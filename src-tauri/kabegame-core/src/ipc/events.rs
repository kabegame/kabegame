//! IPC 事件监听器
//!
//! 提供统一的事件监听接口，让所有前端（kabegame、cli）都能
//! 使用相同的 API 来监听 daemon 发送的事件。
//!
//! ## 使用示例
//!
//! ```rust,no_run
//! use kabegame_core::ipc::events::{DaemonEventKind, EventListener};
//!
//! fn main() -> Result<(), String> {
//!     let rt = tokio::runtime::Runtime::new().unwrap();
//!     rt.block_on(async {
//!         let listener = EventListener::new();
//!         listener
//!             .on(DaemonEventKind::TaskLog, |payload| {
//!                 println!("task-log: {}", payload);
//!             })
//!             .await;
//!         listener.start(&[DaemonEventKind::TaskLog]).await?;
//!         Ok(())
//!     })
//! }
//! ```

#[cfg(feature = "ipc-client")]
use crate::ipc::client::daemon_startup;
use crate::storage::tasks::TaskFailedImage;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::RwLock;

macro_rules! daemon_event_kinds {
    (
        $(
            $name:ident
        ),* $(,)?
    ) => {
           /// Daemon 事件种类（不含 payload），用于做"事件 -> 广播器"的固定映射。
        ///
        /// 注意：这是 daemon -> client 的事件流里的"类型"，不是 Tauri 前端的事件名。
        #[repr(usize)]
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
        #[serde(rename_all = "kebab-case")]
        pub enum DaemonEventKind {
            $($name),*
        }

        impl DaemonEventKind {
            /// 已知事件数量（用于初始化固定大小映射表）。
            pub const COUNT: usize = daemon_event_kinds!(@count $($name),*);
            /// 已知事件数量（用于初始化固定大小映射表）。

            pub const ALL: [DaemonEventKind; Self::COUNT] = [
                $(DaemonEventKind::$name),*
            ];
        }
    };

    (@count $($name:ident),*) => {
        <[()]>::len(&[$(daemon_event_kinds!(@unit $name)),*])
    };
    (@unit $name:ident) => { () };
}

daemon_event_kinds! {
    TaskLog,
    DownloadState,
    DownloadProgress,
    Generic,
    ConnectionStatus,
    OrganizeProgress,
    OrganizeFinished,
    WallpaperUpdateImage,
    ImagesChange,
    AlbumImagesChange,
    SettingChange,
    AlbumAdded,
    AlbumChanged,
    AlbumDeleted,
    SurfRecordsChange,
    FailedImagesChange,
    TasksChange,
    DaemonShutdown,
    AutoConfigChange,
    PluginAdded,
    PluginDeleted,
    PluginUpdated,
}

impl DaemonEventKind {
    #[inline]
    pub const fn as_usize(self) -> usize {
        self as usize
    }

    /// 获取事件名（kebab-case，不带引号）
    /// 例如：TaskLog -> "task-log", SettingChange -> "setting-change"
    pub fn as_event_name(&self) -> String {
        match self {
            DaemonEventKind::TaskLog => "task-log",
            DaemonEventKind::DownloadState => "download-state",
            DaemonEventKind::DownloadProgress => "download-progress",
            DaemonEventKind::Generic => "generic",
            DaemonEventKind::ConnectionStatus => "connection-status",
            DaemonEventKind::OrganizeProgress => "organize-progress",
            DaemonEventKind::OrganizeFinished => "organize-finished",
            DaemonEventKind::WallpaperUpdateImage => "wallpaper-update-image",
            DaemonEventKind::ImagesChange => "images-change",
            DaemonEventKind::AlbumImagesChange => "album-images-change",
            DaemonEventKind::SettingChange => "setting-change",
            DaemonEventKind::AlbumAdded => "album-added",
            DaemonEventKind::AlbumChanged => "album-changed",
            DaemonEventKind::AlbumDeleted => "album-deleted",
            DaemonEventKind::SurfRecordsChange => "surf-records-change",
            DaemonEventKind::FailedImagesChange => "failed-images-change",
            DaemonEventKind::TasksChange => "tasks-change",
            DaemonEventKind::DaemonShutdown => "daemon-shutdown",
            DaemonEventKind::AutoConfigChange => "auto-config-change",
            DaemonEventKind::PluginAdded => "plugin-added",
            DaemonEventKind::PluginDeleted => "plugin-deleted",
            DaemonEventKind::PluginUpdated => "plugin-updated",
        }
        .to_string()
    }

