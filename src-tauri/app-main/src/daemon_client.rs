//! Daemon 连接管理模块
//!
//! 提供统一的 daemon IPC 客户端访问接口，支持：
//! - 自动连接 daemon
//! - 连接失败时回退到本地 State
//! - 缓存 IpcClient 实例

use kabegame_core::ipc::IpcClient;
use std::sync::OnceLock;

static IPC_CLIENT: OnceLock<IpcClient> = OnceLock::new();

/// 获取 IPC 客户端实例（单例）
pub fn get_ipc_client() -> &'static IpcClient {
    IPC_CLIENT.get_or_init(|| IpcClient::new())
}

/// 检查 daemon 是否可用
pub async fn is_daemon_available() -> bool {
    match get_ipc_client().status().await {
        Ok(_) => true,
        Err(_) => false,
    }
}

/// 尝试连接 daemon，返回是否成功
pub async fn try_connect_daemon() -> Result<serde_json::Value, String> {
    get_ipc_client().status().await
}
