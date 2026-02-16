//! HTTP/HTTPS 下载实现：计算目标路径与执行下载。
//! 流式读入内存缓冲，按间隔上报进度，最后一次性写入 dest，不落盘临时文件。

use async_trait::async_trait;
use futures_util::StreamExt;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, CONTENT_LENGTH};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Instant;
use tokio::fs::File;
use tokio::io::AsyncWriteExt;
use tokio::time::{sleep, Duration};
use url::Url;

use crate::emitter::GlobalEmitter;
use crate::settings::Settings;
use crate::storage::Storage;
use super::{build_safe_filename, emit_task_log, unique_path, DownloadProgressContext, DownloadQueue, SchemeDownloader, UrlDownloaderKind};

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
        let extension = Path::new(url_path)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or(crate::image_type::default_image_extension());
        let filename = build_safe_filename(url_path, extension, url.as_str());
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
        progress: &DownloadProgressContext<'_>,
    ) -> Result<String, String> {
        let task = Storage::global()
            .get_task(task_id)?
            .ok_or_else(|| "Task not found".to_string())?;
        let headers = task.http_headers.unwrap_or_default();
        let retry = Settings::global()
            .get_network_retry_count()
            .await
            .unwrap_or(2);
        download_http(dq, task_id, url, dest, &headers, retry, progress).await
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

/// 进度上报节流间隔（毫秒）
const PROGRESS_EMIT_INTERVAL_MS: u64 = 200;

/// HTTP/HTTPS 下载实现（由 [super::SchemeDownloader] Http scheme 分发调用）。
/// 流式读入内存缓冲，按间隔上报进度，最后一次性写入 dest，不落盘临时文件；失败重试时重新请求全量。
async fn download_http(
    dq: &DownloadQueue,
    task_id: &str,
    url: &Url,
    dest: &Path,
    headers: &HashMap<String, String>,
    retry_count: u32,
    progress: &DownloadProgressContext<'_>,
) -> Result<String, String> {
    let client = create_client()?;
    let header_map = build_reqwest_header_map_for_emitter(task_id, headers);
    let max_attempts = retry_count.saturating_add(1).max(1);

    let mut attempt: u32 = 0;
    loop {
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

            let r = match req.send().await {
                Ok(r) => r,
                Err(e) => break Err(format!("Failed to download: {e}")),
            };

            if r.status().is_redirection() {
                if redirect_count >= 10 {
                    break Err("Too many redirects".to_string());
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

        let total_bytes = resp
            .headers()
            .get(CONTENT_LENGTH)
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.parse::<u64>().ok());

        let mut buffer = Vec::new();
        let mut received: u64 = 0;
        let mut last_emit = Instant::now();
        let mut stream = resp.bytes_stream();

        while let Some(chunk_result) = stream.next().await {
            if dq.is_task_canceled(task_id).await {
                return Err("Task canceled".to_string());
            }
            let chunk = chunk_result.map_err(|e| format!("Failed to read response stream: {e}"))?;
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

        return Ok(current_url.to_string());
    }
}
