mod commands;
mod startup;
mod utils;
#[cfg(feature = "tray")]
mod tray;
mod wallpaper;

// IPC and daemon related modules
mod ipc;
#[cfg(all(not(kabegame_mode = "light"), not(target_os = "android")))]
mod vd_listener;


use core::fmt;
use std::process;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_global_shortcut::GlobalShortcutExt;
use commands::*;
use startup::*;

// Daemon Imports
use crate::ipc::dedupe_service::DedupeService;
use crate::ipc::handlers::{dispatch_request, Store};
use kabegame_core::ipc::server::{EventBroadcaster, SubscriptionManager};
use kabegame_core::{
    crawler::{DownloadQueue, TaskScheduler},
    ipc::events::{DaemonEvent, DaemonEventKind},
    plugin::PluginManager,
    providers::{ProviderCacheConfig, ProviderRuntime},
    settings::Settings,
    storage::Storage,
};

#[cfg(all(not(kabegame_mode = "light"), not(target_os = "android")))]
use kabegame_core::virtual_driver::VirtualDriveService;

/// 初始化全局状态，并返回 Context
fn init_globals() -> Result<Arc<Store>, String> {
     println!(
        "Kabegame v{} bootstrap...",
        env!("CARGO_PKG_VERSION")
    );
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
    EventBroadcaster::init_global(1000)
        .map_err(|e| format!("Failed to initialize event broadcaster: {}", e))?;
    println!("  ✓ Event broadcaster initialized");

    // 初始化全局订阅管理器
    SubscriptionManager::init_global()
        .map_err(|e| format!("Failed to initialize subscription manager: {}", e))?;
    println!("  ✓ Subscription manager initialized");

    // 初始化全局 emitter
    kabegame_core::emitter::GlobalEmitter::init_global()
        .map_err(|e| format!("Failed to initialize global emitter: {}", e))?;
    println!("  ✓ Global emitter initialized");

    println!("  ✓ Runtime initialized");

    let download_queue = Arc::new(DownloadQueue::new());
    println!("  ✓ DownloadQueue initialized");

    // TaskScheduler：负责处理 PluginRun 的任务队列（全局单例）
    TaskScheduler::init_global(download_queue.clone())
        .map_err(|e| format!("Failed to initialize task scheduler: {}", e))?;
    println!("  ✓ TaskScheduler initialized");

    // 创建请求上下文
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

    let ctx = Arc::new(Store {
        dedupe_service,
        #[cfg(all(not(kabegame_mode = "light"), not(target_os = "android")))]
        virtual_drive_service: virtual_drive_service.clone(),
    });

    Store::init_global(ctx.clone())?;

    // 启动虚拟磁盘事件监听器（仅在 非 light 且非 Android）
    #[cfg(all(not(kabegame_mode = "light"), not(target_os = "android")))]
    {
        #[cfg(target_os = "windows")]
        tauri::async_runtime::spawn({
            vd_listener::start_vd_event_listener(
                virtual_drive_service.clone(),
            );
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

/// Tauri 应用入口（桌面 binary 与 Android/iOS 共用）
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .setup(|app| {
            // 设置全局快捷键
            init_app_paths(app.app_handle());

            init_shortcut(app).unwrap();

            // 启动内置 Backend
            match init_globals() {
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
                    #[cfg(any(
                        all(not(kabegame_mode = "light"), not(target_os = "android")),
                        all(kabegame_mode = "light", not(target_os = "windows"))
                    ))]
                    start_ipc_server(ctx);
                }
                Err(e) => {
                    utils::show_error(app.app_handle(), format!("出现了致命错误！: {}", e));
                    eprintln!("出现了致命错误！:{}", e);
                    process::exit(1);
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
            preview_store_install,
            import_plugin_from_zip,
            get_plugin_image,
            get_plugin_image_for_detail,
            get_plugin_icon,
            get_remote_plugin_icon,
            get_plugin_vars,
            open_plugin_editor_window,
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
            get_native_wallpaper_styles,
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
            #[cfg(target_os = "windows")]
            set_main_sidebar_blur,
            #[cfg(target_os = "windows")]
            wallpaper_window_ready,
            // --- Filesystem ---
            open_explorer,
            open_file_path,
            open_file_folder,
            // --- Misc ---
            get_file_drop_supported_types,
            migrate_images_from_json,
            start_dedupe_gallery_by_hash_batched,
            cancel_dedupe_gallery_by_hash_batched,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
