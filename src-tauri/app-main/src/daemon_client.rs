//! Daemon 连接管理模块
//!
//! 提供统一的 daemon IPC 客户端访问接口，支持：
//! - 自动连接 daemon
//! - 连接失败时回退到本地 State
//! - 缓存 IpcClient 实例

use kabegame_core::ipc::daemon_startup;
use tauri::AppHandle;

use super::event_listeners;

/// 初始化事件监听器（在 Tauri 应用启动时调用）
///
/// 该函数会：
/// 1. 订阅 daemon 的 IPC 事件（按感兴趣的事件类型列表）
/// 2. 将这些事件转发为 Tauri 事件（供前端 JS 监听）
/// 3. 启动长连接事件监听（持续接收服务器推送的事件）
pub async fn init_event_listeners(app: AppHandle) {
    event_listeners::init_event_listeners(app).await;
}

/// 获取 IPC 客户端实例（单例）
pub fn get_ipc_client() -> &'static kabegame_core::ipc::IpcClient {
    daemon_startup::get_ipc_client()
}

/// 检查 daemon 是否可用
pub async fn is_daemon_available() -> bool {
    daemon_startup::is_daemon_available().await
}

/// 尝试连接 daemon，返回是否成功
///
/// 先建立连接，然后检查状态
pub async fn try_connect_daemon() -> Result<serde_json::Value, String> {
    // 先建立连接
    println!("[try_connect_daemon] 尝试连接...");
    get_ipc_client().connect().await?;
    println!("[try_connect_daemon] 连接成功，检查状态...");
    // 然后检查状态
    let result = get_ipc_client().status().await;
    if result.is_ok() {
        println!("[try_connect_daemon] 状态检查成功");
    } else {
        println!(
            "[try_connect_daemon] 状态检查失败: {:?}",
            result.as_ref().err()
        );
    }
    result
}

/// 确保 daemon 已启动并可用（如果不可用则自动启动）
///
/// 注意：此函数仅在后端内部使用，前端不需要手动调用（后端会在启动时自动调用）
pub async fn ensure_daemon_ready() -> Result<(), String> {
    daemon_startup::ensure_daemon_ready().await?;
    Ok(())
}

/// 启动连接状态监听任务
///
/// 监听 IPC 连接状态变化，并在状态变化时发送 daemon-ready 或 daemon-offline 事件
pub fn spawn_connection_status_watcher(app: AppHandle) {
    daemon_startup::spawn_connection_status_watcher(app, "daemon-ready", "daemon-offline");
}
