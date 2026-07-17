//! `McpService`：MCP HTTP 服务的启停管理（单例）。
//!
//! 只负责后端服务生命周期；对外状态完全走 settings（`mcpEnabled`/`mcpPort`）
//! 的 `emit_setting_change`，不再有独立的 mcp-state 事件或快照概念。

use std::sync::{Arc, Mutex, OnceLock};

use tokio::sync::oneshot;

use crate::mcp_server;

/// 正在运行的 MCP 服务句柄。
struct RunningMcpServer {
    shutdown: oneshot::Sender<()>,
    join: tokio::task::JoinHandle<()>,
}

pub struct McpService {
    running: Mutex<Option<RunningMcpServer>>,
}

static GLOBAL: OnceLock<Arc<McpService>> = OnceLock::new();

impl McpService {
    pub fn new() -> Self {
        Self {
            running: Mutex::new(None),
        }
    }

    pub fn init_global(svc: Arc<McpService>) -> Result<(), String> {
        GLOBAL
            .set(svc)
            .map_err(|_| "McpService already initialized".to_string())
    }

    pub fn global() -> Arc<McpService> {
        GLOBAL.get().expect("McpService not initialized").clone()
    }

    /// 服务是否正在运行（供改端口时判断是否需要重启）。
    pub fn is_running(&self) -> bool {
        self.running.lock().unwrap().is_some()
    }

    /// 在 `127.0.0.1:port` 启动 MCP 服务；端口占用等失败返回 `Err`。
    pub async fn start(&self, port: u16) -> Result<(), String> {
        if self.running.lock().unwrap().is_some() {
            self.stop().await;
        }

        let listener = tokio::net::TcpListener::bind(("127.0.0.1", port))
            .await
            .map_err(|e| format!("无法启动 MCP 服务：端口 {port} 绑定失败：{e}"))?;
        let (shutdown, rx) = oneshot::channel();
        let join = tokio::spawn(async move {
            let server = axum::serve(listener, mcp_server::mcp_nest())
                .with_graceful_shutdown(async move {
                    let _ = rx.await;
                });
            if let Err(e) = server.await {
                eprintln!("[MCP] 服务异常退出: {e}");
            }
        });

        *self.running.lock().unwrap() = Some(RunningMcpServer { shutdown, join });
        println!("  ✓ MCP server listening on 127.0.0.1:{port}");
        Ok(())
    }

    /// 停止 MCP 服务（幂等，未运行时为空操作）。
    pub async fn stop(&self) {
        let running = self.running.lock().unwrap().take();
        if let Some(handle) = running {
            let _ = handle.shutdown.send(());
            let _ = handle.join.await;
        }
    }

    /// 以新端口重启（先停后起）。
    pub async fn restart(&self, port: u16) -> Result<(), String> {
        self.stop().await;
        self.start(port).await
    }
}

impl Default for McpService {
    fn default() -> Self {
        Self::new()
    }
}
