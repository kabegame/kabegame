use kabegame_core::ipc::EventBroadcaster;
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

    pub fn start_batched(
        self: Arc<Self>,
        storage: Arc<Storage>,
        settings: Arc<Settings>,
        broadcaster: Arc<EventBroadcaster>,
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
            let res = run_dedupe_batched(
                &handle,
                storage,
                settings,
                broadcaster,
                delete_files,
                batch_size,
                cancel,
            );
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

fn emit_generic(handle: &tokio::runtime::Handle, bc: &EventBroadcaster, event: &str, payload: serde_json::Value) {
    let bc = bc.clone();
    let event = event.to_string();
    handle.block_on(async move {
        bc.broadcast(kabegame_core::ipc::events::DaemonEvent::Generic { event, payload })
            .await;
    });
}

fn run_dedupe_batched(
    handle: &tokio::runtime::Handle,
    storage: Arc<Storage>,
    settings: Arc<Settings>,
    broadcaster: Arc<EventBroadcaster>,
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
    let mut current_wallpaper_id = settings
        .get_settings()
        .ok()
        .and_then(|s| s.current_wallpaper_image_id);

    loop {
        if cancel.load(Ordering::Relaxed) {
            emit_generic(
                handle,
                &broadcaster,
                "dedupe-finished",
                serde_json::json!({
                    "processed": processed,
                    "total": total,
                    "removed": removed_total,
                    "canceled": true,
                }),
            );
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
                emit_generic(
                    handle,
                    &broadcaster,
                    "images-deleted",
                    serde_json::json!({ "imageIds": remove_ids.clone() }),
                );
            } else {
                storage.batch_remove_images(&remove_ids)?;
                emit_generic(
                    handle,
                    &broadcaster,
                    "images-removed",
                    serde_json::json!({ "imageIds": remove_ids.clone() }),
                );
            }

            if let Some(cur) = current_wallpaper_id.as_deref() {
                if remove_ids.iter().any(|id| id == cur) {
                    let _ = settings.set_current_wallpaper_image_id(None);
                    current_wallpaper_id = None;
                }
            }

            removed_total += remove_ids.len();
        }

        emit_generic(
            handle,
            &broadcaster,
            "dedupe-progress",
            serde_json::json!({
                "processed": processed,
                "total": total,
                "removed": removed_total,
                "batchIndex": batch_index,
            }),
        );
        batch_index += 1;
    }

    emit_generic(
        handle,
        &broadcaster,
        "dedupe-finished",
        serde_json::json!({
            "processed": processed,
            "total": total,
            "removed": removed_total,
            "canceled": false,
        }),
    );
    Ok(())
}

