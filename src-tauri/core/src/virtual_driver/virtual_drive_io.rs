//! 虚拟盘（virtual-driver feature）专用：跨平台文件读取抽象。
//!
//! 根据平台选择具体实现：
//! - Windows: 使用内存映射优化（virtual_drive_io_windows.rs）
//! - Linux: 使用普通文件读取（virtual_drive_io_linux.rs）

#![cfg(not(kabegame_mode = "light"))]

#[cfg(target_os = "windows")]
#[path = "virtual_drive_io_windows.rs"]
mod imp;

#[cfg(target_os = "linux")]
#[path = "virtual_drive_io_linux.rs"]
mod imp;

pub use imp::{VdFileMeta, VdReadHandle};
