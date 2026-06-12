#[cfg(target_os = "android")]
use crate::crawler::content_io::get_content_io_provider;
#[cfg(windows)]
use crate::crawler::downloader::util::remove_zone_identifier;
use crate::crawler::task_log_i18n::task_log_i18n;
use crate::emitter::GlobalEmitter;
use crate::settings::Settings;
use crate::storage::{ImageInfo, Storage};
use async_trait::async_trait;
use serde_json::json;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Instant;
use tokio::time::{sleep, Duration};
use url::Url;

pub mod compress;
#[cfg(target_os = "android")]
mod content;
mod http;
pub mod native_download;
pub mod queue;
pub mod util;

pub use compress::{
    generate_thumbnail, generate_thumbnail_from_bytes, image_needs_independent_thumbnail,
    image_thumbnail_dimensions_acceptable, IMAGE_THUMBNAIL_MAX_DIM,
    IMAGE_THUMBNAIL_SOURCE_THRESHOLD_BYTES,
};
pub use http::{build_reqwest_header_map_for_emitter, create_client};
pub use native_download::{NativeDownloadEntry, NativeDownloadState};
pub use queue::{
    next_download_id, ActiveDownloadInfo, DownloadPool, DownloadQueue, DownloadRequest,
    DownloadState,
};
pub use util::{
    build_safe_filename, build_safe_filename_no_ext, compute_bytes_hash, compute_file_hash,
    compute_unique_download_path, unique_path,
};

use queue::{
    clear_failed_image_after_success, emit_task_image_counts_snapshot,
    upsert_failed_image_on_failure,
};
#[cfg(target_os = "android")]
use util::{derive_display_name_from_url, mime_type_from_filename};
/// 下载错误分类
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DownloadErrorKind {
    /// 不可重试，立即放弃
    Fatal,
    /// 截断：可重试，但需清空已下载缓冲从头重下（如服务端不支持 Range）
    Retriable,
    /// 可重试且保留已下载内容（Range 续传）
    Resumable,
}

#[derive(Debug)]
pub(crate) struct DownloadAttemptError {
    kind: DownloadErrorKind,
    message: String,
}

impl DownloadAttemptError {
    pub(crate) fn fatal(message: impl Into<String>) -> Self {
        Self {
            kind: DownloadErrorKind::Fatal,
            message: message.into(),
        }
    }

    pub(crate) fn retriable(message: impl Into<String>) -> Self {
        Self {
            kind: DownloadErrorKind::Retriable,
            message: message.into(),
        }
    }

    pub(crate) fn resumable(message: impl Into<String>) -> Self {
        Self {
            kind: DownloadErrorKind::Resumable,
            message: message.into(),
        }
    }

    pub(crate) fn is_retryable(&self) -> bool {
        !matches!(self.kind, DownloadErrorKind::Fatal)
    }

    pub(crate) fn should_clear(&self) -> bool {
        matches!(self.kind, DownloadErrorKind::Retriable)
    }

    pub(crate) fn into_message(self) -> String {
        self.message
    }

    pub(crate) fn emit_retry_log(&self, task_id: &str, attempt: u32, max_attempts: u32) {
        emit_task_log(
            task_id,
            "warn",
            task_log_i18n(
                "taskLogDownloadRetry",
                json!({ "attempt": attempt, "max": max_attempts, "detail": self.message }),
            ),
        );
    }
}

/// 下载结果：未落盘 → 内存字节；曾落盘 → 临时文件路径。
pub(crate) enum DownloadOutcome {
    Bytes(Vec<u8>),
    Path(PathBuf),
}

/// 溢写阈值：内存缓冲累计达到该大小即把这一段落盘并清空，使大文件常驻内存维持在阈值附近。
pub(crate) const DOWNLOAD_SPILL_THRESHOLD: usize = 5 * 1024 * 1024;

/// 下载写入目标，实现 [`std::io::Write`]，对下载器透明。
///
/// **由 `download_with_retry` 私有持有，以抽象 `&mut dyn Write` 形式传给 `download`。**
/// 下载器只管往里写，并不知道是否落盘；内存缓冲累计到 [`DOWNLOAD_SPILL_THRESHOLD`] 时，
/// `write` 内部把这一段同步落盘到 `downloads_temp_dir()/{id}.part` 并清空缓冲。续传 /
/// 截断 / 收尾由外部通过 [`Self::received`] / [`Self::clear`] / [`Self::finalize`] 决定。
struct SpillWriter {
    buffer: Vec<u8>,
    spilled_len: u64,
    file: Option<std::fs::File>,
    path: Option<PathBuf>,
    download_id: u64,
    downloads_dir: PathBuf,
}

impl SpillWriter {
    fn new(download_id: u64) -> Self {
        Self::new_in(
            download_id,
            crate::app_paths::AppPaths::global().downloads_temp_dir(),
        )
    }

    fn new_in(download_id: u64, downloads_dir: PathBuf) -> Self {
        Self {
            buffer: Vec::with_capacity(64 * 1024),
            spilled_len: 0,
            file: None,
            path: None,
            download_id,
            downloads_dir,
        }
    }

    /// 已累计接收字节数（落盘 + 缓冲），用作 Range 续传与进度基准。
    fn received(&self) -> u64 {
        self.spilled_len + self.buffer.len() as u64
    }

    /// 无条件把当前缓冲写入临时文件（必要时创建）并清空缓冲。
    /// 供收尾 / flush 刷残余缓冲使用。
    fn flush_buffer_to_file(&mut self) -> std::io::Result<()> {
        if self.buffer.is_empty() {
            return Ok(());
        }
        if self.file.is_none() {
            std::fs::create_dir_all(&self.downloads_dir)?;
            let path = self.downloads_dir.join(format!("{}.part", self.download_id));
            self.file = Some(std::fs::File::create(&path)?);
            self.path = Some(path);
        }
        use std::io::Write as _;
        self.file.as_mut().unwrap().write_all(&self.buffer)?;
        self.spilled_len += self.buffer.len() as u64;
        self.buffer.clear();
        Ok(())
    }

