use crate::crawler::downloader::compute_file_hash;
use crate::emitter::GlobalEmitter;
use crate::local_folder::create::build_entries_non_recursive;
use crate::local_folder::import::{import_local_file, CarryFromOld};
use crate::local_folder::run_state::{FolderSyncFinished, FolderSyncService, SyncKind};
use crate::local_folder::scan::dir_mtime_unix_ms;
use crate::local_folder::scan_service::{
    list_child_dirs, scan_and_visit, FolderScanHook, ScanCtx, ScanError, ScanOptions, ScannedDir,
    ScannedFile, DEFAULT_MAX_DEPTH,
};
use crate::local_folder::status::{now_millis, FolderStatus};
use crate::local_folder::synchronizer::{submit, Descend, FullSyncOptions, SyncCmd, SyncOrigin};
use crate::local_folder::SyncMode;
use crate::media::image_type::is_media_by_path;
use crate::settings::Settings;
use crate::storage::image_events::delete_images_with_events;
use crate::storage::{Album, Storage};
#[cfg(all(feature = "virtual-driver", target_os = "windows"))]
use crate::virtual_driver::driver_service::VirtualDriveServiceTrait;
#[cfg(all(feature = "virtual-driver", not(target_os = "android")))]
use crate::virtual_driver::VirtualDriveService;
use serde_json::json;
use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::{Duration, UNIX_EPOCH};
use url::Url;

const CANCEL_MARKER: &str = "__folder_sync_canceled__";
const SYNC_WRITE_THROTTLE_MS: u64 = 100;

/// 递归同步/创建时需要刻意避开的禁区根（规范化）：仅 VD 挂载点。
pub(crate) fn local_folder_forbidden_roots() -> Vec<PathBuf> {
    #[cfg(all(feature = "virtual-driver", not(target_os = "android")))]
    {
        return VirtualDriveService::global()
            .current_mount_point()
            .map(|mount_point| {
                let path = Path::new(&mount_point);
                path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
            })
            .into_iter()
            .collect();
    }
    #[cfg(not(all(feature = "virtual-driver", not(target_os = "android"))))]
    {
        Vec::new()
    }
}

fn normalize_path(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
}

fn parse_folder_status(raw: Option<&str>) -> Option<FolderStatus> {
    serde_json::from_str(raw?).ok()
}

fn unchanged_status(status: Option<&FolderStatus>, folder_mtime_ms: u64) -> Option<&FolderStatus> {
    let status = status?;
    let last_synced_at_ms = status.last_synced_at_ms()?;
    (folder_mtime_ms <= last_synced_at_ms).then_some(status)
}

fn persist_status(album_id: &str, status: &FolderStatus) {
    let status_json = status.to_json();
    if let Err(err) = Storage::global().update_album_folder_status(album_id, Some(&status_json)) {
        eprintln!("[local_folder] persist status for {album_id} failed: {err}");
    }
    GlobalEmitter::global().emit_album_changed(album_id, json!({ "folderStatus": status_json }));
}

fn base_finished(album: &Album, opts: FullSyncOptions) -> FolderSyncFinished {
    FolderSyncFinished {
        album_id: album.id.clone(),
        album_name: album.name.clone(),
        recursive: opts.descend != Descend::None,
        kind: SyncKind::Full,
        progress: 100.0,
        manual: opts.origin == SyncOrigin::Manual,
        added: 0,
        deleted: 0,
        reimported: 0,
        created_albums: 0,
        canceled: false,
        preempted: false,
        skipped_unchanged: false,
        removed_album: false,
        error: None,
    }
}

fn emit_manual_error(album: &Album, opts: FullSyncOptions, error: &str) {
    if opts.origin != SyncOrigin::Manual {
        return;
    }
    let mut payload = base_finished(album, opts);
    payload.error = Some(error.to_string());
    FolderSyncService::emit_finished_unregistered(payload);
}

