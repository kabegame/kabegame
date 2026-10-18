//! 页面 VFS 文件系统命令（全平台）。
//!
//! 桌面端服务于 WebView 爬虫窗口（`crawler-*`）与畅游窗口；安卓端只有畅游窗口，但注入脚本
//! （`media_download.js` 的 `blob:` / MSE 分块写与合流）与桌面共用同一套命令，故整个模块不再按
//! 平台裁剪。部分实现取自并改编自 tauri-plugin-fs 2.4.4（Apache-2.0 OR MIT）。
//! 原始版权：Copyright 2019-2023 Tauri Programme within The Commons Conservancy；
//! Copyright 2018-2023 the Deno authors.
use deno_fs::{FileSystem, OpenOptions};
use deno_permissions::CheckedPathBuf;
use kabegame_core::crawler::task_scheduler::Task;
use kabegame_core::crawler::webview::task_id_from_crawler_label;
use kabegame_core::crawler::TaskScheduler;
use kabegame_core::plugin::{ffmpeg::FfmpegProbeResult, vfs::PluginVfs};
use serde::Deserialize;
use serde::Serialize;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex as StdMutex};
use tauri::{Manager, Resource, ResourceId, Runtime, Webview};

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CrawlFsWriteOptions {
    pub append: Option<bool>,
    pub create: Option<bool>,
    pub create_new: Option<bool>,
    pub mode: Option<u32>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CrawlFsOpenOptions {
    pub read: Option<bool>,
    pub write: Option<bool>,
    pub append: Option<bool>,
    pub truncate: Option<bool>,
    pub create: Option<bool>,
    pub create_new: Option<bool>,
    pub mode: Option<u32>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CrawlFsMkdirOptions {
    pub recursive: Option<bool>,
    pub mode: Option<u32>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CrawlFsRemoveOptions {
    pub recursive: Option<bool>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CrawlFsDirEntry {
    pub name: String,
    pub is_file: bool,
    pub is_directory: bool,
    pub is_symlink: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CrawlFsStat {
    pub is_file: bool,
    pub is_directory: bool,
    pub is_symlink: bool,
    pub size: u64,
    pub mtime: Option<u64>,
    pub atime: Option<u64>,
    pub birthtime: Option<u64>,
    pub ctime: Option<u64>,
    pub dev: u64,
    pub ino: Option<u64>,
    pub mode: u32,
    pub nlink: Option<u64>,
    pub uid: u32,
    pub gid: u32,
    pub rdev: u64,
    pub blksize: u64,
    pub blocks: Option<u64>,
    pub is_block_device: bool,
    pub is_char_device: bool,
    pub is_fifo: bool,
    pub is_socket: bool,
}

struct CrawlFsFileResource(StdMutex<std::fs::File>);

impl CrawlFsFileResource {
    fn new(file: std::fs::File) -> Self {
        Self(StdMutex::new(file))
    }
}

impl Resource for CrawlFsFileResource {}

pub(crate) fn run_of_label(label: &str) -> Result<(String, Arc<Task>), String> {
    let task_id = task_id_from_crawler_label(label)
        .ok_or_else(|| format!("Invalid crawler window label: {}", label))?
        .to_string();
    let run = TaskScheduler::global()
        .get_run(&task_id)
        .ok_or_else(|| format!("Crawler task not found for task {}", task_id))?;
    Ok((task_id, run))
}

pub(crate) fn vfs_of_label(label: &str) -> Result<Arc<PluginVfs>, String> {
    if label.starts_with("crawler-") {
        // 安卓没有 WebView 爬虫窗口，这个分支永远匹配不到；保留是为了桌面与安卓共用同一份实现。
        return run_of_label(label).map(|(_, run)| Arc::clone(&run.vfs));
    }
    if let Some(host) = crate::commands::surf_common::host_from_surf_label(label) {
        return crate::commands::surf_session::get_or_create_session(&host)
            .map(|session| Arc::clone(&session.vfs));
    }
    Err(format!("Invalid fs window label: {label}"))
}

/// 安卓 Tauri 只有 postMessage IPC，到 Rust 都是 `InvokeBody::Json`。这里把三种形态统一还原为字节：
///
/// - `Raw`：桌面 raw body。
/// - `{ "base64": "..." }`：安卓 `media_download.js` 的分块写。直接传 `Uint8Array` 会被
///   `JSON.stringify` 成数字数组（约 3.6 倍体积），实测 1 MiB 一块往返要 1 s 以上；base64 只有 1.33 倍。
/// - JSON 数字数组：页面直接传 `Uint8Array` 时的兼容形态。
fn raw_body_bytes(body: &tauri::ipc::InvokeBody) -> Result<Vec<u8>, String> {
    match body {
        tauri::ipc::InvokeBody::Raw(data) => Ok(data.clone()),
        tauri::ipc::InvokeBody::Json(serde_json::Value::Array(items)) => items
            .iter()
            .map(|value| value.as_u64().filter(|byte| *byte <= 255).map(|byte| byte as u8))
            .collect::<Option<Vec<u8>>>()
            .ok_or_else(|| "Invalid byte array in IPC body".to_string()),
        tauri::ipc::InvokeBody::Json(serde_json::Value::Object(map)) => match map.get("base64") {
            Some(serde_json::Value::String(encoded)) => {
                use base64::Engine;
                base64::engine::general_purpose::STANDARD
                    .decode(encoded)
                    .map_err(|e| format!("Invalid base64 in IPC body: {e}"))
            }
            _ => Err("Expected raw IPC body".to_string()),
        },
        _ => Err("Expected raw IPC body".to_string()),
    }
}

async fn crawl_fs_blocking<T, F>(
    vfs: Arc<PluginVfs>,
    path: String,
    operation: &'static str,
    action: F,
) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(&PluginVfs, CheckedPathBuf) -> Result<T, deno_fs::FsError> + Send + 'static,
{
    tokio::task::spawn_blocking(move || {
        let checked_path = CheckedPathBuf::unsafe_new(PathBuf::from(&path));
        action(&vfs, checked_path).map_err(|error| format!("{operation} '{path}': {error}"))
    })
    .await
    .map_err(|error| format!("Failed to join {operation}: {error}"))?
}

async fn crawl_fs_file_blocking<R, T, F>(
    webview: &Webview<R>,
    rid: ResourceId,
    operation: &'static str,
    action: F,
) -> Result<T, String>
where
    R: Runtime,
    T: Send + 'static,
    F: FnOnce(&mut std::fs::File) -> std::io::Result<T> + Send + 'static,
{
    let resource = webview
        .resources_table()
        .get::<CrawlFsFileResource>(rid)
        .map_err(|error| format!("{operation} rid {rid}: {error}"))?;
    tokio::task::spawn_blocking(move || {
        let mut file = resource
            .0
            .lock()
            .map_err(|_| format!("{operation} rid {rid}: file lock poisoned"))?;
        action(&mut file).map_err(|error| format!("{operation} rid {rid}: {error}"))
    })
    .await
    .map_err(|error| format!("Failed to join {operation}: {error}"))?
}

fn crawl_fs_open_options(options: Option<CrawlFsOpenOptions>) -> OpenOptions {
    match options {
        Some(options) => OpenOptions {
            read: options.read.unwrap_or(true),
            write: options.write.unwrap_or(false),
            create: options.create.unwrap_or(false),
            truncate: options.truncate.unwrap_or(false),
            append: options.append.unwrap_or(false),
            create_new: options.create_new.unwrap_or(false),
            custom_flags: None,
            mode: options.mode,
        },
        None => OpenOptions::read(),
    }
}

fn crawl_fs_raw_handle_write_request(
    request: &tauri::ipc::Request<'_>,
) -> Result<(ResourceId, Vec<u8>), String> {
    let rid = request
        .headers()
        .get("rid")
        .ok_or_else(|| "Missing file resource id header".to_string())?
        .to_str()
        .map_err(|error| format!("Invalid file resource id header: {error}"))?
        .parse::<ResourceId>()
        .map_err(|error| format!("Invalid file resource id: {error}"))?;
    let data = raw_body_bytes(request.body())?;
    Ok((rid, data))
}

fn crawl_fs_raw_write_request(
    request: &tauri::ipc::Request<'_>,
) -> Result<(String, Vec<u8>, CrawlFsWriteOptions), String> {
    let encoded_path = request
        .headers()
        .get("path")
        .ok_or_else(|| "Missing file path header".to_string())?
        .to_str()
        .map_err(|error| format!("Invalid file path header: {error}"))?;
    let path = percent_encoding::percent_decode_str(encoded_path)
        .decode_utf8()
        .map_err(|_| "File path is not valid UTF-8".to_string())?
        .into_owned();
    let options = request
        .headers()
        .get("options")
        .map(|value| {
            value
                .to_str()
                .map_err(|error| format!("Invalid file options header: {error}"))
                .and_then(|value| {
                    serde_json::from_str(value)
                        .map_err(|error| format!("Invalid file options JSON: {error}"))
                })
        })
        .transpose()?
        .unwrap_or_default();
    let data = raw_body_bytes(request.body())?;
    Ok((path, data, options))
}

async fn crawl_fs_metadata(
    vfs: Arc<PluginVfs>,
    path: String,
    operation: &'static str,
    follow_symlinks: bool,
) -> Result<CrawlFsStat, String> {
    crawl_fs_blocking(vfs, path, operation, move |vfs, path| {
        let stat = if follow_symlinks {
            vfs.stat_sync(&path.as_checked_path())
        } else {
            vfs.lstat_sync(&path.as_checked_path())
        }?;
        Ok(CrawlFsStat {
            is_file: stat.is_file,
            is_directory: stat.is_directory,
            is_symlink: stat.is_symlink,
            size: stat.size,
            mtime: stat.mtime,
            atime: stat.atime,
            birthtime: stat.birthtime,
            ctime: stat.ctime,
            dev: stat.dev,
            ino: stat.ino,
            mode: stat.mode,
            nlink: stat.nlink,
            uid: stat.uid,
            gid: stat.gid,
            rdev: stat.rdev,
            blksize: stat.blksize,
            blocks: stat.blocks,
            is_block_device: stat.is_block_device,
            is_char_device: stat.is_char_device,
            is_fifo: stat.is_fifo,
            is_socket: stat.is_socket,
        })
    })
    .await
}

fn crawl_fs_stat_from_std(metadata: std::fs::Metadata) -> CrawlFsStat {
    macro_rules! unix_some_or_none {
        ($member:ident) => {{
            #[cfg(unix)]
            {
                use std::os::unix::fs::MetadataExt;
                Some(metadata.$member())
            }
            #[cfg(not(unix))]
            {
                None
            }
        }};
    }

    macro_rules! unix_or_zero {
        ($member:ident) => {{
            #[cfg(unix)]
            {
                use std::os::unix::fs::MetadataExt;
                metadata.$member()
            }
            #[cfg(not(unix))]
            {
                0
            }
        }};
    }

    macro_rules! unix_or_false {
        ($member:ident) => {{
            #[cfg(unix)]
            {
                use std::os::unix::fs::FileTypeExt;
                metadata.file_type().$member()
            }
            #[cfg(not(unix))]
            {
                false
            }
        }};
    }

    fn to_msec(time: std::io::Result<std::time::SystemTime>) -> Option<u64> {
        time.ok().map(|time| {
            time.duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_millis() as u64)
                .unwrap_or_else(|error| error.duration().as_millis() as u64)
        })
    }

    let ctime = unix_or_zero!(ctime);
    CrawlFsStat {
        is_file: metadata.is_file(),
        is_directory: metadata.is_dir(),
        is_symlink: metadata.file_type().is_symlink(),
        size: metadata.len(),
        mtime: to_msec(metadata.modified()),
        atime: to_msec(metadata.accessed()),
        birthtime: to_msec(metadata.created()),
        ctime: (ctime > 0).then_some(ctime as u64 * 1000),
        dev: unix_or_zero!(dev),
        ino: unix_some_or_none!(ino),
        mode: unix_or_zero!(mode),
        nlink: unix_some_or_none!(nlink),
        uid: unix_or_zero!(uid),
        gid: unix_or_zero!(gid),
        rdev: unix_or_zero!(rdev),
        blksize: unix_or_zero!(blksize),
        blocks: unix_some_or_none!(blocks),
        is_block_device: unix_or_false!(is_block_device),
        is_char_device: unix_or_false!(is_char_device),
        is_fifo: unix_or_false!(is_fifo),
        is_socket: unix_or_false!(is_socket),
    }
}

fn crawl_fs_size_sync(vfs: &PluginVfs, path: CheckedPathBuf) -> Result<u64, deno_fs::FsError> {
    let stat = vfs.stat_sync(&path.as_checked_path())?;
    if stat.is_file {
        return Ok(stat.size);
    }

    let mut size = 0u64;
    for entry in vfs.read_dir_sync(&path.as_checked_path())? {
        let child = CheckedPathBuf::unsafe_new(path.join(entry.name));
        size = size
            .checked_add(crawl_fs_size_sync(vfs, child)?)
            .ok_or_else(|| {
                std::io::Error::new(std::io::ErrorKind::InvalidData, "File size overflow")
            })?;
    }
    Ok(size)
}

#[tauri::command]
pub async fn crawl_fs_open<R: Runtime>(
    webview: Webview<R>,
    path: String,
    options: Option<CrawlFsOpenOptions>,
) -> Result<ResourceId, String> {
    let vfs = vfs_of_label(webview.label())?;
    let options = crawl_fs_open_options(options);
    let file = crawl_fs_blocking(vfs, path, "open", move |vfs, path| {
        vfs.open_std(&path, options)
    })
    .await?;
    Ok(webview
        .resources_table()
        .add(CrawlFsFileResource::new(file)))
}

#[tauri::command]
pub async fn crawl_fs_create<R: Runtime>(
    webview: Webview<R>,
    path: String,
) -> Result<ResourceId, String> {
    let vfs = vfs_of_label(webview.label())?;
    let options = OpenOptions {
        read: false,
        write: true,
        create: true,
        truncate: true,
        append: false,
        create_new: false,
        custom_flags: None,
        mode: None,
    };
    let file = crawl_fs_blocking(vfs, path, "create", move |vfs, path| {
        vfs.open_std(&path, options)
    })
    .await?;
    Ok(webview
        .resources_table()
        .add(CrawlFsFileResource::new(file)))
}

#[tauri::command]
pub async fn crawl_fs_fread<R: Runtime>(
    webview: Webview<R>,
    rid: ResourceId,
    len: usize,
) -> Result<tauri::ipc::Response, String> {
    let mut data = vec![0; len];
    let (mut data, nread) = crawl_fs_file_blocking(&webview, rid, "fread", move |file| {
        let nread = file.read(&mut data)?;
        Ok((data, nread))
    })
    .await?;

    // 与 tauri-plugin-fs 一致，把读取数作为 8 字节大端整数附在 Raw IPC 响应末尾。
    data.extend_from_slice(&(nread as u64).to_be_bytes());
    Ok(tauri::ipc::Response::new(data))
}

#[tauri::command]
pub async fn crawl_fs_fwrite<R: Runtime>(
    webview: Webview<R>,
    request: tauri::ipc::Request<'_>,
) -> Result<usize, String> {
    let (rid, data) = crawl_fs_raw_handle_write_request(&request)?;
    crawl_fs_file_blocking(&webview, rid, "fwrite", move |file| file.write(&data)).await
}

#[tauri::command]
pub async fn crawl_fs_fseek<R: Runtime>(
    webview: Webview<R>,
    rid: ResourceId,
    offset: i64,
    whence: u16,
) -> Result<u64, String> {
    let position = match whence {
        0 => SeekFrom::Start(
            u64::try_from(offset)
                .map_err(|_| "fseek from start requires a non-negative offset".to_string())?,
        ),
        1 => SeekFrom::Current(offset),
        2 => SeekFrom::End(offset),
        _ => return Err(format!("Invalid fseek whence: {whence}")),
    };
    crawl_fs_file_blocking(&webview, rid, "fseek", move |file| file.seek(position)).await
}

#[tauri::command]
pub async fn crawl_fs_fstat<R: Runtime>(
    webview: Webview<R>,
    rid: ResourceId,
) -> Result<CrawlFsStat, String> {
    crawl_fs_file_blocking(&webview, rid, "fstat", |file| {
        file.metadata().map(crawl_fs_stat_from_std)
    })
    .await
}

#[tauri::command]
pub async fn crawl_fs_ftruncate<R: Runtime>(
    webview: Webview<R>,
    rid: ResourceId,
    len: Option<u64>,
) -> Result<(), String> {
    crawl_fs_file_blocking(&webview, rid, "ftruncate", move |file| {
        file.set_len(len.unwrap_or(0))
    })
    .await
}

#[tauri::command]
pub fn crawl_fs_close<R: Runtime>(webview: Webview<R>, rid: ResourceId) -> Result<(), String> {
    let resource = webview
        .resources_table()
        .take::<CrawlFsFileResource>(rid)
        .map_err(|error| format!("close rid {rid}: {error}"))?;
    drop(resource);
    Ok(())
}

#[tauri::command]
pub async fn crawl_fs_read_file<R: Runtime>(
    webview: Webview<R>,
    path: String,
) -> Result<tauri::ipc::Response, String> {
    let vfs = vfs_of_label(webview.label())?;
    let bytes = crawl_fs_blocking(vfs, path, "readfile", |vfs, path| {
        vfs.read_file_sync(&path.as_checked_path(), OpenOptions::read())
            .map(|bytes| bytes.into_owned())
    })
    .await?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
pub async fn crawl_fs_read_text_file<R: Runtime>(
    webview: Webview<R>,
    path: String,
) -> Result<tauri::ipc::Response, String> {
    let vfs = vfs_of_label(webview.label())?;
    let text = crawl_fs_blocking(vfs, path, "readtextfile", |vfs, path| {
        vfs.read_text_file_lossy_sync(&path.as_checked_path())
            .map(|text| text.into_owned())
    })
    .await?;
    Ok(tauri::ipc::Response::new(text.into_bytes()))
}

#[tauri::command]
pub async fn crawl_fs_write_file<R: Runtime>(
    webview: Webview<R>,
    request: tauri::ipc::Request<'_>,
) -> Result<(), String> {
    let vfs = vfs_of_label(webview.label())?;
    let (path, data, options) = crawl_fs_raw_write_request(&request)?;
    let open_options = OpenOptions::write(
        options.create.unwrap_or(true),
        options.append.unwrap_or(false),
        options.create_new.unwrap_or(false),
        options.mode,
    );
    crawl_fs_blocking(vfs, path, "writefile", move |vfs, path| {
        vfs.write_file_sync(&path.as_checked_path(), open_options, &data)
    })
    .await
}

#[tauri::command]
pub async fn crawl_fs_write_text_file<R: Runtime>(
    webview: Webview<R>,
    request: tauri::ipc::Request<'_>,
) -> Result<(), String> {
    let vfs = vfs_of_label(webview.label())?;
    let (path, data, options) = crawl_fs_raw_write_request(&request)?;
    let open_options = OpenOptions::write(
        options.create.unwrap_or(true),
        options.append.unwrap_or(false),
        options.create_new.unwrap_or(false),
        options.mode,
    );
    crawl_fs_blocking(vfs, path, "writetextfile", move |vfs, path| {
        vfs.write_file_sync(&path.as_checked_path(), open_options, &data)
    })
    .await
}

#[tauri::command]
pub async fn crawl_fs_mkdir<R: Runtime>(
    webview: Webview<R>,
    path: String,
    options: Option<CrawlFsMkdirOptions>,
) -> Result<(), String> {
    let vfs = vfs_of_label(webview.label())?;
    let options = options.unwrap_or_default();
    let recursive = options.recursive.unwrap_or(false);
    let mode = Some(options.mode.unwrap_or(0o777) & 0o777);
    crawl_fs_blocking(vfs, path, "mkdir", move |vfs, path| {
        vfs.mkdir_sync(&path.as_checked_path(), recursive, mode)
    })
    .await
}

#[tauri::command]
pub async fn crawl_fs_read_dir<R: Runtime>(
    webview: Webview<R>,
    path: String,
) -> Result<Vec<CrawlFsDirEntry>, String> {
    let vfs = vfs_of_label(webview.label())?;
    crawl_fs_blocking(vfs, path, "readdir", |vfs, path| {
        vfs.read_dir_sync(&path.as_checked_path()).map(|entries| {
            entries
                .into_iter()
                .map(|entry| CrawlFsDirEntry {
                    name: entry.name,
                    is_file: entry.is_file,
                    is_directory: entry.is_directory,
                    is_symlink: entry.is_symlink,
                })
                .collect()
        })
    })
    .await
}

#[tauri::command]
pub async fn crawl_fs_remove<R: Runtime>(
    webview: Webview<R>,
    path: String,
    options: Option<CrawlFsRemoveOptions>,
) -> Result<(), String> {
    let vfs = vfs_of_label(webview.label())?;
    let recursive = options.unwrap_or_default().recursive.unwrap_or(false);
    crawl_fs_blocking(vfs, path, "remove", move |vfs, path| {
        vfs.remove_sync(&path.as_checked_path(), recursive)
    })
    .await
}

#[tauri::command]
pub async fn crawl_fs_stat<R: Runtime>(
    webview: Webview<R>,
    path: String,
) -> Result<CrawlFsStat, String> {
    let vfs = vfs_of_label(webview.label())?;
    crawl_fs_metadata(vfs, path, "stat", true).await
}

#[tauri::command]
pub async fn crawl_fs_lstat<R: Runtime>(
    webview: Webview<R>,
    path: String,
) -> Result<CrawlFsStat, String> {
    let vfs = vfs_of_label(webview.label())?;
    crawl_fs_metadata(vfs, path, "lstat", false).await
}

#[tauri::command]
pub async fn crawl_fs_rename<R: Runtime>(
    webview: Webview<R>,
    old_path: String,
    new_path: String,
) -> Result<(), String> {
    let vfs = vfs_of_label(webview.label())?;
    crawl_fs_blocking(vfs, old_path, "rename", move |vfs, old_path| {
        let new_path = CheckedPathBuf::unsafe_new(PathBuf::from(new_path));
        vfs.rename_sync(&old_path.as_checked_path(), &new_path.as_checked_path())
    })
    .await
}

#[tauri::command]
pub async fn crawl_fs_copy_file<R: Runtime>(
    webview: Webview<R>,
    from_path: String,
    to_path: String,
) -> Result<(), String> {
    let vfs = vfs_of_label(webview.label())?;
    crawl_fs_blocking(vfs, from_path, "copyfile", move |vfs, from_path| {
        let to_path = CheckedPathBuf::unsafe_new(PathBuf::from(to_path));
        vfs.copy_file_sync(&from_path.as_checked_path(), &to_path.as_checked_path())
    })
    .await
}

#[tauri::command]
pub async fn crawl_fs_exists<R: Runtime>(
    webview: Webview<R>,
    path: String,
) -> Result<bool, String> {
    let vfs = vfs_of_label(webview.label())?;
    crawl_fs_blocking(vfs, path, "exists", |vfs, path| {
        Ok(vfs.exists_sync(&path.as_checked_path()))
    })
    .await
}

#[tauri::command]
pub async fn crawl_fs_truncate<R: Runtime>(
    webview: Webview<R>,
    path: String,
    len: Option<u64>,
) -> Result<(), String> {
    let vfs = vfs_of_label(webview.label())?;
    crawl_fs_blocking(vfs, path, "truncate", move |vfs, path| {
        vfs.truncate_sync(&path.as_checked_path(), len.unwrap_or(0))
    })
    .await
}

#[tauri::command]
pub async fn crawl_fs_size<R: Runtime>(webview: Webview<R>, path: String) -> Result<u64, String> {
    let vfs = vfs_of_label(webview.label())?;
    crawl_fs_blocking(vfs, path, "size", crawl_fs_size_sync).await
}

#[tauri::command]
pub async fn crawl_fs_get_root<R: Runtime>(webview: Webview<R>) -> Result<String, String> {
    let vfs = vfs_of_label(webview.label())?;
    tokio::task::spawn_blocking(move || {
        vfs.cwd()
            .map(|path| path.to_string_lossy().into_owned())
            .map_err(|error| format!("getroot: {error}"))
    })
    .await
    .map_err(|error| format!("Failed to join getroot: {error}"))?
}

#[tauri::command]
pub async fn crawl_ffmpeg_mux<R: Runtime>(
    webview: Webview<R>,
    inputs: Vec<String>,
    output: String,
) -> Result<(), String> {
    let vfs = vfs_of_label(webview.label())?;
    tokio::task::spawn_blocking(move || {
        kabegame_core::plugin::ffmpeg::mux_streams_sync(&vfs, &inputs, &output)
    })
    .await
    .map_err(|error| format!("音视频合流任务执行失败：{error}"))?
}

#[tauri::command]
pub async fn crawl_ffmpeg_probe<R: Runtime>(
    webview: Webview<R>,
    path: String,
) -> Result<Option<FfmpegProbeResult>, String> {
    let vfs = vfs_of_label(webview.label())?;
    tokio::task::spawn_blocking(move || kabegame_core::plugin::ffmpeg::probe_sync(&vfs, &path))
        .await
        .map_err(|error| format!("媒体探测任务执行失败：{error}"))?
}

#[cfg(test)]
mod tests {
    use super::raw_body_bytes;

    #[test]
    fn raw_body_accepts_raw_bytes() {
        let body = tauri::ipc::InvokeBody::Raw(vec![1, 2, 3]);
        assert_eq!(raw_body_bytes(&body).unwrap(), vec![1, 2, 3]);
    }

    #[test]
    fn raw_body_accepts_json_byte_array() {
        let body = tauri::ipc::InvokeBody::Json(serde_json::json!([0, 128, 255]));
        assert_eq!(raw_body_bytes(&body).unwrap(), vec![0, 128, 255]);
    }

    #[test]
    fn raw_body_accepts_base64_object() {
        let body = tauri::ipc::InvokeBody::Json(serde_json::json!({ "base64": "AID/" }));
        assert_eq!(raw_body_bytes(&body).unwrap(), vec![0, 128, 255]);
        let invalid = tauri::ipc::InvokeBody::Json(serde_json::json!({ "base64": "@@" }));
        assert!(raw_body_bytes(&invalid).is_err());
    }

    #[test]
    fn raw_body_rejects_out_of_range_and_non_array() {
        let out_of_range = tauri::ipc::InvokeBody::Json(serde_json::json!([256]));
        assert!(raw_body_bytes(&out_of_range).is_err());
        let negative = tauri::ipc::InvokeBody::Json(serde_json::json!([-1]));
        assert!(raw_body_bytes(&negative).is_err());
        let not_array = tauri::ipc::InvokeBody::Json(serde_json::json!({ "a": 1 }));
        assert!(raw_body_bytes(&not_array).is_err());
    }
}
