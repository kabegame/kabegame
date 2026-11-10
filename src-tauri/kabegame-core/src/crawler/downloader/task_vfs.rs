//! task-vfs:// 下载实现：从运行中任务的 PluginVfs 流式读取文件。
//!
//! `downloadImage(path, { relocate: true })` 不走流式读取：[`resolve_relocate_source`] 把 VFS 路径
//! 解析成宿主路径，下载 worker 直接把那个文件或目录交给后处理移走。

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

/// `relocate` 下载的源：把 `task-vfs://` URL 解析成宿主路径（文件或目录）。
///
/// 要求写权限，所以只读的 `input` 挂载移不走；挂载根本身（`/{handle}/tmp` 等）也不行。
/// 源自身或目录里带符号链接一律拒绝：移出 VFS 之后就没有 VFS 的越界校验了。
///
/// 阻塞函数（要遍历目录），异步上下文里放进 `spawn_blocking`。
pub(super) fn resolve_relocate_source(url: &Url) -> Result<PathBuf, String> {
    let handle = parse_handle(url).map_err(DownloadAttemptError::into_message)?;
    let run = TaskScheduler::global()
        .get_run_by_handle(handle)
        .ok_or_else(|| format!("Task VFS handle is no longer active: {handle}"))?;
    relocate_source_in(&run.vfs, handle, url)
}

fn relocate_source_in(vfs: &PluginVfs, handle: u64, url: &Url) -> Result<PathBuf, String> {
    let decoded_path = decoded_url_path(url).map_err(DownloadAttemptError::into_message)?;
    let mut depth = 0usize;
    for component in Path::new(decoded_path.as_ref()).components() {
        match component {
            std::path::Component::RootDir => {}
            std::path::Component::Normal(_) => depth += 1,
            _ => return Err("Task VFS path to relocate must not contain `.` or `..`".to_string()),
        }
    }
    if depth < 2 {
        return Err("Task VFS mount roots cannot be relocated".to_string());
    }
    let virtual_path = PathBuf::from(format!("/{handle}{decoded_path}"));
    let host_path = vfs
        .host_path_for_write(&virtual_path)
        .map_err(|error| format!("Task VFS path cannot be relocated: {error}"))?;
    reject_symlinks(&host_path)?;
    Ok(host_path)
}

