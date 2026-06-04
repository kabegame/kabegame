# Phase 2 — 同步算法核心（纯 Rust，无 IPC，无 UI）

> 隶属：[local-folder-album-sync.md](./local-folder-album-sync.md)
> 前置：Phase 1 已完成（DB schema 已扩展、Album 结构已带 kind/sync_folder/folder_status）。
> 范围：在 `kabegame-core` 中新建 `local_folder/` 模块，**只**提供 `sync_album(album_id) -> Result<SyncReport, String>` 入口；不暴露任何 Tauri 命令、不修改前端、不接入启动期。

参考：
- [src-tauri/kabegame-core/src/crawler/local_import.rs](../../src-tauri/kabegame-core/src/crawler/local_import.rs) — 本地导入的现有 task 化路径，本 Phase 不复用其入口但参考其 `import_file_url`（lines 200–276）做最小化无 task 写入。
- [src-tauri/kabegame-core/src/crawler/downloader/mod.rs](../../src-tauri/kabegame-core/src/crawler/downloader/mod.rs) — `compute_file_hash`（line 213，pub）、`generate_thumbnail`（line 2528，pub）、`process_downloaded_image_to_storage`（line 2243）作为参考。
- [test/native-auto-import/src/main.rs](../../test/native-auto-import/src/main.rs) — `Candidate::from_path` + stable_for（lines 565–599）。

---

## 关键设计决策（已在用户答复中确认）

1. **不复制文件**：sync 是磁盘的"镜像视图"。`images.local_path` 直接写**用户原始路径**的绝对路径；不复制到 `images_dir`。
2. **不复用 task 化路径**：`crawler::local_import::run_builtin_local_import` 必须传 `task_id`，发 task 事件，进 DownloadQueue。Phase 2 不接入，直接拼装 `ImageInfo` 走 `Storage::add_image`。
3. **绕过 dedup-by-hash**：`postprocess_downloaded_image` 在 `auto_deduplicate=true` 时会按 hash 复用现有 image 行；这会让"watched 文件夹有新文件，但 DB 中已有同 hash 的别处图片"的场景跳过插入，导致后续每次 sync 都把它当 fs-only → 死循环新增。所以走自定义直插路径。
4. **`plugin_id = "local-import"`**，**`task_id = None`**，**`url = None`**（本地源没有远程 URL）。
5. **新图片 `display_name = 文件名`**（`path.file_name()`）；**重新导入**沿用旧行的 `display_name` 与 `metadata_id`（不会丢失用户编辑过的元数据/重命名）。
6. **稳定窗口**：参考 probe，仅过滤 mtime 距 now < 3000ms 的"仍在写入"文件，本轮跳过即可（下次 sync 自然纳入）。
7. **删除走 hard-delete**：`delete_images_with_events(&ids, true)`（清缩略图与文件——但 sync 来源的图片 local_path 在用户目录，`delete_files=true` 会去删用户文件吗？需要核查 `batch_delete_images` 行为，见步骤 7）。

---

## 模块布局

```
src-tauri/kabegame-core/src/local_folder/
  mod.rs        // re-export: sync_album, SyncReport, FolderStatus
  status.rs     // FolderStatus 枚举 + JSON 序列化
  scan.rs       // scan_dir: 非递归过滤扫描，返回 Vec<LocalFile> 或 FolderStatus
  diff.rs       // diff(fs, db) -> Plan { adds, deletes, reimports }
  import.rs     // import_local_file: 无 task 的 add_image + events
  sync.rs       // sync_album: 串起 scan/diff/import/delete
```

加 `pub mod local_folder;` 到 [src-tauri/kabegame-core/src/lib.rs](../../src-tauri/kabegame-core/src/lib.rs)。

---

## 步骤

### 1. `status.rs` — FolderStatus

