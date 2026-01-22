use std::sync::Arc;

use kabegame_core::ipc::CliIpcRequest;
use kabegame_core::ipc::CliIpcResponse;
use kabegame_core::ipc::SubscriptionManager;

#[cfg(target_os = "windows")]
use crate::server_windows::serve;

#[cfg(any(target_os = "linux", target_os = "macos"))]
use crate::server_unix::serve;

/// 服务端：循环处理请求，支持长连接事件推送
pub async fn serve_with_events<F, Fut>(
    handler: F,
    broadcaster: Option<Arc<dyn std::any::Any + Send + Sync>>,
    subscription_manager: Option<Arc<SubscriptionManager>>,
) -> Result<(), String>
where
    F: Fn(CliIpcRequest) -> Fut + Send + Sync + Clone + 'static,
    Fut: std::future::Future<Output = CliIpcResponse> + Send,
{
    serve_impl(handler, broadcaster, subscription_manager).await
}

async fn serve_impl<F, Fut>(
    handler: F,
    broadcaster: Option<Arc<dyn std::any::Any + Send + Sync>>,
    subscription_manager: Option<Arc<SubscriptionManager>>,
) -> Result<(), String>
where
    F: Fn(CliIpcRequest) -> Fut + Send + Sync + Clone + 'static,
    Fut: std::future::Future<Output = CliIpcResponse> + Send,
{
    serve(handler, broadcaster, subscription_manager).await
}
