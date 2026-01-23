//! CLI daemon 模块：IPC 服务端、客户端和事件监听
//!
//! 模块结构：
//! - 公共部分（events, ipc）：所有模块共享
//! - server 模块：IPC 服务器端实现（需要 ipc-server feature）
//! - client 模块：IPC 客户端实现（需要 ipc-client feature）

// ==================== 公共模块（所有模块共享） ====================
// 共享模块：协议定义和事件类型（客户端和服务端都需要）
pub mod events;
pub mod ipc;

// 共享导出（客户端和服务端都需要）
pub use events::DaemonEvent;
pub use ipc::{CliIpcRequest, CliIpcResponse};

// ==================== 服务器模块（需要 ipc-server feature） ====================
#[cfg(feature = "ipc-server")]
pub mod server;

#[cfg(feature = "ipc-server")]
pub use server::{serve_with_events, EventBroadcaster, SubscriptionManager};

// ==================== 客户端模块（需要 ipc-client feature） ====================
#[cfg(feature = "ipc-client")]
pub mod client;

// 客户端导出
#[cfg(feature = "ipc-client")]
pub use client::ConnectionStatus;
#[cfg(feature = "ipc-client")]
pub use client::IpcClient;
