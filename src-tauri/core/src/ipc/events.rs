//! IPC 事件监听器
//!
//! 提供统一的事件监听接口，让所有前端（app-main、plugin-editor、cli）都能
//! 使用相同的 API 来监听 daemon 发送的事件。
//!
//! ## 使用示例
//!
//! ```rust
//! use kabegame_core::ipc::events::{EventListener, DaemonEvent};
//!
//! // 创建事件监听器
//! let listener = EventListener::new();
//!
//! // 监听任务日志
//! listener.on_task_log(|event| {
//!     println!("[{}] {}: {}", event.task_id, event.level, event.message);
//! });
//!
//! // 监听下载状态
//! listener.on_download_state(|event| {
//!     println!("下载: {} - {}", event.url, event.state);
//! });
//!
//! // 启动监听（异步）
//! listener.start().await?;
//! ```

use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::{mpsc, RwLock};
use crate::ipc::IpcClient;

/// Daemon 事件类型
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum DaemonEvent {
    /// 任务日志事件
    TaskLog {
        task_id: String,
        level: String,
        message: String,
    },

    /// 下载状态事件
    DownloadState {
        task_id: String,
        url: String,
        start_time: u64,
        plugin_id: String,
        state: String,
        error: Option<String>,
    },

    /// 任务状态事件
    TaskStatus {
        task_id: String,
        status: String,
        progress: Option<f64>,
        error: Option<String>,
        current_wallpaper: Option<String>,
    },

    /// 通用事件
    Generic {
        event: String,
        payload: serde_json::Value,
    },

    /// 连接状态变化
    ConnectionStatus {
        connected: bool,
        message: String,
    },
}

/// 事件回调类型
pub type EventCallback = Arc<dyn Fn(DaemonEvent) + Send + Sync>;

/// 事件监听器
pub struct EventListener {
    /// 事件回调列表
    callbacks: Arc<RwLock<Vec<EventCallback>>>,
    /// 任务日志回调
    task_log_callbacks: Arc<RwLock<Vec<Arc<dyn Fn(String, String, String) + Send + Sync>>>>,
    /// 下载状态回调
    download_state_callbacks: Arc<RwLock<Vec<Arc<dyn Fn(DownloadStateEvent) + Send + Sync>>>>,
    /// 任务状态回调
    task_status_callbacks: Arc<RwLock<Vec<Arc<dyn Fn(TaskStatusEvent) + Send + Sync>>>>,
    /// 停止信号
    stop_signal: Arc<RwLock<Option<mpsc::Sender<()>>>>,
}

#[derive(Debug, Clone)]
pub struct DownloadStateEvent {
    pub task_id: String,
    pub url: String,
    pub start_time: u64,
    pub plugin_id: String,
    pub state: String,
    pub error: Option<String>,
}

#[derive(Debug, Clone)]
pub struct TaskStatusEvent {
    pub task_id: String,
    pub status: String,
    pub progress: Option<f64>,
    pub error: Option<String>,
    pub current_wallpaper: Option<String>,
}

impl EventListener {
    /// 创建新的事件监听器
    pub fn new() -> Self {
        Self {
            callbacks: Arc::new(RwLock::new(Vec::new())),
            task_log_callbacks: Arc::new(RwLock::new(Vec::new())),
            download_state_callbacks: Arc::new(RwLock::new(Vec::new())),
            task_status_callbacks: Arc::new(RwLock::new(Vec::new())),
            stop_signal: Arc::new(RwLock::new(None)),
        }
    }

    /// 注册通用事件回调
    pub async fn on<F>(&self, callback: F)
    where
        F: Fn(DaemonEvent) + Send + Sync + 'static,
    {
        let mut callbacks = self.callbacks.write().await;
        callbacks.push(Arc::new(callback));
    }

    /// 监听任务日志事件
    pub async fn on_task_log<F>(&self, callback: F)
    where
        F: Fn(String, String, String) + Send + Sync + 'static,
    {
        let mut callbacks = self.task_log_callbacks.write().await;
        callbacks.push(Arc::new(callback));
    }

    /// 监听下载状态事件
    pub async fn on_download_state<F>(&self, callback: F)
    where
        F: Fn(DownloadStateEvent) + Send + Sync + 'static,
    {
        let mut callbacks = self.download_state_callbacks.write().await;
        callbacks.push(Arc::new(callback));
    }

    /// 监听任务状态事件
    pub async fn on_task_status<F>(&self, callback: F)
    where
        F: Fn(TaskStatusEvent) + Send + Sync + 'static,
    {
        let mut callbacks = self.task_status_callbacks.write().await;
        callbacks.push(Arc::new(callback));
    }

