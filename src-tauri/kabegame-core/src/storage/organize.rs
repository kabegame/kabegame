use crate::crawler::downloader::{
    generate_thumbnail, image_needs_independent_thumbnail, image_thumbnail_dimensions_acceptable,
};
use crate::emitter::GlobalEmitter;
use crate::settings::Settings;
use crate::storage::Storage;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex, OnceLock,
};

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
    pub compatible_path: String,
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
                    "SELECT images.url, images.local_path, images.plugin_id, images.task_id, images.crawled_at, m.data,
                            COALESCE(NULLIF(thumbnail_path, ''), local_path), COALESCE(hash, ''), COALESCE(type, 'image')
                     FROM images
                     LEFT JOIN image_metadata m ON m.id = images.metadata_id
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

    /// 获取整理用的分批图片数据，按 **id 游标**翻页：`id > after_id ORDER BY id ASC LIMIT limit`。
    ///
    /// 必须用游标而非 OFFSET 分页：整理会边扫边删，OFFSET 会随删除而漂移、跳过未扫的行，
    /// 导致漏扫与「每次执行都还有移除项」的不幂等（曾误删大量文件的连锁根因之一）。
    /// 游标只依赖 `id > after_id`，删除已扫过的行（id ≤ after_id）不影响后续批次。
    pub fn get_organize_batch_after(
        &self,
        after_id: i64,
        limit: usize,
    ) -> Result<Vec<OrganizeScanRow>, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let mut stmt = conn
            .prepare(
                "SELECT id, COALESCE(hash, ''), local_path, COALESCE(thumbnail_path, ''), COALESCE(compatible_path, '') \
                 FROM images WHERE id > ?1 ORDER BY id ASC LIMIT ?2",
            )
            .map_err(|e| format!("Failed to prepare organize batch: {}", e))?;
        let rows = stmt
            .query_map(params![after_id, limit as i64], |row| {
                Ok(OrganizeScanRow {
                    id: row.get(0)?,
                    hash: row.get(1)?,
                    local_path: row.get(2)?,
                    thumbnail_path: row.get(3)?,
                    compatible_path: row.get(4)?,
                })
            })
            .map_err(|e| format!("Failed to query organize batch: {}", e))?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(|e| format!("organize row error: {}", e))?);
        }
        Ok(out)
    }

    /// 对一批 hash，返回每个 hash 在整张表中的「胜者 id」（去重时唯一保留的那张）：
    /// `keep_new == true` → `MAX(id)`（保留最新）；否则 `MIN(id)`（保留最旧）。
    ///
    /// 一条聚合查询完成整批比对，避免逐图查表。IN 占位符按 `hashes` 长度动态拼接
    /// （整理批次 ≤100，占位符数量安全）；空 hash 不参与。
    pub fn get_hash_winner_ids(
        &self,
        hashes: &[String],
        keep_new: bool,
    ) -> Result<HashMap<String, i64>, String> {
        if hashes.is_empty() {
            return Ok(HashMap::new());
        }
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let placeholders = std::iter::repeat("?")
            .take(hashes.len())
            .collect::<Vec<_>>()
            .join(",");
        let agg = if keep_new { "MAX(id)" } else { "MIN(id)" };
        let sql = format!(
            "SELECT hash, {agg} FROM images WHERE hash != '' AND hash IN ({placeholders}) GROUP BY hash"
        );
        let mut stmt = conn
            .prepare(&sql)
            .map_err(|e| format!("Failed to prepare winner query: {}", e))?;
        let params = rusqlite::params_from_iter(hashes.iter());
        let rows = stmt
            .query_map(params, |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            })
            .map_err(|e| format!("Failed to query winner ids: {}", e))?;
        let mut out = HashMap::new();
        for r in rows {
            let (hash, id) = r.map_err(|e| format!("winner row error: {}", e))?;
            out.insert(hash, id);
        }
        Ok(out)
    }

    /// 获取总图片数（用于进度计算）
    pub fn get_images_total_count(&self) -> Result<usize, String> {
        crate::providers::count_at("images://")
    }
}

