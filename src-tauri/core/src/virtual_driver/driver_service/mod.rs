//! 虚拟盘服务模块（跨平台门面）。
//!
//! - 根据平台导出不同的实现，但统一使用 `VirtualDriveService` 名称，保持代码稳定性。
//! - 使用 trait 定义统一接口，但不用于动态分发（编译时多态）。

#[cfg(all(not(kabegame_mode = "light"), not(target_os = "android"), target_os = "windows"))]
mod windows;

#[cfg(all(not(kabegame_mode = "light"), not(target_os = "android"), any(target_os = "macos", target_os = "linux")))]
mod fuse;

use std::sync::Arc;
use std::sync::OnceLock;

#[cfg(all(not(kabegame_mode = "light"), not(target_os = "android"), target_os = "windows"))]
pub use windows::VirtualDriveService;

#[cfg(all(not(kabegame_mode = "light"), not(target_os = "android"), target_os = "windows"))]
pub use windows::{join_mount_subdir, notify_explorer_dir_changed_path};

#[cfg(all(not(kabegame_mode = "light"), not(target_os = "android"), target_os = "windows"))]
pub use windows::normalize_mount_point;

#[cfg(all(not(kabegame_mode = "light"), not(target_os = "android"), any(target_os = "macos", target_os = "linux")))]
pub use fuse::VirtualDriveService;


/// 虚拟盘服务 trait（定义所有平台必须实现的接口）
///
/// 注意：此 trait 不用于动态分发（`dyn VirtualDriveServiceTrait`），
/// 而是通过类型系统在编译时确定具体实现。
pub trait VirtualDriveServiceTrait: Default + Send + Sync {
    /// 当前挂载点
    fn current_mount_point(&self) -> Option<String>;

    /// 通知根目录变更
    fn notify_root_dir_changed(&self);

    /// 通知画册目录变更
    fn notify_album_dir_changed(&self, album_id: &str);

    /// 统一 bump：按任务子树（并通知文件管理器刷新）
    fn bump_tasks(&self);

    /// 统一 bump：画册子树（并通知文件管理器刷新）
    fn bump_albums(&self);

    /// 挂载虚拟盘
    fn mount(&self, mount_point: &str) -> Result<(), String>;

    /// 卸载虚拟盘
    fn unmount(&self) -> Result<bool, String>;
}

// 全局 VirtualDriveService 单例
static VIRTUAL_DRIVE_SERVICE: OnceLock<Arc<VirtualDriveService>> = OnceLock::new();

impl VirtualDriveService {
    pub fn init_global() -> Result<(), String> {
        let service = Arc::new(Self::default());
        VIRTUAL_DRIVE_SERVICE
            .set(service)
            .map_err(|_| "VirtualDriveService already initialized".to_string())
    }

    pub fn global() -> Arc<VirtualDriveService> {
        VIRTUAL_DRIVE_SERVICE
            .get()
            .expect("VirtualDriveService not initialized")
            .clone()
    }
}