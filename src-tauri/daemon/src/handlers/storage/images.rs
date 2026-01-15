//! Images 表相关操作

use kabegame_core::ipc::ipc::CliIpcResponse;
use kabegame_core::storage::Storage;
use kabegame_core::storage::gallery::ImageQuery;
use std::sync::Arc;

pub async fn get_images(storage: Arc<Storage>) -> CliIpcResponse {
    match storage.get_all_images() {
        Ok(images) => CliIpcResponse::ok_with_data(
            "ok",
            serde_json::to_value(images).unwrap_or_default(),
        ),
        Err(e) => CliIpcResponse::err(e),
    }
}

pub async fn get_images_paginated(
    storage: Arc<Storage>,
    page: usize,
    page_size: usize,
) -> CliIpcResponse {
    match storage.get_images_paginated(page, page_size) {
        Ok(result) => CliIpcResponse::ok_with_data(
            "ok",
            serde_json::to_value(result).unwrap_or_default(),
        ),
        Err(e) => CliIpcResponse::err(e),
    }
}

pub async fn get_images_count(storage: Arc<Storage>) -> CliIpcResponse {
    match storage.get_total_count() {
        Ok(count) => {
            CliIpcResponse::ok_with_data("ok", serde_json::to_value(count).unwrap_or_default())
        }
        Err(e) => CliIpcResponse::err(e),
    }
}

pub async fn get_image_by_id(storage: Arc<Storage>, image_id: &str) -> CliIpcResponse {
    match storage.find_image_by_id(image_id) {
        Ok(image) => {
            CliIpcResponse::ok_with_data("ok", serde_json::to_value(image).unwrap_or_default())
        }
        Err(e) => CliIpcResponse::err(e),
    }
}

pub async fn find_image_by_path(storage: Arc<Storage>, path: &str) -> CliIpcResponse {
    match storage.find_image_by_path(path) {
        Ok(image) => CliIpcResponse::ok_with_data(
            "ok",
            serde_json::to_value(image).unwrap_or_default(),
        ),
        Err(e) => CliIpcResponse::err(e),
    }
}

pub async fn get_gallery_date_groups(storage: Arc<Storage>) -> CliIpcResponse {
    match storage.get_gallery_date_groups() {
        Ok(groups) => CliIpcResponse::ok_with_data(
            "ok",
            serde_json::to_value(groups).unwrap_or_default(),
        ),
        Err(e) => CliIpcResponse::err(e),
    }
}

pub async fn get_gallery_plugin_groups(storage: Arc<Storage>) -> CliIpcResponse {
    match storage.get_gallery_plugin_groups() {
        Ok(groups) => CliIpcResponse::ok_with_data(
            "ok",
            serde_json::to_value(groups).unwrap_or_default(),
        ),
        Err(e) => CliIpcResponse::err(e),
    }
}

pub async fn get_images_count_by_query(storage: Arc<Storage>, query: &serde_json::Value) -> CliIpcResponse {
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
    storage: Arc<Storage>,
    query: &serde_json::Value,
    offset: usize,
    limit: usize,
) -> CliIpcResponse {
    let q = match serde_json::from_value::<ImageQuery>(query.clone()) {
        Ok(v) => v,
        Err(e) => return CliIpcResponse::err(format!("Invalid query: {}", e)),
    };
    match storage.get_images_info_range_by_query(&q, offset, limit) {
        Ok(images) => CliIpcResponse::ok_with_data(
            "ok",
            serde_json::to_value(images).unwrap_or_default(),
        ),
        Err(e) => CliIpcResponse::err(e),
    }
}

pub async fn delete_image(storage: Arc<Storage>, image_id: &str) -> CliIpcResponse {
    match storage.delete_image(image_id) {
        Ok(()) => CliIpcResponse::ok("deleted"),
        Err(e) => CliIpcResponse::err(e),
    }
}

pub async fn remove_image(storage: Arc<Storage>, image_id: &str) -> CliIpcResponse {
    match storage.remove_image(image_id) {
        Ok(()) => CliIpcResponse::ok("removed"),
        Err(e) => CliIpcResponse::err(e),
    }
}

pub async fn batch_delete_images(storage: Arc<Storage>, image_ids: &[String]) -> CliIpcResponse {
    match storage.batch_delete_images(image_ids) {
        Ok(()) => CliIpcResponse::ok("deleted"),
        Err(e) => CliIpcResponse::err(e),
    }
}

pub async fn batch_remove_images(storage: Arc<Storage>, image_ids: &[String]) -> CliIpcResponse {
    match storage.batch_remove_images(image_ids) {
        Ok(()) => CliIpcResponse::ok("removed"),
        Err(e) => CliIpcResponse::err(e),
    }
}

pub async fn toggle_image_favorite(
    storage: Arc<Storage>,
    image_id: &str,
    favorite: bool,
) -> CliIpcResponse {
    match storage.toggle_image_favorite(image_id, favorite) {
        Ok(()) => CliIpcResponse::ok("ok"),
        Err(e) => CliIpcResponse::err(e),
    }
}
