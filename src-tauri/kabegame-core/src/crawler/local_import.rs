//! Built-in local import routine. Runs when plugin_id == "local-import".
//!
//! 遍历由通用 `local_folder::scan_service` 负责（可配置递归、跨 file:// / content://）；
//! 本模块只实现「发现媒体文件后如何导入」的钩子：桌面走下载后处理管线，Android 走 content 入库。
//! 任务进度 / 取消语义保留，但不再占用 DownloadQueue 槽位。
//!
//! 开了 `wpe` feature 的桌面构建里，Wallpaper Engine 壁纸目录按一个条目处理：进入子目录（或根）
//! 之前先看它是不是可入库的壁纸目录，是就把整个目录交给后处理的目录分支、不再下钻。

#[cfg(target_os = "android")]
use crate::crawler::content_io::get_content_io_provider;
use crate::crawler::downloader::util::DIR_PART_PREFIX;
#[cfg(not(target_os = "android"))]
use crate::crawler::downloader::{build_safe_filename, occupy_unique_path, OccupiedFile};
use crate::crawler::downloader::{next_download_id, wait_after_download_if_needed, DownloadQueue};
use crate::crawler::task_log_i18n::task_log_i18n;
use crate::crawler::task_scheduler::Task;
use crate::emitter::GlobalEmitter;
use crate::local_folder::import::LOCAL_FOLDER_PLUGIN_ID;
use crate::local_folder::scan_service::{
    scan_and_visit, FolderScanHook, ScanCtx, ScanError, ScanOptions, ScannedDir, ScannedFile,
};
use serde_json::json;
use std::collections::HashMap;
use std::io;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::fs;
use url::Url;

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

