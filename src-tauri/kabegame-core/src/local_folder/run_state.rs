use crate::emitter::GlobalEmitter;
use crate::local_folder::status::now_millis;
use crate::local_folder::{SyncOrigin, DEBOUNCE_MS};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{atomic::AtomicBool, Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

const PROGRESS_THROTTLE: Duration = Duration::from_millis(200);

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SyncKind {
    Full,
    Diff,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderSyncTaskState {
    pub album_id: String,
    pub album_name: String,
    pub recursive: bool,
    pub kind: SyncKind,
    pub progress: f64,
    pub manual: bool,
    pub added: usize,
    pub deleted: usize,
    pub reimported: usize,
    pub created_albums: usize,
    pub started_at_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FolderSyncFinished {
    pub album_id: String,
    pub album_name: String,
    pub recursive: bool,
    pub kind: SyncKind,
    pub progress: f64,
    pub manual: bool,
    pub added: usize,
    pub deleted: usize,
    pub reimported: usize,
    pub created_albums: usize,
    pub canceled: bool,
    pub preempted: bool,
    pub skipped_unchanged: bool,
    pub removed_album: bool,
    pub error: Option<String>,
}

struct FolderSyncTask {
    state: FolderSyncTaskState,
    #[allow(dead_code)]
    cancel: Arc<AtomicBool>,
    visible: bool,
}

static SVC: OnceLock<FolderSyncService> = OnceLock::new();
#[cfg(test)]
static FINISHED_EVENTS: OnceLock<Mutex<Vec<FolderSyncFinished>>> = OnceLock::new();

#[derive(Default)]
pub struct FolderSyncService {
    tasks: Mutex<HashMap<String, FolderSyncTask>>,
    last_emit: Mutex<HashMap<String, Instant>>,
}

impl FolderSyncService {
    pub fn global() -> &'static Self {
        SVC.get_or_init(Self::default)
    }

    pub(crate) fn begin(
        &self,
        album_id: impl Into<String>,
        album_name: impl Into<String>,
        recursive: bool,
        kind: SyncKind,
        origin: SyncOrigin,
        cancel: Arc<AtomicBool>,
    ) -> FolderSyncRunGuard {
        let state = FolderSyncTaskState {
            album_id: album_id.into(),
            album_name: album_name.into(),
            recursive,
            kind,
            progress: 0.0,
            manual: origin == SyncOrigin::Manual,
            added: 0,
            deleted: 0,
            reimported: 0,
            created_albums: 0,
            started_at_ms: now_millis(),
        };
        let album_id = state.album_id.clone();
        let started_at_ms = state.started_at_ms;
        self.tasks.lock().unwrap_or_else(|e| e.into_inner()).insert(
            album_id.clone(),
            FolderSyncTask {
                state,
                cancel,
                visible: false,
            },
        );

        let visible_album_id = album_id.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(DEBOUNCE_MS)).await;
            FolderSyncService::global().make_visible(&visible_album_id, started_at_ms);
        });

        FolderSyncRunGuard {
            album_id,
            finished: false,
        }
    }

    fn make_visible(&self, album_id: &str, started_at_ms: u64) {
        let state = {
            let mut tasks = self.tasks.lock().unwrap_or_else(|e| e.into_inner());
            let Some(task) = tasks.get_mut(album_id) else {
                return;
            };
            if task.state.started_at_ms != started_at_ms || task.visible {
                return;
            }
            task.visible = true;
            task.state.clone()
        };
        self.last_emit
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(album_id.to_string(), Instant::now());
        Self::emit_progress(&state);
    }

    pub fn update(&self, album_id: &str, f: impl FnOnce(&mut FolderSyncTaskState)) {
        let state = {
            let mut tasks = self.tasks.lock().unwrap_or_else(|e| e.into_inner());
            let Some(task) = tasks.get_mut(album_id) else {
                return;
            };
            f(&mut task.state);
            if !task.visible {
                return;
            }

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

    fn finish(
        &self,
        album_id: &str,
        canceled: bool,
        preempted: bool,
        skipped_unchanged: bool,
        removed_album: bool,
        error: Option<String>,
    ) {
        let task = self
            .tasks
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(album_id);
        self.last_emit
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(album_id);
        let Some(task) = task else {
            return;
        };
        let state = task.state;
        if !task.visible && !state.manual {
            return;
        }
        Self::emit_finished(FolderSyncFinished {
            album_id: state.album_id,
            album_name: state.album_name,
            recursive: state.recursive,
            kind: state.kind,
            progress: state.progress,
            manual: state.manual,
            added: state.added,
            deleted: state.deleted,
            reimported: state.reimported,
            created_albums: state.created_albums,
            canceled,
            preempted,
            skipped_unchanged,
            removed_album,
            error,
        });
    }

    pub(crate) fn emit_finished_unregistered(payload: FolderSyncFinished) {
        Self::emit_finished(payload);
    }

    fn emit_finished(payload: FolderSyncFinished) {
        #[cfg(test)]
        FINISHED_EVENTS
            .get_or_init(|| Mutex::new(Vec::new()))
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(payload.clone());
        if let Ok(payload) = serde_json::to_value(payload) {
            GlobalEmitter::global().emit("folder-sync-finished", payload);
        }
    }

    pub fn snapshot(&self) -> Vec<FolderSyncTaskState> {
        let mut tasks: Vec<_> = self
            .tasks
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .filter(|task| task.visible)
            .map(|task| task.state.clone())
            .collect();
        tasks.sort_by(|a, b| {
            a.started_at_ms
                .cmp(&b.started_at_ms)
                .then_with(|| a.album_id.cmp(&b.album_id))
        });
        tasks
    }

    #[cfg(test)]
    pub(crate) fn contains_registered(&self, album_id: &str) -> bool {
        self.tasks
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .contains_key(album_id)
    }

    #[cfg(test)]
    pub(crate) fn take_finished_events(&self) -> Vec<FolderSyncFinished> {
        std::mem::take(
            &mut *FINISHED_EVENTS
                .get_or_init(|| Mutex::new(Vec::new()))
                .lock()
                .unwrap_or_else(|e| e.into_inner()),
        )
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
    pub fn finish(mut self, error: Option<String>, skipped_unchanged: bool, removed_album: bool) {
        if !self.finished {
            FolderSyncService::global().finish(
                &self.album_id,
                false,
                false,
                skipped_unchanged,
                removed_album,
                error,
            );
            self.finished = true;
        }
    }

    pub fn finish_canceled(mut self, preempted: bool) {
        if !self.finished {
            FolderSyncService::global().finish(&self.album_id, true, preempted, false, false, None);
            self.finished = true;
        }
    }
}

impl Drop for FolderSyncRunGuard {
    fn drop(&mut self) {
        if !self.finished {
            FolderSyncService::global().finish(
                &self.album_id,
                false,
                false,
                false,
                false,
                Some("aborted".to_string()),
            );
            self.finished = true;
        }
    }
}
