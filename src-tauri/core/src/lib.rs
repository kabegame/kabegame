//! Kabegame 后端核心库入口（供多个 app crate 复用）。

pub mod app_paths;
pub mod bin_finder;
pub mod emitter;
pub mod ipc;

pub mod crawler;
// 去重任务管理器（GUI/本地模式使用）。daemon 侧只需要 storage::dedupe 的扫描能力。
#[cfg(feature = "tauri")]
pub mod dedupe;

pub mod gallery;
pub mod kgpg;
pub mod plugin;
pub mod providers;
pub mod runtime;
pub mod settings;
pub mod shell_open;
pub mod storage;
// 只有 Windows 平台需要导出 wallpaper_engine_export 模块
#[cfg(target_os = "windows")]
pub mod wallpaper_engine_export;
#[cfg(target_os = "windows")]
pub mod windows_effects;

/// 虚拟盘（Windows Dokan）。
///
/// 注意：该模块仅在启用 feature `virtual-driver` 时编译，避免在不需要 VD 的 app（如 plugin-editor）里引入 Dokan 相关依赖。
#[cfg(feature = "virtual-driver")]
pub mod virtual_driver;
