//! IPC 服务器模块
//!
//! 提供 IPC 服务器端实现，包括事件广播、订阅管理和连接处理

#[cfg(feature = "ipc-server")]
mod connection_handler;
#[cfg(feature = "ipc-server")]
mod server_impl;

#[cfg(feature = "ipc-server")]
#[cfg(any(target_os = "linux", target_os = "macos"))]
mod server_unix;

#[cfg(feature = "ipc-server")]
#[cfg(target_os = "windows")]
mod server_windows;

#[cfg(feature = "ipc-server")]
pub use connection_handler::handle_connection;
#[cfg(feature = "ipc-server")]
pub use server_impl::{serve_with_events, EventBroadcaster, SubscriptionManager};
