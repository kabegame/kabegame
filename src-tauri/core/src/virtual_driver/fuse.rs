//! Linux FUSE 虚拟文件系统实现（使用 fuser crate）。
//!
//! 设计原则：
//! - 复用 VfsSemantics 层，保持与 Windows Dokan 版本一致的语义
//! - 不支持文件系统刷新/失效通知（Linux 不需要）
//! - 支持画册相关的写操作（mkdir/rename/rmdir/unlink）

use std::collections::HashMap;
use std::ffi::OsStr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use fuser::{
    FileAttr, FileType, Filesystem, KernelConfig, MountOption, ReplyAttr, ReplyDirectory,
    ReplyEntry, ReplyOpen, Request, TimeOrNow,
};

use crate::emitter::GlobalEmitter;
use crate::providers::provider::{DeleteChildKind, DeleteChildMode, Provider, VdOpsContext};
use crate::providers::root::{DIR_ALBUMS, DIR_BY_TASK};
use crate::providers::ProviderRuntime;
use crate::storage::Storage;
use crate::virtual_driver::semantics::{VfsEntry, VfsError, VfsOpenedItem, VfsSemantics};
use crate::virtual_driver::virtual_drive_io::{VdFileMeta, VdReadHandle};

// 根目录 inode
const ROOT_INODE: u64 = 1;

// TTL for attributes and entries (1 second)
const TTL: Duration = Duration::from_secs(1);

/// Linux FUSE 虚拟文件系统实现
pub struct KabegameFuseFs {
    root: Arc<dyn Provider>,
    /// inode -> path segments
    inode_to_path: Arc<Mutex<HashMap<u64, Vec<String>>>>,
    /// path segments -> inode
    path_to_inode: Arc<Mutex<HashMap<Vec<String>, u64>>>,
    /// next available inode number
    next_inode: Arc<Mutex<u64>>,
    /// file handle -> opened file context
    file_handles: Arc<Mutex<HashMap<u64, OpenedFile>>>,
    /// next available file handle
    next_fh: Arc<Mutex<u64>>,
}

struct OpenedFile {
    read_handle: Arc<VdReadHandle>,
    #[allow(dead_code)]
    size: u64,
    #[allow(dead_code)]
    meta: VdFileMeta,
}

impl KabegameFuseFs {
    pub fn new(root: Arc<dyn Provider>) -> Self {
        let mut inode_to_path = HashMap::new();
        let mut path_to_inode = HashMap::new();
        // 初始化根目录
        inode_to_path.insert(ROOT_INODE, vec![]);
        path_to_inode.insert(vec![], ROOT_INODE);

        Self {
            root,
            inode_to_path: Arc::new(Mutex::new(inode_to_path)),
            path_to_inode: Arc::new(Mutex::new(path_to_inode)),
            next_inode: Arc::new(Mutex::new(ROOT_INODE + 1)),
            file_handles: Arc::new(Mutex::new(HashMap::new())),
            next_fh: Arc::new(Mutex::new(1)),
        }
    }

    fn semantics(&self) -> VfsSemantics<'_> {
        VfsSemantics::new(&self.root, ProviderRuntime::global())
    }

    /// 获取路径对应的 inode，如果不存在则分配新的
    fn get_or_alloc_inode(&self, path: &[String]) -> u64 {
        let path_to_inode = self.path_to_inode.lock().unwrap();
        if let Some(&ino) = path_to_inode.get(path) {
            return ino;
        }
        drop(path_to_inode);

        let mut path_to_inode = self.path_to_inode.lock().unwrap();
        let mut inode_to_path = self.inode_to_path.lock().unwrap();
        let mut next_inode = self.next_inode.lock().unwrap();

        // 双重检查
        if let Some(&ino) = path_to_inode.get(path) {
            return ino;
        }

        let ino = *next_inode;
        *next_inode += 1;
        path_to_inode.insert(path.to_vec(), ino);
        inode_to_path.insert(ino, path.to_vec());
        ino
    }

    /// 根据 inode 获取路径
    fn get_path(&self, ino: u64) -> Option<Vec<String>> {
        self.inode_to_path.lock().unwrap().get(&ino).cloned()
    }

    /// 将 VfsOpenedItem 转换为 FileAttr
    fn opened_to_attr(&self, item: &VfsOpenedItem, ino: u64) -> FileAttr {
        match item {
            VfsOpenedItem::Directory { .. } => {
                let now = SystemTime::now();
                FileAttr {
                    ino,
                    size: 0,
                    blocks: 0,
                    atime: now,
                    mtime: now,
                    ctime: now,
                    crtime: now,
                    kind: FileType::Directory,
                    perm: 0o755,
                    nlink: 1,
                    uid: unsafe { libc::getuid() },
                    gid: unsafe { libc::getgid() },
                    rdev: 0,
                    flags: 0,
                    blksize: 512,
                }
            }
            VfsOpenedItem::File { size, meta, .. } => {
                FileAttr {
                    ino,
                    size: *size,
                    blocks: (size + 511) / 512,
                    atime: meta.accessed,
                    mtime: meta.modified,
                    ctime: meta.created,
                    crtime: meta.created,
                    kind: FileType::RegularFile,
                    perm: 0o444, // 只读
                    nlink: 1,
                    uid: unsafe { libc::getuid() },
                    gid: unsafe { libc::getgid() },
                    rdev: 0,
                    flags: 0,
                    blksize: 512,
                }
            }
        }
    }

    /// 映射 VfsError 到 libc 错误码
    fn map_vfs_error(e: VfsError) -> libc::c_int {
        match e {
            VfsError::NotFound(_) => libc::ENOENT,
            VfsError::NotADirectory(_) => libc::ENOTDIR,
            VfsError::AccessDenied(_) => libc::EACCES,
            VfsError::AlreadyExists(_) => libc::EEXIST,
            VfsError::InvalidParameter(_) => libc::EINVAL,
            VfsError::Other(_) => libc::EIO,
        }
    }
}

