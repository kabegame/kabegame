use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use kabegame_core::crawler::downloader::{
    build_safe_filename, build_safe_filename_no_ext, compute_unique_download_path_with_name,
    media_upload, next_download_id, postprocess_downloaded_image, unique_path, ActiveDownloadInfo,
    DownloadState, PostprocessSource,
};
use kabegame_core::crawler::task_scheduler::PageStackEntry;
use kabegame_core::crawler::webview::{
    crawler_window_label, get_session, task_id_from_crawler_label, CrawlerSession, JsTaskPatch,
};
use kabegame_core::crawler::TaskScheduler;
use kabegame_core::emitter::GlobalEmitter;
use kabegame_core::storage::tasks::TaskStatus;
use kabegame_core::storage::Storage;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, Manager, Runtime, Webview, WebviewWindow};
use url::Url;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CrawlContextPayload {
    pub task_id: String,
    pub plugin_id: String,
    pub crawl_js: String,
    pub vars: std::collections::HashMap<String, Value>,
    pub base_url: String,
    pub current_url: Option<String>,
    pub page_label: String,
    pub page_state: Option<Value>,
    pub state: Option<Value>,
    pub resume_mode: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CrawlToPayload {
    pub url: String,
    pub page_label: Option<String>,
    pub page_state: Option<Value>,
}

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
        let (_, session) = session_of_label(label).await?;
        let Some(ctx) = session.get_context().await else {
            return Err("Crawler context not found".to_string());
        };
        let task_id = ctx.task_id.clone();
        let merged_headers = if include_headers {
            let mut request_headers = HashMap::new();
            if let Some(ref page_url) = ctx.current_url {
                if !page_url.trim().is_empty() {
                    request_headers.insert("Referer".to_string(), page_url.clone());
                }
            }
            merge_task_headers(&task_id, Some(request_headers), None)?
        } else {
            HashMap::new()
        };
        return Ok(MediaReceiveCtx {
            images_dir: PathBuf::from(&ctx.images_dir),
            plugin_id: ctx.plugin_id,
            plugin_version: ctx.plugin_version,
            task_id,
            surf_record_id: None,
            output_album_id: ctx.output_album_id,
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

async fn get_page_stack(
    task_id: &str,
) -> Result<kabegame_core::crawler::task_scheduler::PageStack, String> {
    TaskScheduler::global()
        .page_stacks()
        .get_stack(task_id)
        .await
        .ok_or_else(|| format!("Page stack not found for task {}", task_id))
}

async fn session_of<R: Runtime>(
    webview: &WebviewWindow<R>,
) -> Result<(String, Arc<CrawlerSession>), String> {
    session_of_label(webview.label()).await
}

async fn session_of_label(label: &str) -> Result<(String, Arc<CrawlerSession>), String> {
    let task_id = task_id_from_crawler_label(label)
        .ok_or_else(|| format!("Invalid crawler window label: {}", label))?
        .to_string();
    let session = get_session(&task_id)
        .await
        .ok_or_else(|| format!("Crawler session not found for task {}", task_id))?;
    Ok((task_id, session))
}

fn merge_task_headers(
    task_id: &str,
    headers: Option<HashMap<String, String>>,
    cookie_header: Option<String>,
) -> Result<HashMap<String, String>, String> {
    let Some(mut task) = Storage::global().get_task(task_id)? else {
        return Err(format!("Task not found: {task_id}"));
    };
    let mut merged = task.http_headers.take().unwrap_or_default();
    if let Some(headers) = headers {
        for (k, v) in headers {
            if !k.trim().is_empty() {
                merged.insert(k, v);
            }
        }
    }
    if let Some(cookie) = cookie_header.filter(|s| !s.trim().is_empty()) {
        merged.insert("Cookie".to_string(), cookie);
    }
    task.http_headers = Some(merged.clone());
    Storage::global().update_task(task)?;
    Ok(merged)
}

#[tauri::command]
pub async fn crawl_get_context<R: Runtime>(
    webview: WebviewWindow<R>,
) -> Result<Option<CrawlContextPayload>, String> {
    let (_, session) = session_of(&webview).await?;
    let Some(ctx) = session.get_context().await else {
        return Ok(None);
    };
    Ok(Some(CrawlContextPayload {
        task_id: ctx.task_id,
        plugin_id: ctx.plugin_id,
        crawl_js: ctx.crawl_js,
        vars: ctx.merged_config,
        base_url: ctx.base_url,
        current_url: ctx.current_url,
        page_label: ctx.page_label,
        page_state: ctx.page_state,
        state: ctx.state,
        resume_mode: ctx.resume_mode,
    }))
}

#[tauri::command]
pub async fn crawl_run_script<R: Runtime>(webview: WebviewWindow<R>) -> Result<(), String> {
    let (_, session) = session_of(&webview).await?;
    if !session.try_dispatch_script() {
        return Ok(());
    }
    let Some(ctx) = session.get_context().await else {
        return Err("Crawler context not found".to_string());
    };

    let wrapped_script = format!(
        r#"(async function () {{
  const ctx = window.__crawl_ctx__;
  if (!ctx) {{
    throw new Error("Crawler context missing on window.__crawl_ctx__");
  }}
  try {{
{script}
  }} catch (e) {{
    let detail;
    if (e && typeof e === 'object') {{
      const msg = e.message || '';
      const stack = e.stack || '';
      detail = msg ? (msg + (stack ? '\n' + stack : '')) : (stack || String(e));
    }} else {{
      detail = String(e);
    }}
    if (ctx && typeof ctx.error === "function") {{
      await ctx.error(detail);
    }} else {{
      console.error("[crawler-bootstrap] script error:", detail);
    }}
  }}
}})();"#,
        script = ctx.crawl_js
    );

    webview
        .eval(&wrapped_script)
        .map_err(|e| format!("Failed to eval crawler script: {}", e))?;
    Ok(())
}

