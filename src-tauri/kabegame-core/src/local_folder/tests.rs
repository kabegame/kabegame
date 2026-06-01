use super::status::FolderStatus;
use super::sync::sync_album_if_folder_changed;
use super::{build_entries_recursive, sync_album};
use crate::app_paths::AppPaths;
use crate::crawler::downloader::{
    IMAGE_THUMBNAIL_SOURCE_THRESHOLD_BYTES, IMAGE_THUMBNAIL_TARGET_BYTES,
    IMAGE_THUMBNAIL_TARGET_TOLERANCE_BYTES,
};
use crate::storage::{ImageInfo, Storage};
use image::{Rgb, RgbImage};
use rusqlite::{params, OptionalExtension};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

static TEST_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static TEST_INIT: OnceLock<()> = OnceLock::new();

fn test_guard() -> MutexGuard<'static, ()> {
    let guard = TEST_LOCK.get_or_init(|| Mutex::new(())).lock().unwrap();
    TEST_INIT.get_or_init(init_test_runtime);
    guard
}

fn init_test_runtime() {
    let root = std::env::temp_dir().join(format!(
        "kabegame-core-local-folder-tests-{}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root).unwrap();
    AppPaths::init(AppPaths {
        data_dir: root.join("data"),
        cache_dir: root.join("cache"),
        temp_dir: root.join("tmp"),
        resource_dir: root.join("resources"),
        exe_dir: None,
        external_data_dir: None,
        pictures_dir: Some(root.join("pictures")),
    })
    .unwrap();
    Storage::init_global().unwrap();

    #[cfg(feature = "ipc-server")]
    {
        let _ = crate::ipc::server::EventBroadcaster::init_global(1000);
        let _ = crate::emitter::GlobalEmitter::init_global();
    }

    let _ = crate::providers::provider_runtime();
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

fn wait_for_stable_window() {
    std::thread::sleep(Duration::from_millis(3200));
}

fn write_png(path: &Path, color: [u8; 3]) {
    let image = RgbImage::from_pixel(1, 1, Rgb(color));
    image.save(path).unwrap();
}

fn write_large_png(path: &Path) {
    let mut image = RgbImage::new(1800, 1200);
    for (x, y, pixel) in image.enumerate_pixels_mut() {
        let r = ((x.wrapping_mul(31) ^ y.wrapping_mul(17)) & 0xff) as u8;
        let g = ((x.wrapping_mul(13) + y.wrapping_mul(29)) & 0xff) as u8;
        let b = ((x.wrapping_mul(7) ^ y.wrapping_mul(53)) & 0xff) as u8;
        *pixel = Rgb([r, g, b]);
    }
    image.save(path).unwrap();
    assert!(fs::metadata(path).unwrap().len() > IMAGE_THUMBNAIL_SOURCE_THRESHOLD_BYTES);
}

fn create_sync_album(sync_folder: &Path) -> String {
    let album_id = uuid::Uuid::new_v4().to_string();
    let storage = Storage::global();
    let conn = storage.db.lock().unwrap();
    conn.execute(
        "INSERT INTO albums (id, name, created_at, parent_id, type, sync_folder, folder_status)
         VALUES (?1, ?2, ?3, NULL, 'local_folder', ?4, NULL)",
        params![
            album_id,
            format!("sync-{}", uuid::Uuid::new_v4().simple()),
            now_secs(),
            sync_folder.to_string_lossy().as_ref()
        ],
    )
    .unwrap();
    album_id
}

#[test]
fn writable_guard_rejects_local_folder_albums_only() {
    let _guard = test_guard();
    let tmp = tempfile::tempdir().unwrap();
    let local_album_id = create_sync_album(tmp.path());
    let normal_album = Storage::global()
        .add_album(&format!("normal-{}", uuid::Uuid::new_v4().simple()), None)
        .unwrap();

    assert!(Storage::global()
        .ensure_album_is_writable(&local_album_id)
        .is_err());
    assert!(Storage::global()
        .ensure_album_is_writable(&normal_album.id)
        .is_ok());
    assert!(Storage::global()
        .ensure_album_is_writable("missing-album-id")
        .is_ok());
}

#[test]
fn build_entries_recursive_builds_dfs_names_and_parents() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("Pictures");
    fs::create_dir_all(root.join("person/girl")).unwrap();
    fs::create_dir_all(root.join(".hidden")).unwrap();
    fs::write(root.join("person/girl/a.txt"), "ignored").unwrap();

    let entries = build_entries_recursive("图片", &root, None).unwrap();

    assert_eq!(entries.len(), 3);
    assert_eq!(entries[0].name, "图片");
    assert_eq!(entries[1].name, "图片-person");
    assert_eq!(entries[2].name, "图片-person-girl");
    assert_eq!(entries[0].parent_id, None);
    assert_eq!(
        entries[1].parent_id.as_deref(),
        Some(entries[0].id.as_str())
    );
    assert_eq!(
        entries[2].parent_id.as_deref(),
        Some(entries[1].id.as_str())
    );
    assert_eq!(entries[0].sync_folder, root.to_string_lossy());
}

fn image_row_for_path(
    path: &Path,
) -> Option<(String, String, Option<String>, String, Option<i64>)> {
    let conn = Storage::global().db.lock().unwrap();
    conn.query_row(
        "SELECT CAST(id AS TEXT), plugin_id, task_id, display_name, metadata_id
         FROM images WHERE local_path = ?1 ORDER BY id DESC LIMIT 1",
        params![path.to_string_lossy().as_ref()],
        |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
            ))
        },
    )
    .optional()
    .unwrap()
}

