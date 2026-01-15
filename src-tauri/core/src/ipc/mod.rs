//! CLI daemon 模块：IPC 服务端、客户端和事件监听

pub mod ipc;
pub mod client;
pub mod events;
pub mod broadcaster;

pub use client::IpcClient;
pub use ipc::{CliIpcRequest, CliIpcResponse};
pub use events::{EventListener, DaemonEvent, DownloadStateEvent, TaskStatusEvent};
pub use events::{on_task_log, on_download_state, on_task_status, start_listening, stop_listening};
pub use broadcaster::EventBroadcaster;

