// Daemon IPC 命令（客户端侧 wrappers）

use crate::daemon_client;
use kabegame_core::ipc::ConnectionStatus;

#[tauri::command]
pub async fn check_daemon_status() -> Result<serde_json::Value, String> {
    let client = daemon_client::get_ipc_client();
    let conn_status = client.connection_status().await;

    // 尝试获取 daemon 状态信息
    let status_result = client.status().await;

    // 构建返回结果
    let mut result = serde_json::json!({
        "status": match conn_status {
            ConnectionStatus::Disconnected => "disconnected",
            ConnectionStatus::Connecting => "connecting",
            ConnectionStatus::Connected => "connected",
        }
    });

    match status_result {
        Ok(info) => {
            result["info"] = info;
        }
        Err(e) => {
            result["error"] = serde_json::Value::String(e);
        }
    }

    Ok(result)
}

#[tauri::command]
pub async fn reconnect_daemon() -> Result<(), String> {
    // 先尝试检查 daemon 状态
    match daemon_client::try_connect_daemon().await {
        Ok(_) => {
            // daemon 已可用，发送就绪事件
            eprintln!("[reconnect_daemon] daemon 已可用");
            Ok(())
        }
        Err(_) => {
            // status 检查失败，尝试重启 daemon
            eprintln!("[reconnect_daemon] 尝试重启 daemon");
            daemon_client::ensure_daemon_ready().await
        }
    }
}

#[tauri::command]
pub async fn get_images() -> Result<serde_json::Value, String> {
    daemon_client::get_ipc_client()
        .storage_get_images()
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))
}

#[tauri::command]
pub async fn get_images_paginated(
    page: usize,
    page_size: usize,
) -> Result<serde_json::Value, String> {
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

// Moved to task.rs

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

// Moved to task.rs
