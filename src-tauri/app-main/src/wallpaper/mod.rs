pub mod manager;
pub mod rotator;
#[cfg(target_os = "windows")]
pub mod window;
#[cfg(target_os = "windows")]
pub mod window_mount;
#[cfg(target_os = "windows")]
pub mod engine_export;

// 导出主要类型供外部使用
pub use rotator::WallpaperRotator;
#[cfg(target_os = "windows")]
pub use window::WallpaperWindow;

// 导出管理器类型
pub use manager::WallpaperController;