    /// 从事件名解析事件类型（kebab-case）
    pub fn from_event_name(s: &str) -> Option<Self> {
        match s {
            "task-log" => Some(DaemonEventKind::TaskLog),
            "download-state" => Some(DaemonEventKind::DownloadState),
            "download-progress" => Some(DaemonEventKind::DownloadProgress),
            "generic" => Some(DaemonEventKind::Generic),
            "connection-status" => Some(DaemonEventKind::ConnectionStatus),
            "organize-progress" => Some(DaemonEventKind::OrganizeProgress),
            "organize-finished" => Some(DaemonEventKind::OrganizeFinished),
            "wallpaper-update-image" => Some(DaemonEventKind::WallpaperUpdateImage),
            "images-change" => Some(DaemonEventKind::ImagesChange),
            "album-images-change" => Some(DaemonEventKind::AlbumImagesChange),
            "setting-change" => Some(DaemonEventKind::SettingChange),
            "album-added" => Some(DaemonEventKind::AlbumAdded),
            "album-changed" => Some(DaemonEventKind::AlbumChanged),
            "album-deleted" => Some(DaemonEventKind::AlbumDeleted),
            "surf-records-change" => Some(DaemonEventKind::SurfRecordsChange),
            "failed-images-change" => Some(DaemonEventKind::FailedImagesChange),
            "tasks-change" => Some(DaemonEventKind::TasksChange),
            "daemon-shutdown" => Some(DaemonEventKind::DaemonShutdown),
            "auto-config-change" => Some(DaemonEventKind::AutoConfigChange),
            "plugin-added" => Some(DaemonEventKind::PluginAdded),
            "plugin-deleted" => Some(DaemonEventKind::PluginDeleted),
            "plugin-updated" => Some(DaemonEventKind::PluginUpdated),
            "TaskAdded" | "TaskDeleted" | "TaskChanged" => Some(DaemonEventKind::TasksChange),
            _ => None,
        }
    }

    /// 从字符串解析事件类型（用于 IPC 协议，支持 JSON 格式和 kebab-case）
    pub fn from_str(s: &str) -> Option<Self> {
        // 先尝试 JSON 格式（向后兼容）
        if let Ok(res) = serde_json::from_str::<Self>(s) {
            return Some(res);
        }
        // 再尝试 kebab-case 格式
        Self::from_event_name(s)
    }
}

