#[cfg(not(any(target_os = "android", target_os = "ios")))]
use kabegame_core::ipc::server::EventBroadcaster;
use kabegame_core::ipc::DaemonEvent;
use kabegame_core::settings::Settings;
use kabegame_core::storage::Storage;
use std::collections::HashSet;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};

#[derive(Default)]
pub struct DedupeService {
    cancel_flag: Mutex<Option<Arc<AtomicBool>>>,
}

impl DedupeService {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn start_batched(
        self: Arc<Self>,
        storage: Arc<Storage>,
        delete_files: bool,
        batch_size: usize,
    ) -> Result<(), String> {
        let mut guard = self
            .cancel_flag
            .lock()
            .map_err(|e| format!("Lock error: {}", e))?;
        if guard.is_some() {
            return Err("去重正在进行中".to_string());
        }

        let cancel = Arc::new(AtomicBool::new(false));
        *guard = Some(cancel.clone());
        drop(guard);

        let handle = tokio::runtime::Handle::current();
        let svc = Arc::clone(&self);

        tokio::task::spawn_blocking(move || {
            let res = run_dedupe_batched(&handle, storage, delete_files, batch_size, cancel);
            if let Err(e) = res {
                eprintln!("[dedupe] 任务失败: {}", e);
            }

            // 清理运行状态
            svc.clear_running();
        });

        Ok(())
    }

    pub fn cancel(&self) -> Result<bool, String> {
        let guard = self
            .cancel_flag
            .lock()
            .map_err(|e| format!("Lock error: {}", e))?;
        if let Some(flag) = guard.as_ref() {
            flag.store(true, Ordering::Relaxed);
            Ok(true)
        } else {
            Ok(false)
        }
    }

    fn clear_running(&self) {
        if let Ok(mut g) = self.cancel_flag.lock() {
            *g = None;
        }
    }
}

fn emit_dedupe_finished(
    handle: &tokio::runtime::Handle,
    processed: usize,
    total: usize,
    removed: usize,
    canceled: bool,
) {
    handle.block_on(async move {
        EventBroadcaster::global().broadcast(Arc::new(DaemonEvent::DedupeFinished {
            processed,
            total,
            removed,
            canceled,
        }));
    });
}

fn run_dedupe_batched(
    handle: &tokio::runtime::Handle,
    storage: Arc<Storage>,
    delete_files: bool,
    batch_size: usize,
    cancel: Arc<AtomicBool>,
) -> Result<(), String> {
    let total = storage.get_dedupe_total_hash_images_count()?; // hash != '' 的记录

    let mut seen_hashes: HashSet<String> = HashSet::new();
    let mut processed: usize = 0;
    let mut removed_total: usize = 0;
    let mut batch_index: usize = 0;
    let mut cursor: Option<kabegame_core::storage::dedupe::DedupeCursor> = None;

    // 当前壁纸 id：若被移除则清空（与历史行为保持一致）
    let mut current_wallpaper_id = handle.block_on(async {
        Settings::global()
            .get_current_wallpaper_image_id()
            .await
            .ok()
            .flatten()
    });

    loop {
        if cancel.load(Ordering::Relaxed) {
            emit_dedupe_finished(handle, processed, total, removed_total, true);
            return Ok(());
        }

        let batch = storage.get_dedupe_batch(cursor.as_ref(), batch_size)?;
        if batch.is_empty() {
            break;
        }

        cursor = batch.last().map(|r| r.cursor());
        processed += batch.len();

        let mut remove_ids: Vec<String> = Vec::new();
        for row in batch {
            if row.hash.is_empty() {
                continue;
            }
            if seen_hashes.contains(&row.hash) {
                remove_ids.push(row.id);
            } else {
                seen_hashes.insert(row.hash);
            }
        }

        if !remove_ids.is_empty() {
            if delete_files {
                storage.batch_delete_images(&remove_ids)?;
                // 新事件：统一"图片数据变更"，前端按需刷新当前 provider 视图
                EventBroadcaster::global().broadcast(Arc::new(DaemonEvent::ImagesChange {
                    reason: "delete".to_string(),
                    image_ids: remove_ids.clone(),
                }));
            } else {
                storage.batch_remove_images(&remove_ids)?;
                // 新事件：统一"图片数据变更"，前端按需刷新当前 provider 视图
                EventBroadcaster::global().broadcast(Arc::new(DaemonEvent::ImagesChange {
                    reason: "remove".to_string(),
                    image_ids: remove_ids.clone(),
                }));
            }

            if let Some(cur) = current_wallpaper_id.as_deref() {
                if remove_ids.iter().any(|id| id == cur) {
                    let _ = handle.block_on(async {
                        Settings::global()
                            .set_current_wallpaper_image_id(None)
                            .await
                    });
                    current_wallpaper_id = None;
                }
            }

            removed_total += remove_ids.len();
        }

        EventBroadcaster::global().broadcast(Arc::new(DaemonEvent::DedupeProgress {
            processed,
            total,
            removed: removed_total,
            batch_index,
        }));

        batch_index += 1;
    }

    emit_dedupe_finished(handle, processed, total, removed_total, false);
    Ok(())
}
