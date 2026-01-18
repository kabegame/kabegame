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
    path::PathBuf,
    sync::{Arc, Once},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use super::drive_service::{join_mount_subdir, notify_explorer_dir_changed_path};
use super::fs::KabegameFs;
use super::semantics::{VfsEntry, VfsError, VfsOpenedItem, VfsSemantics};
#[cfg(all(feature = "virtual-drive-windows", target_os = "windows"))]
use super::virtual_drive_io::{VdFileMeta, VdReadHandle};
use crate::providers::provider::{DeleteChildMode, FsEntry, Provider, VdOpsContext};
use crate::providers::root::{DIR_ALBUMS, DIR_BY_TASK};
use crate::storage::Storage;
use dokan::{
    CreateFileInfo, DiskSpaceInfo, FileInfo, FileSystemHandler, OperationInfo, OperationResult,
    VolumeInfo,
};
use tauri::AppHandle;
use tauri::Emitter;
use tauri::Manager;
use widestring::{U16CStr, U16CString};
use winapi::{
    shared::ntstatus::{
        STATUS_ACCESS_DENIED, STATUS_INVALID_PARAMETER, STATUS_NOT_A_DIRECTORY,
        STATUS_OBJECT_NAME_NOT_FOUND,
    },
    shared::winerror,
    um::winnt::{FILE_ATTRIBUTE_ARCHIVE, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_READONLY},
};

static DOKAN_INIT: Once = Once::new();

/// 初始化 Dokan 驱动（仅一次）
pub fn dokan_init_once() {
    DOKAN_INIT.call_once(|| dokan::init());
}

#[inline]
fn now() -> SystemTime {
    SystemTime::now()
}

// NOTE: 文件时间戳由语义层（VfsSemantics::open_existing/read_dir）统一决定并缓存到 context；
// 这里的几个 helper 仅用于历史逻辑，保留无害，但不应再在高频路径中调用。

fn parse_segments(file_name: &U16CStr) -> Vec<String> {
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

/// 虚拟盘 RootProvider（VD 用）：包含按时间、按插件、按任务、画册、全部
pub struct VirtualDriveRootProvider;

impl Provider for VirtualDriveRootProvider {
    fn descriptor(&self) -> crate::providers::descriptor::ProviderDescriptor {
        // VD 的 root 只是内部使用；这里用 Root descriptor 复用即可
        crate::providers::descriptor::ProviderDescriptor::Root
    }

    fn list(&self, _storage: &Storage) -> Result<Vec<FsEntry>, String> {
        crate::providers::RootProvider::default().list(_storage)
    }

    fn get_child(&self, _storage: &Storage, name: &str) -> Option<Arc<dyn Provider>> {
        crate::providers::RootProvider::default().get_child(_storage, name)
    }

    fn resolve_file(&self, storage: &Storage, name: &str) -> Option<(String, PathBuf)> {
        crate::providers::RootProvider::default().resolve_file(storage, name)
    }
}

/// 文件系统项（Dokan handler 内部使用）
#[derive(Clone)]
pub enum FsItem {
    /// 目录
    Directory { path: Vec<String> },
    /// 文件
    File {
        path: Vec<String>,
        image_id: String,
        size: u64,
        meta: VdFileMeta,
        /// 缓存的只读读取句柄：优先 mmap，fallback seek_read（面向 Explorer 缩略图/预览）
        read_handle: Arc<VdReadHandle>,
    },
}

pub struct WindowsVdOpsContext<'a> {
    fs: &'a KabegameFs,
}

impl<'a> WindowsVdOpsContext<'a> {
    pub fn new(fs: &'a KabegameFs) -> Self {
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

        notify_explorer_dir_changed_path(&join_mount_subdir(
            self.fs.mount_point.as_ref(),
            DIR_ALBUMS,
        ));
        notify_explorer_dir_changed_path(self.fs.mount_point.as_ref());
    }

