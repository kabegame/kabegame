//! 桌面网页壁纸（`x-wpe/web`）的 `file://` 宿主：壁纸窗口导航的唯一属主。
//!
//! WPE 让网页壁纸以 `file://` 从壁纸目录直接加载。Kabegame 照此做：当前壁纸是 `x-wpe/web`
//! 时，把壁纸窗口的**整个主 frame** 导航到入口的 `file://` URL；切到别的壁纸时再导航回
//! 应用页（`index.html?window=wallpaper`），由 Vue 应用照旧渲染图片和视频。
//!
//! - 决定权只在这里：Vue 侧（`WallpaperWindow.vue`）拿到网页壁纸时什么都不做，不会抢导航；
//! - 应用页 URL 不手拼：第一次离开应用页前从壁纸 webview 读当前 URL 并记住；
//! - 文件访问偏好由 `tauri_runtime_cef::allow_file_documents`（建窗前）只对壁纸窗口开启，
//!   这里按当前壁纸目录设置 / 清空允许的根目录；
//! - Windows 上进入网页壁纸时启动桌面鼠标转发（`input_forward`），离开时停止。
//!
//! 触发点：当前壁纸变化（`setting-change` 的 `currentWallpaperImageId`）、壁纸窗口的
//! `wallpaper_window_ready` 握手（开机即网页壁纸时由此切去 `file://`）、窗口销毁（复位）。

use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use kabegame_core::ipc::events::{AppEvent, AppEventKind};
use kabegame_core::ipc::server::EventBroadcaster;
use tauri::{AppHandle, Manager, Runtime};
use url::Url;

use crate::commands::wallpaper::get_current_wallpaper_target_from_settings;

/// 壁纸窗口 label（与 `manager/window.rs` 一致）。
pub const WALLPAPER_LABEL: &str = "wallpaper";

/// 壁纸窗口当前停在哪里。
#[derive(Debug, Clone, PartialEq, Eq)]
enum HostMode {
    /// 应用页（Vue 自驱动渲染）。
    App,
    /// 某张网页壁纸的 `file://` 入口。
    File { image_id: String, entry_url: Url },
}

struct HostState {
    mode: HostMode,
    /// 应用页 URL：第一次离开应用页前从 webview 读取。
    app_url: Option<Url>,
    #[cfg(target_os = "windows")]
    forwarder: Option<super::input_forward::InputForwarder>,
}

impl HostState {
    const fn new() -> Self {
        Self {
            mode: HostMode::App,
            app_url: None,
            #[cfg(target_os = "windows")]
            forwarder: None,
        }
    }

    fn stop_forwarding(&mut self) {
        #[cfg(target_os = "windows")]
        if let Some(forwarder) = self.forwarder.take() {
            forwarder.stop();
        }
    }
}

static STATE: Mutex<HostState> = Mutex::new(HostState::new());

/// 串行化 `sync`：当前壁纸变化与 ready 握手可能同时触发，读目标是异步的。
fn sync_gate() -> &'static tokio::sync::Mutex<()> {
    static GATE: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    GATE.get_or_init(|| tokio::sync::Mutex::new(()))
}

/// 当前壁纸若是网页壁纸，解析出其目录与入口 `file://` URL。
struct WebWallpaper {
    image_id: String,
    dir: PathBuf,
    entry_url: Url,
}

async fn current_web_wallpaper() -> Option<WebWallpaper> {
    let target = match get_current_wallpaper_target_from_settings().await {
        Ok(Some(target)) => target,
        Ok(None) => return None,
        Err(error) => {
            tracing::warn!("读取当前壁纸失败: {error}");
            return None;
        }
    };
    if kabegame_core::media::image_type::wpe_kind(target.media_type.as_deref()).as_deref()
        != Some("web")
    {
        return None;
    }
    let dir = PathBuf::from(&target.path);
    // read_project 校验 `file` 是目录内相对路径（拒绝越界）且入口存在。
    let project =
        match tokio::task::spawn_blocking(move || kabegame_core::wpe::read_project(&dir)).await {
            Ok(Ok(project)) => project,
            Ok(Err(skip)) => {
                tracing::warn!(
                    "网页壁纸 {} 无法加载: {}",
                    target.id,
                    skip.message()
                );
                return None;
            }
            Err(error) => {
                tracing::warn!("解析网页壁纸失败: {error}");
                return None;
            }
        };
    let entry = project.entry_path()?;
    let entry_url = match Url::from_file_path(&entry) {
        Ok(url) => url,
        Err(()) => {
            tracing::debug!("入口不是绝对路径: {}", entry.display());
            return None;
        }
    };
    Some(WebWallpaper {
        image_id: target.id,
        dir: project.dir,
        entry_url,
    })
}

