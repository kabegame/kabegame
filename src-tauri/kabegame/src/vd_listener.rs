//! 虚拟磁盘事件监听器
//!
//! 监听 EventBroadcaster 的事件，并调用 VirtualDriveService 的相应方法更新虚拟磁盘状态。

use kabegame_core::ipc::events::AppEvent;
use kabegame_core::ipc::server::EventBroadcaster;
use kabegame_core::virtual_driver::driver_service::VirtualDriveServiceTrait;
use kabegame_core::virtual_driver::VirtualDriveService;
use std::sync::Arc;

/// 启动虚拟磁盘事件监听器
///
/// 监听以下事件并触发对应操作：
/// - 画册新增 / 删除 / 移动 / 单条与批量字段补丁 → `vd_service.bump_albums()`
/// - `ImagesAdded` → 从图片行读取 task_id 通知任务目录；图片增删与字段补丁均刷新画廊树
/// - 成员增删与排序 → 按 `albumId` 通知画册目录（隐藏画册事件整体 `bump_albums()`），并 `notify_gallery_tree_changed`
/// - `TaskAdded` / `TaskDeleted` → `bump_tasks()`
#[cfg(target_os = "windows")]
pub async fn start_vd_event_listener(vd_service: Arc<VirtualDriveService>) {
    use kabegame_core::ipc::events::AppEventKind;

    // 订阅我们关心的事件类型
    let event_kinds = vec![
        AppEventKind::AlbumsAdded,
        AppEventKind::AlbumChanged,
        AppEventKind::AlbumsChange,
        AppEventKind::AlbumMoved,
        AppEventKind::AlbumsDeleted,
        AppEventKind::ImagesAdded,
        AppEventKind::ImagesDeleted,
        AppEventKind::ImagesChange,
        AppEventKind::ImageChanged,
        AppEventKind::AlbumImagesAdded,
        AppEventKind::AlbumImagesDeleted,
        AppEventKind::AlbumImagesChange,
        AppEventKind::TasksChange,
    ];

    let broadcaster = EventBroadcaster::global();
    let mut rx = broadcaster.subscribe_filtered_stream(&event_kinds);

    loop {
        match rx.recv().await {
            Some((_id, event)) => {
                match &*event {
                    AppEvent::AlbumsAdded { .. }
                    | AppEvent::AlbumsChange { .. }
                    | AppEvent::AlbumMoved { .. } => {
                        vd_service.bump_albums();
                    }
                    AppEvent::ImagesAdded { images, .. } => {
                        for tid in images
                            .iter()
                            .filter_map(|image| image.task_id.as_deref())
                            .filter(|tid| !tid.is_empty())
                        {
                            vd_service.notify_task_dir_changed(tid);
                        }
                        vd_service.notify_gallery_tree_changed();
                    }
                    AppEvent::ImagesDeleted { .. }
                    | AppEvent::ImagesChange { .. }
                    | AppEvent::ImageChanged { .. } => {
                        vd_service.notify_gallery_tree_changed();
                    }
                    AppEvent::AlbumImagesAdded { body, .. }
                    | AppEvent::AlbumImagesDeleted { body, .. }
                    | AppEvent::AlbumImagesChange { body, .. } => {
                        if body.album_id == kabegame_core::storage::HIDDEN_ALBUM_ID {
                            // 隐藏图在每个画册目录里都是隐藏文件，事件不带图片所在的其它画册，整体失效画册目录
                            vd_service.bump_albums();
                        } else {
                            vd_service.notify_album_dir_changed(&body.album_id);
                        }
                        vd_service.notify_gallery_tree_changed();
                    }
                    AppEvent::AlbumChanged { .. } => {
                        vd_service.bump_albums();
                    }
                    AppEvent::AlbumsDeleted { .. } => {
                        vd_service.bump_albums();
                    }
                    AppEvent::TaskAdded { .. } | AppEvent::TaskDeleted { .. } => {
                        vd_service.bump_tasks();
                    }
                    AppEvent::TaskChanged { .. } => {}
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
