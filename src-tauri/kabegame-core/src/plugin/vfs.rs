use std::borrow::Cow;
use std::collections::HashSet;
use std::io;
use std::path::{Component, Path, PathBuf};
use std::rc::Rc;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};

use deno_fs::{FileSystem, FsDirEntry, FsFileType, FsReadDir, FsReadDirRc, OpenOptions, RealFs};
use deno_io::fs::{File, FsError, FsResult, FsStat, FsStatFs};
use deno_permissions::{CheckedPath, CheckedPathBuf};

use crate::app_paths::AppPaths;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Access {
    ReadOnly,
    ReadWrite,
}

#[derive(Debug)]
pub struct PluginVfs {
    handle: u64,
    snapshot_placeholder: bool,
    data_root: PathBuf,
    cache_root: PathBuf,
    tmp_root: PathBuf,
    inner: RealFs,
    bytes_written: AtomicU64,
}

#[derive(Debug)]
struct MountReadDir {
    index: AtomicUsize,
}

#[async_trait::async_trait(?Send)]
impl FsReadDir for MountReadDir {
    async fn next(&self) -> FsResult<Option<FsDirEntry>> {
        let index = self.index.fetch_add(1, Ordering::Relaxed);
        Ok(mount_entries().get(index).cloned())
    }
}

fn mount_entries() -> [FsDirEntry; 3] {
    ["data", "cache", "tmp"].map(|name| FsDirEntry {
        name: name.to_string(),
        is_file: false,
        is_directory: true,
        is_symlink: false,
    })
}

fn permission_denied(message: impl Into<String>) -> FsError {
    io::Error::new(io::ErrorKind::PermissionDenied, message.into()).into()
}

fn not_found(message: impl Into<String>) -> FsError {
    io::Error::new(io::ErrorKind::NotFound, message.into()).into()
}

fn invalid_input(message: impl Into<String>) -> FsError {
    io::Error::new(io::ErrorKind::InvalidInput, message.into()).into()
}

macro_rules! forward_sync {
    ($name:ident, $access:expr, ($($arg:ident: $ty:ty),*), $ret:ty) => {
        fn $name(
            &self,
            path: &CheckedPath,
            $($arg: $ty),*
        ) -> FsResult<$ret> {
            let path = self.resolve_checked(path, $access)?;
            self.inner.$name(&path.as_checked_path(), $($arg),*)
        }
    };
}

macro_rules! forward_async {
    ($name:ident, $access:expr, ($($arg:ident: $ty:ty),*), $ret:ty) => {
        fn $name<'life0, 'async_trait>(
            &'life0 self,
            path: CheckedPathBuf,
            $($arg: $ty),*
        ) -> std::pin::Pin<Box<dyn std::future::Future<Output = FsResult<$ret>> + 'async_trait>>
        where
            'life0: 'async_trait,
            Self: 'async_trait,
        {
            Box::pin(async move {
                let path = self.resolve_checked(&path.as_checked_path(), $access)?;
                self.inner.$name(path, $($arg),*).await
            })
        }
    };
}

impl PluginVfs {
    pub fn new(handle: u64, plugin_id: &str) -> FsResult<Self> {
        let paths = AppPaths::global();
        let data_root = paths.plugin_data_dir(plugin_id).map_err(invalid_input)?;
        let cache_root = paths.plugin_cache_dir(plugin_id).map_err(invalid_input)?;
        let tmp_root = paths.plugin_temp_dir(plugin_id).map_err(invalid_input)?;
        Ok(Self::from_roots(handle, data_root, cache_root, tmp_root))
    }

    /// 仅用于生成 V8 baseline snapshot 的不可用占位文件系统。
    ///
    /// 快照生成只求值 extension JS，不应执行任何文件操作；`resolve` 会在读取这些
    /// 空根路径前直接拒绝访问，因此该实例不会映射到任何真实目录。
    pub(crate) fn snapshot_placeholder() -> Self {
        Self {
            handle: 0,
            snapshot_placeholder: true,
            data_root: PathBuf::new(),
            cache_root: PathBuf::new(),
            tmp_root: PathBuf::new(),
            inner: RealFs,
            bytes_written: AtomicU64::new(0),
        }
    }

