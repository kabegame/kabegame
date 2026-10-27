pub mod manager;
pub mod rotator;
#[cfg(any(target_os = "windows", target_os = "macos"))]
pub mod window;
#[cfg(target_os = "macos")]
pub mod window_mount_macos;
// 桌面网页壁纸（x-wpe/web）的 file:// 宿主与 Windows 桌面鼠标转发
#[cfg(target_os = "windows")]
pub mod input_forward;
#[cfg(any(target_os = "windows", target_os = "macos"))]
pub mod wpe_web_host;

// 轮播器
pub use rotator::WallpaperRotator;
#[cfg(any(target_os = "windows", target_os = "macos"))]
pub use window::WallpaperWindow;

// 蟇ｼ蜃ｺ邂｡逅・勣邀ｻ蝙・
pub use manager::WallpaperController;
