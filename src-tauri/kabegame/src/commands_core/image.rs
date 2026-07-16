//! 图片命令的共享实现层。
//!
//! 调用方：`crate::web::dispatch`（web 模式 JSON-RPC）与 `crate::commands::image`
//! （桌面 Tauri 薄包装）。两者共用同一份实现，行为差异只允许由 feature 决定。
//! 本模块同时是 web 边界：任何返回 `ImageInfo`（或嵌套 `ImageInfo`）的函数，
//! **必须**在序列化前调用 `crate::web::image_rewrite::rewrite_image_info`，
//! 把 `local_path` / `thumbnail_path` 改写成 CDN 绝对 URL。否则 web 客户端拿到
//! 的是服务器本地路径，浏览器没法直接加载。

use kabegame_core::providers::{
    decode_provider_path_segments, query_entry, query_fetch, query_list,
};
use kabegame_core::settings::Settings;
use kabegame_core::storage::image_events::{
    delete_images_with_events, toggle_image_favorite_with_event,
};
use kabegame_core::storage::Storage;
use serde_json::Value;

#[cfg(feature = "web")]
use crate::web::image_rewrite::{rewrite_fs_path, rewrite_image_info};

#[cfg(feature = "web")]
fn rewrite_pathql_image_rows(rows: &mut [Value]) {
    if cfg!(debug_assertions) {
        return;
    }
    for row in rows {
        let Some(obj) = row.as_object_mut() else {
            continue;
        };
        for key in ["local_path", "thumbnail_path"] {
            if let Some(Value::String(path)) = obj.get_mut(key) {
                *path = rewrite_fs_path(path);
            }
        }
    }
}

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
    #[cfg_attr(not(feature = "web"), allow(unused_mut))]
    let mut result = tokio::task::spawn_blocking(move || query_fetch(&path))
        .await
        .map_err(|e| e.to_string())??;
    #[cfg(feature = "web")]
    rewrite_pathql_image_rows(&mut result);
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
    #[cfg_attr(not(feature = "web"), allow(unused_mut))]
    let mut image = Storage::find_image_by_id(&image_id)?;
    #[cfg(feature = "web")]
    if let Some(info) = image.as_mut() {
        rewrite_image_info(info);
    }
    serde_json::to_value(image).map_err(|e| e.to_string())
}

pub fn get_image_metadata(image_id: String) -> Result<Value, String> {
    let meta = Storage::global().get_image_metadata(&image_id)?;
    serde_json::to_value(meta).map_err(|e| e.to_string())
}

pub fn get_image_metadata_full(image_id: String) -> Result<Value, String> {
    let meta = Storage::global().get_image_metadata_full(&image_id)?;
    serde_json::to_value(meta).map_err(|e| e.to_string())
}

pub fn toggle_image_favorite(image_id: String, favorite: bool) -> Result<Value, String> {
    toggle_image_favorite_with_event(&image_id, favorite)?;
    #[cfg(feature = "standard")]
    {
        use kabegame_core::virtual_driver::driver_service::VirtualDriveServiceTrait;
        kabegame_core::virtual_driver::VirtualDriveService::global()
            .notify_album_dir_changed(kabegame_core::storage::FAVORITE_ALBUM_ID);
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
