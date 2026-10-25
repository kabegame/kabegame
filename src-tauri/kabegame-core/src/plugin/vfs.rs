use std::borrow::Cow;
use std::collections::HashSet;
use std::ffi::OsString;
use std::io;
#[cfg(target_os = "android")]
use std::os::fd::OwnedFd;
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

/// 一次任务冻结时解析出的路径类变量挂载。
#[derive(Debug)]
pub struct InputMount {
    /// 插件变量 key，对应虚拟路径 `/{handle}/input/<key>`
    pub key: String,
    pub kind: InputKind,
    /// Android `content://` 打开的 fd，随 VFS 一起存活到任务结束。
    #[cfg(target_os = "android")]
    pub owned_fd: Option<OwnedFd>,
}

#[derive(Debug)]
pub enum InputKind {
    /// 文件变量：合成目录 `input/<key>` 下只有这一个文件名。
    File { host: PathBuf, name: String },
    /// 文件夹变量：整棵子树只读可见。
    Dir { host: PathBuf },
}

#[derive(Debug)]
pub struct PluginVfs {
    handle: u64,
    data_root: PathBuf,
    cache_root: PathBuf,
    tmp_root: PathBuf,
    inputs: Vec<InputMount>,
    inner: RealFs,
    bytes_written: AtomicU64,
}

#[derive(Debug)]
struct MountReadDir {
    entries: Vec<FsDirEntry>,
    index: AtomicUsize,
}

#[async_trait::async_trait(?Send)]
impl FsReadDir for MountReadDir {
    async fn next(&self) -> FsResult<Option<FsDirEntry>> {
        let index = self.index.fetch_add(1, Ordering::Relaxed);
        Ok(self.entries.get(index).cloned())
    }
}

fn dir_entry(name: impl Into<String>) -> FsDirEntry {
    FsDirEntry {
        name: name.into(),
        is_file: false,
        is_directory: true,
        is_symlink: false,
    }
}

