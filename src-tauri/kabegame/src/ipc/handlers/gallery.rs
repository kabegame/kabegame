//! Gallery / Provider 命令处理器

use kabegame_core::ipc::ipc::{IpcRequest, IpcResponse};
use kabegame_core::providers::{decode_provider_path_segments, query_entry, query_list};
use serde_json::json;

pub async fn handle_gallery_request(req: &IpcRequest) -> Option<IpcResponse> {
    match req {
        IpcRequest::GalleryBrowseProvider { path } => Some(browse_provider(path).await),
        IpcRequest::PathqlEntry { path } => Some(pathql_entry(path).await),
        IpcRequest::PathqlList { path, with_count } => Some(pathql_list(path, *with_count).await),
        IpcRequest::PathqlFetch { path } => Some(pathql_fetch(path).await),
        _ => None,
    }
}

async fn pathql_entry(path: &str) -> IpcResponse {
    match kabegame_core::commands::image::pathql_entry(path.to_string()).await {
        Ok(data) => IpcResponse::ok_with_data("ok", data),
        Err(error) => IpcResponse::err(error),
    }
}

async fn pathql_list(path: &str, with_count: bool) -> IpcResponse {
    match kabegame_core::commands::image::pathql_list(path.to_string(), with_count).await {
        Ok(data) => IpcResponse::ok_with_data("ok", data),
        Err(error) => IpcResponse::err(error),
    }
}

async fn pathql_fetch(path: &str) -> IpcResponse {
    match kabegame_core::commands::image::pathql_fetch(path.to_string()).await {
        Ok(data) => IpcResponse::ok_with_data("ok", data),
        Err(error) => IpcResponse::err(error),
    }
}

async fn browse_provider(path: &str) -> IpcResponse {
    let trimmed = path
        .trim()
        .trim_start_matches('/')
        .trim_end_matches('/')
        .trim_end_matches("/*")
        .to_string();
    let full = decode_provider_path_segments(&format!("gallery/{}", trimmed));
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
