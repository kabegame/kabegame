//! Windows 虚拟盘（Dokan）：使用 Provider 系统将 Kabegame 的画册和画廊映射为虚拟文件系统。
//!
//! 设计原则：
//! - Provider 对路径完全无感知
//! - 每个 Provider 只返回自己的内容（子目录或文件）
//! - 子目录通过 `get_child(name)` 获取对应的子 Provider
//! - 路径解析由框架自动递归处理
//!
//! 目录结构：
//! ```text
//! K:\
//! ├── 按时间\                  <- DateGroupProvider
//! │   └── 2024-01\             <- DateImagesProvider (-> AllProvider)
//! ├── 按插件\                  <- PluginGroupProvider
//! │   └── konachan\            <- PluginImagesProvider (-> AllProvider)
//! ├── 画册\                    <- AlbumsProvider
//! │   ├── 收藏\                <- AlbumProvider (-> AllProvider)
//! │   └── 其他画册\
//! └── 全部\                    <- AllProvider
//!     ├── 1-100000\            <- RangeProvider (贪心分解)
//!     ├── 100001-110000\
//!     └── *.jpg                <- 剩余文件直接显示
//! ```

use std::{
    fs::File,
    os::windows::fs::FileExt,
    path::PathBuf,
    sync::{Arc, Mutex, Once},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use crate::providers::provider::{
    DeleteChildKind, DeleteChildMode, FsEntry, Provider, ResolveResult, VdOpsContext,
};
use crate::providers::ProviderRuntime;
use crate::providers::{
    AlbumsProvider, AllProvider, DateGroupProvider, PluginGroupProvider, TaskGroupProvider,
};
use crate::storage::Storage;
use dokan::{
    CreateFileInfo, DiskSpaceInfo, FileInfo, FileSystemHandler, FileSystemMounter, MountFlags,
    MountOptions, OperationInfo, OperationResult, VolumeInfo,
};
use tauri::AppHandle;
use tauri::Emitter;
use tauri::Manager;
use widestring::{U16CStr, U16CString};
use winapi::{
    shared::ntstatus::{
        STATUS_ACCESS_DENIED, STATUS_INVALID_PARAMETER, STATUS_NOT_A_DIRECTORY,
        STATUS_OBJECT_NAME_NOT_FOUND, STATUS_OBJECT_PATH_NOT_FOUND,
    },
    shared::winerror,
    um::winnt::{FILE_ATTRIBUTE_ARCHIVE, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_READONLY},
};
use windows_sys::Win32::UI::Shell::{SHChangeNotify, SHCNE_UPDATEDIR, SHCNF_PATHW};

/// 根目录名称
const DIR_BY_DATE: &str = "按时间";
const DIR_BY_PLUGIN: &str = "按插件";
const DIR_BY_TASK: &str = "按任务";
const DIR_ALBUMS: &str = "画册";
const DIR_ALL: &str = "全部";

static DOKAN_INIT: Once = Once::new();

fn dokan_init_once() {
    DOKAN_INIT.call_once(|| dokan::init());
}

#[inline]
fn now() -> SystemTime {
    SystemTime::now()
}

fn system_time_from_fs_metadata(meta: &std::fs::Metadata) -> (SystemTime, SystemTime, SystemTime) {
    let created = meta.created().unwrap_or(UNIX_EPOCH);
    let accessed = meta.accessed().unwrap_or(created);
    let modified = meta.modified().unwrap_or(accessed);
    (created, accessed, modified)
}

fn parse_components(file_name: &U16CStr) -> Vec<String> {
    let s = file_name.to_string_lossy();
    s.split('\\')
        .filter(|c| !c.is_empty())
        .map(|c| c.to_string())
        .collect()
}

fn file_index_from_numeric_id(id: &str) -> u64 {
    id.parse::<u64>().unwrap_or(0)
}

fn file_index_from_path(path: &[String]) -> u64 {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut hasher = DefaultHasher::new();
    path.hash(&mut hasher);
    hasher.finish()
}

fn normalize_mount_point(input: &str) -> Result<String, String> {
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

fn join_mount_subdir(mount_point: &str, subdir: &str) -> String {
    if mount_point.ends_with('\\') {
        format!("{}{}", mount_point, subdir)
    } else {
        format!("{}\\{}", mount_point, subdir)
    }
}

fn notify_explorer_dir_changed_path(path: &str) {
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
/// 虚拟盘 RootProvider（VD 用）：包含按时间、按插件、按任务、画册、全部
struct VirtualDriveRootProvider;

impl Provider for VirtualDriveRootProvider {
    fn descriptor(&self) -> crate::providers::descriptor::ProviderDescriptor {
        // VD 的 root 只是内部使用；这里用 Root descriptor 复用即可
        crate::providers::descriptor::ProviderDescriptor::Root
    }

    fn list(&self, _storage: &Storage) -> Result<Vec<FsEntry>, String> {
        Ok(vec![
            FsEntry::dir(DIR_BY_DATE),
            FsEntry::dir(DIR_BY_PLUGIN),
            FsEntry::dir(DIR_BY_TASK),
            FsEntry::dir(DIR_ALBUMS),
            FsEntry::dir(DIR_ALL),
        ])
    }

    fn get_child(&self, _storage: &Storage, name: &str) -> Option<Arc<dyn Provider>> {
        match name {
            n if n.eq_ignore_ascii_case(DIR_BY_DATE) => {
                Some(Arc::new(DateGroupProvider::new()) as Arc<dyn Provider>)
            }
            n if n.eq_ignore_ascii_case(DIR_BY_PLUGIN) => {
                Some(Arc::new(PluginGroupProvider::new()) as Arc<dyn Provider>)
            }
            n if n.eq_ignore_ascii_case(DIR_BY_TASK) => {
                Some(Arc::new(TaskGroupProvider::new()) as Arc<dyn Provider>)
            }
            n if n.eq_ignore_ascii_case(DIR_ALBUMS) => {
                Some(Arc::new(AlbumsProvider::new()) as Arc<dyn Provider>)
            }
            n if n.eq_ignore_ascii_case(DIR_ALL) => {
                Some(Arc::new(AllProvider::new()) as Arc<dyn Provider>)
            }
            _ => None,
        }
    }
}

/// 文件系统项
#[derive(Clone)]
enum FsItem {
    /// 目录
    Directory { path: Vec<String> },
    /// 文件
    File {
        path: Vec<String>,
        image_id: String,
        resolved_path: PathBuf,
        size: u64,
        /// 缓存的文件句柄：避免每次 read_file 都重新 open
        /// 用 FileExt::seek_read(offset) 无锁读取，避免 seek + mutex 导致的游标竞争
        file_handle: Arc<File>,
    },
}

pub struct VirtualDriveService {
    mounted: Mutex<Option<String>>,
}

impl Default for VirtualDriveService {
    fn default() -> Self {
        Self {
            mounted: Mutex::new(None),
        }
    }
}

impl VirtualDriveService {
    /// 是否已挂载
    pub fn is_mounted(&self) -> bool {
        self.mounted.lock().ok().and_then(|g| g.clone()).is_some()
    }

    /// 当前挂载点
    pub fn current_mount_point(&self) -> Option<String> {
        self.mounted.lock().ok().and_then(|g| g.clone())
    }

    /// 通知根目录变更
    pub fn notify_root_dir_changed(&self) {
        let Some(mp) = self.current_mount_point() else {
            return;
        };
        notify_explorer_dir_changed_path(&mp);
    }

    /// 通知按任务根目录变更
    fn notify_task_root_dir_changed(&self) {
        let Some(mp) = self.current_mount_point() else {
            return;
        };
        notify_explorer_dir_changed_path(&join_mount_subdir(&mp, DIR_BY_TASK));
    }

    /// 通知画册根目录变更
    fn notify_albums_root_dir_changed(&self) {
        let Some(mp) = self.current_mount_point() else {
            return;
        };
        notify_explorer_dir_changed_path(&join_mount_subdir(&mp, DIR_ALBUMS));
    }

    /// 通知画册目录变更
    pub fn notify_album_dir_changed(&self, storage: &Storage, album_id: &str) {
        let Some(mp) = self.current_mount_point() else {
            return;
        };
        let Ok(Some(name)) = storage.get_album_name_by_id(album_id) else {
            // 画册不存在，刷新画册列表
            self.notify_albums_root_dir_changed();
            return;
        };
        let album_path = join_mount_subdir(&mp, &format!("{}\\{}", DIR_ALBUMS, name));
        notify_explorer_dir_changed_path(&album_path);
    }

    /// 统一 bump：按任务子树（并通知 Explorer 刷新）
    pub fn bump_tasks(&self) {
        // 不做失效：仅提醒 Explorer 刷新（根目录 + 按任务）
        self.notify_root_dir_changed();
        self.notify_task_root_dir_changed();
    }

    /// 统一 bump：画册子树（并通知 Explorer 刷新）
    pub fn bump_albums(&self) {
        // 不做失效：仅提醒 Explorer 刷新（根目录 + 画册）
        self.notify_root_dir_changed();
        self.notify_albums_root_dir_changed();
    }

    pub fn mount(&self, mount_point: &str, storage: Storage, app: AppHandle) -> Result<(), String> {
        let mount_point = normalize_mount_point(mount_point)?;
        {
            let mut g = self
                .mounted
                .lock()
                .map_err(|e| format!("Lock error: {}", e))?;
            if g.is_some() {
                return Err("虚拟盘已挂载".to_string());
            }
            *g = Some(mount_point.clone());
        }

        let (tx, rx) = std::sync::mpsc::sync_channel::<Result<(), String>>(1);

        let mount_point_for_thread = mount_point.clone();
        let app_for_thread = app.clone();
        std::thread::spawn(move || {
            dokan_init_once();

            let root = Arc::new(VirtualDriveRootProvider);
            let handler = KabegameFs::new(
                storage,
                mount_point_for_thread.clone(),
                app_for_thread,
                root,
            );

            let mount_point_u16 = match U16CString::from_str(&mount_point_for_thread) {
                Ok(v) => v,
                Err(_) => {
                    let _ = tx.send(Err("mount_point 编码失败".to_string()));
                    return;
                }
            };

            let options = MountOptions {
                single_thread: false,
                flags: MountFlags::empty(),
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
                    let _ = tx.send(Err(format!("挂载失败: {}", e)));
                }
            };
        });

        match rx.recv_timeout(Duration::from_secs(20)) {
            Ok(Ok(())) => {
                Ok(())
            }
            Ok(Err(e)) => {
                let mut g = self
                    .mounted
                    .lock()
                    .map_err(|e| format!("Lock error: {}", e))?;
                *g = None;
                Err(e)
            }
            Err(_) => {
                Err("挂载确认超时：系统可能已出现盘符；若无法访问请先关闭开关卸载再重试（也可能是 Dokan 驱动不兼容）".to_string())
            }
        }
    }

    pub fn unmount(&self) -> Result<bool, String> {
        let mount_point = self
            .mounted
            .lock()
            .map_err(|e| format!("Lock error: {}", e))?
            .clone();
        let Some(mount_point) = mount_point else {
            return Ok(false);
        };
        let mp =
            U16CString::from_str(&mount_point).map_err(|_| "mount_point 编码失败".to_string())?;
        let ok = dokan::unmount(mp.as_ucstr());
        if ok {
            let mut g = self
                .mounted
                .lock()
                .map_err(|e| format!("Lock error: {}", e))?;
            *g = None;
        }
        Ok(ok)
    }
}

impl Drop for VirtualDriveService {
    fn drop(&mut self) {
        let mount_point = self.mounted.lock().ok().and_then(|g| g.clone());
        let Some(mount_point) = mount_point else {
            return;
        };
        if let Ok(mp) = U16CString::from_str(&mount_point) {
            let _ = dokan::unmount(mp.as_ucstr());
        }
    }
}

/// Kabegame 虚拟文件系统 Handler
struct KabegameFs {
    storage: Storage,
    mount_point: String,
    app: AppHandle,
    root: Arc<dyn Provider>,
}

struct WindowsVdOpsContext<'a> {
    fs: &'a KabegameFs,
}

impl<'a> WindowsVdOpsContext<'a> {
    fn new(fs: &'a KabegameFs) -> Self {
        Self { fs }
    }
}

impl VdOpsContext for WindowsVdOpsContext<'_> {
    fn albums_created(&self, album_name: &str) {
        let _ = self.fs.app.emit(
            "albums-changed",
            serde_json::json!({
                "reason": "create",
                "albumName": album_name
            }),
        );

        notify_explorer_dir_changed_path(&join_mount_subdir(&self.fs.mount_point, DIR_ALBUMS));
        notify_explorer_dir_changed_path(&self.fs.mount_point);
    }

    fn albums_deleted(&self, album_name: &str) {
        let _ = self.fs.app.emit(
            "albums-changed",
            serde_json::json!({
                "reason": "delete",
                "albumName": album_name
            }),
        );
        notify_explorer_dir_changed_path(&self.fs.mount_point);
    }

    fn album_images_removed(&self, album_name: &str) {
        let _ = self.fs.app.emit(
            "album-images-changed",
            serde_json::json!({
                "albumName": album_name,
                "reason": "remove"
            }),
        );
        notify_explorer_dir_changed_path(&self.fs.mount_point);
    }

    fn tasks_deleted(&self, task_id: &str) {
        let _ = self.fs.app.emit(
            "tasks-changed",
            serde_json::json!({
                "reason": "delete",
                "taskId": task_id
            }),
        );
        // 刷新“按任务”目录（以及根目录）
        notify_explorer_dir_changed_path(&join_mount_subdir(&self.fs.mount_point, DIR_BY_TASK));
        notify_explorer_dir_changed_path(&self.fs.mount_point);
    }
}

