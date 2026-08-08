use crate::crawler::downloader::compute_file_hash;
use crate::emitter::GlobalEmitter;
use crate::local_folder::create::build_entries_non_recursive;
use crate::local_folder::import::{import_local_file, CarryFromOld};
use crate::local_folder::run_state::FolderSyncService;
use crate::local_folder::scan::dir_mtime_unix_ms;
use crate::local_folder::scan_service::{
    scan_and_visit, FolderScanHook, ScanCtx, ScanError, ScanOptions, ScannedDir, ScannedFile,
};
use crate::local_folder::status::{now_millis, FolderStatus};
use crate::local_folder::SyncMode;
use crate::settings::Settings;
use crate::storage::image_events::delete_images_with_events;
use crate::storage::{Album, Storage};
#[cfg(all(feature = "virtual-driver", target_os = "windows"))]
use crate::virtual_driver::driver_service::VirtualDriveServiceTrait;
#[cfg(all(feature = "virtual-driver", not(target_os = "android")))]
use crate::virtual_driver::VirtualDriveService;
use serde_json::json;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex as StdMutex, OnceLock,
};
use std::time::Duration;
use tokio::sync::Mutex as AsyncMutex;
use url::Url;

const CANCEL_MARKER: &str = "__folder_sync_canceled__";

/// 同步的逐文件节流间隔：**只在真正写了库之后**才等这一手（新增 / 链接进画册 / 重导入）。
/// 已入库且本次什么都没做的文件全速掠过——否则一个几万张图的老目录，光空转就要几十分钟。
const SYNC_WRITE_THROTTLE_MS: u64 = 100;

/// 同一画册已有同步在飞时的补偿重试次数。
const IN_FLIGHT_RETRY_LIMIT: usize = 3;
/// 补偿重试间隔；只处理 `skipped_in_flight`，普通同步错误不重试。
const IN_FLIGHT_RETRY_DELAY_MS: u64 = 500;

#[derive(Debug, Default, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncReport {
    pub album_id: String,
    pub status: Option<FolderStatus>,
    pub added: usize,
    pub deleted: usize,
    pub reimported: usize,
    pub created_albums: usize,
    pub synced_albums: usize,
    pub failed: usize,
    pub skipped_in_flight: bool,
    pub skipped_unchanged: bool,
    pub skipped_unchanged_dirs: usize,
    pub canceled: bool,
}

#[derive(Debug, Clone)]
pub struct SyncAlbumOptions {
    pub recursive: bool,
    pub create_missing_albums: bool,
    pub forbidden_roots: Vec<PathBuf>,
}

impl Default for SyncAlbumOptions {
    fn default() -> Self {
        Self {
            recursive: false,
            create_missing_albums: true,
            forbidden_roots: Vec::new(),
        }
    }
}

/// 递归同步/创建时需要刻意避开的「禁区根」（规范化）：仅 VD 挂载点。
pub(crate) fn local_folder_forbidden_roots() -> Vec<PathBuf> {
    #[cfg(all(feature = "virtual-driver", not(target_os = "android")))]
    {
        return VirtualDriveService::global()
            .current_mount_point()
            .map(|mount_point| {
                let path = Path::new(&mount_point);
                path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
            })
            .into_iter()
            .collect();
    }
    #[cfg(not(all(feature = "virtual-driver", not(target_os = "android"))))]
    {
        Vec::new()
    }
}

/// 将同步模式映射为统一的同步选项；`none` 不触发同步。
pub(crate) fn sync_options_for_mode(mode: SyncMode) -> Option<SyncAlbumOptions> {
    match mode {
        SyncMode::None => None,
        SyncMode::Shallow => Some(SyncAlbumOptions {
            recursive: false,
            create_missing_albums: false,
            forbidden_roots: Vec::new(),
        }),
        SyncMode::Recursive | SyncMode::Delegated => Some(SyncAlbumOptions {
            recursive: true,
            create_missing_albums: true,
            forbidden_roots: local_folder_forbidden_roots(),
        }),
    }
}

