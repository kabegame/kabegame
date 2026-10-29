//! 内建 `wpe-import` 任务：把 Wallpaper Engine 壁纸目录原地引用入库。
//!
//! 入库 `video` 与 `web` 两类：`local_path` 存壁纸目录本身，`type` 为 `x-wpe/video` /
//! `x-wpe/web`，缩略图直接引用 WPE 自带的 `preview.*`。
//!
//! - 视频行的 `compatible_path` 始终有值：浏览器能播时就是入口视频本身，不能播时才在
//!   `compatibles_dir` 生成兼容副本；所有播放端（预览、应用背景、壁纸窗口）统一走 `/compatible`。
//! - 网页行没有可播放媒体，`compatible_path` 留空、宽高留空；`hash` / `size` 取入口 html。
//!   页面经本地 HTTP 服务的 `/wpe/<id>/` 按原目录加载。
//!
//! 不复制、不转码、不改写用户目录里的任何文件。

use std::collections::HashMap;
use std::sync::Arc;

use serde_json::json;

use crate::crawler::downloader::compute_file_hash;
use crate::crawler::task_log_i18n::task_log_i18n;
use crate::crawler::task_scheduler::Task;
use crate::emitter::GlobalEmitter;
use crate::storage::image_events::emit_membership_added;
use crate::storage::labels::{validate_labels, LabelInput};
use crate::storage::{ImageInfo, Storage};
use crate::wpe::discover::WpeRootKind;
use crate::wpe::project::{read_project, WpeKind, WpeProject, WpeSkip};
use crate::wpe::scan::collect_selected_dirs;
use crate::wpe::normalize_local_dir;

/// 内建任务 / 插件 id。
pub use crate::wpe::WPE_IMPORT_PLUGIN_ID;

/// 壁纸标签画册的分类段：`WPE/<tag>`。
pub const WPE_LABEL_CATEGORY: &str = "WPE";

fn emit_log(task_id: &str, level: &str, key: &str, params: serde_json::Value) {
    GlobalEmitter::global().emit_task_log(task_id, level, &task_log_i18n(key, params));
}

