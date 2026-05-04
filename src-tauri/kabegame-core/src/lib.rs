//! Kabegame 后端核心库入口（供多个 app crate 复用）。

pub mod app_paths;
pub mod bin_finder;
pub mod image_type;
pub mod ipc;

pub mod crawler;

/// 兼容旧路径：archive 已迁至 crawler::archiver
pub use crawler::archiver as archive;

pub mod gallery;
pub mod kgpg;
pub mod media_dimensions;
pub mod plugin;
pub mod providers;

pub mod emitter;
pub mod schedule_sync;
pub mod scheduler;
pub mod settings;
pub mod shell_open;
pub mod storage;
pub mod workarounds;

// 只有 Windows 平台需要导出 wallpaper_engine_export 模块
#[cfg(target_os = "windows")]
pub mod wallpaper_engine_export;

/// 虚拟盘。
///
/// 注意：该模块仅在启用 feature `virtual-driver` 时编译，避免在不需要 VD 的 app 里引入相关依赖。
/// 6b 起：VfsSemantics 用 ProviderQuery + Storage 替代旧 Provider::list_images /
/// get_meta-typed-enum；部分动态目录列举功能临时为 stub 状态，
/// 待 Phase 6c SqlExecutor 接入后完整恢复。
#[cfg(feature = "virtual-driver")]
pub mod virtual_driver;

pub fn is_standard_mode() -> bool {
    cfg!(feature = "virtual-driver")
}

pub fn is_light_mode() -> bool {
    !cfg!(feature = "virtual-driver")
}
