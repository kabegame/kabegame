//! 非 Windows 平台的占位实现：后续可替换为 Linux/macOS 对应实现。

use crate::storage::Storage;
use tauri::AppHandle;

use super::VirtualDriveServiceTrait;

/// 非 Windows 平台的占位实现：后续可替换为 Linux/macOS 对应实现。
#[derive(Default)]
pub struct VirtualDriveService;

impl VirtualDriveServiceTrait for VirtualDriveService {
    fn current_mount_point(&self) -> Option<String> {
        None
    }

    fn notify_root_dir_changed(&self) {}

    fn notify_album_dir_changed(&self, _storage: &Storage, _album_id: &str) {}

    fn bump_tasks(&self) {}

    fn bump_albums(&self) {}

    fn mount(&self, _mount_point: &str, _storage: Storage, _app: AppHandle) -> Result<(), String> {
        Err("当前平台暂不支持虚拟盘".to_string())
    }

    fn unmount(&self) -> Result<bool, String> {
        Ok(false)
    }
}

impl VirtualDriveService {
    pub fn current_mount_point(&self) -> Option<String> {
        VirtualDriveServiceTrait::current_mount_point(self)
    }

    pub fn notify_root_dir_changed(&self) {
        VirtualDriveServiceTrait::notify_root_dir_changed(self)
    }

    pub fn notify_album_dir_changed(&self, storage: &Storage, album_id: &str) {
        VirtualDriveServiceTrait::notify_album_dir_changed(self, storage, album_id)
    }

    pub fn bump_tasks(&self) {
        VirtualDriveServiceTrait::bump_tasks(self)
    }

    pub fn bump_albums(&self) {
        VirtualDriveServiceTrait::bump_albums(self)
    }

    pub fn mount(&self, mount_point: &str, storage: Storage, app: AppHandle) -> Result<(), String> {
        VirtualDriveServiceTrait::mount(self, mount_point, storage, app)
    }

    pub fn unmount(&self) -> Result<bool, String> {
        VirtualDriveServiceTrait::unmount(self)
    }
}
