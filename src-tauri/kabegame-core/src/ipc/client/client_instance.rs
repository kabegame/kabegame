//! IPC 客户端单例。
//!
//! 客户端连接由调用方按需建立；Kabegame 的 IPC 服务由主应用进程提供。

use super::IpcClient;
use std::sync::OnceLock;

pub static IPC_CLIENT: OnceLock<IpcClient> = OnceLock::new();

/// 获取 IPC 客户端实例（单例）
///
/// 首次调用时初始化客户端并异步尝试连接。
pub fn get_ipc_client() -> &'static IpcClient {
    IPC_CLIENT.get_or_init(|| {
        let client = IpcClient::new();
        // 全局客户端保持原有的后台尝试语义，失败仅在调试开关打开时输出。
        let client_clone = client.clone();
        tokio::spawn(async move {
            if let Err(e) = client_clone.connection.clone().connect().await {
                crate::ipc_dbg!("IPC 客户端初始化连接失败: {}", e);
            }
        });
        client
    })
}
