//! Storage 相关请求
pub mod albums;
pub mod images;
pub mod run_configs;
pub mod tasks;

use kabegame_core::ipc::ipc::{CliIpcRequest, CliIpcResponse};
use kabegame_core::ipc::server::EventBroadcaster;
use std::sync::Arc;

pub async fn handle_storage_request(
    req: &CliIpcRequest,
    broadcaster: Arc<EventBroadcaster>,
) -> Option<CliIpcResponse> {
    match req {
        // Images
        CliIpcRequest::StorageGetImages => Some(images::get_images().await),
        CliIpcRequest::StorageGetImagesPaginated { page, page_size } => {
            Some(images::get_images_paginated(*page, *page_size).await)
        }
        CliIpcRequest::StorageGetImagesCount => Some(images::get_images_count().await),
        CliIpcRequest::StorageGetImageById { image_id } => {
            Some(images::get_image_by_id(image_id).await)
        }
        CliIpcRequest::StorageFindImageByPath { path } => {
            Some(images::find_image_by_path(path).await)
        }
        CliIpcRequest::StorageDeleteImage { image_id } => {
            Some(images::delete_image(broadcaster, image_id).await)
        }
        CliIpcRequest::StorageRemoveImage { image_id } => {
            Some(images::remove_image(broadcaster, image_id).await)
        }
        CliIpcRequest::StorageBatchDeleteImages { image_ids } => {
            Some(images::batch_delete_images(broadcaster, image_ids).await)
        }
        CliIpcRequest::StorageBatchRemoveImages { image_ids } => {
            Some(images::batch_remove_images(broadcaster, image_ids).await)
        }
        CliIpcRequest::StorageToggleImageFavorite { image_id, favorite } => {
            Some(images::toggle_image_favorite(broadcaster, image_id, *favorite).await)
        }

        // Albums
        CliIpcRequest::StorageGetAlbums => Some(albums::get_albums().await),
        CliIpcRequest::StorageAddAlbum { name } => {
            // TODO: 蜑咲ｫｯ螟・炊 album_add 莠倶ｻｶ
            Some(albums::add_album(broadcaster, name).await)
        }
        CliIpcRequest::StorageDeleteAlbum { album_id } => {
            Some(albums::delete_album(album_id).await)
        }
        CliIpcRequest::StorageRenameAlbum { album_id, new_name } => {
            Some(albums::rename_album(album_id, new_name).await)
        }
        CliIpcRequest::StorageAddImagesToAlbum {
            album_id,
            image_ids,
        } => Some(albums::add_images_to_album(album_id, image_ids).await),
        CliIpcRequest::StorageRemoveImagesFromAlbum {
            album_id,
            image_ids,
        } => Some(albums::remove_images_from_album(album_id, image_ids).await),
        CliIpcRequest::StorageGetAlbumImages { album_id } => {
            Some(albums::get_album_images(album_id).await)
        }
        CliIpcRequest::StorageGetAlbumPreview { album_id, limit } => {
            Some(albums::get_album_preview(album_id, *limit).await)
        }
        CliIpcRequest::StorageGetAlbumCounts => Some(albums::get_album_counts().await),
        CliIpcRequest::StorageUpdateAlbumImagesOrder {
            album_id,
            image_orders,
        } => Some(albums::update_album_images_order(album_id, image_orders).await),
        CliIpcRequest::StorageGetAlbumImageIds { album_id } => {
            Some(albums::get_album_image_ids(album_id).await)
        }

        // Tasks
        CliIpcRequest::StorageGetAllTasks => Some(tasks::get_all_tasks().await),
        CliIpcRequest::StorageGetTask { task_id } => Some(tasks::get_task(task_id).await),
        CliIpcRequest::StorageAddTask { task } => Some(tasks::add_task(task).await),
        CliIpcRequest::StorageUpdateTask { task } => Some(tasks::update_task(task).await),
        CliIpcRequest::StorageDeleteTask { task_id } => Some(tasks::delete_task(task_id).await),
        CliIpcRequest::StorageGetTaskImages { task_id } => {
            Some(tasks::get_task_images(task_id).await)
        }
        CliIpcRequest::StorageGetTaskImageIds { task_id } => {
            Some(tasks::get_task_image_ids(task_id).await)
        }
        CliIpcRequest::StorageGetTaskImagesPaginated {
            task_id,
            offset,
            limit,
        } => Some(tasks::get_task_images_paginated(task_id, *offset, *limit).await),
        CliIpcRequest::StorageGetTaskFailedImages { task_id } => {
            Some(tasks::get_task_failed_images(task_id).await)
        }
        CliIpcRequest::StorageConfirmTaskRhaiDump { task_id } => {
            Some(tasks::confirm_task_rhai_dump(task_id).await)
        }
        CliIpcRequest::StorageClearFinishedTasks => Some(tasks::clear_finished_tasks().await),

        // Run Configs
        CliIpcRequest::StorageGetRunConfigs => Some(run_configs::get_run_configs().await),
        CliIpcRequest::StorageAddRunConfig { config } => {
            Some(run_configs::add_run_config(config).await)
        }
        CliIpcRequest::StorageUpdateRunConfig { config } => {
            Some(run_configs::update_run_config(config).await)
        }
        CliIpcRequest::StorageDeleteRunConfig { config_id } => {
            Some(run_configs::delete_run_config(config_id).await)
        }

        // Gallery Query Helpers・井ｾ・app-main 扈・｣・判蟒願劒諡溯ｷｯ蠕・ｼ・        CliIpcRequest::StorageGetGalleryDateGroups => Some(images::get_gallery_date_groups().await),
        CliIpcRequest::StorageGetGalleryPluginGroups => {
            Some(images::get_gallery_plugin_groups().await)
        }
        CliIpcRequest::StorageGetTasksWithImages => Some(tasks::get_tasks_with_images().await),
        CliIpcRequest::StorageGetImagesCountByQuery { query } => {
            Some(images::get_images_count_by_query(query).await)
        }
        CliIpcRequest::StorageGetImagesRangeByQuery {
            query,
            offset,
            limit,
        } => Some(images::get_images_range_by_query(query, *offset, *limit).await),

        _ => None,
    }
}
