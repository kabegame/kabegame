mod commands;
mod startup;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod tray;
mod utils;
mod wallpaper;

// IPC and daemon related modules
mod ipc;
#[cfg(all(not(kabegame_mode = "light"), not(target_os = "android")))]
mod vd_listener;

use commands::*;
use core::fmt;
use startup::*;
use std::process;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use tauri_plugin_global_shortcut::GlobalShortcutExt;

// Daemon Imports
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use crate::ipc::dedupe_service::DedupeService;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use crate::ipc::handlers::{dispatch_request, Store};
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use kabegame_core::ipc::events::{DaemonEvent, DaemonEventKind};
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use kabegame_core::ipc::server::{EventBroadcaster, SubscriptionManager};
use kabegame_core::{
    crawler::{DownloadQueue, TaskScheduler},
    plugin::PluginManager,
    providers::{ProviderCacheConfig, ProviderRuntime},
    settings::Settings,
    storage::Storage,
};

#[cfg(all(not(kabegame_mode = "light"), not(target_os = "android")))]
use kabegame_core::virtual_driver::VirtualDriveService;

/// 初始化全局状态，并返回 Context（仅桌面端）
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn init_globals(app_handle: tauri::AppHandle) -> Result<Arc<Store>, String> {
    println!("Kabegame v{} bootstrap...", env!("CARGO_PKG_VERSION"));
    println!("Initializing Globals...");

    Settings::init_global().map_err(|e| format!("Failed to initialize settings: {}", e))?;
    println!("  ✓ Settings initialized");

    // 初始化全局 PluginManager
    PluginManager::init_global()
        .map_err(|e| format!("Failed to initialize plugin manager: {}", e))?;
    println!("  ✓ Plugin manager initialized");

    // 初始化全局 Storage
    Storage::init_global().map_err(|e| format!("Failed to initialize storage: {}", e))?;

    // 将 pending 或 running 的任务标记为失败
    let failed_count = Storage::global()
        .mark_pending_running_tasks_as_failed()
        .unwrap_or(0);
    if failed_count > 0 {
        println!("  ✓ Marked {failed_count} pending/running task(s) as failed");
    }
    println!("  ✓ Storage initialized");

    // 初始化全局事件广播器（保留最近 1000 个事件）
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        EventBroadcaster::init_global(1000)
            .map_err(|e| format!("Failed to initialize event broadcaster: {}", e))?;
        println!("  ✓ Event broadcaster initialized");

        // 初始化全局订阅管理器
        SubscriptionManager::init_global()
            .map_err(|e| format!("Failed to initialize subscription manager: {}", e))?;
        println!("  ✓ Subscription manager initialized");
    }

    // 初始化全局 emitter（仅桌面端）
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        kabegame_core::emitter::GlobalEmitter::init_global()
            .map_err(|e| format!("Failed to initialize global emitter: {}", e))?;
        println!("  ✓ Global emitter initialized");
    }

    println!("  ✓ Runtime initialized");

    let download_queue = Arc::new(DownloadQueue::new());
    println!("  ✓ DownloadQueue initialized");

    // TaskScheduler：负责处理 PluginRun 的任务队列（全局单例）
    TaskScheduler::init_global(download_queue.clone())
        .map_err(|e| format!("Failed to initialize task scheduler: {}", e))?;
    println!("  ✓ TaskScheduler initialized");

    // 创建请求上下文（仅桌面端）
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    let dedupe_service = Arc::new(DedupeService::new());

    // 初始化全局 ProviderRuntime
    {
        let mut cfg = ProviderCacheConfig::default();
        if let Ok(dir) = std::env::var("KABEGAME_PROVIDER_DB_DIR") {
            cfg.db_dir = std::path::PathBuf::from(dir);
        }

        // 尝试初始化 ProviderRuntime
        // 注意：这里仍然有锁检查逻辑，但因为是内嵌，通常我们是唯一的实例。
        // 如果有其他实例（如旧版 daemon）运行，这里会报错，这是预期的。
        if let Err(e) = ProviderRuntime::init_global(cfg.clone()) {
            eprintln!("[providers] Init failed: {}", e);
            // 尝试 fallback
            if let Err(e2) = ProviderRuntime::init_global(ProviderCacheConfig::default()) {
                return Err(format!("ProviderRuntime init failed: {}", e2));
            }
        }
    }
    println!("  ✓ ProviderRuntime initialized");

    // Virtual Driver
    #[cfg(all(not(kabegame_mode = "light"), not(target_os = "android")))]
    VirtualDriveService::init_global().map_err(|e| format!("Failed to init VD service: {}", e))?;
    #[cfg(all(not(kabegame_mode = "light"), not(target_os = "android")))]
    let virtual_drive_service = VirtualDriveService::global();
    #[cfg(all(not(kabegame_mode = "light"), not(target_os = "android")))]
    println!("  ✓ Virtual drive support enabled");

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    let ctx = Arc::new(Store {
        dedupe_service,
        #[cfg(all(not(kabegame_mode = "light"), not(target_os = "android")))]
        virtual_drive_service: virtual_drive_service.clone(),
        app_handle: Arc::new(tokio::sync::RwLock::new(Some(app_handle))),
    });

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    Store::init_global(ctx.clone())?;

    // 启动虚拟磁盘事件监听器（仅在 非 light 且非 Android）
    #[cfg(all(not(kabegame_mode = "light"), not(target_os = "android")))]
    {
        #[cfg(target_os = "windows")]
        tauri::async_runtime::spawn({
            vd_listener::start_vd_event_listener(virtual_drive_service.clone());
            println!("  ✓ Virtual drive event listener started");
        });

        // 启动时根据设置自动挂载画册盘
        let vd_service_for_mount = virtual_drive_service.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;

            let enabled = Settings::global()
                .get_album_drive_enabled()
                .await
                .unwrap_or(false);
            let mount_point = Settings::global()
                .get_album_drive_mount_point()
                .await
                .unwrap_or_default();

            if enabled && !mount_point.is_empty() {
                use kabegame_core::virtual_driver::driver_service::VirtualDriveServiceTrait;
                let mount_result = tokio::task::spawn_blocking({
                    let vd_service = vd_service_for_mount.clone();
                    let mount_point = mount_point.clone();
                    move || vd_service.mount(mount_point.as_str())
                })
                .await;

                if let Err(e) = mount_result {
                    eprintln!("Auto mount failed: {}", e);
                } else if let Ok(Err(e)) = mount_result {
                    eprintln!("Auto mount failed: {}", e);
                }
            }
        });
    }

    Ok(ctx)
}

