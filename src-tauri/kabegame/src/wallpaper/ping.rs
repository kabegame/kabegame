//! 壁纸窗口 ping 看门狗：后端计时，页面只应答，避免 hidden 页面定时器节流造成误判。

use kabegame_core::emitter::GlobalEmitter;
use kabegame_core::ipc::events::{AppEvent, AppEventKind, ArcAppEvent};
use kabegame_core::ipc::server::EventBroadcaster;
use std::time::Duration;
use tokio::sync::{
    broadcast,
    mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender},
};

const PING_INTERVAL: Duration = Duration::from_secs(10);
const MISS_LIMIT: u32 = 3;
const MISS_LIMIT_CAP: u32 = 60;

/// 随 WallpaperWindow 持有；丢弃后通道关闭，看门狗任务退出。
pub struct Pinger {
    reset: UnboundedSender<()>,
}

impl Pinger {
    pub fn start(label: String, recover: impl FnMut() + Send + 'static) -> Self {
        let (reset, reset_rx) = unbounded_channel();
        let pongs = EventBroadcaster::global().subscribe(AppEventKind::WallpaperPong);
        let ping_label = label.clone();
        tauri::async_runtime::spawn(run(
            reset_rx,
            pongs,
            label,
            move |seq| GlobalEmitter::global().emit_wallpaper_ping(&ping_label, seq),
            recover,
        ));
        Self { reset }
    }

    /// 重新起算，并作废之前文档的迟到应答。壁纸窗口不再导航（网页壁纸是 iframe），目前没有调用方；
    /// 整页重载由看门狗自己处理。
    #[allow(dead_code)]
    pub fn reset(&self) {
        let _ = self.reset.send(());
    }
}

