//! 虚拟磁盘事件监听器
//!
//! 监听 EventBroadcaster 的事件，并调用 VirtualDriveService 的相应方法更新虚拟磁盘状态。

use crate::server::EventBroadcaster;
use kabegame_core::ipc::events::DaemonEvent;
use kabegame_core::storage::Storage;
use kabegame_core::virtual_driver::driver_service::VirtualDriveServiceTrait;
use kabegame_core::virtual_driver::VirtualDriveService;
use std::sync::Arc;

/// 启动虚拟磁盘事件监听器
///
/// 监听以下事件并触发对应操作：
/// - `AlbumAdded` → `vd_service.bump_albums()`
/// - `ImagesChange` → 根据 payload 调用 `notify_album_dir_changed` 或 `notify_gallery_tree_changed`
/// - `Generic` 事件中的 `albums-changed` → `bump_albums()`
/// - `Generic` 事件中的 `tasks-changed` → `bump_tasks()`
/// - `Generic` 事件中的 `images-change` → 根据 payload 处理
#[cfg(all(not(kabegame_mode = "light"), target_os = "windows"))]
pub async fn start_vd_event_listener(
    broadcaster: Arc<EventBroadcaster>,
    vd_service: Arc<VirtualDriveService>,
) {
    use kabegame_core::ipc::events::DaemonEventKind;

    // 订阅我们关心的事件类型
    let event_kinds = vec![
        DaemonEventKind::AlbumAdded,
        DaemonEventKind::ImagesChange,
        DaemonEventKind::Generic,
    ];

    let mut rx = broadcaster.subscribe_filtered_stream(&event_kinds);

    loop {
        match rx.recv().await {
            Some((_id, event)) => {
                match &event {
                    DaemonEvent::AlbumAdded { .. } => {
                        vd_service.bump_albums();
                    }
                    DaemonEvent::ImagesChange { reason, image_ids } => {
                        // ImagesChange 事件通常需要刷新整个 gallery 树
                        vd_service.notify_gallery_tree_changed();
                    }
                    DaemonEvent::Generic { event, payload } => {
                        match event.as_str() {
                            "albums-changed" => {
                                vd_service.bump_albums();
                            }
                            "tasks-changed" => {
                                vd_service.bump_tasks();
                            }
                            "images-change" => {
                                // 解析 payload，提取 albumId 和 taskId
                                let album_id = payload
                                    .get("albumId")
                                    .and_then(|v| v.as_str())
                                    .map(|s| s.to_string());
                                let task_id = payload
                                    .get("taskId")
                                    .and_then(|v| v.as_str())
                                    .map(|s| s.to_string());

                                let storage = Storage::global();

                                // 如果有 taskId，通知任务目录变更
                                if let Some(tid) = &task_id {
                                    if !tid.is_empty() {
                                        vd_service.notify_task_dir_changed(storage, tid);
                                    }
                                }

                                // 如果有 albumId，通知画册目录变更
                                if let Some(aid) = &album_id {
                                    if !aid.is_empty() {
                                        vd_service.notify_album_dir_changed(storage, aid);
                                    }
                                }

                                // 总是刷新 gallery 树
                                vd_service.notify_gallery_tree_changed();
                            }
                            _ => {
                                // 忽略其他 Generic 事件
                            }
                        }
                    }
                    _ => {
                        // 忽略其他事件类型
                    }
                }
            }
            None => {
                break;
            }
        }
    }
}

/// 非 Windows 或未启用 virtual-driver feature 时的空实现
#[cfg(not(all(not(kabegame_mode = "light"), target_os = "windows")))]
pub async fn start_vd_event_listener(
    _broadcaster: Arc<EventBroadcaster>,
    _vd_service: Arc<VirtualDriveService>,
) {
    // 空实现：非 Windows 或未启用 virtual-driver feature 时不做任何事
}