/// 删除画册及其子树，只解除图片关联，不删除图片行。
pub(crate) async fn remove_album_tree(album_id: &str) -> Result<(), String> {
    let Some(album) = Storage::global().get_album_by_id(album_id)? else {
        return Ok(());
    };
    crate::commands::album::delete_album(album_id.to_string())?;
    FolderSyncService::emit_finished_unregistered(FolderSyncFinished {
        album_id: album.id,
        album_name: album.name,
        recursive: true,
        kind: SyncKind::Full,
        progress: 100.0,
        manual: false,
        added: 0,
        deleted: 0,
        reimported: 0,
        created_albums: 0,
        canceled: false,
        preempted: false,
        skipped_unchanged: false,
        removed_album: true,
        error: None,
    });
    Ok(())
}

/// 在同一父画册下创建一批直接子目录画册，并处理名称冲突。
pub(crate) fn create_child_albums(
    parent_id: &str,
    dirs: &[ScannedDir],
) -> Result<Vec<Album>, String> {
    let storage = Storage::global();
    let mut entries = Vec::new();
    let mut reserved = HashSet::new();
    for dir in dirs {
        let Some(path) = dir.path.as_deref() else {
            continue;
        };
        let mut name = dir.name.clone();
        let base = name.clone();
        let mut suffix = 2usize;
        while reserved.contains(&name.to_lowercase())
            || storage
                .find_child_album_by_name_ci(Some(parent_id), &name)?
                .is_some()
        {
            name = format!("{base} ({suffix})");
            suffix += 1;
        }
        reserved.insert(name.to_lowercase());
        let mut entry = build_entries_non_recursive(&name, path, Some(parent_id));
        entry.sync_mode = SyncMode::None;
        entries.push(entry);
    }
    storage.add_local_folder_albums_tx(&entries)
}

async fn handle_subdirs(
    parent: &Album,
    dirs: Vec<ScannedDir>,
    opts: FullSyncOptions,
) -> Result<(), String> {
    if opts.descend == Descend::None || opts.depth >= DEFAULT_MAX_DEPTH {
        return Ok(());
    }

    let forbidden = local_folder_forbidden_roots();
    let dirs: Vec<_> = dirs
        .into_iter()
        .filter(|dir| {
            let Some(path) = dir.path.as_deref() else {
                return false;
            };
            let canon = normalize_path(path);
            !forbidden
                .iter()
                .any(|root| canon == *root || canon.starts_with(root))
        })
        .collect();
    let present: HashSet<PathBuf> = dirs
        .iter()
        .filter_map(|dir| dir.path.as_deref().map(normalize_path))
        .collect();
    let albums = Storage::global().list_local_folder_albums()?;
    let mut by_path: HashMap<PathBuf, Album> = albums
        .iter()
        .filter_map(|album| {
            album
                .sync_folder
                .as_deref()
                .map(|path| (normalize_path(Path::new(path)), album.clone()))
        })
        .collect();

    for child in albums.iter().filter(|album| {
        album.parent_id.as_deref() == Some(parent.id.as_str()) && album.kind == "local_folder"
    }) {
        let Some(path) = child.sync_folder.as_deref().map(PathBuf::from) else {
            continue;
        };
        if !present.contains(&normalize_path(&path))
            && matches!(std::fs::metadata(&path), Err(err) if err.kind() == std::io::ErrorKind::NotFound)
        {
            remove_album_tree(&child.id).await?;
        }
    }

    if opts.descend == Descend::CreateMissing {
        let missing: Vec<_> = dirs
            .iter()
            .filter(|dir| {
                dir.path
                    .as_deref()
                    .is_some_and(|path| !by_path.contains_key(&normalize_path(path)))
            })
            .cloned()
            .collect();
        if !missing.is_empty() {
            let created = create_child_albums(&parent.id, &missing)?;
            FolderSyncService::global().update(&parent.id, |state| {
                state.created_albums += created.len()
            });
            Storage::global().rechain_local_folder_albums()?;
            crate::local_folder::fs_listener::reconcile_now().await;
            for album in &created {
                if let Some(path) = album.sync_folder.as_deref() {
                    by_path.insert(normalize_path(Path::new(path)), album.clone());
                }
            }
        }
    }

    for dir in dirs {
        let Some(path) = dir.path.as_deref() else {
            continue;
        };
        let Some(album) = by_path.get(&normalize_path(path)) else {
            continue;
        };
        submit(SyncCmd::Full {
            album_id: album.id.clone(),
            opts: FullSyncOptions {
                descend: opts.descend,
                origin: SyncOrigin::Spawned,
                depth: opts.depth + 1,
            },
        });
    }
    Ok(())
}

