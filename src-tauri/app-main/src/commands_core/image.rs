use kabegame_core::storage::image_events::toggle_image_favorite_with_event;
use kabegame_core::storage::Storage;
#[cfg(kabegame_mode = "standard")]
use kabegame_core::virtual_driver::driver_service::VirtualDriveServiceTrait;
use serde_json::Value;

pub async fn get_images_range(offset: usize, limit: usize) -> Result<Value, String> {
    let result = Storage::global().get_images_range(offset, limit)?;
    serde_json::to_value(result).map_err(|e| e.to_string())
}

pub async fn toggle_image_favorite(image_id: String, favorite: bool) -> Result<Value, String> {
    toggle_image_favorite_with_event(&image_id, favorite)?;
    #[cfg(kabegame_mode = "standard")]
    kabegame_core::virtual_driver::VirtualDriveService::global()
        .notify_album_dir_changed(kabegame_core::storage::FAVORITE_ALBUM_ID);
    Ok(Value::Null)
}
