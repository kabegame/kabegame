//! Gallery / Provider 命令处理器

use kabegame_core::ipc::ipc::{IpcRequest, IpcResponse};
use kabegame_core::providers::{query_entry, query_list};
use serde_json::json;

pub async fn handle_gallery_request(req: &IpcRequest) -> Option<IpcResponse> {
    match req {
        IpcRequest::GalleryBrowseProvider { path } => Some(browse_provider(path).await),
        _ => None,
    }
}

async fn browse_provider(path: &str) -> IpcResponse {
    let trimmed = path
        .trim()
        .trim_start_matches('/')
        .trim_end_matches('/')
        .trim_end_matches("/*")
        .to_string();
    let full = format!("gallery/{}", trimmed);
    let entry = match query_entry(&full) {
        Ok(entry) => entry,
        Err(e) => return IpcResponse::err(e),
    };
    let children = match query_list(&full, false) {
        Ok(children) => children
            .into_iter()
            .map(|child| {
                json!({
                    "kind": "dir",
                    "name": child.name,
                    "meta": child.meta,
                    "total": child.total,
                })
            })
            .collect::<Vec<_>>(),
        Err(_) => Vec::new(),
    };
    match serde_json::to_value(entry) {
        Ok(mut data) => {
            if let Some(obj) = data.as_object_mut() {
                obj.insert("entries".to_string(), serde_json::Value::Array(children));
            }
            IpcResponse::ok_with_data("ok", data)
        }
        Err(e) => IpcResponse::err(e.to_string()),
    }
}
