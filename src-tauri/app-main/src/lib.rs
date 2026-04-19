// Shared modules (local + web)
pub(crate) mod core_init;

// Web mode entry
#[cfg(feature = "web")]
mod web_entry;

// Local (Tauri native) modules
#[cfg(all(feature = "local", target_os = "android"))]
mod archiver_provider;
#[cfg(feature = "local")]
mod commands;
#[cfg(all(feature = "local", target_os = "android"))]
mod compress_provider;
#[cfg(all(feature = "local", target_os = "android"))]
mod content_io_provider;
#[cfg(all(feature = "local", not(target_os = "android")))]
mod http_server;
#[cfg(all(feature = "local", target_os = "linux"))]
mod linux_desktop;
#[cfg(all(feature = "local", not(target_os = "android")))]
mod mcp_server;
#[cfg(feature = "local")]
pub mod startup;
#[cfg(all(feature = "local", not(mobile)))]
mod tray;
#[cfg(feature = "local")]
mod utils;
#[cfg(feature = "local")]
mod wallpaper;
#[cfg(feature = "local")]
mod ipc;
#[cfg(all(feature = "local", kabegame_mode = "standard"))]
mod vd_listener;

// ---- local-only imports ----
#[cfg(feature = "local")]
use commands::*;
#[cfg(feature = "local")]
use core::fmt;
#[cfg(all(feature = "local", not(target_os = "android")))]
use http_server::get_http_server_base_url;
#[cfg(feature = "local")]
use startup::*;
#[cfg(feature = "local")]
use std::process;
#[cfg(feature = "local")]
use std::sync::Arc;
#[cfg(feature = "local")]
use tauri::{AppHandle, Emitter, Manager};
#[cfg(all(feature = "local", not(target_os = "android")))]
use tauri_plugin_global_shortcut::GlobalShortcutExt;

#[cfg(all(feature = "local", not(target_os = "android")))]
use crate::ipc::handlers::dispatch_request;
#[cfg(all(feature = "local", not(target_os = "android")))]
use kabegame_core::ipc::events::{DaemonEvent, DaemonEventKind};
#[cfg(all(feature = "local", not(target_os = "android")))]
use kabegame_core::ipc::server::{EventBroadcaster, SubscriptionManager};
#[cfg(all(feature = "local", not(target_os = "android")))]
use kabegame_core::storage::organize::OrganizeService;

#[cfg(all(feature = "local", kabegame_mode = "standard"))]
use kabegame_core::virtual_driver::VirtualDriveService;

// ---- web entry point ----

#[cfg(feature = "web")]
pub fn run() {
    web_entry::run();
}

// ---- local (Tauri) entry point ----

