//! Gallery / Provider 命令处理器

use kabegame_core::ipc::ipc::{CliIpcRequest, CliIpcResponse};
use kabegame_core::providers::execute_provider_query;

pub async fn handle_gallery_request(req: &CliIpcRequest) -> Option<CliIpcResponse> {
    match req {
        CliIpcRequest::GalleryBrowseProvider { path } => Some(browse_provider(path).await),
        _ => None,
    }
}

async fn browse_provider(path: &str) -> CliIpcResponse {
    let trimmed = path.trim().trim_start_matches('/').to_string();
    let effective = if trimmed.ends_with("/*") || trimmed.ends_with('/') {
        trimmed
    } else {
        format!("{}/", trimmed)
    };
    let full = format!("gallery/{}", effective);
    match execute_provider_query(&full) {
        Ok(data) => CliIpcResponse::ok_with_data("ok", data),
        Err(e) => CliIpcResponse::err(e),
    }
}
