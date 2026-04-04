// 启动步骤函数

use async_trait::async_trait;
use kabegame_core::crawler::TaskScheduler;
use kabegame_i18n::t;
// 事件转发到前端（桌面与 Android 均需要，用于 tasks-change 等）
use crate::wallpaper::manager::WallpaperController;
use crate::wallpaper::WallpaperRotator;
use kabegame_core::ipc::events::DaemonEventKind;
use kabegame_core::ipc::{DaemonEvent, EventBroadcaster};
use kabegame_core::plugin::PluginManager;
use kabegame_core::settings::Settings;
use kabegame_core::storage::Storage;
use std::fs;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Listener, Manager};

#[cfg(not(target_os = "android"))]
use kabegame_core::crawler::downloader::{
    compute_native_download_destination, postprocess_downloaded_image, BrowserDownloadState,
    NativeDownloadEntry, NativeDownloadState,
};
#[cfg(not(target_os = "android"))]
use kabegame_core::crawler::webview::{
    crawler_window_state, set_webview_handler, CrawlerWebViewHandler,
};
#[cfg(not(target_os = "android"))]
use kabegame_core::emitter::GlobalEmitter;
#[cfg(not(target_os = "android"))]
use tauri::webview::DownloadEvent;

#[cfg(not(target_os = "android"))]
struct AppCrawlerWebViewHandler {
    app: AppHandle,
}

#[cfg(not(target_os = "android"))]
#[async_trait]
impl CrawlerWebViewHandler for AppCrawlerWebViewHandler {
    async fn setup_js_task(&self, _task_id: &str, base_url: &str) -> Result<(), String> {
        let crawler_window = self
            .app
            .get_webview_window("crawler")
            .ok_or_else(|| "Crawler window not found".to_string())?;
        let target = if base_url.trim().is_empty() {
            "about:blank"
        } else {
            base_url
        };
        let parsed = url::Url::parse(target)
            .map_err(|e| format!("Invalid crawler URL '{}': {}", target, e))?;
        crawler_window
            .navigate(parsed)
            .map_err(|e| format!("Failed to navigate crawler window: {}", e))?;
        // 由设置控制启动 WebView 插件任务时是否自动显示窗口
        let auto_open = Settings::global()
            .get_auto_open_crawler_webview()
            .await
            .unwrap_or(false);
        if auto_open {
            let _ = crawler_window.show();
            let _ = crawler_window.set_focus();
        }
        Ok(())
    }
}

pub fn init_kgpg_plugin() {
    tauri::async_runtime::spawn(async {
        // 初始化已安装插件缓存（仅用户 data 目录下的 .kgpg）
        if let Err(e) = PluginManager::global()
            .ensure_installed_cache_initialized()
            .await
        {
            eprintln!("Failed to initialize plugin cache: {}", e);
        }
    });
}

// 清理用户数据（清理后重启时在 init_globals 之前执行，避免 DB 已打开导致删除失败）
#[cfg(not(target_os = "android"))]
pub fn cleanup_user_data_if_marked() -> bool {
    let paths = kabegame_core::app_paths::AppPaths::global();
    let cleanup_marker = paths.cleanup_marker();
    let app_data_dir = paths.data_dir.clone();
    let cache_dir = paths.cache_dir.clone();
    let is_cleaning_data = cleanup_marker.exists();
    if is_cleaning_data {
        // 先删除标记文件（在 data_dir 内，后面会一起删掉，但先删可避免重复进入）
        let _ = fs::remove_file(&cleanup_marker);
        // 删除 data 目录（此时尚未 init_globals，无文件占用）
        if app_data_dir.exists() {
            if let Err(e) = fs::remove_dir_all(&app_data_dir) {
                eprintln!("警告：清理数据目录失败: {}", e);
            } else {
                println!("成功清理应用数据目录");
            }
        }
        // 删除缓存目录（provider-cache、store-cache 等）
        if cache_dir.exists() {
            if let Err(e) = fs::remove_dir_all(&cache_dir) {
                eprintln!("警告：清理缓存目录失败: {}", e);
            } else {
                println!("成功清理缓存目录");
            }
        }
    }
    is_cleaning_data
}

