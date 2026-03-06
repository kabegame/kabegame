use crate::crawler::downloader::generate_thumbnail;
use crate::emitter::GlobalEmitter;
#[cfg(not(target_os = "android"))]
use crate::ipc::server::EventBroadcaster;
use crate::ipc::DaemonEvent;
use crate::settings::Settings;
use crate::storage::{Storage, FAVORITE_ALBUM_ID};
use rusqlite::params;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::Path;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex, OnceLock,
};
use tokio::sync::Notify;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DedupeRemoveResult {
    pub removed: usize,
    pub removed_ids: Vec<String>,
    #[serde(default)]
    pub removed_ids_truncated: bool,
}

#[derive(Debug, Clone)]
pub struct DedupeCursor {
    pub is_favorite: i64,
    pub sort_key: i64,
    pub crawled_at: i64,
    pub id: String,
}

#[derive(Debug, Clone)]
pub struct DedupeScanRow {
    pub id: String,
    pub hash: String,
    pub is_favorite: i64,
    pub sort_key: i64,
    pub crawled_at: i64,
}

impl DedupeScanRow {
    pub fn cursor(&self) -> DedupeCursor {
        DedupeCursor {
            is_favorite: self.is_favorite,
            sort_key: self.sort_key,
            crawled_at: self.crawled_at,
            id: self.id.clone(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DebugCloneImagesResult {
    pub inserted: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DebugCloneImagesProgress {
    pub inserted: usize,
    pub total: usize,
}

#[derive(Debug, Clone)]
pub(crate) struct BaseImageRow {
    pub(crate) url: Option<String>,
    pub(crate) local_path: String,
    pub(crate) plugin_id: String,
    pub(crate) task_id: Option<String>,
    pub(crate) crawled_at: i64,
    pub(crate) metadata_json: Option<String>,
    pub(crate) thumbnail_path: String,
    pub(crate) hash: String,
}

// ========== 整理相关方法 ==========

#[derive(Debug, Clone)]
pub struct OrganizeScanRow {
    pub id: i64,
    pub hash: String,
    pub local_path: String,
    pub thumbnail_path: String,
}

impl Storage {
    pub fn get_dedupe_total_hash_images_count(&self) -> Result<usize, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let count: usize = conn
            .query_row("SELECT COUNT(*) FROM images WHERE hash != ''", [], |row| {
                row.get(0)
            })
            .map_err(|e| format!("Failed to query hash count: {}", e))?;
        Ok(count)
    }

    pub fn get_dedupe_batch(
        &self,
        cursor: Option<&DedupeCursor>,
        limit: usize,
    ) -> Result<Vec<DedupeScanRow>, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;

        let query = format!(
            "SELECT CAST(images.id AS TEXT), images.hash,
             CASE WHEN album_images.image_id IS NOT NULL THEN 1 ELSE 0 END as is_favorite,
             images.crawled_at as sort_key,
             images.crawled_at
             FROM images
             LEFT JOIN album_images ON images.id = album_images.image_id AND album_images.album_id = '{}'
             WHERE images.hash != ''
             {}
             ORDER BY is_favorite DESC, sort_key ASC, images.crawled_at ASC, images.id ASC
             LIMIT ?",
            FAVORITE_ALBUM_ID,
            if cursor.is_some() {
                "AND (is_favorite < ? OR (is_favorite = ? AND (sort_key > ? OR (sort_key = ? AND (images.crawled_at > ? OR (images.crawled_at = ? AND images.id > ?))))))"
            } else {
                ""
            }
        );

        let mut stmt = conn
            .prepare(&query)
            .map_err(|e| format!("Failed to prepare query: {}", e))?;

        let mapper = |row: &rusqlite::Row| {
            Ok(DedupeScanRow {
                id: row.get(0)?,
                hash: row.get(1)?,
                is_favorite: row.get(2)?,
                sort_key: row.get(3)?,
                crawled_at: row.get(4)?,
            })
        };

        let rows = if let Some(c) = cursor {
            stmt.query_map(
                params![
                    c.is_favorite,
                    c.is_favorite,
                    c.sort_key,
                    c.sort_key,
                    c.crawled_at,
                    c.crawled_at,
                    c.id,
                    limit as i64
                ],
                mapper,
            )
        } else {
            stmt.query_map(params![limit as i64], mapper)
        }
        .map_err(|e| format!("Failed to query dedupe batch: {}", e))?;

        let mut results: Vec<DedupeScanRow> = Vec::new();
        for r in rows {
            results.push(r.map_err(|e| format!("Failed to read row: {}", e))?);
        }
        Ok(results)
    }

    pub fn dedupe_gallery_by_hash(&self, delete_files: bool) -> Result<DedupeRemoveResult, String> {
        let mut conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;

        let mut seen_hashes = std::collections::HashSet::new();
        let mut to_remove_ids = Vec::new();
        let mut to_remove_paths = Vec::new();

        {
            let mut stmt = conn
                .prepare(
                    "SELECT hash, CAST(id AS TEXT), local_path,
                     CASE WHEN EXISTS(SELECT 1 FROM album_images WHERE image_id = images.id AND album_id = ?1) THEN 1 ELSE 0 END as is_fav
                     FROM images
                     WHERE hash != ''
                     ORDER BY is_fav DESC, crawled_at ASC, id ASC",
                )
                .map_err(|e| format!("Failed to prepare dedupe query: {}", e))?;

            let rows = stmt
                .query_map(params![FAVORITE_ALBUM_ID], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                })
                .map_err(|e| format!("Failed to query images for dedupe: {}", e))?;

            for r in rows {
                let (hash, id, path) = r.map_err(|e| format!("Failed to read row: {}", e))?;
                if seen_hashes.contains(&hash) {
                    to_remove_ids.push(id);
                    to_remove_paths.push(path);
                } else {
                    seen_hashes.insert(hash);
                }
            }
        }

        if to_remove_ids.is_empty() {
            return Ok(DedupeRemoveResult {
                removed: 0,
                removed_ids: Vec::new(),
                removed_ids_truncated: false,
            });
        }

        let tx = conn
            .transaction()
            .map_err(|e| format!("Failed to start transaction: {}", e))?;

        // 在删除前，查询所有图片所属的任务，并统计每个任务需要增加的 deleted_count
        let mut task_deleted_counts: std::collections::HashMap<String, i64> =
            std::collections::HashMap::new();
        for id in &to_remove_ids {
            let task_ids: Vec<String> = tx
                .prepare("SELECT DISTINCT task_id FROM task_images WHERE image_id = ?1")
                .and_then(|mut stmt| {
                    stmt.query_map(params![id], |row| row.get::<_, String>(0))
                        .and_then(|rows| {
                            let mut ids = Vec::new();
                            for row_result in rows {
                                if let Ok(task_id) = row_result {
                                    ids.push(task_id);
                                }
                            }
                            Ok(ids)
                        })
                })
                .unwrap_or_default();

            for task_id in task_ids {
                *task_deleted_counts.entry(task_id).or_insert(0) += 1;
            }
        }

        for id in &to_remove_ids {
            tx.execute("DELETE FROM images WHERE id = ?1", params![id])
                .map_err(|e| format!("Failed to delete image: {}", e))?;
            let _ = tx.execute("DELETE FROM album_images WHERE image_id = ?1", params![id]);
            let _ = tx.execute("DELETE FROM task_images WHERE image_id = ?1", params![id]);
        }

        // 更新所有相关任务的 deleted_count
        for (task_id, count) in task_deleted_counts {
            let _ = tx.execute(
                "UPDATE tasks SET deleted_count = deleted_count + ?1 WHERE id = ?2",
                params![count, task_id],
            );
        }

        tx.commit()
            .map_err(|e| format!("Failed to commit transaction: {}", e))?;

        if delete_files {
            for path in to_remove_paths {
                let _ = std::fs::remove_file(path);
            }
        }

        self.invalidate_images_total_cache();

        let removed_ids_truncated = to_remove_ids.len() > 100;
        let mut removed_ids = to_remove_ids;
        if removed_ids_truncated {
            removed_ids.truncate(100);
        }

        Ok(DedupeRemoveResult {
            removed: removed_ids.len(),
            removed_ids,
            removed_ids_truncated,
        })
    }

    pub fn debug_clone_images(
        &self,
        count: usize,
        pool_size: usize,
        seed: Option<u64>,
    ) -> Result<DebugCloneImagesResult, String> {
        use crate::storage::XorShift64;

        if count == 0 {
            return Ok(DebugCloneImagesResult { inserted: 0 });
        }

        let mut conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;

        let pool_size = pool_size.clamp(1, 5000);
        let pool: Vec<BaseImageRow> = {
            let mut pool_stmt = conn
                .prepare(
                    "SELECT url, local_path, plugin_id, task_id, crawled_at, metadata,
                            COALESCE(NULLIF(thumbnail_path, ''), local_path), COALESCE(hash, '')
                     FROM images
                     ORDER BY RANDOM()
                     LIMIT ?1",
                )
                .map_err(|e| format!("Failed to prepare pool query: {}", e))?;

            let rows = pool_stmt
                .query_map(params![pool_size as i64], |row| {
                    Ok(BaseImageRow {
                        url: row.get::<_, Option<String>>(0)?,
                        local_path: row.get(1)?,
                        plugin_id: row.get(2)?,
                        task_id: row.get(3)?,
                        crawled_at: row.get(4)?,
                        metadata_json: row.get(5)?,
                        thumbnail_path: row.get(6)?,
                        hash: row.get(7)?,
                    })
                })
                .map_err(|e| format!("Failed to query pool: {}", e))?;

            let mut v = Vec::new();
            for r in rows {
                v.push(r.map_err(|e| format!("Failed to read pool row: {}", e))?);
            }
            v
        };
        if pool.is_empty() {
            return Err("数据库里没有任何图片记录，无法生成测试数据".to_string());
        }

        let default_seed = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos() as u64;
        let mut rng = XorShift64::new(seed.unwrap_or(default_seed));

        let total = count;
        let batch_size = 5000usize.min(total).max(1);
        let mut inserted = 0usize;

        while inserted < total {
            let cur = (total - inserted).min(batch_size);
            let tx = conn
                .transaction()
                .map_err(|e| format!("Failed to begin transaction: {}", e))?;

            {
                let mut insert_img = tx
                    .prepare(
                        "INSERT INTO images (url, local_path, plugin_id, task_id, crawled_at, metadata, thumbnail_path, hash)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                    )
                    .map_err(|e| format!("Failed to prepare insert image: {}", e))?;

                let mut insert_task_img = tx
                    .prepare(
                        "INSERT OR REPLACE INTO task_images (task_id, image_id, added_at, \"order\")
                         VALUES (?1, ?2, ?3, ?4)",
                    )
                    .map_err(|e| format!("Failed to prepare insert task_images: {}", e))?;

                for _ in 0..cur {
                    let base = &pool[rng.gen_usize(pool.len())];

                    let thumbnail_path = if base.thumbnail_path.trim().is_empty() {
                        base.local_path.clone()
                    } else {
                        base.thumbnail_path.clone()
                    };

                    let jitter = (rng.next_u64() % 1_000_000) as i64;
                    let crawled_at = base.crawled_at.saturating_add(jitter);

                    insert_img
                        .execute(params![
                            base.url.as_deref(),
                            &base.local_path,
                            &base.plugin_id,
                            &base.task_id,
                            crawled_at,
                            &base.metadata_json,
                            thumbnail_path,
                            &base.hash,
                        ])
                        .map_err(|e| format!("Failed to insert image (debug clone): {}", e))?;
                    let new_id = tx.last_insert_rowid();

                    if let Some(task_id) = base.task_id.as_ref() {
                        let added_at = crawled_at;
                        insert_task_img
                            .execute(params![task_id, new_id, added_at, crawled_at])
                            .map_err(|e| {
                                format!("Failed to insert task-image relation (debug clone): {}", e)
                            })?;
                    }
                }
            }

            tx.commit()
                .map_err(|e| format!("Failed to commit debug clone transaction: {}", e))?;

            inserted += cur;
            let _ = GlobalEmitter::global().emit(
                "debug-clone-images-progress",
                serde_json::to_value(DebugCloneImagesProgress { inserted, total })
                    .unwrap_or_default(),
            );
        }

        self.invalidate_images_total_cache();

        Ok(DebugCloneImagesResult { inserted })
    }

    /// 获取整理用的分批图片数据（单遍扫描）
    /// SELECT CAST(id AS TEXT), hash, local_path, thumbnail_path FROM images WHERE id > ?cursor_id ORDER BY id ASC LIMIT ?limit
    pub fn get_organize_batch(
        &self,
        cursor_id: i64,
        limit: usize,
    ) -> Result<Vec<OrganizeScanRow>, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;

        let query = "SELECT CAST(id AS TEXT), hash, local_path, thumbnail_path FROM images WHERE id > ? ORDER BY id ASC LIMIT ?";
        let mut stmt = conn
            .prepare(query)
            .map_err(|e| format!("Failed to prepare organize batch query: {}", e))?;

        let rows = stmt
            .query_map(params![cursor_id, limit as i64], |row| {
                Ok(OrganizeScanRow {
                    id: row.get::<_, String>(0)?.parse().unwrap_or(0),
                    hash: row.get(1)?,
                    local_path: row.get(2)?,
                    thumbnail_path: row.get(3)?,
                })
            })
            .map_err(|e| format!("Failed to query organize batch: {}", e))?;

        let mut results: Vec<OrganizeScanRow> = Vec::new();
        for r in rows {
            results.push(r.map_err(|e| format!("Failed to read organize row: {}", e))?);
        }
        Ok(results)
    }

    /// 获取总图片数（用于进度计算）
    pub fn get_images_total_count(&self) -> Result<usize, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let count: usize = conn
            .query_row("SELECT COUNT(*) FROM images", [], |row| row.get(0))
            .map_err(|e| format!("Failed to query images total count: {}", e))?;
        Ok(count)
    }
}

#[derive(Debug, Clone)]
pub struct OrganizeOptions {
    pub dedupe: bool,
    pub remove_missing: bool,
    pub regen_thumbnails: bool,
}

static GLOBAL_ORGANIZE: OnceLock<Arc<OrganizeService>> = OnceLock::new();

// 整理期间阻塞下载的全局状态
static ORGANIZE_BARRIER: OnceLock<Arc<Notify>> = OnceLock::new();
static ORGANIZE_RUNNING: OnceLock<Arc<AtomicBool>> = OnceLock::new();

#[derive(Default)]
pub struct OrganizeService {
    cancel_flag: Mutex<Option<Arc<AtomicBool>>>,
}

impl OrganizeService {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn init_global(svc: Arc<OrganizeService>) -> Result<(), String> {
        GLOBAL_ORGANIZE
            .set(svc)
            .map_err(|_| "OrganizeService already initialized".to_string())
    }

