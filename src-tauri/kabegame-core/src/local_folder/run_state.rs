use crate::emitter::GlobalEmitter;
use crate::local_folder::status::now_millis;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
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
    error: Option<String>,
}

static SVC: OnceLock<FolderSyncService> = OnceLock::new();

#[derive(Default)]
pub struct FolderSyncService {
    tasks: Mutex<HashMap<String, FolderSyncTaskState>>,
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

        self.tasks
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(album_id.clone(), state.clone());
        self.last_emit
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(album_id.clone(), Instant::now());

        Self::emit_progress(&state);
        FolderSyncRunGuard {
            album_id,
            finished: false,
        }
    }

    pub fn update(&self, album_id: &str, f: impl FnOnce(&mut FolderSyncTaskState)) {
        let state = {
            let mut tasks = self.tasks.lock().unwrap_or_else(|e| e.into_inner());
            let Some(task) = tasks.get_mut(album_id) else {
                return;
            };
            f(task);

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
            should_emit.then(|| task.clone())
        };

        if let Some(state) = state {
            Self::emit_progress(&state);
        }
    }

    pub fn finish(&self, album_id: &str, error: Option<String>) {
        let state = self
            .tasks
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(album_id);
        self.last_emit
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(album_id);

        if let Some(state) = state {
            let payload = FolderSyncFinished {
                album_id: state.album_id,
                album_name: state.album_name,
                recursive: state.recursive,
                added: state.added,
                deleted: state.deleted,
                reimported: state.reimported,
                created_albums: state.created_albums,
                error,
            };
            if let Ok(payload) = serde_json::to_value(payload) {
                GlobalEmitter::global().emit("folder-sync-finished", payload);
            }
        }
    }

    pub fn snapshot(&self) -> Vec<FolderSyncTaskState> {
        let mut tasks: Vec<_> = self
            .tasks
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .cloned()
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
    finished: bool,
}

impl FolderSyncRunGuard {
    pub fn finish(mut self, error: Option<String>) {
        if !self.finished {
            FolderSyncService::global().finish(&self.album_id, error);
            self.finished = true;
        }
    }
}

impl Drop for FolderSyncRunGuard {
    fn drop(&mut self) {
        if !self.finished {
            FolderSyncService::global().finish(&self.album_id, Some("aborted".to_string()));
            self.finished = true;
        }
    }
}
