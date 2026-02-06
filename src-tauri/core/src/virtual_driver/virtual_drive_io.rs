//! 虚拟盘（virtual-driver feature）专用：跨平台文件读取抽象。
//!
//! 根据平台选择具体实现：
//! - Windows: 使用内存映射优化（virtual_drive_io_windows.rs）
//! - Linux: 使用普通文件读取（virtual_drive_io_linux.rs）

#![cfg(all(not(kabegame_mode = "light"), not(target_os = "android")))]

#[cfg(target_os = "windows")]
#[path = "virtual_drive_io_windows.rs"]
mod imp;

#[cfg(any(target_os = "linux", target_os = "macos"))]
#[path = "virtual_drive_io_fuse.rs"]
mod virtual_drive_io_fuse;

pub use virtual_drive_io_fuse::{VdFileMeta, VdReadHandle};