/// Daemon 事件类型，绝对不Clone
#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
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
        #[serde(default)]
        native: bool,
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
    ConnectionStatus { connected: bool, message: String },

    /// 整理进度事件
    OrganizeProgress {
        /// 全局顺序下已扫描到的行序号（与内部 `row_index` 一致）
        #[serde(rename = "processedGlobal")]
        processed_global: usize,
        /// 图库图片总数
        #[serde(rename = "libraryTotal")]
        library_total: usize,
        /// 所选区间起点（含），全量时为 `None`
        #[serde(rename = "rangeStart")]
        range_start: Option<usize>,
        /// 所选区间终点（不含），与对话框 `rangeEnd` 一致；全量时为 `None`
        #[serde(rename = "rangeEnd")]
        range_end: Option<usize>,
        removed: usize,
        regenerated: usize,
    },

    /// 整理完成事件
    OrganizeFinished {
        removed: usize,
        regenerated: usize,
        canceled: bool,
    },

    /// `images` 表增删改（reason: `add` | `delete` | `change`）
    ImagesChange {
        reason: String,
        #[serde(rename = "imageIds")]
        image_ids: Vec<String>,
        #[serde(rename = "taskIds", skip_serializing_if = "Option::is_none")]
        task_ids: Option<Vec<String>>,
        #[serde(rename = "surfRecordIds", skip_serializing_if = "Option::is_none")]
        surf_record_ids: Option<Vec<String>>,
        #[serde(rename = "pluginIds", skip_serializing_if = "Option::is_none")]
        plugin_ids: Option<Vec<String>>,
    },

    /// `album_images` 表增删（reason: `add` | `delete`）
    AlbumImagesChange {
        reason: String,
        #[serde(rename = "albumIds")]
        album_ids: Vec<String>,
        #[serde(rename = "imageIds")]
        image_ids: Vec<String>,
    },

    /// 壁纸图片更新事件
    WallpaperUpdateImage {
        #[serde(rename = "imagePath")]
        image_path: String,
    },

    /// 设置变更事件（只包含变化的部分）
    SettingChange {
        /// 变更的设置项，键值对形式
        changes: serde_json::Value,
    },

    /// 画册添加
    AlbumAdded {
        id: String,
        name: String,
        #[serde(rename = "createdAt")]
        created_at: u64,
        #[serde(rename = "parentId", skip_serializing_if = "Option::is_none")]
        parent_id: Option<String>,
    },
    /// 画册属性变更（重命名、移动父级等；`changes` 为增量，如 `{ "name": "..." }`、`{ "parentId": "..." | null }`）
    AlbumChanged {
        #[serde(rename = "albumId")]
        album_id: String,
        changes: serde_json::Value,
    },
    /// 画册删除（底层 DB 删除后发出）
    AlbumDeleted {
        #[serde(rename = "albumId")]
        album_id: String,
    },
    /// 畅游记录新增（完整 JSON，与前端 `SurfRecord` 对齐）
    #[serde(rename = "SurfRecordAdded")]
    SurfRecordAdded { record: serde_json::Value },
    /// 畅游记录删除
    #[serde(rename = "SurfRecordDeleted")]
    SurfRecordDeleted {
        #[serde(rename = "surfRecordId")]
        surf_record_id: String,
    },
    /// 畅游记录字段增量更新（计数、访问时间等）
    #[serde(rename = "SurfRecordChanged")]
    SurfRecordChanged {
        #[serde(rename = "surfRecordId")]
        surf_record_id: String,
        diff: serde_json::Value,
    },
    /// 任务失败图片列表变化
    FailedImagesChange {
        reason: String,
        #[serde(rename = "taskId")]
        task_id: String,
        #[serde(rename = "failedImageIds")]
        failed_image_ids: Option<Vec<i64>>,
        #[serde(rename = "failedImages")]
        failed_images: Option<Vec<TaskFailedImage>>,
        #[serde(rename = "failedImage")]
        failed_image: Option<TaskFailedImage>,
    },
    /// 任务新增（完整任务 JSON）
    #[serde(rename = "TaskAdded")]
    TaskAdded { task: serde_json::Value },
    /// 任务删除（仅 ID）
    #[serde(rename = "TaskDeleted")]
    TaskDeleted {
        #[serde(rename = "taskId")]
        task_id: String,
    },
    /// 任务字段增量更新（status、progress、计数等）
    #[serde(rename = "TaskChanged")]
    TaskChanged {
        #[serde(rename = "taskId")]
        task_id: String,
        diff: serde_json::Value,
    },
    /// Daemon 关闭事件（进程退出前发出）
    DaemonShutdown { reason: String },

    /// 运行配置变更（`reason`: `configadd` | `configdelete` | `configchange`）
    AutoConfigChange {
        reason: String,
        #[serde(rename = "configId")]
        config_id: String,
    },

    /// 插件新增安装（首次安装）
    PluginAdded { plugin: serde_json::Value },
    /// 插件卸载
    PluginDeleted {
        #[serde(rename = "pluginId")]
        plugin_id: String,
    },
    /// 插件更新/重装（同 ID 覆盖安装）
    PluginUpdated { plugin: serde_json::Value },
}

