//! Daemon 事件存储和广播
//!
//! 在 daemon 中维护事件队列，并通过长连接推送事件到客户端
//! 同时保留事件历史记录，便于客户端重连后获取历史事件

use super::events::DaemonEvent;
use super::events::DaemonEventKind;
use std::collections::VecDeque;
use std::sync::Arc;
use tokio::sync::{broadcast, mpsc, RwLock};

/// 事件广播器
pub struct EventBroadcaster {
    /// 下一个事件 ID
    next_id: Arc<RwLock<u64>>,
    /// 事件 -> 广播器 映射（固定大小，初始化时与已知事件数量一致）
    event_txs: Vec<broadcast::Sender<(u64, DaemonEvent)>>,
    /// 同步广播通道（供 broadcast_sync 使用）
    sync_tx: mpsc::UnboundedSender<DaemonEvent>,
}

impl EventBroadcaster {
    /// 创建新的事件广播器
    /// 工作机制：
    /// 1. 创建事件种类COUNT个广播通道，每个通道对应一个事件种类，每个通道通过 subscribe 添加订阅者
    /// 2. 创建一个 事件队列，任何事件都塞到这个队列里
    /// 3. 从队列中取出事件，再送到广播通道中
    pub fn new(max_queue_size: usize) -> Self {
        // 写死最多接受 1024 个订阅者/事件种类
        let mut event_txs = Vec::with_capacity(DaemonEventKind::COUNT);
        for _ in 0..DaemonEventKind::COUNT {
            let (tx, _) = broadcast::channel(1024);
            event_txs.push(tx);
        }

        let (sync_tx, mut sync_rx) = mpsc::unbounded_channel::<DaemonEvent>();

        let broadcaster = Self {
            next_id: Arc::new(RwLock::new(0)),
            event_txs,
            sync_tx,
        };

        // 启动后台任务处理同步广播
        let next_id = broadcaster.next_id.clone();
        let event_txs = broadcaster.event_txs.clone();
        tokio::spawn(async move {
            while let Some(event) = sync_rx.recv().await {
                // 构造临时的 broadcaster 来调用 broadcast 逻辑

                let event_with_id = {
                    let mut next_id_guard = next_id.write().await;
                    let id = *next_id_guard;
                    *next_id_guard += 1;
                    #[cfg(debug_assertions)]
                    {
                        eprintln!(
                            "[DEBUG] EventBroadcaster 广播事件(同步): id={}, event={:?}",
                            id, event
                        );
                    }
                    (id, event.clone())
                };

                // 事件 -> 广播器：自动路由
                let idx = event.kind().as_usize();
                let tx = match event_txs.get(idx) {
                    Some(tx) => tx,
                    None => {
                        eprintln!("[DEBUG] EventBroadcaster 路由失败(同步)：idx={} 越界", idx);
                        continue;
                    }
                };

                // 检查订阅者数量
                let receiver_count = tx.receiver_count();

                if receiver_count == 0 {
                    continue;
                }

                // 推送到对应广播 channel（忽略错误，因为可能没有订阅者）
                match tx.send(event_with_id) {
                    Ok(count) => {
                        eprintln!(
                            "[DEBUG] EventBroadcaster 事件已推送到 channel(kind={:?}), 订阅者数量: {}",
                            event.kind(),
                            count
                        );
                    }
                    Err(e) => {
                        eprintln!("[DEBUG] EventBroadcaster 事件推送失败 {}", e);
                    }
                }
            }
        });

        broadcaster
    }

    /// 广播事件（异步版本）
    /// 将事件发送到通道，由后台异步任务处理
    pub async fn broadcast(&self, event: DaemonEvent) {
        // 发送到通道，由后台异步任务处理（非阻塞）
        let _ = self.sync_tx.send(event);
    }

    /// 同步版本的广播（在非 async 环境中可用）
    /// 将事件发送到通道，由后台异步任务处理
    pub fn broadcast_sync(&self, event: DaemonEvent) {
        // 发送到通道，由后台异步任务处理（非阻塞）
        let _ = self.sync_tx.send(event);
    }

    /// 订阅指定事件种类（返回 broadcast Receiver）
    pub fn subscribe(&self, kind: DaemonEventKind) -> broadcast::Receiver<(u64, DaemonEvent)> {
        self.event_txs[kind.as_usize()].subscribe()
    }

    /// 订阅所有事件，并合并为单一接收器（用于长连接推送）
    ///
    /// 取消订阅：丢弃返回的 receiver 即可（内部转发任务会自动退出）。
    pub fn subscribe_all_stream(&self) -> mpsc::UnboundedReceiver<(u64, DaemonEvent)> {
        self.subscribe_filtered_stream(&DaemonEventKind::ALL)
    }

