//! Windows 平台的虚拟盘服务实现（使用 Dokan）。

use std::{
    collections::HashMap,
    sync::{Arc, Mutex, OnceLock},
    time::Duration,
};

use crate::providers::plugin_display_name_from_manifest;
use crate::providers::root::{DIR_ALBUMS, DIR_ALL, DIR_BY_DATE, DIR_BY_PLUGIN, DIR_BY_TASK};
use crate::storage::Storage;
use arc_swap::ArcSwap;
use widestring::U16CString;
use windows_sys::Win32::UI::Shell::{SHChangeNotify, SHCNE_UPDATEDIR, SHCNF_PATHW};

use crate::virtual_driver::fs::KabegameFs;
use crate::virtual_driver::windows::{dokan_init_once, VirtualDriveRootProvider};
use dokan::{FileSystemMounter, MountFlags, MountOptions};

use super::VirtualDriveServiceTrait;

/// Windows 虚拟盘服务
pub struct VirtualDriveService {
    mounted: ArcSwap<Option<Arc<str>>>,
    /// 限流：避免任务运行时每张图片都触发 Explorer 过于频繁的刷新
    task_dir_refresh_limiter: Mutex<HashMap<String, std::time::Instant>>,
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

impl Default for VirtualDriveService {
    fn default() -> Self {
        Self {
            mounted: ArcSwap::from_pointee(None),
            task_dir_refresh_limiter: Mutex::new(HashMap::new()),
        }
    }
}

// windows实现
impl VirtualDriveServiceTrait for VirtualDriveService {
    fn current_mount_point(&self) -> Option<String> {
        self.mounted
            .load_full()
            .as_ref()
            .as_ref()
            .map(|s| s.to_string())
    }

    fn notify_root_dir_changed(&self) {
        let mounted_arc = self.mounted.load_full();
        let Some(mp) = mounted_arc.as_ref().as_ref() else {
            return;
        };
        notify_explorer_dir_changed_path(mp.as_ref());
    }

    fn notify_album_dir_changed(&self, album_id: &str) {
        let mounted_arc = self.mounted.load_full();
        let Some(mp) = mounted_arc.as_ref().as_ref() else {
            return;
        };
        let storage = Storage::global();
        let Ok(Some(name)) = storage.get_album_name_by_id(album_id) else {
            // 画册不存在，刷新画册列表
            self.notify_albums_root_dir_changed();
            return;
        };
        let album_path = join_mount_subdir(mp.as_ref(), &format!("{}\\{}", DIR_ALBUMS, name));
        notify_explorer_dir_changed_path(&album_path);
    }

    fn bump_tasks(&self) {
        // 不做失效：仅提醒 Explorer 刷新（根目录 + 按任务）
        self.notify_root_dir_changed();
        self.notify_task_root_dir_changed();
    }

    fn bump_albums(&self) {
        // 不做失效：仅提醒 Explorer 刷新（根目录 + 画册）
        self.notify_root_dir_changed();
        self.notify_albums_root_dir_changed();
    }

