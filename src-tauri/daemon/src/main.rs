//! Kabegame Daemon（常驻后台服务）
//!
//! 统一的后台服务，处理：
//! - Storage 操作（图片、画册、任务、配置）
//! - Plugin 管理（列表、安装、删除）
//! - Settings 管理（获取、更新）
//! - Events 广播（任务日志、下载状态、任务状态）
//!
//! 所有前端（app-main、plugin-editor、cli、Plasma 壁纸插件）通过 Unix Socket IPC 与 daemon 通信。

// Windows release 构建时使用 GUI 子系统，避免弹黑框
// debug 构建仍使用控制台子系统，便于调试
#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

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

use dedupe_service::DedupeService;
use handlers::{dispatch_request, Store};
use kabegame_core::{
    crawler::{DownloadQueue, TaskScheduler},
    ipc::{ipc, CliIpcRequest},
    plugin::PluginManager,
    providers::{ProviderCacheConfig, ProviderRuntime},
    emitter::GlobalEmitter,
    settings::Settings,
    storage::Storage,
    virtual_driver::VirtualDriveService,
};
use crate::server::{EventBroadcaster, SubscriptionManager};
use std::sync::Arc;

#[tokio::main]
async fn main() {
    let res = daemon_main().await;
    if let Err(e) = res {
        eprintln!("Daemon error: {e}");
        std::process::exit(1);
    }
}

async fn daemon_main() -> Result<(), String> {
    println!("Kabegame Daemon v{}", env!("CARGO_PKG_VERSION"));
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

    // PluginManager 现在是全局单例，不需要 manage
    // Storage 现在是全局单例，不需要 manage
    // Settings 现在是全局单例，不需要 manage
    println!("  ✓ Runtime initialized");

    // DownloadQueue：现在使用全局 emitter
    let download_queue = Arc::new(DownloadQueue::new().await);
    println!("  ✓ DownloadQueue initialized");

    // TaskScheduler：负责处理 PluginRun 的任务队列（全局单例）
    TaskScheduler::init_global(download_queue.clone())
        .map_err(|e| format!("Failed to initialize task scheduler: {}", e))?;
    // let restored = TaskScheduler::global().restore_pending_tasks().unwrap_or(0);
    // println!("  ✓ TaskScheduler initialized (restored {restored} tasks)");
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
                            eprintln!("请先停止正在运行的 daemon，或确保只有一个 daemon 实例。");
                            return Err(format!("另一个 daemon 实例正在运行（数据库被锁定）"));
                        }
                        Err(_) => {
                            // 无法连接到其他 daemon，可能是其他原因导致的锁定
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
                        let error_msg2 = format!("{}", e2);
                        let is_lock_error2 = error_msg2.contains("could not acquire lock")
                            || error_msg2.contains("Resource temporarily unavailable")
                            || error_msg2.contains("WouldBlock");

                        if is_lock_error2 {
                            // 默认配置也锁定，再次检查
                            eprintln!(
                                "[providers] 默认配置也失败，检查是否有其他 daemon 正在运行..."
                            );
                            match ipc::request(CliIpcRequest::Status).await {
                                Ok(_) => {
                                    eprintln!("错误: ProviderRuntime 初始化失败，因为已有其他 daemon 正在运行。");
                                    eprintln!(
                                        "请先停止正在运行的 daemon，或确保只有一个 daemon 实例。"
                                    );
                                    return Err(format!(
                                        "另一个 daemon 实例正在运行（数据库被锁定）"
                                    ));
                                }
                                Err(_) => {
                                    // 无法连接，但确实是锁定错误
                                    eprintln!("错误: ProviderRuntime 初始化失败，数据库被锁定。");
                                    eprintln!("请检查是否有其他进程正在使用数据库，或稍后重试。");
                                    return Err(format!("ProviderRuntime init failed: {}", e2));
                                }
                            }
                        } else {
                            // 不是锁定错误，直接返回错误
                            return Err(format!("ProviderRuntime init failed: {}", e2));
                        }
                    }
                }
            }
        }
    }
    println!("  ✓ ProviderRuntime initialized");

    // Virtual Drive（仅 Windows + feature 启用时）
    // TODO: 初始化 挂载虚拟盘
    #[cfg(feature = "virtual-driver")]
    let virtual_drive_service = Arc::new(VirtualDriveService::default());
    #[cfg(feature = "virtual-driver")]
    println!("  ✓ Virtual drive support enabled");

    #[cfg(feature = "virtual-driver")]
    let ctx = Arc::new(Store {
        // PluginManager 现在是全局单例，不再需要存储在这里
        // Storage 现在是全局单例，不再需要存储在这里
        // TaskScheduler 现在是全局单例，不再需要存储在这里
        broadcaster: broadcaster.clone(),
        subscription_manager: subscription_manager.clone(),
        dedupe_service,
        virtual_drive_service: virtual_drive_service.clone(),
    });

    #[cfg(not(feature = "virtual-driver"))]
    let ctx = Arc::new(Store {
        // PluginManager 现在是全局单例，不再需要存储在这里
        // Storage 现在是全局单例，不再需要存储在这里
        // TaskScheduler 现在是全局单例，不再需要存储在这里
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
            // 稍等片刻确保所有服务已初始化完成
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

                match mount_result {
                    Ok(Ok(())) => {
                        println!("启动时自动挂载画册盘成功: {}", mount_point);
                    }
                    Ok(Err(e)) => {
                        eprintln!("启动时自动挂载画册盘失败: {} (挂载点: {})", e, mount_point);
                    }
                    Err(e) => {
                        eprintln!(
                            "启动时自动挂载画册盘失败（spawn_blocking 错误）: {} (挂载点: {})",
                            e, mount_point
                        );
                    }
                }
            }
        });
    }

    println!("Starting IPC server...");
    // 启动 IPC 服务

    server::serve_with_events(
        move |req| {
            let ctx = ctx.clone();

            async move {
                // 记录请求
                eprintln!("[DEBUG] Daemon 收到请求: {:?}", req);

                // 分发请求到对应的处理器
                let resp = dispatch_request(req, ctx).await;

                // 记录响应
                if resp.ok {
                    eprintln!("[DEBUG] Daemon 发送响应: OK, message={:?}", resp.message);
                } else {
                    eprintln!("[DEBUG] Daemon 发送响应: ERROR, message={:?}", resp.message);
                }

                resp
            }
        },
        Some(broadcaster.clone() as Arc<dyn std::any::Any + Send + Sync>),
        Some(subscription_manager.clone()),
    )
    .await
}
