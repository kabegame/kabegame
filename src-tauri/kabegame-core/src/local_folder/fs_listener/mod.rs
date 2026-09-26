//! 本地文件夹的路径级文件系统事件管道。

#[cfg(all(
    feature = "ipc-server",
    any(target_os = "macos", target_os = "windows", target_os = "linux")
))]
use crate::local_folder::SyncMode;
#[cfg(all(
    feature = "ipc-server",
    any(target_os = "macos", target_os = "windows", target_os = "linux")
))]
use crate::storage::Storage;
use std::collections::HashMap;
#[cfg(all(
    feature = "ipc-server",
    any(target_os = "macos", target_os = "windows", target_os = "linux")
))]
use std::path::Path;
use std::path::PathBuf;
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
use tokio::sync::{mpsc, oneshot, Mutex};

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
pub(crate) const MAX_BATCH_DELAY_MS: u64 = 5000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PathHint {
    File,
    Dir,
    Unknown,
}

#[derive(Debug, Default)]
pub(crate) struct FsBatch {
    pub changes: HashMap<PathBuf, PathHint>,
}

impl FsBatch {
    pub fn merge(&mut self, other: Self) {
        for (path, hint) in other.changes {
            merge_change(&mut self.changes, path, hint);
        }
    }
}

#[cfg(all(
    feature = "ipc-server",
    any(target_os = "macos", target_os = "windows", target_os = "linux")
))]
pub(super) enum RawMsg {
    Change { path: PathBuf, hint: PathHint },
    Overflow { detail: String },
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
enum CtlMsg {
    Reconcile(oneshot::Sender<()>),
    Shutdown,
}

#[cfg(all(
    feature = "ipc-server",
    any(target_os = "macos", target_os = "windows", target_os = "linux")
))]
struct ManagerHandle {
    tx: mpsc::UnboundedSender<CtlMsg>,
    join: tokio::task::JoinHandle<()>,
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
    if enabled {
        let tx = {
            let mut slot = manager_cell().lock().await;
            if let Some(handle) = slot.as_ref() {
                handle.tx.clone()
            } else {
                let (ctl_tx, ctl_rx) = mpsc::unbounded_channel();
                let (raw_tx, raw_rx) = mpsc::unbounded_channel();
                let join = tokio::spawn(run_listener(ctl_rx, raw_rx, raw_tx));
                let tx = ctl_tx.clone();
                *slot = Some(ManagerHandle { tx: ctl_tx, join });
                tx
            }
        };
        let (ack_tx, ack_rx) = oneshot::channel();
        let _ = tx.send(CtlMsg::Reconcile(ack_tx));
        let _ = ack_rx.await;
    } else {
        crate::local_folder::synchronizer::cancel_all();
        let handle = manager_cell().lock().await.take();
        if let Some(handle) = handle {
            let _ = handle.tx.send(CtlMsg::Shutdown);
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
pub(crate) async fn reconcile_now() {
    let tx = manager_cell()
        .lock()
        .await
        .as_ref()
        .map(|handle| handle.tx.clone());
    let Some(tx) = tx else {
        return;
    };
    let (ack_tx, ack_rx) = oneshot::channel();
    if tx.send(CtlMsg::Reconcile(ack_tx)).is_ok() {
        let _ = ack_rx.await;
    }
}

#[cfg(not(all(
    feature = "ipc-server",
    any(target_os = "macos", target_os = "windows", target_os = "linux")
)))]
pub(crate) async fn reconcile_now() {}

fn merge_change(changes: &mut HashMap<PathBuf, PathHint>, path: PathBuf, hint: PathHint) {
    changes
        .entry(path)
        .and_modify(|current| {
            if *current != hint {
                *current = PathHint::Unknown;
            }
        })
        .or_insert(hint);
}