impl KabegameFs {
    fn new(storage: Storage, mount_point: String, app: AppHandle, root: Arc<dyn Provider>) -> Self {
        Self {
            storage,
            mount_point,
            app,
            root,
        }
    }

    /// 将路径转换为段
    fn path_to_segments(path: &[String]) -> Vec<&str> {
        path.iter().map(|s| s.as_str()).collect()
    }

    /// 解析路径：最长前缀回退 + list 刷新
    fn resolve_cached(&self, segments: &[&str]) -> ResolveResult {
        if segments.is_empty() {
            return ResolveResult::Directory(self.root.clone());
        }

        // 如果最后一段看起来像文件名（包含 '.'），优先尝试文件解析，避免被误判为目录
        let is_likely_file = segments.last().map(|s| s.contains('.')).unwrap_or(false);

        if is_likely_file && segments.len() >= 2 {
            // 文件：用 parent provider 的 resolve_file 解析最后一段
            let parent_segs = &segments[..segments.len() - 1];
            let file_name = segments[segments.len() - 1];
            if let Some(parent) = self.resolve_provider(parent_segs) {
                if let Some((image_id, resolved_path)) =
                    parent.resolve_file(&self.storage, file_name)
                {
                    return ResolveResult::File {
                        image_id,
                        resolved_path,
                    };
                }
            }
        }

        // 目录：尝试把完整 segments 解析成 provider
        if let Some(p) = self.resolve_provider(segments) {
            return ResolveResult::Directory(p);
        }

        // 文件（兜底）：当目录解析失败时，再尝试 resolve_file（支持无扩展名的说明文件）
        if !segments.is_empty() {
            let parent_segs = &segments[..segments.len().saturating_sub(1)];
            let file_name = segments[segments.len() - 1];
            if let Some(parent) = self.resolve_provider(parent_segs) {
                if let Some((image_id, resolved_path)) =
                    parent.resolve_file(&self.storage, file_name)
                {
                    return ResolveResult::File {
                        image_id,
                        resolved_path,
                    };
                }
            }
        }

        ResolveResult::NotFound
    }

