//! Kabegame 后端核心库入口（供多个 app crate 复用）。

pub mod app_paths;
pub mod bin_finder;
pub mod ipc;

pub mod archive;
pub mod crawler;

pub mod gallery;
pub mod kgpg;
pub mod plugin;
pub mod providers;

pub mod emitter;
pub mod settings;
pub mod shell_open;
pub mod storage;
pub mod workarounds;

// 只有 Windows 平台需要导出 wallpaper_engine_export 模块
#[cfg(target_os = "windows")]
pub mod wallpaper_engine_export;
#[cfg(target_os = "windows")]
pub mod windows_effects;

/// 虚拟盘（Windows Dokan）。
///
/// 注意：该模块仅在启用 feature `virtual-driver` 时编译，避免在不需要 VD 的 app（如 plugin-editor）里引入 Dokan 相关依赖。
#[cfg(all(not(kabegame_mode = "light"), not(target_os = "android")))]
pub mod virtual_driver;

const BUILD_MODE: &str = env!("KABEGAME_BUILD_MODE"); // injected by build.rs

pub fn is_local_mode() -> bool {
    BUILD_MODE == "local"
}

pub fn is_light_mode() -> bool {
    BUILD_MODE == "light"
}

pub fn is_normal_mode() -> bool {
    BUILD_MODE == "normal"
}