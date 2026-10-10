//! Gallery / Provider 命令处理器

use kabegame_core::ipc::ipc::{IpcRequest, IpcResponse};

pub async fn handle_gallery_request(req: &IpcRequest) -> Option<IpcResponse> {
    match req {
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
