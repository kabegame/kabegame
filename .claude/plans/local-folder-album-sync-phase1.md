# Phase 1 — Schema 扩展与基础读写

> 隶属：[local-folder-album-sync.md](./local-folder-album-sync.md)
> 范围：仅扩展数据模型 + 读写 IO，**不**引入任何同步算法、IPC 或 UI 行为变化。
> 完成后：分支可编译可运行，所有现有功能行为完全一致，所有现有画册 `type='normal'`。

---

## 目标

数据库 `albums` 表 +3 列；Rust `Album` 结构、所有 SELECT 语句、所有 provider DSL 与前端 `Album` 接口同步扩展。普通画册创建、列表、重命名、删除、移动等操作行为**字节级**保持不变。

## 涉及文件清单

新增：
- `src-tauri/kabegame-core/src/storage/migrations/v013_album_type_and_sync.rs`

修改：
- `src-tauri/kabegame-core/src/storage/migrations/mod.rs` — 注册迁移、`LATEST_VERSION` 12 → 13
- `src-tauri/kabegame-core/src/storage/migrations/init.rs` — `CREATE TABLE albums` 同步追加三列
- `src-tauri/kabegame-core/src/storage/albums.rs` — `Album` 结构 + `album_from_storage_row` + 全部 `SELECT id, name, created_at, parent_id FROM albums` + `add_album` 的 INSERT
- `src-tauri/kabegame-core/src/providers/dsl/albums/albums_root_provider.json5`
- `src-tauri/kabegame-core/src/providers/dsl/images/gallery/albums/gallery_album_provider.json5`
- `src-tauri/kabegame-core/src/providers/dsl/images/gallery/albums/gallery_albums_router.json5`
- `src-tauri/kabegame-core/src/providers/dsl/images/vd/album/vd_albums_provider.json5`
- `apps/kabegame/src/stores/albums.ts` — `Album` 接口 + `normalizeAlbumRow`

不修改：
- `add_album`、`rename_album`、`delete_album`、`move_album` 的对外签名与行为。
- 任何前端组件（AlbumCard / Albums.vue / AlbumDetail.vue）。
- IPC 命令列表（`tauri::generate_handler!` 不增不减）。
- 任何 image_events 行为。

---

## 步骤

### 1. 新建迁移文件

**`src-tauri/kabegame-core/src/storage/migrations/v013_album_type_and_sync.rs`**

```rust
//! albums 表增加 type / sync_folder / folder_status 三列，用于本地文件夹同步画册。
//! 已有数据全部为 type='normal'，sync_folder / folder_status 为 NULL；行为不变。

use rusqlite::Connection;

pub fn up(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
ALTER TABLE albums ADD COLUMN type          TEXT NOT NULL DEFAULT 'normal';
ALTER TABLE albums ADD COLUMN sync_folder   TEXT;
ALTER TABLE albums ADD COLUMN folder_status TEXT;
"#,
    )
    .map_err(|e| format!("v013 alter albums: {e}"))?;
    Ok(())
}
```

说明：
- 不加 CHECK 约束（未来 `type` 集合可能扩展，避免迁移再写 CHECK 重建表）。
- 不加索引（Phase 3 决定是否对 `type` 加部分索引；v013 不动）。
- 不需要回填——`DEFAULT 'normal'` 由 ALTER 自动作用于已有行。

### 2. 注册迁移

**`src-tauri/kabegame-core/src/storage/migrations/mod.rs`**

- 在顶层 `mod` 列表追加 `mod v013_album_type_and_sync;`（紧跟 `mod v012_backfill_video_dimensions;` 之后）。
- `MIGRATIONS` 数组末尾追加：
  ```rust
  Migration {
      version: 13,
      name: "album_type_and_sync",
      up: v013_album_type_and_sync::up,
  },
  ```
- `pub const LATEST_VERSION: u32 = 12;` 改为 `= 13;`。

### 3. 同步全新库 DDL

**`src-tauri/kabegame-core/src/storage/migrations/init.rs`** 的 `CREATE TABLE albums` 段：

```sql
-- ───────────── albums ─────────────
CREATE TABLE albums (
    id            TEXT    PRIMARY KEY,
    name          TEXT    NOT NULL,
    created_at    INTEGER NOT NULL,
    parent_id     TEXT    REFERENCES albums(id) ON DELETE CASCADE,
    type          TEXT    NOT NULL DEFAULT 'normal',
    sync_folder   TEXT,
    folder_status TEXT
);
CREATE UNIQUE INDEX idx_albums_name_scoped
    ON albums(COALESCE(parent_id, ''), LOWER(name));
```

注意：不要改 `idx_albums_name_scoped`（递归创建子画册时也走 `<name>-<seg>` 规则，仍受唯一性保护——重名同 parent 直接报错，这是期望行为）。

