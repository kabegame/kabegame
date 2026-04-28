//! Images 表相关操作。
use kabegame_core::ipc::ipc::IpcResponse;
use kabegame_core::storage::image_events::{delete_images_with_events, toggle_image_favorite_with_event};
use kabegame_core::storage::Storage;

pub async fn get_images_count() -> IpcResponse {
    let storage = Storage::global();
    match storage.get_total_count() {
        Ok(count) => {
            IpcResponse::ok_with_data("ok", serde_json::to_value(count).unwrap_or_default())
        }
        Err(e) => IpcResponse::err(e),
    }
}

pub async fn get_image_by_id(image_id: &str) -> IpcResponse {
    let storage = Storage::global();
    match storage.find_image_by_id(image_id) {
        Ok(image) => {
            IpcResponse::ok_with_data("ok", serde_json::to_value(image).unwrap_or_default())
        }
        Err(e) => IpcResponse::err(e),
    }
}

pub async fn find_image_by_path(path: &str) -> IpcResponse {
    let storage = Storage::global();
    match storage.find_image_by_path(path) {
        Ok(image) => {
            IpcResponse::ok_with_data("ok", serde_json::to_value(image).unwrap_or_default())
        }
        Err(e) => IpcResponse::err(e),
    }
}

// TODO: 画廊按时间显示
#[allow(dead_code)]
pub async fn get_gallery_date_groups() -> IpcResponse {
    let storage = Storage::global();
    match storage.get_gallery_date_groups() {
        Ok(groups) => {
            IpcResponse::ok_with_data("ok", serde_json::to_value(groups).unwrap_or_default())
        }
        Err(e) => IpcResponse::err(e),
    }
}

pub async fn get_gallery_plugin_groups() -> IpcResponse {
    let storage = Storage::global();
    match storage.get_gallery_plugin_groups() {
        Ok(groups) => {
            IpcResponse::ok_with_data("ok", serde_json::to_value(groups).unwrap_or_default())
        }
        Err(e) => IpcResponse::err(e),
    }
}

/// 6b 弃用：旧 ImageQuery JSON wire 接口废弃；前端改用 provider path API
/// (`browse_gallery_provider` / `query_provider`) 通过 path 表达过滤条件。
pub async fn get_images_count_by_query(_query: &serde_json::Value) -> IpcResponse {
    IpcResponse::err(
        "get_images_count_by_query is deprecated since 6b; use provider path API instead"
            .to_string(),
    )
}

pub async fn delete_image(image_id: &str) -> IpcResponse {
    match delete_images_with_events(&[image_id.to_string()], true) {
        Ok(()) => IpcResponse::ok("deleted"),
        Err(e) => IpcResponse::err(e),
    }
}

pub async fn remove_image(image_id: &str) -> IpcResponse {
    match delete_images_with_events(&[image_id.to_string()], false) {
        Ok(()) => IpcResponse::ok("removed"),
        Err(e) => IpcResponse::err(e),
    }
}

pub async fn batch_delete_images(image_ids: &[String]) -> IpcResponse {
    match delete_images_with_events(image_ids, true) {
        Ok(()) => IpcResponse::ok("deleted"),
        Err(e) => IpcResponse::err(e),
    }
}

pub async fn batch_remove_images(image_ids: &[String]) -> IpcResponse {
    match delete_images_with_events(image_ids, false) {
        Ok(()) => IpcResponse::ok("removed"),
        Err(e) => IpcResponse::err(e),
    }
}

pub async fn toggle_image_favorite(image_id: &str, favorite: bool) -> IpcResponse {
    match toggle_image_favorite_with_event(image_id, favorite) {
        Ok(()) => IpcResponse::ok("ok"),
        Err(e) => IpcResponse::err(e),
    }
}
