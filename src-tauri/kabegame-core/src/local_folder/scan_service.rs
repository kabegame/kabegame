//! 通用「文件夹扫描服务」：可配置是否递归，遍历 `file://` / `content://` 目录树。
//!
//! 服务只负责「发现」和框架级健康过滤：扫到健康的媒体文件回调
//! [`FolderScanHook::on_file`]，进入/离开健康子目录回调 [`FolderScanHook::on_enter_dir`] /
//! [`FolderScanHook::on_exit_dir`]。具体用途（导入 / 发事件 / 建子画册 / 收集）由钩子决定。
//!
//! 设计要点：
//! - 泛型单态化（非 dyn）以支持钩子的关联类型 `DirCtx`（目录上下文，DFS 中由父向子传递）。
//! - 来源抽象：`file://` 走文件系统，`content://`（Android）走 `ContentIoProvider`。
//! - 框架统一处理媒体过滤、收集节流、递归深度、进度份额、symlink 和基础 IO 健康过滤。
//! - [`ScanCtx`] 在一次扫描中贯穿始终，记录当前目录栈和带位置的非致命错误。
//! - 根目录不触发 `on_enter_dir`/`on_exit_dir`；根上下文由调用方提供并自行收尾。

use crate::image_type::is_media_by_path;
use std::path::PathBuf;
use std::time::{Duration, Instant, UNIX_EPOCH};
use url::Url;

#[cfg(target_os = "android")]
use crate::crawler::content_io::get_content_io_provider;

/// 递归深度上限（与历史 `create.rs` 的 MAX_DEPTH 一致）。
pub const DEFAULT_MAX_DEPTH: usize = 16;

/// 扫描发现的一个媒体文件。
#[derive(Debug, Clone)]
pub struct ScannedFile {
    pub url: Url,
    /// `file://` 时为本地路径；`content://` 时为 None。
    pub path: Option<PathBuf>,
    pub name: String,
    pub size: Option<u64>,
    pub mtime_unix_ms: Option<u128>,
    pub depth: usize,
}

/// 扫描进入的一个子目录。
#[derive(Debug, Clone)]
pub struct ScannedDir {
    pub url: Url,
    pub path: Option<PathBuf>,
    pub name: String,
    pub depth: usize,
}

/// 扫描选项。
#[derive(Debug, Clone)]
pub struct ScanOptions {
    /// 是否递归进入子目录。
    pub recursive: bool,
    /// 收集节流：相邻两次 `on_file` 之间的最小间隔（毫秒）。命中媒体文件交给 hook 前，
    /// 若距上次 `on_file` 不足该值则 sleep 补足，避免逐文件入库把系统压垮。
    /// `None`（或 `0`）= 全速无节流；建议消费者传 ≥100ms（同步用 300，本地导入用 100）。
    pub min_collect_interval_ms: Option<u64>,
    /// 跳过以 `.` 开头的隐藏目录（同步建子画册时为 true）。
    pub skip_hidden_dirs: bool,
    /// 进度总份额（一般 100.0）。份额按目录子项数逐层均分。
    pub total_progress_share: f64,
    /// 递归深度上限。
    pub max_depth: usize,
}

impl Default for ScanOptions {
    fn default() -> Self {
        Self {
            recursive: false,
            min_collect_interval_ms: None,
            skip_hidden_dirs: false,
            total_progress_share: 100.0,
            max_depth: DEFAULT_MAX_DEPTH,
        }
    }
}

/// Hook 返回的扫描错误，以及上下文中记录的错误本体。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ScanError {
    /// 中止整次扫描，向 `scan_and_visit` 调用方返回 `Err(String)`。
    Fatal(String),
    /// 停止当前目录的后续条目，父目录继续。
    Interrupt(String),
    /// 跳过当前条目，继续扫描。
    Skip(String),
}

impl ScanError {
    pub fn message(&self) -> &str {
        match self {
            Self::Fatal(message) | Self::Interrupt(message) | Self::Skip(message) => message,
        }
    }

    fn into_message(self) -> String {
        match self {
            Self::Fatal(message) | Self::Interrupt(message) | Self::Skip(message) => message,
        }
    }
}