/// 按同步模式执行，并补偿「已有同画册同步在飞」造成的跳过。
pub(crate) async fn sync_album_for_mode_with_retry(
    album_id: &str,
    mode: SyncMode,
) -> Result<Option<SyncReport>, String> {
    let Some(options) = sync_options_for_mode(mode) else {
        return Ok(None);
    };

    // 在飞的同步可能已在新文件落地前列完目录；若不补偿，本次变更可能永久漏掉。
    for attempt in 0..=IN_FLIGHT_RETRY_LIMIT {
        let report = sync_album(album_id, options.clone()).await?;
        if !report.skipped_in_flight {
            return Ok(Some(report));
        }

        if attempt == IN_FLIGHT_RETRY_LIMIT {
            eprintln!(
                "[local_folder] sync_album {album_id} still in flight after {IN_FLIGHT_RETRY_LIMIT} retries"
            );
            return Ok(Some(report));
        }

        tokio::time::sleep(Duration::from_millis(IN_FLIGHT_RETRY_DELAY_MS)).await;
    }

    unreachable!("in-flight retry loop always returns")
}

pub async fn sync_all_local_folder_albums() -> Vec<SyncReport> {
    let albums = match Storage::global().list_local_folder_albums() {
        Ok(albums) => albums,
        Err(err) => {
            eprintln!("[local_folder] list_local_folder_albums failed: {err}");
            return Vec::new();
        }
    };

    let mut reports = Vec::with_capacity(albums.len());
    for album in albums {
        let Some(mode) = SyncMode::from_str(&album.sync_mode) else {
            eprintln!(
                "[local_folder] skip album {} with invalid sync_mode {}",
                album.id, album.sync_mode
            );
            continue;
        };
        if matches!(mode, SyncMode::Delegated | SyncMode::None) {
            continue;
        }
        let Some(options) = sync_options_for_mode(mode) else {
            continue;
        };
        match sync_album(&album.id, options).await {
            Ok(report) => reports.push(report),
            Err(err) => {
                eprintln!("[local_folder] sync_album {} failed: {err}", album.id);
            }
        }
    }
    reports
}

pub async fn sync_albums_by_ids(ids: &[String]) -> Vec<Result<SyncReport, String>> {
    let mut out = Vec::with_capacity(ids.len());
    for id in ids {
        out.push(sync_album(id, SyncAlbumOptions::default()).await);
    }
    out
}

// ───────────────────────── 同步钩子 ─────────────────────────

/// 同步用目录上下文：当前目录所归属的画册。
#[derive(Clone)]
struct SyncDirCtx {
    album_id: String,
    skip_files: bool,
}

/// 文件夹同步钩子：经 `scan_service` 驱动。
/// - `on_enter_dir`：递归时为新子目录建子画册 / 复用已存在子画册 / 剪枝禁区。
/// - `on_file`：按**路径**做新增/链接/重导入（复刻原 `diff` 语义）。
/// - `on_exit_dir`：收尾子画册（删除未见行 + 落 ok 状态）。
struct SyncHook {
    /// 进度事件以根画册 id 为任务 key，递归子画册的计数都汇总到这里。
    run_album_id: String,
    cancel: Arc<AtomicBool>,
    /// 规范化禁区根（VD / 下载目录），命中则剪枝整棵子树。
    forbidden_roots: Vec<PathBuf>,
    /// 已存在本地画册：canon 目录 -> album，用于复用/贯穿和读取上次同步状态。
    existing: HashMap<PathBuf, Album>,
    /// 每 album 的「待删除候选」= 同步开始时该 album 的图片 id 集；命中保留即移除，收尾删剩余。
    pending_delete: HashMap<String, HashSet<String>>,
    /// 本次确认目录仍存在的 album id，去重保序；跳过扫描的目录也必须在内。
    visited: Vec<String>,
    created_albums: usize,
    added: usize,
    deleted: usize,
    reimported: usize,
    skipped_dirs: usize,
    /// 收尾落 ok 状态用的时间戳。
    finalize_synced_at_ms: u64,
    /// 递归同步时是否为尚不存在的子目录创建本地文件夹画册。
    create_missing_albums: bool,
    /// 本次同步开始时读取的快速同步设置快照。
    fast_folder_sync: bool,
}

impl SyncHook {
    fn new(
        run_album_id: String,
        cancel: Arc<AtomicBool>,
        forbidden_roots: Vec<PathBuf>,
        existing: HashMap<PathBuf, Album>,
        finalize_synced_at_ms: u64,
        create_missing_albums: bool,
        fast_folder_sync: bool,
    ) -> Self {
        Self {
            run_album_id,
            cancel,
            forbidden_roots,
            existing,
            pending_delete: HashMap::new(),
            visited: Vec::new(),
            created_albums: 0,
            added: 0,
            deleted: 0,
            reimported: 0,
            skipped_dirs: 0,
            finalize_synced_at_ms,
            create_missing_albums,
            fast_folder_sync,
        }
    }