/// 包装在 Arc 中的 Daemon 事件，用于零拷贝传递
pub type ArcDaemonEvent = Arc<DaemonEvent>;

impl DaemonEvent {
    /// 获取事件种类（用于路由到对应广播器）。
    /// TODO: 这个函数太长不好维护
    #[inline]
    pub fn kind(&self) -> DaemonEventKind {
        match self {
            DaemonEvent::TaskLog { .. } => DaemonEventKind::TaskLog,
            DaemonEvent::DownloadState { .. } => DaemonEventKind::DownloadState,
            DaemonEvent::DownloadProgress { .. } => DaemonEventKind::DownloadProgress,
            DaemonEvent::Generic { .. } => DaemonEventKind::Generic,
            DaemonEvent::ConnectionStatus { .. } => DaemonEventKind::ConnectionStatus,
            DaemonEvent::OrganizeProgress { .. } => DaemonEventKind::OrganizeProgress,
            DaemonEvent::OrganizeFinished { .. } => DaemonEventKind::OrganizeFinished,
            DaemonEvent::ImagesChange { .. } => DaemonEventKind::ImagesChange,
            DaemonEvent::AlbumImagesChange { .. } => DaemonEventKind::AlbumImagesChange,
            DaemonEvent::WallpaperUpdateImage { .. } => DaemonEventKind::WallpaperUpdateImage,
            DaemonEvent::SettingChange { .. } => DaemonEventKind::SettingChange,
            DaemonEvent::AlbumAdded { .. } => DaemonEventKind::AlbumAdded,
            DaemonEvent::AlbumChanged { .. } => DaemonEventKind::AlbumChanged,
            DaemonEvent::AlbumDeleted { .. } => DaemonEventKind::AlbumDeleted,
            DaemonEvent::SurfRecordAdded { .. }
            | DaemonEvent::SurfRecordDeleted { .. }
            | DaemonEvent::SurfRecordChanged { .. } => DaemonEventKind::SurfRecordsChange,
            DaemonEvent::FailedImagesChange { .. } => DaemonEventKind::FailedImagesChange,
            DaemonEvent::TaskAdded { .. }
            | DaemonEvent::TaskDeleted { .. }
            | DaemonEvent::TaskChanged { .. } => DaemonEventKind::TasksChange,
            DaemonEvent::DaemonShutdown { .. } => DaemonEventKind::DaemonShutdown,
            DaemonEvent::AutoConfigChange { .. } => DaemonEventKind::AutoConfigChange,
            DaemonEvent::PluginAdded { .. } => DaemonEventKind::PluginAdded,
            DaemonEvent::PluginDeleted { .. } => DaemonEventKind::PluginDeleted,
            DaemonEvent::PluginUpdated { .. } => DaemonEventKind::PluginUpdated,
        }
    }
}

#[cfg(feature = "ipc-client")]
use std::collections::HashMap;

/// 事件回调类型（接收原始 JSON payload）
#[cfg(feature = "ipc-client")]
pub type EventCallback = Arc<dyn Fn(serde_json::Value) + Send + Sync>;

/// 默认事件发送器（用于无回调时自动转发到前端）
#[cfg(feature = "ipc-client")]
pub type DefaultEmitter = Arc<dyn Fn(&str, serde_json::Value) + Send + Sync>;

/// 事件监听器
#[cfg(feature = "ipc-client")]
pub struct EventListener {
    /// 按事件类型组织的回调表：kind -> Vec<callback>
    callbacks: Arc<RwLock<HashMap<DaemonEventKind, Vec<EventCallback>>>>,
    /// 默认事件发送器（当某个 kind 没有回调时使用）
    default_emitter: Arc<RwLock<Option<DefaultEmitter>>>,
}