/// 带目录位置的非致命扫描错误。
#[derive(Debug, Clone)]
pub struct ScanIssue {
    /// 错误本体。框架只记录 `Skip` / `Interrupt`；`Fatal` 会直接返回。
    pub error: ScanError,
    /// 错误归属的目录，用于按 album / 子树判断是否可以 finalize。
    pub dir: Url,
    /// 精确条目位置（文件或子目录）可用时记录。
    pub entry: Option<Url>,
}

/// 一次完整扫描的上下文：当前递归栈 + 已记录的非致命错误。
#[derive(Debug, Clone)]
pub struct ScanCtx<C> {
    stack: Vec<(ScannedDir, C)>,
    issues: Vec<ScanIssue>,
}

impl<C> ScanCtx<C> {
    fn new() -> Self {
        Self {
            stack: Vec::new(),
            issues: Vec::new(),
        }
    }

    fn push(&mut self, dir: ScannedDir, payload: C) {
        self.stack.push((dir, payload));
    }

    fn pop(&mut self) {
        self.stack.pop();
    }

    pub fn take_issues(&mut self) -> Vec<ScanIssue> {
        std::mem::take(&mut self.issues)
    }

    /// 当前所在目录。
    pub fn current_dir(&self) -> &ScannedDir {
        &self.stack.last().expect("scan stack").0
    }

    /// 当前目录的 hook 载荷。
    pub fn ctx(&self) -> &C {
        &self.stack.last().expect("scan stack").1
    }

    pub fn depth(&self) -> usize {
        self.stack.len()
    }

    /// 完整祖先链：root -> current。
    pub fn frames(&self) -> &[(ScannedDir, C)] {
        &self.stack
    }

    /// 已记录的所有非致命错误。
    pub fn issues(&self) -> &[ScanIssue] {
        &self.issues
    }

    /// 指定目录是否有直接归属的错误（不包含子目录错误）。
    pub fn dir_had_errors(&self, dir: &Url) -> bool {
        self.issues.iter().any(|issue| &issue.dir == dir)
    }

    /// 当前目录是否有直接归属的错误（不包含子目录错误）。
    pub fn current_had_errors(&self) -> bool {
        self.dir_had_errors(&self.current_dir().url)
    }

    fn record_here(&mut self, entry: Option<Url>, error: ScanError) {
        let dir = self.current_dir().url.clone();
        self.record_at(dir, entry, error);
    }

    /// 记录到指定目录；用于子目录进入失败，避免污染父目录。
    fn record_at(&mut self, dir: Url, entry: Option<Url>, error: ScanError) {
        debug_assert!(!matches!(error, ScanError::Fatal(_)));
        self.issues.push(ScanIssue { error, dir, entry });
    }
}

/// 扫描钩子：遍历期对每个媒体文件 / 子目录回调，由消费者决定用途。
#[async_trait::async_trait]
pub trait FolderScanHook: Send + Sync {
    /// 目录上下文：DFS 中由父向子传递（如：同步用「所属画册 id+名」）。
    type DirCtx: Clone + Send + Sync;

    /// 进入一个健康的**子**目录时调用，`ctx` 当前帧为父目录。
    /// 返回该目录的上下文（传给其子文件/子目录），或 `None` 表示**跳过整棵子树**。
    async fn on_enter_dir(
        &mut self,
        enter: &ScannedDir,
        ctx: &ScanCtx<Self::DirCtx>,
    ) -> Result<Option<Self::DirCtx>, ScanError>;

    /// 离开当前目录时调用（DFS 出栈前），用于收尾。默认 no-op。
    async fn on_exit_dir(&mut self, _ctx: &ScanCtx<Self::DirCtx>) -> Result<(), ScanError> {
        Ok(())
    }

    /// 发现一个健康、稳定的媒体文件时调用，`ctx` 当前帧为其所在目录。
    async fn on_file(
        &mut self,
        file: &ScannedFile,
        ctx: &ScanCtx<Self::DirCtx>,
    ) -> Result<(), ScanError>;

    /// 进度上报（份额增量）。
    fn on_progress(&mut self, _delta: f64) {}
}

/// 列目录得到的原始子项。
struct RawEntry {
    url: Url,
    name: String,
    is_dir: bool,
    is_symlink: bool,
}