/// 初始化全局状态（Android/iOS 简化版本）
#[cfg(any(target_os = "android", target_os = "ios"))]
fn init_globals_mobile(app_handle: tauri::AppHandle) -> Result<(), String> {
    println!("Kabegame v{} bootstrap...", env!("CARGO_PKG_VERSION"));
    println!("Initializing Globals...");

    Settings::init_global().map_err(|e| format!("Failed to initialize settings: {}", e))?;
    println!("  ✓ Settings initialized");

    // 初始化全局 PluginManager
    PluginManager::init_global()
        .map_err(|e| format!("Failed to initialize plugin manager: {}", e))?;
    println!("  ✓ Plugin manager initialized");

    // 初始化全局 Storage
    Storage::init_global().map_err(|e| format!("Failed to initialize storage: {}", e))?;

    // 将 pending 或 running 的任务标记为失败
    let failed_count = Storage::global()
        .mark_pending_running_tasks_as_failed()
        .unwrap_or(0);
    if failed_count > 0 {
        println!("  ✓ Marked {failed_count} pending/running task(s) as failed");
    }
    println!("  ✓ Storage initialized");

    println!("  ✓ Runtime initialized");

    let download_queue = Arc::new(DownloadQueue::new());
    println!("  ✓ DownloadQueue initialized");

    // TaskScheduler：负责处理 PluginRun 的任务队列（全局单例）
    TaskScheduler::init_global(download_queue.clone())
        .map_err(|e| format!("Failed to initialize task scheduler: {}", e))?;
    println!("  ✓ TaskScheduler initialized");

    // 初始化全局 ProviderRuntime
    {
        let mut cfg = ProviderCacheConfig::default();
        if let Ok(dir) = std::env::var("KABEGAME_PROVIDER_DB_DIR") {
            cfg.db_dir = std::path::PathBuf::from(dir);
        }

        if let Err(e) = ProviderRuntime::init_global(cfg.clone()) {
            eprintln!("[providers] Init failed: {}", e);
            if let Err(e2) = ProviderRuntime::init_global(ProviderCacheConfig::default()) {
                return Err(format!("ProviderRuntime init failed: {}", e2));
            }
        }
    }
    println!("  ✓ ProviderRuntime initialized");

    Ok(())
}

