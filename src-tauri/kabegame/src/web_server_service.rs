//! 桌面应用 Web 服务器的启停管理（单例）。
//!
//! 一个监听器同时承载 JSON-RPC、SSE、媒体文件和 MCP；对外状态完全走
//! settings（`webServerEnabled` / `webServerPort` / `webServerLanAccess`）。

use std::sync::{Arc, Mutex, OnceLock};

use axum::{
    body::Body,
    http::{header, Request, StatusCode},
    middleware::{from_fn, Next},
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use tokio::sync::oneshot;

pub const DEFAULT_SERVER_PORT: u16 = 7490;

struct RunningServer {
    shutdown: oneshot::Sender<()>,
    join: tokio::task::JoinHandle<()>,
}

pub struct WebServerService {
    running: Mutex<Option<RunningServer>>,
}

static GLOBAL: OnceLock<Arc<WebServerService>> = OnceLock::new();

impl WebServerService {
    pub fn new() -> Self {
        Self {
            running: Mutex::new(None),
        }
    }

    pub fn init_global(svc: Arc<WebServerService>) -> Result<(), String> {
        GLOBAL
            .set(svc)
            .map_err(|_| "WebServerService already initialized".to_string())
    }

    pub fn global() -> Arc<WebServerService> {
        GLOBAL
            .get()
            .expect("WebServerService not initialized")
            .clone()
    }

    pub fn is_running(&self) -> bool {
        self.running.lock().unwrap().is_some()
    }

    pub async fn start(&self, port: u16, lan: bool) -> Result<(), String> {
        if self.is_running() {
            self.stop().await;
        }

        let host = if lan { "0.0.0.0" } else { "127.0.0.1" };
        let listener = tokio::net::TcpListener::bind((host, port))
            .await
            .map_err(|e| format!("无法启动 Web 服务器：端口 {port} 绑定失败：{e}"))?;
        let router = Router::new()
            .route("/__ping", get(|| async { "ok" }))
            .merge(crate::http_server::file_routes_media())
            .merge(crate::web::web_routes())
            .merge(crate::mcp_server::mcp_nest(lan))
            .layer(from_fn(reject_browser_mw));
        let (shutdown, rx) = oneshot::channel();
        let join = tokio::spawn(async move {
            let server = axum::serve(listener, router).with_graceful_shutdown(async move {
                let _ = rx.await;
            });
            if let Err(e) = server.await {
                eprintln!("[Web Server] 服务异常退出: {e}");
            }
        });

        *self.running.lock().unwrap() = Some(RunningServer { shutdown, join });
        println!("  ✓ Web server listening on {host}:{port}");
        Ok(())
    }

    pub async fn stop(&self) {
        let running = self.running.lock().unwrap().take();
        if let Some(handle) = running {
            let _ = handle.shutdown.send(());
            let _ = handle.join.await;
        }
    }

    pub async fn restart(&self, port: u16, lan: bool) -> Result<(), String> {
        self.stop().await;
        self.start(port, lan).await
    }
}

impl Default for WebServerService {
    fn default() -> Self {
        Self::new()
    }
}

/// 拒绝浏览器发起的请求：服务无鉴权，网页一旦能连上即可跨站读写图库。
/// `Origin` 与 `Sec-Fetch-*` 是浏览器 forbidden header，网页脚本无法去除或伪造；
/// curl、脚本和 MCP 客户端默认不发送，不受影响。响应不返回任何 CORS 头。
async fn reject_browser_mw(req: Request<Body>, next: Next) -> Response {
    let headers = req.headers();
    let from_browser = headers.contains_key(header::ORIGIN)
        || headers.contains_key("sec-fetch-mode")
        || headers.contains_key("sec-fetch-site")
        || headers.contains_key("sec-fetch-dest");
    if from_browser {
        return (StatusCode::FORBIDDEN, "browser requests are not allowed").into_response();
    }
    next.run(req).await
}
