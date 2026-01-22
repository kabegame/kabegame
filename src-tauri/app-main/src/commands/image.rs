// Image 相关命令

use crate::daemon_client;
#[cfg(all(feature = "virtual-driver", feature = "self-hosted"))]
use crate::storage::Storage;
#[cfg(all(feature = "virtual-driver", feature = "self-hosted"))]
use crate::virtual_driver::VirtualDriveService;
use tauri::AppHandle;

#[tauri::command]
pub async fn get_images_count() -> Result<usize, String> {
    daemon_client::get_ipc_client()
        .storage_get_images_count()
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))
}

#[tauri::command]
pub async fn delete_image(image_id: String) -> Result<(), String> {
    daemon_client::get_ipc_client()
        .storage_delete_image(image_id.clone())
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))?;
    let current_id = daemon_client::get_ipc_client()
        .settings_get_current_wallpaper_image_id()
        .await
        .ok()
        .flatten();
    if current_id.as_deref() == Some(image_id.as_str()) {
        let _ = daemon_client::get_ipc_client()
            .settings_set_current_wallpaper_image_id(None)
            .await;
    }
    Ok(())
}

#[tauri::command]
pub async fn remove_image(image_id: String) -> Result<(), String> {
    daemon_client::get_ipc_client()
        .storage_remove_image(image_id.clone())
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))?;
    let current_id = daemon_client::get_ipc_client()
        .settings_get_current_wallpaper_image_id()
        .await
        .ok()
        .flatten();
    if current_id.as_deref() == Some(image_id.as_str()) {
        let _ = daemon_client::get_ipc_client()
            .settings_set_current_wallpaper_image_id(None)
            .await;
    }
    Ok(())
}

#[tauri::command]
pub async fn batch_delete_images(image_ids: Vec<String>) -> Result<(), String> {
    daemon_client::get_ipc_client()
        .storage_batch_delete_images(image_ids.clone())
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))?;
    let current_id = daemon_client::get_ipc_client()
        .settings_get_current_wallpaper_image_id()
        .await
        .ok()
        .flatten();
    if let Some(cur) = current_id.as_deref() {
        if image_ids.iter().any(|id| id == cur) {
            let _ = daemon_client::get_ipc_client()
                .settings_set_current_wallpaper_image_id(None)
                .await;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn batch_remove_images(image_ids: Vec<String>) -> Result<(), String> {
    daemon_client::get_ipc_client()
        .storage_batch_remove_images(image_ids.clone())
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))?;
    let current_id = daemon_client::get_ipc_client()
        .settings_get_current_wallpaper_image_id()
        .await
        .ok()
        .flatten();
    if let Some(cur) = current_id.as_deref() {
        if image_ids.iter().any(|id| id == cur) {
            let _ = daemon_client::get_ipc_client()
                .settings_set_current_wallpaper_image_id(None)
                .await;
        }
    }
    Ok(())
}

#[tauri::command]
#[cfg(not(all(feature = "virtual-driver", feature = "self-hosted")))]
pub async fn toggle_image_favorite(
    _app: AppHandle,
    image_id: String,
    favorite: bool,
) -> Result<(), String> {
    daemon_client::get_ipc_client()
        .storage_toggle_image_favorite(image_id, favorite)
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))
}

#[tauri::command]
#[cfg(all(feature = "virtual-driver", feature = "self-hosted"))]
pub async fn toggle_image_favorite(
    _app: AppHandle,
    image_id: String,
    favorite: bool,
) -> Result<(), String> {
    daemon_client::get_ipc_client()
        .storage_toggle_image_favorite(image_id.clone(), favorite)
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))?;

    VirtualDriveService::global()
        .notify_album_dir_changed(Storage::global(), "00000000-0000-0000-0000-000000000001");
    Ok(())
}

#[tauri::command]
pub async fn get_image_local_path_by_id(image_id: String) -> Result<Option<String>, String> {
    let v = daemon_client::get_ipc_client()
        .storage_get_image_by_id(image_id)
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))?;
    Ok(v.get("localPath")
        .and_then(|x| x.as_str())
        .map(|s| s.to_string()))
}
