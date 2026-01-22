//! 运行时抽象层：提供事件发送和状态管理功能，不依赖 Tauri
//!
//! 这个模块提供了与 Tauri 的 `Manager` 和 `Emitter` trait 类似的抽象，
//! 但完全独立，可以在 daemon 模式或非 Tauri 环境中使用。
//! 只要开启了 ipc-server 或者 ipc-client feature，就会使用 IPC 运行时。
//! 否则使用 Tauri 运行时。

mod core;
pub use core::*;

// IPC 服务器将用这个runtime发送事件
#[cfg(feature = "ipc-server")]
pub mod ipc_runtime;

#[cfg(not(any(feature = "ipc-server", feature = "ipc-client")))]
pub mod tauri_runtime;

pub mod global_emitter;
