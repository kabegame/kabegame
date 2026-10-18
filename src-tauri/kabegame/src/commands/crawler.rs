// 桌面专属的 WebView 爬虫命令与 CEF 页面下载出口。
//
// 文件系统命令（`crawl_fs_*` / `crawl_ffmpeg_*`）与畅游接收命令已拆到全平台模块
// `page_fs` / `surf_receive`；这里重新导出，保持 `super::crawler::now_ms` 这类既有引用不变。
pub(crate) use super::page_fs::*;
pub(crate) use super::surf_receive::*;

use kabegame_core::crawler::task_log_i18n::task_log_i18n;
use kabegame_core::crawler::task_scheduler::{PageStackEntry, Task, TaskError};
use kabegame_core::crawler::webview::crawler_window_label;
use kabegame_core::crawler::TaskScheduler;
use kabegame_core::emitter::GlobalEmitter;
use kabegame_core::plugin::{
    archive::{ExtractOptions, ExtractResult},
    vfs::PluginVfs,
};
use kabegame_core::storage::labels::{validate_label_values, LabelSpec};
use kabegame_core::storage::search_terms::validate_search_text_values;
use kabegame_core::storage::Storage;
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{AppHandle, Manager, Runtime, Webview, WebviewWindow};
use url::Url;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CrawlToPayload {
    pub url: String,
    pub page_label: Option<String>,
    pub page_state: Option<Value>,
}

pub(crate) fn native_download_id_from_path(path: &Path) -> Option<u64> {
    path.file_name()?
        .to_str()?
        .strip_prefix("native-")?
        .strip_suffix(".part")?
        .parse()
        .ok()
}

/// 向触发页面自发原生下载的 WebView 分发终态事件。
pub(crate) fn notify_page_download<R: Runtime>(webview: &Webview<R>, payload: Value) {
    let Ok(payload_json) = serde_json::to_string(&payload) else {
        return;
    };
    let script = format!("window.__kb_native_download_finished__?.({payload_json});");
    let _ = webview.eval(script.as_str());
}

/// 把页面自发原生下载定向到当前窗口 VFS 的 `tmp/Downloads`。
pub(crate) fn assign_page_download_destination(
    vfs: &PluginVfs,
    handle: u64,
    url: &Url,
    suggested_name: Option<&str>,
    destination: &mut PathBuf,
) -> Result<(), String> {
    let relative =
        kabegame_core::crawler::downloader::util::page_download_rel_path(url, suggested_name);
    let virtual_path = PathBuf::from(format!("/{handle}/tmp")).join(relative);
    let host_path = vfs
        .host_path_for_write(&virtual_path)
        .map_err(|error| format!("无法分配页面下载路径：{error}"))?;
    let parent = host_path
        .parent()
        .ok_or_else(|| "页面下载路径缺少父目录".to_string())?;
    std::fs::create_dir_all(parent).map_err(|error| format!("无法创建页面下载目录：{error}"))?;
    *destination = host_path;
    Ok(())
}

/// 校验页面自发下载确实落在当前窗口 VFS 内，再把虚拟路径回传给页面。
pub(crate) fn finish_page_download<R: Runtime>(
    webview: &Webview<R>,
    vfs: &PluginVfs,
    handle: u64,
    url: &Url,
    path: &Path,
    success: bool,
) {
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .map(ToOwned::to_owned);
    if !success {
        let _ = std::fs::remove_file(path);
        notify_page_download(
            webview,
            serde_json::json!({
                "url": url.as_str(),
                "success": false,
                "name": name,
                "error": "下载失败或已取消",
            }),
        );
        return;
    }

    let Some(name) = name else {
        let _ = std::fs::remove_file(path);
        return;
    };
    let virtual_path = format!("/{handle}/tmp/Downloads/{name}");
    let Ok(expected_path) = vfs.host_path_for_read(Path::new(&virtual_path)) else {
        let _ = std::fs::remove_file(path);
        return;
    };
    if expected_path.as_path() != path {
        let _ = std::fs::remove_file(path);
        return;
    }

    notify_page_download(
        webview,
        serde_json::json!({
            "url": url.as_str(),
            "success": true,
            "path": virtual_path,
            "name": name,
        }),
    );
}