    pub fn global() -> Arc<OrganizeService> {
        GLOBAL_ORGANIZE
            .get()
            .expect("OrganizeService not initialized")
            .clone()
    }

    // 初始化整理阻塞机制的全局状态
    pub fn init_organize_barrier() {
        ORGANIZE_BARRIER.get_or_init(|| Arc::new(Notify::new()));
        ORGANIZE_RUNNING.get_or_init(|| Arc::new(AtomicBool::new(false)));
    }

    pub fn get_organize_barrier() -> Arc<Notify> {
        ORGANIZE_BARRIER
            .get_or_init(|| Arc::new(Notify::new()))
            .clone()
    }

    pub fn get_organize_running() -> Arc<AtomicBool> {
        ORGANIZE_RUNNING
            .get_or_init(|| Arc::new(AtomicBool::new(false)))
            .clone()
    }

    pub async fn start(
        self: Arc<Self>,
        storage: Arc<Storage>,
        options: OrganizeOptions,
    ) -> Result<(), String> {
        // Ensure organize barrier state is ready no matter which call path starts organize.
        Self::init_organize_barrier();

        let mut guard = self
            .cancel_flag
            .lock()
            .map_err(|e| format!("Lock error: {}", e))?;
        if guard.is_some() {
            return Err("整理正在进行中".to_string());
        }

        let cancel = Arc::new(AtomicBool::new(false));
        *guard = Some(cancel.clone());
        drop(guard);

        // 设置整理阻塞状态
        Self::get_organize_running().store(true, Ordering::Relaxed);

        let handle = tokio::runtime::Handle::current();
        let svc = Arc::clone(&self);

        tokio::task::spawn_blocking(move || {
            let res = run_organize(&handle, storage, options, cancel);
            if let Err(e) = res {
                eprintln!("[organize] 任务失败: {}", e);
            }

            // 清理运行状态和唤醒等待的下载任务
            svc.clear_running();
            Self::get_organize_running().store(false, Ordering::Relaxed);
            Self::get_organize_barrier().notify_waiters();
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

fn emit_organize_finished(
    handle: &tokio::runtime::Handle,
    removed: usize,
    regenerated: usize,
    canceled: bool,
) {
    handle.block_on(async move {
        EventBroadcaster::global().broadcast(Arc::new(DaemonEvent::OrganizeFinished {
            removed,
            regenerated,
            canceled,
        }));
    });
}

fn run_organize(
    handle: &tokio::runtime::Handle,
    storage: Arc<Storage>,
    options: OrganizeOptions,
    cancel: Arc<AtomicBool>,
) -> Result<(), String> {
    let total = storage.get_images_total_count()?; // 总图片数

    let mut seen_hashes: HashSet<String> = HashSet::new();
    let mut processed: usize = 0;
    let mut removed_total: usize = 0;
    let mut regenerated_total: usize = 0;
    let mut cursor_id: i64 = 0;

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
            emit_organize_finished(handle, removed_total, regenerated_total, true);
            return Ok(());
        }

        // 分批扫描: SELECT id, hash, local_path, thumbnail_path FROM images WHERE id > ? ORDER BY id ASC LIMIT 1000
        let batch = storage.get_organize_batch(cursor_id, 1000)?;
        if batch.is_empty() {
            break;
        }

        // 游标推进
        cursor_id = batch.last().unwrap().id;
        processed += batch.len();

        let mut remove_ids: Vec<String> = Vec::new();
        let mut regen_list: Vec<(i64, String)> = Vec::new();
        let mut should_remove: HashSet<i64> = HashSet::new();

        // 1. 去重判断
        if options.dedupe {
            for row in &batch {
                if !row.hash.is_empty() {
                    if seen_hashes.contains(&row.hash) {
                        remove_ids.push(row.id.to_string());
                        should_remove.insert(row.id);
                    } else {
                        seen_hashes.insert(row.hash.clone());
                    }
                }
            }
        }

        // 2. 清除失效图片判断
        if options.remove_missing {
            for row in &batch {
                if !should_remove.contains(&row.id) && !Path::new(&row.local_path).exists() {
                    remove_ids.push(row.id.to_string());
                    should_remove.insert(row.id);
                }
            }
        }

        // 3. 补充缩略图判断
        if options.regen_thumbnails {
            for row in &batch {
                if !should_remove.contains(&row.id) {
                    let needs_regen = row.thumbnail_path.is_empty()
                        || row.thumbnail_path == row.local_path
                        || !Path::new(&row.thumbnail_path).exists();
                    if needs_regen {
                        regen_list.push((row.id, row.local_path.clone()));
                    }
                }
            }
        }

        // 执行删除
        if !remove_ids.is_empty() {
            storage.batch_remove_images(&remove_ids)?;

            // 发送 ImagesChange 事件，前端刷新视图
            EventBroadcaster::global().broadcast(Arc::new(DaemonEvent::ImagesChange {
                reason: "remove".to_string(),
                image_ids: remove_ids.clone(),
            }));

            // 检查壁纸是否被移除
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

        // 执行缩略图补充
        for (id, path) in regen_list {
            let thumbnail_result =
                handle.block_on(async { generate_thumbnail(Path::new(&path)).await });

            if let Ok(Some(thumb_path)) = thumbnail_result {
                let thumb_str = thumb_path.to_string_lossy().to_string();
                storage.update_image_thumbnail_path(&id.to_string(), &thumb_str)?;
                regenerated_total += 1;
            }
        }

        // 发送每批进度事件
        EventBroadcaster::global().broadcast(Arc::new(DaemonEvent::OrganizeProgress {
            processed,
            total,
            removed: removed_total,
            regenerated: regenerated_total,
        }));
    }

    emit_organize_finished(handle, removed_total, regenerated_total, false);
    Ok(())
}