/// `path` 自身是符号链接、或它（作为目录）里面任何一层有符号链接时报错。
fn reject_symlinks(path: &Path) -> Result<(), String> {
    let mut pending = vec![path.to_path_buf()];
    while let Some(current) = pending.pop() {
        let metadata = std::fs::symlink_metadata(&current)
            .map_err(|error| format!("Failed to read task VFS path: {error}"))?;
        if metadata.file_type().is_symlink() {
            return Err("Task VFS path to relocate must not contain symbolic links".to_string());
        }
        if metadata.is_dir() {
            let entries = std::fs::read_dir(&current)
                .map_err(|error| format!("Failed to read task VFS directory: {error}"))?;
            for entry in entries {
                let entry =
                    entry.map_err(|error| format!("Failed to read task VFS directory: {error}"))?;
                pending.push(entry.path());
            }
        }
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
    use crate::plugin::vfs::{InputKind, InputMount};
    use std::sync::Arc;

    const HANDLE: u64 = 7_654_321;

    fn init_paths() {
        AppPaths::init_for_tests();
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

    #[tokio::test]
    async fn downloads_from_read_only_input_mount() {
        init_paths();
        let plugin_id = format!("task-vfs-input-{}", std::process::id());
        let source_dir = std::env::temp_dir().join(format!(
            "kabegame-task-vfs-input-{}-{}",
            std::process::id(),
            HANDLE
        ));
        std::fs::create_dir_all(&source_dir).unwrap();
        let source = source_dir.join("a.png");
        std::fs::write(&source, b"input-image").unwrap();
        let vfs = Arc::new(test_vfs(&plugin_id).with_inputs(vec![InputMount {
            key: "src".to_string(),
            kind: InputKind::File {
                host: source.clone(),
                name: "a.png".to_string(),
            },
            #[cfg(target_os = "android")]
            owned_fd: None,
        }]));
        let url = Url::parse(&format!("task-vfs://{HANDLE}/input/src/a.png")).unwrap();
        let output_dir = std::env::temp_dir().join(format!(
            "kabegame-task-vfs-input-output-{}",
            std::process::id()
        ));
        let mut writer = SpillWriter::new_in(5, output_dir);

        download_from_vfs(Arc::clone(&vfs), HANDLE, &url, &mut writer)
            .await
            .expect("read input mount file");
        assert_eq!(writer.total, Some(11));
        match writer.finalize().await.unwrap() {
            DownloadOutcome::Bytes(bytes) => assert_eq!(bytes, b"input-image"),
            DownloadOutcome::Path(_) => panic!("small input file should stay in memory"),
        }
        // 下载只读不会改动用户源文件。
        assert_eq!(std::fs::read(&source).unwrap(), b"input-image");
        let _ = std::fs::remove_file(&source);
    }

    #[test]
    fn relocate_source_resolves_writable_files_and_directories() {
        init_paths();
        let plugin_id = format!("task-vfs-relocate-{}", std::process::id());
        let vfs = test_vfs(&plugin_id);
        let tmp_root = AppPaths::global().plugin_temp_dir(&plugin_id).unwrap();
        std::fs::create_dir_all(tmp_root.join("wpe/wall")).unwrap();
        std::fs::write(tmp_root.join("wpe/wall/project.json"), b"{}").unwrap();
        std::fs::write(tmp_root.join("a.png"), b"png").unwrap();

        let file = Url::parse(&format!("task-vfs://{HANDLE}/tmp/a.png")).unwrap();
        assert_eq!(
            relocate_source_in(&vfs, HANDLE, &file).unwrap(),
            tmp_root.join("a.png")
        );
        let dir = Url::parse(&format!("task-vfs://{HANDLE}/tmp/wpe/wall")).unwrap();
        assert_eq!(
            relocate_source_in(&vfs, HANDLE, &dir).unwrap(),
            tmp_root.join("wpe/wall")
        );

        // 挂载根、越界与不存在的路径都移不走
        for raw in [
            format!("task-vfs://{HANDLE}/tmp"),
            format!("task-vfs://{HANDLE}/tmp/wpe/%2e%2e"),
            format!("task-vfs://{HANDLE}/tmp/missing.png"),
            format!("task-vfs://{}/tmp/a.png", HANDLE + 1),
        ] {
            let url = Url::parse(&raw).unwrap();
            let handle = parse_handle(&url).unwrap();
            assert!(relocate_source_in(&vfs, handle, &url).is_err(), "{raw}");
        }
        let _ = std::fs::remove_dir_all(tmp_root);
    }

    #[test]
    fn relocate_source_rejects_read_only_input_mount() {
        init_paths();
        let plugin_id = format!("task-vfs-relocate-input-{}", std::process::id());
        let source_dir = std::env::temp_dir().join(format!(
            "kabegame-task-vfs-relocate-input-{}-{}",
            std::process::id(),
            HANDLE
        ));
        std::fs::create_dir_all(&source_dir).unwrap();
        let source = source_dir.join("a.png");
        std::fs::write(&source, b"input-image").unwrap();
        let vfs = test_vfs(&plugin_id).with_inputs(vec![InputMount {
            key: "src".to_string(),
            kind: InputKind::File {
                host: source.clone(),
                name: "a.png".to_string(),
            },
            #[cfg(target_os = "android")]
            owned_fd: None,
        }]);
        let url = Url::parse(&format!("task-vfs://{HANDLE}/input/src/a.png")).unwrap();

        let error = relocate_source_in(&vfs, HANDLE, &url).unwrap_err();
        assert!(error.contains("cannot be relocated"), "{error}");
        assert_eq!(std::fs::read(&source).unwrap(), b"input-image");
        let _ = std::fs::remove_dir_all(source_dir);
    }

    #[cfg(unix)]
    #[test]
    fn relocate_source_rejects_symlinks_inside_directory() {
        init_paths();
        let plugin_id = format!("task-vfs-relocate-link-{}", std::process::id());
        let vfs = test_vfs(&plugin_id);
        let tmp_root = AppPaths::global().plugin_temp_dir(&plugin_id).unwrap();
        std::fs::create_dir_all(tmp_root.join("wall/sub")).unwrap();
        std::fs::write(tmp_root.join("wall/project.json"), b"{}").unwrap();
        std::os::unix::fs::symlink(
            tmp_root.join("wall/project.json"),
            tmp_root.join("wall/sub/link.json"),
        )
        .unwrap();

        let url = Url::parse(&format!("task-vfs://{HANDLE}/tmp/wall")).unwrap();
        let error = relocate_source_in(&vfs, HANDLE, &url).unwrap_err();
        assert!(error.contains("symbolic links"), "{error}");
        let _ = std::fs::remove_dir_all(tmp_root);
    }
}
