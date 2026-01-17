//! Daemon 连接管理模块
//!
//! 提供统一的 daemon IPC 客户端访问接口，支持：
//! - 自动连接 daemon
//! - 连接失败时回退到本地 State
//! - 缓存 IpcClient 实例

use kabegame_core::daemon_startup;

/// 获取 IPC 客户端实例（单例）
pub fn get_ipc_client() -> &'static kabegame_core::ipc::IpcClient {
    daemon_startup::get_ipc_client()
}

/// 检查 daemon 是否可用
pub async fn is_daemon_available() -> bool {
    daemon_startup::is_daemon_available().await
}

/// 尝试连接 daemon，返回是否成功
pub async fn try_connect_daemon() -> Result<serde_json::Value, String> {
    get_ipc_client().status().await
}

/// 确保 daemon 已启动并可用（如果不可用则自动启动）
/// 
/// 注意：此函数仅在后端内部使用，前端不需要手动调用（后端会在启动时自动调用）
pub async fn ensure_daemon_ready(app: &tauri::AppHandle) -> Result<(), String> {
    daemon_startup::ensure_daemon_ready(Some(app))
        .await
        .map(|_| ())
}