/// 注册 Android 文件夹选择器插件，并注册 content URI 解析器供本地导入使用。
/// 解析器使用 listContentChildren / readContentUri 两个原语，在 Rust 端做递归与扩展名过滤。
#[cfg(target_os = "android")]
fn init_folder_picker_plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    use kabegame_core::crawler::local_import::set_content_uri_resolver;
    use serde::{Deserialize, Serialize};
    use std::path::PathBuf;
    use tauri::plugin::{Builder, PluginHandle, TauriPlugin};

    fn is_wanted_file_ext(name: &str) -> bool {
        let ext = name.rsplit('.').next().unwrap_or("").to_lowercase();
        matches!(
            ext.as_str(),
            "jpg" | "jpeg" | "png" | "gif" | "webp" | "bmp" | "ico" | "zip" | "rar"
        )
    }

    Builder::new("folder-picker")
        .setup(|_app, api| {
            let handle =
                api.register_android_plugin("app.kabegame.plugin", "FolderPickerPlugin")?;

            #[derive(Serialize)]
            struct ListContentChildrenArgs {
                uri: String,
            }

            #[derive(Deserialize)]
            struct ContentEntry {
                uri: String,
                name: String,
                #[serde(rename = "isDirectory")]
                is_directory: bool,
            }

            #[derive(Deserialize)]
            struct ListContentChildrenResponse {
                entries: Vec<ContentEntry>,
            }

            #[derive(Serialize)]
            struct ReadContentUriArgs {
                uri: String,
            }

            #[derive(Deserialize)]
            struct ReadContentUriResponse {
                path: String,
            }

            fn resolve_content_uri_rec(
                handle: &PluginHandle<R>,
                uri: String,
                recursive: bool,
            ) -> Result<Vec<PathBuf>, String> {
                let list_args = ListContentChildrenArgs { uri: uri.clone() };
                let list_resp: ListContentChildrenResponse = tauri::async_runtime::block_on(
                    handle.run_mobile_plugin_async("listContentChildren", list_args),
                )
                .map_err(|e| format!("listContentChildren 失败: {}", e))?;

                let mut out = Vec::new();
                for e in list_resp.entries {
                    if e.is_directory {
                        if recursive {
                            out.extend(resolve_content_uri_rec(handle, e.uri, true)?);
                        }
                    } else if is_wanted_file_ext(&e.name) {
                        let read_args = ReadContentUriArgs { uri: e.uri };
                        let read_resp: ReadContentUriResponse = tauri::async_runtime::block_on(
                            handle.run_mobile_plugin_async("readContentUri", read_args),
                        )
                        .map_err(|e| format!("readContentUri 失败: {}", e))?;
                        out.push(PathBuf::from(read_resp.path));
                    }
                }
                Ok(out)
            }

            set_content_uri_resolver(move |uri: String, recursive: bool| {
                resolve_content_uri_rec(&handle, uri, recursive)
            });

            Ok(())
        })
        .build()
}

