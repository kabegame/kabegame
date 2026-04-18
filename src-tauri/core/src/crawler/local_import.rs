//! Built-in local import routine. Runs when plugin_id == "local-import".
//! Streams over URLs (file:// on desktop, content:// on Android): each image is enqueued
//! to the download queue immediately; archives are enqueued as decompression jobs.
//!
//! On desktop, paths are converted to file:// URLs and processed via fs::metadata/read_dir.
//! On Android, content:// URIs are processed via ContentIoProvider (listContentChildren,
//! isDirectory, getMimeType).

use crate::crawler::archiver::ArchiveProcessor;
#[cfg(target_os = "android")]
use crate::crawler::content_io::get_content_io_provider;
use crate::crawler::downloader::DownloadQueue;
use crate::crawler::task_log_i18n::task_log_i18n;
use crate::emitter::GlobalEmitter;
use crate::image_type;
use crate::settings::Settings;
use crate::storage::Storage;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::fs;
use url::Url;

const PLUGIN_ID: &'static str = "local-import";

/// 将当前路径/文件对应的进度份额累加并上报。每个子文件夹和子文件在递归中均分父级份额，完成一项即增加相应百分比。
fn add_progress_and_emit(ctx: &mut LocalImportContext<'_>, share: f64) {
    *ctx.progress = (*ctx.progress + share).min(99.9);
    GlobalEmitter::global().emit_task_progress(ctx.task_id, *ctx.progress);
}

/// On macOS, map permission-denied (EPERM) to a user-friendly message with drag-drop hint and System Settings instructions.
fn map_io_error_for_user(e: io::Error, context: &str) -> String {
    #[cfg(target_os = "macos")]
    {
        let is_permission_denied =
            e.kind() == io::ErrorKind::PermissionDenied || e.raw_os_error() == Some(1); // EPERM
        if is_permission_denied {
            return format!(
                "无法访问该路径（权限不足）。\n\n\
                在 macOS 上，「图片」「桌面」「文稿」「下载」等为受保护文件夹。\
                拖拽导入可能无法访问这些目录，请改用「添加文件夹」按钮，通过系统选择器重新选择。\n\n\
                若仍无法访问，请前往 系统设置 → 隐私与安全性 → 文件与文件夹，为 Kabegame 开启对应目录的访问权限。\n\n\
                原始错误：{}",
                e
            );
        }
    }
    format!("{}: {}", context, e)
}

/// 流式遍历并处理 URL：content:// 用 ContentIoProvider，file:// 转 Path 用 fs。
/// `share` 为本路径在本次任务中应占的总进度百分比（0..100），完成本路径后累加该份额。
async fn process_url(
    url: &Url,
    ctx: &mut LocalImportContext<'_>,
    share: f64,
    image_count: &mut usize,
    archive_count: &mut usize,
) -> Result<(), String> {
    if ctx.download_queue.is_task_canceled(ctx.task_id).await {
        return Err("Task canceled".to_string());
    }

    #[cfg(target_os = "android")]
    if url.scheme() == "content" {
        return process_content_url(url, ctx, share, image_count, archive_count).await;
    }

    // file:// 或桌面：转 Path 处理
    let path = url
        .to_file_path()
        .map_err(|_| format!("Invalid file URL: {}", url))?;
    process_path(path.as_path(), ctx, share, image_count, archive_count).await
}

#[cfg(target_os = "android")]
async fn process_content_url(
    url: &Url,
    ctx: &mut LocalImportContext<'_>,
    share: f64,
    image_count: &mut usize,
    archive_count: &mut usize,
) -> Result<(), String> {
    let uri = url.as_str();
    let io = get_content_io_provider();

    let is_dir = io.is_directory(uri).await?;
    if is_dir {
        let children = io.list_children(uri).await?;
        let n = children.len();
        if n == 0 {
            add_progress_and_emit(ctx, share);
            return Ok(());
        }
        let per_child = share / n as f64;
        for child in children {
            if ctx.download_queue.is_task_canceled(ctx.task_id).await {
                return Err("Task canceled".to_string());
            }
            let child_url =
                Url::parse(&child.uri).map_err(|e| format!("Invalid child URI: {}", e))?;
            if child.is_directory {
                if ctx.recursive {
                    Box::pin(process_url(
                        &child_url,
                        ctx,
                        per_child,
                        image_count,
                        archive_count,
                    ))
                    .await?;
                } else {
                    add_progress_and_emit(ctx, per_child);
                }
            } else {
                process_file_url(&child_url, ctx, image_count, archive_count).await?;
                add_progress_and_emit(ctx, per_child);
            }
        }
    } else {
        process_file_url(url, ctx, image_count, archive_count).await?;
        add_progress_and_emit(ctx, share);
    }
    Ok(())
}

