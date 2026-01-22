// Album 相关命令

use crate::daemon_client;
#[cfg(all(feature = "virtual-driver", feature = "self-hosted"))]
use crate::storage::Storage;
#[cfg(all(feature = "virtual-driver", feature = "self-hosted"))]
use crate::virtual_driver::VirtualDriveService;
use tauri::AppHandle;

#[tauri::command]
#[cfg(not(feature = "self-hosted"))]
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
#[cfg(feature = "self-hosted")]
pub async fn rename_album(
    _app: AppHandle,
    album_id: String,
    new_name: String,
) -> Result<(), String> {
    daemon_client::get_ipc_client()
        .storage_rename_album(album_id, new_name)
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))?;
    #[cfg(feature = "virtual-driver")]
    VirtualDriveService::global().bump_albums();
    Ok(())
}

#[tauri::command]
#[cfg(not(feature = "self-hosted"))]
pub async fn add_images_to_album(
    _app: AppHandle,
    album_id: String,
    image_ids: Vec<String>,
) -> Result<serde_json::Value, String> {
    daemon_client::get_ipc_client()
        .storage_add_images_to_album(album_id, image_ids)
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))
}

#[tauri::command]
#[cfg(feature = "self-hosted")]
pub async fn add_images_to_album(
    _app: AppHandle,
    album_id: String,
    image_ids: Vec<String>,
) -> Result<serde_json::Value, String> {
    let r = daemon_client::get_ipc_client()
        .storage_add_images_to_album(album_id.clone(), image_ids)
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))?;
    #[cfg(feature = "virtual-driver")]
    VirtualDriveService::global().notify_album_dir_changed(Storage::global(), &album_id);
    Ok(r)
}

#[tauri::command]
#[cfg(not(feature = "self-hosted"))]
pub async fn remove_images_from_album(
    _app: AppHandle,
    album_id: String,
    image_ids: Vec<String>,
) -> Result<usize, String> {
    let v = daemon_client::get_ipc_client()
        .storage_remove_images_from_album(album_id, image_ids)
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))?;
    Ok(v.as_u64().unwrap_or(0) as usize)
}

#[tauri::command]
#[cfg(feature = "self-hosted")]
pub async fn remove_images_from_album(
    _app: AppHandle,
    album_id: String,
    image_ids: Vec<String>,
) -> Result<usize, String> {
    let v = daemon_client::get_ipc_client()
        .storage_remove_images_from_album(album_id.clone(), image_ids)
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))?;
    let removed = v.as_u64().unwrap_or(0) as usize;
    #[cfg(feature = "virtual-driver")]
    VirtualDriveService::global().notify_album_dir_changed(Storage::global(), &album_id);
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
pub async fn get_album_preview(
    album_id: String,
    limit: usize,
) -> Result<serde_json::Value, String> {
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
