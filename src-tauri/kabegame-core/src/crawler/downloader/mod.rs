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
use std::pin::Pin;
use std::task::{Context, Poll, ready};
use std::time::Instant;
use tokio::io::{AsyncWrite, AsyncWriteExt};
use tokio::sync::Notify;
use tokio::time::{Duration, sleep};
use url::Url;

pub const DATA_URI_PLACEHOLDER: &str = "data:dummy";

pub mod compress;
#[cfg(target_os = "android")]
mod content;
mod http;
pub mod media_upload;
pub mod queue;
pub mod util;

pub use compress::{
    IMAGE_COMPATIBLE_MAX_DIM, generate_compatible_image, generate_compatible_image_from_bytes,
};
pub use compress::{
    IMAGE_THUMBNAIL_MAX_DIM, IMAGE_THUMBNAIL_SOURCE_THRESHOLD_BYTES, generate_thumbnail,
    generate_thumbnail_from_bytes, image_needs_independent_thumbnail,
    image_thumbnail_dimensions_acceptable,
};
#[cfg(not(target_os = "android"))]
pub use compress::{VIDEO_COMPATIBLE_MAX_HEIGHT, generate_compatible_video};
pub use http::{build_reqwest_header_map, create_client};
pub use queue::{
    ActiveDownloadInfo, DownloadQueue, DownloadRequest, DownloadState, emit_removed_after_interval,
    next_download_id,
};
pub use util::{
    build_safe_filename, build_safe_filename_no_ext, compute_bytes_hash, compute_file_hash,
    compute_unique_download_path, compute_unique_download_path_with_name, unique_path,
};

use queue::{
    clear_failed_image_after_success, emit_task_image_counts_snapshot,
    upsert_failed_image_on_failure,
};
#[cfg(target_os = "android")]
use util::derive_display_name_from_url;
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

/// 进度上报节流间隔（毫秒）：writer 在写路径上每隔该时长才上报一次。
pub(crate) const PROGRESS_EMIT_INTERVAL_MS: u64 = 200;

/// 下载写入目标抽象：下载器只见 `&mut dyn DownloadWriter`，只管写字节 + 声明大小，
/// **不感知溢写 / 进度 / 队列**。`set_total` 用于声明 Content-Length 以得到确定进度。
pub(crate) trait DownloadWriter: AsyncWrite + Send + Unpin {
    /// 声明总字节数（HTTP Content-Length / content 已知大小）；未知传 None。
    fn set_total(&mut self, total: Option<u64>);
    /// 向任务日志发送 warn 级消息；默认空实现（测试 writer 不需要上报）。
    fn warn(&mut self, _message: String) {}
}

/// [`DownloadWriter`] 的实现：内存缓冲 + 溢写临时文件，并在写路径上把进度经
/// [`DownloadQueue::report_progress`] 上报（更新 `ActiveDownloadInfo` + 发 `download-progress`）。
///
/// **由 `download_with_retry` 私有持有，以 `&mut dyn DownloadWriter` 形式传给 `download`。**
/// 内存缓冲累计到 [`DOWNLOAD_SPILL_THRESHOLD`] 时落盘到 `downloads_temp_dir()/{id}.part` 并清空缓冲。
/// 续传 / 截断 / 收尾由外部通过 [`Self::received`] / [`Self::clear`] / [`Self::finalize`] 决定。
struct SpillWriter {
    buffer: Vec<u8>,
    spilled_len: u64,
    file: Option<tokio::fs::File>,
    path: Option<PathBuf>,
    download_id: u64,
    downloads_dir: PathBuf,
    /// 总字节数（由 `set_total` 声明）。
    total: Option<u64>,
    /// 进度上报节流时间戳。
    last_emit: Instant,
    /// 队列句柄（cheap Clone，仅持 Arc）；测试构造时为 None，跳过上报。
    dq: Option<DownloadQueue>,
    /// 正在把 `buffer` 落盘:置位时 `poll_write` 先把缓冲写完再接收新输入。
    spilling: bool,
    /// 本次落盘已写入文件的字节数（跨多次 poll 续写）。
    spill_pos: usize,
}

