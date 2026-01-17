//! 事件监听器初始化模块
//!
//! 将 daemon IPC 事件转发为 Tauri 事件，供 GUI 应用使用。
//!
//! # 使用方法
//!
//! 在 Tauri 应用的 setup 阶段调用：
//!
//! ```ignore
//! let app_handle = app.app_handle().clone();
//! tauri::async_runtime::spawn(async move {
//!     kabegame_core::ipc::init_event_listeners(app_handle).await;
//! });
//! ```

use super::events::{get_global_listener, DaemonEvent};
use super::{on_download_state, on_task_log, on_task_status, start_listening};
use tauri::{AppHandle, Emitter};

/// 初始化事件监听器（在 Tauri 应用启动时调用）
///
/// 该函数会：
/// 1. 订阅 daemon 的 IPC 事件（task-log, task-status, download-state, generic）
/// 2. 将这些事件转发为 Tauri 事件（供前端 JS 监听）
/// 3. 启动长连接事件监听（持续接收服务器推送的事件）
pub async fn init_event_listeners(app: AppHandle) {
    // 转发通用事件（Generic）：允许 daemon 发送任意事件名给前端
    // 例如：dedupe-progress / dedupe-finished / images-removed / images-deleted
    {
        let app_for_generic = app.clone();
        get_global_listener()
            .on(move |event| {
                if let DaemonEvent::Generic { event, payload } = event {
                    let _ = app_for_generic.emit(&event, payload);
                }
            })
            .await;
    }

    // 监听任务日志
    let app_for_task_log = app.clone();
    on_task_log(move |task_id, level, message| {
        // 转发到前端
        let _ = app_for_task_log.emit(
            "task-log",
            serde_json::json!({
                "taskId": task_id,
                "level": level,
                "message": message,
            }),
        );
    })
    .await;

    // 监听下载状态
    let app_for_download_state = app.clone();
    on_download_state(move |event| {
        let _ = app_for_download_state.emit(
            "download-state",
            serde_json::json!({
                "taskId": event.task_id,
                "url": event.url,
                "startTime": event.start_time,
                "pluginId": event.plugin_id,
                "state": event.state,
                "error": event.error,
            }),
        );
    })
    .await;

    // 监听任务状态
    let app_for_task_status = app.clone();
    on_task_status(move |event| {
        let _ = app_for_task_status.emit(
            "task-status",
            serde_json::json!({
                "taskId": event.task_id,
                "status": event.status,
                "progress": event.progress,
                "error": event.error,
                "currentWallpaper": event.current_wallpaper,
            }),
        );
    })
    .await;

    // 启动事件监听（长连接模式）
    if let Err(e) = start_listening().await {
        eprintln!("Failed to start event listener: {}", e);
    }
}

/// Tauri 命令：手动触发事件监听
#[tauri::command]
pub async fn start_event_listener() -> Result<(), String> {
    start_listening().await
}

/// Tauri 命令：停止事件监听
#[tauri::command]
pub async fn stop_event_listener() -> Result<(), String> {
    super::stop_listening().await;
    Ok(())
}
