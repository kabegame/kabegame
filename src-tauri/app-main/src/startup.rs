// 启动步骤函数

use std::fs;
use tauri::{Listener, Manager};

use crate::commands::wallpaper::init_wallpaper_on_startup;
use crate::daemon_client;
#[cfg(feature = "self-hosted")]
use crate::storage::Storage;
#[cfg(target_os = "windows")]
use crate::wallpaper::WallpaperWindow;
use crate::wallpaper::{WallpaperController, WallpaperRotator};
#[cfg(feature = "self-hosted")]
use kabegame_core::plugin::PluginManager;
#[cfg(feature = "self-hosted")]
use kabegame_core::settings::Settings;

pub fn startup_step_cleanup_user_data_if_marked(app: &tauri::AppHandle) -> bool {
    // 检查清理标记，如果存在则先清理旧数据目录
    let app_data_dir = match app.path().app_data_dir() {
        Ok(p) => p,
        Err(e) => {
            eprintln!("Failed to resolve app data dir: {e}");
            return false;
        }
    };
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

#[cfg(feature = "self-hosted")]
pub fn startup_step_manage_plugin_manager(_app: &mut tauri::App) {
    // 初始化全局 PluginManager
    if let Err(e) = PluginManager::init_global() {
        eprintln!("Failed to initialize plugin manager: {}", e);
        return;
    }

    // 每次启动：异步覆盖复制内置插件到用户插件目录（确保可用性/不变性）
    std::thread::spawn(move || {
        let pm = PluginManager::global();
        if let Err(e) = pm.ensure_prepackaged_plugins_installed() {
            eprintln!("[WARN] 启动时安装内置插件失败: {}", e);
        }
        // 内置插件复制完成后，初始化/刷新一次已安装插件缓存（减少后续频繁读盘）
        let _ = pm.refresh_installed_plugins_cache();
    });
}

#[cfg(feature = "self-hosted")]
pub fn startup_step_manage_storage(_app: &mut tauri::App) -> Result<(), String> {
    // 初始化全局 Storage
    Storage::init_global().map_err(|e| format!("Failed to initialize storage: {}", e))?;
    // 应用启动时清理所有临时文件
    match Storage::global().cleanup_temp_files() {
        Ok(count) => {
            if count > 0 {
                println!("启动时清理了 {} 个临时文件", count);
            }
        }
        Err(e) => {
            eprintln!("清理临时文件失败: {}", e);
        }
    }
    Ok(())
}

#[cfg(feature = "self-hosted")]
pub fn startup_step_manage_provider_runtime(_app: &mut tauri::App) {
    let mut cfg = kabegame_core::providers::ProviderCacheConfig::default();
    // 可选覆盖 RocksDB 目录
    if let Ok(dir) = std::env::var("KABEGAME_PROVIDER_DB_DIR") {
        cfg.db_dir = std::path::PathBuf::from(dir);
    }
    // 使用全局单例（不再使用 manage）
    if let Err(e) = kabegame_core::providers::ProviderRuntime::init_global(cfg) {
        eprintln!(
            "[providers] init ProviderRuntime failed, fallback to default cfg: {}",
            e
        );
        kabegame_core::providers::ProviderRuntime::init_global(
            kabegame_core::providers::ProviderCacheConfig::default(),
        )
        .expect("ProviderRuntime fallback init failed");
    }
}

#[cfg(feature = "self-hosted")]
pub fn startup_step_warm_provider_cache(app: &tauri::AppHandle) {
    // Provider 树缓存 warm：后台执行，失败只记录 warning（不阻塞启动）
    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        // 给启动留一点时间（避免与大量 IO 初始化竞争）
        tokio::time::sleep(tokio::time::Duration::from_millis(800)).await;

        // 使用全局单例（不再使用 state）
        let rt = kabegame_core::providers::ProviderRuntime::global();
        let storage = Storage::global();
        let root = std::sync::Arc::new(kabegame_core::providers::RootProvider::default())
            as std::sync::Arc<dyn kabegame_core::providers::provider::Provider>;
        match rt.warm_cache(storage, root) {
            Ok(_root_desc) => println!("[providers] warm cache ok"),
            Err(e) => eprintln!("[providers] warm cache failed: {}", e),
        }
    });
}

