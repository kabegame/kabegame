//! IPC 和 Daemon 相关模块
//!
//! 包含所有与 IPC 通信、daemon 服务相关的代码
#![allow(unused)]

#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub mod dedupe_service;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub mod handlers;

// Re-export commonly used types from core
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub use dedupe_service::DedupeService;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub use handlers::{dispatch_request, Store};
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub use kabegame_core::emitter::GlobalEmitter;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub use kabegame_core::ipc::server::{EventBroadcaster, SubscriptionManager};
