#[cfg(target_os = "windows")]
pub mod engine_export;
pub mod manager;
pub mod rotator;
#[cfg(any(target_os = "windows", target_os = "macos"))]
pub mod window;
#[cfg(target_os = "windows")]
pub mod window_mount;
#[cfg(target_os = "macos")]
pub mod window_mount_macos;

// 轮播器
pub use rotator::WallpaperRotator;
#[cfg(any(target_os = "windows", target_os = "macos"))]
pub use window::WallpaperWindow;

// 蟇ｼ蜃ｺ邂｡逅・勣邀ｻ蝙・
pub use manager::WallpaperController;