#[cfg(feature = "local")]
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 先注册 pathes，在 .setup() 前完成 AppPaths 初始化，供 Settings/Storage 等使用
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_pathes::init());

    #[cfg(target_os = "android")]
    {
        builder = builder.plugin(tauri_plugin_picker::init());
        builder = builder.plugin(tauri_plugin_archiver::init());
        builder = builder.plugin(tauri_plugin_share::init());
        builder = builder.plugin(tauri_plugin_compress::init());
        builder = builder.plugin(tauri_plugin_wallpaper::init());
        builder = builder.plugin(tauri_plugin_task_notification::init());
        builder = builder.plugin(tauri_plugin_android_battery_optimization::init());
    }

    #[cfg(not(target_os = "android"))]
    {
        builder = builder.plugin(tauri_plugin_global_shortcut::Builder::new().build());
        // 爬虫窗口关闭时仅隐藏不销毁，便于设置中再次打开；遨游窗口关闭时清除会话状态并通知前端
        builder = builder.on_window_event(|window, event| match event {
            tauri::WindowEvent::CloseRequested { api, .. } => {
                if window.label() == "crawler" {
                    let _ = window.hide();
                    api.prevent_close();
                } else if window.label() == "surf" {
                    commands::surf::notify_surf_session_closed(&window.app_handle());
                }
            }
            _ => {}
        });
    }

    let app = builder
        .setup(|app| {
            // 若有清理标记，必须在 init_globals 之前清理 data/cache，否则 DB 等已打开无法删除
            #[cfg(not(target_os = "android"))]
            let _ = cleanup_user_data_if_marked();

            // 启动内置 Backend
            match crate::core_init::init_globals() {
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
                            if let Err(e) = mcp_server::start_mcp_server().await {
                                eprintln!("Failed to start MCP server: {}", e);
                            }
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
            move_album,
            get_album_preview,
            get_album_image_ids,
            add_images_to_album,
            add_task_images_to_album,
            remove_images_from_album,
            update_album_images_order,
            get_favorite_album_id,
            // --- Images ---
            get_image_by_id,
            get_image_metadata,
            get_image_metadata_by_metadata_id,
            get_gallery_image,
            copy_image_to_clipboard,
            delete_image,
            remove_image,
            batch_delete_images,
            batch_remove_images,
            get_images_count,
            get_gallery_plugin_groups,
            get_gallery_media_type_counts,
            get_album_media_type_counts,
            get_gallery_time_filter_data,
            browse_gallery_provider,
            query_provider,
            clear_provider_cache,
            toggle_image_favorite,
            update_image_dimensions,
            // --- Tasks ---
            get_all_tasks,
            get_tasks_page,
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
            get_all_failed_images,
            get_task_logs,
            retry_task_failed_image,
            retry_failed_images,
            cancel_retry_failed_image,
            cancel_retry_failed_images,
            delete_failed_images,
            delete_task_failed_image,
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
            surf_update_name,
            #[cfg(not(target_os = "android"))]
            surf_delete_record,
            #[cfg(not(target_os = "android"))]
            surf_get_cookies,
            #[cfg(not(target_os = "android"))]
            surf_open_devtools,
            // --- Run Configs ---
            get_run_configs,
            get_run_config,
            add_run_config,
            update_run_config,
            delete_run_config,
            copy_run_config,
            get_missed_runs,
            run_missed_configs,
            dismiss_missed_configs,
            // --- Plugins ---
            get_plugins,
            refresh_plugins,
            get_plugin_detail,
            delete_plugin,
            install_from_store,
            get_plugin_sources,
            add_plugin_source,
            update_plugin_source,
            delete_plugin_source,
            validate_plugin_source,
            get_store_plugins,
            preview_import_plugin,
            preview_store_install,
            import_plugin_from_zip,
            get_plugin_image_for_detail,
            get_remote_plugin_icon,
            get_plugin_image_from_zip,
            get_plugin_default_config,
            ensure_plugin_default_config,
            save_plugin_default_config,
            reset_plugin_default_config,
            get_build_mode,
            // --- Settings ---
            get_language,
            set_language,
            get_auto_launch,
            set_auto_launch,
            get_auto_open_crawler_webview,
            set_auto_open_crawler_webview,
            get_import_recommended_schedule_enabled,
            set_import_recommended_schedule_enabled,
            get_max_concurrent_downloads,
            set_max_concurrent_downloads,
            get_max_concurrent_tasks,
            set_max_concurrent_tasks,
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
            get_gallery_page_size,
            set_gallery_page_size,
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
            set_wallpaper_rotation_include_subalbums,
            get_wallpaper_rotation_include_subalbums,
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
            #[cfg(kabegame_mode = "standard")]
            get_album_drive_enabled,
            #[cfg(kabegame_mode = "standard")]
            set_album_drive_enabled,
            #[cfg(kabegame_mode = "standard")]
            get_album_drive_mount_point,
            #[cfg(kabegame_mode = "standard")]
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
            open_album_virtual_drive_folder,
            // --- Misc ---
            proxy_fetch,
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
            proxy_fetch,
            get_supported_image_types,
            set_supported_image_formats,
            get_linux_desktop_env,
            is_plasma_wallpaper_plugin_installed,
            #[cfg(not(target_os = "android"))]
            get_http_server_base_url,
            #[cfg(not(target_os = "android"))]
            start_organize,
            #[cfg(not(target_os = "android"))]
            get_organize_total_count,
            #[cfg(not(target_os = "android"))]
            get_organize_run_state,
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
