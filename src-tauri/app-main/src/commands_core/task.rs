use kabegame_core::emitter::GlobalEmitter;
use kabegame_core::scheduler::Scheduler;
use kabegame_core::storage::{RunConfig, Storage, TaskInfo};
use serde_json::Value;
use std::collections::HashSet;

pub async fn get_run_configs() -> Result<Value, String> {
    let configs = Storage::global().get_run_configs()?;
    serde_json::to_value(configs).map_err(|e| e.to_string())
}

pub async fn get_all_tasks() -> Result<Value, String> {
    let tasks = Storage::global().get_all_tasks()?;
    serde_json::to_value(tasks).map_err(|e| e.to_string())
}

pub async fn get_tasks_page(limit: u32, offset: u32) -> Result<Value, String> {
    let (tasks, total) = Storage::global().get_tasks_page(limit, offset)?;
    serde_json::to_value(serde_json::json!({ "tasks": tasks, "total": total }))
        .map_err(|e| e.to_string())
}

pub async fn get_task(task_id: String) -> Result<Value, String> {
    let task = Storage::global().get_task(&task_id)?;
    serde_json::to_value(task).map_err(|e| e.to_string())
}

pub async fn get_task_logs(task_id: String) -> Result<Value, String> {
    let logs = Storage::global().get_task_logs(&task_id)?;
    serde_json::to_value(logs).map_err(|e| e.to_string())
}

pub async fn get_task_failed_images(task_id: String) -> Result<Value, String> {
    let images = Storage::global().get_task_failed_images(&task_id)?;
    serde_json::to_value(images).map_err(|e| e.to_string())
}

pub async fn get_all_failed_images() -> Result<Value, String> {
    let images = Storage::global().get_all_failed_images()?;
    serde_json::to_value(images).map_err(|e| e.to_string())
}

pub async fn get_active_downloads() -> Result<Value, String> {
    use kabegame_core::crawler::TaskScheduler;
    let downloads = TaskScheduler::global().get_active_downloads().await?;
    serde_json::to_value(downloads).map_err(|e| e.to_string())
}

pub async fn start_task(task: Value) -> Result<(), String> {
    use kabegame_core::crawler::CrawlTaskRequest;
    use kabegame_core::crawler::TaskScheduler;

    let req: CrawlTaskRequest = serde_json::from_value(task).map_err(|e| e.to_string())?;

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
                run_config_id: req.run_config_id.clone(),
                trigger_source: if req.trigger_source.is_empty() {
                    "manual".to_string()
                } else {
                    req.trigger_source.clone()
                },
                status: "pending".to_string(),
                progress: 0.0,
                deleted_count: 0,
                dedup_count: 0,
                success_count: 0,
                failed_count: 0,
                start_time: Some(now_ms),
                end_time: None,
                error: None,
            };
            let payload = serde_json::to_value(&t).map_err(|e| e.to_string())?;
            Storage::global().add_task(t)?;
            GlobalEmitter::global().emit_task_added(&payload);
        }
    }

    TaskScheduler::global()
        .submit_task(req)
        .map_err(|e| e.to_string())?;
    Ok(())
}

pub async fn cancel_task(task_id: String) -> Result<Value, String> {
    use kabegame_core::crawler::TaskScheduler;
    TaskScheduler::global().cancel_task(&task_id).await;
    Ok(Value::Null)
}

pub async fn delete_task(task_id: String) -> Result<Value, String> {
    let storage = Storage::global();
    let image_ids = storage.get_task_image_ids(&task_id)?;
    storage.delete_task(&task_id)?;
    GlobalEmitter::global().emit_task_deleted(&task_id);
    if !image_ids.is_empty() {
        let tids = vec![task_id];
        GlobalEmitter::global().emit_images_change("change", &image_ids, Some(&tids), None);
    }
    Ok(Value::Null)
}

pub async fn retry_task_failed_image(failed_id: i64) -> Result<Value, String> {
    use kabegame_core::crawler::TaskScheduler;
    TaskScheduler::global().retry_failed_image(failed_id).await?;
    Ok(Value::Null)
}

pub async fn retry_failed_images(ids: Vec<i64>) -> Result<Value, String> {
    use kabegame_core::crawler::TaskScheduler;
    let started = TaskScheduler::global().retry_failed_images(&ids).await?;
    serde_json::to_value(started).map_err(|e| e.to_string())
}

pub async fn cancel_retry_failed_image(failed_id: i64) -> Result<Value, String> {
    use kabegame_core::crawler::TaskScheduler;
    TaskScheduler::global()
        .cancel_retry_failed_image(failed_id)
        .await;
    Ok(Value::Null)
}

pub async fn cancel_retry_failed_images(ids: Vec<i64>) -> Result<Value, String> {
    use kabegame_core::crawler::TaskScheduler;
    TaskScheduler::global()
        .cancel_retry_failed_images(&ids)
        .await;
    Ok(Value::Null)
}