    /// 仅在确有必要（缓冲已满到阈值）时落盘，否则保留在内存。
    fn spill(&mut self) -> std::io::Result<()> {
        if self.buffer.len() >= DOWNLOAD_SPILL_THRESHOLD {
            self.flush_buffer_to_file()?;
        }
        Ok(())
    }

    /// 截断：丢弃缓冲与临时文件并归零（服务端不支持 Range、需从头重下时）。
    fn clear(&mut self) {
        self.buffer.clear();
        self.spilled_len = 0;
        self.file = None; // 先释放句柄再删文件（Windows 要求）
        if let Some(path) = self.path.take() {
            let _ = std::fs::remove_file(path);
        }
    }

    /// 收尾：曾落盘 → 刷入剩余缓冲并返回 Path；否则返回内存 Bytes。
    fn finalize(mut self) -> std::io::Result<DownloadOutcome> {
        if self.file.is_some() {
            self.flush_buffer_to_file()?;
            if let Some(mut f) = self.file.take() {
                use std::io::Write as _;
                f.flush()?;
            }
            return Ok(DownloadOutcome::Path(self.path.take().unwrap()));
        }
        Ok(DownloadOutcome::Bytes(self.buffer))
    }
}

impl std::io::Write for SpillWriter {
    /// 每次最多往缓冲写入 `阈值 - 当前缓冲长度` 字节并返回写入量，使缓冲严格不超过阈值；
    /// 写满即落盘腾空间。调用方用 `write_all` 循环写完整块数据。
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        let space = DOWNLOAD_SPILL_THRESHOLD - self.buffer.len();
        let n = buf.len().min(space);
        self.buffer.extend_from_slice(&buf[..n]);
        self.spill()?; // 缓冲达到阈值才落盘
        Ok(n)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        // 已落盘时，把缓冲里未落盘的尾部刷入文件再 flush 文件，避免丢数据。
        // 尚未落盘（小文件）时数据留在内存即为最终形态，flush 为 no-op，不提前建文件。
        if self.file.is_some() {
            self.flush_buffer_to_file()?;
            use std::io::Write as _;
            self.file.as_mut().unwrap().flush()?;
        }
        Ok(())
    }
}

#[async_trait]
pub(crate) trait SchemeDownloader: Send + Sync {
    /// 执行下载：把 `url` 的字节写入抽象 `out`（由调用方提供，通常是一个 `Vec<u8>`），
    /// `headers` 为本次下载使用的 HTTP 请求头。
    ///
    /// `already_received` 为本次调用前 `out` 中已有的字节数；>0 表示这是一次续传，下载器据此
    /// 发送 `Range` 请求并把进度基准设为该值。下载器**只往 `out` 追加写**，从不清空它——
    /// 清空 / 落盘 / 收尾全部由 `download_with_retry` 在本函数返回后决定。当服务端无法从
    /// `already_received` 续传（忽略 Range、返回 200 或非法 Content-Range）时，返回
    /// [`DownloadAttemptError::retriable`]（截断）让外部清空缓冲后从头重下。
    async fn download(
        &self,
        dq: &DownloadQueue,
        url: &Url,
        task_id: &str,
        headers: &HashMap<String, String>,
        out: &mut (dyn std::io::Write + Send),
        already_received: u64,
        download_id: u64,
    ) -> Result<(), DownloadAttemptError>;
    /// 根据最终本地路径计算显示名称。
    /// `final_local_path`: 入库时的 local_path（桌面端为文件路径，Android 为 content URI）。
    async fn display_name(&self, url: &Url, final_local_path: &str) -> String;
}

/// 宏：根据 (scheme 列表, 变体名, 类型路径) 静态生成枚举、trait 实现和注册表，避免重复代码。
macro_rules! define_scheme_downloader_registry {
    ($( ($schemes:expr, $variant:ident, $type:path) ),* $(,)?) => {
        enum SchemeDownloaderEnum {
            $($variant($type),)*
        }

        #[async_trait]
        impl SchemeDownloader for SchemeDownloaderEnum {
            async fn download(
                &self,
                dq: &DownloadQueue,
                url: &Url,
                task_id: &str,
                headers: &HashMap<String, String>,
                out: &mut (dyn std::io::Write + Send),
                already_received: u64,
                download_id: u64,
            ) -> Result<(), DownloadAttemptError> {
                match self {
                    $(SchemeDownloaderEnum::$variant(d) => d.download(dq, url, task_id, headers, out, already_received, download_id).await,)*
                }
            }

            async fn display_name(&self, url: &Url, final_local_path: &str) -> String {
                match self {
                    $(SchemeDownloaderEnum::$variant(d) => d.display_name(url, final_local_path).await,)*
                }
            }
        }

        /// 静态下载器注册表：(scheme 列表, 下载器)。无需 OnceLock，编译期确定。
        static DOWNLOADER_REGISTRY: &[(&[&'static str], SchemeDownloaderEnum)] = &[
            $(($schemes, SchemeDownloaderEnum::$variant($type)),)*
        ];
    };
}

#[cfg(target_os = "android")]
define_scheme_downloader_registry! {
    (&["content"], Content, content::ContentSchemeDownloader),
    (&["http", "https"], Http, http::HttpSchemeDownloader),
}

#[cfg(not(target_os = "android"))]
define_scheme_downloader_registry! {
    (&["http", "https"], Http, http::HttpSchemeDownloader),
}

fn get_downloader_by_scheme(scheme: &str) -> Option<&'static SchemeDownloaderEnum> {
    let key = scheme.trim().to_ascii_lowercase();
    DOWNLOADER_REGISTRY
        .iter()
        .find(|(schemes, _)| schemes.iter().any(|s| s.eq_ignore_ascii_case(&key)))
        .map(|(_, d)| d)
}

fn get_downloader_for_url(url: &Url) -> Option<&'static SchemeDownloaderEnum> {
    get_downloader_by_scheme(url.scheme())
}

