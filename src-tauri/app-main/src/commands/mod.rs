// Commands 模块
pub mod daemon;
pub mod plugin;
pub mod storage;
pub mod filesystem;
pub mod wallpaper;
pub mod window;
pub mod album;
pub mod image;
pub mod settings;
pub mod task;
pub mod misc;

#[cfg(feature = "virtual-drive")]
pub mod virtual_drive;

#[cfg(target_os = "windows")]
pub mod wallpaper_engine;
