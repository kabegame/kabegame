//! 应用 IPC 模块。
//!
//! 包含请求分发、事件广播与订阅管理。

#[cfg(not(target_os = "android"))]
pub mod handlers;

// Re-export commonly used types from core
#[cfg(not(target_os = "android"))]
pub use handlers::dispatch_request;
#[cfg(not(target_os = "android"))]
pub use kabegame_core::emitter::GlobalEmitter;
#[cfg(not(target_os = "android"))]
pub use kabegame_core::ipc::server::{EventBroadcaster, SubscriptionManager};
