//! 虚拟盘模块（跨平台门面）。
//!
//! - 本模块只在 feature `virtual-drive` 开启时编译（见 `lib.rs`）。
//! - 具体平台实现放在子模块中：Windows 使用 Dokan；其他平台暂提供 no-op/stub，便于后续扩展。

#![cfg(feature = "virtual-drive")]

pub(crate) mod ops;

#[cfg(target_os = "windows")]
mod windows;

#[cfg(target_os = "windows")]
pub use windows::VirtualDriveService;

#[cfg(not(target_os = "windows"))]
use crate::storage::Storage;

#[cfg(not(target_os = "windows"))]
use tauri::AppHandle;

/// 非 Windows 平台的占位实现：后续可替换为 Linux/macOS 对应实现。
#[cfg(not(target_os = "windows"))]
#[derive(Default)]
pub struct VirtualDriveService;

#[cfg(not(target_os = "windows"))]
impl VirtualDriveService {
    pub fn is_mounted(&self) -> bool {
        false
    }

    pub fn current_mount_point(&self) -> Option<String> {
        None
    }

    pub fn notify_root_dir_changed(&self) {}

    pub fn notify_album_dir_changed(&self, _storage: &Storage, _album_id: &str) {}

    pub fn bump_tasks(&self) {}

    pub fn bump_albums(&self) {}

    pub fn mount(
        &self,
        _mount_point: &str,
        _storage: Storage,
        _app: AppHandle,
    ) -> Result<(), String> {
        Err("当前平台暂不支持虚拟盘".to_string())
    }

    pub fn unmount(&self) -> Result<bool, String> {
        Ok(false)
    }
}