pub async fn delete_failed_images(ids: Vec<i64>) -> Result<Value, String> {
    use kabegame_core::crawler::TaskScheduler;
    TaskScheduler::global()
        .cancel_retry_failed_images(&ids)
        .await;
    let storage = Storage::global();
    let groups = storage.delete_failed_images(&ids)?;
    for (task_id, del_ids) in &groups {
        GlobalEmitter::global().emit_failed_images_removed(task_id, del_ids);
        if let Ok(Some(t)) = storage.get_task(task_id) {
            GlobalEmitter::global().emit_task_image_counts(
                task_id,
                Some(t.success_count),
                Some(t.deleted_count),
                Some(t.failed_count),
                Some(t.dedup_count),
            );
        }
    }
    Ok(Value::Null)
}

pub async fn delete_task_failed_image(failed_id: i64) -> Result<Value, String> {
    let storage = Storage::global();
    let task_id = storage
        .get_task_failed_image_by_id(failed_id)?
        .map(|item| item.task_id);
    storage.delete_task_failed_image(failed_id)?;
    if let Some(ref tid) = task_id {
        GlobalEmitter::global().emit_failed_images_removed(tid, &[failed_id]);
        if let Ok(Some(t)) = storage.get_task(tid) {
            GlobalEmitter::global().emit_task_image_counts(
                tid,
                Some(t.success_count),
                Some(t.deleted_count),
                Some(t.failed_count),
                Some(t.dedup_count),
            );
        }
    }
    Ok(Value::Null)
}

pub async fn add_run_config(config: Value) -> Result<Value, String> {
    let run_config: RunConfig = serde_json::from_value(config).map_err(|e| e.to_string())?;
    let config_id = run_config.id.clone();
    let result = Storage::global().add_run_config(run_config)?;
    let _ = Scheduler::global().reload_config(&config_id).await;
    GlobalEmitter::global().emit_auto_config_change("configadd", &config_id);
    serde_json::to_value(result).map_err(|e| e.to_string())
}

pub async fn update_run_config(config: Value) -> Result<Value, String> {
    let run_config: RunConfig = serde_json::from_value(config).map_err(|e| e.to_string())?;
    let config_id = run_config.id.clone();
    Storage::global().update_run_config(run_config)?;
    let _ = Scheduler::global().reload_config(&config_id).await;
    GlobalEmitter::global().emit_auto_config_change("configchange", &config_id);
    Ok(Value::Null)
}

pub async fn delete_run_config(config_id: String) -> Result<Value, String> {
    let _ = Scheduler::global().remove_config(&config_id).await;
    Storage::global().delete_run_config(&config_id)?;
    GlobalEmitter::global().emit_auto_config_change("configdelete", &config_id);
    Ok(Value::Null)
}

pub async fn run_missed_configs(config_ids: Vec<String>) -> Result<Value, String> {
    kabegame_core::scheduler::run_missed_configs(&config_ids);
    let _ = Scheduler::global().reload_config("").await;
    Ok(Value::Null)
}

pub async fn dismiss_missed_configs(config_ids: Vec<String>) -> Result<Value, String> {
    kabegame_core::scheduler::dismiss_missed_configs(&config_ids);
    let _ = Scheduler::global().reload_config("").await;
    Ok(Value::Null)
}

pub async fn add_task(task: Value) -> Result<Value, String> {
    let task_info: TaskInfo = serde_json::from_value(task).map_err(|e| e.to_string())?;
    Storage::global().add_task(task_info.clone())?;
    let payload = serde_json::to_value(&task_info).map_err(|e| e.to_string())?;
    GlobalEmitter::global().emit_task_added(&payload);
    Ok(Value::Null)
}

pub async fn update_task(task: Value) -> Result<Value, String> {
    let task_info: TaskInfo = serde_json::from_value(task).map_err(|e| e.to_string())?;
    Storage::global().update_task(task_info)?;
    Ok(Value::Null)
}

pub async fn clear_finished_tasks() -> Result<Value, String> {
    let storage = Storage::global();
    let task_ids = storage.get_finished_task_ids()?;
    let mut all_image_ids: Vec<String> = Vec::new();
    for tid in &task_ids {
        let ids = storage.get_task_image_ids(tid)?;
        all_image_ids.extend(ids);
    }
    let count = storage.clear_finished_tasks()?;
    for tid in &task_ids {
        GlobalEmitter::global().emit_task_deleted(tid);
    }
    if !all_image_ids.is_empty() {
        let mut seen = HashSet::new();
        all_image_ids.retain(|id| seen.insert(id.clone()));
        GlobalEmitter::global().emit_images_change(
            "change",
            &all_image_ids,
            Some(&task_ids),
            None,
        );
    }
    serde_json::to_value(count).map_err(|e| e.to_string())
}

pub async fn copy_run_config(config_id: String) -> Result<Value, String> {
    let new_id = uuid::Uuid::new_v4().to_string();
    let copied = Storage::global().copy_run_config(&config_id, &new_id)?;
    let _ = Scheduler::global().reload_config(&new_id).await;
    GlobalEmitter::global().emit_auto_config_change("configadd", &copied.id);
    serde_json::to_value(copied).map_err(|e| e.to_string())
}

pub async fn get_run_config(config_id: String) -> Result<Value, String> {
    match Storage::global().get_run_config(&config_id)? {
        Some(cfg) => serde_json::to_value(cfg).map_err(|e| e.to_string()),
        None => Ok(Value::Null),
    }
}

pub async fn get_missed_runs() -> Result<Value, String> {
    let items = kabegame_core::scheduler::collect_missed_runs_now()?;
    serde_json::to_value(items).map_err(|e| e.to_string())
}
