//! Gallery / Provider 命令处理器

use kabegame_core::ipc::ipc::{CliIpcRequest, CliIpcResponse};
use kabegame_core::providers::ProviderRuntime;
use kabegame_core::storage::Storage;

pub async fn handle_gallery_request(req: &CliIpcRequest) -> Option<CliIpcResponse> {
    match req {
        CliIpcRequest::GalleryBrowseProvider { path } => Some(browse_provider(path).await),
        _ => None,
    }
}

async fn browse_provider(path: &str) -> CliIpcResponse {
    let storage = Storage::global();
    let provider_rt = ProviderRuntime::global();
    match kabegame_core::gallery::browse_gallery_provider(storage, provider_rt, path) {
        Ok(res) => {
            CliIpcResponse::ok_with_data("ok", serde_json::to_value(res).unwrap_or_default())
        }
        Err(e) => CliIpcResponse::err(e),
    }
}