/// 返回当前支持的 URL scheme 列表。
pub fn supported_url_schemes() -> Vec<String> {
    let mut out: Vec<String> = DOWNLOADER_REGISTRY
        .iter()
        .flat_map(|(schemes, _)| schemes.iter().map(|s| s.to_string()))
        .collect();
    out.sort();
    out
}

pub(crate) fn emit_task_log(task_id: &str, level: &str, message: impl Into<String>) {
    let task_id = task_id.trim();
    if task_id.is_empty() {
        return;
    }
    GlobalEmitter::global().emit_task_log(task_id, level, &message.into());
}

/// 根据 URL scheme 选择下载器，重试成功后返回 DownloadOutcome（Bytes 或 Path）。
pub async fn download_with_retry(
    dq: &DownloadQueue,
    task_id: &str,
    url: &str,
    headers: &HashMap<String, String>,
    download_id: u64,
) -> Result<DownloadOutcome, String> {
    let parsed = Url::parse(url).map_err(|e| format!("Invalid URL: {}", e))?;
    let downloader = get_downloader_for_url(&parsed).ok_or_else(|| {
        let supported = supported_url_schemes().join(", ");
        format!(
            "Unsupported URL scheme: '{}'. Only {} are supported.",
            parsed.scheme(),
            supported
        )
    })?;
    let max_attempts = Settings::global()
        .get_network_retry_count()
        .saturating_add(1)
        .max(1);
    // download_with_retry 私有持有溢写状态：以抽象 Write 形式传给 download，
    // 何时清空 / 落盘 / 收尾都在 download 返回后由本函数决定。
    let mut writer = SpillWriter::new(download_id);

    for attempt in 1..=max_attempts {
        if dq.is_download_canceled(task_id).await {
            writer.clear();
            return Err("Task canceled".to_string());
        }

        // 已接收量 >0 表示续传：download 据此发送 Range。
        let already_received = writer.received();
        match downloader
            .download(
                dq,
                &parsed,
                task_id,
                headers,
                &mut writer,
                already_received,
                download_id,
            )
            .await
        {
            // 流结束：曾落盘 → Path，否则 → Bytes。
            Ok(()) => {
                return writer
                    .finalize()
                    .map_err(|e| format!("finalize download: {e}"))
            }
            Err(e) => {
                if !e.is_retryable() || attempt >= max_attempts {
                    writer.clear();
                    return Err(e.into_message());
                }
                e.emit_retry_log(task_id, attempt, max_attempts);
                // Retriable（截断）→ 清空从头重来；Resumable → 保留续传。
                if e.should_clear() {
                    writer.clear();
                }
                sleep(Duration::from_millis(500 * attempt as u64)).await;
            }
        }
    }
    unreachable!()
}

fn download_interval_ms() -> u64 {
    Settings::global().get_download_interval_ms() as u64
}

async fn wait_until_download_interval_elapsed(download_start_time: u64, interval_ms: u64) {
    if interval_ms == 0 {
        return;
    }
    let elapsed = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
        - download_start_time;
    if elapsed < interval_ms {
        let remaining = interval_ms - elapsed;
        sleep(Duration::from_millis(remaining)).await;
    }
}

/// 非下载池路径（本地导入、本地文件夹同步、native/surf 下载）使用：
/// 确保单个文件处理从开始到结束至少间隔设置中的下载间隔。
pub async fn wait_after_non_pool_download_if_needed(download_start_time: u64) {
    wait_until_download_interval_elapsed(download_start_time, download_interval_ms()).await;
}

/// 每次下载完成后，按设置等待一段时间再进入下一轮；等待期间可被 exit_notify 中断。
async fn wait_after_pool_download_if_needed(pool: &DownloadPool) {
    let interval_ms = download_interval_ms();
    if interval_ms == 0 {
        return;
    }
    let exit_notify = &pool.exit_notify;
    tokio::select! {
        _ = sleep(Duration::from_millis(interval_ms)) => {}
        _ = exit_notify.notified() => {}
    }
}

/// 根据 URL 和最终本地路径解析显示名称。
/// `url`: 原始 URL（用于确定 scheme）
/// `local_path`: 入库时的 local_path（桌面端为文件路径，Android 为 content URI）
pub async fn resolve_display_name(url: &str, local_path: &str) -> String {
    let parsed = match Url::parse(url) {
        Ok(u) => u,
        Err(_) => {
            // URL 解析失败，尝试从 local_path 提取文件名
            return Path::new(local_path)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("image")
                .to_string();
        }
    };
    let downloader = match get_downloader_for_url(&parsed) {
        Some(d) => d,
        None => {
            // 无匹配的 downloader，从 local_path 提取文件名
            return Path::new(local_path)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("image")
                .to_string();
        }
    };
    downloader.display_name(&parsed, local_path).await
}

