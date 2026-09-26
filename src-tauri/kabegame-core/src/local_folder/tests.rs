use super::fs_listener::{FsBatch, PathHint};
use super::run_state::{FolderSyncService, SyncKind};
use super::status::FolderStatus;
use super::synchronizer::{self, Descend, FullSyncOptions, SyncCmd, SyncOrigin};
use super::{FolderScanHook, ScanCtx, ScanError, ScanOptions, ScannedDir, ScannedFile, SyncMode};
use crate::app_paths::AppPaths;
use crate::crawler::downloader::{IMAGE_THUMBNAIL_MAX_DIM, IMAGE_THUMBNAIL_SOURCE_THRESHOLD_BYTES};
use crate::settings::Settings;
use crate::storage::{ImageInfo, Storage};
use image::{Rgb, RgbImage};
use rusqlite::{params, OptionalExtension};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{atomic::AtomicBool, Arc, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

static TEST_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static TEST_INIT: OnceLock<()> = OnceLock::new();

fn test_guard() -> MutexGuard<'static, ()> {
    let guard = TEST_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|error| error.into_inner());
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
    let _ = Settings::init_global();
    Storage::init_global().unwrap();
    #[cfg(feature = "ipc-server")]
    {
        let _ = crate::ipc::server::EventBroadcaster::init_global(1000);
        let _ = crate::emitter::GlobalEmitter::init_global();
    }
    let _ = crate::providers::provider_runtime();
}

struct FastSyncGuard(bool);

impl FastSyncGuard {
    fn set(enabled: bool) -> Self {
        let previous = Settings::global().get_fast_folder_sync();
        Settings::global().set_fast_folder_sync(enabled).unwrap();
        Self(previous)
    }
}

