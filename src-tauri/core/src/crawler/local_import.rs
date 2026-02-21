//! Built-in local import routine. Runs when plugin_id == "本地导入".
//! Streams over URLs (file:// on desktop, content:// on Android): each image is enqueued
//! to the download queue immediately; archives are enqueued as decompression jobs.
//!
//! On desktop, paths are converted to file:// URLs and processed via fs::metadata/read_dir.
//! On Android, content:// URIs are processed via ContentIoProvider (listContentChildren,
//! isDirectory, getMimeType).

#[cfg(target_os = "android")]
use crate::crawler::content_io::get_content_io_provider;
use crate::crawler::decompression::DecompressionJob;
use crate::crawler::downloader::DownloadQueue;
use crate::emitter::GlobalEmitter;
use crate::image_type;
use crate::settings::Settings;
use crate::storage::Storage;
use serde_json::Value;
use std::collections::HashMap;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::fs;
use url::Url;

const PLUGIN_ID: &'static str = "本地导入";

/// 按已入队数量计算并上报本地导入进度（0..99），避免结束前一直为 0。完成后由调用方发 100。
fn emit_local_import_progress(task_id: &str, image_count: usize, archive_count: usize) {
    let n = image_count + archive_count;
    let pct = if n == 0 {
        0.0
    } else {
        (n as f64 * 2.0).min(99.0) // 每项约 2%，上限 99
    };
    GlobalEmitter::global().emit_task_progress(task_id, pct);
}

/// On macOS, map permission-denied (EPERM) to a user-friendly message with drag-drop hint and System Settings instructions.
fn map_io_error_for_user(e: io::Error, context: &str) -> String {
    #[cfg(target_os = "macos")]
    {
        let is_permission_denied = e.kind() == io::ErrorKind::PermissionDenied
            || e.raw_os_error() == Some(1); // EPERM
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
async fn process_url(
    url: &Url,
    ctx: &LocalImportContext<'_>,
    image_count: &mut usize,
    archive_count: &mut usize,
) -> Result<(), String> {
    if ctx.download_queue.is_task_canceled(ctx.task_id).await {
        return Err("Task canceled".to_string());
    }

    #[cfg(target_os = "android")]
    if url.scheme() == "content" {
        return process_content_url(url, ctx, image_count, archive_count).await;
    }

    // file:// 或桌面：转 Path 处理
    let path = url
        .to_file_path()
        .map_err(|_| format!("Invalid file URL: {}", url))?;
    process_path(path.as_path(), ctx, image_count, archive_count).await
}

#[cfg(target_os = "android")]
async fn process_content_url(
    url: &Url,
    ctx: &LocalImportContext<'_>,
    image_count: &mut usize,
    archive_count: &mut usize,
) -> Result<(), String> {
    let uri = url.as_str();
    let io = get_content_io_provider()
        .ok_or_else(|| "Android ContentIoProvider 未注册".to_string())?;

    let is_dir = io.is_directory(uri)?;
    if is_dir {
        let children = io.list_children(uri)?;
        for child in children {
            if ctx.download_queue.is_task_canceled(ctx.task_id).await {
                return Err("Task canceled".to_string());
            }
            let child_url = Url::parse(&child.uri).map_err(|e| format!("Invalid child URI: {}", e))?;
            if child.is_directory {
                if ctx.recursive {
                    Box::pin(process_url(&child_url, ctx, image_count, archive_count)).await?;
                }
            } else {
                process_file_url(&child_url, ctx, image_count, archive_count).await?;
            }
        }
    } else {
        process_file_url(url, ctx, image_count, archive_count).await?;
    }
    Ok(())
}

/// 桌面：流式遍历 Path，遇到图片入队下载，遇到压缩包入队解压。
async fn process_path(
    path: &Path,
    ctx: &LocalImportContext<'_>,
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
            if entry_meta.is_dir() {
                if ctx.recursive {
                    Box::pin(process_path(&p, ctx, image_count, archive_count)).await?;
                }
            } else if entry_meta.is_file() {
                let url = Url::from_file_path(&p)
                    .map_err(|_| format!("Invalid path: {}", p.display()))?;
                process_file_url(&url, ctx, image_count, archive_count).await?;
            }
        }
        return Ok(());
    }
    if meta.is_file() {
        let url = Url::from_file_path(path)
            .map_err(|_| format!("Invalid path: {}", path.display()))?;
        process_file_url(&url, ctx, image_count, archive_count).await?;
    }
    Ok(())
}