    /// 根据解析 Provider
    fn resolve_provider(&self, segments: &[&str]) -> Option<Arc<dyn Provider>> {
        if segments.is_empty() {
            return Some(self.root.clone());
        }
        let rt = self.app.state::<ProviderRuntime>();
        rt.resolve_provider_for_root(&self.storage, self.root.clone(), segments)
            .ok()
            .flatten()
    }

    fn list_entries_as_find_data(
        &self,
        segments: &[&str],
        provider: Arc<dyn Provider>,
        mut fill: impl FnMut(&dokan::FindData) -> dokan::FillDataResult,
    ) -> Result<(), winapi::shared::ntdef::NTSTATUS> {
        let rt = self.app.state::<ProviderRuntime>();
        let entries = rt
            .list_and_cache_children(&self.storage, segments, provider)
            .map_err(|_| STATUS_OBJECT_PATH_NOT_FOUND)?;

        for entry in entries {
            let (attributes, file_size, created, accessed, modified) = match &entry {
                FsEntry::Directory { name } => {
                    // 任务目录：修改时间 = 任务 end_time（无 end_time 则回退 start_time/now）
                    if segments.len() == 1 && segments[0].eq_ignore_ascii_case(DIR_BY_TASK) {
                        let task_id = name
                            .rsplit_once(" - ")
                            .map(|(_, id)| id)
                            .unwrap_or(name)
                            .trim();
                        if let Ok(Some(task)) = self.storage.get_task(task_id) {
                            // 兼容：若是毫秒时间戳（大于 9999-12-31 秒级阈值），则降为秒
                            fn normalize_unix_secs(ts: u64) -> u64 {
                                const MAX_SEC_9999: u64 = 253402300799;
                                if ts > MAX_SEC_9999 {
                                    ts / 1000
                                } else {
                                    ts
                                }
                            }

                            let ts = task
                                .end_time
                                .or(task.start_time)
                                .map(normalize_unix_secs)
                                .unwrap_or_else(|| {
                                    now()
                                        .duration_since(UNIX_EPOCH)
                                        .unwrap_or_default()
                                        .as_secs()
                                });
                            let t = UNIX_EPOCH
                                .checked_add(Duration::from_secs(ts))
                                .unwrap_or_else(now);
                            (FILE_ATTRIBUTE_DIRECTORY, 0, t, t, t)
                        } else {
                            (FILE_ATTRIBUTE_DIRECTORY, 0, now(), now(), now())
                        }
                    } else {
                        (FILE_ATTRIBUTE_DIRECTORY, 0, now(), now(), now())
                    }
                }
                FsEntry::File { resolved_path, .. } => {
                    let meta_result = std::fs::metadata(resolved_path);
                    match meta_result {
                        Ok(meta) => {
                            let (created, accessed, modified) = system_time_from_fs_metadata(&meta);
                            (
                                FILE_ATTRIBUTE_READONLY | FILE_ATTRIBUTE_ARCHIVE,
                                meta.len(),
                                created,
                                accessed,
                                modified,
                            )
                        }
                        Err(_) => {
                            return Err(STATUS_OBJECT_NAME_NOT_FOUND);
                        }
                    }
                }
            };

            let data = dokan::FindData {
                attributes,
                creation_time: created,
                last_access_time: accessed,
                last_write_time: modified,
                file_size,
                file_name: U16CString::from_str(entry.name())
                    .map_err(|_| STATUS_INVALID_PARAMETER)?,
            };
            let _ = fill(&data);
        }
        Ok(())
    }

