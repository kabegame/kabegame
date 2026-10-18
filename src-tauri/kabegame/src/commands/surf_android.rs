//! 安卓畅游：内容页是 `SurfActivity` 的 Tauri 主 webview，顶部导航栏是 Kotlin 原生控件。
//!
//! 与 Phase 1 的主次对调后，桌面那套「按 webview label 认会话」的命令（`surf_collect_*`、
//! `surf_download_image`、`surf_import_media`、`crawl_fs_*` / `crawl_ffmpeg_*`）在安卓上原样可用。
//! Kotlin 只负责三件事：原生工具栏直接操作 `RustWebView`、把 IPC 限制在主框架、拦截页面自发下载。
use super::surf_common::{
    normalize_surf_host, parse_external_url, resolve_root_url, surf_initialization_scripts,
    surf_toast_for_host, SurfSessionStatus,
};
use kabegame_core::crawler::favicon::fetch_favicon;
use kabegame_core::media::image_type;
use kabegame_core::storage::Storage;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::plugin::{Builder, PluginHandle, TauriPlugin};
use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Emitter, Manager, Runtime, WebviewUrl, WebviewWindowBuilder};
use url::Url;

#[derive(Debug, Clone)]
struct AndroidSurfSession {
    host: String,
    record_id: String,
    label: String,
    /// 主框架 IPC 是否可用。设备不支持 `WEB_MESSAGE_LISTENER` 时关闭，只能浏览、不能一键下载。
    ipc_available: bool,
}

static SESSION: Mutex<Option<AndroidSurfSession>> = Mutex::new(None);
static NEXT_SESSION_ID: AtomicU64 = AtomicU64::new(1);

pub struct SurfAndroid<R: Runtime>(PluginHandle<R>);

