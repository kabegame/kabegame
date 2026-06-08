# Phase 4 — 创建弹窗 + 递归创建逻辑 + reimport 保 order

> 隶属：[local-folder-album-sync.md](./local-folder-album-sync.md)
> 前置：[Phase 1](./local-folder-album-sync-phase1.md)、[Phase 2](./local-folder-album-sync-phase2.md)、[Phase 3](./local-folder-album-sync-phase3.md) 已实现并合并。
> 范围：让用户能从「画册」页一键创建本地文件夹同步画册，支持递归展开为子画册；同步顺路修复 Phase 2 reimport 不保留 `order` 的缺陷。
> 完成后：UI 流程闭环（创建 → 自动 sync → 看到图片）；用户可以**手动重排** local_folder album 中图片的顺序（`update_album_images_order` 仍开放），reimport 时该 order 不会被丢失。

---

## 已确认的设计点

1. **递归命名格式**：`<根名>-<seg1>-<seg2>-...-<segN>`（与根计划已确认决策一致）。例：`Pictures/person/girl` + 根名"图片" → `图片` / `图片-person` / `图片-person-girl`。分隔符写死 `-`。
2. **递归遍历策略**：
   - DFS，**所有**子目录都创建对应画册（即使该目录内无媒体——保持结构与磁盘一致；用户可后续删除）。
   - **不**跟随 symlink（避免循环）。
   - 跳过 `.` 开头的隐藏目录与文件。
   - 深度上限 16，超过的子树静默跳过（避免病态递归把 DB 撑爆）。
   - 顶层 album 总是创建——即使 sync_folder 是空目录。
3. **事务原子性**：所有子画册的 INSERT 在**单个**事务里完成，失败整体回滚。事件 (`emit_album_added`) 在 COMMIT 之后**逐个**发出。
4. **创建后首轮 sync**：用 Phase 3 的 `sync_albums_by_ids` 在 `tauri::async_runtime::spawn` 异步跑；命令立即返回创建结果，不等 sync。
5. **路径校验**：
   - 必须是绝对路径（`Path::is_absolute()`）。
   - 必须存在且是目录。
   - **允许**指向已被其它 local_folder album 使用的路径（根计划决策 5）。
   - **不允许**指向 `/`（兜底）。
   - **不允许**位于 VD 挂载目录之下——把 sync 数据库回环导入到 VD 挂载里只会触发死循环（VD 内的"文件"是从 DB 渲染出来的；sync 把它们当本地图片再写回 DB）。通过 `VirtualDriveService::global().current_mount_point()` 取当前挂载点，做祖先关系比较。
6. **`update_album_images_order` 保持开放**（用户最新指示）：local_folder album 的图片**顺序可由用户手动调整**；Phase 5 的只读守卫**不**覆盖这个命令。本 Phase 同步把 Phase 2 reimport 流程补上"保留 order"逻辑，否则用户调整完顺序、下次文件 mtime 变化触发 reimport 就会丢失。
7. **平台范围**：与 Phase 3 一致——非 macOS 在 commands_core 入口直接 `Err("local folder sync is macOS-only in this build")`；前端 UI 入口（创建弹窗的复选框）在非 macOS 上隐藏。

---

## 涉及文件清单

### 修改（amendment to Phase 2）

- [src-tauri/kabegame-core/src/local_folder/diff.rs](../../src-tauri/kabegame-core/src/local_folder/diff.rs) — `DbImageRow` 加 `order: Option<i64>`
- [src-tauri/kabegame-core/src/local_folder/import.rs](../../src-tauri/kabegame-core/src/local_folder/import.rs) — `CarryFromOld` 加 `order: Option<i64>`；`import_local_file` 末尾按 carry.order 修正 album_images 行的 `order`
- [src-tauri/kabegame-core/src/storage/images.rs](../../src-tauri/kabegame-core/src/storage/images.rs) — `list_album_images_for_sync` SELECT 加上 `ai."order"`，行解析多读一列
- [src-tauri/kabegame-core/src/local_folder/sync.rs](../../src-tauri/kabegame-core/src/local_folder/sync.rs) — reimport 分支构造 `CarryFromOld` 时填入 `db.order`

### 新增

- [src-tauri/kabegame-core/src/local_folder/create.rs](../../src-tauri/kabegame-core/src/local_folder/create.rs)（新文件）— 递归遍历构造 album 创建条目列表

### 修改（Phase 4 主体）

