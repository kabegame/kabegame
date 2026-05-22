//! Built-in local import routine. Runs when plugin_id == "local-import".
//!
//! Local import walks file:// URLs on desktop and content:// URIs on Android, then
//! sends media directly into the downloader post-processing pipeline. It keeps task
//! progress/cancellation semantics, but no longer occupies DownloadQueue slots.

#[cfg(target_os = "android")]
use crate::crawler::content_io::get_content_io_provider;
use crate::crawler::downloader::DownloadQueue;
#[cfg(not(target_os = "android"))]
use crate::crawler::downloader::{build_safe_filename, unique_path};
use crate::crawler::task_log_i18n::task_log_i18n;
use crate::emitter::GlobalEmitter;
use crate::settings::Settings;
use crate::storage::Storage;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::fs;
use url::Url;

const PLUGIN_ID: &str = "local-import";

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

async fn fs_is_dir(url: &Url) -> Result<bool, String> {
    let path = url
        .to_file_path()
        .map_err(|_| format!("Invalid file URL: {}", url))?;
    let meta = fs::metadata(path)
        .await
        .map_err(|e| map_io_error_for_user(e, "Failed to read path metadata"))?;
    Ok(meta.is_dir())
}

async fn list_file_children(url: &Url) -> Result<Vec<Url>, String> {
    let path = url
        .to_file_path()
        .map_err(|_| format!("Invalid file URL: {}", url))?;
    let mut entries = fs::read_dir(path)
        .await
        .map_err(|e| map_io_error_for_user(e, "Failed to read directory"))?;
    let mut children = Vec::new();
    while let Some(entry) = entries
        .next_entry()
        .await
        .map_err(|e| map_io_error_for_user(e, "Failed to read directory entry"))?
    {
        let child_path = entry.path();
        children.push(
            Url::from_file_path(&child_path)
                .map_err(|_| format!("Invalid path: {}", child_path.display()))?,
        );
    }
    Ok(children)
}

#[cfg(target_os = "android")]
async fn content_io_is_dir(url: &Url) -> Result<bool, String> {
    get_content_io_provider().is_directory(url.as_str()).await
}

#[cfg(target_os = "android")]
async fn list_content_children(url: &Url) -> Result<Vec<Url>, String> {
    get_content_io_provider()
        .list_children(url.as_str())
        .await?
        .into_iter()
        .map(|child| Url::parse(&child.uri).map_err(|e| format!("Invalid child URI: {}", e)))
        .collect()
}

async fn url_is_dir(url: &Url) -> Result<bool, String> {
    match url.scheme() {
        "file" => fs_is_dir(url).await,
        "content" => {
            #[cfg(target_os = "android")]
            {
                content_io_is_dir(url).await
            }
            #[cfg(not(target_os = "android"))]
            {
                Err("content:// local import is only supported on Android".to_string())
            }
        }
        scheme => Err(format!("Unsupported scheme for local import: {}", scheme)),
    }
}

async fn list_url_children(url: &Url) -> Result<Vec<Url>, String> {
    match url.scheme() {
        "file" => list_file_children(url).await,
        "content" => {
            #[cfg(target_os = "android")]
            {
                list_content_children(url).await
            }
            #[cfg(not(target_os = "android"))]
            {
                Err("content:// local import is only supported on Android".to_string())
            }
        }
        scheme => Err(format!("Unsupported scheme for local import: {}", scheme)),
    }
}

/// 流式遍历并处理 URL。目录子项仍按当前平台能力单层列出；是否递归进入子目录由 ctx.recursive 控制。
async fn process_url(
    url: &Url,
    ctx: &mut LocalImportContext<'_>,
    share: f64,
    image_count: &mut usize,
) -> Result<(), String> {
    if ctx.download_queue.is_task_canceled(ctx.task_id).await {
        return Err("Task canceled".to_string());
    }

    let is_dir = url_is_dir(url).await?;
    if is_dir {
        let children = list_url_children(url).await?;
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

            let child_is_dir = url_is_dir(&child).await.unwrap_or(false);
            if child_is_dir && !ctx.recursive {
                add_progress_and_emit(ctx, per_child);
                continue;
            }
            Box::pin(process_url(&child, ctx, per_child, image_count)).await?;
        }
        return Ok(());
    }

    import_single_file(url, ctx, image_count).await?;
    add_progress_and_emit(ctx, share);
    Ok(())
}