/// 收集节流：相邻两次 `on_file` 之间至少间隔 `interval_ms`，不足则 sleep 补足。
/// `None`/`0` 表示全速无节流。`last` 跨整次扫描贯穿（DFS 全局）。
async fn throttle_collect(last: &mut Option<Instant>, interval_ms: Option<u64>) {
    let Some(ms) = interval_ms.filter(|ms| *ms > 0) else {
        return;
    };
    let interval = Duration::from_millis(ms);
    if let Some(prev) = *last {
        let elapsed = prev.elapsed();
        if elapsed < interval {
            tokio::time::sleep(interval - elapsed).await;
        }
    }
    *last = Some(Instant::now());
}

fn url_file_name(url: &Url) -> String {
    url.to_file_path()
        .ok()
        .and_then(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()))
        .or_else(|| {
            url.path_segments()
                .and_then(|mut s| s.next_back())
                .map(|s| s.to_string())
        })
        .unwrap_or_default()
}

async fn url_is_dir(url: &Url) -> Result<bool, String> {
    match url.scheme() {
        "file" => {
            let path = url
                .to_file_path()
                .map_err(|_| format!("invalid file URL: {url}"))?;
            Ok(std::fs::metadata(&path)
                .map_err(|e| e.to_string())?
                .is_dir())
        }
        "content" => {
            #[cfg(target_os = "android")]
            {
                get_content_io_provider().is_directory(url.as_str()).await
            }
            #[cfg(not(target_os = "android"))]
            {
                Err("content:// scan is only supported on Android".to_string())
            }
        }
        scheme => Err(format!("unsupported scheme for scan: {scheme}")),
    }
}

/// 列出目录直接子项（不分媒体/稳定性，统一由 walk 阶段分类）。
async fn read_dir_entries(dir_url: &Url, skip_hidden_dirs: bool) -> Result<Vec<RawEntry>, String> {
    match dir_url.scheme() {
        "file" => {
            let dir_path = dir_url
                .to_file_path()
                .map_err(|_| format!("invalid file URL: {dir_url}"))?;
            let read = std::fs::read_dir(&dir_path).map_err(|e| e.to_string())?;
            let mut out = Vec::new();
            for ent in read.flatten() {
                let ft = match ent.file_type() {
                    Ok(ft) => ft,
                    Err(_) => continue,
                };
                let name = ent.file_name().to_string_lossy().into_owned();
                let is_symlink = ft.is_symlink();
                let is_dir = if is_symlink {
                    std::fs::metadata(ent.path())
                        .map(|metadata| metadata.is_dir())
                        .unwrap_or(false)
                } else {
                    ft.is_dir()
                };
                if is_dir && skip_hidden_dirs && name.starts_with('.') {
                    continue;
                }
                let path = ent.path();
                let Ok(url) = Url::from_file_path(&path) else {
                    continue;
                };
                out.push(RawEntry {
                    url,
                    name,
                    is_dir,
                    is_symlink,
                });
            }
            Ok(out)
        }
        "content" => {
            #[cfg(target_os = "android")]
            {
                let children = get_content_io_provider()
                    .list_children(dir_url.as_str())
                    .await?;
                let mut out = Vec::new();
                for child in children {
                    if child.is_directory && skip_hidden_dirs && child.name.starts_with('.') {
                        continue;
                    }
                    let Ok(url) = Url::parse(&child.uri) else {
                        continue;
                    };
                    out.push(RawEntry {
                        url,
                        name: child.name,
                        is_dir: child.is_directory,
                        is_symlink: false,
                    });
                }
                Ok(out)
            }
            #[cfg(not(target_os = "android"))]
            {
                let _ = skip_hidden_dirs;
                Err("content:// scan is only supported on Android".to_string())
            }
        }
        scheme => Err(format!("unsupported scheme for scan: {scheme}")),
    }
}

