use kabegame_core::app_paths::AppPaths;
use kabegame_core::crawler::downloader::{
    get_default_images_dir, next_download_id, postprocess_downloaded_image, ActiveDownloadInfo,
    DownloadState,
};
use kabegame_core::crawler::favicon::fetch_favicon;
use kabegame_core::crawler::TaskScheduler;
use kabegame_core::storage::{RangedSurfRecords, Storage, SurfRecord};
use kabegame_i18n::t;
use std::collections::HashMap;
use tauri::webview::{DownloadEvent, NewWindowResponse, PageLoadEvent, WebviewBuilder};
use tauri::Emitter;
use tauri::{
    AppHandle, LogicalPosition, LogicalSize, Manager, Runtime, Webview, WebviewUrl,
    WebviewWindowBuilder,
};

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SurfSessionStatus {
    pub active: bool,
    /// 当前畅游站点 host（对外索引键，与路由 `/surf/:host/images` 一致）
    pub surf_host: Option<String>,
}

fn parse_external_url(raw: &str) -> Result<url::Url, String> {
    let parsed = url::Url::parse(raw).map_err(|e| format!("无效 URL: {}", e))?;
    let scheme = parsed.scheme();
    if scheme != "http" && scheme != "https" {
        return Err("仅支持 http 或 https URL".to_string());
    }
    Ok(parsed)
}

/// 新建畅游记录时写入的「根 URL」：与用户输入一致（保留 path、query），仅去掉 fragment。
fn resolve_root_url(parsed: &url::Url) -> String {
    let mut root = parsed.clone();
    root.set_fragment(None);
    root.to_string()
}

/// RFC6265 风格的域匹配：`.example.com` 与 `www.example.com` 等子域。
fn cookie_domain_matches_site_host(cookie_domain: &str, site_host: &str) -> bool {
    let cd = cookie_domain.trim_start_matches('.').to_lowercase();
    let rh = site_host.to_lowercase();
    cd == rh || rh.ends_with(&format!(".{}", cd))
}

/// 合并 `cookies_for_url(root)` 与全量 `cookies()` 中域属于本站点的项。
/// 仅 `cookies_for_url(www)` 时，部分 WebView 实现会漏掉与登录相关的 Cookie（开发者工具仍可见）。
///
/// 注意：surf 窗口带 navbar 子 webview，不再是 Tauri 的 `WebviewWindow`
/// （`is_webview_window()` 为 false），必须用 `Webview` 级 API 操作内容页。
fn collect_surf_cookie_string<R: Runtime>(
    surf_webview: &Webview<R>,
    site_host: &str,
    root_url: &str,
) -> Result<String, String> {
    let mut merged: HashMap<String, String> = HashMap::new();

    if let Ok(parsed) = url::Url::parse(root_url) {
        if let Ok(for_url) = surf_webview.cookies_for_url(parsed) {
            for c in for_url {
                merged.insert(c.name().to_string(), c.value().to_string());
            }
        }
    }

    let all = surf_webview
        .cookies()
        .map_err(|e| format!("获取 Cookie 失败: {}", e))?;
    for c in all {
        let Some(d) = c.domain().filter(|s| !s.is_empty()) else {
            continue;
        };
        if cookie_domain_matches_site_host(d, site_host) {
            merged.insert(c.name().to_string(), c.value().to_string());
        }
    }

    let mut pairs: Vec<String> = merged
        .into_iter()
        .map(|(k, v)| format!("{}={}", k, v))
        .collect();
    pairs.sort();
    Ok(pairs.join("; "))
}

fn eval_surf_toast<R: Runtime>(app: &AppHandle<R>, message: &str, kind: &str) {
    if let Some(webview) = app
        .webviews()
        .into_iter()
        .find_map(|(label, webview)| is_surf_content_label(&label).then_some(webview))
    {
        let msg_json =
            serde_json::to_string(message).unwrap_or_else(|_| "\"下载失败\"".to_string());
        let kind_json = serde_json::to_string(kind).unwrap_or_else(|_| "\"failed\"".to_string());
        let script = format!("window.__kabegame_toast?.({}, {});", msg_json, kind_json);
        let _ = webview.eval(script.as_str());
    }
}

