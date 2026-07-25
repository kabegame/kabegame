//! 图片命令的共享实现层。
//!
//! 调用方（均在 `kabegame` crate）：`web::dispatch`（web 模式 JSON-RPC）与
//! `commands::image`（桌面 Tauri 薄包装）。两者共用本实现。
//! 返回 `ImageInfo`（或嵌套）的函数一律回**原始本地路径**；web 模式的 CDN 改写
//! 由 `kabegame::web::dispatch` 在本层返回之后施加，本层不感知 web。

use crate::providers::{decode_provider_path_segments, query_entry, query_fetch, query_list};
use crate::settings::Settings;
use crate::storage::image_events::{delete_images_with_events, toggle_image_favorite_with_event};
use crate::storage::Storage;
use serde_json::{json, Value};

pub async fn pathql_entry(path: String) -> Result<Value, String> {
    let path = decode_provider_path_segments(&path);
    let result = tokio::task::spawn_blocking(move || query_entry(&path))
        .await
        .map_err(|e| e.to_string())??;
    serde_json::to_value(result).map_err(|e| e.to_string())
}

pub async fn pathql_list(path: String, with_count: bool) -> Result<Value, String> {
    let path = decode_provider_path_segments(&path);
    let result = tokio::task::spawn_blocking(move || query_list(&path, with_count))
        .await
        .map_err(|e| e.to_string())??;
    serde_json::to_value(result).map_err(|e| e.to_string())
}

pub async fn pathql_fetch(path: String) -> Result<Value, String> {
    let path = decode_provider_path_segments(&path);
    let result = tokio::task::spawn_blocking(move || query_fetch(&path))
        .await
        .map_err(|e| e.to_string())??;
    serde_json::to_value(result).map_err(|e| e.to_string())
}

pub fn get_images_count() -> Result<Value, String> {
    let count = Storage::global().get_total_count()?;
    serde_json::to_value(count).map_err(|e| e.to_string())
}

pub fn get_gallery_plugin_groups() -> Result<Value, String> {
    let groups = Storage::global().get_gallery_plugin_groups()?;
    serde_json::to_value(groups).map_err(|e| e.to_string())
}

pub fn get_gallery_media_type_counts() -> Result<Value, String> {
    let c = Storage::global().get_gallery_media_type_counts()?;
    serde_json::to_value(c).map_err(|e| e.to_string())
}

pub fn get_album_media_type_counts(album_id: String) -> Result<Value, String> {
    let c = Storage::global().get_album_media_type_counts(&album_id)?;
    serde_json::to_value(c).map_err(|e| e.to_string())
}

pub fn get_gallery_time_filter_data() -> Result<Value, String> {
    let p = Storage::global().get_gallery_time_filter_payload()?;
    serde_json::to_value(p).map_err(|e| e.to_string())
}

pub fn get_image_by_id(image_id: String) -> Result<Value, String> {
    let image = Storage::find_image_by_id(&image_id)?;
    serde_json::to_value(image).map_err(|e| e.to_string())
}

pub fn get_image_metadata(image_id: String) -> Result<Value, String> {
    let meta = Storage::global().get_metadata(&image_id)?;
    serde_json::to_value(meta).map_err(|e| e.to_string())
}

pub fn get_image_metadata_full(image_id: String) -> Result<Value, String> {
    let meta = Storage::global().get_metadata_full(&image_id)?;
    serde_json::to_value(meta).map_err(|e| e.to_string())
}

