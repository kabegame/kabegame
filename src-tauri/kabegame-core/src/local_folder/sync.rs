use crate::crawler::downloader::compute_file_hash;
use crate::emitter::GlobalEmitter;
use crate::local_folder::create::build_entries_non_recursive;
use crate::local_folder::import::{import_local_file, CarryFromOld};
use crate::local_folder::scan::dir_mtime_unix_ms;
use crate::local_folder::scan_service::{
    scan_and_visit, FolderScanHook, ScanCtx, ScanError, ScanOptions, ScannedDir, ScannedFile,
};
use crate::local_folder::status::{now_millis, FolderStatus};
use crate::storage::image_events::delete_images_with_events;
use crate::storage::Storage;
use serde_json::json;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex, OnceLock};
use tokio::sync::Mutex as AsyncMutex;
use url::Url;

const NAME_SEPARATOR: &str = "-";

#[derive(Debug, Default, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncReport {
    pub album_id: String,
    pub status: Option<FolderStatus>,
    pub added: usize,
    pub deleted: usize,
    pub reimported: usize,
    pub skipped_in_flight: bool,
    pub skipped_unchanged: bool,
}

pub async fn sync_album(album_id: &str) -> Result<SyncReport, String> {
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
    sync_album_inner(album_id, ScanMode::Force).await
}

pub(crate) async fn sync_album_if_folder_changed(album_id: &str) -> Result<SyncReport, String> {
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
    sync_album_inner(album_id, ScanMode::SkipUnchangedFolder).await
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
        match sync_album_if_folder_changed(&album.id).await {
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
        out.push(sync_album(id).await);
    }
    out
}

/// 「立即同步(递归)」的汇总结果。
#[derive(Debug, Default, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecursiveSyncReport {
    pub album_id: String,
    /// 本次为新增子目录创建的画册数。
    pub created_albums: usize,
    /// 参与同步的画册数（含根与所有子画册）。
    pub synced_albums: usize,
    pub added: usize,
    pub deleted: usize,
    pub reimported: usize,
    /// 同步失败的子画册数（目录已删的旧子画册落 missing 状态计入）。
    pub failed: usize,
}

#[derive(Debug, Clone, Copy)]
pub struct RecursiveSyncOptions {
    pub create_missing_albums: bool,
}

impl Default for RecursiveSyncOptions {
    fn default() -> Self {
        Self {
            create_missing_albums: true,
        }
    }
}

// ───────────────────────── 同步钩子 ─────────────────────────

/// 同步用目录上下文：当前目录所归属的画册。
#[derive(Clone)]
struct SyncDirCtx {
    album_id: String,
    album_name: String,
}

/// 文件夹同步钩子：经 `scan_service` 驱动。
/// - `on_enter_dir`：递归时为新子目录建子画册 / 复用已存在子画册 / 剪枝禁区。
/// - `on_file`：按**路径**做新增/链接/重导入（复刻原 `diff` 语义）。
/// - `on_exit_dir`：收尾子画册（删除未见行 + 落 ok 状态）。
struct SyncHook {
    /// 规范化禁区根（VD / 下载目录），命中则剪枝整棵子树。
    forbidden_roots: Vec<PathBuf>,
    /// 已存在本地画册：canon 目录 -> (album_id, album_name)，用于复用/贯穿。
    existing: HashMap<PathBuf, (String, String)>,
    /// 每 album 的「待删除候选」= 同步开始时该 album 的图片 id 集；命中保留即移除，收尾删剩余。
    pending_delete: HashMap<String, HashSet<String>>,
    /// 本次涉及（已加载）的 album id，去重保序。
    visited: Vec<String>,
    created_albums: usize,
    added: usize,
    deleted: usize,
    reimported: usize,
    /// 收尾落 ok 状态用的时间戳。
    finalize_synced_at_ms: u64,
    /// 递归同步时是否为尚不存在的子目录创建本地文件夹画册。
    create_missing_albums: bool,
}

