//! Storage 相关请求
pub mod albums;
pub mod images;
pub mod run_configs;
pub mod tasks;

use kabegame_core::ipc::ipc::{IpcRequest, IpcResponse};

pub async fn handle_storage_request(req: &IpcRequest) -> Option<IpcResponse> {
    match req {
        // Images
        IpcRequest::StorageGetImagesCount => Some(images::get_images_count().await),
        IpcRequest::StorageGetImageById { image_id } => {
            Some(images::get_image_by_id(image_id).await)
        }
        IpcRequest::StorageFindImageByPath { path } => Some(images::find_image_by_path(path).await),
        IpcRequest::StorageDeleteImage { image_id } => Some(images::delete_image(image_id).await),
        IpcRequest::StorageRemoveImage { image_id } => Some(images::remove_image(image_id).await),
        IpcRequest::StorageBatchDeleteImages { image_ids } => {
            Some(images::batch_delete_images(image_ids).await)
        }
        IpcRequest::StorageBatchRemoveImages { image_ids } => {
            Some(images::batch_remove_images(image_ids).await)
        }
        IpcRequest::StorageToggleImageFavorite { image_id, favorite } => {
            Some(images::toggle_image_favorite(image_id, *favorite).await)
        }

        // Albums
        IpcRequest::StorageGetAlbums => Some(albums::get_albums().await),
        IpcRequest::StorageAddAlbum { name } => {
            // TODO: 蜑咲ｫｯ螟・炊 album_add 莠倶ｻｶ
            Some(albums::add_album(name).await)
        }
        IpcRequest::StorageDeleteAlbum { album_id } => Some(albums::delete_album(album_id).await),
        IpcRequest::StorageRenameAlbum { album_id, new_name } => {
            Some(albums::rename_album(album_id, new_name).await)
        }
        IpcRequest::StorageAddImagesToAlbum {
            album_id,
            image_ids,
        } => Some(albums::add_images_to_album(album_id, image_ids).await),
        IpcRequest::StorageRemoveImagesFromAlbum {
            album_id,
            image_ids,
        } => Some(albums::remove_images_from_album(album_id, image_ids).await),
        IpcRequest::StorageGetAlbumImages { album_id } => {
            Some(albums::get_album_images(album_id).await)
        }
        IpcRequest::StorageGetAlbumPreview { album_id, limit } => {
            Some(albums::get_album_preview(album_id, *limit).await)
        }
        IpcRequest::StorageGetAlbumCounts => Some(albums::get_album_counts().await),
        IpcRequest::StorageUpdateAlbumImagesOrder {
            album_id,
            image_orders,
        } => Some(albums::update_album_images_order(album_id, image_orders).await),
        IpcRequest::StorageGetAlbumImageIds { album_id } => {
            Some(albums::get_album_image_ids(album_id).await)
        }

        // Tasks
        IpcRequest::StorageGetAllTasks => Some(tasks::get_all_tasks().await),
        IpcRequest::StorageGetTask { task_id } => Some(tasks::get_task(task_id).await),
        IpcRequest::StorageAddTask { task } => Some(tasks::add_task(task).await),
        IpcRequest::StorageUpdateTask { task } => Some(tasks::update_task(task).await),
        IpcRequest::StorageDeleteTask { task_id } => Some(tasks::delete_task(task_id).await),
        IpcRequest::StorageGetTaskFailedImages { task_id } => {
            Some(tasks::get_task_failed_images(task_id).await)
        }
        IpcRequest::StorageGetAllFailedImages => Some(tasks::get_all_failed_images().await),
        IpcRequest::StorageClearFinishedTasks => Some(tasks::clear_finished_tasks().await),

        // Run Configs
        IpcRequest::StorageGetRunConfigs => Some(run_configs::get_run_configs().await),
        IpcRequest::StorageAddRunConfig { config } => {
            Some(run_configs::add_run_config(config).await)
        }
        IpcRequest::StorageUpdateRunConfig { config } => {
            Some(run_configs::update_run_config(config).await)
        }
        IpcRequest::StorageDeleteRunConfig { config_id } => {
            Some(run_configs::delete_run_config(config_id).await)
        }

        // Gallery Query Helpers・井ｾ・kabegame 扈・｣・判蟒願劒諡溯ｷｯ蠕・ｼ・        IpcRequest::StorageGetGalleryDateGroups => Some(images::get_gallery_date_groups().await),
        IpcRequest::StorageGetGalleryPluginGroups => {
            Some(images::get_gallery_plugin_groups().await)
        }
        IpcRequest::StorageGetTasksWithImages => Some(tasks::get_tasks_with_images().await),
        _ => None,
    }
}
