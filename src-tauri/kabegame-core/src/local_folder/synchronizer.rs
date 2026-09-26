use crate::local_folder::fs_batch::{self, DiffRequest};
use crate::local_folder::fs_listener::FsBatch;
use crate::local_folder::sync::{run_diff, run_full};
use crate::storage::Storage;
use std::collections::{BTreeSet, HashMap};
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    Arc, Mutex, OnceLock,
};
use tokio::sync::{mpsc, Semaphore};

#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, serde::Serialize, serde::Deserialize,
)]
#[serde(rename_all = "camelCase")]
pub enum Descend {
    None,
    Existing,
    CreateMissing,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SyncOrigin {
    Startup,
    Manual,
    Spawned,
    Event,
    System,
}

#[derive(Debug, Clone, Copy)]
pub struct FullSyncOptions {
    pub descend: Descend,
    pub origin: SyncOrigin,
    pub depth: usize,
}

pub(crate) enum SyncCmd {
    Batch(FsBatch),
    Full {
        album_id: String,
        opts: FullSyncOptions,
    },
}

struct Slot {
    running: bool,
    full: Option<FullSyncOptions>,
    paths: BTreeSet<PathBuf>,
    cancel: Option<Arc<AtomicBool>>,
    preempted: Option<Arc<AtomicBool>>,
    ancestor_path: String,
}

impl Default for Slot {
    fn default() -> Self {
        Self {
            running: false,
            full: None,
            paths: BTreeSet::new(),
            cancel: None,
            preempted: None,
            ancestor_path: String::new(),
        }
    }
}

#[derive(Default)]
struct Shared {
    slots: Mutex<HashMap<String, Slot>>,
    queued_commands: AtomicUsize,
}

struct Controller {
    tx: mpsc::UnboundedSender<SyncCmd>,
    shared: Arc<Shared>,
}

static CONTROLLER: OnceLock<Mutex<Option<Controller>>> = OnceLock::new();

fn controller() -> &'static Mutex<Option<Controller>> {
    CONTROLLER.get_or_init(|| Mutex::new(None))
}

pub fn start() {
    let mut current = controller().lock().unwrap_or_else(|e| e.into_inner());
    if current
        .as_ref()
        .is_some_and(|controller| !controller.tx.is_closed())
    {
        return;
    }
    let (tx, rx) = mpsc::unbounded_channel();
    let shared = Arc::new(Shared::default());
    let permits = std::thread::available_parallelism()
        .map(|value| value.get())
        .unwrap_or(1);
    let semaphore = Arc::new(Semaphore::new(permits));
    tokio::spawn(run_loop(rx, Arc::clone(&shared), semaphore));
    *current = Some(Controller { tx, shared });
}

pub(crate) fn submit(cmd: SyncCmd) {
    start();
    let current = controller().lock().unwrap_or_else(|e| e.into_inner());
    let Some(controller) = current.as_ref() else {
        return;
    };
    controller
        .shared
        .queued_commands
        .fetch_add(1, Ordering::Relaxed);
    if controller.tx.send(cmd).is_err() {
        controller
            .shared
            .queued_commands
            .fetch_sub(1, Ordering::Relaxed);
    }
}

async fn run_loop(
    mut rx: mpsc::UnboundedReceiver<SyncCmd>,
    shared: Arc<Shared>,
    semaphore: Arc<Semaphore>,
) {
    while let Some(first) = rx.recv().await {
        let mut commands = vec![first];
        while let Ok(command) = rx.try_recv() {
            commands.push(command);
        }
        let command_count = commands.len();
        let mut merged_batch = FsBatch::default();
        let mut fulls = Vec::new();
        for command in commands {
            match command {
                SyncCmd::Batch(batch) => merged_batch.merge(batch),
                SyncCmd::Full { album_id, opts } => fulls.push((album_id, opts)),
            }
        }

        if !merged_batch.changes.is_empty() {
            let handle = tokio::runtime::Handle::current();
            match tokio::task::spawn_blocking(move || {
                handle.block_on(fs_batch::process_batch(merged_batch))
            })
            .await
            {
                Ok(Ok(requests)) => {
                    for request in requests {
                        enqueue_paths(request, Arc::clone(&shared), Arc::clone(&semaphore));
                    }
                }
                Ok(Err(err)) => eprintln!("[local_folder.synchronizer] batch failed: {err}"),
                Err(err) => eprintln!("[local_folder.synchronizer] batch panicked: {err}"),
            }
        }
        for (album_id, opts) in fulls {
            enqueue_full(album_id, opts, Arc::clone(&shared), Arc::clone(&semaphore)).await;
        }
        shared
            .queued_commands
            .fetch_sub(command_count, Ordering::Relaxed);
    }
}

