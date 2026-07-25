//! task-vfs:// 下载实现：从运行中任务的 PluginVfs 流式读取文件。

use async_trait::async_trait;
use deno_fs::OpenOptions;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use url::Url;

use super::{DownloadAttemptError, DownloadWriter, SchemeDownloader};
use crate::crawler::TaskScheduler;
use crate::plugin::vfs::PluginVfs;

pub struct TaskVfsSchemeDownloader;

#[async_trait]
impl SchemeDownloader for TaskVfsSchemeDownloader {
    async fn download(
        &self,
        url: &Url,
        _headers: &HashMap<String, String>,
        out: &mut dyn DownloadWriter,
        _already_received: u64,
    ) -> Result<(), DownloadAttemptError> {
        let handle = parse_handle(url)?;
        let run = TaskScheduler::global()
            .get_run_by_handle(handle)
            .ok_or_else(|| {
                DownloadAttemptError::fatal(format!(
                    "Task VFS handle is no longer active: {handle}"
                ))
            })?;

        download_from_vfs(Arc::clone(&run.vfs), handle, url, out).await
    }

    async fn display_name(&self, url: &Url, _final_local_path: &str) -> String {
        decoded_url_path(url)
            .ok()
            .and_then(|path| {
                Path::new(path.as_ref())
                    .file_name()
                    .and_then(|name| name.to_str())
                    .map(str::to_owned)
            })
            .unwrap_or_else(|| "image".to_string())
    }
}

fn parse_handle(url: &Url) -> Result<u64, DownloadAttemptError> {
    url.host_str()
        .and_then(|value| value.parse::<u64>().ok())
        .ok_or_else(|| DownloadAttemptError::fatal("Invalid task-vfs handle"))
}

fn decoded_url_path(url: &Url) -> Result<std::borrow::Cow<'_, str>, DownloadAttemptError> {
    urlencoding::decode(url.path()).map_err(|error| {
        DownloadAttemptError::fatal(format!("Invalid task-vfs path encoding: {error}"))
    })
}

