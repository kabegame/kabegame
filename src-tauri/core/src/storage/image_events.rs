//! 在修改 `images` / `album_images` 后统一发射 `images-change` / `album-images-change`。

use crate::emitter::GlobalEmitter;
use crate::storage::albums::AddToAlbumResult;
use crate::storage::{Storage, FAVORITE_ALBUM_ID};

fn emit_task_image_counts_full(task_id: &str) {
    if let Ok(Some(t)) = Storage::global().get_task(task_id) {
        GlobalEmitter::global().emit_task_image_counts(
            task_id,
            Some(t.success_count),
            Some(t.deleted_count),
            Some(t.failed_count),
            Some(t.dedup_count),
        );
    }
}

/// 删除 `images` 表行（删文件或仅删记录），并发射 `images-change(delete)` + 必要时 `album-images-change(delete)`。
pub fn delete_images_with_events(image_ids: &[String], delete_files: bool) -> Result<(), String> {
    let storage = Storage::global();
    let album_ids = storage.collect_album_ids_for_images(image_ids)?;
    let task_ids = storage.collect_task_ids_for_images(image_ids)?;
    let surf_record_ids = storage.collect_surf_record_ids_for_images(image_ids)?;
    if delete_files {
        storage.batch_delete_images(image_ids)?;
    } else {
        storage.batch_remove_images(image_ids)?;
    }
    for tid in &task_ids {
        emit_task_image_counts_full(tid);
    }
    GlobalEmitter::global().emit_images_change(
        "delete",
        image_ids,
        Some(&task_ids),
        Some(&surf_record_ids),
    );
    if !album_ids.is_empty() {
        GlobalEmitter::global().emit_album_images_change("delete", &album_ids, image_ids);
    }
    Ok(())
}

/// 加入画册并发 `album-images-change(add)`。
pub fn add_images_to_album_with_event(
    album_id: &str,
    image_ids: &[String],
) -> Result<AddToAlbumResult, String> {
    let r = Storage::global().add_images_to_album(album_id, image_ids)?;
    let aids = vec![album_id.to_string()];
    GlobalEmitter::global().emit_album_images_change("add", &aids, image_ids);
    Ok(r)
}

/// 从画册移除并发 `album-images-change(delete)`。
pub fn remove_images_from_album_with_event(
    album_id: &str,
    image_ids: &[String],
) -> Result<usize, String> {
    let removed = Storage::global().remove_images_from_album(album_id, image_ids)?;
    let aids = vec![album_id.to_string()];
    GlobalEmitter::global().emit_album_images_change("delete", &aids, image_ids);
    Ok(removed)
}

/// 切换收藏并发 `album-images-change`。
pub fn toggle_image_favorite_with_event(image_id: &str, favorite: bool) -> Result<(), String> {
    Storage::global().toggle_image_favorite(image_id, favorite)?;
    let aids = vec![FAVORITE_ALBUM_ID.to_string()];
    let ids = vec![image_id.to_string()];
    let reason = if favorite { "add" } else { "delete" };
    GlobalEmitter::global().emit_album_images_change(reason, &aids, &ids);
    Ok(())
}