/// 桌面：流式遍历 Path，遇到图片入队下载，遇到压缩包入队解压。
/// `share` 为本路径在本次任务中应占的总进度百分比，完成本路径（或本目录下所有子项）后累加该份额。
async fn process_path(
    path: &Path,
    ctx: &mut LocalImportContext<'_>,
    share: f64,
    image_count: &mut usize,
    archive_count: &mut usize,
) -> Result<(), String> {
    if ctx.download_queue.is_task_canceled(ctx.task_id).await {
        return Err("Task canceled".to_string());
    }
    let meta = fs::metadata(path)
        .await
        .map_err(|e| map_io_error_for_user(e, "Failed to read path metadata"))?;
    if meta.is_dir() {
        let mut entries = fs::read_dir(path)
            .await
            .map_err(|e| map_io_error_for_user(e, "Failed to read directory"))?;
        let mut children: Vec<(PathBuf, bool)> = Vec::new();
        while let Some(entry) = entries
            .next_entry()
            .await
            .map_err(|e| map_io_error_for_user(e, "Failed to read directory entry"))?
        {
            let p = entry.path();
            let entry_meta = entry
                .metadata()
                .await
                .map_err(|e| map_io_error_for_user(e, "Failed to read entry metadata"))?;
            children.push((p, entry_meta.is_dir()));
        }
        let n = children.len();
        if n == 0 {
            add_progress_and_emit(ctx, share);
            return Ok(());
        }
        let per_child = share / n as f64;
        for (p, is_dir) in children {
            if ctx.download_queue.is_task_canceled(ctx.task_id).await {
                return Err("Task canceled".to_string());
            }
            if is_dir {
                if ctx.recursive {
                    Box::pin(process_path(&p, ctx, per_child, image_count, archive_count)).await?;
                } else {
                    add_progress_and_emit(ctx, per_child);
                }
            } else {
                let url = Url::from_file_path(&p)
                    .map_err(|_| format!("Invalid path: {}", p.display()))?;
                process_file_url(&url, ctx, image_count, archive_count).await?;
                add_progress_and_emit(ctx, per_child);
            }
        }
        return Ok(());
    }
    if meta.is_file() {
        let url =
            Url::from_file_path(path).map_err(|_| format!("Invalid path: {}", path.display()))?;
        process_file_url(&url, ctx, image_count, archive_count).await?;
        add_progress_and_emit(ctx, share);
    }
    Ok(())
}

/// 处理单个文件 URL：图片入队下载，压缩包入队解压。
async fn process_file_url(
    url: &Url,
    ctx: &mut LocalImportContext<'_>,
    image_count: &mut usize,
    archive_count: &mut usize,
) -> Result<(), String> {
    #[cfg(target_os = "android")]
    if url.scheme() == "content" {
        return process_content_file_url(url, ctx, image_count, archive_count).await;
    }

    // file://：用 path 判断类型
    let path = url
        .to_file_path()
        .map_err(|_| format!("Invalid file URL: {}", url))?;
    if image_type::is_media_by_path(&path) {
        enqueue_image(url.clone(), ctx, image_count).await?;
        return Ok(());
    }
    if crate::archive::is_archive_by_path(&path) && ctx.include_archive {
        if crate::archive::get_processor_by_path(&path).is_none() {
            return Err(format!("不支持的压缩格式: {}", path.display()));
        }
        enqueue_archive(url.clone(), ctx, archive_count, None).await?;
    }
    Ok(())
}

