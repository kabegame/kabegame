//! Built-in local import routine. Runs when plugin_id == "local-import".
//!
//! 遍历由通用 `local_folder::scan_service` 负责（可配置递归、跨 file:// / content://）；
//! 本模块只实现「发现媒体文件后如何导入」的钩子：桌面走下载后处理管线，Android 走 content 入库。
//! 任务进度 / 取消语义保留，但不再占用 DownloadQueue 槽位。

#[cfg(target_os = "android")]
use crate::crawler::content_io::get_content_io_provider;
use crate::crawler::downloader::DownloadQueue;
#[cfg(not(target_os = "android"))]
use crate::crawler::downloader::{build_safe_filename, unique_path};
use crate::crawler::task_log_i18n::task_log_i18n;
use crate::emitter::GlobalEmitter;
use crate::local_folder::scan_service::{
    scan_and_visit, FolderScanHook, ScanCtx, ScanError, ScanOptions, ScannedDir, ScannedFile,
};
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

/// 本地导入钩子：`DirCtx = ()`（输出画册固定在钩子里）。
struct LocalImportHook<'a> {
    task_id: &'a str,
    download_queue: &'a DownloadQueue,
    output_album_id: Option<String>,
    #[cfg(not(target_os = "android"))]
    images_dir: PathBuf,
    #[cfg(not(target_os = "android"))]
    copy_to_dir: bool,
    #[cfg(not(target_os = "android"))]
    copy_dest: Option<PathBuf>,
    progress: f64,
    image_count: usize,
    last_download_start_time: u64,
}

impl LocalImportHook<'_> {
    fn next_download_start_time(&mut self) -> u64 {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        let next = if now <= self.last_download_start_time {
            self.last_download_start_time.saturating_add(1)
        } else {
            now
        };
        self.last_download_start_time = next;
        next
    }

    #[cfg(not(target_os = "android"))]
    async fn import_file_url(
        &mut self,
        file: &ScannedFile,
        download_start_time: u64,
    ) -> Result<(), String> {
        let src = file
            .path
            .clone()
            .ok_or_else(|| format!("Invalid file URL: {}", file.url))?;

        let final_path = if self.copy_to_dir {
            let dest_dir = self.copy_dest.as_ref().unwrap_or(&self.images_dir);
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
            file.url.as_str(),
            PLUGIN_ID,
            Some(self.task_id),
            None,
            None,
            download_start_time,
            self.output_album_id.as_deref(),
            &headers,
            false,
            None,
            None,
        )
        .await?;
        if imported {
            self.image_count += 1;
        }
        Ok(())
    }

    #[cfg(target_os = "android")]
    async fn import_file_url(
        &mut self,
        file: &ScannedFile,
        download_start_time: u64,
    ) -> Result<(), String> {
        let src = file
            .path
            .clone()
            .ok_or_else(|| format!("Invalid file URL: {}", file.url))?;
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
        self.import_content_url(&copied_url, download_start_time)
            .await
    }

    #[cfg(target_os = "android")]
    async fn import_content_url(
        &mut self,
        url: &Url,
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
            self.task_id,
            download_start_time,
            self.output_album_id.as_deref(),
            None,
            &headers,
            None,
            None,
        )
        .await?;

        self.image_count += 1;
        Ok(())
    }
}

#[async_trait::async_trait]
impl FolderScanHook for LocalImportHook<'_> {
    type DirCtx = ();

    async fn on_enter_dir(
        &mut self,
        _enter: &ScannedDir,
        _ctx: &ScanCtx<()>,
    ) -> Result<Option<()>, ScanError> {
        if self.download_queue.is_task_canceled(self.task_id).await {
            return Err(ScanError::Fatal("Task canceled".to_string()));
        }
        Ok(Some(()))
    }

    async fn on_file(&mut self, file: &ScannedFile, _ctx: &ScanCtx<()>) -> Result<(), ScanError> {
        if self.download_queue.is_task_canceled(self.task_id).await {
            return Err(ScanError::Fatal("Task canceled".to_string()));
        }
        let download_start_time = self.next_download_start_time();
        let result = match file.url.scheme() {
            "file" => self.import_file_url(file, download_start_time).await,
            #[cfg(target_os = "android")]
            "content" => {
                self.import_content_url(&file.url, download_start_time)
                    .await
            }
            _ => Ok(()),
        };
        if let Err(e) = result {
            GlobalEmitter::global().emit_task_log(
                self.task_id,
                "warn",
                &task_log_i18n(
                    "taskLogEnqueueFailed",
                    json!({ "url": file.url.as_str(), "detail": e }),
                ),
            );
        }
        Ok(())
    }

    fn on_progress(&mut self, delta: f64) {
        self.progress = (self.progress + delta).min(99.9);
        GlobalEmitter::global().emit_task_progress(self.task_id, self.progress);
    }
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

/// 把输入字符串路径解析为 `Url`（file:// 或 content://），并校验存在性、规范化。
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

    #[cfg(not(target_os = "android"))]
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

    // 把输入路径解析为 URL（同时校验存在性）。
    let mut roots: Vec<Url> = Vec::with_capacity(paths.len());
    for path_str in &paths {
        roots.push(parse_input_url(path_str).await?);
    }

    GlobalEmitter::global().emit_task_log(
        task_id,
        "info",
        &task_log_i18n(
            "taskLogLocalImportStreaming",
            json!({ "count": paths.len() }),
        ),
    );
    GlobalEmitter::global().emit_task_progress(task_id, 0.0);

    let mut hook = LocalImportHook {
        task_id,
        download_queue,
        output_album_id,
        #[cfg(not(target_os = "android"))]
        images_dir,
        #[cfg(not(target_os = "android"))]
        copy_to_dir,
        #[cfg(not(target_os = "android"))]
        copy_dest,
        progress: 0.0,
        image_count: 0,
        last_download_start_time: download_start_time,
    };
    let options = ScanOptions {
        recursive,
        min_stable_age_ms: None,
        total_progress_share: 100.0,
        ..Default::default()
    };
    scan_and_visit(&roots, (), &options, &mut hook).await?;

    let image_count = hook.image_count;
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