/// 内部：按给定状态结束当前 webview 任务并释放。若 only_for_task_id 为 Some，
/// 仅当当前上下文为该任务时执行，否则直接返回（用于取消时只释放对应任务）。
pub async fn crawl_exit_with_status(status: TaskStatus, only_for_task_id: Option<&str>) {
    if let Some(task_id) = only_for_task_id {
        if let Some(session) = get_session(task_id).await {
            if status == TaskStatus::Canceled {
                TaskScheduler::global()
                    .download_queue()
                    .cancel_task_downloads(task_id)
                    .await;
            }
            session
                .complete(
                    status,
                    (status == TaskStatus::Canceled).then(|| "Task canceled".to_string()),
                )
                .await;
        }
    }
}

#[tauri::command]
pub async fn crawl_exit<R: Runtime>(webview: WebviewWindow<R>) -> Result<(), String> {
    let (_, session) = session_of(&webview).await?;
    session.complete(TaskStatus::Completed, None).await;
    Ok(())
}

#[tauri::command]
pub async fn crawl_error<R: Runtime>(
    webview: WebviewWindow<R>,
    message: String,
) -> Result<(), String> {
    let (task_id, session) = session_of(&webview).await?;
    let err = if message.trim().is_empty() {
        "Unknown crawl.js error".to_string()
    } else {
        message
    };
    // 用户取消时脚本可能调用 ctx.error("Task canceled")，应显示为"已取消"而非"失败"
    let next = if err.contains("Task canceled") {
        TaskStatus::Canceled
    } else {
        TaskStatus::Failed
    };
    if next == TaskStatus::Canceled {
        TaskScheduler::global()
            .download_queue()
            .cancel_task_downloads(&task_id)
            .await;
    }
    session.complete(next, Some(err)).await;
    Ok(())
}

