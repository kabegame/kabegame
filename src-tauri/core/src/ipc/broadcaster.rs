//! Daemon 事件存储和广播
//!
//! 在 daemon 中维护事件队列，供客户端轮询获取

use super::events::DaemonEvent;
use std::collections::VecDeque;
use std::sync::Arc;
use tokio::sync::RwLock;

/// 事件广播器
pub struct EventBroadcaster {
    /// 事件队列（FIFO）
    events: Arc<RwLock<VecDeque<(u64, DaemonEvent)>>>,
    /// 下一个事件 ID
    next_id: Arc<RwLock<u64>>,
    /// 最大队列长度
    max_queue_size: usize,
}

impl EventBroadcaster {
    /// 创建新的事件广播器
    pub fn new(max_queue_size: usize) -> Self {
        Self {
            events: Arc::new(RwLock::new(VecDeque::new())),
            next_id: Arc::new(RwLock::new(0)),
            max_queue_size,
        }
    }

    /// 广播事件
    pub async fn broadcast(&self, event: DaemonEvent) {
        let mut events = self.events.write().await;
        let mut next_id = self.next_id.write().await;

        let id = *next_id;
        *next_id += 1;

        events.push_back((id, event));

        // 限制队列大小
        while events.len() > self.max_queue_size {
            events.pop_front();
        }
    }

    /// 获取自指定 ID 以来的所有事件
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
pub async fn emit_download_state(
    broadcaster: &EventBroadcaster,
    task_id: impl Into<String>,
    url: impl Into<String>,
    start_time: u64,
    plugin_id: impl Into<String>,
    state: impl Into<String>,
    error: Option<String>,
) {
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
