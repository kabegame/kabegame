//! 任务相关命令。Tauri 薄包装：实现在 `commands_core::task`，与 Web 模式 RPC 共享。
//!
//! 命令保持 `async fn`（Tauri 只把 async 命令派到工作线程，同步命令跑在主线程），
//! 即使被调的 core 实现是同步的。

use serde_json::Value;

use crate::commands_core;

#[tauri::command]
pub async fn add_run_config(config: Value) -> Result<Value, String> {
    commands_core::task::add_run_config(config).await
}

#[tauri::command]
pub async fn update_run_config(config: Value) -> Result<Value, String> {
    commands_core::task::update_run_config(config).await
}

#[tauri::command]
pub async fn get_run_configs() -> Result<Value, String> {
    commands_core::task::get_run_configs()
}

#[tauri::command]
pub async fn get_run_config(config_id: String) -> Result<Value, String> {
    commands_core::task::get_run_config(config_id)
}

#[tauri::command]
pub async fn delete_run_config(config_id: String) -> Result<Value, String> {
    commands_core::task::delete_run_config(config_id).await
}

#[tauri::command]
pub async fn copy_run_config(config_id: String) -> Result<Value, String> {
    commands_core::task::copy_run_config(config_id).await
}

#[tauri::command]
pub async fn get_missed_runs() -> Result<Value, String> {
    commands_core::task::get_missed_runs()
}

#[tauri::command]
pub async fn run_missed_configs(config_ids: Vec<String>) -> Result<Value, String> {
    commands_core::task::run_missed_configs(config_ids).await
}

#[tauri::command]
pub async fn dismiss_missed_configs(config_ids: Vec<String>) -> Result<Value, String> {
    commands_core::task::dismiss_missed_configs(config_ids).await
}

/// 除 core 的取消外，桌面端还要立即结束 WebView 任务窗口：否则脚本后续调用
/// `ctx.error` 会把任务写成 failed，而不是 canceled。
#[tauri::command]
pub async fn cancel_task(task_id: String) -> Result<Value, String> {
    let r = commands_core::task::cancel_task(task_id.clone()).await?;
    #[cfg(not(target_os = "android"))]
    {
        use kabegame_core::storage::tasks::TaskStatus;
        super::crawler::crawl_exit_with_status(TaskStatus::Canceled, Some(&task_id)).await;
    }
    Ok(r)
}

#[tauri::command]
pub async fn get_active_downloads() -> Result<Value, String> {
    commands_core::task::get_active_downloads().await
}

#[tauri::command]
pub async fn clear_finished_tasks() -> Result<Value, String> {
    commands_core::task::clear_finished_tasks()
}

#[tauri::command]
pub async fn get_task_failed_images(task_id: String) -> Result<Value, String> {
    commands_core::task::get_task_failed_images(task_id)
}

#[tauri::command]
pub async fn get_all_failed_images() -> Result<Value, String> {
    commands_core::task::get_all_failed_images()
}

#[tauri::command]
pub async fn get_task_logs(task_id: String) -> Result<Value, String> {
    commands_core::task::get_task_logs(task_id)
}

#[tauri::command]
pub async fn retry_task_failed_image(failed_id: i64) -> Result<Value, String> {
    commands_core::task::retry_task_failed_image(failed_id).await
}

#[tauri::command]
pub async fn retry_failed_images(ids: Vec<i64>) -> Result<Value, String> {
    commands_core::task::retry_failed_images(ids).await
}

#[tauri::command]
pub async fn cancel_retry_failed_image(failed_id: i64) -> Result<Value, String> {
    commands_core::task::cancel_retry_failed_image(failed_id).await
}

#[tauri::command]
pub async fn cancel_retry_failed_images(ids: Vec<i64>) -> Result<Value, String> {
    commands_core::task::cancel_retry_failed_images(ids).await
}

#[tauri::command]
pub async fn delete_failed_images(ids: Vec<i64>) -> Result<Value, String> {
    commands_core::task::delete_failed_images(ids).await
}

#[tauri::command]
pub async fn delete_task_failed_image(failed_id: i64) -> Result<Value, String> {
    commands_core::task::delete_task_failed_image(failed_id)
}

#[tauri::command]
pub async fn get_all_tasks() -> Result<Value, String> {
    commands_core::task::get_all_tasks()
}

#[tauri::command]
pub async fn get_tasks_page(limit: u32, offset: u32) -> Result<Value, String> {
    commands_core::task::get_tasks_page(limit, offset)
}

#[tauri::command]
pub async fn get_task(task_id: String) -> Result<Value, String> {
    commands_core::task::get_task(task_id)
}

#[tauri::command]
pub async fn add_task(task: Value) -> Result<Value, String> {
    commands_core::task::add_task(task)
}

#[tauri::command]
pub async fn delete_task(task_id: String) -> Result<Value, String> {
    commands_core::task::delete_task(task_id)
}

#[tauri::command]
pub async fn start_task(task: Value) -> Result<String, String> {
    commands_core::task::start_task(task)
}
