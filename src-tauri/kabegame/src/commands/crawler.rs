// 部分文件系统命令实现取自并改编自 tauri-plugin-fs 2.4.4（Apache-2.0 OR MIT）。
// 原始版权：Copyright 2019-2023 Tauri Programme within The Commons Conservancy；
// Copyright 2018-2023 the Deno authors.
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64_STANDARD};
use deno_fs::{FileSystem, OpenOptions};
use deno_permissions::CheckedPathBuf;
use kabegame_core::crawler::TaskScheduler;
use kabegame_core::crawler::downloader::{
    ActiveDownloadInfo, DownloadState, PostprocessSource, build_safe_filename,
    build_safe_filename_no_ext, compute_unique_download_path_with_name, media_upload,
    next_download_id, postprocess_downloaded_image, unique_path,
};
use kabegame_core::crawler::task_scheduler::{PageStackEntry, Task, TaskError};
use kabegame_core::crawler::webview::{crawler_window_label, task_id_from_crawler_label};
use kabegame_core::emitter::GlobalEmitter;
use kabegame_core::plugin::vfs::PluginVfs;
use kabegame_core::storage::Storage;
use serde::Deserialize;
use serde::Serialize;
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager, Resource, ResourceId, Runtime, Webview, WebviewWindow};
use url::Url;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CrawlToPayload {
    pub url: String,
    pub page_label: Option<String>,
    pub page_state: Option<Value>,
}

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

struct CrawlFsFileResource(Mutex<std::fs::File>);

impl CrawlFsFileResource {
    fn new(file: std::fs::File) -> Self {
        Self(Mutex::new(file))
    }
}

impl Resource for CrawlFsFileResource {}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// `plugin_version` 为写入时运行插件的 packed 版本（应用维护，插件不可传入）。
fn insert_metadata(
    plugin_id: &str,
    metadata: Option<Value>,
    plugin_version: u32,
) -> Result<Option<i64>, String> {
    if let Some(value) = metadata {
        Ok(Some(Storage::global().insert_image_metadata_row(
            &value,
            plugin_id,
            plugin_version,
        )?))
    } else {
        Ok(None)
    }
}

fn media_upload_ext(mime: &str) -> String {
    let base_mime = mime.split(';').next().unwrap_or("").trim().to_lowercase();
    kabegame_core::image_type::ext_from_mime(&base_mime)
        .unwrap_or_else(|| kabegame_core::image_type::default_image_extension().to_string())
}

fn compute_media_upload_path(
    images_dir: &std::path::Path,
    source_url: &Url,
    mime: &str,
    name: Option<&str>,
) -> Result<PathBuf, String> {
    let ext = media_upload_ext(mime);
    compute_unique_download_path_with_name(images_dir, source_url, Some(&ext), name)
}

fn compute_media_upload_paths(
    images_dir: &std::path::Path,
    source_url: &Url,
    streams: &[MediaStreamInit],
    name: Option<&str>,
) -> Result<Vec<(PathBuf, String)>, String> {
    if streams.is_empty() {
        return Err("Media upload requires at least one stream".to_string());
    }
    if streams.len() == 1 {
        let mime = streams[0].mime.clone().unwrap_or_default();
        return Ok(vec![(
            compute_media_upload_path(images_dir, source_url, &mime, name)?,
            mime,
        )]);
    }

    let base_name = name
        .filter(|value| !value.trim().is_empty())
        .map(build_safe_filename_no_ext)
        .unwrap_or_else(|| "media".to_string());
    streams
        .iter()
        .enumerate()
        .map(|(idx, stream)| {
            let mime = stream.mime.clone().unwrap_or_default();
            let ext = media_upload_ext(&mime);
            let filename = build_safe_filename(&format!("{base_name}-{idx}.{ext}"), &ext);
            Ok((unique_path(images_dir, &filename), mime))
        })
        .collect()
}

