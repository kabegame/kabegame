//! Image 相关命令。Tauri 薄包装：实现在 `commands_core::image`，与 Web 模式 RPC 共享。
//!
//! 命令保持 `async fn`（Tauri 只把 async 命令派到工作线程，同步命令跑在主线程），
//! 即使被调的 core 实现是同步的。

use serde_json::Value;
use tauri::{AppHandle, Runtime};

use crate::commands_core;

#[tauri::command]
pub async fn pathql_entry(path: String) -> Result<Value, String> {
    commands_core::image::pathql_entry(path).await
}

#[tauri::command]
pub async fn pathql_list(path: String, with_count: bool) -> Result<Value, String> {
    commands_core::image::pathql_list(path, with_count).await
}

#[tauri::command]
pub async fn pathql_fetch(path: String) -> Result<Value, String> {
    commands_core::image::pathql_fetch(path).await
}

#[tauri::command]
pub async fn get_image_by_id(image_id: String) -> Result<Value, String> {
    commands_core::image::get_image_by_id(image_id)
}

#[tauri::command]
pub async fn get_image_metadata(image_id: String) -> Result<Value, String> {
    commands_core::image::get_image_metadata(image_id)
}

#[tauri::command]
pub async fn get_image_metadata_full(image_id: String) -> Result<Value, String> {
    commands_core::image::get_image_metadata_full(image_id)
}

#[tauri::command]
pub async fn get_images_count() -> Result<Value, String> {
    commands_core::image::get_images_count()
}

#[tauri::command]
pub async fn get_gallery_plugin_groups() -> Result<Value, String> {
    commands_core::image::get_gallery_plugin_groups()
}

#[tauri::command]
pub async fn get_gallery_media_type_counts() -> Result<Value, String> {
    commands_core::image::get_gallery_media_type_counts()
}

#[tauri::command]
pub async fn get_album_media_type_counts(album_id: String) -> Result<Value, String> {
    commands_core::image::get_album_media_type_counts(album_id)
}

/// 抓取时间过滤：月（由日聚合）+ 日（原始），与 `storage::gallery_time` 一致。
#[tauri::command]
pub async fn get_gallery_time_filter_data() -> Result<Value, String> {
    commands_core::image::get_gallery_time_filter_data()
}

#[tauri::command]
pub async fn delete_image(image_id: String) -> Result<Value, String> {
    commands_core::image::delete_image(image_id)
}

#[tauri::command]
pub async fn remove_image(image_id: String) -> Result<Value, String> {
    commands_core::image::remove_image(image_id)
}

#[tauri::command]
pub async fn batch_delete_images(image_ids: Vec<String>) -> Result<Value, String> {
    commands_core::image::batch_delete_images(image_ids)
}

#[tauri::command]
pub async fn batch_remove_images(image_ids: Vec<String>) -> Result<Value, String> {
    commands_core::image::batch_remove_images(image_ids)
}

#[tauri::command]
pub async fn toggle_image_favorite<R: Runtime>(
    _app: AppHandle<R>,
    image_id: String,
    favorite: bool,
) -> Result<Value, String> {
    commands_core::image::toggle_image_favorite(image_id, favorite)
}
