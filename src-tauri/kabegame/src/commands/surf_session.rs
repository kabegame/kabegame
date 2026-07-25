use kabegame_core::app_paths::AppPaths;
use kabegame_core::crawler::downloader::{
    next_download_id, postprocess_downloaded_image, ActiveDownloadInfo, DownloadState,
    PostprocessSource,
};
use kabegame_core::crawler::TaskScheduler;
use kabegame_core::plugin::vfs::PluginVfs;
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{Runtime, Webview};
use url::Url;

#[derive(Debug)]
pub(crate) struct SurfFsSession {
    pub(crate) handle: u64,
    pub(crate) vfs: Arc<PluginVfs>,
    pub(crate) root: PathBuf,
}

fn sessions() -> &'static Mutex<HashMap<String, Arc<SurfFsSession>>> {
    static SESSIONS: OnceLock<Mutex<HashMap<String, Arc<SurfFsSession>>>> = OnceLock::new();
    SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn random_handle() -> u64 {
    let (high, low) = uuid::Uuid::new_v4().as_u64_pair();
    high ^ low
}

pub(crate) fn get_or_create_session(host: &str) -> Result<Arc<SurfFsSession>, String> {
    let mut sessions = sessions()
        .lock()
        .map_err(|_| "畅游文件系统会话注册表已损坏".to_string())?;
    if let Some(session) = sessions.get(host) {
        return Ok(Arc::clone(session));
    }

    let handle = loop {
        let candidate = random_handle();
        if !sessions.values().any(|session| session.handle == candidate) {
            break candidate;
        }
    };
    let root = AppPaths::global().surf_session_temp_dir(handle);
    let session = Arc::new(SurfFsSession {
        handle,
        vfs: Arc::new(PluginVfs::new_session(handle, &root)),
        root,
    });
    sessions.insert(host.to_string(), Arc::clone(&session));
    Ok(session)
}

pub(crate) fn drop_session(host: &str) {
    let session = match sessions().lock() {
        Ok(mut sessions) => sessions.remove(host),
        Err(_) => {
            eprintln!("[surf-session] 畅游文件系统会话注册表已损坏");
            None
        }
    };
    if let Some(session) = session {
        if let Err(error) = std::fs::remove_dir_all(&session.root) {
            if error.kind() != std::io::ErrorKind::NotFound {
                eprintln!(
                    "[surf-session] 清理会话目录 {} 失败：{error}",
                    session.root.display()
                );
            }
        }
    }
}

/// 启动时清理上次异常退出遗留的全部畅游会话目录。
pub(crate) fn clear_stale_sessions() {
    let sentinel = AppPaths::global().surf_session_temp_dir(0);
    let Some(root) = sentinel.parent() else {
        return;
    };
    if let Err(error) = std::fs::remove_dir_all(root) {
        if error.kind() != std::io::ErrorKind::NotFound {
            eprintln!(
                "[surf-session] 清理遗留会话目录 {} 失败：{error}",
                root.display()
            );
        }
    }
}

#[tauri::command]
pub async fn surf_import_media<R: Runtime>(
    webview: Webview<R>,
    path: String,
    source_url: String,
    name: Option<String>,
    metadata: Option<Value>,
    page_url: Option<String>,
) -> Result<(), String> {
    let ctx = super::crawler::surf_ctx_from_label(webview.label())?;
    let session = get_or_create_session(&ctx.host)?;
    let real_path = session
        .vfs
        .host_path_for_read(Path::new(&path))
        .map_err(|error| format!("无法读取待导入媒体“{path}”：{error}"))?;
    let file_size = std::fs::metadata(&real_path)
        .map_err(|error| format!("无法读取待导入媒体“{path}”：{error}"))?
        .len();
    let parsed = Url::parse(&source_url).map_err(|error| format!("Invalid media URL: {error}"))?;
    let custom_name = name.or_else(|| super::crawler::surf_download_name_from_url(&parsed));
    let metadata_id = super::crawler::insert_metadata(&ctx.host, metadata, 0)?;
    let download_id = next_download_id();
    let download_start_time = super::crawler::now_ms();
    let http_headers = HashMap::new();

    let dq = TaskScheduler::global().download_queue();
    dq.register_active_download(ActiveDownloadInfo {
        id: download_id,
        url: parsed.as_str().to_string(),
        plugin_id: ctx.host.clone(),
        start_time: download_start_time,
        task_id: String::new(),
        state: DownloadState::Processing,
        retried_for: None,
        received_bytes: file_size,
        total_bytes: Some(file_size),
        surf_record_id: Some(ctx.surf_record_id.clone()),
        http_headers: http_headers.clone(),
        output_album_id: None,
        custom_display_name: custom_name.clone(),
        metadata_id,
        post_url: page_url.clone(),
        native_completion: Arc::new(Mutex::new(None)),
    })?;

    let result = postprocess_downloaded_image(
        &*dq,
        download_id,
        PostprocessSource::Path {
            path: &real_path,
            relocate_to: Some(&ctx.images_dir),
        },
        true,
        &parsed,
        &ctx.host,
        None,
        None,
        Some(&ctx.surf_record_id),
        download_start_time,
        None,
        &http_headers,
        custom_name.as_deref(),
        metadata_id,
        page_url.as_deref(),
    )
    .await;
    dq.wait_then_finish_download(download_id, false).await;
    result.map(|_| ())
}
