//! IPC 客户端模块
//!
//! 提供 IPC 客户端实现，包括连接管理、请求处理和 daemon 启动

pub mod connection;
pub mod daemon_startup;
pub mod daemon_status;

// Re-export for convenience
pub use connection::ConnectionStatus;
pub use daemon_startup::get_ipc_client;
pub use daemon_startup::IPC_CLIENT;

// IpcClient 定义在 mod.rs 中（从原来的 client.rs 移动过来）
mod client;

pub use client::IpcClient;
