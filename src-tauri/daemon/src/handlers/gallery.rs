//! Gallery / Provider 命令处理器

use kabegame_core::ipc::ipc::{CliIpcRequest, CliIpcResponse};
use kabegame_core::providers::ProviderRuntime;
use kabegame_core::storage::Storage;
use std::sync::Arc;

pub async fn handle_gallery_request(
    req: &CliIpcRequest,
    storage: Arc<Storage>,
    provider_rt: Arc<ProviderRuntime>,
) -> Option<CliIpcResponse> {
    match req {
        CliIpcRequest::GalleryBrowseProvider { path } => {
            Some(browse_provider(storage, provider_rt, path).await)
        }
        _ => None,
    }
}

async fn browse_provider(
    storage: Arc<Storage>,
    provider_rt: Arc<ProviderRuntime>,
    path: &str,
) -> CliIpcResponse {
    match kabegame_core::gallery::browse_gallery_provider(&storage, &provider_rt, path) {
        Ok(res) => CliIpcResponse::ok_with_data(
            "ok",
            serde_json::to_value(res).unwrap_or_default(),
        ),
        Err(e) => CliIpcResponse::err(e),
    }
}

