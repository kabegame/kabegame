//! HTTP/HTTPS 下载实现：计算目标路径与执行下载。
//! 流式读入内存缓冲，按间隔上报进度，最后一次性写入 dest，不落盘临时文件。

use async_trait::async_trait;
use futures_util::StreamExt;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, CONTENT_LENGTH, CONTENT_RANGE, RANGE};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex, Once};
use std::time::Instant;
use tokio::fs::File;
use tokio::io::AsyncWriteExt;
use tokio::time::{sleep, Duration};
use url::Url;

#[cfg(not(target_os = "android"))]
use super::build_safe_filename_no_ext;
use super::{
    build_safe_filename, emit_task_log, unique_path, DownloadProgressContext, DownloadQueue,
    SchemeDownloader, UrlDownloaderKind,
};
use crate::crawler::task_log_i18n::task_log_i18n;
use crate::emitter::GlobalEmitter;
use crate::settings::Settings;
use serde_json::json;

/// http(s) scheme：目标路径由 URL 路径段与扩展名决定。
pub struct HttpSchemeDownloader;

#[async_trait]
impl SchemeDownloader for HttpSchemeDownloader {
    fn supported_schemes(&self) -> &[&'static str] {
        &["http", "https"]
    }

    fn compute_destination_path(&self, url: &Url, base_dir: &Path) -> Result<PathBuf, String> {
        let url_path = url
            .path_segments()
            .and_then(|segments| segments.last())
            .unwrap_or("image");
        let extension = Path::new(url_path).extension().and_then(|e| e.to_str());
        #[cfg(target_os = "android")]
        let filename = build_safe_filename(
            url_path,
            extension.unwrap_or(crate::image_type::default_image_extension()),
            url.as_str(),
        );
        #[cfg(not(target_os = "android"))]
        let filename = match extension {
            Some(ext) => build_safe_filename(url_path, ext, url.as_str()),
            None => build_safe_filename_no_ext(url_path, url.as_str()),
        };
        Ok(unique_path(base_dir, &filename))
    }

    fn download_kind(&self) -> UrlDownloaderKind {
        UrlDownloaderKind::Http
    }

    async fn download(
        &self,
        dq: &DownloadQueue,
        url: &Url,
        dest: &Path,
        task_id: &str,
        headers: &HashMap<String, String>,
        progress: &DownloadProgressContext<'_>,
    ) -> Result<String, String> {
        let retry = Settings::global()
            .get_network_retry_count()
            .await
            .unwrap_or(2);
        download_http(dq, task_id, url, dest, headers, retry, progress).await
    }

    async fn display_name(&self, _url: &Url, final_local_path: &str) -> String {
        Path::new(final_local_path)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("image")
            .to_string()
    }
}

pub fn create_client() -> Result<reqwest::Client, String> {
    let mut client_builder = reqwest::Client::builder();

    let config = crate::crawler::proxy::get_proxy_config();

    if let Some(ref proxy_url) = config.proxy_url {
        match reqwest::Proxy::all(proxy_url) {
            Ok(proxy) => {
                client_builder = client_builder.proxy(proxy);
                eprintln!("网络代理已配置 (async): {}", proxy_url);
            }
            Err(e) => {
                eprintln!("代理配置无效 ({}), 将使用直连 (async): {}", proxy_url, e);
            }
        }
    }

    if let Some(ref no_proxy) = config.no_proxy {
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

    client_builder = client_builder
        .timeout(Duration::from_secs(HTTP_REQUEST_TIMEOUT_SECS))
        .connect_timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .user_agent("Kabegame/1.0");

    client_builder
        .build()
        .map_err(|e| format!("Failed to create async HTTP client: {}", e))
}

/// 客户端池条目：按 host 复用 [reqwest::Client]，60 秒未使用则可被清理。
const CLIENT_IDLE_SECS: u64 = 60;
/// 后台扫描间隔（秒）
const SWEEP_INTERVAL_SECS: u64 = 30;

struct PoolEntry {
    client: reqwest::Client,
    last_used: Instant,
}

struct HttpClientPool {
    entries: Mutex<HashMap<String, PoolEntry>>,
}

impl HttpClientPool {
    fn new() -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
        }
    }

    fn start_sweeper() {
        static SWEEPER_ONCE: Once = Once::new();
        SWEEPER_ONCE.call_once(|| {
            tokio::spawn(async {
                loop {
                    tokio::time::sleep(Duration::from_secs(SWEEP_INTERVAL_SECS)).await;
                    CLIENT_POOL.sweep_stale();
                }
            });
        });
    }

    fn sweep_stale(&self) {
        let mut map = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        map.retain(|_, entry| entry.last_used.elapsed() < Duration::from_secs(CLIENT_IDLE_SECS));
    }

    fn get_or_create(&self, host: &str) -> Result<reqwest::Client, String> {
        Self::start_sweeper();
        let mut map = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        let now = Instant::now();
        if let Some(entry) = map.get_mut(host) {
            if entry.last_used.elapsed() < Duration::from_secs(CLIENT_IDLE_SECS) {
                entry.last_used = now;
                return Ok(entry.client.clone());
            }
        }
        let client = create_client()?;
        map.insert(
            host.to_string(),
            PoolEntry {
                client: client.clone(),
                last_used: now,
            },
        );
        Ok(client)
    }
}

