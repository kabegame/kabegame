//! Real-time source folder watchers for `local_folder` albums.
//!
//! The public surface is intentionally just `set_enabled`: album set changes
//! are reconciled by subscribing to typed album events from `EventBroadcaster`.

#[cfg(all(
    feature = "ipc-server",
    any(target_os = "macos", target_os = "windows", target_os = "linux")
))]
use std::collections::HashMap;
#[cfg(all(
    feature = "ipc-server",
    any(target_os = "macos", target_os = "windows", target_os = "linux")
))]
use std::path::{Path, PathBuf};
#[cfg(all(
    feature = "ipc-server",
    any(target_os = "macos", target_os = "windows", target_os = "linux")
))]
use std::sync::OnceLock;
#[cfg(all(
    feature = "ipc-server",
    any(target_os = "macos", target_os = "windows", target_os = "linux")
))]
use std::time::Duration;

#[cfg(all(
    feature = "ipc-server",
    any(target_os = "macos", target_os = "windows", target_os = "linux")
))]
use tokio::sync::{mpsc, Mutex};

#[cfg(all(
    feature = "ipc-server",
    any(target_os = "macos", target_os = "windows", target_os = "linux")
))]
use crate::local_folder::SyncMode;

#[cfg(all(feature = "ipc-server", target_os = "linux"))]
mod linux;
#[cfg(all(feature = "ipc-server", target_os = "macos"))]
mod macos;
#[cfg(all(feature = "ipc-server", target_os = "windows"))]
mod windows;

#[cfg(all(feature = "ipc-server", target_os = "linux"))]
use linux::PlatformImpl;
#[cfg(all(feature = "ipc-server", target_os = "macos"))]
use macos::PlatformImpl;
#[cfg(all(feature = "ipc-server", target_os = "windows"))]
use windows::PlatformImpl;

#[cfg(all(
    feature = "ipc-server",
    any(target_os = "macos", target_os = "windows", target_os = "linux")
))]
const DEBOUNCE_MS: u64 = 1500;
#[cfg(all(
    feature = "ipc-server",
    any(target_os = "macos", target_os = "windows", target_os = "linux")
))]
#[derive(Debug, Clone)]
pub struct WatchEvent {
    pub album_id: String,
    pub kind: &'static str,
}

#[cfg(all(
    feature = "ipc-server",
    any(target_os = "macos", target_os = "windows", target_os = "linux")
))]
pub(super) trait PlatformWatcher: Send {
    fn add(&mut self, album_id: &str, path: &Path) -> Result<(), String>;
    fn remove(&mut self, album_id: &str);
    fn shutdown(&mut self);
}

#[cfg(all(
    feature = "ipc-server",
    any(target_os = "macos", target_os = "windows", target_os = "linux")
))]
pub(super) enum ManagerMsg {
    Event(WatchEvent),
    Debounced { album_id: String, generation: u64 },
    Shutdown,
}

#[cfg(all(
    feature = "ipc-server",
    any(target_os = "macos", target_os = "windows", target_os = "linux")
))]
struct ManagerHandle {
    tx: mpsc::Sender<ManagerMsg>,
    join: tokio::task::JoinHandle<()>,
}

#[cfg(all(
    feature = "ipc-server",
    any(target_os = "macos", target_os = "windows", target_os = "linux")
))]
struct PendingDebounce {
    ancestor_path: String,
    mode: SyncMode,
    generation: u64,
    handle: tokio::task::JoinHandle<()>,
}

#[cfg(all(
    feature = "ipc-server",
    any(target_os = "macos", target_os = "windows", target_os = "linux")
))]
static MANAGER: OnceLock<Mutex<Option<ManagerHandle>>> = OnceLock::new();

#[cfg(all(
    feature = "ipc-server",
    any(target_os = "macos", target_os = "windows", target_os = "linux")
))]
fn manager_cell() -> &'static Mutex<Option<ManagerHandle>> {
    MANAGER.get_or_init(|| Mutex::new(None))
}

