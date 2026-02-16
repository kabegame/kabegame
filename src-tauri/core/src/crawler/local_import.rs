//! Built-in local import routine. Runs when plugin_id == "本地导入".
//! Streams over paths (files, folders; on Android, content:// is resolved via
//! the registered content URI resolver): each image is enqueued to the download
//! queue immediately; archives are enqueued as decompression jobs or extracted
//! inline per config.
//!
//! On Android, paths starting with `content://` are resolved via the registered
//! content URI resolver (FolderPickerPlugin listContentChildren + readContentUri), which copies
//! selected files to app-private storage and returns file paths; those paths are then enqueued
//! as file:// URLs so the download worker copies them into the task images_dir.

use crate::crawler::decompression::DecompressionJob;
use crate::crawler::downloader::DownloadQueue;
use crate::emitter::GlobalEmitter;
use crate::settings::Settings;
use crate::storage::Storage;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const PLUGIN_ID: &'static str = "本地导入";

#[cfg(target_os = "android")]
mod content_uri {
    use super::*;
    use std::sync::OnceLock;

    /// Android content URI 解析器：将 content:// 路径通过插件遍历并复制到可读路径。
    static RESOLVER: OnceLock<Box<dyn Fn(String, bool) -> Result<Vec<PathBuf>, String> + Send + Sync>> =
        OnceLock::new();

    pub fn set(f: impl Fn(String, bool) -> Result<Vec<PathBuf>, String> + Send + Sync + 'static) {
        let _ = RESOLVER.set(Box::new(f));
    }

    pub fn resolve(uri: &str, recursive: bool) -> Result<Vec<PathBuf>, String> {
        RESOLVER
            .get()
            .ok_or_else(|| "Android content URI 解析器未注册，无法读取 content:// 路径".to_string())?
            (uri.to_string(), recursive)
    }
}