#[cfg(not(target_os = "android"))]
pub fn create_main_window(app_handle: &AppHandle) -> Result<(), String> {
    use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

    let (width, height) = if cfg!(target_os = "linux") {
        (1600.0, 1200.0)
    } else {
        (1200.0, 800.0)
    };
    let (min_w, min_h) = if cfg!(target_os = "linux") {
        (1200.0, 800.0)
    } else {
        (800.0, 600.0)
    };

    let (x, y) = match app_handle.primary_monitor() {
        Ok(Some(monitor)) => {
            let size = monitor.size();
            let scale = monitor.scale_factor();
            let mon_w = size.width as f64 / scale;
            let mon_h = size.height as f64 / scale;
            ((mon_w - width) / 2.0, (mon_h - height) / 2.0)
        }
        _ => (0.0, 0.0),
    };

    let builder =
        WebviewWindowBuilder::new(app_handle, "main", WebviewUrl::App("index.html".into()))
            .title(t!("common.appName"))
            .inner_size(width, height)
            .min_inner_size(min_w, min_h)
            .position(x, y)
            .resizable(true)
            .fullscreen(false)
            .visible(true)
            .devtools(true)
            // .devtools(cfg!(debug_assertions))
            .transparent(!cfg!(target_os = "linux"));

    // Windows/macOS: 添加窗口效果
    #[cfg(not(target_os = "linux"))]
    let builder = {
        use tauri::window::{Effect, EffectState, EffectsBuilder};
        builder.effects(
            EffectsBuilder::new()
                .effect(Effect::Sidebar)
                .effect(Effect::Acrylic)
                .state(EffectState::FollowsWindowActiveState)
                .build(),
        )
    };

    builder
        .build()
        .map_err(|e| format!("创建 main 窗口失败: {}", e))?;
    Ok(())
}
/// 检测是否是开机启动（带 --minimized 时不创建/不显示主窗口）
/// 判断逻辑：检查命令行参数中是否有 --minimized 参数
#[cfg(not(target_os = "android"))]
pub fn is_auto_startup() -> bool {
    std::env::args().any(|arg| arg == "--minimized")
}

/// 若主窗口不存在则创建，然后显示并聚焦。用于托盘点击、IPC AppShowWindow 等“显示窗口”场景。
#[cfg(not(target_os = "android"))]
pub fn ensure_main_window(app_handle: AppHandle) -> Result<(), String> {
    use tauri::Manager;
    if let Some(w) = app_handle.get_webview_window("main") {
        let _ = w.center();
        w.show().map_err(|e| format!("显示主窗口失败: {}", e))?;
        let _ = w.set_focus();
        return Ok(());
    }
    create_main_window(&app_handle)?;
    if let Some(w) = app_handle.get_webview_window("main") {
        let _ = w.show();
        let _ = w.set_focus();
    }
    Ok(())
}

// 壁纸组件，壁纸设置、轮播等功能
pub fn init_wallpaper_controller(app: &mut tauri::App) {
    // 初始化全局壁纸控制器（基础 manager）
    // 使用全局单例（不再使用 manage）
    if let Err(e) = WallpaperController::init_global(app.app_handle().clone()) {
        eprintln!("Failed to initialize WallpaperController: {}", e);
        return;
    }

    // 初始化壁纸轮播器
    // 使用全局单例（不再使用 manage）
    if let Err(e) = WallpaperRotator::init_global(app.app_handle().clone()) {
        eprintln!("Failed to initialize WallpaperRotator: {}", e);
        return;
    }

    // 创建壁纸窗口（用于窗口模式）
    #[cfg(any(target_os = "windows", target_os = "macos"))]
    {
        use tauri::{WebviewUrl, WebviewWindowBuilder};
        let _ = WebviewWindowBuilder::new(
            app,
            "wallpaper",
            // 使用独立的 wallpaper.html，只渲染 WallpaperLayer 组件
            WebviewUrl::App("wallpaper.html".into()),
        )
        // 给壁纸窗口一个固定标题，便于脚本/调试定位到正确窗口
        .title(t!("window.wallpaperTitle"))
        .fullscreen(true)
        .decorations(false)
        // 设置窗口为透明，背景为透明
        .transparent(true)
        .visible(false)
        .skip_taskbar(true)
        .build();

        #[cfg(target_os = "macos")]
        if let Some(wallpaper_window) = app.get_webview_window("wallpaper") {
            let _ = crate::wallpaper::window_mount_macos::mount_to_desktop(&wallpaper_window);
        }
    }

    // 创建系统托盘（使用 Tauri 2.0 内置 API）
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        crate::tray::setup_tray(app.app_handle().clone());
    }

    tauri::async_runtime::spawn(async move {
        // 初始化壁纸控制器（如创建窗口等）
        if let Err(e) = WallpaperController::global().init() {
            eprintln!("[WARN] Failed to initialize wallpaper controller: {}", e);
        }

        if let Err(e) = init_wallpaper_on_startup().await {
            eprintln!("[WARN] init_wallpaper_on_startup failed: {}", e);
        } else {
            println!("[WALLPAPER_CONTROLLER] init finished");
        }
    });
    tauri::async_runtime::spawn(async {
        if let Err(e) = WallpaperRotator::global().ensure_running(true).await {
            eprintln!("[WARN] Failed to ensure wallpaper rotator running: {}", e);
        }
    });
}

