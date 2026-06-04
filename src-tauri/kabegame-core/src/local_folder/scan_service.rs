//! 通用「文件夹扫描服务」：可配置是否递归，遍历 `file://` / `content://` 目录树。
//!
//! 服务只负责「发现」——扫到媒体文件回调 [`FolderScanHook::on_file`]，进入/离开子目录回调
//! [`FolderScanHook::on_enter_dir`] / [`FolderScanHook::on_exit_dir`]——具体用途（导入 / 发事件 /
//! 建子画册 / 收集）由钩子决定。本地导入、文件夹同步、画册创建均复用本服务。
//!
//! 设计要点：
//! - 泛型单态化（非 dyn）以支持钩子的关联类型 `DirCtx`（目录上下文，DFS 中由父向子传递）。
//! - 来源抽象：`file://` 走文件系统，`content://`（Android）走 `ContentIoProvider`。
//! - 媒体过滤、稳定性过滤、递归深度、进度份额、取消，全部收敛在服务里。
//! - 根目录**不**触发 on_enter_dir/on_exit_dir（根上下文由调用方提供并自行收尾）；仅子目录触发。

use crate::image_type::is_media_by_path;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};
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
    /// 文件「稳定」最小年龄（毫秒）：`now - mtime < age` 的文件跳过并计入 `skipped_unstable`。
    /// 仅对有 mtime 的 `file://` 生效；同步传 `Some(3000)`，本地导入传 `None`。
    pub min_stable_age_ms: Option<u64>,
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
            min_stable_age_ms: None,
            skip_hidden_dirs: false,
            total_progress_share: 100.0,
            max_depth: DEFAULT_MAX_DEPTH,
        }
    }
}

/// 扫描汇总。
#[derive(Debug, Default, Clone)]
pub struct ScanSummary {
    pub files: usize,
    pub dirs: usize,
    pub skipped_unstable: usize,
    pub skipped_missing: usize,
}

/// 扫描钩子：遍历期对每个媒体文件 / 子目录回调，由消费者决定用途。
#[async_trait::async_trait]
pub trait FolderScanHook: Send + Sync {
    /// 目录上下文：DFS 中由父向子传递（如：同步用「所属画册 id+名」）。
    type DirCtx: Clone + Send + Sync;

    /// 进入一个**子**目录时调用，`parent` 为父目录上下文。
    /// 返回该目录的上下文（传给其子文件/子目录），或 `None` 表示**跳过整棵子树**。
    async fn on_enter_dir(
        &mut self,
        dir: &ScannedDir,
        parent: &Self::DirCtx,
    ) -> Result<Option<Self::DirCtx>, String>;

    /// 离开一个**子**目录时调用（DFS 出栈），用于收尾。默认 no-op。
    async fn on_exit_dir(&mut self, _dir: &ScannedDir, _ctx: &Self::DirCtx) -> Result<(), String> {
        Ok(())
    }

    /// 发现一个媒体文件时调用，`ctx` 为其所在目录上下文。
    async fn on_file(&mut self, file: &ScannedFile, ctx: &Self::DirCtx) -> Result<(), String>;

    /// 是否取消（每个条目处理前检查）。
    async fn is_canceled(&self) -> bool {
        false
    }

    /// 进度上报（份额增量）。
    fn on_progress(&mut self, _delta: f64) {}
}