#[derive(Debug, Clone)]
pub struct OrganizeOptions {
    pub dedupe: bool,
    /// 去重保留策略：`true` 保留最新（最大 id），`false` 保留最旧（最小 id）
    pub dedupe_keep_new: bool,
    pub remove_missing: bool,
    pub remove_unrecognized: bool,
    pub regen_thumbnails: bool,
    /// 为尚无兼容副本的媒体（浏览器不兼容格式/超大图）生成兼容副本（仅桌面）
    pub regen_compatible: bool,
    /// 在 DB 记录删除后是否同时删除磁盘上的源文件
    pub delete_source_files: bool,
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
    pub dedupe_keep_new: bool,
    pub remove_missing: bool,
    pub remove_unrecognized: bool,
    pub regen_thumbnails: bool,
    pub regen_compatible: bool,
    pub delete_source_files: bool,
}

static GLOBAL_ORGANIZE: OnceLock<Arc<OrganizeService>> = OnceLock::new();

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
            dedupe_keep_new: options.dedupe_keep_new,
            remove_missing: options.remove_missing,
            remove_unrecognized: options.remove_unrecognized,
            regen_thumbnails: options.regen_thumbnails,
            regen_compatible: options.regen_compatible,
            delete_source_files: options.delete_source_files,
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

    /// `running == false` 时返回默认空状态（`run_state.running` 由 start/reset 维护）
    pub fn get_run_state(&self) -> OrganizeRunState {
        self.run_state
            .lock()
            .ok()
            .map(|m| (*m).clone())
            .unwrap_or_default()
    }

    pub async fn start(
        self: Arc<Self>,
        storage: Arc<Storage>,
        options: OrganizeOptions,
    ) -> Result<(), String> {
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

            // 清理运行状态
            svc.clear_running();
            svc.reset_run_state();
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

#[derive(Debug, Clone)]
enum ThumbnailRefreshAction {
    UseOriginal {
        id: i64,
        local_path: String,
    },
    Regenerate {
        id: i64,
        local_path: String,
    },
    #[cfg(target_os = "linux")]
    RegenerateVideo {
        id: i64,
        local_path: String,
        previous_thumbnail_path: String,
    },
}

fn thumbnail_refresh_action(row: &OrganizeScanRow) -> Option<ThumbnailRefreshAction> {
    let local_path = row.local_path.trim();
    if local_path.is_empty() {
        return None;
    }

    let local = Path::new(local_path);
    if !local.exists() || !crate::image_type::is_image_by_path(local) {
        return None;
    }

    let source_size = std::fs::metadata(local).ok()?.len();
    let thumbnail_path = row.thumbnail_path.trim();

    if !image_needs_independent_thumbnail(source_size) {
        if thumbnail_path != local_path {
            return Some(ThumbnailRefreshAction::UseOriginal {
                id: row.id,
                local_path: local_path.to_string(),
            });
        }
        return None;
    }

    // 按尺寸判断：最长边超过上限（或读不出尺寸/已损坏）才重生成；与生成策略一致，避免无谓重生成。
    let needs_regen = thumbnail_path.is_empty()
        || thumbnail_path == local_path
        || !Path::new(thumbnail_path).exists()
        || image::image_dimensions(thumbnail_path)
            .map(|(w, h)| !image_thumbnail_dimensions_acceptable(w, h))
            .unwrap_or(true);

    if needs_regen {
        Some(ThumbnailRefreshAction::Regenerate {
            id: row.id,
            local_path: local_path.to_string(),
        })
    } else {
        None
    }
}

/// Linux CEF 不能播放旧的 H.264 MP4 视频缩略图。整理时将其重建为 VP9 WebM，
/// 已存在的 WebM 缩略图无需重复处理。
#[cfg(target_os = "linux")]
fn video_thumbnail_refresh_action(row: &OrganizeScanRow) -> Option<ThumbnailRefreshAction> {
    let local_path = row.local_path.trim();
    if local_path.is_empty() {
        return None;
    }

    let local = Path::new(local_path);
    if !local.exists() || !crate::image_type::is_video_by_path(local) {
        return None;
    }

    let thumbnail_path = row.thumbnail_path.trim();
    let is_usable_webm = Path::new(thumbnail_path)
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("webm"))
        && Path::new(thumbnail_path).exists();
    if is_usable_webm {
        return None;
    }

    Some(ThumbnailRefreshAction::RegenerateVideo {
        id: row.id,
        local_path: local_path.to_string(),
        previous_thumbnail_path: thumbnail_path.to_string(),
    })
}

