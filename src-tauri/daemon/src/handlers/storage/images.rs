//! Images 表相关操作

use kabegame_core::ipc::events::DaemonEvent;
use kabegame_core::ipc::ipc::CliIpcResponse;
use kabegame_core::ipc::EventBroadcaster;
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

pub async fn get_images_paginated(
    page: usize,
    page_size: usize,
) -> CliIpcResponse {
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

pub async fn get_images_count_by_query(
    query: &serde_json::Value,
) -> CliIpcResponse {
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

pub async fn delete_image(
    broadcaster: Arc<EventBroadcaster>,
    image_id: &str,
) -> CliIpcResponse {
    let storage = Storage::global();
    match storage.delete_image(image_id) {
        Ok(()) => {
            // 统一图片变更事件：供前端刷新当前 provider 视图
            let _ = broadcaster
                .broadcast(DaemonEvent::Generic {
                    event: "images-change".to_string(),
                    payload: serde_json::json!({
                        "reason": "delete",
                        "imageIds": [image_id],
                    }),
                })
                .await;
            CliIpcResponse::ok("deleted")
        }
        Err(e) => CliIpcResponse::err(e),
    }
}

pub async fn remove_image(
    broadcaster: Arc<EventBroadcaster>,
    image_id: &str,
) -> CliIpcResponse {
    let storage = Storage::global();
    match storage.remove_image(image_id) {
        Ok(()) => {
            let _ = broadcaster
                .broadcast(DaemonEvent::ImagesChange {
                    reason: "remove".to_string(),
                    image_ids: vec![image_id.to_string()],
                })
                .await;
            CliIpcResponse::ok("removed")
        }
        Err(e) => CliIpcResponse::err(e),
    }
}

pub async fn batch_delete_images(
    broadcaster: Arc<EventBroadcaster>,
    image_ids: &[String],
) -> CliIpcResponse {
    let storage = Storage::global();
    match storage.batch_delete_images(image_ids) {
        Ok(()) => {
            let _ = broadcaster
                .broadcast(DaemonEvent::ImagesChange {
                    reason: "delete".to_string(),
                    image_ids: image_ids.to_vec(),
                })
                .await;
            CliIpcResponse::ok("deleted")
        }
        Err(e) => CliIpcResponse::err(e),
    }
}

pub async fn batch_remove_images(
    broadcaster: Arc<EventBroadcaster>,
    image_ids: &[String],
) -> CliIpcResponse {
    let storage = Storage::global();
    match storage.batch_remove_images(image_ids) {
        Ok(()) => {
            let _ = broadcaster
                .broadcast(DaemonEvent::ImagesChange {
                    reason: "remove".to_string(),
                    image_ids: image_ids.to_vec(),
                })
                .await;
            CliIpcResponse::ok("removed")
        }
        Err(e) => CliIpcResponse::err(e),
    }
}

pub async fn toggle_image_favorite(
    broadcaster: Arc<EventBroadcaster>,
    image_id: &str,
    favorite: bool,
) -> CliIpcResponse {
    let storage = Storage::global();
    match storage.toggle_image_favorite(image_id, favorite) {
        Ok(()) => {
            // 统一图片变更事件：收藏/取消收藏会影响 Gallery 的 favorite 字段 + 收藏画册内容
            let _ = broadcaster
                .broadcast(DaemonEvent::Generic {
                    event: "images-change".to_string(),
                    payload: serde_json::json!({
                        "reason": if favorite { "favorite-add" } else { "favorite-remove" },
                        "albumId": FAVORITE_ALBUM_ID,
                        "imageIds": [image_id],
                    }),
                })
                .await;
            CliIpcResponse::ok("ok")
        }
        Err(e) => CliIpcResponse::err(e),
    }
}