fn file_entry(name: impl Into<String>) -> FsDirEntry {
    FsDirEntry {
        name: name.into(),
        is_file: true,
        is_directory: false,
        is_symlink: false,
    }
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

    /// 创建由宿主管理生命周期的会话 VFS。
    pub fn new_session(handle: u64, session_root: &Path) -> Self {
        Self::from_roots(
            handle,
            session_root.join("data"),
            session_root.join("cache"),
            session_root.join("tmp"),
        )
    }

    fn from_roots(handle: u64, data_root: PathBuf, cache_root: PathBuf, tmp_root: PathBuf) -> Self {
        Self {
            handle,
            data_root,
            cache_root,
            tmp_root,
            inputs: Vec::new(),
            inner: RealFs,
            bytes_written: AtomicU64::new(0),
        }
    }

    /// 挂载本次任务的路径类变量为只读 `input` 挂载点。
    pub fn with_inputs(mut self, inputs: Vec<InputMount>) -> Self {
        self.inputs = inputs;
        self
    }

    /// 已挂载的输入变量 key，供任务构造时把 `config` 改写成虚拟路径。
    pub fn input_keys(&self) -> Vec<&str> {
        self.inputs.iter().map(|mount| mount.key.as_str()).collect()
    }

    /// 某个输入变量在脚本侧应使用的虚拟路径；未挂载时为 `None`。
    pub fn input_virtual_path(&self, key: &str) -> Option<PathBuf> {
        self.inputs
            .iter()
            .find(|mount| mount.key == key)
            .map(|mount| self.input_virtual_path_of(mount))
    }

    /// 虚拟路径统一用 `/` 分隔：它会作为字符串交给 JS，也会被 `task-vfs://` URL 解析。
    fn input_base_path(&self, key: &str) -> String {
        format!("/{}/input/{key}", self.handle)
    }

    fn input_virtual_path_of(&self, mount: &InputMount) -> PathBuf {
        let base = self.input_base_path(&mount.key);
        match &mount.kind {
            InputKind::File { name, .. } => PathBuf::from(format!("{base}/{name}")),
            InputKind::Dir { .. } => PathBuf::from(base),
        }
    }

    pub fn bytes_written(&self) -> u64 {
        self.bytes_written.load(Ordering::Relaxed)
    }

    /// 将只读虚拟路径解析为宿主路径，仅供 FFmpeg 等宿主内建工具消费。
    ///
    /// 返回的真实路径不得回传给插件 JavaScript。
    pub fn host_path_for_read(&self, virtual_path: &Path) -> FsResult<PathBuf> {
        self.resolve(virtual_path, Access::ReadOnly)
    }

    /// 将可写虚拟路径解析为宿主路径，仅供 FFmpeg 等宿主内建工具消费。
    ///
    /// 返回的真实路径不得回传给插件 JavaScript。
    pub fn host_path_for_write(&self, virtual_path: &Path) -> FsResult<PathBuf> {
        self.resolve(virtual_path, Access::ReadWrite)
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

    /// 词法规范化虚拟路径：校验绝对路径 / handle，并折叠 `.` 与 `..`。
    ///
    /// `..` 只允许在 `/{handle}` 内折叠；尝试越过该会话根会立即失败。
    /// 返回路径中 `/{handle}` 之后的部分。
    fn normalize_virtual(&self, virtual_path: &Path) -> FsResult<Vec<OsString>> {
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
        Ok(normalized)
    }

    /// 校验虚拟路径并翻译为插件私有的宿主路径。
    fn resolve(&self, virtual_path: &Path, need: Access) -> FsResult<PathBuf> {
        let normalized = self.normalize_virtual(virtual_path)?;

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
        if mount == "input" {
            return self.resolve_input(&normalized[1..], need);
        }
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

    /// `input` 挂载只读：文件变量仅暴露 `input/<key>/<name>`，文件夹变量暴露整棵子树。
    fn resolve_input(&self, rest: &[OsString], need: Access) -> FsResult<PathBuf> {
        if self.inputs.is_empty() {
            return Err(not_found("插件 VFS 挂载点不存在"));
        }
        if need == Access::ReadWrite {
            return Err(permission_denied("插件 VFS 输入挂载为只读"));
        }

        let Some(key) = rest.first().and_then(|segment| segment.to_str()) else {
            // `/{handle}/input` 是合成目录，与会话根一样不用于真实列目录。
            return Ok(self.data_root.clone());
        };
        let mount = self
            .inputs
            .iter()
            .find(|mount| mount.key == key)
            .ok_or_else(|| not_found("插件 VFS 输入挂载不存在"))?;

        match &mount.kind {
            InputKind::File { host, name } => match rest {
                // `input/<key>` 是合成目录：stat 用宿主文件的父目录，内容由
                // `synthetic_dir_entries` 提供，不会泄漏同目录其它文件。
                [_] => host
                    .parent()
                    .map(Path::to_path_buf)
                    .ok_or_else(|| not_found("插件 VFS 输入文件路径无效")),
                // 文件变量只暴露这一个路径，多余层级一律 not found，不能忽略尾段读源文件。
                [_, only] if only.to_str() == Some(name.as_str()) => Ok(host.clone()),
                _ => Err(not_found("插件 VFS 输入文件不存在")),
            },
            InputKind::Dir { host } => {
                self.check_input_symlinks(host, &rest[1..].iter().collect::<PathBuf>())?;
                let mut real_path = host.clone();
                real_path.extend(rest.iter().skip(1));
                Ok(real_path)
            }
        }
    }

    /// 输入子树里任何一层软链接都拒绝：用户授权的是冻结时的真实目录，软链接可以逃出去。
    fn check_input_symlinks(&self, root: &Path, relative: &Path) -> FsResult<()> {
        let mut current = root.to_path_buf();
        for component in relative.components() {
            match component {
                Component::CurDir => continue,
                Component::Normal(segment) => current.push(segment),
                Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                    return Err(permission_denied("插件 VFS 输入路径包含非法路径段"));
                }
            }
            match std::fs::symlink_metadata(&current) {
                Ok(metadata) if metadata.file_type().is_symlink() => {
                    return Err(permission_denied("插件 VFS 输入挂载拒绝软链接"));
                }
                Ok(_) => {}
                // 不存在的尾段交给上层 API 报 NotFound；此前存在的层已确认不是软链接。
                Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
                Err(error) => return Err(error.into()),
            }
        }
        Ok(())
    }

    fn resolve_checked(&self, path: &CheckedPath, need: Access) -> FsResult<CheckedPathBuf> {
        self.resolve(path, need).map(CheckedPathBuf::unsafe_new)
    }

    /// 合成目录（会话根 / `input` 根 / 文件变量的 `input/<key>`）的条目；不是合成目录时返回 `None`。
    fn synthetic_dir_entries(&self, virtual_path: &Path) -> Option<Vec<FsDirEntry>> {
        let normalized = self.normalize_virtual(virtual_path).ok()?;
        match normalized.as_slice() {
            [] => {
                let mut entries = vec![dir_entry("data"), dir_entry("cache"), dir_entry("tmp")];
                if !self.inputs.is_empty() {
                    entries.push(dir_entry("input"));
                }
                Some(entries)
            }
            [mount] if mount.to_str() == Some("input") && !self.inputs.is_empty() => Some(
                self.inputs
                    .iter()
                    .map(|mount| dir_entry(mount.key.as_str()))
                    .collect(),
            ),
            [mount, key] if mount.to_str() == Some("input") => {
                let found = self
                    .inputs
                    .iter()
                    .find(|found| key.to_str() == Some(found.key.as_str()))?;
                match &found.kind {
                    InputKind::File { name, .. } => Some(vec![file_entry(name.as_str())]),
                    // 文件夹挂载是真实目录，交给内核列目录。
                    InputKind::Dir { .. } => None,
                }
            }
            _ => None,
        }
    }

    /// 合成目录的规范虚拟路径（`/` 分隔，供 `realpath` 回传给脚本）。
    fn synthetic_virtual_path(&self, virtual_path: &Path) -> Option<PathBuf> {
        self.synthetic_dir_entries(virtual_path)?;
        let normalized = self.normalize_virtual(virtual_path).ok()?;
        let mut text = format!("/{}", self.handle);
        for segment in &normalized {
            text.push('/');
            text.push_str(&segment.to_string_lossy());
        }
        Some(PathBuf::from(text))
    }

    /// 宿主路径是否落在某个输入挂载内。
    fn is_input_real_path(&self, real_path: &Path) -> bool {
        self.inputs.iter().any(|mount| match &mount.kind {
            InputKind::File { host, .. } => host == real_path,
            InputKind::Dir { host } => real_path.starts_with(host),
        })
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
        for mount in &self.inputs {
            match &mount.kind {
                InputKind::File { host, name } => {
                    if host == real_path {
                        return Ok(PathBuf::from(format!(
                            "{}/{name}",
                            self.input_base_path(&mount.key)
                        )));
                    }
                    // Android 的 `/proc/self/fd/N` 会被 realpath 解析成真实文件路径。
                    if std::fs::canonicalize(host).is_ok_and(|canonical| canonical == real_path) {
                        return Ok(PathBuf::from(format!(
                            "{}/{name}",
                            self.input_base_path(&mount.key)
                        )));
                    }
                }
                InputKind::Dir { host } => {
                    let base = self.input_base_path(&mount.key);
                    if let Ok(relative) = real_path.strip_prefix(host) {
                        return Ok(PathBuf::from(base).join(relative));
                    }
                    if let Ok(canonical_host) = std::fs::canonicalize(host) {
                        if let Ok(relative) = real_path.strip_prefix(canonical_host) {
                            return Ok(PathBuf::from(base).join(relative));
                        }
                    }
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
        Ok(self.virtual_root())
    }

    fn tmp_dir(&self) -> FsResult<PathBuf> {
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
        if let Some(virtual_path) = self.synthetic_virtual_path(path) {
            return Ok(virtual_path);
        }
        let path = self.resolve_checked(path, Access::ReadOnly)?;
        let real = self.inner.realpath_sync(&path.as_checked_path())?;
        self.reverse_translate(&real)
    }

    async fn realpath_async(&self, path: CheckedPathBuf) -> FsResult<PathBuf> {
        if let Some(virtual_path) = self.synthetic_virtual_path(&path) {
            return Ok(virtual_path);
        }
        let path = self.resolve_checked(&path.as_checked_path(), Access::ReadOnly)?;
        let real = self.inner.realpath_async(path).await?;
        self.reverse_translate(&real)
    }

    fn read_dir_sync(&self, path: &CheckedPath) -> FsResult<Vec<FsDirEntry>> {
        if let Some(entries) = self.synthetic_dir_entries(path) {
            return Ok(entries);
        }
        let path = self.resolve_checked(path, Access::ReadOnly)?;
        self.inner.read_dir_sync(&path.as_checked_path())
    }

    async fn read_dir_async(&self, path: CheckedPathBuf) -> FsResult<FsReadDirRc> {
        if let Some(entries) = self.synthetic_dir_entries(&path) {
            return Ok(deno_fs::sync::new_rc(MountReadDir {
                entries,
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
        if self.is_input_real_path(&oldpath) {
            // 硬链接会与用户文件共享 inode，绕开 input 的只读约束。
            return Err(permission_denied("插件 VFS 不允许为输入挂载创建硬链接"));
        }
        let newpath = self.resolve_checked(newpath, Access::ReadWrite)?;
        self.inner
            .link_sync(&oldpath.as_checked_path(), &newpath.as_checked_path())
    }

    async fn link_async(&self, oldpath: CheckedPathBuf, newpath: CheckedPathBuf) -> FsResult<()> {
        let oldpath = self.resolve_checked(&oldpath.as_checked_path(), Access::ReadOnly)?;
        if self.is_input_real_path(&oldpath) {
            return Err(permission_denied("插件 VFS 不允许为输入挂载创建硬链接"));
        }
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
        if self.synthetic_dir_entries(path).is_some() {
            return true;
        }
        self.resolve_checked(path, Access::ReadOnly)
            .is_ok_and(|path| self.inner.exists_sync(&path.as_checked_path()))
    }

    async fn exists_async(&self, path: CheckedPathBuf) -> FsResult<bool> {
        if self.synthetic_dir_entries(&path).is_some() {
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
        let data_root = temp.path().join("data/plugin-test");
        let cache_root = temp.path().join("cache/plugin-test");
        let tmp_root = temp.path().join("tmp/plugin-test");
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
    fn session_vfs_maps_all_mounts_under_one_root() {
        let temp = tempfile::tempdir().unwrap();
        let vfs = PluginVfs::new_session(HANDLE, temp.path());

        assert_eq!(
            vfs.host_path_for_read(Path::new("/4242/data/input.mp4"))
                .unwrap(),
            temp.path().join("data/input.mp4")
        );
        assert_eq!(
            vfs.host_path_for_write(Path::new("/4242/tmp/output.mp4"))
                .unwrap(),
            temp.path().join("tmp/output.mp4")
        );
        assert!(temp.path().join("tmp").is_dir());
    }

    #[test]
    fn host_path_helpers_preserve_vfs_escape_checks() {
        let test = test_vfs();
        let error = test
            .vfs
            .host_path_for_read(Path::new("/4242/data/../../outside.mp4"))
            .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
    }

    fn file_mount(key: &str, host: PathBuf, name: &str) -> InputMount {
        InputMount {
            key: key.to_string(),
            kind: InputKind::File {
                host,
                name: name.to_string(),
            },
            #[cfg(target_os = "android")]
            owned_fd: None,
        }
    }

    fn dir_mount(key: &str, host: PathBuf) -> InputMount {
        InputMount {
            key: key.to_string(),
            kind: InputKind::Dir { host },
            #[cfg(target_os = "android")]
            owned_fd: None,
        }
    }

    fn test_vfs_with(temp: &tempfile::TempDir, inputs: Vec<InputMount>) -> PluginVfs {
        PluginVfs::from_roots(
            HANDLE,
            temp.path().join("data/plugin-test"),
            temp.path().join("cache/plugin-test"),
            temp.path().join("tmp/plugin-test"),
        )
        .with_inputs(inputs)
    }

    fn names(entries: &[FsDirEntry]) -> Vec<&str> {
        entries.iter().map(|entry| entry.name.as_str()).collect()
    }

    #[test]
    fn input_file_mount_exposes_one_read_only_file() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        std::fs::create_dir_all(&source).unwrap();
        let picked = source.join("picked.png");
        std::fs::write(&picked, b"png-bytes").unwrap();
        std::fs::write(source.join("sibling.png"), b"hidden").unwrap();
        let vfs = test_vfs_with(&temp, vec![file_mount("src", picked.clone(), "picked.png")]);

        assert_eq!(
            names(&vfs.read_dir_sync(&checked("/4242")).unwrap()),
            ["data", "cache", "tmp", "input"]
        );
        assert_eq!(
            names(&vfs.read_dir_sync(&checked("/4242/input")).unwrap()),
            ["src"]
        );
        // 文件变量的合成目录里只有选中的那一个文件。
        assert_eq!(
            names(&vfs.read_dir_sync(&checked("/4242/input/src")).unwrap()),
            ["picked.png"]
        );

        let contents = vfs
            .read_file_sync(&checked("/4242/input/src/picked.png"), OpenOptions::read())
            .unwrap();
        assert_eq!(&*contents, b"png-bytes");
        // 同目录的其它文件不可见。
        let error = vfs
            .read_file_sync(&checked("/4242/input/src/sibling.png"), OpenOptions::read())
            .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::NotFound);
        // 文件变量只有 `input/<key>/<name>` 两层，多余尾段不能被忽略。
        let error = vfs
            .read_file_sync(
                &checked("/4242/input/src/picked.png/extra"),
                OpenOptions::read(),
            )
            .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::NotFound);

        assert_eq!(
            vfs.realpath_sync(&checked("/4242/input/src/picked.png"))
                .unwrap(),
            PathBuf::from("/4242/input/src/picked.png")
        );
        assert_eq!(
            vfs.realpath_sync(&checked("/4242/input")).unwrap(),
            PathBuf::from("/4242/input")
        );
        assert!(vfs.exists_sync(&checked("/4242/input/src")));
        // 文件变量的 `input/<key>` 是合成目录，stat 用宿主文件父目录。
        assert!(
            vfs.stat_sync(&checked("/4242/input/src"))
                .unwrap()
                .is_directory
        );
        assert_eq!(
            vfs.input_virtual_path("src").unwrap(),
            PathBuf::from("/4242/input/src/picked.png")
        );
        assert!(vfs.input_virtual_path("unknown").is_none());
        assert_eq!(vfs.input_keys(), ["src"]);
    }

    #[test]
    fn input_mounts_reject_every_write_and_allow_copy_out() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        std::fs::create_dir_all(&source).unwrap();
        let picked = source.join("picked.png");
        std::fs::write(&picked, b"png-bytes").unwrap();
        let vfs = test_vfs_with(&temp, vec![file_mount("src", picked.clone(), "picked.png")]);

        let virtual_file = checked("/4242/input/src/picked.png");
        assert_eq!(
            vfs.write_file_sync(&virtual_file, write_options(), b"x")
                .unwrap_err()
                .kind(),
            io::ErrorKind::PermissionDenied
        );
        assert_eq!(
            vfs.mkdir_sync(&checked("/4242/input/new-dir"), false, None)
                .unwrap_err()
                .kind(),
            io::ErrorKind::PermissionDenied
        );
        assert_eq!(
            vfs.remove_sync(&virtual_file, false).unwrap_err().kind(),
            io::ErrorKind::PermissionDenied
        );
        assert_eq!(
            vfs.rename_sync(&virtual_file, &checked("/4242/tmp/picked.png"))
                .unwrap_err()
                .kind(),
            io::ErrorKind::PermissionDenied
        );
        // 读取源之后复制到 tmp 是允许的（插件可以拿输入文件的副本继续处理）。
        vfs.copy_file_sync(&virtual_file, &checked("/4242/tmp/copy.png"))
            .unwrap();
        assert_eq!(
            std::fs::read(
                vfs.host_path_for_read(Path::new("/4242/tmp/copy.png"))
                    .unwrap()
            )
            .unwrap(),
            b"png-bytes"
        );
        // 硬链接会与用户文件共享 inode，必须拒绝，否则可以借 tmp 改写只读输入。
        assert_eq!(
            vfs.link_sync(&virtual_file, &checked("/4242/tmp/link.png"))
                .unwrap_err()
                .kind(),
            io::ErrorKind::PermissionDenied
        );
        // 用户源文件没有被改动。
        assert_eq!(std::fs::read(&picked).unwrap(), b"png-bytes");
    }

    #[test]
    fn input_dir_mount_exposes_subtree_read_only() {
        let temp = tempfile::tempdir().unwrap();
        let folder = temp.path().join("folder");
        std::fs::create_dir_all(folder.join("nested")).unwrap();
        std::fs::write(folder.join("nested/a.txt"), b"a").unwrap();
        let vfs = test_vfs_with(&temp, vec![dir_mount("dir", folder.clone())]);

        assert_eq!(
            names(&vfs.read_dir_sync(&checked("/4242/input/dir")).unwrap()),
            ["nested"]
        );
        let contents = vfs
            .read_file_sync(
                &checked("/4242/input/dir/nested/a.txt"),
                OpenOptions::read(),
            )
            .unwrap();
        assert_eq!(&*contents, b"a");
        assert_eq!(
            vfs.realpath_sync(&checked("/4242/input/dir/nested/a.txt"))
                .unwrap(),
            PathBuf::from("/4242/input/dir/nested/a.txt")
        );
        assert_eq!(
            vfs.input_virtual_path("dir").unwrap(),
            PathBuf::from("/4242/input/dir")
        );
        assert_eq!(
            vfs.write_file_sync(
                &checked("/4242/input/dir/nested/a.txt"),
                write_options(),
                b"x"
            )
            .unwrap_err()
            .kind(),
            io::ErrorKind::PermissionDenied
        );
        // `..` 只能在会话根内折叠，越过会话根立即失败。
        assert_eq!(
            vfs.resolve(
                Path::new("/4242/input/dir/../../../etc/passwd"),
                Access::ReadOnly
            )
            .unwrap_err()
            .kind(),
            io::ErrorKind::PermissionDenied
        );
    }

    #[cfg(unix)]
    #[test]
    fn input_dir_mount_rejects_symlinks_inside_subtree() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().unwrap();
        let folder = temp.path().join("folder");
        std::fs::create_dir_all(folder.join("nested")).unwrap();
        let outside = temp.path().join("outside.txt");
        std::fs::write(&outside, b"secret").unwrap();
        symlink(&outside, folder.join("escape.txt")).unwrap();
        symlink(&outside, folder.join("nested/inner-escape.txt")).unwrap();
        let vfs = test_vfs_with(&temp, vec![dir_mount("dir", folder)]);

        for path in [
            "/4242/input/dir/escape.txt",
            "/4242/input/dir/nested/inner-escape.txt",
        ] {
            assert_eq!(
                vfs.read_file_sync(&checked(path), OpenOptions::read())
                    .unwrap_err()
                    .kind(),
                io::ErrorKind::PermissionDenied,
                "{path}"
            );
            assert_eq!(
                vfs.realpath_sync(&checked(path)).unwrap_err().kind(),
                io::ErrorKind::PermissionDenied,
                "{path}"
            );
        }
    }

    #[test]
    fn input_mounts_are_absent_without_inputs() {
        let test = test_vfs();
        assert!(test.vfs.input_keys().is_empty());
        assert_eq!(
            test.vfs
                .resolve(Path::new("/4242/input/x"), Access::ReadOnly)
                .unwrap_err()
                .kind(),
            io::ErrorKind::NotFound
        );
        assert_eq!(
            test.vfs
                .read_dir_sync(&checked("/4242/input"))
                .unwrap_err()
                .kind(),
            io::ErrorKind::NotFound
        );
        assert_eq!(
            names(
                &test
                    .vfs
                    .read_dir_sync(&checked(test.vfs.virtual_root()))
                    .unwrap()
            ),
            ["data", "cache", "tmp"]
        );
    }
}