/// 准备图片下载目标。
/// content:// 图片入库：local_path 存 URI，thumbnail_path 为本地路径。
#[cfg(target_os = "android")]
pub(crate) async fn process_downloaded_content_image_to_storage(
    dq: &DownloadQueue,
    id: u64,
    content_uri: &str,
    hash: &str,
    thumbnail_path: Option<&Path>,
    inferred_mime_type: Option<String>,
    plugin_id: &str,
    task_id: &str,
    download_start_time: u64,
    output_album_id: Option<&str>,
    failed_image_id: Option<i64>,
    http_headers: &HashMap<String, String>,
    custom_display_name: Option<&str>,
    metadata_id: Option<i64>,
) -> Result<(), String> {
    let mut display_name = get_content_io_provider()
        .get_display_name(content_uri)
        .await
        .unwrap_or_else(|_| "image".to_string());
    if let Some(n) = custom_display_name {
        if !n.trim().is_empty() {
            display_name = n.to_string();
        }
    }
    let mime_line = inferred_mime_type
        .as_ref()
        .map(|s| s.trim().to_lowercase())
        .filter(|s| !s.is_empty())
        .or_else(|| {
            let from_fn = mime_type_from_filename(&display_name);
            let f = from_fn.to_lowercase();
            if f != "application/octet-stream" && !f.is_empty() {
                Some(f)
            } else {
                None
            }
        });
    let media_type = Some(match mime_line {
        Some(m)
            if m.starts_with("video/") || crate::image_type::is_video_mime(&Some(m.clone())) =>
        {
            m
        }
        Some(m)
            if m.starts_with("image/") || crate::image_type::is_image_mime(&Some(m.clone())) =>
        {
            m
        }
        Some(m) if m == "video" => crate::image_type::default_video_mime().to_string(),
        Some(m) if m == "image" => crate::image_type::default_image_mime().to_string(),
        Some(m) => m,
        None => crate::image_type::default_image_mime().to_string(),
    });
    let (width, height) = if media_type
        .as_deref()
        .map(|m| m.starts_with("video/"))
        .unwrap_or(false)
    {
        crate::media_dimensions::android::resolve_video_dimensions(content_uri).await
    } else {
        crate::media_dimensions::android::resolve_image_dimensions(content_uri).await
    }
    .map(|(w, h)| (Some(w), Some(h)))
    .unwrap_or((None, None));
    let size = crate::media_dimensions::android::resolve_content_size(content_uri).await;

    let image_info = ImageInfo {
        id: "".to_string(),
        url: None,
        local_path: content_uri.to_string(),
        plugin_id: plugin_id.to_string(),
        task_id: Some(task_id.to_string()),
        surf_record_id: None,
        crawled_at: download_start_time,
        metadata_id,
        metadata_version: 0,
        thumbnail_path: thumbnail_path
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default(),
        favorite: false,
        is_hidden: false,
        hash: hash.to_string(),
        local_exists: true,
        width,
        height,
        display_name,
        media_type,
        last_set_wallpaper_at: None,
        size,
        album_order: None,
    };
    // local_path 唯一性硬约束：同一 content URI 已入库则放弃，发送下载错误事件。
    if let Some(existing) = Storage::find_image_by_path(content_uri).ok().flatten() {
        emit_task_log(
            task_id,
            "warn",
            task_log_i18n(
                "taskLogDedupByPath",
                json!({
                    "currentUrl": content_uri,
                    "existingId": &existing.id,
                    "existingPath": &existing.local_path,
                }),
            ),
        );
        dq.emit_state(
            task_id,
            id,
            content_uri,
            download_start_time,
            plugin_id,
            DownloadState::Failed,
            Some("duplicate path"),
            failed_image_id,
            false,
        );
        GlobalEmitter::global().emit_task_status_from_storage(task_id);
        return Ok(());
    }
    match Storage::global().add_image(image_info) {
        Ok(inserted) => {
            let image_id = inserted.id.clone();
            let ids = vec![image_id.clone()];
            let tid_add = vec![task_id.to_string()];
            GlobalEmitter::global().emit_images_change(
                "add",
                &ids,
                Some(&tid_add),
                None,
                Some(&[plugin_id.to_string()]),
            );
            if let Some(album_id) = output_album_id {
                if !album_id.trim().is_empty() {
                    let added =
                        Storage::global().add_images_to_album_silent(album_id, &[image_id.clone()]);
                    if added > 0 {
                        let alb = vec![album_id.to_string()];
                        GlobalEmitter::global().emit_album_images_change("add", &alb, &ids);
                    }
                }
            }
            dq.emit_state(
                task_id,
                id,
                content_uri,
                download_start_time,
                plugin_id,
                DownloadState::Completed,
                None,
                failed_image_id,
                false,
            );
            emit_task_image_counts_snapshot(task_id);
            clear_failed_image_after_success(failed_image_id);
            Ok(())
        }
        Err(e) => {
            if let Some(thumb) = thumbnail_path {
                let _ = tokio::fs::remove_file(thumb).await;
            }
            upsert_failed_image_on_failure(
                failed_image_id,
                task_id,
                plugin_id,
                content_uri,
                download_start_time as i64,
                e.as_str(),
                http_headers,
                metadata_id,
                custom_display_name,
            );
            dq.emit_state(
                task_id,
                id,
                content_uri,
                download_start_time,
                plugin_id,
                DownloadState::Failed,
                Some(e.as_str()),
                failed_image_id,
                false,
            );
            GlobalEmitter::global().emit_task_status_from_storage(task_id);
            Err(e)
        }
    }
}

pub enum PostprocessSource<'a> {
    /// 小文件/内存下载 → 写入 output_dir
    Bytes { output_dir: &'a Path, bytes: &'a [u8] },
    /// 文件已在磁盘上；relocate_to = Some(dir) → 移动到 dir；None → 原地处理
    Path { path: &'a Path, relocate_to: Option<&'a Path> },
}

