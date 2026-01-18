//! Storage 命令处理器模块

pub mod images;
pub mod albums;
pub mod tasks;
pub mod run_configs;

use kabegame_core::ipc::ipc::{CliIpcRequest, CliIpcResponse};
use kabegame_core::ipc::EventBroadcaster;
use kabegame_core::storage::Storage;
use std::sync::Arc;

/// 处理所有 Storage 相关的 IPC 请求
pub async fn handle_storage_request(
    req: &CliIpcRequest,
    storage: Arc<Storage>,
    broadcaster: Arc<EventBroadcaster>,
) -> Option<CliIpcResponse> {
    match req {
        // Images
        CliIpcRequest::StorageGetImages => Some(images::get_images(storage).await),
        CliIpcRequest::StorageGetImagesPaginated { page, page_size } => {
            Some(images::get_images_paginated(storage, *page, *page_size).await)
        }
        CliIpcRequest::StorageGetImagesCount => Some(images::get_images_count(storage).await),
        CliIpcRequest::StorageGetImageById { image_id } => {
            Some(images::get_image_by_id(storage, image_id).await)
        }
        CliIpcRequest::StorageFindImageByPath { path } => {
            Some(images::find_image_by_path(storage, path).await)
        }
        CliIpcRequest::StorageDeleteImage { image_id } => {
            Some(images::delete_image(storage, broadcaster, image_id).await)
        }
        CliIpcRequest::StorageRemoveImage { image_id } => {
            Some(images::remove_image(storage, broadcaster, image_id).await)
        }
        CliIpcRequest::StorageBatchDeleteImages { image_ids } => {
            Some(images::batch_delete_images(storage, broadcaster, image_ids).await)
        }
        CliIpcRequest::StorageBatchRemoveImages { image_ids } => {
            Some(images::batch_remove_images(storage, broadcaster, image_ids).await)
        }
        CliIpcRequest::StorageToggleImageFavorite { image_id, favorite } => {
            Some(images::toggle_image_favorite(storage, broadcaster, image_id, *favorite).await)
        }

        // Albums
        CliIpcRequest::StorageGetAlbums => Some(albums::get_albums(storage).await),
        CliIpcRequest::StorageAddAlbum { name } => {
            Some(albums::add_album(storage, name).await)
        }
        CliIpcRequest::StorageDeleteAlbum { album_id } => {
            Some(albums::delete_album(storage, album_id).await)
        }
        CliIpcRequest::StorageRenameAlbum { album_id, new_name } => {
            Some(albums::rename_album(storage, album_id, new_name).await)
        }
        CliIpcRequest::StorageAddImagesToAlbum { album_id, image_ids } => {
            Some(albums::add_images_to_album(storage, album_id, image_ids).await)
        }
        CliIpcRequest::StorageRemoveImagesFromAlbum { album_id, image_ids } => {
            Some(albums::remove_images_from_album(storage, album_id, image_ids).await)
        }
        CliIpcRequest::StorageGetAlbumImages { album_id } => {
            Some(albums::get_album_images(storage, album_id).await)
        }
        CliIpcRequest::StorageGetAlbumPreview { album_id, limit } => {
            Some(albums::get_album_preview(storage, album_id, *limit).await)
        }
        CliIpcRequest::StorageGetAlbumCounts => Some(albums::get_album_counts(storage).await),
        CliIpcRequest::StorageUpdateAlbumImagesOrder { album_id, image_orders } => {
            Some(albums::update_album_images_order(storage, album_id, image_orders).await)
        }
        CliIpcRequest::StorageGetAlbumImageIds { album_id } => {
            Some(albums::get_album_image_ids(storage, album_id).await)
        }

        // Tasks
        CliIpcRequest::StorageGetAllTasks => Some(tasks::get_all_tasks(storage).await),
        CliIpcRequest::StorageGetTask { task_id } => {
            Some(tasks::get_task(storage, task_id).await)
        }
        CliIpcRequest::StorageAddTask { task } => {
            Some(tasks::add_task(storage, task).await)
        }
        CliIpcRequest::StorageUpdateTask { task } => {
            Some(tasks::update_task(storage, task).await)
        }
        CliIpcRequest::StorageDeleteTask { task_id } => {
            Some(tasks::delete_task(storage, task_id).await)
        }
        CliIpcRequest::StorageGetTaskImages { task_id } => {
            Some(tasks::get_task_images(storage, task_id).await)
        }
        CliIpcRequest::StorageGetTaskImageIds { task_id } => {
            Some(tasks::get_task_image_ids(storage, task_id).await)
        }
        CliIpcRequest::StorageGetTaskImagesPaginated { task_id, offset, limit } => {
            Some(tasks::get_task_images_paginated(storage, task_id, *offset, *limit).await)
        }
        CliIpcRequest::StorageGetTaskFailedImages { task_id } => {
            Some(tasks::get_task_failed_images(storage, task_id).await)
        }
        CliIpcRequest::StorageConfirmTaskRhaiDump { task_id } => {
            Some(tasks::confirm_task_rhai_dump(storage, task_id).await)
        }
        CliIpcRequest::StorageClearFinishedTasks => {
            Some(tasks::clear_finished_tasks(storage).await)
        }

        // Run Configs
        CliIpcRequest::StorageGetRunConfigs => Some(run_configs::get_run_configs(storage).await),
        CliIpcRequest::StorageAddRunConfig { config } => {
            Some(run_configs::add_run_config(storage, config).await)
        }
        CliIpcRequest::StorageUpdateRunConfig { config } => {
            Some(run_configs::update_run_config(storage, config).await)
        }
        CliIpcRequest::StorageDeleteRunConfig { config_id } => {
            Some(run_configs::delete_run_config(storage, config_id).await)
        }

        // Gallery Query Helpers（供 app-main 组装画廊虚拟路径）
        CliIpcRequest::StorageGetGalleryDateGroups => {
            Some(images::get_gallery_date_groups(storage).await)
        }
        CliIpcRequest::StorageGetGalleryPluginGroups => {
            Some(images::get_gallery_plugin_groups(storage).await)
        }
        CliIpcRequest::StorageGetTasksWithImages => Some(tasks::get_tasks_with_images(storage).await),
        CliIpcRequest::StorageGetImagesCountByQuery { query } => {
            Some(images::get_images_count_by_query(storage, query).await)
        }
        CliIpcRequest::StorageGetImagesRangeByQuery { query, offset, limit } => {
            Some(images::get_images_range_by_query(storage, query, *offset, *limit).await)
        }

        _ => None,
    }
}
