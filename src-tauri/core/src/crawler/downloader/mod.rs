use async_trait::async_trait;
#[cfg(target_os = "android")]
use crate::crawler::content_io::get_content_io_provider;
use crate::crawler::decompression::DecompressionJob;
use crate::emitter::GlobalEmitter;
use crate::settings::Settings;
use crate::storage::{ImageInfo, Storage, FAVORITE_ALBUM_ID};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{Mutex, Notify, RwLock};
use tokio::time::{sleep, Duration};
use url::Url;

mod content;
mod file;
mod http;

pub use crate::crawler::archiver::ArchiveType;
pub use http::{build_reqwest_header_map_for_emitter, create_client};

/// 下载执行类型：按 scheme 选择 http / file / content 的具体实现。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum UrlDownloaderKind {
    Http,
    /// file://：什么都不做，只返回本地路径（去掉 file 前缀）。
    File,
    /// content://（Android）：复制前需通过 [set_content_permission_register] 注册可访问权限
    ///（如 Kotlin 侧调用 `contentResolver.takePersistableUriPermission(uri, FLAG_GRANT_READ_URI_PERMISSION)`）。
    Content,
}

/// 下载进度上报上下文（仅 HTTP 等需要流式进度的 scheme 使用）。
#[derive(Clone, Copy)]
pub struct DownloadProgressContext<'a> {
    pub plugin_id: &'a str,
    pub start_time: u64,
}

