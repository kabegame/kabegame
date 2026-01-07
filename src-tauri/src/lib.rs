//! Kabegame 后端库入口。
//!
//! 说明：
//! - 现有 GUI 入口在 `main.rs`，但为了复用逻辑给额外的 CLI/sidecar 二进制，
//!   这里提供一个 `lib.rs`，让 `src/bin/*.rs` 可以直接复用模块实现。

pub mod app_paths;
pub mod crawler;
#[cfg(debug_assertions)]
pub mod debug_tools;
pub mod dedupe;
pub mod kgpg;
pub mod plugin;
pub mod plugin_editor;
pub mod settings;
pub mod storage;
pub mod tray;
pub mod wallpaper;
pub mod wallpaper_engine_export;


