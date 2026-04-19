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

        let router = Router::new().route("/__ping", get(|| async { "ok" }));
        let addr: SocketAddr = "127.0.0.1:7490".parse().unwrap();
        let listener = tokio::net::TcpListener::bind(addr)
            .await
            .expect("Failed to bind 127.0.0.1:7490");
        println!("  ✓ Web server listening on {addr}");
        axum::serve(listener, router)
            .await
            .expect("Web server exited unexpectedly");
    });
}