/// 按 scheme 区分的下载器：计算目标路径由各 scheme 实现，下载由 [UrlDownloaderKind] 分发。
#[async_trait]
pub trait SchemeDownloader: Send + Sync {
    /// 支持的 URL scheme 列表（如 `["http", "https"]`）。
    fn supported_schemes(&self) -> &[&'static str];
    /// 根据 URL 和基础目录计算下载目标路径（不创建文件）。
    fn compute_destination_path(&self, url: &Url, base_dir: &Path) -> Result<PathBuf, String>;
    /// 用于实际执行下载的分发类型。
    fn download_kind(&self) -> UrlDownloaderKind;
    /// 执行下载：将 `url` 下载到 `dest`，`task_id` 用于查表获取任务的 http_headers、重试次数等。
    /// `progress` 必传，用于上报进度（前端始终预期有进度事件）。
    /// 返回成功时的最终 URL 或本地路径字符串。
    async fn download(
        &self,
        dq: &DownloadQueue,
        url: &Url,
        dest: &Path,
        task_id: &str,
        progress: &DownloadProgressContext<'_>,
    ) -> Result<String, String>;
}

/// 宏：根据 (scheme 列表, 变体名, 类型路径) 静态生成枚举、trait 实现和注册表，避免重复代码。
macro_rules! define_scheme_downloader_registry {
    ($( ($schemes:expr, $variant:ident, $type:path) ),* $(,)?) => {
        enum SchemeDownloaderEnum {
            $($variant($type),)*
        }

        #[async_trait]
        impl SchemeDownloader for SchemeDownloaderEnum {
            fn supported_schemes(&self) -> &[&'static str] {
                match self {
                    $(SchemeDownloaderEnum::$variant(d) => d.supported_schemes(),)*
                }
            }

            fn compute_destination_path(&self, url: &Url, base_dir: &Path) -> Result<PathBuf, String> {
                match self {
                    $(SchemeDownloaderEnum::$variant(d) => d.compute_destination_path(url, base_dir),)*
                }
            }

            fn download_kind(&self) -> UrlDownloaderKind {
                match self {
                    $(SchemeDownloaderEnum::$variant(d) => d.download_kind(),)*
                }
            }

            async fn download(
                &self,
                dq: &DownloadQueue,
                url: &Url,
                dest: &Path,
                task_id: &str,
                progress: &DownloadProgressContext<'_>,
            ) -> Result<String, String> {
                match self {
                    $(SchemeDownloaderEnum::$variant(d) => d.download(dq, url, dest, task_id, progress).await,)*
                }
            }
        }

        /// 静态下载器注册表：(scheme 列表, 下载器)。无需 OnceLock，编译期确定。
        static DOWNLOADER_REGISTRY: &[(&[&'static str], SchemeDownloaderEnum)] = &[
            $(($schemes, SchemeDownloaderEnum::$variant($type)),)*
        ];
    };
}

define_scheme_downloader_registry! {
    (&["http", "https"], Http, http::HttpSchemeDownloader),
    (&["file"], File, file::FileSchemeDownloader),
    (&["content"], Content, content::ContentSchemeDownloader),
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

/// 返回当前支持的 URL scheme 列表（与 archive::supported_types() 类似）
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

/// 根据 URL scheme 选择下载器并执行下载，委托给 [SchemeDownloader::download]（headers、重试等由 task_id 查表获取）。
/// `progress` 必传，前端始终预期有进度事件。
pub async fn download_file_to_path_with_retry(
    dq: &DownloadQueue,
    task_id: &str,
    url: &str,
    dest: &Path,
    progress: &DownloadProgressContext<'_>,
) -> Result<String, String> {
    let parsed = Url::parse(url).map_err(|e| format!("Invalid URL: {}", e))?;
    let downloader = get_downloader_for_url(&parsed).ok_or_else(|| {
        let supported = supported_url_schemes().join(", ");
        format!(
            "Unsupported URL scheme: '{}'. Only {} are supported.",
            parsed.scheme(),
            supported
        )
    })?;
    downloader.download(dq, &parsed, dest, task_id, progress).await
}

pub async fn ensure_minimum_duration(download_start_time: u64, min_duration_ms: u64) {
    let elapsed = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
        - download_start_time;
    if elapsed < min_duration_ms {
        let remaining = min_duration_ms - elapsed;
        sleep(Duration::from_millis(remaining)).await;
    }
}

/// 在阻塞线程中计算文件 SHA256，使用大缓冲区顺序读，避免 tokio 小缓冲 + 多次 await 的开销。
pub async fn compute_file_hash(path: &Path) -> Result<String, String> {
    let mut file = tokio::fs::File::open(path)
        .await
        .map_err(|e| format!("Failed to open file for hash: {}", e))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 8192];
    loop {
        let n = file
            .read(&mut buffer)
            .await
            .map_err(|e| format!("Failed to read file for hash: {}", e))?;
        if n == 0 {
            break;
        }
        hasher.update(&buffer[..n]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}


#[allow(dead_code)]
pub fn compute_bytes_hash(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

pub const MAX_SAFE_FILENAME_LEN: usize = 180;

pub fn short_hash8(input: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(input.as_bytes());
    let full = format!("{:x}", hasher.finalize());
    full.chars().take(8).collect()
}

pub fn clamp_ascii_len(s: &str, max_len: usize) -> &str {
    if s.len() <= max_len {
        return s;
    }
    &s[..max_len]
}

pub fn is_windows_reserved_device_name(stem: &str) -> bool {
    let u = stem
        .trim()
        .trim_end_matches([' ', '.'])
        .to_ascii_uppercase();
    if matches!(u.as_str(), "CON" | "PRN" | "AUX" | "NUL") {
        return true;
    }
    if (u.starts_with("COM") || u.starts_with("LPT")) && u.len() == 4 {
        return matches!(
            u.chars().nth(3),
            Some('1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9')
        );
    }
    false
}

pub fn sanitize_stem_for_filename(stem: &str) -> String {
    let mut out: String = stem
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == ' ' {
                c
            } else {
                '_'
            }
        })
        .collect();

    while out.contains("  ") {
        out = out.replace("  ", " ");
    }

    let out = out.trim().trim_end_matches([' ', '.']).to_string();

    let mut out = if out.is_empty() {
        "image".to_string()
    } else {
        out
    };
    if is_windows_reserved_device_name(&out) {
        out = format!("_{}", out);
    }
    out
}

pub fn normalize_ext(ext: &str, fallback_ext: &str) -> String {
    let e = ext.trim().trim_start_matches('.').trim();
    let e = if e.is_empty() { fallback_ext.trim() } else { e };
    let e = e.trim().trim_start_matches('.').trim();
    if e.is_empty() {
        crate::image_type::default_image_extension().to_string()
    } else {
        e.to_ascii_lowercase()
    }
}

pub fn build_safe_filename(hint_filename: &str, fallback_ext: &str, hash_source: &str) -> String {
    let path = Path::new(hint_filename);
    let raw_stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("image");
    let raw_ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");

    let ext = normalize_ext(raw_ext, fallback_ext);
    let stem = sanitize_stem_for_filename(raw_stem);
    let h = short_hash8(hash_source);
    let suffix = format!("-{}", h);

    let reserve = suffix.len() + 1 + ext.len();
    let stem_max = MAX_SAFE_FILENAME_LEN.saturating_sub(reserve).max(1);
    let stem_final = clamp_ascii_len(&stem, stem_max);

    format!("{}{}.{}", stem_final, suffix, ext)
}

pub fn unique_path(dir: &Path, filename: &str) -> PathBuf {
    let mut candidate = dir.join(filename);
    if !candidate.exists() {
        return candidate;
    }

    let path = Path::new(filename);
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("image");
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");

    let mut idx = 1;
    loop {
        let suffix = format!("({})", idx);
        let (stem_max, ext_part) = if ext.is_empty() {
            (
                MAX_SAFE_FILENAME_LEN.saturating_sub(suffix.len()).max(1),
                String::new(),
            )
        } else {
            (
                MAX_SAFE_FILENAME_LEN
                    .saturating_sub(suffix.len() + 1 + ext.len())
                    .max(1),
                format!(".{}", ext),
            )
        };
        let stem_final = clamp_ascii_len(stem, stem_max);
        let new_name = format!("{}{}{}", stem_final, suffix, ext_part);
        candidate = dir.join(&new_name);
        if !candidate.exists() {
            return candidate;
        }
        idx += 1;
    }
}

/// 根据 URL 计算图片的下载目标路径（仅路径，不创建文件）；按 scheme 委托给对应 [SchemeDownloader]。
fn compute_image_download_path(url: &str, base_dir: &Path) -> Result<PathBuf, String> {
    let parsed = Url::parse(url).map_err(|e| format!("Invalid URL: {}", e))?;
    let downloader = get_downloader_for_url(&parsed).ok_or_else(|| {
        let supported = supported_url_schemes().join(", ");
        format!(
            "Unsupported or invalid URL (no scheme or path): '{}'. Supported schemes: {}.",
            url, supported
        )
    })?;
    downloader.compute_destination_path(&parsed, base_dir)
}

/// 准备下载目标：归档保存到 images_dir/.archives/；图片为 images_dir 内路径。
async fn prepare_download_destination(
    job: &DownloadRequest,
    is_archive: bool,
    processor_ext: Option<&str>,
) -> Result<PathBuf, String> {
    if is_archive {
        let ext = processor_ext.unwrap_or("zip");
        let archive_dir = job.images_dir.join(".archives");
        tokio::fs::create_dir_all(&archive_dir)
            .await
            .map_err(|e| format!("Failed to create archive dir: {}", e))?;
        let path = archive_dir.join(format!("{}.{}", uuid::Uuid::new_v4(), ext));
        Ok(path)
    } else {
        tokio::fs::create_dir_all(&job.images_dir)
            .await
            .map_err(|e| format!("Failed to create output directory: {}", e))?;
        let path = compute_image_download_path(job.url.as_str(), &job.images_dir)?;
        Ok(path)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActiveDownloadInfo {
    pub url: String,
    #[serde(rename = "plugin_id")]
    pub plugin_id: String,
    #[serde(rename = "start_time")]
    pub start_time: u64,
    #[serde(rename = "task_id")]
    pub task_id: String,
    #[serde(default)]
    pub state: String,
}

pub fn emit_download_state(
    task_id: &str,
    url: &str,
    start_time: u64,
    plugin_id: &str,
    state: &str,
    error: Option<&str>,
) {
    GlobalEmitter::global().emit_download_state(task_id, url, start_time, plugin_id, state, error);
}

#[derive(Debug, Clone)]
pub struct DownloadRequest {
    // 请求url，由schema+path
    pub url: Url,
    // 下载目录
    pub images_dir: PathBuf,
    // 插件id，当schema为file时忽略（本地文件）
    pub plugin_id: String,
    // 任务id
    pub task_id: String,
    pub download_start_time: u64,
    pub output_album_id: Option<String>,
    pub http_headers: HashMap<String, String>,
    pub archive_type: Option<ArchiveType>,
}

#[derive(Debug)]
pub struct DownloadPoolState {
    pub queue: VecDeque<DownloadRequest>,
}

#[derive(Debug)]
pub struct DownloadPool {
    /// 当前存在的 worker 数量，由 worker 退出时减 1
    pub total_workers: Mutex<u32>,
    pub state: Mutex<DownloadPoolState>,
    /// 有新的 job 时 notify，worker 在 loop 开头 select 等此信号
    pub job_notify: Notify,
    /// 需要缩减 worker 时 notify_one，worker 被唤醒后从设置取 desired，若 total > desired 则减 1 并退出
    pub exit_notify: Notify,
}

impl DownloadPool {
    pub fn new(_initial_workers: u32) -> Self {
        Self {
            total_workers: Mutex::new(0),
            state: Mutex::new(DownloadPoolState {
                queue: VecDeque::new(),
            }),
            job_notify: Notify::new(),
            exit_notify: Notify::new(),
        }
    }
}

#[derive(Clone)]
pub struct DownloadQueue {
    pub pool: Arc<DownloadPool>,
    pub active_tasks: Arc<Mutex<Vec<ActiveDownloadInfo>>>,
    pub canceled_tasks: Arc<RwLock<HashSet<String>>>,
    pub decompression_queue: Arc<(Mutex<VecDeque<DecompressionJob>>, Notify)>,
}

impl DownloadQueue {
    // new 的时候先只创建一个下载线程，等 init 阶段完成之后，再手动扩容（用 set_desired_concurrency_from_settings）
    pub fn new() -> Self {
        let pool = Arc::new(DownloadPool::new(1));
        Self {
            pool: Arc::clone(&pool),
            active_tasks: Arc::new(Mutex::new(Vec::new())),
            canceled_tasks: Arc::new(RwLock::new(HashSet::new())),
            decompression_queue: Arc::new((Mutex::new(VecDeque::new()), Notify::new())),
        }
    }

    pub async fn start_download_workers(&self, count: u32) {
        let n = count.max(1);
        {
            let mut total = self.pool.total_workers.lock().await;
            *total += n;
        }
        for _ in 0..n {
            let dq = Arc::new(self.clone());
            tokio::spawn(async move { download_worker_loop(dq).await });
        }
    }

    pub async fn set_desired_concurrency_from_settings(&self) {
        let desired = Settings::global()
            .get_max_concurrent_downloads()
            .await
            .unwrap_or(1)
            .max(1);
        let mut total = self.pool.total_workers.lock().await;
        if *total < desired {
            let add = desired - *total;
            *total = desired;
            drop(total);
            for _ in 0..add {
                let dq = Arc::new(self.clone());
                tokio::spawn(async move { download_worker_loop(dq).await });
            }
            self.pool.job_notify.notify_waiters();
        } else if *total > desired {
            let exit_count = *total - desired;
            drop(total);
            for _ in 0..exit_count {
                self.pool.exit_notify.notify_one();
            }
        }
    }

    pub fn notify_all_waiting(&self) {
        self.pool.job_notify.notify_waiters();
    }

    pub async fn get_active_downloads(&self) -> Result<Vec<ActiveDownloadInfo>, String> {
        let tasks = self.active_tasks.lock().await;
        Ok(tasks.clone())
    }

    pub async fn download_image(
        &self,
        url: Url,
        images_dir: PathBuf,
        plugin_id: String,
        task_id: String,
        download_start_time: u64,
        output_album_id: Option<String>,
        http_headers: HashMap<String, String>,
    ) -> Result<(), String> {
        self.download(
            url,
            images_dir,
            plugin_id,
            task_id,
            download_start_time,
            output_album_id,
            http_headers,
            None,
        )
        .await
    }

    pub async fn download_archive(
        &self,
        url: Url,
        archive_type: &str,
        images_dir: PathBuf,
        plugin_id: String,
        task_id: String,
        download_start_time: u64,
        output_album_id: Option<String>,
        http_headers: HashMap<String, String>,
    ) -> Result<(), String> {
        let t = if archive_type.trim().is_empty() || archive_type.eq_ignore_ascii_case("none") {
            let mgr = crate::crawler::archiver::manager();
            if let Some(processor) = mgr.get_processor_by_url(&url) {
                let types = processor.supported_types();
                if types.contains(&"zip") {
                    Some(ArchiveType::Zip)
                } else if types.contains(&"rar") {
                    Some(ArchiveType::Rar)
                } else {
                    None
                }
            } else {
                None
            }
        } else {
            ArchiveType::parse(archive_type)
        };

        let Some(t) = t else {
            return Err(format!(
                "Unsupported or undetectable archive type: {archive_type}"
            ));
        };
        self.download(
            url,
            images_dir,
            plugin_id,
            task_id,
            download_start_time,
            output_album_id,
            http_headers,
            Some(t),
        )
        .await
    }

    pub async fn download(
        &self,
        url: Url,
        images_dir: PathBuf,
        plugin_id: String,
        task_id: String,
        download_start_time: u64,
        output_album_id: Option<String>,
        http_headers: HashMap<String, String>,
        archive_type: Option<ArchiveType>,
    ) -> Result<(), String> {
        // 检查任务是否取消
        if self.is_task_canceled(&task_id).await {
            return Err("Task canceled".to_string());
        }

        eprintln!("download: {}", url.as_str());
        // 直接推入 pool.state.queue，由 worker 消费
        let mut pool_st = self.pool.state.lock().await;
        pool_st.queue.push_back(DownloadRequest {
            url,
            images_dir,
            plugin_id,
            task_id,
            download_start_time,
            output_album_id,
            http_headers,
            archive_type,
        });
        drop(pool_st);
        self.pool.job_notify.notify_waiters();

        Ok(())
    }

    pub async fn cancel_task(&self, task_id: &str) {
        let mut canceled = self.canceled_tasks.write().await;
        canceled.insert(task_id.to_string());
    }

    pub async fn is_task_canceled(&self, task_id: &str) -> bool {
        let c = self.canceled_tasks.read().await;
        c.contains(task_id)
    }

    /// 同步版本，供非 async 上下文调用（内部 block_on）。
    pub fn is_task_canceled_blocking(&self, task_id: &str) -> bool {
        tokio::runtime::Handle::current().block_on(self.is_task_canceled(task_id))
    }

    pub fn emitter_arc(&self) -> &'static GlobalEmitter {
        GlobalEmitter::global()
    }

    pub fn settings_arc(&self) -> &'static crate::settings::Settings {
        Settings::global()
    }

    pub fn storage(&self) -> &'static crate::storage::Storage {
        Storage::global()
    }
}


async fn download_worker_loop(dq: Arc<DownloadQueue>) {
    let pool = Arc::clone(&dq.pool);
    let active_tasks = Arc::clone(&dq.active_tasks);
    loop {
        let job = {
            let mut st = pool.state.lock().await;
            loop {
                if let Some(job) = st.queue.pop_front() {
                    break job;
                }
                let desired = Settings::global()
                    .get_max_concurrent_downloads()
                    .await
                    .unwrap_or(1)
                    .max(1);
                drop(st);
                let total = *pool.total_workers.lock().await;
                if total > desired {
                    let mut tw = pool.total_workers.lock().await;
                    *tw -= 1;
                    return;
                }
                pool.job_notify.notified().await;
                st = pool.state.lock().await;
            }
        };
        eprintln!("download_worker_loop: {}", job.url.as_str());

        // 取出任务后，添加到 active_tasks 并发送 "preparing" 事件
        {
            let download_info = ActiveDownloadInfo {
                url: job.url.to_string(),
                plugin_id: job.plugin_id.clone(),
                start_time: job.download_start_time,
                task_id: job.task_id.clone(),
                state: "preparing".to_string(),
            };
            let mut tasks = active_tasks.lock().await;
            tasks.push(download_info);
        }
        GlobalEmitter::global().emit_download_state(
            &job.task_id,
            job.url.as_str(),
            job.download_start_time,
            &job.plugin_id,
            "preparing",
            None,
        );

        let processor = match job.archive_type {
            Some(ty) => crate::crawler::archiver::manager().get_processor(ty),
            None => crate::crawler::archiver::manager().get_processor_by_url(&job.url),
        };

        // 先计算下载位置并下载，再按类型分支（归档入解压队 / 图片读内容后处理）
        let url_clone = job.url.clone();
        let plugin_id_clone = job.plugin_id.clone();
        let task_id_clone = job.task_id.clone();
        let download_start_time = job.download_start_time;

        {
            let mut tasks = active_tasks.lock().await;
            if let Some(t) = tasks
                .iter_mut()
                .find(|t| t.url == url_clone.as_str() && t.start_time == download_start_time)
            {
                t.state = "downloading".to_string();
            }
        }
        GlobalEmitter::global().emit_download_state(
            &task_id_clone,
            url_clone.as_str(),
            download_start_time,
            &plugin_id_clone,
            "downloading",
            None,
        );

        let is_archive = processor.is_some();
        let processor_ext = processor.as_ref().map(|p| p.supported_types()[0]);

        // 图片且开启去重时：若 URL 已在库中且源文件存在于本机，则跳过下载，仅入画册+发事件
        if !is_archive {
            let existing_opt = Settings::global()
                .get_auto_deduplicate()
                .await
                .unwrap_or(false)
                .then(|| Storage::global().find_image_by_url(job.url.as_str()).ok().flatten())
                .flatten();
            if let Some(ref existing) = existing_opt {
                let existing_path = PathBuf::from(&existing.local_path);
                if existing_path.exists() {
                    {
                        let mut tasks = active_tasks.lock().await;
                        if let Some(t) = tasks
                            .iter_mut()
                            .find(|t| t.url == url_clone.as_str() && t.start_time == download_start_time)
                        {
                            t.state = "processing".to_string();
                        }
                    }
                    GlobalEmitter::global().emit_download_state(
                        &task_id_clone,
                        url_clone.as_str(),
                        download_start_time,
                        &plugin_id_clone,
                        "processing",
                        None,
                    );
                    if !dq.is_task_canceled(&task_id_clone).await {
                        if let Some(ref album_id) = job.output_album_id {
                            if !album_id.trim().is_empty() {
                                let added = Storage::global()
                                    .add_images_to_album_silent(album_id, &[existing.id.clone()]);
                                if added > 0 {
                                    let reason = if album_id.as_str() == FAVORITE_ALBUM_ID {
                                        "favorite-add"
                                    } else {
                                        "album-add"
                                    };
                                    GlobalEmitter::global().emit(
                                        "images-change",
                                        serde_json::json!({
                                            "reason": reason,
                                            "albumId": album_id,
                                            "taskId": &task_id_clone,
                                            "imageIds": [existing.id.clone()],
                                        }),
                                    );
                                }
                            }
                        }
                        GlobalEmitter::global().emit_download_state(
                            &task_id_clone,
                            url_clone.as_str(),
                            download_start_time,
                            &plugin_id_clone,
                            "completed",
                            None,
                        );
                    } else {
                        GlobalEmitter::global().emit_download_state(
                            &task_id_clone,
                            url_clone.as_str(),
                            download_start_time,
                            &plugin_id_clone,
                            "canceled",
                            None,
                        );
                    }
                    ensure_minimum_duration(download_start_time, 500).await;
                    let mut tasks = active_tasks.lock().await;
                    tasks.retain(|t| t.url != url_clone.as_str() || t.start_time != download_start_time);
                    drop(tasks);
                    let pool = Arc::clone(&dq.pool);
                    pool.job_notify.notify_waiters();
                    continue;
                }
            }
        }

        let dest = match prepare_download_destination(&job, is_archive, processor_ext).await {
            Ok(path) => Some(path),
            Err(e) => {
                GlobalEmitter::global().emit_download_state(
                    &task_id_clone,
                    url_clone.as_str(),
                    download_start_time,
                    &plugin_id_clone,
                    "failed",
                    Some(e.as_str()),
                );
                GlobalEmitter::global().emit_task_status_from_storage(&task_id_clone);
                let mut tasks = active_tasks.lock().await;
                tasks.retain(|t| t.url != url_clone.as_str() || t.start_time != download_start_time);
                None
            }
        };

        if let Some(download_path) = dest {
            let progress_ctx = DownloadProgressContext {
                plugin_id: &job.plugin_id,
                start_time: download_start_time,
            };
            let download_result = download_file_to_path_with_retry(
                &dq,
                &job.task_id,
                job.url.as_str(),
                &download_path,
                &progress_ctx,
            )
            .await;

            match download_result {
                Ok(_) => {
                    // 归档：解压到 images_dir，解压 worker 会添加 file:// 下载请求
                    if is_archive {
                        let archive_url = Url::from_file_path(&download_path)
                            .expect("download_path must be valid for archive");
                        let decompression_job = DecompressionJob {
                            archive_url,
                            images_dir: job.images_dir.clone(),
                            task_id: task_id_clone.clone(),
                            plugin_id: plugin_id_clone.clone(),
                            download_start_time,
                            output_album_id: job.output_album_id.clone(),
                            http_headers: job.http_headers.clone(),
                        };
                        let (lock, notify) = &*dq.decompression_queue;
                        let mut queue = lock.lock().await;
                        queue.push_back(decompression_job);
                        notify.notify_waiters();
                        GlobalEmitter::global().emit_download_state(
                            &task_id_clone,
                            url_clone.as_str(),
                            download_start_time,
                            &plugin_id_clone,
                            "completed",
                            None,
                        );
                    } else {
                        // 非归档：后处理。content:// 用 readFileBytes；file:// 用 path。
                        let is_content = job.url.scheme() == "content";

                        // 后处理：processing 状态、去重逻辑、缩略图、入库、入画册、发事件
                        {
                            let mut tasks = active_tasks.lock().await;
                            if let Some(t) = tasks
                                .iter_mut()
                                .find(|t| t.url == url_clone.as_str() && t.start_time == download_start_time)
                            {
                                t.state = "processing".to_string();
                            }
                        }
                        if dq.is_task_canceled(&task_id_clone).await {
                            GlobalEmitter::global().emit_download_state(
                                &task_id_clone,
                                url_clone.as_str(),
                                download_start_time,
                                &plugin_id_clone,
                                "canceled",
                                None,
                            );
                        } else {
                            GlobalEmitter::global().emit_download_state(
                                &task_id_clone,
                                url_clone.as_str(),
                                download_start_time,
                                &plugin_id_clone,
                                "processing",
                                None,
                            );
                            let auto_deduplicate = Settings::global()
                                .get_auto_deduplicate()
                                .await
                                .unwrap_or(false);

                            #[cfg(target_os = "android")]
                            let use_path_flow = !is_content;
                            #[cfg(not(target_os = "android"))]
                            let use_path_flow = true;

                            #[cfg(target_os = "android")]
                            if !use_path_flow {
                                let bytes = match get_content_io_provider()
                                    .ok_or_else(|| "ContentIoProvider 未注册".to_string())
                                    .and_then(|io| io.read_file_bytes(url_clone.as_str()))
                                {
                                    Ok(b) => b,
                                    Err(e) => {
                                        let _ = Storage::global().add_task_failed_image(
                                            &task_id_clone,
                                            &plugin_id_clone,
                                            url_clone.as_str(),
                                            download_start_time as i64,
                                            Some(e.as_str()),
                                        );
                                        GlobalEmitter::global().emit_download_state(
                                            &task_id_clone,
                                            url_clone.as_str(),
                                            download_start_time,
                                            &plugin_id_clone,
                                            "failed",
                                            Some(e.as_str()),
                                        );
                                        GlobalEmitter::global().emit_task_status_from_storage(&task_id_clone);
                                        continue;
                                    }
                                };
                                ensure_minimum_duration(download_start_time, 500).await;
                                let hash = compute_bytes_hash(&bytes);
                                match generate_thumbnail_from_bytes(&bytes).await {
                                    Ok(thumb_opt) => {
                                        let thumb_path_str = thumb_opt
                                            .as_ref()
                                            .and_then(|p| p.canonicalize().ok())
                                            .map(|p| {
                                                p.to_string_lossy()
                                                    .trim_start_matches("\\\\?\\")
                                                    .to_string()
                                            })
                                            .unwrap_or_else(|| url_clone.to_string());
                                        let _ = process_downloaded_content_image_to_storage(
                                            url_clone.as_str(),
                                            &hash,
                                            thumb_opt.as_ref(),
                                            &thumb_path_str,
                                            &plugin_id_clone,
                                            &task_id_clone,
                                            download_start_time,
                                            job.output_album_id.as_deref(),
                                        )
                                        .await;
                                    }
                                    Err(e) => {
                                        let _ = Storage::global().add_task_failed_image(
                                            &task_id_clone,
                                            &plugin_id_clone,
                                            url_clone.as_str(),
                                            download_start_time as i64,
                                            Some(e.as_str()),
                                        );
                                        GlobalEmitter::global().emit_download_state(
                                            &task_id_clone,
                                            url_clone.as_str(),
                                            download_start_time,
                                            &plugin_id_clone,
                                            "failed",
                                            Some(e.as_str()),
                                        );
                                        GlobalEmitter::global().emit_task_status_from_storage(&task_id_clone);
                                    }
                                }
                                ensure_minimum_duration(download_start_time, 500).await;
                            } else if use_path_flow {
                            let path_for_post = download_path;

                            if !auto_deduplicate {
                                // 去重关闭：完整流程，并统计后处理各步骤耗时
                                let post_start = Instant::now();
                                match compute_file_hash(&path_for_post).await {
                                    Ok(hash) => {
                                        let hash_ms = post_start.elapsed().as_millis() as u64;
                                        let _ = process_downloaded_image_to_storage(
                                            &path_for_post,
                                            &hash,
                                            url_clone.as_str(),
                                            &plugin_id_clone,
                                            &task_id_clone,
                                            download_start_time,
                                            job.output_album_id.as_deref(),
                                            Some(hash_ms),
                                        )
                                        .await;
                                    }
                                    Err(e) => {
                                        let _ = tokio::fs::remove_file(&path_for_post).await;
                                        let _ = Storage::global().add_task_failed_image(
                                            &task_id_clone,
                                            &plugin_id_clone,
                                            url_clone.as_str(),
                                            download_start_time as i64,
                                            Some(e.as_str()),
                                        );
                                        GlobalEmitter::global().emit_download_state(
                                            &task_id_clone,
                                            url_clone.as_str(),
                                            download_start_time,
                                            &plugin_id_clone,
                                            "failed",
                                            Some(e.as_str()),
                                        );
                                        GlobalEmitter::global().emit_task_status_from_storage(&task_id_clone);
                                    }
                                }
                            } else {
                                // 去重开启，URL 不在库中（已下载）：算哈希后分支
                                match compute_file_hash(&path_for_post).await {
                                    Ok(hash) => {
                                        let existing_by_hash = Storage::global()
                                            .find_image_by_hash(&hash)
                                            .ok()
                                            .flatten();
                                        if let Some(ref existing) = existing_by_hash {
                                            // 哈希已存在：删除刚下载的文件（若无任何图片使用该路径），入画册，发事件
                                            let local_path_str = path_for_post
                                                .canonicalize()
                                                .unwrap_or_else(|_| path_for_post.clone())
                                                .to_string_lossy()
                                                .to_string()
                                                .trim_start_matches("\\\\?\\")
                                                .to_string();
                                            let no_image_uses_path = Storage::global()
                                                .find_image_by_path(&local_path_str)
                                                .ok()
                                                .flatten()
                                                .is_none();
                                            if no_image_uses_path {
                                                let _ =
                                                    tokio::fs::remove_file(&path_for_post).await;
                                            }
                                            if let Some(ref album_id) = job.output_album_id {
                                                if !album_id.trim().is_empty() {
                                                    let added = Storage::global()
                                                        .add_images_to_album_silent(
                                                            album_id,
                                                            &[existing.id.clone()],
                                                        );
                                                    if added > 0 {
                                                        let reason = if album_id.as_str()
                                                            == FAVORITE_ALBUM_ID
                                                        {
                                                            "favorite-add"
                                                        } else {
                                                            "album-add"
                                                        };
                                                        GlobalEmitter::global().emit(
                                                            "images-change",
                                                            serde_json::json!({
                                                                "reason": reason,
                                                                "albumId": album_id,
                                                                "taskId": &task_id_clone,
                                                                "imageIds": [existing.id.clone()],
                                                            }),
                                                        );
                                                    }
                                                }
                                            }
                                            GlobalEmitter::global().emit(
                                                "images-change",
                                                serde_json::json!({
                                                    "reason": "add",
                                                    "taskId": &task_id_clone,
                                                    "imageIds": [existing.id.clone()],
                                                }),
                                            );
                                            GlobalEmitter::global().emit_download_state(
                                                &task_id_clone,
                                                url_clone.as_str(),
                                                download_start_time,
                                                &plugin_id_clone,
                                                "completed",
                                                None,
                                            );
                                        } else {
                                            // 哈希不存在：与不去重相同流程（不统计耗时）
                                            let _ = process_downloaded_image_to_storage(
                                                &path_for_post,
                                                &hash,
                                                url_clone.as_str(),
                                                &plugin_id_clone,
                                                &task_id_clone,
                                                download_start_time,
                                                job.output_album_id.as_deref(),
                                                None,
                                            )
                                            .await;
                                        }
                                    }
                                    Err(e) => {
                                        let _ = tokio::fs::remove_file(&path_for_post).await;
                                        let _ = Storage::global().add_task_failed_image(
                                            &task_id_clone,
                                            &plugin_id_clone,
                                            url_clone.as_str(),
                                            download_start_time as i64,
                                            Some(e.as_str()),
                                        );
                                        GlobalEmitter::global().emit_download_state(
                                            &task_id_clone,
                                            url_clone.as_str(),
                                            download_start_time,
                                            &plugin_id_clone,
                                            "failed",
                                            Some(e.as_str()),
                                        );
                                        GlobalEmitter::global().emit_task_status_from_storage(&task_id_clone);
                                    }
                                }
                            }
                            ensure_minimum_duration(download_start_time, 500).await;
                            }
                        }
                    }
                    let mut tasks = active_tasks.lock().await;
                    tasks.retain(|t| t.url != url_clone.as_str() || t.start_time != download_start_time);
                }
                Err(e) => {
                    if is_archive && !e.contains("Task canceled") {
                        eprintln!(
                            "[Archive Error] Task: {}, URL: {}, Error: {}",
                            task_id_clone, url_clone, e
                        );
                    }
                    if !is_archive && !e.contains("Task canceled") {
                        let _ = Storage::global().add_task_failed_image(
                            &task_id_clone,
                            &plugin_id_clone,
                            url_clone.as_str(),
                            download_start_time as i64,
                            Some(e.as_str()),
                        );
                    }
                    GlobalEmitter::global().emit_download_state(
                        &task_id_clone,
                        url_clone.as_str(),
                        download_start_time,
                        &plugin_id_clone,
                        if e.contains("Task canceled") {
                            "canceled"
                        } else {
                            "failed"
                        },
                        Some(&e),
                    );
                    if !e.contains("Task canceled") {
                        GlobalEmitter::global().emit_task_status_from_storage(&task_id_clone);
                    }
                    let mut tasks = active_tasks.lock().await;
                    tasks.retain(|t| t.url != url_clone.as_str() || t.start_time != download_start_time);
                }
            }
        }

        // 两个分支的公共收尾：通知等待中的 worker
        let pool = Arc::clone(&dq.pool);
        pool.job_notify.notify_waiters();
    }
}

/// content:// 图片入库：local_path 存 URI，thumbnail_path 为本地路径。
#[cfg(target_os = "android")]
async fn process_downloaded_content_image_to_storage(
    content_uri: &str,
    hash: &str,
    thumbnail_path: Option<&PathBuf>,
    thumbnail_path_str: &str,
    plugin_id: &str,
    task_id: &str,
    download_start_time: u64,
    output_album_id: Option<&str>,
) -> Result<(), String> {
    let image_info = ImageInfo {
        id: "".to_string(),
        url: None,
        local_path: content_uri.to_string(),
        plugin_id: plugin_id.to_string(),
        task_id: Some(task_id.to_string()),
        crawled_at: download_start_time,
        metadata: None,
        thumbnail_path: thumbnail_path_str.to_string(),
        favorite: false,
        hash: hash.to_string(),
        order: Some(download_start_time as i64),
        local_exists: true,
    };
    match Storage::global().add_image(image_info) {
        Ok(inserted) => {
            let image_id = inserted.id.clone();
            GlobalEmitter::global().emit(
                "images-change",
                serde_json::json!({
                    "reason": "add",
                    "taskId": task_id,
                    "imageIds": [image_id.clone()],
                }),
            );
            if let Some(album_id) = output_album_id {
                if !album_id.trim().is_empty() {
                    let added =
                        Storage::global().add_images_to_album_silent(album_id, &[image_id.clone()]);
                    if added > 0 {
                        let reason = if album_id == FAVORITE_ALBUM_ID {
                            "favorite-add"
                        } else {
                            "album-add"
                        };
                        GlobalEmitter::global().emit(
                            "images-change",
                            serde_json::json!({
                                "reason": reason,
                                "albumId": album_id,
                                "taskId": task_id,
                                "imageIds": [image_id.clone()],
                            }),
                        );
                    }
                }
            }
            GlobalEmitter::global().emit_download_state(
                task_id,
                content_uri,
                download_start_time,
                plugin_id,
                "completed",
                None,
            );
            Ok(())
        }
        Err(e) => {
            if let Some(thumb) = thumbnail_path {
                let _ = tokio::fs::remove_file(thumb).await;
            }
            let _ = Storage::global().add_task_failed_image(
                task_id,
                plugin_id,
                content_uri,
                download_start_time as i64,
                Some(e.as_str()),
            );
            GlobalEmitter::global().emit_download_state(
                task_id,
                content_uri,
                download_start_time,
                plugin_id,
                "failed",
                Some(e.as_str()),
            );
            GlobalEmitter::global().emit_task_status_from_storage(task_id);
            Err(e)
        }
    }
}

/// 对新下载的图片做完整入库流程：生成缩略图、入库、入画册、发事件。失败时已做清理并发送 failed。
/// `postprocess_timing_hash_ms`: 当为 Some 时表示来自「未去重」分支，在成功结束时 print 各步骤耗时（含传入的算哈希耗时）。
async fn process_downloaded_image_to_storage(
    path: &Path,
    hash: &str,
    url: &str,
    plugin_id: &str,
    task_id: &str,
    download_start_time: u64,
    output_album_id: Option<&str>,
    postprocess_timing_hash_ms: Option<u64>,
) -> Result<(), String> {
    let t_thumb = if postprocess_timing_hash_ms.is_some() {
        Some(Instant::now())
    } else {
        None
    };
    let thumbnail_path = match generate_thumbnail(path).await {
        Ok(t) => t,
        Err(e) => {
            let _ = tokio::fs::remove_file(path).await;
            let _ = Storage::global().add_task_failed_image(
                task_id,
                plugin_id,
                url,
                download_start_time as i64,
                Some(e.as_str()),
            );
            GlobalEmitter::global().emit_download_state(
                task_id,
                url,
                download_start_time,
                plugin_id,
                "failed",
                Some(e.as_str()),
            );
            GlobalEmitter::global().emit_task_status_from_storage(task_id);
            return Err(e);
        }
    };
    let thumb_ms = t_thumb.map(|t| t.elapsed().as_millis() as u64);
    let local_path_str = path
        .canonicalize()
        .unwrap_or_else(|_| path.to_path_buf())
        .to_string_lossy()
        .to_string()
        .trim_start_matches("\\\\?\\")
        .to_string();
    let thumbnail_path_str = thumbnail_path
        .as_ref()
        .and_then(|p| p.canonicalize().ok())
        .map(|p| {
            p.to_string_lossy()
                .to_string()
                .trim_start_matches("\\\\?\\")
                .to_string()
        })
        .unwrap_or_else(|| local_path_str.clone());
    let image_info = ImageInfo {
        // id 由数据库生成，这里占位
        id: "".to_string(),
        url: if url.starts_with("file://") {
            None
        } else {
            Some(url.to_string())
        },
        local_path: local_path_str,
        plugin_id: plugin_id.to_string(),
        task_id: Some(task_id.to_string()),
        crawled_at: download_start_time,
        metadata: None,
        thumbnail_path: thumbnail_path_str,
        favorite: false,
        hash: hash.to_string(),
        order: Some(download_start_time as i64),
        local_exists: true,
    };
    let t_add = postprocess_timing_hash_ms.map(|_| Instant::now());
    match Storage::global().add_image(image_info) {
        Ok(inserted) => {
            let add_ms = t_add.map(|t| t.elapsed().as_millis() as u64);
            let image_id = inserted.id.clone();
            let t_album = postprocess_timing_hash_ms.map(|_| Instant::now());
            GlobalEmitter::global().emit(
                "images-change",
                serde_json::json!({
                    "reason": "add",
                    "taskId": task_id,
                    "imageIds": [image_id.clone()],
                }),
            );
            if let Some(album_id) = output_album_id {
                if !album_id.trim().is_empty() {
                    let added =
                        Storage::global().add_images_to_album_silent(album_id, &[image_id.clone()]);
                    if added > 0 {
                        let reason = if album_id == FAVORITE_ALBUM_ID {
                            "favorite-add"
                        } else {
                            "album-add"
                        };
                        GlobalEmitter::global().emit(
                            "images-change",
                            serde_json::json!({
                                "reason": reason,
                                "albumId": album_id,
                                "taskId": task_id,
                                "imageIds": [image_id.clone()],
                            }),
                        );
                    }
                }
            }
            let album_ms = t_album.map(|t| t.elapsed().as_millis() as u64);
            if let Some(hash_ms) = postprocess_timing_hash_ms {
                let h = hash_ms;
                let th = thumb_ms.unwrap_or(0);
                let ad = add_ms.unwrap_or(0);
                let al = album_ms.unwrap_or(0);
                eprintln!(
                    "[Postprocess] task_id={} url={} | hash={}ms thumbnail={}ms add_image={}ms add_album={}ms total={}ms",
                    task_id,
                    if url.len() > 60 { format!("{}...", &url[..60]) } else { url.to_string() },
                    h,
                    th,
                    ad,
                    al,
                    h + th + ad + al
                );
            }
            GlobalEmitter::global().emit_download_state(
                task_id,
                url,
                download_start_time,
                plugin_id,
                "completed",
                None,
            );
            Ok(())
        }
        Err(e) => {
            let _ = tokio::fs::remove_file(path).await;
            if let Some(ref thumb) = thumbnail_path {
                if thumb != path {
                    let _ = tokio::fs::remove_file(thumb).await;
                }
            }
            let _ = Storage::global().add_task_failed_image(
                task_id,
                plugin_id,
                url,
                download_start_time as i64,
                Some(e.as_str()),
            );
            GlobalEmitter::global().emit_download_state(
                task_id,
                url,
                download_start_time,
                plugin_id,
                "failed",
                Some(e.as_str()),
            );
            GlobalEmitter::global().emit_task_status_from_storage(task_id);
            Err(e)
        }
    }
}

pub fn get_default_images_dir() -> PathBuf {
    if let Some(pictures_dir) = dirs::picture_dir() {
        pictures_dir.join("Kabegame")
    } else {
        crate::app_paths::kabegame_data_dir().join("images")
    }
}

#[cfg(windows)]
fn remove_zone_identifier(file_path: &Path) {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::DeleteFileW;

    let mut stream_path = file_path.as_os_str().to_owned();
    stream_path.push(":Zone.Identifier");

    let wide_path: Vec<u16> = OsStr::new(&stream_path)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();

    unsafe {
        DeleteFileW(wide_path.as_ptr());
    }
}

/// 从字节生成缩略图（用于 content:// URI）。
pub async fn generate_thumbnail_from_bytes(bytes: &[u8]) -> Result<Option<PathBuf>, String> {
    let img = match image::load_from_memory(bytes) {
        Ok(img) => img,
        Err(_) => return Ok(None),
    };
    let app_data_dir = crate::app_paths::kabegame_data_dir();
    let thumbnails_dir = app_data_dir.join("thumbnails");
    tokio::fs::create_dir_all(&thumbnails_dir)
        .await
        .map_err(|e| format!("Failed to create thumbnails directory: {}", e))?;
    let thumbnail = img.thumbnail(300, 300);
    let thumbnail_filename = format!(
        "{}.{}",
        uuid::Uuid::new_v4(),
        crate::image_type::default_image_extension()
    );
    let thumbnail_path = thumbnails_dir.join(&thumbnail_filename);
    thumbnail
        .save(&thumbnail_path)
        .map_err(|e| format!("Failed to save thumbnail: {}", e))?;
    Ok(Some(thumbnail_path))
}

pub async fn generate_thumbnail(image_path: &Path) -> Result<Option<PathBuf>, String> {
    // 制作缩略图时用后缀+infer 推断，非图片则跳过
    if !crate::image_type::is_image_by_path(image_path) {
        return Ok(None);
    }
    let app_data_dir = crate::app_paths::kabegame_data_dir();
    let thumbnails_dir = app_data_dir.join("thumbnails");
    tokio::fs::create_dir_all(&thumbnails_dir)
        .await
        .map_err(|e| format!("Failed to create thumbnails directory: {}", e))?;

    let img = match image::open(image_path) {
        Ok(img) => img,
        Err(_) => return Ok(None),
    };

    let thumbnail = img.thumbnail(300, 300);

    let thumbnail_filename = format!("{}.{}", uuid::Uuid::new_v4(), crate::image_type::default_image_extension());
    let thumbnail_path = thumbnails_dir.join(&thumbnail_filename);

    thumbnail
        .save(&thumbnail_path)
        .map_err(|e| format!("Failed to save thumbnail: {}", e))?;

    Ok(Some(thumbnail_path))
}
