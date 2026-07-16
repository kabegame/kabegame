//! Album 相关命令。Tauri 薄包装：实现在 `commands_core::album`，与 Web 模式 RPC 共享。
//!
//! 命令保持 `async fn`（Tauri 只把 async 命令派到工作线程，同步命令跑在主线程），
//! 即使被调的 core 实现是同步的。

use serde_json::Value;
use tauri::{AppHandle, Runtime};

use crate::commands_core;

#[tauri::command]
pub fn get_albums() -> Result<Value, String> {
    commands_core::album::get_albums()
}

#[tauri::command]
pub fn add_album<R: Runtime>(name: String, parent_id: Option<String>) -> Result<Value, String> {
    commands_core::album::add_album(name, parent_id)
}

#[tauri::command]
pub fn delete_album<R: Runtime>(album_id: String) -> Result<Value, String> {
    commands_core::album::delete_album(album_id)
}

#[tauri::command]
pub fn rename_album<R: Runtime>(album_id: String, new_name: String) -> Result<Value, String> {
    commands_core::album::rename_album(album_id, new_name)
}

#[tauri::command]
pub fn move_album<R: Runtime>(
    _app: AppHandle<R>,
    album_id: String,
    new_parent_id: Option<String>,
) -> Result<Value, String> {
    commands_core::album::move_album(album_id, new_parent_id)
}

#[tauri::command]
pub fn add_images_to_album<R: Runtime>(
    album_id: String,
    image_ids: Vec<String>,
) -> Result<Value, String> {
    commands_core::album::add_images_to_album(album_id, image_ids)
}

/// 将任务的全部图片加入画册（后端根据 task_id 取图，前端只负责选画册）
#[tauri::command]
pub fn add_task_images_to_album<R: Runtime>(
    task_id: String,
    album_id: String,
) -> Result<Value, String> {
    commands_core::album::add_task_images_to_album(task_id, album_id)
}

#[tauri::command]
pub async fn remove_images_from_album<R: Runtime>(
    _app: AppHandle<R>,
    album_id: String,
    image_ids: Vec<String>,
) -> Result<Value, String> {
    commands_core::album::remove_images_from_album(album_id, image_ids)
}

#[tauri::command]
pub async fn get_album_preview(album_id: String, limit: usize) -> Result<Value, String> {
    commands_core::album::get_album_preview(album_id, limit)
}

#[tauri::command]
pub async fn update_album_images_order(
    album_id: String,
    image_orders: Vec<(String, i64)>,
) -> Result<Value, String> {
    commands_core::album::update_album_images_order(album_id, image_orders)
}

#[tauri::command]
#[cfg(all(not(target_os = "android"), not(feature = "web")))]
pub async fn add_local_folder_album(
    name: String,
    parent_id: Option<String>,
    sync_folder: String,
    recursive: bool,
) -> Result<Value, String> {
    commands_core::album::add_local_folder_album(name, parent_id, sync_folder, recursive).await
}

#[tauri::command]
pub async fn sync_local_folder_album(
    album_id: String,
    recursive: Option<bool>,
    create_missing_albums: Option<bool>,
) -> Result<Value, String> {
    commands_core::album::sync_local_folder_album(album_id, recursive, create_missing_albums).await
}

#[tauri::command]
pub async fn sync_local_folder_albums(album_ids: Vec<String>) -> Result<Value, String> {
    commands_core::album::sync_local_folder_albums(album_ids).await
}
