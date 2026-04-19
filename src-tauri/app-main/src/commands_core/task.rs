use kabegame_core::storage::Storage;
use serde_json::Value;

pub async fn get_tasks_page(limit: u32, offset: u32) -> Result<Value, String> {
    let (tasks, total) = Storage::global().get_tasks_page(limit, offset)?;
    serde_json::to_value(serde_json::json!({ "tasks": tasks, "total": total }))
        .map_err(|e| e.to_string())
}

pub async fn get_task(task_id: String) -> Result<Value, String> {
    let task = Storage::global().get_task(&task_id)?;
    serde_json::to_value(task).map_err(|e| e.to_string())
}
