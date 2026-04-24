//! Events 命令处理器
//!
//! 注意：实际的事件订阅逻辑在 server.rs 中通过 SubscriptionManager 处理。
//! 此模块仅负责返回订阅确认响应。

use kabegame_core::ipc::ipc::{IpcRequest, IpcResponse};

/// 处理所有 Events 相关的 IPC 请求
///
/// 注意：SubscribeEvents 的实际订阅逻辑在 server.rs 中处理。
/// 此函数仅返回确认响应消息。
pub async fn handle_events_request(req: &IpcRequest) -> Option<IpcResponse> {
    match req {
        IpcRequest::SubscribeEvents { kinds } => {
            // 长连接事件订阅：服务器会在连接上持续推送事件
            // 返回成功后，连接保持打开，服务器会推送事件（每行一个 JSON）
            // 实际的订阅逻辑在 server.rs 中通过 SubscriptionManager 处理
            if kinds.is_empty() {
                Some(IpcResponse::ok(
                    "subscribed (streaming mode, all events)",
                ))
            } else {
                Some(IpcResponse::ok(&format!(
                    "subscribed (streaming mode, {} event types)",
                    kinds.len()
                )))
            }
        }

        _ => None,
    }
}