/// CEF Requested 回调认领 worker 发起的下载并设置统一临时路径。
pub(crate) fn claim_native_download_destination(
    task_id: Option<&str>,
    surf_record_id: Option<&str>,
    url: &Url,
    destination: &mut PathBuf,
) -> bool {
    let temp_dir = kabegame_core::app_paths::AppPaths::global().downloads_temp_dir();
    if std::fs::create_dir_all(&temp_dir).is_err() {
        return false;
    }
    let dq = TaskScheduler::global().download_queue();
    let Some(id) = dq.claim_native_download(task_id, surf_record_id, url.as_str()) else {
        return false;
    };
    *destination = temp_dir.join(format!("native-{id}.part"));
    true
}

/// CEF Finished 回调把终态送回对应 worker。无法找到等待者时立即清理孤儿文件。
pub(crate) fn finish_native_download(
    task_id: Option<&str>,
    surf_record_id: Option<&str>,
    url: &Url,
    path: Option<PathBuf>,
    success: bool,
) {
    if !success {
        if let Some(path) = path.as_ref() {
            let _ = std::fs::remove_file(path);
        }
    }
    let dq = TaskScheduler::global().download_queue();
    let tx = path
        .as_deref()
        .and_then(native_download_id_from_path)
        .and_then(|id| dq.take_native_completion(id))
        .or_else(|| dq.take_native_completion_for_owner_url(task_id, surf_record_id, url.as_str()));
    let Some(tx) = tx else {
        if let Some(path) = path {
            let _ = std::fs::remove_file(path);
        }
        return;
    };
    if tx.send((path.clone(), success)).is_err() {
        if let Some(path) = path {
            let _ = std::fs::remove_file(path);
        }
    }
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

#[tauri::command]
pub async fn crawl_archive_zip<R: Runtime>(
    webview: Webview<R>,
    src: String,
    dest_dir: String,
    opts: Option<ExtractOptions>,
) -> Result<ExtractResult, String> {
    let vfs = vfs_of_label(webview.label())?;
    let opts = opts.unwrap_or_default();
    tokio::task::spawn_blocking(move || {
        kabegame_core::plugin::archive::extract_zip_sync(&vfs, &src, &dest_dir, &opts)
    })
    .await
    .map_err(|error| format!("ZIP 解压任务执行失败：{error}"))?
}

#[tauri::command]
pub async fn crawl_archive_tar<R: Runtime>(
    webview: Webview<R>,
    src: String,
    dest_dir: String,
    opts: Option<ExtractOptions>,
) -> Result<ExtractResult, String> {
    let vfs = vfs_of_label(webview.label())?;
    let opts = opts.unwrap_or_default();
    tokio::task::spawn_blocking(move || {
        kabegame_core::plugin::archive::extract_tar_sync(&vfs, &src, &dest_dir, &opts)
    })
    .await
    .map_err(|error| format!("TAR 解压任务执行失败：{error}"))?
}

#[tauri::command]
pub async fn crawl_archive_7z<R: Runtime>(
    webview: Webview<R>,
    src: String,
    dest_dir: String,
    opts: Option<ExtractOptions>,
) -> Result<ExtractResult, String> {
    let vfs = vfs_of_label(webview.label())?;
    let opts = opts.unwrap_or_default();
    tokio::task::spawn_blocking(move || {
        kabegame_core::plugin::archive::extract_7z_sync(&vfs, &src, &dest_dir, &opts)
    })
    .await
    .map_err(|error| format!("7z 解压任务执行失败：{error}"))?
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

/// WebView 心跳上报（bootstrap.js 每 60s 调一次）；调度器看门狗以此重置无响应超时。
#[tauri::command]
pub async fn crawl_heartbeat<R: Runtime>(webview: WebviewWindow<R>) -> Result<(), String> {
    let (_, run) = run_of(&webview)?;
    run.heartbeat_webview();
    Ok(())
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

#[tauri::command]
pub async fn crawl_create_image_metadata<R: Runtime>(
    webview: WebviewWindow<R>,
    value: Value,
    search_texts: Option<Value>,
) -> Result<i64, String> {
    let (task_id, run) = run_of(&webview)?;
    let search_terms = validate_crawler_search_texts(search_texts, &task_id, "searchTexts")?;
    run.insert_metadata(&value, search_terms)
}

#[tauri::command]
pub async fn crawl_plugin_data<R: Runtime>(webview: WebviewWindow<R>) -> Result<Value, String> {
    let (_, run) = run_of(&webview)?;
    Storage::global()
        .plugin_data()
        .get(&run.params.plugin.id)
        .map(|value| value.unwrap_or_else(|| Value::Object(Map::new())))
        .map_err(|error| format!("读取插件私有数据失败：{error}"))
}

#[tauri::command]
pub async fn crawl_set_plugin_data<R: Runtime>(
    webview: WebviewWindow<R>,
    value: Value,
) -> Result<(), String> {
    if !value.is_object() {
        return Err("设置插件私有数据失败：value 必须是 JSON 对象".to_string());
    }
    let (_, run) = run_of(&webview)?;
    Storage::global()
        .plugin_data()
        .set(&run.params.plugin.id, &value)
        .map_err(|error| format!("写入插件私有数据失败：{error}"))
}

/// WebView `Kabegame.downloadImage(url, opts)`：支持与 V8 同形的
/// `opts.name` / `opts.url` / `opts.metadata_id` / `opts.metadata` / `opts.searchTexts`。
/// raw metadata 在入口处归一化为 `metadata_id`，下载队列只传 id。
#[tauri::command]
pub async fn crawl_download_image<R: Runtime>(
    webview: WebviewWindow<R>,
    url: String,
    name: Option<String>,
    metadata: Option<Value>,
    metadata_id: Option<i64>,
    source_url: Option<String>,
    labels: Option<Value>,
    search_texts: Option<Value>,
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
    let search_terms = validate_crawler_search_texts(search_texts, &task_id, "searchTexts")?;
    let metadata_id = if let Some(id) = metadata_id {
        if search_terms.is_some() {
            GlobalEmitter::global().emit_task_log(
                &task_id,
                "warn",
                &task_log_i18n("taskLogSearchTextsIgnoredWithMetadataId", json!({})),
            );
        }
        Some(id)
    } else if let Some(value) = metadata {
        Some(run.insert_metadata(&value, search_terms)?)
    } else {
        None
    };
    let labels = validate_crawler_download_labels(labels, &run.params.plugin.id, &task_id)?;

    let dq = TaskScheduler::global().download_queue();
    // 与 V8 op 同形：统一经容量门控入队；worker 再按插件 backend 选择 CEF 或 scheme downloader。
    let cancel = run.cancel.clone();
    let download = dq.download_image(
        parsed,
        images_dir,
        run.params.plugin.id.clone(),
        task_id,
        download_start_time,
        run.params.output_album_id.clone(),
        HashMap::new(),
        name,
        metadata_id,
        source_url,
        labels,
    );
    tokio::select! {
        biased;
        _ = cancel.cancelled() => Err("Task canceled".to_string()),
        result = download => result.map_err(|error| format!("Failed to download image: {error}")),
    }
}

fn validate_crawler_download_labels(
    value: Option<Value>,
    plugin_id: &str,
    task_id: &str,
) -> Result<Vec<LabelSpec>, String> {
    let (specs, rejected) = validate_label_values(value.as_ref(), plugin_id)
        .map_err(|error| format!("downloadImage {error}"))?;
    for (index, reason) in rejected {
        GlobalEmitter::global().emit_task_log(
            task_id,
            "warn",
            &task_log_i18n(
                "taskLogLabelSkipped",
                json!({ "label": "labels", "index": index, "reason": reason }),
            ),
        );
    }
    Ok(specs)
}

fn validate_crawler_search_texts(
    value: Option<Value>,
    task_id: &str,
    label: &str,
) -> Result<Option<Vec<String>>, String> {
    let (terms, rejected) =
        validate_search_text_values(value.as_ref()).map_err(|error| format!("{label}: {error}"))?;
    for (index, reason) in rejected {
        GlobalEmitter::global().emit_task_log(
            task_id,
            "warn",
            &task_log_i18n(
                "taskLogSearchTextSkipped",
                json!({ "label": label, "index": index, "reason": reason }),
            ),
        );
    }
    Ok(terms)
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