/// 对一个媒体文件项分类（媒体过滤），命中则按收集节流间隔回调 `on_file`。
async fn process_file<H: FolderScanHook>(
    raw: &RawEntry,
    ctx: &ScanCtx<H::DirCtx>,
    depth: usize,
    options: &ScanOptions,
    last_collect: &mut Option<Instant>,
    hook: &mut H,
) -> Result<(), ScanError> {
    match raw.url.scheme() {
        "file" => {
            let path = raw
                .url
                .to_file_path()
                .map_err(|_| ScanError::Skip(format!("invalid file URL: {}", raw.url)))?;
            if !is_media_by_path(&path) {
                return Ok(());
            }
            let (size, mtime) = match std::fs::metadata(&path) {
                Ok(metadata) => {
                    let mtime = metadata
                        .modified()
                        .ok()
                        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                        .map(|d| d.as_millis());
                    (Some(metadata.len()), mtime)
                }
                Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                    return Err(ScanError::Skip(format!("missing file: {}", path.display())));
                }
                Err(err) => {
                    return Err(ScanError::Skip(format!(
                        "unreadable file {}: {err}",
                        path.display()
                    )));
                }
            };
            let file = ScannedFile {
                url: raw.url.clone(),
                path: Some(path),
                name: raw.name.clone(),
                size,
                mtime_unix_ms: mtime,
                depth,
            };
            throttle_collect(last_collect, options.min_collect_interval_ms).await;
            hook.on_file(&file, ctx).await
        }
        "content" => {
            #[cfg(target_os = "android")]
            {
                let mime = get_content_io_provider()
                    .get_mime_type(raw.url.as_str())
                    .await
                    .unwrap_or(None);
                let is_media = crate::image_type::is_image_mime(&mime)
                    || crate::image_type::is_video_mime(&mime);
                if !is_media {
                    return Ok(());
                }
                let size = get_content_io_provider()
                    .get_content_size(raw.url.as_str())
                    .await
                    .ok();
                let file = ScannedFile {
                    url: raw.url.clone(),
                    path: None,
                    name: raw.name.clone(),
                    size,
                    mtime_unix_ms: None,
                    depth,
                };
                throttle_collect(last_collect, options.min_collect_interval_ms).await;
                hook.on_file(&file, ctx).await
            }
            #[cfg(not(target_os = "android"))]
            {
                Err(ScanError::Skip(
                    "content:// scan is only supported on Android".to_string(),
                ))
            }
        }
        scheme => Err(ScanError::Skip(format!(
            "unsupported scheme for scan: {scheme}"
        ))),
    }
}

/// 处理当前栈顶目录（其直接子项 + 递归子目录）。返回 `Err` 仅表示 Fatal。
async fn process_dir<H: FolderScanHook>(
    ctx: &mut ScanCtx<H::DirCtx>,
    share: f64,
    options: &ScanOptions,
    last_collect: &mut Option<Instant>,
    hook: &mut H,
) -> Result<(), ScanError> {
    let dir_url = ctx.current_dir().url.clone();
    let depth = ctx.current_dir().depth;

    let mut entries = match read_dir_entries(&dir_url, options.skip_hidden_dirs).await {
        Ok(entries) => entries,
        Err(err) => {
            ctx.record_here(
                Some(dir_url.clone()),
                ScanError::Skip(format!("read dir: {err}")),
            );
            hook.on_progress(share);
            return Ok(());
        }
    };
    entries.sort_by(|a, b| a.name.cmp(&b.name));

    let n = entries.len();
    if n == 0 {
        hook.on_progress(share);
        return Ok(());
    }
    let per = share / n as f64;

    for raw in &entries {
        if raw.is_symlink {
            if raw.is_dir {
                ctx.record_at(
                    raw.url.clone(),
                    Some(raw.url.clone()),
                    ScanError::Skip("linked folder not followed".to_string()),
                );
            }
            hook.on_progress(per);
            continue;
        }

        if raw.is_dir {
            let can_recurse = options.recursive && depth + 1 < options.max_depth;
            if !can_recurse {
                hook.on_progress(per);
                continue;
            }

            let sub = ScannedDir {
                url: raw.url.clone(),
                path: raw.url.to_file_path().ok(),
                name: raw.name.clone(),
                depth: depth + 1,
            };
            let sub_url = sub.url.clone();
            match url_is_dir(&sub_url).await {
                Ok(true) => {}
                Ok(false) => {
                    ctx.record_at(
                        sub_url.clone(),
                        Some(sub_url),
                        ScanError::Skip("non-enterable dir".to_string()),
                    );
                    hook.on_progress(per);
                    continue;
                }
                Err(err) => {
                    ctx.record_at(
                        sub_url.clone(),
                        Some(sub_url),
                        ScanError::Skip(format!("non-enterable dir: {err}")),
                    );
                    hook.on_progress(per);
                    continue;
                }
            }

            match hook.on_enter_dir(&sub, &*ctx).await {
                Ok(Some(payload)) => {
                    ctx.push(sub, payload);
                    let res = Box::pin(process_dir(ctx, per, options, last_collect, hook)).await;
                    let exit = if res.is_ok() {
                        hook.on_exit_dir(&*ctx).await
                    } else {
                        Ok(())
                    };
                    ctx.pop();

                    if let Err(error) = res {
                        return Err(error);
                    }
                    match exit {
                        Ok(()) => {}
                        Err(ScanError::Fatal(message)) => return Err(ScanError::Fatal(message)),
                        Err(error @ ScanError::Skip(_)) | Err(error @ ScanError::Interrupt(_)) => {
                            ctx.record_at(sub_url.clone(), Some(sub_url), error);
                        }
                    }
                }
                Ok(None) => hook.on_progress(per),
                Err(ScanError::Fatal(message)) => return Err(ScanError::Fatal(message)),
                Err(error @ ScanError::Skip(_)) | Err(error @ ScanError::Interrupt(_)) => {
                    ctx.record_at(sub_url.clone(), Some(sub_url), error);
                    hook.on_progress(per);
                }
            }
        } else {
            let entry_url = raw.url.clone();
            let interrupted =
                match process_file(raw, &*ctx, depth + 1, options, last_collect, hook).await {
                    Ok(()) => false,
                    Err(ScanError::Fatal(message)) => return Err(ScanError::Fatal(message)),
                    Err(error @ ScanError::Skip(_)) => {
                        ctx.record_here(Some(entry_url), error);
                        false
                    }
                    Err(error @ ScanError::Interrupt(_)) => {
                        ctx.record_here(Some(entry_url), error);
                        true
                    }
                };
            hook.on_progress(per);
            if interrupted {
                break;
            }
        }
    }
    Ok(())
}

