//! 在修改 `images` / `album_images` 后统一发射图片增删、字段补丁与 `album-images-change`。

#[cfg(feature = "ipc-server")]
use crate::emitter::dispatch_view_event;
use crate::emitter::{next_change_seq, GlobalEmitter};
#[cfg(feature = "ipc-server")]
use crate::ipc::events::AppEvent;
use crate::ipc::events::ImageFieldPatch;
use crate::storage::albums::AddToAlbumResult;
use crate::storage::source_purge::{purge_source_files, PurgeReport};
use crate::storage::{Storage, FAVORITE_ALBUM_ID, HIDDEN_ALBUM_ID};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::{BTreeMap, HashMap, HashSet};
#[cfg(feature = "ipc-server")]
use std::sync::Arc;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AlbumImagesChangePayload {
    pub seq: u64,
    pub reason: String,
    pub album_ids: Vec<String>,
    pub image_ids: Vec<String>,
    pub ancestor_path: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MembershipRemovalContext {
    /// 单独从某个画册移出；移出 HIDDEN 时需要为其它画册发 `unhide`。
    AlbumMutation,
    /// 图片整行被删除；所有原成员只按删除前隐藏状态分类，不产生 `unhide`。
    ImagesDeleted,
}

#[derive(Debug, Clone)]
pub struct DeleteImagesResult {
    pub purge: PurgeReport,
    pub album_changes: Vec<AlbumImagesChangePayload>,
}

/// 已完成数据库删除与事件生成、尚未回收源文件的中间结果。
pub struct PendingImageDelete {
    paths: Vec<String>,
    album_changes: Vec<AlbumImagesChangePayload>,
}

impl PendingImageDelete {
    pub async fn finish(self) -> DeleteImagesResult {
        DeleteImagesResult {
            purge: purge_source_files(&self.paths).await,
            album_changes: self.album_changes,
        }
    }
}

impl std::ops::Deref for DeleteImagesResult {
    type Target = PurgeReport;

    fn deref(&self) -> &Self::Target {
        &self.purge
    }
}

fn emit_album_images_change(
    reason: &str,
    album_id: &str,
    image_ids: &[String],
    ancestor_paths: &HashMap<String, String>,
) -> Option<AlbumImagesChangePayload> {
    if album_id.trim().is_empty() || (image_ids.is_empty() && reason != "order") {
        return None;
    }
    debug_assert!(matches!(
        reason,
        "add" | "add-hidden" | "delete" | "delete-hidden" | "hide" | "unhide" | "order"
    ));
    if GlobalEmitter::try_global().is_none() {
        return None;
    }
    let payload = AlbumImagesChangePayload {
        seq: next_change_seq(),
        reason: reason.to_string(),
        album_ids: vec![album_id.to_string()],
        image_ids: image_ids.to_vec(),
        ancestor_path: ancestor_paths
            .get(album_id)
            .cloned()
            .unwrap_or_else(|| format!("/{album_id}/")),
    };
    #[cfg(feature = "ipc-server")]
    dispatch_view_event(Arc::new(AppEvent::AlbumImagesChange {
        seq: payload.seq,
        reason: payload.reason.clone(),
        album_ids: payload.album_ids.clone(),
        image_ids: payload.image_ids.clone(),
        ancestor_path: payload.ancestor_path.clone(),
    }));
    Some(payload)
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

fn hidden_image_ids(pairs: &[(String, String)]) -> HashSet<&str> {
    pairs
        .iter()
        .filter_map(|(album_id, image_id)| {
            (album_id == HIDDEN_ALBUM_ID).then_some(image_id.as_str())
        })
        .collect()
}

fn split_by_hidden(changed: &[String], pairs: &[(String, String)]) -> (Vec<String>, Vec<String>) {
    let hidden = hidden_image_ids(pairs);
    changed
        .iter()
        .cloned()
        .partition(|image_id| hidden.contains(image_id.as_str()))
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

/// 实际新增的成员写库后调用；按画册与隐藏状态拆分并返回已发送 payload 的副本。
pub fn emit_membership_added(
    album_id: &str,
    changed: &[String],
) -> Result<Vec<AlbumImagesChangePayload>, String> {
    if changed.is_empty() {
        return Ok(Vec::new());
    }
    let (pairs, ancestor_paths) =
        Storage::global().collect_album_memberships_with_paths(changed)?;
    let mut out = Vec::new();
    if album_id == HIDDEN_ALBUM_ID {
        if let Some(payload) =
            emit_album_images_change("add-hidden", album_id, changed, &ancestor_paths)
        {
            out.push(payload);
        }
        for (affected_album, ids) in grouped_memberships(&pairs) {
            if affected_album == HIDDEN_ALBUM_ID {
                continue;
            }
            if let Some(payload) =
                emit_album_images_change("hide", &affected_album, &ids, &ancestor_paths)
            {
                out.push(payload);
            }
        }
    } else {
        let (hidden_ids, visible_ids) = split_by_hidden(changed, &pairs);
        if let Some(payload) =
            emit_album_images_change("add", album_id, &visible_ids, &ancestor_paths)
        {
            out.push(payload);
        }
        if let Some(payload) =
            emit_album_images_change("add-hidden", album_id, &hidden_ids, &ancestor_paths)
        {
            out.push(payload);
        }
    }
    Ok(out)
}

/// 实际移除的成员写库后调用；`pairs_before` 必须来自写库前状态。
pub fn emit_membership_removed(
    album_id: &str,
    changed: &[String],
    pairs_before: &[(String, String)],
    ancestor_paths: &HashMap<String, String>,
    context: MembershipRemovalContext,
) -> Vec<AlbumImagesChangePayload> {
    if changed.is_empty() {
        return Vec::new();
    }
    let mut out = Vec::new();
    if context == MembershipRemovalContext::AlbumMutation && album_id == HIDDEN_ALBUM_ID {
        if let Some(payload) =
            emit_album_images_change("delete-hidden", album_id, changed, ancestor_paths)
        {
            out.push(payload);
        }
        let changed_set: HashSet<&str> = changed.iter().map(String::as_str).collect();
        for (affected_album, ids) in grouped_memberships(pairs_before) {
            if affected_album == HIDDEN_ALBUM_ID {
                continue;
            }
            let affected: Vec<String> = ids
                .into_iter()
                .filter(|image_id| changed_set.contains(image_id.as_str()))
                .collect();
            if let Some(payload) =
                emit_album_images_change("unhide", &affected_album, &affected, ancestor_paths)
            {
                out.push(payload);
            }
        }
    } else {
        let (hidden_ids, visible_ids) = split_by_hidden(changed, pairs_before);
        if let Some(payload) =
            emit_album_images_change("delete", album_id, &visible_ids, ancestor_paths)
        {
            out.push(payload);
        }
        if let Some(payload) =
            emit_album_images_change("delete-hidden", album_id, &hidden_ids, ancestor_paths)
        {
            out.push(payload);
        }
    }
    out
}

/// 排序不改变计数，但会使画册视图失效。
pub fn emit_album_images_order_changed(
    album_id: &str,
    image_ids: &[String],
) -> Vec<AlbumImagesChangePayload> {
    let ancestor_paths = Storage::global()
        .get_album_by_id(album_id)
        .ok()
        .flatten()
        .map(|album| HashMap::from([(album.id, album.ancestor_path)]))
        .unwrap_or_default();
    emit_album_images_change("order", album_id, image_ids, &ancestor_paths)
        .into_iter()
        .collect()
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

    let mut album_changes = Vec::new();
    for (album_id, changed) in grouped_memberships(&pairs_before) {
        album_changes.extend(emit_membership_removed(
            &album_id,
            &changed,
            &pairs_before,
            &ancestor_paths,
            MembershipRemovalContext::ImagesDeleted,
        ));
    }
    Ok(PendingImageDelete {
        paths,
        album_changes,
    })
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
    let mut result = Storage::global().add_images_to_album(album_id, image_ids)?;
    result.album_changes = emit_membership_added(album_id, &result.inserted_ids)?;
    Ok(result)
}

/// 从画册移除并发射精确成员变更。
pub fn remove_images_from_album_with_event(
    album_id: &str,
    image_ids: &[String],
) -> Result<(Vec<String>, Vec<AlbumImagesChangePayload>), String> {
    Storage::global().ensure_album_is_writable(album_id)?;
    let (pairs_before, ancestor_paths) =
        Storage::global().collect_album_memberships_with_paths(image_ids)?;
    let removed = Storage::global().remove_images_from_album(album_id, image_ids)?;
    let album_changes = emit_membership_removed(
        album_id,
        &removed,
        &pairs_before,
        &ancestor_paths,
        MembershipRemovalContext::AlbumMutation,
    );
    Ok((removed, album_changes))
}

/// 切换收藏；重复设置同一状态时不发成员增量。
pub fn toggle_image_favorite_with_event(image_id: &str, favorite: bool) -> Result<(), String> {
    let (pairs_before, ancestor_paths) = (!favorite)
        .then(|| Storage::global().collect_album_memberships_with_paths(&[image_id.to_string()]))
        .transpose()?
        .unwrap_or_default();
    if !Storage::global().toggle_image_favorite(image_id, favorite)? {
        return Ok(());
    }
    let changed = vec![image_id.to_string()];
    if favorite {
        emit_membership_added(FAVORITE_ALBUM_ID, &changed)?;
    } else {
        emit_membership_removed(
            FAVORITE_ALBUM_ID,
            &changed,
            &pairs_before,
            &ancestor_paths,
            MembershipRemovalContext::AlbumMutation,
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn membership_change_classification_uses_each_images_hidden_state() {
        let changed = vec!["visible".to_string(), "hidden".to_string()];
        let pairs = vec![
            ("album-a".to_string(), "visible".to_string()),
            ("album-a".to_string(), "hidden".to_string()),
            (HIDDEN_ALBUM_ID.to_string(), "hidden".to_string()),
            ("album-b".to_string(), "hidden".to_string()),
        ];

        let (hidden, visible) = split_by_hidden(&changed, &pairs);
        assert_eq!(hidden, vec!["hidden"]);
        assert_eq!(visible, vec!["visible"]);

        let grouped = grouped_memberships(&pairs);
        assert_eq!(grouped["album-a"], vec!["visible", "hidden"]);
        assert_eq!(grouped["album-b"], vec!["hidden"]);
        assert_eq!(grouped[HIDDEN_ALBUM_ID], vec!["hidden"]);
    }

    /// 在同一个事件循环中覆盖协议出口与真实写命令，避免多个转发任务争用全局接收器。
    #[cfg(feature = "ipc-server")]
    #[tokio::test(flavor = "current_thread")]
    async fn phase_a_image_event_protocol() {
        use crate::ipc::events::{AppEvent, AppEventKind, ImageFieldPatch};
        use crate::ipc::server::EventBroadcaster;
        use tokio::time::{timeout, Duration};

        crate::app_paths::AppPaths::init_for_tests();
        let _ = crate::settings::Settings::init_global();
        let _ = Storage::init_global();
        let _ = EventBroadcaster::init_global(64);
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
            matches!(&*next(&mut rx).await, AppEvent::AlbumImagesChange { reason, .. } if reason == "add-hidden")
        );
        let paths = HashMap::from([(HIDDEN_ALBUM_ID.to_string(), format!("/{HIDDEN_ALBUM_ID}/"))]);
        Storage::global()
            .remove_images_from_album(HIDDEN_ALBUM_ID, &ids)
            .unwrap();
        emit_membership_removed(
            HIDDEN_ALBUM_ID,
            &ids,
            &[(HIDDEN_ALBUM_ID.into(), inserted.id.clone())],
            &paths,
            MembershipRemovalContext::AlbumMutation,
        );
        assert!(
            matches!(&*next(&mut rx).await, AppEvent::AlbumImagesChange { reason, .. } if reason == "delete-hidden")
        );
        assert!(timeout(Duration::from_millis(30), rx.recv()).await.is_err());

        begin_delete_images_with_events(&ids, false).unwrap();
        let deleted = next(&mut rx).await;
        assert_eq!(deleted.kind(), AppEventKind::ImagesDeleted);
        let serialized = serde_json::to_value(&*deleted).unwrap();
        assert_eq!(serialized.as_object().unwrap().len(), 3);
        assert_eq!(serialized["imageIds"], json!(ids));
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