/// 删除已被新缩略图替代的文件。只允许删除 `AppPaths::thumbnails_dir()` 内的常规文件，
/// 避免整理流程触及原始媒体或任意外部路径。
#[cfg(target_os = "linux")]
fn remove_replaced_thumbnail_file(previous_path: &str, replacement_path: &str) {
    let previous_path = previous_path.trim();
    if previous_path.is_empty() || previous_path == replacement_path {
        return;
    }
    let Ok(root) = crate::app_paths::AppPaths::global()
        .thumbnails_dir()
        .canonicalize()
    else {
        return;
    };
    let Ok(previous) = Path::new(previous_path).canonicalize() else {
        return;
    };
    if !previous.starts_with(&root) {
        return;
    }
    if let Err(e) = std::fs::remove_file(&previous) {
        eprintln!(
            "[organize] remove replaced video thumbnail failed ({}): {e}",
            previous.display()
        );
    }
}

/// 删除已由新兼容副本替代的文件。只允许删除 `AppPaths::compatibles_dir()` 内的常规文件，
/// 避免整理流程触及用户导入的原始媒体或任意外部路径。
#[cfg(not(target_os = "android"))]
fn remove_replaced_compatible_file(previous_path: &str, replacement_path: &str) {
    let previous_path = previous_path.trim();
    if previous_path.is_empty() || previous_path == replacement_path {
        return;
    }
    let Ok(root) = crate::app_paths::AppPaths::global()
        .compatibles_dir()
        .canonicalize()
    else {
        return;
    };
    let Ok(previous) = Path::new(previous_path).canonicalize() else {
        return;
    };
    if !previous.starts_with(&root) {
        return;
    }
    if let Err(e) = std::fs::remove_file(&previous) {
        eprintln!(
            "[organize] remove replaced compatible file failed ({}): {e}",
            previous.display()
        );
    }
}

