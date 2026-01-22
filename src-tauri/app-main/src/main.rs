// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};

#[cfg(target_os = "windows")]
const CF_HDROP_FORMAT: u32 = 15; // Clipboard format for file drop

mod commands;
mod startup;
#[cfg(feature = "tray")]
mod tray;
mod wallpaper;

// Copied from daemon
mod connection_handler;
mod dedupe_service;
mod handlers;
mod server;
#[cfg(any(target_os = "linux", target_os = "macos"))]
mod server_unix;
#[cfg(target_os = "windows")]
mod server_windows;
#[cfg(all(feature = "virtual-driver"))]
mod vd_listener;

use commands::album;
use commands::album::*;
use commands::daemon::*;
use commands::filesystem::*;
use commands::plugin::*;
use commands::settings::*;
use commands::task::*;
use commands::wallpaper as wallpaper_cmds;
use commands::wallpaper_engine;
#[cfg(target_os = "windows")]
use commands::wallpaper_engine::{export_album_to_we_project, export_images_to_we_project};
#[cfg(target_os = "windows")]
use commands::window::set_main_sidebar_blur;
#[cfg(target_os = "windows")]
use commands::window::wallpaper_window_ready;
use commands::window::*;

use crate::commands::misc::*;

// Daemon Imports
use crate::server::{EventBroadcaster, SubscriptionManager};
use dedupe_service::DedupeService;
use handlers::{dispatch_request, Store};
use kabegame_core::{
    crawler::{DownloadQueue, TaskScheduler},
    emitter::GlobalEmitter,
    ipc::{
        events::{DaemonEvent, DaemonEventKind},
        ipc, CliIpcRequest,
    },
    plugin::PluginManager,
    providers::{ProviderCacheConfig, ProviderRuntime},
    settings::Settings,
    storage::Storage,
    virtual_driver::VirtualDriveService,
};

