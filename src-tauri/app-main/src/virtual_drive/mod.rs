//! 虚拟盘模块（跨平台门面）。
//!
//! - 具体平台实现放在子模块中：Windows 使用 Dokan；其他平台暂提供 no-op/stub，便于后续扩展。

#[cfg(target_os = "windows")]
mod windows;

pub mod drive_service;
mod fs;
mod semantics;
#[cfg(all(feature = "virtual-drive", target_os = "windows"))]
mod virtual_drive_io;
// 从 drive_service 模块导出 VirtualDriveService（根据平台自动选择实现）

pub use drive_service::VirtualDriveService;