    fn from_roots(handle: u64, data_root: PathBuf, cache_root: PathBuf, tmp_root: PathBuf) -> Self {
        Self {
            handle,
            snapshot_placeholder: false,
            data_root,
            cache_root,
            tmp_root,
            inner: RealFs,
            bytes_written: AtomicU64::new(0),
        }
    }

    pub fn bytes_written(&self) -> u64 {
        self.bytes_written.load(Ordering::Relaxed)
    }

    /// 校验虚拟路径后直接打开宿主文件，避免把已解析的真实路径暴露给 VFS 模块之外。
    pub fn open_std(&self, virtual_path: &Path, options: OpenOptions) -> FsResult<std::fs::File> {
        let access = if open_options_write(&options) {
            Access::ReadWrite
        } else {
            Access::ReadOnly
        };
        let real_path = self.resolve(virtual_path, access)?;
        let checked_path = CheckedPath::unsafe_new(Cow::Borrowed(real_path.as_path()));
        deno_fs::open_options_for_checked_path(options, &checked_path)
            .open(real_path)
            .map_err(Into::into)
    }

    fn virtual_root(&self) -> PathBuf {
        PathBuf::from(format!("/{}", self.handle))
    }

    fn virtual_tmp_dir(&self) -> PathBuf {
        self.virtual_root().join("tmp")
    }

    fn roots(&self) -> [(&'static str, &Path); 3] {
        [
            ("data", self.data_root.as_path()),
            ("cache", self.cache_root.as_path()),
            ("tmp", self.tmp_root.as_path()),
        ]
    }

    fn ensure_available(&self) -> FsResult<()> {
        if self.snapshot_placeholder {
            Err(permission_denied("V8 快照占位文件系统不可访问"))
        } else {
            Ok(())
        }
    }

    /// 校验虚拟路径并翻译为插件私有的宿主路径。
    ///
    /// `..` 只允许在 `/{handle}` 内折叠；尝试越过该会话根会立即失败。
    fn resolve(&self, virtual_path: &Path, need: Access) -> FsResult<PathBuf> {
        self.ensure_available()?;
        if !virtual_path.has_root() {
            return Err(permission_denied("插件 VFS 只接受绝对路径"));
        }

        let mut components = virtual_path.components();
        match components.next() {
            Some(Component::RootDir) => {}
            _ => return Err(permission_denied("插件 VFS 只接受绝对路径")),
        }

        let Some(Component::Normal(raw_handle)) = components.next() else {
            return Err(permission_denied("插件 VFS 根目录不可访问"));
        };
        let path_handle = raw_handle
            .to_str()
            .and_then(|value| value.parse::<u64>().ok())
            .ok_or_else(|| permission_denied("插件 VFS handle 无效"))?;
        if path_handle != self.handle {
            return Err(permission_denied("插件 VFS handle 不匹配"));
        }

        let mut normalized = Vec::new();
        for component in components {
            match component {
                Component::CurDir => {}
                Component::Normal(segment) => normalized.push(segment.to_os_string()),
                Component::ParentDir => {
                    if normalized.pop().is_none() {
                        return Err(permission_denied("插件 VFS 路径试图越过会话根"));
                    }
                }
                Component::RootDir | Component::Prefix(_) => {
                    return Err(permission_denied("插件 VFS 路径包含额外的根或前缀"));
                }
            }
        }

        if normalized.is_empty() {
            if need == Access::ReadWrite {
                return Err(permission_denied("插件 VFS 会话根为只读"));
            }
            // 会话根是合成目录；返回值不会用于列目录或 realpath。
            return Ok(self.data_root.clone());
        }

        let mount = normalized[0]
            .to_str()
            .ok_or_else(|| not_found("插件 VFS 挂载点不存在"))?;
        let root = match mount {
            "data" => &self.data_root,
            "cache" => &self.cache_root,
            "tmp" => &self.tmp_root,
            _ => return Err(not_found("插件 VFS 挂载点不存在")),
        };
        let mut real_path = root.clone();
        real_path.extend(normalized.iter().skip(1));

        self.check_symlink_safety(&real_path)?;
        if need == Access::ReadWrite {
            // 只惰性创建挂载根，不改变 mkdir 等 API 对更深父目录的原有语义。
            std::fs::create_dir_all(root)?;
        }
        Ok(real_path)
    }

    fn resolve_checked(&self, path: &CheckedPath, need: Access) -> FsResult<CheckedPathBuf> {
        self.resolve(path, need).map(CheckedPathBuf::unsafe_new)
    }

    fn is_virtual_root(&self, virtual_path: &Path) -> bool {
        if self.resolve(virtual_path, Access::ReadOnly).is_err() {
            return false;
        }

        // `resolve` 已完成全部安全校验；这里仅重放词法深度，以区分合成会话根与
        // 同样映射到 data_root 的 `/handle/data`。
        let mut components = virtual_path.components();
        let _ = components.next();
        let _ = components.next();
        let mut depth = 0usize;
        for component in components {
            match component {
                Component::CurDir => {}
                Component::Normal(_) => depth += 1,
                Component::ParentDir => depth = depth.saturating_sub(1),
                Component::RootDir | Component::Prefix(_) => return false,
            }
        }
        depth == 0
    }

    fn root_for_real_path<'a>(&'a self, path: &Path) -> Option<(&'static str, &'a Path, PathBuf)> {
        for (mount, root) in self.roots() {
            if let Ok(relative) = path.strip_prefix(root) {
                return Some((mount, root, relative.to_path_buf()));
            }
        }
        None
    }

