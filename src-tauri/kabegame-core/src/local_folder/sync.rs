use crate::crawler::downloader::compute_file_hash;
use crate::emitter::GlobalEmitter;
use crate::local_folder::diff::{diff, MaybeReimport};
use crate::local_folder::import::{import_local_file, CarryFromOld};
use crate::local_folder::scan::{dir_mtime_unix_ms, scan_dir};
use crate::local_folder::status::{now_millis, FolderStatus};
use crate::storage::image_events::delete_images_with_events;
use crate::storage::Storage;
use serde_json::json;
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex as StdMutex, OnceLock};
use tokio::sync::Mutex as AsyncMutex;

#[derive(Debug, Default, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncReport {
    pub album_id: String,
    pub status: Option<FolderStatus>,
    pub added: usize,
    pub deleted: usize,
    pub reimported: usize,
    pub skipped_unstable: usize,
    pub skipped_in_flight: bool,
    pub skipped_unchanged: bool,
}

pub async fn sync_album(album_id: &str) -> Result<SyncReport, String> {
    let lock = lock_for(album_id);
    let _guard = match lock.try_lock() {
        Ok(guard) => guard,
        Err(_) => {
            eprintln!("[local_folder] sync_album {album_id} skipped: already in flight");
            return Ok(SyncReport {
                album_id: album_id.to_string(),
                skipped_in_flight: true,
                ..Default::default()
            });
        }
    };
    sync_album_inner(album_id, ScanMode::Force).await
}

pub(crate) async fn sync_album_if_folder_changed(album_id: &str) -> Result<SyncReport, String> {
    let lock = lock_for(album_id);
    let _guard = match lock.try_lock() {
        Ok(guard) => guard,
        Err(_) => {
            eprintln!("[local_folder] sync_album {album_id} skipped: already in flight");
            return Ok(SyncReport {
                album_id: album_id.to_string(),
                skipped_in_flight: true,
                ..Default::default()
            });
        }
    };
    sync_album_inner(album_id, ScanMode::SkipUnchangedFolder).await
}

pub async fn sync_all_local_folder_albums() -> Vec<SyncReport> {
    let albums = match Storage::global().list_local_folder_albums() {
        Ok(albums) => albums,
        Err(err) => {
            eprintln!("[local_folder] list_local_folder_albums failed: {err}");
            return Vec::new();
        }
    };

    let mut reports = Vec::with_capacity(albums.len());
    for album in albums {
        match sync_album_if_folder_changed(&album.id).await {
            Ok(report) => reports.push(report),
            Err(err) => {
                eprintln!("[local_folder] sync_album {} failed: {err}", album.id);
            }
        }
    }
    reports
}

pub async fn sync_albums_by_ids(ids: &[String]) -> Vec<Result<SyncReport, String>> {
    let mut out = Vec::with_capacity(ids.len());
    for id in ids {
        out.push(sync_album(id).await);
    }
    out
}

fn album_locks() -> &'static StdMutex<HashMap<String, Arc<AsyncMutex<()>>>> {
    static LOCKS: OnceLock<StdMutex<HashMap<String, Arc<AsyncMutex<()>>>>> = OnceLock::new();
    LOCKS.get_or_init(|| StdMutex::new(HashMap::new()))
}

fn lock_for(album_id: &str) -> Arc<AsyncMutex<()>> {
    let mut map = album_locks().lock().expect("album_locks poisoned");
    map.entry(album_id.to_string())
        .or_insert_with(|| Arc::new(AsyncMutex::new(())))
        .clone()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ScanMode {
    Force,
    SkipUnchangedFolder,
}

async fn sync_album_inner(album_id: &str, scan_mode: ScanMode) -> Result<SyncReport, String> {
    let mut report = SyncReport {
        album_id: album_id.to_string(),
        ..Default::default()
    };

    let storage = Storage::global();
    let album = storage
        .get_album_by_id(album_id)?
        .ok_or_else(|| format!("album {album_id} not found"))?;

    if album.kind != "local_folder" {
        return Err(format!("album {album_id} is not a local_folder album"));
    }
    let sync_folder = album
        .sync_folder
        .as_deref()
        .ok_or_else(|| format!("album {album_id} missing sync_folder"))?;
    let sync_path = Path::new(sync_folder);

    let scan_started_at_ms = now_millis();
    let folder_mtime_ms = match dir_mtime_unix_ms(sync_path) {
        Ok(ms) => ms,
        Err(status) => {
            persist_status(album_id, &status);
            report.status = Some(status);
            return Ok(report);
        }
    };

    let previous_status = parse_folder_status(album.folder_status.as_deref());
    if scan_mode == ScanMode::SkipUnchangedFolder {
        if let Some(status) = unchanged_status(previous_status.as_ref(), folder_mtime_ms) {
            report.status = Some(status.clone());
            report.skipped_unchanged = true;
            return Ok(report);
        }
    }

    let scan = match scan_dir(sync_path) {
        Ok(scan) => scan,
        Err(status) => {
            persist_status(album_id, &status);
            report.status = Some(status);
            return Ok(report);
        }
    };
    report.skipped_unstable = scan.skipped_unstable;

    let db_rows = storage.list_album_images_for_sync(album_id)?;
    let plan = diff(&scan.files, &db_rows);

    if !plan.deletes.is_empty() {
        report.deleted = plan.deletes.len();
        delete_images_with_events(&plan.deletes, true)?;
    }

    for MaybeReimport { fs, db } in plan.maybe_reimports {
        let new_hash = compute_file_hash(&fs.path).await?;
        if new_hash == db.hash {
            continue;
        }
        let carry = CarryFromOld {
            display_name: db.display_name,
            metadata_id: db.metadata_id,
            order: db.order,
        };
        import_local_file(&fs.path, album_id, fs.size, Some(carry)).await?;
        delete_images_with_events(&[db.image_id], false)?;
        report.reimported += 1;
    }

    for file in plan.adds {
        import_local_file(&file.path, album_id, file.size, None).await?;
        report.added += 1;
    }

    let last_synced_at_ms = if scan.skipped_unstable == 0 && scan.skipped_missing == 0 {
        scan_started_at_ms
    } else {
        previous_status
            .as_ref()
            .and_then(FolderStatus::last_synced_at_ms)
            .unwrap_or(0)
    };
    let ok = FolderStatus::ok_synced_at_ms(last_synced_at_ms);
    persist_status(album_id, &ok);
    report.status = Some(ok);
    Ok(report)
}

fn parse_folder_status(raw: Option<&str>) -> Option<FolderStatus> {
    serde_json::from_str(raw?).ok()
}

fn unchanged_status(status: Option<&FolderStatus>, folder_mtime_ms: u64) -> Option<&FolderStatus> {
    let status = status?;
    let last_synced_at_ms = status.last_synced_at_ms()?;
    if folder_mtime_ms <= last_synced_at_ms {
        Some(status)
    } else {
        None
    }
}

fn persist_status(album_id: &str, status: &FolderStatus) {
    let status_json = status.to_json();
    if let Err(err) = Storage::global().update_album_folder_status(album_id, Some(&status_json)) {
        eprintln!("[local_folder] persist status for {album_id} failed: {err}");
    }
    GlobalEmitter::global().emit_album_changed(
        album_id,
        json!({
            "folderStatus": status_json,
        }),
    );
}