/// 启动事件转发任务（将同步广播和异步广播都收拢到一个接口处）
pub fn start_event_forward_task() {
    tauri::async_runtime::spawn(async {
        EventBroadcaster::start_forward_task().await;
    });
}

/// 启动本地事件转发循环（将 Broadcaster 事件转发给 Tauri 前端，桌面与 Android 均需）
pub fn start_local_event_loop(app: AppHandle) {
    let broadcaster = EventBroadcaster::global();
    tauri::async_runtime::spawn(async move {
        let mut rx = broadcaster.subscribe_filtered_stream(&DaemonEventKind::ALL);
        eprintln!("[LOCAL_EVENT_LOOP] ready for receive event");
        while let Some((_id, event)) = rx.recv().await {
            let kind = event.kind();

            match &*event {
                DaemonEvent::Generic { event, payload } => {
                    let _ = app.emit(event.as_str(), payload.clone());
                }
                DaemonEvent::SettingChange { changes } => {
                    let _ = app.emit("setting-change", changes.clone());
                    // 语言变更时刷新托盘菜单、收藏画册/官方插件源 i18n 名称（与磁盘挂载等实现方式一致，在 setting 回调处处理）
                    if changes.get("language").is_some() {
                        let raw = t!("albums.favorite");
                        let i18n_name = if raw == "albums.favorite" {
                            "收藏".to_string()
                        } else {
                            raw
                        };
                        let raw_source_name = t!("plugins.officialGithubReleaseSourceName");
                        let i18n_source_name =
                            if raw_source_name == "plugins.officialGithubReleaseSourceName" {
                                kabegame_core::storage::plugin_sources::OFFICIAL_PLUGIN_SOURCE_DEFAULT_DB_NAME
                                    .to_string()
                            } else {
                                raw_source_name
                            };
                        #[cfg(not(target_os = "android"))]
                        if let Err(e) = crate::tray::update_tray_menu(&app) {
                            eprintln!("[托盘] 语言切换后刷新菜单失败: {}", e);
                        }
                        let _ = Storage::global().ensure_favorite_album();
                        if let Err(e) = Storage::global().set_favorite_album_name(&i18n_name) {
                            eprintln!("[收藏画册] 语言切换后设置 i18n 名称失败: {}", e);
                        }
                        if let Err(e) = Storage::global()
                            .plugin_sources()
                            .set_official_source_name(&i18n_source_name)
                        {
                            eprintln!("[插件官方源] 语言切换后设置 i18n 名称失败: {}", e);
                        }
                    }
                }
                DaemonEvent::WallpaperUpdateImage { image_path } => {
                    #[cfg(not(target_os = "android"))]
                    {
                        let path = image_path.clone();
                        let controller = crate::wallpaper::manager::WallpaperController::global();
                        tokio::spawn(async move {
                            let style = Settings::global()
                                .get_wallpaper_rotation_style()
                                .await
                                .unwrap_or("fill".to_string());
                            if let Err(e) = controller.set_wallpaper(&path, &style).await {
                                eprintln!("[LocalEvent] Set wallpaper failed: {}", e);
                            }
                        });
                    }
                }
                DaemonEvent::TaskChanged { diff, .. } => {
                    let event_name = kind.as_event_name();
                    let payload =
                        serde_json::to_value(&event).unwrap_or_else(|_| serde_json::Value::Null);
                    let _ = app.emit(event_name.as_str(), payload);

                    #[cfg(target_os = "android")]
                    {
                        if let Some(s) = diff.get("status").and_then(|v| v.as_str()) {
                            use tauri_plugin_task_notification::TaskNotificationExt;
                            let running = TaskScheduler::global().running_worker_count() as u32;
                            let tn = app.task_notification();
                            if running > 0 {
                                let _ = tn.update_task_notification(running).await;
                            } else if s == "completed"
                                || s == "failed"
                                || s == "canceled"
                            {
                                let _ = tn.clear_task_notification().await;
                            }
                        }
                    }
                }
                _ => {
                    let event_name = kind.as_event_name();
                    let payload =
                        serde_json::to_value(&event).unwrap_or_else(|_| serde_json::Value::Null);
                    let _ = app.emit(event_name.as_str(), payload);
                }
            }
        }
    });
}