fn surf_download_name_from_url(url: &Url) -> Option<String> {
    if matches!(url.scheme(), "blob" | "data") {
        return None;
    }
    url.path_segments()
        .and_then(|segments| segments.filter(|segment| !segment.trim().is_empty()).last())
        .map(str::trim)
        .filter(|segment| !segment.is_empty())
        .map(ToOwned::to_owned)
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaStreamInit {
    pub mime: Option<String>,
    pub total_bytes: Option<u64>,
}

#[derive(Debug)]
struct MediaReceiveCtx {
    images_dir: PathBuf,
    plugin_id: String,
    /// 运行中插件的 packed 版本；surf 窗口（无插件语境）恒为 0。
    plugin_version: u32,
    task_id: String,
    surf_record_id: Option<String>,
    output_album_id: Option<String>,
    http_headers: HashMap<String, String>,
}

// surf 内容 webview 所在窗口含 navbar 子 webview,不是 WebviewWindow,
// 命令参数用 `Webview`(对 crawler 窗口同样适用),按 label 分流。
async fn media_ctx_from_label(
    label: &str,
    include_headers: bool,
) -> Result<MediaReceiveCtx, String> {
    if label.starts_with("crawler-") {
        let (task_id, run) = run_of_label(label)?;
        let merged_headers = if include_headers {
            let mut request_headers = HashMap::new();
            if let Some(page_url) = run.current_page_url().filter(|url| !url.trim().is_empty()) {
                request_headers.insert("Referer".to_string(), page_url);
            }
            merge_task_headers(&task_id, Some(request_headers), None)?
        } else {
            HashMap::new()
        };
        return Ok(MediaReceiveCtx {
            images_dir: run.params.images_dir.clone(),
            plugin_id: run.params.plugin.id.clone(),
            plugin_version: run.params.plugin_version(),
            task_id,
            surf_record_id: None,
            output_album_id: run.params.output_album_id.clone(),
            http_headers: merged_headers,
        });
    }

    if let Some(host) = surf_host_from_label(label) {
        let record = Storage::global()
            .get_surf_record_by_host(&host)?
            .ok_or_else(|| format!("Surf record not found for host: {host}"))?;
        return Ok(MediaReceiveCtx {
            images_dir: kabegame_core::crawler::downloader::get_default_images_dir(),
            plugin_id: host,
            plugin_version: 0,
            task_id: String::new(),
            surf_record_id: Some(record.id),
            output_album_id: None,
            http_headers: HashMap::new(),
        });
    }

    Err(format!("Invalid media receiver window label: {label}"))
}

fn active_download_matches_ctx(entry: &ActiveDownloadInfo, ctx: &MediaReceiveCtx) -> bool {
    if !ctx.task_id.is_empty() {
        entry.task_id == ctx.task_id
    } else {
        entry.task_id.is_empty()
            && entry.plugin_id == ctx.plugin_id
            && entry.surf_record_id == ctx.surf_record_id
    }
}

fn sum_stream_totals(streams: &[MediaStreamInit]) -> Result<Option<u64>, String> {
    let mut total = 0u64;
    for stream in streams {
        let Some(bytes) = stream.total_bytes else {
            return Ok(None);
        };
        total = total
            .checked_add(bytes)
            .ok_or_else(|| "Media upload total byte count overflow".to_string())?;
    }
    Ok(Some(total))
}

fn surf_host_from_label(label: &str) -> Option<String> {
    label
        .strip_prefix("surf-")
        .filter(|host| !host.is_empty())
        .map(|host| host.replace('_', "."))
}

/// 仅接受 plain object：是 Object 则克隆返回，否则返回空对象。
fn page_state_plain_object(value: Option<&Value>) -> Value {
    value
        .and_then(|v| v.as_object())
        .map(|m| Value::Object(m.clone()))
        .unwrap_or_else(|| Value::Object(Map::new()))
}

/// 将 patch 浅合并到当前 page_state（类似 JS 的 Object.assign）。
fn merge_page_state(current: Option<&Value>, patch: &Value) -> Value {
    let mut base = current
        .and_then(|v| v.as_object())
        .map(|m| m.clone())
        .unwrap_or_default();
    if let Some(patch_obj) = patch.as_object() {
        for (k, v) in patch_obj {
            base.insert(k.clone(), v.clone());
        }
    }
    Value::Object(base)
}

/// 与 page_state 同理：仅接受 plain object，合并到当前 state。
fn state_plain_object(value: Option<&Value>) -> Value {
    value
        .and_then(|v| v.as_object())
        .map(|m| Value::Object(m.clone()))
        .unwrap_or_else(|| Value::Object(Map::new()))
}

fn merge_state(current: Option<&Value>, patch: &Value) -> Value {
    let mut base = current
        .and_then(|v| v.as_object())
        .map(|m| m.clone())
        .unwrap_or_default();
    if let Some(patch_obj) = patch.as_object() {
        for (k, v) in patch_obj {
            base.insert(k.clone(), v.clone());
        }
    }
    Value::Object(base)
}

fn resolve_target_url(
    raw_url: &str,
    current_url: Option<&str>,
    base_url: &str,
) -> Result<String, String> {
    if let Ok(abs) = Url::parse(raw_url) {
        return Ok(abs.to_string());
    }

    let base = current_url
        .filter(|v| !v.trim().is_empty())
        .unwrap_or(base_url);
    let base = Url::parse(base).map_err(|e| format!("Invalid base URL: {}", e))?;
    let target = base
        .join(raw_url)
        .map_err(|e| format!("Failed to resolve URL: {}", e))?;
    Ok(target.to_string())
}

fn resolve_download_image_url(
    raw_url: &str,
    current_url: Option<&str>,
    base_url: &str,
    fs_handle: u64,
) -> Result<Url, String> {
    // 只认自己的 handle 前缀。不要把"首段是数字"当作 VFS 特征：WebView 后端会把
    // 相对 URL 解析到当前页面，而大量图站的图片就在 /12345/image.jpg 这类数字段路径
    // 下，那样会把合法的站内相对 URL 误判成 VFS 路径并报 Invalid URL。
    // 别的 handle 走正常的站内解析即可——它拿不到任何 VFS 访问，只是一次普通 HTTP 请求。
    let is_vfs_path = raw_url.starts_with(&format!("/{fs_handle}/"))
        || Url::parse(raw_url).is_ok_and(|url| url.scheme() == "task-vfs");
    if is_vfs_path {
        return kabegame_core::plugin::parse_download_image_url(raw_url, fs_handle);
    }

    let resolved = resolve_target_url(raw_url, current_url, base_url)?;
    kabegame_core::plugin::parse_download_image_url(&resolved, fs_handle)
}

fn get_page_stack(
    task_id: &str,
) -> Result<kabegame_core::crawler::task_scheduler::PageStack, String> {
    TaskScheduler::global()
        .page_stack(task_id)
        .ok_or_else(|| format!("Page stack not found for task {}", task_id))
}

fn run_of<R: Runtime>(webview: &WebviewWindow<R>) -> Result<(String, Arc<Task>), String> {
    run_of_label(webview.label())
}

fn run_of_label(label: &str) -> Result<(String, Arc<Task>), String> {
    let task_id = task_id_from_crawler_label(label)
        .ok_or_else(|| format!("Invalid crawler window label: {}", label))?
        .to_string();
    let run = TaskScheduler::global()
        .get_run(&task_id)
        .ok_or_else(|| format!("Crawler task not found for task {}", task_id))?;
    Ok((task_id, run))
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
    webview: &WebviewWindow<R>,
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
    let data = match request.body() {
        tauri::ipc::InvokeBody::Raw(data) => data.clone(),
        _ => return Err("Expected raw IPC body for file handle write".to_string()),
    };
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
    let data = match request.body() {
        tauri::ipc::InvokeBody::Raw(data) => data.clone(),
        _ => return Err("Expected raw IPC body for file write".to_string()),
    };
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

fn crawl_fs_size_sync(
    vfs: &PluginVfs,
    path: CheckedPathBuf,
) -> Result<u64, deno_fs::FsError> {
    let stat = vfs.stat_sync(&path.as_checked_path())?;
    if stat.is_file {
        return Ok(stat.size);
    }

    let mut size = 0u64;
    for entry in vfs.read_dir_sync(&path.as_checked_path())? {
        let child = CheckedPathBuf::unsafe_new(path.join(entry.name));
        size = size.checked_add(crawl_fs_size_sync(vfs, child)?).ok_or_else(|| {
            std::io::Error::new(std::io::ErrorKind::InvalidData, "File size overflow")
        })?;
    }
    Ok(size)
}

#[tauri::command]
pub async fn crawl_fs_open<R: Runtime>(
    webview: WebviewWindow<R>,
    path: String,
    options: Option<CrawlFsOpenOptions>,
) -> Result<ResourceId, String> {
    let (_, run) = run_of(&webview)?;
    let options = crawl_fs_open_options(options);
    let file = crawl_fs_blocking(run.vfs.clone(), path, "open", move |vfs, path| {
        vfs.open_std(&path, options)
    })
    .await?;
    Ok(webview
        .resources_table()
        .add(CrawlFsFileResource::new(file)))
}

#[tauri::command]
pub async fn crawl_fs_create<R: Runtime>(
    webview: WebviewWindow<R>,
    path: String,
) -> Result<ResourceId, String> {
    let (_, run) = run_of(&webview)?;
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
    let file = crawl_fs_blocking(run.vfs.clone(), path, "create", move |vfs, path| {
        vfs.open_std(&path, options)
    })
    .await?;
    Ok(webview
        .resources_table()
        .add(CrawlFsFileResource::new(file)))
}

#[tauri::command]
pub async fn crawl_fs_fread<R: Runtime>(
    webview: WebviewWindow<R>,
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
    webview: WebviewWindow<R>,
    request: tauri::ipc::Request<'_>,
) -> Result<usize, String> {
    let (rid, data) = crawl_fs_raw_handle_write_request(&request)?;
    crawl_fs_file_blocking(&webview, rid, "fwrite", move |file| file.write(&data)).await
}

#[tauri::command]
pub async fn crawl_fs_fseek<R: Runtime>(
    webview: WebviewWindow<R>,
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
    webview: WebviewWindow<R>,
    rid: ResourceId,
) -> Result<CrawlFsStat, String> {
    crawl_fs_file_blocking(&webview, rid, "fstat", |file| {
        file.metadata().map(crawl_fs_stat_from_std)
    })
    .await
}

#[tauri::command]
pub async fn crawl_fs_ftruncate<R: Runtime>(
    webview: WebviewWindow<R>,
    rid: ResourceId,
    len: Option<u64>,
) -> Result<(), String> {
    crawl_fs_file_blocking(&webview, rid, "ftruncate", move |file| {
        file.set_len(len.unwrap_or(0))
    })
    .await
}

#[tauri::command]
pub fn crawl_fs_close<R: Runtime>(
    webview: WebviewWindow<R>,
    rid: ResourceId,
) -> Result<(), String> {
    let resource = webview
        .resources_table()
        .take::<CrawlFsFileResource>(rid)
        .map_err(|error| format!("close rid {rid}: {error}"))?;
    drop(resource);
    Ok(())
}

#[tauri::command]
pub async fn crawl_fs_read_file<R: Runtime>(
    webview: WebviewWindow<R>,
    path: String,
) -> Result<tauri::ipc::Response, String> {
    let (_, run) = run_of(&webview)?;
    let bytes = crawl_fs_blocking(run.vfs.clone(), path, "readfile", |vfs, path| {
        vfs.read_file_sync(&path.as_checked_path(), OpenOptions::read())
            .map(|bytes| bytes.into_owned())
    })
    .await?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
pub async fn crawl_fs_read_text_file<R: Runtime>(
    webview: WebviewWindow<R>,
    path: String,
) -> Result<tauri::ipc::Response, String> {
    let (_, run) = run_of(&webview)?;
    let text = crawl_fs_blocking(run.vfs.clone(), path, "readtextfile", |vfs, path| {
        vfs.read_text_file_lossy_sync(&path.as_checked_path())
            .map(|text| text.into_owned())
    })
    .await?;
    Ok(tauri::ipc::Response::new(text.into_bytes()))
}

#[tauri::command]
pub async fn crawl_fs_write_file<R: Runtime>(
    webview: WebviewWindow<R>,
    request: tauri::ipc::Request<'_>,
) -> Result<(), String> {
    let (_, run) = run_of(&webview)?;
    let (path, data, options) = crawl_fs_raw_write_request(&request)?;
    let open_options = OpenOptions::write(
        options.create.unwrap_or(true),
        options.append.unwrap_or(false),
        options.create_new.unwrap_or(false),
        options.mode,
    );
    crawl_fs_blocking(run.vfs.clone(), path, "writefile", move |vfs, path| {
        vfs.write_file_sync(&path.as_checked_path(), open_options, &data)
    })
    .await
}

#[tauri::command]
pub async fn crawl_fs_write_text_file<R: Runtime>(
    webview: WebviewWindow<R>,
    request: tauri::ipc::Request<'_>,
) -> Result<(), String> {
    let (_, run) = run_of(&webview)?;
    let (path, data, options) = crawl_fs_raw_write_request(&request)?;
    let open_options = OpenOptions::write(
        options.create.unwrap_or(true),
        options.append.unwrap_or(false),
        options.create_new.unwrap_or(false),
        options.mode,
    );
    crawl_fs_blocking(run.vfs.clone(), path, "writetextfile", move |vfs, path| {
        vfs.write_file_sync(&path.as_checked_path(), open_options, &data)
    })
    .await
}

#[tauri::command]
pub async fn crawl_fs_mkdir<R: Runtime>(
    webview: WebviewWindow<R>,
    path: String,
    options: Option<CrawlFsMkdirOptions>,
) -> Result<(), String> {
    let (_, run) = run_of(&webview)?;
    let options = options.unwrap_or_default();
    let recursive = options.recursive.unwrap_or(false);
    let mode = Some(options.mode.unwrap_or(0o777) & 0o777);
    crawl_fs_blocking(run.vfs.clone(), path, "mkdir", move |vfs, path| {
        vfs.mkdir_sync(&path.as_checked_path(), recursive, mode)
    })
    .await
}

#[tauri::command]
pub async fn crawl_fs_read_dir<R: Runtime>(
    webview: WebviewWindow<R>,
    path: String,
) -> Result<Vec<CrawlFsDirEntry>, String> {
    let (_, run) = run_of(&webview)?;
    crawl_fs_blocking(run.vfs.clone(), path, "readdir", |vfs, path| {
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
    webview: WebviewWindow<R>,
    path: String,
    options: Option<CrawlFsRemoveOptions>,
) -> Result<(), String> {
    let (_, run) = run_of(&webview)?;
    let recursive = options.unwrap_or_default().recursive.unwrap_or(false);
    crawl_fs_blocking(run.vfs.clone(), path, "remove", move |vfs, path| {
        vfs.remove_sync(&path.as_checked_path(), recursive)
    })
    .await
}

#[tauri::command]
pub async fn crawl_fs_stat<R: Runtime>(
    webview: WebviewWindow<R>,
    path: String,
) -> Result<CrawlFsStat, String> {
    let (_, run) = run_of(&webview)?;
    crawl_fs_metadata(run.vfs.clone(), path, "stat", true).await
}

#[tauri::command]
pub async fn crawl_fs_lstat<R: Runtime>(
    webview: WebviewWindow<R>,
    path: String,
) -> Result<CrawlFsStat, String> {
    let (_, run) = run_of(&webview)?;
    crawl_fs_metadata(run.vfs.clone(), path, "lstat", false).await
}

#[tauri::command]
pub async fn crawl_fs_rename<R: Runtime>(
    webview: WebviewWindow<R>,
    old_path: String,
    new_path: String,
) -> Result<(), String> {
    let (_, run) = run_of(&webview)?;
    crawl_fs_blocking(run.vfs.clone(), old_path, "rename", move |vfs, old_path| {
        let new_path = CheckedPathBuf::unsafe_new(PathBuf::from(new_path));
        vfs.rename_sync(
            &old_path.as_checked_path(),
            &new_path.as_checked_path(),
        )
    })
    .await
}

#[tauri::command]
pub async fn crawl_fs_copy_file<R: Runtime>(
    webview: WebviewWindow<R>,
    from_path: String,
    to_path: String,
) -> Result<(), String> {
    let (_, run) = run_of(&webview)?;
    crawl_fs_blocking(run.vfs.clone(), from_path, "copyfile", move |vfs, from_path| {
        let to_path = CheckedPathBuf::unsafe_new(PathBuf::from(to_path));
        vfs.copy_file_sync(
            &from_path.as_checked_path(),
            &to_path.as_checked_path(),
        )
    })
    .await
}

#[tauri::command]
pub async fn crawl_fs_exists<R: Runtime>(
    webview: WebviewWindow<R>,
    path: String,
) -> Result<bool, String> {
    let (_, run) = run_of(&webview)?;
    crawl_fs_blocking(run.vfs.clone(), path, "exists", |vfs, path| {
        Ok(vfs.exists_sync(&path.as_checked_path()))
    })
    .await
}

#[tauri::command]
pub async fn crawl_fs_truncate<R: Runtime>(
    webview: WebviewWindow<R>,
    path: String,
    len: Option<u64>,
) -> Result<(), String> {
    let (_, run) = run_of(&webview)?;
    crawl_fs_blocking(run.vfs.clone(), path, "truncate", move |vfs, path| {
        vfs.truncate_sync(&path.as_checked_path(), len.unwrap_or(0))
    })
    .await
}

#[tauri::command]
pub async fn crawl_fs_size<R: Runtime>(
    webview: WebviewWindow<R>,
    path: String,
) -> Result<u64, String> {
    let (_, run) = run_of(&webview)?;
    crawl_fs_blocking(run.vfs.clone(), path, "size", crawl_fs_size_sync).await
}

#[tauri::command]
pub async fn crawl_fs_get_root<R: Runtime>(
    webview: WebviewWindow<R>,
) -> Result<String, String> {
    let (_, run) = run_of(&webview)?;
    let vfs = run.vfs.clone();
    tokio::task::spawn_blocking(move || {
        vfs.cwd()
            .map(|path| path.to_string_lossy().into_owned())
            .map_err(|error| format!("getroot: {error}"))
    })
    .await
    .map_err(|error| format!("Failed to join getroot: {error}"))?
}

fn merge_task_headers(
    task_id: &str,
    headers: Option<HashMap<String, String>>,
    cookie_header: Option<String>,
) -> Result<HashMap<String, String>, String> {
    TaskScheduler::global().merge_task_headers(task_id, headers, cookie_header)
}

/// 每页动态状态按需单独获取（不再一次性 crawl_get_context；crawl.js 与 vars 在
/// 建窗时已烘焙进 initialization_script）。
#[tauri::command]
pub async fn crawl_get_page_label<R: Runtime>(webview: WebviewWindow<R>) -> Result<String, String> {
    let (_, run) = run_of(&webview)?;
    Ok(run
        .with_stack_top(|entry| entry.page_label.clone())
        .unwrap_or_else(|| "initial".to_string()))
}

#[tauri::command]
pub async fn crawl_get_page_state<R: Runtime>(webview: WebviewWindow<R>) -> Result<Value, String> {
    let (_, run) = run_of(&webview)?;
    Ok(run
        .with_stack_top(|entry| page_state_plain_object(Some(&entry.page_state)))
        .unwrap_or_else(|| Value::Object(Map::new())))
}

#[tauri::command]
pub async fn crawl_get_state<R: Runtime>(webview: WebviewWindow<R>) -> Result<Value, String> {
    let (_, run) = run_of(&webview)?;
    Ok(state_plain_object(Some(&run.webview_state())))
}

/// 内部：按任务 id 取消当前 WebView 任务并释放。
pub async fn crawl_cancel_for_task(task_id: &str) {
    TaskScheduler::global()
        .complete_webview_task(task_id, Err(TaskError::Canceled))
        .await;
}

#[tauri::command]
pub async fn crawl_exit<R: Runtime>(webview: WebviewWindow<R>) -> Result<(), String> {
    let (task_id, _) = run_of(&webview)?;
    TaskScheduler::global()
        .complete_webview_task(&task_id, Ok(()))
        .await;
    Ok(())
}

#[tauri::command]
pub async fn crawl_error<R: Runtime>(
    webview: WebviewWindow<R>,
    message: String,
) -> Result<(), String> {
    let (task_id, _) = run_of(&webview)?;
    let err = if message.trim().is_empty() {
        "Unknown crawl.js error".to_string()
    } else {
        message
    };
    // 用户取消时脚本可能调用 ctx.error("Task canceled")，取消文案由 worker 统一写入。
    let result = if err.contains("Task canceled") {
        Err(TaskError::Canceled)
    } else {
        Err(TaskError::Other(err))
    };
    TaskScheduler::global()
        .complete_webview_task(&task_id, result)
        .await;
    Ok(())
}

#[tauri::command]
pub async fn crawl_task_log<R: Runtime>(
    webview: WebviewWindow<R>,
    message: String,
    level: Option<String>,
) -> Result<(), String> {
    let (task_id, _) = run_of(&webview)?;
    let lvl = level.as_deref().unwrap_or("print");
    GlobalEmitter::global().emit_task_log(&task_id, lvl, &message);
    Ok(())
}

#[tauri::command]
pub async fn crawl_add_progress<R: Runtime>(
    webview: WebviewWindow<R>,
    percentage: f64,
) -> Result<(), String> {
    let (task_id, _) = run_of(&webview)?;
    let _ = TaskScheduler::global().add_task_progress(&task_id, percentage);
    Ok(())
}

/// WebView `ctx.downloadImage(url, opts)`：`opts.name` / `opts.metadata` 可单独或同时传入。
/// raw metadata 在入口处归一化为 `metadata_id`，下载队列只传 id。
#[tauri::command]
pub async fn crawl_download_image<R: Runtime>(
    webview: WebviewWindow<R>,
    url: String,
    _cookie: Option<bool>,
    headers: Option<HashMap<String, String>>,
    name: Option<String>,
    metadata: Option<Value>,
    source_url: Option<String>,
) -> Result<(), String> {
    let (task_id, run) = run_of(&webview)?;

    let current_url = run.current_page_url();
    let parsed = resolve_download_image_url(
        &url,
        current_url.as_deref(),
        run.params.base_url(),
        run.fs_handle,
    )?;
    let images_dir = run.params.images_dir.clone();
    let download_start_time = now_ms();
    let mut request_headers = headers.unwrap_or_default();
    if let Some(page_url) = current_url.filter(|url| !url.trim().is_empty()) {
        request_headers.insert("Referer".to_string(), page_url);
    }
    let metadata_id = metadata
        .map(|value| run.insert_image_metadata(&value))
        .transpose()?;

    let merged_headers = merge_task_headers(&task_id, Some(request_headers), None)?;
    let dq = TaskScheduler::global().download_queue();
    if parsed.scheme() == "task-vfs" {
        let cancel = run.cancel.clone();
        let download = dq.download_image(
            parsed,
            images_dir,
            run.params.plugin.id.clone(),
            task_id,
            download_start_time,
            run.params.output_album_id.clone(),
            merged_headers,
            name,
            metadata_id,
            source_url,
        );
        return tokio::select! {
            biased;
            _ = cancel.cancelled() => Err("Task canceled".to_string()),
            result = download => result.map_err(|error| format!("Failed to download image: {error}")),
        };
    }

    std::fs::create_dir_all(&images_dir)
        .map_err(|e| format!("Failed to create native download dir: {}", e))?;
    let _native_dest =
        compute_unique_download_path_with_name(&images_dir, &parsed, None, name.as_deref())
            .map_err(|e| format!("Failed to compute native download destination: {}", e))?;
    let download_id = next_download_id();
    let native_info = ActiveDownloadInfo {
        id: download_id,
        url: parsed.as_str().to_string(),
        plugin_id: run.params.plugin.id.clone(),
        start_time: download_start_time,
        task_id: task_id.clone(),
        state: DownloadState::Preparing,
        native: true,
        retried_for: None,
        received_bytes: 0,
        total_bytes: None,
        surf_record_id: None,
        http_headers: merged_headers,
        output_album_id: run.params.output_album_id.clone(),
        custom_display_name: name,
        metadata_id,
        post_url: source_url,
    };
    dq.register_native(native_info)?;

    #[cfg(target_os = "linux")]
    let start_result = tauri_runtime_cef::start_download(webview.label(), parsed.as_str())
        .map_err(|e| e.to_string());
    #[cfg(not(target_os = "linux"))]
    let start_result = webview.navigate(parsed.clone()).map_err(|e| e.to_string());

    if let Err(e) = start_result {
        let _ = dq.take_native(parsed.as_str());
        return Err(format!("Failed to start native crawler download: {}", e));
    }
    Ok(())
}

/// Surf right-click download entry: pre-register a native download so the surf WebView
/// can keep cookies/session state while preserving the JS-computed display name.
#[tauri::command]
pub async fn surf_download_image<R: Runtime>(
    webview: Webview<R>,
    url: String,
    name: Option<String>,
    headers: Option<HashMap<String, String>>,
    metadata: Option<Value>,
    source_url: Option<String>,
) -> Result<(), String> {
    let ctx = media_ctx_from_label(webview.label(), true).await?;
    let parsed = Url::parse(&url).map_err(|e| format!("Invalid URL: {}", e))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("Surf download only supports http or https URLs".to_string());
    }

    let custom_name = name.or_else(|| surf_download_name_from_url(&parsed));
    std::fs::create_dir_all(&ctx.images_dir)
        .map_err(|e| format!("Failed to create native download dir: {}", e))?;
    let _native_dest = compute_unique_download_path_with_name(
        &ctx.images_dir,
        &parsed,
        None,
        custom_name.as_deref(),
    )
    .map_err(|e| format!("Failed to compute native download destination: {}", e))?;

    let metadata_id = insert_metadata(&ctx.plugin_id, metadata, ctx.plugin_version)?;
    let mut http_headers = ctx.http_headers.clone();
    if let Some(headers) = headers {
        http_headers.extend(headers);
    }
    let download_id = next_download_id();
    let native_info = ActiveDownloadInfo {
        id: download_id,
        url: parsed.as_str().to_string(),
        plugin_id: ctx.plugin_id.clone(),
        start_time: now_ms(),
        task_id: ctx.task_id.clone(),
        state: DownloadState::Preparing,
        native: true,
        retried_for: None,
        received_bytes: 0,
        total_bytes: None,
        surf_record_id: ctx.surf_record_id.clone(),
        http_headers,
        output_album_id: ctx.output_album_id.clone(),
        custom_display_name: custom_name,
        metadata_id,
        post_url: source_url,
    };
    let dq = TaskScheduler::global().download_queue();
    dq.register_native(native_info)?;

    #[cfg(target_os = "linux")]
    let start_result = tauri_runtime_cef::start_download(webview.label(), parsed.as_str())
        .map_err(|e| e.to_string());
    #[cfg(not(target_os = "linux"))]
    let start_result = webview.navigate(parsed.clone()).map_err(|e| e.to_string());

    if let Err(e) = start_result {
        let _ = dq.take_native(parsed.as_str());
        return Err(format!("Failed to start native surf download: {}", e));
    }
    Ok(())
}

#[tauri::command]
pub async fn crawl_media_begin<R: Runtime>(
    webview: tauri::Webview<R>,
    source_url: String,
    streams: Vec<MediaStreamInit>,
    name: Option<String>,
    metadata: Option<Value>,
    page_url: Option<String>,
) -> Result<u64, String> {
    let ctx = media_ctx_from_label(webview.label(), true).await?;
    let total_bytes = sum_stream_totals(&streams)?;
    if matches!(total_bytes, Some(total) if total > media_upload::SESSION_MAX_BYTES) {
        return Err(format!(
            "Media upload exceeds {} bytes",
            media_upload::SESSION_MAX_BYTES
        ));
    }

    let parsed = Url::parse(&source_url).map_err(|e| format!("Invalid media URL: {}", e))?;
    std::fs::create_dir_all(&ctx.images_dir)
        .map_err(|e| format!("Failed to create media upload dir: {e}"))?;
    let custom_name = name.or_else(|| {
        ctx.surf_record_id
            .as_ref()
            .and_then(|_| surf_download_name_from_url(&parsed))
    });
    let paths =
        compute_media_upload_paths(&ctx.images_dir, &parsed, &streams, custom_name.as_deref())?;
    let download_id = next_download_id();
    let download_start_time = now_ms();
    let metadata_id = insert_metadata(&ctx.plugin_id, metadata, ctx.plugin_version)?;

    media_upload::begin(
        download_id,
        ctx.task_id.clone(),
        paths,
        parsed.as_str().to_string(),
        total_bytes,
    )?;

    let native_info = ActiveDownloadInfo {
        id: download_id,
        url: parsed.as_str().to_string(),
        plugin_id: ctx.plugin_id.clone(),
        start_time: download_start_time,
        task_id: ctx.task_id.clone(),
        state: DownloadState::Preparing,
        native: true,
        retried_for: None,
        received_bytes: 0,
        total_bytes,
        surf_record_id: ctx.surf_record_id.clone(),
        http_headers: ctx.http_headers.clone(),
        output_album_id: ctx.output_album_id.clone(),
        custom_display_name: custom_name,
        metadata_id,
        post_url: page_url,
    };
    let dq = TaskScheduler::global().download_queue();
    if let Err(e) = dq.register_native(native_info) {
        media_upload::abort(download_id);
        return Err(e);
    }
    dq.switch_state(download_id, DownloadState::Downloading, None)
        .await;
    Ok(download_id)
}

#[tauri::command]
pub async fn crawl_media_chunk<R: Runtime>(
    webview: tauri::Webview<R>,
    id: u64,
    stream: Option<usize>,
    data: String,
) -> Result<(), String> {
    let ctx = media_ctx_from_label(webview.label(), false).await?;
    let dq = TaskScheduler::global().download_queue();
    let Some(entry) = dq.get_active_download(id) else {
        return Err(format!("Media upload download not found: {id}"));
    };
    if !active_download_matches_ctx(&entry, &ctx) {
        return Err("Media upload context mismatch".to_string());
    }

    let bytes = BASE64_STANDARD
        .decode(data.as_bytes())
        .map_err(|e| format!("Invalid media upload chunk: {e}"))?;
    match media_upload::append(id, stream.unwrap_or(0), &bytes) {
        Ok((written, total)) => {
            dq.report_progress(id, written, total);
            Ok(())
        }
        Err(e) => {
            media_upload::abort(id);
            dq.switch_state(id, DownloadState::Failed, Some(e.as_str()))
                .await;
            dq.wait_then_finish_download(id, false).await;
            Err(e)
        }
    }
}

#[tauri::command]
pub async fn crawl_media_end<R: Runtime>(
    webview: tauri::Webview<R>,
    id: u64,
    success: bool,
    error: Option<String>,
) -> Result<(), String> {
    let ctx = media_ctx_from_label(webview.label(), false).await?;
    let dq = TaskScheduler::global().download_queue();
    let Some(entry) = dq.get_active_download(id) else {
        if !success {
            media_upload::abort(id);
            return Ok(());
        }
        return Err(format!("Media upload download not found: {id}"));
    };
    if !active_download_matches_ctx(&entry, &ctx) {
        return Err("Media upload context mismatch".to_string());
    }

    if !success {
        media_upload::abort(id);
        let error = error
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or("Media upload aborted");
        dq.switch_state(id, DownloadState::Failed, Some(error))
            .await;
        dq.wait_then_finish_download(id, false).await;
        return Ok(());
    }

    let upload = match media_upload::finish(id) {
        Ok(upload) => upload,
        Err(e) => {
            dq.switch_state(id, DownloadState::Failed, Some(e.as_str()))
                .await;
            dq.wait_then_finish_download(id, false).await;
            return Err(e);
        }
    };
    if upload.task_id != ctx.task_id {
        for (path, _) in &upload.streams {
            let _ = std::fs::remove_file(path);
        }
        let error = "Media upload context mismatch";
        dq.switch_state(id, DownloadState::Failed, Some(error))
            .await;
        dq.wait_then_finish_download(id, false).await;
        return Err(error.to_string());
    }
    if let Some(total) = upload.total {
        if total != upload.written {
            let error = format!(
                "Media upload size mismatch: wrote {} of {} bytes",
                upload.written, total
            );
            dq.switch_state(id, DownloadState::Failed, Some(error.as_str()))
                .await;
            dq.wait_then_finish_download(id, false).await;
            for (path, _) in &upload.streams {
                let _ = std::fs::remove_file(path);
            }
            return Err(error);
        }
    }

    let parsed =
        Url::parse(&upload.source_url).map_err(|e| format!("Invalid media upload URL: {e}"))?;
    dq.switch_state(id, DownloadState::Processing, None).await;
    let task_id = (!entry.task_id.trim().is_empty()).then_some(entry.task_id.as_str());
    let postprocess_path;
    let temp_mux_path;
    let relocate_to;
    let delete_postprocess_source;
    if upload.streams.len() == 1 {
        postprocess_path = upload.streams[0].0.clone();
        temp_mux_path = None;
        relocate_to = None;
        delete_postprocess_source = false;
    } else {
        #[cfg(target_os = "android")]
        {
            for (path, _) in &upload.streams {
                let _ = std::fs::remove_file(path);
            }
            let error = "A/V stream merge not supported on Android";
            dq.switch_state(id, DownloadState::Failed, Some(error))
                .await;
            dq.wait_then_finish_download(id, false).await;
            return Err(error.to_string());
        }

        #[cfg(not(target_os = "android"))]
        {
            let out_ext = if upload
                .streams
                .iter()
                .any(|(_, mime)| mime.to_lowercase().contains("webm"))
            {
                "webm"
            } else {
                "mp4"
            };
            let out_path = kabegame_core::app_paths::AppPaths::global()
                .temp_dir
                .join(format!("media-mux-{}.{}", id, out_ext));
            if let Err(e) = kabegame_core::crawler::downloader::compress::mux_media_streams(
                &upload.streams,
                &out_path,
            ) {
                for (path, _) in &upload.streams {
                    let _ = std::fs::remove_file(path);
                }
                let _ = std::fs::remove_file(&out_path);
                dq.switch_state(id, DownloadState::Failed, Some(e.as_str()))
                    .await;
                dq.wait_then_finish_download(id, false).await;
                return Err(e);
            }
            for (path, _) in &upload.streams {
                let _ = std::fs::remove_file(path);
            }
            postprocess_path = out_path.clone();
            temp_mux_path = Some(out_path);
            relocate_to = Some(ctx.images_dir.as_path());
            delete_postprocess_source = true;
        }
    }
    let result = postprocess_downloaded_image(
        &*dq,
        id,
        PostprocessSource::Path {
            path: &postprocess_path,
            relocate_to,
        },
        delete_postprocess_source,
        &parsed,
        &entry.plugin_id,
        task_id,
        None,
        entry.surf_record_id.as_deref(),
        entry.start_time,
        entry.output_album_id.as_deref(),
        &entry.http_headers,
        true,
        entry.custom_display_name.as_deref(),
        entry.metadata_id,
        entry.post_url.as_deref(),
    )
    .await;
    if let Some(path) = temp_mux_path.as_ref() {
        let _ = std::fs::remove_file(path);
    }
    if let Ok(inserted) = result.as_ref() {
        if *inserted {
            if let Some(surf_record_id) = entry.surf_record_id.as_deref() {
                let _ = Storage::global().increment_surf_record_download_count(surf_record_id);
            }
        }
    }
    dq.wait_then_finish_download(id, false).await;
    result.map(|_| ())
}

/// 更新当前页 page_state（浅合并），返回合并后的 page_state 供脚本直接复用
/// （无本地缓存，避免脚本再发一次 crawl_get_page_state）。
#[tauri::command]
pub async fn crawl_update_page_state<R: Runtime>(
    webview: WebviewWindow<R>,
    patch: Value,
) -> Result<Value, String> {
    let (_, run) = run_of(&webview)?;
    let patch_obj = page_state_plain_object(Some(&patch));
    let merged = {
        let mut stack = run
            .page_stack
            .lock()
            .map_err(|e| format!("Lock error: {e}"))?;
        let current = stack.last().map(|entry| &entry.page_state);
        let merged = merge_page_state(current, &patch_obj);
        if let Some(top) = stack.last_mut() {
            top.page_state = merged.clone();
        }
        merged
    };
    Ok(merged)
}

/// 更新整个任务上下文状态（浅合并），返回合并后的 state（与 updatePageState 同理）。
#[tauri::command]
pub async fn crawl_update_state<R: Runtime>(
    webview: WebviewWindow<R>,
    patch: Value,
) -> Result<Value, String> {
    let (_, run) = run_of(&webview)?;
    let patch_obj = state_plain_object(Some(&patch));
    let current = run.webview_state();
    let merged = merge_state(Some(&current), &patch_obj);
    run.set_webview_state(merged.clone());
    Ok(merged)
}

/// 清空「当前站点」数据：删除该 URL 对应 origin 下的所有 Cookie（localStorage/sessionStorage 由前端 clear() 内清除）。
#[tauri::command]
pub async fn crawl_clear_site_data<R: Runtime>(
    webview: WebviewWindow<R>,
    url: String,
) -> Result<(), String> {
    let _ = run_of(&webview)?;
    let parsed =
        Url::parse(url.trim()).map_err(|e| format!("Invalid URL for clear_site_data: {}", e))?;
    let cookies = webview
        .cookies_for_url(parsed)
        .map_err(|e| format!("Failed to get cookies: {}", e))?;
    for cookie in cookies {
        let _ = webview.delete_cookie(cookie);
    }
    Ok(())
}

#[tauri::command]
pub async fn crawl_to<R: Runtime>(
    webview: WebviewWindow<R>,
    payload: CrawlToPayload,
) -> Result<(), String> {
    let (task_id, run) = run_of(&webview)?;
    let current_url = run.current_page_url();
    let target_url =
        resolve_target_url(&payload.url, current_url.as_deref(), run.params.base_url())?;
    let stack = get_page_stack(&task_id)?;
    let new_page_label = payload.page_label.clone().unwrap_or_else(|| {
        run.with_stack_top(|entry| entry.page_label.clone())
            .unwrap_or_else(|| "initial".to_string())
    });
    let new_page_state = page_state_plain_object(payload.page_state.as_ref());
    {
        let mut guard = stack.lock().map_err(|e| format!("Lock error: {}", e))?;
        if guard.is_empty() {
            guard.push(PageStackEntry {
                url: current_url
                    .clone()
                    .unwrap_or_else(|| run.params.base_url().to_string()),
                html: String::new(),
                headers: HashMap::new(),
                page_label: "initial".to_string(),
                page_state: Value::Object(Map::new()),
            });
        }
        guard.push(PageStackEntry {
            url: target_url.clone(),
            html: String::new(),
            headers: HashMap::new(),
            page_label: new_page_label.clone(),
            page_state: new_page_state.clone(),
        });
    }

    let parsed = url::Url::parse(&target_url)
        .map_err(|e| format!("Invalid target URL '{}': {}", target_url, e))?;
    webview
        .navigate(parsed)
        .map_err(|e| format!("Failed to navigate crawler window: {}", e))?;
    Ok(())
}

#[tauri::command]
pub async fn crawl_back<R: Runtime>(
    webview: WebviewWindow<R>,
    count: Option<usize>,
) -> Result<(), String> {
    let count = count.unwrap_or(1);
    if count == 0 {
        return Err("count must be >= 1".to_string());
    }
    let (task_id, _) = run_of(&webview)?;
    let stack = get_page_stack(&task_id)?;
    let previous_url = {
        let mut guard = stack.lock().map_err(|e| format!("Lock error: {}", e))?;
        if guard.len() < count + 1 {
            return Err(format!(
                "Page stack has only {} entries, cannot go back {} steps",
                guard.len(),
                count
            ));
        }
        for _ in 0..count {
            let _ = guard.pop();
        }
        let Some(top) = guard.last() else {
            return Err("Page stack is empty, cannot go back".to_string());
        };
        top.url.clone()
    };
    let parsed = url::Url::parse(&previous_url)
        .map_err(|e| format!("Invalid target URL '{}': {}", previous_url, e))?;
    webview
        .navigate(parsed)
        .map_err(|e| format!("Failed to navigate crawler window: {}", e))?;
    Ok(())
}

#[tauri::command]
pub fn show_crawler_window<R: Runtime>(app: AppHandle<R>, task_id: String) -> Result<(), String> {
    let label = crawler_window_label(task_id.trim());
    let crawler_window = app
        .get_webview_window(&label)
        .ok_or_else(|| "该任务未在运行或没有 WebView 窗口".to_string())?;
    crawler_window
        .show()
        .map_err(|e| format!("Failed to show crawler window: {}", e))?;
    crawler_window
        .set_focus()
        .map_err(|e| format!("Failed to focus crawler window: {}", e))?;
    Ok(())
}
