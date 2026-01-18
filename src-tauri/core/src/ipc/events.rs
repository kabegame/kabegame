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

/// Daemon 事件种类（不含 payload），用于做"事件 -> 广播器"的固定映射。
///
/// 注意：这是 daemon -> client 的事件流里的"类型"，不是 Tauri 前端的事件名。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum DaemonEventKind {
    TaskLog,
    DownloadState,
    TaskStatus,
    TaskProgress,
    TaskError,
    DownloadProgress,
    Generic,
    ConnectionStatus,
    DedupeProgress,
    DedupeFinished,
    WallpaperUpdateImage,
    WallpaperUpdateStyle,
    WallpaperUpdateTransition,
    SettingChange,
}

impl DaemonEventKind {
    /// 已知事件数量（用于初始化固定大小映射表）。
    pub const COUNT: usize = 14;

    /// 所有种类（用于遍历初始化/订阅）。
    pub const ALL: [DaemonEventKind; Self::COUNT] = [
        DaemonEventKind::TaskLog,
        DaemonEventKind::DownloadState,
        DaemonEventKind::TaskStatus,
        DaemonEventKind::TaskProgress,
        DaemonEventKind::TaskError,
        DaemonEventKind::DownloadProgress,
        DaemonEventKind::Generic,
        DaemonEventKind::ConnectionStatus,
        DaemonEventKind::DedupeProgress,
        DaemonEventKind::DedupeFinished,
        DaemonEventKind::WallpaperUpdateImage,
        DaemonEventKind::WallpaperUpdateStyle,
        DaemonEventKind::WallpaperUpdateTransition,
        DaemonEventKind::SettingChange,
    ];

    #[inline]
    pub const fn as_usize(self) -> usize {
        match self {
            DaemonEventKind::TaskLog => 0,
            DaemonEventKind::DownloadState => 1,
            DaemonEventKind::TaskStatus => 2,
            DaemonEventKind::TaskProgress => 3,
            DaemonEventKind::TaskError => 4,
            DaemonEventKind::DownloadProgress => 5,
            DaemonEventKind::Generic => 6,
            DaemonEventKind::ConnectionStatus => 7,
            DaemonEventKind::DedupeProgress => 8,
            DaemonEventKind::DedupeFinished => 9,
            DaemonEventKind::WallpaperUpdateImage => 10,
            DaemonEventKind::WallpaperUpdateStyle => 11,
            DaemonEventKind::WallpaperUpdateTransition => 12,
            DaemonEventKind::SettingChange => 13,
        }
    }
}

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

    /// 任务进度事件（Rhai add_progress 驱动）
    TaskProgress {
        task_id: String,
        progress: f64,
    },

    /// 任务错误事件
    TaskError {
        task_id: String,
        error: String,
    },

    /// 下载进度事件（细粒度进度更新）
    DownloadProgress {
        task_id: String,
        url: String,
        start_time: u64,
        plugin_id: String,
        received_bytes: u64,
        total_bytes: Option<u64>,
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

    /// 去重进度事件
    DedupeProgress {
        processed: usize,
        total: usize,
        removed: usize,
        batch_index: usize,
    },

    /// 去重完成事件
    DedupeFinished {
        processed: usize,
        total: usize,
        removed: usize,
        canceled: bool,
    },

    /// 壁纸图片更新事件
    WallpaperUpdateImage {
        image_path: String,
    },

    /// 壁纸样式更新事件
    WallpaperUpdateStyle {
        style: String,
    },

    /// 壁纸过渡效果更新事件
    WallpaperUpdateTransition {
        transition: String,
    },

    /// 设置变更事件（只包含变化的部分）
    SettingChange {
        /// 变更的设置项，键值对形式
        changes: serde_json::Value,
    },
}

