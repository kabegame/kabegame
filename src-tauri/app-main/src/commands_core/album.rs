//! Web JSON-RPC 相册后端层。见 `super::image` 模块注释：
//! 返回 `ImageInfo` 的函数必须先 [`crate::web::image_rewrite::rewrite_image_info`]。

use kabegame_core::settings::Settings;
use kabegame_core::storage::image_events::{
    add_images_to_album_with_event, remove_images_from_album_with_event,
};
use kabegame_core::storage::Storage;
#[cfg(feature = "standard")]
use kabegame_core::virtual_driver::driver_service::VirtualDriveServiceTrait;
#[cfg(feature = "standard")]
use kabegame_core::virtual_driver::VirtualDriveService;
use serde_json::Value;

#[cfg(feature = "web")]
use crate::web::image_rewrite::rewrite_image_info;

pub async fn get_albums() -> Result<Value, String> {
    let albums = Storage::global().list_all_albums()?;
    serde_json::to_value(albums).map_err(|e| e.to_string())
}

pub async fn get_album_counts() -> Result<Value, String> {
    let counts = Storage::global().get_album_counts()?;
    serde_json::to_value(counts).map_err(|e| e.to_string())
}

pub async fn get_album_preview(album_id: String, limit: usize) -> Result<Value, String> {
    let mut images = Storage::global().get_album_preview(&album_id, limit)?;
    #[cfg(feature = "web")]
    for info in images.iter_mut() {
        rewrite_image_info(info);
    }
    serde_json::to_value(images).map_err(|e| e.to_string())
}

pub async fn get_album_image_ids(album_id: String) -> Result<Value, String> {
    let ids = Storage::global().get_album_image_ids(&album_id)?;
    serde_json::to_value(ids).map_err(|e| e.to_string())
}

pub async fn rename_album(album_id: String, new_name: String) -> Result<Value, String> {
    Storage::global().rename_album(&album_id, &new_name)?;
    #[cfg(feature = "standard")]
    kabegame_core::virtual_driver::VirtualDriveService::global().bump_albums();
    Ok(Value::Null)
}

pub async fn delete_album(album_id: String) -> Result<Value, String> {
    Storage::global().delete_album(&album_id)?;
    if let Some(id) = Settings::global().get_wallpaper_rotation_album_id() {
        if id == album_id {
            Settings::global().set_wallpaper_rotation_album_id(None)?;
        }
    }
    #[cfg(feature = "standard")]
    kabegame_core::virtual_driver::VirtualDriveService::global().bump_albums();
    Ok(Value::Null)
}

pub async fn move_album(album_id: String, new_parent_id: Option<String>) -> Result<Value, String> {
    Storage::global().move_album(&album_id, new_parent_id.as_deref())?;
    #[cfg(feature = "standard")]
    kabegame_core::virtual_driver::VirtualDriveService::global().bump_albums();
    Ok(Value::Null)
}

pub async fn add_album(name: String, parent_id: Option<String>) -> Result<Value, String> {
    let album = Storage::global().add_album(&name, parent_id.as_deref())?;
    serde_json::to_value(album).map_err(|e| e.to_string())
}

pub async fn add_images_to_album(
    album_id: String,
    image_ids: Vec<String>,
) -> Result<Value, String> {
    let r = add_images_to_album_with_event(&album_id, &image_ids)?;
    #[cfg(feature = "standard")]
    VirtualDriveService::global().notify_album_dir_changed(&album_id);
    serde_json::to_value(r).map_err(|e| e.to_string())
}

pub async fn add_task_images_to_album(task_id: String, album_id: String) -> Result<Value, String> {
    let image_ids = Storage::global().get_task_image_ids(&task_id)?;
    if image_ids.is_empty() {
        return Ok(serde_json::json!({
            "added": 0,
            "attempted": 0,
            "canAdd": 0,
            "currentCount": 0
        }));
    }
    let r = add_images_to_album_with_event(&album_id, &image_ids)?;
    #[cfg(feature = "standard")]
    VirtualDriveService::global().notify_album_dir_changed(&album_id);
    serde_json::to_value(r).map_err(|e| e.to_string())
}

pub async fn remove_images_from_album(
    album_id: String,
    image_ids: Vec<String>,
) -> Result<Value, String> {
    let removed = remove_images_from_album_with_event(&album_id, &image_ids)?;
    #[cfg(feature = "standard")]
    VirtualDriveService::global().notify_album_dir_changed(&album_id);
    serde_json::to_value(removed).map_err(|e| e.to_string())
}

pub async fn update_album_images_order(
    album_id: String,
    image_orders: Vec<(String, i64)>,
) -> Result<Value, String> {
    Storage::global().update_album_images_order(&album_id, &image_orders)?;
    Ok(Value::Null)
}
