//! 全局事件广播器模块
//!
//! 提供全局单例的 EventBroadcaster，参照 Settings 的实现模式

use std::sync::OnceLock;

use crate::ipc::events::{ArcDaemonEvent, DaemonEventKind};
use tokio::sync::{Mutex, RwLock, broadcast, mpsc};

/// 全局事件广播器单例
pub struct EventBroadcaster {
    next_id: RwLock<u64>,
    event_txs: Vec<broadcast::Sender<(u64, ArcDaemonEvent)>>,
    sync_tx: mpsc::UnboundedSender<ArcDaemonEvent>,
    sync_rx: Mutex<mpsc::UnboundedReceiver<ArcDaemonEvent>>,
}

static EVENT_BROADCASTER: OnceLock<EventBroadcaster> = OnceLock::new();

impl EventBroadcaster {
    /// 初始化全局 EventBroadcaster（必须在首次使用前调用）
    pub fn init_global(_max_queue_size: usize) -> Result<(), String> {
        let mut event_txs = Vec::with_capacity(DaemonEventKind::COUNT);
        for _ in 0..DaemonEventKind::COUNT {
            let (tx, _) = broadcast::channel(1024);
            event_txs.push(tx);
        }

        let (sync_tx, sync_rx) = mpsc::unbounded_channel::<ArcDaemonEvent>();

        EVENT_BROADCASTER
            .set(EventBroadcaster {
                next_id: RwLock::new(0),
                event_txs,
                sync_tx,
                sync_rx: Mutex::new(sync_rx),
            })
            .map_err(|_| "EventBroadcaster already initialized".to_string())?;

        Ok(())
    }

    /// 获取全局 EventBroadcaster 引用
    pub fn global() -> &'static EventBroadcaster {
        EVENT_BROADCASTER
            .get()
            .expect("EventBroadcaster not initialized. Call EventBroadcaster::init_global() first.")
    }

    /// 启动转发服务器，之所以有必要是为了将同步广播和异步广播都收拢到一个接口处
    pub async fn start_forward_task() {
        let broadcaster = Self::global();
        let event_txs = broadcaster.event_txs.clone();
        // 就是要长时间持锁
        eprintln!("[EVENT_FORWARD] ready for forward event");
        let mut sync_rx_guard = broadcaster.sync_rx.lock().await;
        loop {
            match sync_rx_guard.recv().await {
                Some(event) => {
                    let event_with_id = {
                        let mut next_id_guard = broadcaster.next_id.write().await;
                        let id = *next_id_guard;
                        *next_id_guard += 1;
                        (id, event.clone())
                    };

                    let idx = (*event).kind().as_usize();
                    let tx = match event_txs.get(idx) {
                        Some(tx) => tx,
                        None => {
                            eprintln!("[DEBUG] EventBroadcaster 路由失败(同步)：idx={} 越界", idx);
                            continue;
                        }
                    };

                    let receiver_count = tx.receiver_count();

                    if receiver_count == 0 {
                        continue;
                    }

                    let _ = tx.send(event_with_id);
                }
                None => {
                    break;
                }
            }
        }

    }

    /// 广播事件
    pub fn broadcast(&self, event: ArcDaemonEvent) {
        let broadcaster = Self::global();
        let _ = broadcaster.sync_tx.send(event);
    }

    /// 订阅指定类型的事件
    pub fn subscribe(&self, kind: DaemonEventKind) -> broadcast::Receiver<(u64, ArcDaemonEvent)> {
        let broadcaster = Self::global();
        broadcaster.event_txs[kind.as_usize()].subscribe()
    }

    /// 订阅所有事件的流
    pub fn subscribe_all_stream(&self) -> mpsc::UnboundedReceiver<(u64, ArcDaemonEvent)> {
        self.subscribe_filtered_stream(&DaemonEventKind::ALL)
    }

    /// 订阅过滤后的事件流
    pub fn subscribe_filtered_stream(
        &self,
        kinds: &[DaemonEventKind],
    ) -> mpsc::UnboundedReceiver<(u64, ArcDaemonEvent)> {
        let (tx, rx) = mpsc::unbounded_channel::<(u64, ArcDaemonEvent)>();

        for kind in kinds {
            let mut brx = self.subscribe(*kind);
            let tx = tx.clone();
            tokio::spawn(async move {
                loop {
                    match brx.recv().await {
                        Ok(item) => {
                            if tx.send(item).is_err() {
                                break;
                            }
                        }
                        Err(broadcast::error::RecvError::Closed) => break,
                        Err(broadcast::error::RecvError::Lagged(_)) => {
                            continue;
                        }
                    }
                }
            });
        }

        rx
    }

    /// 获取最新的事件 ID
    pub async fn latest_id(&self) -> u64 {
        let broadcaster = Self::global();
        let next_id = broadcaster.next_id.read().await;
        next_id.saturating_sub(1)
    }

    /// 获取指定事件类型的接收者数量
    pub fn receiver_count(&self, kind: DaemonEventKind) -> usize {
        let broadcaster = Self::global();
        let idx = kind.as_usize();
        match broadcaster.event_txs.get(idx) {
            Some(tx) => tx.receiver_count(),
            None => 0,
        }
    }
}