- [src-tauri/kabegame-core/src/local_folder/mod.rs](../../src-tauri/kabegame-core/src/local_folder/mod.rs) — 加 `pub mod create;` 与 re-export
- [src-tauri/kabegame-core/src/storage/albums.rs](../../src-tauri/kabegame-core/src/storage/albums.rs) — 新增 `add_local_folder_albums_tx`
- [src-tauri/kabegame/src/commands_core/album.rs](../../src-tauri/kabegame/src/commands_core/album.rs) — 业务函数 `add_local_folder_album`
- [src-tauri/kabegame/src/commands/album.rs](../../src-tauri/kabegame/src/commands/album.rs) — Tauri 命令包装
- [src-tauri/kabegame/src/lib.rs](../../src-tauri/kabegame/src/lib.rs) — `generate_handler!` 注册一个新命令
- [src-tauri/kabegame/src/web/dispatch.rs](../../src-tauri/kabegame/src/web/dispatch.rs) — Web RPC method 一条
- [apps/kabegame/src/stores/albums.ts](../../apps/kabegame/src/stores/albums.ts) — `createLocalFolderAlbum` 方法
- [apps/kabegame/src/views/Albums.vue](../../apps/kabegame/src/views/Albums.vue) — 创建弹窗扩展（复选框 / 路径选择 / 递归开关）
- 前端 i18n 文件（`zh.json` / `en.json` 等）— 新增 key

### 不修改

- 任何只读守卫逻辑（Phase 5 做）。
- AlbumCard 视觉（Phase 5 做）。
- AlbumDetail.vue / 手动刷新（Phase 6 做）。

---

## 步骤

### 1. Amendment: reimport 保留 `order`

#### 1.1 SELECT 多查一列

`list_album_images_for_sync` 当前 SQL：

```sql
SELECT i.id, i.local_path, i.size, i.crawled_at, i.hash, i.metadata_id, i.display_name
FROM images i
INNER JOIN album_images ai ON ai.image_id = i.id
WHERE ai.album_id = ?1
```

改为：

```sql
SELECT i.id, i.local_path, i.size, i.crawled_at, i.hash, i.metadata_id, i.display_name, ai."order"
FROM images i
INNER JOIN album_images ai ON ai.image_id = i.id
WHERE ai.album_id = ?1
```

