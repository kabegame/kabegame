use crate::archive;
use crate::crawler::decompression::DecompressionJob;
use crate::emitter::GlobalEmitter;
use crate::settings::Settings;
use crate::storage::{ImageInfo, Storage, FAVORITE_ALBUM_ID};
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{Mutex, Notify};
use tokio::time::{sleep, Duration};
use url::Url;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArchiveType {
    Zip,
    Rar,
}

impl ArchiveType {
    pub fn parse(s: &str) -> Option<Self> {
        let t = s.trim().to_ascii_lowercase();
        match t.as_str() {
            "zip" => Some(ArchiveType::Zip),
            "rar" => Some(ArchiveType::Rar),
            _ => None,
        }
    }
}

pub fn emit_task_log(task_id: &str, level: &str, message: impl Into<String>) {
    let task_id = task_id.trim();
    if task_id.is_empty() {
        return;
    }
    GlobalEmitter::global().emit_task_log(task_id, level, &message.into());
}

pub fn build_reqwest_header_map(task_id: &str, headers: &HashMap<String, String>) -> HeaderMap {
    let mut map = HeaderMap::new();
    for (k, v) in headers {
        let key = k.trim();
        if key.is_empty() {
            continue;
        }
        let name = match HeaderName::from_bytes(key.as_bytes()) {
            Ok(n) => n,
            Err(e) => {
                emit_task_log(
                    task_id,
                    "warn",
                    format!("[headers] 跳过无效 header 名：{key} ({e})"),
                );
                continue;
            }
        };
        let value = match HeaderValue::from_str(v) {
            Ok(v) => v,
            Err(e) => {
                emit_task_log(
                    task_id,
                    "warn",
                    format!("[headers] 跳过无效 header 值：{key} ({e})"),
                );
                continue;
            }
        };
        map.insert(name, value);
    }
    map
}

pub fn build_reqwest_header_map_for_emitter(
    task_id: &str,
    headers: &HashMap<String, String>,
) -> HeaderMap {
    let mut map = HeaderMap::new();
    for (k, v) in headers {
        let key = k.trim();
        if key.is_empty() {
            continue;
        }
        let name = match HeaderName::from_bytes(key.as_bytes()) {
            Ok(n) => n,
            Err(e) => {
                GlobalEmitter::global().emit_task_log(
                    task_id,
                    "warn",
                    &format!("[headers] 跳过无效 header 名：{key} ({e})"),
                );
                continue;
            }
        };
        let value = match HeaderValue::from_str(v) {
            Ok(v) => v,
            Err(e) => {
                GlobalEmitter::global().emit_task_log(
                    task_id,
                    "warn",
                    &format!("[headers] 跳过无效 header 值：{key} ({e})"),
                );
                continue;
            }
        };
        map.insert(name, value);
    }
    map
}

pub async fn download_file_to_path_with_retry(
    dq: &DownloadQueue,
    task_id: &str,
    url: &str,
    dest: &Path,
    headers: &HashMap<String, String>,
    retry_count: u32,
) -> Result<String, String> {
    let path_obj = Path::new(url);
    if url.starts_with("file://") || path_obj.is_absolute() {
        if dq.is_task_canceled(task_id).await {
            return Err("Task canceled".to_string());
        }
        let local_path = if url.starts_with("file://") {
            resolve_local_path_from_url(url)
                .ok_or_else(|| format!("Invalid local file URL or file not found: {}", url))?
        } else {
            path_obj.to_path_buf()
        };

        if !local_path.exists() {
            return Err(format!("Local file not found: {}", local_path.display()));
        }

        tokio::fs::copy(&local_path, dest)
            .await
            .map_err(|e| format!("Failed to copy local file: {}", e))?;
        return Ok(url.to_string());
    }

    let client = create_client()?;
    let header_map = build_reqwest_header_map_for_emitter(task_id, headers);
    let max_attempts = retry_count.saturating_add(1).max(1);

    let mut attempt: u32 = 0;
    loop {
        attempt += 1;

        let mut current_url = url.to_string();
        let mut redirect_count = 0;

        // 通过重定向机制获取响应
        let resp = loop {
            if dq.is_task_canceled(task_id).await {
                return Err("Task canceled".to_string());
            }

            let mut req = client.get(&current_url);
            if !header_map.is_empty() {
                req = req.headers(header_map.clone());
            }

            let r = match req.send().await {
                Ok(r) => r,
                Err(e) => break Err(format!("Failed to download archive: {e}")),
            };

            if r.status().is_redirection() {
                if redirect_count >= 10 {
                    break Err("Too many redirects".to_string());
                }
                if let Some(loc) = r.headers().get(reqwest::header::LOCATION) {
                    if let Ok(loc_str) = loc.to_str() {
                        if let Ok(u) = Url::parse(&current_url) {
                            if let Ok(new_url) = u.join(loc_str) {
                                current_url = new_url.to_string();
                                redirect_count += 1;
                                continue;
                            }
                        }
                    }
                }
            }
            break Ok(r);
        };

        let resp = match resp {
            Ok(r) => r,
            Err(e) => {
                if attempt < max_attempts {
                    let backoff_ms = (500u64)
                        .saturating_mul(2u64.saturating_pow((attempt - 1) as u32))
                        .min(5000);
                    sleep(Duration::from_millis(backoff_ms)).await;
                    continue;
                }
                return Err(e);
            }
        };

        let status = resp.status();
        if !status.is_success() {
            let retryable =
                status.as_u16() == 408 || status.as_u16() == 429 || status.is_server_error();
            if retryable && attempt < max_attempts {
                let backoff_ms = (500u64)
                    .saturating_mul(2u64.saturating_pow((attempt - 1) as u32))
                    .min(5000);
                sleep(Duration::from_millis(backoff_ms)).await;
                continue;
            }
            return Err(format!("HTTP error: {status}"));
        }

        let final_url = current_url;
        let mut file = tokio::fs::File::create(dest)
            .await
            .map_err(|e| format!("Failed to create archive file: {e}"))?;

        let bytes = resp
            .bytes()
            .await
            .map_err(|e| format!("Failed to read archive bytes: {e}"))?;

        file.write_all(&bytes)
            .await
            .map_err(|e| format!("Failed to write archive file: {e}"))?;

        return Ok(final_url);
    }
}