struct FullDirHook {
    album_id: String,
    cancel: Arc<AtomicBool>,
    pending_delete: HashSet<String>,
    subdirs: Vec<ScannedDir>,
}

impl FullDirHook {
    fn new(album_id: String, cancel: Arc<AtomicBool>) -> Result<Self, String> {
        Ok(Self {
            pending_delete: Storage::global()
                .list_album_image_ids_for_sync(&album_id)?
                .into_iter()
                .collect(),
            album_id,
            cancel,
            subdirs: Vec::new(),
        })
    }

    fn record_added(&self) {
        FolderSyncService::global().update(&self.album_id, |state| state.added += 1);
    }

    fn record_reimported(&self) {
        FolderSyncService::global().update(&self.album_id, |state| state.reimported += 1);
    }

    async fn import_one(&mut self, file: &ScannedFile) -> Result<bool, String> {
        let Some(path) = file.path.as_deref() else {
            return Ok(false);
        };
        let path_str = path.to_string_lossy();
        let storage = Storage::global();
        let mut wrote = false;

        match Storage::find_image_by_path(&path_str)? {
            Some(existing) => {
                let linked =
                    storage.add_images_to_album_silent(&self.album_id, &[existing.id.clone()]);
                if linked > 0 {
                    GlobalEmitter::global().emit_album_images_change(
                        "add",
                        std::slice::from_ref(&self.album_id),
                        std::slice::from_ref(&existing.id),
                    );
                    self.record_added();
                    wrote = true;
                }
                self.pending_delete.remove(&existing.id);
                let mtime = file.mtime_unix_ms.unwrap_or(0);
                if mtime > (existing.crawled_at as u128) * 1000 + 1000 {
                    let new_hash = compute_file_hash(path).await?;
                    if new_hash != existing.hash {
                        let order = Storage::get_album_image_order(&self.album_id, &existing.id)?;
                        let metadata_text = match existing.metadata_id {
                            Some(mid) => storage.read_metadata_text(mid)?,
                            None => None,
                        };
                        delete_images_with_events(std::slice::from_ref(&existing.id), false)
                            .await?;
                        let metadata_id = match metadata_text {
                            Some(text) => Some(storage.insert_metadata_text(&text)?),
                            None => None,
                        };
                        import_local_file(
                            path,
                            Some(&self.album_id),
                            file.size.unwrap_or(0),
                            Some(CarryFromOld {
                                display_name: existing.display_name,
                                metadata_id,
                                order,
                            }),
                        )
                        .await?;
                        self.record_reimported();
                        wrote = true;
                    }
                }
            }
            None => {
                import_local_file(path, Some(&self.album_id), file.size.unwrap_or(0), None).await?;
                self.record_added();
                wrote = true;
            }
        }
        Ok(wrote)
    }

    async fn finalize(&mut self, synced_at_ms: u64) -> Result<(), String> {
        let mut missing = Vec::new();
        let mut unlink = Vec::new();
        for id in self.pending_delete.drain() {
            match Storage::find_image_by_id(&id)? {
                Some(image) if Path::new(&image.local_path).exists() => unlink.push(id),
                Some(_) => missing.push(id),
                None => {}
            }
        }
        if !unlink.is_empty() {
            Storage::global().remove_images_from_album(&self.album_id, &unlink)?;
            GlobalEmitter::global().emit_album_images_change(
                "delete",
                std::slice::from_ref(&self.album_id),
                &unlink,
            );
        }
        if !missing.is_empty() {
            delete_images_with_events(&missing, false).await?;
        }
        let deleted = unlink.len() + missing.len();
        if deleted > 0 {
            FolderSyncService::global().update(&self.album_id, |state| state.deleted += deleted);
        }
        persist_status(&self.album_id, &FolderStatus::ok_synced_at_ms(synced_at_ms));
        Ok(())
    }
}

#[async_trait::async_trait]
impl FolderScanHook for FullDirHook {
    type DirCtx = ();

    async fn on_enter_dir(
        &mut self,
        _enter: &ScannedDir,
        _ctx: &ScanCtx<Self::DirCtx>,
    ) -> Result<Option<Self::DirCtx>, ScanError> {
        Ok(None)
    }