async fn import_single_file(
    url: &Url,
    ctx: &mut LocalImportContext<'_>,
    image_count: &mut usize,
) -> Result<(), String> {
    let download_start_time = ctx.next_download_start_time();
    let result = match url.scheme() {
        "file" => import_file_url(url, ctx, image_count, download_start_time).await,
        #[cfg(target_os = "android")]
        "content" => import_content_url(url, ctx, image_count, download_start_time).await,
        _ => Ok(()),
    };

    if let Err(e) = result {
        GlobalEmitter::global().emit_task_log(
            ctx.task_id,
            "warn",
            &task_log_i18n(
                "taskLogEnqueueFailed",
                json!({ "url": url.as_str(), "detail": e }),
            ),
        );
    }
    Ok(())
}

async fn import_file_url(
    url: &Url,
    ctx: &mut LocalImportContext<'_>,
    image_count: &mut usize,
    download_start_time: u64,
) -> Result<(), String> {
    let src = url
        .to_file_path()
        .map_err(|_| format!("Invalid file URL: {}", url))?;

    if crate::image_type::is_media_by_path(&src) {
        #[cfg(not(target_os = "android"))]
        {
            let final_path = if ctx.copy_to_dir {
                let dest_dir = ctx.copy_dest.as_ref().unwrap_or(&ctx.images_dir);
                fs::create_dir_all(dest_dir)
                    .await
                    .map_err(|e| format!("Failed to create output directory: {}", e))?;
                let name = src.file_name().and_then(|n| n.to_str()).unwrap_or("image");
                let hash_source = src.to_string_lossy();
                let safe = build_safe_filename(name, "bin", hash_source.as_ref());
                let dest = unique_path(dest_dir, &safe);
                fs::copy(&src, &dest)
                    .await
                    .map_err(|e| format!("Failed to copy local file: {}", e))?;
                dest
            } else {
                src.clone()
            };
            let headers: HashMap<String, String> = HashMap::new();
            let imported = crate::crawler::downloader::postprocess_downloaded_image(
                &final_path,
                url.as_str(),
                PLUGIN_ID,
                Some(ctx.task_id),
                None,
                None,
                download_start_time,
                ctx.output_album_id.as_deref(),
                &headers,
                false,
                None,
                None,
            )
            .await?;
            if imported {
                *image_count += 1;
            }
            return Ok(());
        }

        #[cfg(target_os = "android")]
        {
            let inferred = crate::image_type::mime_type_from_path(&src);
            let mime = inferred.unwrap_or_else(|| {
                if crate::image_type::is_video_by_path(&src) {
                    crate::image_type::default_video_mime().to_string()
                } else {
                    crate::image_type::default_image_mime().to_string()
                }
            });
            let display_name = src
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("image")
                .to_string();
            let copied_uri = get_content_io_provider()
                .copy_image_to_pictures(src.to_string_lossy().as_ref(), &mime, &display_name)
                .await?;
            let copied_url = Url::parse(&copied_uri).map_err(|e| e.to_string())?;
            import_content_url(&copied_url, ctx, image_count, download_start_time).await?;
            return Ok(());
        }
    }

    Ok(())
}

#[cfg(target_os = "android")]
async fn import_content_url(
    url: &Url,
    ctx: &mut LocalImportContext<'_>,
    image_count: &mut usize,
    download_start_time: u64,
) -> Result<(), String> {
    let uri = url.as_str();
    let io = get_content_io_provider();
    let _ = io.take_persistable_permission(uri).await;
    let mime = io.get_mime_type(uri).await?;

    let is_image = crate::image_type::is_image_mime(&mime);
    let is_video = crate::image_type::is_video_mime(&mime);
    if !is_image && !is_video {
        return Ok(());
    }

    let bytes = io.read_file_bytes(uri).await?;
    let hash = crate::crawler::downloader::compute_bytes_hash(&bytes);
    let (video_thumb_path, video_thumb_str) = if is_video {
        prepare_android_video_thumb(&bytes, &mime).await
    } else {
        (None, String::new())
    };
    let headers: HashMap<String, String> = HashMap::new();

    crate::crawler::downloader::process_downloaded_content_image_to_storage(
        uri,
        &hash,
        video_thumb_path.as_ref(),
        video_thumb_str.as_str(),
        mime,
        PLUGIN_ID,
        ctx.task_id,
        download_start_time,
        ctx.output_album_id.as_deref(),
        None,
        &headers,
        None,
        None,
    )
    .await?;

    *image_count += 1;
    Ok(())
}

