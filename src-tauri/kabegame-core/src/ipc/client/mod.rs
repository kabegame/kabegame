//! IPC 客户端模块
//!
//! 提供 IPC 客户端实现，包括连接管理、请求处理和客户端单例。

pub mod connection;
pub mod client_instance;

// Re-export for convenience
pub use connection::ConnectionStatus;
pub use client_instance::get_ipc_client;
pub use client_instance::IPC_CLIENT;

// IpcClient 定义在 mod.rs 中（从原来的 client.rs 移动过来）
mod client;

pub use client::IpcClient;