    fn albums_deleted(&self, album_name: &str) {
        let _ = self.fs.app.emit(
            "albums-changed",
            serde_json::json!({
                "reason": "delete",
                "albumName": album_name
            }),
        );
        notify_explorer_dir_changed_path(self.fs.mount_point.as_ref());
    }

    fn album_images_removed(&self, album_name: &str) {
        let _ = self.fs.app.emit(
            "images-change",
            serde_json::json!({
                "albumName": album_name,
                "reason": "album-remove"
            }),
        );
        notify_explorer_dir_changed_path(self.fs.mount_point.as_ref());
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
        notify_explorer_dir_changed_path(&join_mount_subdir(
            self.fs.mount_point.as_ref(),
            DIR_BY_TASK,
        ));
        notify_explorer_dir_changed_path(self.fs.mount_point.as_ref());
    }
}

impl KabegameFs {
    pub fn new(
        storage: Storage,
        mount_point: Arc<str>,
        app: AppHandle,
        root: Arc<dyn Provider>,
    ) -> Self {
        Self {
            storage,
            mount_point,
            app,
            root,
        }
    }

    fn deny_access() -> winapi::shared::ntdef::NTSTATUS {
        dokan::map_win32_error_to_ntstatus(winerror::ERROR_ACCESS_DENIED)
    }

