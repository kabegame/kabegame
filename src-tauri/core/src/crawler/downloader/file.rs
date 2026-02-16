//! file:// 协议：什么都不做，只返回本地路径（去掉 file 前缀）；以及计算目标路径。

use async_trait::async_trait;
use std::path::{Path, PathBuf};
use url::Url;

use crate::crawler::archiver;

use super::{build_safe_filename, resolve_local_path_from_url, unique_path, DownloadProgressContext, DownloadQueue, SchemeDownloader, UrlDownloaderKind};

/// file:// 或本地路径：目标路径由源文件路径推导。
pub struct FileSchemeDownloader;

#[async_trait]
impl SchemeDownloader for FileSchemeDownloader {
    fn supported_schemes(&self) -> &[&'static str] {
        &["file"]
    }

    fn compute_destination_path(&self, url: &Url, base_dir: &Path) -> Result<PathBuf, String> {
        let source_path = resolve_local_path_from_url(url.as_str())
            .ok_or_else(|| format!("Invalid or non-existent file URL: {}", url))?;
        let extension = source_path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or(crate::image_type::default_image_extension());
        let original_name = source_path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("image");
        let filename = build_safe_filename(
            original_name,
            extension,
            &source_path.to_string_lossy().to_string(),
        );
        Ok(unique_path(base_dir, &filename))
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
        handle_file(dq, task_id, url.as_str(), progress).await
    }
}

/// file://：什么都不做，只解析并返回本地路径（去掉 file 前缀）；不写入 dest。结束时上报一次进度供前端展示。
async fn handle_file(
    dq: &DownloadQueue,
    task_id: &str,
    url: &str,
    progress: &DownloadProgressContext<'_>,
) -> Result<String, String> {
    if dq.is_task_canceled(task_id).await {
        return Err("Task canceled".to_string());
    }

    let source = archiver::resolve_local_path_from_url(url).ok_or_else(|| {
        format!("Invalid or non-existent file URL: {}", url)
    })?;

    if !source.exists() {
        return Err(format!("Source file does not exist: {}", source.display()));
    }
    if !source.is_file() {
        return Err(format!("Source is not a file: {}", source.display()));
    }

    let total = std::fs::metadata(&source).ok().map(|m| m.len());
    crate::emitter::GlobalEmitter::global().emit_download_progress(
        task_id,
        url,
        progress.start_time,
        progress.plugin_id,
        total.unwrap_or(0),
        total,
    );

    Ok(source.to_string_lossy().to_string())
}