/// 对图片数据处理，提取入库需要的参数，并在必要的时候落盘，最后入库
/// 数据为字节或者路径，字节或者路径可能被复制到另一个最终path
/// 安卓：自然下载的数据可能是在临时目录的字节或者文件，但不会被输出到任何地方，而是最后统一复制到Pictures
///       本地导入不会走这个函数（TODO：把Source扩展成可以接受content uri，从而能够走这个函数）。
/// 桌面：自然下载的数据可能是临时目录的字节或者文件，会被输出到下载目录。
///       本地导入的数据是一个文件，可能会被输出到其他目录（TODO: 暂未实现）。
pub async fn postprocess_downloaded_image(
    dq: &DownloadQueue,
    id: u64,
    source: PostprocessSource<'_>,
    delete_source: bool,
    url: &Url,
    plugin_id: &str,
    task_id: Option<&str>,
    failed_image_id: Option<i64>,
    surf_record_id: Option<&str>,
    download_start_time: u64,
    output_album_id: Option<&str>,
    http_headers: &HashMap<String, String>,
    native: bool,
    custom_display_name: Option<&str>,
    metadata_id: Option<i64>,
) -> Result<bool, String> {
    match async {
        let event_task_id = task_id.or(surf_record_id).unwrap_or_default();
        let is_surf_mode = surf_record_id.is_some();
        // 根据不同来源计算mime和哈希
        let (inferred_mime, hash, hash_ms) = match &source {
            PostprocessSource::Bytes { bytes, .. } => {
                let inferred_mime = match crate::image_type::mime_type_from_bytes(bytes) {
                    Some(mime) => mime,
                    None => {
                        return Err(format!("下载文件格式不受支持（infer）：{}", url));
                    }
                };
                let hash_start = Instant::now();
                let hash = compute_bytes_hash(bytes);
                let hash_ms = hash_start.elapsed().as_millis() as u64;
                (inferred_mime, hash, hash_ms)
            }
            PostprocessSource::Path { path, .. } => {
                let inferred_mime = match crate::image_type::mime_type_from_path(path) {
                    Some(mime) => mime,
                    None => {
                        return Err(format!("下载文件格式不受支持（infer）：{}", url));
                    }
                };
                let hash_start = Instant::now();
                let hash = match compute_file_hash(path).await {
                    Ok(h) => h,
                    Err(e) => {
                        return Err(format!("文件哈希计算出错：{}", e));
                    }
                };
                let hash_ms = hash_start.elapsed().as_millis() as u64;
                (inferred_mime, hash, hash_ms)
            }
        };
        // 算正确的扩展名，稍后用来给新文件添加扩展名，如果没有新文件就没有用。
        let inferred_ext = crate::image_type::ext_from_mime(&inferred_mime);
        let auto_deduplicate = Settings::global().get_auto_deduplicate();

        // 去重
        if auto_deduplicate {
            let existing_by_hash = Storage::find_image_by_hash(&hash).ok().flatten();
            if let Some(ref existing) = existing_by_hash {
                if let Some(album_id) = output_album_id {
                    if !album_id.trim().is_empty() {
                        let added = Storage::global()
                            .add_images_to_album_silent(album_id, &[existing.id.clone()]);
                        if added > 0 {
                            let ids = vec![existing.id.clone()];
                            let alb = vec![album_id.to_string()];
                            GlobalEmitter::global().emit_album_images_change("add", &alb, &ids);
                        }
                    }
                }
                if let Some(task_id) = task_id {
                    emit_task_log(
                        task_id,
                        "warn",
                        task_log_i18n(
                            "taskLogDedupByHash",
                            json!({
                                "currentUrl": url.to_string(),
                                "existingId": &existing.id,
                                "existingUrl": existing.url.as_deref().unwrap_or(""),
                                "existingPath": &existing.local_path,
                            }),
                        ),
                    );
                }
                // On dedup hit for Path{relocate_to: Some}, delete the temp source file.
                if let PostprocessSource::Path { path, relocate_to: Some(_) } = &source {
                    if delete_source {
                        let _ = tokio::fs::remove_file(path).await;
                    }
                }
                return Ok(false);
            }
        }

        // Save bytes reference for thumbnail generation (only available for Bytes source).
        let bytes: Option<&[u8]> = match &source {
            PostprocessSource::Bytes { bytes, .. } => Some(bytes),
            _ => None,
        };
         // Materialize final path; track whether a temp file was created (for Android cleanup).
        let mut file_created = false;
        let path = match &source {
            PostprocessSource::Bytes { output_dir, bytes } => {
                #[cfg(target_os = "android")]
                let path = {
                    let ext = inferred_ext
                        .unwrap_or_else(|| crate::image_type::default_image_extension().to_string());
                    output_dir.join(format!("{}.{}", uuid::Uuid::new_v4(), ext))
                };

                if let Err(e) = tokio::fs::create_dir_all(output_dir).await {
                    return Err(format!("Failed to create download directory: {}", e));
                }

                #[cfg(not(target_os = "android"))]
                let path = compute_unique_download_path(output_dir, url, inferred_ext.as_deref())?;

                if let Err(e) = tokio::fs::write(&path, bytes).await {
                    return Err(format!("Failed to write file: {}", e));
                }
                file_created = true;
                path
            }
            // 安卓不会走这条路，这条路只会在
            // - 下载数据过大临时文件,复制到目标文件夹
            // - 本地导入决定复制到文件夹(TODO: 未实现)
            PostprocessSource::Path {
                path: src_path,
                relocate_to: Some(dir),
            } => {
                if let Err(e) = tokio::fs::create_dir_all(dir).await {
                    return Err(format!("Failed to create directory: {}", e));
                }

                let path = compute_unique_download_path(dir, url, inferred_ext.as_deref())?;
                if !delete_source {
                    if let Err(e2) = tokio::fs::copy(src_path, &path).await {
                        return Err(format!(
                            "Failed to copy file {} ({})",
                            src_path.display(),
                            e2
                        ));
                    }
                } else {
                    if let Err(e) = tokio::fs::rename(src_path, &path).await {
                        if let Err(e2) = tokio::fs::copy(src_path, &path).await {
                            return Err(format!(
                                "Failed to copy file {} (rename: {}, copy: {})",
                                src_path.display(),
                                e,
                                e2
                            ));
                        }
                        let _ = tokio::fs::remove_file(src_path).await;
                    }
                }
                file_created = true;
                path
            }
            PostprocessSource::Path {
                path: src_path,
                relocate_to: None,
            } => {
                #[cfg(target_os = "android")]
                {
                    output_dir_target = false;
                }
                ensure_media_extension_by_infer(src_path).await
            }
        };

        match async {
            #[cfg(windows)]
            remove_zone_identifier(&path);
            let is_video = inferred_mime.starts_with("video");

            let is_content = url.scheme() == "content";

            // 这个算法要保持，不然可能不一致
            let local_path = path
                .canonicalize()
                .unwrap_or_else(|_| path.to_path_buf())
                .to_string_lossy()
                .to_string()
                .trim_start_matches("\\\\?\\")
                .to_string();

            let url_string = url.to_string();

            // 去重兜底
            if let Some(existing) = Storage::find_image_by_path(if is_content {
                &url_string
            } else {
                &local_path
            })
            .ok()
            .flatten()
            {
                if let Some(tid) = task_id {
                    emit_task_log(
                        tid,
                        "warn",
                        task_log_i18n(
                            "taskLogDedupByPath",
                            json!({
                                "currentUrl": url_string,
                                "existingId": &existing.id,
                                "existingPath": &existing.local_path,
                            }),
                        ),
                    );
                };
                if let Some(album_id) = output_album_id {
                    if !album_id.trim().is_empty() {
                        let added = Storage::global()
                            .add_images_to_album_silent(album_id, &[existing.id.clone()]);
                        if added > 0 {
                            let ids = vec![existing.id.clone()];
                            let alb = vec![album_id.to_string()];
                            GlobalEmitter::global().emit_album_images_change("add", &alb, &ids);
                        }
                    }
                }
                if file_created {
                    let _ = tokio::fs::remove_file(&path).await;
                }
                return Ok(false);
            }

            let (resolved_w, resolved_h) =
                crate::media_dimensions::resolve_media_dimensions_sync(&local_path)
                    .map(|(w, h)| (Some(w), Some(h)))
                    .unwrap_or((None, None));
            let resolved_size = if let Some(b) = bytes {
                Some(b.len() as u64)
            } else {
                crate::media_dimensions::resolve_file_size_sync(&local_path)
            };

            let t_thumb = (!auto_deduplicate).then(Instant::now);

            let thumbnail_result: Result<Option<PathBuf>, String> = if is_video {
                #[cfg(feature = "video")]
                {
                    // 安卓内部处理
                    compress::compress_video_for_preview(&path)
                        .await
                        .map(|r| Some(r.preview_path))
                }
                #[cfg(not(feature = "video"))]
                {
                    Err("video ingestion not supported in this build".to_string())
                }
            } else {
                if let Some(b) = bytes {
                    generate_thumbnail_from_bytes(b).await
                } else {
                    generate_thumbnail(&path).await
                }
            };

            let thumbnail_path = match thumbnail_result {
                Ok(t) => t,
                Err(e) => {
                    if let Some(task_id) = task_id {
                        upsert_failed_image_on_failure(
                            failed_image_id,
                            task_id,
                            plugin_id,
                            url.as_str(),
                            download_start_time as i64,
                            e.as_str(),
                            http_headers,
                            metadata_id,
                            custom_display_name,
                        );
                    }
                    dq.switch_state(id, DownloadState::Failed, Some(e.as_str())).await;
                    return Err(e);
                }
            };

            let thumb_ms = t_thumb.map(|t| t.elapsed().as_millis() as u64);

            let thumbnail_path_str = thumbnail_path
                .as_ref()
                .and_then(|p| p.canonicalize().ok())
                .map(|p| {
                    p.to_string_lossy()
                        .to_string()
                        .trim_start_matches("\\\\?\\")
                        .to_string()
                })
                .unwrap_or_else(|| local_path.clone());

            let default_name = path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("image")
                .to_string();

            let display_name = custom_display_name
                .filter(|s| !s.trim().is_empty())
                .map(|s| s.to_string())
                .unwrap_or(default_name);

            let image_info = ImageInfo {
                id: "".to_string(),
                url: if is_content {
                    None
                } else {
                    Some(url.to_string())
                },
                local_path,
                plugin_id: plugin_id.to_string(),
                task_id: task_id.map(|v| v.to_string()),
                surf_record_id: surf_record_id.map(|v| v.to_string()),
                crawled_at: download_start_time,
                metadata_id,
                metadata_version: 0,
                thumbnail_path: thumbnail_path_str,
                favorite: false,
                is_hidden: false,
                hash,
                local_exists: true,
                width: resolved_w,
                height: resolved_h,
                display_name,
                media_type: Some(inferred_mime),
                last_set_wallpaper_at: None,
                size: resolved_size,
                album_order: None,
            };

            let t_add = (!auto_deduplicate).then(Instant::now);

            let inserted = match Storage::global().add_image(image_info) {
                Ok(inserted) => {
                    let add_ms = t_add.map(|t| t.elapsed().as_millis() as u64);
                    let image_id = inserted.id.clone();
                    let t_album = (!auto_deduplicate).then(Instant::now);
                    let ids = vec![image_id.clone()];
                    let task_opt = task_id.map(|t| vec![t.to_string()]);
                    let surf_opt = surf_record_id.map(|s| vec![s.to_string()]);
                    GlobalEmitter::global().emit_images_change(
                        "add",
                        &ids,
                        task_opt.as_ref().map(|v| v.as_slice()),
                        surf_opt.as_ref().map(|v| v.as_slice()),
                        Some(&[plugin_id.to_string()]),
                    );
                    if let Some(album_id) = output_album_id {
                        if !album_id.trim().is_empty() {
                            let added = Storage::global()
                                .add_images_to_album_silent(album_id, &[image_id.clone()]);
                            if added > 0 {
                                let alb = vec![album_id.to_string()];
                                GlobalEmitter::global().emit_album_images_change("add", &alb, &ids);
                            }
                        }
                    }
                    let album_ms = t_album.map(|t| t.elapsed().as_millis() as u64);
                    if !auto_deduplicate {
                        let th = thumb_ms.unwrap_or(0);
                        let ad = add_ms.unwrap_or(0);
                        let al = album_ms.unwrap_or(0);
                        eprintln!(
                            "[Postprocess] task_id={} url={} | hash={}ms thumbnail={}ms add_image={}ms add_album={}ms total={}ms",
                            task_id.unwrap_or_default(),
                            if url.as_str().len() > 60 {
                                format!("{}...", &url.as_str()[..60])
                            } else {
                                url.to_string()
                            },
                            hash_ms,
                            th,
                            ad,
                            al,
                            hash_ms + th + ad + al
                        );
                    }
                    true
                }
                Err(e) => {
                    if let Some(ref thumb) = thumbnail_path {
                        if thumb != &path {
                            let _ = tokio::fs::remove_file(thumb).await;
                        }
                    }
                    return Err(e);
                }
            };
            if is_surf_mode && !inserted {
                return Ok(false);
            }
            Ok(inserted)
        }.await {
            Ok(imported) => Ok(imported),
            Err(e) => {
                if file_created {
                    let _ = tokio::fs::remove_file(path).await;
                }
                Err(e)
            }
        }
    }.await {
        Ok(imported) => {
            if let Some(task_id) = task_id {
                if !imported {
                    let _ = Storage::global().increment_task_dedup_count(task_id);
                }
                emit_task_image_counts_snapshot(task_id);
            }
            clear_failed_image_after_success(failed_image_id);
            dq.switch_state(id, DownloadState::Completed, None).await;
            return Ok(imported);
        }
        Err(err) => {
            if let Some(task_id) = task_id {
                GlobalEmitter::global().emit_task_log(
                    task_id,
                    "error",
                    &task_log_i18n("taskLogPostprocessFailed", json!({ "detail": err })),
                );
                upsert_failed_image_on_failure(
                    failed_image_id,
                    task_id,
                    plugin_id,
                    url.as_str(),
                    download_start_time as i64,
                    err.as_str(),
                    http_headers,
                    metadata_id,
                    custom_display_name,
                );
            }
            dq.switch_state(id, DownloadState::Failed, Some(err.as_str())).await;
            return Err(err);
        }
    }
}