#[cfg(all(
    feature = "ipc-server",
    any(target_os = "macos", target_os = "windows", target_os = "linux")
))]
pub async fn set_enabled(enabled: bool) {
    let mut slot = manager_cell().lock().await;
    if enabled {
        if slot.is_some() {
            return;
        }

        let (tx, rx) = mpsc::channel::<ManagerMsg>(64);
        let join = tokio::spawn(run_manager(rx, tx.clone()));
        *slot = Some(ManagerHandle { tx, join });
    } else {
        crate::local_folder::FolderSyncService::global().cancel_all();
        if let Some(handle) = slot.take() {
            let _ = handle.tx.send(ManagerMsg::Shutdown).await;
            let _ = handle.join.await;
        }
    }
}

#[cfg(not(all(
    feature = "ipc-server",
    any(target_os = "macos", target_os = "windows", target_os = "linux")
)))]
pub async fn set_enabled(_enabled: bool) {}

#[cfg(all(
    feature = "ipc-server",
    any(target_os = "macos", target_os = "windows", target_os = "linux")
))]
async fn run_manager(mut rx: mpsc::Receiver<ManagerMsg>, self_tx: mpsc::Sender<ManagerMsg>) {
    use crate::ipc::events::DaemonEventKind;
    use crate::ipc::server::EventBroadcaster;

    let mut platform = PlatformImpl::new(self_tx.clone());
    let mut desired: HashMap<String, PathBuf> = HashMap::new();
    let mut modes: HashMap<String, (String, SyncMode)> = HashMap::new();
    let mut debounce: HashMap<String, PendingDebounce> = HashMap::new();
    let mut debounce_generation = 0u64;
    let mut album_events = EventBroadcaster::global().subscribe_filtered_stream(&[
        DaemonEventKind::AlbumAdded,
        DaemonEventKind::AlbumChanged,
        DaemonEventKind::AlbumDeleted,
    ]);

    reconcile(&mut platform, &mut desired, &mut modes).await;
    let _ = crate::local_folder::sync_all_local_folder_albums().await;

    loop {
        tokio::select! {
            maybe_msg = rx.recv() => {
                match maybe_msg {
                    Some(ManagerMsg::Event(event)) => {
                        let album_id = event.album_id;
                        if !desired.contains_key(&album_id) {
                            continue;
                        }
                        let Some((ancestor_path, mode)) = modes.get(&album_id).cloned() else {
                            continue;
                        };
                        if let Some(old) = debounce.remove(&album_id) {
                            old.handle.abort();
                        }

                        let covered_by_pending_ancestor = debounce.iter().any(|(pending_id, pending)| {
                            pending_id != &album_id
                                && mode_covers_descendants(pending.mode)
                                && is_strict_descendant(&ancestor_path, &pending.ancestor_path)
                        });
                        if covered_by_pending_ancestor {
                            continue;
                        }

                        if mode_covers_descendants(mode) {
                            let descendant_ids: Vec<String> = debounce
                                .iter()
                                .filter(|(pending_id, pending)| {
                                    *pending_id != &album_id
                                        && is_strict_descendant(
                                            &pending.ancestor_path,
                                            &ancestor_path,
                                        )
                                })
                                .map(|(pending_id, _)| pending_id.clone())
                                .collect();
                            for descendant_id in descendant_ids {
                                if let Some(pending) = debounce.remove(&descendant_id) {
                                    pending.handle.abort();
                                }
                            }
                        }

                        debounce_generation = debounce_generation.wrapping_add(1);
                        let generation = debounce_generation;
                        let sync_album_id = album_id.clone();
                        let debounced_tx = self_tx.clone();
                        let handle = tokio::spawn(async move {
                            tokio::time::sleep(Duration::from_millis(DEBOUNCE_MS)).await;
                            let _ = debounced_tx
                                .send(ManagerMsg::Debounced {
                                    album_id: sync_album_id,
                                    generation,
                                })
                                .await;
                        });
                        debounce.insert(
                            album_id,
                            PendingDebounce {
                                ancestor_path,
                                mode,
                                generation,
                                handle,
                            },
                        );
                    }
                    Some(ManagerMsg::Debounced { album_id, generation }) => {
                        let is_current = debounce
                            .get(&album_id)
                            .is_some_and(|pending| pending.generation == generation);
                        if !is_current {
                            continue;
                        }
                        debounce.remove(&album_id);
                        if !desired.contains_key(&album_id) {
                            continue;
                        }
                        let Some(mode) = modes.get(&album_id).map(|(_, mode)| *mode) else {
                            continue;
                        };
                        tokio::spawn(sync_album_after_event(album_id, mode));
                    }
                    Some(ManagerMsg::Shutdown) | None => {
                        for (_, pending) in debounce.drain() {
                            pending.handle.abort();
                        }
                        platform.shutdown();
                        break;
                    }
                }
            }
            album_event = album_events.recv() => {
                if album_event.is_some() {
                    reconcile(&mut platform, &mut desired, &mut modes).await;
                    let stale_ids: Vec<String> = debounce
                        .keys()
                        .filter(|id| !desired.contains_key(*id))
                        .cloned()
                        .collect();
                    for id in stale_ids {
                        if let Some(pending) = debounce.remove(&id) {
                            pending.handle.abort();
                        }
                    }
                    for (id, pending) in &mut debounce {
                        if let Some((ancestor_path, mode)) = modes.get(id) {
                            pending.ancestor_path.clone_from(ancestor_path);
                            pending.mode = *mode;
                        }
                    }
                }
            }
        }
    }
}

