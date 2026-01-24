// Image 相关命令

use kabegame_core::emitter::GlobalEmitter;
use kabegame_core::providers::ProviderRuntime;
use kabegame_core::settings::Settings;
use kabegame_core::storage::{Storage, FAVORITE_ALBUM_ID};
#[cfg(not(kabegame_mode = "light"))]
use kabegame_core::virtual_driver::driver_service::VirtualDriveServiceTrait;
#[cfg(not(kabegame_mode = "light"))]
use kabegame_core::virtual_driver::VirtualDriveService;
use serde_json::json;
use tauri::AppHandle;

#[tauri::command]
pub async fn get_images_range(offset: usize, limit: usize) -> Result<serde_json::Value, String> {
    let result = Storage::global().get_images_range(offset, limit)?;
    Ok(serde_json::to_value(result).map_err(|e| e.to_string())?)
}

#[tauri::command]
pub async fn browse_gallery_provider(path: String) -> Result<serde_json::Value, String> {
    let storage = Storage::global();
    let provider_rt = ProviderRuntime::global();
    let result = kabegame_core::gallery::browse_gallery_provider(storage, provider_rt, &path)?;
    Ok(serde_json::to_value(result).map_err(|e| e.to_string())?)
}

#[tauri::command]
pub async fn get_image_by_id(image_id: String) -> Result<serde_json::Value, String> {
    let image = Storage::global().find_image_by_id(&image_id)?;
    Ok(serde_json::to_value(image).map_err(|e| e.to_string())?)
}

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

    GlobalEmitter::global().emit(
        "images-change",
        json!({
            "reason": "delete",
            "imageIds": [image_id]
        }),
    );

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

    GlobalEmitter::global().emit(
        "images-change",
        json!({
            "reason": "remove",
            "imageIds": [image_id]
        }),
    );

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

    GlobalEmitter::global().emit(
        "images-change",
        json!({
            "reason": "delete",
            "imageIds": image_ids
        }),
    );

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

    GlobalEmitter::global().emit(
        "images-change",
        json!({
            "reason": "remove",
            "imageIds": image_ids
        }),
    );

    Ok(())
}

#[tauri::command]
pub async fn toggle_image_favorite(
    _app: AppHandle,
    image_id: String,
    favorite: bool,
) -> Result<(), String> {
    Storage::global().toggle_image_favorite(&image_id, favorite)?;

    #[cfg(not(kabegame_mode = "light"))]
    VirtualDriveService::global().notify_album_dir_changed(FAVORITE_ALBUM_ID);
    Ok(())
}

// #[tauri::command]
// pub async fn get_image_local_path_by_id(image_id: String) -> Result<Option<String>, String> {
//     let img = Storage::global().find_image_by_id(&image_id)?;
//     Ok(img.map(|i| i.local_path))
// }
