//! Kabegame Daemon（常驻后台服务）
//!
//! 统一的后台服务，处理：
//! - Storage 操作（图片、画册、任务、配置）
//! - Plugin 管理（列表、安装、删除）
//! - Settings 管理（获取、更新）
//! - Events 广播（任务日志、下载状态、任务状态）
//!
//! 所有前端（app-main、plugin-editor、cli、Plasma 壁纸插件）通过 Unix Socket IPC 与 daemon 通信。

mod handlers;
mod dedupe_service;

use handlers::{dispatch_request, RequestContext};
use kabegame_core::{
    crawler::{DownloadQueue, TaskScheduler},
    ipc::{ipc, CliIpcRequest, EventBroadcaster},
    plugin::PluginManager,
    providers::{ProviderCacheConfig, ProviderRuntime},
    runtime::ipc_runtime::IpcRuntime,
    runtime::StateManager,
    settings::Settings,
    storage::Storage,
};
use std::sync::Arc;
use dedupe_service::DedupeService;


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

    // 初始化所有组件
    let plugin_manager = Arc::new(PluginManager::new());
    println!("  ✓ Plugin manager initialized");

    let storage = Arc::new({
        let s = Storage::new();
        s.init()
            .map_err(|e| format!("Failed to initialize storage: {}", e))?;
        // 将 pending 或 running 的任务标记为失败
        let failed_count = s.mark_pending_running_tasks_as_failed()
            .unwrap_or(0);
        if failed_count > 0 {
            println!("  ✓ Marked {failed_count} pending/running task(s) as failed");
        }
        s
    });
    println!("  ✓ Storage initialized");

    let settings = Arc::new(Settings::new());
    println!("  ✓ Settings initialized");

    // 创建事件广播器（保留最近 1000 个事件）
    let broadcaster = Arc::new(EventBroadcaster::new(1000));
    println!("  ✓ Event broadcaster initialized");

    // 构建 daemon runtime（事件：IPC；状态：HashMap）
    let runtime = Arc::new(IpcRuntime::new(broadcaster.clone()));
    runtime.manage(plugin_manager.clone())?;
    runtime.manage(storage.clone())?;
    runtime.manage(settings.clone())?;
    println!("  ✓ IpcRuntime initialized");

    // DownloadQueue：worker 线程需要 emitter/settings/storage
    let emitter: Arc<dyn kabegame_core::runtime::EventEmitter> = runtime.clone();
    let download_queue = Arc::new(DownloadQueue::new(
        emitter.clone(),
        settings.clone(),
        storage.clone(),
    ));
    println!("  ✓ DownloadQueue initialized");

    // TaskScheduler：负责处理 PluginRun 的任务队列
    let task_scheduler = Arc::new(TaskScheduler::new(
        plugin_manager.clone(),
        download_queue.clone(),
    ));
    // let restored = task_scheduler.restore_pending_tasks().unwrap_or(0);
    // println!("  ✓ TaskScheduler initialized (restored {restored} tasks)");

    // 创建请求上下文
    let dedupe_service = Arc::new(DedupeService::new());
    let provider_rt = {
        let mut cfg = ProviderCacheConfig::default();
        if let Ok(dir) = std::env::var("KABEGAME_PROVIDER_DB_DIR") {
            cfg.db_dir = std::path::PathBuf::from(dir);
        }
        
        // 尝试初始化 ProviderRuntime
        match ProviderRuntime::new(cfg.clone()) {
            Ok(rt) => Arc::new(rt),
            Err(e) => {
                // 初始化失败，检查是否是数据库锁定错误
                let error_msg = format!("{}", e);
                let is_lock_error = error_msg.contains("could not acquire lock") 
                    || error_msg.contains("Resource temporarily unavailable")
                    || error_msg.contains("WouldBlock");
                
                if is_lock_error {
                    // 如果是锁定错误，检查是否有其他 daemon 正在运行
                    eprintln!("[providers] 检测到数据库锁定错误，检查是否有其他 daemon 正在运行...");
                    match ipc::request(CliIpcRequest::Status).await {
                        Ok(_) => {
                            eprintln!("错误: ProviderRuntime 初始化失败，因为已有其他 daemon 正在运行。");
                            eprintln!("请先停止正在运行的 daemon，或确保只有一个 daemon 实例。");
                            return Err(format!("另一个 daemon 实例正在运行（数据库被锁定）"));
                        },
                        Err(_) => {
                            // 无法连接到其他 daemon，可能是其他原因导致的锁定
                            eprintln!("[providers] 无法连接到其他 daemon，但检测到数据库锁定");
                        }
                    }
                }
                
                eprintln!("[providers] init ProviderRuntime failed, fallback to default cfg: {}", e);
                
                // 尝试使用默认配置
                match ProviderRuntime::new(ProviderCacheConfig::default()) {
                    Ok(rt) => Arc::new(rt),
                    Err(e2) => {
                        let error_msg2 = format!("{}", e2);
                        let is_lock_error2 = error_msg2.contains("could not acquire lock") 
                            || error_msg2.contains("Resource temporarily unavailable")
                            || error_msg2.contains("WouldBlock");
                        
                        if is_lock_error2 {
                            // 默认配置也锁定，再次检查
                            eprintln!("[providers] 默认配置也失败，检查是否有其他 daemon 正在运行...");
                            match ipc::request(CliIpcRequest::Status).await {
                                Ok(_) => {
                                    eprintln!("错误: ProviderRuntime 初始化失败，因为已有其他 daemon 正在运行。");
                                    eprintln!("请先停止正在运行的 daemon，或确保只有一个 daemon 实例。");
                                    return Err(format!("另一个 daemon 实例正在运行（数据库被锁定）"));
                                },
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
    };
    let ctx = Arc::new(RequestContext {
        storage,
        plugin_manager,
        settings,
        broadcaster: broadcaster.clone(),
        task_scheduler,
        dedupe_service,
        provider_rt,
    });

    // Virtual Drive（仅 Windows + feature 启用时）
    // TODO 初始化 virtual drive
    #[cfg(all(feature = "virtual-drive", target_os = "windows"))]
    {
        println!("  ✓ Virtual drive support enabled");
    }

    println!("Starting IPC server...");
    // 启动 IPC 服务
    println!("IPC server listening on /tmp/kabegame-cli.sock");
    println!("Ready to accept requests.\n");

    ipc::serve_with_events(
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
    )
    .await
}