impl SpillWriter {
    fn new(download_id: u64, dq: &DownloadQueue) -> Self {
        let mut w = Self::new_in(
            download_id,
            crate::app_paths::AppPaths::global().downloads_temp_dir(),
        );
        w.dq = Some(dq.clone());
        w
    }

    fn new_in(download_id: u64, downloads_dir: PathBuf) -> Self {
        Self {
            buffer: Vec::with_capacity(64 * 1024),
            spilled_len: 0,
            file: None,
            path: None,
            download_id,
            downloads_dir,
            total: None,
            last_emit: Instant::now(),
            dq: None,
            spilling: false,
            spill_pos: 0,
        }
    }

    /// 已累计接收字节数（落盘 + 缓冲），用作 Range 续传与进度基准。
    fn received(&self) -> u64 {
        self.spilled_len + self.buffer.len() as u64
    }

    /// 节流上报进度（写路径调用）。
    fn maybe_report(&mut self) {
        if self.dq.is_none() {
            return;
        }
        if self.last_emit.elapsed().as_millis() as u64 >= PROGRESS_EMIT_INTERVAL_MS {
            self.last_emit = Instant::now();
            let (id, received, total) = (self.download_id, self.received(), self.total);
            if let Some(dq) = &self.dq {
                dq.report_progress(id, received, total);
            }
        }
    }

    /// 强制上报一次当前进度（set_total / 收尾用）。
    fn report_now(&self) {
        if let Some(dq) = &self.dq {
            dq.report_progress(self.download_id, self.received(), self.total);
        }
    }

    /// 把 `buffer` 落盘到临时文件（跨多次 poll 续写,完成后清空缓冲并累加 `spilled_len`）。
    fn poll_drive_spill(&mut self, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        if self.file.is_none() {
            std::fs::create_dir_all(&self.downloads_dir)?;
            let path = self
                .downloads_dir
                .join(format!("{}.part", self.download_id));
            let std_file = std::fs::File::create(&path)?;
            self.file = Some(tokio::fs::File::from_std(std_file));
            self.path = Some(path);
        }
        let Self {
            file,
            buffer,
            spill_pos,
            spilled_len,
            spilling,
            ..
        } = self;
        let file = file.as_mut().unwrap();
        while *spill_pos < buffer.len() {
            let n = ready!(Pin::new(&mut *file).poll_write(cx, &buffer[*spill_pos..]))?;
            *spill_pos += n;
        }
        *spilled_len += buffer.len() as u64;
        buffer.clear();
        *spill_pos = 0;
        *spilling = false;
        Poll::Ready(Ok(()))
    }

    /// 截断：丢弃缓冲与临时文件并归零（服务端不支持 Range、需从头重下时）。
    fn clear(&mut self) {
        self.buffer.clear();
        self.spilled_len = 0;
        self.spill_pos = 0;
        self.spilling = false;
        self.file = None; // 先释放句柄再删文件（Windows 要求）
        if let Some(path) = self.path.take() {
            let _ = std::fs::remove_file(path);
        }
    }

    /// 收尾：曾落盘 → 刷入剩余缓冲并返回 Path；否则返回内存 Bytes。
    /// 注意:`poll_write` 可能在落盘未完成（`spilling` 仍为 true、已写到 `spill_pos`）时就返回,
    /// 因此这里要从 `spill_pos` 续写剩余缓冲,不能整段重写。
    async fn finalize(mut self) -> std::io::Result<DownloadOutcome> {
        if self.file.is_some() {
            // 未落盘起点:进行中的落盘从 spill_pos 续写,否则整段缓冲都要追加。
            let from = if self.spilling { self.spill_pos } else { 0 };
            if from < self.buffer.len() {
                let f = self.file.as_mut().unwrap();
                f.write_all(&self.buffer[from..]).await?;
            }
            self.spilled_len += self.buffer.len() as u64;
            self.buffer.clear();
            self.spill_pos = 0;
            self.spilling = false;
            if let Some(mut f) = self.file.take() {
                f.flush().await?;
            }
            self.report_now();
            return Ok(DownloadOutcome::Path(self.path.take().unwrap()));
        }
        self.report_now();
        Ok(DownloadOutcome::Bytes(self.buffer))
    }
}

