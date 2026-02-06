//! Linux/macOS 平台的虚拟盘服务实现（使用 FUSE）。

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use arc_swap::ArcSwap;
use fuser::{spawn_mount2, BackgroundSession, MountOption};

use crate::providers::provider::Provider;
use crate::providers::root::RootProvider;
use crate::virtual_driver::fuse::KabegameFuseFs;

use super::VirtualDriveServiceTrait;

/// Linux/macOS 虚拟盘服务
pub struct VirtualDriveService {
    /// 当前挂载点（如果已挂载）
    mounted: ArcSwap<Option<Arc<str>>>,
    /// 挂载会话句柄：用于显式 join/unmount，避免残留 busy
    session: Mutex<Option<BackgroundSession>>,
}

impl Default for VirtualDriveService {
    fn default() -> Self {
        Self {
            mounted: ArcSwap::from_pointee(None),
            session: Mutex::new(None),
        }
    }
}

fn normalize_mount_point(input: &str) -> Result<PathBuf, String> {
    let s = input.trim();
    if s.is_empty() {
        return Err("挂载点不能为空".to_string());
    }

    // 展开 ~/...
    if let Some(rest) = s.strip_prefix("~/") {
        let home = dirs::home_dir().ok_or_else(|| "无法获取用户 home 目录".to_string())?;
        return Ok(home.join(rest));
    }

    let p = PathBuf::from(s);
    if p.is_absolute() {
        return Ok(p);
    }

    // 相对路径：默认解释为 home 下的相对路径，避免“当前工作目录不确定”导致找不到
    let home = dirs::home_dir().ok_or_else(|| "无法获取用户 home 目录".to_string())?;
    Ok(home.join(p))
}

impl VirtualDriveServiceTrait for VirtualDriveService {
    fn current_mount_point(&self) -> Option<String> {
        self.mounted
            .load_full()
            .as_ref()
            .as_ref()
            .map(|s| s.to_string())
    }

    fn notify_root_dir_changed(&self) {
        // Linux 不需要刷新文件系统
    }

    fn notify_album_dir_changed(&self, _album_id: &str) {
        // Linux 不需要刷新文件系统
    }

    fn bump_tasks(&self) {
        // Linux 不需要刷新文件系统
    }

    fn bump_albums(&self) {
        // Linux 不需要刷新文件系统
    }