/// 解析勾选的来源。缺省（未传 `sources`）时三类全选；`extraDirs` 单独走扩展键。
fn parse_sources(config: &HashMap<String, serde_json::Value>) -> Vec<WpeRootKind> {
    let Some(sources) = config.get("sources").and_then(|value| value.as_object()) else {
        return WpeRootKind::ALL.to_vec();
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

/// 把 `project.json` 的 `tags` 转成 `WPE/<tag>` 标签并挂到图片上。
fn apply_wpe_tags(task_id: &str, project: &WpeProject, image_id: &str) {
    if project.tags.is_empty() {
        return;
    }
    let inputs: Vec<LabelInput> = project
        .tags
        .iter()
        .map(|tag| LabelInput {
            key: Some(tag.clone()),
            category: Some(WPE_LABEL_CATEGORY.to_string()),
            name: None,
        })
        .collect();
    let (specs, rejected) = validate_labels(&inputs, WPE_IMPORT_PLUGIN_ID);
    for (index, reason) in rejected {
        let tag = project.tags.get(index).cloned().unwrap_or_default();
        emit_log(
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
                emit_log(
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
            emit_log(
                task_id,
                "warn",
                "taskLogLabelAttachFailed",
                json!({ "detail": error }),
            );
        }
    }
}

fn join_album(task_id: &str, album_id: Option<&str>, image_id: &str) -> Result<(), String> {
    let Some(album_id) = album_id.map(str::trim).filter(|id| !id.is_empty()) else {
        return Ok(());
    };
    let storage = Storage::global();
    let added = storage.add_images_to_album_silent(album_id, &[image_id.to_string()]);
    if added > 0 {
        emit_membership_added(album_id, &[image_id.to_string()])?;
    }
    let _ = task_id;
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ImportOutcome {
    Imported,
    Existing,
}

/// 规范化成入库用的绝对路径字符串（去掉 Windows `\\?\` 前缀）。
fn canonical_string(path: &std::path::Path) -> String {
    path.canonicalize()
        .ok()
        .map(|path| path.to_string_lossy().trim_start_matches("\\\\?\\").to_string())
        .unwrap_or_else(|| path.to_string_lossy().into_owned())
}

/// 计算 WPE 视频行的 `compatible_path`：浏览器能播就是入口视频本身；解不了的编码在
/// `compatibles_dir` 生成兼容副本，生成失败仍回落到入口视频，保证字段始终有值。
async fn resolve_compatible_path(
    task_id: &str,
    entry: &std::path::Path,
    probe: Option<&crate::media::dimensions::MediaProbeResult>,
    dir_string: &str,
) -> String {
    #[cfg(not(target_os = "android"))]
    if let Some(probe) = probe.filter(|probe| !probe.browser_safe) {
        match crate::crawler::downloader::generate_compatible_video(entry, probe).await {
            Ok(Some(path)) => return canonical_string(&path),
            Ok(None) => {}
            Err(error) => emit_log(
                task_id,
                "warn",
                "taskLogWpeCompatibleFailed",
                json!({ "path": dir_string, "detail": error }),
            ),
        }
    }
    #[cfg(target_os = "android")]
    let _ = (task_id, probe, dir_string);
    canonical_string(entry)
}

/// 已入库行的 `compatible_path` 为空或文件已不在时补上（早期导入只在不可播时才写）。
async fn backfill_compatible_path(
    task_id: &str,
    existing: &ImageInfo,
    entry: &std::path::Path,
    dir_string: &str,
) {
    let current = existing.compatible_path.as_deref().map(str::trim).unwrap_or("");
    if !current.is_empty() && std::path::Path::new(current).is_file() {
        return;
    }
    let probe = crate::media::dimensions::probe_media_sync(entry);
    let path = resolve_compatible_path(task_id, entry, probe.as_ref(), dir_string).await;
    if let Err(error) = Storage::global().replace_image_compatible_path(&existing.id, &path) {
        tracing::warn!("compatible_path backfill failed for {}: {error}", existing.id);
        return;
    }
    GlobalEmitter::global().emit_image_fields(
        std::slice::from_ref(&existing.id),
        json!({ "compatiblePath": path }),
    );
}

/// 视频 / 网页两类壁纸共用的行组装：来源字段、作者预览图、创意工坊链接与 metadata。
/// 调用方各自覆盖 `media_type` / `width` / `height` / `compatible_path`。
fn base_image_info(
    project: &WpeProject,
    task_id: &str,
    metadata_id: i64,
    hash: String,
    size: Option<u64>,
) -> ImageInfo {
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
    ImageInfo {
        id: String::new(),
        url: workshop_url.clone(),
        local_path: project.dir_string(),
        plugin_id: Some(WPE_IMPORT_PLUGIN_ID.to_string()),
        task_id: Some(task_id.to_string()),
        surf_record_id: None,
        crawled_at,
        metadata_id: Some(metadata_id),
        image_metadata_id: None,
        thumbnail_path,
        favorite: false,
        is_hidden: false,
        local_exists: true,
        hash,
        width: None,
        height: None,
        display_name: project.title.clone(),
        media_type: None,
        last_set_wallpaper_at: None,
        size,
        album_order: None,
        compatible_path: None,
        post_url: workshop_url,
    }
}

/// 写库、广播、挂画册与标签、记日志：两类壁纸新增行之后的公共步骤。
fn finish_insert(
    task_id: &str,
    project: &WpeProject,
    album_id: Option<&str>,
    image: ImageInfo,
) -> Result<ImportOutcome, String> {
    let inserted = Storage::global().add_image(image)?;
    let image_id = inserted.id.clone();
    GlobalEmitter::global().emit_images_added(std::slice::from_ref(&inserted));

    join_album(task_id, album_id, &image_id)?;
    apply_wpe_tags(task_id, project, &image_id);

    emit_log(
        task_id,
        "info",
        "taskLogWpeImported",
        json!({ "title": project.title, "path": project.dir_string() }),
    );

    Ok(ImportOutcome::Imported)
}

fn insert_project_metadata(project: &WpeProject) -> Result<i64, String> {
    Storage::global()
        .insert_metadata_row(&project.raw, WPE_IMPORT_PLUGIN_ID, 0, None, None)
        .map_err(|e| format!("写入 metadata 失败：{e}"))
}

/// 导入一个视频壁纸目录（幂等：已入库只补画册成员与缺失的 `compatible_path`）。
async fn import_wpe_video(
    task_id: &str,
    project: &WpeProject,
    album_id: Option<&str>,
) -> Result<ImportOutcome, String> {
    let dir_string = project.dir_string();

    let entry = project
        .entry_path()
        .ok_or_else(|| "缺少入口文件".to_string())?;

    if let Some(existing) = Storage::find_image_by_path(&dir_string).map_err(|e| e.to_string())? {
        backfill_compatible_path(task_id, &existing, &entry, &dir_string).await;
        join_album(task_id, album_id, &existing.id)?;
        return Ok(ImportOutcome::Existing);
    }

    let hash = compute_file_hash(&entry).await?;
    let probe = crate::media::dimensions::probe_media_sync(&entry);
    let (width, height) = probe
        .as_ref()
        .map(|probe| (Some(probe.width), Some(probe.height)))
        .unwrap_or((None, None));
    let size = std::fs::metadata(&entry).ok().map(|meta| meta.len());

    let compatible_path = Some(resolve_compatible_path(task_id, &entry, probe.as_ref(), &dir_string).await);
    let metadata_id = insert_project_metadata(project)?;

    let image = ImageInfo {
        width,
        height,
        media_type: Some("x-wpe/video".to_string()),
        compatible_path,
        ..base_image_info(project, task_id, metadata_id, hash, size)
    };
    finish_insert(task_id, project, album_id, image)
}

/// 导入一个网页壁纸目录（幂等：已入库只补画册成员）。页面没有可播放媒体，
/// `compatible_path` 留空；页面没有固有尺寸，宽高留空。
async fn import_wpe_web(
    task_id: &str,
    project: &WpeProject,
    album_id: Option<&str>,
) -> Result<ImportOutcome, String> {
    let dir_string = project.dir_string();
    let entry = project
        .entry_path()
        .filter(|path| path.is_file())
        .ok_or_else(|| "缺少入口文件".to_string())?;

    if let Some(existing) = Storage::find_image_by_path(&dir_string).map_err(|e| e.to_string())? {
        join_album(task_id, album_id, &existing.id)?;
        return Ok(ImportOutcome::Existing);
    }

    let hash = compute_file_hash(&entry).await?;
    let size = std::fs::metadata(&entry).ok().map(|meta| meta.len());
    let metadata_id = insert_project_metadata(project)?;

    let image = ImageInfo {
        media_type: Some("x-wpe/web".to_string()),
        ..base_image_info(project, task_id, metadata_id, hash, size)
    };
    finish_insert(task_id, project, album_id, image)
}

/// 按类型分派到对应的导入函数；调用方保证 `project.kind.is_supported()`。
async fn import_wpe_project(
    task_id: &str,
    project: &WpeProject,
    album_id: Option<&str>,
) -> Result<ImportOutcome, String> {
    match project.kind {
        WpeKind::Video => import_wpe_video(task_id, project, album_id).await,
        WpeKind::Web => import_wpe_web(task_id, project, album_id).await,
        kind => Err(format!("暂不支持的壁纸类型：{}", kind.as_str())),
    }
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
                    match import_wpe_project(&task_id, project, run.params.output_album_id.as_deref())
                        .await
                    {
                        Ok(ImportOutcome::Imported) => imported += 1,
                        Ok(ImportOutcome::Existing) => {
                            already += 1;
                            emit_log(
                                &task_id,
                                "warn",
                                "taskLogWpeExisting",
                                json!({ "path": project.dir_string() }),
                            );
                        }
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

        // 已入库的目录在文件系统层面无需再做任何事；各 import 函数内部按 local_path 幂等。
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
