use crate::emitter::GlobalEmitter;
use crate::scheduler::Scheduler;
use crate::storage::{RunConfig, Storage, TaskInfo, TaskStatus};
use serde_json::Value;
use std::collections::HashSet;

pub fn get_run_configs() -> Result<Value, String> {
    let configs = Storage::global().get_run_configs()?;
    serde_json::to_value(configs).map_err(|e| e.to_string())
}

pub fn get_all_tasks() -> Result<Value, String> {
    let tasks = Storage::global().get_all_tasks()?;
    serde_json::to_value(tasks).map_err(|e| e.to_string())
}

pub fn get_tasks_page(limit: u32, offset: u32) -> Result<Value, String> {
    let (tasks, total) = Storage::global().get_tasks_page(limit, offset)?;
    serde_json::to_value(serde_json::json!({ "tasks": tasks, "total": total }))
        .map_err(|e| e.to_string())
}

pub fn get_task(task_id: String) -> Result<Value, String> {
    let task = Storage::global().get_task(&task_id)?;
    serde_json::to_value(task).map_err(|e| e.to_string())
}

pub fn get_task_logs(task_id: String) -> Result<Value, String> {
    let logs = Storage::global().get_task_logs(&task_id)?;
    serde_json::to_value(logs).map_err(|e| e.to_string())
}

pub fn get_task_failed_images(task_id: String) -> Result<Value, String> {
    let images = Storage::get_task_failed_images(&task_id)?;
    serde_json::to_value(images).map_err(|e| e.to_string())
}

pub fn get_all_failed_images() -> Result<Value, String> {
    let images = Storage::get_all_failed_images()?;
    serde_json::to_value(images).map_err(|e| e.to_string())
}

pub async fn get_active_downloads() -> Result<Value, String> {
    use crate::crawler::TaskScheduler;
    let downloads = TaskScheduler::global().get_active_downloads().await?;
    serde_json::to_value(downloads).map_err(|e| e.to_string())
}

