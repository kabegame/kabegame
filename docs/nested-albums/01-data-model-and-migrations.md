# 数据模型与 SQLite 迁移

## 现状

当前 `albums` 为扁平结构：`id`、`name`、`created_at`；`CREATE UNIQUE INDEX idx_albums_name_ci ON albums(LOWER(name))` 保证全局名称不区分大小写唯一。图片通过 `album_images` 关联 `album_id`。实现见 `src-tauri/core/src/storage/albums.rs`、建表见 `src-tauri/core/src/storage/mod.rs`。

## 已定方案（仅扩展 `albums`）

- **只增加一列 `parent_id`**：`TEXT`，可为 `NULL`。`NULL` 表示根级画册（与当前「全部在根」语义一致）。
- **不引入**单独的「文件夹」实体；子画册仍是 `albums` 表中的行，通过 `parent_id` 挂到父画册 `id`。
- **`Album` 结构体**：序列化字段名与其它 API 保持 camelCase 约定时，对应 `parent_id` / `parentId`。

## 名称唯一性

- 规则与现在「同一层级内不能重名」一致，只是层级由 **`parent_id` 界定**：
  - **同一 `parent_id` 下** `name` 不冲突（仍建议沿用现有 **不区分大小写** 比较，与 `idx_albums_name_ci` 心智一致）。
  - **根目录**：`parent_id IS NULL`，互不冲突的画册之间名称仍全局唯一——与旧版「全表 name 唯一」等价。
- **实现**：删除旧的全局唯一索引 `idx_albums_name_ci`，改为在 **`(parent_id, LOWER(name))`** 上建唯一约束（或等价唯一索引）。应用层 `add_album` / `rename_album` 中的重名检测改为带 **`parent_id` 条件**（根级条件为 `parent_id IS NULL`）。

### SQLite 实现注意

SQLite 中 `UNIQUE` 对 **`NULL` 的语义**：多行 `parent_id IS NULL` 在部分写法下可能与「根级也要唯一」冲突处理有关，需在实现迁移时验证。若唯一索引无法单独表达「仅 `NULL` 父级一组内唯一」，可用例如：**部分唯一索引**（`WHERE parent_id IS NULL` 与 `WHERE parent_id IS NOT NULL` 各一条）、或根级用约定占位、或在事务内严格用与索引一致的查询校验。以最终迁移脚本与 `cargo test` / 手工验证为准。

## 删除策略：级联删除「整棵文件夹」

- 删除某一画册 = 删除**该节点及其全部子孙画册**（递归），语义上等于删掉整个子树文件夹。
- 每个被删画册在 `album_images` 中的行需一并清理；实现上可用 **自引用外键 `parent_id` → `albums(id)` 的 `ON DELETE CASCADE`**（若启用 SQLite 外键），或在应用层 **递归收集 id 后批量删除** `album_images` 与 `albums`（顺序：先子后父或先断关联再删行，避免孤儿数据）。
- 系统画册（收藏夹等）**不可删除**的业务规则不变，见 [00-product-decisions.md](./00-product-decisions.md) §5；与级联策略不矛盾：禁止删的 id 根本不进入删除路径。

## 其它约束

- **移动 / 改父级**：更新 `parent_id` 时必须校验**不成环**（不能把祖先挂到自己子孙下）。
- **收藏夹**：可作为子节点、可有子画册；不可删除。

## 迁移（TODO）

- 在 **`src-tauri/core/src/storage/migrations/`** 下新增版本化迁移（如 `v004_album_parent_id.rs`），并在 `migrations/mod.rs` 的 `MIGRATIONS` 与 **`LATEST_VERSION`** 中注册。
- 迁移内容应包括：
  - `ALTER TABLE albums ADD COLUMN parent_id TEXT`（或等价；若 SQLite 版本限制需表重建则按项目既有 `perform_complex_migrations` 风格处理）；
  - 已有行 **`parent_id` 全部为 `NULL`**；
  - 替换名称唯一索引为 **`(parent_id, LOWER(name))`** 方案（见上文）；
  - 按需增加 **`parent_id` 普通索引**（按父列子画册、树遍历）。
- 新建库路径：在 `storage/mod.rs` 中 **`CREATE TABLE albums`** 的初始定义与索引需与迁移后的最终 schema 一致，且 **`mark_as_latest`** 仍跳过迁移时，新库已含 `parent_id` 与新唯一约束。

## 关联影响

- 所有「按名称查找画册」「重名检测」从全表改为 **`parent_id` + name**。
- 全表 `get_albums` 若仍返回扁平列表，需增加 **`parent_id` 字段**供前端建树；或后续提供按父筛选的查询。