/// 注册 Android 壁纸插件
#[cfg(target_os = "android")]
fn init_wallpaper_plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    use tauri::plugin::{Builder, TauriPlugin};

    Builder::new("wallpaper")
        .setup(|_app, api| {
            let _handle = api.register_android_plugin("app.kabegame.plugin", "WallpaperPlugin")?;
            Ok(())
        })
        .build()
}

/// 注册 Android 分享插件（将 handle 存入 app state，供 share_file 命令使用）
#[cfg(target_os = "android")]
fn init_share_plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    use tauri::plugin::{Builder, TauriPlugin};

    Builder::new("share")
        .setup(|app, api| {
            let handle = api.register_android_plugin("app.kabegame.plugin", "SharePlugin")?;
            app.manage(handle);
            Ok(())
        })
        .build()
}

#[cfg(target_os = "android")]
fn init_resource_plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    use tauri::plugin::{Builder, TauriPlugin};

    Builder::new("resource")
        .setup(|app, api| {
            let handle = api.register_android_plugin("app.kabegame.plugin", "ResourcePlugin")?;
            // Extract plugins after registration (init_app_paths has already been called)
            let app_handle = app.app_handle().clone();
            let handle_clone = handle.clone();
            tauri::async_runtime::spawn(async move {
                // Small delay to ensure all initialization is complete
                tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
                if let Err(e) = extract_bundled_plugins(&app_handle, &handle_clone).await {
                    eprintln!("Failed to extract bundled plugins: {}", e);
                }
            });
            Ok(())
        })
        .build()
}

#[cfg(target_os = "android")]
async fn extract_bundled_plugins<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    plugin_handle: &tauri::plugin::PluginHandle<R>,
) -> Result<(), String> {
    use serde::{Deserialize, Serialize};

    #[derive(Serialize)]
    struct ExtractArgs {
        target_dir: String,
    }

    #[derive(Deserialize)]
    struct ExtractResponse {
        files: Vec<String>,
        count: usize,
    }

    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {}", e))?;
    let builtin_dir = app_data_dir.join("builtin-plugins");

    std::fs::create_dir_all(&builtin_dir)
        .map_err(|e| format!("Failed to create builtin-plugins directory: {}", e))?;

    let target_dir_str = builtin_dir.to_string_lossy().to_string();
    let response: ExtractResponse = plugin_handle
        .run_mobile_plugin_async(
            "extractBundledPlugins",
            ExtractArgs {
                target_dir: target_dir_str,
            },
        )
        .await
        .map_err(|e| format!("Failed to call extractBundledPlugins: {}", e))?;

    println!(
        "Extracted {} bundled plugins to {}",
        response.count,
        builtin_dir.display()
    );
    Ok(())
}

