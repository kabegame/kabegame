//! Gallery / Provider 命令处理器

use kabegame_core::ipc::ipc::{IpcRequest, IpcResponse};
use kabegame_core::providers::execute_provider_query;

pub async fn handle_gallery_request(req: &IpcRequest) -> Option<IpcResponse> {
    match req {
        IpcRequest::GalleryBrowseProvider { path } => Some(browse_provider(path).await),
        _ => None,
    }
}

async fn browse_provider(path: &str) -> IpcResponse {
    let trimmed = path.trim().trim_start_matches('/').to_string();
    let effective = if trimmed.ends_with("/*") || trimmed.ends_with('/') {
        trimmed
    } else {
        format!("{}/", trimmed)
    };
    let full = format!("gallery/{}", effective);
    match execute_provider_query(&full) {
        Ok(data) => IpcResponse::ok_with_data("ok", data),
        Err(e) => IpcResponse::err(e),
    }
}
