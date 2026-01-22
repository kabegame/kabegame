//! CLI daemon 模块：IPC 服务端、客户端和事件监听

// 共享模块：协议定义和事件类型（客户端和服务端都需要）
pub mod events;
pub mod ipc;

// 服务端模块
#[cfg(feature = "ipc-server")]
pub mod broadcaster;
#[cfg(feature = "ipc-server")]
pub mod subscription;

// 客户端模块
#[cfg(feature = "ipc-client")]
pub mod client;
#[cfg(feature = "ipc-client")]
pub mod connection;
#[cfg(feature = "ipc-client")]
pub mod daemon_startup;

// 共享导出（客户端和服务端都需要）
pub use events::DaemonEvent;
pub use ipc::{CliIpcRequest, CliIpcResponse};

// 服务端导出
#[cfg(feature = "ipc-server")]
pub use broadcaster::EventBroadcaster;
#[cfg(feature = "ipc-server")]
pub use subscription::SubscriptionManager;

// 客户端导出
#[cfg(feature = "ipc-client")]
pub use client::IpcClient;
#[cfg(feature = "ipc-client")]
pub use connection::ConnectionStatus;
#[cfg(feature = "ipc-client")]
pub use events::*;
#[cfg(feature = "ipc-client")]
pub use events::*;
