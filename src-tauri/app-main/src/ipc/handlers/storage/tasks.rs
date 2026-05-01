//! Tasks 表相关操作

use kabegame_core::ipc::ipc::IpcResponse;
use kabegame_core::storage::Storage;

pub async fn get_all_tasks() -> IpcResponse {
    let storage = Storage::global();
    match storage.get_all_tasks() {
        Ok(tasks) => {
            IpcResponse::ok_with_data("ok", serde_json::to_value(tasks).unwrap_or_default())
        }
        Err(e) => IpcResponse::err(e),
    }
}

pub async fn get_task(task_id: &str) -> IpcResponse {
    let storage = Storage::global();
    match storage.get_task(task_id) {
        Ok(task) => IpcResponse::ok_with_data("ok", serde_json::to_value(task).unwrap_or_default()),
        Err(e) => IpcResponse::err(e),
    }
}

pub async fn add_task(task: &serde_json::Value) -> IpcResponse {
    let storage = Storage::global();
    match serde_json::from_value::<kabegame_core::storage::TaskInfo>(task.clone()) {
        Ok(task) => match storage.add_task(task) {
            Ok(()) => IpcResponse::ok("added"),
            Err(e) => IpcResponse::err(e),
        },
        Err(e) => IpcResponse::err(format!("Invalid task data: {}", e)),
    }
}

pub async fn update_task(task: &serde_json::Value) -> IpcResponse {
    let storage = Storage::global();
    match serde_json::from_value::<kabegame_core::storage::TaskInfo>(task.clone()) {
        Ok(task) => match storage.update_task(task) {
            Ok(()) => IpcResponse::ok("updated"),
            Err(e) => IpcResponse::err(e),
        },
        Err(e) => IpcResponse::err(format!("Invalid task data: {}", e)),
    }
}

pub async fn delete_task(task_id: &str) -> IpcResponse {
    let storage = Storage::global();
    match storage.delete_task(task_id) {
        Ok(()) => IpcResponse::ok("deleted"),
        Err(e) => IpcResponse::err(e),
    }
}

pub async fn get_task_image_ids(task_id: &str) -> IpcResponse {
    let storage = Storage::global();
    match storage.get_task_image_ids(task_id) {
        Ok(ids) => IpcResponse::ok_with_data("ok", serde_json::to_value(ids).unwrap_or_default()),
        Err(e) => IpcResponse::err(e),
    }
}

pub async fn get_task_failed_images(task_id: &str) -> IpcResponse {
    let storage = Storage::global();
    match storage.get_task_failed_images(task_id) {
        Ok(images) => {
            IpcResponse::ok_with_data("ok", serde_json::to_value(images).unwrap_or_default())
        }
        Err(e) => IpcResponse::err(e),
    }
}

pub async fn get_all_failed_images() -> IpcResponse {
    let storage = Storage::global();
    match storage.get_all_failed_images() {
        Ok(images) => {
            IpcResponse::ok_with_data("ok", serde_json::to_value(images).unwrap_or_default())
        }
        Err(e) => IpcResponse::err(e),
    }
}

pub async fn clear_finished_tasks() -> IpcResponse {
    let storage = Storage::global();
    match storage.clear_finished_tasks() {
        Ok(n) => IpcResponse::ok_with_data("ok", serde_json::to_value(n).unwrap_or_default()),
        Err(e) => IpcResponse::err(e),
    }
}

pub async fn get_tasks_with_images() -> IpcResponse {
    let storage = Storage::global();
    match storage.get_tasks_with_images() {
        Ok(v) => IpcResponse::ok_with_data("ok", serde_json::to_value(v).unwrap_or_default()),
        Err(e) => IpcResponse::err(e),
    }
}