    fn map_vfs_error(e: VfsError) -> winapi::shared::ntdef::NTSTATUS {
        match e {
            VfsError::NotFound(_) => STATUS_OBJECT_NAME_NOT_FOUND,
            VfsError::NotADirectory(_) => STATUS_NOT_A_DIRECTORY,
            VfsError::AccessDenied(_) => Self::deny_access(),
            VfsError::AlreadyExists(_) => {
                dokan::map_win32_error_to_ntstatus(winerror::ERROR_ALREADY_EXISTS)
            }
            VfsError::InvalidParameter(_) => STATUS_INVALID_PARAMETER,
            VfsError::Other(_) => STATUS_INVALID_PARAMETER,
        }
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
                // 目录删除：委托给父目录 provider.delete_child（无 can_* 查询）
                if path.is_empty() {
                    return;
                }
                let parent_path = &path[..path.len().saturating_sub(1)];
                let child_name = path.last().map(|s| s.as_str()).unwrap_or("");
                let ctx = WindowsVdOpsContext::new(self);
                let rt = self.app.state::<crate::providers::ProviderRuntime>();
                let sem = VfsSemantics::new(&self.storage, &self.root, &*rt);
                if sem
                    .delete_dir(parent_path, child_name, DeleteChildMode::Commit, &ctx)
                    .ok()
                    .unwrap_or(false)
                {
                    notify_explorer_dir_changed_path(self.mount_point.as_ref());
                }
            }
            FsItem::File { path, .. } => {
                // 文件删除：默认只读；只有“画册”目录下允许删除=从画册移除图片
                if path.len() >= 3 && path[0].eq_ignore_ascii_case(DIR_ALBUMS) {
                    let file_name = path.last().map(|s| s.as_str()).unwrap_or("");
                    let parent_path = &path[..path.len().saturating_sub(1)];
                    let ctx = WindowsVdOpsContext::new(self);
                    let rt = self.app.state::<crate::providers::ProviderRuntime>();
                    let sem = VfsSemantics::new(&self.storage, &self.root, &*rt);
                    if sem
                        .delete_file(parent_path, file_name, DeleteChildMode::Commit, &ctx)
                        .ok()
                        .unwrap_or(false)
                    {
                        notify_explorer_dir_changed_path(self.mount_point.as_ref());
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
        let segs = parse_segments(file_name);
        let rt = self.app.state::<crate::providers::ProviderRuntime>();
        let sem = VfsSemantics::new(&self.storage, &self.root, &*rt);

        // 3 = OPEN_EXISTING；其他均视为“创建类操作”。
        // 默认只读：只有 provider 覆写允许的场景才放行（目前：画册根目录 mkdir）。
        if user_flags.creation_disposition != 3 {
            let is_dir_request = (file_attributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
            if !is_dir_request || segs.is_empty() {
                return Err(Self::deny_access());
            }

            // 目录创建：委托给 parent provider
            let create_new = user_flags.creation_disposition == 1; // CREATE_NEW

            // 若已存在：按 CREATE_NEW 语义返回已存在；否则当作成功打开目录
            match sem.open_existing(&segs) {
                Ok(VfsOpenedItem::Directory { .. }) => {
                    if create_new {
                        return Err(dokan::map_win32_error_to_ntstatus(
                            winerror::ERROR_ALREADY_EXISTS,
                        ));
                    }
                    return Ok(CreateFileInfo {
                        context: FsItem::Directory { path: segs },
                        is_dir: true,
                        new_file_created: false,
                    });
                }
                Ok(VfsOpenedItem::File { .. }) => return Err(STATUS_NOT_A_DIRECTORY),
                Err(VfsError::NotFound(_)) => {}
                Err(e) => return Err(Self::map_vfs_error(e)),
            }

            if segs.len() < 2 {
                return Err(STATUS_ACCESS_DENIED);
            }
            let parent_path = &segs[..segs.len() - 1];
            let dir_name = segs[segs.len() - 1].trim();
            if dir_name.is_empty() {
                return Err(STATUS_INVALID_PARAMETER);
            }

            let ctx = WindowsVdOpsContext::new(self);
            match sem.create_dir(parent_path, dir_name, &ctx) {
                Ok(()) => {
                    return Ok(CreateFileInfo {
                        context: FsItem::Directory { path: segs },
                        is_dir: true,
                        new_file_created: true,
                    });
                }
                Err(e) => return Err(Self::map_vfs_error(e)),
            }
        }

        // 对文件的写入操作拒绝
        const GENERIC_WRITE: u32 = winapi::um::winnt::GENERIC_WRITE;
        if segs.len() >= 3 && (desired_access & GENERIC_WRITE) != 0 {
            return Err(dokan::map_win32_error_to_ntstatus(
                winerror::ERROR_ACCESS_DENIED,
            ));
        }

        match sem.open_existing(&segs) {
            Ok(VfsOpenedItem::Directory { .. }) => Ok(CreateFileInfo {
                context: FsItem::Directory { path: segs },
                is_dir: true,
                new_file_created: false,
            }),
            Ok(VfsOpenedItem::File {
                image_id,
                size,
                meta,
                read_handle,
                ..
            }) => Ok(CreateFileInfo {
                context: FsItem::File {
                    path: segs,
                    image_id,
                    size,
                    meta,
                    read_handle,
                },
                is_dir: false,
                new_file_created: false,
            }),
            Err(e) => Err(Self::map_vfs_error(e)),
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
                let segments = VfsSemantics::path_to_segments(path);

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
                size,
                image_id,
                meta,
                ..
            } => Ok(FileInfo {
                attributes: FILE_ATTRIBUTE_READONLY | FILE_ATTRIBUTE_ARCHIVE,
                creation_time: meta.created,
                last_access_time: meta.accessed,
                last_write_time: meta.modified,
                file_size: *size,
                number_of_links: 1,
                file_index: file_index_from_numeric_id(image_id),
            }),
        }
    }

    fn find_files(
        &'h self,
        _file_name: &U16CStr,
        mut fill_find_data: impl FnMut(&dokan::FindData) -> dokan::FillDataResult,
        _info: &OperationInfo<'c, 'h, Self>,
        context: &'c Self::Context,
    ) -> OperationResult<()> {
        match context {
            FsItem::Directory { path } => {
                let rt = self.app.state::<crate::providers::ProviderRuntime>();
                let sem = VfsSemantics::new(&self.storage, &self.root, &*rt);
                let entries = sem.read_dir(path).map_err(Self::map_vfs_error)?;
                for entry in entries {
                    let (attributes, file_size, created, accessed, modified, file_name) =
                        match entry {
                            VfsEntry::Directory { name, meta } => (
                                FILE_ATTRIBUTE_DIRECTORY,
                                0,
                                meta.created,
                                meta.accessed,
                                meta.modified,
                                name,
                            ),
                            VfsEntry::File { name, meta, .. } => (
                                FILE_ATTRIBUTE_READONLY | FILE_ATTRIBUTE_ARCHIVE,
                                meta.size,
                                meta.created,
                                meta.accessed,
                                meta.modified,
                                name,
                            ),
                        };

                    let data = dokan::FindData {
                        attributes,
                        creation_time: created,
                        last_access_time: accessed,
                        last_write_time: modified,
                        file_size,
                        file_name: U16CString::from_str(&file_name)
                            .map_err(|_| STATUS_INVALID_PARAMETER)?,
                    };
                    let _ = fill_find_data(&data);
                }
                Ok(())
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
        let FsItem::File { read_handle, .. } = context else {
            return Err(STATUS_INVALID_PARAMETER);
        };
        if offset < 0 {
            return Err(STATUS_INVALID_PARAMETER);
        }
        let rt = self.app.state::<crate::providers::ProviderRuntime>();
        let sem = VfsSemantics::new(&self.storage, &self.root, &*rt);
        let n = sem
            .read_file(read_handle, offset as u64, buffer)
            .map_err(Self::map_vfs_error)?;
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

        // 默认只读；仅允许在画册目录下“删除文件”=从画册移除图片（实际删除在 cleanup(delete_on_close) 中执行）。
        if path.len() >= 3 && path[0].eq_ignore_ascii_case(DIR_ALBUMS) {
            let parent_path = &path[..path.len().saturating_sub(1)];
            let file_name = path.last().map(|s| s.as_str()).unwrap_or("");
            let rt = self.app.state::<crate::providers::ProviderRuntime>();
            let sem = VfsSemantics::new(&self.storage, &self.root, &*rt);
            let ok = sem
                .delete_file(
                    parent_path,
                    file_name,
                    DeleteChildMode::Check,
                    &WindowsVdOpsContext::new(self),
                )
                .is_ok();
            if ok {
                return Ok(());
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

        if path.is_empty() {
            return Err(STATUS_ACCESS_DENIED);
        }
        let parent_path = &path[..path.len().saturating_sub(1)];
        let child_name = path.last().map(|s| s.as_str()).unwrap_or("");
        let rt = self.app.state::<crate::providers::ProviderRuntime>();
        let sem = VfsSemantics::new(&self.storage, &self.root, &*rt);
        sem.delete_dir(
            parent_path,
            child_name,
            DeleteChildMode::Check,
            &WindowsVdOpsContext::new(self),
        )
        .map(|_| ())
        .map_err(|e| Self::map_vfs_error(e))
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

        if path.len() != 2 || !path[0].eq_ignore_ascii_case(DIR_ALBUMS) {
            return Err(STATUS_ACCESS_DENIED);
        }

        let new_comps = parse_segments(new_file_name);
        if new_comps.len() != 2 {
            return Err(STATUS_ACCESS_DENIED);
        }

        let new_name = new_comps[1].trim();
        if new_name.is_empty() {
            return Err(STATUS_INVALID_PARAMETER);
        }

        // 查找 Provider 并执行重命名
        let rt = self.app.state::<crate::providers::ProviderRuntime>();
        let sem = VfsSemantics::new(&self.storage, &self.root, &*rt);
        sem.rename_dir(path, new_name)
            .map_err(Self::map_vfs_error)?;

        let _ = self.app.emit(
            "albums-changed",
            serde_json::json!({
                "reason": "rename",
                "oldName": path[1],
                "newName": new_name
            }),
        );
        notify_explorer_dir_changed_path(self.mount_point.as_ref());
        Ok(())
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