    // windows 挂载
    fn mount(&self, mount_point: &str) -> Result<(), String> {
        let mount_point = normalize_mount_point(mount_point)?;
        let mount_point: Arc<str> = Arc::from(mount_point);

        // CAS：确保并发下只有一个挂载成功
        let current = self.mounted.load();
        if current.as_ref().is_some() {
            return Err("虚拟盘已挂载".to_string());
        }
        self.mounted.store(Arc::new(Some(mount_point.clone())));

        let (tx, rx) = std::sync::mpsc::sync_channel::<Result<(), String>>(1);

        let mount_point_for_thread = mount_point.clone();
        tokio::spawn(async move {
            dokan_init_once();

            let root = Arc::new(VirtualDriveRootProvider);
            let handler = KabegameFs::new(root);

            let mount_point_u16 = match U16CString::from_str(mount_point_for_thread.as_ref()) {
                Ok(v) => v,
                Err(_) => {
                    let _ = tx.send(Err("mount_point 编码失败".to_string()));
                    return;
                }
            };

            let options = MountOptions {
                single_thread: false,
                // 默认使用 CURRENT_SESSION：
                // - 更符合“仅当前用户会话可见”的产品语义
                // - 在部分 Win10 环境下可降低“必须管理员才能挂载盘符”的概率
                flags: MountFlags::CURRENT_SESSION | MountFlags::CASE_SENSITIVE,
                unc_name: None,
                timeout: Duration::from_secs(30),
                allocation_unit_size: 4096,
                sector_size: 512,
                volume_security_descriptor: None,
            };

            let mut mounter =
                FileSystemMounter::new(&handler, mount_point_u16.as_ucstr(), &options);
            let mount_res = mounter.mount();
            match mount_res {
                Ok(fs) => {
                    let _ = tx.send(Ok(()));
                    drop(fs);
                }
                Err(e) => {
                    let msg = e.to_string();
                    // 提示强化：Dokan 驱动未安装/安装失败（os error: can't install driver）
                    if msg.contains("can't install driver") {
                        let _ = tx.send(Err(
                            "挂载失败：Dokan 驱动不可用（can't install driver）。\n\n请安装 Dokan 2.x Runtime/Driver（仅放置 dokan2.dll 不够，还需要内核驱动 dokan2.sys），安装后建议重启系统。\n安装完成后可在管理员终端运行 `kabegame-cli.exe vd daemon` 并用 `kabegame-cli.exe vd ipc-status` 验证 IPC 可用。"
                                .to_string(),
                        ));
                    } else if msg.contains("requested an incompatible version") {
                        let _ = tx.send(Err(
                            "挂载失败：Dokan 版本不兼容（requested an incompatible version）。\n\n请确保安装的 Dokan Driver 版本与应用内置的 dokan2.dll/依赖版本匹配（建议安装 Dokan 2.x 最新稳定版），然后重启再试。"
                                .to_string(),
                        ));
                    } else {
                        let _ = tx.send(Err(format!("挂载失败: {}", e)));
                    }
                }
            };
        });

        match rx.recv_timeout(Duration::from_secs(20)) {
            Ok(Ok(())) => Ok(()),
            Ok(Err(e)) => {
                // 挂载失败，回滚状态
                self.mounted.store(Arc::new(None));
                Err(e)
            }
            Err(_) => {
                // 超时也回滚
                self.mounted.store(Arc::new(None));
                Err("挂载确认超时：系统可能已出现盘符；若无法访问请先关闭开关卸载再重试（也可能是 Dokan 驱动不兼容）".to_string())
            }
        }
    }

    fn unmount(&self) -> Result<bool, String> {
        let mount_point_arc = self.mounted.load_full();
        let Some(mount_point) = mount_point_arc.as_ref().as_ref() else {
            return Ok(false);
        };
        let mp = U16CString::from_str(mount_point.as_ref())
            .map_err(|_| "mount_point 编码失败".to_string())?;
        let ok = dokan::unmount(mp.as_ucstr());
        if ok {
            // 卸载成功，清除状态
            self.mounted.store(Arc::new(None));
        }
        Ok(ok)
    }
}

impl VirtualDriveService {
    /// 初始化全局 VirtualDriveService（必须在首次使用前调用）
    // pub fn init_global() -> Result<(), String> {
    //     let service = VirtualDriveService::default();
    //     VIRTUAL_DRIVE_SERVICE
    //         .set(service)
    //         .map_err(|_| "VirtualDriveService already initialized".to_string())?;
    //     Ok(())
    // }

    /// 获取全局 VirtualDriveService 引用
    // pub fn global() -> &'static VirtualDriveService {
    //     VIRTUAL_DRIVE_SERVICE.get().expect(
    //         "VirtualDriveService not initialized. Call VirtualDriveService::init_global() first.",
    //     )
    // }

    /// 通知按任务根目录变更（私有辅助方法）
    fn notify_task_root_dir_changed(&self) {
        let mounted_arc = self.mounted.load_full();
        let Some(mp) = mounted_arc.as_ref().as_ref() else {
            return;
        };
        notify_explorer_dir_changed_path(&join_mount_subdir(mp.as_ref(), DIR_BY_TASK));
    }

    /// 通知画册根目录变更（私有辅助方法）
    fn notify_albums_root_dir_changed(&self) {
        let mounted_arc = self.mounted.load_full();
        let Some(mp) = mounted_arc.as_ref().as_ref() else {
            return;
        };
        notify_explorer_dir_changed_path(&join_mount_subdir(mp.as_ref(), DIR_ALBUMS));
    }

