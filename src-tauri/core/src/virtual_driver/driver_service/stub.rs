//! VirtualDriveService stub (linux/mac without `virtual-driver` feature)。
//!
//! 不挂载任何虚拟盘；所有 trait 方法都是 no-op。仅用于让没有 fuser 依赖的
//! 编译目标（如 cargo check 默认 feature 集）能正常构建。

use super::VirtualDriveServiceTrait;

#[derive(Default)]
pub struct VirtualDriveService;

impl VirtualDriveServiceTrait for VirtualDriveService {
    fn current_mount_point(&self) -> Option<String> {
        None
    }
    fn notify_root_dir_changed(&self) {}
    fn notify_album_dir_changed(&self, _album_id: &str) {}
    fn bump_tasks(&self) {}
    fn bump_albums(&self) {}
    fn mount(&self, _mount_point: &str) -> Result<(), String> {
        Err("VD stub: virtual-driver feature is disabled".into())
    }
    fn unmount(&self) -> Result<bool, String> {
        Ok(false)
    }
}
