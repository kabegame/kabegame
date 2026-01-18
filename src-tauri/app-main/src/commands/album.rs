// Album 相关命令

use crate::daemon_client;
use tauri::{AppHandle, Emitter};
#[cfg(all(feature = "virtual-drive", target_os = "windows"))]
use crate::storage::Storage;
#[cfg(all(feature = "virtual-drive", target_os = "windows"))]
use crate::virtual_drive::VirtualDriveService;

#[tauri::command]
#[cfg(not(all(feature = "virtual-drive", target_os = "windows")))]
pub async fn rename_album(
    _app: AppHandle,
    album_id: String,
    new_name: String,
) -> Result<(), String> {
    daemon_client::get_ipc_client()
        .storage_rename_album(album_id, new_name)
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))
}

#[tauri::command]
#[cfg(all(feature = "virtual-drive", target_os = "windows"))]
pub async fn rename_album(
    _app: AppHandle,
    album_id: String,
    new_name: String,
    drive: tauri::State<VirtualDriveService>,
) -> Result<(), String> {
    daemon_client::get_ipc_client()
        .storage_rename_album(album_id, new_name)
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))?;
    drive.bump_albums();
    Ok(())
}

#[tauri::command]
#[cfg(not(all(feature = "virtual-drive", target_os = "windows")))]
pub async fn add_images_to_album(
    app: AppHandle,
    album_id: String,
    image_ids: Vec<String>,
) -> Result<serde_json::Value, String> {
    let r = daemon_client::get_ipc_client()
        .storage_add_images_to_album(album_id.clone(), image_ids.clone())
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))?;
    let _ = app.emit(
        "images-change",
        serde_json::json!({
            "reason": "album-add",
            "albumId": album_id,
            "imageIds": image_ids
        }),
    );
    Ok(r)
}

#[tauri::command]
#[cfg(not(all(feature = "virtual-drive", target_os = "windows")))]
pub async fn remove_images_from_album(
    app: AppHandle,
    album_id: String,
    image_ids: Vec<String>,
) -> Result<usize, String> {
    let v = daemon_client::get_ipc_client()
        .storage_remove_images_from_album(album_id.clone(), image_ids.clone())
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))?;
    let removed = v.as_u64().unwrap_or(0) as usize;
    let _ = app.emit(
        "images-change",
        serde_json::json!({
            "reason": "album-remove",
            "albumId": album_id,
            "imageIds": image_ids
        }),
    );
    Ok(removed)
}

#[tauri::command]
#[cfg(all(feature = "virtual-drive", target_os = "windows"))]
pub async fn add_images_to_album(
    app: AppHandle,
    album_id: String,
    image_ids: Vec<String>,
    state: tauri::State<Storage>,
    drive: tauri::State<VirtualDriveService>,
) -> Result<serde_json::Value, String> {
    let r = daemon_client::get_ipc_client()
        .storage_add_images_to_album(album_id.clone(), image_ids.clone())
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))?;
    let _ = app.emit(
        "images-change",
        serde_json::json!({
            "reason": "album-add",
            "albumId": album_id,
            "imageIds": image_ids
        }),
    );
    drive.notify_album_dir_changed(state.inner(), &album_id);
    Ok(r)
}

#[tauri::command]
#[cfg(all(feature = "virtual-drive", target_os = "windows"))]
pub async fn remove_images_from_album(
    app: AppHandle,
    album_id: String,
    image_ids: Vec<String>,
    state: tauri::State<Storage>,
    drive: tauri::State<VirtualDriveService>,
) -> Result<usize, String> {
    let v = daemon_client::get_ipc_client()
        .storage_remove_images_from_album(album_id.clone(), image_ids.clone())
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))?;
    let removed = v.as_u64().unwrap_or(0) as usize;
    let _ = app.emit(
        "images-change",
        serde_json::json!({
            "reason": "album-remove",
            "albumId": album_id,
            "imageIds": image_ids
        }),
    );
    drive.notify_album_dir_changed(state.inner(), &album_id);
    Ok(removed)
}

#[tauri::command]
pub async fn get_album_images(album_id: String) -> Result<serde_json::Value, String> {
    daemon_client::get_ipc_client()
        .storage_get_album_images(album_id)
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))
}

#[tauri::command]
pub async fn get_album_image_ids(album_id: String) -> Result<Vec<String>, String> {
    daemon_client::get_ipc_client()
        .storage_get_album_image_ids(album_id)
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))
}

#[tauri::command]
pub async fn get_album_preview(album_id: String, limit: usize) -> Result<serde_json::Value, String> {
    daemon_client::get_ipc_client()
        .storage_get_album_preview(album_id, limit)
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))
}

#[tauri::command]
pub async fn get_album_counts() -> Result<serde_json::Value, String> {
    daemon_client::get_ipc_client()
        .storage_get_album_counts()
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))
}

#[tauri::command]
pub async fn update_album_images_order(
    album_id: String,
    image_orders: Vec<(String, i64)>,
) -> Result<(), String> {
    daemon_client::get_ipc_client()
        .storage_update_album_images_order(album_id, image_orders)
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))
}