/// 若 infer 得到支持的媒体类型且当前路径扩展名不匹配，则重命名为规范扩展名。
pub(crate) async fn ensure_media_extension_by_infer(path: &Path) -> PathBuf {
    let inferred = match crate::image_type::mime_type_from_path(path) {
        Some(m) => m,
        None => return path.to_path_buf(),
    };
    let want_ext = match crate::image_type::ext_from_mime(&inferred) {
        Some(e) => e,
        None => return path.to_path_buf(),
    };
    let current_ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
    if crate::image_type::is_supported_media_ext(current_ext) && current_ext == want_ext {
        return path.to_path_buf();
    }
    let new_path = path.with_extension(&want_ext);
    if new_path == *path {
        return path.to_path_buf();
    }
    if tokio::fs::rename(path, &new_path).await.is_ok() {
        new_path
    } else {
        path.to_path_buf()
    }
}

pub fn get_default_images_dir() -> PathBuf {
    crate::app_paths::AppPaths::global().images_dir()
}

/// 解析爬虫任务的输出目录：
/// - 如果用户显式指定了目录 → 直接使用
/// - 否则 Android → `temp_dir`
/// - 否则桌面 → `Settings.get_default_download_dir()`（非空） → `images_dir()`
pub fn resolve_crawl_output_dir(explicit: Option<&str>) -> PathBuf {
    if let Some(dir) = explicit {
        let trimmed = dir.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }

    #[cfg(target_os = "android")]
    {
        crate::app_paths::AppPaths::global().temp_dir.clone()
    }

    #[cfg(not(target_os = "android"))]
    {
        crate::settings::Settings::global()
            .get_default_download_dir()
            .map(PathBuf::from)
            .unwrap_or_else(get_default_images_dir)
    }
}