impl Filesystem for KabegameFuseFs {
    fn init(&mut self, _req: &Request<'_>, _config: &mut KernelConfig) -> Result<(), libc::c_int> {
        // 初始化完成
        Ok(())
    }

    fn lookup(
        &mut self,
        _req: &Request<'_>,
        parent: u64,
        name: &OsStr,
        reply: ReplyEntry,
    ) {
        let Some(parent_path) = self.get_path(parent) else {
            reply.error(libc::ENOENT);
            return;
        };

        let name_str = match name.to_str() {
            Some(s) => s,
            None => {
                reply.error(libc::EINVAL);
                return;
            }
        };

        let mut child_path = parent_path.clone();
        child_path.push(name_str.to_string());

        let sem = self.semantics();
        match sem.open_existing(&child_path) {
            Ok(item) => {
                let ino = self.get_or_alloc_inode(&child_path);
                let attr = self.opened_to_attr(&item, ino);
                reply.entry(&TTL, &attr, 0);
            }
            Err(e) => {
                reply.error(Self::map_vfs_error(e));
            }
        }
    }

    fn getattr(&mut self, _req: &Request<'_>, ino: u64, _fh: Option<u64>, reply: ReplyAttr) {
        let Some(path) = self.get_path(ino) else {
            reply.error(libc::ENOENT);
            return;
        };

        let sem = self.semantics();
        match sem.open_existing(&path) {
            Ok(item) => {
                let attr = self.opened_to_attr(&item, ino);
                reply.attr(&TTL, &attr);
            }
            Err(e) => {
                reply.error(Self::map_vfs_error(e));
            }
        }
    }

    fn readdir(
        &mut self,
        _req: &Request<'_>,
        ino: u64,
        _fh: u64,
        offset: i64,
        mut reply: ReplyDirectory,
    ) {
        let Some(path) = self.get_path(ino) else {
            reply.error(libc::ENOENT);
            return;
        };

        let sem = self.semantics();
        let entries = match sem.read_dir(&path) {
            Ok(e) => e,
            Err(e) => {
                reply.error(Self::map_vfs_error(e));
                return;
            }
        };

        // 添加 "." 和 ".."
        let mut all_entries: Vec<(u64, &str, FileType)> = vec![
            (ino, ".", FileType::Directory),
            (
                if path.is_empty() {
                    ino
                } else {
                    self.get_or_alloc_inode(&path[..path.len() - 1])
                },
                "..",
                FileType::Directory,
            ),
        ];

        // 添加目录项
        for entry in &entries {
            let mut entry_path = path.clone();
            entry_path.push(entry.name().to_string());
            let entry_ino = self.get_or_alloc_inode(&entry_path);
            let file_type = match entry {
                VfsEntry::Directory { .. } => FileType::Directory,
                VfsEntry::File { .. } => FileType::RegularFile,
            };
            all_entries.push((entry_ino, entry.name(), file_type));
        }

        // 根据 offset 跳过已发送的条目
        let start = offset as usize;
        for (i, (ino, name, kind)) in all_entries.iter().enumerate().skip(start) {
            if reply.add(*ino, (i + 1) as i64, *kind, name) {
                break;
            }
        }
        reply.ok();
    }

