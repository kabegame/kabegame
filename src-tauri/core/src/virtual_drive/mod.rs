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

#![cfg(all(target_os = "windows", feature = "virtual-drive"))]

mod provider;
mod providers;

use std::{
    collections::HashMap,
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::PathBuf,
    sync::{Arc, Mutex, Once},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use dokan::{
    CreateFileInfo, DiskSpaceInfo, FileInfo, FileSystemHandler, FileSystemMounter, MountFlags,
    MountOptions, OperationInfo, OperationResult, VolumeInfo,
};
use widestring::{U16CStr, U16CString};
use winapi::{
    shared::ntstatus::{
        STATUS_ACCESS_DENIED, STATUS_INVALID_PARAMETER, STATUS_NOT_A_DIRECTORY,
        STATUS_OBJECT_NAME_NOT_FOUND, STATUS_OBJECT_PATH_NOT_FOUND,
    },
    shared::winerror,
    um::winnt::{FILE_ATTRIBUTE_ARCHIVE, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_READONLY},
};
use windows_sys::Win32::UI::Shell::{
    SHChangeNotify, SHCNE_ASSOCCHANGED, SHCNE_UPDATEDIR, SHCNF_IDLIST, SHCNF_PATHW,
};
use winreg::{enums::HKEY_CURRENT_USER, RegKey};

use crate::storage::Storage;
use provider::{FsEntry, ResolveResult, VirtualFsProvider};
use providers::{AlbumsProvider, AllProvider, DateGroupProvider, PluginGroupProvider};
use tauri::AppHandle;
use tauri::Emitter;

/// 根目录名称
const DIR_BY_DATE: &str = "按时间";
const DIR_BY_PLUGIN: &str = "按插件";
const DIR_ALBUMS: &str = "画册";
const DIR_ALL: &str = "全部";

static DOKAN_INIT: Once = Once::new();

fn dokan_init_once() {
    DOKAN_INIT.call_once(|| dokan::init());
}

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

fn drive_letter_from_mount_point(mount_point: &str) -> Option<char> {
    let s = mount_point.trim();
    if s.len() < 2 {
        return None;
    }
    let bytes = s.as_bytes();
    let c0 = bytes[0] as char;
    if !c0.is_ascii_alphabetic() {
        return None;
    }
    if bytes[1] as char != ':' {
        return None;
    }
    Some(c0.to_ascii_uppercase())
}

fn refresh_explorer_icons() {
    unsafe {
        SHChangeNotify(
            SHCNE_ASSOCCHANGED as i32,
            SHCNF_IDLIST,
            std::ptr::null(),
            std::ptr::null(),
        );
    }
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

fn drive_icons_root() -> Result<RegKey, String> {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    hkcu.open_subkey_with_flags(
        "Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\DriveIcons",
        winreg::enums::KEY_READ | winreg::enums::KEY_WRITE,
    )
    .or_else(|_| {
        hkcu.create_subkey("Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\DriveIcons")
            .map(|(k, _)| k)
    })
    .map_err(|e| format!("打开注册表 DriveIcons 失败: {}", e))
}

fn set_drive_icon(letter: char, icon_spec: &str) -> Result<(), String> {
    let root = drive_icons_root()?;
    let drive_key = root
        .create_subkey(letter.to_string())
        .map_err(|e| format!("创建注册表 DriveIcons\\{} 失败: {}", letter, e))?
        .0;
    let default_icon = drive_key
        .create_subkey("DefaultIcon")
        .map_err(|e| format!("创建注册表 DefaultIcon 失败: {}", e))?
        .0;

    default_icon
        .set_value("", &icon_spec)
        .map_err(|e| format!("写入盘符图标失败: {}", e))?;
    Ok(())
}

fn clear_drive_icon(letter: char) -> Result<(), String> {
    let root = drive_icons_root()?;
    root.delete_subkey_all(letter.to_string())
        .map_err(|e| format!("删除盘符图标注册表失败: {}", e))?;
    Ok(())
}

fn apply_default_drive_icon_if_possible(mount_point: &str) {
    let Some(letter) = drive_letter_from_mount_point(mount_point) else {
        return;
    };
    let Ok(exe) = std::env::current_exe() else {
        return;
    };
    let spec = format!("{},0", exe.to_string_lossy());
    let _ = set_drive_icon(letter, &spec);
    refresh_explorer_icons();
}

/// 根 Provider - 包含按时间、按插件、画册、全部
struct RootProvider;

impl VirtualFsProvider for RootProvider {
    fn list(&self, _storage: &Storage) -> Result<Vec<FsEntry>, String> {
        Ok(vec![
            FsEntry::dir(DIR_BY_DATE),
            FsEntry::dir(DIR_BY_PLUGIN),
            FsEntry::dir(DIR_ALBUMS),
            FsEntry::dir(DIR_ALL),
        ])
    }

    fn get_child(&self, _storage: &Storage, name: &str) -> Option<Arc<dyn VirtualFsProvider>> {
        match name {
            n if n.eq_ignore_ascii_case(DIR_BY_DATE) => {
                Some(Arc::new(DateGroupProvider::new()) as Arc<dyn VirtualFsProvider>)
            }
            n if n.eq_ignore_ascii_case(DIR_BY_PLUGIN) => {
                Some(Arc::new(PluginGroupProvider::new()) as Arc<dyn VirtualFsProvider>)
            }
            n if n.eq_ignore_ascii_case(DIR_ALBUMS) => {
                Some(Arc::new(AlbumsProvider::new()) as Arc<dyn VirtualFsProvider>)
            }
            n if n.eq_ignore_ascii_case(DIR_ALL) => {
                Some(Arc::new(AllProvider::new()) as Arc<dyn VirtualFsProvider>)
            }
            _ => None,
        }
    }
}

/// 文件系统上下文
#[derive(Debug, Clone)]
enum FsContext {
    /// 目录
    Directory { path: Vec<String> },
    /// 文件
    File {
        path: Vec<String>,
        image_id: String,
        resolved_path: PathBuf,
        size: u64,
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
    pub fn is_mounted(&self) -> bool {
        self.mounted.lock().ok().and_then(|g| g.clone()).is_some()
    }

    pub fn current_mount_point(&self) -> Option<String> {
        self.mounted.lock().ok().and_then(|g| g.clone())
    }

    pub fn notify_root_dir_changed(&self) {
        let Some(mp) = self.current_mount_point() else {
            return;
        };
        notify_explorer_dir_changed_path(&mp);
    }

    pub fn notify_album_dir_changed(&self, storage: &Storage, album_id: &str) {
        let Some(mp) = self.current_mount_point() else {
            return;
        };
        let Ok(Some(name)) = storage.get_album_name_by_id(album_id) else {
            // 画册不存在，刷新画册列表
            let albums_path = join_mount_subdir(&mp, DIR_ALBUMS);
            notify_explorer_dir_changed_path(&albums_path);
            return;
        };
        let album_path = join_mount_subdir(&mp, &format!("{}\\{}", DIR_ALBUMS, name));
        notify_explorer_dir_changed_path(&album_path);
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

            let root = Arc::new(RootProvider);
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
                apply_default_drive_icon_if_possible(&mount_point);
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
                apply_default_drive_icon_if_possible(&mount_point);
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
            if let Some(letter) = drive_letter_from_mount_point(&mount_point) {
                let _ = clear_drive_icon(letter);
                refresh_explorer_icons();
            }
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
        if let Some(letter) = drive_letter_from_mount_point(&mount_point) {
            let _ = clear_drive_icon(letter);
            refresh_explorer_icons();
        }
    }
}

/// Kabegame 虚拟文件系统 Handler
struct KabegameFs {
    storage: Storage,
    mount_point: String,
    app: AppHandle,
    root: Arc<dyn VirtualFsProvider>,
    /// Provider 树状缓存：同一路径复用同一个 Provider，且可按前缀子树精确失效
    provider_cache: Mutex<ProviderCacheNode>,
}

#[derive(Default)]
struct ProviderCacheNode {
    provider: Option<Arc<dyn VirtualFsProvider>>,
    children: HashMap<String, ProviderCacheNode>, // key: lowercased segment
}

impl ProviderCacheNode {
    fn new(provider: Option<Arc<dyn VirtualFsProvider>>) -> Self {
        Self {
            provider,
            children: HashMap::new(),
        }
    }

    fn get_provider(&self, segments: &[&str]) -> Option<Arc<dyn VirtualFsProvider>> {
        if segments.is_empty() {
            return self.provider.clone();
        }
        let mut node = self;
        for seg in segments {
            let key = seg.to_ascii_lowercase();
            node = node.children.get(&key)?;
        }
        node.provider.clone()
    }

    fn insert_provider(&mut self, segments: &[&str], provider: Arc<dyn VirtualFsProvider>) {
        let mut node = self;
        for seg in segments {
            let key = seg.to_ascii_lowercase();
            node = node
                .children
                .entry(key)
                .or_insert_with(ProviderCacheNode::default);
        }
        node.provider = Some(provider);
    }

    fn remove_subtree(&mut self, segments: &[&str]) {
        if segments.is_empty() {
            // 清空整棵树（保留根 provider）
            self.children.clear();
            return;
        }
        let mut node = self;
        for (i, seg) in segments.iter().enumerate() {
            let key = seg.to_ascii_lowercase();
            if i + 1 == segments.len() {
                node.children.remove(&key);
                return;
            }
            let Some(next) = node.children.get_mut(&key) else {
                return;
            };
            node = next;
        }
    }
}

impl KabegameFs {
    fn new(
        storage: Storage,
        mount_point: String,
        app: AppHandle,
        root: Arc<dyn VirtualFsProvider>,
    ) -> Self {
        let root_for_cache = root.clone();
        Self {
            storage,
            mount_point,
            app,
            root,
            provider_cache: Mutex::new(ProviderCacheNode::new(Some(root_for_cache))),
        }
    }

    fn path_to_segments(path: &[String]) -> Vec<&str> {
        path.iter().map(|s| s.as_str()).collect()
    }

    fn get_cached_provider(&self, segments: &[&str]) -> Option<Arc<dyn VirtualFsProvider>> {
        self.provider_cache.lock().ok()?.get_provider(segments)
    }

    fn put_cached_provider(&self, segments: &[&str], provider: Arc<dyn VirtualFsProvider>) {
        if let Ok(mut g) = self.provider_cache.lock() {
            g.insert_provider(segments, provider);
        }
    }

    fn invalidate_cache_subtree(&self, segments: &[&str]) {
        if let Ok(mut g) = self.provider_cache.lock() {
            g.remove_subtree(segments);
        }
    }

    /// 带缓存的路径解析：优先复用已解析的目录 Provider，避免反复构建 Provider/重复 DB 查询
    fn resolve_cached(&self, segments: &[&str]) -> ResolveResult {
        if segments.is_empty() {
            return ResolveResult::Directory(self.root.clone());
        }

        // 如果整个路径是目录且已缓存，直接返回
        if let Some(p) = self.get_cached_provider(segments) {
            return ResolveResult::Directory(p);
        }

        let mut current = self.root.clone();
        let mut prefix: Vec<&str> = Vec::new();

        for (i, seg) in segments.iter().enumerate() {
            let is_last = i + 1 == segments.len();
            if is_last {
                // 目录优先
                let mut dir_path = prefix.clone();
                dir_path.push(seg);
                if let Some(p) = self.get_cached_provider(&dir_path) {
                    return ResolveResult::Directory(p);
                }
                if let Some(child) = current.get_child(&self.storage, seg) {
                    self.put_cached_provider(&dir_path, child.clone());
                    return ResolveResult::Directory(child);
                }
                // 文件（叶子）尝试直接解析
                if let Some((image_id, resolved_path)) = current.resolve_file(&self.storage, seg) {
                    return ResolveResult::File {
                        image_id,
                        resolved_path,
                    };
                }
                return ResolveResult::NotFound;
            } else {
                // 中间层必须是目录
                prefix.push(seg);
                if let Some(p) = self.get_cached_provider(&prefix) {
                    current = p;
                    continue;
                }
                let Some(child) = current.get_child(&self.storage, seg) else {
                    return ResolveResult::NotFound;
                };
                self.put_cached_provider(&prefix, child.clone());
                current = child;
            }
        }

        ResolveResult::NotFound
    }

    fn find_provider_cached(&self, segments: &[&str]) -> Option<Arc<dyn VirtualFsProvider>> {
        if segments.is_empty() {
            return Some(self.root.clone());
        }
        if let Some(p) = self.get_cached_provider(segments) {
            return Some(p);
        }
        // 如果没缓存，走 resolve_cached 获取目录并缓存
        match self.resolve_cached(segments) {
            ResolveResult::Directory(p) => Some(p),
            _ => None,
        }
    }

    fn list_entries_as_find_data(
        &self,
        provider: Arc<dyn VirtualFsProvider>,
        mut fill: impl FnMut(&dokan::FindData) -> dokan::FillDataResult,
    ) -> Result<(), winapi::shared::ntdef::NTSTATUS> {
        let entries = provider
            .list(&self.storage)
            .map_err(|_| STATUS_OBJECT_PATH_NOT_FOUND)?;

        for entry in entries {
            let (attributes, file_size, created, accessed, modified) = match &entry {
                FsEntry::Directory { .. } => (FILE_ATTRIBUTE_DIRECTORY, 0, now(), now(), now()),
                FsEntry::File { resolved_path, .. } => {
                    let meta = std::fs::metadata(resolved_path)
                        .map_err(|_| STATUS_OBJECT_NAME_NOT_FOUND)?;
                    let (created, accessed, modified) = system_time_from_fs_metadata(&meta);
                    (
                        FILE_ATTRIBUTE_READONLY | FILE_ATTRIBUTE_ARCHIVE,
                        meta.len(),
                        created,
                        accessed,
                        modified,
                    )
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
}

impl<'c, 'h: 'c> FileSystemHandler<'c, 'h> for KabegameFs {
    type Context = FsContext;

    fn cleanup(
        &'h self,
        _file_name: &U16CStr,
        info: &OperationInfo<'c, 'h, Self>,
        context: &'c Self::Context,
    ) {
        if !info.delete_on_close() {
            return;
        }

        let path = match context {
            FsContext::Directory { path } => path,
            FsContext::File { path, .. } => path,
        };

        let segments = Self::path_to_segments(path);

        // 查找对应的 Provider 并执行删除
        if let Some(provider) = self.find_provider_cached(&segments) {
            if provider.can_delete() {
                if provider.delete(&self.storage).is_ok() {
                    // 画册删除会改变路径映射：仅精确失效画册相关缓存（不清全局）
                    self.invalidate_cache_subtree(&[DIR_ALBUMS]);
                    // 发送事件通知前端
                    if segments.len() >= 2 && segments[0].eq_ignore_ascii_case(DIR_ALBUMS) {
                        if segments.len() == 2 {
                            let _ = self.app.emit(
                                "albums-changed",
                                serde_json::json!({
                                    "reason": "delete",
                                    "albumName": segments[1]
                                }),
                            );
                        } else if segments.len() == 3 {
                            let _ = self.app.emit(
                                "album-images-changed",
                                serde_json::json!({
                                    "albumName": segments[1],
                                    "reason": "remove"
                                }),
                            );
                        }
                    }
                    notify_explorer_dir_changed_path(&self.mount_point);
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
        // 3 = OPEN_EXISTING
        if user_flags.creation_disposition != 3 {
            return Err(dokan::map_win32_error_to_ntstatus(
                winerror::ERROR_ACCESS_DENIED,
            ));
        }

        let comps = parse_components(file_name);
        let segments: Vec<&str> = comps.iter().map(|s| s.as_str()).collect();

        // 对文件的写入操作拒绝
        const GENERIC_WRITE: u32 = winapi::um::winnt::GENERIC_WRITE;
        if segments.len() >= 3 && (desired_access & GENERIC_WRITE) != 0 {
            return Err(dokan::map_win32_error_to_ntstatus(
                winerror::ERROR_ACCESS_DENIED,
            ));
        }

        match self.resolve_cached(&segments) {
            ResolveResult::Directory(_) => Ok(CreateFileInfo {
                context: FsContext::Directory { path: comps },
                is_dir: true,
                new_file_created: false,
            }),
            ResolveResult::File {
                image_id,
                resolved_path,
            } => {
                let size = std::fs::metadata(&resolved_path)
                    .map(|m| m.len())
                    .unwrap_or(0);
                Ok(CreateFileInfo {
                    context: FsContext::File {
                        path: comps,
                        image_id,
                        resolved_path,
                        size,
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
            FsContext::Directory { path } => Ok(FileInfo {
                attributes: FILE_ATTRIBUTE_DIRECTORY,
                creation_time: now(),
                last_access_time: now(),
                last_write_time: now(),
                file_size: 0,
                number_of_links: 1,
                file_index: file_index_from_path(path),
            }),
            FsContext::File {
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
            FsContext::Directory { path } => {
                let segments = Self::path_to_segments(path);

                // 解析路径获取 Provider
                let provider = match self.resolve_cached(&segments) {
                    ResolveResult::Directory(p) => p,
                    _ => return Err(STATUS_OBJECT_PATH_NOT_FOUND),
                };

                self.list_entries_as_find_data(provider, fill_find_data)
            }
            FsContext::File { .. } => Err(STATUS_NOT_A_DIRECTORY),
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
        let FsContext::File { resolved_path, .. } = context else {
            return Err(STATUS_INVALID_PARAMETER);
        };
        if offset < 0 {
            return Err(STATUS_INVALID_PARAMETER);
        }
        let mut f = File::open(resolved_path).map_err(|_| STATUS_OBJECT_NAME_NOT_FOUND)?;
        f.seek(SeekFrom::Start(offset as u64))
            .map_err(|_| STATUS_INVALID_PARAMETER)?;
        let n = f.read(buffer).map_err(|_| STATUS_INVALID_PARAMETER)?;
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
        let FsContext::File { path, .. } = context else {
            return Err(STATUS_ACCESS_DENIED);
        };

        let segments = Self::path_to_segments(path);

        // 只允许从画册中移除图片
        if segments.len() >= 3 && segments[0].eq_ignore_ascii_case(DIR_ALBUMS) {
            return Ok(());
        }

        Err(STATUS_ACCESS_DENIED)
    }

    fn delete_directory(
        &'h self,
        _file_name: &U16CStr,
        _info: &OperationInfo<'c, 'h, Self>,
        context: &'c Self::Context,
    ) -> OperationResult<()> {
        let FsContext::Directory { path } = context else {
            return Err(STATUS_ACCESS_DENIED);
        };

        let segments = Self::path_to_segments(path);

        // 只允许删除画册
        if segments.len() == 2 && segments[0].eq_ignore_ascii_case(DIR_ALBUMS) {
            // 检查是否为收藏画册
            if let Some(album_id) = self
                .storage
                .find_album_id_by_name_ci(segments[1])
                .ok()
                .flatten()
            {
                if album_id == crate::storage::FAVORITE_ALBUM_ID {
                    return Err(STATUS_ACCESS_DENIED);
                }
            }
            return Ok(());
        }

        Err(STATUS_ACCESS_DENIED)
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
        let FsContext::Directory { path } = context else {
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
        if let Some(provider) = self.find_provider_cached(&segments) {
            if provider.can_rename() {
                provider
                    .rename(&self.storage, new_name)
                    .map_err(|_| STATUS_ACCESS_DENIED)?;

                // 画册重命名会改变路径映射：仅精确失效画册相关缓存（不清全局）
                self.invalidate_cache_subtree(&[DIR_ALBUMS]);
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
            byte_count: 1024 * 1024 * 1024 * 1024,     // 1TB
            free_byte_count: 512 * 1024 * 1024 * 1024, // 512GB
            available_byte_count: 512 * 1024 * 1024 * 1024,
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