/// 扫描入口：对每个根（目录或单文件）遍历，按选项递归，回调钩子。
///
/// 根目录**不**触发 on_enter_dir/on_exit_dir —— 根上下文为传入的 `root_ctx`，
/// 调用方在 `scan_and_visit` 返回后自行对根做收尾（如同步的「删除未见行 + 落状态」）。
pub async fn scan_and_visit<H: FolderScanHook>(
    roots: &[Url],
    root_ctx: H::DirCtx,
    options: &ScanOptions,
    hook: &mut H,
) -> Result<ScanCtx<H::DirCtx>, String> {
    let mut ctx = ScanCtx::new();
    if roots.is_empty() {
        return Ok(ctx);
    }
    let share = options.total_progress_share / roots.len() as f64;
    // 收集节流时间戳：贯穿整次扫描（跨根、跨目录），相邻 on_file 至少间隔配置值。
    let mut last_collect: Option<Instant> = None;

    for root in roots {
        let dir = ScannedDir {
            url: root.clone(),
            path: root.to_file_path().ok(),
            name: url_file_name(root),
            depth: 0,
        };

        match url_is_dir(root).await {
            Ok(true) => {
                ctx.push(dir, root_ctx.clone());
                let res = process_dir(&mut ctx, share, options, &mut last_collect, hook).await;
                ctx.pop();
                if let Err(error) = res {
                    return Err(error.into_message());
                }
            }
            Ok(false) => {
                ctx.push(dir, root_ctx.clone());
                let raw = RawEntry {
                    url: root.clone(),
                    name: url_file_name(root),
                    is_dir: false,
                    is_symlink: false,
                };
                let res = process_file(&raw, &ctx, 0, options, &mut last_collect, hook).await;
                hook.on_progress(share);
                let fatal = match res {
                    Ok(()) => None,
                    Err(ScanError::Fatal(message)) => Some(message),
                    Err(error @ ScanError::Skip(_)) | Err(error @ ScanError::Interrupt(_)) => {
                        ctx.record_here(Some(root.clone()), error);
                        None
                    }
                };
                ctx.pop();
                if let Some(message) = fatal {
                    return Err(message);
                }
            }
            Err(err) => {
                ctx.record_at(
                    root.clone(),
                    Some(root.clone()),
                    ScanError::Skip(format!("skip root: {err}")),
                );
                hook.on_progress(share);
            }
        }
    }

    Ok(ctx)
}
