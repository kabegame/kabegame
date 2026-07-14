use super::status::FolderStatus;
use super::sync::sync_album_if_folder_changed;
use super::sync_album;
use crate::app_paths::AppPaths;
use crate::crawler::downloader::{IMAGE_THUMBNAIL_MAX_DIM, IMAGE_THUMBNAIL_SOURCE_THRESHOLD_BYTES};
use crate::storage::{ImageInfo, Storage};
use image::{Rgb, RgbImage};
use rusqlite::{params, OptionalExtension};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

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
        compatibles_dir_path: root.join("compatibles"),
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
    create_sync_album_with_parent(sync_folder, None)
}

fn create_sync_album_with_parent(sync_folder: &Path, parent_id: Option<&str>) -> String {
    let album_id = uuid::Uuid::new_v4().to_string();
    let storage = Storage::global();
    let conn = storage.db.lock().unwrap();
    conn.execute(
        "INSERT INTO albums (id, name, created_at, parent_id, type, sync_folder, folder_status)
         VALUES (?1, ?2, ?3, ?4, 'local_folder', ?5, NULL)",
        params![
            album_id,
            format!("sync-{}", uuid::Uuid::new_v4().simple()),
            now_secs(),
            parent_id,
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

#[tokio::test(flavor = "current_thread")]
async fn scan_service_recursive_filters_and_hidden() {
    use super::scan_service::{
        scan_and_visit, FolderScanHook, ScanCtx, ScanError, ScanOptions, ScannedDir, ScannedFile,
    };
    use url::Url;

    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("Pics");
    fs::create_dir_all(root.join("sub/deep")).unwrap();
    fs::create_dir_all(root.join(".hidden")).unwrap();
    write_png(&root.join("a.png"), [1, 2, 3]);
    write_png(&root.join("sub/b.png"), [4, 5, 6]);
    write_png(&root.join("sub/deep/c.png"), [7, 8, 9]);
    write_png(&root.join(".hidden/h.png"), [0, 0, 0]);
    fs::write(root.join("note.txt"), "x").unwrap(); // 非媒体

    struct CollectHook {
        files: Vec<String>,
        dirs: Vec<String>,
    }
    #[async_trait::async_trait]
    impl FolderScanHook for CollectHook {
        type DirCtx = ();
        async fn on_enter_dir(
            &mut self,
            dir: &ScannedDir,
            _ctx: &ScanCtx<()>,
        ) -> Result<Option<()>, ScanError> {
            self.dirs.push(dir.name.clone());
            Ok(Some(()))
        }
        async fn on_file(
            &mut self,
            file: &ScannedFile,
            _ctx: &ScanCtx<()>,
        ) -> Result<(), ScanError> {
            self.files.push(file.name.clone());
            Ok(())
        }
    }

    let root_url = Url::from_file_path(&root).unwrap();

    // 非递归：仅根层 a.png（note.txt 非媒体被过滤）。
    let mut h = CollectHook {
        files: vec![],
        dirs: vec![],
    };
    scan_and_visit(&[root_url.clone()], (), &ScanOptions::default(), &mut h)
        .await
        .unwrap();
    assert_eq!(h.files, vec!["a.png".to_string()]);
    assert!(h.dirs.is_empty());

    // 递归 + 跳过隐藏目录：a/b/c.png；进入 sub、deep（.hidden 跳过）。
    let mut h2 = CollectHook {
        files: vec![],
        dirs: vec![],
    };
    let opts = ScanOptions {
        recursive: true,
        skip_hidden_dirs: true,
        ..Default::default()
    };
    scan_and_visit(&[root_url], (), &opts, &mut h2)
        .await
        .unwrap();
    h2.files.sort();
    assert_eq!(
        h2.files,
        vec![
            "a.png".to_string(),
            "b.png".to_string(),
            "c.png".to_string()
        ]
    );
    h2.dirs.sort();
    assert_eq!(h2.dirs, vec!["deep".to_string(), "sub".to_string()]);
}

#[cfg(unix)]
#[tokio::test(flavor = "current_thread")]
async fn scan_service_skips_linked_folder() {
    use super::scan_service::{
        scan_and_visit, FolderScanHook, ScanCtx, ScanError, ScanOptions, ScannedDir, ScannedFile,
    };
    use std::os::unix::fs::symlink;
    use url::Url;

    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("root");
    let linked_target = tmp.path().join("linked-target");
    fs::create_dir_all(&root).unwrap();
    fs::create_dir_all(&linked_target).unwrap();
    write_png(&linked_target.join("inside.png"), [9, 9, 9]);
    let link = root.join("linked");
    symlink(&linked_target, &link).unwrap();

    struct CollectHook {
        files: Vec<String>,
        dirs: Vec<String>,
    }
    #[async_trait::async_trait]
    impl FolderScanHook for CollectHook {
        type DirCtx = ();
        async fn on_enter_dir(
            &mut self,
            enter: &ScannedDir,
            _ctx: &ScanCtx<()>,
        ) -> Result<Option<()>, ScanError> {
            self.dirs.push(enter.name.clone());
            Ok(Some(()))
        }
        async fn on_file(
            &mut self,
            file: &ScannedFile,
            _ctx: &ScanCtx<()>,
        ) -> Result<(), ScanError> {
            self.files.push(file.name.clone());
            Ok(())
        }
    }

    let mut hook = CollectHook {
        files: vec![],
        dirs: vec![],
    };
    let opts = ScanOptions {
        recursive: true,
        ..Default::default()
    };
    let root_url = Url::from_file_path(&root).unwrap();
    let scan_ctx = scan_and_visit(&[root_url], (), &opts, &mut hook)
        .await
        .unwrap();

    assert!(hook.files.is_empty());
    assert!(hook.dirs.is_empty());

    let link_url = Url::from_file_path(&link).unwrap();
    let issue = scan_ctx
        .issues()
        .iter()
        .find(|issue| issue.dir == link_url && issue.entry.as_ref() == Some(&link_url))
        .expect("linked folder should be recorded as a scan issue");
    assert!(matches!(
        &issue.error,
        ScanError::Skip(message) if message.contains("linked folder")
    ));
}

#[tokio::test(flavor = "current_thread")]
async fn recursive_sync_creates_subalbums_and_imports() {
    let _guard = test_guard();
    let (_tmp, dir) = temp_album_dir();
    write_png(&dir.join("root.png"), [1, 1, 1]);
    fs::create_dir_all(dir.join("cats")).unwrap();
    write_png(&dir.join("cats/cat.png"), [2, 2, 2]);
    let album_id = create_sync_album(&dir);

    let report = super::sync_album_recursive(&album_id, vec![])
        .await
        .unwrap();

    assert_eq!(report.created_albums, 1, "应为 cats 子目录建一个子画册");
    assert_eq!(report.added, 2);
    assert_eq!(album_image_count(&album_id), 1, "根画册装 root.png");

    let child_id: String = {
        let conn = Storage::global().db.lock().unwrap();
        conn.query_row(
            "SELECT id FROM albums WHERE parent_id = ?1",
            params![album_id],
            |row| row.get(0),
        )
        .unwrap()
    };
    assert_eq!(album_image_count(&child_id), 1, "子画册装 cat.png");
}

#[tokio::test(flavor = "current_thread")]
async fn recursive_sync_without_create_skips_new_subalbum_dirs() {
    let _guard = test_guard();
    let (_tmp, dir) = temp_album_dir();
    let cats_dir = dir.join("cats");
    let dogs_dir = dir.join("dogs");
    fs::create_dir_all(&cats_dir).unwrap();
    fs::create_dir_all(&dogs_dir).unwrap();
    write_png(&cats_dir.join("cat.png"), [2, 2, 2]);
    write_png(&dogs_dir.join("dog.png"), [3, 3, 3]);

    let album_id = create_sync_album(&dir);
    let cats_album_id = create_sync_album_with_parent(&cats_dir, Some(&album_id));

    let report = super::sync_album_recursive_with_options(
        &album_id,
        vec![],
        super::RecursiveSyncOptions {
            create_missing_albums: false,
        },
    )
    .await
    .unwrap();

    assert_eq!(report.created_albums, 0);
    assert_eq!(album_image_count(&cats_album_id), 1);
    assert!(
        !album_exists_for_sync_folder(&dogs_dir),
        "new subdirectories should be skipped when create_missing_albums=false"
    );
}

#[cfg(unix)]
#[tokio::test(flavor = "current_thread")]
async fn sync_skips_finalize_for_album_with_errored_file() {
    use std::os::unix::fs::PermissionsExt;

    let _guard = test_guard();
    let (_tmp, dir) = temp_album_dir();
    let bad_dir = dir.join("bad");
    let clean_dir = dir.join("clean");
    fs::create_dir_all(&bad_dir).unwrap();
    fs::create_dir_all(&clean_dir).unwrap();

    let bad_stale = bad_dir.join("stale.png");
    let clean_stale = clean_dir.join("stale.png");
    write_png(&bad_stale, [1, 1, 1]);
    write_png(&clean_stale, [2, 2, 2]);

    let album_id = create_sync_album(&dir);
    let first = super::sync_album_recursive(&album_id, vec![])
        .await
        .unwrap();
    assert_eq!(first.added, 2);

    let bad_album_id = album_id_for_sync_folder(&bad_dir);
    let clean_album_id = album_id_for_sync_folder(&clean_dir);
    assert_eq!(album_image_count(&bad_album_id), 1);
    assert_eq!(album_image_count(&clean_album_id), 1);

    fs::remove_file(&bad_stale).unwrap();
    fs::remove_file(&clean_stale).unwrap();
    let broken = bad_dir.join("broken.png");
    write_png(&broken, [3, 3, 3]);
    let mut perms = fs::metadata(&broken).unwrap().permissions();
    perms.set_mode(0o000);
    fs::set_permissions(&broken, perms).unwrap();

    let second = super::sync_album_recursive(&album_id, vec![])
        .await
        .unwrap();

    let mut restore = fs::metadata(&broken).unwrap().permissions();
    restore.set_mode(0o644);
    fs::set_permissions(&broken, restore).unwrap();

    assert_eq!(second.deleted, 1, "clean sibling should still reconcile");
    assert_eq!(
        album_image_count(&bad_album_id),
        1,
        "errored album keeps stale image linked"
    );
    assert_eq!(
        album_image_count(&clean_album_id),
        0,
        "clean sibling unlinks stale image"
    );
    assert_eq!(image_count_for_path(&bad_stale), 1);
    assert_eq!(image_count_for_path(&clean_stale), 1);
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

fn album_id_for_sync_folder(path: &Path) -> String {
    let conn = Storage::global().db.lock().unwrap();
    conn.query_row(
        "SELECT id FROM albums WHERE sync_folder = ?1",
        params![path.to_string_lossy().as_ref()],
        |row| row.get(0),
    )
    .unwrap()
}

fn album_exists_for_sync_folder(path: &Path) -> bool {
    let conn = Storage::global().db.lock().unwrap();
    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM albums WHERE sync_folder = ?1",
            params![path.to_string_lossy().as_ref()],
            |row| row.get(0),
        )
        .unwrap();
    count > 0
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
    let album_id = create_sync_album(&dir);

    let report = sync_album(&album_id).await.unwrap();

    assert_eq!(report.added, 1);
    let thumbnail = image_thumbnail_for_path(&file).unwrap();
    assert_ne!(thumbnail, file.to_string_lossy());
    let (tw, th) = image::image_dimensions(&thumbnail).unwrap();
    assert!(
        tw.max(th) <= IMAGE_THUMBNAIL_MAX_DIM,
        "thumbnail longest side {} exceeds cap {}",
        tw.max(th),
        IMAGE_THUMBNAIL_MAX_DIM
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
            plugin_id: Some("test".to_string()),
            task_id: None,
            surf_record_id: None,
            crawled_at: now_secs() as u64,
            metadata_id: None,
            plugin_version: 0,
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
            compatible_path: None,
            post_url: None,
        })
        .unwrap();

    Storage::global()
        .replace_image_thumbnail_path(&inserted.id, &local_str)
        .unwrap();

    assert!(!old_thumb.exists());
    assert_eq!(image_thumbnail_for_path(&local).unwrap(), local_str);
}

#[tokio::test(flavor = "current_thread")]
async fn sync_unlinks_from_album_when_file_disappears() {
    let _guard = test_guard();
    let (_tmp, dir) = temp_album_dir();
    let file = dir.join("gone.png");
    write_png(&file, [0, 255, 0]);
    let album_id = create_sync_album(&dir);
    assert_eq!(sync_album(&album_id).await.unwrap().added, 1);

    fs::remove_file(&file).unwrap();
    let report = sync_album(&album_id).await.unwrap();

    assert_eq!(report.deleted, 1);
    assert_eq!(image_count_for_path(&file), 1);
    assert_eq!(album_image_count(&album_id), 0);
}

#[tokio::test(flavor = "current_thread")]
async fn sync_reimports_changed_file_and_carries_user_fields() {
    let _guard = test_guard();
    let (_tmp, dir) = temp_album_dir();
    let file = dir.join("changed.png");
    write_png(&file, [0, 0, 255]);
    let album_id = create_sync_album(&dir);
    assert_eq!(sync_album(&album_id).await.unwrap().added, 1);

    let old = image_row_for_path(&file).unwrap();
    let old_hash = image_hash_for_path(&file).unwrap();
    Storage::global()
        .update_album_images_order(&album_id, &[(old.0.clone(), 42)])
        .unwrap();
    let metadata_id = {
        let conn = Storage::global().db.lock().unwrap();
        conn.execute(
            "INSERT INTO image_metadata (data) VALUES (?1)",
            params![r#"{"edited":true}"#],
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
    let report = sync_album(&album_id).await.unwrap();

    assert_eq!(report.reimported, 1);
    assert_eq!(image_count_for_path(&file), 1);
    let new = image_row_for_path(&file).unwrap();
    assert_ne!(new.0, old.0);
    assert_eq!(new.3, "edited-name.png");
    // 重导入「保存再写入」metadata：内容必须保留；id 可能变化（旧行被 GC 后重建）均可。
    let new_metadata_id = new.4.expect("reimport should carry metadata");
    assert_eq!(
        Storage::global()
            .read_image_metadata_text(new_metadata_id)
            .unwrap()
            .unwrap(),
        r#"{"edited":true}"#
    );
    let _ = metadata_id;
    let ids = Storage::global()
        .list_album_image_ids_for_sync(&album_id)
        .unwrap();
    assert_eq!(ids.len(), 1);
    assert_eq!(
        Storage::get_album_image_order(&album_id, &new.0).unwrap(),
        Some(42)
    );
    assert_ne!(image_hash_for_path(&file).unwrap(), old_hash);
    assert!(file.exists(), "reimport must not delete the source file");
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