#[cfg(all(
    feature = "ipc-server",
    any(target_os = "macos", target_os = "windows", target_os = "linux")
))]
fn mode_covers_descendants(mode: SyncMode) -> bool {
    matches!(mode, SyncMode::Recursive | SyncMode::Delegated)
}

#[cfg(all(
    feature = "ipc-server",
    any(target_os = "macos", target_os = "windows", target_os = "linux")
))]
fn is_strict_descendant(path: &str, ancestor_path: &str) -> bool {
    path.len() > ancestor_path.len() && path.starts_with(ancestor_path)
}

#[cfg(all(
    feature = "ipc-server",
    any(target_os = "macos", target_os = "windows", target_os = "linux")
))]
async fn sync_album_after_event(album_id: String, mode: SyncMode) {
    if let Err(err) = crate::local_folder::sync_album_for_mode_with_retry(&album_id, mode).await {
        eprintln!("[local_folder.watch] sync_album {album_id} failed: {err}");
    }
}

#[cfg(all(
    feature = "ipc-server",
    any(target_os = "macos", target_os = "windows", target_os = "linux")
))]
async fn reconcile(
    platform: &mut PlatformImpl,
    desired: &mut HashMap<String, PathBuf>,
    modes: &mut HashMap<String, (String, SyncMode)>,
) {
    let albums = match list_local_folder_albums() {
        Ok(albums) => albums,
        Err(err) => {
            eprintln!("[local_folder.watch] list local_folder albums failed: {err}");
            return;
        }
    };

    let mut next = HashMap::new();
    let mut next_modes = HashMap::new();
    for album in albums {
        let Some(mode) = SyncMode::from_str(&album.sync_mode) else {
            eprintln!(
                "[local_folder.watch] skip album {} with invalid sync_mode {}",
                album.id, album.sync_mode
            );
            continue;
        };
        next_modes.insert(album.id.clone(), (album.ancestor_path.clone(), mode));
        if mode == SyncMode::None {
            continue;
        }
        let Some(folder) = album.sync_folder.as_deref() else {
            continue;
        };
        let path = PathBuf::from(folder);
        if let Some(status) = invalid_path_status(&path) {
            if !folder_status_matches(album.folder_status.as_deref(), &status) {
                persist_folder_status(&album.id, &status);
            }
            continue;
        }
        next.insert(album.id, path);
    }

    let removed_ids: Vec<String> = desired
        .iter()
        .filter(|(id, path)| next.get(*id).map_or(true, |next_path| next_path != *path))
        .map(|(id, _)| id.clone())
        .collect();
    for id in removed_ids {
        platform.remove(&id);
        desired.remove(&id);
    }

    for (id, path) in next {
        if desired.get(&id).is_some_and(|old| old == &path) {
            continue;
        }

        match platform.add(&id, &path) {
            Ok(()) => {
                desired.insert(id, path);
            }
            Err(err) => {
                let status = crate::local_folder::FolderStatus::now_denied(err.clone());
                persist_folder_status(&id, &status);
                eprintln!(
                    "[local_folder.watch] add watch for album {id} ({}) failed: {err}",
                    path.display()
                );
            }
        }
    }
    *modes = next_modes;
}

