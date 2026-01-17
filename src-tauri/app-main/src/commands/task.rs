// 任务相关命令

use crate::daemon_client;
#[cfg(feature = "self-host")]
use crate::storage::{Storage, TaskInfo};

#[tauri::command]
pub async fn add_run_config(config: serde_json::Value) -> Result<serde_json::Value, String> {
    daemon_client::get_ipc_client()
        .storage_add_run_config(config)
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))
}

#[tauri::command]
pub async fn update_run_config(config: serde_json::Value) -> Result<(), String> {
    daemon_client::get_ipc_client()
        .storage_update_run_config(config)
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))
}

#[tauri::command]
pub async fn get_run_configs() -> Result<serde_json::Value, String> {
    daemon_client::get_ipc_client()
        .storage_get_run_configs()
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))
}

#[tauri::command]
pub async fn delete_run_config(config_id: String) -> Result<(), String> {
    daemon_client::get_ipc_client()
        .storage_delete_run_config(config_id)
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))
}

#[tauri::command]
pub async fn cancel_task(task_id: String) -> Result<(), String> {
    daemon_client::get_ipc_client()
        .task_cancel(task_id)
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))
}

#[tauri::command]
pub async fn get_active_downloads() -> Result<serde_json::Value, String> {
    daemon_client::get_ipc_client()
        .get_active_downloads()
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))
}

#[tauri::command]
#[cfg(feature = "self-host")]
pub fn local_add_task(task: TaskInfo, state: tauri::State<Storage>) -> Result<(), String> {
    state.add_task(task)
}

#[tauri::command]
#[cfg(feature = "self-host")]
pub fn local_update_task(task: TaskInfo, state: tauri::State<Storage>) -> Result<(), String> {
    state.update_task(task)
}

#[tauri::command]
#[cfg(feature = "self-host")]
pub fn local_get_task(task_id: String, state: tauri::State<Storage>) -> Result<Option<TaskInfo>, String> {
    state.get_task(&task_id)
}

#[tauri::command]
#[cfg(feature = "self-host")]
pub fn local_get_all_tasks(state: tauri::State<Storage>) -> Result<Vec<TaskInfo>, String> {
    state.get_all_tasks()
}

#[tauri::command]
pub async fn confirm_task_rhai_dump(task_id: String) -> Result<(), String> {
    daemon_client::get_ipc_client()
        .storage_confirm_task_rhai_dump(task_id)
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))
}

#[tauri::command]
pub async fn clear_finished_tasks() -> Result<usize, String> {
    daemon_client::get_ipc_client()
        .storage_clear_finished_tasks()
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))
}

#[tauri::command]
pub async fn get_task_images(task_id: String) -> Result<serde_json::Value, String> {
    daemon_client::get_ipc_client()
        .storage_get_task_images(task_id)
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))
}

#[tauri::command]
pub async fn get_task_images_paginated(
    task_id: String,
    page: usize,
    page_size: usize,
) -> Result<serde_json::Value, String> {
    let offset = page.saturating_mul(page_size);
    daemon_client::get_ipc_client()
        .storage_get_task_images_paginated(task_id, offset, page_size)
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))
}

#[tauri::command]
pub async fn get_task_image_ids(task_id: String) -> Result<Vec<String>, String> {
    daemon_client::get_ipc_client()
        .storage_get_task_image_ids(task_id)
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))
}

#[tauri::command]
pub async fn get_task_failed_images(task_id: String) -> Result<serde_json::Value, String> {
    daemon_client::get_ipc_client()
        .storage_get_task_failed_images(task_id)
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))
}

#[tauri::command]
pub async fn retry_task_failed_image(failed_id: i64) -> Result<(), String> {
    daemon_client::get_ipc_client()
        .task_retry_failed_image(failed_id)
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))
}