fn run_organize(
    handle: &tokio::runtime::Handle,
    storage: Arc<Storage>,
    options: OrganizeOptions,
    cancel: Arc<AtomicBool>,
) -> Result<(), String> {
    let total = storage.get_images_total_count()?; // 总图片数

    let mut row_index: usize = 0;
    let mut removed_total: usize = 0;
    let mut regenerated_total: usize = 0;
    // id 游标：上一批处理到的最大 id。用游标分页而非 OFFSET，避免边扫边删导致漏扫。
    let mut last_id: i64 = 0;

    // 缩略图重生成 / 兼容格式生成均重（解码 + 写文件），保持小批；其余只读判断 + 删除，用大批减少往返。
    let batch_size = if options.regen_thumbnails || options.regen_compatible {
        10
    } else {
        100
    };

    // 当前壁纸 id：若被移除则清空（与历史行为保持一致）
    let mut current_wallpaper_id = Settings::global().get_current_wallpaper_image_id();

    loop {
        if cancel.load(Ordering::Relaxed) {
            emit_organize_finished(removed_total, regenerated_total, true);
            return Ok(());
        }

        let batch = storage.get_organize_batch_after(last_id, batch_size)?;
        if batch.is_empty() {
            break;
        }

        // 去重：每批一条聚合查询拿到每个 hash 在整张表的「胜者 id」。
        // 胜者（保新=MAX / 保旧=MIN）永不被删，故跨批次稳定；批内同 hash 也只留胜者。
        let winner_ids: HashMap<String, i64> = if options.dedupe {
            let mut hashes: Vec<String> = batch
                .iter()
                .filter(|r| !r.hash.is_empty())
                .map(|r| r.hash.clone())
                .collect();
            hashes.sort();
            hashes.dedup();
            storage.get_hash_winner_ids(&hashes, options.dedupe_keep_new)?
        } else {
            HashMap::new()
        };

        let mut remove_ids: Vec<String> = Vec::new();
        let mut refresh_list: Vec<ThumbnailRefreshAction> = Vec::new();
        let mut should_remove: HashSet<i64> = HashSet::new();
        #[cfg(not(target_os = "android"))]
        let mut compat_list: Vec<(i64, String, String)> = Vec::new();

        let upper = organize_range_upper_bound(options.offset, options.limit);
        let mut finish_organize = false;

        for row in &batch {
            // 推进游标：即使本行因区间上界跳过，也已"看过"，下一批从其后继续。
            last_id = row.id;
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

            // 1. 去重判断：非胜者 id 即重复项，移除。
            if options.dedupe && !row.hash.is_empty() {
                if let Some(&winner) = winner_ids.get(&row.hash) {
                    if row.id != winner {
                        remove_ids.push(row.id.to_string());
                        should_remove.insert(row.id);
                    }
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
                #[cfg(target_os = "linux")]
                let refresh_action =
                    video_thumbnail_refresh_action(row).or_else(|| thumbnail_refresh_action(row));
                #[cfg(not(target_os = "linux"))]
                let refresh_action = thumbnail_refresh_action(row);
                if let Some(action) = refresh_action {
                    refresh_list.push(action);
                }
            }

            // 5. 补充兼容格式。Linux CEF 不支持 H.264/AAC，因此勾选整理时所有视频都
            // 重新生成 VP9/Opus WebM 副本。不能仅按 .webm 扩展名跳过：历史副本可能是
            // 无声的 VP9 WebM，必须借此迁移为包含 Opus 音轨的正确副本。
            #[cfg(not(target_os = "android"))]
            {
                let compatible_path = row.compatible_path.trim();
                let linux_video_needs_refresh = cfg!(target_os = "linux")
                    && crate::image_type::is_video_by_path(Path::new(&row.local_path));
                if options.regen_compatible
                    && !should_remove.contains(&row.id)
                    && (compatible_path.is_empty() || linux_video_needs_refresh)
                {
                    let local = row.local_path.trim();
                    if !local.is_empty() && Path::new(local).exists() {
                        compat_list.push((row.id, local.to_string(), compatible_path.to_string()));
                    }
                }
            }
        }

        // 执行删除
        if !remove_ids.is_empty() {
            crate::storage::image_events::delete_images_with_events(&remove_ids, false)?;

            // 检查壁纸是否被移除
            if let Some(cur) = current_wallpaper_id.as_deref() {
                if remove_ids.iter().any(|id| id == cur) {
                    let _ = Settings::global().set_current_wallpaper_image_id(None);
                    current_wallpaper_id = None;
                }
            }

            removed_total += remove_ids.len();

            // 「删除源文件」=移入系统回收站（带软链接/异构盘护栏，绝不永久删除）。
            // 历史事故：`~/Pictures` 软链到外置盘后，删除穿过软链误删共享物理文件。
            // 现在软链接 / 网络盘 / 虚拟盘上的文件只移出图库、保留磁盘文件（见 safe_delete）。
            // Android 的 content:// 删除不在此处。
            #[cfg(not(any(target_os = "android", target_os = "ios")))]
            if options.delete_source_files {
                let paths: Vec<&Path> = batch
                    .iter()
                    .filter(|r| should_remove.contains(&r.id))
                    .map(|r| r.local_path.trim())
                    .filter(|p| !p.is_empty())
                    .map(Path::new)
                    .collect();
                crate::storage::safe_delete::trash_source_files_batch(&paths);
            }
        }

        // 执行缩略图补充（进度仅在整批——含缩略图——结束后发送，避免扫描已 100% 仍在补图）
        for action in refresh_list {
            if cancel.load(Ordering::Relaxed) {
                emit_organize_finished(removed_total, regenerated_total, true);
                return Ok(());
            }
            match action {
                ThumbnailRefreshAction::UseOriginal { id, local_path } => {
                    storage.replace_image_thumbnail_path(&id.to_string(), &local_path)?;
                    regenerated_total += 1;
                }
                ThumbnailRefreshAction::Regenerate { id, local_path } => {
                    let thumbnail_result =
                        handle.block_on(async { generate_thumbnail(Path::new(&local_path)).await });

                    if let Ok(thumbnail_path) = thumbnail_result {
                        let thumb_str = thumbnail_path
                            .map(|path| path.to_string_lossy().to_string())
                            .unwrap_or_else(|| local_path.clone());
                        storage.replace_image_thumbnail_path(&id.to_string(), &thumb_str)?;
                        regenerated_total += 1;
                    }
                }
                #[cfg(target_os = "linux")]
                ThumbnailRefreshAction::RegenerateVideo {
                    id,
                    local_path,
                    previous_thumbnail_path,
                } => {
                    let thumbnail_result = handle.block_on(async {
                        crate::crawler::downloader::compress::compress_video_for_preview(Path::new(
                            &local_path,
                        ))
                        .await
                    });

                    if let Ok(result) = thumbnail_result {
                        let thumbnail_path = result.preview_path.to_string_lossy().to_string();
                        storage.replace_image_thumbnail_path(&id.to_string(), &thumbnail_path)?;
                        remove_replaced_thumbnail_file(&previous_thumbnail_path, &thumbnail_path);
                        regenerated_total += 1;
                    }
                }
            }
        }

        // 执行兼容格式补充（仅桌面）
        #[cfg(not(target_os = "android"))]
        for (id, local_path, previous_compatible_path) in compat_list {
            if cancel.load(Ordering::Relaxed) {
                emit_organize_finished(removed_total, regenerated_total, true);
                return Ok(());
            }
            let local = Path::new(&local_path);
            let is_video = crate::image_type::is_video_by_path(local);
            let result = handle.block_on(async {
                if is_video {
                    match crate::media_dimensions::probe_media_sync(local) {
                        Some(probe) => {
                            crate::crawler::downloader::generate_compatible_video(local, &probe)
                                .await
                        }
                        None => Ok(None),
                    }
                } else {
                    let Some(mime) = crate::image_type::mime_type_from_path(local) else {
                        return Ok(None);
                    };
                    let Some((w, h)) =
                        crate::media_dimensions::resolve_media_dimensions_sync(&local_path)
                    else {
                        return Ok(None);
                    };
                    crate::crawler::downloader::generate_compatible_image(local, &mime, w, h).await
                }
            });
            match result {
                Ok(Some(compat_path)) => {
                    let path_str = compat_path
                        .canonicalize()
                        .ok()
                        .map(|p| {
                            p.to_string_lossy()
                                .to_string()
                                .trim_start_matches("\\\\?\\")
                                .to_string()
                        })
                        .unwrap_or_else(|| compat_path.to_string_lossy().to_string());
                    if let Err(e) =
                        storage.replace_image_compatible_path(&id.to_string(), &path_str)
                    {
                        eprintln!("[organize] compatible_path update failed for {id}: {e}");
                    } else {
                        remove_replaced_compatible_file(&previous_compatible_path, &path_str);
                        regenerated_total += 1;
                    }
                }
                // VP8/VP9/AV1 WebM 原文件本身已可被 Linux CEF 直接播放。若历史上
                // 留有 H.264 MP4 兼容副本，清空引用并删除该副本，避免前端优先选到它。
                Ok(None) if is_video && !previous_compatible_path.is_empty() => {
                    if let Err(e) = storage.replace_image_compatible_path(&id.to_string(), "") {
                        eprintln!("[organize] compatible_path clear failed for {id}: {e}");
                    } else {
                        remove_replaced_compatible_file(&previous_compatible_path, "");
                        regenerated_total += 1;
                    }
                }
                Ok(None) => {}
                Err(e) => {
                    eprintln!(
                        "[organize] compatible generation failed for {id} ({local_path}): {e}"
                    );
                }
            }
        }

        // 本批（扫描 + 删除 + 缩略图 + 兼容格式）完成后发送进度
        push_organize_progress(total, &options, row_index, removed_total, regenerated_total);

        if finish_organize {
            break;
        }
    }

    emit_organize_finished(removed_total, regenerated_total, false);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crawler::downloader::{
        IMAGE_THUMBNAIL_MAX_DIM, IMAGE_THUMBNAIL_SOURCE_THRESHOLD_BYTES,
    };

    fn row(id: i64, local_path: &Path, thumbnail_path: &Path) -> OrganizeScanRow {
        OrganizeScanRow {
            id,
            hash: String::new(),
            local_path: local_path.to_string_lossy().to_string(),
            thumbnail_path: thumbnail_path.to_string_lossy().to_string(),
            compatible_path: String::new(),
        }
    }

    #[test]
    fn thumbnail_refresh_clears_small_image_to_original() {
        let dir = tempfile::tempdir().unwrap();
        let local = dir.path().join("small.png");
        let thumb = dir.path().join("old.jpg");
        std::fs::write(&local, [1u8; 16]).unwrap();
        std::fs::write(&thumb, [2u8; 16]).unwrap();

        let action = thumbnail_refresh_action(&row(7, &local, &thumb)).unwrap();

        match action {
            ThumbnailRefreshAction::UseOriginal { id, local_path } => {
                assert_eq!(id, 7);
                assert_eq!(local_path, local.to_string_lossy().to_string());
            }
            other => panic!("unexpected action: {:?}", other),
        }
    }

    #[test]
    fn thumbnail_refresh_keeps_in_dimension_thumbnail() {
        let dir = tempfile::tempdir().unwrap();
        let local = dir.path().join("large.png");
        let thumb = dir.path().join("thumb.jpg");
        std::fs::write(
            &local,
            vec![1u8; (IMAGE_THUMBNAIL_SOURCE_THRESHOLD_BYTES + 1) as usize],
        )
        .unwrap();
        // 缩略图最长边 ≤ 上限 → 不需重生成。
        image::RgbImage::new(800, 600).save(&thumb).unwrap();

        assert!(thumbnail_refresh_action(&row(8, &local, &thumb)).is_none());
    }

    #[test]
    fn thumbnail_refresh_regenerates_oversized_thumbnail() {
        let dir = tempfile::tempdir().unwrap();
        let local = dir.path().join("large.png");
        let thumb = dir.path().join("oversized.jpg");
        std::fs::write(
            &local,
            vec![1u8; (IMAGE_THUMBNAIL_SOURCE_THRESHOLD_BYTES + 1) as usize],
        )
        .unwrap();
        // 缩略图最长边超过上限 → 需重生成。
        image::RgbImage::new(IMAGE_THUMBNAIL_MAX_DIM + 100, 600)
            .save(&thumb)
            .unwrap();

        let action = thumbnail_refresh_action(&row(9, &local, &thumb)).unwrap();

        match action {
            ThumbnailRefreshAction::Regenerate { id, local_path } => {
                assert_eq!(id, 9);
                assert_eq!(local_path, local.to_string_lossy().to_string());
            }
            other => panic!("unexpected action: {:?}", other),
        }
    }
}
