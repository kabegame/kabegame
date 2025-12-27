pub mod manager;
pub mod rotator;
pub mod window;

// 导出主要类型供外部使用
pub use rotator::WallpaperRotator;
pub use window::WallpaperWindow;

// 导出管理器类型
pub use manager::WallpaperController;
