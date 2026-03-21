#[cfg(target_os = "android")]
mod archiver_provider;
#[cfg(target_os = "android")]
mod compress_provider;
mod commands;
#[cfg(target_os = "android")]
mod content_io_provider;
#[cfg(not(target_os = "android"))]
mod http_server;
#[cfg(target_os = "linux")]
mod linux_desktop;
pub mod startup;
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
#[cfg(not(target_os = "android"))]
use http_server::get_http_server_base_url;
use startup::*;
use std::process;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};
#[cfg(not(target_os = "android"))]
use tauri_plugin_global_shortcut::GlobalShortcutExt;

// Daemon Imports
#[cfg(not(target_os = "android"))]
use crate::ipc::handlers::dispatch_request;
#[cfg(not(target_os = "android"))]
use kabegame_core::ipc::events::{DaemonEvent, DaemonEventKind};
#[cfg(not(target_os = "android"))]
use kabegame_core::ipc::server::{EventBroadcaster, SubscriptionManager};
#[cfg(not(target_os = "android"))]
use kabegame_core::storage::organize::OrganizeService;
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

    // 同步后端 i18n 语言（从配置恢复）
    {
        let lang = tauri::async_runtime::block_on(Settings::global().get_language())
            .ok()
            .flatten();
        kabegame_i18n::sync_locale(lang.as_deref());
    }

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
    // 收藏画册使用当前 locale 的 i18n 名称（与语言切换时 set_favorite_album_name 一致）
    let raw = kabegame_i18n::t!("albums.favorite");
    let name = if raw == "albums.favorite" { "收藏" } else { raw.as_str() };
    let _ = Storage::global().set_favorite_album_name(name);

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

    // 桌面端：OrganizeService、VD 等全局单例
    #[cfg(not(target_os = "android"))]
    {
        OrganizeService::init_global(Arc::new(OrganizeService::new()))?;

        #[cfg(not(kabegame_mode = "light"))]
        {
            VirtualDriveService::init_global()
                .map_err(|e| format!("Failed to init VD service: {}", e))?;
            let virtual_drive_service = VirtualDriveService::global();
            println!("  ✓ Virtual drive support enabled");

            #[cfg(target_os = "windows")]
            {
                let vd_service_for_listener = virtual_drive_service.clone();
                tauri::async_runtime::spawn(async move {
                    vd_listener::start_vd_event_listener(vd_service_for_listener).await;
                    println!("  ✓ Virtual drive event listener started");
                });
            }

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

/// Tauri 应用入口（桌面 binary 与 Android 共用）
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 先注册 pathes，在 .setup() 前完成 AppPaths 初始化，供 Settings/Storage 等使用
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_pathes::init());

    #[cfg(target_os = "android")]
    {
        builder = builder.plugin(tauri_plugin_picker::init());
        builder = builder.plugin(tauri_plugin_archiver::init());
        builder = builder.plugin(tauri_plugin_share::init());
        builder = builder.plugin(tauri_plugin_compress::init());
        builder = builder.plugin(tauri_plugin_wallpaper::init());
        builder = builder.plugin(tauri_plugin_task_notification::init());
    }

    #[cfg(not(target_os = "android"))]
    {
        builder = builder.plugin(tauri_plugin_global_shortcut::Builder::new().build());
        // 爬虫窗口关闭时仅隐藏不销毁，便于设置中再次打开；遨游窗口关闭时清除会话状态并通知前端
        builder = builder.on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "crawler" {
                    let _ = window.hide();
                    api.prevent_close();
                } else if window.label() == "surf" {
                    commands::surf::notify_surf_session_closed(&window.app_handle());
                }
            }
        });
    }

    let app = builder
        .setup(|app| {
            // 若有清理标记，必须在 init_globals 之前清理 data/cache，否则 DB 等已打开无法删除
            #[cfg(not(target_os = "android"))]
            let _ = cleanup_user_data_if_marked();

            // 启动内置 Backend（安卓与桌面共用 init_globals，用编译开关区分平台差异）
            match init_globals() {
                Ok(()) => {
                    // 在初始化全局状态后、初始化壁纸控制器前，检测并缓存 Linux 桌面环境
                    #[cfg(target_os = "linux")]
                    {
                        crate::linux_desktop::init_linux_desktop();
                    }

                    // 公共步骤
                    start_local_event_loop(app.app_handle().clone());
                    // 命令行带 --minimized 时不创建主窗口，避免窗口闪现；托盘/IPC 显示时由 ensure_main_window 再创建
                    #[cfg(not(target_os = "android"))]
                    if !startup::is_auto_startup() {
                        if let Err(e) = create_main_window(&app.app_handle()) {
                            return Err(Box::new(std::io::Error::other(e)));
                        }
                    }
                    #[cfg(not(target_os = "android"))]
                    init_crawler_window(app.app_handle().clone());
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
                            if let Err(e) = http_server::start_http_server().await {
                                eprintln!("Failed to start file server: {}", e);
                            }
                        });
                        tauri::async_runtime::spawn(async {
                            if let Err(e) =
                                kabegame_core::storage::Storage::global().fill_missing_dimensions()
                            {
                                eprintln!("Failed to fill missing image dimensions: {}", e);
                            }
                            let _ = tauri::async_runtime::spawn_blocking(move || {
                                if let Err(e) = kabegame_core::storage::Storage::global()
                                    .backfill_display_names()
                                {
                                    eprintln!("Failed to backfill display names: {}", e);
                                }
                            })
                            .await;
                        });
                        startup::start_ipc_server(app.app_handle().clone());
                    }
                    #[cfg(target_os = "android")]
                    {
                        let provider = content_io_provider::PickerContentIoProvider::new(
                            app.app_handle().clone(),
                        );
                        let proxy = content_io_provider::ChannelContentIoProvider::new(provider);
                        // 设置内容IO提供者
                        kabegame_core::crawler::content_io::set_content_io_provider(Box::new(
                            proxy,
                        ));
                        // 设置归档提取提供者
                        let archiver_provider = archiver_provider::ArchiverContentProvider::new(
                            app.app_handle().clone(),
                        );
                        let archiver_proxy = archiver_provider::ChannelArchiveExtractProvider::new(
                            archiver_provider,
                        );
                        kabegame_core::crawler::archiver::set_archive_extract_provider(Box::new(
                            archiver_proxy,
                        ));

                        let compress_provider =
                            compress_provider::PluginVideoCompressProvider::new(
                                app.app_handle().clone(),
                            );
                        let compress_proxy =
                            compress_provider::ChannelVideoCompressProvider::new(compress_provider);
                        if let Err(e) = kabegame_core::crawler::downloader::video_compress::set_android_video_compress_provider(Arc::new(compress_proxy))
                        {
                            eprintln!("[VideoCompress] Failed to set android compress provider: {e}");
                        }
                    }

                    // 初始化插件缓存
                    init_kgpg_plugin();
                }
                Err(e) => {
                    utils::show_error(
                        app.app_handle(),
                        kabegame_i18n::t!("dialog.initFatalError", detail = e.to_string()),
                    );
                    eprintln!("初始化过程中出现了致命错误！:{}", e);
                    process::exit(1);
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
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
            add_task_images_to_album,
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
            clear_provider_cache,
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
            get_task_images,
            get_task_images_paginated,
            get_task_image_ids,
            get_task_failed_images,
            get_task_logs,
            retry_task_failed_image,
            get_active_downloads,
            #[cfg(not(target_os = "android"))]
            surf_start_session,
            #[cfg(not(target_os = "android"))]
            surf_close_session,
            #[cfg(not(target_os = "android"))]
            surf_get_session_status,
            #[cfg(not(target_os = "android"))]
            surf_list_records,
            #[cfg(not(target_os = "android"))]
            surf_get_record,
            #[cfg(not(target_os = "android"))]
            surf_get_record_images,
            #[cfg(not(target_os = "android"))]
            surf_update_root_url,
            #[cfg(not(target_os = "android"))]
            surf_delete_record,
            #[cfg(not(target_os = "android"))]
            surf_get_cookies,
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
            add_plugin_source,
            update_plugin_source,
            delete_plugin_source,
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
            get_language,
            set_language,
            get_auto_launch,
            set_auto_launch,
            get_auto_open_crawler_webview,
            set_auto_open_crawler_webview,
            get_max_concurrent_downloads,
            set_max_concurrent_downloads,
            get_download_interval_ms,
            set_download_interval_ms,
            get_network_retry_count,
            set_network_retry_count,
            get_image_click_action,
            set_image_click_action,
            get_gallery_image_aspect_ratio,
            set_gallery_image_aspect_ratio,
            get_gallery_image_object_position,
            set_gallery_image_object_position,
            get_gallery_grid_columns,
            set_gallery_grid_columns,
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
            get_wallpaper_volume,
            set_wallpaper_volume,
            get_wallpaper_video_playback_rate,
            set_wallpaper_video_playback_rate,
            get_wallpaper_rotator_status,
            #[cfg(any(target_os = "windows", target_os = "macos"))]
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
            #[cfg(target_os = "windows")]
            export_video_to_we_project,
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
            wallpaper_window_ready,
            // --- Filesystem ---
            open_explorer,
            open_file_path,
            open_file_folder,
            // --- Misc ---
            exit_app,
            #[cfg(not(target_os = "android"))]
            open_dev_webview,
            #[cfg(not(target_os = "android"))]
            crawl_get_context,
            #[cfg(not(target_os = "android"))]
            crawl_run_script,
            #[cfg(not(target_os = "android"))]
            crawl_exit,
            #[cfg(not(target_os = "android"))]
            crawl_error,
            #[cfg(not(target_os = "android"))]
            crawl_task_log,
            #[cfg(not(target_os = "android"))]
            crawl_add_progress,
            #[cfg(not(target_os = "android"))]
            crawl_download_image,
            #[cfg(not(target_os = "android"))]
            crawl_register_blob_download,
            #[cfg(not(target_os = "android"))]
            crawl_browser_download_failed,
            #[cfg(not(target_os = "android"))]
            crawl_to,
            #[cfg(not(target_os = "android"))]
            crawl_back,
            #[cfg(not(target_os = "android"))]
            crawl_update_page_state,
            #[cfg(not(target_os = "android"))]
            crawl_update_state,
            #[cfg(not(target_os = "android"))]
            crawl_page_ready,
            #[cfg(not(target_os = "android"))]
            crawl_clear_site_data,
            #[cfg(not(target_os = "android"))]
            show_crawler_window,
            get_file_drop_supported_types,
            get_file_drop_kinds,
            get_supported_image_types,
            set_supported_image_formats,
            get_linux_desktop_env,
            is_plasma_wallpaper_plugin_installed,
            #[cfg(not(target_os = "android"))]
            get_http_server_base_url,
            #[cfg(not(target_os = "android"))]
            start_organize,
            #[cfg(not(target_os = "android"))]
            cancel_organize,
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
