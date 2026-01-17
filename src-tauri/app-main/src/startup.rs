// 启动步骤函数

use std::fs;
use tauri::Manager;

#[cfg(feature = "self-host")]
use crate::storage::Storage;
#[cfg(feature = "self-host")]
use kabegame_core::settings::Settings;
#[cfg(feature = "self-host")]
use kabegame_core::plugin::PluginManager;
use crate::wallpaper::{WallpaperController, WallpaperRotator};
#[cfg(target_os = "windows")]
use crate::wallpaper::WallpaperWindow;
#[cfg(feature = "virtual-drive")]
use crate::virtual_drive::VirtualDriveService;
use crate::commands::wallpaper::init_wallpaper_on_startup;
use crate::daemon_client;

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

#[cfg(feature = "self-host")]
pub fn startup_step_manage_plugin_manager(app: &mut tauri::App) {
    // 初始化插件管理器
    let plugin_manager = PluginManager::new();
    app.manage(plugin_manager);

    // 每次启动：异步覆盖复制内置插件到用户插件目录（确保可用性/不变性）
    let app_handle_plugins = app.app_handle().clone();
    std::thread::spawn(move || {
        let pm = app_handle_plugins.state::<PluginManager>();
        if let Err(e) = pm.ensure_prepackaged_plugins_installed() {
            eprintln!("[WARN] 启动时安装内置插件失败: {}", e);
        }
        // 内置插件复制完成后，初始化/刷新一次已安装插件缓存（减少后续频繁读盘）
        let _ = pm.refresh_installed_plugins_cache();
    });
}

#[cfg(feature = "self-host")]
pub fn startup_step_manage_storage(app: &mut tauri::App) -> Result<(), String> {
    // 初始化存储管理器
    let storage = Storage::new();
    storage
        .init()
        .map_err(|e| format!("Failed to initialize storage: {}", e))?;
    // 应用启动时清理所有临时文件
    match storage.cleanup_temp_files() {
        Ok(count) => {
            if count > 0 {
                println!("启动时清理了 {} 个临时文件", count);
            }
        }
        Err(e) => {
            eprintln!("清理临时文件失败: {}", e);
        }
    }
    app.manage(storage);
    Ok(())
}

#[cfg(feature = "self-host")]
pub fn startup_step_manage_provider_runtime(app: &mut tauri::App) {
    let mut cfg = kabegame_core::providers::ProviderCacheConfig::default();
    // 可选覆盖 RocksDB 目录
    if let Ok(dir) = std::env::var("KABEGAME_PROVIDER_DB_DIR") {
        cfg.db_dir = std::path::PathBuf::from(dir);
    }
    let rt = match kabegame_core::providers::ProviderRuntime::new(cfg) {
        Ok(v) => v,
        Err(e) => {
            eprintln!(
                "[providers] init ProviderRuntime failed, fallback to default cfg: {}",
                e
            );
            kabegame_core::providers::ProviderRuntime::new(
                kabegame_core::providers::ProviderCacheConfig::default(),
            )
            .expect("ProviderRuntime fallback init failed")
        }
    };
    app.manage(rt);
}

#[cfg(feature = "self-host")]
pub fn startup_step_warm_provider_cache(app: &tauri::AppHandle) {
    // Provider 树缓存 warm：后台执行，失败只记录 warning（不阻塞启动）
    let app_handle = app.clone();
    let storage = app_handle.state::<Storage>().inner().clone();
    tauri::async_runtime::spawn(async move {
        // 给启动留一点时间（避免与大量 IO 初始化竞争）
        tokio::time::sleep(tokio::time::Duration::from_millis(800)).await;

        // NOTE: 这里直接从 AppHandle 取 state（AppHandle 是 Send+Sync，可跨线程使用）
        let rt = app_handle.state::<kabegame_core::providers::ProviderRuntime>();
        let root = std::sync::Arc::new(kabegame_core::providers::RootProvider::default())
            as std::sync::Arc<dyn kabegame_core::providers::provider::Provider>;
        match rt.warm_cache(&storage, root) {
            Ok(_root_desc) => println!("[providers] warm cache ok"),
            Err(e) => eprintln!("[providers] warm cache failed: {}", e),
        }
    });
}