    fn record_added(&mut self) {
        self.added += 1;
        FolderSyncService::global().update(&self.run_album_id, |state| state.added += 1);
    }

    fn record_deleted(&mut self, count: usize) {
        self.deleted += count;
        FolderSyncService::global().update(&self.run_album_id, |state| state.deleted += count);
    }

    fn record_reimported(&mut self) {
        self.reimported += 1;
        FolderSyncService::global().update(&self.run_album_id, |state| state.reimported += 1);
    }

    fn record_created_album(&mut self) {
        self.created_albums += 1;
        FolderSyncService::global().update(&self.run_album_id, |state| state.created_albums += 1);
    }

    /// 懒加载某 album 的当前图片 id 集（作为待删除候选基线）。
    fn load_album(&mut self, album_id: &str) -> Result<(), String> {
        if self.pending_delete.contains_key(album_id) {
            return Ok(());
        }
        let ids: HashSet<String> = Storage::global()
            .list_album_image_ids_for_sync(album_id)?
            .into_iter()
            .collect();
        self.pending_delete.insert(album_id.to_string(), ids);
        self.visited.push(album_id.to_string());
        Ok(())
    }

    /// 标记目录仍存在但跳过本层文件扫描，并只刷新 checked_at。
    fn mark_visited(&mut self, album_id: &str, last_synced_at_ms: u64) {
        if self.visited.iter().any(|id| id == album_id) {
            return;
        }
        self.skipped_dirs += 1;
        self.visited.push(album_id.to_string());
        persist_status(album_id, &FolderStatus::ok_synced_at_ms(last_synced_at_ms));
    }

    /// 快速同步开启且目录 mtime 未越过上次真扫描时刻时，返回旧时间戳。
    fn should_skip_dir(&self, dir: &Path, folder_status: Option<&str>) -> Option<u64> {
        if !self.fast_folder_sync {
            return None;
        }
        let status = parse_folder_status(folder_status);
        let folder_mtime_ms = dir_mtime_unix_ms(dir).ok()?;
        unchanged_status(status.as_ref(), folder_mtime_ms).and_then(FolderStatus::last_synced_at_ms)
    }

    /// 单个媒体文件的入库逻辑（仅 file://）。
    /// 返回是否**真的写了库**（新增 / 链接进画册 / 重导入），供调用方决定要不要节流。
    async fn import_one(&mut self, file: &ScannedFile, album_id: &str) -> Result<bool, String> {
        let Some(path) = file.path.as_deref() else {
            // 同步只走 file://；content:// 无 mtime/size，忽略。
            return Ok(false);
        };
        let path_str = path.to_string_lossy();
        let storage = Storage::global();

        // 本次是否落了写操作；决定调用方要不要节流。
        let mut wrote = false;

        match Storage::find_image_by_path(&path_str)? {
            Some(existing) => {
                // 链接进本画册（已在则 linked==0，不计 added）。
                let linked = storage.add_images_to_album_silent(album_id, &[existing.id.clone()]);
                if linked > 0 {
                    GlobalEmitter::global().emit_album_images_change(
                        "add",
                        &[album_id.to_string()],
                        &[existing.id.clone()],
                    );
                    self.record_added();
                    wrote = true;
                }
                // 保留：从待删除候选中移除。
                if let Some(set) = self.pending_delete.get_mut(album_id) {
                    set.remove(&existing.id);
                }
                // 新旧比对：文件比库内记录新且内容已变化 → 先删旧行（释放路径）再重导入。
                let mtime = file.mtime_unix_ms.unwrap_or(0);
                if mtime > (existing.crawled_at as u128) * 1000 + 1000 {
                    let new_hash = compute_file_hash(path).await?;
                    if new_hash != existing.hash {
                        let order = Storage::get_album_image_order(album_id, &existing.id)?;
                        // 唯一约束要求先删旧行再插新行；删除可能 GC 掉这条 metadata
                        // （仅当它只被这张旧图引用时）。故先把内容读出来，删除后再写入：
                        // 内容仍在 → 拿回原 id；已被 GC → 得新 id（无人引用，id 变了也无妨）。
                        let metadata_text = match existing.metadata_id {
                            Some(mid) => storage.read_metadata_text(mid)?,
                            None => None,
                        };
                        delete_images_with_events(&[existing.id.clone()], false).await?;
                        let metadata_id = match metadata_text {
                            Some(text) => Some(storage.insert_metadata_text(&text)?),
                            None => None,
                        };
                        let carry = CarryFromOld {
                            display_name: existing.display_name.clone(),
                            metadata_id,
                            order,
                        };
                        import_local_file(
                            path,
                            Some(album_id),
                            file.size.unwrap_or(0),
                            Some(carry),
                        )
                        .await?;
                        self.record_reimported();
                        wrote = true;
                    }
                }
            }
            None => {
                import_local_file(path, Some(album_id), file.size.unwrap_or(0), None).await?;
                self.record_added();
                wrote = true;
            }
        }
        Ok(wrote)
    }