fn image_hash_for_path(path: &Path) -> Option<String> {
    let conn = Storage::global().db.lock().unwrap();
    conn.query_row(
        "SELECT hash FROM images WHERE local_path = ?1 ORDER BY id DESC LIMIT 1",
        params![path.to_string_lossy().as_ref()],
        |row| row.get(0),
    )
    .optional()
    .unwrap()
}

fn image_thumbnail_for_path(path: &Path) -> Option<String> {
    let conn = Storage::global().db.lock().unwrap();
    conn.query_row(
        "SELECT thumbnail_path FROM images WHERE local_path = ?1 ORDER BY id DESC LIMIT 1",
        params![path.to_string_lossy().as_ref()],
        |row| row.get(0),
    )
    .optional()
    .unwrap()
}

fn image_count_for_path(path: &Path) -> i64 {
    let conn = Storage::global().db.lock().unwrap();
    conn.query_row(
        "SELECT COUNT(*) FROM images WHERE local_path = ?1",
        params![path.to_string_lossy().as_ref()],
        |row| row.get(0),
    )
    .unwrap()
}

fn album_image_count(album_id: &str) -> i64 {
    let conn = Storage::global().db.lock().unwrap();
    conn.query_row(
        "SELECT COUNT(*) FROM album_images WHERE album_id = ?1",
        params![album_id],
        |row| row.get(0),
    )
    .unwrap()
}

fn folder_status_json(album_id: &str) -> Option<String> {
    let conn = Storage::global().db.lock().unwrap();
    conn.query_row(
        "SELECT folder_status FROM albums WHERE id = ?1",
        params![album_id],
        |row| row.get(0),
    )
    .unwrap()
}

fn temp_album_dir() -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().canonicalize().unwrap();
    (dir, path)
}

#[tokio::test(flavor = "current_thread")]
async fn sync_adds_stable_media_file() {
    let _guard = test_guard();
    let (_tmp, dir) = temp_album_dir();
    let file = dir.join("wall.png");
    write_png(&file, [255, 0, 0]);
    wait_for_stable_window();
    let album_id = create_sync_album(&dir);

    let report = sync_album(&album_id).await.unwrap();

    assert_eq!(report.added, 1);
    assert_eq!(report.deleted, 0);
    assert_eq!(report.reimported, 0);
    let row = image_row_for_path(&file).unwrap();
    assert_eq!(row.1, "local-import");
    assert_eq!(row.2, None);
    assert_eq!(row.3, "wall.png");
    assert_eq!(
        image_thumbnail_for_path(&file).unwrap(),
        file.to_string_lossy().to_string()
    );
    assert_eq!(album_image_count(&album_id), 1);
}