```rust
use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum FolderStatus {
    Ok { checked_at: u64 },
    Missing { checked_at: u64 },
    Denied { checked_at: u64, message: String },
    NotADir { checked_at: u64 },
    IoError { checked_at: u64, message: String },
}

impl FolderStatus {
    pub fn now_ok() -> Self {
        Self::Ok { checked_at: now_secs() }
    }
    pub fn now_missing() -> Self {
        Self::Missing { checked_at: now_secs() }
    }
    pub fn now_denied(message: impl Into<String>) -> Self {
        Self::Denied { checked_at: now_secs(), message: message.into() }
    }
    pub fn now_not_a_dir() -> Self {
        Self::NotADir { checked_at: now_secs() }
    }
    pub fn now_io_error(message: impl Into<String>) -> Self {
        Self::IoError { checked_at: now_secs(), message: message.into() }
    }
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| "{}".to_string())
    }
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}
```

JSON 形如 `{"state":"ok","checked_at":1716387200}`，与 Phase 1 前端 `FolderStatus` 接口对齐。

### 2. `scan.rs` — 非递归扫描

```rust
use crate::image_type::is_media_by_path;
use crate::local_folder::status::FolderStatus;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const STABLE_FOR_MS: u128 = 3000;

#[derive(Debug, Clone)]
pub struct LocalFile {
    pub path: PathBuf,
    pub size: u64,
    pub mtime_unix_ms: u128,
}

pub struct ScanResult {
    pub files: Vec<LocalFile>,
    /// 因 stable_for 跳过的文件数；用于报告，便于排查"刚拷进来还没出现"。
    pub skipped_unstable: usize,
    pub skipped_missing: usize,
}

pub fn scan_dir(dir: &Path) -> Result<ScanResult, FolderStatus> {
    let meta = fs::metadata(dir).map_err(map_io_error)?;
    if !meta.is_dir() {
        return Err(FolderStatus::now_not_a_dir());
    }

    let read = fs::read_dir(dir).map_err(map_io_error)?;
    let mut files = Vec::new();
    let mut skipped_unstable = 0;
    let mut skipped_missing = 0;
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();

    for entry in read {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let path = entry.path();
        let ft = match entry.file_type() {
            Ok(ft) => ft,
            Err(_) => continue,
        };
        if !ft.is_file() {
            continue;
        }
        if !is_media_by_path(&path) {
            continue;
        }
        let m = match fs::metadata(&path) {
            Ok(m) => m,
            Err(err) if err.kind() == io::ErrorKind::NotFound => {
                skipped_missing += 1;
                continue;
            }
            Err(_) => continue,
        };
        let modified = m.modified().unwrap_or_else(|_| SystemTime::UNIX_EPOCH);
        let mtime_ms = modified
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        if now_ms.saturating_sub(mtime_ms) < STABLE_FOR_MS {
            skipped_unstable += 1;
            continue;
        }
        files.push(LocalFile {
            path,
            size: m.len(),
            mtime_unix_ms: mtime_ms,
        });
    }

    Ok(ScanResult { files, skipped_unstable, skipped_missing })
}

fn map_io_error(err: io::Error) -> FolderStatus {
    match err.kind() {
        io::ErrorKind::NotFound => FolderStatus::now_missing(),
        io::ErrorKind::PermissionDenied => FolderStatus::now_denied(err.to_string()),
        _ => {
            // macOS EPERM (1) 等价权限拒绝（系统受保护目录）
            #[cfg(target_os = "macos")]
            if err.raw_os_error() == Some(1) {
                return FolderStatus::now_denied(err.to_string());
            }
            FolderStatus::now_io_error(err.to_string())
        }
    }
}
```

**Hints**：
- `is_media_by_path` 是 `kabegame_core::image_type` 的合并函数（image + video），符合 CLAUDE.md "image_type 单一源"。
- `is_media_by_path` 不存在则用 `is_image_by_path(p) || is_video_by_path(p)`（看 [image_type.rs:358](../../src-tauri/kabegame-core/src/image_type.rs)）。

### 3. `diff.rs` — 三方差异