pub fn create_client() -> Result<reqwest::Client, String> {
    let mut client_builder = reqwest::Client::builder();

    if let Ok(proxy_url) = std::env::var("HTTP_PROXY")
        .or_else(|_| std::env::var("http_proxy"))
        .or_else(|_| std::env::var("HTTPS_PROXY"))
        .or_else(|_| std::env::var("https_proxy"))
    {
        if !proxy_url.trim().is_empty() {
            match reqwest::Proxy::all(&proxy_url) {
                Ok(proxy) => {
                    client_builder = client_builder.proxy(proxy);
                    eprintln!("网络代理已配置 (async): {}", proxy_url);
                }
                Err(e) => {
                    eprintln!("代理配置无效 ({}), 将使用直连 (async): {}", proxy_url, e);
                }
            }
        }
    }

    if let Ok(no_proxy) = std::env::var("NO_PROXY").or_else(|_| std::env::var("no_proxy")) {
        if !no_proxy.trim().is_empty() {
            let no_proxy_list: Vec<&str> = no_proxy.split(',').map(|s| s.trim()).collect();
            for domain in no_proxy_list {
                if !domain.is_empty() {
                    match reqwest::Proxy::all(&format!("direct://{}", domain)) {
                        Ok(proxy) => {
                            client_builder = client_builder.proxy(proxy);
                        }
                        Err(e) => {
                            eprintln!("跳过无效的 NO_PROXY 配置 {}: {}", domain, e);
                        }
                    }
                }
            }
        }
    }

    client_builder = client_builder
        .timeout(Duration::from_secs(30))
        .connect_timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .user_agent("Kabegame/1.0");

    client_builder
        .build()
        .map_err(|e| format!("Failed to create async HTTP client: {}", e))
}

#[derive(Debug, Clone)]
pub struct DownloadedImage {
    pub path: PathBuf,
    pub thumbnail: Option<PathBuf>,
    pub hash: String,
    pub reused: bool,
    pub owns_file: bool,
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

pub fn resolve_local_path_from_url(url: &str) -> Option<PathBuf> {
    archive::resolve_local_path_from_url(url)
}

#[derive(Debug)]
pub struct TempDirGuard {
    pub path: PathBuf,
}

impl Drop for TempDirGuard {
    fn drop(&mut self) {
        let path = self.path.clone();
        tokio::task::spawn(async move {
            let _ = tokio::fs::remove_dir_all(path).await;
        });
    }
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
        "jpg".to_string()
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
    pub url: String,
    pub images_dir: PathBuf,
    pub plugin_id: String,
    pub task_id: String,
    pub download_start_time: u64,
    pub output_album_id: Option<String>,
    pub http_headers: HashMap<String, String>,
    pub archive_type: Option<ArchiveType>,
    pub temp_dir_guard: Option<Arc<TempDirGuard>>,
}

#[derive(Debug)]
pub struct DownloadPoolState {
    pub in_flight: u32,
    pub queue: VecDeque<DownloadRequest>,
}

#[derive(Debug)]
pub struct DownloadPool {
    pub desired_workers: AtomicU32,
    pub total_workers: AtomicU32,
    pub state: Mutex<DownloadPoolState>,
    pub notify: Notify,
}

impl DownloadPool {
    pub fn new(initial_workers: u32) -> Self {
        let n = initial_workers.max(1);
        Self {
            desired_workers: AtomicU32::new(n),
            total_workers: AtomicU32::new(n),
            state: Mutex::new(DownloadPoolState {
                in_flight: 0,
                queue: VecDeque::new(),
            }),
            notify: Notify::new(),
        }
    }