static CLIENT_POOL: LazyLock<HttpClientPool> = LazyLock::new(HttpClientPool::new);

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
                    task_log_i18n(
                        "taskLogHttpHeaderInvalidName",
                        json!({ "key": key, "detail": e.to_string() }),
                    ),
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
                    task_log_i18n(
                        "taskLogHttpHeaderInvalidValue",
                        json!({ "key": key, "detail": e.to_string() }),
                    ),
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
                    &task_log_i18n(
                        "taskLogHttpHeaderInvalidName",
                        json!({ "key": key, "detail": e.to_string() }),
                    ),
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
                    &task_log_i18n(
                        "taskLogHttpHeaderInvalidValue",
                        json!({ "key": key, "detail": e.to_string() }),
                    ),
                );
                continue;
            }
        };
        map.insert(name, value);
    }
    map
}

/// 进度上报节流间隔（毫秒）
const PROGRESS_EMIT_INTERVAL_MS: u64 = 200;

/// 整体请求+响应体读取超时（秒），大图或慢速站点需较长时间
const HTTP_REQUEST_TIMEOUT_SECS: u64 = 600;

/// 判断响应体读取错误是否可重试（超时、连接中断、body error 等）
fn is_retryable_stream_error(msg: &str) -> bool {
    let lower = msg.to_lowercase();
    lower.contains("timed out")
        || lower.contains("timeout")
        || lower.contains("body error")
        || lower.contains("connection reset")
        || lower.contains("connection refused")
        || lower.contains("eof")
        || lower.contains("broken pipe")
}

fn parse_content_range_start_and_total(header: &str) -> Option<(u64, Option<u64>)> {
    // 形如: "bytes 123-456/789" 或 "bytes 123-456/*"
    let raw = header.trim();
    let bytes_part = raw.strip_prefix("bytes ")?;
    let (range_part, total_part) = bytes_part.split_once('/')?;
    let (start_part, _end_part) = range_part.split_once('-')?;
    let start = start_part.trim().parse::<u64>().ok()?;
    let total = if total_part.trim() == "*" {
        None
    } else {
        total_part.trim().parse::<u64>().ok()
    };
    Some((start, total))
}

