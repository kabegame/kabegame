use crate::crawler::downloader::generate_thumbnail;
use crate::emitter::GlobalEmitter;
use crate::settings::Settings;
use crate::storage::Storage;
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
    /// 对应 `images.type`（`image` / `video`）
    pub(crate) media_type: String,
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
                            COALESCE(NULLIF(thumbnail_path, ''), local_path), COALESCE(hash, ''), COALESCE(type, 'image')
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
                        media_type: row.get(8)?,
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
                        "INSERT INTO images (url, local_path, plugin_id, task_id, crawled_at, metadata, thumbnail_path, hash, type)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                    )
                    .map_err(|e| format!("Failed to prepare insert image: {}", e))?;

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
                            &base.media_type,
                        ])
                        .map_err(|e| format!("Failed to insert image (debug clone): {}", e))?;
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
    pub remove_unrecognized: bool,
    pub regen_thumbnails: bool,
    /// 在 DB 记录删除后是否同时删除磁盘上的源文件
    pub delete_source_files: bool,
    /// 删除文件前查询是否仍有其它 DB 行引用同一 `local_path`
    pub safe_delete: bool,
    /// 从有序列表（按 id ASC）中跳过的前若干条
    pub offset: Option<usize>,
    /// 在 offset 之后最多处理的条数（与 offset 成对使用时表示区间）
    pub limit: Option<usize>,
}

/// 供前端刷新后同步：整理是否进行中及最近一次进度快照（与 `organize-progress` 事件字段一致）
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrganizeRunState {
    pub running: bool,
    pub library_total: usize,
    pub processed_global: usize,
    pub removed: usize,
    pub regenerated: usize,
    pub range_start: Option<usize>,
    pub range_end: Option<usize>,
    pub dedupe: bool,
    pub remove_missing: bool,
    pub remove_unrecognized: bool,
    pub regen_thumbnails: bool,
    pub delete_source_files: bool,
    pub safe_delete: bool,
}

static GLOBAL_ORGANIZE: OnceLock<Arc<OrganizeService>> = OnceLock::new();

// 整理期间阻塞下载的全局状态
static ORGANIZE_BARRIER: OnceLock<Arc<Notify>> = OnceLock::new();
static ORGANIZE_RUNNING: OnceLock<Arc<AtomicBool>> = OnceLock::new();

#[derive(Default)]
pub struct OrganizeService {
    cancel_flag: Mutex<Option<Arc<AtomicBool>>>,
    run_state: Mutex<OrganizeRunState>,
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

    fn init_run_state_from_start(
        &self,
        options: &OrganizeOptions,
        library_total: usize,
    ) -> Result<(), String> {
        let (range_start, range_end) = range_bounds_for_ui(options);
        let state = OrganizeRunState {
            running: true,
            library_total,
            processed_global: 0,
            removed: 0,
            regenerated: 0,
            range_start,
            range_end,
            dedupe: options.dedupe,
            remove_missing: options.remove_missing,
            remove_unrecognized: options.remove_unrecognized,
            regen_thumbnails: options.regen_thumbnails,
            delete_source_files: options.delete_source_files,
            safe_delete: options.safe_delete,
        };
        let mut g = self
            .run_state
            .lock()
            .map_err(|e| format!("Lock error: {}", e))?;
        *g = state;
        Ok(())
    }

    fn update_run_state_progress(
        &self,
        processed_global: usize,
        removed: usize,
        regenerated: usize,
    ) {
        if let Ok(mut g) = self.run_state.lock() {
            g.processed_global = processed_global;
            g.removed = removed;
            g.regenerated = regenerated;
        }
    }

    fn reset_run_state(&self) {
        if let Ok(mut g) = self.run_state.lock() {
            *g = OrganizeRunState::default();
        }
    }

