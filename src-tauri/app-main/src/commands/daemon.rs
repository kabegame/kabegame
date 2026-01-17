// Daemon IPC 命令（客户端侧 wrappers）

use crate::daemon_client;

#[tauri::command]
pub async fn check_daemon_status() -> Result<serde_json::Value, String> {
    daemon_client::try_connect_daemon().await
}

#[tauri::command]
pub async fn get_images() -> Result<serde_json::Value, String> {
    daemon_client::get_ipc_client()
        .storage_get_images()
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))
}

#[tauri::command]
pub async fn get_images_paginated(page: usize, page_size: usize) -> Result<serde_json::Value, String> {
    daemon_client::get_ipc_client()
        .storage_get_images_paginated(page, page_size)
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))
}

#[tauri::command]
pub async fn get_albums() -> Result<serde_json::Value, String> {
    daemon_client::get_ipc_client()
        .storage_get_albums()
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))
}

#[tauri::command]
pub async fn add_album(name: String) -> Result<serde_json::Value, String> {
    daemon_client::get_ipc_client()
        .storage_add_album(name)
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))
}

#[tauri::command]
pub async fn delete_album(album_id: String) -> Result<(), String> {
    daemon_client::get_ipc_client()
        .storage_delete_album(album_id)
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))
}

#[tauri::command]
pub async fn get_all_tasks() -> Result<serde_json::Value, String> {
    daemon_client::get_ipc_client()
        .storage_get_all_tasks()
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))
}

#[tauri::command]
pub async fn get_task(task_id: String) -> Result<serde_json::Value, String> {
    daemon_client::get_ipc_client()
        .storage_get_task(task_id)
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))
}

#[tauri::command]
pub async fn add_task(task: serde_json::Value) -> Result<(), String> {
    daemon_client::get_ipc_client()
        .storage_add_task(task)
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))
}

#[tauri::command]
pub async fn update_task(task: serde_json::Value) -> Result<(), String> {
    daemon_client::get_ipc_client()
        .storage_update_task(task)
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))
}

#[tauri::command]
pub async fn delete_task(task_id: String) -> Result<(), String> {
    daemon_client::get_ipc_client()
        .storage_delete_task(task_id)
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))
}

#[tauri::command]
pub async fn get_images_range(offset: usize, limit: usize) -> Result<serde_json::Value, String> {
    // 兼容旧前端 offset+limit：使用 daemon 的 page+page_size
    let page = if limit == 0 { 0 } else { offset / limit };
    daemon_client::get_ipc_client()
        .storage_get_images_paginated(page, limit)
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))
}

#[tauri::command]
pub async fn browse_gallery_provider(path: String) -> Result<serde_json::Value, String> {
    daemon_client::get_ipc_client()
        .gallery_browse_provider(path)
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))
}

#[tauri::command]
pub async fn get_image_by_id(image_id: String) -> Result<serde_json::Value, String> {
    daemon_client::get_ipc_client()
        .storage_get_image_by_id(image_id)
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))
}

#[tauri::command]
pub async fn start_task(task: serde_json::Value) -> Result<(), String> {
    let _task_id = daemon_client::get_ipc_client()
        .task_start(task)
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))?;
    Ok(())
}
