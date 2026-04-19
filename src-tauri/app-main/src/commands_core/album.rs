use kabegame_core::settings::Settings;
use kabegame_core::storage::Storage;
#[cfg(kabegame_mode = "standard")]
use kabegame_core::virtual_driver::driver_service::VirtualDriveServiceTrait;
use serde_json::Value;

pub async fn get_albums() -> Result<Value, String> {
    let albums = Storage::global().list_all_albums()?;
    serde_json::to_value(albums).map_err(|e| e.to_string())
}

pub async fn get_album_counts() -> Result<Value, String> {
    let counts = Storage::global().get_album_counts()?;
    serde_json::to_value(counts).map_err(|e| e.to_string())
}

pub async fn rename_album(album_id: String, new_name: String) -> Result<Value, String> {
    Storage::global().rename_album(&album_id, &new_name)?;
    #[cfg(kabegame_mode = "standard")]
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
    #[cfg(kabegame_mode = "standard")]
    kabegame_core::virtual_driver::VirtualDriveService::global().bump_albums();
    Ok(Value::Null)
}
