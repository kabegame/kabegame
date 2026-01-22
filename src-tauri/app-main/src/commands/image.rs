// Image 相关命令

use kabegame_core::settings::Settings;
use kabegame_core::storage::{Storage, FAVORITE_ALBUM_ID};
#[cfg(feature = "virtual-driver")]
use kabegame_core::virtual_driver::driver_service::VirtualDriveServiceTrait;
#[cfg(feature = "virtual-driver")]
use kabegame_core::virtual_driver::VirtualDriveService;
use tauri::AppHandle;

#[tauri::command]
pub async fn get_images_count() -> Result<usize, String> {
    Storage::global().get_total_count()
}

#[tauri::command]
pub async fn delete_image(image_id: String) -> Result<(), String> {
    Storage::global().delete_image(&image_id)?;

    let current_id = Settings::global()
        .get_current_wallpaper_image_id()
        .await
        .ok()
        .flatten();
    if current_id.as_deref() == Some(image_id.as_str()) {
        let _ = Settings::global()
            .set_current_wallpaper_image_id(None)
            .await;
    }
    Ok(())
}

#[tauri::command]
pub async fn remove_image(image_id: String) -> Result<(), String> {
    Storage::global().remove_image(&image_id)?;

    let current_id = Settings::global()
        .get_current_wallpaper_image_id()
        .await
        .ok()
        .flatten();
    if current_id.as_deref() == Some(image_id.as_str()) {
        let _ = Settings::global()
            .set_current_wallpaper_image_id(None)
            .await;
    }
    Ok(())
}

#[tauri::command]
pub async fn batch_delete_images(image_ids: Vec<String>) -> Result<(), String> {
    Storage::global().batch_delete_images(&image_ids)?;

    let current_id = Settings::global()
        .get_current_wallpaper_image_id()
        .await
        .ok()
        .flatten();
    if let Some(cur) = current_id.as_deref() {
        if image_ids.iter().any(|id| id == cur) {
            let _ = Settings::global()
                .set_current_wallpaper_image_id(None)
                .await;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn batch_remove_images(image_ids: Vec<String>) -> Result<(), String> {
    Storage::global().batch_remove_images(&image_ids)?;

    let current_id = Settings::global()
        .get_current_wallpaper_image_id()
        .await
        .ok()
        .flatten();
    if let Some(cur) = current_id.as_deref() {
        if image_ids.iter().any(|id| id == cur) {
            let _ = Settings::global()
                .set_current_wallpaper_image_id(None)
                .await;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn toggle_image_favorite(
    _app: AppHandle,
    image_id: String,
    favorite: bool,
) -> Result<(), String> {
    Storage::global().toggle_image_favorite(&image_id, favorite)?;

    #[cfg(feature = "virtual-driver")]
    VirtualDriveService::global().notify_album_dir_changed(Storage::global(), FAVORITE_ALBUM_ID);
    Ok(())
}

#[tauri::command]
pub async fn get_image_local_path_by_id(image_id: String) -> Result<Option<String>, String> {
    let img = Storage::global().find_image_by_id(&image_id)?;
    Ok(img.map(|i| i.local_path))
}
