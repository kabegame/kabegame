//! IPC 服务器核心实现

use crate::ipc::{CliIpcRequest, CliIpcResponse};

#[cfg(target_os = "windows")]
use crate::ipc::server::server_windows::serve;

#[cfg(any(target_os = "linux", target_os = "macos"))]
use crate::ipc::server::server_unix::serve;

pub async fn serve_with_events<F, Fut>(
    handler: F,
) -> Result<(), String>
where
    F: Fn(CliIpcRequest) -> Fut + Send + Sync + Clone + 'static,
    Fut: std::future::Future<Output = CliIpcResponse> + Send,
{
    serve_impl(handler).await
}

async fn serve_impl<F, Fut>(
    handler: F,
) -> Result<(), String>
where
    F: Fn(CliIpcRequest) -> Fut + Send + Sync + Clone + 'static,
    Fut: std::future::Future<Output = CliIpcResponse> + Send,
{
    #[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
    {
        serve(handler).await
    }
    #[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
    {
        let _ = handler;
        Err("IPC server not supported on Android".to_string())
    }
}
