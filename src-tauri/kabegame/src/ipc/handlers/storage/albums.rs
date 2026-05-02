//! Albums 相关代码
use kabegame_core::ipc::ipc::IpcResponse;
use kabegame_core::storage::Storage;

pub async fn get_albums() -> IpcResponse {
    let storage = Storage::global();
    match storage.list_all_albums() {
        Ok(albums) => {
            IpcResponse::ok_with_data("ok", serde_json::to_value(albums).unwrap_or_default())
        }
        Err(e) => IpcResponse::err(e),
    }
}

pub async fn add_album(name: &str) -> IpcResponse {
    let storage = Storage::global();
    match storage.add_album(name, None) {
        Ok(album) => {
            IpcResponse::ok_with_data("created", serde_json::to_value(album).unwrap_or_default())
        }
        Err(e) => IpcResponse::err(e),
    }
}

pub async fn delete_album(album_id: &str) -> IpcResponse {
    let storage = Storage::global();
    match storage.delete_album(album_id) {
        Ok(()) => IpcResponse::ok("deleted"),
        Err(e) => IpcResponse::err(e),
    }
}

pub async fn rename_album(album_id: &str, new_name: &str) -> IpcResponse {
    let storage = Storage::global();
    match storage.rename_album(album_id, new_name) {
        Ok(()) => IpcResponse::ok("renamed"),
        Err(e) => IpcResponse::err(e),
    }
}

pub async fn add_images_to_album(album_id: &str, image_ids: &[String]) -> IpcResponse {
    let storage = Storage::global();
    match storage.add_images_to_album(album_id, image_ids) {
        Ok(result) => {
            IpcResponse::ok_with_data("ok", serde_json::to_value(result).unwrap_or_default())
        }
        Err(e) => IpcResponse::err(e),
    }
}

pub async fn remove_images_from_album(album_id: &str, image_ids: &[String]) -> IpcResponse {
    let storage = Storage::global();
    match storage.remove_images_from_album(album_id, image_ids) {
        Ok(removed) => {
            IpcResponse::ok_with_data("ok", serde_json::to_value(removed).unwrap_or_default())
        }
        Err(e) => IpcResponse::err(e),
    }
}

pub async fn get_album_images(album_id: &str) -> IpcResponse {
    let storage = Storage::global();
    match storage.get_album_images(album_id) {
        Ok(images) => {
            IpcResponse::ok_with_data("ok", serde_json::to_value(images).unwrap_or_default())
        }
        Err(e) => IpcResponse::err(e),
    }
}

pub async fn get_album_preview(album_id: &str, limit: usize) -> IpcResponse {
    let storage = Storage::global();
    match storage.get_album_preview(album_id, limit) {
        Ok(images) => {
            IpcResponse::ok_with_data("ok", serde_json::to_value(images).unwrap_or_default())
        }
        Err(e) => IpcResponse::err(e),
    }
}

pub async fn get_album_counts() -> IpcResponse {
    let storage = Storage::global();
    match storage.get_album_counts() {
        Ok(m) => IpcResponse::ok_with_data("ok", serde_json::to_value(m).unwrap_or_default()),
        Err(e) => IpcResponse::err(e),
    }
}

pub async fn update_album_images_order(
    album_id: &str,
    image_orders: &[(String, i64)],
) -> IpcResponse {
    let storage = Storage::global();
    match storage.update_album_images_order(album_id, image_orders) {
        Ok(()) => IpcResponse::ok("ok"),
        Err(e) => IpcResponse::err(e),
    }
}

pub async fn get_album_image_ids(album_id: &str) -> IpcResponse {
    let storage = Storage::global();
    match storage.get_album_image_ids(album_id) {
        Ok(ids) => IpcResponse::ok_with_data("ok", serde_json::to_value(ids).unwrap_or_default()),
        Err(e) => IpcResponse::err(e),
    }
}