    fn mount(&self, mount_point: &str) -> Result<(), String> {
        let mount_path = normalize_mount_point(mount_point)?;

        // 先加锁避免并发 mount/unmount 打架
        let mut guard = self
            .session
            .lock()
            .map_err(|_| "VirtualDriveService session lock poisoned".to_string())?;
        if guard.is_some() || self.mounted.load().as_ref().is_some() {
            return Err("虚拟盘已挂载".to_string());
        }

        // 启动时清理：如果挂载点已经是挂载状态（残留），先尝试卸载
        #[cfg(target_os = "linux")]
        {
            if mount_path.exists() {
                // 尝试卸载残留的挂载点（如果失败说明不是挂载点，可以忽略）
                let _ = std::process::Command::new("fusermount3")
                    .arg("-u")
                    .arg(&mount_path)
                    .output();
            }
        }

        #[cfg(target_os = "macos")]
        {
            if mount_path.exists() {
                // macOS 上尝试卸载残留的挂载点
                // 使用 umount 命令（macOS 上 FUSE 使用 umount）
                let _ = std::process::Command::new("umount")
                    .arg(&mount_path)
                    .output();
            }
        }

        // 确保挂载点目录存在（容错：AlreadyExists 继续，但要求它必须是目录）
        if let Err(e) = std::fs::create_dir_all(&mount_path) {
            if e.kind() != std::io::ErrorKind::AlreadyExists {
                return Err(format!("创建挂载点目录失败: {}", e));
            }
        }

        // 再次检查：如果仍然不是目录，可能是残留的挂载点，尝试强制卸载
        if !mount_path.is_dir() {
            #[cfg(target_os = "linux")]
            {
                // 尝试强制卸载
                let output = std::process::Command::new("fusermount3")
                    .arg("-uz") // -z: lazy unmount
                    .arg(&mount_path)
                    .output();

                // 等待一下让卸载完成
                std::thread::sleep(std::time::Duration::from_millis(100));

                // 再次尝试创建目录
                if let Err(e) = std::fs::create_dir_all(&mount_path) {
                    if e.kind() != std::io::ErrorKind::AlreadyExists {
                        return Err(format!("创建挂载点目录失败: {} (已尝试卸载残留挂载点)", e));
                    }
                }

                // 如果仍然不是目录，报错
                if !mount_path.is_dir() {
                    return Err(format!(
                        "挂载点不是目录: {} (可能是残留的挂载点，请手动运行: fusermount3 -u {})",
                        mount_path.display(),
                        mount_path.display()
                    ));
                }
            }
            #[cfg(target_os = "macos")]
            {
                // macOS 上尝试强制卸载
                let _ = std::process::Command::new("umount")
                    .arg("-f") // -f: force unmount
                    .arg(&mount_path)
                    .output();

                // 等待一下让卸载完成
                std::thread::sleep(std::time::Duration::from_millis(100));

                // 再次尝试创建目录
                if let Err(e) = std::fs::create_dir_all(&mount_path) {
                    if e.kind() != std::io::ErrorKind::AlreadyExists {
                        return Err(format!("创建挂载点目录失败: {} (已尝试卸载残留挂载点)", e));
                    }
                }

                // 如果仍然不是目录，报错
                if !mount_path.is_dir() {
                    return Err(format!(
                        "挂载点不是目录: {} (可能是残留的挂载点，请手动运行: umount -f {})",
                        mount_path.display(),
                        mount_path.display()
                    ));
                }
            }
            #[cfg(not(any(target_os = "linux", target_os = "macos")))]
            {
                return Err(format!("挂载点不是目录: {}", mount_path.display()));
            }
        }

        // 创建文件系统实例
        let root = Arc::new(RootProvider::default()) as Arc<dyn Provider>;
        let fs = KabegameFuseFs::new(root);

        // 挂载选项
        let mount_options = &[
            MountOption::FSName("kabegame".to_string()),
            MountOption::Subtype("kabegame-vd".to_string()),
            // 注意：不使用 AllowOther，避免需要修改 /etc/fuse.conf
            // 注意：不使用 AutoUnmount，某些系统可能有问题
            // 如果确实需要其他用户访问，可以在 /etc/fuse.conf 中添加 user_allow_other，然后取消注释下面这行
            // MountOption::AllowOther,
        ];

        // 挂载文件系统
        let session =
            spawn_mount2(fs, &mount_path, mount_options).map_err(|e| format!("挂载失败: {}", e))?;

        // 保存状态
        let mount_point_arc: Arc<str> = Arc::from(mount_path.to_string_lossy().to_string());
        self.mounted.store(Arc::new(Some(mount_point_arc.clone())));
        *guard = Some(session);

        Ok(())
    }

    fn unmount(&self) -> Result<bool, String> {
        let mut guard = self
            .session
            .lock()
            .map_err(|_| "VirtualDriveService session lock poisoned".to_string())?;

        let Some(session) = guard.take() else {
            self.mounted.store(Arc::new(None));
            return Ok(false);
        };

        // 显式 join：确保卸载完成、目录不再 busy
        session.join();

        self.mounted.store(Arc::new(None));
        Ok(true)
    }
}

impl VirtualDriveService {
    pub fn current_mount_point(&self) -> Option<String> {
        VirtualDriveServiceTrait::current_mount_point(self)
    }

    pub fn notify_root_dir_changed(&self) {
        VirtualDriveServiceTrait::notify_root_dir_changed(self)
    }

    pub fn notify_album_dir_changed(&self, album_id: &str) {
        VirtualDriveServiceTrait::notify_album_dir_changed(self, album_id)
    }

    pub fn notify_task_dir_changed(&self, _task_id: &str) {
        // Linux 不需要刷新文件系统
    }

    pub fn notify_gallery_tree_changed(&self) {
        // Linux 不需要刷新文件系统
    }

    pub fn bump_tasks(&self) {
        VirtualDriveServiceTrait::bump_tasks(self)
    }

    pub fn bump_albums(&self) {
        VirtualDriveServiceTrait::bump_albums(self)
    }

    pub fn mount(&self, mount_point: &str) -> Result<(), String> {
        VirtualDriveServiceTrait::mount(self, mount_point)
    }

    pub fn unmount(&self) -> Result<bool, String> {
        VirtualDriveServiceTrait::unmount(self)
    }
}

impl Drop for VirtualDriveService {
    fn drop(&mut self) {
        // 如果还在挂载状态，尝试卸载
        if self.mounted.load().as_ref().is_some() {
            let _ = self.unmount();
        }
    }
}