/// 启动时清理 downloads 临时子目录（best-effort，忽略错误）。
pub async fn clear_downloads_temp_dir() {
    let dir = crate::app_paths::AppPaths::global().downloads_temp_dir();
    let _ = tokio::fs::remove_dir_all(&dir).await;
    let _ = tokio::fs::create_dir_all(&dir).await;
}

#[cfg(test)]
mod spill_writer_tests {
    use super::{DownloadOutcome, SpillWriter, DOWNLOAD_SPILL_THRESHOLD};
    use std::io::Write;
    use std::path::PathBuf;

    const MIB: usize = 1024 * 1024;

    /// 每个用例独立的落盘目录，避免相互干扰且不依赖全局 AppPaths。
    fn temp_dir(tag: &str) -> PathBuf {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!(
            "kabegame-spillwriter-{}-{}-{}",
            tag,
            std::process::id(),
            nonce
        ))
    }

    /// 写入 `total` 字节（递增模式，便于校验内容），返回写入的原始数据。
    fn write_pattern(w: &mut SpillWriter, total: usize) -> Vec<u8> {
        let data: Vec<u8> = (0..total).map(|i| (i % 251) as u8).collect();
        w.write_all(&data).unwrap();
        data
    }

    /// 小于阈值（400 KiB）：全程留在内存，不建文件，收尾为 Bytes。
    #[test]
    fn under_threshold_stays_in_memory() {
        let dir = temp_dir("400kb");
        let mut w = SpillWriter::new_in(1, dir.clone());
        let data = write_pattern(&mut w, 400 * 1024);

        assert_eq!(w.spilled_len, 0, "不应落盘");
        assert!(w.file.is_none(), "不应建临时文件");
        assert_eq!(w.received() as usize, 400 * 1024);
        // 目录不应被创建。
        assert!(!dir.exists(), "未落盘不应创建目录");

        match w.finalize().unwrap() {
            DownloadOutcome::Bytes(b) => assert_eq!(b, data),
            DownloadOutcome::Path(_) => panic!("expected Bytes"),
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 恰好等于阈值（5 MiB）：落盘一次，收尾为 Path。
    #[test]
    fn exactly_threshold_spills_once() {
        let dir = temp_dir("5mb");
        let mut w = SpillWriter::new_in(2, dir.clone());
        write_pattern(&mut w, DOWNLOAD_SPILL_THRESHOLD);

        assert_eq!(w.spilled_len as usize, DOWNLOAD_SPILL_THRESHOLD, "落盘一次");
        assert!(w.file.is_some());
        assert_eq!(w.received() as usize, DOWNLOAD_SPILL_THRESHOLD);

        match w.finalize().unwrap() {
            DownloadOutcome::Path(p) => {
                assert_eq!(
                    std::fs::metadata(&p).unwrap().len() as usize,
                    DOWNLOAD_SPILL_THRESHOLD
                );
            }
            DownloadOutcome::Bytes(_) => panic!("expected Path"),
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 6 MiB：落盘一次（5 MiB），残余 1 MiB 收尾时刷盘，合计 6 MiB 的 Path。
    #[test]
    fn six_mib_spills_once() {
        let dir = temp_dir("6mb");
        let mut w = SpillWriter::new_in(3, dir.clone());
        let data = write_pattern(&mut w, 6 * MIB);

        assert_eq!(w.spilled_len as usize, DOWNLOAD_SPILL_THRESHOLD, "仅一次 5 MiB 溢写");
        assert_eq!(w.buffer.len(), 6 * MIB - DOWNLOAD_SPILL_THRESHOLD, "残余 1 MiB 仍在内存");
        assert_eq!(w.received() as usize, 6 * MIB);

        match w.finalize().unwrap() {
            DownloadOutcome::Path(p) => {
                assert_eq!(std::fs::metadata(&p).unwrap().len() as usize, 6 * MIB);
                assert_eq!(std::fs::read(&p).unwrap(), data, "落盘内容应与写入一致");
            }
            DownloadOutcome::Bytes(_) => panic!("expected Path"),
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 12 MiB：落盘两次（各 5 MiB），残余 2 MiB 收尾刷盘，合计 12 MiB 的 Path。
    #[test]
    fn twelve_mib_spills_twice() {
        let dir = temp_dir("12mb");
        let mut w = SpillWriter::new_in(4, dir.clone());
        let data = write_pattern(&mut w, 12 * MIB);

        assert_eq!(
            w.spilled_len as usize,
            2 * DOWNLOAD_SPILL_THRESHOLD,
            "两次 5 MiB 溢写"
        );
        assert_eq!(w.buffer.len(), 12 * MIB - 2 * DOWNLOAD_SPILL_THRESHOLD);
        assert_eq!(w.received() as usize, 12 * MIB);

        match w.finalize().unwrap() {
            DownloadOutcome::Path(p) => {
                assert_eq!(std::fs::metadata(&p).unwrap().len() as usize, 12 * MIB);
                assert_eq!(std::fs::read(&p).unwrap(), data);
            }
            DownloadOutcome::Bytes(_) => panic!("expected Path"),
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 空下载：返回空 Bytes，不建文件。
    #[test]
    fn empty_download_returns_empty_bytes() {
        let dir = temp_dir("empty");
        let w = SpillWriter::new_in(5, dir.clone());
        assert_eq!(w.received(), 0);
        match w.finalize().unwrap() {
            DownloadOutcome::Bytes(b) => assert!(b.is_empty()),
            DownloadOutcome::Path(_) => panic!("expected Bytes"),
        }
        assert!(!dir.exists());
    }

    /// 单次 `write` 最多写入 `阈值 - 缓冲长度` 字节并返回写入量，确保缓冲不超过阈值。
    #[test]
    fn single_write_is_capped_at_remaining_space() {
        let dir = temp_dir("cap");
        let mut w = SpillWriter::new_in(6, dir.clone());
        // 缓冲空 → 可写空间恰为阈值；给一个超大切片，应只接收阈值大小。
        let big = vec![1u8; 12 * MIB];
        let n = w.write(&big).unwrap();
        assert_eq!(n, DOWNLOAD_SPILL_THRESHOLD, "单次 write 应被截到剩余空间");
        // 写满即落盘，缓冲被清空。
        assert_eq!(w.spilled_len as usize, DOWNLOAD_SPILL_THRESHOLD);
        assert!(w.buffer.len() < DOWNLOAD_SPILL_THRESHOLD);
        let _ = w.finalize();
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 多次小块写入跨过阈值（6×1 MiB，模拟流式 / 续传累积）：仍只在累计到阈值时落盘一次。
    #[test]
    fn many_small_writes_accumulate_then_spill() {
        let dir = temp_dir("small-writes");
        let mut w = SpillWriter::new_in(7, dir.clone());
        let mut expected = Vec::new();
        for _ in 0..6 {
            let chunk = vec![5u8; MIB];
            w.write_all(&chunk).unwrap();
            expected.extend_from_slice(&chunk);
        }
        assert_eq!(w.spilled_len as usize, DOWNLOAD_SPILL_THRESHOLD, "累计到 5 MiB 落盘一次");
        assert_eq!(w.received() as usize, 6 * MIB);
        match w.finalize().unwrap() {
            DownloadOutcome::Path(p) => assert_eq!(std::fs::read(&p).unwrap(), expected),
            DownloadOutcome::Bytes(_) => panic!("expected Path"),
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 截断 `clear`：删除已落盘的临时文件并把状态归零（服务端不支持 Range 的场景）。
    #[test]
    fn clear_truncates_and_removes_temp_file() {
        let dir = temp_dir("clear");
        let mut w = SpillWriter::new_in(8, dir.clone());
        write_pattern(&mut w, 6 * MIB);
        let spilled_path = w.path.clone().expect("应已落盘建文件");
        assert!(spilled_path.exists());

        w.clear();
        assert!(!spilled_path.exists(), "clear 应删除临时文件");
        assert_eq!(w.received(), 0);
        assert!(w.file.is_none() && w.path.is_none());

        // 截断后可重新下载并独立收尾为内存 Bytes。
        let data = write_pattern(&mut w, 400 * 1024);
        match w.finalize().unwrap() {
            DownloadOutcome::Bytes(b) => assert_eq!(b, data),
            DownloadOutcome::Path(_) => panic!("expected Bytes after clear"),
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
