//! 虚拟盘模块（跨平台门面）。
//!
//! - 具体平台实现放在子模块中：Windows 使用 Dokan；其他平台暂提供 no-op/stub，便于后续扩展。
//!
//! 整个模块仅在启用 feature `virtual-driver` 时编译（见 lib.rs 的模块声明）。

pub mod driver_service;
#[cfg(target_os = "windows")]
mod fs;
mod semantics;
pub(crate) mod vd_locale_sync;
mod virtual_drive_io;
#[cfg(target_os = "windows")]
mod virtual_drive_io_windows;
#[cfg(target_os = "windows")]
mod windows;
#[cfg(not(target_os = "windows"))]
mod fuse;
// 从 drive_service 模块导出 VirtualDriveService（根据平台自动选择实现）

pub use driver_service::VirtualDriveService;
pub use vd_locale_sync::album_folder_abs_path_for_explorer;
