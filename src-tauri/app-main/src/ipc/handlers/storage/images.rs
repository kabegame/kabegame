//! Images 陦ｨ逶ｸ蜈ｳ謫堺ｽ・
use kabegame_core::ipc::events::DaemonEvent;
use kabegame_core::ipc::ipc::CliIpcResponse;
use kabegame_core::ipc::server::EventBroadcaster;
use kabegame_core::storage::gallery::ImageQuery;
use kabegame_core::storage::Storage;
use kabegame_core::storage::FAVORITE_ALBUM_ID;
use std::sync::Arc;

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
    let storage = Storage::global();
    match storage.delete_image(image_id) {
        Ok(()) => {
            EventBroadcaster::global().broadcast(Arc::new(DaemonEvent::Generic {
                event: "images-change".to_string(),
                payload: serde_json::json!({
                    "reason": "delete",
                    "imageIds": [image_id],
                }),
            }));
            CliIpcResponse::ok("deleted")
        }
        Err(e) => CliIpcResponse::err(e),
    }
}

pub async fn remove_image(image_id: &str) -> CliIpcResponse {
    let storage = Storage::global();
    match storage.remove_image(image_id) {
        Ok(()) => {
            EventBroadcaster::global().broadcast(Arc::new(DaemonEvent::ImagesChange {
                reason: "remove".to_string(),
                image_ids: vec![image_id.to_string()],
            }));
            CliIpcResponse::ok("removed")
        }
        Err(e) => CliIpcResponse::err(e),
    }
}

pub async fn batch_delete_images(
    image_ids: &[String],
) -> CliIpcResponse {
    let storage = Storage::global();
    match storage.batch_delete_images(image_ids) {
        Ok(()) => {
            EventBroadcaster::global().broadcast(Arc::new(DaemonEvent::ImagesChange {
                reason: "delete".to_string(),
                image_ids: image_ids.to_vec(),
            }));
            CliIpcResponse::ok("deleted")
        }
        Err(e) => CliIpcResponse::err(e),
    }
}

pub async fn batch_remove_images(
    image_ids: &[String],
) -> CliIpcResponse {
    let storage = Storage::global();
    match storage.batch_remove_images(image_ids) {
        Ok(()) => {
            EventBroadcaster::global().broadcast(Arc::new(DaemonEvent::ImagesChange {
                reason: "remove".to_string(),
                image_ids: image_ids.to_vec(),
            }));
            CliIpcResponse::ok("removed")
        }
        Err(e) => CliIpcResponse::err(e),
    }
}

pub async fn toggle_image_favorite(
    image_id: &str,
    favorite: bool,
) -> CliIpcResponse {
    let storage = Storage::global();
    match storage.toggle_image_favorite(image_id, favorite) {
        Ok(()) => {
            // 扈滉ｸ蝗ｾ迚・序譖ｴ莠倶ｻｶ・壽噺阯・蜿匁ｶ域噺阯丈ｼ壼ｽｱ蜩・Gallery 逧・favorite 蟄玲ｮｵ + 謾ｶ阯冗判蜀悟・螳ｹ
            EventBroadcaster::global().broadcast(Arc::new(DaemonEvent::Generic {
                event: "images-change".to_string(),
                payload: serde_json::json!({
                    "reason": if favorite { "favorite-add" } else { "favorite-remove" },
                    "albumId": FAVORITE_ALBUM_ID,
                    "imageIds": [image_id],
                }),
            }));
            CliIpcResponse::ok("ok")
        }
        Err(e) => CliIpcResponse::err(e),
    }
}