    pub fn set_desired(&self, desired: u32) -> u32 {
        let n = desired.max(1);
        self.desired_workers.store(n, Ordering::Relaxed);
        self.notify.notify_waiters();
        n
    }
}

#[derive(Debug, Clone, Default)]
pub struct TaskRateLimit {
    pub concurrency: Option<u32>,
    pub min_interval_ms: Option<u64>,
}

#[derive(Debug, Default)]
pub struct TaskRuntimeState {
    pub in_flight: u32,
    pub last_finished: u64,
}

#[derive(Clone)]
pub struct DownloadQueue {
    pub pool: Arc<DownloadPool>,
    pub active_tasks: Arc<Mutex<Vec<ActiveDownloadInfo>>>,
    pub canceled_tasks: Arc<Mutex<HashSet<String>>>,
    pub decompression_queue: Arc<(Mutex<VecDeque<DecompressionJob>>, Notify)>,
    pub pending_queue: Arc<(Mutex<VecDeque<DownloadRequest>>, Notify)>,
    pub task_limits: Arc<Mutex<HashMap<String, TaskRateLimit>>>,
    pub task_states: Arc<Mutex<HashMap<String, TaskRuntimeState>>>,
}

impl DownloadQueue {
    // new 的时候先只创建一个下载线程，等init阶段完成之后，再手动扩容(用set_desired_concurrency)
    pub fn new() -> Self {
        let pool = Arc::new(DownloadPool::new(1));
        Self {
            pool: Arc::clone(&pool),
            active_tasks: Arc::new(Mutex::new(Vec::new())),
            canceled_tasks: Arc::new(Mutex::new(HashSet::new())),
            decompression_queue: Arc::new((Mutex::new(VecDeque::new()), Notify::new())),
            pending_queue: Arc::new((Mutex::new(VecDeque::new()), Notify::new())),
            task_limits: Arc::new(Mutex::new(HashMap::new())),
            task_states: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn start_download_workers(&self, count: u32) {
        for _ in 0..count {
            let dq = Arc::new(self.clone());
            tokio::spawn(async move { download_worker_loop(dq).await });
        }
    }

    pub fn set_desired_concurrency(&self, desired: u32) {
        let desired = self.pool.set_desired(desired);
        loop {
            let total = self.pool.total_workers.load(Ordering::Relaxed);
            if total >= desired {
                break;
            }
            let add = desired - total;
            self.pool.total_workers.fetch_add(add, Ordering::Relaxed);
            for _ in 0..add {
                let dq = Arc::new(self.clone());
                tokio::spawn(async move { download_worker_loop(dq).await });
            }
            break;
        }
        self.pool.notify.notify_waiters();
    }

    pub fn notify_all_waiting(&self) {
        self.pool.notify.notify_waiters();
    }

    pub async fn set_task_concurrency(&self, task_id: &str, limit: u32) {
        let mut limits = self.task_limits.lock().await;
        let entry = limits.entry(task_id.to_string()).or_default();
        entry.concurrency = Some(limit);
        self.pending_queue.1.notify_waiters();
    }

    pub async fn set_task_interval(&self, task_id: &str, interval_ms: u64) {
        let mut limits = self.task_limits.lock().await;
        let entry = limits.entry(task_id.to_string()).or_default();
        entry.min_interval_ms = Some(interval_ms);
    }

    pub async fn get_active_downloads(&self) -> Result<Vec<ActiveDownloadInfo>, String> {
        let tasks = self.active_tasks.lock().await;
        Ok(tasks.clone())
    }

    pub async fn download_image(
        &self,
        url: String,
        images_dir: PathBuf,
        plugin_id: String,
        task_id: String,
        download_start_time: u64,
        output_album_id: Option<String>,
        http_headers: HashMap<String, String>,
    ) -> Result<(), String> {
        self.download_with_temp_guard(
            url,
            images_dir,
            plugin_id,
            task_id,
            download_start_time,
            output_album_id,
            http_headers,
            None,
            None,
        )
        .await
    }

    pub async fn download_archive(
        &self,
        url: String,
        archive_type: &str,
        images_dir: PathBuf,
        plugin_id: String,
        task_id: String,
        download_start_time: u64,
        output_album_id: Option<String>,
        http_headers: HashMap<String, String>,
    ) -> Result<(), String> {
        let t = if archive_type.trim().is_empty() || archive_type.eq_ignore_ascii_case("none") {
            let mgr = crate::archive::manager();
            if let Some(processor) = mgr.get_processor(None, &url) {
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
        self.download_with_temp_guard(
            url,
            images_dir,
            plugin_id,
            task_id,
            download_start_time,
            output_album_id,
            http_headers,
            Some(t),
            None,
        )
        .await
    }

    pub async fn download_with_temp_guard(
        &self,
        mut url: String,
        images_dir: PathBuf,
        plugin_id: String,
        task_id: String,
        download_start_time: u64,
        output_album_id: Option<String>,
        http_headers: HashMap<String, String>,
        archive_type: Option<ArchiveType>,
        temp_dir_guard: Option<Arc<TempDirGuard>>,
    ) -> Result<(), String> {
        // 1. 检查 reject: 前缀
        const REJECT_PREFIX: &str = "reject:";
        let trimmed = url.trim();
        if let Some(reason) = trimmed.strip_prefix(REJECT_PREFIX) {
            return Err(reason.trim().to_string());
        }
        if trimmed.len() != url.len() {
            url = trimmed.to_string();
        }

        // 2. 检查任务是否取消
        if self.is_task_canceled(&task_id).await {
            return Err("Task canceled".to_string());
        }

        let should_skip_by_url = {
            if archive_type.is_some() {
                false
            } else {
                let is_http_url = url.starts_with("http://") || url.starts_with("https://");
                if !is_http_url {
                    false
                } else {
                    if Settings::global()
                        .get_auto_deduplicate()
                        .await
                        .unwrap_or(false)
                    {
                        Storage::global()
                            .find_image_by_url(&url)
                            .ok()
                            .flatten()
                            .is_some()
                    } else {
                        false
                    }
                }
            }
        };

        if should_skip_by_url {
            let url_clone = url.clone();
            let task_id_clone = task_id.clone();
            let plugin_id_clone = plugin_id.clone();

            tokio::spawn(async move {
                GlobalEmitter::global().emit_download_state(
                    &task_id_clone,
                    &url_clone,
                    download_start_time,
                    &plugin_id_clone,
                    "processing",
                    None,
                );

                if let Ok(Some(existing)) = Storage::global().find_image_by_url(&url_clone) {
                    let existing_path = PathBuf::from(&existing.local_path);
                    if existing_path.exists() {
                        let mut need_backfill = existing.thumbnail_path.trim().is_empty();
                        if !need_backfill {
                            let p = PathBuf::from(&existing.thumbnail_path);
                            if !p.exists() {
                                need_backfill = true;
                            }
                        }
                        if need_backfill {
                            // Run thumbnail generation in blocking task
                            let existing_path_clone = existing_path.clone();
                            let existing_id = existing.id.clone();
                            if let Ok(Some(gen)) = generate_thumbnail(&existing_path_clone).await {
                                let canonical_thumb = gen
                                    .canonicalize()
                                    .unwrap_or(gen)
                                    .to_string_lossy()
                                    .to_string()
                                    .trim_start_matches("\\\\?\\")
                                    .to_string();
                                let _ = Storage::global().update_image_thumbnail_path(
                                    &existing_id,
                                    &canonical_thumb,
                                );
                            }
                        }
                    }
                }

                ensure_minimum_duration(download_start_time, 500).await;

                GlobalEmitter::global().emit_download_state(
                    &task_id_clone,
                    &url_clone,
                    download_start_time,
                    &plugin_id_clone,
                    "completed",
                    None,
                );
            });

            return Ok(());
        }

        if self.is_task_canceled(&task_id).await {
            return Err("Task canceled".to_string());
        }

        // 入队到 pending_queue
        {
            let (lock, notify) = &*self.pending_queue;
            let mut queue = lock.lock().await;
            queue.push_back(DownloadRequest {
                url,
                images_dir,
                plugin_id,
                task_id,
                download_start_time,
                output_album_id,
                http_headers,
                archive_type,
                temp_dir_guard,
            });
            let pending_count = queue.len();
            notify.notify_one();
            drop(queue);
            // 发送 pending 队列变化事件
            GlobalEmitter::global().emit_pending_queue_change(pending_count);
        }

        Ok(())
    }

    pub async fn cancel_task(&self, task_id: &str) -> Result<(), String> {
        {
            let mut canceled = self.canceled_tasks.lock().await;
            canceled.insert(task_id.to_string());
        }

        self.notify_all_waiting();

        Ok(())
    }

    pub async fn is_task_canceled(&self, task_id: &str) -> bool {
        let c = self.canceled_tasks.lock().await;
        c.contains(task_id)
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

pub(crate) async fn dispatcher_loop(dq: Arc<DownloadQueue>) {
    let (pending_lock, pending_notify) = &*dq.pending_queue;
    let pool = Arc::clone(&dq.pool);
    let task_limits = Arc::clone(&dq.task_limits);
    let task_states = Arc::clone(&dq.task_states);

    loop {
        let mut pending = pending_lock.lock().await;
        if pending.is_empty() {
            drop(pending);
            pending_notify.notified().await;
            pending = pending_lock.lock().await;
        }

        let count = pending.len();
        let mut min_wait_ms: Option<u64> = None;

        for _ in 0..count {
            if pending.is_empty() {
                break;
            }

            let job_ref = pending.front().unwrap();
            let task_id = job_ref.task_id.clone();

            let mut pool_st = pool.state.lock().await;
            let desired = pool.desired_workers.load(Ordering::Relaxed);
            if pool_st.in_flight >= desired {
                drop(pool_st);
                break;
            }

            let limits = task_limits.lock().await;
            let limit = limits.get(&task_id).cloned().unwrap_or_default();
            drop(limits);

            let mut states = task_states.lock().await;
            let state = states.entry(task_id.clone()).or_default();

            let is_canceled = dq.is_task_canceled(&task_id).await;

            let concurrency_ok =
                is_canceled || limit.concurrency.map_or(true, |c| state.in_flight < c);

            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis() as u64;

            let mut interval_wait = 0u64;
            let interval_ok = is_canceled
                || limit.min_interval_ms.map_or(true, |i| {
                    let next_allowed = state.last_finished + i;
                    if now >= next_allowed {
                        true
                    } else {
                        interval_wait = next_allowed - now;
                        false
                    }
                });

            if concurrency_ok && interval_ok {
                let job = pending.pop_front().unwrap();
                let pending_count = pending.len();
                state.in_flight += 1;
                drop(states);

                pool_st.queue.push_back(job);
                pool_st.in_flight += 1;
                pool.notify.notify_one();
                drop(pool_st);

                // 发送 pending 队列变化事件
                GlobalEmitter::global().emit_pending_queue_change(pending_count);
            } else {
                if concurrency_ok && !interval_ok {
                    if let Some(min) = min_wait_ms {
                        min_wait_ms = Some(min.min(interval_wait));
                    } else {
                        min_wait_ms = Some(interval_wait);
                    }
                }

                drop(states);
                drop(pool_st);
                let job = pending.pop_front().unwrap();
                pending.push_back(job);
            }
        }

        drop(pending);

        if let Some(wait_ms) = min_wait_ms {
            let _ = tokio::time::timeout(Duration::from_millis(wait_ms), pending_notify.notified())
                .await;
        }
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
                    break Some(job);
                }

                let desired = pool.desired_workers.load(Ordering::Relaxed);
                let total = pool.total_workers.load(Ordering::Relaxed);
                if total > desired {
                    pool.total_workers.fetch_sub(1, Ordering::Relaxed);
                    pool.notify.notify_waiters();
                    return;
                }

                drop(st);
                pool.notify.notified().await;
                st = pool.state.lock().await;
            }
        };

        let Some(job) = job else { continue };

        // 取出任务后，添加到 active_tasks 并发送 "preparing" 事件
        {
            let download_info = ActiveDownloadInfo {
                url: job.url.clone(),
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
            &job.url,
            job.download_start_time,
            &job.plugin_id,
            "preparing",
            None,
        );

        let archive_type_hint = job.archive_type.map(|t| match t {
            ArchiveType::Zip => "zip",
            ArchiveType::Rar => "rar",
        });

        let processor = crate::archive::manager().get_processor(archive_type_hint, &job.url);

        // 下载archive并发送解压缩任务
        if let Some(_) = processor {
            let url_clone = job.url.clone();
            let plugin_id_clone = job.plugin_id.clone();
            let task_id_clone = job.task_id.clone();
            let download_start_time = job.download_start_time;

            // 更新状态为 downloading
            {
                let mut tasks = active_tasks.lock().await;
                if let Some(t) = tasks
                    .iter_mut()
                    .find(|t| t.url == url_clone && t.start_time == download_start_time)
                {
                    t.state = "downloading".to_string();
                }
            }
            GlobalEmitter::global().emit_download_state(
                &task_id_clone,
                &url_clone,
                download_start_time,
                &plugin_id_clone,
                "downloading",
                None,
            );

            let result: Result<(), String> = (async {
                if dq.is_task_canceled(&task_id_clone).await {
                    return Err("Task canceled".to_string());
                }

                let temp_dir = std::env::temp_dir()
                    .join(format!("kabegame_zip_{}", uuid::Uuid::new_v4().to_string()));
                tokio::fs::create_dir_all(&temp_dir)
                    .await
                    .map_err(|e| format!("Failed to create temp dir: {}", e))?;
                let temp_guard = Arc::new(TempDirGuard {
                    path: temp_dir.clone(),
                });

                let ext = if let Some(t) = job.archive_type {
                    match t {
                        ArchiveType::Zip => "zip",
                        ArchiveType::Rar => "rar",
                    }
                } else {
                    let lower = url_clone.to_lowercase();
                    if lower.ends_with(".rar") || lower.contains(".rar?") || lower.contains(".rar#")
                    {
                        "rar"
                    } else {
                        "zip"
                    }
                };

                let archive_path = temp_dir.join(format!("__kg_archive.{}", ext));

                let retry_count = crate::settings::Settings::global()
                    .get_network_retry_count()
                    .await
                    .unwrap_or(2);

                // cancel_check for download_file_to_path_with_retry
                // We need to pass a closure or something. But the function expects &dyn Fn() -> bool.
                // We can't pass an async closure or a closure that calls async method.
                // Refactor download_file_to_path_with_retry to take cancel_check which is Fn() -> bool.
                // But dq.is_task_canceled is async.
                // However, we are in async context.
                // We can pass a closure that uses blocking logic? No.
                // Ideally we should pass a `CancellationToken` or just a shared flag.
                // For now, let's use a simplified check or modify download_file_to_path_with_retry signature to take something else.
                // Since I modified `download_file_to_path_with_retry` to be async, it can take an async closure?
                // Async closures are unstable.
                // I will modify `download_file_to_path_with_retry` to take `&DownloadQueue` and `task_id`.
                // But I kept the signature `cancel_check: &dyn Fn() -> bool` in the previous edit.
                // I should change it.
                // Let's fix this in the code below.

                // Temporary fix: pass a dummy closure and check cancellation inside the loop in `download_file_to_path_with_retry` if I had access to `dq`.
                // I will change `download_file_to_path_with_retry` signature to:
                // `pub async fn download_file_to_path_with_retry(..., dq: &DownloadQueue, task_id: &str, ...)`
                // But `DownloadQueue` is defined below.
                // I can use `Arc<Mutex<HashSet<String>>>` for canceled tasks.
                // Or just `&DownloadQueue` (Rust allows it).

                // Let's use `dq` directly.
                let cancel_check = || false; // Placeholder, I will fix the function signature.

                // Actually, I'll update the function signature in the file content I'm writing.

                let final_url = download_file_to_path_with_retry(
                    &dq, // Pass dq
                    &task_id_clone,
                    &url_clone,
                    &archive_path,
                    &job.http_headers,
                    retry_count,
                )
                .await?;

                let mut final_archive_path = archive_path.clone();
                if final_url != url_clone {
                    let lower = final_url.to_lowercase();
                    let new_ext = if lower.ends_with(".rar")
                        || lower.contains(".rar?")
                        || lower.contains(".rar#")
                    {
                        "rar"
                    } else if lower.ends_with(".zip")
                        || lower.contains(".zip?")
                        || lower.contains(".zip#")
                    {
                        "zip"
                    } else {
                        ext
                    };

                    if new_ext != ext {
                        let new_archive_path = temp_dir.join(format!("__kg_archive.{}", new_ext));
                        if tokio::fs::rename(&archive_path, &new_archive_path)
                            .await
                            .is_ok()
                        {
                            final_archive_path = new_archive_path;
                        }
                    }
                }

                let decompression_job = DecompressionJob {
                    archive_path: final_archive_path,
                    images_dir: job.images_dir.clone(),
                    original_url: url_clone.clone(),
                    task_id: task_id_clone.clone(),
                    plugin_id: plugin_id_clone.clone(),
                    download_start_time,
                    output_album_id: job.output_album_id.clone(),
                    http_headers: job.http_headers.clone(),
                    temp_dir_guard: Some(temp_guard),
                };

                let (lock, notify) = &*dq.decompression_queue;
                let mut queue = lock.lock().await;
                queue.push_back(decompression_job);
                notify.notify_waiters();

                {
                    let mut tasks = active_tasks.lock().await;
                    tasks.retain(|t| t.url != url_clone || t.start_time != download_start_time);
                }

                GlobalEmitter::global().emit_download_state(
                    &task_id_clone,
                    &url_clone,
                    download_start_time,
                    &plugin_id_clone,
                    "completed",
                    None,
                );

                Ok(())
            })
            .await;

            if let Err(e) = result {
                if !e.contains("Task canceled") {
                    eprintln!(
                        "[Archive Error] Task: {}, URL: {}, Error: {}",
                        task_id_clone, url_clone, e
                    );
                }
                GlobalEmitter::global().emit_download_state(
                    &task_id_clone,
                    &url_clone,
                    download_start_time,
                    &plugin_id_clone,
                    if e.contains("Task canceled") {
                        "canceled"
                    } else {
                        "failed"
                    },
                    Some(&e),
                );
                {
                    let mut tasks = active_tasks.lock().await;
                    tasks.retain(|t| t.url != url_clone || t.start_time != download_start_time);
                }

                let pool = Arc::clone(&dq.pool);
                let task_states = Arc::clone(&dq.task_states);
                let mut st = pool.state.lock().await;
                st.in_flight = st.in_flight.saturating_sub(1);
                drop(st);

                let mut states = task_states.lock().await;
                if let Some(state) = states.get_mut(&task_id_clone) {
                    state.in_flight = state.in_flight.saturating_sub(1);
                    state.last_finished = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap()
                        .as_millis() as u64;
                }
                drop(states);

                dq.pending_queue.1.notify_waiters();
                pool.notify.notify_one();
            }
        } else {
            // 下载普通图片
            let url_clone = job.url.clone();
            let plugin_id_clone = job.plugin_id.clone();
            let task_id_clone = job.task_id.clone();
            let download_start_time = job.download_start_time;
            let output_album_id_clone = job.output_album_id.clone();

            {
                let mut tasks = active_tasks.lock().await;
                if let Some(t) = tasks
                    .iter_mut()
                    .find(|t| t.url == url_clone && t.start_time == download_start_time)
                {
                    t.state = "downloading".to_string();
                }
            }

            GlobalEmitter::global().emit_download_state(
                &task_id_clone,
                &url_clone,
                download_start_time,
                &plugin_id_clone,
                "downloading",
                None,
            );

            let result = download_image(
                &job.url,
                &job.images_dir,
                &job.plugin_id,
                &job.task_id,
                job.download_start_time,
                &dq,
                &job.http_headers,
            )
            .await;

            match result {
                Ok(downloaded) => {
                    {
                        let mut tasks = active_tasks.lock().await;
                        if let Some(t) = tasks
                            .iter_mut()
                            .find(|t| t.url == url_clone && t.start_time == download_start_time)
                        {
                            t.state = "processing".to_string();
                        }
                    }

                    GlobalEmitter::global().emit_download_state(
                        &task_id_clone,
                        &url_clone,
                        download_start_time,
                        &plugin_id_clone,
                        "processing",
                        None,
                    );

                    if dq.is_task_canceled(&task_id_clone).await {
                        GlobalEmitter::global().emit_download_state(
                            &task_id_clone,
                            &url_clone,
                            download_start_time,
                            &plugin_id_clone,
                            "canceled",
                            None,
                        );
                    } else if downloaded.reused {
                        GlobalEmitter::global().emit_download_state(
                            &task_id_clone,
                            &url_clone,
                            download_start_time,
                            &plugin_id_clone,
                            "completed",
                            None,
                        );
                    } else {
                        let local_path_str = downloaded
                            .path
                            .canonicalize()
                            .unwrap_or_else(|_| downloaded.path.clone())
                            .to_string_lossy()
                            .to_string()
                            .trim_start_matches("\\\\?\\")
                            .to_string();

                        let thumbnail_path_str = downloaded
                            .thumbnail
                            .as_ref()
                            .and_then(|p| p.canonicalize().ok())
                            .map(|p| {
                                p.to_string_lossy()
                                    .to_string()
                                    .trim_start_matches("\\\\?\\")
                                    .to_string()
                            })
                            .unwrap_or_else(|| local_path_str.clone());

                        let auto_deduplicate = Settings::global()
                            .get_auto_deduplicate()
                            .await
                            .unwrap_or(false);

                        let should_skip = if auto_deduplicate {
                            let is_http_url = url_clone.starts_with("http://")
                                || url_clone.starts_with("https://");
                            if is_http_url {
                                Storage::global()
                                    .find_image_by_url(&url_clone)
                                    .ok()
                                    .flatten()
                                    .is_some()
                                    || (!downloaded.hash.is_empty()
                                        && Storage::global()
                                            .find_image_by_hash(&downloaded.hash)
                                            .ok()
                                            .flatten()
                                            .is_some())
                            } else {
                                !downloaded.hash.is_empty()
                                    && Storage::global()
                                        .find_image_by_hash(&downloaded.hash)
                                        .ok()
                                        .flatten()
                                        .is_some()
                            }
                        } else {
                            false
                        };

                        if should_skip {
                            if downloaded.owns_file {
                                let _ = tokio::fs::remove_file(&downloaded.path).await;
                                if let Some(thumb) = downloaded.thumbnail.as_ref() {
                                    if thumb != &downloaded.path {
                                        let _ = tokio::fs::remove_file(thumb).await;
                                    }
                                }
                            }

                            GlobalEmitter::global().emit_download_state(
                                &task_id_clone,
                                &url_clone,
                                download_start_time,
                                &plugin_id_clone,
                                "completed",
                                None,
                            );
                        } else {
                            let image_info = ImageInfo {
                                id: "".to_string(),
                                url: url_clone.clone(),
                                local_path: local_path_str,
                                plugin_id: plugin_id_clone.clone(),
                                task_id: Some(task_id_clone.clone()),
                                crawled_at: download_start_time,
                                metadata: None,
                                thumbnail_path: thumbnail_path_str,
                                favorite: false,
                                hash: downloaded.hash.clone(),
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
                                            "taskId": task_id_clone,
                                            "imageIds": [image_id.clone()],
                                        }),
                                    );

                                    if let Some(album_id) = output_album_id_clone.as_ref() {
                                        if !album_id.trim().is_empty() {
                                            let added = Storage::global()
                                                .add_images_to_album_silent(
                                                    album_id,
                                                    &[image_id.clone()],
                                                );
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
                                                        "taskId": task_id_clone,
                                                        "imageIds": [image_id.clone()],
                                                    }),
                                                );
                                            }
                                        }
                                    }

                                    GlobalEmitter::global().emit_download_state(
                                        &task_id_clone,
                                        &url_clone,
                                        download_start_time,
                                        &plugin_id_clone,
                                        "completed",
                                        None,
                                    );
                                }
                                Err(e) => {
                                    if downloaded.owns_file {
                                        let _ = tokio::fs::remove_file(&downloaded.path).await;
                                        if let Some(thumb) = downloaded.thumbnail.as_ref() {
                                            if thumb != &downloaded.path {
                                                let _ = tokio::fs::remove_file(thumb).await;
                                            }
                                        }
                                    }

                                    let _ = Storage::global().add_task_failed_image(
                                        &task_id_clone,
                                        &plugin_id_clone,
                                        &url_clone,
                                        download_start_time as i64,
                                        Some(e.as_str()),
                                    );

                                    GlobalEmitter::global().emit_download_state(
                                        &task_id_clone,
                                        &url_clone,
                                        download_start_time,
                                        &plugin_id_clone,
                                        "failed",
                                        Some(e.as_str()),
                                    );
                                }
                            }
                        }
                    }
                }
                Err(e) => {
                    if !e.contains("Task canceled") {
                        let _ = Storage::global().add_task_failed_image(
                            &task_id_clone,
                            &plugin_id_clone,
                            &url_clone,
                            download_start_time as i64,
                            Some(e.as_str()),
                        );
                    }
                    GlobalEmitter::global().emit_download_state(
                        &task_id_clone,
                        &url_clone,
                        download_start_time,
                        &plugin_id_clone,
                        if e.contains("Task canceled") {
                            "canceled"
                        } else {
                            "failed"
                        },
                        Some(&e),
                    );
                }
            }

            {
                let mut tasks = active_tasks.lock().await;
                tasks.retain(|t| t.url != url_clone || t.start_time != download_start_time);
            }

            let pool = Arc::clone(&dq.pool);
            let task_states = Arc::clone(&dq.task_states);
            let mut st = pool.state.lock().await;
            st.in_flight = st.in_flight.saturating_sub(1);
            drop(st);

            let mut states = task_states.lock().await;
            if let Some(state) = states.get_mut(&task_id_clone) {
                state.in_flight = state.in_flight.saturating_sub(1);
                state.last_finished = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_millis() as u64;
            }
            drop(states);

            dq.pending_queue.1.notify_waiters();
            pool.notify.notify_one();
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

