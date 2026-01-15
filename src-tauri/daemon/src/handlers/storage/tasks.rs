//! Tasks 表相关操作

use kabegame_core::ipc::ipc::CliIpcResponse;
use kabegame_core::storage::Storage;
use std::sync::Arc;

pub async fn get_all_tasks(storage: Arc<Storage>) -> CliIpcResponse {
    match storage.get_all_tasks() {
        Ok(tasks) => {
            CliIpcResponse::ok_with_data("ok", serde_json::to_value(tasks).unwrap_or_default())
        }
        Err(e) => CliIpcResponse::err(e),
    }
}

pub async fn get_task(storage: Arc<Storage>, task_id: &str) -> CliIpcResponse {
    match storage.get_task(task_id) {
        Ok(task) => {
            CliIpcResponse::ok_with_data("ok", serde_json::to_value(task).unwrap_or_default())
        }
        Err(e) => CliIpcResponse::err(e),
    }
}

pub async fn add_task(storage: Arc<Storage>, task: &serde_json::Value) -> CliIpcResponse {
    match serde_json::from_value::<kabegame_core::storage::TaskInfo>(task.clone()) {
        Ok(task) => match storage.add_task(task) {
            Ok(()) => CliIpcResponse::ok("added"),
            Err(e) => CliIpcResponse::err(e),
        },
        Err(e) => CliIpcResponse::err(format!("Invalid task data: {}", e)),
    }
}

pub async fn update_task(storage: Arc<Storage>, task: &serde_json::Value) -> CliIpcResponse {
    match serde_json::from_value::<kabegame_core::storage::TaskInfo>(task.clone()) {
        Ok(task) => match storage.update_task(task) {
            Ok(()) => CliIpcResponse::ok("updated"),
            Err(e) => CliIpcResponse::err(e),
        },
        Err(e) => CliIpcResponse::err(format!("Invalid task data: {}", e)),
    }
}

pub async fn delete_task(storage: Arc<Storage>, task_id: &str) -> CliIpcResponse {
    match storage.delete_task(task_id) {
        Ok(()) => CliIpcResponse::ok("deleted"),
        Err(e) => CliIpcResponse::err(e),
    }
}

pub async fn get_task_images(storage: Arc<Storage>, task_id: &str) -> CliIpcResponse {
    match storage.get_task_images(task_id) {
        Ok(images) => CliIpcResponse::ok_with_data(
            "ok",
            serde_json::to_value(images).unwrap_or_default(),
        ),
        Err(e) => CliIpcResponse::err(e),
    }
}

pub async fn get_task_image_ids(storage: Arc<Storage>, task_id: &str) -> CliIpcResponse {
    match storage.get_task_image_ids(task_id) {
        Ok(ids) => CliIpcResponse::ok_with_data("ok", serde_json::to_value(ids).unwrap_or_default()),
        Err(e) => CliIpcResponse::err(e),
    }
}

pub async fn get_task_images_paginated(
    storage: Arc<Storage>,
    task_id: &str,
    offset: usize,
    limit: usize,
) -> CliIpcResponse {
    let images = match storage.get_task_images_paginated(task_id, offset, limit) {
        Ok(v) => v,
        Err(e) => return CliIpcResponse::err(e),
    };
    let total = match storage.get_task_image_ids(task_id) {
        Ok(ids) => ids.len(),
        Err(e) => return CliIpcResponse::err(e),
    };
    CliIpcResponse::ok_with_data(
        "ok",
        serde_json::json!({
            "images": images,
            "total": total,
            "offset": offset,
            "limit": limit,
        }),
    )
}

pub async fn get_task_failed_images(storage: Arc<Storage>, task_id: &str) -> CliIpcResponse {
    match storage.get_task_failed_images(task_id) {
        Ok(images) => CliIpcResponse::ok_with_data(
            "ok",
            serde_json::to_value(images).unwrap_or_default(),
        ),
        Err(e) => CliIpcResponse::err(e),
    }
}

pub async fn confirm_task_rhai_dump(storage: Arc<Storage>, task_id: &str) -> CliIpcResponse {
    match storage.confirm_task_rhai_dump(task_id) {
        Ok(()) => CliIpcResponse::ok("ok"),
        Err(e) => CliIpcResponse::err(e),
    }
}

pub async fn clear_finished_tasks(storage: Arc<Storage>) -> CliIpcResponse {
    match storage.clear_finished_tasks() {
        Ok(n) => CliIpcResponse::ok_with_data("ok", serde_json::to_value(n).unwrap_or_default()),
        Err(e) => CliIpcResponse::err(e),
    }
}

pub async fn get_tasks_with_images(storage: Arc<Storage>) -> CliIpcResponse {
    match storage.get_tasks_with_images() {
        Ok(v) => CliIpcResponse::ok_with_data("ok", serde_json::to_value(v).unwrap_or_default()),
        Err(e) => CliIpcResponse::err(e),
    }
}