impl AsyncWrite for SpillWriter {
    /// 先把内存缓冲写满到阈值再落盘:正在落盘时返回 Pending（不接收新输入,防缓冲越界）;
    /// 落盘完成后接收新输入,达到阈值则开始下一轮落盘。进度按间隔节流上报。
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        let download_id = self.download_id;
        if let Some(dq) = self.dq.as_ref() {
            if dq.is_download_canceled_sync(download_id) {
                return Poll::Ready(Err(std::io::Error::new(
                    std::io::ErrorKind::Interrupted,
                    "Task canceled",
                )));
            }
        }
        let this = self.get_mut();
        // 1. 若有进行中的落盘,先驱动完成(未完成则 Pending,本次不接收新输入)。
        if this.spilling {
            ready!(this.poll_drive_spill(cx))?;
        }
        // 2. 接收输入到缓冲(限制不超过阈值)。
        let space = DOWNLOAD_SPILL_THRESHOLD - this.buffer.len();
        let n = buf.len().min(space);
        this.buffer.extend_from_slice(&buf[..n]);
        this.maybe_report();
        // 3. 缓冲满阈值则开始落盘;Pending 也无妨,已消费 n,下次 poll 会先续写。
        if this.buffer.len() >= DOWNLOAD_SPILL_THRESHOLD {
            this.spilling = true;
            let _ = this.poll_drive_spill(cx)?;
        }
        Poll::Ready(Ok(n))
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        let this = self.get_mut();
        if this.spilling {
            ready!(this.poll_drive_spill(cx))?;
        }
        if let Some(f) = this.file.as_mut() {
            ready!(Pin::new(f).poll_flush(cx))?;
        }
        Poll::Ready(Ok(()))
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        let this = self.get_mut();
        if this.spilling {
            ready!(this.poll_drive_spill(cx))?;
        }
        if let Some(f) = this.file.as_mut() {
            ready!(Pin::new(f).poll_shutdown(cx))?;
        }
        Poll::Ready(Ok(()))
    }
}

impl DownloadWriter for SpillWriter {
    fn set_total(&mut self, total: Option<u64>) {
        self.total = total;
        self.report_now();
    }

