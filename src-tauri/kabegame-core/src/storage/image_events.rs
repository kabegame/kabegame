//! 在修改 `images` / `album_images` 后统一发射图片增删、字段补丁与画册成员增删 / 排序事件。

#[cfg(feature = "ipc-server")]
use crate::emitter::dispatch_view_event;
#[cfg(feature = "ipc-server")]
use crate::emitter::next_change_seq;
use crate::emitter::GlobalEmitter;
#[cfg(feature = "ipc-server")]
use crate::ipc::events::AppEvent;
use crate::ipc::events::ImageFieldPatch;
use crate::storage::albums::AddToAlbumResult;
use crate::storage::source_purge::{purge_source_files, PurgeReport};
#[cfg(test)]
use crate::storage::HIDDEN_ALBUM_ID;
use crate::storage::{Storage, FAVORITE_ALBUM_ID};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::BTreeMap;
#[cfg(feature = "ipc-server")]
use std::sync::Arc;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlbumImagesPayload {
    pub album_id: String,
    pub ancestor_path: String,
    pub image_ids: Vec<String>,
    /// 整行删图造成的成员删除；隐藏画册的这类删除不是取消隐藏
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub images_deleted: bool,
}

#[derive(Debug, Clone)]
pub struct DeleteImagesResult {
    pub purge: PurgeReport,
}

/// 已完成数据库删除与事件生成、尚未回收源文件的中间结果。
pub struct PendingImageDelete {
    paths: Vec<String>,
}

impl PendingImageDelete {
    pub async fn finish(self) -> DeleteImagesResult {
        DeleteImagesResult {
            purge: purge_source_files(&self.paths).await,
        }
    }
}

impl std::ops::Deref for DeleteImagesResult {
    type Target = PurgeReport;
    fn deref(&self) -> &Self::Target {
        &self.purge
    }
}

fn emit_album_images(kind: &str, body: AlbumImagesPayload) {
    if body.album_id.is_empty()
        || body.image_ids.is_empty()
        || GlobalEmitter::try_global().is_none()
    {
        return;
    }
    #[cfg(feature = "ipc-server")]
    {
        let seq = next_change_seq();
        let event = match kind {
            "added" => AppEvent::AlbumImagesAdded { seq, body },
            "deleted" => AppEvent::AlbumImagesDeleted { seq, body },
            "order" => AppEvent::AlbumImagesChange { seq, body },
            _ => unreachable!("未知画册成员事件"),
        };
        dispatch_view_event(Arc::new(event));
    }
    #[cfg(not(feature = "ipc-server"))]
    let _ = (kind, body);
}

fn membership_payload(
    album_id: &str,
    changed: &[String],
    ancestor_path: Option<String>,
) -> AlbumImagesPayload {
    AlbumImagesPayload {
        album_id: album_id.to_string(),
        ancestor_path: ancestor_path.unwrap_or_else(|| format!("/{album_id}/")),
        image_ids: changed.to_vec(),
        images_deleted: false,
    }
}

/// 画册自身的路径；读不到时由 membership_payload 退回 `/<id>/`（系统画册本来就是这个路径）。
fn album_ancestor_path(album_id: &str) -> Option<String> {
    Storage::global()
        .get_album_by_id(album_id)
        .ok()
        .flatten()
        .map(|album| album.ancestor_path)
}

fn grouped_memberships(pairs: &[(String, String)]) -> BTreeMap<String, Vec<String>> {
    let mut grouped = BTreeMap::<String, Vec<String>>::new();
    for (album_id, image_id) in pairs {
        let ids = grouped.entry(album_id.clone()).or_default();
        if !ids.iter().any(|id| id == image_id) {
            ids.push(image_id.clone());
        }
    }
    grouped
}

/// 原生元数据挂载的补丁：`image_metadata_id` 是图片字段，按 `imageMetadataId` 下发绝对值。
pub fn native_metadata_image_patch(image_id: &str, metadata_id: i64) -> ImageFieldPatch {
    ImageFieldPatch {
        id: image_id.to_string(),
        fields: json!({ "imageMetadataId": metadata_id })
            .as_object()
            .unwrap()
            .clone(),
    }
}