#[cfg(feature = "ipc-client")]
impl Default for EventListener {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(feature = "ipc-client")]
impl EventListener {
    /// 创建新的事件监听器
    pub fn new() -> Self {
        Self {
            callbacks: Arc::new(RwLock::new(HashMap::new())),
            default_emitter: Arc::new(RwLock::new(None)),
        }
    }

    /// 注册事件回调：按事件类型注册，回调接收原始 JSON payload
    ///
    /// # 参数
    /// - `kind`: 事件类型
    /// - `callback`: 回调函数，接收 `serde_json::Value`（原始 payload）
    ///
    /// # 行为
    /// - 如果某个 `kind` 注册了回调，则只执行回调（不自动转发）
    /// - 如果某个 `kind` 没有回调，且设置了默认 emitter，则自动转发
    pub async fn on<F>(&self, kind: DaemonEventKind, callback: F)
    where
        F: Fn(serde_json::Value) + Send + Sync + 'static,
    {
        let mut callbacks = self.callbacks.write().await;
        callbacks
            .entry(kind)
            .or_insert_with(Vec::new)
            .push(Arc::new(callback));
    }

    /// 设置默认事件发送器（用于无回调时自动转发到前端）
    ///
    /// # 参数
    /// - `emitter`: 发送器函数，接收 `(event_name: &str, payload: serde_json::Value)`
    pub async fn set_default_emitter<F>(&self, emitter: F)
    where
        F: Fn(&str, serde_json::Value) + Send + Sync + 'static,
    {
        let mut default_emitter = self.default_emitter.write().await;
        *default_emitter = Some(Arc::new(emitter));
    }