fn eval_surf_toast_for_host<R: Runtime>(app: &AppHandle<R>, host: &str, message: &str, kind: &str) {
    if let Some(webview) = app.get_webview(&surf_label(host)) {
        let msg_json =
            serde_json::to_string(message).unwrap_or_else(|_| "\"下载失败\"".to_string());
        let kind_json = serde_json::to_string(kind).unwrap_or_else(|_| "\"failed\"".to_string());
        let script = format!("window.__kabegame_toast?.({}, {});", msg_json, kind_json);
        let _ = webview.eval(script.as_str());
    }
}

fn surf_label(host: &str) -> String {
    // Tauri window labels only allow [a-zA-Z0-9-/:_]; replace '.' with '_'
    format!("surf-{}", host.trim().to_lowercase().replace('.', "_"))
}

fn surf_navbar_label(host: &str) -> String {
    format!("{}-navbar", surf_label(host))
}

fn is_surf_content_label(label: &str) -> bool {
    label.starts_with("surf-") && !label.ends_with("-navbar")
}

fn host_from_surf_label(label: &str) -> Option<String> {
    label
        .strip_prefix("surf-")
        .filter(|s| !s.ends_with("-navbar"))
        .filter(|s| !s.is_empty())
        .map(|s| s.replace('_', "."))
}

fn encode_query_value(value: &str) -> String {
    url::form_urlencoded::byte_serialize(value.as_bytes()).collect()
}

fn surf_content_webview<R: Runtime>(
    app: &AppHandle<R>,
    host: Option<&str>,
) -> Result<Webview<R>, String> {
    if let Some(host) = host {
        let host = normalize_surf_host(host);
        return app
            .get_webview(&surf_label(&host))
            .ok_or_else(|| "畅游窗口未打开".to_string());
    }

    app.webviews()
        .into_iter()
        .find_map(|(label, webview)| is_surf_content_label(&label).then_some(webview))
        .ok_or_else(|| "畅游窗口未打开".to_string())
}