```rust
use crate::local_folder::scan::LocalFile;
use std::collections::HashMap;
use std::path::PathBuf;

/// 来自 DB 的、当前 album_images 里的一行；按 `local_path` 索引。
#[derive(Debug, Clone)]
pub struct DbImageRow {
    pub image_id: String,
    pub local_path: String,
    pub size: Option<u64>,
    pub crawled_at: u64,        // 秒
    pub hash: String,
    pub metadata_id: Option<i64>,
    pub display_name: String,
}

#[derive(Debug)]
pub struct Plan {
    /// fs-only：要新增
    pub adds: Vec<LocalFile>,
    /// db-only：要硬删除（包括文件本体，因为 sync 视角中这些图片就是磁盘文件的镜像）
    pub deletes: Vec<String>,
    /// 同路径但 mtime 后于入库时间 + 1s；待计算 hash 二次判定
    pub maybe_reimports: Vec<MaybeReimport>,
}

#[derive(Debug, Clone)]
pub struct MaybeReimport {
    pub fs: LocalFile,
    pub db: DbImageRow,
}

pub fn diff(fs_files: &[LocalFile], db_rows: &[DbImageRow]) -> Plan {
    let mut db_by_path: HashMap<PathBuf, DbImageRow> = db_rows
        .iter()
        .map(|r| (PathBuf::from(&r.local_path), r.clone()))
        .collect();

    let mut adds = Vec::new();
    let mut maybe_reimports = Vec::new();

    for f in fs_files {
        if let Some(db_row) = db_by_path.remove(&f.path) {
            // 入库时间秒 → 毫秒；+1000ms 抖动余量；mtime > crawled+1s 才认为可能改过
            if f.mtime_unix_ms > (db_row.crawled_at as u128) * 1000 + 1000 {
                maybe_reimports.push(MaybeReimport { fs: f.clone(), db: db_row });
            }
            // 否则视为未变更，跳过
        } else {
            adds.push(f.clone());
        }
    }

    let deletes = db_by_path.into_values().map(|r| r.image_id).collect();

    Plan { adds, deletes, maybe_reimports }
}
```

### 4. `import.rs` — 无 task 直插

```rust
use crate::crawler::downloader::{compute_file_hash, generate_thumbnail};
#[cfg(not(target_os = "android"))]
use crate::crawler::downloader::video_compress::compress_video_for_preview;
use crate::emitter::GlobalEmitter;
use crate::image_type::is_video_by_path;
use crate::media_dimensions::{resolve_file_size_sync, resolve_media_dimensions_sync};
use crate::storage::{ImageInfo, Storage};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

pub const LOCAL_FOLDER_PLUGIN_ID: &str = "local-import";

/// 把一个本地文件按 sync 语义写入 DB + album_images，并发出事件。
///
/// - 新增（`carry` 为 None）：display_name = 文件名，metadata_id = None。
/// - 重新导入（`carry` 为 Some）：display_name 与 metadata_id 沿用调用方传入的旧值。
pub async fn import_local_file(
    path: &Path,
    album_id: &str,
    size: u64,
    carry: Option<CarryFromOld>,
) -> Result<String, String> {
    let hash = compute_file_hash(path).await?;
    let is_video = is_video_by_path(path);
    let thumbnail_path_str = build_thumbnail_path(path, is_video).await;
    let (w, h) = resolve_media_dimensions_sync(&path.to_string_lossy())
        .map(|(w, h)| (Some(w), Some(h)))
        .unwrap_or((None, None));
    let resolved_size = resolve_file_size_sync(&path.to_string_lossy()).or(Some(size));

    let basename = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("image")
        .to_string();
    let display_name = carry
        .as_ref()
        .map(|c| c.display_name.clone())
        .unwrap_or(basename);
    let metadata_id = carry.as_ref().and_then(|c| c.metadata_id);

    let crawled_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    let info = ImageInfo {
        id: String::new(),
        url: None,
        local_path: path.to_string_lossy().into_owned(),
        plugin_id: LOCAL_FOLDER_PLUGIN_ID.to_string(),
        task_id: None,
        surf_record_id: None,
        crawled_at,
        metadata_id,
        thumbnail_path: thumbnail_path_str,
        favorite: false,
        is_hidden: false,
        hash,
        local_exists: true,
        width: w,
        height: h,
        display_name,
        media_type: None, // add_image 会按 path 推断
        last_set_wallpaper_at: None,
        size: resolved_size,
        album_order: None,
    };

    let storage = Storage::global();
    let inserted = storage.add_image(info)?;
    let image_id = inserted.id.clone();

    // 加入 album_images（不复用 add_images_to_album_with_event 因为我们要合并 images-change 一起发）
    storage.add_images_to_album(album_id, &[image_id.clone()])?;

    // 合并发两类事件，参考 downloader 的 process_downloaded_image_to_storage 收尾
    let aids = vec![album_id.to_string()];
    let ids = vec![image_id.clone()];
    let plugin_ids = vec![LOCAL_FOLDER_PLUGIN_ID.to_string()];
    GlobalEmitter::global().emit_images_change("add", &ids, None, None, Some(&plugin_ids));
    GlobalEmitter::global().emit_album_images_change("add", &aids, &ids);

    Ok(image_id)
}

#[derive(Debug, Clone)]
pub struct CarryFromOld {
    pub display_name: String,
    pub metadata_id: Option<i64>,
}

#[cfg(not(target_os = "android"))]
async fn build_thumbnail_path(path: &Path, is_video: bool) -> String {
    let result = if is_video {
        compress_video_for_preview(path).await.map(|r| Some(r.preview_path))
    } else {
        generate_thumbnail(path).await
    };
    match result {
        Ok(Some(p)) => p
            .canonicalize()
            .ok()
            .map(|pp| pp.to_string_lossy().trim_start_matches("\\\\?\\").to_string())
            .unwrap_or_else(|| p.to_string_lossy().into_owned()),
        _ => path.to_string_lossy().into_owned(), // 缩略图失败回落到原路径，与 add_image 内部逻辑一致
    }
}

#[cfg(target_os = "android")]
async fn build_thumbnail_path(path: &Path, _is_video: bool) -> String {
    path.to_string_lossy().into_owned()
}
```