    /// 启动事件监听（长连接模式，按事件类型过滤）
    ///
    /// 建立长连接并持续接收服务器推送的事件，适用于全双工 IPC
    /// kinds 为空表示订阅全部事件
    ///
    /// 此方法会监听连接状态，当连接上时自动注册事件，断开时自动停止并释放资源
    /// 当连接状态通道关闭时，监听循环会自动退出
    pub async fn start(&self, kinds: &[DaemonEventKind]) -> Result<(), String> {
        let callbacks = self.callbacks.clone();
        let default_emitter = self.default_emitter.clone();
        let kinds_vec = kinds.to_vec();

        tokio::spawn(async move {
            // 使用全局 IpcClient（与请求共享连接）
            let client = daemon_startup::get_ipc_client();

            // 获取连接状态订阅
            let mut status_rx = client.subscribe_connection_status();

            // 当前事件订阅任务的句柄（用于在断开时取消）
            let mut event_task_handle: Option<tokio::task::JoinHandle<()>> = None;

            loop {
                // 监听连接状态变化
                match status_rx.changed().await {
                    Ok(()) => {
                        let status = *status_rx.borrow();
                        eprintln!("[DEBUG] EventListener 连接状态变化: {:?}", status);

                        match status {
                            crate::ipc::client::ConnectionStatus::Connected => {
                                // 连接上：启动事件订阅任务
                                if event_task_handle.is_none() {
                                    eprintln!("[DEBUG] EventListener 连接已建立，开始订阅事件");

                                    let callbacks_clone = callbacks.clone();
                                    let default_emitter_clone = default_emitter.clone();
                                    let kinds_clone = kinds_vec.clone();
                                    let mut client_clone = client.clone();

                                    let task = tokio::spawn(async move {
                                        // 建立长连接并持续接收事件（带过滤）
                                        let _ = client_clone
                                            .subscribe_events_stream(&kinds_clone, move |raw: serde_json::Value| {
                                                let callbacks = callbacks_clone.clone();
                                                let default_emitter = default_emitter_clone.clone();

                                                async move {
                                                    eprintln!("[DEBUG] EventListener 收到事件: {:?}", raw);

                                                    // 从 payload 解析事件类型
                                                    let kind = if let Some(type_val) = raw.get("type") {
                                                        if let Some(type_str) = type_val.as_str() {
                                                            DaemonEventKind::from_str(type_str)
                                                        } else {
                                                            None
                                                        }
                                                    } else {
                                                        None
                                                    };

                                                    let kind = match kind {
                                                        Some(k) => k,
                                                        None => {
                                                            eprintln!("[ipc-events] 无法解析事件类型，raw: {:?}", raw);
                                                            return;
                                                        }
                                                    };

                                                    // 检查是否有该 kind 的回调
                                                    let has_callbacks = {
                                                        let callbacks_guard = callbacks.read().await;
                                                        callbacks_guard
                                                            .get(&kind)
                                                            .map(|v| !v.is_empty())
                                                            .unwrap_or(false)
                                                    };

                                                    if has_callbacks {
                                                        // 有回调：执行所有回调
                                                        let callbacks_guard = callbacks.read().await;
                                                        if let Some(cb_list) = callbacks_guard.get(&kind) {
                                                            for cb in cb_list.iter() {
                                                                cb(raw.clone());
                                                            }
                                                        }
                                                    } else {
                                                        // 无回调：使用默认 emitter（如果设置了）
                                                        let default_emitter_guard = default_emitter.read().await;
                                                        if let Some(emitter) = default_emitter_guard.as_ref() {
                                                            let event_name = kind.as_event_name();

                                                            // Generic 事件特殊处理：使用 event 字段作为事件名，payload 用 payload 字段
                                                            if kind == DaemonEventKind::Generic {
                                                                if let (Some(event_name_val), Some(payload_val)) = (
                                                                    raw.get("event").and_then(|v: &serde_json::Value| v.as_str()),
                                                                    raw.get("payload"),
                                                                ) {
                                                                    emitter(event_name_val, payload_val.clone());
                                                                }
                                                            } else {
                                                                // 其他事件：使用 kind 对应的事件名，payload 为整个 raw
                                                                emitter(&event_name, raw);
                                                            }
                                                        }
                                                    }
                                                }
                                            })
                                            .await;

                                        eprintln!("[DEBUG] EventListener 事件流已结束");
                                    });

                                    event_task_handle = Some(task);
                                }
                            }
                            crate::ipc::client::ConnectionStatus::Disconnected => {
                                // 断开连接：停止并释放事件订阅任务
                                if let Some(handle) = event_task_handle.take() {
                                    eprintln!("[DEBUG] EventListener 连接已断开，停止事件订阅");
                                    handle.abort();
                                }
                            }
                            crate::ipc::client::ConnectionStatus::Connecting => {
                                // 正在连接：不做任何操作，等待连接完成或失败
                            }
                        }
                    }
                    Err(_) => {
                        // 连接状态通道已关闭，退出循环
                        eprintln!("[DEBUG] EventListener 连接状态通道已关闭，退出监听循环");
                        // 取消当前事件订阅任务
                        if let Some(handle) = event_task_handle.take() {
                            handle.abort();
                        }
                        break;
                    }
                }
            }

            eprintln!("[DEBUG] EventListener 主循环已退出");
        });

        Ok(())
    }
}

/// 全局事件监听器（单例）
#[cfg(feature = "ipc-client")]
static GLOBAL_LISTENER: std::sync::OnceLock<EventListener> = std::sync::OnceLock::new();

/// 获取全局事件监听器
#[cfg(feature = "ipc-client")]
pub fn get_global_listener() -> &'static EventListener {
    GLOBAL_LISTENER.get_or_init(|| EventListener::new())
}

/// 简化的 API：启动监听（长连接模式，按事件类型过滤）
#[cfg(feature = "ipc-client")]
pub async fn start_listening(kinds: &[DaemonEventKind]) -> Result<(), String> {
    get_global_listener().start(kinds).await
}
