//! HTTP/HTTPS 下载实现：流式读入内存缓冲，按间隔上报进度。

use async_trait::async_trait;
use futures_util::StreamExt;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, CONTENT_LENGTH, CONTENT_RANGE, RANGE};
use std::collections::HashMap;
use std::path::Path;
use std::sync::{LazyLock, Mutex, Once};
use std::time::Instant;
use tokio::io::AsyncWriteExt;
use tokio::time::Duration;
use url::Url;

use super::{DownloadAttemptError, DownloadWriter, SchemeDownloader};
use crate::crawler::task_log_i18n::task_log_i18n;
use serde_json::json;

/// http(s) scheme：目标路径由 URL 路径段与扩展名决定。
pub struct HttpSchemeDownloader;

#[async_trait]
impl SchemeDownloader for HttpSchemeDownloader {
    async fn download(
        &self,
        url: &Url,
        headers: &HashMap<String, String>,
        out: &mut dyn DownloadWriter,
        already_received: u64,
    ) -> Result<(), DownloadAttemptError> {
        download_http(url, headers, out, already_received).await
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
                if let Ok(proxy) = reqwest::Proxy::all(&format!("direct://{}", domain)) {
                    client_builder = client_builder.proxy(proxy);
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

pub fn build_reqwest_header_map(
    headers: &HashMap<String, String>,
    out: &mut dyn DownloadWriter,
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
                out.warn(task_log_i18n(
                    "taskLogHttpHeaderInvalidName",
                    json!({ "key": key, "detail": e.to_string() }),
                ));
                continue;
            }
        };
        let value = match HeaderValue::from_str(v) {
            Ok(v) => v,
            Err(e) => {
                out.warn(task_log_i18n(
                    "taskLogHttpHeaderInvalidValue",
                    json!({ "key": key, "detail": e.to_string() }),
                ));
                continue;
            }
        };
        map.insert(name, value);
    }
    map
}

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
/// 流式读入内存缓冲，按间隔上报进度；
/// 读流失败时优先使用 Range 从已接收字节继续下载，服务端不支持时回退整包重下。
async fn download_http(
    url: &Url,
    headers: &HashMap<String, String>,
    out: &mut dyn DownloadWriter,
    already_received: u64,
) -> Result<(), DownloadAttemptError> {
    let host = url.host_str().unwrap_or("unknown");
    let client = CLIENT_POOL
        .get_or_create(host)
        .map_err(DownloadAttemptError::resumable)?;
    let mut header_map = build_reqwest_header_map(headers, out);
    // 已接收量由外部告知（out 是抽象 writer，无法回读已写入长度）；仅用于 Range 续传判断。
    let received = already_received;

    let mut current_url = url.clone();
    let mut redirect_count: u32 = 0;

    let resp = loop {
        let mut req = client.get(current_url.as_str());
        if !header_map.is_empty() {
            req = req.headers(header_map.clone());
        }
        if received > 0 {
            req = req.header(RANGE, format!("bytes={}-", received));
        }

        let r = req.send().await.map_err(|e| {
            DownloadAttemptError::resumable(format!("Failed to download: {e}"))
        })?;

        if r.status().is_redirection() {
            if redirect_count >= 10 {
                return Err(DownloadAttemptError::fatal("Too many redirects"));
            }

            // Collect Set-Cookie from redirect responses and merge into Cookie header.
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
        break r;
    };

    let status = resp.status();
    if !status.is_success() {
        let retryable =
            status.as_u16() == 408 || status.as_u16() == 429 || status.is_server_error();
        if retryable {
            return Err(DownloadAttemptError::resumable(format!("HTTP error: {status}")));
        }
        return Err(DownloadAttemptError::fatal(format!("HTTP error: {status}")));
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
                            let msg = format!(
                                "Invalid Content-Range start: expected {}, got {}",
                                received, start
                            );
                            return Err(DownloadAttemptError::retriable(msg));
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
            // 我们带 Range 请求续传，服务端却返回非 206（忽略 Range）：无法续传。
            // out 是抽象 Write，下载器无法自行清空已写内容，因此返回截断（Retriable），
            // 由 download_with_retry 清空缓冲后从头重下。
            out.warn(task_log_i18n(
                "taskLogDownloadNoPartialContent",
                json!({ "status": status.to_string() }),
            ));
            return Err(DownloadAttemptError::retriable(format!(
                "server ignored Range (status {status}); truncating to restart"
            )));
        }
    }
    // 声明总量后,进度（含字节/总量/节流上报）全部由 writer 经 DownloadQueue 处理。
    out.set_total(total_bytes);
    let mut stream = resp.bytes_stream();

    while let Some(chunk_result) = stream.next().await {
        let chunk = match chunk_result {
            Ok(c) => c,
            Err(e) => {
                let msg = format!("Failed to read response stream: {e}");
                if is_retryable_stream_error(&msg) {
                    return Err(DownloadAttemptError::resumable(msg));
                }
                return Err(DownloadAttemptError::fatal(msg));
            }
        };
        out.write_all(&chunk)
            .await
            .map_err(|e| DownloadAttemptError::fatal(format!("write download buffer: {e}")))?;
    }

    Ok(())
}