**核对**：调用前确保 `compute_file_hash`、`generate_thumbnail`、`video_compress::compress_video_for_preview` 都是 `pub`：
- `compute_file_hash` — [downloader/mod.rs:213](../../src-tauri/kabegame-core/src/crawler/downloader/mod.rs) `pub async fn`。✅
- `generate_thumbnail` — [downloader/mod.rs:2528](../../src-tauri/kabegame-core/src/crawler/downloader/mod.rs) `pub async fn`。✅
- `compress_video_for_preview` — [downloader/video_compress.rs](../../src-tauri/kabegame-core/src/crawler/downloader/video_compress.rs)，若非 pub 需提升可见性（追加 `pub` 或在 mod.rs 顶端 `pub use`）。Phase 2 完成时核对。

### 5. `sync.rs` — 顶层入口

```rust
use crate::emitter::GlobalEmitter;
use crate::local_folder::diff::{diff, DbImageRow, MaybeReimport};
use crate::local_folder::import::{import_local_file, CarryFromOld};
use crate::local_folder::scan::scan_dir;
use crate::local_folder::status::FolderStatus;
use crate::storage::image_events::delete_images_with_events;
use crate::storage::Storage;
use std::path::Path;

#[derive(Debug, Default)]
pub struct SyncReport {
    pub album_id: String,
    pub status: Option<FolderStatus>,
    pub added: usize,
    pub deleted: usize,
    pub reimported: usize,
    pub skipped_unstable: usize,
}

pub async fn sync_album(album_id: &str) -> Result<SyncReport, String> {
    let mut report = SyncReport {
        album_id: album_id.to_string(),
        ..Default::default()
    };

    let storage = Storage::global();
    let album = storage
        .get_album_by_id(album_id)?
        .ok_or_else(|| format!("album {} not found", album_id))?;

    if album.kind != "local_folder" {
        return Err(format!("album {} is not a local_folder album", album_id));
    }
    let sync_folder = album
        .sync_folder
        .as_deref()
        .ok_or_else(|| format!("album {} missing sync_folder", album_id))?;

    let scan = match scan_dir(Path::new(sync_folder)) {
        Ok(s) => s,
        Err(status) => {
            persist_status(album_id, &status);
            report.status = Some(status);
            return Ok(report);
        }
    };
    report.skipped_unstable = scan.skipped_unstable;

    let db_rows = storage.list_album_images_for_sync(album_id)?;
    let plan = diff(&scan.files, &db_rows);

    // 1) deletes（包括文件本体）
    if !plan.deletes.is_empty() {
        report.deleted = plan.deletes.len();
        delete_images_with_events(&plan.deletes, /* delete_files = */ true)?;
    }

    // 2) reimports：hash 对比真正改过的才走 delete + import；保留 display_name + metadata_id
    for MaybeReimport { fs, db } in plan.maybe_reimports {
        let new_hash = crate::crawler::downloader::compute_file_hash(&fs.path).await?;
        if new_hash == db.hash {
            continue; // 内容未变（mtime 单调推前但内容相同）
        }
        let carry = CarryFromOld {
            display_name: db.display_name.clone(),
            metadata_id: db.metadata_id,
        };
        delete_images_with_events(&[db.image_id.clone()], /* delete_files = */ false)?;
        // ⚠️ 重新导入用 delete_files=false：旧记录的 local_path 与新文件相同，
        //    若先删文件再 import 会一起把新文件干掉。详见步骤 7。
        import_local_file(&fs.path, album_id, fs.size, Some(carry)).await?;
        report.reimported += 1;
    }

    // 3) adds
    for f in plan.adds {
        import_local_file(&f.path, album_id, f.size, None).await?;
        report.added += 1;
    }

    let ok = FolderStatus::now_ok();
    persist_status(album_id, &ok);
    report.status = Some(ok);
    Ok(report)
}

fn persist_status(album_id: &str, status: &FolderStatus) {
    if let Err(e) = Storage::global().update_album_folder_status(album_id, Some(&status.to_json())) {
        log::warn!("[local_folder] persist status for {album_id} failed: {e}");
    }
    // 通知前端刷新画册卡片上的 folderStatus 显示
    GlobalEmitter::global().emit_album_changed(album_id);
}
```