/// 源文件是否直接位于 `dir` 中（两侧都 canonicalize，消除符号链接、尾部分隔符与大小写差异）。
#[cfg(not(target_os = "android"))]
async fn is_in_dir(src: &std::path::Path, dir: &std::path::Path) -> bool {
    let Some(parent) = src.parent() else {
        return false;
    };
    match (fs::canonicalize(parent).await, fs::canonicalize(dir).await) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

/// 本地导入钩子：`DirCtx = ()`（输出画册固定在钩子里）。
struct LocalImportHook {
    task_id: String,
    run: Arc<Task>,
    download_queue: Arc<DownloadQueue>,
    output_album_id: Option<String>,
    #[cfg(not(target_os = "android"))]
    images_dir: PathBuf,
    #[cfg(not(target_os = "android"))]
    copy_to_dir: bool,
    #[cfg(not(target_os = "android"))]
    copy_dest: Option<PathBuf>,
    image_count: usize,
    last_download_start_time: u64,
}

impl LocalImportHook {
    fn is_canceled(&self) -> bool {
        self.run.cancel.is_cancelled()
    }

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

    /// 复制到目标目录：原子占坑一个不冲突的文件名，再经占坑句柄写入内容。
    ///
    /// 目标目录常是文件夹画册的 `sync_folder`，返回的守卫要持有到后处理入库结束，
    /// 期间文件夹同步探测到占用标记会放弃导入（由下载后处理补挂文件夹画册）。
    #[cfg(not(target_os = "android"))]
    async fn copy_into(
        &self,
        src: &std::path::Path,
        dest_dir: &std::path::Path,
    ) -> Result<OccupiedFile, String> {
        let name = src.file_name().and_then(|n| n.to_str()).unwrap_or("image");
        let fallback_ext = crate::media::image_type::mime_type_from_path(src)
            .as_deref()
            .and_then(crate::media::image_type::ext_from_mime)
            .unwrap_or_else(|| "bin".to_string());
        let safe = build_safe_filename(name, &fallback_ext);
        let occupied = occupy_unique_path(dest_dir, &safe, None).map_err(|e| {
            format!(
                "Failed to occupy local import target in {}: {}",
                dest_dir.display(),
                e
            )
        })?;
        let dest = occupied.path().to_path_buf();
        match occupied.copy_from(src).await {
            Ok(occupied) => Ok(occupied),
            Err(e) => {
                // 守卫已随失败的复制 drop，删掉不完整的目标文件
                let _ = fs::remove_file(&dest).await;
                Err(format!("Failed to copy local file: {}", e))
            }
        }
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

        // `occupied` 是复制出的新文件的占坑守卫，持有到后处理（入库）结束
        let (final_path, occupied) = if self.copy_to_dir {
            let dest_dir = self.copy_dest.as_ref().unwrap_or(&self.images_dir);
            fs::create_dir_all(dest_dir)
                .await
                .map_err(|e| format!("Failed to create output directory: {}", e))?;
            if is_in_dir(&src, dest_dir).await {
                // 源文件已在目标目录：复制只会产生「name (1).ext」副本（去重拦不住，
                // 文件夹同步还会把副本当新文件入库），直接用原文件走后处理
                (src.clone(), None)
            } else {
                let occupied = self.copy_into(&src, dest_dir).await?;
                (occupied.path().to_path_buf(), Some(occupied))
            }
        } else {
            (src.clone(), None)
        };
        let headers: HashMap<String, String> = HashMap::new();
        let imported = crate::crawler::downloader::postprocess_downloaded_image(
            &*self.download_queue,
            next_download_id(),
            crate::crawler::downloader::PostprocessSource::Path {
                path: &final_path,
                relocate_to: None,
            },
            false,
            &file.url,
            LOCAL_FOLDER_PLUGIN_ID,
            Some(&self.task_id),
            None,
            None,
            download_start_time,
            self.output_album_id.as_deref(),
            &headers,
            None,
            None,
            None,
            &[],
        )
        .await;
        drop(occupied);
        wait_after_download_if_needed(download_start_time, None).await;
        let imported = imported?;
        if imported {
            self.image_count += 1;
        }
        Ok(())
    }

    /// `dir` 是可入库的 WPE 壁纸目录（`project.json` 可读且类型受支持）时把它整个导入并返回 `true`，
    /// 调用方不再下钻；其余目录（包括带无关 `project.json` 的）返回 `false`，照常递归。
    ///
    /// Android 的 `content://` 目录没有本地路径，不走这里。
    #[cfg(all(feature = "wpe", not(target_os = "android")))]
    async fn try_wpe_dir(&mut self, dir: &std::path::Path) -> bool {
        if !crate::crawler::wpe_import::is_importable_wpe_dir(dir) {
            return false;
        }
        let Ok(url) = Url::from_file_path(dir) else {
            return false;
        };
        if self.run.params.is_dry_run {
            GlobalEmitter::global().emit_task_log(
                &self.task_id,
                "info",
                &task_log_i18n("taskLogDryRunSkipImport", json!({ "path": url.as_str() })),
            );
            self.run.record_dry_run_skip();
            return true;
        }
        let download_start_time = self.next_download_start_time();
        if let Err(e) = self.import_wpe_dir(dir, &url, download_start_time).await {
            GlobalEmitter::global().emit_task_log(
                &self.task_id,
                "warn",
                &task_log_i18n(
                    "taskLogEnqueueFailed",
                    json!({ "url": url.as_str(), "detail": e }),
                ),
            );
        }
        true
    }

    /// 导入一个 WPE 壁纸目录，与 [`Self::import_file_url`] 同一套参数。
    ///
    /// `copy_to_dir`（拖进文件夹画册等）时先把整个目录复制到目标目录下的唯一名，再对副本原地入库；
    /// 目录已直接位于目标目录里就不复制。源目录始终不动。
    #[cfg(all(feature = "wpe", not(target_os = "android")))]
    async fn import_wpe_dir(
        &mut self,
        dir: &std::path::Path,
        url: &Url,
        download_start_time: u64,
    ) -> Result<(), String> {
        let final_dir = if self.copy_to_dir {
            let dest_dir = self.copy_dest.as_ref().unwrap_or(&self.images_dir).clone();
            fs::create_dir_all(&dest_dir)
                .await
                .map_err(|e| format!("Failed to create output directory: {}", e))?;
            if is_in_dir(dir, &dest_dir).await {
                dir.to_path_buf()
            } else {
                let src = dir.to_path_buf();
                let name = dir
                    .file_name()
                    .map(|name| name.to_string_lossy().into_owned())
                    .unwrap_or_else(|| "wallpaper".to_string());
                tokio::task::spawn_blocking(move || {
                    crate::crawler::downloader::util::copy_dir_unique(&src, &dest_dir, &name)
                })
                .await
                .map_err(|e| format!("copy task join error: {e}"))?
                .map_err(|e| format!("Failed to copy wallpaper directory: {}", e))?
            }
        } else {
            dir.to_path_buf()
        };
        let headers: HashMap<String, String> = HashMap::new();
        let imported = crate::crawler::downloader::postprocess_downloaded_image(
            &*self.download_queue,
            next_download_id(),
            crate::crawler::downloader::PostprocessSource::Path {
                path: &final_dir,
                relocate_to: None,
            },
            false,
            url,
            LOCAL_FOLDER_PLUGIN_ID,
            Some(&self.task_id),
            None,
            None,
            download_start_time,
            self.output_album_id.as_deref(),
            &headers,
            None,
            None,
            None,
            &[],
        )
        .await;
        wait_after_download_if_needed(download_start_time, None).await;
        if imported? {
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
        let inferred = crate::media::image_type::mime_type_from_path(&src);
        let mime = inferred.unwrap_or_else(|| {
            if crate::media::image_type::is_video_by_path(&src) {
                crate::media::image_type::default_video_format().to_string()
            } else {
                crate::media::image_type::default_image_format().to_string()
            }
        });
        let display_name = src
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("image")
            .to_string();
        let copied_uri = get_content_io_provider()
            .copy_image_to_pictures(
                src.to_string_lossy().as_ref(),
                crate::media::image_type::mime_from_format(&mime).unwrap_or(&mime),
                &display_name,
            )
            .await?;
        let copied_url = Url::parse(&copied_uri).map_err(|e| e.to_string())?;
        self.import_content_url(&copied_url, download_start_time, Some(display_name))
            .await
    }

    #[cfg(target_os = "android")]
    async fn import_content_url(
        &mut self,
        url: &Url,
        download_start_time: u64,
        custom_display_name: Option<String>,
    ) -> Result<(), String> {
        let uri = url.as_str();
        let io = get_content_io_provider();
        let _ = io.take_persistable_permission(uri).await;
        let mime = io.get_mime_type(uri).await?;

        let is_image = crate::media::image_type::is_image_mime(&mime);
        let is_video = crate::media::image_type::is_video_mime(&mime);
        if !is_image && !is_video {
            return Ok(());
        }

        let result = crate::crawler::downloader::postprocess_downloaded_image(
            &*self.download_queue,
            next_download_id(),
            crate::crawler::downloader::PostprocessSource::ContentUri,
            false,
            url,
            LOCAL_FOLDER_PLUGIN_ID,
            Some(self.task_id.as_str()),
            None,
            None,
            download_start_time,
            self.output_album_id.as_deref(),
            &HashMap::new(),
            custom_display_name.as_deref(),
            None,
            None,
            &[],
        )
        .await;
        wait_after_download_if_needed(download_start_time, None).await;
        if result? {
            self.image_count += 1;
        }
        Ok(())
    }
}

#[async_trait::async_trait]
impl FolderScanHook for LocalImportHook {
    type DirCtx = ();

    async fn on_enter_dir(
        &mut self,
        enter: &ScannedDir,
        _ctx: &ScanCtx<()>,
    ) -> Result<Option<()>, ScanError> {
        if self.is_canceled() {
            return Err(ScanError::Fatal("Task canceled".to_string()));
        }
        // 不钻进整目录复制 / 跨盘移动的半成品
        if enter.name.starts_with(DIR_PART_PREFIX) {
            return Ok(None);
        }
        // WPE 壁纸目录：整目录导入，返回上一级
        #[cfg(all(feature = "wpe", not(target_os = "android")))]
        if let Some(path) = enter.path.as_deref() {
            if self.try_wpe_dir(path).await {
                return Ok(None);
            }
        }
        Ok(Some(()))
    }

    /// 非递归或到达深度上限时，子目录走这里：其中的 WPE 壁纸目录仍按一个条目导入。
    async fn on_subdir(&mut self, dir: &ScannedDir, _ctx: &ScanCtx<()>) -> Result<(), ScanError> {
        if self.is_canceled() {
            return Err(ScanError::Fatal("Task canceled".to_string()));
        }
        if dir.name.starts_with(DIR_PART_PREFIX) {
            return Ok(());
        }
        #[cfg(all(feature = "wpe", not(target_os = "android")))]
        if let Some(path) = dir.path.as_deref() {
            self.try_wpe_dir(path).await;
        }
        Ok(())
    }

    async fn on_file(&mut self, file: &ScannedFile, _ctx: &ScanCtx<()>) -> Result<(), ScanError> {
        if self.is_canceled() {
            return Err(ScanError::Fatal("Task canceled".to_string()));
        }
        if self.run.params.is_dry_run {
            GlobalEmitter::global().emit_task_log(
                &self.task_id,
                "info",
                &task_log_i18n(
                    "taskLogDryRunSkipImport",
                    json!({ "path": file.url.as_str() }),
                ),
            );
            self.run.record_dry_run_skip();
            return Ok(());
        }
        let download_start_time = self.next_download_start_time();
        let result = match file.url.scheme() {
            "file" => self.import_file_url(file, download_start_time).await,
            #[cfg(target_os = "android")]
            "content" => {
                self.import_content_url(&file.url, download_start_time, None)
                    .await
            }
            _ => Ok(()),
        };
        if let Err(e) = result {
            GlobalEmitter::global().emit_task_log(
                &self.task_id,
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
        self.run.add_progress(delta);
    }
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

pub async fn run_builtin_local_import(run: Arc<Task>) -> Result<(), String> {
    let task_id = run.task_id.clone();
    let cfg = run.params.config.clone();

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
    let images_dir = run.params.images_dir.clone();

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
        &task_id,
        "info",
        &task_log_i18n(
            "taskLogLocalImportStreaming",
            json!({ "count": paths.len() }),
        ),
    );
    run.set_progress(0.0);

    let mut hook = LocalImportHook {
        task_id: task_id.clone(),
        run: Arc::clone(&run),
        download_queue: crate::crawler::TaskScheduler::global().download_queue(),
        output_album_id: run.params.output_album_id.clone(),
        #[cfg(not(target_os = "android"))]
        images_dir,
        #[cfg(not(target_os = "android"))]
        copy_to_dir,
        #[cfg(not(target_os = "android"))]
        copy_dest,
        image_count: 0,
        last_download_start_time: download_start_time,
    };
    // 根目录不触发 `on_enter_dir`：根本身是 WPE 壁纸目录时在这里整目录导入，并从待扫描的根里拿掉
    let total_roots = roots.len();
    #[cfg(all(feature = "wpe", not(target_os = "android")))]
    let roots = {
        let mut rest = Vec::with_capacity(total_roots);
        for root in roots {
            if hook.is_canceled() {
                return Err("Task canceled".to_string());
            }
            let handled = match root.to_file_path() {
                Ok(path) if path.is_dir() => hook.try_wpe_dir(&path).await,
                _ => false,
            };
            if handled {
                run.add_progress(100.0 / total_roots as f64);
            } else {
                rest.push(root);
            }
        }
        rest
    };
    let options = ScanOptions {
        recursive,
        min_collect_interval_ms: Some(100),
        total_progress_share: 100.0 * roots.len() as f64 / total_roots as f64,
        ..Default::default()
    };
    scan_and_visit(&roots, (), &options, &mut hook).await?;

    let image_count = hook.image_count;
    run.set_progress(100.0);
    GlobalEmitter::global().emit_task_log(
        &task_id,
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
