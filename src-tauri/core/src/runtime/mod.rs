//! 运行时抽象层：提供事件发送和状态管理功能，不依赖 Tauri
//!
//! 这个模块提供了与 Tauri 的 `Manager` 和 `Emitter` trait 类似的抽象，
//! 但完全独立，可以在 daemon 模式或非 Tauri 环境中使用。
//!
//! ## 使用示例
//!
//! ### Daemon 模式（无 Tauri）
//! ```rust
//! use kabegame_core::runtime::{NoopRuntime, Runtime};
//!
//! let runtime = NoopRuntime::new();
//! runtime.manage(plugin_manager);
//! runtime.manage(storage);
//! let pm = runtime.state::<PluginManager>();
//! ```
//!
//! ### Tauri 前端应用（可选）
//! ```rust
//! #[cfg(feature = "tauri-adapter")]
//! use kabegame_core::runtime::tauri_adapter::TauriRuntime;
//!
//! #[cfg(feature = "tauri-adapter")]
//! let runtime = TauriRuntime::new(app.handle().clone());
//! #[cfg(feature = "tauri-adapter")]
//! runtime.manage(plugin_manager);
//! #[cfg(feature = "tauri-adapter")]
//! let pm = runtime.state::<PluginManager>();
//! ```

mod core;
pub use core::*;

pub mod ipc_runtime;

#[cfg(feature = "tauri-adapter")]
pub mod tauri_adapter;