    /// 收尾一个 album：移除未见旧图的画册关联 + 落 ok 状态。
    fn finalize_album(&mut self, album_id: &str, synced_at_ms: u64) -> Result<(), String> {
        if let Some(set) = self.pending_delete.remove(album_id) {
            if !set.is_empty() {
                let ids: Vec<String> = set.into_iter().collect();
                Storage::global().remove_images_from_album(album_id, &ids)?;
                self.record_deleted(ids.len());
                GlobalEmitter::global().emit_album_images_change(
                    "delete",
                    &[album_id.to_string()],
                    &ids,
                );
            }
        }
        let ok = FolderStatus::ok_synced_at_ms(synced_at_ms);
        persist_status(album_id, &ok);
        Ok(())
    }
}

#[async_trait::async_trait]
impl FolderScanHook for SyncHook {
    type DirCtx = SyncDirCtx;

    async fn on_enter_dir(
        &mut self,
        enter: &ScannedDir,
        ctx: &ScanCtx<SyncDirCtx>,
    ) -> Result<Option<SyncDirCtx>, ScanError> {
        if self.cancel.load(Ordering::Relaxed) {
            return Err(ScanError::Fatal(CANCEL_MARKER.to_string()));
        }
        let parent = ctx.ctx();
        let Some(dir_path) = enter.path.as_deref() else {
            return Ok(None); // 同步只处理 file:// 目录
        };
        let canon = dir_path
            .canonicalize()
            .unwrap_or_else(|_| dir_path.to_path_buf());

        // 禁区（VD / 下载目录）：剪枝整棵子树。
        if self
            .forbidden_roots
            .iter()
            .any(|root| canon == *root || canon.starts_with(root))
        {
            return Ok(None);
        }

        let skip_since;
        let ctx = if let Some(found) = self.existing.get(&canon).cloned() {
            // 已存在子画册：快速同步命中时跳过本层文件，但仍贯穿子树。
            skip_since = self.should_skip_dir(dir_path, found.folder_status.as_deref());
            SyncDirCtx {
                album_id: found.id,
                skip_files: skip_since.is_some(),
            }
        } else {
            if !self.create_missing_albums {
                return Ok(None);
            }
            // 新子目录：在父画册下创建子画册。
            let mut name = enter.name.clone();
            let storage = Storage::global();
            if storage
                .find_child_album_by_name_ci(Some(&parent.album_id), &name)
                .map_err(ScanError::Skip)?
                .is_some()
            {
                let conn = storage
                    .db
                    .lock()
                    .map_err(|e| ScanError::Skip(format!("Lock error: {e}")))?;
                name = Storage::resolve_scoped_name_ci(&conn, Some(&parent.album_id), &name, None)
                    .map_err(ScanError::Skip)?;
            }
            let mut entry = build_entries_non_recursive(&name, dir_path, Some(&parent.album_id));
            entry.sync_mode = SyncMode::None;
            let created = storage
                .add_local_folder_albums_tx(std::slice::from_ref(&entry))
                .map_err(ScanError::Skip)?
                .into_iter()
                .next()
                .ok_or_else(|| {
                    ScanError::Skip("add_local_folder_albums_tx returned empty".to_string())
                })?;
            self.record_created_album();
            let ctx = SyncDirCtx {
                album_id: created.id.clone(),
                skip_files: false,
            };
            self.existing.insert(canon, created);
            skip_since = None;
            ctx
        };

        if let Some(last_synced_at_ms) = skip_since {
            self.mark_visited(&ctx.album_id, last_synced_at_ms);
        } else {
            self.load_album(&ctx.album_id).map_err(ScanError::Skip)?;
        }
        Ok(Some(ctx))
    }