async fn run(
    mut reset_rx: UnboundedReceiver<()>,
    mut pongs: broadcast::Receiver<(u64, ArcAppEvent)>,
    label: String,
    mut ping: impl FnMut(u64),
    mut recover: impl FnMut(),
) {
    let mut seq = 0u64; // 最近一次发出的序号
    let mut floor = 0u64; // 只认序号 > floor 的应答，导航 / 重载前的迟到应答作废
    let mut awaiting = false; // 最近一次 ping 尚未应答
    let mut misses = 0u32; // 连续未应答次数
    let mut limit = MISS_LIMIT; // 重载后仍无应答则翻倍，有应答即恢复
    loop {
        tokio::select! {
            r = reset_rx.recv() => match r {
                None => break,
                Some(()) => {
                    floor = seq;
                    awaiting = false;
                    misses = 0;
                }
            },
            r = pongs.recv() => match r {
                Ok((_, event)) => {
                    if let AppEvent::WallpaperPong { label: from, seq: n } = &*event {
                        if *from == label && *n > floor {
                            if misses > 0 {
                                tracing::info!("壁纸窗口 {label} 恢复应答");
                            }
                            awaiting = false;
                            misses = 0;
                            limit = MISS_LIMIT;
                        }
                    }
                }
                Err(broadcast::error::RecvError::Lagged(_)) => {}
                Err(broadcast::error::RecvError::Closed) => break,
            },
            // 每轮重建 sleep：应答 / reset 后顺延，睡眠唤醒后不补发错过的 tick。
            _ = tokio::time::sleep(PING_INTERVAL) => {
                if awaiting {
                    misses += 1;
                    tracing::warn!("壁纸窗口 {label} 第 {misses}/{limit} 次 ping 未应答");
                    if misses >= limit {
                        tracing::error!("壁纸窗口 {label} 无响应，重新加载");
                        recover();
                        floor = seq;
                        awaiting = false;
                        misses = 0;
                        limit = (limit * 2).min(MISS_LIMIT_CAP);
                        continue; // 给新文档一个周期再 ping
                    }
                }
                seq += 1;
                awaiting = true;
                ping(seq);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Mutex,
    };

    struct Harness {
        pinger: Pinger,
        pongs: broadcast::Sender<(u64, ArcAppEvent)>,
        pings: Arc<Mutex<Vec<u64>>>,
        reloads: Arc<AtomicUsize>,
        reply: Arc<AtomicBool>,
        task: tokio::task::JoinHandle<()>,
    }

    impl Harness {
        async fn new(reply: bool) -> Self {
            let (reset, reset_rx) = unbounded_channel();
            let (pongs, pong_rx) = broadcast::channel(32);
            let pings = Arc::new(Mutex::new(Vec::new()));
            let reloads = Arc::new(AtomicUsize::new(0));
            let reply = Arc::new(AtomicBool::new(reply));
            let ping_log = pings.clone();
            let pong_tx = pongs.clone();
            let reply_enabled = reply.clone();
            let reload_count = reloads.clone();
            let task = tokio::spawn(run(
                reset_rx,
                pong_rx,
                "wallpaper".into(),
                move |seq| {
                    ping_log.lock().unwrap().push(seq);
                    if reply_enabled.load(Ordering::SeqCst) {
                        pong_tx
                            .send((
                                seq,
                                Arc::new(AppEvent::WallpaperPong {
                                    label: "wallpaper".into(),
                                    seq,
                                }),
                            ))
                            .unwrap();
                    }
                },
                move || {
                    reload_count.fetch_add(1, Ordering::SeqCst);
                },
            ));
            // 先让任务登记首个 sleep，再推进暂停的时钟。
            tokio::task::yield_now().await;
            Self {
                pinger: Pinger { reset },
                pongs,
                pings,
                reloads,
                reply,
                task,
            }
        }

        async fn ticks(&self, count: usize) {
            for _ in 0..count {
                tokio::time::advance(PING_INTERVAL).await;
                tokio::task::yield_now().await;
            }
        }

        fn reloads(&self) -> usize {
            self.reloads.load(Ordering::SeqCst)
        }

        fn last_seq(&self) -> u64 {
            *self.pings.lock().unwrap().last().unwrap()
        }

        async fn pong(&self, label: &str, seq: u64) {
            self.pongs
                .send((
                    seq,
                    Arc::new(AppEvent::WallpaperPong {
                        label: label.into(),
                        seq,
                    }),
                ))
                .unwrap();
            tokio::task::yield_now().await;
        }

        async fn stop(self) {
            drop(self.pinger);
            tokio::task::yield_now().await;
            assert!(self.task.is_finished(), "丢弃句柄后任务应退出");
            self.task.await.unwrap();
        }
    }

    #[tokio::test(start_paused = true)]
    async fn responsive_for_ten_minutes_never_reloads() {
        let h = Harness::new(true).await;
        h.ticks(60).await;
        assert_eq!(h.pings.lock().unwrap().len(), 60);
        assert_eq!(h.reloads(), 0);
        h.stop().await;
    }

    #[tokio::test(start_paused = true)]
    async fn silent_window_reloads_once_at_forty_seconds() {
        let h = Harness::new(false).await;
        h.ticks(3).await;
        assert_eq!(h.last_seq(), 3);
        assert_eq!(h.reloads(), 0);
        h.ticks(1).await;
        assert_eq!(h.reloads(), 1);
        assert_eq!(h.last_seq(), 3, "重载当轮不发送 ping");
        h.stop().await;
    }

    #[tokio::test(start_paused = true)]
    async fn stops_responding_then_reloads_after_three_misses() {
        let h = Harness::new(true).await;
        h.ticks(5).await;
        h.reply.store(false, Ordering::SeqCst);
        h.ticks(3).await;
        assert_eq!(h.reloads(), 0);
        h.ticks(1).await;
        assert_eq!(h.reloads(), 1);
        h.stop().await;
    }

    #[tokio::test(start_paused = true)]
    async fn another_label_does_not_answer_for_this_window() {
        let h = Harness::new(false).await;
        for _ in 0..3 {
            h.ticks(1).await;
            h.pong("other-wallpaper", h.last_seq()).await;
        }
        h.ticks(1).await;
        assert_eq!(h.reloads(), 1);
        h.stop().await;
    }

    #[tokio::test(start_paused = true)]
    async fn reset_rejects_old_pongs_and_accepts_new_pongs() {
        let h = Harness::new(false).await;
        h.ticks(2).await;
        let old_seq = h.last_seq();
        h.pinger.reset();
        tokio::task::yield_now().await;
        h.ticks(3).await;
        assert_eq!(h.reloads(), 0, "reset 应清零原来的未应答次数");
        h.pong("wallpaper", old_seq).await;
        h.ticks(1).await;
        assert_eq!(h.reloads(), 1, "旧文档应答不能清零计数");

        h.ticks(3).await;
        h.pong("wallpaper", h.last_seq()).await;
        h.ticks(3).await;
        assert_eq!(h.reloads(), 1, "有效应答应清零计数");
        h.ticks(1).await;
        assert_eq!(h.reloads(), 2, "有效应答后阈值应恢复为 3");
        h.stop().await;
    }

    #[tokio::test(start_paused = true)]
    async fn reloads_back_off_and_a_pong_restores_three_misses() {
        let h = Harness::new(false).await;
        for (index, limit) in [3, 6, 12].into_iter().enumerate() {
            h.ticks(limit).await;
            assert_eq!(h.reloads(), index);
            h.ticks(1).await;
            assert_eq!(h.reloads(), index + 1);
        }
        let old_seq = h.last_seq();
        h.ticks(1).await;
        h.pong("wallpaper", old_seq).await;
        h.ticks(4).await;
        assert_eq!(h.reloads(), 3, "重载前的迟到应答不能解除退避");
        h.pong("wallpaper", h.last_seq()).await;
        h.ticks(3).await;
        assert_eq!(h.reloads(), 3);
        h.ticks(1).await;
        assert_eq!(h.reloads(), 4);
        h.stop().await;
    }

    #[tokio::test(start_paused = true)]
    async fn backoff_is_capped_at_sixty_misses() {
        let h = Harness::new(false).await;
        for (index, limit) in [3, 6, 12, 24, 48, 60, 60].into_iter().enumerate() {
            h.ticks(limit).await;
            assert_eq!(h.reloads(), index);
            h.ticks(1).await;
            assert_eq!(h.reloads(), index + 1);
        }
        h.stop().await;
    }

    #[tokio::test(start_paused = true)]
    async fn waking_from_sleep_does_not_catch_up_missed_ticks() {
        let h = Harness::new(false).await;
        h.ticks(1).await;
        tokio::time::advance(Duration::from_secs(60)).await;
        tokio::task::yield_now().await;
        assert_eq!(h.last_seq(), 2);
        assert_eq!(h.reloads(), 0);
        h.ticks(1).await;
        assert_eq!(h.reloads(), 0);
        h.stop().await;
    }

    #[tokio::test(start_paused = true)]
    async fn dropping_the_handle_stops_the_task() {
        Harness::new(false).await.stop().await;
    }
}