/// 列目录得到的原始子项。
struct RawEntry {
    url: Url,
    name: String,
    is_dir: bool,
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
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
            Ok(std::fs::metadata(&path).map_err(|e| e.to_string())?.is_dir())
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

/// 列出目录直接子项（不分媒体/稳定性，统一由 walk 阶段分类）。symlink 一律跳过。
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
                if ft.is_symlink() {
                    continue;
                }
                let name = ent.file_name().to_string_lossy().into_owned();
                if ft.is_dir() && skip_hidden_dirs && name.starts_with('.') {
                    continue;
                }
                let path = ent.path();
                let Ok(url) = Url::from_file_path(&path) else {
                    continue;
                };
                out.push(RawEntry {
                    url,
                    name,
                    is_dir: ft.is_dir(),
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

/// 对一个媒体文件项分类（媒体过滤 + 稳定性过滤），命中则回调 `on_file`。
async fn process_file<H: FolderScanHook>(
    raw: &RawEntry,
    ctx: &H::DirCtx,
    depth: usize,
    options: &ScanOptions,
    hook: &mut H,
    summary: &mut ScanSummary,
) -> Result<(), String> {
    match raw.url.scheme() {
        "file" => {
            let path = raw
                .url
                .to_file_path()
                .map_err(|_| format!("invalid file URL: {}", raw.url))?;
            if !is_media_by_path(&path) {
                return Ok(());
            }
            let (size, mtime) = match std::fs::metadata(&path) {
                Ok(m) => {
                    let mtime = m
                        .modified()
                        .ok()
                        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                        .map(|d| d.as_millis());
                    (Some(m.len()), mtime)
                }
                Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                    summary.skipped_missing += 1;
                    return Ok(());
                }
                Err(_) => return Ok(()),
            };
            if let (Some(age_ms), Some(mt)) = (options.min_stable_age_ms, mtime) {
                if now_ms().saturating_sub(mt) < age_ms as u128 {
                    summary.skipped_unstable += 1;
                    return Ok(());
                }
            }
            summary.files += 1;
            let file = ScannedFile {
                url: raw.url.clone(),
                path: Some(path),
                name: raw.name.clone(),
                size,
                mtime_unix_ms: mtime,
                depth,
            };
            hook.on_file(&file, ctx).await?;
            Ok(())
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
                summary.files += 1;
                let file = ScannedFile {
                    url: raw.url.clone(),
                    path: None,
                    name: raw.name.clone(),
                    size,
                    mtime_unix_ms: None,
                    depth,
                };
                hook.on_file(&file, ctx).await?;
                Ok(())
            }
            #[cfg(not(target_os = "android"))]
            {
                Err("content:// scan is only supported on Android".to_string())
            }
        }
        scheme => Err(format!("unsupported scheme for scan: {scheme}")),
    }
}

/// 处理一个目录（其直接子项 + 递归子目录）。进度份额 `share` 在子项间均分。
async fn process_dir<H: FolderScanHook>(
    dir: &ScannedDir,
    ctx: &H::DirCtx,
    share: f64,
    options: &ScanOptions,
    hook: &mut H,
    summary: &mut ScanSummary,
) -> Result<(), String> {
    if hook.is_canceled().await {
        return Err("Task canceled".to_string());
    }
    summary.dirs += 1;

    let mut entries = match read_dir_entries(&dir.url, options.skip_hidden_dirs).await {
        Ok(entries) => entries,
        Err(err) => {
            eprintln!("[scan_service] skip dir {}: {err}", dir.url);
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
        if hook.is_canceled().await {
            return Err("Task canceled".to_string());
        }
        if raw.is_dir {
            let can_recurse = options.recursive && dir.depth + 1 < options.max_depth;
            if can_recurse {
                let sub = ScannedDir {
                    url: raw.url.clone(),
                    path: raw.url.to_file_path().ok(),
                    name: raw.name.clone(),
                    depth: dir.depth + 1,
                };
                match hook.on_enter_dir(&sub, ctx).await? {
                    Some(sub_ctx) => {
                        // 递归会把 `per` 份额再均分给孙级；此处不再额外计进度。
                        Box::pin(process_dir(&sub, &sub_ctx, per, options, hook, summary)).await?;
                        hook.on_exit_dir(&sub, &sub_ctx).await?;
                    }
                    None => hook.on_progress(per),
                }
            } else {
                hook.on_progress(per);
            }
        } else {
            process_file(raw, ctx, dir.depth + 1, options, hook, summary).await?;
            hook.on_progress(per);
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
) -> Result<ScanSummary, String> {
    let mut summary = ScanSummary::default();
    if roots.is_empty() {
        return Ok(summary);
    }
    let share = options.total_progress_share / roots.len() as f64;

    for root in roots {
        if hook.is_canceled().await {
            return Err("Task canceled".to_string());
        }
        if url_is_dir(root).await? {
            let dir = ScannedDir {
                url: root.clone(),
                path: root.to_file_path().ok(),
                name: url_file_name(root),
                depth: 0,
            };
            process_dir(&dir, &root_ctx, share, options, hook, &mut summary).await?;
        } else {
            let raw = RawEntry {
                url: root.clone(),
                name: url_file_name(root),
                is_dir: false,
            };
            process_file(&raw, &root_ctx, 0, options, hook, &mut summary).await?;
            hook.on_progress(share);
        }
    }
    Ok(summary)
}
