//! 虚拟磁盘事件监听器
//!
//! 监听 EventBroadcaster 的事件，并调用 VirtualDriveService 的相应方法更新虚拟磁盘状态。

use kabegame_core::ipc::events::DaemonEvent;
use kabegame_core::ipc::server::EventBroadcaster;
use kabegame_core::virtual_driver::driver_service::VirtualDriveServiceTrait;
use kabegame_core::virtual_driver::VirtualDriveService;
use std::sync::Arc;

/// 启动虚拟磁盘事件监听器
///
/// 监听以下事件并触发对应操作：
/// - `AlbumAdded` / `AlbumChanged` / `AlbumDeleted` → `vd_service.bump_albums()`
/// - `ImagesChange` → 按 `task_ids` 通知任务目录，并 `notify_gallery_tree_changed`
/// - `AlbumImagesChange` → 按 `album_ids` 通知画册目录，并 `notify_gallery_tree_changed`
/// - `TaskAdded` / `TaskDeleted` → `bump_tasks()`
#[cfg(target_os = "windows")]
pub async fn start_vd_event_listener(vd_service: Arc<VirtualDriveService>) {
    use kabegame_core::ipc::events::DaemonEventKind;

    // 订阅我们关心的事件类型
    let event_kinds = vec![
        DaemonEventKind::AlbumAdded,
        DaemonEventKind::AlbumChanged,
        DaemonEventKind::AlbumDeleted,
        DaemonEventKind::ImagesChange,
        DaemonEventKind::AlbumImagesChange,
        DaemonEventKind::TasksChange,
    ];

    let broadcaster = EventBroadcaster::global();
    let mut rx = broadcaster.subscribe_filtered_stream(&event_kinds);

    loop {
        match rx.recv().await {
            Some((_id, event)) => {
                match &*event {
                    DaemonEvent::AlbumAdded { .. } => {
                        vd_service.bump_albums();
                    }
                    DaemonEvent::ImagesChange { task_ids, .. } => {
                        if let Some(ids) = task_ids {
                            for tid in ids {
                                if !tid.is_empty() {
                                    vd_service.notify_task_dir_changed(&tid);
                                }
                            }
                        }
                        vd_service.notify_gallery_tree_changed();
                    }
                    DaemonEvent::AlbumImagesChange { album_ids, .. } => {
                        for aid in album_ids {
                            if !aid.is_empty() {
                                vd_service.notify_album_dir_changed(&aid);
                            }
                        }
                        vd_service.notify_gallery_tree_changed();
                    }
                    DaemonEvent::AlbumChanged { .. } => {
                        vd_service.bump_albums();
                    }
                    DaemonEvent::AlbumDeleted { .. } => {
                        vd_service.bump_albums();
                    }
                    DaemonEvent::TaskAdded { .. } | DaemonEvent::TaskDeleted { .. } => {
                        vd_service.bump_tasks();
                    }
                    DaemonEvent::TaskChanged { .. } => {}
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