/// 处理单个文件 URL：图片入队下载，压缩包入队解压。
async fn process_file_url(
    url: &Url,
    ctx: &LocalImportContext<'_>,
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
    if image_type::is_image_by_path(&path) {
        enqueue_image(url.clone(), ctx, image_count, archive_count).await?;
        return Ok(());
    }
    if crate::archive::is_archive_by_path(&path) && ctx.include_archive {
        if crate::archive::get_processor_by_path(&path).is_none() {
            return Err(format!("不支持的压缩格式: {}", path.display()));
        }
        enqueue_archive(url.clone(), ctx, image_count, archive_count).await?;
    }
    Ok(())
}

#[cfg(target_os = "android")]
async fn process_content_file_url(
    url: &Url,
    ctx: &LocalImportContext<'_>,
    image_count: &mut usize,
    archive_count: &mut usize,
) -> Result<(), String> {
    let uri = url.as_str();
    let io = get_content_io_provider()
        .ok_or_else(|| "Android ContentIoProvider 未注册".to_string())?;

    let mime = io.get_mime_type(uri)?;
    if image_type::is_image_mime(&mime) {
        enqueue_image(url.clone(), ctx, image_count, archive_count).await?;
        return Ok(());
    }
    if image_type::is_archive_mime(&mime) && ctx.include_archive {
        enqueue_archive(url.clone(), ctx, image_count, archive_count).await?;
    }
    Ok(())
}

async fn enqueue_image(
    url: Url,
    ctx: &LocalImportContext<'_>,
    image_count: &mut usize,
    archive_count: &usize,
) -> Result<(), String> {
    match ctx
        .download_queue
        .download_image(
            url.clone(),
            ctx.images_dir.clone(),
            PLUGIN_ID.to_string(),
            ctx.task_id.to_string(),
            ctx.download_start_time,
            ctx.output_album_id.clone(),
            HashMap::new(),
        )
        .await
    {
        Ok(()) => {
            *image_count += 1;
            emit_local_import_progress(ctx.task_id, *image_count, *archive_count);
        }
        Err(e) => {
            GlobalEmitter::global().emit_task_log(
                ctx.task_id,
                "warn",
                &format!("入队失败 {}: {}", url, e),
            );
        }
    }
    Ok(())
}

async fn enqueue_archive(
    url: Url,
    ctx: &LocalImportContext<'_>,
    image_count: &usize,
    archive_count: &mut usize,
) -> Result<(), String> {
    let job = DecompressionJob {
        archive_url: url,
        images_dir: ctx.images_dir.clone(),
        task_id: ctx.task_id.to_string(),
        plugin_id: PLUGIN_ID.to_string(),
        download_start_time: ctx.download_start_time,
        output_album_id: ctx.output_album_id.clone(),
        http_headers: HashMap::new(),
    };
    let (lock, notify) = &*ctx.download_queue.decompression_queue;
    let mut queue = lock.lock().await;
    queue.push_back(job);
    notify.notify_waiters();
    *archive_count += 1;
    emit_local_import_progress(ctx.task_id, *image_count, *archive_count);
    Ok(())
}

struct LocalImportContext<'a> {
    task_id: &'a str,
    images_dir: PathBuf,
    download_start_time: u64,
    output_album_id: Option<String>,
    download_queue: &'a DownloadQueue,
    recursive: bool,
    include_archive: bool,
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
        match Settings::global().get_default_download_dir().await {
            Ok(Some(dir)) => PathBuf::from(dir),
            _ => storage.get_images_dir(),
        }
    };

    let download_start_time = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;

    let ctx = LocalImportContext {
        task_id,
        images_dir,
        download_start_time,
        output_album_id: output_album_id.clone(),
        download_queue,
        recursive,
        include_archive,
    };

    GlobalEmitter::global().emit_task_log(
        task_id,
        "info",
        &format!("本地导入: 开始流式遍历 {} 个路径...", paths.len()),
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
            let path = fs::canonicalize(&path).await.map_err(|e| {
                map_io_error_for_user(e, &format!("无法解析路径 {}", path_str))
            })?;
            Url::from_file_path(&path).map_err(|_| format!("Invalid path: {}", path_str))?
        };

        process_url(&url, &ctx, &mut image_count, &mut archive_count).await?;
    }

    GlobalEmitter::global().emit_task_progress(task_id, 100.0);
    GlobalEmitter::global().emit_task_log(
        task_id,
        "info",
        &format!(
            "本地导入: 已添加 {} 个下载任务、{} 个压缩包到队列",
            image_count, archive_count
        ),
    );

    Ok(())
}