    fn open(&mut self, _req: &Request<'_>, ino: u64, flags: i32, reply: ReplyOpen) {
        // 检查是否允许写入（我们只支持只读）
        if (flags & libc::O_RDWR != 0) || (flags & libc::O_WRONLY != 0) {
            reply.error(libc::EACCES);
            return;
        }

        let Some(path) = self.get_path(ino) else {
            reply.error(libc::ENOENT);
            return;
        };

        let sem = self.semantics();
        match sem.open_existing(&path) {
            Ok(VfsOpenedItem::File {
                read_handle,
                size,
                meta,
                ..
            }) => {
                let mut next_fh = self.next_fh.lock().unwrap();
                let fh = *next_fh;
                *next_fh += 1;
                drop(next_fh);

                let mut file_handles = self.file_handles.lock().unwrap();
                file_handles.insert(
                    fh,
                    OpenedFile {
                        read_handle,
                        size,
                        meta,
                    },
                );
                drop(file_handles);

                reply.opened(fh, 0);
            }
            Ok(VfsOpenedItem::Directory { .. }) => {
                // 目录打开：返回一个简单的 fh
                let mut next_fh = self.next_fh.lock().unwrap();
                let fh = *next_fh;
                *next_fh += 1;
                drop(next_fh);
                reply.opened(fh, 0);
            }
            Err(e) => {
                reply.error(Self::map_vfs_error(e));
            }
        }
    }

    fn read(
        &mut self,
        _req: &Request<'_>,
        _ino: u64,
        fh: u64,
        offset: i64,
        size: u32,
        _flags: i32,
        _lock_owner: Option<u64>,
        reply: fuser::ReplyData,
    ) {
        let file_handles = self.file_handles.lock().unwrap();
        let Some(opened_file) = file_handles.get(&fh) else {
            reply.error(libc::EBADF);
            return;
        };

        if offset < 0 {
            reply.error(libc::EINVAL);
            return;
        }

        let mut buffer = vec![0u8; size as usize];
        match opened_file
            .read_handle
            .read_at(offset as u64, &mut buffer)
        {
            Ok(n) => {
                buffer.truncate(n);
                reply.data(&buffer);
            }
            Err(_) => {
                reply.error(libc::EIO);
            }
        }
    }

    fn release(
        &mut self,
        _req: &Request<'_>,
        _ino: u64,
        fh: u64,
        _flags: i32,
        _lock_owner: Option<u64>,
        _flush: bool,
        reply: fuser::ReplyEmpty,
    ) {
        let mut file_handles = self.file_handles.lock().unwrap();
        file_handles.remove(&fh);
        reply.ok();
    }

    fn mkdir(
        &mut self,
        _req: &Request<'_>,
        parent: u64,
        name: &OsStr,
        mode: u32,
        umask: u32,
        reply: ReplyEntry,
    ) {
        let _ = mode; // 忽略 mode，使用语义层的权限控制
        let _ = umask; // 忽略 umask

        let Some(parent_path) = self.get_path(parent) else {
            reply.error(libc::ENOENT);
            return;
        };

        let name_str = match name.to_str() {
            Some(s) => s.trim(),
            None => {
                reply.error(libc::EINVAL);
                return;
            }
        };

        if name_str.is_empty() {
            reply.error(libc::EINVAL);
            return;
        }

        // 只允许在画册根目录下创建目录
        if parent_path.len() != 1 || !parent_path[0].eq_ignore_ascii_case(DIR_ALBUMS) {
            reply.error(libc::EACCES);
            return;
        }

        let mut child_path = parent_path.clone();
        child_path.push(name_str.to_string());

        let sem = self.semantics();
        let ctx = LinuxVdOpsContext;
        match sem.create_dir(&parent_path, name_str, &ctx) {
            Ok(()) => {
                let ino = self.get_or_alloc_inode(&child_path);
                let attr = self.opened_to_attr(
                    &VfsOpenedItem::Directory {
                        path: child_path.clone(),
                    },
                    ino,
                );
                reply.entry(&TTL, &attr, 0);
            }
            Err(e) => {
                reply.error(Self::map_vfs_error(e));
            }
        }
    }

    fn rmdir(&mut self, _req: &Request<'_>, parent: u64, name: &OsStr, reply: fuser::ReplyEmpty) {
        let Some(parent_path) = self.get_path(parent) else {
            reply.error(libc::ENOENT);
            return;
        };

        let name_str = match name.to_str() {
            Some(s) => s,
            None => {
                reply.error(libc::EINVAL);
                return;
            }
        };

        let sem = self.semantics();
        let ctx = LinuxVdOpsContext;
        match sem.delete_dir(&parent_path, name_str, DeleteChildMode::Commit, &ctx) {
            Ok(true) => {
                // 清理 inode 映射
                let mut child_path = parent_path.clone();
                child_path.push(name_str.to_string());
                let mut path_to_inode = self.path_to_inode.lock().unwrap();
                let mut inode_to_path = self.inode_to_path.lock().unwrap();
                if let Some(ino) = path_to_inode.remove(&child_path) {
                    inode_to_path.remove(&ino);
                }
                reply.ok();
            }
            Ok(false) => {
                reply.error(libc::ENOENT);
            }
            Err(e) => {
                reply.error(Self::map_vfs_error(e));
            }
        }
    }

