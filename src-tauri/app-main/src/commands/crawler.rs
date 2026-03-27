use kabegame_core::crawler::scheduler::PageStackEntry;
use kabegame_core::crawler::downloader::BrowserDownloadState;
use kabegame_core::crawler::webview::{crawler_window_state, JsTaskPatch};
use kabegame_core::crawler::TaskScheduler;
use kabegame_core::emitter::GlobalEmitter;
use kabegame_core::schedule_sync::on_crawl_task_reached_terminal;
use kabegame_core::storage::Storage;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};
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

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CrawlRegisterBlobDownloadPayload {
    pub download_id: String,
    pub blob_url: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CrawlBrowserDownloadFailedPayload {
    pub download_id: String,
    pub error: Option<String>,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn update_task_status(task_id: &str, status: &str, end_time: Option<u64>, error: Option<String>) {
    if let Ok(Some(mut task)) = Storage::global().get_task(task_id) {
        task.status = status.to_string();
        if let Some(end) = end_time {
            task.end_time = Some(end);
        }
        if let Some(err) = error.clone() {
            task.error = Some(err);
        }
        let _ = Storage::global().update_task(task);
        if matches!(
            status,
            "completed" | "failed" | "canceled" | "cancelled"
        ) {
            on_crawl_task_reached_terminal(task_id);
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

fn resolve_target_url(raw_url: &str, current_url: Option<&str>, base_url: &str) -> Result<String, String> {
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

fn get_page_stack(task_id: &str) -> Result<kabegame_core::crawler::scheduler::PageStack, String> {
    TaskScheduler::global()
        .page_stacks()
        .get_stack(task_id)
        .ok_or_else(|| format!("Page stack not found for task {}", task_id))
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
pub async fn crawl_get_context() -> Result<Option<CrawlContextPayload>, String> {
    let state = crawler_window_state();
    let Some(ctx) = state.get_context().await else {
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
pub async fn crawl_run_script(app: AppHandle) -> Result<(), String> {
    let state = crawler_window_state();
    if !state.try_dispatch_script() {
        return Ok(());
    }
    let Some(ctx) = state.get_context().await else {
        return Err("Crawler context not found".to_string());
    };
    let crawler_window = app
        .get_webview_window("crawler")
        .ok_or_else(|| "Crawler window not found".to_string())?;

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

    crawler_window
        .eval(&wrapped_script)
        .map_err(|e| format!("Failed to eval crawler script: {}", e))?;
    Ok(())
}

/// 内部：按给定状态结束当前 webview 任务并释放。若 only_for_task_id 为 Some，
/// 仅当当前上下文为该任务时执行，否则直接返回（用于取消时只释放对应任务）。
pub async fn crawl_exit_with_status(status: &str, only_for_task_id: Option<&str>) {
    let state = crawler_window_state();
    let Some(ctx) = state.get_context().await else {
        return;
    };
    if let Some(id) = only_for_task_id {
        if ctx.task_id != id {
            return;
        }
    }

    let end = now_ms();
    update_task_status(&ctx.task_id, status, Some(end), None);
    GlobalEmitter::global().emit_task_status(
        &ctx.task_id,
        status,
        None,
        None,
        Some(end),
        None,
        None,
    );
    TaskScheduler::global().page_stacks().remove_stack(&ctx.task_id);
    let _ = state.release_task(&ctx.task_id).await;
}

#[tauri::command]
pub async fn crawl_exit() -> Result<(), String> {
    crawl_exit_with_status("completed", None).await;
    Ok(())
}

#[tauri::command]
pub async fn crawl_error(message: String) -> Result<(), String> {
    let state = crawler_window_state();
    let Some(ctx) = state.get_context().await else {
        return Ok(());
    };

    let end = now_ms();
    let err = if message.trim().is_empty() {
        "Unknown crawl.js error".to_string()
    } else {
        message
    };
    // 用户取消时脚本可能调用 ctx.error("Task canceled")，应显示为“已取消”而非“失败”
    let status = if err.contains("Task canceled") {
        "canceled"
    } else {
        "failed"
    };
    update_task_status(&ctx.task_id, status, Some(end), Some(err.clone()));
    GlobalEmitter::global().emit_task_error(&ctx.task_id, &err);
    GlobalEmitter::global().emit_task_status(
        &ctx.task_id,
        status,
        None,
        None,
        Some(end),
        Some(err.as_str()),
        None,
    );
    TaskScheduler::global().page_stacks().remove_stack(&ctx.task_id);
    let _ = state.release_task(&ctx.task_id).await;
    Ok(())
}

#[tauri::command]
pub async fn crawl_task_log(message: String, level: Option<String>) -> Result<(), String> {
    let state = crawler_window_state();
    let Some(ctx) = state.get_context().await else {
        return Ok(());
    };
    let lvl = level.as_deref().unwrap_or("print");
    GlobalEmitter::global().emit_task_log(&ctx.task_id, lvl, &message);
    Ok(())
}

#[tauri::command]
pub async fn crawl_add_progress(percentage: f64) -> Result<(), String> {
    let state = crawler_window_state();
    let Some(ctx) = state.get_context().await else {
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

#[tauri::command]
pub async fn crawl_download_image(
    app: AppHandle,
    url: String,
    cookie: Option<bool>,
    headers: Option<HashMap<String, String>>,
) -> Result<(), String> {
    let state = crawler_window_state();
    let Some(ctx) = state.get_context().await else {
        return Err("Crawler context not found".to_string());
    };

    let dq = TaskScheduler::global().download_queue();
    if dq.is_task_canceled(&ctx.task_id).await {
        return Err("Task canceled".to_string());
    }

    let target_url = resolve_target_url(&url, ctx.current_url.as_deref(), &ctx.base_url)?;
    let parsed = Url::parse(&target_url).map_err(|e| format!("Invalid URL: {}", e))?;
    let images_dir = PathBuf::from(&ctx.images_dir);
    let download_start_time = now_ms();
    let cookie_header = if cookie.unwrap_or(false) {
        let crawler_window = app
            .get_webview_window("crawler")
            .ok_or_else(|| "Crawler window not found".to_string())?;
        let page_url = ctx
            .current_url
            .as_deref()
            .map(|u| Url::parse(u))
            .transpose()
            .ok()
            .flatten();
        let mut cookie_map = std::collections::BTreeMap::<String, String>::new();
        for cookie_url in [Some(parsed.clone()), page_url].into_iter().flatten() {
            if let Ok(cookies) = crawler_window.cookies_for_url(cookie_url) {
                for c in cookies {
                    cookie_map
                        .entry(c.name().to_string())
                        .or_insert_with(|| c.value().to_string());
                }
            }
        }
        if cookie_map.is_empty() {
            None
        } else {
            Some(
                cookie_map
                    .iter()
                    .map(|(k, v)| format!("{k}={v}"))
                    .collect::<Vec<_>>()
                    .join("; "),
            )
        }
    } else {
        None
    };
    let mut request_headers = headers.unwrap_or_default();
    if let Some(ref page_url) = ctx.current_url {
        if !page_url.trim().is_empty() {
            request_headers.insert("Referer".to_string(), page_url.clone());
        }
    }
    let merged_headers = merge_task_headers(&ctx.task_id, Some(request_headers), cookie_header)?;
    dq.download_image(
        parsed,
        images_dir,
        ctx.plugin_id.clone(),
        ctx.task_id.clone(),
        download_start_time,
        ctx.output_album_id.clone(),
        merged_headers,
    )
    .await
}

#[tauri::command]
pub async fn crawl_register_blob_download(
    payload: CrawlRegisterBlobDownloadPayload,
) -> Result<(), String> {
    let state = crawler_window_state();
    let Some(ctx) = state.get_context().await else {
        return Err("Crawler context not found".to_string());
    };
    if !BrowserDownloadState::global().is_pending_for_task(&payload.download_id, &ctx.task_id) {
        return Err(format!(
            "Browser download {} does not belong to current task {}",
            payload.download_id, ctx.task_id
        ));
    }
    let result = BrowserDownloadState::global().register_blob_url(&payload.download_id, &payload.blob_url);
    result
}

#[tauri::command]
pub async fn crawl_browser_download_failed(
    payload: CrawlBrowserDownloadFailedPayload,
) -> Result<(), String> {
    let state = crawler_window_state();
    let Some(ctx) = state.get_context().await else {
        return Err("Crawler context not found".to_string());
    };
    if !BrowserDownloadState::global().is_pending_for_task(&payload.download_id, &ctx.task_id) {
        return Err(format!(
            "Browser download {} does not belong to current task {}",
            payload.download_id, ctx.task_id
        ));
    }
    let msg = payload
        .error
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "Browser download failed".to_string());
    BrowserDownloadState::global().signal_failure(&payload.download_id, msg)
}

#[tauri::command]
pub async fn crawl_update_page_state(patch: Value) -> Result<(), String> {
    let state = crawler_window_state();
    let Some(ctx) = state.get_context().await else {
        return Err("Crawler context not found".to_string());
    };
    let task_id = ctx.task_id.clone();
    let patch_obj = page_state_plain_object(Some(&patch));
    let merged = merge_page_state(ctx.page_state.as_ref(), &patch_obj);
    state
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
pub async fn crawl_update_state(patch: Value) -> Result<(), String> {
    let state = crawler_window_state();
    let Some(ctx) = state.get_context().await else {
        return Err("Crawler context not found".to_string());
    };
    let task_id = ctx.task_id.clone();
    let patch_obj = state_plain_object(Some(&patch));
    let merged = merge_state(ctx.state.as_ref(), &patch_obj);
    state
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
pub async fn crawl_page_ready() -> Result<(), String> {
    let state = crawler_window_state();
    let Some(_) = state.get_context().await else {
        return Err("Crawler context not found".to_string());
    };
    state.set_page_ready(false);
    state.set_page_ready(true);
    Ok(())
}

/// 清空「当前站点」数据：删除该 URL 对应 origin 下的所有 Cookie（localStorage/sessionStorage 由前端 clear() 内清除）。
#[tauri::command]
pub async fn crawl_clear_site_data(app: AppHandle, url: String) -> Result<(), String> {
    let parsed =
        Url::parse(url.trim()).map_err(|e| format!("Invalid URL for clear_site_data: {}", e))?;
    let crawler_window = app
        .get_webview_window("crawler")
        .ok_or_else(|| "Crawler window not found".to_string())?;
    let cookies = crawler_window
        .cookies_for_url(parsed)
        .map_err(|e| format!("Failed to get cookies: {}", e))?;
    for cookie in cookies {
        let _ = crawler_window.delete_cookie(cookie);
    }
    Ok(())
}

#[tauri::command]
pub async fn crawl_to(app: AppHandle, payload: CrawlToPayload) -> Result<(), String> {
    let state = crawler_window_state();
    let Some(ctx) = state.get_context().await else {
        return Err("Crawler context not found".to_string());
    };

    let target_url = resolve_target_url(&payload.url, ctx.current_url.as_deref(), &ctx.base_url)?;
    let task_id = ctx.task_id.clone();
    let stack = get_page_stack(&task_id)?;
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
                url: ctx.current_url.clone().unwrap_or_else(|| ctx.base_url.clone()),
                html: String::new(),
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
            page_label: new_page_label.clone(),
            page_state: new_page_state.clone(),
        });
    }
    state
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

    let crawler_window = app
        .get_webview_window("crawler")
        .ok_or_else(|| "Crawler window not found".to_string())?;
    let parsed = url::Url::parse(&target_url)
        .map_err(|e| format!("Invalid target URL '{}': {}", target_url, e))?;
    state.set_page_ready(false);
    crawler_window
        .navigate(parsed)
        .map_err(|e| format!("Failed to navigate crawler window: {}", e))?;
    Ok(())
}

#[tauri::command]
pub async fn crawl_back(app: AppHandle, count: Option<usize>) -> Result<(), String> {
    let count = count.unwrap_or(1);
    if count == 0 {
        return Err("count must be >= 1".to_string());
    }
    let state = crawler_window_state();
    let Some(ctx) = state.get_context().await else {
        return Err("Crawler context not found".to_string());
    };
    let stack = get_page_stack(&ctx.task_id)?;
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
    state
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
    let crawler_window = app
        .get_webview_window("crawler")
        .ok_or_else(|| "Crawler window not found".to_string())?;
    let parsed = url::Url::parse(&previous_url)
        .map_err(|e| format!("Invalid target URL '{}': {}", previous_url, e))?;
    state.set_page_ready(false);
    crawler_window
        .navigate(parsed)
        .map_err(|e| format!("Failed to navigate crawler window: {}", e))?;
    Ok(())
}

#[tauri::command]
pub fn show_crawler_window(app: AppHandle) -> Result<(), String> {
    if crawler_window_state().try_get_context().is_none() {
        return Err("爬虫 WebView 窗口当前为空，没有爬虫插件在占用，先运行一个爬虫插件吧".to_string());
    }
    let crawler_window = app
        .get_webview_window("crawler")
        .ok_or_else(|| "Crawler window not found".to_string())?;
    crawler_window
        .show()
        .map_err(|e| format!("Failed to show crawler window: {}", e))?;
    crawler_window
        .set_focus()
        .map_err(|e| format!("Failed to focus crawler window: {}", e))?;
    Ok(())
}