async fn download_from_vfs(
    vfs: Arc<PluginVfs>,
    handle: u64,
    url: &Url,
    out: &mut dyn DownloadWriter,
) -> Result<(), DownloadAttemptError> {
    let decoded_path = decoded_url_path(url)?;
    let virtual_path = PathBuf::from(format!("/{handle}{decoded_path}"));
    // 先在 blocking 池完成 VFS 权限/软链校验并打开 std File，再交给 Tokio 分块读取。
    let (file, total) = tokio::task::spawn_blocking(move || {
        let file = vfs.open_std(&virtual_path, OpenOptions::read())?;
        let total = file.metadata()?.len();
        Ok::<_, deno_fs::FsError>((file, total))
    })
    .await
    .map_err(|error| DownloadAttemptError::fatal(format!("Failed to join task VFS read: {error}")))?
    .map_err(|error| {
        DownloadAttemptError::fatal(format!("Failed to read task VFS file: {error}"))
    })?;

    out.set_total(Some(total));
    let mut file = tokio::fs::File::from_std(file);
    let mut buffer = vec![0u8; 1024 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .await
            .map_err(|error| DownloadAttemptError::fatal(format!("read task VFS file: {error}")))?;
        if read == 0 {
            break;
        }
        out.write_all(&buffer[..read]).await.map_err(|error| {
            DownloadAttemptError::fatal(format!("write download buffer: {error}"))
        })?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_paths::AppPaths;
    use crate::crawler::downloader::{
        DownloadErrorKind, DownloadOutcome, SpillWriter, DOWNLOAD_SPILL_THRESHOLD,
    };
    use crate::crawler::{DownloadQueue, TaskScheduler};
    use std::sync::Arc;

    const HANDLE: u64 = 7_654_321;

    fn init_paths() {
        let root =
            std::env::temp_dir().join(format!("kabegame-task-vfs-tests-{}", std::process::id()));
        let _ = AppPaths::init(AppPaths {
            data_dir: root.join("data"),
            cache_dir: root.join("cache"),
            temp_dir: root.join("tmp"),
            resource_dir: root.join("resources"),
            exe_dir: None,
            external_data_dir: None,
            pictures_dir: Some(root.join("pictures")),
            compatibles_dir_path: root.join("compatibles"),
        });
    }

    fn test_vfs(plugin_id: &str) -> PluginVfs {
        init_paths();
        PluginVfs::new(HANDLE, plugin_id).expect("create test VFS")
    }

    #[tokio::test]
    async fn reads_bytes_through_plugin_vfs() {
        init_paths();
        let plugin_id = format!("task-vfs-read-{}", std::process::id());
        let data_root = AppPaths::global().plugin_data_dir(&plugin_id).unwrap();
        std::fs::create_dir_all(&data_root).unwrap();
        std::fs::write(data_root.join("x.jpg"), b"vfs-image").unwrap();
        let vfs = Arc::new(test_vfs(&plugin_id));
        let url = Url::parse(&format!("task-vfs://{HANDLE}/data/x.jpg")).unwrap();
        let output_dir =
            std::env::temp_dir().join(format!("kabegame-task-vfs-output-{}", std::process::id()));
        let mut writer = SpillWriter::new_in(1, output_dir);

        download_from_vfs(vfs, HANDLE, &url, &mut writer)
            .await
            .expect("read task VFS file");
        assert_eq!(writer.total, Some(9));
        match writer.finalize().await.unwrap() {
            DownloadOutcome::Bytes(bytes) => assert_eq!(bytes, b"vfs-image"),
            DownloadOutcome::Path(_) => panic!("small VFS file should stay in memory"),
        }
    }

    #[tokio::test]
    async fn spills_large_vfs_file_to_path() {
        init_paths();
        let plugin_id = format!("task-vfs-spill-{}", std::process::id());
        let data_root = AppPaths::global().plugin_data_dir(&plugin_id).unwrap();
        std::fs::create_dir_all(&data_root).unwrap();
        let expected_len = DOWNLOAD_SPILL_THRESHOLD + 1;
        std::fs::write(data_root.join("large.mp4"), vec![0x5a; expected_len]).unwrap();
        let vfs = Arc::new(test_vfs(&plugin_id));
        let url = Url::parse(&format!("task-vfs://{HANDLE}/data/large.mp4")).unwrap();
        let output_dir =
            std::env::temp_dir().join(format!("kabegame-task-vfs-spill-{}", std::process::id()));
        let mut writer = SpillWriter::new_in(4, output_dir);

        download_from_vfs(vfs, HANDLE, &url, &mut writer)
            .await
            .expect("stream task VFS file");
        assert_eq!(writer.total, Some(expected_len as u64));
        match writer.finalize().await.unwrap() {
            DownloadOutcome::Path(path) => {
                assert_eq!(std::fs::metadata(&path).unwrap().len(), expected_len as u64);
                let _ = std::fs::remove_file(path);
            }
            DownloadOutcome::Bytes(_) => panic!("large VFS file should spill to disk"),
        }
    }

    #[tokio::test]
    async fn rejects_another_handle_and_parent_escape_through_vfs() {
        let vfs = Arc::new(test_vfs(&format!(
            "task-vfs-boundary-{}",
            std::process::id()
        )));
        for raw_url in [
            format!("task-vfs://{}/data/x.jpg", HANDLE + 1),
            format!("task-vfs://{HANDLE}/data/%2e%2e/%2e%2e/x"),
        ] {
            let url = Url::parse(&raw_url).unwrap();
            let handle = parse_handle(&url).unwrap();
            let output_dir = std::env::temp_dir()
                .join(format!("kabegame-task-vfs-rejected-{}", std::process::id()));
            let mut writer = SpillWriter::new_in(2, output_dir);
            let error = download_from_vfs(Arc::clone(&vfs), handle, &url, &mut writer)
                .await
                .expect_err("unsafe VFS path must be rejected");
            assert_eq!(error.kind, DownloadErrorKind::Fatal, "{raw_url}");
        }
    }

    #[tokio::test]
    async fn missing_handle_is_fatal() {
        let _ = TaskScheduler::init_global(Arc::new(DownloadQueue::new()));
        let url = Url::parse("task-vfs://18446744073709551615/data/x.jpg").unwrap();
        let output_dir =
            std::env::temp_dir().join(format!("kabegame-task-vfs-missing-{}", std::process::id()));
        let mut writer = SpillWriter::new_in(3, output_dir);
        let error = TaskVfsSchemeDownloader
            .download(&url, &HashMap::new(), &mut writer, 0)
            .await
            .expect_err("finished task handle must fail");

        assert_eq!(error.kind, DownloadErrorKind::Fatal);
        assert!(!error.is_retryable());
    }
}