impl SyncHook {
    fn new(
        forbidden_roots: Vec<PathBuf>,
        existing: HashMap<PathBuf, (String, String)>,
        finalize_synced_at_ms: u64,
        options: RecursiveSyncOptions,
    ) -> Self {
        Self {
            forbidden_roots,
            existing,
            pending_delete: HashMap::new(),
            visited: Vec::new(),
            created_albums: 0,
            added: 0,
            deleted: 0,
            reimported: 0,
            finalize_synced_at_ms,
            create_missing_albums: options.create_missing_albums,
        }
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

    /// 单个媒体文件的入库逻辑（仅 file://）。
    async fn import_one(&mut self, file: &ScannedFile, album_id: &str) -> Result<(), String> {
        let Some(path) = file.path.as_deref() else {
            // 同步只走 file://；content:// 无 mtime/size，忽略。
            return Ok(());
        };
        // organize gate：整理进行中先等待其结束再入库，避免与去重 / 删除 / 重建缩略图并发竞态。
        // 在触碰 DB 前等待，避免持有任何数据库状态空等；醒来后下方按路径 + mtime + 哈希重新校验是否仍需导入。
        crate::storage::organize::OrganizeService::wait_until_idle().await;
        let path_str = path.to_string_lossy();
        let storage = Storage::global();

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
                    self.added += 1;
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
                            Some(mid) => storage.read_image_metadata_text(mid)?,
                            None => None,
                        };
                        delete_images_with_events(&[existing.id.clone()], false)?;
                        let metadata_id = match metadata_text {
                            Some(text) => Some(storage.insert_or_get_image_metadata_text(&text)?),
                            None => None,
                        };
                        let carry = CarryFromOld {
                            display_name: existing.display_name.clone(),
                            metadata_id,
                            order,
                        };
                        import_local_file(path, album_id, file.size.unwrap_or(0), Some(carry))
                            .await?;
                        self.reimported += 1;
                    }
                }
            }
            None => {
                import_local_file(path, album_id, file.size.unwrap_or(0), None).await?;
                self.added += 1;
            }
        }
        Ok(())
    }

    /// 收尾一个 album：移除未见旧图的画册关联 + 落 ok 状态。
    fn finalize_album(&mut self, album_id: &str, synced_at_ms: u64) -> Result<(), String> {
        if let Some(set) = self.pending_delete.remove(album_id) {
            if !set.is_empty() {
                let ids: Vec<String> = set.into_iter().collect();
                self.deleted += ids.len();
                Storage::global().remove_images_from_album(album_id, &ids)?;
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

        let ctx = if let Some((id, name)) = self.existing.get(&canon).cloned() {
            // 已存在子画册：复用并贯穿向下。
            SyncDirCtx {
                album_id: id,
                album_name: name,
            }
        } else {
            if !self.create_missing_albums {
                return Ok(None);
            }
            // 新子目录：在父画册下创建子画册。
            let name = format!("{}{}{}", parent.album_name, NAME_SEPARATOR, enter.name);
            let entry = build_entries_non_recursive(&name, dir_path, Some(&parent.album_id));
            Storage::global()
                .add_local_folder_albums_tx(std::slice::from_ref(&entry))
                .map_err(ScanError::Skip)?;
            self.created_albums += 1;
            self.existing
                .insert(canon, (entry.id.clone(), name.clone()));
            SyncDirCtx {
                album_id: entry.id,
                album_name: name,
            }
        };

        self.load_album(&ctx.album_id).map_err(ScanError::Skip)?;
        Ok(Some(ctx))
    }

    async fn on_exit_dir(&mut self, ctx: &ScanCtx<SyncDirCtx>) -> Result<(), ScanError> {
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
        self.import_one(file, album_id)
            .await
            .map_err(ScanError::Skip)
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ScanMode {
    Force,
    SkipUnchangedFolder,
}

async fn sync_album_inner(album_id: &str, scan_mode: ScanMode) -> Result<SyncReport, String> {
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
    let folder_mtime_ms = match dir_mtime_unix_ms(sync_path) {
        Ok(ms) => ms,
        Err(status) => {
            persist_status(album_id, &status);
            report.status = Some(status);
            return Ok(report);
        }
    };

    let previous_status = parse_folder_status(album.folder_status.as_deref());
    if scan_mode == ScanMode::SkipUnchangedFolder {
        if let Some(status) = unchanged_status(previous_status.as_ref(), folder_mtime_ms) {
            report.status = Some(status.clone());
            report.skipped_unchanged = true;
            return Ok(report);
        }
    }

    let root_url = Url::from_file_path(sync_path)
        .map_err(|_| format!("invalid sync_folder path: {sync_folder}"))?;

    // 非递归：仅扫本层文件；不建子画册。
    let mut hook = SyncHook::new(
        Vec::new(),
        HashMap::new(),
        scan_started_at_ms,
        RecursiveSyncOptions::default(),
    );
    hook.load_album(album_id)?;
    let root_ctx = SyncDirCtx {
        album_id: album_id.to_string(),
        album_name: album.name.clone(),
    };
    let options = ScanOptions {
        recursive: false,
        min_collect_interval_ms: Some(300),
        ..Default::default()
    };
    let scan_ctx = scan_and_visit(&[root_url.clone()], root_ctx, &options, &mut hook).await?;
    let root_had_errors = scan_ctx.dir_had_errors(&root_url);

    let last_synced_at_ms = scan_started_at_ms;
    if !root_had_errors {
        hook.finalize_album(album_id, last_synced_at_ms)?;
        report.status = Some(FolderStatus::ok_synced_at_ms(last_synced_at_ms));
    } else {
        report.status = previous_status;
    }

    report.added = hook.added;
    report.deleted = hook.deleted;
    report.reimported = hook.reimported;
    Ok(report)
}

/// 递归同步指定本地文件夹画册：遍历目录树，为新子目录建子画册（贯穿已存在子画册），
/// 整棵子树文件按路径入库/重导入，收尾删未见行。`forbidden_roots` 为规范化禁区（VD / 下载目录）。
pub async fn sync_album_recursive(
    album_id: &str,
    forbidden_roots: Vec<PathBuf>,
) -> Result<RecursiveSyncReport, String> {
    sync_album_recursive_with_options(album_id, forbidden_roots, RecursiveSyncOptions::default())
        .await
}

pub async fn sync_album_recursive_with_options(
    album_id: &str,
    forbidden_roots: Vec<PathBuf>,
    options: RecursiveSyncOptions,
) -> Result<RecursiveSyncReport, String> {
    let storage = Storage::global();
    let album = storage
        .get_album_by_id(album_id)?
        .ok_or_else(|| format!("album {album_id} not found"))?;
    if album.kind != "local_folder" {
        return Err(format!("album {album_id} is not a local_folder album"));
    }
    let root_folder = album
        .sync_folder
        .clone()
        .ok_or_else(|| format!("album {album_id} missing sync_folder"))?;
    let root_path = PathBuf::from(&root_folder);

    let mut report = RecursiveSyncReport {
        album_id: album.id.clone(),
        ..Default::default()
    };

    let run_started_ms = now_millis();
    if let Err(status) = dir_mtime_unix_ms(&root_path) {
        persist_status(&album.id, &status);
        return Ok(report);
    }

    // 已存在本地画册：canon 目录 -> (id, name)，用于复用/贯穿。
    let mut existing: HashMap<PathBuf, (String, String)> = HashMap::new();
    for a in storage.list_local_folder_albums()? {
        if let Some(folder) = a.sync_folder.as_deref() {
            let key = Path::new(folder)
                .canonicalize()
                .unwrap_or_else(|_| PathBuf::from(folder));
            existing.insert(key, (a.id, a.name));
        }
    }

    let root_url = Url::from_file_path(&root_path)
        .map_err(|_| format!("invalid sync_folder path: {root_folder}"))?;

    let mut hook = SyncHook::new(forbidden_roots, existing, run_started_ms, options);
    hook.load_album(&album.id)?;
    let root_ctx = SyncDirCtx {
        album_id: album.id.clone(),
        album_name: album.name.clone(),
    };
    let options = ScanOptions {
        recursive: true,
        min_collect_interval_ms: Some(300),
        skip_hidden_dirs: true,
        ..Default::default()
    };
    let scan_ctx = scan_and_visit(&[root_url.clone()], root_ctx, &options, &mut hook).await?;

    // 根画册不经 on_exit_dir，显式收尾。
    if !scan_ctx.dir_had_errors(&root_url) {
        hook.finalize_album(&album.id, run_started_ms)?;
    }

    report.created_albums = hook.created_albums;
    report.added = hook.added;
    report.deleted = hook.deleted;
    report.reimported = hook.reimported;

    // 子树中本次未访问到的画册（其目录已被删）→ 落 missing 状态（图片保留，交由用户处理）。
    let visited: HashSet<String> = hook.visited.iter().cloned().collect();
    report.synced_albums = visited.len();
    for id in storage.list_subtree_album_ids(&album.id)? {
        if !visited.contains(&id) {
            persist_status(&id, &FolderStatus::now_missing());
            report.failed += 1;
        }
    }

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