#[tokio::test(flavor = "current_thread")]
async fn sync_large_image_creates_target_sized_thumbnail() {
    let _guard = test_guard();
    let (_tmp, dir) = temp_album_dir();
    let file = dir.join("large.png");
    write_large_png(&file);
    wait_for_stable_window();
    let album_id = create_sync_album(&dir);

    let report = sync_album(&album_id).await.unwrap();

    assert_eq!(report.added, 1);
    let thumbnail = image_thumbnail_for_path(&file).unwrap();
    assert_ne!(thumbnail, file.to_string_lossy());
    let thumbnail_size = fs::metadata(&thumbnail).unwrap().len();
    assert!(
        thumbnail_size.abs_diff(IMAGE_THUMBNAIL_TARGET_BYTES)
            < IMAGE_THUMBNAIL_TARGET_TOLERANCE_BYTES,
        "thumbnail size {} was not within target range",
        thumbnail_size
    );
}

#[test]
fn replace_image_thumbnail_path_deletes_old_independent_thumbnail() {
    let _guard = test_guard();
    let tmp = tempfile::tempdir().unwrap();
    let local = tmp.path().join("source.png");
    let old_thumb = tmp.path().join("old-thumb.jpg");
    write_png(&local, [10, 20, 30]);
    fs::write(&old_thumb, [1u8; 16]).unwrap();

    let local_str = local.to_string_lossy().to_string();
    let old_thumb_str = old_thumb.to_string_lossy().to_string();
    let inserted = Storage::global()
        .add_image(ImageInfo {
            id: String::new(),
            url: None,
            local_path: local_str.clone(),
            plugin_id: "test".to_string(),
            task_id: None,
            surf_record_id: None,
            crawled_at: now_secs() as u64,
            metadata_id: None,
            thumbnail_path: old_thumb_str,
            favorite: false,
            is_hidden: false,
            local_exists: true,
            hash: format!("hash-{}", uuid::Uuid::new_v4()),
            width: None,
            height: None,
            display_name: "source.png".to_string(),
            media_type: Some("image/png".to_string()),
            last_set_wallpaper_at: None,
            size: None,
            album_order: None,
        })
        .unwrap();

    Storage::global()
        .replace_image_thumbnail_path(&inserted.id, &local_str)
        .unwrap();

    assert!(!old_thumb.exists());
    assert_eq!(image_thumbnail_for_path(&local).unwrap(), local_str);
}

#[tokio::test(flavor = "current_thread")]
async fn sync_deletes_db_row_when_file_disappears() {
    let _guard = test_guard();
    let (_tmp, dir) = temp_album_dir();
    let file = dir.join("gone.png");
    write_png(&file, [0, 255, 0]);
    wait_for_stable_window();
    let album_id = create_sync_album(&dir);
    assert_eq!(sync_album(&album_id).await.unwrap().added, 1);

    fs::remove_file(&file).unwrap();
    let report = sync_album(&album_id).await.unwrap();

    assert_eq!(report.deleted, 1);
    assert_eq!(image_count_for_path(&file), 0);
    assert_eq!(album_image_count(&album_id), 0);
}

