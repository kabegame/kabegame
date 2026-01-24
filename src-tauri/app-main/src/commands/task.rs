// 任务相关命令

use kabegame_core::storage::{Storage, TaskInfo};
use tauri::AppHandle;

#[tauri::command]
pub async fn add_run_config(config: serde_json::Value) -> Result<serde_json::Value, String> {
    use kabegame_core::storage::RunConfig;
    let run_config: RunConfig = serde_json::from_value(config).map_err(|e| e.to_string())?;
    let result = Storage::global().add_run_config(run_config)?;
    Ok(serde_json::to_value(result).map_err(|e| e.to_string())?)
}

#[tauri::command]
pub async fn update_run_config(config: serde_json::Value) -> Result<(), String> {
    use kabegame_core::storage::RunConfig;
    let run_config: RunConfig = serde_json::from_value(config).map_err(|e| e.to_string())?;
    Storage::global().update_run_config(run_config)
}

#[tauri::command]
pub async fn get_run_configs() -> Result<serde_json::Value, String> {
    let configs = Storage::global().get_run_configs()?;
    Ok(serde_json::to_value(configs).map_err(|e| e.to_string())?)
}

#[tauri::command]
pub async fn delete_run_config(config_id: String) -> Result<(), String> {
    Storage::global().delete_run_config(&config_id)
}

#[tauri::command]
pub async fn cancel_task(task_id: String) -> Result<(), String> {
    // 任务取消通常需要通知 Scheduler 或 Runtime
    // 这里我们直接调用 TaskScheduler 的 cancel
    use kabegame_core::crawler::TaskScheduler;
    TaskScheduler::global().cancel_task(&task_id)
}

#[tauri::command]
pub async fn get_active_downloads() -> Result<serde_json::Value, String> {
    use kabegame_core::crawler::TaskScheduler;
    let downloads = TaskScheduler::global().get_active_downloads()?;
    Ok(serde_json::to_value(downloads).map_err(|e| e.to_string())?)
}

#[tauri::command]
pub async fn confirm_task_rhai_dump(task_id: String) -> Result<(), String> {
    Storage::global().confirm_task_rhai_dump(&task_id)
}

#[tauri::command]
pub async fn clear_finished_tasks() -> Result<usize, String> {
    Storage::global().clear_finished_tasks()
}

#[tauri::command]
pub async fn get_task_images(task_id: String) -> Result<serde_json::Value, String> {
    let images = Storage::global().get_task_images(&task_id)?;
    Ok(serde_json::to_value(images).map_err(|e| e.to_string())?)
}

#[tauri::command]
pub async fn get_task_images_paginated(
    task_id: String,
    page: usize,
    page_size: usize,
) -> Result<serde_json::Value, String> {
    // 这里的 page/page_size 是前端传来的，后端 get_task_images_paginated 接受 offset 和 limit
    let offset = page.saturating_mul(page_size);
    let images = Storage::global().get_task_images_paginated(&task_id, offset, page_size)?;
    Ok(serde_json::to_value(images).map_err(|e| e.to_string())?)
}

#[tauri::command]
pub async fn get_task_image_ids(task_id: String) -> Result<Vec<String>, String> {
    Storage::global().get_task_image_ids(&task_id)
}

#[tauri::command]
pub async fn get_task_failed_images(task_id: String) -> Result<serde_json::Value, String> {
    let images = Storage::global().get_task_failed_images(&task_id)?;
    Ok(serde_json::to_value(images).map_err(|e| e.to_string())?)
}

#[tauri::command]
pub async fn retry_task_failed_image(failed_id: i64) -> Result<(), String> {
    // 重试逻辑通常涉及 Scheduler
    use kabegame_core::crawler::TaskScheduler;
    TaskScheduler::global().retry_failed_image(failed_id)
}

// 补充：add_task, update_task, delete_task, start_task (之前在 daemon.rs 里的)
#[tauri::command]
pub async fn get_all_tasks() -> Result<serde_json::Value, String> {
    let tasks = Storage::global().get_all_tasks()?;
    Ok(serde_json::to_value(tasks).map_err(|e| e.to_string())?)
}

#[tauri::command]
pub async fn get_task(task_id: String) -> Result<serde_json::Value, String> {
    let task = Storage::global().get_task(&task_id)?;
    Ok(serde_json::to_value(task).map_err(|e| e.to_string())?)
}

#[tauri::command]
pub async fn add_task(task: serde_json::Value) -> Result<(), String> {
    // 需要转换 serde_json::Value 到 TaskInfo?
    // Storage::add_task 接受 TaskInfo
    let task_info: TaskInfo = serde_json::from_value(task).map_err(|e| e.to_string())?;
    Storage::global().add_task(task_info)
}

#[tauri::command]
pub async fn update_task(task: serde_json::Value) -> Result<(), String> {
    let task_info: TaskInfo = serde_json::from_value(task).map_err(|e| e.to_string())?;
    Storage::global().update_task(task_info)
}

#[tauri::command]
pub async fn delete_task(task_id: String) -> Result<(), String> {
    Storage::global().delete_task(&task_id)
}

#[tauri::command]
pub async fn start_task(task: serde_json::Value) -> Result<(), String> {
    use kabegame_core::crawler::CrawlTaskRequest;
    use kabegame_core::crawler::TaskScheduler;

    // 解析 CrawlTaskRequest
    let req: CrawlTaskRequest = serde_json::from_value(task).map_err(|e| e.to_string())?;

    // 确保任务在 DB 中存在（否则调度器的状态持久化会变成 no-op）
    match Storage::global().get_task(&req.task_id)? {
        Some(_) => {}
        None => {
            let now_ms = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64;
            let t = TaskInfo {
                id: req.task_id.clone(),
                plugin_id: req.plugin_id.clone(),
                output_dir: req.output_dir.clone(),
                user_config: req.user_config.clone(),
                http_headers: req.http_headers.clone(),
                output_album_id: req.output_album_id.clone(),
                status: "pending".to_string(),
                progress: 0.0,
                deleted_count: 0,
                start_time: Some(now_ms),
                end_time: None,
                error: None,
                rhai_dump_present: false,
                rhai_dump_confirmed: false,
                rhai_dump_created_at: None,
            };
            let _ = Storage::global().add_task(t);
        }
    }

    let _task_id = TaskScheduler::global()
        .submit_task(req)
        .map_err(|e| e.to_string())?;
    Ok(())
}