#[cfg(feature = "virtual-drive")]
pub fn startup_step_manage_virtual_drive_service(app: &mut tauri::App) {
    // Windows：虚拟盘服务（Dokan）
    #[cfg(target_os = "windows")]
    {
        use tauri::Listener;

        app.manage(VirtualDriveService::default());

        // 通过后端事件监听把"数据变更"转成"Explorer 刷新"，避免 core 直接依赖 VD。
        let app_handle = app.app_handle().clone();
        // 1) 画册内容变更：刷新对应画册目录
        let app_handle_album_images = app_handle.clone();
        let _album_images_listener = app_handle.listen("album-images-changed", move |event| {
            let payload = event.payload();
            eprintln!("[DEBUG] 收到 album-images-changed 事件: {}", payload);
            let Ok(v) = serde_json::from_str::<serde_json::Value>(payload) else {
                return;
            };
            eprintln!("[DEBUG] album-images-changed 解析后的数据: {:?}", v);
            let Some(album_id) = v.get("albumId").and_then(|x| x.as_str()) else {
                eprintln!("[DEBUG] album-images-changed 事件中缺少 albumId");
                return;
            };
            let reason = v.get("reason").and_then(|x| x.as_str()).unwrap_or("unknown");
            let image_ids = v.get("imageIds").and_then(|x| x.as_array());
            eprintln!("[DEBUG] album-images-changed: albumId={}, reason={}, imageIds={:?}", album_id, reason, image_ids);
            let drive = app_handle_album_images.state::<VirtualDriveService>();
            let storage = app_handle_album_images.state::<Storage>();
            drive.notify_album_dir_changed(storage.inner(), album_id);
        });

        // 2) 画册列表变更：刷新画册子树（新增/删除/重命名等）
        let app_handle_albums = app_handle.clone();
        let _albums_listener = app_handle.listen("albums-changed", move |event: tauri::Event| {
            eprintln!("[DEBUG] 收到 albums-changed 事件: {}", event.payload());
            let drive = app_handle_albums.state::<VirtualDriveService>();
            drive.bump_albums();
        });

        // 3) 任务列表变更：刷新按任务子树（删除任务等）
        let app_handle_tasks = app_handle.clone();
        let _tasks_listener = app_handle.listen("tasks-changed", move |event: tauri::Event| {
            eprintln!("[DEBUG] 收到 tasks-changed 事件: {}", event.payload());
            let drive = app_handle_tasks.state::<VirtualDriveService>();
            drive.bump_tasks();
        });

        // 4) 任务运行中新增图片：刷新"按任务"根目录 + 对应任务目录（Explorer 正在浏览该目录时可见更新）
        let app_handle_task_images = app_handle.clone();
        let _task_images_listener = app_handle.listen("image-added", move |event: tauri::Event| {
            let payload = event.payload();
            eprintln!("[DEBUG] 收到 image-added 事件: {}", payload);
            let Ok(v) = serde_json::from_str::<serde_json::Value>(payload) else {
                eprintln!("[DEBUG] image-added 事件 payload 解析失败");
                return;
            };
            let task_id = v.get("taskId").and_then(|x| x.as_str());
            let image_id = v.get("imageId").and_then(|x| x.as_str());
            let album_id = v.get("albumId").and_then(|x| x.as_str());
            eprintln!("[DEBUG] image-added: taskId={:?}, imageId={:?}, albumId={:?}", task_id, image_id, album_id);
            let Some(task_id) = task_id else {
                return;
            };
            let task_id = task_id.trim();
            if task_id.is_empty() {
                return;
            }
            let drive = app_handle_task_images.state::<VirtualDriveService>();
            let storage = app_handle_task_images.state::<Storage>();
            drive.notify_task_dir_changed(storage.inner(), task_id);
            drive.notify_gallery_tree_changed();
        });
    }
}

#[cfg(feature = "self-host")]
pub fn startup_step_manage_settings(app: &mut tauri::App) {
    // 初始化设置管理器
    let settings = Settings::new();
    app.manage(settings);
}

#[cfg(feature = "virtual-drive")]
pub fn startup_step_auto_mount_album_drive(app: &tauri::AppHandle) {
    // 按设置自动挂载画册盘（不自动弹出 Explorer）
    // 注意：挂载操作可能耗时（尤其是首次挂载或 Dokan 驱动初始化），放到后台线程避免阻塞启动
    #[cfg(feature = "self-host")]
    {
        let settings = app.state::<Settings>().get_settings().ok();
        if let Some(s) = settings {
            if s.album_drive_enabled {
                let mount_point = s.album_drive_mount_point.clone();
                let storage = app.state::<Storage>().inner().clone();
                let app_handle = app.clone();

                // 在后台线程中执行挂载，避免阻塞主线程
                tauri::async_runtime::spawn(async move {
                    // 稍等片刻确保所有服务已初始化完成
                    tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;

                    let drive = app_handle.state::<VirtualDriveService>();
                    match drive.mount(&mount_point, storage, app_handle.clone()) {
                        Ok(_) => {
                            println!("启动时自动挂载画册盘成功: {}", mount_point);
                        }
                        Err(e) => {
                            eprintln!("启动时自动挂载画册盘失败: {} (挂载点: {})", e, mount_point);
                        }
                    }
                });
            }
        }
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
    let wallpaper_controller = WallpaperController::new(app.app_handle().clone());
    app.manage(wallpaper_controller);

    // 初始化壁纸轮播器
    let rotator = WallpaperRotator::new(app.app_handle().clone());
    app.manage(rotator);

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
        // 先确保 daemon 就绪
        if let Err(e) = daemon_client::ensure_daemon_ready(&app_handle).await {
            eprintln!("[WARN] 壁纸初始化前等待 daemon 失败: {}", e);
            return;
        }

        tokio::time::sleep(tokio::time::Duration::from_millis(500)).await; // 延迟启动，确保应用完全初始化

        // 初始化壁纸控制器（如创建窗口等）
        let controller = app_handle.state::<WallpaperController>();
        if let Err(e) = controller.init().await {
            eprintln!("初始化壁纸控制器失败: {}", e);
        }

        println!("初始化壁纸控制器完成");

        // 启动时：按规则恢复/回退"当前壁纸"
        if let Err(e) = init_wallpaper_on_startup(&app_handle).await {
            eprintln!("启动时初始化壁纸失败: {}", e);
        }

        // 初始化完成后：若轮播仍启用，则启动轮播线程
        if let Ok(v) = daemon_client::get_ipc_client().settings_get().await {
            if v.get("wallpaperRotationEnabled")
                .and_then(|x| x.as_bool())
                .unwrap_or(false)
            {
                let rotator = app_handle.state::<WallpaperRotator>();
                if let Err(e) = rotator.start() {
                    eprintln!("启动壁纸轮播失败: {}", e);
                }
            }
        }
    });
}