impl Drop for FastSyncGuard {
    fn drop(&mut self) {
        let _ = Settings::global().set_fast_folder_sync(self.0);
    }
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

fn write_png(path: &Path, color: [u8; 3]) {
    RgbImage::from_pixel(1, 1, Rgb(color)).save(path).unwrap();
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

fn temp_album_dir() -> (tempfile::TempDir, PathBuf) {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().canonicalize().unwrap();
    (temp, path)
}

fn create_sync_album(sync_folder: &Path, parent_id: Option<&str>, mode: SyncMode) -> String {
    let mut entry = super::build_entries_non_recursive(
        &format!("sync-{}", uuid::Uuid::new_v4().simple()),
        sync_folder,
        parent_id,
    );
    entry.sync_mode = mode;
    Storage::global()
        .add_local_folder_albums_tx(&[entry])
        .unwrap()
        .remove(0)
        .id
}

fn album_exists(album_id: &str) -> bool {
    Storage::global().album_exists(album_id).unwrap()
}

fn album_id_for_path(path: &Path) -> Option<String> {
    let target = path.to_string_lossy();
    Storage::global()
        .list_local_folder_albums()
        .unwrap()
        .into_iter()
        .find(|album| album.sync_folder.as_deref() == Some(target.as_ref()))
        .map(|album| album.id)
}

fn image_id_for_path(path: &Path) -> Option<String> {
    Storage::find_image_by_path(&path.to_string_lossy())
        .unwrap()
        .map(|image| image.id)
}

fn album_image_count(album_id: &str) -> i64 {
    Storage::global()
        .db
        .lock()
        .unwrap()
        .query_row(
            "SELECT COUNT(*) FROM album_images WHERE album_id = ?1",
            params![album_id],
            |row| row.get(0),
        )
        .unwrap()
}

fn image_row_for_path(
    path: &Path,
) -> Option<(String, String, Option<String>, String, Option<i64>)> {
    Storage::global()
        .db
        .lock()
        .unwrap()
        .query_row(
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
    Storage::global()
        .db
        .lock()
        .unwrap()
        .query_row(
            "SELECT hash FROM images WHERE local_path = ?1 ORDER BY id DESC LIMIT 1",
            params![path.to_string_lossy().as_ref()],
            |row| row.get(0),
        )
        .optional()
        .unwrap()
}

fn image_thumbnail_for_path(path: &Path) -> Option<String> {
    Storage::global()
        .db
        .lock()
        .unwrap()
        .query_row(
            "SELECT thumbnail_path FROM images WHERE local_path = ?1 ORDER BY id DESC LIMIT 1",
            params![path.to_string_lossy().as_ref()],
            |row| row.get(0),
        )
        .optional()
        .unwrap()
}

fn image_count_for_path(path: &Path) -> i64 {
    Storage::global()
        .db
        .lock()
        .unwrap()
        .query_row(
            "SELECT COUNT(*) FROM images WHERE local_path = ?1",
            params![path.to_string_lossy().as_ref()],
            |row| row.get(0),
        )
        .unwrap()
}

fn folder_status_json(album_id: &str) -> Option<String> {
    Storage::global()
        .db
        .lock()
        .unwrap()
        .query_row(
            "SELECT folder_status FROM albums WHERE id = ?1",
            params![album_id],
            |row| row.get(0),
        )
        .unwrap()
}

async fn run_full_to_idle(album_id: &str, opts: FullSyncOptions) {
    synchronizer::submit(SyncCmd::Full {
        album_id: album_id.to_string(),
        opts,
    });
    synchronizer::wait_for_idle().await;
}

async fn process_paths(changes: impl IntoIterator<Item = (PathBuf, PathHint)>) {
    synchronizer::submit(SyncCmd::Batch(FsBatch {
        changes: changes.into_iter().collect::<HashMap<_, _>>(),
    }));
    synchronizer::wait_for_idle().await;
}

async fn wait_registered(album_id: &str) {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if FolderSyncService::global().contains_registered(album_id) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("sync task should register");
}

fn manual_opts(descend: Descend) -> FullSyncOptions {
    FullSyncOptions {
        descend,
        origin: SyncOrigin::Manual,
        depth: 0,
    }
}

#[test]
fn writable_guard_rejects_local_folder_albums_only() {
    let _guard = test_guard();
    let tmp = tempfile::tempdir().unwrap();
    let local_album_id = create_sync_album(tmp.path(), None, SyncMode::None);
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
    use url::Url;

    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("Pics");
    fs::create_dir_all(root.join("sub/deep")).unwrap();
    fs::create_dir_all(root.join(".hidden")).unwrap();
    write_png(&root.join("a.png"), [1, 2, 3]);
    write_png(&root.join("sub/b.png"), [4, 5, 6]);
    write_png(&root.join("sub/deep/c.png"), [7, 8, 9]);
    write_png(&root.join(".hidden/h.png"), [0, 0, 0]);
    fs::write(root.join("note.txt"), "x").unwrap();

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
    let mut non_recursive = CollectHook {
        files: vec![],
        dirs: vec![],
    };
    super::scan_and_visit(
        &[root_url.clone()],
        (),
        &ScanOptions::default(),
        &mut non_recursive,
    )
    .await
    .unwrap();
    assert_eq!(non_recursive.files, vec!["a.png".to_string()]);
    assert!(non_recursive.dirs.is_empty());

    let mut recursive = CollectHook {
        files: vec![],
        dirs: vec![],
    };
    let opts = ScanOptions {
        recursive: true,
        skip_hidden_dirs: true,
        ..Default::default()
    };
    super::scan_and_visit(&[root_url], (), &opts, &mut recursive)
        .await
        .unwrap();
    recursive.files.sort();
    assert_eq!(
        recursive.files,
        vec![
            "a.png".to_string(),
            "b.png".to_string(),
            "c.png".to_string()
        ]
    );
    recursive.dirs.sort();
    assert_eq!(recursive.dirs, vec!["deep".to_string(), "sub".to_string()]);
}

#[cfg(unix)]
#[tokio::test(flavor = "current_thread")]
async fn scan_service_skips_linked_folder() {
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
    let scan_ctx = super::scan_and_visit(&[root_url], (), &opts, &mut hook)
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
async fn scan_service_reports_subdirs_without_recursing() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("root");
    fs::create_dir_all(root.join("child")).unwrap();
    write_png(&root.join("root.png"), [1, 2, 3]);
    write_png(&root.join("child/child.png"), [4, 5, 6]);

    struct Hook {
        files: Vec<String>,
        dirs: Vec<String>,
    }
    #[async_trait::async_trait]
    impl FolderScanHook for Hook {
        type DirCtx = ();
        async fn on_enter_dir(
            &mut self,
            _enter: &ScannedDir,
            _ctx: &ScanCtx<Self::DirCtx>,
        ) -> Result<Option<Self::DirCtx>, ScanError> {
            panic!("non-recursive scan must not enter subdirectories")
        }
        async fn on_subdir(
            &mut self,
            dir: &ScannedDir,
            _ctx: &ScanCtx<Self::DirCtx>,
        ) -> Result<(), ScanError> {
            self.dirs.push(dir.name.clone());
            Ok(())
        }
        async fn on_file(
            &mut self,
            file: &ScannedFile,
            _ctx: &ScanCtx<Self::DirCtx>,
        ) -> Result<(), ScanError> {
            self.files.push(file.name.clone());
            Ok(())
        }
    }
    let mut hook = Hook {
        files: Vec::new(),
        dirs: Vec::new(),
    };
    super::scan_and_visit(
        &[url::Url::from_directory_path(&root).unwrap()],
        (),
        &ScanOptions::default(),
        &mut hook,
    )
    .await
    .unwrap();
    assert_eq!(hook.files, ["root.png"]);
    assert_eq!(hook.dirs, ["child"]);
    assert_eq!(
        super::list_child_dirs(&url::Url::from_directory_path(root).unwrap(), false)
            .await
            .unwrap()
            .len(),
        1
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
async fn full_sync_is_one_directory_and_spawns_children() {
    let _guard = test_guard();
    let (_temp, root) = temp_album_dir();
    fs::create_dir(root.join("child")).unwrap();
    write_png(&root.join("root.png"), [1, 1, 1]);
    write_png(&root.join("child/child.png"), [2, 2, 2]);
    let root_id = create_sync_album(&root, None, SyncMode::Recursive);

    run_full_to_idle(&root_id, manual_opts(Descend::CreateMissing)).await;

    let child_id = album_id_for_path(&root.join("child")).expect("child album");
    assert_eq!(album_image_count(&root_id), 1);
    assert_eq!(album_image_count(&child_id), 1);
}

#[tokio::test(flavor = "current_thread")]
async fn batch_adds_and_deletes_file_rows() {
    let _guard = test_guard();
    let (_temp, root) = temp_album_dir();
    let album_id = create_sync_album(&root, None, SyncMode::Shallow);
    let file = root.join("event.png");
    write_png(&file, [3, 4, 5]);
    process_paths([(file.clone(), PathHint::File)]).await;
    assert!(image_id_for_path(&file).is_some());
    assert_eq!(album_image_count(&album_id), 1);

    fs::remove_file(&file).unwrap();
    process_paths([(file.clone(), PathHint::File)]).await;
    assert!(
        image_id_for_path(&file).is_none(),
        "file disappearance deletes the image row"
    );
    assert_eq!(album_image_count(&album_id), 0);
}

#[tokio::test(flavor = "current_thread")]
async fn batch_new_directory_creates_album_and_first_scans() {
    let _guard = test_guard();
    let (_temp, root) = temp_album_dir();
    let root_id = create_sync_album(&root, None, SyncMode::Recursive);
    let child = root.join("new-child");
    fs::create_dir(&child).unwrap();
    write_png(&child.join("first.png"), [6, 7, 8]);

    process_paths([(child.clone(), PathHint::Dir)]).await;

    let child_id = album_id_for_path(&child).expect("event should create child album");
    assert_eq!(album_image_count(&child_id), 1);
    assert!(album_exists(&root_id));
}

#[tokio::test(flavor = "current_thread")]
async fn removing_directory_deletes_album_tree_but_preserves_image_rows() {
    let _guard = test_guard();
    let (_temp, root) = temp_album_dir();
    let child = root.join("child");
    fs::create_dir(&child).unwrap();
    let file = child.join("kept.png");
    write_png(&file, [9, 9, 9]);
    let root_id = create_sync_album(&root, None, SyncMode::Recursive);
    run_full_to_idle(&root_id, manual_opts(Descend::CreateMissing)).await;
    let child_id = album_id_for_path(&child).unwrap();
    let image_id = image_id_for_path(&file).unwrap();

    fs::remove_dir_all(&child).unwrap();
    process_paths([
        (child.clone(), PathHint::Dir),
        (file.clone(), PathHint::File),
    ])
    .await;

    assert!(!album_exists(&child_id));
    assert!(Storage::find_image_by_id(&image_id).unwrap().is_some());
}

#[tokio::test(flavor = "current_thread")]
async fn removing_root_directory_deletes_root_album_and_preserves_rows() {
    let _guard = test_guard();
    let (temp, root) = temp_album_dir();
    let file = root.join("kept-root.png");
    write_png(&file, [10, 10, 10]);
    let root_id = create_sync_album(&root, None, SyncMode::Shallow);
    run_full_to_idle(&root_id, manual_opts(Descend::None)).await;
    let image_id = image_id_for_path(&file).unwrap();
    drop(temp);

    process_paths([
        (root.clone(), PathHint::Dir),
        (file.clone(), PathHint::File),
    ])
    .await;

    assert!(!album_exists(&root_id));
    assert!(Storage::find_image_by_id(&image_id).unwrap().is_some());
}

#[tokio::test(flavor = "current_thread")]
async fn batch_ignores_media_outside_album_directories() {
    let _guard = test_guard();
    let temp = tempfile::tempdir().unwrap();
    let file = temp.path().join("orphan.png");
    write_png(&file, [11, 11, 11]);
    process_paths([(file.clone(), PathHint::File)]).await;
    assert!(image_id_for_path(&file).is_none());
}

#[tokio::test(flavor = "current_thread")]
async fn path_arriving_during_full_sync_runs_after_it() {
    let _guard = test_guard();
    let (_temp, root) = temp_album_dir();
    for index in 0..20 {
        write_png(&root.join(format!("{index:02}.png")), [index, 1, 1]);
    }
    let album_id = create_sync_album(&root, None, SyncMode::Shallow);
    synchronizer::submit(SyncCmd::Full {
        album_id: album_id.clone(),
        opts: FullSyncOptions {
            descend: Descend::None,
            origin: SyncOrigin::Startup,
            depth: 0,
        },
    });
    wait_registered(&album_id).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    let late = root.join("late.png");
    write_png(&late, [12, 12, 12]);
    process_paths([(late.clone(), PathHint::File)]).await;
    assert!(image_id_for_path(&late).is_some());
}

#[tokio::test(flavor = "current_thread")]
async fn cancel_clears_pending_paths() {
    let _guard = test_guard();
    let (_temp, root) = temp_album_dir();
    for index in 0..20 {
        write_png(&root.join(format!("{index:02}.png")), [index, 2, 2]);
    }
    let album_id = create_sync_album(&root, None, SyncMode::Shallow);
    synchronizer::submit(SyncCmd::Full {
        album_id: album_id.clone(),
        opts: FullSyncOptions {
            descend: Descend::None,
            origin: SyncOrigin::Startup,
            depth: 0,
        },
    });
    wait_registered(&album_id).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    let late = root.join("cancel-late.png");
    write_png(&late, [13, 13, 13]);
    synchronizer::submit(SyncCmd::Batch(FsBatch {
        changes: HashMap::from([(late.clone(), PathHint::File)]),
    }));
    tokio::time::timeout(Duration::from_secs(10), async {
        while synchronizer::pending_path_count(&album_id) == 0 {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("diff path should enter the running album slot");
    assert!(synchronizer::cancel(&album_id));
    synchronizer::wait_for_idle().await;
    assert!(image_id_for_path(&late).is_none());
}

#[tokio::test(flavor = "current_thread")]
async fn manual_full_preempts_visible_startup_task() {
    let _guard = test_guard();
    let _ = FolderSyncService::global().take_finished_events();
    let (_temp, root) = temp_album_dir();
    for index in 0..30 {
        write_png(&root.join(format!("{index:02}.png")), [index, 3, 3]);
    }
    let album_id = create_sync_album(&root, None, SyncMode::Shallow);
    synchronizer::submit(SyncCmd::Full {
        album_id: album_id.clone(),
        opts: FullSyncOptions {
            descend: Descend::None,
            origin: SyncOrigin::Startup,
            depth: 0,
        },
    });
    wait_registered(&album_id).await;
    tokio::time::sleep(Duration::from_millis(super::DEBOUNCE_MS + 100)).await;
    synchronizer::submit(SyncCmd::Full {
        album_id: album_id.clone(),
        opts: manual_opts(Descend::None),
    });
    synchronizer::wait_for_idle().await;

    let events = FolderSyncService::global().take_finished_events();
    assert!(events
        .iter()
        .any(|event| event.album_id == album_id && event.preempted));
    assert!(events
        .iter()
        .any(|event| event.album_id == album_id && event.manual));
}

#[tokio::test(flavor = "current_thread")]
async fn startup_and_spawned_requests_do_not_preempt_running_task() {
    let _guard = test_guard();
    let _ = FolderSyncService::global().take_finished_events();
    let (_temp, root) = temp_album_dir();
    for index in 0..20 {
        write_png(&root.join(format!("{index:02}.png")), [index, 4, 4]);
    }
    let album_id = create_sync_album(&root, None, SyncMode::Shallow);
    synchronizer::submit(SyncCmd::Full {
        album_id: album_id.clone(),
        opts: manual_opts(Descend::None),
    });
    wait_registered(&album_id).await;
    for origin in [SyncOrigin::Startup, SyncOrigin::Spawned] {
        synchronizer::submit(SyncCmd::Full {
            album_id: album_id.clone(),
            opts: FullSyncOptions {
                descend: Descend::None,
                origin,
                depth: 0,
            },
        });
    }
    synchronizer::wait_for_idle().await;
    assert!(!FolderSyncService::global()
        .take_finished_events()
        .iter()
        .any(|event| event.album_id == album_id && event.preempted));
}

#[tokio::test(flavor = "current_thread")]
async fn descending_manual_full_preempts_running_descendant() {
    let _guard = test_guard();
    let _ = FolderSyncService::global().take_finished_events();
    let (_temp, root) = temp_album_dir();
    let child = root.join("child");
    fs::create_dir(&child).unwrap();
    for index in 0..30 {
        write_png(&child.join(format!("{index:02}.png")), [index, 5, 5]);
    }
    let root_id = create_sync_album(&root, None, SyncMode::Recursive);
    let child_id = create_sync_album(&child, Some(&root_id), SyncMode::Delegated);
    Storage::global().rechain_local_folder_albums().unwrap();
    synchronizer::submit(SyncCmd::Full {
        album_id: child_id.clone(),
        opts: FullSyncOptions {
            descend: Descend::None,
            origin: SyncOrigin::Startup,
            depth: 1,
        },
    });
    wait_registered(&child_id).await;
    tokio::time::sleep(Duration::from_millis(super::DEBOUNCE_MS + 100)).await;
    synchronizer::submit(SyncCmd::Full {
        album_id: root_id,
        opts: manual_opts(Descend::Existing),
    });
    synchronizer::wait_for_idle().await;
    assert!(FolderSyncService::global()
        .take_finished_events()
        .iter()
        .any(|event| event.album_id == child_id && event.preempted));
}

#[tokio::test(flavor = "current_thread")]
async fn sync_large_image_creates_target_sized_thumbnail() {
    let _guard = test_guard();
    let (_temp, root) = temp_album_dir();
    let file = root.join("large.png");
    write_large_png(&file);
    let album_id = create_sync_album(&root, None, SyncMode::Shallow);

    run_full_to_idle(&album_id, manual_opts(Descend::None)).await;

    assert!(image_id_for_path(&file).is_some());
    let thumbnail = image_thumbnail_for_path(&file).unwrap();
    assert_ne!(thumbnail, file.to_string_lossy());
    let (width, height) = image::image_dimensions(&thumbnail).unwrap();
    assert!(
        width.max(height) <= IMAGE_THUMBNAIL_MAX_DIM,
        "thumbnail longest side {} exceeds cap {}",
        width.max(height),
        IMAGE_THUMBNAIL_MAX_DIM
    );
}

#[tokio::test(flavor = "current_thread")]
async fn sync_reimports_changed_file_and_carries_user_fields() {
    let _guard = test_guard();
    let _fast = FastSyncGuard::set(false);
    let (_temp, root) = temp_album_dir();
    let file = root.join("changed.png");
    write_png(&file, [0, 0, 255]);
    let album_id = create_sync_album(&root, None, SyncMode::Shallow);
    run_full_to_idle(&album_id, manual_opts(Descend::None)).await;

    let old = image_row_for_path(&file).unwrap();
    let old_hash = image_hash_for_path(&file).unwrap();
    Storage::global()
        .update_album_images_order(&album_id, &[(old.0.clone(), 42)])
        .unwrap();
    {
        let conn = Storage::global().db.lock().unwrap();
        conn.execute(
            "INSERT INTO metadata (data) VALUES (?1)",
            params![r#"{"edited":true}"#],
        )
        .unwrap();
        let metadata_id = conn.last_insert_rowid();
        conn.execute(
            "UPDATE images SET display_name = 'edited-name.png', metadata_id = ?1, crawled_at = 0 WHERE id = ?2",
            params![metadata_id, old.0],
        )
        .unwrap();
    }

    write_png(&file, [255, 255, 0]);
    run_full_to_idle(&album_id, manual_opts(Descend::None)).await;

    assert_eq!(image_count_for_path(&file), 1);
    let new = image_row_for_path(&file).unwrap();
    assert_ne!(new.0, old.0);
    assert_eq!(new.3, "edited-name.png");
    let new_metadata_id = new.4.expect("reimport should carry metadata");
    assert_eq!(
        Storage::global()
            .read_metadata_text(new_metadata_id)
            .unwrap()
            .unwrap(),
        r#"{"edited":true}"#
    );
    assert_eq!(
        Storage::get_album_image_order(&album_id, &new.0).unwrap(),
        Some(42)
    );
    assert_ne!(image_hash_for_path(&file).unwrap(), old_hash);
    assert!(file.exists(), "reimport must not delete the source file");
}

#[cfg(unix)]
#[tokio::test(flavor = "current_thread")]
async fn sync_skips_finalize_for_album_with_errored_file() {
    use std::os::unix::fs::PermissionsExt;

    let _guard = test_guard();
    let _fast = FastSyncGuard::set(false);
    let (_temp, root) = temp_album_dir();
    let stale = root.join("stale.png");
    write_png(&stale, [1, 1, 1]);
    let album_id = create_sync_album(&root, None, SyncMode::Shallow);
    run_full_to_idle(&album_id, manual_opts(Descend::None)).await;
    let previous_status = folder_status_json(&album_id);

    fs::remove_file(&stale).unwrap();
    let broken = root.join("broken.png");
    write_png(&broken, [3, 3, 3]);
    let mut permissions = fs::metadata(&broken).unwrap().permissions();
    permissions.set_mode(0o000);
    fs::set_permissions(&broken, permissions).unwrap();

    run_full_to_idle(&album_id, manual_opts(Descend::None)).await;

    let mut restore = fs::metadata(&broken).unwrap().permissions();
    restore.set_mode(0o644);
    fs::set_permissions(&broken, restore).unwrap();

    assert_eq!(album_image_count(&album_id), 1);
    assert_eq!(image_count_for_path(&stale), 1);
    assert!(image_id_for_path(&broken).is_none());
    assert_eq!(
        folder_status_json(&album_id),
        previous_status,
        "有扫描错误的单目录任务不得 finalize 或推进 folder_status"
    );
}

#[tokio::test(flavor = "current_thread")]
async fn cancel_mid_sync_preserves_unseen_images_and_folder_status() {
    let _guard = test_guard();
    let _fast = FastSyncGuard::set(false);
    let _ = FolderSyncService::global().take_finished_events();
    let (_temp, root) = temp_album_dir();
    let existing_file = root.join("z-existing.png");
    write_png(&existing_file, [0, 255, 0]);
    let album_id = create_sync_album(&root, None, SyncMode::Shallow);
    run_full_to_idle(&album_id, manual_opts(Descend::None)).await;
    let previous_status = folder_status_json(&album_id);
    let existing_image_id = image_id_for_path(&existing_file).unwrap();
    let _ = FolderSyncService::global().take_finished_events();

    for index in 0..24 {
        write_png(&root.join(format!("a-new-{index:02}.png")), [index, 6, 6]);
    }
    synchronizer::submit(SyncCmd::Full {
        album_id: album_id.clone(),
        opts: manual_opts(Descend::None),
    });
    wait_registered(&album_id).await;
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if FolderSyncService::global()
                .snapshot()
                .iter()
                .any(|task| task.album_id == album_id && task.added >= 1)
            {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("sync should become visible after importing at least one new file");

    assert!(synchronizer::cancel(&album_id));
    synchronizer::wait_for_idle().await;

    assert_eq!(
        folder_status_json(&album_id),
        previous_status,
        "取消同步不得推进 folder_status"
    );
    assert!(Storage::global()
        .list_album_image_ids_for_sync(&album_id)
        .unwrap()
        .contains(&existing_image_id));
    assert!(FolderSyncService::global()
        .take_finished_events()
        .iter()
        .any(|event| event.album_id == album_id && event.canceled && !event.preempted));
}

#[tokio::test(flavor = "current_thread")]
async fn fast_sync_manual_entry_skips_unchanged_folder_and_preserves_last_synced_at() {
    let _guard = test_guard();
    let _fast = FastSyncGuard::set(true);
    let _ = FolderSyncService::global().take_finished_events();
    let (_temp, root) = temp_album_dir();
    let file = root.join("wall.png");
    write_png(&file, [255, 0, 0]);
    let album_id = create_sync_album(&root, None, SyncMode::Shallow);
    run_full_to_idle(&album_id, manual_opts(Descend::None)).await;
    let first_status: FolderStatus =
        serde_json::from_str(&folder_status_json(&album_id).unwrap()).unwrap();
    let first_last_synced_at_ms = first_status
        .last_synced_at_ms()
        .expect("first sync should persist last_synced_at_ms");
    let _ = FolderSyncService::global().take_finished_events();

    run_full_to_idle(&album_id, manual_opts(Descend::None)).await;

    let second_status: FolderStatus =
        serde_json::from_str(&folder_status_json(&album_id).unwrap()).unwrap();
    assert_eq!(
        second_status.last_synced_at_ms(),
        Some(first_last_synced_at_ms),
        "快速跳过不得推进 last_synced_at_ms"
    );
    assert_eq!(album_image_count(&album_id), 1);
    assert!(FolderSyncService::global()
        .take_finished_events()
        .iter()
        .any(|event| event.album_id == album_id && event.skipped_unchanged));
}

#[tokio::test(flavor = "current_thread")]
async fn disabled_fast_sync_rescans_unchanged_folder() {
    let _guard = test_guard();
    let _fast = FastSyncGuard::set(false);
    let _ = FolderSyncService::global().take_finished_events();
    let (_temp, root) = temp_album_dir();
    write_png(&root.join("wall.png"), [255, 0, 0]);
    let album_id = create_sync_album(&root, None, SyncMode::Shallow);
    run_full_to_idle(&album_id, manual_opts(Descend::None)).await;
    let _ = FolderSyncService::global().take_finished_events();

    run_full_to_idle(&album_id, manual_opts(Descend::None)).await;

    assert_eq!(album_image_count(&album_id), 1);
    assert!(FolderSyncService::global()
        .take_finished_events()
        .iter()
        .any(|event| event.album_id == album_id && event.manual && !event.skipped_unchanged));
}

#[tokio::test(flavor = "current_thread")]
async fn recursive_fast_sync_descends_through_skipped_parents() {
    let _guard = test_guard();
    let initial_fast = FastSyncGuard::set(false);
    let (_temp, root) = temp_album_dir();
    let parent = root.join("parent");
    let child = parent.join("child");
    fs::create_dir_all(&child).unwrap();
    let root_id = create_sync_album(&root, None, SyncMode::Recursive);
    run_full_to_idle(&root_id, manual_opts(Descend::CreateMissing)).await;
    let root_mtime = fs::metadata(&root).unwrap().modified().unwrap();
    let parent_mtime = fs::metadata(&parent).unwrap().modified().unwrap();

    drop(initial_fast);
    let _fast = FastSyncGuard::set(true);
    tokio::time::sleep(Duration::from_millis(20)).await;
    let new_file = child.join("new.png");
    write_png(&new_file, [9, 8, 7]);
    assert_eq!(fs::metadata(&root).unwrap().modified().unwrap(), root_mtime);
    assert_eq!(
        fs::metadata(&parent).unwrap().modified().unwrap(),
        parent_mtime
    );

    run_full_to_idle(&root_id, manual_opts(Descend::CreateMissing)).await;

    let child_id = album_id_for_path(&child).unwrap();
    assert_eq!(album_image_count(&child_id), 1);
    assert!(image_id_for_path(&new_file).is_some());
}

#[tokio::test(flavor = "current_thread")]
async fn recursive_sync_without_create_skips_new_subalbum_dirs() {
    let _guard = test_guard();
    let (_temp, root) = temp_album_dir();
    let cats = root.join("cats");
    let dogs = root.join("dogs");
    fs::create_dir_all(&cats).unwrap();
    fs::create_dir_all(&dogs).unwrap();
    write_png(&cats.join("cat.png"), [2, 2, 2]);
    write_png(&dogs.join("dog.png"), [3, 3, 3]);
    let root_id = create_sync_album(&root, None, SyncMode::Recursive);
    let cats_id = create_sync_album(&cats, Some(&root_id), SyncMode::Delegated);

    run_full_to_idle(&root_id, manual_opts(Descend::Existing)).await;

    assert_eq!(album_image_count(&cats_id), 1);
    assert!(album_id_for_path(&dogs).is_none());
    assert!(image_id_for_path(&dogs.join("dog.png")).is_none());
}

#[tokio::test(flavor = "current_thread")]
async fn recursive_sync_rechains_external_deep_album_under_created_middle_album() {
    let _guard = test_guard();
    let (_temp, root) = temp_album_dir();
    let middle = root.join("middle");
    let deep = middle.join("deep");
    fs::create_dir_all(&deep).unwrap();
    let root_id = create_sync_album(&root, None, SyncMode::Recursive);
    let deep_id = create_sync_album(&deep, None, SyncMode::Shallow);

    run_full_to_idle(&root_id, manual_opts(Descend::CreateMissing)).await;

    let middle_id = album_id_for_path(&middle).expect("middle album should be created");
    assert_eq!(
        Storage::global()
            .get_album_by_id(&deep_id)
            .unwrap()
            .unwrap()
            .parent_id
            .as_deref(),
        Some(middle_id.as_str())
    );
}

#[tokio::test(flavor = "current_thread")]
async fn recursive_sync_does_not_mark_normal_descendant_missing() {
    let _guard = test_guard();
    let (_temp, root) = temp_album_dir();
    let root_id = create_sync_album(&root, None, SyncMode::Recursive);
    let normal_id = uuid::Uuid::new_v4().to_string();
    {
        let conn = Storage::global().db.lock().unwrap();
        conn.execute(
            "INSERT INTO albums (id, name, created_at, parent_id, type, folder_status, ancestor_path)
             VALUES (?1, ?2, ?3, ?4, 'normal', 'normal-sentinel', ?5)",
            params![
                normal_id,
                format!("normal-{}", uuid::Uuid::new_v4().simple()),
                now_secs(),
                root_id,
                format!("/{root_id}/{normal_id}/")
            ],
        )
        .unwrap();
    }

    run_full_to_idle(&root_id, manual_opts(Descend::CreateMissing)).await;

    assert!(Storage::global()
        .get_album_by_id(&normal_id)
        .unwrap()
        .is_some());
    assert_eq!(
        folder_status_json(&normal_id).as_deref(),
        Some("normal-sentinel"),
        "非 delegated 的普通子画册不能被递归同步删除或改写状态"
    );
}

#[tokio::test(flavor = "current_thread")]
async fn sync_persists_non_missing_folder_status_without_removing_album() {
    let _guard = test_guard();
    let temp = tempfile::tempdir().unwrap();
    let file = temp.path().join("not-a-dir");
    fs::write(&file, b"not a directory").unwrap();
    let album_id = create_sync_album(&file, None, SyncMode::Shallow);

    run_full_to_idle(&album_id, manual_opts(Descend::None)).await;

    assert!(album_exists(&album_id));
    let status: FolderStatus =
        serde_json::from_str(&folder_status_json(&album_id).unwrap()).unwrap();
    assert!(matches!(status, FolderStatus::NotADir { .. }));

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        let blocked = temp.path().join("blocked");
        let denied = blocked.join("child");
        fs::create_dir_all(&denied).unwrap();
        let denied_id = create_sync_album(&denied, None, SyncMode::Shallow);
        let mut permissions = fs::metadata(&blocked).unwrap().permissions();
        permissions.set_mode(0o000);
        fs::set_permissions(&blocked, permissions).unwrap();

        run_full_to_idle(&denied_id, manual_opts(Descend::None)).await;

        let mut restore = fs::metadata(&blocked).unwrap().permissions();
        restore.set_mode(0o755);
        fs::set_permissions(&blocked, restore).unwrap();
        assert!(album_exists(&denied_id));
        let status: FolderStatus =
            serde_json::from_str(&folder_status_json(&denied_id).unwrap()).unwrap();
        assert!(matches!(status, FolderStatus::Denied { .. }));
    }
}

#[tokio::test(flavor = "current_thread")]
async fn fast_skip_never_registers_card_but_manual_gets_finished_event() {
    let _guard = test_guard();
    let previous = Settings::global().get_fast_folder_sync();
    Settings::global().set_fast_folder_sync(true).unwrap();
    let _ = FolderSyncService::global().take_finished_events();
    let (_temp, root) = temp_album_dir();
    write_png(&root.join("stable.png"), [14, 14, 14]);
    let album_id = create_sync_album(&root, None, SyncMode::Shallow);
    run_full_to_idle(&album_id, manual_opts(Descend::None)).await;
    let _ = FolderSyncService::global().take_finished_events();

    synchronizer::submit(SyncCmd::Full {
        album_id: album_id.clone(),
        opts: manual_opts(Descend::None),
    });
    synchronizer::wait_for_idle().await;

    assert!(!FolderSyncService::global().contains_registered(&album_id));
    assert!(FolderSyncService::global().snapshot().is_empty());
    assert!(FolderSyncService::global()
        .take_finished_events()
        .iter()
        .any(|event| event.album_id == album_id && event.skipped_unchanged));
    Settings::global().set_fast_folder_sync(previous).unwrap();
}

#[tokio::test(flavor = "current_thread")]
async fn sync_card_stays_hidden_until_debounce() {
    let _guard = test_guard();
    let album_id = format!("visibility-{}", uuid::Uuid::new_v4());
    let cancel = Arc::new(AtomicBool::new(false));
    let guard = FolderSyncService::global().begin(
        album_id.clone(),
        "visibility",
        false,
        SyncKind::Diff,
        SyncOrigin::Event,
        cancel,
    );
    assert!(!FolderSyncService::global()
        .snapshot()
        .iter()
        .any(|task| task.album_id == album_id));
    tokio::time::sleep(Duration::from_millis(super::DEBOUNCE_MS + 50)).await;
    assert!(FolderSyncService::global()
        .snapshot()
        .iter()
        .any(|task| task.album_id == album_id));
    guard.finish(None, false, false);
}

#[test]
fn helper_timestamp_is_valid() {
    assert!(now_secs() > 0);
}