#[cfg(all(
    feature = "ipc-server",
    any(target_os = "macos", target_os = "windows", target_os = "linux")
))]
fn list_local_folder_albums() -> Result<Vec<crate::storage::Album>, String> {
    crate::providers::query_fetch("albums://byType/local_folder")?
        .into_iter()
        .map(|row| {
            serde_json::from_value(row)
                .map_err(|err| format!("decode albums://byType/local_folder row: {err}"))
        })
        .collect()
}

#[cfg(all(
    feature = "ipc-server",
    any(target_os = "macos", target_os = "windows", target_os = "linux")
))]
fn invalid_path_status(path: &Path) -> Option<crate::local_folder::FolderStatus> {
    match std::fs::metadata(path) {
        Ok(meta) if meta.is_dir() => None,
        Ok(_) => Some(crate::local_folder::FolderStatus::now_not_a_dir()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            Some(crate::local_folder::FolderStatus::now_missing())
        }
        Err(err) if err.kind() == std::io::ErrorKind::PermissionDenied => Some(
            crate::local_folder::FolderStatus::now_denied(err.to_string()),
        ),
        Err(err) => Some(crate::local_folder::FolderStatus::now_io_error(
            err.to_string(),
        )),
    }
}

#[cfg(all(
    feature = "ipc-server",
    any(target_os = "macos", target_os = "windows", target_os = "linux")
))]
fn folder_status_matches(raw: Option<&str>, next: &crate::local_folder::FolderStatus) -> bool {
    let Some(raw) = raw else {
        return false;
    };
    let Ok(current) = serde_json::from_str::<crate::local_folder::FolderStatus>(raw) else {
        return false;
    };
    match (&current, next) {
        (
            crate::local_folder::FolderStatus::Ok { .. },
            crate::local_folder::FolderStatus::Ok { .. },
        )
        | (
            crate::local_folder::FolderStatus::Missing { .. },
            crate::local_folder::FolderStatus::Missing { .. },
        )
        | (
            crate::local_folder::FolderStatus::NotADir { .. },
            crate::local_folder::FolderStatus::NotADir { .. },
        ) => true,
        (
            crate::local_folder::FolderStatus::Denied { message: a, .. },
            crate::local_folder::FolderStatus::Denied { message: b, .. },
        )
        | (
            crate::local_folder::FolderStatus::IoError { message: a, .. },
            crate::local_folder::FolderStatus::IoError { message: b, .. },
        ) => a == b,
        _ => false,
    }
}

#[cfg(all(
    feature = "ipc-server",
    any(target_os = "macos", target_os = "windows", target_os = "linux")
))]
fn persist_folder_status(album_id: &str, status: &crate::local_folder::FolderStatus) {
    use serde_json::json;

    let status_json = status.to_json();
    if let Err(err) =
        crate::storage::Storage::global().update_album_folder_status(album_id, Some(&status_json))
    {
        eprintln!("[local_folder.watch] persist status for {album_id} failed: {err}");
        return;
    }
    crate::emitter::GlobalEmitter::global().emit_album_changed(
        album_id,
        json!({
            "folderStatus": status_json,
        }),
    );
}
