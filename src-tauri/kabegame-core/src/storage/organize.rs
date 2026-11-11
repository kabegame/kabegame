use crate::crawler::downloader::{
    generate_thumbnail, image_needs_independent_thumbnail, image_thumbnail_dimensions_acceptable,
};
use crate::emitter::GlobalEmitter;
use crate::ipc::events::ImageFieldPatch;
use crate::settings::Settings;
use crate::storage::image_events::native_metadata_image_patch;
use crate::storage::Storage;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
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

// ========== 整理相关方法 ==========

#[derive(Debug, Clone)]
pub struct OrganizeScanRow {
    pub id: i64,
    pub hash: String,
    pub local_path: String,
    pub thumbnail_path: String,
    pub compatible_path: String,
    pub format_key: Option<String>,
    pub native_parser_version: Option<i64>,
}

impl Storage {
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
                "SELECT i.id, COALESCE(i.hash, ''), i.local_path, COALESCE(i.thumbnail_path, ''), \
                        COALESCE(i.compatible_path, ''), i.type, im.parser_version \
                 FROM images i \
                 LEFT JOIN image_metadata im ON im.id = i.image_metadata_id \
                 WHERE i.id > ?1 ORDER BY i.id ASC LIMIT ?2",
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
                    format_key: row.get(5)?,
                    native_parser_version: row.get(6)?,
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
    /// 为缺失或解析器版本过旧的 JPEG/PNG 补充原生元数据
    pub backfill_native_metadata: bool,
    /// 重新计算代表色：范围内每张不会被本次删除的图都重算色盘，不管现在有没有
    pub recompute_palette: bool,
    /// 在 DB 记录删除后是否同时删除磁盘上的源文件
    pub delete_source_files: bool,
    /// 从有序列表（按 id ASC）中跳过的前若干条
    pub offset: Option<usize>,
    /// 在 offset 之后最多处理的条数（与 offset 成对使用时表示区间）
    pub limit: Option<usize>,
}

/// 整理是否进行中及最近一次进度快照。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrganizeRunState {
    pub running: bool,
    pub library_total: usize,
    pub processed_global: usize,
    pub removed: usize,
    pub regenerated: usize,
    pub backfilled: usize,
    /// 重算后色盘有变化、已写回的张数
    pub palettes_updated: usize,
    pub range_start: Option<usize>,
    pub range_end: Option<usize>,
    pub dedupe: bool,
    pub dedupe_keep_new: bool,
    pub remove_missing: bool,
    pub remove_unrecognized: bool,
    pub regen_thumbnails: bool,
    pub regen_compatible: bool,
    pub backfill_native_metadata: bool,
    pub recompute_palette: bool,
    pub delete_source_files: bool,
}