/// 在 AppPaths 尚未初始化时独立计算 data_dir 并检查 `.cleanup_marker` 是否存在。
/// 用于 `try_forward_to_existing_instance_and_exit` 跳过清理重启时的单例检测。
#[cfg(not(target_os = "android"))]
fn is_cleanup_restart() -> bool {
    use kabegame_core::app_paths::{is_dev, repo_root_dir};

    let data_dir = if is_dev() {
        if let Some(repo_root) = repo_root_dir() {
            repo_root.join("data")
        } else {
            match dirs::data_local_dir().or_else(dirs::data_dir) {
                Some(d) => d.join("Kabegame"),
                None => return false,
            }
        }
    } else {
        match dirs::data_local_dir().or_else(dirs::data_dir) {
            Some(d) => d.join("Kabegame"),
            None => return false,
        }
    };
    data_dir.join(".cleanup_marker").exists()
}

/// 单例检测：若已有实例在运行则通过 IPC 转发请求并退出，仅在桌面端、在 setup 最早阶段调用（早于 init_shortcut）。
#[cfg(not(target_os = "android"))]
pub fn try_forward_to_existing_instance_and_exit() {
    if is_cleanup_restart() {
        println!("[IPC] 检测到清理重启标记，跳过单例检测");
        return;
    }

    use kabegame_core::ipc::ipc::{request, CliIpcRequest};

    let rt = match tokio::runtime::Runtime::new() {
        Ok(r) => r,
        Err(_) => return,
    };
    let another = rt.block_on(kabegame_core::ipc::server::check_other_daemon_running());
    if !another {
        return;
    }
    println!("[IPC] 检测到已有实例在运行，转发请求并退出...");
    let _ = rt.block_on(request(CliIpcRequest::AppShowWindow));
    if let Some(path) = extract_kgpg_file_from_args() {
        let _ = rt.block_on(request(CliIpcRequest::AppImportPlugin { kgpg_path: path }));
    }
    std::process::exit(0);
}

/// 启动 IPC 服务（仅需 app_handle，DedupeService / VirtualDriveService 等由全局单例提供）
#[cfg(not(target_os = "android"))]
pub fn start_ipc_server(app_handle: AppHandle) {
    println!("[IPC_SERVER] Starting IPC server...");

    tauri::async_runtime::spawn(async move {
        // 1. 单例检测已在 setup 最早阶段由 try_forward_to_existing_instance_and_exit 完成，此处仅启动服务器

        // 2. 首次启动：处理启动参数
        if let Some(path) = extract_kgpg_file_from_args() {
            let app_handle_clone = app_handle.clone();
            // 等待前端准备好
            app_handle.once("app-ready", move |_| {
                let _ = app_handle_clone.emit(
                    "app-import-plugin",
                    serde_json::json!({
                        "kgpgPath": path
                    }),
                );
            });
        }

        // 3. 启动服务器（app_handle 直接传入 dispatch_request）
        let res = kabegame_core::ipc::server::serve_with_events(move |req| {
            let app_handle = app_handle.clone();
            async move {
                use crate::ipc::dispatch_request;
                dispatch_request(req, app_handle).await
            }
        })
        .await;

        if let Err(e) = res {
            eprintln!("[IPC_SERVER] 服务器退出: {}", e);
        }
    });
}

