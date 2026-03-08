//! content://（Android）协议：请求持久化权限后直接引用 content URI，不复制文件。

use async_trait::async_trait;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use url::Url;

use super::{short_hash8, DownloadProgressContext, DownloadQueue, SchemeDownloader, UrlDownloaderKind};

#[cfg(target_os = "android")]
use crate::crawler::content_io::get_content_io_provider;

/// content://：不复制，dest 为占位路径（不被使用），返回原 URI。
pub struct ContentSchemeDownloader;

#[async_trait]
impl SchemeDownloader for ContentSchemeDownloader {
    fn supported_schemes(&self) -> &[&'static str] {
        &["content"]
    }

    fn compute_destination_path(&self, url: &Url, base_dir: &Path) -> Result<PathBuf, String> {
        let hash = short_hash8(url.as_str());
        Ok(base_dir.join(format!(".content_sentinel_{}", hash)))
    }

    fn download_kind(&self) -> UrlDownloaderKind {
        UrlDownloaderKind::Content
    }

    async fn download(
        &self,
        dq: &DownloadQueue,
        url: &Url,
        _dest: &Path,
        task_id: &str,
        _headers: &HashMap<String, String>,
        progress: &DownloadProgressContext<'_>,
    ) -> Result<String, String> {
        handle_content(dq, task_id, url.as_str(), progress).await
    }

    async fn display_name(&self, _url: &Url, final_local_path: &str) -> String {
        #[cfg(target_os = "android")]
        {
            match get_content_io_provider().get_display_name(final_local_path).await {
                Ok(name) => name,
                Err(_) => {
                    // 回退到 URI 末段
                    final_local_path
                        .split('/')
                        .last()
                        .unwrap_or("image")
                        .to_string()
                }
            }
        }
        #[cfg(not(target_os = "android"))]
        {
            final_local_path
                .split('/')
                .last()
                .unwrap_or("image")
                .to_string()
        }
    }
}

/// 请求持久化权限（失败静默），然后返回原 content URI。
async fn handle_content(
    dq: &DownloadQueue,
    task_id: &str,
    url: &str,
    progress: &DownloadProgressContext<'_>,
) -> Result<String, String> {
    #[cfg(not(target_os = "android"))]
    return Err("content:// is only supported on Android".to_string());

    #[cfg(target_os = "android")] {
        if dq.is_task_canceled(task_id).await {
            return Err("Task canceled".to_string());
        }
    
        let _ = get_content_io_provider().take_persistable_permission(url).await;
    
        crate::emitter::GlobalEmitter::global().emit_download_progress(
            task_id,
            url,
            progress.start_time,
            progress.plugin_id,
            1,
            Some(1),
        );
    
        Ok(url.to_string())
    }
}