/// 初始化全局状态，并返回 Context 和 Broadcaster
async fn init_globals() -> Result<(Arc<Store>, Arc<EventBroadcaster>), String> {
    println!(
        "Kabegame Backend (Embedded Daemon) v{}",
        env!("CARGO_PKG_VERSION")
    );
    println!("Initializing Globals...");

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

    Settings::init_global().map_err(|e| format!("Failed to initialize settings: {}", e))?;
    println!("  ✓ Settings initialized");

    // 创建事件广播器（保留最近 1000 个事件）
    let broadcaster = Arc::new(EventBroadcaster::new(1000));
    println!("  ✓ Event broadcaster initialized");

    // 创建订阅管理器
    let subscription_manager = Arc::new(SubscriptionManager::new(broadcaster.clone()));
    println!("  ✓ Subscription manager initialized");

    // 初始化全局 emitter
    GlobalEmitter::init_global_ipc(broadcaster.clone())
        .map_err(|e| format!("Failed to initialize global emitter: {}", e))?;
    println!("  ✓ Global emitter initialized");

    println!("  ✓ Runtime initialized");

    // DownloadQueue：现在使用全局 emitter
    let download_queue = Arc::new(DownloadQueue::new().await);
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

    // Virtual Drive（仅 Windows + feature 启用时）
    #[cfg(feature = "virtual-driver")]
    {
        VirtualDriveService::init_global()
            .map_err(|e| format!("Failed to init VD service: {}", e))?;
    }
    #[cfg(feature = "virtual-driver")]
    let virtual_drive_service = VirtualDriveService::global();
    #[cfg(feature = "virtual-driver")]
    println!("  ✓ Virtual drive support enabled");

    #[cfg(feature = "virtual-driver")]
    let ctx = Arc::new(Store {
        broadcaster: broadcaster.clone(),
        subscription_manager: subscription_manager.clone(),
        dedupe_service,
        virtual_drive_service: virtual_drive_service.clone(),
    });

    #[cfg(not(feature = "virtual-driver"))]
    let ctx = Arc::new(Store {
        broadcaster: broadcaster.clone(),
        subscription_manager: subscription_manager.clone(),
        dedupe_service,
        virtual_drive_service: Arc::new(VirtualDriveService::default()),
    });

    Store::init_global(ctx.clone())?;

    // 启动虚拟磁盘事件监听器（仅在 Windows + virtual-driver feature 启用时）
    #[cfg(feature = "virtual-driver")]
    {
        tokio::spawn(vd_listener::start_vd_event_listener(
            broadcaster.clone(),
            virtual_drive_service.clone(),
        ));
        println!("  ✓ Virtual drive event listener started");

        // 启动时根据设置自动挂载画册盘
        let vd_service_for_mount = virtual_drive_service.clone();
        tokio::spawn(async move {
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
                    move || vd_service.mount(mount_point.as_str(), Storage::global().clone())
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

    Ok((ctx, broadcaster))
}

/// 启动 IPC 服务
#[cfg(feature = "ipc-service")]
async fn start_ipc_server(ctx: Arc<Store>) -> Result<(), String> {
    println!("Starting IPC server...");

    // 从 ctx 中提取 broadcaster 和 subscription_manager
    // 这里我们假设 ctx 内部持有它们的引用
    let broadcaster = ctx.broadcaster.clone();
    let subscription_manager = ctx.subscription_manager.clone();

    server::serve_with_events(
        move |req| {
            let ctx = ctx.clone();
            async move {
                // eprintln!("[DEBUG] Backend 收到请求: {:?}", req);
                let resp = dispatch_request(req, ctx).await;
                resp
            }
        },
        Some(broadcaster as Arc<dyn std::any::Any + Send + Sync>),
        Some(subscription_manager),
    )
    .await
}

/// 启动本地事件转发循环（将 Broadcaster 事件转发给 Tauri 前端）
async fn start_local_event_loop(app: AppHandle, broadcaster: Arc<EventBroadcaster>) {
    // 订阅所有事件
    let mut rx = broadcaster.subscribe_filtered_stream(&DaemonEventKind::ALL);

    while let Some((_id, event)) = rx.recv().await {
        let kind = event.kind();

        match &event {
            DaemonEvent::Generic { event, payload } => {
                let _ = app.emit(event.as_str(), payload.clone());
            }
            DaemonEvent::SettingChange { changes } => {
                let _ = app.emit("setting-change", changes.clone());
            }
            DaemonEvent::WallpaperUpdateImage { image_path } => {
                let path = image_path.clone();
                let controller = crate::wallpaper::WallpaperController::global();
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
                let controller = crate::wallpaper::WallpaperController::global();
                tokio::spawn(async move {
                    if let Ok(manager) = controller.active_manager().await {
                        let _ = manager.set_style(&style, true).await;
                    }
                });
            }
            DaemonEvent::WallpaperUpdateTransition { transition } => {
                let transition = transition.clone();
                let controller = crate::wallpaper::WallpaperController::global();
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
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            // 启动连接状态监听任务（监听 IPC 连接状态变化）
            // 注意：现在我们是 Embedded 模式，这个 watcher 主要用于兼容旧代码，
            // 但如果 daemon_client 不再连接，这个 watcher 可能没用。
            // 我们可以保留它，但实际上它不会触发 "daemon-offline" 因为我们不连接外部。
            // daemon_client::spawn_connection_status_watcher(app.app_handle().clone());

            let app_handle = app.app_handle().clone();

            // 启动内置 Backend
            tauri::async_runtime::spawn(async move {
                match init_globals().await {
                    Ok((ctx, broadcaster)) => {
                        // 1. 启动本地事件转发
                        let app_handle_for_events = app_handle.clone();
                        tauri::async_runtime::spawn(async move {
                            start_local_event_loop(app_handle_for_events, broadcaster).await;
                        });

                        // 2. 发送 Ready 信号给前端
                        // 稍微延迟一下确保前端就绪？
                        // tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                        let _ = app_handle.emit(
                            "daemon-ready",
                            serde_json::json!({
                                "mode": "embedded"
                            }),
                        );
                        println!("Backend initialized (Embedded).");

                        // 3. 启动 IPC Server (如果启用)
                        #[cfg(feature = "ipc-service")]
                        {
                            if let Err(e) = start_ipc_server(ctx).await {
                                eprintln!("IPC Server Fatal Error: {}", e);
                            }
                        }
                    }
                    Err(e) => {
                        eprintln!("Backend Initialization Fatal Error: {}", e);
                    }
                }
            });

            // UI 相关的初始化步骤
            let is_cleaning_data =
                startup::startup_step_cleanup_user_data_if_marked(app.app_handle());
            startup::startup_step_restore_main_window_state(app.app_handle(), is_cleaning_data);
            startup::startup_step_manage_wallpaper_components(app);

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            check_daemon_status,
            reconnect_daemon,
            get_images,
            get_images_paginated,
            get_albums,
            add_album,
            delete_album,
            get_all_tasks,
            get_task,
            add_task,
            update_task,
            delete_task,
            confirm_task_rhai_dump,
            clear_finished_tasks,
            get_task_images,
            get_task_images_paginated,
            get_task_image_ids,
            get_task_failed_images,
            get_plugins,
            refresh_installed_plugins_cache,
            refresh_installed_plugin_cache,
            get_build_mode,
            delete_plugin,
            get_images_range,
            browse_gallery_provider,
            get_image_by_id,
            rename_album,
            add_images_to_album,
            remove_images_from_album,
            get_album_images,
            get_album_image_ids,
            get_album_preview,
            // Settings
            get_settings,
            get_setting,
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
            get_wallpaper_engine_dir,
            set_wallpaper_engine_dir,
            get_wallpaper_engine_myprojects_dir,
            get_wallpaper_rotation_enabled,
            get_wallpaper_rotation_album_id,
            get_wallpaper_rotation_interval_minutes,
            get_wallpaper_rotation_mode,
            get_wallpaper_rotation_style,
            get_wallpaper_rotation_transition,
            get_wallpaper_style_by_mode,
            get_wallpaper_transition_by_mode,
            get_wallpaper_mode,
            get_window_state,
            get_desktop_resolution,
            get_default_images_dir,
            open_plasma_wallpaper_settings,
            get_favorite_album_id,
            // Virtual Driver Settings
            #[cfg(feature = "virtual-driver")]
            get_album_drive_enabled,
            #[cfg(feature = "virtual-driver")]
            get_album_drive_mount_point,
            #[cfg(feature = "virtual-driver")]
            set_album_drive_enabled,
            #[cfg(feature = "virtual-driver")]
            set_album_drive_mount_point,
            // Task
            add_run_config,
            update_run_config,
            get_run_configs,
            delete_run_config,
            cancel_task,
            get_active_downloads,
            retry_task_failed_image,
            start_task,
            // Plugin
            get_plugin_vars,
            get_browser_plugins,
            get_plugin_sources,
            save_plugin_sources,
            get_store_plugins,
            get_plugin_detail,
            validate_plugin_source,
            preview_import_plugin,
            preview_store_install,
            import_plugin_from_zip,
            install_browser_plugin,
            get_plugin_image,
            get_plugin_image_for_detail,
            get_plugin_icon,
            get_remote_plugin_icon,
            // Window
            hide_main_window,
            #[cfg(target_os = "windows")]
            set_main_sidebar_blur,
            #[cfg(target_os = "windows")]
            wallpaper_window_ready,
            // Filesystem
            open_explorer,
            open_file_path,
            open_file_folder,
            // Misc
            clear_user_data,
            start_dedupe_gallery_by_hash_batched,
            cancel_dedupe_gallery_by_hash_batched,
            open_plugin_editor_window,
            get_gallery_image,
            // Album
            album::get_album_counts,
            album::get_album_images,
            album::get_album_image_ids,
            album::get_album_preview,
            album::rename_album,
            album::add_images_to_album,
            album::remove_images_from_album,
            album::update_album_images_order,
            // Wallpaper
            wallpaper_cmds::get_current_wallpaper_image_id,
            wallpaper_cmds::set_wallpaper,
            wallpaper_cmds::set_wallpaper_by_image_id,
            wallpaper_cmds::clear_current_wallpaper_image_id,
            wallpaper_cmds::get_current_wallpaper_path,
            wallpaper_cmds::migrate_images_from_json,
            wallpaper_cmds::set_wallpaper_rotation_enabled,
            wallpaper_cmds::set_wallpaper_rotation_album_id,
            wallpaper_cmds::start_wallpaper_rotation,
            wallpaper_cmds::set_wallpaper_rotation_interval_minutes,
            wallpaper_cmds::set_wallpaper_mode,
            wallpaper_cmds::set_wallpaper_style,
            wallpaper_cmds::set_wallpaper_rotation_transition,
            // Wallpaper Engine
            #[cfg(target_os = "windows")]
            wallpaper_engine::export_album_to_we_project,
            #[cfg(target_os = "windows")]
            wallpaper_engine::export_images_to_we_project,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