    /// 通知某个任务目录内容变更（用于任务运行中不断新增图片时，Explorer 正在浏览该目录也能刷新）。
    ///
    /// 说明：任务目录名规则与 `TaskGroupProvider::list()` 保持一致：
    /// - 若可读到插件显示名：`"{pluginName} - {taskId}"`
    /// - 否则退回 `"{pluginId} - {taskId}"`
    /// - 若插件名为空：仅 `"{taskId}"`
    pub fn notify_task_dir_changed(&self, task_id: &str) {
        let task_id = task_id.trim();
        if task_id.is_empty() {
            return;
        }
        let mounted_arc = self.mounted.load_full();
        let Some(mp) = mounted_arc.as_ref().as_ref() else {
            return;
        };

        // 轻量限流：同一 task 500ms 内最多刷新一次，避免下载高并发时卡 Explorer。
        const MIN_INTERVAL: Duration = Duration::from_millis(500);
        let now = std::time::Instant::now();
        if let Ok(mut guard) = self.task_dir_refresh_limiter.lock() {
            if let Some(last) = guard.get(task_id) {
                if now.duration_since(*last) < MIN_INTERVAL {
                    return;
                }
            }
            guard.insert(task_id.to_string(), now);
        }

        // 刷新"按任务"根目录：确保首次出现图片时该任务目录可见
        self.notify_task_root_dir_changed();

        // 刷新具体任务目录：确保 Explorer 正在浏览该目录时也能更新文件列表
        let storage = Storage::global();
        let plugin_id = storage
            .get_task(task_id)
            .ok()
            .flatten()
            .map(|t| t.plugin_id)
            .unwrap_or_default();

        let mut plugin_name = plugin_display_name_from_manifest(&plugin_id).unwrap_or(plugin_id);
        plugin_name = plugin_name.trim().to_string();
        let task_dir_name = if plugin_name.is_empty() {
            task_id.to_string()
        } else {
            format!("{} - {}", plugin_name, task_id)
        };

        let task_path =
            join_mount_subdir(mp.as_ref(), &format!("{}\\{}", DIR_BY_TASK, task_dir_name));
        notify_explorer_dir_changed_path(&task_path);
    }

    /// 通知“画廊树”变更：
    /// - 全部（图片列表变化）
    /// - 按插件（可能出现新插件分组/数量变化）
    /// - 按时间（可能出现新月份分组/数量变化）
    pub fn notify_gallery_tree_changed(&self) {
        let mounted_arc = self.mounted.load_full();
        let Some(mp) = mounted_arc.as_ref().as_ref() else {
            return;
        };

        // 轻量限流：500ms 内最多刷新一次，避免任务高并发下载时反复刷新多个目录
        const MIN_INTERVAL: Duration = Duration::from_millis(500);
        let now = std::time::Instant::now();
        if let Ok(mut guard) = self.task_dir_refresh_limiter.lock() {
            let key = "__gallery_tree__";
            if let Some(last) = guard.get(key) {
                if now.duration_since(*last) < MIN_INTERVAL {
                    return;
                }
            }
            guard.insert(key.to_string(), now);
        }

        notify_explorer_dir_changed_path(&join_mount_subdir(mp.as_ref(), DIR_ALL));
        notify_explorer_dir_changed_path(&join_mount_subdir(mp.as_ref(), DIR_BY_PLUGIN));
        notify_explorer_dir_changed_path(&join_mount_subdir(mp.as_ref(), DIR_BY_DATE));
    }
}

impl Drop for VirtualDriveService {
    fn drop(&mut self) {
        let mount_point_arc = self.mounted.load_full();
        let Some(mount_point) = mount_point_arc.as_ref().as_ref() else {
            return;
        };
        if let Ok(mp) = U16CString::from_str(mount_point.as_ref()) {
            let _ = dokan::unmount(mp.as_ucstr());
        }
    }
}

/// 规范化挂载点（Windows 特定：处理 `K:` -> `K:\`）
pub fn normalize_mount_point(input: &str) -> Result<String, String> {
    let s = input.trim();
    if s.is_empty() {
        return Err("mount_point 不能为空".to_string());
    }
    if s.len() == 1 && s.chars().next().unwrap().is_ascii_alphabetic() {
        return Ok(format!("{}:\\", s.to_uppercase()));
    }
    if s.len() == 2
        && s.chars().next().unwrap().is_ascii_alphabetic()
        && s.chars().nth(1) == Some(':')
    {
        return Ok(format!("{}\\", s.to_uppercase()));
    }
    Ok(s.to_string())
}

/// 拼接挂载点子目录（Windows 特定：使用 `\` 分隔符）
pub fn join_mount_subdir(mount_point: &str, subdir: &str) -> String {
    if mount_point.ends_with('\\') {
        format!("{}{}", mount_point, subdir)
    } else {
        format!("{}\\{}", mount_point, subdir)
    }
}

/// 通知 Explorer 刷新目录（Windows 特定：使用 SHChangeNotify）
pub fn notify_explorer_dir_changed_path(path: &str) {
    if let Ok(p) = U16CString::from_str(path) {
        unsafe {
            SHChangeNotify(
                SHCNE_UPDATEDIR as i32,
                SHCNF_PATHW,
                p.as_ptr() as *const _,
                std::ptr::null(),
            );
        }
    }
}
