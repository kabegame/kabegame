//! file:// 协议：什么都不做，只返回本地路径（去掉 file 前缀）；以及计算目标路径。

use async_trait::async_trait;
use std::path::{Path, PathBuf};
use url::Url;

use super::{DownloadProgressContext, DownloadQueue, SchemeDownloader, UrlDownloaderKind};

/// file:// 或本地路径：目标路径由源文件路径推导。
pub struct FileSchemeDownloader;

#[async_trait]
impl SchemeDownloader for FileSchemeDownloader {
    fn supported_schemes(&self) -> &[&'static str] {
        &["file"]
    }

    fn compute_destination_path(&self, url: &Url, _base_dir: &Path) -> Result<PathBuf, String> {
        // file:// 不复制，dest 即源路径，忽略 base_dir
        url.to_file_path()
            .map_err(|_| format!("Invalid or non-existent file URL: {}", url))
    }

    fn download_kind(&self) -> UrlDownloaderKind {
        UrlDownloaderKind::File
    }

    async fn download(
        &self,
        dq: &DownloadQueue,
        url: &Url,
        _dest: &Path,
        task_id: &str,
        progress: &DownloadProgressContext<'_>,
    ) -> Result<String, String> {
        eprintln!("handle_file: {}", url.as_str());
        handle_file(dq, task_id, url, progress).await
    }
}

/// file://：什么都不做，只解析并返回本地路径（库函数 Url::to_file_path）；不写入 dest。结束时上报一次进度供前端展示。
async fn handle_file(
    dq: &DownloadQueue,
    task_id: &str,
    url: &Url,
    progress: &DownloadProgressContext<'_>,
) -> Result<String, String> {
    if dq.is_task_canceled(task_id).await {
        return Err("Task canceled".to_string());
    }

    let source = url
        .to_file_path()
        .map_err(|_| format!("Invalid or non-existent file URL: {}", url))?;

    if !source.exists() {
        return Err(format!("Source file does not exist: {}", source.display()));
    }
    if !source.is_file() {
        return Err(format!("Source is not a file: {}", source.display()));
    }

    let total = std::fs::metadata(&source).ok().map(|m| m.len());
    crate::emitter::GlobalEmitter::global().emit_download_progress(
        task_id,
        url.as_str(),
        progress.start_time,
        progress.plugin_id,
        total.unwrap_or(0),
        total,
    );

    Ok(source.to_string_lossy().to_string())
}