    async fn on_subdir(
        &mut self,
        dir: &ScannedDir,
        _ctx: &ScanCtx<Self::DirCtx>,
    ) -> Result<(), ScanError> {
        self.subdirs.push(dir.clone());
        Ok(())
    }

    async fn on_file(
        &mut self,
        file: &ScannedFile,
        _ctx: &ScanCtx<Self::DirCtx>,
    ) -> Result<(), ScanError> {
        if self.cancel.load(Ordering::Relaxed) {
            return Err(ScanError::Fatal(CANCEL_MARKER.to_string()));
        }
        if !Storage::global()
            .album_exists(&self.album_id)
            .map_err(ScanError::Skip)?
        {
            return Err(ScanError::Interrupt(format!(
                "album {} deleted during sync",
                self.album_id
            )));
        }
        let wrote = self.import_one(file).await.map_err(ScanError::Skip)?;
        if wrote {
            tokio::time::sleep(Duration::from_millis(SYNC_WRITE_THROTTLE_MS)).await;
        }
        Ok(())
    }

    fn on_progress(&mut self, delta: f64) {
        FolderSyncService::global().update(&self.album_id, |state| {
            state.progress = (state.progress + delta).min(100.0)
        });
    }
}

pub(crate) async fn run_full(
    album_id: String,
    opts: FullSyncOptions,
    cancel: Arc<AtomicBool>,
    preempted: Arc<AtomicBool>,
) -> Result<(), String> {
    let Some(album) = Storage::global().get_album_by_id(&album_id)? else {
        return Ok(());
    };
    if album.kind != "local_folder" {
        return Err(format!("album {album_id} is not a local_folder album"));
    }
    let sync_folder = album
        .sync_folder
        .as_deref()
        .ok_or_else(|| format!("album {album_id} missing sync_folder"))?;
    let sync_path = Path::new(sync_folder);
    let scan_started_at_ms = now_millis();
    let root_mtime_ms = match dir_mtime_unix_ms(sync_path) {
        Ok(ms) => ms,
        Err(FolderStatus::Missing { .. }) => return remove_album_tree(&album_id).await,
        Err(status) => {
            persist_status(&album_id, &status);
            if opts.origin == SyncOrigin::Manual {
                let mut payload = base_finished(&album, opts);
                payload.error = Some(format!("folder status: {status:?}"));
                FolderSyncService::emit_finished_unregistered(payload);
            }
            return Ok(());
        }
    };

    let previous_status = parse_folder_status(album.folder_status.as_deref());
    let last_synced = if Settings::global().get_fast_folder_sync() {
        unchanged_status(previous_status.as_ref(), root_mtime_ms)
            .and_then(FolderStatus::last_synced_at_ms)
    } else {
        None
    };
    let root_url = match Url::from_file_path(sync_path) {
        Ok(url) => url,
        Err(_) => {
            let err = format!("invalid sync_folder path: {sync_folder}");
            emit_manual_error(&album, opts, &err);
            return Err(err);
        }
    };
    if let Some(last_synced_at_ms) = last_synced {
        if opts.descend != Descend::None {
            let dirs = match list_child_dirs(&root_url, true).await {
                Ok(dirs) => dirs,
                Err(err) => {
                    emit_manual_error(&album, opts, &err);
                    return Err(err);
                }
            };
            if let Err(err) = handle_subdirs(&album, dirs, opts).await {
                emit_manual_error(&album, opts, &err);
                return Err(err);
            }
        }
        persist_status(&album_id, &FolderStatus::ok_synced_at_ms(last_synced_at_ms));
        if opts.origin == SyncOrigin::Manual {
            let mut payload = base_finished(&album, opts);
            payload.skipped_unchanged = true;
            FolderSyncService::emit_finished_unregistered(payload);
        }
        return Ok(());
    }

    let guard = FolderSyncService::global().begin(
        album.id.clone(),
        album.name.clone(),
        opts.descend != Descend::None,
        SyncKind::Full,
        opts.origin,
        cancel.clone(),
    );
    let mut hook = match FullDirHook::new(album.id.clone(), cancel.clone()) {
        Ok(hook) => hook,
        Err(err) => {
            guard.finish(Some(err.clone()), false, false);
            return Err(err);
        }
    };
    let scan_options = ScanOptions {
        recursive: false,
        skip_hidden_dirs: opts.descend != Descend::None,
        ..Default::default()
    };
    let scan_ctx = match scan_and_visit(&[root_url.clone()], (), &scan_options, &mut hook).await {
        Ok(ctx) => ctx,
        Err(err) if err == CANCEL_MARKER => {
            guard.finish_canceled(preempted.load(Ordering::Relaxed));
            return Ok(());
        }
        Err(err) => {
            guard.finish(Some(err.clone()), false, false);
            return Err(err);
        }
    };
    if cancel.load(Ordering::Relaxed) {
        guard.finish_canceled(preempted.load(Ordering::Relaxed));
        return Ok(());
    }
    if !scan_ctx.dir_had_errors(&root_url) {
        if let Err(err) = hook.finalize(scan_started_at_ms).await {
            guard.finish(Some(err.clone()), false, false);
            return Err(err);
        }
    }
    if opts.descend != Descend::None && !scan_ctx.dir_had_errors(&root_url) {
        if let Err(err) = handle_subdirs(&album, hook.subdirs, opts).await {
            guard.finish(Some(err.clone()), false, false);
            return Err(err);
        }
    }
    FolderSyncService::global().update(&album_id, |state| state.progress = 100.0);
    guard.finish(None, false, false);
    Ok(())
}

