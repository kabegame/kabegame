//! 事件监听器模块
//!
//! plugin-editor 只需要部分事件（主要是任务相关的），统一转发到前端 Vue。
//! 使用默认 emitter 自动转发所有事件到前端。

use kabegame_core::ipc::events::get_global_listener;
use kabegame_core::ipc::start_listening;
use kabegame_core::ipc::DaemonEventKind;
use tauri::{AppHandle, Emitter};

/// 定义 plugin-editor 感兴趣的事件类型
/// plugin-editor 主要关注任务相关的事件
const INTERESTED_EVENTS: &[DaemonEventKind] = &[
    DaemonEventKind::TaskLog,
    DaemonEventKind::TaskStatus,
    DaemonEventKind::TaskProgress,
    DaemonEventKind::TaskError,
    DaemonEventKind::DownloadState,
    DaemonEventKind::Generic, // 用于 images-change 等通用事件
];

/// 初始化事件监听器（在 Tauri 应用启动时调用）
pub async fn init_event_listeners(app: AppHandle) {
    eprintln!(
        "[event_listeners] plugin-editor 感兴趣的事件类型: {:?}",
        INTERESTED_EVENTS
    );

    let listener = get_global_listener();

    // 设置默认 emitter：自动转发所有事件到前端
    let app_clone = app.clone();
    listener
        .set_default_emitter(move |event_name, payload| {
            let _ = app_clone.emit(event_name, payload);
        })
        .await;

    // 启动事件监听（只订阅感兴趣的事件）
    // 由于没有注册任何回调，所有事件都会通过默认 emitter 转发到前端
    if let Err(e) = start_listening(INTERESTED_EVENTS).await {
        eprintln!("Failed to start event listener: {}", e);
    }
}