/// HTTP/HTTPS 下载实现（由 [super::SchemeDownloader] Http scheme 分发调用）。
/// 流式读入内存缓冲，按间隔上报进度，最后一次性写入 dest，不落盘临时文件；
/// 读流失败时优先使用 Range 从已接收字节继续下载，服务端不支持时回退整包重下。
async fn download_http(
    dq: &DownloadQueue,
    task_id: &str,
    url: &Url,
    dest: &Path,
    headers: &HashMap<String, String>,
    retry_count: u32,
    progress: &DownloadProgressContext<'_>,
) -> Result<String, String> {
    let host = url.host_str().unwrap_or("unknown");
    let client = CLIENT_POOL.get_or_create(host)?;
    let mut header_map = build_reqwest_header_map_for_emitter(task_id, headers);
    let max_attempts = retry_count.saturating_add(1).max(1);
    let mut buffer = Vec::new();
    let mut received: u64 = 0;
    let mut last_emit = Instant::now();

    let mut attempt: u32 = 0;
    'retry: loop {
        attempt += 1;

        let mut current_url = url.clone();
        let mut redirect_count: u32 = 0;

        let resp = loop {
            if dq.is_task_canceled(task_id).await {
                return Err("Task canceled".to_string());
            }

            let mut req = client.get(current_url.as_str());
            if !header_map.is_empty() {
                req = req.headers(header_map.clone());
            }
            if received > 0 {
                req = req.header(RANGE, format!("bytes={}-", received));
            }

            let r = match req.send().await {
                Ok(r) => r,
                Err(e) => break Err(format!("Failed to download: {e}")),
            };

            if r.status().is_redirection() {
                if redirect_count >= 10 {
                    break Err("Too many redirects".to_string());
                }

                // Collect Set-Cookie from redirect responses and merge into Cookie header
                for set_cookie_val in r.headers().get_all(reqwest::header::SET_COOKIE) {
                    if let Ok(sc) = set_cookie_val.to_str() {
                        if let Some(name_value) = sc.split(';').next() {
                            let existing = header_map
                                .get(reqwest::header::COOKIE)
                                .and_then(|v| v.to_str().ok())
                                .unwrap_or("")
                                .to_string();
                            let merged = if existing.is_empty() {
                                name_value.to_string()
                            } else {
                                format!("{existing}; {name_value}")
                            };
                            if let Ok(val) = HeaderValue::from_str(&merged) {
                                header_map.insert(reqwest::header::COOKIE, val);
                            }
                        }
                    }
                }

                if let Some(loc) = r.headers().get(reqwest::header::LOCATION) {
                    if let Ok(loc_str) = loc.to_str() {
                        if let Ok(new_url) = current_url.join(loc_str) {
                            current_url = new_url;
                            redirect_count += 1;
                            continue;
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
                    emit_task_log(
                        task_id,
                        "warn",
                        task_log_i18n(
                            "taskLogHttpRetryRequest",
                            json!({
                                "attempt": attempt,
                                "max": max_attempts,
                                "detail": e.to_string(),
                            }),
                        ),
                    );
                    sleep(Duration::from_millis(backoff_ms)).await;
                    continue 'retry;
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
                emit_task_log(
                    task_id,
                    "warn",
                    task_log_i18n(
                        "taskLogHttpRetryStatus",
                        json!({
                            "status": status.to_string(),
                            "attempt": attempt,
                            "max": max_attempts,
                        }),
                    ),
                );
                sleep(Duration::from_millis(backoff_ms)).await;
                continue 'retry;
            }
            return Err(format!("HTTP error: {status}"));
        }

        let mut total_bytes = resp
            .headers()
            .get(CONTENT_LENGTH)
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.parse::<u64>().ok());
        if received > 0 {
            if status == reqwest::StatusCode::PARTIAL_CONTENT {
                if let Some(v) = resp.headers().get(CONTENT_RANGE) {
                    if let Ok(s) = v.to_str() {
                        if let Some((start, total)) = parse_content_range_start_and_total(s) {
                            if start != received {
                                return Err(format!(
                                    "Invalid Content-Range start: expected {}, got {}",
                                    received, start
                                ));
                            }
                            total_bytes = total.or_else(|| total_bytes.map(|len| len + received));
                        } else {
                            total_bytes = total_bytes.map(|len| len + received);
                        }
                    } else {
                        total_bytes = total_bytes.map(|len| len + received);
                    }
                } else {
                    total_bytes = total_bytes.map(|len| len + received);
                }
            } else {
                emit_task_log(
                    task_id,
                    "warn",
                    task_log_i18n(
                        "taskLogHttpNoPartialContent",
                        json!({ "status": status.to_string() }),
                    ),
                );
                buffer.clear();
                received = 0;
                total_bytes = resp
                    .headers()
                    .get(CONTENT_LENGTH)
                    .and_then(|v| v.to_str().ok())
                    .and_then(|s| s.parse::<u64>().ok());
            }
        }
        let mut stream = resp.bytes_stream();

        while let Some(chunk_result) = stream.next().await {
            if dq.is_task_canceled(task_id).await {
                return Err("Task canceled".to_string());
            }
            let chunk = match chunk_result {
                Ok(c) => c,
                Err(e) => {
                    let msg = format!("Failed to read response stream: {e}");
                    let retryable = is_retryable_stream_error(&msg);
                    if retryable && attempt < max_attempts {
                        let backoff_ms = (500u64)
                            .saturating_mul(2u64.saturating_pow((attempt - 1) as u32))
                            .min(5000);
                        emit_task_log(
                            task_id,
                            "warn",
                            task_log_i18n(
                                "taskLogHttpRetryReadBody",
                                json!({
                                    "attempt": attempt,
                                    "max": max_attempts,
                                    "detail": msg,
                                }),
                            ),
                        );
                        sleep(Duration::from_millis(backoff_ms)).await;
                        continue 'retry;
                    }
                    return Err(msg);
                }
            };
            let n = chunk.len() as u64;
            received += n;
            buffer.extend_from_slice(&chunk);

            let elapsed_ms = last_emit.elapsed().as_millis() as u64;
            if elapsed_ms >= PROGRESS_EMIT_INTERVAL_MS {
                last_emit = Instant::now();
                GlobalEmitter::global().emit_download_progress(
                    task_id,
                    current_url.as_str(),
                    progress.start_time,
                    progress.plugin_id,
                    received,
                    total_bytes,
                );
            }
        }

        GlobalEmitter::global().emit_download_progress(
            task_id,
            current_url.as_str(),
            progress.start_time,
            progress.plugin_id,
            received,
            total_bytes,
        );

        let mut file = File::options()
            .create(true)
            .write(true)
            .truncate(true)
            .open(dest)
            .await
            .map_err(|e| format!("Failed to create file: {e}"))?;
        file.write_all(&buffer)
            .await
            .map_err(|e| format!("Failed to write file: {e}"))?;
        file.flush()
            .await
            .map_err(|e| format!("Failed to flush file: {e}"))?;

        return Ok(current_url.to_string());
    }
}
