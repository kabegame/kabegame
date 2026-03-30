//! Images 陦ｨ逶ｸ蜈ｳ謫堺ｽ・
use kabegame_core::ipc::ipc::CliIpcResponse;
use kabegame_core::storage::gallery::ImageQuery;
use kabegame_core::storage::image_events::{delete_images_with_events, toggle_image_favorite_with_event};
use kabegame_core::storage::Storage;

pub async fn get_images() -> CliIpcResponse {
    let storage = Storage::global();
    match storage.get_all_images() {
        Ok(images) => {
            CliIpcResponse::ok_with_data("ok", serde_json::to_value(images).unwrap_or_default())
        }
        Err(e) => CliIpcResponse::err(e),
    }
}

pub async fn get_images_paginated(page: usize, page_size: usize) -> CliIpcResponse {
    let storage = Storage::global();
    match storage.get_images_paginated(page, page_size) {
        Ok(result) => {
            CliIpcResponse::ok_with_data("ok", serde_json::to_value(result).unwrap_or_default())
        }
        Err(e) => CliIpcResponse::err(e),
    }
}

pub async fn get_images_count() -> CliIpcResponse {
    let storage = Storage::global();
    match storage.get_total_count() {
        Ok(count) => {
            CliIpcResponse::ok_with_data("ok", serde_json::to_value(count).unwrap_or_default())
        }
        Err(e) => CliIpcResponse::err(e),
    }
}

pub async fn get_image_by_id(image_id: &str) -> CliIpcResponse {
    let storage = Storage::global();
    match storage.find_image_by_id(image_id) {
        Ok(image) => {
            CliIpcResponse::ok_with_data("ok", serde_json::to_value(image).unwrap_or_default())
        }
        Err(e) => CliIpcResponse::err(e),
    }
}

pub async fn find_image_by_path(path: &str) -> CliIpcResponse {
    let storage = Storage::global();
    match storage.find_image_by_path(path) {
        Ok(image) => {
            CliIpcResponse::ok_with_data("ok", serde_json::to_value(image).unwrap_or_default())
        }
        Err(e) => CliIpcResponse::err(e),
    }
}

// TODO: 画廊按时间显示
#[allow(dead_code)]
pub async fn get_gallery_date_groups() -> CliIpcResponse {
    let storage = Storage::global();
    match storage.get_gallery_date_groups() {
        Ok(groups) => {
            CliIpcResponse::ok_with_data("ok", serde_json::to_value(groups).unwrap_or_default())
        }
        Err(e) => CliIpcResponse::err(e),
    }
}

pub async fn get_gallery_plugin_groups() -> CliIpcResponse {
    let storage = Storage::global();
    match storage.get_gallery_plugin_groups() {
        Ok(groups) => {
            CliIpcResponse::ok_with_data("ok", serde_json::to_value(groups).unwrap_or_default())
        }
        Err(e) => CliIpcResponse::err(e),
    }
}

pub async fn get_images_count_by_query(query: &serde_json::Value) -> CliIpcResponse {
    let storage = Storage::global();
    let q = match serde_json::from_value::<ImageQuery>(query.clone()) {
        Ok(v) => v,
        Err(e) => return CliIpcResponse::err(format!("Invalid query: {}", e)),
    };
    match storage.get_images_count_by_query(&q) {
        Ok(n) => CliIpcResponse::ok_with_data("ok", serde_json::to_value(n).unwrap_or_default()),
        Err(e) => CliIpcResponse::err(e),
    }
}

pub async fn get_images_range_by_query(
    query: &serde_json::Value,
    offset: usize,
    limit: usize,
) -> CliIpcResponse {
    let storage = Storage::global();
    let q = match serde_json::from_value::<ImageQuery>(query.clone()) {
        Ok(v) => v,
        Err(e) => return CliIpcResponse::err(format!("Invalid query: {}", e)),
    };
    match storage.get_images_info_range_by_query(&q, offset, limit) {
        Ok(images) => {
            CliIpcResponse::ok_with_data("ok", serde_json::to_value(images).unwrap_or_default())
        }
        Err(e) => CliIpcResponse::err(e),
    }
}

pub async fn delete_image(image_id: &str) -> CliIpcResponse {
    match delete_images_with_events(&[image_id.to_string()], true) {
        Ok(()) => CliIpcResponse::ok("deleted"),
        Err(e) => CliIpcResponse::err(e),
    }
}

pub async fn remove_image(image_id: &str) -> CliIpcResponse {
    match delete_images_with_events(&[image_id.to_string()], false) {
        Ok(()) => CliIpcResponse::ok("removed"),
        Err(e) => CliIpcResponse::err(e),
    }
}

pub async fn batch_delete_images(image_ids: &[String]) -> CliIpcResponse {
    match delete_images_with_events(image_ids, true) {
        Ok(()) => CliIpcResponse::ok("deleted"),
        Err(e) => CliIpcResponse::err(e),
    }
}

pub async fn batch_remove_images(image_ids: &[String]) -> CliIpcResponse {
    match delete_images_with_events(image_ids, false) {
        Ok(()) => CliIpcResponse::ok("removed"),
        Err(e) => CliIpcResponse::err(e),
    }
}

pub async fn toggle_image_favorite(image_id: &str, favorite: bool) -> CliIpcResponse {
    match toggle_image_favorite_with_event(image_id, favorite) {
        Ok(()) => CliIpcResponse::ok("ok"),
        Err(e) => CliIpcResponse::err(e),
    }
}