/// 按当前壁纸决定壁纸窗口停在哪个 URL。
pub async fn sync<R: Runtime>(app: &AppHandle<R>) {
    let _gate = sync_gate().lock().await;
    let Some(webview) = app.get_webview_window(WALLPAPER_LABEL) else {
        reset();
        return;
    };
    let desired = current_web_wallpaper().await;
    // 窗口 getter 会同步等主线程回执，必须在拿 STATE 锁之前取：主线程上的 `reset()`
    // （窗口销毁）也要拿这把锁，持锁等主线程会死锁。
    let current_url = desired.as_ref().map(|_| webview.url());
    #[cfg(target_os = "windows")]
    let hwnd = desired
        .as_ref()
        .map(|_| webview.hwnd().map(|hwnd| hwnd.0 as isize));

    let mut state = match STATE.lock() {
        Ok(state) => state,
        Err(poisoned) => poisoned.into_inner(),
    };
    match desired {
        Some(web) => {
            if matches!(&state.mode, HostMode::File { image_id, .. } if *image_id == web.image_id) {
                return;
            }
            if state.mode == HostMode::App {
                // 从应用页离开前记住它（dev 是 vite 地址，prod 是内置资源地址）。
                match current_url {
                    Some(Ok(url)) if url.scheme() != "file" => state.app_url = Some(url),
                    Some(Err(error)) => {
                        tracing::warn!("读取壁纸窗口 URL 失败: {error}")
                    }
                    _ => {}
                }
            }
            if state.app_url.is_none() {
                // 没有回程地址就不离开应用页，否则之后切回图片 / 视频壁纸时回不来。
                tracing::debug!("未知应用页 URL，保持在应用页");
                return;
            }
            if let Err(error) =
                tauri_runtime_cef::set_file_document_root(WALLPAPER_LABEL, Some(web.dir.clone()))
            {
                tracing::warn!("设置文件根目录失败: {error}");
                return;
            }
            if let Err(error) = webview.navigate(web.entry_url.clone()) {
                tracing::warn!("导航到网页壁纸失败: {error}");
                let _ = tauri_runtime_cef::set_file_document_root(WALLPAPER_LABEL, None);
                return;
            }
            tracing::debug!(
                "壁纸窗口 → {} ({})",
                web.entry_url, web.image_id
            );
            state.mode = HostMode::File {
                image_id: web.image_id,
                entry_url: web.entry_url,
            };
            #[cfg(target_os = "windows")]
            if state.forwarder.is_none() {
                match hwnd {
                    Some(Ok(hwnd)) => {
                        state.forwarder = Some(super::input_forward::InputForwarder::start(
                            WALLPAPER_LABEL,
                            hwnd,
                        ))
                    }
                    Some(Err(error)) => {
                        tracing::warn!("取壁纸窗口句柄失败: {error}")
                    }
                    None => {}
                }
            }
        }
        None => {
            if state.mode == HostMode::App {
                // Vue 应用照旧自驱动。
                return;
            }
            state.stop_forwarding();
            let _ = tauri_runtime_cef::set_file_document_root(WALLPAPER_LABEL, None);
            let Some(app_url) = state.app_url.clone() else {
                state.mode = HostMode::App;
                return;
            };
            if let Err(error) = webview.navigate(app_url.clone()) {
                tracing::warn!("导航回应用页失败: {error}");
            }
            tracing::debug!("壁纸窗口 → {app_url}");
            state.mode = HostMode::App;
        }
    }
}

/// 在后台执行一次 [`sync`]（命令处理器里调用，不阻塞调用线程）。
pub fn spawn_sync<R: Runtime>(app: AppHandle<R>) {
    tauri::async_runtime::spawn(async move {
        sync(&app).await;
    });
}

/// 壁纸窗口销毁时复位：回到 App 模式、根目录清空、停止鼠标转发。
pub fn reset() {
    let mut state = match STATE.lock() {
        Ok(state) => state,
        Err(poisoned) => poisoned.into_inner(),
    };
    state.stop_forwarding();
    state.mode = HostMode::App;
    let _ = tauri_runtime_cef::set_file_document_root(WALLPAPER_LABEL, None);
}

/// 订阅当前壁纸变化（Rust 侧事件流，不新增事件类型），变化时同步一次。
pub fn start_listener<R: Runtime>(app: AppHandle<R>) {
    tauri::async_runtime::spawn(async move {
        let mut rx = EventBroadcaster::global().subscribe_filtered_stream(&[AppEventKind::SettingChange]);
        while let Some((_, event)) = rx.recv().await {
            if let AppEvent::SettingChange { changes } = &*event {
                if changes.get("currentWallpaperImageId").is_some() {
                    sync(&app).await;
                }
            }
        }
    });
}