    fn reverse_translate(&self, real_path: &Path) -> FsResult<PathBuf> {
        for (mount, root) in self.roots() {
            if let Ok(relative) = real_path.strip_prefix(root) {
                return Ok(self.virtual_root().join(mount).join(relative));
            }
            if let Ok(canonical_root) = std::fs::canonicalize(root) {
                if let Ok(relative) = real_path.strip_prefix(canonical_root) {
                    return Ok(self.virtual_root().join(mount).join(relative));
                }
            }
        }
        Err(permission_denied(
            "宿主路径无法映射回插件 VFS，拒绝泄漏真实路径",
        ))
    }

    fn check_symlink_safety(&self, real_path: &Path) -> FsResult<()> {
        self.check_symlink_safety_inner(real_path, &mut HashSet::new(), 0)
    }

    fn check_symlink_safety_inner(
        &self,
        real_path: &Path,
        visited: &mut HashSet<PathBuf>,
        depth: usize,
    ) -> FsResult<()> {
        if depth > 40 || !visited.insert(real_path.to_path_buf()) {
            return Err(permission_denied("插件 VFS 软链形成循环或层级过深"));
        }
        let (_, root, relative) = self
            .root_for_real_path(real_path)
            .ok_or_else(|| permission_denied("插件 VFS 宿主路径越界"))?;

        let mut current = root.to_path_buf();
        let mut paths = Vec::with_capacity(relative.components().count() + 1);
        paths.push(current.clone());
        for component in relative.components() {
            current.push(component.as_os_str());
            paths.push(current.clone());
        }

        for current in paths {
            let metadata = match std::fs::symlink_metadata(&current) {
                Ok(metadata) => metadata,
                Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
                Err(error) => return Err(error.into()),
            };
            if !metadata.file_type().is_symlink() {
                continue;
            }
            if current != real_path {
                return Err(permission_denied("插件 VFS 拒绝通过作为父目录的软链访问"));
            }

            let target = std::fs::read_link(&current)?;
            let target = if target.is_absolute() {
                normalize_absolute_path(&target)?
            } else {
                normalize_absolute_path(
                    &current
                        .parent()
                        .ok_or_else(|| permission_denied("软链缺少父目录"))?
                        .join(target),
                )?
            };
            self.reverse_translate(&target)?;
            return self.check_symlink_safety_inner(&target, visited, depth + 1);
        }
        Ok(())
    }

    fn translate_link_result(&self, link_path: &Path, target: PathBuf) -> FsResult<PathBuf> {
        let target = if target.is_absolute() {
            normalize_absolute_path(&target)?
        } else {
            normalize_absolute_path(
                &link_path
                    .parent()
                    .ok_or_else(|| permission_denied("软链缺少父目录"))?
                    .join(target),
            )?
        };
        self.reverse_translate(&target)
    }
}

