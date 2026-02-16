// Album 相关命令

use kabegame_core::emitter::GlobalEmitter;
use kabegame_core::settings::Settings;
use kabegame_core::storage::Storage;
#[cfg(all(not(kabegame_mode = "light"), not(target_os = "android")))]
use kabegame_core::virtual_driver::driver_service::VirtualDriveServiceTrait;
#[cfg(all(not(kabegame_mode = "light"), not(target_os = "android")))]
use kabegame_core::virtual_driver::VirtualDriveService;
use serde_json::json;
use tauri::AppHandle;

#[tauri::command]
pub async fn get_albums() -> Result<serde_json::Value, String> {
    let albums = Storage::global().get_albums()?;
    Ok(serde_json::to_value(albums).map_err(|e| e.to_string())?)
}

#[tauri::command]
pub async fn add_album(_app: AppHandle, name: String) -> Result<serde_json::Value, String> {
    let album = Storage::global().add_album(&name)?;
    Ok(serde_json::to_value(album).map_err(|e| e.to_string())?)
}

#[tauri::command]
pub async fn delete_album(_app: AppHandle, album_id: String) -> Result<(), String> {
    Storage::global().delete_album(&album_id)?;
    // 轮播画册没有了，回到画廊。这里前端会提示，所以不用报错
    if let Ok(Some(id)) = Settings::global().get_wallpaper_rotation_album_id().await {
        if id == album_id {
            Settings::global()
                .set_wallpaper_rotation_album_id(None)
                .await?;
        }
    }
    #[cfg(all(not(kabegame_mode = "light"), not(target_os = "android")))]
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
    #[cfg(all(not(kabegame_mode = "light"), not(target_os = "android")))]
    VirtualDriveService::global().bump_albums();
    Ok(())
}

#[tauri::command]
pub async fn add_images_to_album(
    _app: AppHandle,
    album_id: String,
    image_ids: Vec<String>,
) -> Result<serde_json::Value, String> {
    let r = Storage::global().add_images_to_album(&album_id, &image_ids)?;
    #[cfg(all(not(kabegame_mode = "light"), not(target_os = "android")))]
    VirtualDriveService::global().notify_album_dir_changed(&album_id);

    GlobalEmitter::global().emit(
        "images-change",
        json!({
            "reason": "add",
            "albumId": album_id,
            "imageIds": image_ids
        }),
    );

    Ok(serde_json::to_value(r).map_err(|e| e.to_string())?)
}

#[tauri::command]
pub async fn remove_images_from_album(
    _app: AppHandle,
    album_id: String,
    image_ids: Vec<String>,
) -> Result<usize, String> {
    let removed = Storage::global().remove_images_from_album(&album_id, &image_ids)?;
    #[cfg(all(not(kabegame_mode = "light"), not(target_os = "android")))]
    VirtualDriveService::global().notify_album_dir_changed(&album_id);

    GlobalEmitter::global().emit(
        "images-change",
        json!({
            "reason": "remove",
            "albumId": album_id,
            "imageIds": image_ids
        }),
    );

    Ok(removed)
}

#[tauri::command]
pub async fn get_album_images(album_id: String) -> Result<serde_json::Value, String> {
    let images = Storage::global().get_album_images(&album_id)?;
    Ok(serde_json::to_value(images).map_err(|e| e.to_string())?)
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
