//! CLI daemon 模块：IPC 服务端、客户端和事件监听

// 共享模块：协议定义和事件类型（客户端和服务端都需要）
pub mod events;
pub mod ipc;

// 客户端模块
#[cfg(feature = "ipc")]
pub mod client;
#[cfg(feature = "ipc")]
pub mod connection;
#[cfg(feature = "ipc")]
pub mod daemon_startup;

// 共享导出（客户端和服务端都需要）
pub use events::DaemonEvent;
pub use ipc::{CliIpcRequest, CliIpcResponse};

// 客户端导出
#[cfg(feature = "ipc")]
pub use client::IpcClient;
#[cfg(feature = "ipc")]
pub use connection::ConnectionStatus;
pub use events::*;
pub use events::*;