fn normalize_absolute_path(path: &Path) -> FsResult<PathBuf> {
    if !path.is_absolute() {
        return Err(permission_denied("软链目标不是绝对宿主路径"));
    }
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            Component::RootDir => normalized.push(component.as_os_str()),
            Component::CurDir => {}
            Component::Normal(segment) => normalized.push(segment),
            Component::ParentDir => {
                if !normalized.pop() {
                    return Err(permission_denied("软链目标试图越过宿主根目录"));
                }
            }
        }
    }
    Ok(normalized)
}

#[async_trait::async_trait(?Send)]
impl FileSystem for PluginVfs {
    fn cwd(&self) -> FsResult<PathBuf> {
        self.ensure_available()?;
        Ok(self.virtual_root())
    }

    fn tmp_dir(&self) -> FsResult<PathBuf> {
        self.ensure_available()?;
        Ok(self.virtual_tmp_dir())
    }

    fn chdir(&self, path: &CheckedPath) -> FsResult<()> {
        self.resolve(path, Access::ReadOnly)?;
        Err(FsError::NotSupported)
    }

    /// umask 是**进程级**设置，不受路径沙箱约束：转发给 RealFs 会让插件改掉整个
    /// kabegame 进程后续所有文件创建的权限位（下载、数据库、设置文件都受影响）。
    /// 这是虚拟文件系统边界之外的副作用，一律拒绝。
    fn umask(&self, _mask: Option<u32>) -> FsResult<u32> {
        Err(FsError::NotSupported)
    }

    fn open_sync(&self, path: &CheckedPath, options: OpenOptions) -> FsResult<Rc<dyn File>> {
        let access = if open_options_write(&options) {
            Access::ReadWrite
        } else {
            Access::ReadOnly
        };
        let path = self.resolve_checked(path, access)?;
        self.inner.open_sync(&path.as_checked_path(), options)
    }

    async fn open_async(
        &self,
        path: CheckedPathBuf,
        options: OpenOptions,
    ) -> FsResult<Rc<dyn File>> {
        let access = if open_options_write(&options) {
            Access::ReadWrite
        } else {
            Access::ReadOnly
        };
        let path = self.resolve_checked(&path.as_checked_path(), access)?;
        self.inner.open_async(path, options).await
    }

    forward_sync!(mkdir_sync, Access::ReadWrite, (recursive: bool, mode: Option<u32>), ());
    forward_async!(mkdir_async, Access::ReadWrite, (recursive: bool, mode: Option<u32>), ());

    #[cfg(unix)]
    forward_sync!(chmod_sync, Access::ReadWrite, (mode: u32), ());
    #[cfg(not(unix))]
    forward_sync!(chmod_sync, Access::ReadWrite, (mode: i32), ());
    #[cfg(unix)]
    forward_async!(chmod_async, Access::ReadWrite, (mode: u32), ());
    #[cfg(not(unix))]
    forward_async!(chmod_async, Access::ReadWrite, (mode: i32), ());

    forward_sync!(chown_sync, Access::ReadWrite, (uid: Option<u32>, gid: Option<u32>), ());
    forward_async!(chown_async, Access::ReadWrite, (uid: Option<u32>, gid: Option<u32>), ());
    forward_sync!(lchmod_sync, Access::ReadWrite, (mode: u32), ());
    forward_async!(lchmod_async, Access::ReadWrite, (mode: u32), ());
    forward_sync!(lchown_sync, Access::ReadWrite, (uid: Option<u32>, gid: Option<u32>), ());
    forward_async!(lchown_async, Access::ReadWrite, (uid: Option<u32>, gid: Option<u32>), ());
    forward_sync!(remove_sync, Access::ReadWrite, (recursive: bool), ());
    forward_async!(remove_async, Access::ReadWrite, (recursive: bool), ());

    fn copy_file_sync(&self, oldpath: &CheckedPath, newpath: &CheckedPath) -> FsResult<()> {
        let oldpath = self.resolve_checked(oldpath, Access::ReadOnly)?;
        let newpath = self.resolve_checked(newpath, Access::ReadWrite)?;
        self.inner
            .copy_file_sync(&oldpath.as_checked_path(), &newpath.as_checked_path())
    }

