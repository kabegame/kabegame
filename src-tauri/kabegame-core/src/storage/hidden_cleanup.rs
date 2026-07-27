use crate::emitter::GlobalEmitter;
use crate::settings::Settings;
use crate::storage::image_events::delete_images_with_events;
use crate::storage::{Storage, HIDDEN_ALBUM_ID};
use serde::{Deserialize, Serialize};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex, OnceLock,
};

const CLEANUP_BATCH_SIZE: usize = 200;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HiddenCleanupRunState {
    pub running: bool,
    pub total: usize,
    pub processed: usize,
    pub removed: usize,
    pub kept_files: usize,
}

static GLOBAL_HIDDEN_CLEANUP: OnceLock<Arc<HiddenCleanupService>> = OnceLock::new();

#[derive(Default)]
pub struct HiddenCleanupService {
    cancel_flag: Mutex<Option<Arc<AtomicBool>>>,
    run_state: Mutex<HiddenCleanupRunState>,
}

impl HiddenCleanupService {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn init_global(service: Arc<HiddenCleanupService>) -> Result<(), String> {
        GLOBAL_HIDDEN_CLEANUP
            .set(service)
            .map_err(|_| "HiddenCleanupService already initialized".to_string())
    }

    pub fn global() -> Arc<HiddenCleanupService> {
        GLOBAL_HIDDEN_CLEANUP
            .get()
            .expect("HiddenCleanupService not initialized")
            .clone()
    }

    pub async fn start(self: Arc<Self>, storage: Arc<Storage>) -> Result<(), String> {
        let mut guard = self
            .cancel_flag
            .lock()
            .map_err(|e| format!("Lock error: {e}"))?;
        if guard.is_some() {
            return Err("清理正在进行中".to_string());
        }

        let cancel = Arc::new(AtomicBool::new(false));
        *guard = Some(cancel.clone());
        drop(guard);

        let total = match storage.count_album_images(HIDDEN_ALBUM_ID) {
            Ok(total) => total,
            Err(error) => {
                self.clear_running();
                return Err(error);
            }
        };
        if let Err(error) = self.init_run_state(total) {
            self.clear_running();
            return Err(error);
        }

        let handle = tokio::runtime::Handle::current();
        let service = Arc::clone(&self);
        tokio::task::spawn_blocking(move || {
            eprintln!("[hidden_cleanup] 开始清理，共 {total} 条");
            if let Err(error) =
                run_hidden_cleanup(&handle, storage, cancel, total, Arc::clone(&service))
            {
                let state = service.get_run_state();
                GlobalEmitter::global().emit_hidden_cleanup_finished(
                    state.removed,
                    state.kept_files,
                    false,
                    Some(error.clone()),
                );
                eprintln!("[hidden_cleanup] 任务失败: {error}");
            }

            service.clear_running();
            service.reset_run_state();
        });

        Ok(())
    }

    pub fn cancel(&self) -> Result<bool, String> {
        let guard = self
            .cancel_flag
            .lock()
            .map_err(|e| format!("Lock error: {e}"))?;
        if let Some(flag) = guard.as_ref() {
            flag.store(true, Ordering::Relaxed);
            Ok(true)
        } else {
            Ok(false)
        }
    }

    /// `running == false` 时返回全零默认状态。
    pub fn get_run_state(&self) -> HiddenCleanupRunState {
        self.run_state
            .lock()
            .ok()
            .map(|state| state.clone())
            .unwrap_or_default()
    }

    fn init_run_state(&self, total: usize) -> Result<(), String> {
        let mut state = self
            .run_state
            .lock()
            .map_err(|e| format!("Lock error: {e}"))?;
        *state = HiddenCleanupRunState {
            running: true,
            total,
            ..HiddenCleanupRunState::default()
        };
        Ok(())
    }

    fn update_run_state(&self, processed: usize, removed: usize, kept_files: usize) {
        if let Ok(mut state) = self.run_state.lock() {
            state.processed = processed;
            state.removed = removed;
            state.kept_files = kept_files;
        }
    }

    fn clear_running(&self) {
        if let Ok(mut flag) = self.cancel_flag.lock() {
            *flag = None;
        }
    }

    fn reset_run_state(&self) {
        if let Ok(mut state) = self.run_state.lock() {
            *state = HiddenCleanupRunState::default();
        }
    }
}

fn run_hidden_cleanup(
    handle: &tokio::runtime::Handle,
    storage: Arc<Storage>,
    cancel: Arc<AtomicBool>,
    total: usize,
    service: Arc<HiddenCleanupService>,
) -> Result<(), String> {
    let mut processed = 0usize;
    let mut removed = 0usize;
    let mut kept_files = 0usize;
    let mut previous_batch: Option<Vec<String>> = None;
    let mut current_wallpaper_id = Settings::global().get_current_wallpaper_image_id();

    loop {
        if cancel.load(Ordering::Relaxed) {
            GlobalEmitter::global().emit_hidden_cleanup_finished(removed, kept_files, true, None);
            return Ok(());
        }

        let batch = storage.get_album_image_ids_batch(HIDDEN_ALBUM_ID, CLEANUP_BATCH_SIZE)?;
        if batch.is_empty() {
            break;
        }

        let mut signature = batch.clone();
        signature.sort_unstable();
        if previous_batch.as_ref() == Some(&signature) {
            let error = format!(
                "连续两批得到相同的 {} 个隐藏图片 id，停止清理以避免死循环",
                signature.len()
            );
            eprintln!("[hidden_cleanup] {error}");
            return Err(error);
        }
        previous_batch = Some(signature);

        let purge = handle.block_on(delete_images_with_events(&batch, true))?;
        // 检查壁纸是否被移除
        if let Some(cur) = current_wallpaper_id.as_deref() {
            if batch.iter().any(|id| id == cur) {
                let _ = Settings::global().set_current_wallpaper_image_id(None);
                current_wallpaper_id = None;
            }
        }
        processed += batch.len();
        removed += batch.len();
        kept_files += purge.kept;

        service.update_run_state(processed, removed, kept_files);
        GlobalEmitter::global().emit_hidden_cleanup_progress(processed, total, removed, kept_files);
    }

    GlobalEmitter::global().emit_hidden_cleanup_finished(removed, kept_files, false, None);
    Ok(())
}