**Note on `emit_album_changed`**：核对该方法是否存在；若没有就触发一次空 `emit_album_images_change("meta", &[album_id], &[])` 作为 piggyback。Phase 2 实现时取存在的一个，必要时新增。

### 6. `mod.rs`

```rust
//! 本地文件夹同步画册（type = "local_folder"）的核心算法。
//! macOS 优先实现；其它平台 sync_album 暂时仍可调用——scan_dir 走标准 std::fs，
//! 但端到端入口（IPC / 启动 / UI）只在 macOS 暴露，详见根计划。

pub mod diff;
pub mod import;
pub mod scan;
pub mod status;
pub mod sync;

pub use status::FolderStatus;
pub use sync::{sync_album, SyncReport};
```

并在 [src-tauri/kabegame-core/src/lib.rs](../../src-tauri/kabegame-core/src/lib.rs) 顶层加 `pub mod local_folder;`。

### 7. 新增 Storage 辅助方法

**`src-tauri/kabegame-core/src/storage/images.rs`** 内追加（位置：`find_image_by_hash` 附近）：

```rust
impl Storage {
    /// 为本地文件夹同步查询某 album 当前的图片快照。
    /// 仅返回 sync 关心的最少字段，避免拉整个 ImageInfo。
    pub fn list_album_images_for_sync(
        &self,
        album_id: &str,
    ) -> Result<Vec<crate::local_folder::diff::DbImageRow>, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {e}"))?;
        let mut stmt = conn
            .prepare(
                "SELECT i.id, i.local_path, i.size, i.crawled_at, i.hash, i.metadata_id, i.display_name
                 FROM images i
                 INNER JOIN album_images ai ON ai.image_id = i.id
                 WHERE ai.album_id = ?1",
            )
            .map_err(|e| format!("prepare list_album_images_for_sync: {e}"))?;
        let rows = stmt
            .query_map(rusqlite::params![album_id], |row| {
                Ok(crate::local_folder::diff::DbImageRow {
                    image_id: row.get::<_, i64>(0)?.to_string(),
                    local_path: row.get(1)?,
                    size: row.get::<_, Option<i64>>(2)?.map(|v| v as u64),
                    crawled_at: row.get::<_, i64>(3)? as u64,
                    hash: row.get(4)?,
                    metadata_id: row.get(5)?,
                    display_name: row.get(6)?,
                })
            })
            .map_err(|e| format!("query list_album_images_for_sync: {e}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("read list_album_images_for_sync: {e}"))
    }
}
```