/// 整理的累计计数：进运行状态、进度快照与完成事件。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct OrganizeCounts {
    removed: usize,
    regenerated: usize,
    backfilled: usize,
    /// 重算后色盘有变化、已写回的张数（与 `regenerated` / `backfilled` 分开计）
    palettes_updated: usize,
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
            backfilled: 0,
            palettes_updated: 0,
            range_start,
            range_end,
            dedupe: options.dedupe,
            dedupe_keep_new: options.dedupe_keep_new,
            remove_missing: options.remove_missing,
            remove_unrecognized: options.remove_unrecognized,
            regen_thumbnails: options.regen_thumbnails,
            regen_compatible: options.regen_compatible,
            backfill_native_metadata: options.backfill_native_metadata,
            recompute_palette: options.recompute_palette,
            delete_source_files: options.delete_source_files,
        };
        let mut g = self
            .run_state
            .lock()
            .map_err(|e| format!("Lock error: {}", e))?;
        *g = state;
        Ok(())
    }

    fn update_run_state_progress(&self, processed_global: usize, counts: OrganizeCounts) {
        if let Ok(mut g) = self.run_state.lock() {
            g.processed_global = processed_global;
            g.removed = counts.removed;
            g.regenerated = counts.regenerated;
            g.backfilled = counts.backfilled;
            g.palettes_updated = counts.palettes_updated;
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
        GlobalEmitter::global().emit_busy_tasks_change("organize");

        let handle = tokio::runtime::Handle::current();
        let svc = Arc::clone(&self);

        tokio::task::spawn_blocking(move || {
            tracing::info!("开始整理 {:?}", options);
            let res = run_organize(&handle, storage, options, cancel);
            if let Err(e) = res {
                let state = svc.get_run_state();
                emit_organize_finished(
                    OrganizeCounts {
                        removed: state.removed,
                        regenerated: state.regenerated,
                        backfilled: state.backfilled,
                        palettes_updated: state.palettes_updated,
                    },
                    false,
                    Some(e.clone()),
                );
                tracing::warn!("任务失败: {}", e);
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

fn push_organize_progress(processed_global: usize, counts: OrganizeCounts) {
    OrganizeService::global().update_run_state_progress(processed_global, counts);
}

fn emit_organize_finished(counts: OrganizeCounts, canceled: bool, error: Option<String>) {
    GlobalEmitter::global().emit_organize_finished(
        counts.removed,
        counts.regenerated,
        counts.backfilled,
        counts.palettes_updated,
        canceled,
        error,
    );
}

fn emit_organize_images_change(image_patches: &mut Vec<ImageFieldPatch>) {
    GlobalEmitter::global().emit_image_patches(std::mem::take(image_patches));
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
    UseOriginal { id: i64, local_path: String },
    Regenerate { id: i64, local_path: String },
    RegenerateVideo { id: i64, local_path: String },
}

#[derive(Debug)]
enum CompatResult {
    Generated(PathBuf),
    NotNeeded,
    Unknown,
}

/// 目录型 WPE 壁纸行：`local_path` 是目录，整理流程不能按文件处理。
fn is_wpe_row(row: &OrganizeScanRow) -> bool {
    crate::media::image_type::is_wpe_type(row.format_key.as_deref())
}

fn thumbnail_refresh_action(row: &OrganizeScanRow) -> Option<ThumbnailRefreshAction> {
    // WPE 的缩略图直接引用壁纸目录里的 preview.*，不重建、也不覆盖成 Kabegame 生成的图。
    if is_wpe_row(row) {
        return None;
    }
    let local_path = row.local_path.trim();
    if local_path.is_empty() {
        return None;
    }

    let local = Path::new(local_path);
    if !local.exists() {
        return None;
    }

    if crate::media::image_type::is_video_by_path(local) {
        let thumb = row.thumbnail_path.trim();
        if thumb.is_empty() || thumb == local_path || !Path::new(thumb).exists() {
            return Some(ThumbnailRefreshAction::RegenerateVideo {
                id: row.id,
                local_path: local_path.to_string(),
            });
        }
        return None;
    }

    if !crate::media::image_type::is_image_by_path(local) {
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
        tracing::warn!(
            "remove replaced compatible file failed ({}): {e}",
            previous.display()
        );
    }
}

/// 一批扫描行的处理计划：删哪些，给哪些补缩略图 / 兼容副本 / 原生元数据、重算色盘。
#[derive(Default)]
struct BatchPlan {
    remove_ids: Vec<String>,
    should_remove: HashSet<i64>,
    refresh_list: Vec<ThumbnailRefreshAction>,
    #[cfg(not(target_os = "android"))]
    compat_list: Vec<(i64, String, String)>,
    native_metadata_list: Vec<(i64, String, String)>,
    /// 重算色盘的图：范围内、不在本批删除之列
    palette_ids: Vec<i64>,
    /// 走到区间上界：本批做完即结束整理
    finish: bool,
}

/// 逐行决定本批要做什么，推进 `row_index`（全表序号，用于 offset / limit 区间）与 `last_id`（id 游标）。
fn plan_batch(
    batch: &[OrganizeScanRow],
    options: &OrganizeOptions,
    winner_ids: &HashMap<String, i64>,
    row_index: &mut usize,
    last_id: &mut i64,
) -> BatchPlan {
    let mut plan = BatchPlan::default();
    let upper = organize_range_upper_bound(options.offset, options.limit);

    for row in batch {
        // 推进游标：即使本行因区间上界跳过，也已"看过"，下一批从其后继续。
        *last_id = row.id;
        if let Some(ub) = upper {
            if *row_index >= ub {
                plan.finish = true;
                break;
            }
        }

        let in_range = row_in_organize_range(*row_index, options.offset, options.limit);
        *row_index += 1;
        if !in_range {
            continue;
        }

        // 1. 去重判断：非胜者 id 即重复项，移除。
        // 目录型 WPE 壁纸不参与哈希去重：删掉目录型记录会静默丢失壁纸来源，
        // 且入口视频的哈希与普通视频相同并不代表二者可互相替代。
        if options.dedupe && !row.hash.is_empty() && !is_wpe_row(row) {
            if let Some(&winner) = winner_ids.get(&row.hash) {
                if row.id != winner {
                    plan.remove_ids.push(row.id.to_string());
                    plan.should_remove.insert(row.id);
                }
            }
        }

        // 2. 清除失效图片判断
        if options.remove_missing
            && !plan.should_remove.contains(&row.id)
            && !Path::new(&row.local_path).exists()
        {
            plan.remove_ids.push(row.id.to_string());
            plan.should_remove.insert(row.id);
        }

        // 3. 移除磁盘存在但 infer 无法在支持 MIME 列表中识别的媒体
        // WPE 行的 local_path 是目录，infer 必然失败；不能据此把整张壁纸判成「无法识别」。
        if options.remove_unrecognized
            && !plan.should_remove.contains(&row.id)
            && !is_wpe_row(row)
            && Path::new(&row.local_path).exists()
            && crate::media::image_type::mime_type_from_path(Path::new(&row.local_path)).is_none()
        {
            plan.remove_ids.push(row.id.to_string());
            plan.should_remove.insert(row.id);
        }

        // 4. 补充缩略图判断
        if options.regen_thumbnails && !plan.should_remove.contains(&row.id) {
            if let Some(action) = thumbnail_refresh_action(row) {
                plan.refresh_list.push(action);
            }
        }

        // 5. 补充兼容格式。仅在缺失 compatible_path 时生成；已有兼容副本不做平台迁移式重建。
        #[cfg(not(target_os = "android"))]
        {
            let compatible_path = row.compatible_path.trim();
            if options.regen_compatible
                && !plan.should_remove.contains(&row.id)
                && !is_wpe_row(row)
                && (compatible_path.is_empty() || !Path::new(compatible_path).exists())
            {
                let local = row.local_path.trim();
                if !local.is_empty() && Path::new(local).exists() {
                    plan.compat_list
                        .push((row.id, local.to_string(), compatible_path.to_string()));
                }
            }
        }

        // 6. 补充原生元数据。即将删除的图片不处理；版本不符的图片逐张解析。
        if options.backfill_native_metadata && !plan.should_remove.contains(&row.id) {
            let format_key = row.format_key.as_deref().unwrap_or("").to_string();
            if let Some(expected_version) =
                crate::media::native_metadata::parser_version_for(&format_key)
            {
                if row.native_parser_version != Some(i64::from(expected_version)) {
                    plan.native_metadata_list
                        .push((row.id, row.local_path.clone(), format_key));
                }
            }
        }

        // 7. 重新计算代表色：不管现在有没有色盘都重算；即将删除的图片不处理。
        if options.recompute_palette && !plan.should_remove.contains(&row.id) {
            plan.palette_ids.push(row.id);
        }
    }
    plan
}

/// 「重新计算代表色」：逐张重算色盘，与原来不同才写回（`palette` 列 + 距离，一个事务）并推补丁；
/// 算不出来（文件不在、解码失败）的保留原色盘。读行、计算与写回和回填作业 `image_palette` 共用。
/// 返回 `(写回的张数, 是否被取消)`。
fn recompute_palettes(
    handle: &tokio::runtime::Handle,
    storage: &Storage,
    ids: &[i64],
    cancel: &AtomicBool,
    patches: &mut Vec<ImageFieldPatch>,
) -> Result<(usize, bool), String> {
    let rows = storage.palette_source_rows(ids)?;
    let mut updated = 0;
    for row in rows {
        if cancel.load(Ordering::Relaxed) {
            return Ok((updated, true));
        }
        let Some(palette) = handle.block_on(row.compute()) else {
            tracing::debug!(
                "palette recompute: no palette for {} ({}), keep the old one",
                row.id,
                row.local_path
            );
            continue;
        };
        match storage.store_recomputed_palette(&row, &palette) {
            Ok(Some(patch)) => {
                patches.push(patch);
                updated += 1;
            }
            // 色盘没变，或读盘期间行被删 / 改指别处
            Ok(None) => {}
            Err(e) => tracing::warn!("palette recompute store failed for {}: {e}", row.id),
        }
    }
    Ok((updated, false))
}

fn run_organize(
    handle: &tokio::runtime::Handle,
    storage: Arc<Storage>,
    options: OrganizeOptions,
    cancel: Arc<AtomicBool>,
) -> Result<(), String> {
    let mut row_index: usize = 0;
    let mut counts = OrganizeCounts::default();
    // id 游标：上一批处理到的最大 id。用游标分页而非 OFFSET，避免边扫边删导致漏扫。
    let mut last_id: i64 = 0;

    // 缩略图、兼容格式、原生元数据补算与重算色盘都会读文件并解码，保持小批；其余操作用大批减少往返。
    let batch_size = if options.regen_thumbnails
        || options.regen_compatible
        || options.backfill_native_metadata
        || options.recompute_palette
    {
        10
    } else {
        100
    };

    loop {
        if cancel.load(Ordering::Relaxed) {
            emit_organize_finished(counts, true, None);
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

        let plan = plan_batch(&batch, &options, &winner_ids, &mut row_index, &mut last_id);
        let mut changed_image_patches: Vec<ImageFieldPatch> = Vec::new();
        let remove_ids = plan.remove_ids;
        let should_remove = plan.should_remove;

        // 执行删除
        if !remove_ids.is_empty() {
            handle.block_on(crate::storage::image_events::delete_images_with_events(
                &remove_ids,
                false,
            ))?;

            // 被移除的图若是某个壁纸目标的当前壁纸，清空该目标（与历史行为保持一致）
            let _ = Settings::global().clear_wallpaper_targets_current_images(&remove_ids);

            counts.removed += remove_ids.len();

            if options.delete_source_files {
                let paths: Vec<String> = batch
                    .iter()
                    .filter(|r| should_remove.contains(&r.id))
                    .map(|r| r.local_path.trim().to_string())
                    .filter(|p| !p.is_empty())
                    .collect();
                handle.block_on(crate::storage::source_purge::purge_source_files(&paths));
            }
        }

        // 执行缩略图补充（进度仅在整批——含缩略图——结束后发送，避免扫描已 100% 仍在补图）
        for action in plan.refresh_list {
            if cancel.load(Ordering::Relaxed) {
                emit_organize_images_change(&mut changed_image_patches);
                emit_organize_finished(counts, true, None);
                return Ok(());
            }
            match action {
                ThumbnailRefreshAction::UseOriginal { id, local_path } => {
                    // 写库失败会中止整理：先把本批已写入的补丁发出，前端不停留在旧路径
                    storage
                        .replace_image_thumbnail_path(&id.to_string(), &local_path)
                        .inspect_err(|_| emit_organize_images_change(&mut changed_image_patches))?;
                    changed_image_patches.push(ImageFieldPatch {
                        id: id.to_string(),
                        fields: serde_json::json!({ "thumbnailPath": local_path })
                            .as_object()
                            .unwrap()
                            .clone(),
                    });
                    counts.regenerated += 1;
                }
                ThumbnailRefreshAction::Regenerate { id, local_path } => {
                    let thumbnail_result =
                        handle.block_on(async { generate_thumbnail(Path::new(&local_path)).await });

                    if let Ok(thumbnail_path) = thumbnail_result {
                        let thumb_str = thumbnail_path
                            .map(|path| path.to_string_lossy().to_string())
                            .unwrap_or_else(|| local_path.clone());
                        storage
                            .replace_image_thumbnail_path(&id.to_string(), &thumb_str)
                            .inspect_err(|_| {
                                emit_organize_images_change(&mut changed_image_patches)
                            })?;
                        changed_image_patches.push(ImageFieldPatch {
                            id: id.to_string(),
                            fields: serde_json::json!({ "thumbnailPath": thumb_str })
                                .as_object()
                                .unwrap()
                                .clone(),
                        });
                        counts.regenerated += 1;
                    }
                }
                ThumbnailRefreshAction::RegenerateVideo { id, local_path } => {
                    #[cfg(target_os = "android")]
                    let preview = handle.block_on(async {
                        crate::crawler::downloader::compress::compress_video_for_preview(
                            &local_path,
                        )
                        .await
                    });
                    #[cfg(not(target_os = "android"))]
                    let preview = handle.block_on(async {
                        crate::crawler::downloader::compress::compress_video_for_preview(Path::new(
                            &local_path,
                        ))
                        .await
                    });
                    match preview {
                        Ok(result) => {
                            let preview_path_str =
                                result.preview_path.to_string_lossy().to_string();
                            storage
                                .replace_image_thumbnail_path(&id.to_string(), &preview_path_str)
                                .inspect_err(|_| {
                                    emit_organize_images_change(&mut changed_image_patches)
                                })?;
                            changed_image_patches.push(ImageFieldPatch {
                                id: id.to_string(),
                                fields: serde_json::json!({ "thumbnailPath": preview_path_str })
                                    .as_object()
                                    .unwrap()
                                    .clone(),
                            });
                            counts.regenerated += 1;
                        }
                        Err(e) => {
                            tracing::warn!("video thumbnail generation failed for {id}: {e}");
                        }
                    }
                }
            }
        }

        // 执行兼容格式补充（仅桌面）
        #[cfg(not(target_os = "android"))]
        for (id, local_path, previous_compatible_path) in plan.compat_list {
            if cancel.load(Ordering::Relaxed) {
                emit_organize_images_change(&mut changed_image_patches);
                emit_organize_finished(counts, true, None);
                return Ok(());
            }
            let local = Path::new(&local_path);
            let is_video = crate::media::image_type::is_video_by_path(local);
            let compat_result = handle.block_on(async {
                if is_video {
                    match crate::media::dimensions::probe_media_sync(local) {
                        Some(probe) if probe.browser_safe => CompatResult::NotNeeded,
                        Some(probe) => {
                            tracing::debug!("transcoding compatible video for {id} ({local_path})");
                            match crate::crawler::downloader::generate_compatible_video(
                                local, &probe,
                            )
                            .await
                            {
                                Ok(Some(path)) => CompatResult::Generated(path),
                                Ok(None) => CompatResult::Unknown,
                                Err(e) => {
                                    tracing::warn!(
                                        "compatible generation failed for {id} ({local_path}): {e}"
                                    );
                                    CompatResult::Unknown
                                }
                            }
                        }
                        None => CompatResult::Unknown,
                    }
                } else {
                    let Some(mime) = crate::media::image_type::mime_type_from_path(local) else {
                        return CompatResult::Unknown;
                    };
                    let Some((w, h)) =
                        crate::media::dimensions::resolve_media_dimensions_sync(&local_path)
                    else {
                        return CompatResult::Unknown;
                    };
                    match crate::crawler::downloader::generate_compatible_image(local, &mime, w, h)
                        .await
                    {
                        Ok(Some(path)) => CompatResult::Generated(path),
                        Ok(None) => CompatResult::NotNeeded,
                        Err(e) => {
                            tracing::warn!(
                                "compatible generation failed for {id} ({local_path}): {e}"
                            );
                            CompatResult::Unknown
                        }
                    }
                }
            });
            match compat_result {
                CompatResult::Generated(compat_path) => {
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
                        tracing::warn!("compatible_path update failed for {id}: {e}");
                    } else {
                        remove_replaced_compatible_file(&previous_compatible_path, &path_str);
                        changed_image_patches.push(ImageFieldPatch {
                            id: id.to_string(),
                            fields: serde_json::json!({ "compatiblePath": path_str })
                                .as_object()
                                .unwrap()
                                .clone(),
                        });
                        counts.regenerated += 1;
                    }
                }
                CompatResult::NotNeeded => {
                    if let Err(e) =
                        storage.replace_image_compatible_path(&id.to_string(), &local_path)
                    {
                        tracing::warn!("compatible_path sentinel update failed for {id}: {e}");
                    } else {
                        remove_replaced_compatible_file(&previous_compatible_path, &local_path);
                        changed_image_patches.push(ImageFieldPatch {
                            id: id.to_string(),
                            fields: serde_json::json!({ "compatiblePath": local_path })
                                .as_object()
                                .unwrap()
                                .clone(),
                        });
                    }
                }
                CompatResult::Unknown => {}
            }
        }

        // 执行原生元数据补充。失败只记录并跳过，不中断整批整理。
        for (id, local_path, format_key) in plan.native_metadata_list {
            let Some(expected_version) =
                crate::media::native_metadata::parser_version_for(&format_key)
            else {
                continue;
            };
            if cancel.load(Ordering::Relaxed) {
                emit_organize_images_change(&mut changed_image_patches);
                emit_organize_finished(counts, true, None);
                return Ok(());
            }

            let image_id = id.to_string();
            let bytes = match handle
                .block_on(crate::media::native_metadata::read_image_bytes(&local_path))
            {
                Ok(bytes) => bytes,
                Err(e) => {
                    tracing::warn!("native metadata file read failed for {id} ({local_path}): {e}");
                    continue;
                }
            };
            let Some(parsed) =
                crate::media::native_metadata::parse_native_metadata(&format_key, &bytes)
            else {
                tracing::debug!("native metadata parse returned no result for {id} ({local_path})");
                continue;
            };
            let json = match serde_json::to_string(&parsed) {
                Ok(json) => json,
                Err(e) => {
                    tracing::warn!(
                        "native metadata serialization failed for {id} ({local_path}): {e}"
                    );
                    continue;
                }
            };
            match storage.replace_image_native_metadata(&image_id, expected_version, &json) {
                Ok(metadata_id) => {
                    counts.backfilled += 1;
                    // 原生元数据参与搜索：随本批逐图补丁按图片数量分流发送。
                    changed_image_patches.push(native_metadata_image_patch(&image_id, metadata_id));
                }
                Err(e) => {
                    tracing::warn!("native metadata store failed for {id} ({local_path}): {e}");
                }
            }
        }

        // 重新计算代表色。读行失败会中止整理：先把本批已写入的补丁发出
        let (palettes_updated, canceled) = recompute_palettes(
            handle,
            &storage,
            &plan.palette_ids,
            &cancel,
            &mut changed_image_patches,
        )
        .inspect_err(|_| emit_organize_images_change(&mut changed_image_patches))?;
        counts.palettes_updated += palettes_updated;
        if canceled {
            emit_organize_images_change(&mut changed_image_patches);
            emit_organize_finished(counts, true, None);
            return Ok(());
        }

        emit_organize_images_change(&mut changed_image_patches);

        // 本批（扫描 + 删除 + 缩略图 + 兼容格式 + 原生元数据 + 色盘）完成后发送进度
        push_organize_progress(row_index, counts);

        if plan.finish {
            break;
        }
    }

    emit_organize_finished(counts, false, None);
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
            format_key: None,
            native_parser_version: None,
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
        // 缩略图最长边 ≤ 上限 → 不需重生成。取恰好等于上限的边界值,与
        // thumbnail_refresh_regenerates_oversized_thumbnail 的 `+100` 对称;
        // 必须引用常量而非写死尺寸,否则上限调整后本测试会静默失效。
        image::RgbImage::new(IMAGE_THUMBNAIL_MAX_DIM, IMAGE_THUMBNAIL_MAX_DIM - 100)
            .save(&thumb)
            .unwrap();

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

    #[test]
    fn thumbnail_refresh_regenerates_video_missing_thumb() {
        let dir = tempfile::tempdir().unwrap();
        let local = dir.path().join("test.mp4");
        std::fs::write(&local, [1u8; 100]).unwrap();
        let row = OrganizeScanRow {
            id: 10,
            hash: String::new(),
            local_path: local.to_string_lossy().to_string(),
            thumbnail_path: dir
                .path()
                .join("nonexistent.mp4")
                .to_string_lossy()
                .to_string(),
            compatible_path: String::new(),
            format_key: None,
            native_parser_version: None,
        };
        let action = thumbnail_refresh_action(&row).unwrap();
        match action {
            ThumbnailRefreshAction::RegenerateVideo { id, local_path } => {
                assert_eq!(id, 10);
                assert_eq!(local_path, local.to_string_lossy().to_string());
            }
            other => panic!("unexpected action: {:?}", other),
        }
    }

    #[test]
    fn thumbnail_refresh_keeps_existing_video_thumb() {
        let dir = tempfile::tempdir().unwrap();
        let local = dir.path().join("test.mp4");
        let thumb = dir.path().join("existing_preview.mp4");
        std::fs::write(&local, [1u8; 100]).unwrap();
        std::fs::write(&thumb, [2u8; 100]).unwrap();
        let row = OrganizeScanRow {
            id: 11,
            hash: String::new(),
            local_path: local.to_string_lossy().to_string(),
            thumbnail_path: thumb.to_string_lossy().to_string(),
            compatible_path: String::new(),
            format_key: None,
            native_parser_version: None,
        };
        assert!(thumbnail_refresh_action(&row).is_none());
    }

    // ---------- 重新计算代表色 ----------

    fn options(recompute_palette: bool) -> OrganizeOptions {
        OrganizeOptions {
            dedupe: false,
            dedupe_keep_new: true,
            remove_missing: false,
            remove_unrecognized: false,
            regen_thumbnails: false,
            regen_compatible: false,
            backfill_native_metadata: false,
            recompute_palette,
            delete_source_files: false,
            offset: None,
            limit: None,
        }
    }

    fn scan_row(id: i64, local_path: &Path, hash: &str) -> OrganizeScanRow {
        OrganizeScanRow {
            hash: hash.to_string(),
            ..row(id, local_path, local_path)
        }
    }

    /// 范围内、不在本批删除之列的每一张都重算，不管现在有没有色盘；范围外与要删的不算。
    #[test]
    fn plan_recomputes_palettes_in_range_except_rows_being_removed() {
        let dir = tempfile::tempdir().unwrap();
        let present = dir.path().join("present.png");
        std::fs::write(&present, [1u8; 16]).unwrap();
        let missing = dir.path().join("missing.png");
        let batch: Vec<OrganizeScanRow> = (1..=6)
            .map(|id| scan_row(id, if id == 3 { &missing } else { &present }, ""))
            .collect();

        // 序号区间 [1, 5)：id 2..=5；id 3 的文件不在、本次删除
        let mut opts = options(true);
        opts.remove_missing = true;
        opts.offset = Some(1);
        opts.limit = Some(4);
        let (mut row_index, mut last_id) = (0, 0);
        let plan = plan_batch(&batch, &opts, &HashMap::new(), &mut row_index, &mut last_id);
        assert_eq!(plan.palette_ids, vec![2, 4, 5]);
        assert_eq!(plan.remove_ids, vec!["3".to_string()]);
        assert!(plan.finish, "走到区间上界");
        assert_eq!((row_index, last_id), (5, 6));

        // 去重的非胜者同样不算
        let batch = vec![
            scan_row(1, &present, "same"),
            scan_row(2, &present, "same"),
            scan_row(3, &present, ""),
        ];
        let mut opts = options(true);
        opts.dedupe = true;
        let winners = HashMap::from([("same".to_string(), 2)]);
        let (mut row_index, mut last_id) = (0, 0);
        let plan = plan_batch(&batch, &opts, &winners, &mut row_index, &mut last_id);
        assert_eq!(plan.palette_ids, vec![2, 3]);
        assert!(!plan.finish);

        // 开关关着不算
        let (mut row_index, mut last_id) = (0, 0);
        let plan = plan_batch(
            &batch,
            &options(false),
            &winners,
            &mut row_index,
            &mut last_id,
        );
        assert!(plan.palette_ids.is_empty());
    }

    mod palette_recompute {
        use super::super::*;
        use crate::media::palette::{distance_to, Palette, NO_PALETTE_DISTANCE};
        use crate::storage::images::write_color_distances;
        use crate::storage::migrations::BUILTIN_COLOR_BUCKETS;

        fn storage() -> Storage {
            let conn = rusqlite::Connection::open_in_memory().unwrap();
            conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
            crate::storage::migrations::init::create_all_tables(&conn);
            Storage::from_test_connection(conn)
        }

        /// 一张已入库的图：图片行（带原色盘或没有）+ 对每个色桶的距离。
        fn insert(
            storage: &Storage,
            local_path: &str,
            media_type: &str,
            palette: Option<&Palette>,
        ) -> i64 {
            let conn = storage.db.lock().unwrap();
            conn.execute(
                "INSERT INTO images (local_path, thumbnail_path, crawled_at, type, palette)
                 VALUES (?1, ?1, 1, ?2, ?3)",
                rusqlite::params![local_path, media_type, palette.map(Palette::to_json)],
            )
            .unwrap();
            let id = conn.last_insert_rowid();
            write_color_distances(&conn, id, palette).unwrap();
            id
        }

        fn solid_png(dir: &Path, name: &str, rgb: [u8; 3]) -> String {
            let path = dir.join(name);
            image::RgbImage::from_pixel(64, 64, image::Rgb(rgb))
                .save(&path)
                .unwrap();
            path.to_string_lossy().into_owned()
        }

        fn palette_of(storage: &Storage, id: i64) -> Option<String> {
            storage
                .db
                .lock()
                .unwrap()
                .query_row("SELECT palette FROM images WHERE id = ?1", [id], |row| {
                    row.get(0)
                })
                .unwrap()
        }

        fn distances_of(storage: &Storage, id: i64) -> Vec<(i64, i64)> {
            let conn = storage.db.lock().unwrap();
            let mut stmt = conn
                .prepare(
                    "SELECT bucket_rgb, distance FROM image_color_distances
                      WHERE image_id = ?1 ORDER BY bucket_rgb",
                )
                .unwrap();
            let rows = stmt
                .query_map([id], |row| Ok((row.get(0)?, row.get(1)?)))
                .unwrap()
                .collect::<Result<_, _>>()
                .unwrap();
            rows
        }

        fn expected(palette: Option<&Palette>) -> Vec<(i64, i64)> {
            let mut rows: Vec<(i64, i64)> = BUILTIN_COLOR_BUCKETS
                .iter()
                .map(|(_, rgb)| (i64::from(*rgb), i64::from(distance_to(palette, *rgb))))
                .collect();
            rows.sort();
            rows
        }

        fn run(storage: &Storage, ids: &[i64]) -> (usize, bool, Vec<ImageFieldPatch>) {
            let runtime = tokio::runtime::Runtime::new().unwrap();
            let mut patches = Vec::new();
            let (updated, canceled) = recompute_palettes(
                runtime.handle(),
                storage,
                ids,
                &AtomicBool::new(false),
                &mut patches,
            )
            .unwrap();
            (updated, canceled, patches)
        }

        /// 原来没有色盘、原来的色盘过时：都写回 palette 列与距离，各发一条 `palette` 补丁。
        #[test]
        fn writes_new_palettes_with_distances_and_patches() {
            let dir = tempfile::tempdir().unwrap();
            let storage = storage();
            let red = solid_png(dir.path(), "red.png", [255, 0, 0]);
            let blue = solid_png(dir.path(), "blue.png", [0, 0, 255]);
            let none = insert(&storage, &red, "image/png", None);
            let stale = insert(
                &storage,
                &blue,
                "image/png",
                Some(&Palette::single([255, 255, 0])),
            );

            let (updated, canceled, patches) = run(&storage, &[none, stale]);

            assert_eq!((updated, canceled), (2, false));
            let red_palette = Palette::single([255, 0, 0]);
            let blue_palette = Palette::single([0, 0, 255]);
            assert_eq!(palette_of(&storage, none), Some(red_palette.to_json()));
            assert_eq!(palette_of(&storage, stale), Some(blue_palette.to_json()));
            assert_eq!(distances_of(&storage, none), expected(Some(&red_palette)));
            assert_eq!(distances_of(&storage, stale), expected(Some(&blue_palette)));
            assert_eq!(
                patches,
                vec![
                    ImageFieldPatch {
                        id: none.to_string(),
                        fields: serde_json::Map::from_iter([(
                            "palette".to_string(),
                            serde_json::Value::String(red_palette.to_json()),
                        )]),
                    },
                    ImageFieldPatch {
                        id: stale.to_string(),
                        fields: serde_json::Map::from_iter([(
                            "palette".to_string(),
                            serde_json::Value::String(blue_palette.to_json()),
                        )]),
                    },
                ]
            );
        }

        /// 色盘与原来相同：不写库（距离行原样，连被改过的标记值都不动）、不发补丁、不计数。
        #[test]
        fn unchanged_palette_is_not_written() {
            let dir = tempfile::tempdir().unwrap();
            let storage = storage();
            let red = solid_png(dir.path(), "red.png", [255, 0, 0]);
            let id = insert(
                &storage,
                &red,
                "image/png",
                Some(&Palette::single([255, 0, 0])),
            );
            storage
                .db
                .lock()
                .unwrap()
                .execute(
                    "UPDATE image_color_distances SET distance = 7 WHERE image_id = ?1",
                    [id],
                )
                .unwrap();

            let (updated, canceled, patches) = run(&storage, &[id]);

            assert_eq!((updated, canceled), (0, false));
            assert!(patches.is_empty());
            assert!(distances_of(&storage, id)
                .iter()
                .all(|(_, distance)| *distance == 7));
        }

        /// 算不出来（文件不在）：保留原色盘与距离，不发补丁；原来没有色盘的仍是 65536。
        #[test]
        fn uncomputable_rows_keep_their_palette() {
            let dir = tempfile::tempdir().unwrap();
            let storage = storage();
            let gone = dir.path().join("gone.png").to_string_lossy().into_owned();
            let old = Palette::single([0, 255, 0]);
            let kept = insert(&storage, &gone, "image/png", Some(&old));
            let gone2 = dir.path().join("gone2.png").to_string_lossy().into_owned();
            let bare = insert(&storage, &gone2, "image/png", None);

            let (updated, _, patches) = run(&storage, &[kept, bare]);

            assert_eq!(updated, 0);
            assert!(patches.is_empty());
            assert_eq!(palette_of(&storage, kept), Some(old.to_json()));
            assert_eq!(distances_of(&storage, kept), expected(Some(&old)));
            assert_eq!(palette_of(&storage, bare), None);
            assert!(distances_of(&storage, bare)
                .iter()
                .all(|(_, distance)| *distance == i64::from(NO_PALETTE_DISTANCE)));
        }

        /// 只处理给定的 id；WPE 网页壁纸照回填从 metadata 取 schemecolor。
        #[test]
        fn only_given_ids_and_wpe_scheme_color() {
            let dir = tempfile::tempdir().unwrap();
            let storage = storage();
            let red = solid_png(dir.path(), "red.png", [255, 0, 0]);
            let outside = insert(&storage, &red, "image/png", None);
            let web = insert(&storage, "/no/such/wallpaper-dir", "x-wpe/web", None);
            {
                let conn = storage.db.lock().unwrap();
                conn.execute(
                    "INSERT INTO metadata (data, plugin_id) VALUES (?1, 'wpe-import')",
                    [serde_json::json!({
                        "type": "web",
                        "general": { "properties": {
                            "schemecolor": { "type": "color", "value": "0 0 1" }
                        }}
                    })
                    .to_string()],
                )
                .unwrap();
                let metadata_id = conn.last_insert_rowid();
                conn.execute(
                    "UPDATE images SET metadata_id = ?1 WHERE id = ?2",
                    [metadata_id, web],
                )
                .unwrap();
            }

            let (updated, _, patches) = run(&storage, &[web]);

            assert_eq!(updated, 1);
            assert_eq!(
                palette_of(&storage, web),
                Some(Palette::single([0, 0, 255]).to_json())
            );
            assert_eq!(palette_of(&storage, outside), None, "不在 ids 里的不算");
            assert_eq!(
                patches.iter().map(|p| p.id.clone()).collect::<Vec<_>>(),
                vec![web.to_string()]
            );
        }

        /// 取消：一张都不算就返回，标记为已取消。
        #[test]
        fn cancel_stops_before_computing() {
            let dir = tempfile::tempdir().unwrap();
            let storage = storage();
            let red = solid_png(dir.path(), "red.png", [255, 0, 0]);
            let id = insert(&storage, &red, "image/png", None);
            let runtime = tokio::runtime::Runtime::new().unwrap();
            let mut patches = Vec::new();
            let result = recompute_palettes(
                runtime.handle(),
                &storage,
                &[id],
                &AtomicBool::new(true),
                &mut patches,
            )
            .unwrap();
            assert_eq!(result, (0, true));
            assert_eq!(palette_of(&storage, id), None);
        }
    }
}