#[cfg(target_os = "android")]
async fn process_content_file_url(
    url: &Url,
    ctx: &mut LocalImportContext<'_>,
    image_count: &mut usize,
    archive_count: &mut usize,
) -> Result<(), String> {
    let uri = url.as_str();
    let io = get_content_io_provider();

    let mime = io.get_mime_type(uri).await?;
    if image_type::is_image_mime(&mime) || image_type::is_video_mime(&mime) {
        enqueue_image(url.clone(), ctx, image_count).await?;
        return Ok(());
    }
    if image_type::is_archive_mime(&mime) && ctx.include_archive {
        enqueue_archive(url.clone(), ctx, archive_count, mime.as_deref()).await?;
    }
    Ok(())
}

async fn enqueue_image(
    url: Url,
    ctx: &mut LocalImportContext<'_>,
    image_count: &mut usize,
) -> Result<(), String> {
    let download_start_time = ctx.next_download_start_time();
    match ctx
        .download_queue
        .download_image(
            url.clone(),
            ctx.images_dir.clone(),
            PLUGIN_ID.to_string(),
            ctx.task_id.to_string(),
            download_start_time,
            ctx.output_album_id.clone(),
            HashMap::new(),
            None,
            None,
            None,
        )
        .await
    {
        Ok(()) => {
            *image_count += 1;
        }
        Err(e) => {
            GlobalEmitter::global().emit_task_log(
                ctx.task_id,
                "warn",
                &task_log_i18n(
                    "taskLogEnqueueFailed",
                    json!({ "url": url.as_str(), "detail": e.to_string() }),
                ),
            );
        }
    }
    Ok(())
}

async fn enqueue_archive(
    url: Url,
    ctx: &mut LocalImportContext<'_>,
    archive_count: &mut usize,
    mime: Option<&str>,
) -> Result<(), String> {
    // 获取对应的 processor，解压到固定目录（Android 内部私有目录 / 桌面临时目录）
    let processor = crate::crawler::archiver::get_processor_by_url(&url, mime);
    let extract_base = crate::app_paths::AppPaths::global()
        .temp_dir
        .join("archive_extract");
    if let Err(e) = tokio::fs::create_dir_all(&extract_base).await {
        return Err(format!("Failed to create archive extract dir: {}", e));
    }

    if let Some(proc) = processor {
        match proc.process(&url, &extract_base).await {
            Ok(extract_dir) => {
                // 解析压缩包名称
                let archive_name = crate::crawler::archiver::resolve_archive_name(&url).await;
                #[cfg(target_os = "android")]
                {
                    let source_dir = extract_dir.to_string_lossy().to_string();
                    let copy_result = get_content_io_provider()
                        .copy_extracted_images_to_pictures(&source_dir)
                        .await;
                    let _ = tokio::fs::remove_dir_all(&extract_dir).await;

                    let entries = copy_result.map_err(|e| {
                        format!("Failed to copy extracted images to Pictures: {}", e)
                    })?;
                    for (idx, entry) in entries.into_iter().enumerate() {
                        if ctx.download_queue.is_task_canceled(ctx.task_id).await {
                            return Err("Task canceled".to_string());
                        }

                        let img_url = Url::parse(&entry.content_uri)
                            .map_err(|e| format!("Invalid content URI from picker: {}", e))?;
                        match ctx
                            .download_queue
                            .download_image(
                                img_url.clone(),
                                ctx.images_dir.clone(),
                                PLUGIN_ID.to_string(),
                                ctx.task_id.to_string(),
                                ctx.next_download_start_time(),
                                ctx.output_album_id.clone(),
                                HashMap::new(),
                                None,
                                None,
                                None,
                            )
                            .await
                        {
                            Ok(()) => {}
                            Err(e) => {
                                GlobalEmitter::global().emit_task_log(
                                    ctx.task_id,
                                    "warn",
                                    &task_log_i18n(
                                        "taskLogEnqueueFailed",
                                        json!({
                                            "url": img_url.as_str(),
                                            "detail": e.to_string(),
                                        }),
                                    ),
                                );
                            }
                        }
                    }
                }

                #[cfg(not(target_os = "android"))]
                {
                    // 扁平复制图片到 images_dir 子文件夹并逐个入队
                    use crate::crawler::downloader::copy_extracted_images_and_enqueue;
                    let archive_download_start_time = ctx.next_download_start_time();
                    if let Err(e) = copy_extracted_images_and_enqueue(
                        &extract_dir,
                        &ctx.images_dir,
                        &archive_name,
                        ctx.download_queue,
                        ctx.task_id,
                        PLUGIN_ID,
                        archive_download_start_time,
                        &ctx.output_album_id,
                        &HashMap::new(),
                    )
                    .await
                    {
                        return Err(format!(
                            "Failed to copy and enqueue extracted images: {}",
                            e
                        ));
                    }
                }
                *archive_count += 1;
            }
            Err(e) => {
                return Err(format!("Decompression failed: {}", e));
            }
        }
    } else {
        return Err(format!("No processor found for archive: {}", url));
    }

    Ok(())
}

