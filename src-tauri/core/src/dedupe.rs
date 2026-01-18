use crate::settings::Settings;
use crate::storage::Storage;
use crate::storage::dedupe::DedupeCursor;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use tauri::{AppHandle, Emitter, Manager};

/// 分批去重任务管理器（单例：同一时间只允许一个去重任务运行）。
#[derive(Default)]
pub struct DedupeManager {
    // Some(cancel_flag) 表示任务正在运行
    cancel_flag: Mutex<Option<Arc<AtomicBool>>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DedupeProgressPayload {
    pub processed: usize,
    pub total: usize,
    pub removed: usize,
    pub batch_index: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DedupeFinishedPayload {
    pub processed: usize,
    pub total: usize,
    pub removed: usize,
    pub canceled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DedupeBatchRemovedPayload {
    pub image_ids: Vec<String>,
}

impl DedupeManager {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn start_batched(
        &self,
        app: AppHandle,
        storage: Storage,
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

        tokio::spawn(async move {
            let res = run_dedupe_batched(app.clone(), storage, delete_files, batch_size, cancel);
            if let Err(e) = res {
                eprintln!("[dedupe] 任务失败: {}", e);
            }
            // 清理运行状态（无论成功/失败/取消都需要释放）
            if let Some(m) = app.try_state::<DedupeManager>() {
                let mut g = match m.cancel_flag.lock() {
                    Ok(g) => g,
                    Err(e) => e.into_inner(),
                };
                *g = None;
            }
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
}

fn run_dedupe_batched(
    app: AppHandle,
    storage: Storage,
    delete_files: bool,
    batch_size: usize,
    cancel: Arc<AtomicBool>,
) -> Result<(), String> {
    let total = storage.get_dedupe_total_hash_images_count()?; // 仅 hash != '' 的记录

    // 仅保存“已保留图片”的 hash：后续批次遇到相同 hash 就移除。
    // 注意：极端情况下（大量图片 hash 都不同）可能导致 set 变大，有潜在内存风险。
    let mut seen_hashes: HashSet<String> = HashSet::new();

    let mut processed: usize = 0;
    let mut removed_total: usize = 0;
    let mut batch_index: usize = 0;
    let mut cursor: Option<DedupeCursor> = None;

    // 当前壁纸 id：若被移除则清空（尽量与 batch_remove/delete 行为一致）
    let settings = app.state::<Settings>();
    let mut current_wallpaper_id = settings
        .get_settings()
        .ok()
        .and_then(|s| s.current_wallpaper_image_id);

    loop {
        if cancel.load(Ordering::Relaxed) {
            let _ = app.emit(
                "dedupe-finished",
                DedupeFinishedPayload {
                    processed,
                    total,
                    removed: removed_total,
                    canceled: true,
                },
            );
            return Ok(());
        }

        let batch = storage.get_dedupe_batch(cursor.as_ref(), batch_size)?;
        if batch.is_empty() {
            break;
        }

        // 更新 cursor：以本批最后一条记录作为下一批的 “< last” 游标
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
                // 新事件：统一“图片数据变更”，前端按需刷新当前 provider 视图
                let _ = app.emit(
                    "images-change",
                    serde_json::json!({
                        "reason": "delete",
                        "imageIds": remove_ids.clone(),
                    }),
                );
            } else {
                storage.batch_remove_images(&remove_ids)?;
                // 新事件：统一“图片数据变更”，前端按需刷新当前 provider 视图
                let _ = app.emit(
                    "images-change",
                    serde_json::json!({
                        "reason": "remove",
                        "imageIds": remove_ids.clone(),
                    }),
                );
            }

            // 若当前壁纸被移除：清空设置（只需要做一次）
            if let Some(cur) = current_wallpaper_id.as_deref() {
                if remove_ids.iter().any(|id| id == cur) {
                    let _ = settings.set_current_wallpaper_image_id(None);
                    current_wallpaper_id = None;
                }
            }

            removed_total += remove_ids.len();
        }

        let _ = app.emit(
            "dedupe-progress",
            DedupeProgressPayload {
                processed,
                total,
                removed: removed_total,
                batch_index,
            },
        );

        batch_index += 1;
    }

    let _ = app.emit(
        "dedupe-finished",
        DedupeFinishedPayload {
            processed,
            total,
            removed: removed_total,
            canceled: false,
        },
    );
    Ok(())
}
