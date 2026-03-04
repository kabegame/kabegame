mod commands;
mod startup;
mod desktop_env;
#[cfg(not(target_os = "android"))]
mod file_server;
#[cfg(target_os = "android")]
mod archiver_provider;
#[cfg(target_os = "android")]
mod content_io_provider;
#[cfg(not(mobile))]
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
#[cfg(not(target_os = "android"))]
use file_server::get_file_server_base_url;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use tauri_plugin_global_shortcut::GlobalShortcutExt;

// Daemon Imports
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use crate::ipc::dedupe_service::DedupeService;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use crate::ipc::handlers::dispatch_request;
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

/// 统一初始化全局状态（安卓与桌面共用主流程，桌面端多出 DedupeService/VD 等用 cfg 收束）
fn init_globals() -> Result<(), String> {
    println!("Kabegame v{} bootstrap...", env!("CARGO_PKG_VERSION"));
    println!("Initializing Globals...");

    Settings::init_global().map_err(|e| format!("Failed to initialize settings: {}", e))?;
    println!("  ✓ Settings initialized");

    PluginManager::init_global()
        .map_err(|e| format!("Failed to initialize plugin manager: {}", e))?;
    println!("  ✓ Plugin manager initialized");

    Storage::init_global().map_err(|e| format!("Failed to initialize storage: {}", e))?;
    let failed_count = Storage::global()
        .mark_pending_running_tasks_as_failed()
        .unwrap_or(0);
    if failed_count > 0 {
        println!("  ✓ Marked {failed_count} pending/running task(s) as failed");
    }
    println!("  ✓ Storage initialized");

    kabegame_core::ipc::server::EventBroadcaster::init_global(1000)
        .map_err(|e| format!("EventBroadcaster: {}", e))?;
    kabegame_core::ipc::server::SubscriptionManager::init_global()
        .map_err(|e| format!("SubscriptionManager: {}", e))?;
    kabegame_core::emitter::GlobalEmitter::init_global()
        .map_err(|e| format!("GlobalEmitter: {}", e))?;
    println!("  ✓ Event broadcaster and emitter initialized");

    println!("  ✓ Runtime initialized");

    let download_queue = Arc::new(DownloadQueue::new());
    println!("  ✓ DownloadQueue initialized");

    TaskScheduler::init_global(download_queue.clone())
        .map_err(|e| format!("Failed to initialize task scheduler: {}", e))?;
    println!("  ✓ TaskScheduler initialized");

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

    // 桌面端：DedupeService、VD 等全局单例
    #[cfg(not(target_os = "android"))]
    {
        DedupeService::init_global(Arc::new(DedupeService::new()))?;

        #[cfg(all(not(kabegame_mode = "light"), not(target_os = "android")))]
        {
            VirtualDriveService::init_global().map_err(|e| format!("Failed to init VD service: {}", e))?;
            let virtual_drive_service = VirtualDriveService::global();
            println!("  ✓ Virtual drive support enabled");

            #[cfg(target_os = "windows")]
            tauri::async_runtime::spawn({
                vd_listener::start_vd_event_listener(virtual_drive_service.clone());
                println!("  ✓ Virtual drive event listener started");
            });

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

        return Ok(());
    }

    #[cfg(target_os = "android")]
    Ok(())
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

/// Tauri 应用入口（桌面 binary 与 Android 共用）
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 先注册 pathes，在 .setup() 前完成 AppPaths 初始化，供 Settings/Storage 等使用
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_pathes::init());

    #[cfg(target_os = "android")]
    {
        builder = builder.plugin(tauri_plugin_picker::init());
        builder = builder.plugin(tauri_plugin_archiver::init());
        builder = builder.plugin(tauri_plugin_share::init());
        builder = builder.plugin(init_wallpaper_plugin());
    }

    #[cfg(not(target_os = "android"))]
    {
        builder = builder.plugin(tauri_plugin_global_shortcut::Builder::new().build());
    }

    let app = builder
        .setup(|app| {
            // 设置全局快捷键
            #[cfg(not(target_os = "android"))]
            init_shortcut(app).unwrap();

            // 启动内置 Backend（安卓与桌面共用 init_globals，用编译开关区分平台差异）
            match init_globals() {
                Ok(()) => {
                    // 在初始化全局状态后、初始化壁纸控制器前，检测并缓存 Linux 桌面环境
                    #[cfg(target_os = "linux")]
                    {
                        crate::desktop_env::init_linux_desktop();
                    }

                    // 公共步骤
                    start_local_event_loop(app.app_handle().clone());
                    // 清理用户数据
                    #[cfg(not(target_os = "android"))]
                    cleanup_user_data_if_marked();
                    // 恢复窗口状态（当前实现仅将窗口居屏幕中央）
                    #[cfg(not(target_os = "android"))]
                    restore_main_window_state(app.app_handle());
                    // 初始化壁纸控制器
                    init_wallpaper_controller(app);
                    // 启动 TaskScheduler（启动 DownloadQueue 的 worker）
                    start_task_scheduler();
                    // 初始化download worker
                    init_download_workers();
                    // 初始化任务阻塞worker线程池
                    start_download_workers();
                    // 启动事件转发任务
                    start_event_forward_task();

                    #[cfg(not(target_os = "android"))]
                    {
                        tauri::async_runtime::spawn(async {
                            if let Err(e) = file_server::start_file_server().await {
                                eprintln!("Failed to start file server: {}", e);
                            }
                        });
                        tauri::async_runtime::spawn(async {
                            if let Err(e) =
                                kabegame_core::storage::Storage::global().fill_missing_dimensions()
                            {
                                eprintln!("Failed to fill missing image dimensions: {}", e);
                            }
                        });
                        startup::start_ipc_server(app.app_handle().clone());
                    }

                    #[cfg(target_os = "android")]
                    {
                        // 将内置插件提取到用户目录
                        init_bundled_plugins(app.app_handle().clone());
                        let provider =
                            content_io_provider::PickerContentIoProvider::new(app.app_handle().clone());
                        let proxy =
                            content_io_provider::ChannelContentIoProvider::new(provider);
                        // 设置内容IO提供者
                        kabegame_core::crawler::content_io::set_content_io_provider(Box::new(proxy));
                        // 设置归档提取提供者
                        let archiver_provider =
                            archiver_provider::ArchiverContentProvider::new(app.app_handle().clone());
                        let archiver_proxy =
                            archiver_provider::ChannelArchiveExtractProvider::new(archiver_provider);
                        kabegame_core::crawler::archiver::set_archive_extract_provider(Box::new(
                            archiver_proxy,
                        ));
                    }

                    // 初始化插件
                    init_kgpg_plugin();

                }
                Err(e) => {
                    utils::show_error(app.app_handle(), format!("初始化过程中出现了致命错误！: {}", e));
                    eprintln!("初始化过程中出现了致命错误！:{}", e);
                    process::exit(1);
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            #[cfg(any(target_os = "linux", target_os = "android"))]
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
            update_image_dimensions,
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
            #[cfg(not(target_os = "android"))]
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
            #[cfg(target_os = "windows")]
            wallpaper_window_ready,
            // --- Filesystem ---
            open_explorer,
            open_file_path,
            open_file_folder,
            // --- Misc ---
            exit_app,
            get_file_drop_supported_types,
            get_file_drop_kinds,
            get_supported_image_types,
            set_supported_image_formats,
            get_linux_desktop_env,
            #[cfg(not(target_os = "android"))]
            get_file_server_base_url,
            #[cfg(not(target_os = "android"))]
            start_dedupe_gallery_by_hash_batched,
            #[cfg(not(target_os = "android"))]
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
                    use std::ffi::OsStr;

                    if path.extension() == Some(OsStr::new("kgpg")) {
                        let _ = app_handle.emit(
                            "app-import-plugin",
                            serde_json::json!({
                                "kgpgPath": path.to_string_lossy()
                            }),
                        );
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