/// 原生元数据挂载写库后发送单图字段补丁。
pub fn emit_native_metadata_attached(image_id: &str, metadata_id: i64) {
    if let Some(emitter) = GlobalEmitter::try_global() {
        emitter.emit_image_fields(
            &[image_id.to_string()],
            json!({ "imageMetadataId": metadata_id }),
        );
    }
}

/// 实际新增的成员写库后调用；隐藏也只是隐藏画册的成员新增，不派生其它画册事件。
pub fn emit_membership_added(album_id: &str, changed: &[String]) -> Result<(), String> {
    if changed.is_empty() {
        return Ok(());
    }
    emit_album_images(
        "added",
        membership_payload(album_id, changed, album_ancestor_path(album_id)),
    );
    Ok(())
}

/// 实际移出画册的成员写库后调用（取消隐藏也走这里）；整行删图另走 begin_delete_images_with_events。
pub fn emit_membership_removed(album_id: &str, changed: &[String]) {
    if changed.is_empty() {
        return;
    }
    emit_album_images(
        "deleted",
        membership_payload(album_id, changed, album_ancestor_path(album_id)),
    );
}

/// 排序不改变成员，只发送实际 UPDATE 命中的 id；空操作不发事件。
pub fn emit_album_images_order_changed(album_id: &str, image_ids: &[String]) {
    if image_ids.is_empty() {
        return;
    }
    emit_album_images(
        "order",
        membership_payload(album_id, image_ids, album_ancestor_path(album_id)),
    );
}

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

/// 删除 `images` 表行并发射精确事件，但把可能耗时的源文件回收留给调用方。
pub fn begin_delete_images_with_events(
    image_ids: &[String],
    delete_files: bool,
) -> Result<PendingImageDelete, String> {
    let storage = Storage::global();
    let (pairs_before, ancestor_paths) = storage.collect_album_memberships_with_paths(image_ids)?;
    let task_ids = storage.collect_task_ids_for_images(image_ids)?;
    let paths = if delete_files {
        storage.batch_delete_images(image_ids)?
    } else {
        storage.batch_remove_images(image_ids)?;
        Vec::new()
    };
    for tid in &task_ids {
        emit_task_image_counts_full(tid);
    }
    GlobalEmitter::global().emit_images_deleted(image_ids);

    for (album_id, changed) in grouped_memberships(&pairs_before) {
        let mut body =
            membership_payload(&album_id, &changed, ancestor_paths.get(&album_id).cloned());
        body.images_deleted = true;
        emit_album_images("deleted", body);
    }
    Ok(PendingImageDelete { paths })
}

/// 删除 `images` 表行、发射精确事件并回收源文件。
pub async fn delete_images_with_events(
    image_ids: &[String],
    delete_files: bool,
) -> Result<DeleteImagesResult, String> {
    Ok(begin_delete_images_with_events(image_ids, delete_files)?
        .finish()
        .await)
}

/// 加入画册并发射精确成员变更。
pub fn add_images_to_album_with_event(
    album_id: &str,
    image_ids: &[String],
) -> Result<AddToAlbumResult, String> {
    Storage::global().ensure_album_is_writable(album_id)?;
    let result = Storage::global().add_images_to_album(album_id, image_ids)?;
    emit_membership_added(album_id, &result.inserted_ids)?;
    Ok(result)
}

/// 从画册移除并发射精确成员变更。
pub fn remove_images_from_album_with_event(
    album_id: &str,
    image_ids: &[String],
) -> Result<Vec<String>, String> {
    Storage::global().ensure_album_is_writable(album_id)?;
    let removed = Storage::global().remove_images_from_album(album_id, image_ids)?;
    emit_membership_removed(album_id, &removed);
    Ok(removed)
}

