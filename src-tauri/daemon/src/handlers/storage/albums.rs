//! Albums 表相关操作

use kabegame_core::ipc::ipc::CliIpcResponse;
use kabegame_core::storage::Storage;
use std::sync::Arc;

pub async fn get_albums(storage: Arc<Storage>) -> CliIpcResponse {
    match storage.get_albums() {
        Ok(albums) => CliIpcResponse::ok_with_data(
            "ok",
            serde_json::to_value(albums).unwrap_or_default(),
        ),
        Err(e) => CliIpcResponse::err(e),
    }
}

pub async fn add_album(storage: Arc<Storage>, name: &str) -> CliIpcResponse {
    match storage.add_album(name) {
        Ok(album) => {
            CliIpcResponse::ok_with_data("created", serde_json::to_value(album).unwrap_or_default())
        }
        Err(e) => CliIpcResponse::err(e),
    }
}

pub async fn delete_album(storage: Arc<Storage>, album_id: &str) -> CliIpcResponse {
    match storage.delete_album(album_id) {
        Ok(()) => CliIpcResponse::ok("deleted"),
        Err(e) => CliIpcResponse::err(e),
    }
}

pub async fn rename_album(storage: Arc<Storage>, album_id: &str, new_name: &str) -> CliIpcResponse {
    match storage.rename_album(album_id, new_name) {
        Ok(()) => CliIpcResponse::ok("renamed"),
        Err(e) => CliIpcResponse::err(e),
    }
}

pub async fn add_images_to_album(
    storage: Arc<Storage>,
    album_id: &str,
    image_ids: &[String],
) -> CliIpcResponse {
    match storage.add_images_to_album(album_id, image_ids) {
        Ok(result) => {
            CliIpcResponse::ok_with_data("ok", serde_json::to_value(result).unwrap_or_default())
        }
        Err(e) => CliIpcResponse::err(e),
    }
}

pub async fn remove_images_from_album(
    storage: Arc<Storage>,
    album_id: &str,
    image_ids: &[String],
) -> CliIpcResponse {
    match storage.remove_images_from_album(album_id, image_ids) {
        Ok(removed) => CliIpcResponse::ok_with_data(
            "ok",
            serde_json::to_value(removed).unwrap_or_default(),
        ),
        Err(e) => CliIpcResponse::err(e),
    }
}

pub async fn get_album_images(storage: Arc<Storage>, album_id: &str) -> CliIpcResponse {
    match storage.get_album_images(album_id) {
        Ok(images) => CliIpcResponse::ok_with_data(
            "ok",
            serde_json::to_value(images).unwrap_or_default(),
        ),
        Err(e) => CliIpcResponse::err(e),
    }
}

pub async fn get_album_preview(storage: Arc<Storage>, album_id: &str, limit: usize) -> CliIpcResponse {
    match storage.get_album_preview(album_id, limit) {
        Ok(images) => CliIpcResponse::ok_with_data(
            "ok",
            serde_json::to_value(images).unwrap_or_default(),
        ),
        Err(e) => CliIpcResponse::err(e),
    }
}

pub async fn get_album_counts(storage: Arc<Storage>) -> CliIpcResponse {
    match storage.get_album_counts() {
        Ok(m) => CliIpcResponse::ok_with_data("ok", serde_json::to_value(m).unwrap_or_default()),
        Err(e) => CliIpcResponse::err(e),
    }
}

pub async fn update_album_images_order(
    storage: Arc<Storage>,
    album_id: &str,
    image_orders: &[(String, i64)],
) -> CliIpcResponse {
    match storage.update_album_images_order(album_id, image_orders) {
        Ok(()) => CliIpcResponse::ok("ok"),
        Err(e) => CliIpcResponse::err(e),
    }
}

pub async fn get_album_image_ids(storage: Arc<Storage>, album_id: &str) -> CliIpcResponse {
    match storage.get_album_image_ids(album_id) {
        Ok(ids) => {
            CliIpcResponse::ok_with_data("ok", serde_json::to_value(ids).unwrap_or_default())
        }
        Err(e) => CliIpcResponse::err(e),
    }
}
