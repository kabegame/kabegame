//! 前端事件监听集成示例
//!
//! 展示如何在 Tauri 前端中使用统一的事件监听 API

use kabegame_core::ipc::{on_task_log, on_download_state, on_task_status, start_listening};
use kabegame_core::ipc::events::{get_global_listener, DaemonEvent};
use tauri::{AppHandle, Emitter};

/// 初始化事件监听器（在 Tauri 应用启动时调用）
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
        let _ = app_for_task_log.emit("task-log", serde_json::json!({
            "taskId": task_id,
            "level": level,
            "message": message,
        }));
    }).await;

    // 监听下载状态
    let app_for_download_state = app.clone();
    on_download_state(move |event| {
        let _ = app_for_download_state.emit("download-state", serde_json::json!({
            "taskId": event.task_id,
            "url": event.url,
            "startTime": event.start_time,
            "pluginId": event.plugin_id,
            "state": event.state,
            "error": event.error,
        }));
    }).await;

    // 监听任务状态
    let app_for_task_status = app.clone();
    on_task_status(move |event| {
        let _ = app_for_task_status.emit("task-status", serde_json::json!({
            "taskId": event.task_id,
            "status": event.status,
            "progress": event.progress,
            "error": event.error,
            "currentWallpaper": event.current_wallpaper,
        }));
    }).await;

    // 启动事件监听（每 500ms 轮询一次）
    if let Err(e) = start_listening(500).await {
        eprintln!("Failed to start event listener: {}", e);
    }
}

// ==================== Tauri 命令示例 ====================

/// Tauri 命令：手动触发事件监听
#[tauri::command]
pub async fn start_event_listener() -> Result<(), String> {
    start_listening(500).await
}

/// Tauri 命令：停止事件监听
#[tauri::command]
pub async fn stop_event_listener() -> Result<(), String> {
    kabegame_core::ipc::stop_listening().await;
    Ok(())
}

// ==================== Vue/TypeScript 使用示例 ====================

/*
// 在 Vue 组件中监听事件：

<script setup lang="ts">
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/tauri';
import { onMounted, onUnmounted } from 'vue';

let unlistenTaskLog: (() => void) | null = null;
let unlistenDownloadState: (() => void) | null = null;
let unlistenTaskStatus: (() => void) | null = null;

onMounted(async () => {
  // 启动事件监听
  await invoke('start_event_listener');

  // 监听任务日志
  unlistenTaskLog = await listen('task-log', (event) => {
    const { taskId, level, message } = event.payload;
    console.log(`[${taskId}] ${level}: ${message}`);
  });

  // 监听下载状态
  unlistenDownloadState = await listen('download-state', (event) => {
    const { url, state } = event.payload;
    console.log(`Download ${url}: ${state}`);
  });

  // 监听任务状态
  unlistenTaskStatus = await listen('task-status', (event) => {
    const { taskId, status, progress } = event.payload;
    console.log(`Task ${taskId}: ${status} (${progress}%)`);
  });
});

onUnmounted(async () => {
  // 停止事件监听
  await invoke('stop_event_listener');
  
  // 清理监听器
  unlistenTaskLog?.();
  unlistenDownloadState?.();
  unlistenTaskStatus?.();
});
</script>
*/