/// 切换收藏；重复设置同一状态时不发成员增量。
pub fn toggle_image_favorite_with_event(image_id: &str, favorite: bool) -> Result<(), String> {
    if !Storage::global().toggle_image_favorite(image_id, favorite)? {
        return Ok(());
    }
    let changed = vec![image_id.to_string()];
    if favorite {
        emit_membership_added(FAVORITE_ALBUM_ID, &changed)?;
    } else {
        emit_membership_removed(FAVORITE_ALBUM_ID, &changed);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    /// 在同一个事件循环中覆盖协议出口与真实写命令，避免多个转发任务争用全局接收器。
    #[cfg(feature = "ipc-server")]
    #[tokio::test(flavor = "current_thread")]
    async fn phase_a_and_e_image_event_protocol() {
        use crate::ipc::events::{AppEvent, AppEventKind, ImageFieldPatch};
        use crate::ipc::server::EventBroadcaster;
        use tokio::time::{timeout, Duration};

        crate::app_paths::AppPaths::init_for_tests();
        let _ = crate::settings::Settings::init_global();
        let _ = Storage::init_global();
        let _ = EventBroadcaster::init_global(256);
        let _ = GlobalEmitter::init_global();
        let emitter = GlobalEmitter::global();
        let mut rx = EventBroadcaster::global().subscribe_all_stream();
        let forward = tokio::spawn(EventBroadcaster::start_forward_task());
        let patch = |id: &str, fields: serde_json::Value| ImageFieldPatch {
            id: id.into(),
            fields: fields.as_object().unwrap().clone(),
        };
        async fn next(
            rx: &mut tokio::sync::mpsc::UnboundedReceiver<(u64, Arc<AppEvent>)>,
        ) -> Arc<AppEvent> {
            timeout(Duration::from_secs(2), rx.recv())
                .await
                .unwrap()
                .unwrap()
                .1
        }
        for kind in [
            AppEventKind::ImagesAdded,
            AppEventKind::ImagesDeleted,
            AppEventKind::ImagesChange,
            AppEventKind::ImageChanged,
            AppEventKind::AlbumsAdded,
            AppEventKind::AlbumsDeleted,
            AppEventKind::AlbumMoved,
            AppEventKind::AlbumChanged,
            AppEventKind::AlbumsChange,
            AppEventKind::AlbumImagesAdded,
            AppEventKind::AlbumImagesDeleted,
            AppEventKind::AlbumImagesChange,
        ] {
            assert!(AppEventKind::ALL.contains(&kind));
            assert_eq!(
                AppEventKind::from_event_name(&kind.as_event_name()),
                Some(kind)
            );
        }
        emitter.emit_image_patches(vec![]);
        emitter.emit_image_patches(vec![patch("a", json!({}))]);
        emitter.emit_image_fields(&["a".into()], json!({}));
        emitter.emit_images_added(&[]);
        emitter.emit_images_deleted(&[]);
        assert!(timeout(Duration::from_millis(30), rx.recv()).await.is_err());

        emitter.emit_image_patches(vec![
            patch("a", json!({"width": 1})),
            patch("a", json!({"width": 2, "metadataId": 9})),
            patch("b", json!({})),
        ]);
        let single = next(&mut rx).await;
        match &*single {
            AppEvent::ImageChanged { patch, .. } => {
                assert_eq!(patch.id, "a");
                assert_eq!(
                    patch.fields,
                    json!({"width": 2, "metadataId": 9})
                        .as_object()
                        .unwrap()
                        .clone()
                );
            }
            event => panic!("unexpected event: {event:?}"),
        }
        let serialized = serde_json::to_value(&*single).unwrap();
        assert_eq!(serialized["type"], "image-changed");
        assert_eq!(serialized["patch"]["id"], "a");
        assert!(serialized["patch"].get("fields").is_none());
        assert!(serialized.get("patches").is_none());
        emitter.emit_image_fields(&["a".into(), "b".into()], json!({"surfRecordId": null}));
        match &*next(&mut rx).await {
            AppEvent::ImagesChange { patches, .. } => {
                assert_eq!(patches.len(), 2);
                assert!(patches.iter().all(|p| p.fields["surfRecordId"].is_null()));
            }
            event => panic!("unexpected event: {event:?}"),
        }

        let image: crate::storage::ImageInfo = serde_json::from_value(json!({
            "id": "", "url": "https://example.test/a", "local_path": "/tmp/phase-a-missing",
            "plugin_id": "phase-a", "task_id": null, "surf_record_id": null,
            "crawled_at": 42, "image_metadata_id": 7, "metadata_id": null,
            "thumbnail_path": "/tmp/phase-a-thumb", "display_name": "phase-a"
        }))
        .unwrap();
        emitter.emit_images_added(std::slice::from_ref(&image));
        let added = next(&mut rx).await;
        assert_eq!(added.kind(), AppEventKind::ImagesAdded);
        let serialized = serde_json::to_value(&*added).unwrap();
        assert_eq!(
            serialized["images"][0],
            serde_json::to_value(&image).unwrap()
        );
        assert_eq!(serialized["images"][0]["imageMetadataId"], 7);
        let decoded: AppEvent = serde_json::from_value(serialized.clone()).unwrap();
        assert_eq!(serde_json::to_value(decoded).unwrap(), serialized);
        assert!(serialized.get("reason").is_none());
        let inserted = Storage::global().add_image(image).unwrap();

        // 隐藏增删只产生画册成员事件。
        let ids = vec![inserted.id.clone()];
        Storage::global()
            .add_images_to_album(HIDDEN_ALBUM_ID, &ids)
            .unwrap();
        emit_membership_added(HIDDEN_ALBUM_ID, &ids).unwrap();
        assert!(
            matches!(&*next(&mut rx).await, AppEvent::AlbumImagesAdded { body, .. } if body.album_id == HIDDEN_ALBUM_ID && body.ancestor_path == format!("/{HIDDEN_ALBUM_ID}/"))
        );
        Storage::global()
            .remove_images_from_album(HIDDEN_ALBUM_ID, &ids)
            .unwrap();
        emit_membership_removed(HIDDEN_ALBUM_ID, &ids);
        assert!(
            matches!(&*next(&mut rx).await, AppEvent::AlbumImagesDeleted { body, .. } if body.album_id == HIDDEN_ALBUM_ID && body.image_ids == ids && !body.images_deleted)
        );
        assert!(timeout(Duration::from_millis(30), rx.recv()).await.is_err());

        begin_delete_images_with_events(&ids, false).unwrap();
        let deleted = next(&mut rx).await;
        assert_eq!(deleted.kind(), AppEventKind::ImagesDeleted);
        let serialized = serde_json::to_value(&*deleted).unwrap();
        assert_eq!(serialized.as_object().unwrap().len(), 3);
        assert_eq!(serialized["imageIds"], json!(ids));
        assert!(timeout(Duration::from_millis(30), rx.recv()).await.is_err());

        // Phase E：真实成员增删不按隐藏状态拆分；隐藏只给自身发事件。
        let storage = Storage::global();
        let a = storage.add_album("phase-e-a", None).unwrap();
        assert!(
            matches!(&*next(&mut rx).await, AppEvent::AlbumsAdded { albums, .. } if albums.len() == 1)
        );
        let child = storage.add_album("phase-e-child", Some(&a.id)).unwrap();
        next(&mut rx).await;
        let b = storage.add_album("phase-e-b", None).unwrap();
        next(&mut rx).await;
        let mut images = Vec::new();
        for n in 0..2 {
            let image = serde_json::from_value(json!({
                "id": "", "url": format!("https://example.test/phase-e-{n}"),
                "local_path": format!("/tmp/phase-e-{n}"), "plugin_id": "phase-e",
                "task_id": null, "crawled_at": 42, "thumbnail_path": ""
            }))
            .unwrap();
            images.push(storage.add_image(image).unwrap().id);
        }
        add_images_to_album_with_event(&a.id, &images).unwrap();
        assert!(
            matches!(&*next(&mut rx).await, AppEvent::AlbumImagesAdded { body, .. } if body.image_ids == images && body.ancestor_path == a.ancestor_path)
        );
        toggle_image_favorite_with_event(&images[0], true).unwrap();
        next(&mut rx).await;
        add_images_to_album_with_event(HIDDEN_ALBUM_ID, &images[..1]).unwrap();
        let hidden = next(&mut rx).await;
        assert!(
            matches!(&*hidden, AppEvent::AlbumImagesAdded { body, .. } if body.album_id == HIDDEN_ALBUM_ID && body.image_ids == images[..1])
        );
        // 隐藏只发隐藏画册自身一条，不带其它画册成员与图片行，也不给 A / 收藏派生事件
        assert!(timeout(Duration::from_millis(30), rx.recv()).await.is_err());
        let encoded = serde_json::to_value(&*hidden).unwrap();
        assert!(encoded.get("reason").is_none() && encoded.get("albumIds").is_none());
        assert!(encoded.get("memberships").is_none() && encoded.get("images").is_none());
        assert!(encoded.get("imagesDeleted").is_none());
        add_images_to_album_with_event(&b.id, &images).unwrap();
        assert!(
            matches!(&*next(&mut rx).await, AppEvent::AlbumImagesAdded { body, .. } if body.image_ids == images)
        );
        remove_images_from_album_with_event(&b.id, &images).unwrap();
        assert!(
            matches!(&*next(&mut rx).await, AppEvent::AlbumImagesDeleted { body, .. } if body.image_ids == images && !body.images_deleted)
        );
        remove_images_from_album_with_event(HIDDEN_ALBUM_ID, &images[..1]).unwrap();
        assert!(
            matches!(&*next(&mut rx).await, AppEvent::AlbumImagesDeleted { body, .. } if
            body.album_id == HIDDEN_ALBUM_ID && body.image_ids == images[..1] && !body.images_deleted)
        );
        assert!(timeout(Duration::from_millis(30), rx.recv()).await.is_err());
        crate::commands::album::update_album_images_order(
            a.id.clone(),
            vec![(images[0].clone(), -10), ("missing".into(), 1)],
        )
        .unwrap();
        assert!(
            matches!(&*next(&mut rx).await, AppEvent::AlbumImagesChange { body, .. } if body.image_ids == images[..1])
        );
        crate::commands::album::update_album_images_order(
            a.id.clone(),
            vec![(images[0].clone(), -10)],
        )
        .unwrap();
        assert!(timeout(Duration::from_millis(30), rx.recv()).await.is_err());
        // NULL 旧序也能被更新。
        storage
            .db
            .lock()
            .unwrap()
            .execute(
                "UPDATE album_images SET \"order\" = NULL WHERE album_id = ?1 AND image_id = ?2",
                rusqlite::params![a.id, images[1]],
            )
            .unwrap();
        crate::commands::album::update_album_images_order(
            a.id.clone(),
            vec![(images[1].clone(), -20)],
        )
        .unwrap();
        assert!(
            matches!(&*next(&mut rx).await, AppEvent::AlbumImagesChange { body, .. } if body.image_ids == images[1..])
        );
        add_images_to_album_with_event(HIDDEN_ALBUM_ID, &images[..1]).unwrap();
        next(&mut rx).await;
        begin_delete_images_with_events(&images[..1], false).unwrap();
        assert!(matches!(
            &*next(&mut rx).await,
            AppEvent::ImagesDeleted { .. }
        ));
        for _ in 0..3 {
            assert!(
                matches!(&*next(&mut rx).await, AppEvent::AlbumImagesDeleted { body, .. } if body.images_deleted)
            );
        }
        assert!(timeout(Duration::from_millis(30), rx.recv()).await.is_err());

        // 移动只发根；补丁合并、去掉位置字段，删除子树不再发空排序。
        storage.move_album(&a.id, Some(&b.id)).unwrap();
        assert!(
            matches!(&*next(&mut rx).await, AppEvent::AlbumMoved { id, old_ancestor_path, new_ancestor_path, .. }
            if id == &a.id && old_ancestor_path == &a.ancestor_path && new_ancestor_path == &format!("{}{}/", b.ancestor_path, a.id))
        );
        emitter.emit_album_patches(vec![
            crate::emitter::AlbumFieldPatch::new(
                &a.id,
                json!({ "name": "first", "parentId": "bad" }),
            ),
            crate::emitter::AlbumFieldPatch::new(
                &a.id,
                json!({ "name": "last", "ancestorPath": "bad" }),
            ),
            crate::emitter::AlbumFieldPatch::new(&b.id, json!({})),
        ]);
        assert!(
            matches!(&*next(&mut rx).await, AppEvent::AlbumChanged { patch, .. } if patch.fields == json!({ "name": "last" }).as_object().unwrap().clone())
        );
        emitter.emit_album_patches(vec![
            crate::emitter::AlbumFieldPatch::new(&a.id, json!({ "name": "a" })),
            crate::emitter::AlbumFieldPatch::new(&b.id, json!({ "syncMode": "none" })),
        ]);
        assert!(
            matches!(&*next(&mut rx).await, AppEvent::AlbumsChange { patches, .. } if patches.len() == 2)
        );
        storage.delete_album(&a.id).unwrap();
        assert!(
            matches!(&*next(&mut rx).await, AppEvent::AlbumsDeleted { albums, .. } if albums.len() == 1 && albums[0].id == a.id && albums[0].ancestor_path == format!("{}{}/", b.ancestor_path, a.id))
        );
        assert!(storage.get_album_by_id(&child.id).unwrap().is_none());
        assert!(timeout(Duration::from_millis(30), rx.recv()).await.is_err());

        let labels = vec![
            crate::storage::labels::LabelSpec {
                segments: vec!["phase-e-labels".into()],
                key: "one".into(),
                name: None,
            },
            crate::storage::labels::LabelSpec {
                segments: vec!["phase-e-labels".into()],
                key: "two".into(),
                name: None,
            },
        ];
        storage
            .apply_labels_to_images(&labels, &images[1..])
            .unwrap();
        assert!(
            matches!(&*next(&mut rx).await, AppEvent::AlbumsAdded { albums, .. } if albums.len() == 3)
        );
        for _ in 0..2 {
            assert!(matches!(
                &*next(&mut rx).await,
                AppEvent::AlbumImagesAdded { .. }
            ));
        }
        assert!(timeout(Duration::from_millis(30), rx.recv()).await.is_err());

        // 本地文件夹批量创建、同时改链祖先与子孙、转换提升均走同一协议。
        use crate::local_folder::create::build_entries_non_recursive;
        let folder_base = tempfile::tempdir().unwrap();
        let outer = build_entries_non_recursive("phase-e-outer", folder_base.path(), None);
        let root_path = folder_base.path().join("root");
        std::fs::create_dir_all(root_path.join("mid/leaf")).unwrap();
        let folder_root = build_entries_non_recursive("phase-e-root", &root_path, None);
        let mid = build_entries_non_recursive("phase-e-mid", &root_path.join("mid"), None);
        let leaf = build_entries_non_recursive(
            "phase-e-leaf",
            &root_path.join("mid/leaf"),
            Some(&folder_root.id),
        );
        let created = storage
            .add_local_folder_albums_tx(&[
                outer.clone(),
                folder_root.clone(),
                mid.clone(),
                leaf.clone(),
            ])
            .unwrap();
        let added = next(&mut rx).await;
        assert!(matches!(&*added, AppEvent::AlbumsAdded { albums, .. } if albums.len() == 4));
        let serialized = serde_json::to_value(&*added).unwrap();
        assert_eq!(
            serde_json::to_value(serde_json::from_value::<AppEvent>(serialized.clone()).unwrap())
                .unwrap(),
            serialized
        );
        let mut held: HashMap<_, _> = created
            .iter()
            .map(|a| (a.id.clone(), a.ancestor_path.clone()))
            .collect();
        let changed = storage.rechain_local_folder_albums().unwrap();
        assert_eq!(changed.len(), 3);
        let mut moved_ids = Vec::new();
        for _ in 0..3 {
            let event = next(&mut rx).await;
            match &*event {
                AppEvent::AlbumMoved {
                    id,
                    old_ancestor_path,
                    new_ancestor_path,
                    ..
                } => {
                    assert_eq!(
                        held[id], *old_ancestor_path,
                        "每条移动的旧路径必须接上前序事件"
                    );
                    moved_ids.push(id.clone());
                    for path in held.values_mut() {
                        if let Some(suffix) = path.strip_prefix(old_ancestor_path) {
                            *path = format!("{new_ancestor_path}{suffix}");
                        }
                    }
                }
                event => panic!("改链意外事件: {event:?}"),
            }
        }
        assert!(
            moved_ids
                .iter()
                .position(|id| id == &folder_root.id)
                .unwrap()
                < moved_ids.iter().position(|id| id == &leaf.id).unwrap()
        );
        for (id, path) in &held {
            assert_eq!(
                storage.get_album_by_id(id).unwrap().unwrap().ancestor_path,
                *path
            );
        }
        assert!(timeout(Duration::from_millis(30), rx.recv()).await.is_err());
        storage
            .set_album_sync_mode(&outer.id, crate::local_folder::SyncMode::Recursive)
            .unwrap();
        assert!(
            matches!(&*next(&mut rx).await, AppEvent::AlbumsChange { patches, .. } if patches.len() == 4 && patches.iter().all(|p|
            p.fields.len() == 1 && p.fields.contains_key("syncMode")))
        );
        storage
            .set_album_sync_mode(&outer.id, crate::local_folder::SyncMode::None)
            .unwrap();
        assert!(
            matches!(&*next(&mut rx).await, AppEvent::AlbumsChange { patches, .. } if patches.len() == 4)
        );
        storage
            .convert_local_folder_album_to_normal(&folder_root.id)
            .unwrap();
        assert!(
            matches!(&*next(&mut rx).await, AppEvent::AlbumMoved { id, old_ancestor_path, new_ancestor_path, .. }
            if id == &folder_root.id && old_ancestor_path == &held[id] && new_ancestor_path == &format!("/{id}/"))
        );
        assert!(
            matches!(&*next(&mut rx).await, AppEvent::AlbumsChange { patches, .. } if patches.len() == 3 && patches.iter().all(|p|
            p.fields.get("albumType") == Some(&json!("normal")) && !p.fields.contains_key("parentId") && !p.fields.contains_key("ancestorPath") && !p.fields.contains_key("folderStatus") && !p.fields.contains_key("syncMode")))
        );
        assert!(timeout(Duration::from_millis(30), rx.recv()).await.is_err());

        // 删除任务、清理已完成任务：外键把图片 task_id 置空，发 taskId: null 补丁。
        let task_id = format!("phase-a-{}", uuid::Uuid::new_v4());
        let insert_task_with_image = |n: u32| {
            Storage::global()
                .db
                .lock()
                .unwrap()
                .execute(
                    "INSERT INTO tasks (id, plugin_id, status) VALUES (?1, 'phase-a', 'completed')",
                    [&task_id],
                )
                .unwrap();
            let image: crate::storage::ImageInfo = serde_json::from_value(json!({
                "id": "", "url": format!("https://example.test/task-{n}"),
                "local_path": format!("/tmp/phase-a-task-{n}"), "plugin_id": "phase-a",
                "task_id": task_id, "crawled_at": 42, "thumbnail_path": ""
            }))
            .unwrap();
            Storage::global().add_image(image).unwrap().id
        };
        let task_image_nulled = |event: &AppEvent, image_id: &str| match event {
            AppEvent::ImageChanged { patch, .. } => {
                patch.id == image_id && patch.fields.get("taskId") == Some(&json!(null))
            }
            AppEvent::ImagesChange { patches, .. } => patches
                .iter()
                .any(|p| p.id == image_id && p.fields.get("taskId") == Some(&json!(null))),
            _ => false,
        };

        let image_id = insert_task_with_image(1);
        crate::commands::task::delete_task(task_id.clone()).unwrap();
        assert!(task_image_nulled(&*next(&mut rx).await, &image_id));
        assert!(
            matches!(&*next(&mut rx).await, AppEvent::TaskDeleted { task_id: id } if id == &task_id)
        );
        assert!(timeout(Duration::from_millis(30), rx.recv()).await.is_err());

        let image_id = insert_task_with_image(2);
        let cleared = crate::commands::task::clear_finished_tasks().unwrap();
        assert!(cleared["taskIds"]
            .as_array()
            .unwrap()
            .contains(&json!(task_id)));
        let (mut saw_deleted, mut saw_patch) = (false, false);
        while let Ok(Some((_, event))) = timeout(Duration::from_millis(30), rx.recv()).await {
            match &*event {
                AppEvent::TaskDeleted { task_id: id } => saw_deleted |= id == &task_id,
                AppEvent::ImageChanged { .. } | AppEvent::ImagesChange { .. } => {
                    saw_patch |= task_image_nulled(&event, &image_id)
                }
                event => panic!("unexpected event after clear: {event:?}"),
            }
        }
        assert!(saw_deleted && saw_patch);
        forward.abort();
    }
}
