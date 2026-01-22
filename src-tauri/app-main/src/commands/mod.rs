// Commands 模块
pub mod album;
pub mod daemon;
pub mod filesystem;
pub mod image;
pub mod misc;
pub mod plugin;
pub mod settings;
pub mod storage;
pub mod task;
pub mod wallpaper;
pub mod window;

#[cfg(target_os = "windows")]
pub mod wallpaper_engine;
