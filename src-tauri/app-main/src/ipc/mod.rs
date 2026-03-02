//! IPC 和 Daemon 相关模块
//!
//! 包含所有与 IPC 通信、daemon 服务相关的代码
#![allow(unused)]

#[cfg(not(target_os = "android"))]
pub mod dedupe_service;
#[cfg(not(target_os = "android"))]
pub mod handlers;

// Re-export commonly used types from core
#[cfg(not(target_os = "android"))]
pub use dedupe_service::DedupeService;
#[cfg(not(target_os = "android"))]
pub use handlers::dispatch_request;
#[cfg(not(target_os = "android"))]
pub use kabegame_core::emitter::GlobalEmitter;
#[cfg(not(target_os = "android"))]
pub use kabegame_core::ipc::server::{EventBroadcaster, SubscriptionManager};