    async fn on_exit_dir(&mut self, ctx: &ScanCtx<SyncDirCtx>) -> Result<(), ScanError> {
        if ctx.ctx().skip_files {
            return Ok(());
        }
        if ctx.current_had_errors() {
            return Ok(());
        }
        let ts = self.finalize_synced_at_ms;
        self.finalize_album(&ctx.ctx().album_id, ts)
            .map_err(ScanError::Skip)
    }

    async fn on_file(
        &mut self,
        file: &ScannedFile,
        ctx: &ScanCtx<SyncDirCtx>,
    ) -> Result<(), ScanError> {
        if self.cancel.load(Ordering::Relaxed) {
            return Err(ScanError::Fatal(CANCEL_MARKER.to_string()));
        }
        if ctx.ctx().skip_files {
            return Ok(());
        }
        let album_id = &ctx.ctx().album_id;
        match Storage::global().album_exists(album_id) {
            Ok(true) => {}
            Ok(false) => {
                return Err(ScanError::Interrupt(format!(
                    "album {album_id} deleted during sync"
                )));
            }
            Err(err) => return Err(ScanError::Skip(err)),
        }
        let wrote = self
            .import_one(file, album_id)
            .await
            .map_err(ScanError::Skip)?;
        // 节流放在这里而不是 scan_service 的通用 min_collect_interval：
        // 后者对每个媒体文件都等，已入库、本次无改动的文件也要陪跑。
        if wrote {
            tokio::time::sleep(Duration::from_millis(SYNC_WRITE_THROTTLE_MS)).await;
        }
        Ok(())
    }
}

// ───────────────────────── 编排 ─────────────────────────

fn album_locks() -> &'static StdMutex<HashMap<String, Arc<AsyncMutex<()>>>> {
    static LOCKS: OnceLock<StdMutex<HashMap<String, Arc<AsyncMutex<()>>>>> = OnceLock::new();
    LOCKS.get_or_init(|| StdMutex::new(HashMap::new()))
}

fn lock_for(album_id: &str) -> Arc<AsyncMutex<()>> {
    let mut map = album_locks().lock().expect("album_locks poisoned");
    map.entry(album_id.to_string())
        .or_insert_with(|| Arc::new(AsyncMutex::new(())))
        .clone()
}

