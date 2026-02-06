// 启动步骤函数

use std::fs;
use std::sync::Arc;
use kabegame_core::app_paths::kabegame_data_dir;
use kabegame_core::crawler::TaskScheduler;
use kabegame_core::ipc::{DaemonEvent, EventBroadcaster};
use kabegame_core::ipc::events::DaemonEventKind;
use kabegame_core::plugin::PluginManager;
use kabegame_core::settings::Settings;
use tauri::{AppHandle, Emitter, Listener, Manager};
use tauri_plugin_global_shortcut::GlobalShortcutExt;

use crate::commands::wallpaper::init_wallpaper_on_startup;
 #[cfg(any(
    all(not(kabegame_mode = "light"), not(target_os = "android")), 
    all(kabegame_mode = "light", not(target_os = "windows"))
))]
use crate::ipc::Store;
use crate::wallpaper::manager::WallpaperController;
use crate::wallpaper::WallpaperRotator;

pub fn init_app_paths(app: &tauri::AppHandle) {
    kabegame_core::app_paths::init_resource_path(app.path().resolve("resources", tauri::path::BaseDirectory::Resource).unwrap());
}

pub fn init_plugin() {
    tauri::async_runtime::spawn(async {
        // 初始化已安装插件缓存（会自动合并读取内置和用户目录）
        if let Err(e) = PluginManager::global().ensure_installed_cache_initialized().await {
            eprintln!("Failed to initialize plugin cache: {}", e);
        }
    });
}

// 清理用户数据（清理后重启处理真正的清理操作）
pub fn cleanup_user_data_if_marked() -> bool {
    // 检查清理标记，如果存在则先清理旧数据目录
    let app_data_dir = kabegame_data_dir();
    let cleanup_marker = app_data_dir.join(".cleanup_marker");
    let is_cleaning_data = cleanup_marker.exists();
    if is_cleaning_data {
        // 删除标记文件
        let _ = fs::remove_file(&cleanup_marker);
        // 尝试删除整个数据目录
        if app_data_dir.exists() {
            // 使用多次重试，因为文件可能还在被其他进程使用
            let mut retries = 5;
            while retries > 0 {
                match fs::remove_dir_all(&app_data_dir) {
                    Ok(_) => {
                        println!("成功清理应用数据目录");
                        break;
                    }
                    Err(e) => {
                        retries -= 1;
                        if retries == 0 {
                            eprintln!("警告：无法完全清理数据目录，部分文件可能仍在使用中: {}", e);
                            // 尝试删除单个文件而不是整个目录
                            // 至少删除数据库和设置文件
                            let _ = fs::remove_file(app_data_dir.join("images.db"));
                            let _ = fs::remove_file(app_data_dir.join("settings.json"));
                            let _ = fs::remove_file(app_data_dir.join("plugins.json"));
                        } else {
                            // 等待一段时间后重试
                            std::thread::sleep(std::time::Duration::from_millis(200));
                        }
                    }
                }
            }
        }
    }
    is_cleaning_data
}

// 恢复窗口位置
pub fn restore_main_window_state(app: &tauri::AppHandle) {
    // 检查是否是开机启动（没有额外命令行参数，且开启了开机启动）
    let is_auto_startup = is_auto_startup();
    
    if let Some(main_window) = app.get_webview_window("main") {
        let _ = main_window.center();
        if is_auto_startup {
            // 开机启动时隐藏窗口
            let _ = main_window.hide();
        } else {
            // 正常启动时显示窗口
            let _ = main_window.show();
        }
    }
}

