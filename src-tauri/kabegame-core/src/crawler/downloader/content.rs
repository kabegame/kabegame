//! Android content:// 下载实现：从 ContentResolver 读取完整字节。

use async_trait::async_trait;
use std::collections::HashMap;
use url::Url;

use super::{DownloadAttemptError, DownloadQueue, SchemeDownloader};
use crate::crawler::content_io::get_content_io_provider;

pub struct ContentSchemeDownloader;

#[async_trait]
impl SchemeDownloader for ContentSchemeDownloader {
    async fn download(
        &self,
        _dq: &DownloadQueue,
        url: &Url,
        _task_id: &str,
        _headers: &HashMap<String, String>,
        out: &mut (dyn std::io::Write + Send),
        _already_received: u64,
        _download_id: u64,
    ) -> Result<(), DownloadAttemptError> {
        // content:// 一次性整体读入，无续传，也不清空 out（清空 / 落盘由 download_with_retry 负责）。
        use std::io::Write as _;
        let bytes = get_content_io_provider()
            .read_file_bytes(url.as_str())
            .await
            .map_err(|e| {
                DownloadAttemptError::fatal(format!("Failed to read content URI: {}", e))
            })?;
        out.write_all(&bytes)
            .map_err(|e| DownloadAttemptError::fatal(format!("write download buffer: {e}")))?;
        Ok(())
    }

    async fn display_name(&self, _url: &Url, final_local_path: &str) -> String {
        get_content_io_provider()
            .get_display_name(final_local_path)
            .await
            .unwrap_or_else(|_| "image".to_string())
    }
}
