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
    /// 事件队列（FIFO）
    events: Arc<RwLock<VecDeque<(u64, DaemonEvent)>>>,
    /// 下一个事件 ID
    next_id: Arc<RwLock<u64>>,
    /// 最大队列长度
    max_queue_size: usize,
    /// 事件 -> 广播器 映射（固定大小，初始化时与已知事件数量一致）
    ///
    /// 注意：这是“daemon 内部事件类型”的广播，不是 Tauri 前端事件名。
    event_txs: Vec<broadcast::Sender<(u64, DaemonEvent)>>,
}

impl EventBroadcaster {
    /// 创建新的事件广播器
    pub fn new(max_queue_size: usize) -> Self {
        // 写死最多接受 1024 个订阅者/事件种类
        let mut event_txs = Vec::with_capacity(DaemonEventKind::COUNT);
        for _ in 0..DaemonEventKind::COUNT {
            let (tx, _) = broadcast::channel(1024);
            event_txs.push(tx);
        }

        Self {
            events: Arc::new(RwLock::new(VecDeque::new())),
            next_id: Arc::new(RwLock::new(0)),
            max_queue_size,
            event_txs,
        }
    }

    /// 广播事件
    pub async fn broadcast(&self, event: DaemonEvent) {
        let mut events = self.events.write().await;
        let mut next_id = self.next_id.write().await;

        let id = *next_id;
        *next_id += 1;

        let event_with_id = (id, event.clone());
        eprintln!("[DEBUG] EventBroadcaster 广播事件: id={}, event={:?}", id, event);
        events.push_back(event_with_id.clone());

        // 限制队列大小：只保留最近 max_queue_size 条
        while events.len() > self.max_queue_size {
            events.pop_front();
        }

        // 事件 -> 广播器：自动路由
        let idx = event.kind().as_usize();
        let tx = match self.event_txs.get(idx) {
            Some(tx) => tx,
            None => {
                // 理论上不可能：kind()->index 是固定映射，且 event_txs 初始化为 COUNT
                eprintln!("[DEBUG] EventBroadcaster 路由失败：idx={} 越界", idx);
                return;
            }
        };

        // 检查订阅者数量
        let receiver_count = tx.receiver_count();
        
        // 推送到对应广播 channel（忽略错误，因为可能没有订阅者）
        match tx.send(event_with_id) {
            Ok(count) => {
                eprintln!(
                    "[DEBUG] EventBroadcaster 事件已推送到 channel(kind={:?}), 订阅者数量: {}",
                    event.kind(),
                    count
                );
            },
            Err(_) => {
                eprintln!(
                    "[DEBUG] EventBroadcaster 事件推送失败（可能没有订阅者），订阅者数量: {}",
                    receiver_count
                );
            }
        }
    }

    /// 订阅指定事件种类（返回 broadcast Receiver）
    pub fn subscribe(&self, kind: DaemonEventKind) -> broadcast::Receiver<(u64, DaemonEvent)> {
        self.event_txs[kind.as_usize()].subscribe()
    }

    /// 订阅所有事件，并合并为单一接收器（用于长连接推送）
    ///
    /// 取消订阅：丢弃返回的 receiver 即可（内部转发任务会自动退出）。
    pub fn subscribe_all_stream(&self) -> mpsc::UnboundedReceiver<(u64, DaemonEvent)> {
        let (tx, rx) = mpsc::unbounded_channel::<(u64, DaemonEvent)>();

        for kind in DaemonEventKind::ALL {
            let mut brx = self.subscribe(kind);
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

    /// 获取自指定 ID 以来的所有事件（历史查询，已弃用）
    /// 
    /// 注意：此方法用于历史事件查询，当前长连接模式下不再使用。
    /// 保留此方法以便未来扩展（如客户端重连后获取历史事件）。
    pub async fn get_events_since(&self, since: Option<u64>) -> Vec<serde_json::Value> {
        let events = self.events.read().await;
        
        let start_id = since.unwrap_or(0);
        events
            .iter()
            .filter(|(id, _)| *id >= start_id)
            .filter_map(|(id, event)| {
                // 兼容：在事件对象中注入 id 字段，便于客户端推进 since 游标。
                // DaemonEvent 的反序列化会忽略未知字段，因此不会破坏现有解析逻辑。
                let mut v = serde_json::to_value(event).ok()?;
                if let Some(obj) = v.as_object_mut() {
                    obj.insert("id".to_string(), serde_json::Value::Number((*id).into()));
                }
                Some(v)
            })
            .collect()
    }

    /// 清空所有事件
    pub async fn clear(&self) {
        let mut events = self.events.write().await;
        events.clear();
    }

    /// 获取当前事件数量
    pub async fn len(&self) -> usize {
        let events = self.events.read().await;
        events.len()
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
pub async fn emit_wallpaper_update_style(
    broadcaster: &EventBroadcaster,
    style: impl Into<String>,
) {
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