fn extract_kgpg_file_from_args() -> Option<String> {
    let args: Vec<String> = std::env::args().collect();
    // 简单启发式：找第一个以 .kgpg 结尾的参数
    for arg in args.iter().skip(1) {
        if arg.ends_with(".kgpg") {
            return Some(arg.clone());
        }
    }
    None
}

pub fn init_download_workers() {
    tauri::async_runtime::spawn(async {
        TaskScheduler::global().set_download_concurrency().await;
    });
}

pub fn start_download_workers() {
    tauri::async_runtime::spawn(async {
        TaskScheduler::global()
            .start_workers(kabegame_core::crawler::MAX_TASK_WORKER_LOOPS)
            .await;
    });
}

#[cfg(not(target_os = "android"))]
pub fn create_crawler_window(app_handle: AppHandle) -> Result<(), String> {
    if app_handle.get_webview_window("crawler").is_some() {
        return Ok(());
    }

    use tauri::{WebviewUrl, WebviewWindowBuilder};
    // 编译时嵌入 bootstrap.js（从 resources 目录读取）
    let script = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/resources/bootstrap.js"
    ));
    let about_blank = url::Url::parse("about:blank").map_err(|e| e.to_string())?;
    WebviewWindowBuilder::new(&app_handle, "crawler", WebviewUrl::External(about_blank))
        .title(t!("window.crawlerTitle"))
        .visible(false)
        .skip_taskbar(true)
        .resizable(false)
        .inner_size(1920.0, 1080.0)
        .initialization_script(script)
        .on_page_load(move |_webview, _payload| {})
        .on_download(|_webview, event| match event {
            DownloadEvent::Requested { url, destination } => {
                if let Some(dest) =
                    BrowserDownloadState::global().resolve_destination_by_blob_url(url.as_str())
                {
                    *destination = dest;
                    true
                } else {
                    let Some(ctx) = crawler_window_state().try_get_context() else {
                        return false;
                    };
                    let images_dir = std::path::PathBuf::from(&ctx.images_dir);
                    if let Err(e) = std::fs::create_dir_all(&images_dir) {
                        eprintln!("Failed to create native download dir: {}", e);
                        return false;
                    }
                    let effective_url = if url.scheme() == "blob" {
                        url.as_str()
                            .strip_prefix("blob:")
                            .unwrap_or(url.as_str())
                            .to_string()
                    } else {
                        url.as_str().to_string()
                    };
                    let native_dest =
                        match compute_native_download_destination(&effective_url, &images_dir) {
                            Ok(p) => p,
                            Err(e) => {
                                eprintln!("Failed to compute native download destination: {}", e);
                                return false;
                            }
                        };
                    let download_start_time = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_millis() as u64)
                        .unwrap_or(0);
                    let entry = NativeDownloadEntry {
                        destination: native_dest.clone(),
                        task_id: Some(ctx.task_id.clone()),
                        surf_record_id: None,
                        plugin_id: ctx.plugin_id.clone(),
                        output_album_id: ctx.output_album_id.clone(),
                        download_start_time,
                    };
                    if let Err(e) = NativeDownloadState::global().register(url.as_str(), entry) {
                        eprintln!("Failed to register native download: {}", e);
                        return false;
                    }
                    GlobalEmitter::global().emit_download_state_with_native(
                        &ctx.task_id,
                        url.as_str(),
                        download_start_time,
                        &ctx.plugin_id,
                        "downloading",
                        None,
                        true,
                    );
                    *destination = native_dest;
                    true
                }
            }
            DownloadEvent::Finished { url, path, success } => {
                if BrowserDownloadState::global()
                    .signal_completion_by_blob_url(url.as_str(), path.clone(), success)
                    .is_ok()
                {
                    return true;
                }
                let Some(entry) = NativeDownloadState::global().take(url.as_str()) else {
                    return true;
                };
                if success {
                    let final_path = path.unwrap_or_else(|| entry.destination.clone());
                    let url_str = url.to_string();
                    tauri::async_runtime::spawn(async move {
                        let empty_headers = std::collections::HashMap::new();
                        let _ = postprocess_downloaded_image(
                            &final_path,
                            &url_str,
                            &entry.plugin_id,
                            entry.task_id.as_deref(),
                            None,
                            entry.surf_record_id.as_deref(),
                            entry.download_start_time,
                            entry.output_album_id.as_deref(),
                            &empty_headers,
                            true,
                            None,
                            None,
                            None,
                        )
                        .await;
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
                }
                true
            }
            _ => true,
        })
        .build()
        .map_err(|e| format!("创建 crawler 窗口失败: {}", e))?;
    Ok(())
}