pub async fn get_image_native_metadata(image_id: String) -> Result<Value, String> {
    let storage = Storage::global();
    let row = storage
        .get_image_native_metadata_row(&image_id)?
        .ok_or_else(|| "native-metadata:image-not-found".to_string())?;
    let format_key = row
        .format_key
        .as_deref()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    if !matches!(
        format_key.as_str(),
        "image/jpg" | "image/jpeg" | "image/png"
    ) {
        return Ok(Value::Null);
    }

    if row.parser_version == Some(crate::media::native_metadata::PARSER_VERSION) {
        if let Some(data) = row.data.as_deref() {
            return native_metadata_payload(data, row.parser_version.unwrap());
        }
    }

    if storage
        .ensure_native_metadata_for_image(&image_id, &row.hash, None)?
        .is_some()
    {
        if let Some(shared) = storage.get_image_native_metadata_row(&image_id)? {
            if shared.parser_version == Some(crate::media::native_metadata::PARSER_VERSION) {
                if let Some(data) = shared.data.as_deref() {
                    return native_metadata_payload(data, shared.parser_version.unwrap());
                }
            }
        }
    }

    let bytes = crate::media::native_metadata::read_image_bytes(&row.local_path).await?;
    let parsed = crate::media::native_metadata::parse_native_metadata(&format_key, &bytes)
        .ok_or_else(|| "native-metadata:unsupported-format".to_string())?;
    let json = serde_json::to_string(&parsed)
        .map_err(|e| format!("native-metadata:serialize-failed:{e}"))?;
    storage.ensure_native_metadata_for_image(&image_id, &row.hash, Some(&json))?;

    let stored = storage
        .get_image_native_metadata_row(&image_id)?
        .ok_or_else(|| "native-metadata:image-not-found".to_string())?;
    let data = stored
        .data
        .as_deref()
        .ok_or_else(|| "native-metadata:store-failed".to_string())?;
    native_metadata_payload(data, stored.parser_version.unwrap_or_default())
}

fn native_metadata_payload(data: &str, parser_version: u32) -> Result<Value, String> {
    let mut payload: Value =
        serde_json::from_str(data).map_err(|e| format!("native-metadata:invalid-cache:{e}"))?;
    let object = payload
        .as_object_mut()
        .ok_or_else(|| "native-metadata:invalid-cache".to_string())?;
    object.insert("v".to_string(), json!(parser_version));
    Ok(payload)
}

pub fn toggle_image_favorite(image_id: String, favorite: bool) -> Result<Value, String> {
    toggle_image_favorite_with_event(&image_id, favorite)?;
    #[cfg(feature = "virtual-driver")]
    {
        use crate::virtual_driver::driver_service::VirtualDriveServiceTrait;
        crate::virtual_driver::VirtualDriveService::global()
            .notify_album_dir_changed(crate::storage::FAVORITE_ALBUM_ID);
    }
    Ok(Value::Null)
}

/// 图片被移出图库后，若它正是当前壁纸，则清空该设置，避免留下悬空引用。
fn clear_current_wallpaper_if_removed(removed_ids: &[String]) {
    let Some(current) = Settings::global().get_current_wallpaper_image_id() else {
        return;
    };
    if removed_ids.iter().any(|id| id == &current) {
        let _ = Settings::global().set_current_wallpaper_image_id(None);
    }
}

pub fn delete_image(image_id: String) -> Result<Value, String> {
    delete_images_with_events(std::slice::from_ref(&image_id), true)?;
    clear_current_wallpaper_if_removed(std::slice::from_ref(&image_id));
    Ok(Value::Null)
}

pub fn remove_image(image_id: String) -> Result<Value, String> {
    delete_images_with_events(std::slice::from_ref(&image_id), false)?;
    clear_current_wallpaper_if_removed(std::slice::from_ref(&image_id));
    Ok(Value::Null)
}

pub fn batch_delete_images(image_ids: Vec<String>) -> Result<Value, String> {
    delete_images_with_events(&image_ids, true)?;
    clear_current_wallpaper_if_removed(&image_ids);
    Ok(Value::Null)
}

pub fn batch_remove_images(image_ids: Vec<String>) -> Result<Value, String> {
    delete_images_with_events(&image_ids, false)?;
    clear_current_wallpaper_if_removed(&image_ids);
    Ok(Value::Null)
}