### 4. Rust `Album` 结构与读取

**`src-tauri/kabegame-core/src/storage/albums.rs`** 顶部 `Album` 结构改为：

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all(serialize = "camelCase", deserialize = "snake_case"))]
pub struct Album {
    pub id: String,
    pub name: String,
    pub created_at: u64,
    pub parent_id: Option<String>,
    /// "normal" | "local_folder"（未来可扩展）
    #[serde(rename(serialize = "type"))]
    pub kind: String,
    /// 仅 kind=="local_folder" 时为 Some，存绝对路径
    pub sync_folder: Option<String>,
    /// 仅 kind=="local_folder" 时使用，JSON 字符串，Phase 2 起填充
    pub folder_status: Option<String>,
}
```

关键点：
- Rust 字段名用 `kind` 而非 `type`（避开关键字），通过 `#[serde(rename(serialize = "type"))]` 序列化为 `type`；反序列化时 `snake_case` 会让 `type` JSON key 默认映射到 `type` 字段——但 `type` 是 Rust 关键字所以字段叫 `kind`，反序列化方向需要显式 `#[serde(alias = "type")]`。最终注解形如：

  ```rust
  #[serde(rename(serialize = "type"), alias = "type")]
  pub kind: String,
  ```

- 默认值不在 serde 注解里设——Rust 侧总是从 DB 读，DB 列 NOT NULL DEFAULT 'normal'。

**`album_from_storage_row`** 改为读 7 列：

```rust
fn album_from_storage_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Album> {
    Ok(Album {
        id: row.get(0)?,
        name: row.get(1)?,
        created_at: row.get::<_, i64>(2)? as u64,
        parent_id: row.get(3)?,
        kind: row.get(4)?,
        sync_folder: row.get(5)?,
        folder_status: row.get(6)?,
    })
}
```

### 5. 改全部 SELECT 语句

将下列文件中所有 `SELECT id, name, created_at, parent_id FROM albums` 替换为 `SELECT id, name, created_at, parent_id, type, sync_folder, folder_status FROM albums`：

- `src-tauri/kabegame-core/src/storage/albums.rs`
  - 行 242 / 245（`get_albums`）
  - 行 268（`list_all_albums`）
  - 行 618（`get_album_by_id`）
- `src-tauri/kabegame-core/src/providers/dsl/images/gallery/albums/gallery_album_provider.json5` 的 sql
- `src-tauri/kabegame-core/src/providers/dsl/images/gallery/albums/gallery_albums_router.json5` 的 sql
- `src-tauri/kabegame-core/src/providers/dsl/images/vd/album/vd_albums_provider.json5` 的 sql（已含 `display` 计算列，追加三个新字段，保持 `display` 在末尾）

**不动**的 SELECT（只查特定列，不涉及结构化反序列化）：
- `SELECT name FROM albums WHERE id = ?1`（行 61）
- `SELECT EXISTS(...)` 全部
- `SELECT parent_id FROM albums WHERE id = ?1`（行 315）
- `SELECT id FROM albums WHERE LOWER(name) = ...`（行 367 / 647 / 655）
- `SELECT COUNT(*) FROM albums ...`（行 580-601）
- `SELECT a.id FROM albums a INNER JOIN sub ...`（递归 CTE）
- `v008` / `v009` 迁移文件里的 `SELECT id, name FROM albums`（已发生的迁移，不动）

### 6. `albums_root_provider.json5` 扩字段

```json5
{
    "namespace": "kabegame",
    "name": "albums_root_provider",
    "query": {
        "fields": [
            { "sql": "albums.id", "as": "id" },
            { "sql": "albums.name", "as": "name" },
            { "sql": "albums.created_at", "as": "created_at" },
            { "sql": "albums.parent_id", "as": "parent_id" },
            { "sql": "albums.type", "as": "type" },
            { "sql": "albums.sync_folder", "as": "sync_folder" },
            { "sql": "albums.folder_status", "as": "folder_status" }
        ],
    },
    "resolve": {
        "all": { "provider": "albums_all_provider" },
        "id_([^/]+)": {
            "provider": "albums_id_provider",
            "properties": { "album_id": "${capture[1]}" }
        }
    }
}
```

### 7. INSERT 语句

`add_album` 中：

```rust
conn.execute(
    "INSERT INTO albums (id, name, created_at, parent_id, type, sync_folder, folder_status)
     VALUES (?1, ?2, ?3, ?4, 'normal', NULL, NULL)",
    params![&id, name_trimmed, created_at as i64, parent_id],
)
```

也搜索 [storage/albums.rs](../../src-tauri/kabegame-core/src/storage/albums.rs) 内是否还有其它 `INSERT INTO albums`（`ensure_favorite_album` / `ensure_hidden_album` 两处）——它们当前 INSERT 4 列，依赖列默认值即可，**不需要改**（type 列有 DEFAULT 'normal'，sync_folder / folder_status 列默认 NULL）。为了未来阅读清晰，建议**仍**显式补全：

