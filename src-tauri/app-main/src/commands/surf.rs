use kabegame_i18n::t;
use kabegame_core::crawler::downloader::{
    compute_native_download_destination, get_default_images_dir, postprocess_downloaded_image,
    NativeDownloadEntry, NativeDownloadState,
};
use kabegame_core::crawler::favicon::fetch_favicon;
use kabegame_core::emitter::GlobalEmitter;
use kabegame_core::storage::{RangedSurfRecords, Storage, SurfRecord};
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri::Emitter;
use tauri::webview::{DownloadEvent, PageLoadEvent};

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SurfSessionStatus {
    pub active: bool,
    pub surf_record_id: Option<String>,
    pub host: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct SurfSessionState {
    current_record_id: Option<String>,
    current_host: Option<String>,
}

impl SurfSessionState {
    pub fn global() -> &'static Mutex<SurfSessionState> {
        static INSTANCE: OnceLock<Mutex<SurfSessionState>> = OnceLock::new();
        INSTANCE.get_or_init(|| Mutex::new(SurfSessionState::default()))
    }
}

fn parse_external_url(raw: &str) -> Result<url::Url, String> {
    let parsed = url::Url::parse(raw).map_err(|e| format!("无效 URL: {}", e))?;
    let scheme = parsed.scheme();
    if scheme != "http" && scheme != "https" {
        return Err("仅支持 http 或 https URL".to_string());
    }
    Ok(parsed)
}

fn resolve_root_url(parsed: &url::Url) -> String {
    let mut root = parsed.clone();
    root.set_path("/");
    root.set_query(None);
    root.set_fragment(None);
    root.to_string()
}

fn eval_surf_toast(app: &AppHandle, message: &str, kind: &str) {
    if let Some(win) = app.get_webview_window("surf") {
        let msg_json =
            serde_json::to_string(message).unwrap_or_else(|_| "\"下载失败\"".to_string());
        let kind_json = serde_json::to_string(kind).unwrap_or_else(|_| "\"failed\"".to_string());
        let script = format!("window.__kabegame_toast?.({}, {});", msg_json, kind_json);
        let _ = win.eval(script.as_str());
    }
}

/// 由 surf 导航栏注入脚本通过 `invoke` 调用，打开当前畅游窗口的开发者工具。
#[cfg(not(target_os = "android"))]
#[tauri::command]
pub async fn surf_open_devtools(app: AppHandle) -> Result<(), String> {
    let win = app
        .get_webview_window("surf")
        .ok_or_else(|| "畅游窗口未打开".to_string())?;
    win.open_devtools();
    Ok(())
}

