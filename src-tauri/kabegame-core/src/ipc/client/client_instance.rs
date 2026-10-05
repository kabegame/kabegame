//! IPC 客户端单例。
//!
//! 客户端连接由调用方按需建立；Kabegame 的 IPC 服务由主应用进程提供。

use super::IpcClient;
use std::sync::OnceLock;

pub static IPC_CLIENT: OnceLock<IpcClient> = OnceLock::new();

/// 获取 IPC 客户端实例（单例）
///
/// 首次调用时初始化客户端并异步尝试连接；具体请求失败时由连接状态模块统一提示。
pub fn get_ipc_client() -> &'static IpcClient {
    IPC_CLIENT.get_or_init(|| {
        let client = IpcClient::new();
        // 异步尝试连接，如果失败会通过状态管理器处理错误
        let client_clone = client.clone();
        tokio::spawn(async move {
            if let Err(e) = client_clone.connection.clone().connect().await {
                eprintln!("IPC 客户端初始化连接失败: {}", e);
                // 这里不直接处理错误，让后续的 request 调用时处理
            }
        });
        client
    })
}