#[cfg(not(target_os = "android"))]
pub fn init_crawler_webview_handler(app_handle: AppHandle) -> Result<(), String> {
    let handler = Arc::new(AppCrawlerWebViewHandler { app: app_handle });
    set_webview_handler(handler)
}

#[cfg(not(target_os = "android"))]
pub fn init_crawler_window(app_handle: AppHandle) {
    tauri::async_runtime::spawn_blocking(move || {
        if let Err(e) = create_crawler_window(app_handle.clone()) {
            eprintln!("Failed to create crawler window: {}", e);
        }
        if let Err(e) = init_crawler_webview_handler(app_handle) {
            eprintln!("Failed to init crawler webview handler: {}", e);
        }
    });
}

/// 启动 TaskScheduler（启动 DownloadQueue 的 worker）
pub fn start_task_scheduler() {
    tauri::async_runtime::spawn(async {
        TaskScheduler::global().start_download_workers_async().await;
        TaskScheduler::global().set_task_concurrency();
    });
}

/// 启动时初始化"当前壁纸"并按规则回退/降级
///
/// 规则（按用户需求）：
/// - 非轮播：尝试设置 currentWallpaperImageId；失败则清空并停止
/// - 轮播：优先在轮播源中找到 currentWallpaperImageId；找不到则回退到轮播源的一张；源无可用则画册->画廊->关闭轮播并清空
pub async fn init_wallpaper_on_startup() -> Result<(), String> {
    use std::path::Path;

    // Linux Plasma + 插件模式：若当前系统壁纸插件不是 Kabegame，自动切到 Kabegame（与 Windows/macOS 窗口模式启动时对齐）
    #[cfg(target_os = "linux")]
    {
        use crate::linux_desktop::{linux_desktop, LinuxDesktop};
        use crate::wallpaper::manager::PlasmaPluginWallpaperManager;
        let mode = Settings::global()
            .get_wallpaper_mode()
            .await
            .unwrap_or_else(|_| "native".to_string());
        if linux_desktop() == LinuxDesktop::Plasma && mode == "plasma-plugin" {
            if let Err(e) = PlasmaPluginWallpaperManager::ensure_plasma_plugin_aligned() {
                eprintln!("[WARN] ensure_plasma_plugin_aligned failed: {}", e);
            }
        }
    }

    let controller = WallpaperController::global();
    // 启动时只"尝试还原 currentWallpaperImageId"，不在客户端做大规模选图/回退，
    // 回退与轮播逻辑由 rotator 负责（避免客户端依赖 Storage/Settings）。
    let settings = Settings::global();
    let (style_result, id_result) = tokio::join!(
        settings.get_wallpaper_rotation_style(),
        settings.get_current_wallpaper_image_id()
    );

    let style = style_result.unwrap_or_else(|_| "fill".to_string());
    let Some(id) = id_result.ok().flatten() else {
        return Ok(());
    };

    let img_v = Storage::global()
        .find_image_by_id(&id)
        .map_err(|e| format!("Storage error: {}", e))?;

    let Some(img_info) = img_v else {
        let _ = settings.set_current_wallpaper_image_id(None).await;
        return Ok(());
    };
    let path = img_info.local_path;

    if !Path::new(&path).exists() {
        let _ = settings.set_current_wallpaper_image_id(None).await;
        return Ok(());
    }

    if controller.set_wallpaper(&path, &style).await.is_err() as bool {
        let _ = settings.set_current_wallpaper_image_id(None).await;
    }

    Ok(())
}