**`src-tauri/kabegame-core/src/storage/albums.rs`** 内追加：

```rust
impl Storage {
    pub fn update_album_folder_status(
        &self,
        album_id: &str,
        status_json: Option<&str>,
    ) -> Result<(), String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {e}"))?;
        conn.execute(
            "UPDATE albums SET folder_status = ?1 WHERE id = ?2",
            rusqlite::params![status_json, album_id],
        )
        .map_err(|e| format!("update_album_folder_status: {e}"))?;
        Ok(())
    }

    pub fn list_local_folder_albums(&self) -> Result<Vec<Album>, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {e}"))?;
        let mut stmt = conn
            .prepare(
                "SELECT id, name, created_at, parent_id, type, sync_folder, folder_status
                 FROM albums WHERE type = 'local_folder' ORDER BY created_at ASC",
            )
            .map_err(|e| format!("prepare list_local_folder_albums: {e}"))?;
        let rows = stmt
            .query_map([], album_from_storage_row)
            .map_err(|e| format!("query list_local_folder_albums: {e}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("read list_local_folder_albums: {e}"))
    }
}
```

### 7-bis. **细节：`delete_files` 的语义**

阅读 [storage/images.rs:563](../../src-tauri/kabegame-core/src/storage/images.rs) 的 `batch_delete_images` 在执行时**会去删 local_path 对应的磁盘文件**。这正是用户要求的"DB-only 时 hard-delete 包括文件"——但要注意：

- **deletes 分支**：用户已经把磁盘上的文件删了，`batch_delete_images` 再去删一个不存在的路径不应当报错（已确认：fs::remove_file 的 NotFound 是吞掉的，看 [batch_delete_images](../../src-tauri/kabegame-core/src/storage/images.rs)；Phase 2 实施时必须 `cargo check` 确认）。✅ 这路径用 `delete_files=true`。
- **reimports 分支**：新文件就在旧 local_path 上覆盖。如果先 `delete_files=true`，会把用户新写的文件一起删了。所以 reimports 用 **`delete_files=false`**（仅删 DB 行，文件保留），随后 `import_local_file` 重新计算 hash + 缩略图 + 插入新 DB 行。

> **核对项**：实施时 `cd src-tauri/kabegame-core && cargo check`，且加单测验证 reimports 情况下文件没被删。

### 8. 单元测试（必做，至少覆盖 3 条路径）

新建 `src-tauri/kabegame-core/src/local_folder/tests.rs`（用 `#[cfg(test)] mod tests;` 引入），用 `tempfile = "3"` 在 tmp 目录起一个干净测试库（参考其它模块的 testing 范式，若 Storage 没有 in-memory ctor 就用文件 + ENV 注入）。

测试用例：
1. **新增**：tmp dir 放 1 张 jpg → 创建 album（type=local_folder, sync_folder=tmp 路径）→ `sync_album(id)` → 断言 SyncReport.added == 1，DB 中能查到一条 plugin_id="local-import" 且 task_id IS NULL 的行，display_name=basename。
2. **删除**：sync 一次后，删 tmp 文件 → 再 sync → SyncReport.deleted == 1，DB 中该行不存在。
3. **重新导入**：sync 一次后，覆盖 tmp 文件（不同内容、modified time +5s）→ display_name 与 metadata_id 用 `Storage::update_image_display_name` / 直接 SQL 改一下作为"用户编辑痕迹" → 再 sync → SyncReport.reimported == 1，新行的 display_name 与 metadata_id 与旧行一致，hash 与文件新内容一致。
4. **stable 跳过**：写入文件后立刻 sync（mtime < 3s）→ SyncReport.added == 0 且 skipped_unstable == 1；3s 后再 sync → added == 1。
5. **状态：missing**：sync_folder 指向不存在路径 → SyncReport.status == FolderStatus::Missing；DB 中 folder_status 字段非 NULL 且能反序列化。

测试**不**覆盖（留 Phase 3）：缩略图生成失败、并发 sync 同一 album、IPC 入口。

### 9. 在 `Cargo.toml` 顶层 `[dev-dependencies]` 检查是否已有 `tempfile`

