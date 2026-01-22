// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{Emitter, Manager};

#[cfg(target_os = "windows")]
const CF_HDROP_FORMAT: u32 = 15; // Clipboard format for file drop

mod commands;
mod daemon_client;
mod event_listeners;
mod startup;
#[cfg(feature = "self-hosted")]
mod storage;
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

use commands::album::*;
use commands::daemon::*;
use commands::image::*;
use commands::misc::{clear_user_data, get_gallery_image, open_plugin_editor_window};
use commands::plugin::*;
#[cfg(feature = "self-hosted")]
use commands::settings::get_default_images_dir;
use commands::settings::*;
#[cfg(feature = "virtual-driver")]
use commands::settings::{set_album_drive_enabled, set_album_drive_mount_point};
#[cfg(feature = "self-hosted")]
use commands::storage::*;
use commands::task::*;
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
    ipc::{ipc, CliIpcRequest},
    plugin::PluginManager,
    providers::{ProviderCacheConfig, ProviderRuntime},
    settings::Settings,
    storage::Storage,
    virtual_driver::VirtualDriveService,
};

// 初始化后端服务（原 Daemon 逻辑）
async fn init_backend_server() -> Result<(), String> {
    println!(
        "Kabegame Backend (Embedded Daemon) v{}",
        env!("CARGO_PKG_VERSION")
    );
    println!("Initializing...");

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
        match ProviderRuntime::init_global(cfg.clone()) {
            Ok(()) => {}
            Err(e) => {
                // 初始化失败，检查是否是数据库锁定错误
                let error_msg = format!("{}", e);
                let is_lock_error = error_msg.contains("could not acquire lock")
                    || error_msg.contains("Resource temporarily unavailable")
                    || error_msg.contains("WouldBlock");

                if is_lock_error {
                    // 如果是锁定错误，检查是否有其他 daemon 正在运行
                    eprintln!(
                        "[providers] 检测到数据库锁定错误，检查是否有其他 daemon 正在运行..."
                    );
                    match ipc::request(CliIpcRequest::Status).await {
                        Ok(_) => {
                            eprintln!(
                                "错误: ProviderRuntime 初始化失败，因为已有其他 daemon 正在运行。"
                            );
                            return Err(format!("另一个 daemon 实例正在运行（数据库被锁定）"));
                        }
                        Err(_) => {
                            eprintln!("[providers] 无法连接到其他 daemon，但检测到数据库锁定");
                        }
                    }
                }

                eprintln!(
                    "[providers] init ProviderRuntime failed, fallback to default cfg: {}",
                    e
                );

                // 尝试使用默认配置
                match ProviderRuntime::init_global(ProviderCacheConfig::default()) {
                    Ok(()) => {}
                    Err(e2) => {
                        return Err(format!("ProviderRuntime init failed: {}", e2));
                    }
                }
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

    println!("Starting IPC server...");

    server::serve_with_events(
        move |req| {
            let ctx = ctx.clone();
            async move {
                eprintln!("[DEBUG] Backend 收到请求: {:?}", req);
                let resp = dispatch_request(req, ctx).await;
                resp
            }
        },
        Some(broadcaster.clone() as Arc<dyn std::any::Any + Send + Sync>),
        Some(subscription_manager.clone()),
    )
    .await
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            // 启动连接状态监听任务（监听 IPC 连接状态变化）
            daemon_client::spawn_connection_status_watcher(app.app_handle().clone());

            // 【关键修改】启动内置 Backend Server (原 Daemon)
            tauri::async_runtime::spawn(async move {
                if let Err(e) = init_backend_server().await {
                    eprintln!("Backend Server Fatal Error: {}", e);
                    // 考虑退出应用？
                }
            });

            // UI 相关的初始化步骤（保留清理、恢复窗口状态等）
            let is_cleaning_data =
                startup::startup_step_cleanup_user_data_if_marked(app.app_handle());
            startup::startup_step_restore_main_window_state(app.app_handle(), is_cleaning_data);
            startup::startup_step_manage_wallpaper_components(app);

            // 注意：我们不再调用 startup::manage_plugin_manager 等，因为 init_backend_server 已经处理了

            // 连接自身（Loopback IPC）
            let app_handle_for_daemon = app.app_handle().clone();
            tauri::async_runtime::spawn(async move {
                println!("UI Client 尝试连接 Backend Server...");

                // 循环重试连接（等待 Server 启动）
                match daemon_client::try_connect_daemon().await {
                    Ok(_) => {
                        let timestamp = SystemTime::now()
                            .duration_since(UNIX_EPOCH)
                            .unwrap()
                            .as_millis();
                        println!("Backend 已就绪: {}", timestamp);
                        let _ = app_handle_for_daemon.emit("daemon-ready", serde_json::json!({}));
                        daemon_client::init_event_listeners(app_handle_for_daemon.clone()).await;
                    }
                    Err(e) => {
                        println!("连接 Backend 失败（将自动重试）: {}", e);
                        // try_connect_daemon 内部可能没有重试循环，这里可以简单处理
                        // 但由于 daemon_client 实际上会被前端反复调用，且 init_event_listeners 很重要
                        // 我们应该用 ensure_daemon_ready 的逻辑，但 ensure_daemon_ready 会尝试启动外部进程
                        // 这里我们只需要等待内部线程启动即可。

                        // 简单的重试逻辑
                        let mut retries = 0;
                        while retries < 10 {
                            tokio::time::sleep(tokio::time::Duration::from_secs(1)).await;
                            match daemon_client::try_connect_daemon().await {
                                Ok(_) => {
                                    println!("Backend 已就绪 (重试 {})", retries);
                                    let _ = app_handle_for_daemon
                                        .emit("daemon-ready", serde_json::json!({}));
                                    daemon_client::init_event_listeners(
                                        app_handle_for_daemon.clone(),
                                    )
                                    .await;
                                    break;
                                }
                                Err(_) => {
                                    retries += 1;
                                }
                            }
                        }
                    }
                }
            });

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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