/// 检测是否是开机启动
/// 判断逻辑：检查命令行参数中是否有 --auto-startup 参数
fn is_auto_startup() -> bool {
    // 检查命令行参数中是否有 --auto-startup 参数
    std::env::args().any(|arg| arg == "--auto-startup")
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
    #[cfg(target_os = "windows")]
    {
        use tauri::{WebviewUrl, WebviewWindowBuilder};
        let _ = WebviewWindowBuilder::new(
            app,
            "wallpaper",
            // 使用独立的 wallpaper.html，只渲染 WallpaperLayer 组件
            WebviewUrl::App("wallpaper.html".into()),
        )
        // 给壁纸窗口一个固定标题，便于脚本/调试定位到正确窗口
        .title("Kabegame Wallpaper")
        .fullscreen(true)
        .decorations(false)
        // 设置窗口为透明，背景为透明
        .transparent(true)
        .visible(false)
        .skip_taskbar(true)
        .build();
    }

    // 创建系统托盘（使用 Tauri 2.0 内置 API）
    #[cfg(feature = "tray")]
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
    tauri::async_runtime::spawn(async{
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

/// 启动本地事件转发循环（将 Broadcaster 事件转发给 Tauri 前端）
pub fn start_local_event_loop(app: AppHandle) {
    let broadcaster = EventBroadcaster::global();
    tauri::async_runtime::spawn(async move {

        let mut rx = broadcaster.subscribe_filtered_stream(&DaemonEventKind::ALL);
        eprintln!("[LOCAL_EVENT_LOOP] ready for recieve event");
        while let Some((_id, event)) = rx.recv().await {
               let kind = event.kind();

        match &*event {
            DaemonEvent::Generic { event, payload } => {
                let _ = app.emit(event.as_str(), payload.clone());
            }
            DaemonEvent::SettingChange { changes } => {
                let _ = app.emit("setting-change", changes.clone());
            }
            DaemonEvent::WallpaperUpdateImage { image_path } => {
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
            DaemonEvent::WallpaperUpdateStyle { style } => {
                let style = style.clone();
                let controller = crate::wallpaper::manager::WallpaperController::global();
                tokio::spawn(async move {
                    if let Ok(manager) = controller.active_manager().await {
                        let _ = manager.set_style(&style, true).await;
                    }
                });
            }
            DaemonEvent::WallpaperUpdateTransition { transition } => {
                let transition = transition.clone();
                let controller = crate::wallpaper::manager::WallpaperController::global();
                tokio::spawn(async move {
                    if let Ok(manager) = controller.active_manager().await {
                        let _ = manager.set_transition(&transition, true).await;
                    }
                });
            }
            _ => {
                let event_name = kind.as_event_name();
                let payload =
                    serde_json::to_value(&event).unwrap_or_else(|_| serde_json::Value::Null);
                let _ = app.emit(event_name.as_str(), payload);
            }
        }
    }});
}

/// 启动 IPC 服务
#[cfg(not(target_os = "android"))]
pub fn start_ipc_server(ctx: Arc<Store>, app_handle: AppHandle) {
    println!("[IPC_SERVER] Starting IPC server...");

    tauri::async_runtime::spawn(async move {
        // 1. 检查是否有其他实例运行
        if kabegame_core::ipc::server::check_other_daemon_running().await {
            println!("[IPC_SERVER] Another instance detected. Forwarding request and exiting...");
            
            use kabegame_core::ipc::ipc::{CliIpcRequest, request};
            
            // 请求 1: 显示窗口
            let _ = request(CliIpcRequest::AppShowWindow).await;
            
            // 请求 2: 导入插件
            if let Some(path) = extract_kgpg_file_from_args() {
                let _ = request(CliIpcRequest::AppImportPlugin { kgpg_path: path }).await;
            }
            
            std::process::exit(0);
        }

        // 2. 首次启动：处理启动参数
        if let Some(path) = extract_kgpg_file_from_args() {
             let app_handle_clone = app_handle.clone();
             // 等待前端准备好
             app_handle.once("app-ready", move |_| {
                 let _ = app_handle_clone.emit("app-import-plugin", serde_json::json!({
                     "kgpgPath": path
                 }));
             });
        }

        // 3. 启动服务器
        let res = kabegame_core::ipc::server::serve_with_events(
            move |req| {
                let ctx = ctx.clone();
                async move {
                    // eprintln!("[DEBUG] Backend 收到请求: {:?}", req);
                    use crate::ipc::dispatch_request;
                    let resp = dispatch_request(req, ctx).await;
                    resp
                }
            },
        ).await;
        
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
        TaskScheduler::global().set_download_concurrency(
            Settings::global().get_max_concurrent_downloads().await.unwrap()
        )
    });
}

pub fn start_download_workers() {
    tauri::async_runtime::spawn(async {
        TaskScheduler::global().start_workers(10).await;
    });
}

/// 启动 TaskScheduler（启动 DownloadQueue 的 worker）
pub fn start_task_scheduler() {
    tauri::async_runtime::spawn(async {
        TaskScheduler::global().start_decompression_worker().await;
    });
    tauri::async_runtime::spawn(async {
        TaskScheduler::global().start_dispatcher_loop().await;
    });
    tauri::async_runtime::spawn(async {
        TaskScheduler::global().start_download_workers_async().await;
    });
}

pub fn init_shortcut(app: &tauri::App) -> Result<(), String> {
    // macOS 使用系统自带的 Control + Command + F 全屏快捷键，无需手动注册
    // 其他平台（Windows/Linux）注册 F11 快捷键切换全屏
    #[cfg(not(target_os = "macos"))]
    {
        use tauri_plugin_global_shortcut::Shortcut;

        let app_handle = app.app_handle().clone();
        let shortcuts = app.global_shortcut();

        // 注册并监听 F11 快捷键切换全屏
        let f11_shortcut = Shortcut::new(
            Some(tauri_plugin_global_shortcut::Modifiers::empty()),
            tauri_plugin_global_shortcut::Code::F11,
        );

        let app_handle_clone = app_handle.clone();
        shortcuts.on_shortcuts([f11_shortcut], move |_app_handle, shortcut, event| {
            // 检查是否是 F11 快捷键（无修饰键 + F11）且是按下事件
            if shortcut.mods.is_empty()
                && shortcut.key.eq(&tauri_plugin_global_shortcut::Code::F11)
                && matches!(
                    event.state,
                    tauri_plugin_global_shortcut::ShortcutState::Pressed
                )
            {
                let app_handle = app_handle_clone.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(e) = commands::window::toggle_fullscreen(app_handle).await {
                        eprintln!("Failed to toggle fullscreen: {}", e);
                    }
                });
            }
        }).map_err(|e| format!("初始化快捷键失败"))?;

        println!("✓ F11 shortcut registered for fullscreen toggle");
    }
    
    Ok(())
}