    async fn copy_file_async(
        &self,
        oldpath: CheckedPathBuf,
        newpath: CheckedPathBuf,
    ) -> FsResult<()> {
        let oldpath = self.resolve_checked(&oldpath.as_checked_path(), Access::ReadOnly)?;
        let newpath = self.resolve_checked(&newpath.as_checked_path(), Access::ReadWrite)?;
        self.inner.copy_file_async(oldpath, newpath).await
    }

    fn cp_sync(&self, path: &CheckedPath, new_path: &CheckedPath) -> FsResult<()> {
        let path = self.resolve_checked(path, Access::ReadOnly)?;
        let new_path = self.resolve_checked(new_path, Access::ReadWrite)?;
        self.inner
            .cp_sync(&path.as_checked_path(), &new_path.as_checked_path())
    }

    async fn cp_async(&self, path: CheckedPathBuf, new_path: CheckedPathBuf) -> FsResult<()> {
        let path = self.resolve_checked(&path.as_checked_path(), Access::ReadOnly)?;
        let new_path = self.resolve_checked(&new_path.as_checked_path(), Access::ReadWrite)?;
        self.inner.cp_async(path, new_path).await
    }

    forward_sync!(stat_sync, Access::ReadOnly, (), FsStat);
    forward_async!(stat_async, Access::ReadOnly, (), FsStat);
    forward_sync!(lstat_sync, Access::ReadOnly, (), FsStat);
    forward_async!(lstat_async, Access::ReadOnly, (), FsStat);
    forward_sync!(statfs_sync, Access::ReadOnly, (bigint: bool), FsStatFs);
    forward_async!(statfs_async, Access::ReadOnly, (bigint: bool), FsStatFs);

    fn realpath_sync(&self, path: &CheckedPath) -> FsResult<PathBuf> {
        if self.is_virtual_root(path) {
            return Ok(self.virtual_root());
        }
        let path = self.resolve_checked(path, Access::ReadOnly)?;
        let real = self.inner.realpath_sync(&path.as_checked_path())?;
        self.reverse_translate(&real)
    }

    async fn realpath_async(&self, path: CheckedPathBuf) -> FsResult<PathBuf> {
        if self.is_virtual_root(&path) {
            return Ok(self.virtual_root());
        }
        let path = self.resolve_checked(&path.as_checked_path(), Access::ReadOnly)?;
        let real = self.inner.realpath_async(path).await?;
        self.reverse_translate(&real)
    }

    fn read_dir_sync(&self, path: &CheckedPath) -> FsResult<Vec<FsDirEntry>> {
        if self.is_virtual_root(path) {
            return Ok(mount_entries().into());
        }
        let path = self.resolve_checked(path, Access::ReadOnly)?;
        self.inner.read_dir_sync(&path.as_checked_path())
    }

    async fn read_dir_async(&self, path: CheckedPathBuf) -> FsResult<FsReadDirRc> {
        if self.is_virtual_root(&path) {
            return Ok(deno_fs::sync::new_rc(MountReadDir {
                index: AtomicUsize::new(0),
            }));
        }
        let path = self.resolve_checked(&path.as_checked_path(), Access::ReadOnly)?;
        self.inner.read_dir_async(path).await
    }

    fn rename_sync(&self, oldpath: &CheckedPath, newpath: &CheckedPath) -> FsResult<()> {
        let oldpath = self.resolve_checked(oldpath, Access::ReadWrite)?;
        let newpath = self.resolve_checked(newpath, Access::ReadWrite)?;
        self.inner
            .rename_sync(&oldpath.as_checked_path(), &newpath.as_checked_path())
    }

    async fn rename_async(&self, oldpath: CheckedPathBuf, newpath: CheckedPathBuf) -> FsResult<()> {
        let oldpath = self.resolve_checked(&oldpath.as_checked_path(), Access::ReadWrite)?;
        let newpath = self.resolve_checked(&newpath.as_checked_path(), Access::ReadWrite)?;
        self.inner.rename_async(oldpath, newpath).await
    }

    forward_sync!(rmdir_sync, Access::ReadWrite, (), ());
    forward_async!(rmdir_async, Access::ReadWrite, (), ());