struct LocalImportContext<'a> {
    task_id: &'a str,
    progress: &'a mut f64,
    images_dir: PathBuf,
    last_download_start_time: &'a mut u64,
    output_album_id: Option<String>,
    download_queue: &'a DownloadQueue,
    recursive: bool,
    include_archive: bool,
}

impl LocalImportContext<'_> {
    fn next_download_start_time(&mut self) -> u64 {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        let next = if now <= *self.last_download_start_time {
            self.last_download_start_time.saturating_add(1)
        } else {
            now
        };
        *self.last_download_start_time = next;
        next
    }
}

pub async fn run_builtin_local_import(
    task_id: &str,
    user_config: Option<HashMap<String, Value>>,
    output_album_id: Option<String>,
    download_queue: &DownloadQueue,
) -> Result<(), String> {
    let cfg = user_config.unwrap_or_default();

    let paths: Vec<String> = cfg
        .get("paths")
        .and_then(|v| serde_json::from_value::<Vec<String>>(v.clone()).ok())
        .unwrap_or_default();

    let recursive = cfg
        .get("recursive")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);

    let include_archive = cfg
        .get("include_archive")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    if paths.is_empty() {
        return Err("未指定任何路径".to_string());
    }

    let images_dir = {
        let storage = Storage::global();
        match Settings::global().get_default_download_dir() {
            Some(dir) => PathBuf::from(dir),
            None => storage.get_images_dir(),
        }
    };

    let download_start_time = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;

    let mut progress = 0.0_f64;
    let share_per_path = 100.0 / paths.len() as f64;

    let mut last_download_start_time = download_start_time;
    let mut ctx = LocalImportContext {
        task_id,
        progress: &mut progress,
        images_dir,
        last_download_start_time: &mut last_download_start_time,
        output_album_id: output_album_id.clone(),
        download_queue,
        recursive,
        include_archive,
    };

    GlobalEmitter::global().emit_task_log(
        task_id,
        "info",
        &task_log_i18n(
            "taskLogLocalImportStreaming",
            json!({ "count": paths.len() }),
        ),
    );
    GlobalEmitter::global().emit_task_progress(task_id, 0.0);

    let mut image_count = 0usize;
    let mut archive_count = 0usize;

    for path_str in &paths {
        if download_queue.is_task_canceled(task_id).await {
            return Err("Task canceled".to_string());
        }

        let url = if path_str.starts_with("content://") {
            Url::parse(path_str).map_err(|e| format!("Invalid content URI: {}", e))?
        } else {
            let path = PathBuf::from(path_str);
            if !fs::try_exists(&path)
                .await
                .map_err(|e| map_io_error_for_user(e, "Failed to check path"))?
            {
                return Err(format!("路径不存在: {}", path_str));
            }
            let path = fs::canonicalize(&path)
                .await
                .map_err(|e| map_io_error_for_user(e, &format!("无法解析路径 {}", path_str)))?;
            Url::from_file_path(&path).map_err(|_| format!("Invalid path: {}", path_str))?
        };

        process_url(
            &url,
            &mut ctx,
            share_per_path,
            &mut image_count,
            &mut archive_count,
        )
        .await?;
    }

    GlobalEmitter::global().emit_task_progress(task_id, 100.0);
    GlobalEmitter::global().emit_task_log(
        task_id,
        "info",
        &task_log_i18n(
            "taskLogLocalImportEnqueuedSummary",
            json!({
                "downloads": image_count,
                "archives": archive_count,
            }),
        ),
    );

    Ok(())
}
