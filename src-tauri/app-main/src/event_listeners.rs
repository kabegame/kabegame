//! 事件监听器模块
//!
//! 统一的事件转发机制：客户端注册感兴趣的事件类型，daemon 只推送这些事件。
//! 收到事件后：
//! - 如果注册了回调，则执行回调（不自动转发）
//! - 如果没有注册回调，则通过默认 emitter 自动转发到前端 Vue
//!
//! 壁纸相关事件（WallpaperUpdateImage/Style/Transition）被拦截处理，不再转发到前端。

use kabegame_core::ipc::events::{get_global_listener, DaemonEventKind};
use kabegame_core::ipc::start_listening;
use serde::Deserialize;
use tauri::{AppHandle, Emitter};

/// 定义 app-main 不需要的事件（排除列表）
/// 例如 DownloadProgress 太频繁，main 不需要
const EXCLUDED_EVENTS: &[DaemonEventKind] = &[
    // 可以在这里添加不需要的事件类型
    // DaemonEventKind::DownloadProgress, // 如果不需要下载进度事件
];

/// 壁纸图片更新事件 payload
#[derive(Debug, Deserialize)]
struct WallpaperUpdateImagePayload {
    image_path: String,
}

/// 壁纸样式更新事件 payload
#[derive(Debug, Deserialize)]
struct WallpaperUpdateStylePayload {
    style: String,
}

/// 壁纸过渡效果更新事件 payload
#[derive(Debug, Deserialize)]
struct WallpaperUpdateTransitionPayload {
    transition: String,
}

/// 初始化事件监听器（在 Tauri 应用启动时调用）
pub async fn init_event_listeners(app: AppHandle) {
    // 计算感兴趣的事件 = ALL - EXCLUDED
    let interested: Vec<DaemonEventKind> = DaemonEventKind::ALL
        .iter()
        .filter(|k| !EXCLUDED_EVENTS.contains(k))
        .copied()
        .collect();

    eprintln!(
        "[event_listeners] app-main 感兴趣的事件类型: {:?}",
        interested
    );

    let listener = get_global_listener();

    // 设置默认 emitter：无回调时自动转发到前端
    let app_clone = app.clone();
    listener
        .set_default_emitter(move |event_name, payload| {
            let _ = app_clone.emit(event_name, payload);
        })
        .await;

    // 注册壁纸相关事件回调（拦截处理，不转发到前端）

    // 注册壁纸相关事件回调（拦截处理，不转发到前端）

    // WallpaperUpdateImage: 更新壁纸图片
    listener
        .on(DaemonEventKind::WallpaperUpdateImage, move |payload| {
            if let Ok(event) = serde_json::from_value::<WallpaperUpdateImagePayload>(payload) {
                let controller = crate::wallpaper::WallpaperController::global();
                tauri::async_runtime::spawn(async move {
                    // 获取当前样式和过渡效果
                    let style = kabegame_core::settings::Settings::global()
                        .get_wallpaper_rotation_style()
                        .await
                        .unwrap_or_else(|_| "fill".to_string());

                    // 设置壁纸
                    if let Err(e) = controller.set_wallpaper(&event.image_path, &style).await {
                        eprintln!("[event_listeners] 设置壁纸失败: {}", e);
                    }
                });
            }
        })
        .await;

    // WallpaperUpdateStyle: 更新壁纸样式
    listener
        .on(DaemonEventKind::WallpaperUpdateStyle, move |payload| {
            if let Ok(event) = serde_json::from_value::<WallpaperUpdateStylePayload>(payload) {
                let controller = crate::wallpaper::WallpaperController::global();
                tauri::async_runtime::spawn(async move {
                    if let Ok(manager) = controller.active_manager().await {
                        if let Err(e) = manager.set_style(&event.style, true).await {
                            eprintln!("[event_listeners] 设置壁纸样式失败: {}", e);
                        }
                    }
                });
            }
        })
        .await;

    // WallpaperUpdateTransition: 更新壁纸过渡效果
    listener
        .on(DaemonEventKind::WallpaperUpdateTransition, move |payload| {
            if let Ok(event) = serde_json::from_value::<WallpaperUpdateTransitionPayload>(payload) {
                let controller = crate::wallpaper::WallpaperController::global();
                tauri::async_runtime::spawn(async move {
                    if let Ok(manager) = controller.active_manager().await {
                        if let Err(e) = manager.set_transition(&event.transition, true).await {
                            eprintln!("[event_listeners] 设置壁纸过渡效果失败: {}", e);
                        }
                    }
                });
            }
        })
        .await;

    // 启动事件监听（只订阅感兴趣的事件）
    if let Err(e) = start_listening(&interested).await {
        eprintln!("Failed to start event listener: {}", e);
    }
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