    fn unlink(&mut self, _req: &Request<'_>, parent: u64, name: &OsStr, reply: fuser::ReplyEmpty) {
        let Some(parent_path) = self.get_path(parent) else {
            reply.error(libc::ENOENT);
            return;
        };

        let name_str = match name.to_str() {
            Some(s) => s,
            None => {
                reply.error(libc::EINVAL);
                return;
            }
        };

        // 只允许在画册目录下删除文件（语义=从画册移除图片）
        if parent_path.len() < 2 || !parent_path[0].eq_ignore_ascii_case(DIR_ALBUMS) {
            reply.error(libc::EACCES);
            return;
        }

        let sem = self.semantics();
        let ctx = LinuxVdOpsContext;
        match sem.delete_file(&parent_path, name_str, DeleteChildMode::Commit, &ctx) {
            Ok(true) => reply.ok(),
            Ok(false) => reply.error(libc::ENOENT),
            Err(e) => reply.error(Self::map_vfs_error(e)),
        }
    }

    fn rename(
        &mut self,
        _req: &Request<'_>,
        parent: u64,
        name: &OsStr,
        newparent: u64,
        newname: &OsStr,
        flags: u32,
        reply: fuser::ReplyEmpty,
    ) {
        let _ = flags; // 忽略 flags

        let Some(parent_path) = self.get_path(parent) else {
            reply.error(libc::ENOENT);
            return;
        };

        let Some(newparent_path) = self.get_path(newparent) else {
            reply.error(libc::ENOENT);
            return;
        };

        let _name_str = match name.to_str() {
            Some(s) => s,
            None => {
                reply.error(libc::EINVAL);
                return;
            }
        };

        let newname_str = match newname.to_str() {
            Some(s) => s.trim(),
            None => {
                reply.error(libc::EINVAL);
                return;
            }
        };

        if newname_str.is_empty() {
            reply.error(libc::EINVAL);
            return;
        }

        // 只允许重命名画册（必须在画册根目录下）
        if parent_path.len() != 2
            || !parent_path[0].eq_ignore_ascii_case(DIR_ALBUMS)
            || newparent_path.len() != 1
            || !newparent_path[0].eq_ignore_ascii_case(DIR_ALBUMS)
        {
            reply.error(libc::EACCES);
            return;
        }

        let sem = self.semantics();
        match sem.rename_dir(&parent_path, newname_str) {
            Ok(()) => {
                // 更新 inode 映射
                let old_path = parent_path.clone();
                let mut new_path = newparent_path.clone();
                new_path.push(newname_str.to_string());
                let mut path_to_inode = self.path_to_inode.lock().unwrap();
                let mut inode_to_path = self.inode_to_path.lock().unwrap();
                if let Some(ino) = path_to_inode.remove(&old_path) {
                    path_to_inode.insert(new_path.clone(), ino);
                    inode_to_path.insert(ino, new_path);
                }
                reply.ok();
            }
            Err(e) => {
                reply.error(Self::map_vfs_error(e));
            }
        }
    }
}

/// Linux 虚拟盘操作上下文（不发送文件系统刷新通知）
struct LinuxVdOpsContext;

impl VdOpsContext for LinuxVdOpsContext {
    fn albums_created(&self, album_name: &str) {
        GlobalEmitter::global().emit(
            "albums-changed",
            serde_json::json!({
                "reason": "create",
                "albumName": album_name
            }),
        );
        // Linux 不需要刷新文件系统
    }

    fn albums_deleted(&self, album_name: &str) {
        GlobalEmitter::global().emit(
            "albums-changed",
            serde_json::json!({
                "reason": "delete",
                "albumName": album_name
            }),
        );
        // Linux 不需要刷新文件系统
    }

    fn album_images_removed(&self, album_name: &str) {
        GlobalEmitter::global().emit(
            "images-change",
            serde_json::json!({
                "albumName": album_name,
                "reason": "album-remove"
            }),
        );
        // Linux 不需要刷新文件系统
    }

    fn tasks_deleted(&self, task_id: &str) {
        GlobalEmitter::global().emit(
            "tasks-changed",
            serde_json::json!({
                "reason": "delete",
                "taskId": task_id
            }),
        );
        // Linux 不需要刷新文件系统
    }
}
