// Album 相关命令

use kabegame_core::settings::Settings;
use kabegame_core::storage::image_events::{
    add_images_to_album_with_event, remove_images_from_album_with_event,
};
use kabegame_core::storage::Storage;
#[cfg(feature = "standard")]
use kabegame_core::virtual_driver::driver_service::VirtualDriveServiceTrait;
#[cfg(feature = "standard")]
use kabegame_core::virtual_driver::VirtualDriveService;
use tauri::AppHandle;

#[tauri::command]
pub async fn get_albums() -> Result<serde_json::Value, String> {
    let albums = Storage::global().list_all_albums()?;
    Ok(serde_json::to_value(albums).map_err(|e| e.to_string())?)
}

#[tauri::command]
pub async fn add_album(
    _app: AppHandle,
    name: String,
    parent_id: Option<String>,
) -> Result<serde_json::Value, String> {
    let album = Storage::global().add_album(&name, parent_id.as_deref())?;
    Ok(serde_json::to_value(album).map_err(|e| e.to_string())?)
}

#[tauri::command]
pub async fn delete_album(_app: AppHandle, album_id: String) -> Result<(), String> {
    Storage::global().delete_album(&album_id)?;
    // 轮播画册没有了，回到画廊。这里前端会提示，所以不用报错
    if let Some(id) = Settings::global().get_wallpaper_rotation_album_id() {
        if id == album_id {
            Settings::global().set_wallpaper_rotation_album_id(None)?;
        }
    }
    #[cfg(feature = "standard")]
    VirtualDriveService::global().bump_albums();
    Ok(())
}

#[tauri::command]
pub async fn rename_album(
    _app: AppHandle,
    album_id: String,
    new_name: String,
) -> Result<(), String> {
    Storage::global().rename_album(&album_id, &new_name)?;
    #[cfg(feature = "standard")]
    VirtualDriveService::global().bump_albums();
    Ok(())
}

#[tauri::command]
pub async fn move_album(
    _app: AppHandle,
    album_id: String,
    new_parent_id: Option<String>,
) -> Result<(), String> {
    Storage::global().move_album(&album_id, new_parent_id.as_deref())?;
    #[cfg(feature = "standard")]
    VirtualDriveService::global().bump_albums();
    Ok(())
}

#[tauri::command]
pub async fn add_images_to_album(
    _app: AppHandle,
    album_id: String,
    image_ids: Vec<String>,
) -> Result<serde_json::Value, String> {
    let r = add_images_to_album_with_event(&album_id, &image_ids)?;
    #[cfg(feature = "standard")]
    VirtualDriveService::global().notify_album_dir_changed(&album_id);

    Ok(serde_json::to_value(r).map_err(|e| e.to_string())?)
}

/// 将任务的全部图片加入画册（后端根据 task_id 取图，前端只负责选画册）
#[tauri::command]
pub async fn add_task_images_to_album(
    _app: AppHandle,
    task_id: String,
    album_id: String,
) -> Result<serde_json::Value, String> {
    let image_ids = Storage::global().get_task_image_ids(&task_id)?;
    if image_ids.is_empty() {
        return Ok(serde_json::to_value(serde_json::json!({
            "added": 0,
            "attempted": 0,
            "canAdd": 0,
            "currentCount": 0
        }))
        .map_err(|e| e.to_string())?);
    }
    let r = add_images_to_album_with_event(&album_id, &image_ids)?;
    #[cfg(feature = "standard")]
    VirtualDriveService::global().notify_album_dir_changed(&album_id);

    Ok(serde_json::to_value(r).map_err(|e| e.to_string())?)
}

#[tauri::command]
pub async fn remove_images_from_album(
    _app: AppHandle,
    album_id: String,
    image_ids: Vec<String>,
) -> Result<usize, String> {
    let removed = remove_images_from_album_with_event(&album_id, &image_ids)?;
    #[cfg(feature = "standard")]
    VirtualDriveService::global().notify_album_dir_changed(&album_id);

    Ok(removed)
}

#[tauri::command]
pub async fn get_album_image_ids(album_id: String) -> Result<Vec<String>, String> {
    Storage::global().get_album_image_ids(&album_id)
}

#[tauri::command]
pub async fn get_album_preview(
    album_id: String,
    limit: usize,
) -> Result<serde_json::Value, String> {
    let images = Storage::global().get_album_preview(&album_id, limit)?;
    Ok(serde_json::to_value(images).map_err(|e| e.to_string())?)
}

#[tauri::command]
pub async fn get_album_counts() -> Result<serde_json::Value, String> {
    let counts = Storage::global().get_album_counts()?;
    Ok(serde_json::to_value(counts).map_err(|e| e.to_string())?)
}

#[tauri::command]
pub async fn update_album_images_order(
    album_id: String,
    image_orders: Vec<(String, i64)>,
) -> Result<(), String> {
    Storage::global().update_album_images_order(&album_id, &image_orders)
}