impl DaemonEvent {
    /// 获取事件种类（用于路由到对应广播器）。
    #[inline]
    pub fn kind(&self) -> DaemonEventKind {
        match self {
            DaemonEvent::TaskLog { .. } => DaemonEventKind::TaskLog,
            DaemonEvent::DownloadState { .. } => DaemonEventKind::DownloadState,
            DaemonEvent::TaskStatus { .. } => DaemonEventKind::TaskStatus,
            DaemonEvent::TaskProgress { .. } => DaemonEventKind::TaskProgress,
            DaemonEvent::TaskError { .. } => DaemonEventKind::TaskError,
            DaemonEvent::DownloadProgress { .. } => DaemonEventKind::DownloadProgress,
            DaemonEvent::Generic { .. } => DaemonEventKind::Generic,
            DaemonEvent::ConnectionStatus { .. } => DaemonEventKind::ConnectionStatus,
            DaemonEvent::DedupeProgress { .. } => DaemonEventKind::DedupeProgress,
            DaemonEvent::DedupeFinished { .. } => DaemonEventKind::DedupeFinished,
            DaemonEvent::WallpaperUpdateImage { .. } => DaemonEventKind::WallpaperUpdateImage,
            DaemonEvent::WallpaperUpdateStyle { .. } => DaemonEventKind::WallpaperUpdateStyle,
            DaemonEvent::WallpaperUpdateTransition { .. } => DaemonEventKind::WallpaperUpdateTransition,
            DaemonEvent::SettingChange { .. } => DaemonEventKind::SettingChange,
        }
    }
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
    /// 任务进度回调
    task_progress_callbacks: Arc<RwLock<Vec<Arc<dyn Fn(TaskProgressEvent) + Send + Sync>>>>,
    /// 任务错误回调
    task_error_callbacks: Arc<RwLock<Vec<Arc<dyn Fn(TaskErrorEvent) + Send + Sync>>>>,
    /// 下载进度回调
    download_progress_callbacks: Arc<RwLock<Vec<Arc<dyn Fn(DownloadProgressEvent) + Send + Sync>>>>,
    /// 去重进度回调
    dedupe_progress_callbacks: Arc<RwLock<Vec<Arc<dyn Fn(DedupeProgressEvent) + Send + Sync>>>>,
    /// 去重完成回调
    dedupe_finished_callbacks: Arc<RwLock<Vec<Arc<dyn Fn(DedupeFinishedEvent) + Send + Sync>>>>,
    /// 壁纸图片更新回调
    wallpaper_update_image_callbacks: Arc<RwLock<Vec<Arc<dyn Fn(WallpaperUpdateImageEvent) + Send + Sync>>>>,
    /// 壁纸样式更新回调
    wallpaper_update_style_callbacks: Arc<RwLock<Vec<Arc<dyn Fn(WallpaperUpdateStyleEvent) + Send + Sync>>>>,
    /// 壁纸过渡效果更新回调
    wallpaper_update_transition_callbacks: Arc<RwLock<Vec<Arc<dyn Fn(WallpaperUpdateTransitionEvent) + Send + Sync>>>>,
    /// 设置变更回调
    setting_change_callbacks: Arc<RwLock<Vec<Arc<dyn Fn(SettingChangeEvent) + Send + Sync>>>>,
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

#[derive(Debug, Clone)]
pub struct TaskProgressEvent {
    pub task_id: String,
    pub progress: f64,
}

#[derive(Debug, Clone)]
pub struct TaskErrorEvent {
    pub task_id: String,
    pub error: String,
}

#[derive(Debug, Clone)]
pub struct DownloadProgressEvent {
    pub task_id: String,
    pub url: String,
    pub start_time: u64,
    pub plugin_id: String,
    pub received_bytes: u64,
    pub total_bytes: Option<u64>,
}

#[derive(Debug, Clone)]
pub struct DedupeProgressEvent {
    pub processed: usize,
    pub total: usize,
    pub removed: usize,
    pub batch_index: usize,
}

#[derive(Debug, Clone)]
pub struct DedupeFinishedEvent {
    pub processed: usize,
    pub total: usize,
    pub removed: usize,
    pub canceled: bool,
}

#[derive(Debug, Clone)]
pub struct WallpaperUpdateImageEvent {
    pub image_path: String,
}

#[derive(Debug, Clone)]
pub struct WallpaperUpdateStyleEvent {
    pub style: String,
}

#[derive(Debug, Clone)]
pub struct WallpaperUpdateTransitionEvent {
    pub transition: String,
}

#[derive(Debug, Clone)]
pub struct SettingChangeEvent {
    pub changes: serde_json::Value,
}

impl EventListener {
    /// 创建新的事件监听器
    pub fn new() -> Self {
        Self {
            callbacks: Arc::new(RwLock::new(Vec::new())),
            task_log_callbacks: Arc::new(RwLock::new(Vec::new())),
            download_state_callbacks: Arc::new(RwLock::new(Vec::new())),
            task_status_callbacks: Arc::new(RwLock::new(Vec::new())),
            task_progress_callbacks: Arc::new(RwLock::new(Vec::new())),
            task_error_callbacks: Arc::new(RwLock::new(Vec::new())),
            download_progress_callbacks: Arc::new(RwLock::new(Vec::new())),
            dedupe_progress_callbacks: Arc::new(RwLock::new(Vec::new())),
            dedupe_finished_callbacks: Arc::new(RwLock::new(Vec::new())),
            wallpaper_update_image_callbacks: Arc::new(RwLock::new(Vec::new())),
            wallpaper_update_style_callbacks: Arc::new(RwLock::new(Vec::new())),
            wallpaper_update_transition_callbacks: Arc::new(RwLock::new(Vec::new())),
            setting_change_callbacks: Arc::new(RwLock::new(Vec::new())),
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

    /// 监听任务进度事件
    pub async fn on_task_progress<F>(&self, callback: F)
    where
        F: Fn(TaskProgressEvent) + Send + Sync + 'static,
    {
        let mut callbacks = self.task_progress_callbacks.write().await;
        callbacks.push(Arc::new(callback));
    }

    /// 监听任务错误事件
    pub async fn on_task_error<F>(&self, callback: F)
    where
        F: Fn(TaskErrorEvent) + Send + Sync + 'static,
    {
        let mut callbacks = self.task_error_callbacks.write().await;
        callbacks.push(Arc::new(callback));
    }

    /// 监听下载进度事件
    pub async fn on_download_progress<F>(&self, callback: F)
    where
        F: Fn(DownloadProgressEvent) + Send + Sync + 'static,
    {
        let mut callbacks = self.download_progress_callbacks.write().await;
        callbacks.push(Arc::new(callback));
    }

    /// 监听去重进度事件
    pub async fn on_dedupe_progress<F>(&self, callback: F)
    where
        F: Fn(DedupeProgressEvent) + Send + Sync + 'static,
    {
        let mut callbacks = self.dedupe_progress_callbacks.write().await;
        callbacks.push(Arc::new(callback));
    }

    /// 监听去重完成事件
    pub async fn on_dedupe_finished<F>(&self, callback: F)
    where
        F: Fn(DedupeFinishedEvent) + Send + Sync + 'static,
    {
        let mut callbacks = self.dedupe_finished_callbacks.write().await;
        callbacks.push(Arc::new(callback));
    }

    /// 监听壁纸图片更新事件
    pub async fn on_wallpaper_update_image<F>(&self, callback: F)
    where
        F: Fn(WallpaperUpdateImageEvent) + Send + Sync + 'static,
    {
        let mut callbacks = self.wallpaper_update_image_callbacks.write().await;
        callbacks.push(Arc::new(callback));
    }

    /// 监听壁纸样式更新事件
    pub async fn on_wallpaper_update_style<F>(&self, callback: F)
    where
        F: Fn(WallpaperUpdateStyleEvent) + Send + Sync + 'static,
    {
        let mut callbacks = self.wallpaper_update_style_callbacks.write().await;
        callbacks.push(Arc::new(callback));
    }

    /// 监听壁纸过渡效果更新事件
    pub async fn on_wallpaper_update_transition<F>(&self, callback: F)
    where
        F: Fn(WallpaperUpdateTransitionEvent) + Send + Sync + 'static,
    {
        let mut callbacks = self.wallpaper_update_transition_callbacks.write().await;
        callbacks.push(Arc::new(callback));
    }

    /// 监听设置变更事件
    pub async fn on_setting_change<F>(&self, callback: F)
    where
        F: Fn(SettingChangeEvent) + Send + Sync + 'static,
    {
        let mut callbacks = self.setting_change_callbacks.write().await;
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
        let task_progress_callbacks = self.task_progress_callbacks.clone();
        let task_error_callbacks = self.task_error_callbacks.clone();
        let download_progress_callbacks = self.download_progress_callbacks.clone();
        let dedupe_progress_callbacks = self.dedupe_progress_callbacks.clone();
        let dedupe_finished_callbacks = self.dedupe_finished_callbacks.clone();
        let wallpaper_update_image_callbacks = self.wallpaper_update_image_callbacks.clone();
        let wallpaper_update_style_callbacks = self.wallpaper_update_style_callbacks.clone();
        let wallpaper_update_transition_callbacks = self.wallpaper_update_transition_callbacks.clone();
        let setting_change_callbacks = self.setting_change_callbacks.clone();

        tokio::spawn(async move {
            let client = IpcClient::new();
            
            // 建立长连接并持续接收事件
            let _ = client.subscribe_events_stream(move |raw| {
                let callbacks = callbacks.clone();
                let task_log_callbacks = task_log_callbacks.clone();
                let download_state_callbacks = download_state_callbacks.clone();
                let task_status_callbacks = task_status_callbacks.clone();
                let task_progress_callbacks = task_progress_callbacks.clone();
                let task_error_callbacks = task_error_callbacks.clone();
                let download_progress_callbacks = download_progress_callbacks.clone();
                let dedupe_progress_callbacks = dedupe_progress_callbacks.clone();
                let dedupe_finished_callbacks = dedupe_finished_callbacks.clone();
                let wallpaper_update_image_callbacks = wallpaper_update_image_callbacks.clone();
                let wallpaper_update_style_callbacks = wallpaper_update_style_callbacks.clone();
                let wallpaper_update_transition_callbacks = wallpaper_update_transition_callbacks.clone();
                let setting_change_callbacks = setting_change_callbacks.clone();
                
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
                        &task_progress_callbacks,
                        &task_error_callbacks,
                        &download_progress_callbacks,
                        &dedupe_progress_callbacks,
                        &dedupe_finished_callbacks,
                        &wallpaper_update_image_callbacks,
                        &wallpaper_update_style_callbacks,
                        &wallpaper_update_transition_callbacks,
                        &setting_change_callbacks,
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
        task_progress_callbacks: &Arc<RwLock<Vec<Arc<dyn Fn(TaskProgressEvent) + Send + Sync>>>>,
        task_error_callbacks: &Arc<RwLock<Vec<Arc<dyn Fn(TaskErrorEvent) + Send + Sync>>>>,
        download_progress_callbacks: &Arc<RwLock<Vec<Arc<dyn Fn(DownloadProgressEvent) + Send + Sync>>>>,
        dedupe_progress_callbacks: &Arc<RwLock<Vec<Arc<dyn Fn(DedupeProgressEvent) + Send + Sync>>>>,
        dedupe_finished_callbacks: &Arc<RwLock<Vec<Arc<dyn Fn(DedupeFinishedEvent) + Send + Sync>>>>,
        wallpaper_update_image_callbacks: &Arc<RwLock<Vec<Arc<dyn Fn(WallpaperUpdateImageEvent) + Send + Sync>>>>,
        wallpaper_update_style_callbacks: &Arc<RwLock<Vec<Arc<dyn Fn(WallpaperUpdateStyleEvent) + Send + Sync>>>>,
        wallpaper_update_transition_callbacks: &Arc<RwLock<Vec<Arc<dyn Fn(WallpaperUpdateTransitionEvent) + Send + Sync>>>>,
        setting_change_callbacks: &Arc<RwLock<Vec<Arc<dyn Fn(SettingChangeEvent) + Send + Sync>>>>,
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
            DaemonEvent::TaskProgress { task_id, progress } => {
                let cbs = task_progress_callbacks.read().await;
                let event = TaskProgressEvent {
                    task_id: task_id.clone(),
                    progress: *progress,
                };
                for callback in cbs.iter() {
                    callback(event.clone());
                }
            }
            DaemonEvent::TaskError { task_id, error } => {
                let cbs = task_error_callbacks.read().await;
                let event = TaskErrorEvent {
                    task_id: task_id.clone(),
                    error: error.clone(),
                };
                for callback in cbs.iter() {
                    callback(event.clone());
                }
            }
            DaemonEvent::DownloadProgress { task_id, url, start_time, plugin_id, received_bytes, total_bytes } => {
                let cbs = download_progress_callbacks.read().await;
                let event = DownloadProgressEvent {
                    task_id: task_id.clone(),
                    url: url.clone(),
                    start_time: *start_time,
                    plugin_id: plugin_id.clone(),
                    received_bytes: *received_bytes,
                    total_bytes: *total_bytes,
                };
                for callback in cbs.iter() {
                    callback(event.clone());
                }
            }
            DaemonEvent::DedupeProgress { processed, total, removed, batch_index } => {
                let cbs = dedupe_progress_callbacks.read().await;
                let event = DedupeProgressEvent {
                    processed: *processed,
                    total: *total,
                    removed: *removed,
                    batch_index: *batch_index,
                };
                for callback in cbs.iter() {
                    callback(event.clone());
                }
            }
            DaemonEvent::DedupeFinished { processed, total, removed, canceled } => {
                let cbs = dedupe_finished_callbacks.read().await;
                let event = DedupeFinishedEvent {
                    processed: *processed,
                    total: *total,
                    removed: *removed,
                    canceled: *canceled,
                };
                for callback in cbs.iter() {
                    callback(event.clone());
                }
            }
            DaemonEvent::WallpaperUpdateImage { image_path } => {
                let cbs = wallpaper_update_image_callbacks.read().await;
                let event = WallpaperUpdateImageEvent {
                    image_path: image_path.clone(),
                };
                for callback in cbs.iter() {
                    callback(event.clone());
                }
            }
            DaemonEvent::WallpaperUpdateStyle { style } => {
                let cbs = wallpaper_update_style_callbacks.read().await;
                let event = WallpaperUpdateStyleEvent {
                    style: style.clone(),
                };
                for callback in cbs.iter() {
                    callback(event.clone());
                }
            }
            DaemonEvent::WallpaperUpdateTransition { transition } => {
                let cbs = wallpaper_update_transition_callbacks.read().await;
                let event = WallpaperUpdateTransitionEvent {
                    transition: transition.clone(),
                };
                for callback in cbs.iter() {
                    callback(event.clone());
                }
            }
            DaemonEvent::SettingChange { changes } => {
                let cbs = setting_change_callbacks.read().await;
                let event = SettingChangeEvent {
                    changes: changes.clone(),
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

/// 简化的 API：监听任务进度
pub async fn on_task_progress<F>(callback: F)
where
    F: Fn(TaskProgressEvent) + Send + Sync + 'static,
{
    get_global_listener().on_task_progress(callback).await;
}

/// 简化的 API：监听任务错误
pub async fn on_task_error<F>(callback: F)
where
    F: Fn(TaskErrorEvent) + Send + Sync + 'static,
{
    get_global_listener().on_task_error(callback).await;
}

/// 简化的 API：监听下载进度
pub async fn on_download_progress<F>(callback: F)
where
    F: Fn(DownloadProgressEvent) + Send + Sync + 'static,
{
    get_global_listener().on_download_progress(callback).await;
}

/// 简化的 API：监听去重进度
pub async fn on_dedupe_progress<F>(callback: F)
where
    F: Fn(DedupeProgressEvent) + Send + Sync + 'static,
{
    get_global_listener().on_dedupe_progress(callback).await;
}

/// 简化的 API：监听去重完成
pub async fn on_dedupe_finished<F>(callback: F)
where
    F: Fn(DedupeFinishedEvent) + Send + Sync + 'static,
{
    get_global_listener().on_dedupe_finished(callback).await;
}

/// 简化的 API：启动监听（长连接模式）
pub async fn start_listening() -> Result<(), String> {
    get_global_listener().start().await
}

/// 简化的 API：停止监听
pub async fn stop_listening() {
    get_global_listener().stop().await;
}

/// 简化的 API：监听壁纸图片更新
pub async fn on_wallpaper_update_image<F>(callback: F)
where
    F: Fn(WallpaperUpdateImageEvent) + Send + Sync + 'static,
{
    get_global_listener().on_wallpaper_update_image(callback).await;
}

/// 简化的 API：监听壁纸样式更新
pub async fn on_wallpaper_update_style<F>(callback: F)
where
    F: Fn(WallpaperUpdateStyleEvent) + Send + Sync + 'static,
{
    get_global_listener().on_wallpaper_update_style(callback).await;
}

/// 简化的 API：监听壁纸过渡效果更新
pub async fn on_wallpaper_update_transition<F>(callback: F)
where
    F: Fn(WallpaperUpdateTransitionEvent) + Send + Sync + 'static,
{
    get_global_listener().on_wallpaper_update_transition(callback).await;
}

/// 简化的 API：监听设置变更
pub async fn on_setting_change<F>(callback: F)
where
    F: Fn(SettingChangeEvent) + Send + Sync + 'static,
{
    get_global_listener().on_setting_change(callback).await;
}
