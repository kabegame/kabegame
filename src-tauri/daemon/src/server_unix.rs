//! Unix 特定的服务器实现

use std::sync::Arc;

use kabegame_core::ipc::CliIpcRequest;
use kabegame_core::ipc::CliIpcResponse;
use kabegame_core::ipc::SubscriptionManager;
use kabegame_core::{
    ipc::ipc::{encode_frame, read_one_frame, unix_socket_path, write_all},
    ipc_dbg,
};
use tokio::io::split;
use tokio::net::{UnixListener, UnixStream};
use tokio::time::{timeout, Duration};
use uuid;

use crate::connection_handler;

/// 检查是否有其他 daemon 正在运行
pub async fn check_other_daemon_running() -> bool {
    let path = unix_socket_path();
    // 尝试连接现有的 Unix socket
    let connect_result = timeout(Duration::from_millis(100), UnixStream::connect(&path)).await;

    if let Ok(Ok(mut stream)) = connect_result {
        // 如果连接成功，尝试发送 Status 请求验证
        let status_req = CliIpcRequest::Status;
        if let Ok(bytes) = encode_frame(&status_req) {
            if write_all(&mut stream, &bytes).await.is_ok() {
                // 尝试读取响应（但不等待太久）
                if timeout(Duration::from_millis(100), read_one_frame(&mut stream))
                    .await
                    .is_ok()
                {
                    return true; // 成功连接并得到响应，说明有其他 daemon 在运行
                }
            }
        }
    }
    false
}

/// Unix 平台的服务实现
pub async fn serve<F, Fut>(
    handler: F,
    broadcaster: Option<Arc<dyn std::any::Any + Send + Sync>>,
    subscription_manager: Option<Arc<SubscriptionManager>>,
) -> Result<(), String>
where
    F: Fn(CliIpcRequest) -> Fut + Send + Sync + Clone + 'static,
    Fut: std::future::Future<Output = CliIpcResponse> + Send,
{
    let path = unix_socket_path();
    let _ = std::fs::remove_file(&path);
    let listener = match UnixListener::bind(&path) {
        Ok(l) => l,
        Err(e) => {
            // 绑定失败，检查是否有其他 daemon 正在运行
            if check_other_daemon_running().await {
                eprintln!(
                    "错误: 无法绑定 Unix socket {}，因为已有其他 daemon 正在运行。",
                    path.display()
                );
                eprintln!("请先停止正在运行的 daemon，或确保只有一个 daemon 实例。");
                return Err(format!("另一个 daemon 实例正在运行: {}", e));
            }
            // 如果没有其他 daemon 运行，可能是其他原因导致的绑定失败（如权限问题）
            return Err(format!("ipc bind failed ({}): {}", path.display(), e));
        }
    };

    loop {
        let (stream, _) = listener
            .accept()
            .await
            .map_err(|e| format!("ipc accept failed: {}", e))?;

        ipc_dbg!("[DEBUG] IPC 服务器接受新连接（持久连接模式）");

        // 为每个连接 spawn 一个任务来处理多个请求
        let handler = handler.clone();
        let broadcaster = broadcaster.clone();
        let subscription_manager = subscription_manager.clone();

        // 为每个连接生成唯一的 client_id
        let client_id = uuid::Uuid::new_v4().to_string();

        tokio::spawn(async move {
            let (read_half, write_half) = split(stream);

            connection_handler::handle_connection(
                read_half,
                write_half,
                handler,
                broadcaster,
                subscription_manager,
                client_id,
            )
            .await;

            ipc_dbg!("[DEBUG] IPC 服务器连接处理完成");
        });
    }
}
