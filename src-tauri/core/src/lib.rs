//! Kabegame 后端核心库入口（供多个 app crate 复用）。

pub mod app_paths;
pub mod crawler;
pub mod dedupe;
pub mod kgpg;
pub mod plugin;
pub mod plugin_editor;
pub mod settings;
pub mod storage;
#[cfg(feature = "wallpaper")]
pub mod tray;
#[cfg(feature = "wallpaper")]
pub mod wallpaper;
pub mod wallpaper_engine_export;