    /// 与 `get_organize_running()` 一致：`running == false` 时返回默认空状态
    pub fn get_run_state(&self) -> OrganizeRunState {
        let running = Self::get_organize_running().load(Ordering::Relaxed);
        if !running {
            return OrganizeRunState::default();
        }
        let mut s = self
            .run_state
            .lock()
            .ok()
            .map(|m| (*m).clone())
            .unwrap_or_default();
        s.running = true;
        s
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

        let library_total = storage.get_images_total_count()?;
        self.init_run_state_from_start(&options, library_total)?;

        let handle = tokio::runtime::Handle::current();
        let svc = Arc::clone(&self);

        tokio::task::spawn_blocking(move || {
            eprintln!("[organize] 开始整理 {:?}", options);
            let res = run_organize(&handle, storage, options, cancel);
            if let Err(e) = res {
                eprintln!("[organize] 任务失败: {}", e);
            }

            // 清理运行状态和唤醒等待的下载任务
            svc.clear_running();
            svc.reset_run_state();
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

fn range_bounds_for_ui(options: &OrganizeOptions) -> (Option<usize>, Option<usize>) {
    match (options.offset, options.limit) {
        (Some(o), Some(l)) => (Some(o), Some(o + l)),
        _ => (None, None),
    }
}

fn push_organize_progress(
    library_total: usize,
    options: &OrganizeOptions,
    processed_global: usize,
    removed_total: usize,
    regenerated_total: usize,
) {
    let (range_start, range_end) = range_bounds_for_ui(options);
    GlobalEmitter::global().emit_organize_progress(
        processed_global,
        library_total,
        range_start,
        range_end,
        removed_total,
        regenerated_total,
    );
    OrganizeService::global().update_run_state_progress(
        processed_global,
        removed_total,
        regenerated_total,
    );
}

fn emit_organize_finished(removed: usize, regenerated: usize, canceled: bool) {
    GlobalEmitter::global().emit_organize_finished(removed, regenerated, canceled);
}

fn organize_range_upper_bound(offset: Option<usize>, limit: Option<usize>) -> Option<usize> {
    match (offset, limit) {
        (Some(o), Some(l)) => Some(o + l),
        (None, Some(l)) => Some(l),
        _ => None,
    }
}

fn row_in_organize_range(idx: usize, offset: Option<usize>, limit: Option<usize>) -> bool {
    match (offset, limit) {
        (None, None) => true,
        (Some(o), None) => idx >= o,
        (None, Some(l)) => idx < l,
        (Some(o), Some(l)) => idx >= o && idx < o + l,
    }
}

fn run_organize(
    handle: &tokio::runtime::Handle,
    storage: Arc<Storage>,
    options: OrganizeOptions,
    cancel: Arc<AtomicBool>,
) -> Result<(), String> {
    let total = storage.get_images_total_count()?; // 总图片数

    let mut seen_hashes: HashSet<String> = HashSet::new();
    let mut row_index: usize = 0;
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
            emit_organize_finished(removed_total, regenerated_total, true);
            return Ok(());
        }

        // 分批扫描: SELECT id, hash, local_path, thumbnail_path FROM images WHERE id > ? ORDER BY id ASC LIMIT 1000
        let batch = storage.get_organize_batch(cursor_id, 1000)?;
        if batch.is_empty() {
            break;
        }

        // 游标推进
        cursor_id = batch.last().unwrap().id;

        let mut remove_ids: Vec<String> = Vec::new();
        let mut regen_list: Vec<(i64, String)> = Vec::new();
        let mut should_remove: HashSet<i64> = HashSet::new();

        let upper = organize_range_upper_bound(options.offset, options.limit);
        let mut finish_organize = false;

        for row in &batch {
            if let Some(ub) = upper {
                if row_index >= ub {
                    finish_organize = true;
                    break;
                }
            }

            let in_range = row_in_organize_range(row_index, options.offset, options.limit);
            row_index += 1;
            if !in_range {
                continue;
            }

            // 1. 去重判断
            if options.dedupe && !row.hash.is_empty() {
                if seen_hashes.contains(&row.hash) {
                    remove_ids.push(row.id.to_string());
                    should_remove.insert(row.id);
                } else {
                    seen_hashes.insert(row.hash.clone());
                }
            }

            // 2. 清除失效图片判断
            if options.remove_missing
                && !should_remove.contains(&row.id)
                && !Path::new(&row.local_path).exists()
            {
                remove_ids.push(row.id.to_string());
                should_remove.insert(row.id);
            }

            // 3. 移除磁盘存在但 infer 无法在支持 MIME 列表中识别的媒体
            if options.remove_unrecognized
                && !should_remove.contains(&row.id)
                && Path::new(&row.local_path).exists()
                && crate::image_type::mime_type_from_path(Path::new(&row.local_path)).is_none()
            {
                remove_ids.push(row.id.to_string());
                should_remove.insert(row.id);
            }

            // 4. 补充缩略图判断
            if options.regen_thumbnails && !should_remove.contains(&row.id) {
                let needs_regen = row.thumbnail_path.is_empty()
                    || row.thumbnail_path == row.local_path
                    || !Path::new(&row.thumbnail_path).exists();
                if needs_regen {
                    regen_list.push((row.id, row.local_path.clone()));
                }
            }
        }

        // 执行删除
        if !remove_ids.is_empty() {
            crate::storage::image_events::delete_images_with_events(&remove_ids, false)?;

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

            if options.delete_source_files {
                let paths_to_delete: Vec<&str> = batch
                    .iter()
                    .filter(|r| should_remove.contains(&r.id))
                    .map(|r| r.local_path.as_str())
                    .collect();

                if options.safe_delete {
                    let still_referenced = storage.paths_still_referenced(&paths_to_delete)?;
                    for path in paths_to_delete {
                        if path.is_empty() {
                            continue;
                        }
                        if !still_referenced.contains(path) {
                            let _ = std::fs::remove_file(path);
                        }
                    }
                } else {
                    for path in paths_to_delete {
                        if path.is_empty() {
                            continue;
                        }
                        let _ = std::fs::remove_file(path);
                    }
                }
            }
        }

        // 执行缩略图补充（进度仅在整批——含缩略图——结束后发送，避免扫描已 100% 仍在补图）
        for (id, path) in regen_list {
            if cancel.load(Ordering::Relaxed) {
                emit_organize_finished(removed_total, regenerated_total, true);
                return Ok(());
            }
            let thumbnail_result =
                handle.block_on(async { generate_thumbnail(Path::new(&path)).await });

            if let Ok(Some(thumb_path)) = thumbnail_result {
                let thumb_str = thumb_path.to_string_lossy().to_string();
                storage.update_image_thumbnail_path(&id.to_string(), &thumb_str)?;
                regenerated_total += 1;
            }
        }

        // 本批（扫描 + 删除 + 缩略图）完成后发送进度
        push_organize_progress(
            total,
            &options,
            row_index,
            removed_total,
            regenerated_total,
        );

        if finish_organize {
            break;
        }
    }

    emit_organize_finished(removed_total, regenerated_total, false);
    Ok(())
}