fn save_surf_session_cookies(app: &AppHandle) {
    let record_id = SurfSessionState::global()
        .lock()
        .ok()
        .and_then(|g| g.current_record_id.clone());
    let Some(record_id) = record_id else {
        return;
    };
    let Some(surf_window) = app.get_webview_window("surf") else {
        return;
    };
    let Ok(Some(record)) = Storage::global().get_surf_record(&record_id) else {
        return;
    };
    let Ok(parsed) = url::Url::parse(&record.root_url) else {
        return;
    };
    let Ok(cookies) = surf_window.cookies_for_url(parsed) else {
        return;
    };
    let mut pairs: Vec<String> = Vec::new();
    for c in cookies {
        pairs.push(format!("{}={}", c.name(), c.value()));
    }
    let cookie_string = pairs.join("; ");
    let _ = Storage::global().update_surf_record_cookie(&record_id, &cookie_string);
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub async fn surf_start_session(app: AppHandle, url: String) -> Result<serde_json::Value, String> {
    let parsed = parse_external_url(url.trim())?;
    let host = parsed
        .host_str()
        .ok_or_else(|| "URL 缺少 host".to_string())?
        .to_lowercase();
    let root_url = resolve_root_url(&parsed);

    let storage = Storage::global();
    let mut record = storage.get_or_create_surf_record(&host, &root_url)?;
    storage.update_surf_record_visit(&record.id)?;
    if let Some(updated) = storage.get_surf_record(&record.id)? {
        record = updated;
    }

    if let Ok(mut guard) = SurfSessionState::global().lock() {
        guard.current_record_id = Some(record.id.clone());
        guard.current_host = Some(host.clone());
    }

    if app.get_webview_window("surf").is_none() {
        let builder = WebviewWindowBuilder::new(&app, "surf", WebviewUrl::External(parsed))
            .title(t!("surf.windowTitle", host = host.as_str()))
            .inner_size(1200.0, 800.0)
            .devtools(true)
            .initialization_script(include_str!("../../resources/surf_toast.js"))
            .initialization_script(include_str!("../../resources/surf_context_menu.js"))
            .initialization_script(include_str!("../../resources/surf_navbar.js"))
            .on_page_load({
                let app = app.clone();
                move |_surf_window, payload| {
                    if payload.event() == PageLoadEvent::Finished {
                        // cookies_for_url 内部使用 wait_with_pump（重入 Win32 消息泵），
                        // 不能在 WebView2 COM 事件回调（UI线程）中同步调用，否则可能与
                        // NewWindowRequested 等其他 COM 事件交叉导致死锁。
                        // 移到 blocking 线程执行。
                        let app = app.clone();
                        tauri::async_runtime::spawn_blocking(move || {
                            save_surf_session_cookies(&app);
                        });
                    }
                }
            })
            .on_download({
                let app = app.clone();
                move |_webview, event| match event {
                    DownloadEvent::Requested { url, destination } => {
                        let surf_record_id = SurfSessionState::global()
                            .lock()
                            .ok()
                            .and_then(|g| g.current_record_id.clone());

                        let Some(surf_record_id) = surf_record_id else {
                            return false;
                        };

                        let images_dir = get_default_images_dir();
                        if std::fs::create_dir_all(&images_dir).is_err() {
                            return false;
                        }
                        let effective_url = if url.scheme() == "blob" {
                            url.as_str().strip_prefix("blob:").unwrap_or(url.as_str()).to_string()
                        } else {
                            url.as_str().to_string()
                        };

                        let native_dest =
                            match compute_native_download_destination(&effective_url, &images_dir) {
                                Ok(p) => p,
                                Err(_) => {
                                    return false;
                                }
                            };
                        let download_start_time = std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .map(|d| d.as_millis() as u64)
                            .unwrap_or(0);
                        let entry = NativeDownloadEntry {
                            destination: native_dest.clone(),
                            task_id: None,
                            surf_record_id: Some(surf_record_id.clone()),
                            plugin_id: String::new(),
                            output_album_id: None,
                            download_start_time,
                        };

                        if NativeDownloadState::global()
                            .register(url.as_str(), entry)
                            .is_err()
                        {
                            return false;
                        }

                        GlobalEmitter::global().emit_download_state_with_native(
                            &surf_record_id,
                            url.as_str(),
                            download_start_time,
                            "",
                            "downloading",
                            None,
                            true,
                        );

                        eval_surf_toast(&app, "开始下载", "start");
                        *destination = native_dest;
                        true
                    }
                    DownloadEvent::Finished { url, path, success } => {
                        let Some(entry) = NativeDownloadState::global().take(url.as_str()) else {
                            return true;
                        };
                        if success {
                            let app2 = app.clone();
                            let final_path = path.unwrap_or_else(|| entry.destination.clone());
                            let url_str = url.to_string();
                            tauri::async_runtime::spawn(async move {
                                let surf_record_id = entry.surf_record_id.clone();
                                let empty_headers = std::collections::HashMap::new();
                                match postprocess_downloaded_image(
                                    &final_path,
                                    &url_str,
                                    &entry.plugin_id,
                                    entry.task_id.as_deref(),
                                    None,
                                    surf_record_id.as_deref(),
                                    entry.download_start_time,
                                    None,
                                    &empty_headers,
                                    true,
                                    None,
                                    None,
                                    None,
                                )
                                .await
                                {
                                    Ok(inserted) => {
                                        if let Some(id) = surf_record_id.as_deref() {
                                            if inserted {
                                                let _ = Storage::global()
                                                    .increment_surf_record_download_count(id);
                                                eval_surf_toast(&app2, "下载成功", "success");
                                            } else {
                                                eval_surf_toast(&app2, "下载失败（重复或未入库）", "failed");
                                            }
                                        } else {
                                            eval_surf_toast(&app2, "下载失败", "failed");
                                        }
                                    }
                                    Err(_) => {
                                        eval_surf_toast(&app2, "下载失败", "failed");
                                    }
                                }
                            });
                        } else {
                            let event_task_id = entry
                                .task_id
                                .as_deref()
                                .or(entry.surf_record_id.as_deref())
                                .unwrap_or_default();
                            GlobalEmitter::global().emit_download_state_with_native(
                                event_task_id,
                                url.as_str(),
                                entry.download_start_time,
                                &entry.plugin_id,
                                "failed",
                                Some("Native download finished with failure"),
                                true,
                            );
                            eval_surf_toast(&app, "下载失败", "failed");
                        }
                        true
                    }
                    _ => true,
                }
            });
        let window = builder
            .build()
            .map_err(|e| format!("创建 surf 窗口失败: {}", e))?;
        let _ = window.show();
        let _ = window.set_focus();
    } else if let Some(win) = app.get_webview_window("surf") {
        let _ = win.navigate(parsed);
        let _ = win.show();
        let _ = win.set_focus();
    }

    let _ = app.emit(
        "surf-session-changed",
        serde_json::json!({ "active": true, "surfRecordId": record.id.clone() }),
    );

    let app_for_icon = app.clone();
    let record_id_for_icon = record.id.clone();
    tauri::async_runtime::spawn(async move {
        if let Some(icon) = fetch_favicon(&host).await {
            if Storage::global()
                .update_surf_record_icon(&record_id_for_icon, &icon)
                .is_ok()
            {
                let _ = app_for_icon.emit(
                    "surf-records-change",
                    serde_json::json!({ "reason": "icon-updated", "surfRecordId": record_id_for_icon }),
                );
            }
        }
    });

    serde_json::to_value(record).map_err(|e| e.to_string())
}

/// 在会话窗口被关闭时由 lib 的 on_window_event 调用，清除状态并通知前端。
#[cfg(not(target_os = "android"))]
pub fn notify_surf_session_closed(app: &AppHandle) {
    if let Ok(mut guard) = SurfSessionState::global().lock() {
        guard.current_record_id = None;
        guard.current_host = None;
    }
    let _ = app.emit(
        "surf-session-changed",
        serde_json::json!({ "active": false, "surfRecordId": null }),
    );
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub async fn surf_close_session(app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("surf") {
        let _ = win.close();
    }
    notify_surf_session_closed(&app);
    Ok(())
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub async fn surf_get_session_status(app: AppHandle) -> Result<SurfSessionStatus, String> {
    let active_window = app.get_webview_window("surf").is_some();
    if !active_window {
        if let Ok(mut guard) = SurfSessionState::global().lock() {
            guard.current_record_id = None;
            guard.current_host = None;
        }
    }
    let guard = SurfSessionState::global()
        .lock()
        .map_err(|e| format!("Lock error: {}", e))?;
    Ok(SurfSessionStatus {
        active: active_window && guard.current_record_id.is_some(),
        surf_record_id: guard.current_record_id.clone(),
        host: guard.current_host.clone(),
    })
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub async fn surf_list_records(offset: usize, limit: usize) -> Result<RangedSurfRecords, String> {
    let page_limit = if limit == 0 { 10 } else { limit };
    Storage::global().list_surf_records(offset, page_limit)
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub async fn surf_get_record(id: String) -> Result<Option<SurfRecord>, String> {
    Storage::global().get_surf_record(&id)
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub async fn surf_get_record_images(
    id: String,
    offset: usize,
    limit: usize,
) -> Result<serde_json::Value, String> {
    let page_limit = if limit == 0 { 50 } else { limit };
    let images = Storage::global().get_surf_record_images(&id, offset, page_limit)?;
    serde_json::to_value(images).map_err(|e| e.to_string())
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub async fn surf_update_root_url(id: String, root_url: String) -> Result<(), String> {
    Storage::global().update_surf_record_root_url(&id, &root_url)
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub async fn surf_update_name(id: String, name: String) -> Result<(), String> {
    Storage::global().update_surf_record_name(&id, &name)
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub async fn surf_delete_record(id: String) -> Result<(), String> {
    Storage::global().delete_surf_record(&id)
}

/// 返回当前畅游会话对应站点的 Cookie（与浏览器请求头中发送的一致，含 HttpOnly）。
#[cfg(not(target_os = "android"))]
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SurfCookiesResult {
    pub cookie_string: String,
    pub host: Option<String>,
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub async fn surf_get_cookies(app: AppHandle) -> Result<SurfCookiesResult, String> {
    let surf_window = app
        .get_webview_window("surf")
        .ok_or_else(|| "畅游窗口未打开".to_string())?;
    let (record_id, host) = {
        let guard = SurfSessionState::global()
            .lock()
            .map_err(|e| format!("Lock error: {}", e))?;
        let record_id = guard
            .current_record_id
            .clone()
            .ok_or_else(|| "当前无畅游会话".to_string())?;
        let host = guard.current_host.clone();
        (record_id, host)
    };

    let record = Storage::global()
        .get_surf_record(&record_id)?
        .ok_or_else(|| "畅游记录不存在".to_string())?;
    let parsed = url::Url::parse(&record.root_url).map_err(|e| format!("无效 root_url: {}", e))?;

    let cookies = surf_window
        .cookies_for_url(parsed)
        .map_err(|e| format!("获取 Cookie 失败: {}", e))?;
    let mut pairs: Vec<String> = Vec::new();
    for c in cookies {
        pairs.push(format!("{}={}", c.name(), c.value()));
    }
    let cookie_string = pairs.join("; ");
    Ok(SurfCookiesResult {
        cookie_string,
        host,
    })
}