    fn warn(&mut self, message: String) {
        if let Some(dq) = &self.dq {
            dq.emit_log_by_download_id(self.download_id, "warn", message);
        }
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
        url: &Url,
        headers: &HashMap<String, String>,
        out: &mut dyn DownloadWriter,
        already_received: u64,
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
                url: &Url,
                headers: &HashMap<String, String>,
                out: &mut dyn DownloadWriter,
                already_received: u64,
            ) -> Result<(), DownloadAttemptError> {
                match self {
                    $(SchemeDownloaderEnum::$variant(d) => d.download(url, headers, out, already_received).await,)*
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
    // download_with_retry 私有持有溢写状态：以抽象 DownloadWriter 形式传给 download，
    // 何时清空 / 落盘 / 收尾都在 download 返回后由本函数决定。
    let mut writer = SpillWriter::new(download_id, dq);

    for attempt in 1..=max_attempts {
        if dq.is_download_canceled(download_id).await {
            writer.clear();
            return Err("Task canceled".into());
        }

        // 已接收量 >0 表示续传：download 据此发送 Range。
        let already_received = writer.received();
        match downloader
            .download(&parsed, headers, &mut writer, already_received)
            .await
        {
            // 流结束：曾落盘 → Path，否则 → Bytes。
            Ok(()) => {
                return writer
                    .finalize()
                    .await
                    .map_err(|e| format!("finalize download: {e}"));
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

/// 非下载池路径（本地导入、本地文件夹同步）使用：
/// 确保单个文件处理从开始到结束至少间隔设置中的下载间隔。
pub async fn wait_after_non_pool_download_if_needed(download_start_time: u64) {
    wait_until_download_interval_elapsed(download_start_time, download_interval_ms()).await;
}

/// 每次下载完成后，按设置等待一段时间再进入下一轮；等待期间可被 exit_notify 中断。
pub async fn wait_after_download_if_needed(start_time: u64, exit_notify: Option<&Notify>) {
    let interval_ms = download_interval_ms();
    if interval_ms == 0 {
        return;
    }
    let elapsed = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
        - start_time;
    if elapsed < interval_ms {
        let remaining = interval_ms - elapsed;
        match exit_notify {
            Some(exit_notify) => {
                tokio::select! {
                    _ = sleep(Duration::from_millis(remaining)) => {}
                    _ = exit_notify.notified() => {}
                }
            }
            None => {
                sleep(Duration::from_millis(remaining)).await;
            }
        }
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

pub enum PostprocessSource<'a> {
    /// 小文件/内存下载 → 写入 output_dir
    Bytes {
        output_dir: &'a Path,
        bytes: &'a [u8],
    },
    /// 文件已在磁盘上；relocate_to = Some(dir) → 移动到 dir；None → 原地处理
    Path {
        path: &'a Path,
        relocate_to: Option<&'a Path>,
    },
    /// Android content:// URI —— url 参数即为 URI；所有元数据通过 ContentIoProvider 解析，不在 Rust 持有字节。
    #[cfg(target_os = "android")]
    ContentUri,
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
    _native: bool,
    custom_display_name: Option<&str>,
    metadata_id: Option<i64>,
    post_url: Option<&str>,
) -> Result<bool, String> {
    match async {
        let is_surf_mode = surf_record_id.is_some();
        // 根据不同来源计算 MIME 和哈希。图片/普通文件仍由 infer 负责格式判定；
        // Android content:// 由系统 ContentIoProvider 提供 MIME。
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
            #[cfg(target_os = "android")]
            PostprocessSource::ContentUri => {
                use crate::crawler::content_io::get_content_io_provider;
                let io = get_content_io_provider();
                let inferred_mime = io
                    .get_mime_type(url.as_str())
                    .await
                    .ok()
                    .flatten()
                    .unwrap_or_else(|| crate::image_type::default_image_mime().to_string());
                let hash_start = Instant::now();
                let hash = match io.compute_hash(url.as_str()).await {
                    Ok(h) => h,
                    Err(e) => return Err(format!("content URI 哈希计算出错：{e}")),
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
            #[cfg(target_os = "android")]
            PostprocessSource::ContentUri => None,
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
                let path = compute_unique_download_path_with_name(
                    output_dir,
                    url,
                    inferred_ext.as_deref(),
                    custom_display_name,
                )?;

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

                let path = compute_unique_download_path_with_name(
                    dir,
                    url,
                    inferred_ext.as_deref(),
                    custom_display_name,
                )?;
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
                src_path.to_path_buf().clone()
            }
            #[cfg(target_os = "android")]
            PostprocessSource::ContentUri => {
                // URI 作为 "path"；canonicalize 会失败并回退到原字符串，local_path 即为 URI。
                PathBuf::from(url.as_str())
            }
        };

        match async {
            #[cfg(windows)]
            remove_zone_identifier(&path);
            let is_video = inferred_mime.starts_with("video");

            let is_content = url.scheme() == "content";

            // 这个算法要保持，不然可能不一致
            // Android 复制进媒体库后会把 local_path 改写为 content URI；桌面不改写。
            #[cfg_attr(not(target_os = "android"), allow(unused_mut))]
            let mut local_path = path
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

            // Android：把下载到的临时文件复制进系统媒体库（图片→Pictures，视频→Movies），
            // 得到 content:// URI；之后尺寸/预览/大小/名称解析与入库 local_path 都用该 URI。
            // 视频必须如此：Android 的 compress_video_for_preview 只接受 content URI。
            // ContentUri 源（本地 content:// 导入）已是 URI，跳过复制。
            #[cfg(target_os = "android")]
            if !matches!(&source, PostprocessSource::ContentUri) {
                use crate::crawler::content_io::get_content_io_provider;
                let copy_name = custom_display_name
                    .filter(|s| !s.trim().is_empty())
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| {
                        path.file_name()
                            .and_then(|n| n.to_str())
                            .unwrap_or("image")
                            .to_string()
                    });
                let uri = get_content_io_provider()
                    .copy_image_to_pictures(&local_path, &inferred_mime, &copy_name)
                    .await?;
                // 临时文件已进库，删除
                let _ = tokio::fs::remove_file(&path).await;
                local_path = uri;
            }

            #[cfg(target_os = "android")]
            let (resolved_w, resolved_h) = {
                use crate::crawler::content_io::get_content_io_provider;
                let io = get_content_io_provider();
                let r = if is_video {
                    io.get_video_dimensions(&local_path).await
                } else {
                    io.get_image_dimensions(&local_path).await
                };
                r.ok().map(|(w, h)| (Some(w), Some(h))).unwrap_or((None, None))
            };
            #[cfg(not(target_os = "android"))]
            let (resolved_w, resolved_h) =
                crate::media_dimensions::resolve_media_dimensions_sync(&local_path)
                    .map(|(w, h)| (Some(w), Some(h)))
                    .unwrap_or((None, None));

            #[cfg(target_os = "android")]
            let resolved_size = if let Some(b) = bytes {
                Some(b.len() as u64)
            } else {
                // 溢写文件已复制进库并删除，改用 content URI 读取大小。
                use crate::crawler::content_io::get_content_io_provider;
                get_content_io_provider().get_content_size(&local_path).await.ok()
            };
            #[cfg(not(target_os = "android"))]
            let resolved_size = if let Some(b) = bytes {
                Some(b.len() as u64)
            } else {
                crate::media_dimensions::resolve_file_size_sync(&local_path)
            };

            let t_thumb = (!auto_deduplicate).then(Instant::now);

            let thumbnail_result: Result<Option<PathBuf>, String> = if is_video {
                // 视频预览是尽力而为：失败只记日志、不阻断入库。画廊用 <video> 直接播放原文件，
                // thumbnail 回退为原文件（见下方 thumbnail_path_str 的 local_path 兜底）。典型场景：
                // 本 ffmpeg 构建缺该编码的解码器（如未启用 av1 解码器时的 AV1）。
                #[cfg(target_os = "android")]
                // local_path 此时是系统媒体库 content URI，交给 Kotlin provider 生成预览。
                let preview = compress::compress_video_for_preview(&local_path).await;
                #[cfg(not(target_os = "android"))]
                let preview = compress::compress_video_for_preview(&path).await;
                match preview {
                    Ok(r) => Ok(Some(r.preview_path)),
                    Err(e) => {
                        eprintln!(
                            "[downloader] video preview generation failed, storing without preview: {e}"
                        );
                        Ok(None)
                    }
                }
            } else {
                #[cfg(target_os = "android")]
                if let Some(b) = bytes {
                    // 内存字节直接生成缩略图，最可靠，无需依赖系统缩略图。
                    generate_thumbnail_from_bytes(b).await
                } else {
                    // 溢写文件已删除，改用系统 content URI 缩略图。
                    use crate::crawler::content_io::get_content_io_provider;
                    let thumbnails_dir = crate::app_paths::AppPaths::global().thumbnails_dir();
                    let _ = tokio::fs::create_dir_all(&thumbnails_dir).await;
                    let thumb_path = thumbnails_dir
                        .join(format!("{}.jpg", uuid::Uuid::new_v4()));
                    match get_content_io_provider()
                        .get_image_thumbnail(&local_path, thumb_path.to_str().unwrap_or(""))
                        .await
                    {
                        Ok(()) => Ok(Some(thumb_path)),
                        Err(_) => Ok(None),
                    }
                }
                #[cfg(not(target_os = "android"))]
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

            // local_path 此时是系统媒体库 content URI，取库内最终展示名（可能被系统去重改名）。
            #[cfg(target_os = "android")]
            let default_name = {
                use crate::crawler::content_io::get_content_io_provider;
                get_content_io_provider()
                    .get_display_name(&local_path)
                    .await
                    .unwrap_or_else(|_| "image".to_string())
            };
            #[cfg(not(target_os = "android"))]
            let default_name = path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("image")
                .to_string();

            let display_name = custom_display_name
                .filter(|s| !s.trim().is_empty())
                .map(|s| s.to_string())
                .unwrap_or(default_name);

            // 生成浏览器兼容副本（格式不支持或超大图）。失败只记日志，不阻断入库。
            #[cfg(not(target_os = "android"))]
            let compatible_result = if is_video {
                match crate::media_dimensions::probe_media_sync(&path) {
                    Some(probe) => compress::generate_compatible_video(&path, &probe).await,
                    None => Ok(None),
                }
            } else {
                match (resolved_w, resolved_h) {
                    (Some(w), Some(h)) => {
                        compress::generate_compatible_image(&path, &inferred_mime, w, h).await
                    }
                    _ => Ok(None),
                }
            };

            #[cfg(target_os = "android")]
            let compatible_result = if is_video {
                Ok(None)
            } else {
                match (resolved_w, resolved_h) {
                    (Some(w), Some(h)) => {
                        if let Some(bytes) = bytes {
                            compress::generate_compatible_image_from_bytes(
                                bytes,
                                &inferred_mime,
                                w,
                                h,
                            )
                            .await
                        } else {
                            use std::os::fd::{FromRawFd, OwnedFd};
                            match get_content_io_provider().open_fd(&local_path).await {
                                Ok(fd) => {
                                    // 持有原始 content fd，直至 FFmpeg 完成 `/proc/self/fd/N` 解码。
                                    let owned = unsafe { OwnedFd::from_raw_fd(fd) };
                                    let proc_path = PathBuf::from(format!("/proc/self/fd/{fd}"));
                                    let result = compress::generate_compatible_image(
                                        &proc_path,
                                        &inferred_mime,
                                        w,
                                        h,
                                    )
                                    .await;
                                    drop(owned);
                                    result
                                }
                                Err(e) => Err(format!(
                                    "open content URI for compatible image failed: {e}"
                                )),
                            }
                        }
                    }
                    _ => Ok(None),
                }
            };

            let compatible_path_str: Option<String> = match compatible_result {
                Ok(Some(path)) => path.canonicalize().ok().map(|canonical| {
                    canonical
                        .to_string_lossy()
                        .to_string()
                        .trim_start_matches("\\\\?\\")
                        .to_string()
                }),
                Ok(None) => None,
                Err(e) => {
                    eprintln!("[downloader] compatible generation failed: {e}");
                    None
                }
            };

            let image_info = ImageInfo {
                id: "".to_string(),
                url: if is_content {
                    None
                } else if url.scheme() == "data" {
                    Some(DATA_URI_PLACEHOLDER.to_string())
                } else {
                    Some(url.to_string())
                },
                local_path,
                plugin_id: if surf_record_id.is_some() {
                    None
                } else {
                    Some(plugin_id.to_string())
                },
                task_id: task_id.map(|v| v.to_string()),
                surf_record_id: surf_record_id.map(|v| v.to_string()),
                crawled_at: download_start_time,
                metadata_id,
                plugin_version: 0,
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
                compatible_path: compatible_path_str,
                post_url: post_url.map(|s| s.to_string()),
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
    use super::{DOWNLOAD_SPILL_THRESHOLD, DownloadOutcome, SpillWriter};
    use std::path::PathBuf;
    use tokio::io::AsyncWriteExt;

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
    /// 写完 `flush` 以把进行中的落盘驱动完成,使后续中间态断言确定。
    async fn write_pattern(w: &mut SpillWriter, total: usize) -> Vec<u8> {
        let data: Vec<u8> = (0..total).map(|i| (i % 251) as u8).collect();
        w.write_all(&data).await.unwrap();
        w.flush().await.unwrap();
        data
    }

    /// 小于阈值（400 KiB）：全程留在内存，不建文件，收尾为 Bytes。
    #[tokio::test]
    async fn under_threshold_stays_in_memory() {
        let dir = temp_dir("400kb");
        let mut w = SpillWriter::new_in(1, dir.clone());
        let data = write_pattern(&mut w, 400 * 1024).await;

        assert_eq!(w.spilled_len, 0, "不应落盘");
        assert!(w.file.is_none(), "不应建临时文件");
        assert_eq!(w.received() as usize, 400 * 1024);
        // 目录不应被创建。
        assert!(!dir.exists(), "未落盘不应创建目录");

        match w.finalize().await.unwrap() {
            DownloadOutcome::Bytes(b) => assert_eq!(b, data),
            DownloadOutcome::Path(_) => panic!("expected Bytes"),
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 恰好等于阈值（5 MiB）：落盘一次，收尾为 Path。
    #[tokio::test]
    async fn exactly_threshold_spills_once() {
        let dir = temp_dir("5mb");
        let mut w = SpillWriter::new_in(2, dir.clone());
        write_pattern(&mut w, DOWNLOAD_SPILL_THRESHOLD).await;

        assert_eq!(w.spilled_len as usize, DOWNLOAD_SPILL_THRESHOLD, "落盘一次");
        assert!(w.file.is_some());
        assert_eq!(w.received() as usize, DOWNLOAD_SPILL_THRESHOLD);

        match w.finalize().await.unwrap() {
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
    #[tokio::test]
    async fn six_mib_spills_once() {
        let dir = temp_dir("6mb");
        let mut w = SpillWriter::new_in(3, dir.clone());
        let data = write_pattern(&mut w, 6 * MIB).await;

        assert_eq!(
            w.spilled_len as usize, DOWNLOAD_SPILL_THRESHOLD,
            "仅一次 5 MiB 溢写"
        );
        assert_eq!(
            w.buffer.len(),
            6 * MIB - DOWNLOAD_SPILL_THRESHOLD,
            "残余 1 MiB 仍在内存"
        );
        assert_eq!(w.received() as usize, 6 * MIB);

        match w.finalize().await.unwrap() {
            DownloadOutcome::Path(p) => {
                assert_eq!(std::fs::metadata(&p).unwrap().len() as usize, 6 * MIB);
                assert_eq!(std::fs::read(&p).unwrap(), data, "落盘内容应与写入一致");
            }
            DownloadOutcome::Bytes(_) => panic!("expected Path"),
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 12 MiB：落盘两次（各 5 MiB），残余 2 MiB 收尾刷盘，合计 12 MiB 的 Path。
    #[tokio::test]
    async fn twelve_mib_spills_twice() {
        let dir = temp_dir("12mb");
        let mut w = SpillWriter::new_in(4, dir.clone());
        let data = write_pattern(&mut w, 12 * MIB).await;

        assert_eq!(
            w.spilled_len as usize,
            2 * DOWNLOAD_SPILL_THRESHOLD,
            "两次 5 MiB 溢写"
        );
        assert_eq!(w.buffer.len(), 12 * MIB - 2 * DOWNLOAD_SPILL_THRESHOLD);
        assert_eq!(w.received() as usize, 12 * MIB);

        match w.finalize().await.unwrap() {
            DownloadOutcome::Path(p) => {
                assert_eq!(std::fs::metadata(&p).unwrap().len() as usize, 12 * MIB);
                assert_eq!(std::fs::read(&p).unwrap(), data);
            }
            DownloadOutcome::Bytes(_) => panic!("expected Path"),
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 空下载：返回空 Bytes，不建文件。
    #[tokio::test]
    async fn empty_download_returns_empty_bytes() {
        let dir = temp_dir("empty");
        let w = SpillWriter::new_in(5, dir.clone());
        assert_eq!(w.received(), 0);
        match w.finalize().await.unwrap() {
            DownloadOutcome::Bytes(b) => assert!(b.is_empty()),
            DownloadOutcome::Path(_) => panic!("expected Bytes"),
        }
        assert!(!dir.exists());
    }

    /// 单次 `write` 最多写入 `阈值 - 缓冲长度` 字节并返回写入量，确保缓冲不超过阈值。
    #[tokio::test]
    async fn single_write_is_capped_at_remaining_space() {
        let dir = temp_dir("cap");
        let mut w = SpillWriter::new_in(6, dir.clone());
        // 缓冲空 → 可写空间恰为阈值；给一个超大切片，应只接收阈值大小。
        let big = vec![1u8; 12 * MIB];
        let n = w.write(&big).await.unwrap();
        assert_eq!(n, DOWNLOAD_SPILL_THRESHOLD, "单次 write 应被截到剩余空间");
        // 写满即落盘（flush 驱动完成），缓冲被清空。
        w.flush().await.unwrap();
        assert_eq!(w.spilled_len as usize, DOWNLOAD_SPILL_THRESHOLD);
        assert!(w.buffer.len() < DOWNLOAD_SPILL_THRESHOLD);
        let _ = w.finalize().await;
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 多次小块写入跨过阈值（6×1 MiB，模拟流式 / 续传累积）：仍只在累计到阈值时落盘一次。
    #[tokio::test]
    async fn many_small_writes_accumulate_then_spill() {
        let dir = temp_dir("small-writes");
        let mut w = SpillWriter::new_in(7, dir.clone());
        let mut expected = Vec::new();
        for _ in 0..6 {
            let chunk = vec![5u8; MIB];
            w.write_all(&chunk).await.unwrap();
            expected.extend_from_slice(&chunk);
        }
        w.flush().await.unwrap();
        assert_eq!(
            w.spilled_len as usize, DOWNLOAD_SPILL_THRESHOLD,
            "累计到 5 MiB 落盘一次"
        );
        assert_eq!(w.received() as usize, 6 * MIB);
        match w.finalize().await.unwrap() {
            DownloadOutcome::Path(p) => assert_eq!(std::fs::read(&p).unwrap(), expected),
            DownloadOutcome::Bytes(_) => panic!("expected Path"),
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 截断 `clear`：删除已落盘的临时文件并把状态归零（服务端不支持 Range 的场景）。
    #[tokio::test]
    async fn clear_truncates_and_removes_temp_file() {
        let dir = temp_dir("clear");
        let mut w = SpillWriter::new_in(8, dir.clone());
        write_pattern(&mut w, 6 * MIB).await;
        let spilled_path = w.path.clone().expect("应已落盘建文件");
        assert!(spilled_path.exists());

        w.clear();
        assert!(!spilled_path.exists(), "clear 应删除临时文件");
        assert_eq!(w.received(), 0);
        assert!(w.file.is_none() && w.path.is_none());

        // 截断后可重新下载并独立收尾为内存 Bytes。
        let data = write_pattern(&mut w, 400 * 1024).await;
        match w.finalize().await.unwrap() {
            DownloadOutcome::Bytes(b) => assert_eq!(b, data),
            DownloadOutcome::Path(_) => panic!("expected Bytes after clear"),
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