#[cfg(target_os = "android")]
async fn prepare_android_video_thumb(
    bytes: &[u8],
    mime: &Option<String>,
) -> (Option<PathBuf>, String) {
    let ext = mime
        .as_deref()
        .and_then(crate::image_type::ext_from_mime)
        .unwrap_or_else(|| "mp4".to_string());
    let temp_dir = crate::app_paths::AppPaths::global().temp_dir.clone();
    let _ = fs::create_dir_all(&temp_dir).await;
    let temp_path = temp_dir.join(format!("{}.{}", uuid::Uuid::new_v4(), ext));

    if let Err(e) = fs::write(&temp_path, bytes).await {
        eprintln!(
            "[Local Import] Android content video temp write failed: {}",
            e
        );
        return (None, String::new());
    }

    let result =
        match crate::crawler::downloader::video_compress::compress_video_for_preview(&temp_path)
            .await
        {
            Ok(r) => {
                let path = r.preview_path;
                (Some(path.clone()), path.to_string_lossy().to_string())
            }
            Err(e) => {
                eprintln!("[Local Import] Android content video GIF failed: {}", e);
                (None, String::new())
            }
        };
    let _ = fs::remove_file(&temp_path).await;
    result
}

struct LocalImportContext<'a> {
    task_id: &'a str,
    progress: &'a mut f64,
    images_dir: PathBuf,
    #[cfg(not(target_os = "android"))]
    copy_to_dir: bool,
    #[cfg(not(target_os = "android"))]
    copy_dest: Option<PathBuf>,
    last_download_start_time: &'a mut u64,
    output_album_id: Option<String>,
    download_queue: &'a DownloadQueue,
    recursive: bool,
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

async fn parse_input_url(path_str: &str) -> Result<Url, String> {
    if path_str.starts_with("content://") {
        return Url::parse(path_str).map_err(|e| format!("Invalid content URI: {}", e));
    }

    let path = if path_str.starts_with("file://") {
        Url::parse(path_str)
            .map_err(|e| format!("Invalid file URL: {}", e))?
            .to_file_path()
            .map_err(|_| format!("Invalid file URL: {}", path_str))?
    } else {
        PathBuf::from(path_str)
    };

    if !fs::try_exists(&path)
        .await
        .map_err(|e| map_io_error_for_user(e, "Failed to check path"))?
    {
        return Err(format!("路径不存在: {}", path_str));
    }

    let path = fs::canonicalize(&path)
        .await
        .map_err(|e| map_io_error_for_user(e, &format!("无法解析路径 {}", path_str)))?;
    Url::from_file_path(&path).map_err(|_| format!("Invalid path: {}", path_str))
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

    #[cfg(not(target_os = "android"))]
    let copy_to_dir = cfg
        .get("copy_to_dir")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    #[cfg(not(target_os = "android"))]
    let copy_dest = if copy_to_dir {
        cfg.get("output_dir")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(PathBuf::from)
    } else {
        None
    };

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
        #[cfg(not(target_os = "android"))]
        copy_to_dir,
        #[cfg(not(target_os = "android"))]
        copy_dest,
        last_download_start_time: &mut last_download_start_time,
        output_album_id: output_album_id.clone(),
        download_queue,
        recursive,
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

    for path_str in &paths {
        if download_queue.is_task_canceled(task_id).await {
            return Err("Task canceled".to_string());
        }

        let url = parse_input_url(path_str).await?;
        process_url(&url, &mut ctx, share_per_path, &mut image_count).await?;
    }

    GlobalEmitter::global().emit_task_progress(task_id, 100.0);
    GlobalEmitter::global().emit_task_log(
        task_id,
        "info",
        &task_log_i18n(
            "taskLogLocalImportEnqueuedSummary",
            json!({
                "count": image_count,
                "downloads": image_count,
            }),
        ),
    );

    Ok(())
}