行解析（[images.rs:326-336](../../src-tauri/kabegame-core/src/storage/images.rs#L326)）追加：

```rust
order: row.get::<_, Option<i64>>(7)?,
```

#### 1.2 `DbImageRow` 加字段

`diff.rs`：

```rust
#[derive(Debug, Clone)]
pub struct DbImageRow {
    pub image_id: String,
    pub local_path: String,
    pub size: Option<u64>,
    pub crawled_at: u64,
    pub hash: String,
    pub metadata_id: Option<i64>,
    pub display_name: String,
    pub order: Option<i64>,
}
```

注意 diff 算法本身不需要看 `order`——它只是被 `MaybeReimport.db` 透传到 sync.rs 的 reimport 分支。

#### 1.3 `CarryFromOld` 加字段

`import.rs`：

```rust
#[derive(Debug, Clone)]
pub struct CarryFromOld {
    pub display_name: String,
    pub metadata_id: Option<i64>,
    pub order: Option<i64>,
}
```

#### 1.4 `import_local_file` 末尾修正 order

在 `storage.add_images_to_album(album_id, &[image_id.clone()])?;` **之后**、emit 事件**之前**插入：

```rust
if let Some(order) = carry.as_ref().and_then(|old| old.order) {
    storage.update_album_images_order(album_id, &[(image_id.clone(), order)])?;
}
```

> **不要**把 `order` 直接写进 `ImageInfo.album_order` 再依赖 `add_image`——`add_image` 不写 `album_images.order`；`add_images_to_album` 写一个新行 order 默认为 NULL。后置 update 是最少侵入的做法。

#### 1.5 sync.rs reimport 分支填 carry.order

[sync.rs:126](../../src-tauri/kabegame-core/src/local_folder/sync.rs#L126) 当前：

```rust
let carry = CarryFromOld {
    display_name: db.display_name.clone(),
    metadata_id: db.metadata_id,
};
```

改为：

```rust
let carry = CarryFromOld {
    display_name: db.display_name.clone(),
    metadata_id: db.metadata_id,
    order: db.order,
};
```

#### 1.6 测试补充

[src-tauri/kabegame-core/src/local_folder/tests.rs](../../src-tauri/kabegame-core/src/local_folder/tests.rs) 已覆盖的 reimport case 里增加一步：

```rust
// 在首次 sync 后，用户手动设置 order=42
storage.update_album_images_order(&album_id, &[(image_id.clone(), 42)])?;

// 触发 reimport（修改文件内容 + mtime）
// ...

// 断言新 image_id 的 album_images.order == 42
let rows = storage.list_album_images_for_sync(&album_id)?;
assert_eq!(rows.len(), 1);
assert_eq!(rows[0].order, Some(42));
```

### 2. 新增 `local_folder/create.rs` — 递归收集

```rust
//! 递归扫描用户指定的根目录，构造将要批量创建的 local_folder album 条目列表。
//!
//! 输出按 DFS 父在前、子在后的顺序排列，可直接喂给 `Storage::add_local_folder_albums_tx`，
//! 因为子条目的 parent_id 会引用前面已经预生成的 id。

use std::fs;
use std::path::{Path, PathBuf};

const MAX_DEPTH: usize = 16;
const NAME_SEPARATOR: &str = "-";

#[derive(Debug, Clone)]
pub struct NewLocalFolderEntry {
    pub id: String,             // 预生成的 UUID v4
    pub name: String,           // "图片" | "图片-person" | "图片-person-girl"
    pub sync_folder: String,    // 绝对路径
    pub parent_id: Option<String>, // 引用上一层条目的 id；顶层为 None（或外部传入）
}

/// 不递归：只构造一个顶层条目。
pub fn build_entries_non_recursive(
    root_name: &str,
    sync_folder: &Path,
    parent_id: Option<&str>,
) -> NewLocalFolderEntry {
    NewLocalFolderEntry {
        id: uuid::Uuid::new_v4().to_string(),
        name: root_name.to_string(),
        sync_folder: sync_folder.to_string_lossy().into_owned(),
        parent_id: parent_id.map(|s| s.to_string()),
    }
}

/// 递归：DFS 遍历 `sync_folder` 下的所有子目录，按 `<root_name>-<seg>-...` 命名。
/// `parent_id` 是顶层 album 在 Storage 中的父——子目录的 parent_id 自动指向上一层条目的 id。
///
/// 失败场景：读目录权限不足 / IO 错误 —— 返回 Err，由调用方决定回滚或继续。
pub fn build_entries_recursive(
    root_name: &str,
    sync_folder: &Path,
    parent_id: Option<&str>,
) -> Result<Vec<NewLocalFolderEntry>, String> {
    if !sync_folder.is_absolute() {
        return Err(format!("sync_folder must be absolute: {}", sync_folder.display()));
    }
    let mut out = Vec::new();
    let root = NewLocalFolderEntry {
        id: uuid::Uuid::new_v4().to_string(),
        name: root_name.to_string(),
        sync_folder: sync_folder.to_string_lossy().into_owned(),
        parent_id: parent_id.map(|s| s.to_string()),
    };
    let root_id = root.id.clone();
    out.push(root);
    walk(sync_folder, root_name, &root_id, 0, &mut out)?;
    Ok(out)
}

fn walk(
    dir: &Path,
    prefix: &str,
    parent_id: &str,
    depth: usize,
    out: &mut Vec<NewLocalFolderEntry>,
) -> Result<(), String> {
    if depth >= MAX_DEPTH {
        return Ok(()); // 超深度静默跳过
    }
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(e) => {
            // 子目录权限失败不致命：跳过该子树
            log::warn!("[local_folder] skip subdir {}: {e}", dir.display());
            return Ok(());
        }
    };
    for entry in entries.flatten() {
        let file_type = match entry.file_type() {
            Ok(ft) => ft,
            Err(_) => continue,
        };
        if file_type.is_symlink() || !file_type.is_dir() {
            continue;
        }
        let name = entry.file_name();
        let name_str = match name.to_str() {
            Some(s) => s,
            None => continue, // 非 UTF-8 名跳过
        };
        if name_str.starts_with('.') {
            continue;
        }
        let child_path = entry.path();
        let child_album_name = format!("{prefix}{NAME_SEPARATOR}{name_str}");
        let child_id = uuid::Uuid::new_v4().to_string();
        out.push(NewLocalFolderEntry {
            id: child_id.clone(),
            name: child_album_name.clone(),
            sync_folder: child_path.to_string_lossy().into_owned(),
            parent_id: Some(parent_id.to_string()),
        });
        walk(&child_path, &child_album_name, &child_id, depth + 1, out)?;
    }
    Ok(())
}
```

> **决策点**：子目录无媒体也建 album（与第 2 节决策一致）。如果未来想"仅建有内容的子目录"，需要在此函数加一次预扫描——本 Phase 不做。

### 3. Storage 事务方法 `add_local_folder_albums_tx`

在 [storage/albums.rs](../../src-tauri/kabegame-core/src/storage/albums.rs) 末尾追加：

```rust
impl Storage {
    /// 原子地批量创建 local_folder album。entries 必须按 DFS 父在前、子在后排序；
    /// 任何一条失败则整体回滚，不发任何 album-added 事件。
    /// 成功后逐个发 emit_album_added。
    pub fn add_local_folder_albums_tx(
        &self,
        entries: &[crate::local_folder::create::NewLocalFolderEntry],
    ) -> Result<Vec<Album>, String> {
        if entries.is_empty() {
            return Ok(Vec::new());
        }
        let mut conn = self.db.lock().map_err(|e| format!("Lock error: {e}"))?;
        let tx = conn
            .transaction()
            .map_err(|e| format!("Failed to start tx: {e}"))?;

        // 校验：外部 parent_id（不在本批次内的）必须存在。
        let batch_ids: HashSet<&str> = entries.iter().map(|e| e.id.as_str()).collect();
        for entry in entries {
            if let Some(pid) = &entry.parent_id {
                if !batch_ids.contains(pid.as_str()) {
                    let exists: bool = tx
                        .query_row(
                            "SELECT EXISTS(SELECT 1 FROM albums WHERE id = ?1)",
                            params![pid],
                            |row| row.get(0),
                        )
                        .map_err(|e| format!("verify external parent: {e}"))?;
                    if !exists {
                        return Err(format!("父画册不存在: {pid}"));
                    }
                }
            }
        }

        let created_at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| format!("Time error: {e}"))?
            .as_secs();

        let mut created = Vec::with_capacity(entries.len());
        for entry in entries {
            // 复用既有名字唯一性检查，传入 tx 作为 Connection
            Self::ensure_album_name_unique_ci(&tx, &entry.name, entry.parent_id.as_deref(), None)?;
            tx.execute(
                "INSERT INTO albums (id, name, created_at, parent_id, type, sync_folder, folder_status)
                 VALUES (?1, ?2, ?3, ?4, 'local_folder', ?5, NULL)",
                params![
                    entry.id,
                    entry.name,
                    created_at as i64,
                    entry.parent_id,
                    entry.sync_folder,
                ],
            )
            .map_err(|e| format!("insert local_folder album: {e}"))?;
            created.push(Album {
                id: entry.id.clone(),
                name: entry.name.clone(),
                created_at,
                parent_id: entry.parent_id.clone(),
                kind: "local_folder".to_string(),
                sync_folder: Some(entry.sync_folder.clone()),
                folder_status: None,
            });
        }
        tx.commit().map_err(|e| format!("commit: {e}"))?;

        if let Some(emitter) = GlobalEmitter::try_global() {
            for album in &created {
                emitter.emit_album_added(
                    &album.id,
                    &album.name,
                    album.created_at,
                    album.parent_id.as_deref(),
                );
            }
        }
        Ok(created)
    }
}
```

**核对**：
- `ensure_album_name_unique_ci`（[albums.rs:588](../../src-tauri/kabegame-core/src/storage/albums.rs#L588)）目前签名 `(conn: &Connection, ...)`，`rusqlite::Transaction` 实现了 `Deref<Target=Connection>`，所以传 `&tx` 自动解引用。如果编译报 type mismatch，显式写 `&*tx`。
- 父校验：批次内引用走 `batch_ids` 集合；外部引用走 DB EXISTS。
- 唯一性：靠 `idx_albums_name_scoped` 兜底 + `ensure_album_name_unique_ci` 早返回更友好错误。

### 4. `local_folder/mod.rs` re-export

```rust
pub mod create;
pub use create::{build_entries_non_recursive, build_entries_recursive, NewLocalFolderEntry};
```

### 5. `commands_core/album.rs` — 业务函数

```rust
// ─── local folder create (macOS-only at the product level) ───────────────────

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddLocalFolderAlbumArgs {
    pub name: String,
    pub parent_id: Option<String>,
    pub sync_folder: String,
    pub recursive: bool,
}

#[cfg(target_os = "macos")]
pub async fn add_local_folder_album(args: AddLocalFolderAlbumArgs) -> Result<Value, String> {
    use kabegame_core::local_folder::{
        build_entries_non_recursive, build_entries_recursive,
    };
    use kabegame_core::storage::Storage;
    use std::path::Path;

    let name = args.name.trim();
    if name.is_empty() {
        return Err("画册名称不能为空".into());
    }
    if name.contains('/') {
        return Err("画册名称不能包含 '/'".into());
    }
    let sync_folder = Path::new(args.sync_folder.trim());
    if !sync_folder.is_absolute() {
        return Err("sync_folder 必须是绝对路径".into());
    }
    if sync_folder == Path::new("/") {
        return Err("sync_folder 不能是根目录 '/'".into());
    }
    match std::fs::metadata(sync_folder) {
        Ok(m) if m.is_dir() => {}
        Ok(_) => return Err("sync_folder 不是目录".into()),
        Err(e) => return Err(format!("无法访问 sync_folder: {e}")),
    }

    // 不允许选 VD 挂载目录之下的路径——VD 内的文件是 DB 反向渲染产物，
    // 把它当本地源回环导入会触发死循环（写回 DB 后 VD 又出现新"文件"）。
    #[cfg(feature = "standard")]
    {
        use kabegame_core::virtual_driver::driver_service::VirtualDriveServiceTrait;
        if let Some(mp) = kabegame_core::virtual_driver::VirtualDriveService::global()
            .current_mount_point()
        {
            let mp_path = Path::new(&mp);
            let mp_canon = mp_path.canonicalize().unwrap_or_else(|_| mp_path.to_path_buf());
            let sync_canon = sync_folder
                .canonicalize()
                .unwrap_or_else(|_| sync_folder.to_path_buf());
            if sync_canon == mp_canon || sync_canon.starts_with(&mp_canon) {
                return Err(format!(
                    "不能选择虚拟磁盘挂载目录内的路径（{}）作为同步源",
                    mp
                ));
            }
        }
    }

    let entries = if args.recursive {
        build_entries_recursive(name, sync_folder, args.parent_id.as_deref())?
    } else {
        vec![build_entries_non_recursive(name, sync_folder, args.parent_id.as_deref())]
    };

    let created = Storage::global().add_local_folder_albums_tx(&entries)?;
    let created_ids: Vec<String> = created.iter().map(|a| a.id.clone()).collect();

    // 后台启动首轮 sync；不等待
    tauri::async_runtime::spawn(async move {
        let _ = kabegame_core::local_folder::sync_albums_by_ids(&created_ids).await;
    });

    serde_json::to_value(created).map_err(|e| e.to_string())
}

#[cfg(not(target_os = "macos"))]
pub async fn add_local_folder_album(_args: AddLocalFolderAlbumArgs) -> Result<Value, String> {
    Err("local folder sync is macOS-only in this build".into())
}
```

**核对**：
- `tauri::async_runtime::spawn` 在 `kabegame_core` 中不可用（依赖反向）；本函数位于 `kabegame` crate 的 `commands_core`，那里能用 `tauri::async_runtime`。如果用例错位，回落到 `tokio::spawn`。
- `args.parent_id` 是**外部 parent_id**——若为 Some，必须是一个已存在的画册 id（任意 kind 均允许；普通画册下挂 local_folder 子画册没问题）。

### 6. Tauri 命令 + Web RPC

`commands/album.rs` 末尾：

```rust
#[tauri::command]
pub async fn add_local_folder_album(
    args: crate::commands_core::album::AddLocalFolderAlbumArgs,
) -> Result<Value, String> {
    crate::commands_core::album::add_local_folder_album(args).await
}
```

`lib.rs` 的 `generate_handler!` 的 `// --- Albums ---` 段末尾追加 `add_local_folder_album,`。

`web/dispatch.rs` 在 `add_album` 附近追加：

```rust
map.insert(
    "add_local_folder_album",
    MethodEntry {
        requires_super: true,
        handler: Arc::new(|p| {
            Box::pin(async move {
                let args: crate::commands_core::album::AddLocalFolderAlbumArgs =
                    serde_json::from_value(p).map_err(|e| RpcError::invalid_params(e.to_string()))?;
                crate::commands_core::album::add_local_folder_album(args)
                    .await
                    .map_err(RpcError::internal)
            })
        }),
    },
);
```

### 7. 前端 store — `createLocalFolderAlbum`

[stores/albums.ts](../../apps/kabegame/src/stores/albums.ts) 在 `createAlbum` 之后追加：

```ts
const createLocalFolderAlbum = async (
  args: {
    name: string;
    syncFolder: string;
    recursive: boolean;
    parentId?: string | null;
  },
  opts: { reload?: boolean } = {},
) => {
  await initEventListeners();
  try {
    const createdRaw = await invoke<unknown>("add_local_folder_album", {
      args: {
        name: args.name,
        parentId: args.parentId ?? null,
        syncFolder: args.syncFolder,
        recursive: args.recursive,
      },
    });
    const list = Array.isArray(createdRaw) ? createdRaw : [createdRaw];
    const created = list
      .map((r) => normalizeAlbumRow(r as Record<string, unknown>))
      .filter((a) => !!a.id);

    const reload = opts.reload ?? true;
    if (reload) {
      await loadAlbums();
    } else {
      for (const album of created) {
        if (!albums.value.some((a) => a.id === album.id)) {
          albums.value.unshift(album);
        }
        albumDirectCounts.value[album.id] = albumDirectCounts.value[album.id] ?? 0;
        albumHiddenDirectCounts.value[album.id] = albumHiddenDirectCounts.value[album.id] ?? 0;
      }
      recomputeAllAlbumCounts();
    }
    return created;
  } catch (error: any) {
    const errorMessage = typeof error === "string" ? error : error?.message || String(error);
    throw new Error(errorMessage);
  }
};
```

在 store return 块加 `createLocalFolderAlbum,`。

**注意 invoke 参数封装**：Tauri 命令签名是 `add_local_folder_album(args: AddLocalFolderAlbumArgs)`，所以 invoke 的载荷是 `{ args: {...} }`（外层 `args` 是参数名，内层是 struct 字段）。如果想避免这层嵌套，可以在 [commands/album.rs](../../src-tauri/kabegame/src/commands/album.rs) 里把命令签名拍平：

```rust
#[tauri::command]
pub async fn add_local_folder_album(
    name: String,
    parent_id: Option<String>,
    sync_folder: String,
    recursive: bool,
) -> Result<Value, String> {
    crate::commands_core::album::add_local_folder_album(
        crate::commands_core::album::AddLocalFolderAlbumArgs { name, parent_id, sync_folder, recursive }
    ).await
}
```

**推荐拍平**，前端 invoke 写法与 `add_album` 一致（`{ name, parentId, syncFolder, recursive }`），更符合既有约定。Web RPC 那边仍解析 `AddLocalFolderAlbumArgs` 结构体（JSON-RPC 的 params 是个对象，等价）。

### 8. 前端 Albums.vue — 弹窗扩展

[Albums.vue:37-43](../../apps/kabegame/src/views/Albums.vue#L37) 创建弹窗当前只有一个 el-input。改造为：

```vue
<el-dialog v-model="showCreateDialog" :title="$t('albums.newAlbum')" width="400px">
  <el-form label-width="0" @submit.prevent>
    <el-input v-model="newAlbumName" :placeholder="$t('albums.placeholderName')" />

    <el-checkbox
      v-if="IS_MACOS"
      v-model="newAlbumIsLocalFolder"
      class="mt-3"
    >
      {{ $t('albums.localFolder.create') }}
    </el-checkbox>

    <div v-if="newAlbumIsLocalFolder" class="mt-2 flex flex-col gap-2">
      <div class="flex items-center gap-2">
        <el-button size="small" @click="pickLocalFolder">
          {{ $t('albums.localFolder.choosePath') }}
        </el-button>
        <span
          class="text-xs text-gray-500 truncate"
          :title="newAlbumSyncFolder"
        >
          {{ newAlbumSyncFolder || $t('albums.localFolder.noPathSelected') }}
        </span>
      </div>
      <el-checkbox v-model="newAlbumRecursive">
        {{ $t('albums.localFolder.recursive') }}
      </el-checkbox>
      <p class="text-xs text-gray-400 leading-snug">
        {{ $t('albums.localFolder.recursiveHint') }}
      </p>
      <p v-if="newAlbumRecursive" class="text-xs text-gray-400 leading-snug">
        {{ $t('albums.localFolder.recursiveLimits', { maxDepth: 16 }) }}
      </p>
      <p class="text-xs text-gray-400 leading-snug">
        {{ $t('albums.localFolder.skipNotice') }}
      </p>
    </div>
  </el-form>

  <template #footer>
    <el-button @click="showCreateDialog = false">{{ $t('common.cancel') }}</el-button>
    <el-button
      type="primary"
      :disabled="!canSubmitCreateAlbum"
      :loading="creatingAlbum"
      @click="handleCreateAlbum"
    >
      {{ $t('albums.create') }}
    </el-button>
  </template>
</el-dialog>
```

`<script setup>` 内追加：

```ts
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { IS_MACOS } from "@kabegame/core/env";
// IS_MACOS 是 build-time 常量（[packages/core/src/env.ts:3](../../packages/core/src/env.ts#L3)，
// 由 vite define 注入 `__MACOS__`）。Web 构建下为 false → 复选框被隐藏，行为正确。

const newAlbumIsLocalFolder = ref(false);
const newAlbumSyncFolder = ref("");
const newAlbumRecursive = ref(false);
const creatingAlbum = ref(false);

const canSubmitCreateAlbum = computed(() => {
  if (!newAlbumName.value.trim()) return false;
  if (creatingAlbum.value) return false;
  if (newAlbumIsLocalFolder.value && !newAlbumSyncFolder.value) return false;
  return true;
});

const pickLocalFolder = async () => {
  try {
    const selected = await openDialog({ directory: true, multiple: false });
    if (typeof selected === "string" && selected) {
      newAlbumSyncFolder.value = selected;
    }
  } catch (e) {
    console.warn("pickLocalFolder failed", e);
  }
};

// 改造 handleCreateAlbum：
const handleCreateAlbum = async () => {
  if (!canSubmitCreateAlbum.value) return;
  creatingAlbum.value = true;
  try {
    if (newAlbumIsLocalFolder.value) {
      await albumStore.createLocalFolderAlbum(
        {
          name: newAlbumName.value.trim(),
          syncFolder: newAlbumSyncFolder.value,
          recursive: newAlbumRecursive.value,
        },
        { reload: false },
      );
    } else {
      await albumStore.createAlbum(newAlbumName.value.trim(), { reload: false });
    }
    // 重置弹窗状态
    newAlbumName.value = "";
    newAlbumIsLocalFolder.value = false;
    newAlbumSyncFolder.value = "";
    newAlbumRecursive.value = false;
    showCreateDialog.value = false;
  } catch (e: any) {
    ElMessage.error(e?.message || String(e));
  } finally {
    creatingAlbum.value = false;
  }
};
```

**关闭弹窗时重置状态**：在 `<el-dialog>` 上加 `@closed` 回调亦重置（防止 ESC / 点遮罩关闭时残留），逻辑同上。

### 9. i18n keys（zh / en 必加，其它语言可在 Phase 6 补）

```jsonc
// zh
{
  "albums": {
    "localFolder": {
      "create": "同步本地文件夹",
      "choosePath": "选择文件夹…",
      "noPathSelected": "未选择",
      "recursive": "递归创建子文件夹画册",
      "recursiveHint": "将以「<画册名>-<子目录>」格式为每个子目录创建独立画册。",
      "recursiveLimits": "递归最多展开 {maxDepth} 层，超出的子目录会被跳过。",
      "skipNotice": "符号链接、以「.」开头的隐藏目录与文件、非图片/视频文件均不会同步。"
    }
  }
}

// en
{
  "albums": {
    "localFolder": {
      "create": "Sync from local folder",
      "choosePath": "Choose folder…",
      "noPathSelected": "Not selected",
      "recursive": "Create sub-albums recursively",
      "recursiveHint": "Each subfolder becomes its own album named '<album>-<subfolder>'.",
      "recursiveLimits": "Recurses up to {maxDepth} levels deep; deeper subfolders are skipped.",
      "skipNotice": "Symlinks, hidden entries starting with '.', and non-image/video files are skipped."
    }
  }
}
```

实施时 grep [apps/kabegame/src/locales/](../../apps/kabegame/src/locales/) 或 `@kabegame/i18n` 包的实际位置追加。

---

## 验收清单

1. **类型检查**：
   - `bun check -c kabegame` 通过。
   - `cargo check -p kabegame-core`、`cargo check -p kabegame` 通过。
2. **单测**：
   - `cargo test -p kabegame-core local_folder::` 全部通过；reimport 用例新增的 order 断言通过。
   - 可选：新增 `local_folder::create` 子模块单测——给一个临时目录树 + `build_entries_recursive`，断言条目数量、命名格式、父子 id 链。
3. **手工流程（macOS）**：
   - 启动 dev，创建普通画册：流程不变。
   - 启动 dev，勾选「同步本地文件夹」+ 选择 `~/Pictures`（含若干子目录）+ 勾递归 → 成功创建多层画册；UI 立即看到根画册；console 看到 `[local_folder] startup sync done` 或后台 sync 日志；DevTools 接收 `album-images-change` 事件。
   - 不勾递归 → 只创建 1 个根画册；只在根目录的图片被 sync。
   - 名称冲突（已有同名同层画册）→ 返回明确错误，UI 弹 ElMessage.error。
   - 路径为不存在 / 普通文件 → 命令返回错误，未创建任何 album。
   - 选择 VD 挂载目录（或其子目录）→ 返回明确错误 "不能选择虚拟磁盘挂载目录…"，未创建任何 album。
   - 弹窗勾选「递归」后，下方说明文案显示最大深度（16）；不勾选时该行不出现；底部恒显示"跳过 symlink / 隐藏 / 非媒体"的说明。
4. **order 保留**：
   - 创建一个 local_folder album（一张图）→ 手工 `invoke('update_album_images_order', { albumId, imageOrders: [[id, 99]] })`。
   - 在文件系统覆盖图片文件（不同内容、mtime +5s）。
   - 触发 `sync_local_folder_album` → 查 DB `SELECT "order" FROM album_images WHERE album_id=?` 应仍是 99。
5. **非 macOS**：
   - 在 Linux / Android dev 启动，弹窗中**不**出现「同步本地文件夹」复选框；普通画册创建无回归。
   - 强行 invoke `add_local_folder_album` → `Err("local folder sync is macOS-only in this build")`。
6. **回归**：
   - 现有画册创建、重命名、删除、移动、添加图片不变。
   - `images-change` / `album-images-change` / `album-added` 事件路径不变。

---

## 不做的事

- **不**加只读守卫到 `add_images_to_album` / `remove_images_from_album` 等（Phase 5）。
- **不**改 AlbumCard 卡片视觉（Phase 5）。
- **不**改 AlbumDetail.vue 工具栏 / 右键菜单（Phase 5/6）。
- **不**接入手动刷新触发 sync（Phase 6）。
- **不**实现实时监听（Phase 7）。
- **不**做"子目录有内容才建画册"的预扫描——决策记录在第 2 节。

---

## 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| Phase 2 修改 `DbImageRow` / `CarryFromOld` 后字段不向后兼容 | 编译期错误 | 这些是 crate-private 结构，调用点只在 sync.rs / images.rs / tests.rs，统一修改即可 |
| 用户选了 `/` 或 `/Volumes` 这类巨大目录 + 递归 | 创建上万子画册，UI 卡顿、DB 膨胀 | 第 1 步显式拒绝 `/`；MAX_DEPTH=16 已限深；UNIQUE 索引会让重名子目录失败而非静默创建——足够阻拦最坏情况；进一步保护可后续加"批次条目数上限"（如 500），暂不做 |
| 选择路径时用户取消 picker | newAlbumSyncFolder 仍空 | `canSubmitCreateAlbum` 已校验 sync_folder 非空才允许提交；picker 返回 null 时不动 state |
| 同一根目录被两个 album 引用，递归创建产生重名子画册 | 第二次创建在 INSERT 时违反 UNIQUE `(parent, name)` 而整体回滚 | 错误信息透传给前端 ElMessage；用户改顶层名后重试。**取舍**：不在 Phase 4 做"自动追加 -2 / -3"，保留显式失败 |
| `update_album_images_order` 在 reimport 中文件不存在时报错 | reimport 失败 | reimport 路径里 image_id 是**新**插入的，update 必然成功；旧 image_id 被先 delete，update 只针对新 id |
| `parent_id` 外部传入但指向 hidden / favorite album | 创建在那些下面行为未定义 | commands_core 提前校验：`parent_id` 不能是 `HIDDEN_ALBUM_ID` / `FAVORITE_ALBUM_ID`，否则报错（Phase 4 实施时加一行 if 即可，复用 [storage/mod.rs](../../src-tauri/kabegame-core/src/storage/mod.rs) 的常量） |
| Tauri `args: Struct` 参数名嵌套问题导致 invoke 失败 | 前端调用报 invalid params | 按"推荐拍平"方案，把 Tauri 命令签名拍成 `name, parent_id, sync_folder, recursive`，前端 invoke 写 `{ name, parentId, syncFolder, recursive }`（snake↔camel 由 Tauri 默认转换） |
| Web / 非 macOS 构建 | `IS_MACOS` 为 `false` → 复选框被隐藏 | 正是期望行为；`IS_MACOS` 来自 [packages/core/src/env.ts](../../packages/core/src/env.ts)，由 vite define 注入 `__MACOS__`，全平台一致可用 |

---

## 关键 grep 自检

```bash
# Phase 2 修复痕迹：每处都加了 order
rg -n "order" src-tauri/kabegame-core/src/local_folder/{diff,import,sync}.rs
rg -n "ai\\.\"order\"" src-tauri/kabegame-core/src/storage/images.rs

# 新命令注册三处一致
rg -n "add_local_folder_album" src-tauri/kabegame/src

# Storage 事务方法只被新业务函数调用
rg -n "add_local_folder_albums_tx" src-tauri

# 前端只有一处 invoke 入口
rg -n "add_local_folder_album" apps/kabegame/src
```

---

## 关键参考定位

- [`Storage::update_album_images_order`](../../src-tauri/kabegame-core/src/storage/albums.rs#L565) — 已存在；reimport 末尾要再调一次。
- [`Storage::ensure_album_name_unique_ci`](../../src-tauri/kabegame-core/src/storage/albums.rs#L588) — 复用做事务内名字唯一性检查。
- [`Storage::add_album`](../../src-tauri/kabegame-core/src/storage/albums.rs#L195) — 对照 INSERT 列结构。
- [`albumStore.createAlbum`](../../apps/kabegame/src/stores/albums.ts#L337) — 对照 store 新方法风格。
- [`Albums.vue` 创建弹窗](../../apps/kabegame/src/views/Albums.vue#L37) — 改造入口。
- [`@tauri-apps/plugin-dialog::open`](../../apps/kabegame/src/components/LocalImportDialog.vue#L230) — 项目内已用的目录选择器示例。