    /// 启动事件监听（长连接模式）
    ///
    /// 建立长连接并持续接收服务器推送的事件，适用于全双工 IPC
    pub async fn start(&self) -> Result<(), String> {
        let (tx, mut rx) = mpsc::channel::<()>(1);
        *self.stop_signal.write().await = Some(tx);

        let callbacks = self.callbacks.clone();
        let task_log_callbacks = self.task_log_callbacks.clone();
        let download_state_callbacks = self.download_state_callbacks.clone();
        let task_status_callbacks = self.task_status_callbacks.clone();

        tokio::spawn(async move {
            let client = IpcClient::new();
            
            // 建立长连接并持续接收事件
            let _ = client.subscribe_events_stream(move |raw| {
                let callbacks = callbacks.clone();
                let task_log_callbacks = task_log_callbacks.clone();
                let download_state_callbacks = download_state_callbacks.clone();
                let task_status_callbacks = task_status_callbacks.clone();
                
                async move {
                    eprintln!("[DEBUG] EventListener 收到事件: {:?}", raw);
                    let evt: DaemonEvent = match serde_json::from_value(raw.clone()) {
                        Ok(e) => {
                            eprintln!("[DEBUG] EventListener 解析成功: {:?}", e);
                            e
                        },
                        Err(e) => {
                            eprintln!("[ipc-events] parse DaemonEvent failed: {e}, raw: {:?}", raw);
                            return;
                        }
                    };

                    eprintln!("[DEBUG] EventListener 分发事件: {:?}", evt);
                    Self::dispatch_event(
                        &evt,
                        &callbacks,
                        &task_log_callbacks,
                        &download_state_callbacks,
                        &task_status_callbacks,
                    ).await;
                }
            }).await;

            // 连接关闭后，等待停止信号
            let _ = rx.recv().await;
        });

        Ok(())
    }

    /// 分发事件到所有注册的回调
    async fn dispatch_event(
        event: &DaemonEvent,
        callbacks: &Arc<RwLock<Vec<EventCallback>>>,
        task_log_callbacks: &Arc<RwLock<Vec<Arc<dyn Fn(String, String, String) + Send + Sync>>>>,
        download_state_callbacks: &Arc<RwLock<Vec<Arc<dyn Fn(DownloadStateEvent) + Send + Sync>>>>,
        task_status_callbacks: &Arc<RwLock<Vec<Arc<dyn Fn(TaskStatusEvent) + Send + Sync>>>>,
    ) {
        // 调用通用回调
        let cbs = callbacks.read().await;
        for callback in cbs.iter() {
            callback(event.clone());
        }

        // 调用特定类型的回调
        match event {
            DaemonEvent::TaskLog { task_id, level, message } => {
                let cbs = task_log_callbacks.read().await;
                for callback in cbs.iter() {
                    callback(task_id.clone(), level.clone(), message.clone());
                }
            }
            DaemonEvent::DownloadState { task_id, url, start_time, plugin_id, state, error } => {
                let cbs = download_state_callbacks.read().await;
                let event = DownloadStateEvent {
                    task_id: task_id.clone(),
                    url: url.clone(),
                    start_time: *start_time,
                    plugin_id: plugin_id.clone(),
                    state: state.clone(),
                    error: error.clone(),
                };
                for callback in cbs.iter() {
                    callback(event.clone());
                }
            }
            DaemonEvent::TaskStatus { task_id, status, progress, error, current_wallpaper } => {
                let cbs = task_status_callbacks.read().await;
                let event = TaskStatusEvent {
                    task_id: task_id.clone(),
                    status: status.clone(),
                    progress: *progress,
                    error: error.clone(),
                    current_wallpaper: current_wallpaper.clone(),
                };
                for callback in cbs.iter() {
                    callback(event.clone());
                }
            }
            _ => {}
        }
    }

    /// 停止事件监听
    pub async fn stop(&self) {
        if let Some(tx) = self.stop_signal.write().await.take() {
            let _ = tx.send(()).await;
        }
    }
}

impl Default for EventListener {
    fn default() -> Self {
        Self::new()
    }
}

/// 全局事件监听器（单例）
static GLOBAL_LISTENER: std::sync::OnceLock<EventListener> = std::sync::OnceLock::new();

/// 获取全局事件监听器
pub fn get_global_listener() -> &'static EventListener {
    GLOBAL_LISTENER.get_or_init(|| EventListener::new())
}

/// 简化的 API：监听任务日志
pub async fn on_task_log<F>(callback: F)
where
    F: Fn(String, String, String) + Send + Sync + 'static,
{
    get_global_listener().on_task_log(callback).await;
}

/// 简化的 API：监听下载状态
pub async fn on_download_state<F>(callback: F)
where
    F: Fn(DownloadStateEvent) + Send + Sync + 'static,
{
    get_global_listener().on_download_state(callback).await;
}

/// 简化的 API：监听任务状态
pub async fn on_task_status<F>(callback: F)
where
    F: Fn(TaskStatusEvent) + Send + Sync + 'static,
{
    get_global_listener().on_task_status(callback).await;
}

/// 简化的 API：启动监听（长连接模式）
pub async fn start_listening() -> Result<(), String> {
    get_global_listener().start().await
}

/// 简化的 API：停止监听
pub async fn stop_listening() {
    get_global_listener().stop().await;
}
