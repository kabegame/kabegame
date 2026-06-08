# Layer 1 · 后端数据层

> 总览见 [plugin-metadata-migration.md](plugin-metadata-migration.md)。本层只动 **DB schema / 迁移 /
> 存储查询**，不碰 Rhai 引擎与前端。完成后向 Layer 2 暴露存储原语。

## 范围
- `image_metadata` 表加 `version` / `plugin_id`，去重改复合键。
- 写入接口 `insert_or_get_image_metadata_id` 复合键去重 + 冻结历史迁移 v011。
- 迁移运行器所需存储原语（扫描 + 就地写回/合并）。
- `metadata_full` 查询链（DSL provider + query.rs + Storage 方法）。

## 涉及文件
- `src-tauri/kabegame-core/src/storage/migrations/init.rs`
- `src-tauri/kabegame-core/src/storage/migrations/v016_image_metadata_version_plugin.rs`（新）
- `src-tauri/kabegame-core/src/storage/migrations/mod.rs`
- `src-tauri/kabegame-core/src/storage/migrations/v011_consolidate_image_metadata_and_failed_display_name.rs`（冻结）
- `src-tauri/kabegame-core/src/storage/images.rs`
- `src-tauri/kabegame-core/src/providers/dsl/images/images_metadata_full_provider.json5`（新）
- `src-tauri/kabegame-core/src/providers/dsl/images/images_id_provider.json5`
- `src-tauri/kabegame-core/src/providers/query.rs`

## 步骤

### 1.1 schema：image_metadata 增列 + 复合去重
- `init.rs:42`（新库 schema）：`image_metadata` 改为
  `id` / `data TEXT NOT NULL` / `content_hash TEXT NOT NULL`（**去掉单列 UNIQUE**） /
  `version INTEGER NOT NULL DEFAULT 0` / `plugin_id TEXT NOT NULL DEFAULT ''`，并加复合唯一索引
  `CREATE UNIQUE INDEX idx_image_metadata_dedup ON image_metadata(plugin_id, version, content_hash);`
  （该索引前缀同时服务迁移扫描 `WHERE plugin_id=? AND version<?`）。

### 1.2 v016 迁移（表重建 + 回填）
- 新建 `v016_image_metadata_version_plugin.rs`。因 `content_hash UNIQUE` 是**内联列约束**，SQLite 无法
  直接 DROP，需**表重建**（参照 v011 / SQLite 12-step；务必 `PRAGMA foreign_keys=OFF` 包裹，因
  `images.metadata_id`、`task_failed_images.metadata_id` 外键引用本表）：
  1. `ALTER TABLE image_metadata RENAME TO image_metadata_old;`
  2. 按 1.1 新 schema `CREATE TABLE image_metadata (...)` + 复合唯一索引。
  3. `INSERT INTO image_metadata (id, data, content_hash, version, plugin_id)
     SELECT id, data, content_hash, 0,
       COALESCE(
         (SELECT i.plugin_id FROM images i WHERE i.metadata_id = image_metadata_old.id LIMIT 1),
         (SELECT f.plugin_id FROM task_failed_images f WHERE f.metadata_id = image_metadata_old.id LIMIT 1),
         '')
     FROM image_metadata_old;`（**保留原 id** 维持外键；version=0；plugin_id 从引用图片/失败图片回填，
     使现有数据可被定位并从 v1.rhai 起迁移）。
  4. `DROP TABLE image_metadata_old;` → `PRAGMA foreign_key_check;`。
- `mod.rs`：注册 v016，`LATEST_VERSION = 16`。

### 1.3 写入接口复合键去重
- `insert_or_get_image_metadata_id(conn, data, plugin_id, version)`（`images.rs:171`）：
  `INSERT OR IGNORE INTO image_metadata (data, content_hash, plugin_id, version) VALUES (...)`（依赖复合
  唯一索引去重），命中已存在则 `SELECT id WHERE plugin_id=? AND version=? AND content_hash=?` 回查。
- `Storage::insert_or_get_image_metadata_row(value, plugin_id, version)`（`:232`）同步加参。

### 1.4 冻结历史迁移 v011
- v011（`v011_consolidate...rs:1,25` 现 `use` 并调用 `insert_or_get_image_metadata_id`）**不得依赖会变化
  的接口**：把它当时所需的去重写入**内联进 v011 自身**（按 v011 时点 schema：`INSERT OR IGNORE ...
  (data, content_hash)` + 回查 id，自带 sha256），删除对 `crate::storage::images::
  insert_or_get_image_metadata_id` 的 `use`。历史迁移自此与运行期接口解耦（v016 重建时会回填这些行的
  plugin_id）。

### 1.5 迁移运行器存储原语（供 Layer 2 调用）
在 `images.rs` 新增（纯 SQL，事务内执行）：
- `Storage::metadata_rows_below_version(plugin_id: &str, m: u32) -> Result<Vec<(i64, String, u32)>>`：
  `SELECT id, data, version FROM image_metadata WHERE plugin_id=? AND version<?`。
- `Storage::writeback_migrated_metadata_row(row_id, plugin_id, new_version, new_data)`：单行就地写回，
  自动迁移所有引用该行的图片：
  - 计算 `new_hash`；若存在**另一**行命中复合键 `(plugin_id, new_version, new_hash)`（目标行 T）：
    `UPDATE images SET metadata_id=T WHERE metadata_id=row_id`（及 task_failed_images 同理）→ `DELETE`
    当前行（合并去重）。
  - 否则 `UPDATE image_metadata SET data=?, content_hash=?, version=? WHERE id=row_id`。
  - 返回是否发生变更（供 Layer 2 决定是否发事件）。

### 1.6 metadata_full 查询链
- 新 DSL provider `images_metadata_full_provider.json5`：仿 `images_metadata_provider` 的 LEFT JOIN
  `image_metadata`，`fields` 选 `im.data AS data`、`im.version AS version`（含 `im.plugin_id`/
  `im.content_hash` 等其它字段），`limit 1`。
- `images_id_provider.json5` 的 `resolve` 增加 `"metadata_full": { "provider":
  "images_metadata_full_provider" }`（与现有 `"metadata"` 并列）→ 路径 `images://id_{id}/metadata_full`。
- `query.rs`：仿 `image_metadata_at`（`:327`）新增 `image_metadata_full_at(image_id)
  -> Option<{ version: u32, data: Value, ... }>`（读 `images://id_{id}/metadata_full`，`data` 仍用
  `parse_image_metadata_json` 解析）。
- `Storage::get_image_metadata_full(image_id) -> Option<{ version, data, ... }>`（供 Layer 2 命令包装）。

## 暴露给上层的接口
- `insert_or_get_image_metadata_id` / `insert_or_get_image_metadata_row`（加 plugin_id/version）
- `metadata_rows_below_version` / `writeback_migrated_metadata_row`
- `get_image_metadata_full` / `image_metadata_full_at`

## 本层验证
- `bun check -c kabegame --skip vue`（cargo check）通过。
- v15 旧库启动 → `PRAGMA user_version=16`；`image_metadata` 已重建：无单列 UNIQUE、有复合唯一索引
  `(plugin_id, version, content_hash)`、`version`(0)、plugin_id 已按引用图片/失败图片回填、原 `id` 不变
  （`PRAGMA foreign_key_check` 通过、详情区 metadata 仍可读）。
- 单测/手测 `insert_or_get_image_metadata_id`：同插件+同内容+同 version → 复用一行；同内容不同 version →
  两行并存。
- 单测 `writeback_migrated_metadata_row`：命中已有复合键 → 旧行删除、图片 repoint；否则就地 UPDATE。