/// 原生工具栏文案。Rust 侧统一用 `t!()` 取，i18n 只维护一处。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SurfToolbarTexts {
    back: String,
    forward: String,
    reload: String,
    address: String,
    collect: String,
    cancel: String,
    open_in_browser: String,
    close: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AttachArgs {
    label: String,
    host: String,
    url: String,
    events: Channel<serde_json::Value>,
    texts: SurfToolbarTexts,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct AttachResponse {
    ipc_available: bool,
}

#[derive(Serialize)]
struct LabelArgs {
    label: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CollectRunningArgs {
    label: String,
    running: bool,
}

#[derive(Serialize)]
struct CookieArgs {
    url: String,
}

#[derive(Deserialize)]
struct CookieResponse {
    cookie: String,
}

#[derive(serde::Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
enum SurfContentEvent {
    // Kotlin 仍会附 `url`（地址同步用的旧协议字段）；serde 默认忽略未知字段。
    PageFinished {
        cookie: String,
    },
    Closed {
        cookie: String,
    },
    /// 原生工具栏的一键下载按钮。
    CollectToggle,
    /// `setDownloadListener` 拦到的页面自发下载。
    PageDownload {
        url: String,
        suggested_name: Option<String>,
        mime_type: Option<String>,
    },
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct DefaultUserAgentResponse {
    user_agent: String,
}

pub fn plugin<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("kabegame-surf")
        .setup(|app, api| {
            let handle = api.register_android_plugin("app.kabegame", "SurfPlugin")?;
            // 畅游内容页保持系统 WebView 默认 UA；登记给 `Kabegame.cefUserAgent()`，
            // 让插件请求与 Cookie（如 cf_clearance）的签发 UA 一致。畅游下载补 User-Agent 也用它。
            let ua_handle = handle.clone();
            tauri::async_runtime::spawn(async move {
                match ua_handle
                    .run_mobile_plugin_async::<DefaultUserAgentResponse>("getDefaultUserAgent", ())
                    .await
                {
                    Ok(res) => {
                        kabegame_core::plugin::v8::set_android_webview_user_agent(&res.user_agent)
                    }
                    Err(e) => eprintln!("[surf] 读取 WebView 默认 UA 失败: {e}"),
                }
            });
            app.manage(SurfAndroid(handle));
            Ok(())
        })
        .build()
}

fn session_snapshot() -> Result<Option<AndroidSurfSession>, String> {
    SESSION
        .lock()
        .map(|session| session.clone())
        .map_err(|e| format!("读取畅游会话失败: {e}"))
}

/// 当前会话 label（供页内 toast 与运行态回推定位内容 webview）。
pub(crate) fn session_label_for_host(host: &str) -> Option<String> {
    let expected = normalize_surf_host(host);
    SESSION.lock().ok().and_then(|session| {
        session
            .as_ref()
            .filter(|session| session.host == expected)
            .map(|session| session.label.clone())
    })
}

/// 事件是否来自当前会话（旧 Activity 的迟到事件一律丢弃）。
fn is_current_session(label: &str) -> bool {
    session_snapshot()
        .ok()
        .flatten()
        .is_some_and(|session| session.label == label)
}

fn next_label(host: &str) -> String {
    let id = NEXT_SESSION_ID.fetch_add(1, Ordering::Relaxed);
    let base = super::surf_common::surf_label(host);
    format!("{base}:{id}")
}

fn toolbar_texts() -> SurfToolbarTexts {
    use kabegame_i18n::t;
    SurfToolbarTexts {
        back: t!("surf.toolbar.back"),
        forward: t!("surf.toolbar.forward"),
        reload: t!("surf.toolbar.reload"),
        address: t!("surf.toolbar.address"),
        collect: t!("surf.toolbar.collect"),
        cancel: t!("surf.toolbar.cancel"),
        open_in_browser: t!("surf.toolbar.openInBrowser"),
        close: t!("surf.toolbar.close"),
    }
}

fn on_content_event<R: Runtime>(
    app: &AppHandle<R>,
    session: &AndroidSurfSession,
    event: SurfContentEvent,
) {
    match event {
        SurfContentEvent::PageFinished { cookie, .. } => {
            // 旧 Activity 的迟到事件不得覆盖新会话的 Cookie。
            if !is_current_session(&session.label) {
                return;
            }
            let _ = Storage::global()
                .update_surf_record_cookie_if_changed(&session.record_id, &cookie);
        }
        SurfContentEvent::Closed { cookie } => {
            // 同站重开时旧 Activity 的 closed 可能晚于新会话：只有仍是当前会话才落库。
            if !is_current_session(&session.label) {
                return;
            }
            let _ = Storage::global()
                .update_surf_record_cookie_if_changed(&session.record_id, &cookie);
            let cleared = SESSION
                .lock()
                .map(|mut current| {
                    if current
                        .as_ref()
                        .is_some_and(|active| active.label == session.label)
                    {
                        current.take();
                        true
                    } else {
                        false
                    }
                })
                .unwrap_or(false);
            if cleared {
                // 与桌面 Destroyed 分支同口径：清会话 VFS 与一键下载槽位。
                super::surf_session::drop_session(&session.host);
                super::surf_collect::drop_slot(&session.label);
                let _ = app.emit(
                    "surf-session-changed",
                    serde_json::json!({ "active": false, "surfHost": null }),
                );
            }
        }
        SurfContentEvent::CollectToggle => {
            let Some(current) = session_snapshot()
                .ok()
                .flatten()
                .filter(|current| current.label == session.label)
            else {
                return;
            };
            if !current.ipc_available {
                surf_toast_for_host(
                    app,
                    &session.host,
                    &kabegame_i18n::translate("surf.collect.ipcUnavailable"),
                    "failed",
                );
                return;
            }
            if let Err(error) = super::surf_collect::toggle(app, &session.label) {
                surf_toast_for_host(app, &session.host, &error, "failed");
            }
        }
        SurfContentEvent::PageDownload {
            url,
            suggested_name,
            mime_type,
        } => {
            let (app, session) = (app.clone(), session.clone());
            tauri::async_runtime::spawn(async move {
                on_page_download(&app, &session, &url, suggested_name.as_deref(), mime_type.as_deref())
                    .await;
            });
        }
    }
}

/// 页面自发下载（`Content-Disposition: attachment` 或 WebView 渲染不了的 MIME）。
///
/// - http(s)：按文件名 / MIME 判定是否支持的媒体，不是（含 zip 等压缩包）直接拒绝、不发起下载；
///   是则与脚本下载共用 `enqueue_surf_download`（同样补 Cookie / UA / Referer），直接入图库。
/// - `data:` / `blob:`：字节只在页面里，转回 `media_download.js` 的 `__kb_media_download__`。
async fn on_page_download<R: Runtime>(
    app: &AppHandle<R>,
    session: &AndroidSurfSession,
    url: &str,
    name: Option<&str>,
    mime_type: Option<&str>,
) {
    let Some(webview) = app.get_webview(&session.label) else {
        return;
    };
    let toast = |key: &str| {
        surf_toast_for_host(app, &session.host, &kabegame_i18n::translate(key), "failed");
    };
    let Ok(parsed) = Url::parse(url) else {
        return;
    };
    match parsed.scheme() {
        "data" | "blob" => {
            // 与 surf_bootstrap.js 的 triggerDownload 同口径：这类 URL 在页面外取不到字节。
            let url_json = serde_json::to_string(url).unwrap_or_default();
            let options = serde_json::to_string(&serde_json::json!({ "name": name }))
                .unwrap_or_else(|_| "{}".to_string());
            let _ = webview.eval(
                format!("window.__kb_media_download__?.({url_json}, {options});").as_str(),
            );
        }
        "http" | "https" => {
            let by_name = name.is_some_and(|name| image_type::is_media_by_path(Path::new(name)));
            let by_mime = mime_type.is_some_and(image_type::is_supported_media_mime);
            if !(by_name || by_mime) {
                // 压缩包等不下载：解压属于各爬虫插件自己的事（Kabegame.archive），畅游只收媒体。
                toast("surf.download.unsupportedType");
                return;
            }
            let request = super::surf_receive::SurfDownloadRequest {
                url: parsed,
                name: name.map(ToOwned::to_owned),
                headers: HashMap::new(),
                metadata: None,
                metadata_id: None,
                collect_run_id: None,
                source_url: webview.url().ok().map(|url| url.to_string()),
            };
            if let Err(error) =
                super::surf_receive::enqueue_surf_download(&webview, request).await
            {
                surf_toast_for_host(app, &session.host, &error, "failed");
            }
        }
        _ => toast("surf.download.unsupportedScheme"),
    }
}

async fn close_label<R: Runtime>(app: &AppHandle<R>, label: String) -> Result<(), String> {
    let plugin = app.state::<SurfAndroid<R>>().0.clone();
    plugin
        .run_mobile_plugin_async::<()>("close", LabelArgs { label })
        .await
        .map_err(|e| format!("关闭畅游页面失败: {e}"))
}

/// 下载补头用的 `Cookie` 头值；该 URL 没有 Cookie 时返回 `None`。
///
/// 经 SurfPlugin 读 CookieManager，而不是 wry 的 `cookies_for_url`：后者生成的 Kotlin 把
/// `getCookie` 当作非空，没有 Cookie 的 URL（媒体 CDN 很常见）会让主线程 NPE 崩溃。
pub(crate) async fn cookie_header_for_url<R: Runtime>(
    app: &AppHandle<R>,
    url: &url::Url,
) -> Option<String> {
    let plugin = app.state::<SurfAndroid<R>>().0.clone();
    let args = CookieArgs {
        url: url.to_string(),
    };
    match plugin
        .run_mobile_plugin_async::<CookieResponse>("getCookie", args)
        .await
    {
        Ok(res) => (!res.cookie.trim().is_empty()).then_some(res.cookie),
        Err(e) => {
            eprintln!("[surf] 读取 Cookie 失败: {e}");
            None
        }
    }
}

/// 回推一键下载运行态到原生工具栏。
pub(crate) fn set_collect_running<R: Runtime>(app: &AppHandle<R>, label: &str, running: bool) {
    let plugin = app.state::<SurfAndroid<R>>().0.clone();
    let args = CollectRunningArgs {
        label: label.to_string(),
        running,
    };
    tauri::async_runtime::spawn(async move {
        let _ = plugin
            .run_mobile_plugin_async::<()>("setCollectRunning", args)
            .await;
    });
}

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

    // 旧 Activity 可能已经被用户关掉（closed 事件还在路上）。关闭失败不该阻止新会话，
    // 否则用户会看到「开始畅游」直接报错。
    if let Some(old) = session_snapshot()? {
        if let Err(error) = close_label(&app, old.label).await {
            eprintln!("[surf] 关闭旧畅游页面失败，继续新建会话: {error}");
        }
    }

    // 每次会话使用新 label：旧 Activity 的迟到 closed 事件不会误清同站点的新会话，
    // 也不依赖 Tauri 在 Activity 销毁后立即从窗口表移除旧 label。
    let label = next_label(&host);
    // tao 用 getLocalClassName() 登记 Activity 名：类名不以 applicationId 开头时（dev 包
    // applicationId = app.kabegame.dev，类为 app.kabegame.MainActivity）登记的是全限定名，
    // 写死 "MainActivity" 会匹配不到而报 failed to create window，故从主窗口读实际登记名。
    let creator_activity = app
        .get_webview_window("main")
        .ok_or_else(|| "主窗口不存在".to_string())?
        .activity_name()
        .map_err(|e| format!("读取主窗口 Activity 名失败: {e}"))?;

    // 内容页直接作为 Tauri 主 webview：注入脚本、on_page_load、按 label 认会话的命令与桌面一致。
    let mut builder = WebviewWindowBuilder::new(&app, &label, WebviewUrl::External(parsed.clone()))
        .activity_name("SurfActivity")
        .created_by_activity_name(creator_activity)
        // 超过阈值（JSON 8 KiB / raw 1 KiB）的 invoke 响应与 Channel 消息要靠 fetch
        // `<scheme>://ipc.localhost` 取。安卓默认 http，在 https 页面里属于混合内容，改用 https。
        .use_https_scheme(true);
    for script in surf_initialization_scripts() {
        builder = builder.initialization_script(script);
    }
    let builder = builder
        .on_navigation(|url| matches!(url.scheme(), "http" | "https"))
        .on_page_load({
            let app = app.clone();
            let label = label.clone();
            move |_webview, payload| {
                if payload.event() == PageLoadEvent::Started {
                    // 整页导航会销毁内容脚本：结束其一键下载 run，工具栏停止转圈。
                    super::surf_collect::on_content_page_started(&app, &label);
                }
            }
        });
    let window = builder
        .build()
        .map_err(|e| format!("创建畅游 Activity 失败: {e}"))?;

    let session = AndroidSurfSession {
        host: host.clone(),
        record_id: record.id.clone(),
        label: label.clone(),
        ipc_available: false,
    };
    *SESSION
        .lock()
        .map_err(|e| format!("保存畅游会话失败: {e}"))? = Some(session.clone());

    let events = Channel::new({
        let app = app.clone();
        let session = session.clone();
        move |body| {
            if let InvokeResponseBody::Json(json) = body {
                if let Ok(event) = serde_json::from_str::<SurfContentEvent>(&json) {
                    on_content_event(&app, &session, event);
                }
            }
            Ok(())
        }
    });
    let plugin = app.state::<SurfAndroid<R>>().0.clone();
    // attach 要等 Activity 的 setContentView 完成（IPC 替换在那里做）才会 resolve，
    // 期间 RustWebView 已经在加载首个文档；超时则视为 Activity 没起来，销毁窗口。
    let attached = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        plugin.run_mobile_plugin_async::<AttachResponse>(
            "attach",
            AttachArgs {
                label: label.clone(),
                host: host.clone(),
                url: parsed.to_string(),
                events,
                texts: toolbar_texts(),
            },
        ),
    )
    .await;
    match attached {
        Ok(Ok(response)) => {
            if let Ok(mut current) = SESSION.lock() {
                if let Some(active) = current
                    .as_mut()
                    .filter(|active| active.label == label)
                {
                    active.ipc_available = response.ipc_available;
                }
            }
        }
        Ok(Err(error)) => {
            let _ = window.destroy();
            if let Ok(mut current) = SESSION.lock() {
                if current.as_ref().is_some_and(|active| active.label == label) {
                    current.take();
                }
            }
            return Err(format!("绑定畅游内容页失败: {error}"));
        }
        Err(_) => {
            let _ = window.destroy();
            if let Ok(mut current) = SESSION.lock() {
                if current.as_ref().is_some_and(|active| active.label == label) {
                    current.take();
                }
            }
            return Err("绑定畅游内容页超时".to_string());
        }
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
        }
    });

    serde_json::to_value(record).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn surf_close_session<R: Runtime>(
    app: AppHandle<R>,
    host: Option<String>,
) -> Result<(), String> {
    let Some(session) = session_snapshot()? else {
        return Ok(());
    };
    if let Some(host) = host {
        if session.host != normalize_surf_host(&host) {
            return Ok(());
        }
    }
    close_label(&app, session.label).await
}

#[tauri::command]
pub async fn surf_get_session_status() -> Result<SurfSessionStatus, String> {
    let session = session_snapshot()?;
    Ok(SurfSessionStatus {
        active: session.is_some(),
        surf_host: session.map(|session| session.host),
    })
}