pub async fn start_task(task: Value) -> Result<String, String> {
    use std::collections::HashMap;

    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct StartTaskParams {
        plugin_id: String,
        output_dir: Option<String>,
        user_config: Option<HashMap<String, Value>>,
        #[serde(default)]
        http_headers: Option<HashMap<String, String>>,
        output_album_id: Option<String>,
        plugin_file_path: Option<String>,
        run_config_id: Option<String>,
        #[serde(default = "default_trigger_source")]
        trigger_source: String,
    }

    fn default_trigger_source() -> String {
        "manual".to_string()
    }

    let p: StartTaskParams = serde_json::from_value(task).map_err(|e| e.to_string())?;

    let task_id = uuid::Uuid::new_v4().to_string();
    let images_dir =
        crate::crawler::downloader::resolve_crawl_output_dir(p.output_dir.as_deref());
    let output_dir = Some(images_dir.to_string_lossy().into_owned());

    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;

    let t = TaskInfo {
        id: task_id.clone(),
        plugin_id: p.plugin_id,
        output_dir,
        user_config: p.user_config,
        http_headers: p.http_headers,
        output_album_id: p.output_album_id,
        run_config_id: p.run_config_id,
        trigger_source: p.trigger_source,
        status: TaskStatus::Pending,
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

    let req = crate::crawler::CrawlTaskRequest {
        task_id: task_id.clone(),
        plugin_file_path: p.plugin_file_path,
    };
    crate::crawler::TaskScheduler::global()
        .submit_task(req)
        .await?;
    Ok(task_id)
}

pub async fn cancel_task(task_id: String) -> Result<Value, String> {
    use crate::crawler::TaskScheduler;
    TaskScheduler::global().cancel_task(&task_id).await;
    Ok(Value::Null)
}

pub fn delete_task(task_id: String) -> Result<Value, String> {
    let storage = Storage::global();
    let image_ids = Storage::get_task_image_ids(&task_id)?;
    let plugin_ids = storage
        .get_task(&task_id)?
        .map(|t| vec![t.plugin_id])
        .unwrap_or_default();
    storage.delete_task(&task_id)?;
    GlobalEmitter::global().emit_task_deleted(&task_id);
    if !image_ids.is_empty() {
        let tids = vec![task_id];
        GlobalEmitter::global().emit_images_change(
            "change",
            &image_ids,
            Some(&tids),
            None,
            Some(&plugin_ids),
        );
    }
    Ok(Value::Null)
}

pub async fn retry_task_failed_image(failed_id: i64) -> Result<Value, String> {
    use crate::crawler::TaskScheduler;
    TaskScheduler::global()
        .retry_failed_image(failed_id)
        .await?;
    Ok(Value::Null)
}

pub async fn retry_failed_images(ids: Vec<i64>) -> Result<Value, String> {
    use crate::crawler::TaskScheduler;
    let started = TaskScheduler::global().retry_failed_images(&ids).await?;
    serde_json::to_value(started).map_err(|e| e.to_string())
}

pub async fn cancel_retry_failed_image(failed_id: i64) -> Result<Value, String> {
    use crate::crawler::TaskScheduler;
    TaskScheduler::global()
        .cancel_retry_failed_image(failed_id)
        .await;
    Ok(Value::Null)
}

pub async fn cancel_retry_failed_images(ids: Vec<i64>) -> Result<Value, String> {
    use crate::crawler::TaskScheduler;
    TaskScheduler::global()
        .cancel_retry_failed_images(&ids)
        .await;
    Ok(Value::Null)
}

pub async fn delete_failed_images(ids: Vec<i64>) -> Result<Value, String> {
    use crate::crawler::TaskScheduler;
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

pub fn delete_task_failed_image(failed_id: i64) -> Result<Value, String> {
    let storage = Storage::global();
    let task_id = Storage::get_task_failed_image_by_id(failed_id)?.map(|item| item.task_id);
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
    crate::scheduler::run_missed_configs(&config_ids);
    let _ = Scheduler::global().reload_config("").await;
    Ok(Value::Null)
}

pub async fn dismiss_missed_configs(config_ids: Vec<String>) -> Result<Value, String> {
    crate::scheduler::dismiss_missed_configs(&config_ids);
    let _ = Scheduler::global().reload_config("").await;
    Ok(Value::Null)
}

pub fn add_task(task: Value) -> Result<Value, String> {
    let task_info: TaskInfo = serde_json::from_value(task).map_err(|e| e.to_string())?;
    Storage::global().add_task(task_info.clone())?;
    let payload = serde_json::to_value(&task_info).map_err(|e| e.to_string())?;
    GlobalEmitter::global().emit_task_added(&payload);
    Ok(Value::Null)
}

pub fn clear_finished_tasks() -> Result<Value, String> {
    let storage = Storage::global();
    let task_ids = storage.get_finished_task_ids()?;
    let mut all_image_ids: Vec<String> = Vec::new();
    for tid in &task_ids {
        let ids = Storage::get_task_image_ids(tid)?;
        all_image_ids.extend(ids);
    }
    let mut plugin_seen = HashSet::new();
    let plugin_ids: Vec<String> = task_ids
        .iter()
        .filter_map(|tid| storage.get_task(tid).ok().flatten().map(|t| t.plugin_id))
        .filter(|pid| plugin_seen.insert(pid.clone()))
        .collect();
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
            Some(&plugin_ids),
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

pub fn get_run_config(config_id: String) -> Result<Value, String> {
    match Storage::global().get_run_config(&config_id)? {
        Some(cfg) => serde_json::to_value(cfg).map_err(|e| e.to_string()),
        None => Ok(Value::Null),
    }
}

pub fn get_missed_runs() -> Result<Value, String> {
    let items = crate::scheduler::collect_missed_runs_now()?;
    serde_json::to_value(items).map_err(|e| e.to_string())
}