#[tokio::test(flavor = "current_thread")]
async fn sync_reimports_changed_file_and_carries_user_fields() {
    let _guard = test_guard();
    let (_tmp, dir) = temp_album_dir();
    let file = dir.join("changed.png");
    write_png(&file, [0, 0, 255]);
    wait_for_stable_window();
    let album_id = create_sync_album(&dir);
    assert_eq!(sync_album(&album_id).await.unwrap().added, 1);

    let old = image_row_for_path(&file).unwrap();
    let old_hash = image_hash_for_path(&file).unwrap();
    Storage::global()
        .update_album_images_order(&album_id, &[(old.0.clone(), 42)])
        .unwrap();
    let metadata_hash = format!("metadata-{}", uuid::Uuid::new_v4());
    let metadata_id = {
        let conn = Storage::global().db.lock().unwrap();
        conn.execute(
            "INSERT INTO image_metadata (data, content_hash) VALUES (?1, ?2)",
            params![r#"{"edited":true}"#, metadata_hash],
        )
        .unwrap();
        let metadata_id = conn.last_insert_rowid();
        conn.execute(
            "UPDATE images SET display_name = 'edited-name.png', metadata_id = ?1, crawled_at = 0 WHERE id = ?2",
            params![metadata_id, old.0],
        )
        .unwrap();
        metadata_id
    };

    write_png(&file, [255, 255, 0]);
    wait_for_stable_window();
    let report = sync_album(&album_id).await.unwrap();

    assert_eq!(report.reimported, 1);
    assert_eq!(image_count_for_path(&file), 1);
    let new = image_row_for_path(&file).unwrap();
    assert_ne!(new.0, old.0);
    assert_eq!(new.3, "edited-name.png");
    assert_eq!(new.4, Some(metadata_id));
    let rows = Storage::global()
        .list_album_images_for_sync(&album_id)
        .unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].order, Some(42));
    assert_ne!(image_hash_for_path(&file).unwrap(), old_hash);
    assert!(file.exists(), "reimport must not delete the source file");
}

#[tokio::test(flavor = "current_thread")]
async fn sync_skips_unstable_file_then_adds_later() {
    let _guard = test_guard();
    let (_tmp, dir) = temp_album_dir();
    let file = dir.join("fresh.png");
    write_png(&file, [128, 128, 128]);
    let album_id = create_sync_album(&dir);

    let first = sync_album(&album_id).await.unwrap();
    assert_eq!(first.added, 0);
    assert_eq!(first.skipped_unstable, 1);
    assert_eq!(image_count_for_path(&file), 0);

    wait_for_stable_window();
    let second = sync_album(&album_id).await.unwrap();
    assert_eq!(second.added, 1);
    assert_eq!(second.skipped_unstable, 0);
}

#[tokio::test(flavor = "current_thread")]
async fn sync_persists_missing_folder_status() {
    let _guard = test_guard();
    let dir = tempfile::tempdir().unwrap();
    let missing = dir.path().join("missing");
    let album_id = create_sync_album(&missing);

    let report = sync_album(&album_id).await.unwrap();

    assert!(matches!(report.status, Some(FolderStatus::Missing { .. })));
    let raw = folder_status_json(&album_id).unwrap();
    let parsed: FolderStatus = serde_json::from_str(&raw).unwrap();
    assert!(matches!(parsed, FolderStatus::Missing { .. }));
}

#[tokio::test(flavor = "current_thread")]
async fn startup_sync_skips_when_folder_mtime_is_unchanged() {
    let _guard = test_guard();
    let (_tmp, dir) = temp_album_dir();
    let file = dir.join("wall.png");
    write_png(&file, [255, 0, 0]);
    wait_for_stable_window();
    let album_id = create_sync_album(&dir);

    let first = sync_album(&album_id).await.unwrap();
    assert_eq!(first.added, 1);
    assert!(!first.skipped_unchanged);
    assert!(first
        .status
        .as_ref()
        .and_then(FolderStatus::last_synced_at_ms)
        .is_some());

    let second = sync_album_if_folder_changed(&album_id).await.unwrap();
    assert!(second.skipped_unchanged);
    assert_eq!(second.added, 0);
    assert_eq!(second.deleted, 0);
    assert_eq!(second.reimported, 0);
}

#[tokio::test(flavor = "current_thread")]
async fn skipped_unstable_file_does_not_advance_skip_marker() {
    let _guard = test_guard();
    let (_tmp, dir) = temp_album_dir();
    let file = dir.join("fresh.png");
    write_png(&file, [128, 128, 128]);
    let album_id = create_sync_album(&dir);

    let first = sync_album_if_folder_changed(&album_id).await.unwrap();
    assert_eq!(first.added, 0);
    assert_eq!(first.skipped_unstable, 1);
    assert!(first
        .status
        .as_ref()
        .and_then(FolderStatus::last_synced_at_ms)
        .is_none());

    wait_for_stable_window();
    let second = sync_album_if_folder_changed(&album_id).await.unwrap();
    assert!(!second.skipped_unchanged);
    assert_eq!(second.added, 1);
}
