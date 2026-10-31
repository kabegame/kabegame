//! 后台回填服务：进入界面后按 `introduced_at, id` 顺序逐个跑完启动阶段没有排干的回填作业。
//!
//! 进度走忙碌任务快照协议（`get_busy_tasks_snapshot().backfills` + `busy-tasks-change` 唤醒），
//! 每个作业结束发 `backfill-finished { id, processed, total, error }`。失败不阻塞后续作业，
//! 进度停在最后一次提交，下次启动从游标重试。CLI 不启动本服务。

use crate::emitter::GlobalEmitter;
use crate::storage::migrations::backfill::{self, BackfillCtx, PendingJob};
use crate::storage::Storage;
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackfillJobState {
    pub id: String,
    pub processed: usize,
    pub total: Option<usize>,
    /// `false` 表示排队等待前面的作业。
    pub running: bool,
}

#[derive(Default)]
pub struct BackfillService {
    started: AtomicBool,
    /// 尚未结束的作业（含排队中的）；结束（成功或失败）即移除。
    jobs: Mutex<Vec<BackfillJobState>>,
}

static BACKFILL_SERVICE: OnceLock<BackfillService> = OnceLock::new();

impl BackfillService {
    pub fn global() -> &'static Self {
        BACKFILL_SERVICE.get_or_init(Self::default)
    }

    pub fn snapshot(&self) -> Vec<BackfillJobState> {
        self.jobs
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone()
    }

    /// 还没结束的后台作业数（IPC `status` 的 `backfillPending`）。
    pub fn pending_count(&self) -> usize {
        self.jobs
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .len()
    }

    /// 在 tokio blocking 线程池里按序跑完全部未完成回填。必须在 tokio runtime 上下文中调用；
    /// 进程内只启动一次，重复调用无操作。
    pub fn start_pending(&'static self, storage: &'static Storage) -> Result<(), String> {
        if self.started.swap(true, Ordering::SeqCst) {
            return Ok(());
        }
        let pending = {
            let conn = storage.db.lock().map_err(|e| format!("Lock error: {e}"))?;
            backfill::pending_jobs(&conn)?
        };
        if pending.is_empty() {
            return Ok(());
        }
        *self.jobs.lock().unwrap_or_else(|error| error.into_inner()) = pending
            .iter()
            .map(|job| BackfillJobState {
                id: job.job.id.to_string(),
                processed: job.progress.processed,
                total: job.progress.total,
                running: false,
            })
            .collect();
        let handle = tokio::runtime::Handle::current();
        tokio::task::spawn_blocking(move || self.run_all(storage, pending, handle));
        Ok(())
    }

    fn run_all(&self, storage: &Storage, pending: Vec<PendingJob>, handle: tokio::runtime::Handle) {
        for job in &pending {
            let id = job.job.id;
            self.update(id, |state| state.running = true);
            GlobalEmitter::global().emit_busy_tasks_change("backfill");
            tracing::info!(
                "start {id} (processed {}/{:?})",
                job.progress.processed,
                job.progress.total
            );
            let ctx = BackfillCtx::background(id, &storage.db, handle.clone());
            let result = backfill::run_to_completion(&ctx, job, &mut |progress, outcome| {
                self.update(progress.id, |state| state.processed = progress.processed);
                if !outcome.patches.is_empty() {
                    GlobalEmitter::global().emit_image_patches(outcome.patches);
                }
            });
            let finished = self.remove(id);
            let error = result.err();
            match &error {
                None => tracing::info!("{id} done"),
                Some(error) => tracing::warn!("{id} failed: {error}"),
            }
            GlobalEmitter::global().emit(
                "backfill-finished",
                serde_json::json!({
                    "id": id,
                    "processed": finished.as_ref().map(|s| s.processed).unwrap_or_default(),
                    "total": finished.and_then(|s| s.total),
                    "error": error,
                }),
            );
        }
    }

    fn update(&self, id: &str, f: impl FnOnce(&mut BackfillJobState)) {
        if let Some(state) = self
            .jobs
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .iter_mut()
            .find(|state| state.id == id)
        {
            f(state);
        }
    }

    fn remove(&self, id: &str) -> Option<BackfillJobState> {
        let mut jobs = self.jobs.lock().unwrap_or_else(|error| error.into_inner());
        let index = jobs.iter().position(|state| state.id == id)?;
        Some(jobs.remove(index))
    }
}
