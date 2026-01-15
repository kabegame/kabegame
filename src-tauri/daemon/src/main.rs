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
    ipc::{ipc, EventBroadcaster},
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

    // 初始化所有组件（不依赖 Tauri）
    let plugin_manager = Arc::new(PluginManager::new());
    println!("  ✓ Plugin manager initialized");

    let storage = Arc::new({
        let s = Storage::new();
        s.init()
            .map_err(|e| format!("Failed to initialize storage: {}", e))?;
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
        Arc::new(
            ProviderRuntime::new(cfg)
                .unwrap_or_else(|e| {
                    eprintln!("[providers] init ProviderRuntime failed, fallback to default cfg: {}", e);
                    ProviderRuntime::new(ProviderCacheConfig::default())
                        .expect("ProviderRuntime init failed")
                }),
        )
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
    #[cfg(all(feature = "virtual-drive", target_os = "windows"))]
    {
        println!("  ✓ Virtual drive support enabled");
    }

    println!("Starting IPC server...");
    // 启动 IPC 服务
    println!("IPC server listening on /tmp/kabegame-cli.sock");
    println!("Ready to accept requests.\n");

    ipc::serve(move |req| {
        let ctx = ctx.clone();
        
        async move {
            // 记录请求
            eprintln!("[REQUEST] {:?}", req);
            
            // 分发请求到对应的处理器
            let resp = dispatch_request(req, ctx).await;
            
            // 记录响应
            if resp.ok {
                eprintln!("[RESPONSE] OK");
            } else {
                eprintln!("[RESPONSE] ERROR: {:?}", resp.message);
            }
            
            resp
        }
    })
    .await
}