#[cfg(all(
    feature = "ipc-server",
    any(target_os = "macos", target_os = "windows", target_os = "linux")
))]
async fn run_listener(
    mut ctl_rx: mpsc::UnboundedReceiver<CtlMsg>,
    mut raw_rx: mpsc::UnboundedReceiver<RawMsg>,
    raw_tx: mpsc::UnboundedSender<RawMsg>,
) {
    use crate::ipc::events::DaemonEventKind;
    use crate::ipc::server::EventBroadcaster;
    use tokio::time::Instant;

    let mut platform = PlatformImpl::new(raw_tx);
    let mut desired = HashMap::new();
    let mut pending = HashMap::new();
    let mut first_at: Option<Instant> = None;
    let mut last_at: Option<Instant> = None;
    let mut album_events = EventBroadcaster::global().subscribe_filtered_stream(&[
        DaemonEventKind::AlbumAdded,
        DaemonEventKind::AlbumChanged,
        DaemonEventKind::AlbumDeleted,
    ]);

    loop {
        let deadline = match (first_at, last_at) {
            (Some(first), Some(last)) => Some(std::cmp::min(
                last + Duration::from_millis(crate::local_folder::DEBOUNCE_MS),
                first + Duration::from_millis(MAX_BATCH_DELAY_MS),
            )),
            _ => None,
        };
        tokio::select! {
            raw = raw_rx.recv() => match raw {
                Some(RawMsg::Change { path, hint }) => {
                    let now = Instant::now();
                    first_at.get_or_insert(now);
                    last_at = Some(now);
                    merge_change(&mut pending, path, hint);
                }
                Some(RawMsg::Overflow { detail }) => {
                    eprintln!("[local_folder.fs_listener] event queue overflow: {detail}");
                }
                None => break,
            },
            control = ctl_rx.recv() => match control {
                Some(CtlMsg::Reconcile(ack)) => {
                    reconcile(&mut platform, &mut desired).await;
                    let _ = ack.send(());
                }
                Some(CtlMsg::Shutdown) | None => {
                    platform.shutdown();
                    break;
                }
            },
            event = album_events.recv() => {
                if event.is_some() {
                    reconcile(&mut platform, &mut desired).await;
                }
            },
            _ = async {
                match deadline {
                    Some(deadline) => tokio::time::sleep_until(deadline).await,
                    None => std::future::pending::<()>().await,
                }
            } => {
                if !pending.is_empty() {
                    crate::local_folder::synchronizer::submit(
                        crate::local_folder::synchronizer::SyncCmd::Batch(FsBatch {
                            changes: std::mem::take(&mut pending),
                        }),
                    );
                }
                first_at = None;
                last_at = None;
            }
        }
    }
}

#[cfg(all(
    feature = "ipc-server",
    any(target_os = "macos", target_os = "windows", target_os = "linux")
))]
async fn reconcile(platform: &mut PlatformImpl, desired: &mut HashMap<String, PathBuf>) {
    let handle = tokio::runtime::Handle::current();
    let next =
        match tokio::task::spawn_blocking(move || handle.block_on(async { collect_desired() }))
            .await
        {
            Ok(Ok(next)) => next,
            Ok(Err(err)) => {
                eprintln!("[local_folder.fs_listener] list albums failed: {err}");
                return;
            }
            Err(err) => {
                eprintln!("[local_folder.fs_listener] reconcile task panicked: {err}");
                return;
            }
        };

    let removed: Vec<_> = desired
        .iter()
        .filter(|(id, path)| next.get(*id) != Some(*path))
        .map(|(id, _)| id.clone())
        .collect();
    for id in removed {
        platform.remove(&id);
        desired.remove(&id);
    }
    for (id, path) in next {
        if desired.get(&id) == Some(&path) {
            continue;
        }
        match platform.add(&id, &path) {
            Ok(()) => {
                desired.insert(id, path);
            }
            Err(err) => {
                persist_folder_status(
                    &id,
                    &crate::local_folder::FolderStatus::now_denied(err.clone()),
                );
                eprintln!(
                    "[local_folder.fs_listener] add watch {} failed: {err}",
                    path.display()
                );
            }
        }
    }
}

#[cfg(all(
    feature = "ipc-server",
    any(target_os = "macos", target_os = "windows", target_os = "linux")
))]
fn collect_desired() -> Result<HashMap<String, PathBuf>, String> {
    let albums = Storage::global().list_local_folder_albums()?;
    let mut next = HashMap::new();
    for album in albums {
        let Some(mode) = SyncMode::from_str(&album.sync_mode) else {
            continue;
        };
        if mode == SyncMode::None {
            continue;
        }
        let Some(folder) = album.sync_folder.as_deref() else {
            continue;
        };
        let path = PathBuf::from(folder);
        match std::fs::metadata(&path) {
            Ok(metadata) if metadata.is_dir() => {
                next.insert(album.id, path);
            }
            Ok(_) => persist_folder_status(
                &album.id,
                &crate::local_folder::FolderStatus::now_not_a_dir(),
            ),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) if err.kind() == std::io::ErrorKind::PermissionDenied => {
                persist_folder_status(
                    &album.id,
                    &crate::local_folder::FolderStatus::now_denied(err.to_string()),
                );
            }
            Err(err) => persist_folder_status(
                &album.id,
                &crate::local_folder::FolderStatus::now_io_error(err.to_string()),
            ),
        }
    }
    Ok(next)
}

#[cfg(all(
    feature = "ipc-server",
    any(target_os = "macos", target_os = "windows", target_os = "linux")
))]
fn persist_folder_status(album_id: &str, status: &crate::local_folder::FolderStatus) {
    use crate::emitter::GlobalEmitter;
    use crate::storage::Storage;
    use serde_json::json;

    let status_json = status.to_json();
    if let Err(err) = Storage::global().update_album_folder_status(album_id, Some(&status_json)) {
        eprintln!("[local_folder.fs_listener] persist status for {album_id} failed: {err}");
        return;
    }
    GlobalEmitter::global().emit_album_changed(album_id, json!({ "folderStatus": status_json }));
}