fn scanned_file(path: PathBuf, metadata: std::fs::Metadata) -> ScannedFile {
    let mtime_unix_ms = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis());
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    ScannedFile {
        url: Url::from_file_path(&path).expect("absolute local folder event path"),
        path: Some(path),
        name,
        size: Some(metadata.len()),
        mtime_unix_ms,
        depth: 0,
    }
}

pub(crate) async fn run_diff(
    album_id: String,
    paths: BTreeSet<PathBuf>,
    cancel: Arc<AtomicBool>,
    preempted: Arc<AtomicBool>,
) -> Result<(), String> {
    let Some(album) = Storage::global().get_album_by_id(&album_id)? else {
        return Ok(());
    };
    let guard = FolderSyncService::global().begin(
        album.id.clone(),
        album.name.clone(),
        false,
        SyncKind::Diff,
        SyncOrigin::Event,
        cancel.clone(),
    );
    let mut hook = FullDirHook {
        album_id: album.id.clone(),
        cancel: cancel.clone(),
        pending_delete: HashSet::new(),
        subdirs: Vec::new(),
    };
    let total = paths.len().max(1) as f64;
    let mut missing_ids = Vec::new();

    for (index, path) in paths.into_iter().enumerate() {
        if cancel.load(Ordering::Relaxed) {
            guard.finish_canceled(preempted.load(Ordering::Relaxed));
            return Ok(());
        }
        match std::fs::metadata(&path) {
            Ok(metadata) if metadata.is_file() && is_media_by_path(&path) => {
                let wrote = match hook.import_one(&scanned_file(path, metadata)).await {
                    Ok(wrote) => wrote,
                    Err(err) => {
                        guard.finish(Some(err.clone()), false, false);
                        return Err(err);
                    }
                };
                if wrote {
                    tokio::time::sleep(Duration::from_millis(SYNC_WRITE_THROTTLE_MS)).await;
                }
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                if path.parent().is_some_and(Path::exists) {
                    let image = match Storage::find_image_by_path(&path.to_string_lossy()) {
                        Ok(image) => image,
                        Err(err) => {
                            guard.finish(Some(err.clone()), false, false);
                            return Err(err);
                        }
                    };
                    if let Some(image) = image {
                        missing_ids.push(image.id);
                    }
                }
            }
            _ => {}
        }
        FolderSyncService::global().update(&album_id, |state| {
            state.progress = ((index + 1) as f64 / total * 100.0).min(100.0)
        });
    }
    if !missing_ids.is_empty() {
        if let Err(err) = delete_images_with_events(&missing_ids, false).await {
            guard.finish(Some(err.clone()), false, false);
            return Err(err);
        }
        FolderSyncService::global().update(&album_id, |state| state.deleted += missing_ids.len());
    }
    guard.finish(None, false, false);
    Ok(())
}
