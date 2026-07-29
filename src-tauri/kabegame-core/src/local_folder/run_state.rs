use crate::emitter::GlobalEmitter;
use crate::local_folder::status::now_millis;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex, OnceLock,
};
use std::time::{Duration, Instant};

const PROGRESS_THROTTLE: Duration = Duration::from_millis(200);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderSyncTaskState {
    pub album_id: String,
    pub album_name: String,
    pub recursive: bool,
    pub added: usize,
    pub deleted: usize,
    pub reimported: usize,
    pub created_albums: usize,
    pub started_at_ms: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FolderSyncFinished {
    album_id: String,
    album_name: String,
    recursive: bool,
    added: usize,
    deleted: usize,
    reimported: usize,
    created_albums: usize,
    canceled: bool,
    error: Option<String>,
}

struct FolderSyncTask {
    state: FolderSyncTaskState,
    cancel: Arc<AtomicBool>,
}

static SVC: OnceLock<FolderSyncService> = OnceLock::new();

#[derive(Default)]
pub struct FolderSyncService {
    tasks: Mutex<HashMap<String, FolderSyncTask>>,
    last_emit: Mutex<HashMap<String, Instant>>,
}

impl FolderSyncService {
    pub fn global() -> &'static Self {
        SVC.get_or_init(Self::default)
    }

    pub fn begin(
        &self,
        album_id: impl Into<String>,
        album_name: impl Into<String>,
        recursive: bool,
    ) -> FolderSyncRunGuard {
        let state = FolderSyncTaskState {
            album_id: album_id.into(),
            album_name: album_name.into(),
            recursive,
            added: 0,
            deleted: 0,
            reimported: 0,
            created_albums: 0,
            started_at_ms: now_millis(),
        };
        let album_id = state.album_id.clone();
        let cancel = Arc::new(AtomicBool::new(false));

        self.tasks.lock().unwrap_or_else(|e| e.into_inner()).insert(
            album_id.clone(),
            FolderSyncTask {
                state: state.clone(),
                cancel: cancel.clone(),
            },
        );
        self.last_emit
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(album_id.clone(), Instant::now());

        Self::emit_progress(&state);
        FolderSyncRunGuard {
            album_id,
            cancel,
            finished: false,
        }
    }

    pub fn update(&self, album_id: &str, f: impl FnOnce(&mut FolderSyncTaskState)) {
        let state = {
            let mut tasks = self.tasks.lock().unwrap_or_else(|e| e.into_inner());
            let Some(task) = tasks.get_mut(album_id) else {
                return;
            };
            f(&mut task.state);

            let now = Instant::now();
            let mut last_emit = self.last_emit.lock().unwrap_or_else(|e| e.into_inner());
            let should_emit = match last_emit.get_mut(album_id) {
                Some(last) if last.elapsed() < PROGRESS_THROTTLE => false,
                Some(last) => {
                    *last = now;
                    true
                }
                None => {
                    last_emit.insert(album_id.to_string(), now);
                    true
                }
            };
            should_emit.then(|| task.state.clone())
        };

        if let Some(state) = state {
            Self::emit_progress(&state);
        }
    }

    pub fn finish(&self, album_id: &str, canceled: bool, error: Option<String>) {
        let task = self
            .tasks
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(album_id);
        self.last_emit
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(album_id);

        if let Some(task) = task {
            let state = task.state;
            let payload = FolderSyncFinished {
                album_id: state.album_id,
                album_name: state.album_name,
                recursive: state.recursive,
                added: state.added,
                deleted: state.deleted,
                reimported: state.reimported,
                created_albums: state.created_albums,
                canceled,
                error,
            };
            if let Ok(payload) = serde_json::to_value(payload) {
                GlobalEmitter::global().emit("folder-sync-finished", payload);
            }
        }
    }

    pub fn cancel(&self, album_id: &str) -> bool {
        let tasks = self.tasks.lock().unwrap_or_else(|e| e.into_inner());
        let Some(task) = tasks.get(album_id) else {
            return false;
        };
        task.cancel.store(true, Ordering::Relaxed);
        true
    }

    pub fn cancel_all(&self) -> usize {
        let tasks = self.tasks.lock().unwrap_or_else(|e| e.into_inner());
        for task in tasks.values() {
            task.cancel.store(true, Ordering::Relaxed);
        }
        tasks.len()
    }

    pub fn snapshot(&self) -> Vec<FolderSyncTaskState> {
        let mut tasks: Vec<_> = self
            .tasks
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .map(|task| task.state.clone())
            .collect();
        tasks.sort_by(|a, b| {
            a.started_at_ms
                .cmp(&b.started_at_ms)
                .then_with(|| a.album_id.cmp(&b.album_id))
        });
        tasks
    }

    fn emit_progress(state: &FolderSyncTaskState) {
        if let Ok(payload) = serde_json::to_value(state) {
            GlobalEmitter::global().emit("folder-sync-progress", payload);
        }
    }
}

pub struct FolderSyncRunGuard {
    album_id: String,
    cancel: Arc<AtomicBool>,
    finished: bool,
}

impl FolderSyncRunGuard {
    pub fn cancel_flag(&self) -> Arc<AtomicBool> {
        self.cancel.clone()
    }

    pub fn finish(mut self, error: Option<String>) {
        if !self.finished {
            FolderSyncService::global().finish(&self.album_id, false, error);
            self.finished = true;
        }
    }

    pub fn finish_canceled(mut self) {
        if !self.finished {
            FolderSyncService::global().finish(&self.album_id, true, None);
            self.finished = true;
        }
    }
}

impl Drop for FolderSyncRunGuard {
    fn drop(&mut self) {
        if !self.finished {
            FolderSyncService::global().finish(&self.album_id, false, Some("aborted".to_string()));
            self.finished = true;
        }
    }
}