    fn link_sync(&self, oldpath: &CheckedPath, newpath: &CheckedPath) -> FsResult<()> {
        let oldpath = self.resolve_checked(oldpath, Access::ReadOnly)?;
        let newpath = self.resolve_checked(newpath, Access::ReadWrite)?;
        self.inner
            .link_sync(&oldpath.as_checked_path(), &newpath.as_checked_path())
    }

    async fn link_async(&self, oldpath: CheckedPathBuf, newpath: CheckedPathBuf) -> FsResult<()> {
        let oldpath = self.resolve_checked(&oldpath.as_checked_path(), Access::ReadOnly)?;
        let newpath = self.resolve_checked(&newpath.as_checked_path(), Access::ReadWrite)?;
        self.inner.link_async(oldpath, newpath).await
    }

    fn symlink_sync(
        &self,
        oldpath: &CheckedPath,
        newpath: &CheckedPath,
        file_type: Option<FsFileType>,
    ) -> FsResult<()> {
        let oldpath = self.resolve_checked(oldpath, Access::ReadOnly)?;
        let newpath = self.resolve_checked(newpath, Access::ReadWrite)?;
        self.inner.symlink_sync(
            &oldpath.as_checked_path(),
            &newpath.as_checked_path(),
            file_type,
        )
    }

    async fn symlink_async(
        &self,
        oldpath: CheckedPathBuf,
        newpath: CheckedPathBuf,
        file_type: Option<FsFileType>,
    ) -> FsResult<()> {
        let oldpath = self.resolve_checked(&oldpath.as_checked_path(), Access::ReadOnly)?;
        let newpath = self.resolve_checked(&newpath.as_checked_path(), Access::ReadWrite)?;
        self.inner.symlink_async(oldpath, newpath, file_type).await
    }

    fn read_link_sync(&self, path: &CheckedPath) -> FsResult<PathBuf> {
        let path = self.resolve_checked(path, Access::ReadOnly)?;
        let target = self.inner.read_link_sync(&path.as_checked_path())?;
        self.translate_link_result(&path, target)
    }

    async fn read_link_async(&self, path: CheckedPathBuf) -> FsResult<PathBuf> {
        let path = self.resolve_checked(&path.as_checked_path(), Access::ReadOnly)?;
        let target = self.inner.read_link_async(path.clone()).await?;
        self.translate_link_result(&path, target)
    }

    forward_sync!(truncate_sync, Access::ReadWrite, (len: u64), ());
    forward_async!(truncate_async, Access::ReadWrite, (len: u64), ());
    forward_sync!(
        utime_sync,
        Access::ReadWrite,
        (
            atime_secs: i64,
            atime_nanos: u32,
            mtime_secs: i64,
            mtime_nanos: u32
        ),
        ()
    );
    forward_async!(
        utime_async,
        Access::ReadWrite,
        (
            atime_secs: i64,
            atime_nanos: u32,
            mtime_secs: i64,
            mtime_nanos: u32
        ),
        ()
    );
    forward_sync!(
        lutime_sync,
        Access::ReadWrite,
        (
            atime_secs: i64,
            atime_nanos: u32,
            mtime_secs: i64,
            mtime_nanos: u32
        ),
        ()
    );
    forward_async!(
        lutime_async,
        Access::ReadWrite,
        (
            atime_secs: i64,
            atime_nanos: u32,
            mtime_secs: i64,
            mtime_nanos: u32
        ),
        ()
    );

    fn write_file_sync(
        &self,
        path: &CheckedPath,
        options: OpenOptions,
        data: &[u8],
    ) -> FsResult<()> {
        let path = self.resolve_checked(path, Access::ReadWrite)?;
        self.inner
            .write_file_sync(&path.as_checked_path(), options, data)?;
        self.bytes_written
            .fetch_add(data.len() as u64, Ordering::Relaxed);
        Ok(())
    }

    async fn write_file_async(
        &self,
        path: CheckedPathBuf,
        options: OpenOptions,
        data: Box<[u8]>,
    ) -> FsResult<()> {
        let path = self.resolve_checked(&path.as_checked_path(), Access::ReadWrite)?;
        let len = data.len() as u64;
        self.inner.write_file_async(path, options, data).await?;
        self.bytes_written.fetch_add(len, Ordering::Relaxed);
        Ok(())
    }

