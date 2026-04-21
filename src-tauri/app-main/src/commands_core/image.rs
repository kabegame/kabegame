use kabegame_core::providers::{execute_provider_query, ProviderRuntime};
use kabegame_core::storage::image_events::{delete_images_with_events, toggle_image_favorite_with_event};
use kabegame_core::storage::Storage;
#[cfg(kabegame_mode = "standard")]
use kabegame_core::virtual_driver::driver_service::VirtualDriveServiceTrait;
use serde_json::Value;

pub async fn get_images_range(offset: usize, limit: usize) -> Result<Value, String> {
    let result = Storage::global().get_images_range(offset, limit)?;
    serde_json::to_value(result).map_err(|e| e.to_string())
}

pub async fn browse_gallery_provider(path: String) -> Result<Value, String> {
    let full = format!("gallery/{}", path.trim().trim_start_matches('/'));
    let result = tokio::task::spawn_blocking(move || execute_provider_query(&full))
        .await
        .map_err(|e| e.to_string())??;
    Ok(result)
}

pub async fn query_provider(path: String) -> Result<Value, String> {
    let p = path.trim().to_string();
    let result = tokio::task::spawn_blocking(move || execute_provider_query(&p))
        .await
        .map_err(|e| e.to_string())??;
    Ok(result)
}

pub async fn get_images_count() -> Result<Value, String> {
    let count = Storage::global().get_total_count()?;
    serde_json::to_value(count).map_err(|e| e.to_string())
}

pub async fn get_gallery_plugin_groups() -> Result<Value, String> {
    let groups = Storage::global().get_gallery_plugin_groups()?;
    serde_json::to_value(groups).map_err(|e| e.to_string())
}

pub async fn get_gallery_media_type_counts() -> Result<Value, String> {
    let c = Storage::global().get_gallery_media_type_counts()?;
    serde_json::to_value(c).map_err(|e| e.to_string())
}

pub async fn get_album_media_type_counts(album_id: String) -> Result<Value, String> {
    let c = Storage::global().get_album_media_type_counts(&album_id)?;
    serde_json::to_value(c).map_err(|e| e.to_string())
}

pub async fn get_gallery_time_filter_data() -> Result<Value, String> {
    let p = Storage::global().get_gallery_time_filter_payload()?;
    serde_json::to_value(p).map_err(|e| e.to_string())
}

pub async fn get_image_by_id(image_id: String) -> Result<Value, String> {
    let image = Storage::global().find_image_by_id(&image_id)?;
    serde_json::to_value(image).map_err(|e| e.to_string())
}

pub async fn get_image_metadata(image_id: String) -> Result<Value, String> {
    let meta = Storage::global().get_image_metadata(&image_id)?;
    serde_json::to_value(meta).map_err(|e| e.to_string())
}

pub async fn get_image_metadata_by_metadata_id(metadata_id: i64) -> Result<Value, String> {
    let meta = Storage::global().get_image_metadata_by_metadata_id(metadata_id)?;
    serde_json::to_value(meta).map_err(|e| e.to_string())
}

pub async fn toggle_image_favorite(image_id: String, favorite: bool) -> Result<Value, String> {
    toggle_image_favorite_with_event(&image_id, favorite)?;
    #[cfg(kabegame_mode = "standard")]
    kabegame_core::virtual_driver::VirtualDriveService::global()
        .notify_album_dir_changed(kabegame_core::storage::FAVORITE_ALBUM_ID);
    Ok(Value::Null)
}

pub async fn delete_image(image_id: String) -> Result<Value, String> {
    delete_images_with_events(&[image_id], true)?;
    Ok(Value::Null)
}

pub async fn remove_image(image_id: String) -> Result<Value, String> {
    delete_images_with_events(&[image_id], false)?;
    Ok(Value::Null)
}

pub async fn batch_delete_images(image_ids: Vec<String>) -> Result<Value, String> {
    delete_images_with_events(&image_ids, true)?;
    Ok(Value::Null)
}

pub async fn batch_remove_images(image_ids: Vec<String>) -> Result<Value, String> {
    delete_images_with_events(&image_ids, false)?;
    Ok(Value::Null)
}
