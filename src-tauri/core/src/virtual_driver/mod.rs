//! 虚拟盘模块（跨平台门面）。
//!
//! - 具体平台实现放在子模块中：Windows 使用 Dokan；其他平台暂提供 no-op/stub，便于后续扩展。

pub mod driver_service;
#[cfg(all(not(kabegame_mode = "light"), not(target_os = "android"), target_os = "windows"))]
mod fs;
pub mod ipc;
#[cfg(all(not(kabegame_mode = "light"), not(target_os = "android")))]
mod semantics;
#[cfg(all(not(kabegame_mode = "light"), not(target_os = "android")))]
mod virtual_drive_io;
#[cfg(all(not(kabegame_mode = "light"), not(target_os = "android"), target_os = "windows"))]
mod virtual_drive_io_windows;
#[cfg(all(not(kabegame_mode = "light"), not(target_os = "android"), target_os = "windows"))]
mod windows;
#[cfg(all(not(kabegame_mode = "light"), not(target_os = "android"), not(target_os = "windows")))]
mod fuse;
// 从 drive_service 模块导出 VirtualDriveService（根据平台自动选择实现）

pub use driver_service::VirtualDriveService;
