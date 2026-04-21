use axum::{Router, routing::get};
use std::net::SocketAddr;

pub fn run() {
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("Failed to build tokio runtime");

    rt.block_on(async move {
        if let Err(e) = crate::core_init::init_app_paths_for_web() {
            eprintln!("AppPaths initialization failed: {e}");
            std::process::exit(1);
        }

        if let Err(e) = crate::core_init::init_globals() {
            eprintln!("Initialization failed: {e}");
            std::process::exit(1);
        }

        crate::web::init_registry();

        // 启动事件转发：把 GlobalEmitter 广播的 sync_tx → 类型化 broadcast 通道
        // 没有这个，SSE 订阅的 event_txs[kind] 永远收不到事件
        tokio::spawn(async {
            println!("  ▶ Starting EventBroadcaster forward task (web mode)...");
            kabegame_core::ipc::server::EventBroadcaster::start_forward_task().await;
            println!("  ✗ EventBroadcaster forward task exited");
        });

        crate::web::start_web_event_loop();

        // 启动 TaskScheduler worker（必须，否则 start_task 入队后无人消费 → 永远 pending）
        tokio::spawn(async {
            println!("  ▶ Starting download workers (web mode)...");
            kabegame_core::crawler::TaskScheduler::global()
                .start_download_workers_async()
                .await;
            kabegame_core::crawler::TaskScheduler::global().set_task_concurrency();
            println!("  ✓ Download workers started");
        });
        tokio::spawn(async {
            println!(
                "  ▶ Starting {} task worker loop(s) (web mode)...",
                kabegame_core::crawler::MAX_TASK_WORKER_LOOPS
            );
            kabegame_core::crawler::TaskScheduler::global()
                .start_workers(kabegame_core::crawler::MAX_TASK_WORKER_LOOPS)
                .await;
            println!("  ✓ Task worker loops started");
        });

        tokio::spawn(async { crate::web_import::gc_stale_uploads().await });

        // web 无前端弹窗确认：启动时自动触发所有漏跑的定时任务
        tokio::spawn(async {
            match kabegame_core::scheduler::collect_missed_runs_now() {
                Ok(items) if !items.is_empty() => {
                    let ids: Vec<String> = items.iter().map(|i| i.config_id.clone()).collect();
                    println!("  ✓ Auto-running {} missed schedule(s)", ids.len());
                    kabegame_core::scheduler::run_missed_configs(&ids);
                    let _ = kabegame_core::scheduler::Scheduler::global().reload_config("").await;
                }
                Ok(_) => {}
                Err(e) => eprintln!("  ✗ Failed to collect missed runs: {e}"),
            }
        });

        let router = Router::new()
            .route("/__ping", get(|| async { "ok" }))
            .merge(crate::http_server::file_routes_web())
            .merge(crate::web_import::api_routes())
            .merge(crate::mcp_server::mcp_nest())
            .merge(crate::web::web_routes())
            .fallback_service(crate::web_assets::static_assets_router());

        let addr: SocketAddr = "0.0.0.0:7490".parse().unwrap();
        let listener = tokio::net::TcpListener::bind(addr)
            .await
            .expect("Failed to bind 0.0.0.0:7490");
        println!("  ✓ Web server listening on {addr}");
        axum::serve(listener, router)
            .await
            .expect("Web server exited unexpectedly");
    });
}
