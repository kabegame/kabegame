//! content://（Android）协议：复制前注册可访问权限，再通过 resolver 复制到目标路径；以及计算目标路径。

use async_trait::async_trait;
use std::path::{Path, PathBuf};
use url::Url;

use super::{get_content_permission_register, get_content_resolver, unique_path, DownloadProgressContext, DownloadQueue, SchemeDownloader, UrlDownloaderKind};

/// content://：目标文件名为 content_<uuid>.bin。
pub struct ContentSchemeDownloader;

#[async_trait]
impl SchemeDownloader for ContentSchemeDownloader {
    fn supported_schemes(&self) -> &[&'static str] {
        &["content"]
    }

    fn compute_destination_path(&self, _url: &Url, base_dir: &Path) -> Result<PathBuf, String> {
        let filename = format!("content_{}.bin", uuid::Uuid::new_v4());
        Ok(unique_path(base_dir, &filename))
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
        progress: &DownloadProgressContext<'_>,
    ) -> Result<String, String> {
        handle_content(dq, task_id, url.as_str(), progress).await
    }
}

/// 调用已注册的权限注册回调（如有），然后直接引用 content url。结束时上报一次进度供前端展示。
async fn handle_content(
    dq: &DownloadQueue,
    task_id: &str,
    url: &str,
    progress: &DownloadProgressContext<'_>,
) -> Result<String, String> {
    if dq.is_task_canceled(task_id).await {
        return Err("Task canceled".to_string());
    }

    if let Some(register) = get_content_permission_register() {
        register(url.to_string()).await?;
    }

    let _resolver = get_content_resolver().ok_or_else(|| {
        "content:// is only supported on Android; set a content resolver (e.g. copy content URI to dest path) or resolve to file:// first.".to_string()
    })?;

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