/// Tauri 应用入口（桌面 binary 与 Android/iOS 共用）
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init());

    #[cfg(target_os = "android")]
    {
        builder = builder.plugin(init_folder_picker_plugin());
        builder = builder.plugin(init_wallpaper_plugin());
        builder = builder.plugin(init_share_plugin());
        builder = builder.plugin(init_resource_plugin());
    }

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        builder = builder.plugin(tauri_plugin_global_shortcut::Builder::new().build());
    }

    let app = builder
        .setup(|app| {
            init_app_paths(app.app_handle());

            // 设置全局快捷键
            #[cfg(not(any(target_os = "android", target_os = "ios")))]
            init_shortcut(app).unwrap();

            // 启动内置 Backend
            #[cfg(not(any(target_os = "android", target_os = "ios")))]
            match init_globals(app.app_handle().clone()) {
                Ok(ctx) => {
                    // 启动本地事件转发
                    start_local_event_loop(app.app_handle().clone());
                    // 清理用户数据
                    cleanup_user_data_if_marked();
                    // 恢复窗口状态（当前实现仅将窗口居屏幕中央）
                    restore_main_window_state(app.app_handle());
                    // 初始化壁纸控制器
                    init_wallpaper_controller(app);
                    // 启动 TaskScheduler（启动 DownloadQueue 的 worker）
                    start_task_scheduler();
                    // 初始化download worker的并发数
                    init_download_workers();
                    // 初始化任务阻塞worker
                    start_download_workers();
                    // 启动事件转发任务
                    start_event_forward_task();
                    // 初始化插件
                    init_plugin();

                    // 启动 IPC Server（Android 不启用以避免虚拟盘等依赖）
                    #[cfg(not(any(target_os = "android", target_os = "ios")))]
                    startup::start_ipc_server(ctx, app.app_handle().clone());
                }
                Err(e) => {
                    utils::show_error(app.app_handle(), format!("出现了致命错误！: {}", e));
                    eprintln!("出现了致命错误！:{}", e);
                    process::exit(1);
                }
            }
            #[cfg(any(target_os = "android", target_os = "ios"))]
            {
                // Android/iOS 平台：简化初始化流程
                match init_globals_mobile(app.app_handle().clone()) {
                    Ok(_) => {
                        cleanup_user_data_if_marked();
                        init_wallpaper_controller(app);
                        start_task_scheduler();
                        init_download_workers();
                        start_download_workers();
                        init_plugin();
                    }
                    Err(e) => {
                        utils::show_error(app.app_handle(), format!("出现了致命错误！: {}", e));
                        eprintln!("出现了致命错误！:{}", e);
                        process::exit(1);
                    }
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            #[cfg(target_os = "linux")]
            read_file,
            // --- Albums ---
            get_albums,
            get_album_counts,
            add_album,
            delete_album,
            rename_album,
            get_album_preview,
            get_album_images,
            get_album_image_ids,
            add_images_to_album,
            remove_images_from_album,
            update_album_images_order,
            get_favorite_album_id,
            // --- Images ---
            get_images_range,
            get_image_by_id,
            get_gallery_image,
            copy_image_to_clipboard,
            delete_image,
            remove_image,
            batch_delete_images,
            batch_remove_images,
            get_images_count,
            browse_gallery_provider,
            toggle_image_favorite,
            // --- Tasks ---
            get_all_tasks,
            get_task,
            add_task,
            update_task,
            delete_task,
            start_task,
            cancel_task,
            clear_finished_tasks,
            confirm_task_rhai_dump,
            get_task_images,
            get_task_images_paginated,
            get_task_image_ids,
            get_task_failed_images,
            retry_task_failed_image,
            get_active_downloads,
            // --- Run Configs ---
            get_run_configs,
            add_run_config,
            update_run_config,
            delete_run_config,
            // --- Plugins ---
            get_plugins,
            get_plugin_detail,
            delete_plugin,
            get_browser_plugins,
            install_browser_plugin,
            refresh_installed_plugins_cache,
            refresh_installed_plugin_cache,
            get_plugin_sources,
            save_plugin_sources,
            validate_plugin_source,
            get_store_plugins,
            preview_import_plugin,
            preview_import_plugin_with_icon,
            preview_store_install,
            import_plugin_from_zip,
            get_plugin_image,
            get_plugin_image_for_detail,
            get_plugin_icon,
            get_remote_plugin_icon,
            get_plugin_doc_from_zip,
            get_plugin_image_from_zip,
            get_plugin_vars,
            get_build_mode,
            // --- Settings ---
            get_auto_launch,
            set_auto_launch,
            get_max_concurrent_downloads,
            set_max_concurrent_downloads,
            get_network_retry_count,
            set_network_retry_count,
            get_image_click_action,
            set_image_click_action,
            get_gallery_image_aspect_ratio,
            set_gallery_image_aspect_ratio,
            get_auto_deduplicate,
            set_auto_deduplicate,
            get_default_download_dir,
            set_default_download_dir,
            get_default_images_dir,
            get_desktop_resolution,
            clear_user_data,
            // --- Wallpaper ---
            set_wallpaper,
            set_wallpaper_mode,
            set_wallpaper_by_image_id,
            get_current_wallpaper_image_id,
            clear_current_wallpaper_image_id,
            get_current_wallpaper_path,
            set_wallpaper_rotation_enabled,
            get_wallpaper_rotation_enabled,
            set_wallpaper_rotation_album_id,
            get_wallpaper_rotation_album_id,
            start_wallpaper_rotation,
            set_wallpaper_rotation_interval_minutes,
            get_wallpaper_rotation_interval_minutes,
            set_wallpaper_rotation_mode,
            get_wallpaper_rotation_mode,
            set_wallpaper_style,
            get_wallpaper_style_by_mode,
            get_wallpaper_rotation_style,
            set_wallpaper_rotation_transition,
            get_wallpaper_rotation_transition,
            get_wallpaper_transition_by_mode,
            get_wallpaper_mode,
            get_wallpaper_rotator_status,
            #[cfg(target_os = "windows")]
            fix_wallpaper_zorder,
            // --- Wallpaper Engine (Windows) ---
            #[cfg(target_os = "windows")]
            get_wallpaper_engine_dir,
            #[cfg(target_os = "windows")]
            set_wallpaper_engine_dir,
            #[cfg(target_os = "windows")]
            get_wallpaper_engine_myprojects_dir,
            #[cfg(target_os = "windows")]
            export_album_to_we_project,
            #[cfg(target_os = "windows")]
            export_images_to_we_project,
            // --- Virtual Drive ---
            #[cfg(all(not(kabegame_mode = "light"), not(target_os = "android")))]
            get_album_drive_enabled,
            #[cfg(all(not(kabegame_mode = "light"), not(target_os = "android")))]
            set_album_drive_enabled,
            #[cfg(all(not(kabegame_mode = "light"), not(target_os = "android")))]
            get_album_drive_mount_point,
            #[cfg(all(not(kabegame_mode = "light"), not(target_os = "android")))]
            set_album_drive_mount_point,
            // --- Window ---
            hide_main_window,
            #[cfg(not(target_os = "android"))]
            toggle_fullscreen,
            get_window_state,
            #[cfg(any(target_os = "windows", target_os = "macos"))]
            set_main_sidebar_blur,
            #[cfg(target_os = "windows")]
            wallpaper_window_ready,
            // --- Filesystem ---
            open_explorer,
            open_file_path,
            open_file_folder,
            // --- Misc ---
            get_file_drop_supported_types,
            get_supported_image_types,
            migrate_images_from_json,
            #[cfg(not(any(target_os = "android", target_os = "ios")))]
            start_dedupe_gallery_by_hash_batched,
            #[cfg(not(any(target_os = "android", target_os = "ios")))]
            cancel_dedupe_gallery_by_hash_batched,
            // --- Share (Android) ---
            #[cfg(target_os = "android")]
            share_file,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle: &tauri::AppHandle, event| {
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Opened { urls } = event {
            for url in urls {
                if let Ok(path) = url.to_file_path() {
                    if let Some(s) = path.to_str() {
                        if s.ends_with(".kgpg") {
                            let _ = app_handle.emit(
                                "app-import-plugin",
                                serde_json::json!({
                                    "kgpgPath": s
                                }),
                            );
                        } else {
                            eprintln!("[KGPG_DEBUG] [macOS] ✗ 文件不是 .kgpg 格式: {}", s);
                        }
                    } else {
                        eprintln!("[KGPG_DEBUG] [macOS] ✗ 无法将路径转换为字符串: {:?}", path);
                    }
                } else {
                    eprintln!("[KGPG_DEBUG] [macOS] ✗ 无法从 URL 提取文件路径: {}", url);
                }
            }
        }
    });
}
