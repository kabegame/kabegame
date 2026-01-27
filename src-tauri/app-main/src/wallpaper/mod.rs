#[cfg(target_os = "windows")]
pub mod engine_export;
pub mod manager;
pub mod rotator;
#[cfg(target_os = "windows")]
pub mod window;
#[cfg(target_os = "windows")]
pub mod window_mount;

// 轮播器
pub use rotator::WallpaperRotator;
#[cfg(target_os = "windows")]
pub use window::WallpaperWindow;

// 蟇ｼ蜃ｺ邂｡逅・勣邀ｻ蝙・
pub use manager::WallpaperController;
