//! Wallpaper Engine 壁纸目录的入库，以及内建 `wpe-import` 任务。
//!
//! 入库 `video`、`web` 与 `scene` 三类：`local_path` 存壁纸目录本身，`type` 为 `x-wpe/video` /
//! `x-wpe/web` / `x-wpe/scene`，缩略图直接引用 WPE 自带的 `preview.*`。
//!
//! [`ingest_wpe_dir`] 是唯一的入库函数，四个入口共用：`wpe-import` 任务、local-import 与下载
//! 经 `postprocess_downloaded_image` 的目录分支进来，文件夹同步直接调用。
//!
//! - `hash` 是目录哈希（[`crate::wpe::dir_hash`]），`size` 是目录内全部文件的总字节数。
//! - 视频行的 `compatible_path` 始终有值：浏览器能播时就是入口视频本身，不能播时才在
//!   `compatibles_dir` 生成兼容副本；所有播放端（预览、应用背景、壁纸窗口）统一走 `/compatible`。
//! - 网页行没有可播放媒体，`compatible_path` 留空、宽高留空。
//!   页面以入口的 `file://` 从原目录加载（桌面壁纸窗口与图库预览同一套运行时目录拦截）。
//! - 场景行同样没有可播放媒体；宽高是场景分辨率，透视场景留空。渲染在前端，Rust 只从入口读分辨率。
//!
//! 原地入库不复制、不转码、不改写用户目录里的任何文件；只有下载产物（`relocate_to` 为 `Some`）
//! 才会被移动，或在去重命中时删除。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::json;
use url::Url;

use crate::crawler::downloader::util::{copy_dir_unique, move_dir_unique};
use crate::crawler::downloader::{
    next_download_id, postprocess_downloaded_image, PostprocessSource,
};
use crate::crawler::task_log_i18n::task_log_i18n;
use crate::crawler::task_scheduler::Task;
use crate::emitter::GlobalEmitter;
use crate::storage::image_events::emit_membership_added;
use crate::storage::labels::{validate_labels, LabelInput};
use crate::storage::{ImageInfo, Storage};
use crate::wpe::dir_hash::{digest_dir, DirDigest};
use crate::wpe::discover::WpeRootKind;
use crate::wpe::normalize_local_dir;
use crate::wpe::project::{read_project, WpeKind, WpeProject, WpeSkip};
use crate::wpe::scan::collect_selected_dirs;
use crate::wpe::tags::{
    read_workshop_tags, tag_dir, tag_dir_name, tag_name, wallpaper_tags, WorkshopTags,
};

/// 内建任务 / 插件 id。
pub use crate::wpe::WPE_IMPORT_PLUGIN_ID;

/// 壁纸标签画册的根目录：`WPE/<子目录>/<tag>`，子目录见 [`tag_dir`]。
pub const WPE_LABEL_CATEGORY: &str = "WPE";

fn emit_log(task_id: &str, level: &str, key: &str, params: serde_json::Value) {
    GlobalEmitter::global().emit_task_log(task_id, level, &task_log_i18n(key, params));
}

/// 同 [`emit_log`]；没有任务（文件夹同步）时不写任务日志。
fn emit_log_opt(task_id: Option<&str>, level: &str, key: &str, params: serde_json::Value) {
    if let Some(task_id) = task_id {
        emit_log(task_id, level, key, params);
    }
}

/// 解析勾选的来源。缺省（未传 `sources`）时三类全选；`extraDirs` 单独走扩展键。
/// 勾选的自动来源。缺失按全选；显式 `null` 表示不用自动来源（只导入手选文件夹）：checkbox 校验不接受全 false，
/// 前端没有勾选时传 `null`。
fn parse_sources(config: &HashMap<String, serde_json::Value>) -> Vec<WpeRootKind> {
    let Some(value) = config.get("sources") else {
        return WpeRootKind::ALL.to_vec();
    };
    let Some(sources) = value.as_object() else {
        return Vec::new();
    };
    WpeRootKind::ALL
        .into_iter()
        .filter(|kind| {
            sources
                .get(kind.as_str())
                .and_then(|value| value.as_bool())
                .unwrap_or(false)
        })
        .collect()
}