fn merge_full(current: &mut FullSyncOptions, incoming: FullSyncOptions) {
    current.descend = current.descend.max(incoming.descend);
    current.depth = current.depth.min(incoming.depth);
    if incoming.origin == SyncOrigin::Manual || current.origin != SyncOrigin::Manual {
        current.origin = incoming.origin;
    }
}

fn should_preempt(origin: SyncOrigin) -> bool {
    matches!(
        origin,
        SyncOrigin::Manual | SyncOrigin::System | SyncOrigin::Event
    )
}

async fn enqueue_full(
    album_id: String,
    opts: FullSyncOptions,
    shared: Arc<Shared>,
    semaphore: Arc<Semaphore>,
) {
    let lookup_id = album_id.clone();
    let album_info = tokio::task::spawn_blocking(move || {
        let storage = Storage::global();
        let album = storage.get_album_by_id(&lookup_id)?;
        let albums = if opts.descend != Descend::None && should_preempt(opts.origin) {
            storage.list_local_folder_albums()?
        } else {
            Vec::new()
        };
        Ok::<_, String>((album, albums))
    })
    .await;
    let (album, albums) = match album_info {
        Ok(Ok(value)) => value,
        Ok(Err(err)) => {
            eprintln!("[local_folder.synchronizer] inspect {album_id} failed: {err}");
            return;
        }
        Err(err) => {
            eprintln!("[local_folder.synchronizer] inspect {album_id} panicked: {err}");
            return;
        }
    };
    let Some(album) = album else {
        return;
    };

    let mut spawn = false;
    {
        let mut slots = shared.slots.lock().unwrap_or_else(|e| e.into_inner());
        if should_preempt(opts.origin) && opts.descend != Descend::None {
            for descendant in albums.iter().filter(|candidate| {
                candidate.id != album_id
                    && candidate.ancestor_path.starts_with(&album.ancestor_path)
            }) {
                if let Some(slot) = slots.get_mut(&descendant.id) {
                    if let Some(cancel) = &slot.cancel {
                        cancel.store(true, Ordering::Relaxed);
                    }
                    if let Some(preempted) = &slot.preempted {
                        preempted.store(true, Ordering::Relaxed);
                    }
                    slot.full = None;
                    slot.paths.clear();
                }
            }
        }

        let slot = slots.entry(album_id.clone()).or_default();
        slot.ancestor_path.clone_from(&album.ancestor_path);
        if should_preempt(opts.origin) && slot.running {
            if let Some(cancel) = &slot.cancel {
                cancel.store(true, Ordering::Relaxed);
            }
            if let Some(preempted) = &slot.preempted {
                preempted.store(true, Ordering::Relaxed);
            }
            slot.full = Some(opts);
            slot.paths.clear();
        } else if let Some(current) = slot.full.as_mut() {
            merge_full(current, opts);
        } else {
            slot.full = Some(opts);
        }
        if !slot.running {
            slot.running = true;
            spawn = true;
        }
    }
    if spawn {
        spawn_worker(album_id, shared, semaphore);
    }
}

fn enqueue_paths(request: DiffRequest, shared: Arc<Shared>, semaphore: Arc<Semaphore>) {
    let mut spawn = false;
    {
        let mut slots = shared.slots.lock().unwrap_or_else(|e| e.into_inner());
        let slot = slots.entry(request.album_id.clone()).or_default();
        slot.ancestor_path = request.ancestor_path;
        slot.paths.extend(request.paths);
        if !slot.running {
            slot.running = true;
            spawn = true;
        }
    }
    if spawn {
        spawn_worker(request.album_id, shared, semaphore);
    }
}