/// 由 surf 导航栏通过 `invoke` 调用，打开对应畅游内容 webview 的开发者工具。
#[cfg(not(target_os = "android"))]
#[tauri::command]
pub async fn surf_open_devtools<R: Runtime>(
    app: AppHandle<R>,
    host: Option<String>,
) -> Result<(), String> {
    let webview = surf_content_webview(&app, host.as_deref())?;
    webview.open_devtools();
    Ok(())
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub async fn surf_go_back<R: Runtime>(app: AppHandle<R>, host: String) -> Result<(), String> {
    let webview = surf_content_webview(&app, Some(&host))?;
    webview
        .eval("history.back()")
        .map_err(|e| format!("后退失败: {}", e))
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub async fn surf_go_forward<R: Runtime>(app: AppHandle<R>, host: String) -> Result<(), String> {
    let webview = surf_content_webview(&app, Some(&host))?;
    webview
        .eval("history.forward()")
        .map_err(|e| format!("前进失败: {}", e))
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub async fn surf_reload<R: Runtime>(app: AppHandle<R>, host: String) -> Result<(), String> {
    let webview = surf_content_webview(&app, Some(&host))?;
    webview
        .eval("location.reload()")
        .map_err(|e| format!("刷新失败: {}", e))
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub async fn surf_navigate<R: Runtime>(
    app: AppHandle<R>,
    host: String,
    url: String,
) -> Result<(), String> {
    let parsed = parse_external_url(url.trim())?;
    let webview = surf_content_webview(&app, Some(&host))?;
    webview
        .navigate(parsed)
        .map_err(|e| format!("导航失败: {}", e))
}

/// 内容页脚本(surf_url_report.js)在 SPA 导航(pushState 等)时调用,
/// 把当前 URL 转发给同窗口导航栏。这类导航不触发 page load,
/// 仅靠 on_page_load 时导航栏地址会停在旧值。
#[cfg(not(target_os = "android"))]
#[tauri::command]
pub async fn surf_report_url<R: Runtime>(
    app: AppHandle<R>,
    webview: Webview<R>,
    url: String,
) -> Result<(), String> {
    let label = webview.label().to_string();
    if !is_surf_content_label(&label) {
        return Err(format!("Not a surf content webview: {label}"));
    }
    let _ = app.emit_to(format!("{label}-navbar").as_str(), "surf-url-changed", url);
    Ok(())
}

fn save_surf_session_cookies_for_host<R: Runtime>(app: &AppHandle<R>, host: &str) {
    let Some(surf_webview) = app.get_webview(&surf_label(host)) else {
        return;
    };
    let Ok(Some(record)) = Storage::global().get_surf_record_by_host(host) else {
        return;
    };
    let site_host = record.host.as_str();
    let root_url = record.root_url.as_str();
    let Ok(cookie_string) = collect_surf_cookie_string(&surf_webview, site_host, root_url) else {
        return;
    };
    let _ = Storage::global().update_surf_record_cookie(&record.id, &cookie_string);
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub async fn surf_start_session<R: Runtime>(
    app: AppHandle<R>,
    url: String,
) -> Result<serde_json::Value, String> {
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

    let label = surf_label(&host);
    // surf 窗口含 navbar 子 webview,不是 WebviewWindow;按窗口 label 查 Window。
    if let Some(win) = app.get_window(&label) {
        let _ = win.show();
        let _ = win.set_focus();
    } else {
        let host_for_plugin_id = host.clone();
        let record_id_for_download = record.id.clone();
        let navbar_label = surf_navbar_label(&host);
        let media_capture = include_str!("../webview_js/media_capture.js");
        let media_download = include_str!("../webview_js/media_download.js");
        let builder = WebviewWindowBuilder::new(&app, &label, WebviewUrl::External(parsed))
            .title(t!("surf.windowTitle", host = host.as_str()))
            .inner_size(1200.0, 800.0)
            .devtools(true)
            .initialization_script(media_capture)
            .initialization_script(media_download)
            .initialization_script(include_str!("../webview_js/surf_bootstrap.js"))
            .initialization_script(include_str!("../webview_js/surf_toast.js"))
            .initialization_script(include_str!("../webview_js/surf_context_menu.js"))
            .initialization_script(include_str!("../webview_js/surf_url_report.js"))
            .on_page_load({
                let app = app.clone();
                let host = host.clone();
                let navbar_label = navbar_label.clone();
                move |_surf_window, payload| {
                    // Started 也上报:整页导航一发起地址栏即更新,不必等加载完;
                    // SPA 内部跳转(pushState 等)不经过这里,由 surf_report_url 补上。
                    let _ = app.emit_to(
                        navbar_label.as_str(),
                        "surf-url-changed",
                        payload.url().as_str(),
                    );
                    if payload.event() == PageLoadEvent::Finished {
                        // cookies_for_url 内部使用 wait_with_pump（重入 Win32 消息泵），
                        // 不能在 WebView2 COM 事件回调（UI线程）中同步调用，否则可能与
                        // NewWindowRequested 等其他 COM 事件交叉导致死锁。
                        // 移到 blocking 线程执行。
                        let app = app.clone();
                        let host = host.clone();
                        tauri::async_runtime::spawn_blocking(move || {
                            save_surf_session_cookies_for_host(&app, &host);
                        });
                    }
                }
            })
            .on_new_window({
                let app = app.clone();
                let label = label.clone();
                move |url, features| {
                    let scheme = url.scheme();
                    // 真正的 window.open(url, name, "width=..,height=..") 弹窗(OAuth 登录、
                    // 分享等)会带上窗口尺寸;此类流程依赖 window.open() 返回可用的
                    // WindowProxy 并与 opener 双向 postMessage(如 Google Identity
                    // Services),Deny 后 window.open() 返回 null,页面会在
                    // popup.postMessage 处抛 "Cannot read properties of null" 并白屏。
                    // 放行为真实弹窗。(CEF runtime 该闭包不被调用,弹窗裁决见
                    // tauri-runtime-cef 的 PopupToNavigationLifeSpanHandler。)
                    if matches!(scheme, "http" | "https") && features.size().is_some() {
                        return NewWindowResponse::Allow;
                    }
                    // 其余(target="_blank"、无尺寸的 window.open):维持 surf 单窗口语义,
                    // http/https 目标改在当前窗口内导航。
                    if matches!(scheme, "http" | "https") {
                        if let Some(webview) = app.get_webview(&label) {
                            let _ = webview.navigate(url);
                        }
                    }
                    NewWindowResponse::Deny
                }
            })
            .on_navigation(|url| {
                !TaskScheduler::global()
                    .download_queue()
                    .contains_native(url.as_str())
            })
            .on_download({
                let app = app.clone();
                let host = host_for_plugin_id.clone();
                let surf_record_id = record_id_for_download.clone();
                move |_webview, event| match event {
                    DownloadEvent::Requested { url, destination } => {
                        let images_dir = get_default_images_dir();
                        if std::fs::create_dir_all(&images_dir).is_err() {
                            return false;
                        }
                        let dq = TaskScheduler::global().download_queue();
                        if let Some(entry) = dq.get_native(url.as_str()) {
                            let temp_dir = AppPaths::global().downloads_temp_dir();
                            if std::fs::create_dir_all(&temp_dir).is_err() {
                                return false;
                            }
                            *destination = temp_dir.join(format!("surf-native-{}.part", entry.id));
                            let dq2 = dq.clone();
                            let entry_id = entry.id;
                            tauri::async_runtime::spawn(async move {
                                dq2.switch_state(entry_id, DownloadState::Downloading, None)
                                    .await;
                            });
                        } else {
                            let download_start_time = std::time::SystemTime::now()
                                .duration_since(std::time::UNIX_EPOCH)
                                .map(|d| d.as_millis() as u64)
                                .unwrap_or(0);
                            let download_id = next_download_id();
                            let temp_dir = AppPaths::global().downloads_temp_dir();
                            if std::fs::create_dir_all(&temp_dir).is_err() {
                                return false;
                            }
                            let native_dest =
                                temp_dir.join(format!("surf-native-{}.part", download_id));
                            let entry = ActiveDownloadInfo {
                                id: download_id,
                                url: url.as_str().to_string(),
                                plugin_id: host_for_plugin_id.clone(),
                                start_time: download_start_time,
                                task_id: String::new(),
                                state: DownloadState::Downloading,
                                native: true,
                                retried_for: None,
                                received_bytes: 0,
                                total_bytes: None,
                                surf_record_id: Some(surf_record_id.clone()),
                                http_headers: HashMap::new(),
                                output_album_id: None,
                                custom_display_name: None,
                                metadata_id: None,
                                post_url: None,
                            };

                            if dq.register_native(entry.clone()).is_err() {
                                return false;
                            }
                            *destination = native_dest;
                        }

                        eval_surf_toast_for_host(&app, &host, "开始下载", "start");
                        true
                    }
                    DownloadEvent::Finished { url, path, success } => {
                        let dq = TaskScheduler::global().download_queue();
                        let Some(entry) = dq.take_native(url.as_str()) else {
                            return true;
                        };
                        if success {
                            let app2 = app.clone();
                            let host_for_toast = host_for_plugin_id.clone();
                            let Some(final_path) = path else {
                                tauri::async_runtime::spawn(async move {
                                    dq.switch_state(
                                        entry.id,
                                        DownloadState::Failed,
                                        Some("Native download finished without output path"),
                                    )
                                    .await;
                                    dq.wait_then_finish_download(entry.id, false).await;
                                });
                                eval_surf_toast_for_host(
                                    &app,
                                    &host_for_plugin_id,
                                    "下载失败",
                                    "failed",
                                );
                                return true;
                            };
                            tauri::async_runtime::spawn(async move {
                                let dq = TaskScheduler::global().download_queue();
                                let surf_record_id = entry.surf_record_id.clone();
                                let images_dir = get_default_images_dir();
                                dq.switch_state(entry.id, DownloadState::Processing, None)
                                    .await;
                                let result = postprocess_downloaded_image(
                                    &*dq,
                                    entry.id,
                                    kabegame_core::crawler::downloader::PostprocessSource::Path {
                                        path: &final_path,
                                        relocate_to: Some(&images_dir),
                                    },
                                    true,
                                    &url,
                                    &entry.plugin_id,
                                    None,
                                    None,
                                    surf_record_id.as_deref(),
                                    entry.start_time,
                                    None,
                                    &entry.http_headers,
                                    true,
                                    entry.custom_display_name.as_deref(),
                                    entry.metadata_id,
                                    entry.post_url.as_deref(),
                                )
                                .await;
                                if result.is_err() {
                                    let _ = tokio::fs::remove_file(&final_path).await;
                                }
                                dq.wait_then_finish_download(entry.id, false).await;
                                match result {
                                    Ok(inserted) => {
                                        if let Some(id) = surf_record_id.as_deref() {
                                            if inserted {
                                                let _ = Storage::global()
                                                    .increment_surf_record_download_count(id);
                                                eval_surf_toast_for_host(
                                                    &app2,
                                                    &host_for_toast,
                                                    "下载成功",
                                                    "success",
                                                );
                                            } else {
                                                eval_surf_toast_for_host(
                                                    &app2,
                                                    &host_for_toast,
                                                    "下载失败（重复或未入库）",
                                                    "failed",
                                                );
                                            }
                                        } else {
                                            eval_surf_toast_for_host(
                                                &app2,
                                                &host_for_toast,
                                                "下载失败",
                                                "failed",
                                            );
                                        }
                                    }
                                    Err(_) => {
                                        eval_surf_toast_for_host(
                                            &app2,
                                            &host_for_toast,
                                            "下载失败",
                                            "failed",
                                        );
                                    }
                                }
                            });
                        } else {
                            if let Some(path) = path {
                                let _ = std::fs::remove_file(path);
                            }
                            tauri::async_runtime::spawn(async move {
                                dq.switch_state(
                                    entry.id,
                                    DownloadState::Failed,
                                    Some("Native download finished with failure"),
                                )
                                .await;
                                dq.wait_then_finish_download(entry.id, false).await;
                            });
                            eval_surf_toast_for_host(&app, &host, "下载失败", "failed");
                        }
                        true
                    }
                    _ => true,
                }
            });
        let window = builder
            .build()
            .map_err(|e| format!("创建 surf 窗口失败: {}", e))?;
        let navbar_url = WebviewUrl::App(
            format!(
                "surf-navbar.html?host={}&url={}",
                encode_query_value(&host),
                encode_query_value(&root_url)
            )
            .into(),
        );
        let navbar = WebviewBuilder::new(&navbar_label, navbar_url).devtools(true);
        window
            .as_ref()
            .window()
            .add_child(
                navbar,
                LogicalPosition::new(0.0, 0.0),
                LogicalSize::new(1200.0, 40.0),
            )
            .map_err(|e| format!("创建 surf 导航栏失败: {}", e))?;
        let _ = window.show();
        let _ = window.set_focus();
    }

    let _ = app.emit(
        "surf-session-changed",
        serde_json::json!({ "active": true, "surfHost": record.host }),
    );

    let record_id_for_icon = record.id.clone();
    let host_for_icon = host.clone();
    tauri::async_runtime::spawn(async move {
        if let Some(icon) = fetch_favicon(&host_for_icon).await {
            let _ = Storage::global().update_surf_record_icon(&record_id_for_icon, &icon);
            // `update_surf_record_icon` 内已通过 GlobalEmitter 发出 `SurfRecordChanged`（iconChanged）
        }
    });

    serde_json::to_value(record).map_err(|e| e.to_string())
}

/// 在会话窗口被关闭时由 lib 的 on_window_event 调用，清除状态并通知前端。
#[cfg(not(target_os = "android"))]
pub fn notify_surf_session_closed<R: Runtime>(app: &AppHandle<R>, closing_label: Option<&str>) {
    // 用 windows() 而非 webview_windows():surf 窗口含 navbar 子 webview,
    // 不满足 is_webview_window,会被 webview_windows() 过滤掉。
    let surf_host = app
        .windows()
        .into_keys()
        .filter(|label| closing_label != Some(label.as_str()))
        .find_map(|label| host_from_surf_label(&label));
    let _ = app.emit(
        "surf-session-changed",
        serde_json::json!({ "active": surf_host.is_some(), "surfHost": surf_host }),
    );
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub async fn surf_close_session<R: Runtime>(
    app: AppHandle<R>,
    host: Option<String>,
) -> Result<(), String> {
    match host {
        Some(host) => {
            if let Some(win) = app.get_window(&surf_label(&normalize_surf_host(&host))) {
                let _ = win.destroy();
            }
        }
        None => {
            for (label, win) in app.windows() {
                if !label.starts_with("surf-") {
                    continue;
                }
                let _ = win.destroy();
            }
        }
    }
    Ok(())
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub async fn surf_get_session_status<R: Runtime>(
    app: AppHandle<R>,
) -> Result<SurfSessionStatus, String> {
    let surf_host = app
        .windows()
        .into_keys()
        .find_map(|label| host_from_surf_label(&label));
    Ok(SurfSessionStatus {
        active: surf_host.is_some(),
        surf_host,
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
pub async fn surf_get_all_records() -> Result<Vec<SurfRecord>, String> {
    Storage::global().list_all_surf_records()
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub async fn surf_get_records_by_ids(ids: Vec<String>) -> Result<Vec<SurfRecord>, String> {
    let ids: Vec<String> = ids
        .into_iter()
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty())
        .collect();
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let map = Storage::global().get_surf_records_by_ids(&ids)?;
    Ok(ids
        .into_iter()
        .filter_map(|id| map.get(&id).cloned())
        .collect())
}

fn normalize_surf_host(host: &str) -> String {
    host.trim().to_lowercase()
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub async fn surf_get_record(host: String) -> Result<Option<SurfRecord>, String> {
    let host = normalize_surf_host(&host);
    if host.is_empty() {
        return Ok(None);
    }
    Storage::global().get_surf_record_by_host(&host)
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub async fn surf_get_record_images(
    host: String,
    offset: usize,
    limit: usize,
) -> Result<serde_json::Value, String> {
    let host = normalize_surf_host(&host);
    let Some(record) = Storage::global().get_surf_record_by_host(&host)? else {
        return Err("畅游记录不存在".to_string());
    };
    let page_limit = if limit == 0 { 50 } else { limit };
    let images = Storage::global().get_surf_record_images(&record.id, offset, page_limit)?;
    serde_json::to_value(images).map_err(|e| e.to_string())
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub async fn surf_update_root_url(host: String, root_url: String) -> Result<(), String> {
    let host = normalize_surf_host(&host);
    let Some(record) = Storage::global().get_surf_record_by_host(&host)? else {
        return Err("畅游记录不存在".to_string());
    };
    Storage::global().update_surf_record_root_url(&record.id, &root_url)
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub async fn surf_update_name(host: String, name: String) -> Result<(), String> {
    let host = normalize_surf_host(&host);
    let Some(record) = Storage::global().get_surf_record_by_host(&host)? else {
        return Err("畅游记录不存在".to_string());
    };
    Storage::global().update_surf_record_name(&record.id, &name)
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub async fn surf_delete_record(host: String) -> Result<(), String> {
    let host = normalize_surf_host(&host);
    let Some(record) = Storage::global().get_surf_record_by_host(&host)? else {
        return Err("畅游记录不存在".to_string());
    };
    Storage::global().delete_surf_record(&record.id)
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
pub async fn surf_get_cookies<R: Runtime>(app: AppHandle<R>) -> Result<SurfCookiesResult, String> {
    let host = app
        .windows()
        .into_keys()
        .find_map(|label| host_from_surf_label(&label))
        .ok_or_else(|| "当前无畅游会话".to_string())?;

    let record = Storage::global()
        .get_surf_record_by_host(&host)?
        .ok_or_else(|| "畅游记录不存在".to_string())?;
    let site_host = record.host.clone();
    let root_url = record.root_url.clone();

    let app2 = app.clone();
    let cookie_string = tauri::async_runtime::spawn_blocking(move || {
        let webview = app2
            .get_webview(&surf_label(&site_host))
            .ok_or_else(|| "畅游窗口未打开".to_string())?;
        collect_surf_cookie_string(&webview, &site_host, &root_url)
    })
    .await
    .map_err(|e| format!("Cookie 读取任务失败: {}", e))??;

    Ok(SurfCookiesResult {
        cookie_string,
        host: Some(host),
    })
}
