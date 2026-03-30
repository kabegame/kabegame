// Image 相关命令

use kabegame_core::providers::ProviderRuntime;
use kabegame_core::settings::Settings;
use kabegame_core::storage::image_events::{
    delete_images_with_events, toggle_image_favorite_with_event,
};
use kabegame_core::storage::{Storage, FAVORITE_ALBUM_ID};
#[cfg(all(not(kabegame_mode = "light"), not(target_os = "android")))]
use kabegame_core::virtual_driver::driver_service::VirtualDriveServiceTrait;
#[cfg(all(not(kabegame_mode = "light"), not(target_os = "android")))]
use kabegame_core::virtual_driver::VirtualDriveService;
use tauri::AppHandle;

#[tauri::command]
pub async fn get_images_range(offset: usize, limit: usize) -> Result<serde_json::Value, String> {
    let result = Storage::global().get_images_range(offset, limit)?;
    Ok(serde_json::to_value(result).map_err(|e| e.to_string())?)
}

#[tauri::command]
pub async fn browse_gallery_provider(
    path: String,
    page_size: usize,
) -> Result<serde_json::Value, String> {
    let storage = Storage::global();
    let provider_rt = ProviderRuntime::global();
    let path_clone = path.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        kabegame_core::gallery::browse_gallery_provider(
            storage,
            provider_rt,
            &path_clone,
            page_size,
        )
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(serde_json::to_value(result).map_err(|e| e.to_string())?)
}

#[tauri::command]
pub async fn clear_provider_cache() -> Result<(), String> {
    let provider_rt = ProviderRuntime::global();
    tauri::async_runtime::spawn_blocking(move || provider_rt.clear_cache())
        .await
        .map_err(|e| e.to_string())??;
    Ok(())
}

#[tauri::command]
pub async fn get_image_by_id(image_id: String) -> Result<serde_json::Value, String> {
    let image = Storage::global().find_image_by_id(&image_id)?;
    Ok(serde_json::to_value(image).map_err(|e| e.to_string())?)
}

#[tauri::command]
pub async fn get_image_metadata(image_id: String) -> Result<Option<serde_json::Value>, String> {
    Storage::global().get_image_metadata(&image_id)
}

#[tauri::command]
pub async fn get_images_count() -> Result<usize, String> {
    Storage::global().get_total_count()
}

#[tauri::command]
pub async fn get_gallery_plugin_groups() -> Result<serde_json::Value, String> {
    let groups = Storage::global().get_gallery_plugin_groups()?;
    serde_json::to_value(groups).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_gallery_media_type_counts() -> Result<serde_json::Value, String> {
    let c = Storage::global().get_gallery_media_type_counts()?;
    serde_json::to_value(c).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_album_media_type_counts(album_id: String) -> Result<serde_json::Value, String> {
    let c = Storage::global().get_album_media_type_counts(&album_id)?;
    serde_json::to_value(c).map_err(|e| e.to_string())
}

/// 抓取时间过滤：月（由日聚合）+ 日（原始），与 `storage::gallery_time` 一致。
#[tauri::command]
pub async fn get_gallery_time_filter_data() -> Result<serde_json::Value, String> {
    let p = Storage::global().get_gallery_time_filter_payload()?;
    serde_json::to_value(p).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_image(image_id: String) -> Result<(), String> {
    delete_images_with_events(&[image_id.clone()], true)?;

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
    delete_images_with_events(&[image_id.clone()], false)?;

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
    delete_images_with_events(&image_ids, true)?;

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
    delete_images_with_events(&image_ids, false)?;

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
    toggle_image_favorite_with_event(&image_id, favorite)?;

    #[cfg(all(not(kabegame_mode = "light"), not(target_os = "android")))]
    VirtualDriveService::global().notify_album_dir_changed(FAVORITE_ALBUM_ID);
    Ok(())
}