async fn download_image(
    url: &str,
    base_dir: &Path,
    plugin_id: &str,
    task_id: &str,
    download_start_time: u64,
    dq: &DownloadQueue,
    http_headers: &HashMap<String, String>,
) -> Result<DownloadedImage, String> {
    const REJECT_PREFIX: &str = "reject:";
    if let Some(reason) = url.trim().strip_prefix(REJECT_PREFIX) {
        return Err(reason.trim().to_string());
    }

    let is_local_path = url.starts_with("file://")
        || (!url.starts_with("http://") && !url.starts_with("https://") && Path::new(url).exists());

    tokio::fs::create_dir_all(base_dir)
        .await
        .map_err(|e| format!("Failed to create output directory: {}", e))?;
    let target_dir = base_dir.to_path_buf();

    if is_local_path {
        let source_path = if url.starts_with("file://") {
            let path_str = if url.starts_with("file:///") {
                &url[8..]
            } else {
                &url[7..]
            };
            #[cfg(target_os = "windows")]
            let path_str = if path_str.len() > 1 && &path_str[1..2] == ":" {
                path_str.replace("/", "\\")
            } else {
                path_str.replace("/", "\\")
            };
            #[cfg(not(target_os = "windows"))]
            let path_str = path_str;
            PathBuf::from(path_str)
        } else {
            PathBuf::from(url)
        };

        let source_path = source_path
            .canonicalize()
            .map_err(|e| format!("Failed to canonicalize source path: {}", e))?;

        if !source_path.exists() {
            return Err(format!(
                "Source file does not exist: {}",
                source_path.display()
            ));
        }

        let source_hash = compute_file_hash(&source_path).await?;

        let auto_deduplicate = Settings::global()
            .get_auto_deduplicate()
            .await
            .unwrap_or(false);

        if auto_deduplicate {
            if let Ok(Some(existing)) = Storage::global().find_image_by_hash(&source_hash) {
                let existing_path = PathBuf::from(&existing.local_path);
                if existing_path.exists() {
                    let mut need_backfill = existing.thumbnail_path.trim().is_empty();
                    let thumb_path = if !need_backfill {
                        let p = PathBuf::from(&existing.thumbnail_path);
                        if p.exists() {
                            Some(p)
                        } else {
                            need_backfill = true;
                            None
                        }
                    } else {
                        None
                    };
                    if need_backfill {
                        let existing_path_clone = existing_path.clone();
                        let existing_id = existing.id.clone();
                        if let Ok(Some(gen)) = generate_thumbnail(&existing_path_clone).await {
                            let canonical_thumb = gen
                                .canonicalize()
                                .unwrap_or(gen)
                                .to_string_lossy()
                                .to_string()
                                .trim_start_matches("\\\\?\\")
                                .to_string();
                            let _ = Storage::global()
                                .update_image_thumbnail_path(&existing_id, &canonical_thumb);
                        } else {
                            eprintln!("缩略图生成失败 {}", existing_id)
                        }
                    }

                    ensure_minimum_duration(download_start_time, 500).await;
                    return Ok(DownloadedImage {
                        path: source_path.clone(),
                        thumbnail: None,
                        hash: source_hash,
                        reused: true,
                        owns_file: false,
                    });
                }
            }
        }

        if let Ok(target_dir_canonical) = target_dir.canonicalize() {
            if source_path.starts_with(&target_dir_canonical) {
                let source_path_clone = source_path.clone();
                let thumbnail_path = generate_thumbnail(&source_path_clone).await
                        .map_err(|e| e.to_string())?;
                ensure_minimum_duration(download_start_time, 500).await;
                return Ok(DownloadedImage {
                    path: source_path.clone(),
                    thumbnail: thumbnail_path,
                    hash: source_hash,
                    reused: false,
                    owns_file: false,
                });
            }
        }

        let extension = source_path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("jpg");
        let original_name = source_path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("image");
        let filename = build_safe_filename(
            original_name,
            extension,
            &source_path.to_string_lossy().to_string(),
        );
        let target_path = unique_path(&target_dir, &filename);

        tokio::fs::copy(&source_path, &target_path)
            .await
            .map_err(|e| format!("Failed to copy file: {}", e))?;

        #[cfg(target_os = "windows")]
        remove_zone_identifier(&target_path);

        let target_path_clone = target_path.clone();
        let thumbnail_path = 
            generate_thumbnail(&target_path_clone)
                    .await
                    .map_err(|e| e.to_string())?;

        ensure_minimum_duration(download_start_time, 500).await;

        Ok(DownloadedImage {
            path: target_path,
            thumbnail: thumbnail_path,
            hash: source_hash,
            reused: false,
            owns_file: true,
        })
    } else {
        let url_clone = url.to_string();
        let target_dir_clone = target_dir.clone();
        let plugin_id_clone = plugin_id.to_string();
        let task_id_clone = task_id.to_string();
        let http_headers_clone = http_headers.clone();

        let retry_count = Settings::global()
            .get_network_retry_count()
            .await
            .unwrap_or(2);

        let parsed_url = Url::parse(url).map_err(|e| format!("Invalid image URL: {}", e))?;
        let url_path = parsed_url
            .path_segments()
            .and_then(|segments| segments.last())
            .unwrap_or("image");

        let extension = Path::new(url_path)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("jpg");

        let filename = build_safe_filename(url_path, extension, &url_clone);
        let file_path = unique_path(&target_dir, &filename);

        let (content_hash, final_or_temp_path, final_url) = (async {
            let client = create_client()?;
            let header_map =
                build_reqwest_header_map_for_emitter(&task_id_clone, &http_headers_clone);

            let max_attempts = retry_count.saturating_add(1).max(1);
            let mut attempt: u32 = 0;

            loop {
                attempt += 1;

                let mut current_url = url_clone.clone();
                let mut redirect_count = 0;

                let response = loop {
                    if dq.is_task_canceled(&task_id_clone).await {
                        return Err("Task canceled".to_string());
                    }

                    let mut req = client.get(&current_url);
                    if !header_map.is_empty() {
                        req = req.headers(header_map.clone());
                    }
                    let resp = match req.send().await {
                        Ok(r) => r,
                        Err(e) => {
                            break Err(format!("Failed to download image: {}", e));
                        }
                    };

                    if resp.status().is_redirection() {
                        if redirect_count >= 10 {
                            break Err("Too many redirects".to_string());
                        }
                        if let Some(loc) = resp.headers().get(reqwest::header::LOCATION) {
                            if let Ok(loc_str) = loc.to_str() {
                                if let Ok(u) = Url::parse(&current_url) {
                                    if let Ok(new_url) = u.join(loc_str) {
                                        current_url = new_url.to_string();
                                        redirect_count += 1;
                                        continue;
                                    }
                                }
                            }
                        }
                    }
                    break Ok(resp);
                };

                let response = match response {
                    Ok(r) => r,
                    Err(e) => {
                        if attempt < max_attempts {
                            let backoff_ms = (500u64)
                                .saturating_mul(2u64.saturating_pow((attempt - 1) as u32))
                                .min(5000);
                            sleep(Duration::from_millis(backoff_ms)).await;
                            continue;
                        }
                        return Err(e);
                    }
                };

                let status = response.status();
                if !status.is_success() {
                    let retryable = status.as_u16() == 408
                        || status.as_u16() == 429
                        || status.is_server_error();
                    if retryable && attempt < max_attempts {
                        let backoff_ms = (500u64)
                            .saturating_mul(2u64.saturating_pow((attempt - 1) as u32))
                            .min(5000);
                        sleep(Duration::from_millis(backoff_ms)).await;
                        continue;
                    }
                    return Err(format!("HTTP error: {}", status));
                }

                let final_url = current_url;
                let total_bytes = response.content_length();
                let mut received_bytes: u64 = 0;

                let temp_name = format!("__kg_tmp_{}.part", uuid::Uuid::new_v4());
                let temp_path = target_dir_clone.join(temp_name);

                let mut file = match tokio::fs::File::create(&temp_path).await {
                    Ok(f) => f,
                    Err(e) => return Err(format!("Failed to create file: {}", e)),
                };

                let temp_path_str = temp_path.to_string_lossy().to_string();
                let _ = Storage::global().add_temp_file(&temp_path_str);

                let mut hasher = Sha256::new();

                let mut last_emit_bytes: u64 = 0;
                let mut last_emit_at = std::time::Instant::now();
                let emit_interval = std::time::Duration::from_millis(200);
                let emit_bytes_step: u64 = 256 * 1024;

                GlobalEmitter::global().emit_download_state(
                    &task_id_clone,
                    &url_clone,
                    download_start_time,
                    &plugin_id_clone,
                    "downloading",
                    None,
                );

                let mut stream_error: Option<String> = None;

                let mut stream = response.bytes_stream();

                use futures_util::StreamExt;

                while let Some(item) = stream.next().await {
                    if dq.is_task_canceled(&task_id_clone).await {
                        let temp_path_str = temp_path.to_string_lossy().to_string();
                        let _ = Storage::global().remove_temp_file(&temp_path_str);
                        let _ = tokio::fs::remove_file(&temp_path).await;
                        return Err("Task canceled".to_string());
                    }

                    match item {
                        Ok(chunk) => {
                            hasher.update(&chunk);
                            if let Err(e) = file.write_all(&chunk).await {
                                stream_error = Some(format!("Failed to write file: {}", e));
                                break;
                            }

                            received_bytes = received_bytes.saturating_add(chunk.len() as u64);

                            let should_emit = (last_emit_bytes == 0 && received_bytes > 0)
                                || received_bytes.saturating_sub(last_emit_bytes)
                                    >= emit_bytes_step
                                || last_emit_at.elapsed() >= emit_interval;
                            if should_emit {
                                last_emit_bytes = received_bytes;
                                last_emit_at = std::time::Instant::now();
                                GlobalEmitter::global().emit_download_progress(
                                    &task_id_clone,
                                    &url_clone,
                                    download_start_time,
                                    &plugin_id_clone,
                                    received_bytes,
                                    total_bytes,
                                );
                            }
                        }
                        Err(e) => {
                            stream_error = Some(format!("Failed to read stream: {}", e));
                            break;
                        }
                    }
                }

                drop(file);

                // 确保发送最后一次进度（100%）
                if stream_error.is_none() && received_bytes > 0 {
                    GlobalEmitter::global().emit_download_progress(
                        &task_id_clone,
                        &url_clone,
                        download_start_time,
                        &plugin_id_clone,
                        received_bytes,
                        total_bytes,
                    );
                }

                if let Some(err) = stream_error {
                    let temp_path_str = temp_path.to_string_lossy().to_string();
                    let _ = Storage::global().remove_temp_file(&temp_path_str);
                    let _ = tokio::fs::remove_file(&temp_path).await;
                    if attempt < max_attempts {
                        let backoff_ms = (500u64)
                            .saturating_mul(2u64.saturating_pow((attempt - 1) as u32))
                            .min(5000);
                        sleep(Duration::from_millis(backoff_ms)).await;
                        continue;
                    }
                    return Err(err);
                }

                let content_hash = format!("{:x}", hasher.finalize());
                return Ok((content_hash, temp_path, final_url));
            }
        })
        .await?;

        let final_file_path = if final_url != url_clone {
            let parsed_url =
                Url::parse(&final_url).map_err(|e| format!("Invalid final image URL: {}", e))?;
            let url_path = parsed_url
                .path_segments()
                .and_then(|segments| segments.last())
                .unwrap_or("image");

            let extension = Path::new(url_path)
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("jpg");

            let filename = build_safe_filename(url_path, extension, &final_url);
            unique_path(&target_dir, &filename)
        } else {
            file_path
        };

        let should_check_hash_dedupe = Settings::global()
            .get_auto_deduplicate()
            .await
            .unwrap_or(false);

        if should_check_hash_dedupe {
            if let Ok(Some(existing)) = Storage::global().find_image_by_hash(&content_hash) {
                let existing_path = PathBuf::from(&existing.local_path);
                if existing_path.exists() {
                    let temp_path_str = final_or_temp_path.to_string_lossy().to_string();
                    let _ = Storage::global().remove_temp_file(&temp_path_str);
                    let _ = tokio::fs::remove_file(&final_or_temp_path).await;
                    let mut thumb_path = if existing.thumbnail_path.trim().is_empty() {
                        existing_path.clone()
                    } else {
                        PathBuf::from(&existing.thumbnail_path)
                    };

                    if !thumb_path.exists() {
                        let existing_path_clone = existing_path.clone();
                        let existing_id = existing.id.clone();
                        let thumb = generate_thumbnail(&existing_path_clone)
                        .await
                        .map_err(|e| e.to_string())?;

                        if let Some(gen) = thumb {
                            thumb_path = gen;
                            let canonical_thumb = thumb_path
                                .canonicalize()
                                .unwrap_or(thumb_path.clone())
                                .to_string_lossy()
                                .to_string()
                                .trim_start_matches("\\\\?\\")
                                .to_string();
                            let _ = Storage::global()
                                .update_image_thumbnail_path(&existing_id, &canonical_thumb);
                        } else {
                            thumb_path = existing_path.clone();
                        }
                    }

                    let canonical_existing = existing_path
                        .canonicalize()
                        .unwrap_or(existing_path)
                        .to_string_lossy()
                        .to_string()
                        .trim_start_matches("\\\\?\\")
                        .to_string();
                    let canonical_thumb = thumb_path
                        .canonicalize()
                        .unwrap_or(thumb_path)
                        .to_string_lossy()
                        .to_string()
                        .trim_start_matches("\\\\?\\")
                        .to_string();

                    ensure_minimum_duration(download_start_time, 500).await;

                    return Ok(DownloadedImage {
                        path: PathBuf::from(canonical_existing),
                        thumbnail: Some(PathBuf::from(canonical_thumb)),
                        hash: if existing.hash.is_empty() {
                            content_hash.clone()
                        } else {
                            existing.hash
                        },
                        reused: true,
                        owns_file: false,
                    });
                }
            }
        }

        tokio::fs::rename(&final_or_temp_path, &final_file_path)
            .await
            .map_err(|e| format!("Failed to finalize file: {}", e))?;
        let temp_path_str = final_or_temp_path.to_string_lossy().to_string();
        let _ = Storage::global().remove_temp_file(&temp_path_str);

        #[cfg(windows)]
        remove_zone_identifier(&final_file_path);

        let final_file_path_clone = final_file_path.clone();
        let thumbnail_path =
           generate_thumbnail(&final_file_path_clone)
                .await
                .map_err(|e| e.to_string())?;

        ensure_minimum_duration(download_start_time, 500).await;

        Ok(DownloadedImage {
            path: final_file_path,
            thumbnail: thumbnail_path,
            hash: content_hash,
            reused: false,
            owns_file: true,
        })
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

pub async fn generate_thumbnail(image_path: &Path) -> Result<Option<PathBuf>, String> {
    let app_data_dir = crate::app_paths::kabegame_data_dir();
    let thumbnails_dir = app_data_dir.join("thumbnails");
    tokio::fs::create_dir_all(&thumbnails_dir).await
        .map_err(|e| format!("Failed to create thumbnails directory: {}", e))?;

    let img = match image::open(image_path) {
        Ok(img) => img,
        Err(_) => return Ok(None),
    };

    let thumbnail = img.thumbnail(300, 300);

    let thumbnail_filename = format!("{}.jpg", uuid::Uuid::new_v4());
    let thumbnail_path = thumbnails_dir.join(&thumbnail_filename);

    thumbnail
        .save(&thumbnail_path)
        .map_err(|e| format!("Failed to save thumbnail: {}", e))?;

    Ok(Some(thumbnail_path))
}