/// 注册 content URI 解析器（仅 Android，由 app-main 调用）
#[cfg(target_os = "android")]
pub fn set_content_uri_resolver<F>(f: F)
where
    F: Fn(String, bool) -> Result<Vec<PathBuf>, String> + Send + Sync + 'static,
{
    content_uri::set(f);
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

fn is_archive_ext(ext: &str) -> bool {
    let lower = ext.to_lowercase();
    matches!(lower.as_str(), "zip" | "rar")
}

#[allow(dead_code)]
fn compute_file_hash(path: &Path) -> Result<String, String> {
    let mut file = fs::File::open(path)
        .map_err(|e| map_io_error_for_user(e, "Failed to open file for hash"))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 8192];
    loop {
        let n = file
            .read(&mut buffer)
            .map_err(|e| map_io_error_for_user(e, "Failed to read file for hash"))?;
        if n == 0 {
            break;
        }
        hasher.update(&buffer[..n]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

/// 流式遍历并处理：遇到图片立即入队下载，遇到压缩包按配置入队解压或就地解压后入队图片。
fn process_path(
    path: &Path,
    ctx: &LocalImportContext<'_>,
    image_count: &mut usize,
    archive_count: &mut usize,
) -> Result<(), String> {
    if (ctx.cancel_check)() {
        return Err("Task canceled".to_string());
    }
    if path.is_dir() {
        let entries = fs::read_dir(path)
            .map_err(|e| map_io_error_for_user(e, "Failed to read directory"))?;
        for entry in entries {
            let entry = entry
                .map_err(|e| map_io_error_for_user(e, "Failed to read directory entry"))?;
            let p = entry.path();
            if p.is_dir() {
                if ctx.recursive {
                    process_path(&p, ctx, image_count, archive_count)?;
                }
            } else if p.is_file() {
                process_file(&p, ctx, image_count, archive_count)?;
            }
        }
        return Ok(());
    }
    if path.is_file() {
        process_file(path, ctx, image_count, archive_count)?;
    }
    Ok(())
}

fn process_file(
    path: &Path,
    ctx: &LocalImportContext<'_>,
    image_count: &mut usize,
    archive_count: &mut usize,
) -> Result<(), String> {
    let ext = match path.extension().and_then(|e| e.to_str()) {
        Some(e) => e,
        None => return Ok(()),
    };
    if crate::image_type::is_supported_image_ext(ext) {
        let file_url = format!(
            "file:///{}",
            path.display().to_string().replace('\\', "/")
        );
        let url = match url::Url::parse(&file_url) {
            Ok(u) => u,
            Err(e) => return Err(format!("Invalid file URL: {}", e)),
        };
        match ctx.rt.block_on(ctx.download_queue.download_image(
            url,
            ctx.images_dir.clone(),
            PLUGIN_ID.to_string(),
            ctx.task_id.to_string(),
            ctx.download_start_time,
            ctx.output_album_id.clone(),
            HashMap::new(),
        )) {
            Ok(()) => *image_count += 1,
            Err(e) => {
                GlobalEmitter::global().emit_task_log(
                    ctx.task_id,
                    "warn",
                    &format!("入队失败 {}: {}", file_url, e),
                );
            }
        }
        return Ok(());
    }
    if is_archive_ext(ext) {
        let path_hint = path.display().to_string();
        if crate::archive::manager().get_processor_by_url(&path_hint).is_none() {
            return Err(format!("不支持的压缩格式: {}", path.display()));
        }
        let original_url = format!(
            "file:///{}",
            path.display().to_string().replace('\\', "/")
        );
        let job = DecompressionJob {
            archive_path: path.to_path_buf(),
            images_dir: ctx.images_dir.clone(),
            original_url: original_url.clone(),
            task_id: ctx.task_id.to_string(),
            plugin_id: PLUGIN_ID.to_string(),
            download_start_time: ctx.download_start_time,
            output_album_id: ctx.output_album_id.clone(),
            http_headers: HashMap::new(),
            temp_dir_guard: None,
        };
        ctx.rt.block_on(async {
            let (lock, notify) = &*ctx.download_queue.decompression_queue;
            let mut queue = lock.lock().await;
            queue.push_back(job);
            notify.notify_waiters();
        });
        *archive_count += 1;
        return Ok(());
    }
    Ok(())
}

struct LocalImportContext<'a> {
    task_id: &'a str,
    images_dir: PathBuf,
    download_start_time: u64,
    output_album_id: Option<String>,
    download_queue: &'a DownloadQueue,
    rt: &'a tokio::runtime::Handle,
    recursive: bool,
    include_archive: bool,
    cancel_check: &'a dyn Fn() -> bool,
}

pub fn run_builtin_local_import(
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

    let rt = tokio::runtime::Handle::current();
    let cancel_check = || download_queue.is_task_canceled_blocking(task_id);

    let images_dir = rt.block_on(async {
        let storage = Storage::global();
        match Settings::global().get_default_download_dir().await {
            Ok(Some(dir)) => PathBuf::from(dir),
            _ => storage.get_images_dir(),
        }
    });

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
        rt: &rt,
        recursive,
        include_archive,
        cancel_check: &cancel_check,
    };

    GlobalEmitter::global().emit_task_log(
        task_id,
        "info",
        &format!("本地导入: 开始流式遍历 {} 个路径...", paths.len()),
    );

    let mut image_count = 0usize;
    let mut archive_count = 0usize;

    for path_str in &paths {
        if cancel_check() {
            return Err("Task canceled".to_string());
        }

        #[cfg(target_os = "android")]
        if path_str.starts_with("content://") {
            let resolved = content_uri::resolve(path_str, recursive)?;
            for p in resolved {
                process_file(&p, &ctx, &mut image_count, &mut archive_count)?;
            }
            continue;
        }

        let path = PathBuf::from(path_str);
        if !path.exists() {
            return Err(format!("路径不存在: {}", path_str));
        }
        let path = path.canonicalize().map_err(|e| {
            map_io_error_for_user(e, &format!("无法解析路径 {}", path_str))
        })?;

        process_path(&path, &ctx, &mut image_count, &mut archive_count)?;
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