    fn deny_access() -> winapi::shared::ntdef::NTSTATUS {
        dokan::map_win32_error_to_ntstatus(winerror::ERROR_ACCESS_DENIED)
    }
}

impl<'c, 'h: 'c> FileSystemHandler<'c, 'h> for KabegameFs {
    type Context = FsItem;

    fn cleanup(
        &'h self,
        _file_name: &U16CStr,
        info: &OperationInfo<'c, 'h, Self>,
        context: &'c Self::Context,
    ) {
        if !info.delete_on_close() {
            return;
        }

        match context {
            FsItem::Directory { path } => {
                let segments = Self::path_to_segments(path);

                // 目录删除：委托给父目录 provider.delete_child（无 can_* 查询）
                if segments.is_empty() {
                    return;
                }
                let parent_segments = &segments[..segments.len().saturating_sub(1)];
                let child_name = segments.last().copied().unwrap_or("");
                let Some(parent) = self.resolve_provider(parent_segments) else {
                    return;
                };
                let ctx = WindowsVdOpsContext::new(self);
                if parent
                    .delete_child(
                        &self.storage,
                        child_name,
                        DeleteChildKind::Directory,
                        DeleteChildMode::Commit,
                        &ctx,
                    )
                    .ok()
                    .unwrap_or(false)
                {
                    notify_explorer_dir_changed_path(&self.mount_point);
                }
            }
            FsItem::File { path, .. } => {
                let segments = Self::path_to_segments(path);

                // 文件删除：默认只读；只有“画册”目录下允许删除=从画册移除图片
                if segments.len() >= 3 && segments[0].eq_ignore_ascii_case(DIR_ALBUMS) {
                    let file_name = segments.last().copied().unwrap_or("");
                    let parent_segments = &segments[..segments.len().saturating_sub(1)];
                    if let Some(parent_provider) = self.resolve_provider(parent_segments) {
                        let ctx = WindowsVdOpsContext::new(self);
                        if parent_provider
                            .delete_child(
                                &self.storage,
                                file_name,
                                DeleteChildKind::File,
                                DeleteChildMode::Commit,
                                &ctx,
                            )
                            .ok()
                            .unwrap_or(false)
                        {
                            notify_explorer_dir_changed_path(&self.mount_point);
                        }
                    }
                }
            }
        }
    }

    fn create_file(
        &'h self,
        file_name: &U16CStr,
        _security_context: &dokan::IO_SECURITY_CONTEXT,
        desired_access: winapi::um::winnt::ACCESS_MASK,
        file_attributes: u32,
        _share_access: u32,
        create_disposition: u32,
        create_options: u32,
        _info: &mut OperationInfo<'c, 'h, Self>,
    ) -> OperationResult<CreateFileInfo<Self::Context>> {
        let user_flags = dokan::map_kernel_to_user_create_file_flags(
            desired_access,
            file_attributes,
            create_options,
            create_disposition,
        );
        let comps = parse_components(file_name);
        let segments: Vec<&str> = comps.iter().map(|s| s.as_str()).collect();

        // 3 = OPEN_EXISTING；其他均视为“创建类操作”。
        // 默认只读：只有 provider 覆写允许的场景才放行（目前：画册根目录 mkdir）。
        if user_flags.creation_disposition != 3 {
            let is_dir_request = (file_attributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
            if !is_dir_request || segments.is_empty() {
                return Err(Self::deny_access());
            }

            // 目录创建：委托给 parent provider
            let create_new = user_flags.creation_disposition == 1; // CREATE_NEW

            // 若已存在：按 CREATE_NEW 语义返回已存在；否则当作成功打开目录
            match self.resolve_cached(&segments) {
                ResolveResult::Directory(_) => {
                    if create_new {
                        return Err(dokan::map_win32_error_to_ntstatus(
                            winerror::ERROR_ALREADY_EXISTS,
                        ));
                    }
                    return Ok(CreateFileInfo {
                        context: FsItem::Directory { path: comps },
                        is_dir: true,
                        new_file_created: false,
                    });
                }
                ResolveResult::File { .. } => return Err(STATUS_NOT_A_DIRECTORY),
                ResolveResult::NotFound => {}
            }

            if segments.len() < 2 {
                return Err(STATUS_ACCESS_DENIED);
            }
            let parent_segments = &segments[..segments.len() - 1];
            let dir_name = segments[segments.len() - 1].trim();
            if dir_name.is_empty() {
                return Err(STATUS_INVALID_PARAMETER);
            }

            let parent_provider = self
                .resolve_provider(parent_segments)
                .ok_or(STATUS_OBJECT_PATH_NOT_FOUND)?;

            if !parent_provider.can_create_child_dir() {
                return Err(Self::deny_access());
            }

            let ctx = WindowsVdOpsContext::new(self);
            match parent_provider.create_child_dir(&self.storage, dir_name, &ctx) {
                Ok(_) => {
                    return Ok(CreateFileInfo {
                        context: FsItem::Directory { path: comps },
                        is_dir: true,
                        new_file_created: true,
                    });
                }
                Err(e) => {
                    if e.contains("已存在") {
                        return Err(dokan::map_win32_error_to_ntstatus(
                            winerror::ERROR_ALREADY_EXISTS,
                        ));
                    }
                    return Err(STATUS_INVALID_PARAMETER);
                }
            }
        }

        // 对文件的写入操作拒绝
        const GENERIC_WRITE: u32 = winapi::um::winnt::GENERIC_WRITE;
        if segments.len() >= 3 && (desired_access & GENERIC_WRITE) != 0 {
            return Err(dokan::map_win32_error_to_ntstatus(
                winerror::ERROR_ACCESS_DENIED,
            ));
        }

        match self.resolve_cached(&segments) {
            ResolveResult::Directory(_) => Ok(CreateFileInfo {
                context: FsItem::Directory { path: comps },
                is_dir: true,
                new_file_created: false,
            }),
            ResolveResult::File {
                image_id,
                resolved_path,
            } => {
                let meta_result = std::fs::metadata(&resolved_path);
                let size = meta_result.as_ref().map(|m| m.len()).unwrap_or(0);
                // 在 create_file 时打开文件句柄并缓存，避免每次 read_file 都重新 open
                let file_handle = match File::open(&resolved_path) {
                    Ok(f) => Arc::new(f),
                    Err(_) => return Err(STATUS_OBJECT_NAME_NOT_FOUND),
                };
                Ok(CreateFileInfo {
                    context: FsItem::File {
                        path: comps,
                        image_id,
                        resolved_path,
                        size,
                        file_handle,
                    },
                    is_dir: false,
                    new_file_created: false,
                })
            }
            ResolveResult::NotFound => Err(STATUS_OBJECT_NAME_NOT_FOUND),
        }
    }

    fn get_file_information(
        &'h self,
        _file_name: &U16CStr,
        _info: &OperationInfo<'c, 'h, Self>,
        context: &'c Self::Context,
    ) -> OperationResult<FileInfo> {
        match context {
            FsItem::Directory { path } => {
                let segments = Self::path_to_segments(path);

                // 任务目录：修改时间 = end_time
                if segments.len() == 2 && segments[0].eq_ignore_ascii_case(DIR_BY_TASK) {
                    let name = segments[1];
                    let task_id = name
                        .rsplit_once(" - ")
                        .map(|(_, id)| id)
                        .unwrap_or(name)
                        .trim();
                    if let Ok(Some(task)) = self.storage.get_task(task_id) {
                        fn normalize_unix_secs(ts: u64) -> u64 {
                            const MAX_SEC_9999: u64 = 253402300799;
                            if ts > MAX_SEC_9999 {
                                ts / 1000
                            } else {
                                ts
                            }
                        }

                        let ts = task
                            .end_time
                            .or(task.start_time)
                            .map(normalize_unix_secs)
                            .unwrap_or_else(|| {
                                now()
                                    .duration_since(UNIX_EPOCH)
                                    .unwrap_or_default()
                                    .as_secs()
                            });
                        let t = UNIX_EPOCH
                            .checked_add(Duration::from_secs(ts))
                            .unwrap_or_else(now);
                        return Ok(FileInfo {
                            attributes: FILE_ATTRIBUTE_DIRECTORY,
                            creation_time: t,
                            last_access_time: t,
                            last_write_time: t,
                            file_size: 0,
                            number_of_links: 1,
                            file_index: file_index_from_path(path),
                        });
                    }
                }

                Ok(FileInfo {
                    attributes: FILE_ATTRIBUTE_DIRECTORY,
                    creation_time: now(),
                    last_access_time: now(),
                    last_write_time: now(),
                    file_size: 0,
                    number_of_links: 1,
                    file_index: file_index_from_path(path),
                })
            }
            FsItem::File {
                resolved_path,
                size,
                image_id,
                ..
            } => {
                let meta =
                    std::fs::metadata(resolved_path).map_err(|_| STATUS_OBJECT_NAME_NOT_FOUND)?;
                let (created, accessed, modified) = system_time_from_fs_metadata(&meta);
                Ok(FileInfo {
                    attributes: FILE_ATTRIBUTE_READONLY | FILE_ATTRIBUTE_ARCHIVE,
                    creation_time: created,
                    last_access_time: accessed,
                    last_write_time: modified,
                    file_size: *size,
                    number_of_links: 1,
                    file_index: file_index_from_numeric_id(image_id),
                })
            }
        }
    }

    fn find_files(
        &'h self,
        _file_name: &U16CStr,
        fill_find_data: impl FnMut(&dokan::FindData) -> dokan::FillDataResult,
        _info: &OperationInfo<'c, 'h, Self>,
        context: &'c Self::Context,
    ) -> OperationResult<()> {
        match context {
            FsItem::Directory { path } => {
                let segments = Self::path_to_segments(path);

                // 解析路径获取 Provider
                let provider = match self.resolve_cached(&segments) {
                    ResolveResult::Directory(p) => p,
                    _ => return Err(STATUS_OBJECT_PATH_NOT_FOUND),
                };

                self.list_entries_as_find_data(&segments, provider, fill_find_data)
            }
            FsItem::File { .. } => Err(STATUS_NOT_A_DIRECTORY),
        }
    }

    fn read_file(
        &'h self,
        _file_name: &U16CStr,
        offset: i64,
        buffer: &mut [u8],
        _info: &OperationInfo<'c, 'h, Self>,
        context: &'c Self::Context,
    ) -> OperationResult<u32> {
        let FsItem::File { file_handle, .. } = context else {
            return Err(STATUS_INVALID_PARAMETER);
        };
        if offset < 0 {
            return Err(STATUS_INVALID_PARAMETER);
        }
        // 使用缓存的文件句柄，直接按 offset 读取，避免每次 open + seek
        // 这里不移动文件游标，天然支持并发碎片读取（Explorer/图片查看器常见）
        let n = file_handle
            .seek_read(buffer, offset as u64)
            .map_err(|_| STATUS_INVALID_PARAMETER)?;
        Ok(n as u32)
    }

    fn write_file(
        &'h self,
        _file_name: &U16CStr,
        _offset: i64,
        _buffer: &[u8],
        _info: &OperationInfo<'c, 'h, Self>,
        _context: &'c Self::Context,
    ) -> OperationResult<u32> {
        Err(STATUS_ACCESS_DENIED)
    }

    fn delete_file(
        &'h self,
        _file_name: &U16CStr,
        _info: &OperationInfo<'c, 'h, Self>,
        context: &'c Self::Context,
    ) -> OperationResult<()> {
        let FsItem::File { path, .. } = context else {
            return Err(STATUS_ACCESS_DENIED);
        };

        let segments = Self::path_to_segments(path);
        // 默认只读；仅允许在画册目录下“删除文件”=从画册移除图片（实际删除在 cleanup(delete_on_close) 中执行）。
        if segments.len() >= 3 && segments[0].eq_ignore_ascii_case(DIR_ALBUMS) {
            let parent_segments = &segments[..segments.len().saturating_sub(1)];
            if let Some(parent_provider) = self.resolve_provider(parent_segments) {
                if parent_provider
                    .delete_child(
                        &self.storage,
                        segments.last().copied().unwrap_or(""),
                        DeleteChildKind::File,
                        DeleteChildMode::Check,
                        &WindowsVdOpsContext::new(self),
                    )
                    .is_ok()
                {
                    return Ok(());
                }
            }
        }
        Err(STATUS_ACCESS_DENIED)
    }

    fn delete_directory(
        &'h self,
        _file_name: &U16CStr,
        _info: &OperationInfo<'c, 'h, Self>,
        context: &'c Self::Context,
    ) -> OperationResult<()> {
        let FsItem::Directory { path } = context else {
            return Err(STATUS_ACCESS_DENIED);
        };

        let segments = Self::path_to_segments(path);
        if segments.is_empty() {
            return Err(STATUS_ACCESS_DENIED);
        }
        let parent_segments = &segments[..segments.len().saturating_sub(1)];
        let child_name = segments.last().copied().unwrap_or("");
        let Some(parent) = self.resolve_provider(parent_segments) else {
            return Err(STATUS_OBJECT_PATH_NOT_FOUND);
        };
        parent
            .delete_child(
                &self.storage,
                child_name,
                DeleteChildKind::Directory,
                DeleteChildMode::Check,
                &WindowsVdOpsContext::new(self),
            )
            .map(|_| ())
            .map_err(|_| STATUS_ACCESS_DENIED)
    }

    fn move_file(
        &'h self,
        _file_name: &U16CStr,
        new_file_name: &U16CStr,
        _replace_if_existing: bool,
        _info: &OperationInfo<'c, 'h, Self>,
        context: &'c Self::Context,
    ) -> OperationResult<()> {
        // 只允许重命名画册
        let FsItem::Directory { path } = context else {
            return Err(STATUS_ACCESS_DENIED);
        };

        let segments = Self::path_to_segments(path);
        if segments.len() != 2 || !segments[0].eq_ignore_ascii_case(DIR_ALBUMS) {
            return Err(STATUS_ACCESS_DENIED);
        }

        let new_comps = parse_components(new_file_name);
        if new_comps.len() != 2 {
            return Err(STATUS_ACCESS_DENIED);
        }

        let new_name = new_comps[1].trim();
        if new_name.is_empty() {
            return Err(STATUS_INVALID_PARAMETER);
        }

        // 查找 Provider 并执行重命名
        if let Some(provider) = self.resolve_provider(&segments) {
            if provider.can_rename() {
                provider
                    .rename(&self.storage, new_name)
                    .map_err(|_| STATUS_ACCESS_DENIED)?;

                let _ = self.app.emit(
                    "albums-changed",
                    serde_json::json!({
                        "reason": "rename",
                        "oldName": segments[1],
                        "newName": new_name
                    }),
                );
                notify_explorer_dir_changed_path(&self.mount_point);
                return Ok(());
            }
        }

        Err(STATUS_ACCESS_DENIED)
    }

    fn get_disk_free_space(
        &'h self,
        _info: &OperationInfo<'c, 'h, Self>,
    ) -> OperationResult<DiskSpaceInfo> {
        Ok(DiskSpaceInfo {
            // 让资源管理器显示为 “0 / 1KB”
            // 注意：某些系统 UI 可能会对极小容量做最小显示/四舍五入，但这里返回值已是 1KB 总量、0 可用。
            byte_count: 1024, // 1KB
            free_byte_count: 0,
            available_byte_count: 0,
        })
    }

    fn get_volume_information(
        &'h self,
        _info: &OperationInfo<'c, 'h, Self>,
    ) -> OperationResult<VolumeInfo> {
        Ok(VolumeInfo {
            name: U16CString::from_str("Kabegame").map_err(|_| STATUS_INVALID_PARAMETER)?,
            serial_number: 0x4B41_4245u32, // 'KABE'
            max_component_length: 255,
            fs_flags: 0,
            fs_name: U16CString::from_str("NTFS").map_err(|_| STATUS_INVALID_PARAMETER)?,
        })
    }
}
