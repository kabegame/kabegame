//! Kabegame 后端核心库入口（供多个 app crate 复用）。

pub mod app_paths;
pub mod crawler;
pub mod dedupe;
pub mod gallery;
pub mod kgpg;
pub mod plugin;
pub mod providers;
pub mod settings;
pub mod shell_open;
pub mod storage;
#[cfg(feature = "tray")]
pub mod tray;
// 非windows也可以有虚拟盘
#[cfg(feature = "virtual-drive")]
pub mod virtual_drive;
#[cfg(feature = "wallpaper")]
pub mod wallpaper;
// 只有 Windows 平台需要导出 wallpaper_engine_export 模块
#[cfg(target_os = "windows")]
pub mod wallpaper_engine_export;
#[cfg(target_os = "windows")]
pub mod windows_effects;