fn spawn_worker(album_id: String, shared: Arc<Shared>, semaphore: Arc<Semaphore>) {
    tokio::spawn(async move {
        loop {
            let (full, paths, cancel, preempted) = {
                let mut slots = shared.slots.lock().unwrap_or_else(|e| e.into_inner());
                let Some(slot) = slots.get_mut(&album_id) else {
                    return;
                };
                if slot.full.is_none() && slot.paths.is_empty() {
                    slot.running = false;
                    slot.cancel = None;
                    slot.preempted = None;
                    return;
                }
                let full = slot.full.take();
                let paths = if full.is_some() {
                    slot.paths.clear();
                    BTreeSet::new()
                } else {
                    std::mem::take(&mut slot.paths)
                };
                let cancel = Arc::new(AtomicBool::new(false));
                let preempted = Arc::new(AtomicBool::new(false));
                slot.cancel = Some(Arc::clone(&cancel));
                slot.preempted = Some(Arc::clone(&preempted));
                (full, paths, cancel, preempted)
            };

            let Ok(permit) = Arc::clone(&semaphore).acquire_owned().await else {
                return;
            };
            let task_album_id = album_id.clone();
            let handle = tokio::runtime::Handle::current();
            let result = tokio::task::spawn_blocking(move || {
                let _permit = permit;
                handle.block_on(async move {
                    if let Some(opts) = full {
                        run_full(task_album_id, opts, cancel, preempted).await
                    } else {
                        run_diff(task_album_id, paths, cancel, preempted).await
                    }
                })
            })
            .await;
            match result {
                Ok(Ok(())) => {}
                Ok(Err(err)) => {
                    eprintln!("[local_folder.synchronizer] task {album_id} failed: {err}")
                }
                Err(err) => {
                    eprintln!("[local_folder.synchronizer] task {album_id} panicked: {err}")
                }
            }
        }
    });
}

pub fn cancel(album_id: &str) -> bool {
    let current = controller().lock().unwrap_or_else(|e| e.into_inner());
    let Some(controller) = current.as_ref() else {
        return false;
    };
    let mut slots = controller
        .shared
        .slots
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let Some(slot) = slots.get_mut(album_id) else {
        return false;
    };
    let busy = slot.running || slot.full.is_some() || !slot.paths.is_empty();
    if let Some(cancel) = &slot.cancel {
        cancel.store(true, Ordering::Relaxed);
    }
    slot.full = None;
    slot.paths.clear();
    busy
}

pub fn cancel_all() -> usize {
    let current = controller().lock().unwrap_or_else(|e| e.into_inner());
    let Some(controller) = current.as_ref() else {
        return 0;
    };
    let mut slots = controller
        .shared
        .slots
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let mut canceled = 0;
    for slot in slots.values_mut() {
        if slot.running || slot.full.is_some() || !slot.paths.is_empty() {
            canceled += 1;
        }
        if let Some(cancel) = &slot.cancel {
            cancel.store(true, Ordering::Relaxed);
        }
        slot.full = None;
        slot.paths.clear();
    }
    canceled
}

pub fn is_busy_under(ancestor_path: &str) -> bool {
    let current = controller().lock().unwrap_or_else(|e| e.into_inner());
    let Some(controller) = current.as_ref() else {
        return false;
    };
    let busy = controller
        .shared
        .slots
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .values()
        .any(|slot| {
            (slot.running || slot.full.is_some() || !slot.paths.is_empty())
                && (slot.ancestor_path.starts_with(ancestor_path)
                    || ancestor_path.starts_with(&slot.ancestor_path))
        });
    busy
}

#[cfg(test)]
pub(crate) async fn wait_for_idle() {
    tokio::time::timeout(std::time::Duration::from_secs(30), async {
        loop {
            let idle = {
                let current = controller().lock().unwrap_or_else(|e| e.into_inner());
                current.as_ref().is_none_or(|controller| {
                    controller.shared.queued_commands.load(Ordering::Relaxed) == 0
                        && controller
                            .shared
                            .slots
                            .lock()
                            .unwrap_or_else(|e| e.into_inner())
                            .values()
                            .all(|slot| {
                                !slot.running && slot.full.is_none() && slot.paths.is_empty()
                            })
                })
            };
            if idle {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("local folder synchronizer did not become idle");
}

#[cfg(test)]
pub(crate) fn pending_path_count(album_id: &str) -> usize {
    let current = controller().lock().unwrap_or_else(|e| e.into_inner());
    let Some(controller) = current.as_ref() else {
        return 0;
    };
    let count = controller
        .shared
        .slots
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(album_id)
        .map_or(0, |slot| slot.paths.len());
    count
}
