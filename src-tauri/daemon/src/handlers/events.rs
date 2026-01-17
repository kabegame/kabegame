//! Events 命令处理器

use kabegame_core::ipc::ipc::{CliIpcRequest, CliIpcResponse};
use kabegame_core::ipc::EventBroadcaster;
use std::sync::Arc;

/// 处理所有 Events 相关的 IPC 请求
pub async fn handle_events_request(
    req: &CliIpcRequest,
    _broadcaster: Arc<EventBroadcaster>,
) -> Option<CliIpcResponse> {
    match req {
        CliIpcRequest::SubscribeEvents => {
            // 长连接事件订阅：服务器会在连接上持续推送事件
            // 返回成功后，连接保持打开，服务器会推送事件（每行一个 JSON）
            Some(CliIpcResponse::ok("subscribed (streaming mode)"))
        }
        
        _ => None,
    }
}
