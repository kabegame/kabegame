use super::surf_common::{
    encode_query_value, normalize_surf_host, parse_external_url, resolve_root_url,
    surf_navbar_label, SurfSessionStatus,
};
use kabegame_core::crawler::favicon::fetch_favicon;
use kabegame_core::storage::Storage;
use serde::Serialize;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::plugin::{Builder, PluginHandle, TauriPlugin};
use tauri::{AppHandle, Emitter, Manager, Runtime, WebviewUrl, WebviewWindowBuilder};

#[derive(Debug, Clone)]
struct AndroidSurfSession {
    host: String,
    record_id: String,
    label: String,
}

static SESSION: Mutex<Option<AndroidSurfSession>> = Mutex::new(None);
static NEXT_SESSION_ID: AtomicU64 = AtomicU64::new(1);

pub struct SurfAndroid<R: Runtime>(PluginHandle<R>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AttachArgs {
    label: String,
    host: String,
    url: String,
    events: Channel<serde_json::Value>,
}

#[derive(Serialize)]
struct LabelArgs {
    label: String,
}

#[derive(Serialize)]
struct NavigateArgs {
    label: String,
    url: String,
}

#[derive(serde::Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum SurfContentEvent {
    UrlChanged {
        url: String,
    },
    PageFinished {
        url: String,
        cookie: String,
    },
    Closed {
        cookie: String,
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
            // 让插件请求与 Cookie（如 cf_clearance）的签发 UA 一致。
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

fn session_for_host(host: &str) -> Result<AndroidSurfSession, String> {
    let expected = normalize_surf_host(host);
    session_snapshot()?
        .filter(|session| session.host == expected)
        .ok_or_else(|| "畅游页面未打开".to_string())
}

fn next_navbar_label(host: &str) -> String {
    let id = NEXT_SESSION_ID.fetch_add(1, Ordering::Relaxed);
    let base = surf_navbar_label(host);
    let prefix = base.strip_suffix("-navbar").unwrap_or(&base);
    format!("{prefix}-{id}-navbar")
}

fn on_content_event<R: Runtime>(
    app: &AppHandle<R>,
    session: &AndroidSurfSession,
    event: SurfContentEvent,
) {
    match event {
        SurfContentEvent::UrlChanged { url } => {
            if session_snapshot()
                .ok()
                .flatten()
                .is_some_and(|current| current.label == session.label)
            {
                let _ = app.emit_to(&session.label, "surf-url-changed", url);
            }
        }
        SurfContentEvent::PageFinished { url, cookie } => {
            let _ = app.emit_to(&session.label, "surf-url-changed", url);
            let _ = Storage::global()
                .update_surf_record_cookie_if_changed(&session.record_id, &cookie);
        }
        SurfContentEvent::Closed { cookie } => {
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
                let _ = app.emit(
                    "surf-session-changed",
                    serde_json::json!({ "active": false, "surfHost": null }),
                );
            }
        }
    }
}

async fn close_label<R: Runtime>(app: &AppHandle<R>, label: String) -> Result<(), String> {
    let plugin = app.state::<SurfAndroid<R>>().0.clone();
    plugin
        .run_mobile_plugin_async::<()>("close", LabelArgs { label })
        .await
        .map_err(|e| format!("关闭畅游页面失败: {e}"))
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

    if let Some(old) = session_snapshot()? {
        close_label(&app, old.label).await?;
    }

    // 每次会话使用新 label：旧 Activity 的迟到 closed 事件不会误清同站点的新会话，
    // 也不依赖 Tauri 在 Activity 销毁后立即从窗口表移除旧 label。
    let label = next_navbar_label(&host);
    let navbar_url = WebviewUrl::App(
        format!(
            "surf-navbar.html?host={}&url={}",
            encode_query_value(&host),
            encode_query_value(parsed.as_str())
        )
        .into(),
    );
    // tao 用 getLocalClassName() 登记 Activity 名：类名不以 applicationId 开头时（dev 包
    // applicationId = app.kabegame.dev，类为 app.kabegame.MainActivity）登记的是全限定名，
    // 写死 "MainActivity" 会匹配不到而报 failed to create window，故从主窗口读实际登记名。
    let creator_activity = app
        .get_webview_window("main")
        .ok_or_else(|| "主窗口不存在".to_string())?
        .activity_name()
        .map_err(|e| format!("读取主窗口 Activity 名失败: {e}"))?;
    let navbar_window = WebviewWindowBuilder::new(&app, &label, navbar_url)
        .activity_name("SurfActivity")
        .created_by_activity_name(creator_activity)
        .build()
        .map_err(|e| format!("创建畅游 Activity 失败: {e}"))?;

    let session = AndroidSurfSession {
        host: host.clone(),
        record_id: record.id.clone(),
        label: label.clone(),
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
    if let Err(error) = plugin
        .run_mobile_plugin_async::<()>(
            "attach",
            AttachArgs {
                label: label.clone(),
                host: host.clone(),
                url: parsed.to_string(),
                events,
            },
        )
        .await
    {
        let _ = navbar_window.destroy();
        if let Ok(mut current) = SESSION.lock() {
            if current.as_ref().is_some_and(|active| active.label == label) {
                current.take();
            }
        }
        return Err(format!("绑定畅游内容页失败: {error}"));
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

#[tauri::command]
pub async fn surf_go_back<R: Runtime>(app: AppHandle<R>, host: String) -> Result<(), String> {
    let session = session_for_host(&host)?;
    let plugin = app.state::<SurfAndroid<R>>().0.clone();
    plugin
        .run_mobile_plugin_async::<()>(
            "goBack",
            LabelArgs {
                label: session.label,
            },
        )
        .await
        .map_err(|e| format!("后退失败: {e}"))
}

#[tauri::command]
pub async fn surf_go_forward<R: Runtime>(app: AppHandle<R>, host: String) -> Result<(), String> {
    let session = session_for_host(&host)?;
    let plugin = app.state::<SurfAndroid<R>>().0.clone();
    plugin
        .run_mobile_plugin_async::<()>(
            "goForward",
            LabelArgs {
                label: session.label,
            },
        )
        .await
        .map_err(|e| format!("前进失败: {e}"))
}

#[tauri::command]
pub async fn surf_reload<R: Runtime>(app: AppHandle<R>, host: String) -> Result<(), String> {
    let session = session_for_host(&host)?;
    let plugin = app.state::<SurfAndroid<R>>().0.clone();
    plugin
        .run_mobile_plugin_async::<()>(
            "reload",
            LabelArgs {
                label: session.label,
            },
        )
        .await
        .map_err(|e| format!("刷新失败: {e}"))
}

#[tauri::command]
pub async fn surf_navigate<R: Runtime>(
    app: AppHandle<R>,
    host: String,
    url: String,
) -> Result<(), String> {
    let session = session_for_host(&host)?;
    let parsed = parse_external_url(url.trim())?;
    let plugin = app.state::<SurfAndroid<R>>().0.clone();
    plugin
        .run_mobile_plugin_async::<()>(
            "navigate",
            NavigateArgs {
                label: session.label,
                url: parsed.to_string(),
            },
        )
        .await
        .map_err(|e| format!("导航失败: {e}"))
}