```rust
"INSERT INTO albums (id, name, created_at, parent_id, type, sync_folder, folder_status)
 VALUES (?1, ?2, ?3, NULL, 'normal', NULL, NULL)"
```

（取舍：DDL 默认值已经覆盖，不写也对；显式写一致性更好；二选一即可，不卡 review。）

### 8. 前端 Album 接口

**`apps/kabegame/src/stores/albums.ts`** 行 28：

```ts
export type AlbumKind = "normal" | "local_folder";

export interface FolderStatus {
  state: "ok" | "missing" | "denied" | "not_a_dir" | "io_error";
  message?: string;
  checkedAt?: number;
}

export interface Album {
  id: string;
  name: string;
  parentId: string | null;
  createdAt: number;
  type: AlbumKind;
  syncFolder: string | null;
  folderStatus: FolderStatus | null;
}
```

`normalizeAlbumRow` 改为：

```ts
function normalizeAlbumRow(a: Record<string, unknown>): Album {
  const createdAt =
    (a.created_at as number | undefined) ??
    (a.createdAt as number | undefined) ??
    0;
  const rawType = String(a.type ?? "normal");
  const type: AlbumKind = rawType === "local_folder" ? "local_folder" : "normal";
  const syncFolder = ((): string | null => {
    const v = a.sync_folder ?? a.syncFolder;
    return v == null ? null : String(v);
  })();
  const folderStatus = ((): FolderStatus | null => {
    const raw = a.folder_status ?? a.folderStatus;
    if (raw == null) return null;
    if (typeof raw === "object") return raw as FolderStatus;
    try {
      const parsed = JSON.parse(String(raw));
      return parsed && typeof parsed === "object" ? (parsed as FolderStatus) : null;
    } catch {
      return null;
    }
  })();
  return {
    id: String(a.id ?? ""),
    name: String(a.name ?? ""),
    parentId: parseParentId(a.parent_id ?? a.parentId),
    createdAt: typeof createdAt === "number" ? createdAt : Number(createdAt) || 0,
    type,
    syncFolder,
    folderStatus,
  };
}
```

注意：后端把 `folder_status` 存为 JSON **字符串**（Phase 2 起），所以前端要 `JSON.parse`。当前 Phase 1 所有现有行该列都是 NULL，会走 `raw == null` 短路返回 null。

---

## 验收清单

1. **类型检查**：
   - `bun check -c kabegame --skip cargo` — 必须通过。
   - `cargo check -p kabegame-core` — 必须通过（**不要** `cargo build`，按 CLAUDE.md 规则）。
   - `cargo check -p kabegame` — 必须通过。
2. **迁移升级路径**（手工）：
   - 准备一个 user_version=12 的 SQLite 文件（或直接用当前 dev 数据库），启动 app，`PRAGMA user_version` 应变为 13，新三列存在，所有旧画册 `type='normal'`。
   - `bun dev -c kabegame --data dev` 启动正常，画册页正常显示所有现有画册（卡片视觉无变化）。
3. **全新库**：
   - 删除 `data/` 后 `bun dev -c kabegame --data dev`，新建画册流程正常；`sqlite3 data/.../kabegame.db ".schema albums"` 应看到 7 列。
4. **回归**：
   - 创建画册、重命名、删除、移动、添加图片、移出图片、收藏切换——全部行为不变。
   - Gallery / VD provider 仍可正常返回 albums 列表（前端能拉到旧 albums.value）。

---

## 风险与回滚

- **风险**：v013 的 ALTER 在大表上会重写整表。`albums` 表行数通常 <1000，可忽略。
- **风险**：provider DSL 的 `fields` 改了，如果 cache 层按列签名缓存了结果，可能需要 bump 一次。**已确认**（参考 [cocs/provider-dsl/RULES.md](../../cocs/provider-dsl/RULES.md)）：provider 缓存按 path + 输入参数 key，列变更不需要手工失效。
- **回滚**：撤回该 commit；user_version 留在 13 但额外三列保留无害（旧 binary 读 albums 时不 SELECT 那三列，不会出错）。如果坚持要 downgrade schema，需手工 `CREATE TABLE albums_old ... INSERT SELECT ... DROP ... RENAME`，本计划不提供。

---

## 关键 grep 自检

完成后跑一遍：

```bash
# 不应再出现旧 4 列查询（除上一节列出的"不动"的少数）
rg "SELECT id, name, created_at, parent_id FROM albums" src-tauri apps

# DSL 中的 albums.* 字段引用都应能在 DDL 中找到
rg "albums\.(type|sync_folder|folder_status)" src-tauri/kabegame-core/src/providers
```
