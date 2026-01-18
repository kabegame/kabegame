//! CLI daemon 模块：IPC 服务端、客户端和事件监听

pub mod ipc;
pub mod client;
pub mod connection;
pub mod server;
pub mod events;
pub mod broadcaster;

#[cfg(feature = "tauri")]
pub mod event_listeners;

pub use client::IpcClient;
pub use ipc::{CliIpcRequest, CliIpcResponse};
pub use events::{
    DaemonEvent, DedupeFinishedEvent, DedupeProgressEvent, DownloadStateEvent, EventListener,
    SettingChangeEvent, TaskProgressEvent, TaskStatusEvent,
};
pub use events::{
    on_dedupe_finished, on_dedupe_progress, on_download_state, on_setting_change, on_task_log, on_task_progress,
    on_task_status, start_listening, stop_listening,
};
pub use broadcaster::EventBroadcaster;

#[cfg(feature = "tauri")]
pub use event_listeners::{init_event_listeners, start_event_listener, stop_event_listener};
