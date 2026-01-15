//! Events 命令处理器

use kabegame_core::ipc::ipc::{CliIpcRequest, CliIpcResponse};
use kabegame_core::ipc::EventBroadcaster;
use std::sync::Arc;

/// 处理所有 Events 相关的 IPC 请求
pub async fn handle_events_request(
    req: &CliIpcRequest,
    broadcaster: Arc<EventBroadcaster>,
) -> Option<CliIpcResponse> {
    match req {
        CliIpcRequest::GetPendingEvents { since } => {
            Some(get_pending_events(broadcaster, *since).await)
        }
        
        CliIpcRequest::SubscribeEvents => {
            Some(subscribe_events().await)
        }
        
        CliIpcRequest::UnsubscribeEvents => {
            Some(unsubscribe_events().await)
        }
        
        _ => None,
    }
}

async fn get_pending_events(
    broadcaster: Arc<EventBroadcaster>,
    since: Option<u64>,
) -> CliIpcResponse {
    let events = broadcaster.get_events_since(since).await;
    CliIpcResponse::ok_with_events("ok", events)
}

async fn subscribe_events() -> CliIpcResponse {
    // TODO: 实现订阅逻辑（WebSocket 或长轮询）
    CliIpcResponse::ok("subscribed (polling mode)")
}

async fn unsubscribe_events() -> CliIpcResponse {
    // TODO: 实现取消订阅逻辑
    CliIpcResponse::ok("unsubscribed")
}