若无，追加；workspace 已有的话直接 `tempfile.workspace = true`。

---

## 不做的事（明确边界）

- **不**注册 IPC 命令（Phase 3 做）。
- **不**改前端任何文件（Phase 4/5 做）。
- **不**接入启动期自动调用（Phase 3 做）。
- **不**接入 NSMetadataQuery 实时监听（Phase 7 可选）。
- **不**复用 `run_builtin_local_import`（它走 task + DownloadQueue + 复制文件，与 sync 语义不符）。
- **不**改 `add_image` 签名（保留可能受影响的现有调用方）。
- **不**对 `local_folder` 写操作加只读守卫（Phase 5 做）。

---

## 验收清单

1. **类型检查**：
   - `cargo check -p kabegame-core` 通过。
   - `cargo check -p kabegame`、`-p kabegame-cli` 通过（这两者不应被影响，但要核对依赖未破裂）。
2. **单测**：
   - `cargo test -p kabegame-core local_folder::` 全部通过（5 个用例如上）。
3. **手工验证（可选，但推荐）**：
   - 直接 `sqlite3 data/.../kabegame.db` 插一条 `type='local_folder', sync_folder='/tmp/test_album'` 的 album；
   - 在 `/tmp/test_album` 放一张 jpg；
   - 写一个临时 `#[tokio::test]` 调 `sync_album(id).await`；
   - DevTools 监听 `images-change`、`album-images-change` 事件确认（Phase 2 没接 emitter listener 也行，单测里直接断言 DB 即可）。
4. **代码自检 grep**：
   ```bash
   rg "local_folder" src-tauri/kabegame-core/src --files-with-matches
   # 应只看到本 Phase 新建的 6 个文件 + lib.rs + albums.rs + images.rs
   ```

---

## 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| `compress_video_for_preview` 可见性不足 | 编译错误 | 在 `downloader/video_compress.rs` 顶部加 `pub use` 或函数签名前加 `pub` |
| `is_media_by_path` 名字与 [image_type.rs](../../src-tauri/kabegame-core/src/image_type.rs) 实际不一致 | 编译错误 | 改用 `is_image_by_path(p) \|\| is_video_by_path(p)`（line 358 已确认存在） |
| `delete_images_with_events(.., true)` 同步删用户磁盘文件，可能误删 | 用户数据丢失 | 单测覆盖 reimports 用 false；deletes 时用户已主动删文件，再删不存在路径无害 |
| 用户在 sync 进行中替换文件 | hash 不一致或半写文件 | stable_for=3s 已经过滤；并发竞态留 Phase 3 用 album 级 Mutex 解决 |
| `local_path` 唯一约束 | INSERT 冲突 | 当前 schema 在 `local_path` 上**没有** UNIQUE（只有 INDEX，[init.rs:74](../../src-tauri/kabegame-core/src/storage/migrations/init.rs)），允许多 album / 重复 sync 共存；reimports 通过先 delete 行避免冲突 |
| `media_type` 列默认值 | add_image 时 column 默认 `'image'`，视频应为 `'video'` | `add_image` 已调 `normalize_stored_media_type`；同时 `crate::image_type::media_type_from_path(path)` 兜底，必要时在 `import.rs` 显式设置 |

---

## 关键参考定位

- [`compute_file_hash`](../../src-tauri/kabegame-core/src/crawler/downloader/mod.rs#L213) — sha256，流式。
- [`generate_thumbnail`](../../src-tauri/kabegame-core/src/crawler/downloader/mod.rs#L2528) — 图片缩略图。
- [`process_downloaded_image_to_storage`](../../src-tauri/kabegame-core/src/crawler/downloader/mod.rs#L2243) — 参考完整组装链路。
- [`import_file_url`](../../src-tauri/kabegame-core/src/crawler/local_import.rs#L200) — 本地导入既有路径，**对照**但**不复用**。
- [`Candidate::from_path` + stable_age](../../test/native-auto-import/src/main.rs#L565) — stable_for 过滤参考。
- [`image_events::delete_images_with_events`](../../src-tauri/kabegame-core/src/storage/image_events.rs#L20) — 删除事件复用。