#[cfg(all(feature = "virtual-driver", feature = "self-hosted"))]
pub fn startup_step_manage_virtual_drive_service(_app: &mut tauri::App) {
    // Windows：虚拟盘服务（Dokan）
    #[cfg(target_os = "windows")]
    {
        use tauri::Listener;

        // 使用全局单例（不再使用 manage）
        if let Err(e) = VirtualDriveService::init_global() {
            eprintln!("Failed to initialize VirtualDriveService: {}", e);
            return;
        }

        // 通过后端事件监听把"数据变更"转成"Explorer 刷新"，避免 core 直接依赖 VD。
        let app_handle = _app.app_handle().clone();
        // 1) 画册列表变更：刷新画册子树（新增/删除/重命名等）
        let _albums_listener = app_handle.listen("albums-changed", move |_event: tauri::Event| {
            let drive = VirtualDriveService::global();
            drive.bump_albums();
        });

        // 2) 任务列表变更：刷新按任务子树（删除任务等）
        let _tasks_listener = app_handle.listen("tasks-changed", move |_event: tauri::Event| {
            let drive = VirtualDriveService::global();
            drive.bump_tasks();
        });

        // 3) 统一图片变更事件：仅保留 images-change
        // - 若带 taskId：刷新对应任务目录
        // - 若带 albumId：刷新对应画册目录
        // - 总是刷新 gallery 树
        let _images_change_listener =
            app_handle.listen("images-change", move |event: tauri::Event| {
                let payload = event.payload();
                let Ok(v) = serde_json::from_str::<serde_json::Value>(payload) else {
                    return;
                };
                let task_id = v
                    .get("taskId")
                    .and_then(|x| x.as_str())
                    .map(|s| s.trim().to_string());
                let album_id = v
                    .get("albumId")
                    .and_then(|x| x.as_str())
                    .map(|s| s.trim().to_string());
                let drive = VirtualDriveService::global();
                let storage = Storage::global();
                if let Some(tid) = task_id {
                    if !tid.is_empty() {
                        drive.notify_task_dir_changed(storage, &tid);
                    }
                }
                if let Some(aid) = album_id {
                    if !aid.is_empty() {
                        drive.notify_album_dir_changed(storage, &aid);
                    }
                }
                drive.notify_gallery_tree_changed();
            });
    }
}

#[cfg(feature = "self-hosted")]
pub fn startup_step_manage_settings(_app: &mut tauri::App) {
    // Settings 现在是全局单例，不需要 manage
    // 初始化全局 Settings
    if let Err(e) = Settings::init_global() {
        eprintln!("Failed to initialize settings: {}", e);
    }
}

pub fn startup_step_restore_main_window_state(app: &tauri::AppHandle, is_cleaning_data: bool) {
    // 不恢复 window_state：用户要求每次居中弹出
    if is_cleaning_data {
        return;
    }
    if let Some(main_window) = app.get_webview_window("main") {
        let _ = main_window.center();
    }
}

pub fn startup_step_manage_wallpaper_components(app: &mut tauri::App) {
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

    // 初始化壁纸控制器，然后根据设置决定是否启动轮播
    // 注意：不要在 Tokio runtime 内再 `block_on`（会触发 "Cannot start a runtime from within a runtime"）
    let app_handle = app.app_handle().clone();
    tauri::async_runtime::spawn(async move {
        // 先快速检查 daemon 是否已经可用（可能 setup 阶段已经连接成功）
        if daemon_client::is_daemon_available().await {
            // daemon 已就绪，直接继续
        } else {
            // daemon 不可用，等待 daemon-ready 或 daemon-offline 事件
            let (tx, rx) = tokio::sync::oneshot::channel::<bool>();
            let tx = std::sync::Arc::new(std::sync::Mutex::new(Some(tx)));

            // 监听 daemon-ready 事件
            let tx_ready = tx.clone();
            let _listener_ready = app_handle.once("daemon-ready", move |_event| {
                if let Some(sender) = tx_ready.lock().unwrap().take() {
                    let _ = sender.send(true); // true = ready
                }
            });

            // 监听 daemon-offline 事件
            let tx_offline = tx.clone();
            let _listener_offline = app_handle.once("daemon-offline", move |_event| {
                if let Some(sender) = tx_offline.lock().unwrap().take() {
                    let _ = sender.send(false); // false = offline
                }
            });

            // 等待事件（带超时）
            match tokio::time::timeout(tokio::time::Duration::from_secs(30), rx).await {
                Ok(Ok(true)) => {
                    // daemon ready，继续
                }
                Ok(Ok(false)) | Ok(Err(_)) | Err(_) => {
                    eprintln!("[WARN] daemon 不可用或等待超时，跳过壁纸初始化");
                    return;
                }
            }
        }

        tokio::time::sleep(tokio::time::Duration::from_millis(500)).await; // 延迟启动，确保应用完全初始化

        // 初始化壁纸控制器（如创建窗口等）
        // 使用全局单例（不再使用 state）
        let controller = WallpaperController::global();
        if let Err(e) = controller.init().await {
            eprintln!("初始化壁纸控制器失败: {}", e);
        }

        println!("初始化壁纸控制器完成");

        // 启动时：按规则恢复/回退"当前壁纸"
        if let Err(e) = init_wallpaper_on_startup().await {
            eprintln!("启动时初始化壁纸失败: {}", e);
        }

        // 初始化完成后：若轮播仍启用，则启动轮播线程
        if let Ok(enabled) = daemon_client::get_ipc_client()
            .settings_get_wallpaper_rotation_enabled()
            .await
        {
            if enabled {
                // 使用全局单例（不再使用 state）
                let rotator = WallpaperRotator::global();
                if let Err(e) = rotator.start().await {
                    eprintln!("启动壁纸轮播失败: {}", e);
                }
            }
        }
    });
}