/// 同步指定本地文件夹画册。递归与非递归共用同一入口和报告结构。
pub async fn sync_album(album_id: &str, options: SyncAlbumOptions) -> Result<SyncReport, String> {
    let lock = lock_for(album_id);
    let _guard = match lock.try_lock() {
        Ok(guard) => guard,
        Err(_) => {
            eprintln!("[local_folder] sync_album {album_id} skipped: already in flight");
            return Ok(SyncReport {
                album_id: album_id.to_string(),
                skipped_in_flight: true,
                ..Default::default()
            });
        }
    };
    let SyncAlbumOptions {
        recursive,
        create_missing_albums,
        forbidden_roots,
    } = options;

    let mut report = SyncReport {
        album_id: album_id.to_string(),
        ..Default::default()
    };

    let storage = Storage::global();
    let album = storage
        .get_album_by_id(album_id)?
        .ok_or_else(|| format!("album {album_id} not found"))?;

    if album.kind != "local_folder" {
        return Err(format!("album {album_id} is not a local_folder album"));
    }
    let sync_folder = album
        .sync_folder
        .as_deref()
        .ok_or_else(|| format!("album {album_id} missing sync_folder"))?;
    let sync_path = Path::new(sync_folder);

    let scan_started_at_ms = now_millis();
    let root_mtime_ms = match dir_mtime_unix_ms(sync_path) {
        Ok(ms) => ms,
        Err(status) => {
            persist_status(album_id, &status);
            report.status = Some(status);
            return Ok(report);
        }
    };

    let previous_status = parse_folder_status(album.folder_status.as_deref());
    let fast_folder_sync = Settings::global().get_fast_folder_sync();
    let root_skip_since = if fast_folder_sync {
        unchanged_status(previous_status.as_ref(), root_mtime_ms)
            .and_then(FolderStatus::last_synced_at_ms)
    } else {
        None
    };

    if let Some(last_synced_at_ms) = root_skip_since {
        if !recursive {
            let touched = FolderStatus::ok_synced_at_ms(last_synced_at_ms);
            persist_status(album_id, &touched);
            report.status = Some(touched);
            report.skipped_unchanged = true;
            return Ok(report);
        }
    }

    let run_guard =
        FolderSyncService::global().begin(album.id.clone(), album.name.clone(), recursive);
    let cancel = run_guard.cancel_flag();
    let root_url = Url::from_file_path(sync_path)
        .map_err(|_| format!("invalid sync_folder path: {sync_folder}"))?;

    let existing = if recursive {
        let mut map = HashMap::new();
        for existing_album in storage.list_local_folder_albums()? {
            if let Some(folder) = existing_album.sync_folder.as_deref() {
                let key = Path::new(folder)
                    .canonicalize()
                    .unwrap_or_else(|_| PathBuf::from(folder));
                map.insert(key, existing_album);
            }
        }
        map
    } else {
        HashMap::new()
    };

    let mut hook = SyncHook::new(
        album.id.clone(),
        cancel,
        forbidden_roots,
        existing,
        scan_started_at_ms,
        create_missing_albums,
        fast_folder_sync,
    );
    if let Some(last_synced_at_ms) = root_skip_since {
        hook.mark_visited(album_id, last_synced_at_ms);
    } else {
        hook.load_album(album_id)?;
    }
    let root_ctx = SyncDirCtx {
        album_id: album_id.to_string(),
        skip_files: root_skip_since.is_some(),
    };
    // 不用通用 min_collect_interval：同步自己在 on_file 里按「是否写了库」节流。
    let scan_options = ScanOptions {
        recursive,
        skip_hidden_dirs: recursive,
        ..Default::default()
    };
    let scan_ctx =
        match scan_and_visit(&[root_url.clone()], root_ctx, &scan_options, &mut hook).await {
            Ok(scan_ctx) => scan_ctx,
            Err(err) if err == CANCEL_MARKER => {
                report.status = previous_status;
                report.created_albums = hook.created_albums;
                report.synced_albums = hook.visited.len();
                report.added = hook.added;
                report.deleted = hook.deleted;
                report.reimported = hook.reimported;
                report.skipped_unchanged_dirs = hook.skipped_dirs;
                report.canceled = true;
                run_guard.finish_canceled();
                return Ok(report);
            }
            Err(err) => return Err(err),
        };

    // 根画册不经 on_exit_dir，显式收尾；快速同步跳过时保留旧真扫描时间戳。
    if root_skip_since.is_none() {
        if !scan_ctx.dir_had_errors(&root_url) {
            hook.finalize_album(album_id, scan_started_at_ms)?;
            report.status = Some(FolderStatus::ok_synced_at_ms(scan_started_at_ms));
        } else {
            report.status = previous_status;
        }
    }

    if recursive {
        // 子树中本次未访问到的画册（其目录已被删）→ 落 missing 状态。
        let visited: HashSet<String> = hook.visited.iter().cloned().collect();
        report.synced_albums = visited.len();
        for id in storage.list_subtree_album_ids(album_id)? {
            if !visited.contains(&id) {
                if matches!(
                    storage.get_album_by_id(&id)?,
                    Some(album) if album.kind == "local_folder"
                ) {
                    persist_status(&id, &FolderStatus::now_missing());
                    report.failed += 1;
                }
            }
        }
        if hook.created_albums > 0 {
            let _ = storage.rechain_local_folder_albums();
        }
    }

    report.created_albums = hook.created_albums;
    report.added = hook.added;
    report.deleted = hook.deleted;
    report.reimported = hook.reimported;
    report.skipped_unchanged_dirs = hook.skipped_dirs;
    run_guard.finish(None);
    Ok(report)
}

fn parse_folder_status(raw: Option<&str>) -> Option<FolderStatus> {
    serde_json::from_str(raw?).ok()
}

fn unchanged_status(status: Option<&FolderStatus>, folder_mtime_ms: u64) -> Option<&FolderStatus> {
    let status = status?;
    let last_synced_at_ms = status.last_synced_at_ms()?;
    if folder_mtime_ms <= last_synced_at_ms {
        Some(status)
    } else {
        None
    }
}

fn persist_status(album_id: &str, status: &FolderStatus) {
    let status_json = status.to_json();
    if let Err(err) = Storage::global().update_album_folder_status(album_id, Some(&status_json)) {
        eprintln!("[local_folder] persist status for {album_id} failed: {err}");
    }
    GlobalEmitter::global().emit_album_changed(
        album_id,
        json!({
            "folderStatus": status_json,
        }),
    );
}