    fn read_file_sync(
        &self,
        path: &CheckedPath,
        options: OpenOptions,
    ) -> FsResult<Cow<'static, [u8]>> {
        let access = if open_options_write(&options) {
            Access::ReadWrite
        } else {
            Access::ReadOnly
        };
        let path = self.resolve_checked(path, access)?;
        self.inner.read_file_sync(&path.as_checked_path(), options)
    }

    async fn read_file_async(
        &self,
        path: CheckedPathBuf,
        options: OpenOptions,
    ) -> FsResult<Cow<'static, [u8]>> {
        let access = if open_options_write(&options) {
            Access::ReadWrite
        } else {
            Access::ReadOnly
        };
        let path = self.resolve_checked(&path.as_checked_path(), access)?;
        self.inner.read_file_async(path, options).await
    }

    fn exists_sync(&self, path: &CheckedPath) -> bool {
        if self.is_virtual_root(path) {
            return true;
        }
        self.resolve_checked(path, Access::ReadOnly)
            .is_ok_and(|path| self.inner.exists_sync(&path.as_checked_path()))
    }

    async fn exists_async(&self, path: CheckedPathBuf) -> FsResult<bool> {
        if self.is_virtual_root(&path) {
            return Ok(true);
        }
        let path = self.resolve_checked(&path.as_checked_path(), Access::ReadOnly)?;
        self.inner.exists_async(path).await
    }
}

fn open_options_write(options: &OpenOptions) -> bool {
    options.write || options.create || options.truncate || options.append || options.create_new
}

#[cfg(test)]
mod tests {
    use super::*;

    const HANDLE: u64 = 4242;

    struct TestVfs {
        _temp: tempfile::TempDir,
        vfs: PluginVfs,
        data_root: PathBuf,
    }

    fn test_vfs() -> TestVfs {
        let temp = tempfile::tempdir().unwrap();
        let data_root = temp.path().join("data/plugin.test");
        let cache_root = temp.path().join("cache/plugin.test");
        let tmp_root = temp.path().join("tmp/plugin.test");
        let vfs = PluginVfs::from_roots(HANDLE, data_root.clone(), cache_root, tmp_root);
        TestVfs {
            _temp: temp,
            vfs,
            data_root,
        }
    }