#[tauri::command]
pub async fn crawl_task_log<R: Runtime>(
    webview: WebviewWindow<R>,
    message: String,
    level: Option<String>,
) -> Result<(), String> {
    let (_, session) = session_of(&webview).await?;
    let Some(ctx) = session.get_context().await else {
        return Ok(());
    };
    let lvl = level.as_deref().unwrap_or("print");
    GlobalEmitter::global().emit_task_log(&ctx.task_id, lvl, &message);
    Ok(())
}

#[tauri::command]
pub async fn crawl_add_progress<R: Runtime>(
    webview: WebviewWindow<R>,
    percentage: f64,
) -> Result<(), String> {
    let (_, session) = session_of(&webview).await?;
    let Some(ctx) = session.get_context().await else {
        return Ok(());
    };

    if let Ok(Some(mut task)) = Storage::global().get_task(&ctx.task_id) {
        task.progress = (task.progress + percentage).clamp(0.0, 99.9);
        let final_progress = task.progress;
        let _ = Storage::global().update_task(task);
        GlobalEmitter::global().emit_task_progress(&ctx.task_id, final_progress);
    }

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
    let (_, session) = session_of(&webview).await?;
    let Some(ctx) = session.get_context().await else {
        return Err("Crawler context not found".to_string());
    };

    let target_url = resolve_target_url(&url, ctx.current_url.as_deref(), &ctx.base_url)?;
    let parsed = Url::parse(&target_url).map_err(|e| format!("Invalid URL: {}", e))?;
    let images_dir = PathBuf::from(&ctx.images_dir);
    let download_start_time = now_ms();
    let mut request_headers = headers.unwrap_or_default();
    if let Some(ref page_url) = ctx.current_url {
        if !page_url.trim().is_empty() {
            request_headers.insert("Referer".to_string(), page_url.clone());
        }
    }
    let metadata_id = insert_metadata(&ctx.plugin_id, metadata, ctx.plugin_version)?;

    let merged_headers = merge_task_headers(&ctx.task_id, Some(request_headers), None)?;
    std::fs::create_dir_all(&images_dir)
        .map_err(|e| format!("Failed to create native download dir: {}", e))?;
    let _native_dest =
        compute_unique_download_path_with_name(&images_dir, &parsed, None, name.as_deref())
            .map_err(|e| format!("Failed to compute native download destination: {}", e))?;
    let download_id = next_download_id();
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
        total_bytes: None,
        surf_record_id: None,
        http_headers: merged_headers,
        output_album_id: ctx.output_album_id.clone(),
        custom_display_name: name,
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

#[tauri::command]
pub async fn crawl_update_page_state<R: Runtime>(
    webview: WebviewWindow<R>,
    patch: Value,
) -> Result<(), String> {
    let (_, session) = session_of(&webview).await?;
    let Some(ctx) = session.get_context().await else {
        return Err("Crawler context not found".to_string());
    };
    let task_id = ctx.task_id.clone();
    let patch_obj = page_state_plain_object(Some(&patch));
    let merged = merge_page_state(ctx.page_state.as_ref(), &patch_obj);
    session
        .patch_context_for_task(
            &task_id,
            JsTaskPatch {
                current_url: None,
                page_label: None,
                page_state: Some(merged),
                state: None,
                resume_mode: None,
            },
        )
        .await?;
    Ok(())
}

/// 更新整个任务上下文状态：同步到 Rust 内存并会反映到 ctx.state（与 updatePageState 同理）。
#[tauri::command]
pub async fn crawl_update_state<R: Runtime>(
    webview: WebviewWindow<R>,
    patch: Value,
) -> Result<(), String> {
    let (_, session) = session_of(&webview).await?;
    let Some(ctx) = session.get_context().await else {
        return Err("Crawler context not found".to_string());
    };
    let task_id = ctx.task_id.clone();
    let patch_obj = state_plain_object(Some(&patch));
    let merged = merge_state(ctx.state.as_ref(), &patch_obj);
    session
        .patch_context_for_task(
            &task_id,
            JsTaskPatch {
                current_url: None,
                page_label: None,
                page_state: None,
                state: Some(merged),
                resume_mode: None,
            },
        )
        .await?;
    Ok(())
}

#[tauri::command]
pub async fn crawl_page_ready<R: Runtime>(webview: WebviewWindow<R>) -> Result<(), String> {
    let (_, session) = session_of(&webview).await?;
    let Some(_) = session.get_context().await else {
        return Err("Crawler context not found".to_string());
    };
    session.set_page_ready(false);
    session.set_page_ready(true);
    Ok(())
}

/// 清空「当前站点」数据：删除该 URL 对应 origin 下的所有 Cookie（localStorage/sessionStorage 由前端 clear() 内清除）。
#[tauri::command]
pub async fn crawl_clear_site_data<R: Runtime>(
    webview: WebviewWindow<R>,
    url: String,
) -> Result<(), String> {
    let _ = session_of(&webview).await?;
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
    let (_, session) = session_of(&webview).await?;
    let Some(ctx) = session.get_context().await else {
        return Err("Crawler context not found".to_string());
    };

    let target_url = resolve_target_url(&payload.url, ctx.current_url.as_deref(), &ctx.base_url)?;
    let task_id = ctx.task_id.clone();
    let stack = get_page_stack(&task_id).await?;
    let new_page_label = payload
        .page_label
        .clone()
        .unwrap_or_else(|| ctx.page_label.clone());
    let new_page_state = page_state_plain_object(payload.page_state.as_ref());
    let current_page_state = page_state_plain_object(ctx.page_state.as_ref());
    {
        let mut guard = stack.lock().map_err(|e| format!("Lock error: {}", e))?;
        if guard.is_empty() {
            guard.push(PageStackEntry {
                url: ctx
                    .current_url
                    .clone()
                    .unwrap_or_else(|| ctx.base_url.clone()),
                html: String::new(),
                headers: HashMap::new(),
                page_label: ctx.page_label.clone(),
                page_state: current_page_state,
            });
        } else if let Some(top) = guard.last_mut() {
            top.page_label = ctx.page_label.clone();
            top.page_state = current_page_state;
        }
        guard.push(PageStackEntry {
            url: target_url.clone(),
            html: String::new(),
            headers: HashMap::new(),
            page_label: new_page_label.clone(),
            page_state: new_page_state.clone(),
        });
    }
    session
        .patch_context_for_task(
            &task_id,
            JsTaskPatch {
                current_url: Some(target_url.clone()),
                page_label: Some(new_page_label),
                page_state: Some(new_page_state),
                state: None,
                resume_mode: Some("after_navigation".to_string()),
            },
        )
        .await?;

    let parsed = url::Url::parse(&target_url)
        .map_err(|e| format!("Invalid target URL '{}': {}", target_url, e))?;
    session.set_page_ready(false);
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
    let (_, session) = session_of(&webview).await?;
    let Some(ctx) = session.get_context().await else {
        return Err("Crawler context not found".to_string());
    };
    let stack = get_page_stack(&ctx.task_id).await?;
    let (previous_url, restored_page_label, restored_page_state) = {
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
        (
            top.url.clone(),
            top.page_label.clone(),
            page_state_plain_object(Some(&top.page_state)),
        )
    };
    session
        .patch_context_for_task(
            &ctx.task_id,
            JsTaskPatch {
                current_url: Some(previous_url.clone()),
                page_label: Some(restored_page_label),
                page_state: Some(restored_page_state),
                state: None,
                resume_mode: Some("after_navigation".to_string()),
            },
        )
        .await?;
    let parsed = url::Url::parse(&previous_url)
        .map_err(|e| format!("Invalid target URL '{}': {}", previous_url, e))?;
    session.set_page_ready(false);
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
