//! IPC 和 Daemon 相关模块
//!
//! 包含所有与 IPC 通信、daemon 服务相关的代码
#![allow(unused)]

pub mod dedupe_service;
pub mod handlers;

// Re-export commonly used types from core
pub use dedupe_service::DedupeService;
pub use handlers::{dispatch_request, Store};
pub use kabegame_core::emitter::GlobalEmitter;
pub use kabegame_core::ipc::server::{EventBroadcaster, SubscriptionManager};