    fn checked(path: impl AsRef<Path>) -> CheckedPath<'static> {
        CheckedPath::unsafe_new(Cow::Owned(path.as_ref().to_path_buf()))
    }

    fn write_options() -> OpenOptions {
        OpenOptions::write(true, false, false, None)
    }

    #[test]
    fn umask_is_not_supported() {
        let test = test_vfs();
        for mask in [None, Some(0o077)] {
            assert!(matches!(test.vfs.umask(mask), Err(FsError::NotSupported)));
        }
    }

    #[test]
    fn root_and_handle_root_writes_are_denied() {
        let test = test_vfs();
        for path in [PathBuf::from("/"), test.vfs.virtual_root()] {
            let error = test
                .vfs
                .write_file_sync(&checked(path), write_options(), b"x")
                .unwrap_err();
            assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
        }
    }

    #[test]
    fn handle_root_read_dir_lists_mounts_without_creating_them() {
        let test = test_vfs();
        let entries = test
            .vfs
            .read_dir_sync(&checked(test.vfs.virtual_root()))
            .unwrap();
        assert_eq!(
            entries
                .iter()
                .map(|entry| entry.name.as_str())
                .collect::<Vec<_>>(),
            ["data", "cache", "tmp"]
        );
        assert!(!test.data_root.exists());
    }

    #[test]
    fn another_handle_is_denied() {
        let test = test_vfs();
        let error = test
            .vfs
            .read_file_sync(&checked("/4243/data/x"), OpenOptions::read())
            .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
    }

    #[test]
    fn lexical_parent_escape_is_denied() {
        let test = test_vfs();
        for path in [
            "/4242/..",
            "/4242/../../etc/passwd",
            "/4242/data/../../etc/passwd",
            "/4242/data/a/../../../etc/passwd",
        ] {
            let error = test
                .vfs
                .resolve(Path::new(path), Access::ReadOnly)
                .unwrap_err();
            assert_eq!(error.kind(), io::ErrorKind::PermissionDenied, "{path}");
        }
    }

    #[test]
    fn unknown_mount_is_not_found() {
        let test = test_vfs();
        let error = test
            .vfs
            .resolve(Path::new("/4242/unknown/x"), Access::ReadOnly)
            .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::NotFound);
    }

    #[cfg(unix)]
    #[test]
    fn symlink_escape_is_denied() {
        use std::os::unix::fs::symlink;

        let test = test_vfs();
        std::fs::create_dir_all(&test.data_root).unwrap();
        let outside = test._temp.path().join("outside.txt");
        std::fs::write(&outside, b"secret").unwrap();
        symlink(&outside, test.data_root.join("escape")).unwrap();

        let error = test
            .vfs
            .read_file_sync(&checked("/4242/data/escape"), OpenOptions::read())
            .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);

        let outside_dir = test._temp.path().join("outside-dir");
        std::fs::create_dir_all(&outside_dir).unwrap();
        symlink(&outside_dir, test.data_root.join("escape-dir")).unwrap();
        let error = test
            .vfs
            .resolve(Path::new("/4242/data/escape-dir/x"), Access::ReadOnly)
            .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
    }

    #[cfg(unix)]
    #[test]
    fn outbound_paths_are_virtualized() {
        use std::os::unix::fs::symlink;

        let test = test_vfs();
        std::fs::create_dir_all(&test.data_root).unwrap();
        std::fs::write(test.data_root.join("target.txt"), b"ok").unwrap();
        symlink(
            test.data_root.join("target.txt"),
            test.data_root.join("link.txt"),
        )
        .unwrap();

        let cwd = test.vfs.cwd().unwrap();
        let realpath = test
            .vfs
            .realpath_sync(&checked("/4242/data/target.txt"))
            .unwrap();
        let link = test
            .vfs
            .read_link_sync(&checked("/4242/data/link.txt"))
            .unwrap();

        assert_eq!(cwd, PathBuf::from("/4242"));
        assert_eq!(realpath, PathBuf::from("/4242/data/target.txt"));
        assert_eq!(link, PathBuf::from("/4242/data/target.txt"));
        assert_eq!(
            test.vfs.realpath_sync(&checked("/4242/data/..")).unwrap(),
            PathBuf::from("/4242")
        );
        for path in [&cwd, &realpath, &link] {
            assert!(!path.starts_with(test._temp.path()));
        }
    }

    #[test]
    fn counts_successful_direct_writes() {
        let test = test_vfs();
        test.vfs
            .write_file_sync(&checked("/4242/data/file"), write_options(), b"1234")
            .unwrap();
        assert_eq!(test.vfs.bytes_written(), 4);
    }

    #[test]
    fn open_std_denies_lexical_escape() {
        let test = test_vfs();
        let error = test
            .vfs
            .open_std(
                Path::new("/4242/data/../../outside.txt"),
                OpenOptions::read(),
            )
            .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
    }

    #[test]
    fn open_std_denies_writing_handle_root() {
        let test = test_vfs();
        let error = test
            .vfs
            .open_std(&test.vfs.virtual_root(), write_options())
            .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
    }

    #[test]
    fn open_std_opens_normal_virtual_path() {
        use std::io::{Read, Write};

        let test = test_vfs();
        let path = Path::new("/4242/data/file.txt");
        let mut file = test
            .vfs
            .open_std(path, OpenOptions::write(true, false, false, None))
            .unwrap();
        file.write_all(b"ok").unwrap();
        drop(file);

        let mut file = test.vfs.open_std(path, OpenOptions::read()).unwrap();
        let mut contents = String::new();
        file.read_to_string(&mut contents).unwrap();
        assert_eq!(contents, "ok");
    }

    #[test]
    fn snapshot_placeholder_denies_all_paths() {
        let vfs = PluginVfs::snapshot_placeholder();
        assert_eq!(vfs.cwd().unwrap_err().kind(), io::ErrorKind::PermissionDenied);
        assert_eq!(
            vfs.tmp_dir().unwrap_err().kind(),
            io::ErrorKind::PermissionDenied
        );
        let error = vfs
            .resolve(Path::new("/0/data/file"), Access::ReadOnly)
            .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
        assert!(!vfs.exists_sync(&checked("/0/data/file")));
    }
}