    /// 订阅指定事件类型列表，并合并为单一接收器（用于长连接推送）
    ///
    /// 取消订阅：丢弃返回的 receiver 即可（内部转发任务会自动退出）。
    /// 如果 kinds 为空，返回一个永远不会收到消息的 receiver。
    pub fn subscribe_filtered_stream(
        &self,
        kinds: &[DaemonEventKind],
    ) -> mpsc::UnboundedReceiver<(u64, DaemonEvent)> {
        let (tx, rx) = mpsc::unbounded_channel::<(u64, DaemonEvent)>();

        for kind in kinds {
            let mut brx = self.subscribe(*kind);
            let tx = tx.clone();
            tokio::spawn(async move {
                loop {
                    match brx.recv().await {
                        Ok(item) => {
                            // 若对端已断开（连接关闭），直接退出转发任务
                            if tx.send(item).is_err() {
                                break;
                            }
                        }
                        Err(broadcast::error::RecvError::Closed) => break,
                        Err(broadcast::error::RecvError::Lagged(_)) => {
                            // 保持与原逻辑一致：滞后时继续
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
        let next_id = self.next_id.read().await;
        next_id.saturating_sub(1)
    }

    /// 获取指定事件类型的订阅者数量
    pub fn receiver_count(&self, kind: DaemonEventKind) -> usize {
        let idx = kind.as_usize();
        match self.event_txs.get(idx) {
            Some(tx) => tx.receiver_count(),
            None => 0,
        }
    }
}

impl Default for EventBroadcaster {
    fn default() -> Self {
        Self::new(1000) // 默认保留最近 1000 个事件
    }
}

/// 辅助函数：发送任务日志事件
pub async fn emit_task_log(
    broadcaster: &EventBroadcaster,
    task_id: impl Into<String>,
    level: impl Into<String>,
    message: impl Into<String>,
) {
    broadcaster
        .broadcast(DaemonEvent::TaskLog {
            task_id: task_id.into(),
            level: level.into(),
            message: message.into(),
        })
        .await;
}

/// 辅助函数：发送下载状态事件
/// 如果没有订阅者，则跳过发送
pub async fn emit_download_state(
    broadcaster: &EventBroadcaster,
    task_id: impl Into<String>,
    url: impl Into<String>,
    start_time: u64,
    plugin_id: impl Into<String>,
    state: impl Into<String>,
    error: Option<String>,
) {
    // 检查订阅者数量，如果没有订阅者则不发送
    if broadcaster.receiver_count(DaemonEventKind::DownloadState) == 0 {
        return;
    }

    broadcaster
        .broadcast(DaemonEvent::DownloadState {
            task_id: task_id.into(),
            url: url.into(),
            start_time,
            plugin_id: plugin_id.into(),
            state: state.into(),
            error,
        })
        .await;
}

/// 辅助函数：发送任务状态事件
pub async fn emit_task_status(
    broadcaster: &EventBroadcaster,
    task_id: impl Into<String>,
    status: impl Into<String>,
    progress: Option<f64>,
    error: Option<String>,
    current_wallpaper: Option<String>,
) {
    broadcaster
        .broadcast(DaemonEvent::TaskStatus {
            task_id: task_id.into(),
            status: status.into(),
            progress,
            error,
            current_wallpaper,
        })
        .await;
}

/// 辅助函数：发送去重进度事件
pub async fn emit_dedupe_progress(
    broadcaster: &EventBroadcaster,
    processed: usize,
    total: usize,
    removed: usize,
    batch_index: usize,
) {
    broadcaster
        .broadcast(DaemonEvent::DedupeProgress {
            processed,
            total,
            removed,
            batch_index,
        })
        .await;
}

/// 辅助函数：发送去重完成事件
pub async fn emit_dedupe_finished(
    broadcaster: &EventBroadcaster,
    processed: usize,
    total: usize,
    removed: usize,
    canceled: bool,
) {
    broadcaster
        .broadcast(DaemonEvent::DedupeFinished {
            processed,
            total,
            removed,
            canceled,
        })
        .await;
}

/// 辅助函数：发送任务进度事件
pub async fn emit_task_progress(
    broadcaster: &EventBroadcaster,
    task_id: impl Into<String>,
    progress: f64,
) {
    broadcaster
        .broadcast(DaemonEvent::TaskProgress {
            task_id: task_id.into(),
            progress,
        })
        .await;
}

/// 辅助函数：发送任务错误事件
pub async fn emit_task_error(
    broadcaster: &EventBroadcaster,
    task_id: impl Into<String>,
    error: impl Into<String>,
) {
    broadcaster
        .broadcast(DaemonEvent::TaskError {
            task_id: task_id.into(),
            error: error.into(),
        })
        .await;
}

/// 辅助函数：发送下载进度事件
/// 如果没有订阅者，则跳过发送
pub async fn emit_download_progress(
    broadcaster: &EventBroadcaster,
    task_id: impl Into<String>,
    url: impl Into<String>,
    start_time: u64,
    plugin_id: impl Into<String>,
    received_bytes: u64,
    total_bytes: Option<u64>,
) {
    // 检查订阅者数量，如果没有订阅者则不发送
    if broadcaster.receiver_count(DaemonEventKind::DownloadProgress) == 0 {
        return;
    }

    broadcaster
        .broadcast(DaemonEvent::DownloadProgress {
            task_id: task_id.into(),
            url: url.into(),
            start_time,
            plugin_id: plugin_id.into(),
            received_bytes,
            total_bytes,
        })
        .await;
}

/// 辅助函数：发送壁纸图片更新事件
pub async fn emit_wallpaper_update_image(
    broadcaster: &EventBroadcaster,
    image_path: impl Into<String>,
) {
    broadcaster
        .broadcast(DaemonEvent::WallpaperUpdateImage {
            image_path: image_path.into(),
        })
        .await;
}

/// 辅助函数：发送壁纸样式更新事件
pub async fn emit_wallpaper_update_style(broadcaster: &EventBroadcaster, style: impl Into<String>) {
    broadcaster
        .broadcast(DaemonEvent::WallpaperUpdateStyle {
            style: style.into(),
        })
        .await;
}

/// 辅助函数：发送壁纸过渡效果更新事件
pub async fn emit_wallpaper_update_transition(
    broadcaster: &EventBroadcaster,
    transition: impl Into<String>,
) {
    broadcaster
        .broadcast(DaemonEvent::WallpaperUpdateTransition {
            transition: transition.into(),
        })
        .await;
}