fn parse_extra_dirs(config: &HashMap<String, serde_json::Value>) -> Vec<String> {
    config
        .get("extraDirs")
        .and_then(|value| value.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str())
                .map(str::trim)
                .filter(|item| !item.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// 把壁纸的标签（见 [`wallpaper_tags`]）转成 `WPE/<子目录>/<tag>` 标签并挂到图片上。
fn apply_wpe_tags(
    task_id: Option<&str>,
    project: &WpeProject,
    workshop_tags: &WorkshopTags,
    image_id: &str,
) {
    let tags = wallpaper_tags(project, workshop_tags);
    if tags.is_empty() {
        return;
    }
    let inputs: Vec<LabelInput> = tags
        .iter()
        .map(|tag| {
            let dir = tag_dir(tag);
            LabelInput {
                key: Some(tag.clone()),
                category: Some(format!("{WPE_LABEL_CATEGORY}/{dir}")),
                name: tag_name(tag),
                dir_name: tag_dir_name(dir),
            }
        })
        .collect();
    let (specs, rejected) = validate_labels(&inputs, WPE_IMPORT_PLUGIN_ID);
    for (index, reason) in rejected {
        let tag = tags.get(index).cloned().unwrap_or_default();
        emit_log_opt(
            task_id,
            "warn",
            "taskLogWpeTagSkipped",
            json!({ "tag": tag, "reason": reason }),
        );
    }
    if specs.is_empty() {
        return;
    }
    let image_ids = vec![image_id.to_string()];
    match Storage::global().apply_labels_to_images(&specs, &image_ids) {
        Ok(applied) => {
            for (spec, error) in applied.skipped {
                emit_log_opt(
                    task_id,
                    "warn",
                    "taskLogLabelAttachSkipped",
                    json!({
                        "path": format!("{}/{}", spec.segments.join("/"), spec.key),
                        "reason": error,
                    }),
                );
            }
        }
        Err(error) => {
            emit_log_opt(
                task_id,
                "warn",
                "taskLogLabelAttachFailed",
                json!({ "detail": error }),
            );
        }
    }
}

fn join_album(album_id: Option<&str>, image_id: &str) -> Result<(), String> {
    let Some(album_id) = album_id.map(str::trim).filter(|id| !id.is_empty()) else {
        return Ok(());
    };
    let storage = Storage::global();
    let added = storage.add_images_to_album_silent(album_id, &[image_id.to_string()]);
    if added > 0 {
        emit_membership_added(album_id, &[image_id.to_string()])?;
    }
    Ok(())
}

/// 规范化成入库用的绝对路径字符串（去掉 Windows `\\?\` 前缀）。
fn canonical_string(path: &Path) -> String {
    path.canonicalize()
        .ok()
        .map(|path| {
            path.to_string_lossy()
                .trim_start_matches("\\\\?\\")
                .to_string()
        })
        .unwrap_or_else(|| path.to_string_lossy().into_owned())
}

/// 计算 WPE 视频行的 `compatible_path`：浏览器能播就是入口视频本身；解不了的编码在
/// `compatibles_dir` 生成兼容副本，生成失败仍回落到入口视频，保证字段始终有值。
async fn resolve_compatible_path(
    task_id: Option<&str>,
    entry: &Path,
    probe: Option<&crate::media::dimensions::MediaProbeResult>,
    dir_string: &str,
) -> String {
    if let Some(probe) = probe.filter(|probe| !probe.browser_safe) {
        match crate::crawler::downloader::generate_compatible_video(entry, probe).await {
            Ok(Some(path)) => return canonical_string(&path),
            Ok(None) => {}
            Err(error) => emit_log_opt(
                task_id,
                "warn",
                "taskLogWpeCompatibleFailed",
                json!({ "path": dir_string, "detail": error }),
            ),
        }
    }
    canonical_string(entry)
}

/// 已入库行的 `compatible_path` 为空或文件已不在时补上（早期导入只在不可播时才写）。
async fn backfill_compatible_path(
    task_id: Option<&str>,
    existing: &ImageInfo,
    entry: &Path,
    dir_string: &str,
) {
    let current = existing
        .compatible_path
        .as_deref()
        .map(str::trim)
        .unwrap_or("");
    if !current.is_empty() && Path::new(current).is_file() {
        return;
    }
    let probe = crate::media::dimensions::probe_media_sync(entry);
    let path = resolve_compatible_path(task_id, entry, probe.as_ref(), dir_string).await;
    if let Err(error) = Storage::global().replace_image_compatible_path(&existing.id, &path) {
        tracing::warn!(
            "compatible_path backfill failed for {}: {error}",
            existing.id
        );
        return;
    }
    GlobalEmitter::global().emit_image_fields(
        std::slice::from_ref(&existing.id),
        json!({ "compatiblePath": path }),
    );
}

/// 一次目录入库的参数。四个入口（`wpe-import`、local-import、文件夹同步、下载）共用。
pub(crate) struct WpeIngest<'a> {
    /// 所属任务；文件夹同步没有任务。
    pub task_id: Option<&'a str>,
    /// 入库后（或命中已有行时）要挂上的画册。
    pub album_id: Option<&'a str>,
    /// `Some` → 把目录放到该目录下再入库；`None` → 原地引用。
    pub relocate_to: Option<&'a Path>,
    /// `relocate_to` 为 `Some` 时：`true` 移动（去重命中则删掉源目录），`false` 复制、源保持不变。
    /// 原地入库时不删任何东西。
    pub delete_source: bool,
    /// 是否按目录哈希去重。下载 / 导入跟随 `auto_deduplicate`；文件夹同步恒为 `false`
    /// （磁盘上有几个目录就有几行）。
    pub dedup_by_hash: bool,
    /// 展示名，也是搬运后的目录名；为空时取 `project.json` 的标题。
    pub display_name: Option<&'a str>,
    /// 帖子地址；为空时取创意工坊页面地址。
    pub post_url: Option<&'a str>,
}

/// 目录入库的结果。
pub(crate) enum WpeIngested {
    /// 新写了一行。
    Imported(ImageInfo),
    /// 库里已有这张壁纸（同一路径，或内容相同的另一个目录），只补了画册成员。
    Existing(ImageInfo),
}

/// 读出一个可入库的壁纸工程：有 `project.json` 且类型受支持。
fn read_supported_project(dir: &Path) -> Result<WpeProject, String> {
    let project = read_project(dir).map_err(|skip| skip.message())?;
    if !project.kind.is_supported() {
        return Err(WpeSkip::Unsupported(project.kind).message());
    }
    Ok(project)
}

/// `dir` 是否是可入库的 WPE 壁纸目录。local-import 与文件夹同步用它决定「整目录当一个条目」
/// 还是照常下钻 / 建子画册。
pub(crate) fn is_importable_wpe_dir(dir: &Path) -> bool {
    read_supported_project(dir).is_ok()
}

fn non_empty(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

/// 库里按路径已有这一行：补画册成员，视频行补缺失的 `compatible_path`。
async fn finish_existing(
    opts: &WpeIngest<'_>,
    project: &WpeProject,
    existing: ImageInfo,
) -> Result<WpeIngested, String> {
    if project.kind == WpeKind::Video {
        if let Some(entry) = project.entry_path() {
            backfill_compatible_path(opts.task_id, &existing, &entry, &project.dir_string()).await;
        }
    }
    join_album(opts.album_id, &existing.id)?;
    Ok(WpeIngested::Existing(existing))
}

/// 把一个 WPE 壁纸目录写成一行 `x-wpe/*`：四个入口共用的唯一入库函数。
///
/// - 原地入库（`relocate_to` 为 `None`）按 `local_path` 幂等，不复制、不改写、不删除目录里的任何文件。
/// - `relocate_to` 为 `Some` 时目录被移动（`delete_source`）或复制到目标目录下的唯一名；
///   去重命中且 `delete_source` 时删掉源目录（调用方保证它是下载产物）。
/// - 行的身份由宿主定：`plugin_id` 恒为 `wpe-import`，metadata 是 `project.json` 原文，
///   属性面板与垫片直接读它的顶层字段。`hash` 是目录哈希、`size` 是目录总字节数。
pub(crate) async fn ingest_wpe_dir(dir: &Path, opts: WpeIngest<'_>) -> Result<WpeIngested, String> {
    let mut project = read_supported_project(dir)?;

    // ① 原地入库按路径幂等
    if opts.relocate_to.is_none() {
        if let Some(existing) =
            Storage::find_image_by_path(&project.dir_string()).map_err(|e| e.to_string())?
        {
            return finish_existing(&opts, &project, existing).await;
        }
    }

    // ② 目录哈希（可能要读几个 GB，放进阻塞线程）
    let digest_root = project.dir.clone();
    let digest = tokio::task::spawn_blocking(move || digest_dir(&digest_root))
        .await
        .map_err(|e| format!("目录哈希任务异常：{e}"))?
        .map_err(|e| format!("计算壁纸目录哈希失败：{e}"))?;

    // ③ 按内容去重
    if opts.dedup_by_hash {
        if let Some(existing) = Storage::find_image_by_hash(&digest.hash).ok().flatten() {
            join_album(opts.album_id, &existing.id)?;
            // 只删下载产物；已有行指向的目录永远不删
            let is_existing_dir = Path::new(&existing.local_path) == project.dir;
            if opts.relocate_to.is_some() && opts.delete_source && !is_existing_dir {
                if let Err(error) = tokio::fs::remove_dir_all(&project.dir).await {
                    tracing::warn!("删除重复的壁纸目录失败 {}: {error}", project.dir.display());
                }
            }
            return Ok(WpeIngested::Existing(existing));
        }
    }

    // ④ 搬到目标目录（移动或复制），之后一律按新路径处理
    let mut relocated: Option<PathBuf> = None;
    if let Some(dest) = opts.relocate_to {
        let name = non_empty(opts.display_name)
            .unwrap_or(&project.title)
            .to_string();
        let src = project.dir.clone();
        let dest = dest.to_path_buf();
        let delete_source = opts.delete_source;
        let moved = tokio::task::spawn_blocking(move || {
            if delete_source {
                move_dir_unique(&src, &dest, &name)
            } else {
                copy_dir_unique(&src, &dest, &name)
            }
        })
        .await
        .map_err(|e| format!("搬运壁纸目录任务异常：{e}"))?
        .map_err(|e| format!("搬运壁纸目录失败：{e}"))?;
        relocated = Some(moved);
    }

    let result = async {
        if let Some(moved) = relocated.as_deref() {
            project = read_supported_project(moved)?;
        }
        insert_wpe_row(&opts, &project, digest).await
    }
    .await;

    // 入库失败时删掉本次搬运产生的目录（与文件下载失败删新建文件一致）；命中已有行的不在此列。
    // 删之前再按路径查一次：只要有行指向它（另一个入口在这期间写了库），就不删。
    if result.is_err() {
        if let Some(moved) = relocated {
            let referenced = !matches!(
                Storage::find_image_by_path(&moved.to_string_lossy()),
                Ok(None)
            );
            if referenced {
                tracing::warn!(
                    "壁纸目录入库失败，但已有记录指向它，保留目录 {}",
                    moved.display()
                );
            } else if let Err(error) = tokio::fs::remove_dir_all(&moved).await {
                tracing::warn!("清理未入库的壁纸目录失败 {}: {error}", moved.display());
            }
        }
    }
    result
}

/// ⑤⑥ 组装并写入图片行，广播、挂画册与标签。
async fn insert_wpe_row(
    opts: &WpeIngest<'_>,
    project: &WpeProject,
    digest: DirDigest,
) -> Result<WpeIngested, String> {
    let dir_string = project.dir_string();

    // 各类型的差异字段：视频探测宽高并保证 compatible_path 有值；网页没有固有尺寸；
    // 场景取场景分辨率（透视场景留空）
    let (width, height, compatible_path) = match project.kind {
        WpeKind::Video => {
            let entry = project
                .entry_path()
                .ok_or_else(|| "缺少入口文件".to_string())?;
            let probe = crate::media::dimensions::probe_media_sync(&entry);
            let (width, height) = probe
                .as_ref()
                .map(|probe| (Some(probe.width), Some(probe.height)))
                .unwrap_or((None, None));
            let compatible =
                resolve_compatible_path(opts.task_id, &entry, probe.as_ref(), &dir_string).await;
            (width, height, Some(compatible))
        }
        WpeKind::Web => (None, None, None),
        WpeKind::Scene => {
            let (width, height) = project.scene_resolution().unzip();
            (width, height, None)
        }
        kind => return Err(WpeSkip::Unsupported(kind).message()),
    };

    let storage = Storage::global();
    let metadata_id = storage
        .insert_metadata_row(&project.raw, WPE_IMPORT_PLUGIN_ID, 0, None, None)
        .map_err(|e| format!("写入 metadata 失败：{e}"))?;

    let thumbnail_path = project
        .preview_path()
        .map(|path| {
            path.to_string_lossy()
                .trim_start_matches("\\\\?\\")
                .to_string()
        })
        .unwrap_or_default();
    let crawled_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let workshop_url = project.workshop_url();
    let media_type = project.kind.media_type();
    // 色盘：视频从 compatible_path（入口视频或兼容副本）抽帧；网页 / 场景取作者的 schemecolor，
    // 没有时 `source_for_row` 自己落到预览图。尽力而为，算不出来就没有，不阻断入库。
    let palette = match media_type {
        Some(media_type) => {
            crate::media::palette::compute_for_row(
                media_type,
                &dir_string,
                &thumbnail_path,
                compatible_path.as_deref(),
                crate::wpe::properties::scheme_color_from_raw(&project.raw),
            )
            .await
        }
        None => None,
    };
    let image = ImageInfo {
        id: String::new(),
        url: workshop_url.clone(),
        local_path: dir_string.clone(),
        plugin_id: Some(WPE_IMPORT_PLUGIN_ID.to_string()),
        task_id: opts.task_id.map(str::to_string),
        surf_record_id: None,
        crawled_at,
        metadata_id: Some(metadata_id),
        image_metadata_id: None,
        thumbnail_path,
        favorite: false,
        is_hidden: false,
        local_exists: true,
        hash: digest.hash,
        width,
        height,
        display_name: non_empty(opts.display_name)
            .unwrap_or(&project.title)
            .to_string(),
        media_type: media_type.map(str::to_string),
        last_set_wallpaper_at: None,
        size: Some(digest.total_bytes),
        album_order: None,
        compatible_path,
        post_url: non_empty(opts.post_url)
            .map(str::to_string)
            .or(workshop_url),
        palette: palette
            .as_ref()
            .map(crate::media::palette::Palette::to_json),
    };

    let inserted = match storage.add_image(image) {
        Ok(inserted) => inserted,
        Err(error) => {
            let _ = storage.gc_metadata(&[metadata_id]);
            // local_path 有唯一约束：另一个入口（文件夹同步 / 并发任务）抢先写了同一个目录
            return match Storage::find_image_by_path(&dir_string).ok().flatten() {
                Some(existing) => finish_existing(opts, project, existing).await,
                None => Err(error),
            };
        }
    };
    let image_id = inserted.id.clone();
    GlobalEmitter::global().emit_images_added(std::slice::from_ref(&inserted));

    join_album(opts.album_id, &image_id)?;
    apply_wpe_tags(opts.task_id, project, &read_workshop_tags(), &image_id);

    emit_log_opt(
        opts.task_id,
        "info",
        "taskLogWpeImported",
        json!({ "title": project.title, "path": dir_string }),
    );

    Ok(WpeIngested::Imported(inserted))
}

fn skip_reason(project_result: &Result<WpeProject, WpeSkip>) -> Option<&WpeSkip> {
    project_result.as_ref().err()
}

/// 任务入口。
pub async fn run_builtin_wpe_import(run: Arc<Task>) -> Result<(), String> {
    let task_id = run.task_id.clone();
    let config = run.params.config.clone();
    let sources = parse_sources(&config);
    let extra_dirs = parse_extra_dirs(&config);

    if sources.is_empty() && extra_dirs.is_empty() {
        return Err("未选择任何壁纸来源".to_string());
    }

    let (dirs, errors) = collect_selected_dirs(&sources, &extra_dirs);
    for (path, reason) in errors {
        emit_log(
            &task_id,
            "warn",
            "taskLogWpeSourceInvalid",
            json!({ "path": path, "reason": reason }),
        );
    }
    if dirs.is_empty() {
        return Err("没有找到任何 Wallpaper Engine 壁纸目录".to_string());
    }

    let total = dirs.len();
    run.set_progress(0.0);
    emit_log(
        &task_id,
        "info",
        "taskLogWpeScanSummary",
        json!({
            "total": total,
            "sources": sources.iter().map(|kind| kind.as_str()).collect::<Vec<_>>(),
        }),
    );

    let download_queue = crate::crawler::TaskScheduler::global().download_queue();
    let headers: HashMap<String, String> = HashMap::new();
    let download_start_time = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;

    let mut imported = 0usize;
    let mut already = 0usize;
    let mut skipped = 0usize;
    for (index, dir) in dirs.iter().enumerate() {
        if run.cancel.is_cancelled() {
            return Err("Task canceled".to_string());
        }

        let normalized = normalize_local_dir(dir).unwrap_or_else(|| dir.clone());
        let project_result = read_project(&normalized);

        match &project_result {
            Ok(project) if project.kind.is_supported() => {
                if run.params.is_dry_run {
                    emit_log(
                        &task_id,
                        "info",
                        "taskLogDryRunSkipImport",
                        json!({ "path": project.dir_string() }),
                    );
                    run.record_dry_run_skip();
                } else {
                    // 与 local-import 一样走下载后处理：目录分支负责入库，计数 / 去重 / 失败记录由它统一处理
                    let result = match Url::from_file_path(&project.dir) {
                        Ok(url) => {
                            postprocess_downloaded_image(
                                &download_queue,
                                next_download_id(),
                                PostprocessSource::Path {
                                    path: &project.dir,
                                    relocate_to: None,
                                },
                                false,
                                &url,
                                WPE_IMPORT_PLUGIN_ID,
                                Some(&task_id),
                                None,
                                None,
                                download_start_time,
                                run.params.output_album_id.as_deref(),
                                &headers,
                                None,
                                None,
                                None,
                                &[],
                            )
                            .await
                        }
                        Err(()) => Err(format!("无效的目录路径：{}", project.dir.display())),
                    };
                    match result {
                        Ok(true) => imported += 1,
                        Ok(false) => already += 1,
                        Err(error) => {
                            skipped += 1;
                            emit_log(
                                &task_id,
                                "warn",
                                "taskLogWpeSkip",
                                json!({
                                    "path": project.dir_string(),
                                    "reason": error,
                                }),
                            );
                        }
                    }
                }
            }
            Ok(project) => {
                skipped += 1;
                emit_log(
                    &task_id,
                    "info",
                    "taskLogWpeSkip",
                    json!({
                        "path": project.dir_string(),
                        "reason": format!("暂不支持的壁纸类型：{}", project.kind.as_str()),
                    }),
                );
            }
            Err(skip) => {
                // 创意工坊根下偶尔有残目录；NoProject 不当作错误噪音。
                if !matches!(skip_reason(&project_result), Some(WpeSkip::NoProject)) {
                    skipped += 1;
                    emit_log(
                        &task_id,
                        "warn",
                        "taskLogWpeSkip",
                        json!({
                            "path": normalized.to_string_lossy(),
                            "reason": skip.message(),
                        }),
                    );
                }
            }
        }

        // 已入库的目录在文件系统层面无需再做任何事；`ingest_wpe_dir` 按 local_path 幂等。
        run.set_progress(((index + 1) as f64 / total as f64) * 100.0);
    }

    emit_log(
        &task_id,
        "info",
        "taskLogWpeImportSummary",
        json!({
            "total": total,
            "imported": imported,
            "existing": already,
            "skipped": skipped,
            "dryRun": run.params.is_dry_run,
        }),
    );

    run.set_progress(100.0);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crawler::task_scheduler::build_effective_user_config_from_var_defs;
    use crate::plugin::builtin::builtin_plugins;

    #[test]
    fn missing_sources_means_all() {
        assert_eq!(parse_sources(&HashMap::new()).len(), WpeRootKind::ALL.len());
    }

    #[test]
    fn flags_select_only_checked_sources() {
        let config = HashMap::from([(
            "sources".to_string(),
            json!({ "workshop": true, "defaultprojects": false, "myprojects": false }),
        )]);
        assert_eq!(parse_sources(&config), vec![WpeRootKind::Workshop]);
    }

    /// 对话框只选手选文件夹时的配置：要过校验，且不回落到默认的全选。
    #[test]
    fn folder_only_config_passes_validation_without_auto_sources() {
        let plugin = builtin_plugins().get(WPE_IMPORT_PLUGIN_ID).unwrap();
        let config = build_effective_user_config_from_var_defs(
            &plugin.var_defs,
            HashMap::from([
                ("sources".to_string(), serde_json::Value::Null),
                ("extraDirs".to_string(), json!(["/some/folder"])),
            ]),
            None,
        )
        .unwrap();
        assert!(parse_sources(&config).is_empty());
        assert_eq!(parse_extra_dirs(&config), vec!["/some/folder".to_string()]);
    }

    // ---------- 目录入库（后处理的目录分支）----------

    mod ingest {
        use super::super::*;
        use crate::app_paths::AppPaths;
        use crate::crawler::downloader::DownloadQueue;
        use crate::settings::Settings;
        use std::fs;
        use std::sync::{Mutex, MutexGuard, OnceLock};

        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();

        /// 这些用例改全局设置（自动去重），彼此串行。
        fn guard() -> MutexGuard<'static, ()> {
            let guard = LOCK
                .get_or_init(|| Mutex::new(()))
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            // 路径与 Storage 都是进程级单例，可能已被同一测试二进制里的其它模块初始化
            AppPaths::init_for_tests();
            let _ = Settings::init_global();
            let _ = Storage::init_global();
            #[cfg(feature = "ipc-server")]
            {
                let _ = crate::ipc::server::EventBroadcaster::init_global(1000);
                let _ = GlobalEmitter::init_global();
            }
            let _ = crate::providers::provider_runtime();
            guard
        }

        struct DedupGuard {
            auto: bool,
            update_metadata: bool,
        }

        impl DedupGuard {
            fn set(auto: bool, update_metadata: bool) -> Self {
                let settings = Settings::global();
                let previous = Self {
                    auto: settings.get_auto_deduplicate(),
                    update_metadata: settings.get_dedup_update_metadata(),
                };
                settings.set_auto_deduplicate(auto).unwrap();
                settings.set_dedup_update_metadata(update_metadata).unwrap();
                previous
            }
        }

        impl Drop for DedupGuard {
            fn drop(&mut self) {
                let _ = Settings::global().set_auto_deduplicate(self.auto);
                let _ = Settings::global().set_dedup_update_metadata(self.update_metadata);
            }
        }

        fn temp_root() -> (tempfile::TempDir, PathBuf) {
            let temp = tempfile::tempdir().unwrap();
            let path = temp.path().canonicalize().unwrap();
            (temp, path)
        }

        /// 造一个网页壁纸目录；`seed` 决定内容（也就决定目录哈希）。
        fn web_wallpaper(parent: &Path, name: &str, title: &str, seed: &str) -> PathBuf {
            let dir = parent.join(name);
            fs::create_dir_all(dir.join("js")).unwrap();
            fs::write(
                dir.join("project.json"),
                serde_json::to_vec(&json!({
                    "type": "web",
                    "file": "index.html",
                    "title": title,
                    "preview": "preview.jpg",
                }))
                .unwrap(),
            )
            .unwrap();
            fs::write(dir.join("index.html"), format!("<html>{seed}</html>")).unwrap();
            fs::write(dir.join("js/app.js"), format!("// {seed}")).unwrap();
            fs::write(dir.join("preview.jpg"), b"not-a-real-jpeg").unwrap();
            dir
        }

        fn unique(prefix: &str) -> String {
            format!("{prefix}-{}", uuid::Uuid::new_v4().simple())
        }

        async fn postprocess(
            dir: &Path,
            relocate_to: Option<&Path>,
            delete_source: bool,
        ) -> Result<bool, String> {
            postprocess_downloaded_image(
                &DownloadQueue::new(),
                next_download_id(),
                PostprocessSource::Path {
                    path: dir,
                    relocate_to,
                },
                delete_source,
                &Url::from_file_path(dir).unwrap(),
                "some-download-plugin",
                None,
                None,
                None,
                0,
                None,
                &HashMap::new(),
                None,
                // 调用方的 metadata 不参与 WPE 行
                Some(987_654_321),
                None,
                &[],
            )
            .await
        }

        fn row(dir: &Path) -> Option<ImageInfo> {
            Storage::find_image_by_path(&dir.to_string_lossy()).unwrap()
        }

        #[tokio::test]
        async fn in_place_import_writes_one_wpe_row_and_is_idempotent() {
            let _guard = guard();
            let _dedup = DedupGuard::set(true, true);
            let (_temp, root) = temp_root();
            let seed = unique("in-place");
            let dir = web_wallpaper(&root, "wall", "原地导入", &seed);

            assert_eq!(postprocess(&dir, None, false).await, Ok(true));
            let image = row(&dir).expect("目录应写成一行");
            let digest = digest_dir(&dir).unwrap();
            assert_eq!(image.media_type.as_deref(), Some("x-wpe/web"));
            assert_eq!(image.hash, digest.hash);
            assert_eq!(image.size, Some(digest.total_bytes));
            assert_eq!(image.display_name, "原地导入");
            assert_eq!(image.plugin_id.as_deref(), Some(WPE_IMPORT_PLUGIN_ID));
            assert_eq!(
                image.thumbnail_path,
                dir.join("preview.jpg").to_string_lossy()
            );
            // metadata 是 project.json 原文，不是调用方传入的那个 id
            let metadata = Storage::global().get_metadata(&image.id).unwrap().unwrap();
            assert_eq!(metadata["title"], "原地导入");
            assert_ne!(image.metadata_id, Some(987_654_321));

            // 再喂一次：按路径幂等
            assert_eq!(postprocess(&dir, None, false).await, Ok(false));
            assert_eq!(row(&dir).unwrap().id, image.id);
            assert!(dir.join("project.json").is_file(), "原地导入不动目录");
        }

        #[tokio::test]
        async fn relocate_moves_directory_and_probes_names() {
            let _guard = guard();
            let _dedup = DedupGuard::set(true, false);
            let (_temp, root) = temp_root();
            let dest = root.join("downloads");
            let title = unique("搬运");

            let first = web_wallpaper(&root.join("tmp-a"), "wall", &title, &unique("first"));
            assert_eq!(postprocess(&first, Some(&dest), true).await, Ok(true));
            assert!(!first.exists(), "源目录应被移走");
            let moved = dest.join(&title);
            let image = row(&moved).expect("新路径应有一行");
            assert_eq!(image.media_type.as_deref(), Some("x-wpe/web"));
            assert_eq!(image.hash, digest_dir(&moved).unwrap().hash);
            assert!(moved.join("js/app.js").is_file());
            assert_eq!(
                image.thumbnail_path,
                moved.join("preview.jpg").to_string_lossy(),
                "预览图跟着新路径"
            );

            // 同名不同内容：落到 名(1)
            let second = web_wallpaper(&root.join("tmp-b"), "wall", &title, &unique("second"));
            assert_eq!(postprocess(&second, Some(&dest), true).await, Ok(true));
            assert!(!second.exists());
            assert!(row(&dest.join(format!("{title}(1)"))).is_some());
        }

        #[tokio::test]
        async fn relocate_without_delete_source_copies() {
            let _guard = guard();
            let _dedup = DedupGuard::set(true, false);
            let (_temp, root) = temp_root();
            let dest = root.join("downloads");
            let title = unique("复制");
            let src = web_wallpaper(&root.join("src"), "wall", &title, &unique("copy"));

            assert_eq!(postprocess(&src, Some(&dest), false).await, Ok(true));
            assert!(src.join("project.json").is_file(), "不删源时是复制");
            assert!(row(&dest.join(&title)).is_some());
            assert!(row(&src).is_none());
        }

        #[tokio::test]
        async fn dedup_hit_deletes_downloaded_source_only() {
            let _guard = guard();
            let _dedup = DedupGuard::set(true, true);
            let (_temp, root) = temp_root();
            let seed = unique("dedup");
            let title = unique("去重");
            let original = web_wallpaper(&root.join("library"), "wall", &title, &seed);
            assert_eq!(postprocess(&original, None, false).await, Ok(true));
            let existing = row(&original).unwrap();

            // 内容相同的另一个目录，原地导入：命中已有行，但不删任何东西
            let local_copy = web_wallpaper(&root.join("elsewhere"), "wall", &title, &seed);
            assert_eq!(postprocess(&local_copy, None, false).await, Ok(false));
            assert!(local_copy.join("project.json").is_file());
            assert!(row(&local_copy).is_none());

            // 下载产物（relocate + delete_source）：命中已有行，删掉源，输出目录不多东西
            let downloaded = web_wallpaper(&root.join("vfs-tmp"), "wall", &title, &seed);
            let dest = root.join("downloads");
            assert_eq!(postprocess(&downloaded, Some(&dest), true).await, Ok(false));
            assert!(!downloaded.exists(), "去重命中时删掉下载产物");
            assert!(!dest.join(&title).exists(), "去重命中不搬运");
            assert!(original.join("project.json").is_file(), "已有行的目录不动");

            // 已有 WPE 行的身份不变
            let after = row(&original).unwrap();
            assert_eq!(after.plugin_id, existing.plugin_id);
            assert_eq!(after.metadata_id, existing.metadata_id);
        }

        #[tokio::test]
        async fn dedup_off_imports_identical_directories_separately() {
            let _guard = guard();
            let _dedup = DedupGuard::set(false, false);
            let (_temp, root) = temp_root();
            let seed = unique("no-dedup");
            let first = web_wallpaper(&root.join("a"), "wall", "x", &seed);
            let second = web_wallpaper(&root.join("b"), "wall", "x", &seed);
            assert_eq!(postprocess(&first, None, false).await, Ok(true));
            assert_eq!(postprocess(&second, None, false).await, Ok(true));
            assert_eq!(row(&first).unwrap().hash, row(&second).unwrap().hash);
        }

        #[tokio::test]
        async fn non_wallpaper_directory_fails_and_is_left_alone() {
            let _guard = guard();
            let _dedup = DedupGuard::set(true, false);
            let (_temp, root) = temp_root();
            let dest = root.join("downloads");

            // 没有 project.json
            let plain = root.join("plain");
            fs::create_dir_all(&plain).unwrap();
            fs::write(plain.join("a.txt"), b"hello").unwrap();
            assert!(postprocess(&plain, Some(&dest), true).await.is_err());
            assert!(plain.join("a.txt").is_file(), "失败时不动源目录");

            // 类型不受支持
            let app = root.join("app");
            fs::create_dir_all(&app).unwrap();
            fs::write(
                app.join("project.json"),
                br#"{"type":"application","file":"a.exe"}"#,
            )
            .unwrap();
            fs::write(app.join("a.exe"), b"MZ").unwrap();
            assert!(postprocess(&app, Some(&dest), true).await.is_err());
            assert!(app.join("a.exe").is_file());
            assert!(!is_importable_wpe_dir(&app));
            assert!(!is_importable_wpe_dir(&plain));
            assert!(!dest.exists() || fs::read_dir(&dest).unwrap().count() == 0);
        }

        /// 存量 WPE 视频行的 hash 是入口文件哈希，普通下载可能按哈希命中它：
        /// 只补画册 / 计数，不能把它的 plugin_id / metadata_id 改成下载插件的。
        #[tokio::test]
        async fn plain_download_hitting_wpe_row_keeps_its_identity() {
            let _guard = guard();
            let _dedup = DedupGuard::set(true, true);
            let (_temp, root) = temp_root();

            let mut png = std::io::Cursor::new(Vec::new());
            let color = uuid::Uuid::new_v4().into_bytes();
            image::RgbImage::from_fn(4, 4, |x, y| {
                image::Rgb([color[(x + y) as usize], color[5], color[9]])
            })
            .write_to(&mut png, image::ImageFormat::Png)
            .unwrap();
            let png = png.into_inner();
            let hash = crate::crawler::downloader::compute_bytes_hash(&png);

            let storage = Storage::global();
            let wpe_metadata = storage
                .insert_metadata_row(
                    &json!({ "title": "legacy" }),
                    WPE_IMPORT_PLUGIN_ID,
                    0,
                    None,
                    None,
                )
                .unwrap();
            let legacy = storage
                .add_image(ImageInfo {
                    id: String::new(),
                    url: None,
                    local_path: root.join("legacy-wpe").to_string_lossy().into_owned(),
                    plugin_id: Some(WPE_IMPORT_PLUGIN_ID.to_string()),
                    task_id: None,
                    surf_record_id: None,
                    crawled_at: 1,
                    metadata_id: Some(wpe_metadata),
                    image_metadata_id: None,
                    thumbnail_path: String::new(),
                    favorite: false,
                    is_hidden: false,
                    local_exists: true,
                    hash,
                    width: None,
                    height: None,
                    display_name: "legacy".to_string(),
                    media_type: Some("x-wpe/video".to_string()),
                    last_set_wallpaper_at: None,
                    size: Some(1),
                    album_order: None,
                    compatible_path: None,
                    post_url: None,
                    palette: None,
                })
                .unwrap();

            let download_metadata = storage
                .insert_metadata_row(
                    &json!({ "from": "download" }),
                    "other-plugin",
                    1,
                    None,
                    None,
                )
                .unwrap();
            let output = root.join("downloads");
            let imported = postprocess_downloaded_image(
                &DownloadQueue::new(),
                next_download_id(),
                PostprocessSource::Bytes {
                    output_dir: &output,
                    bytes: &png,
                },
                false,
                &Url::parse("https://example.com/legacy.png").unwrap(),
                "other-plugin",
                None,
                None,
                None,
                0,
                None,
                &HashMap::new(),
                None,
                Some(download_metadata),
                Some("https://example.com/post"),
                &[],
            )
            .await;
            assert_eq!(imported, Ok(false), "按哈希命中已有行");

            let after = Storage::find_image_by_id(&legacy.id).unwrap().unwrap();
            assert_eq!(after.plugin_id.as_deref(), Some(WPE_IMPORT_PLUGIN_ID));
            assert_eq!(after.metadata_id, Some(wpe_metadata));
            assert_eq!(after.post_url, None);
        }

        /// 某一行的 `palette` 列与它的距离行（按色桶 rgb 排）。
        fn color_state(where_sql: &str, arg: &str) -> (Option<String>, Vec<(i64, i64)>) {
            let conn = Storage::global().db.lock().unwrap();
            let (id, palette): (i64, Option<String>) = conn
                .query_row(
                    &format!("SELECT id, palette FROM images WHERE {where_sql}"),
                    [arg],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .unwrap();
            let mut stmt = conn
                .prepare(
                    "SELECT bucket_rgb, distance FROM image_color_distances
                      WHERE image_id = ?1 ORDER BY bucket_rgb",
                )
                .unwrap();
            let rows = stmt
                .query_map([id], |row| Ok((row.get(0)?, row.get(1)?)))
                .unwrap()
                .collect::<Result<_, _>>()
                .unwrap();
            (palette, rows)
        }

        fn set_project(dir: &Path, project: serde_json::Value) {
            fs::write(
                dir.join("project.json"),
                serde_json::to_vec(&project).unwrap(),
            )
            .unwrap();
        }

        /// 网页壁纸的色盘：有 `schemecolor` 取它；没有则用预览图算；预览图也解不了就没有色盘。
        /// 三种情况都对每个色桶各有一行距离。
        #[tokio::test]
        async fn wpe_rows_take_scheme_color_then_preview_then_nothing() {
            use crate::media::palette::{Palette, NO_PALETTE_DISTANCE};

            let _guard = guard();
            let _dedup = DedupGuard::set(true, true);
            let (_temp, root) = temp_root();

            // ① 作者的 schemecolor（纯蓝）；预览图是坏的也不影响
            let scheme = web_wallpaper(&root, "scheme", "有代表色", &unique("scheme"));
            set_project(
                &scheme,
                json!({
                    "type": "web", "file": "index.html", "title": "有代表色",
                    "preview": "preview.jpg",
                    "general": { "properties": {
                        "schemecolor": { "type": "color", "value": "0 0 1" }
                    }},
                }),
            );
            assert_eq!(postprocess(&scheme, None, false).await, Ok(true));
            let (palette, rows) = color_state("local_path = ?1", &scheme.to_string_lossy());
            assert_eq!(palette, Some(Palette::single([0, 0, 255]).to_json()));
            assert_eq!(rows.len(), 12);
            assert!(rows.contains(&(0x0000ff, 0)), "{rows:?}");

            // ② 没有 schemecolor：用预览图（纯红）
            let preview = web_wallpaper(&root, "preview", "看预览图", &unique("preview"));
            fs::remove_file(preview.join("preview.jpg")).unwrap();
            image::RgbImage::from_pixel(32, 32, image::Rgb([255, 0, 0]))
                .save(preview.join("preview.png"))
                .unwrap();
            set_project(
                &preview,
                json!({
                    "type": "web", "file": "index.html", "title": "看预览图",
                    "preview": "preview.png",
                }),
            );
            assert_eq!(postprocess(&preview, None, false).await, Ok(true));
            let (palette, rows) = color_state("local_path = ?1", &preview.to_string_lossy());
            assert_eq!(palette, Some(Palette::single([255, 0, 0]).to_json()));
            assert!(rows.contains(&(0xff0000, 0)), "{rows:?}");

            // ③ 预览图解不了：没有色盘，距离全是 65536，照常入库
            let bare = web_wallpaper(&root, "bare", "没有色盘", &unique("bare"));
            assert_eq!(postprocess(&bare, None, false).await, Ok(true));
            let (palette, rows) = color_state("local_path = ?1", &bare.to_string_lossy());
            assert_eq!(palette, None);
            assert_eq!(rows.len(), 12);
            assert!(rows
                .iter()
                .all(|(_, distance)| *distance == i64::from(NO_PALETTE_DISTANCE)));
        }

        /// 普通下载（字节来源）入库时带着色盘与距离行。
        #[tokio::test]
        async fn plain_download_gets_palette_and_distances() {
            use crate::media::palette::Palette;

            let _guard = guard();
            // 关掉去重：内容固定的测试图不会被别的用例的同哈希行挡住
            let _dedup = DedupGuard::set(false, false);
            let (_temp, root) = temp_root();

            let mut png = std::io::Cursor::new(Vec::new());
            image::RgbImage::from_pixel(32, 32, image::Rgb([200, 30, 40]))
                .write_to(&mut png, image::ImageFormat::Png)
                .unwrap();
            let png = png.into_inner();
            let url = format!("https://example.com/{}.png", unique("palette"));

            let imported = postprocess_downloaded_image(
                &DownloadQueue::new(),
                next_download_id(),
                PostprocessSource::Bytes {
                    output_dir: &root.join("downloads"),
                    bytes: &png,
                },
                false,
                &Url::parse(&url).unwrap(),
                "other-plugin",
                None,
                None,
                None,
                0,
                None,
                &HashMap::new(),
                None,
                None,
                None,
                &[],
            )
            .await;
            assert_eq!(imported, Ok(true));

            let (palette, rows) = color_state("url = ?1", &url);
            let palette = Palette::from_json(&palette.expect("下载的图有色盘")).unwrap();
            assert_eq!(palette.0.len(), 1, "{palette:?}");
            assert_eq!(palette.0[0].percent, 100);
            let rgb = palette.0[0].rgb;
            for (shift, expected) in [(16, 200i64), (8, 30), (0, 40)] {
                let channel = i64::from((rgb >> shift) & 0xff);
                assert!((channel - expected).abs() <= 3, "{rgb:06x}");
            }
            assert_eq!(rows.len(), 12);
            let nearest = rows.iter().min_by_key(|(_, distance)| *distance).unwrap();
            assert_eq!(nearest.0, 0xff0000, "偏红的图离红桶最近: {rows:?}");
        }
    }
}
