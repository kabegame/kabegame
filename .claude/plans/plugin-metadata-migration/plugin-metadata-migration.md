# 插件元数据迁移（metadata_migrations）总览

> 拆分为四层执行，按 **数据层 → 引擎接口层 → 前端层 → 文档同步层** 顺序实施：
> - [Layer 1 · 后端数据层](plugin-metadata-migration-phase1-data.md) —— schema/迁移/去重/存储查询
> - [Layer 2 · 引擎接口层](plugin-metadata-migration-phase2-engine.md) —— kgpg 解析/迁移引擎+运行器/Rhai 接口/触发/命令/事件
> - [Layer 3 · 前端层](plugin-metadata-migration-phase3-frontend.md) —— metadata_full 接入/EJS/事件刷新
> - [Layer 4 · 文档同步层](plugin-metadata-migration-phase4-docs.md) —— `apps/docs/` + `docs/` + `cocs/` + CHANGELOG

## Context

爬虫插件入库的图片 metadata 是插件作者定义的自由结构（存于 `image_metadata.data` 文本列，按 `content_hash`
去重、被多张图片共享）。当作者迭代 metadata schema 时，老图片仍是旧结构，导致 `description.ejs` 详情模板
要么显示错乱、要么必须永久兼容所有历史格式。

本功能让插件携带一组 `metadata_migrations/v{N}.rhai` 升级脚本：**插件被成功载入应用时**（安装/更新 +
每次启动载入），自动把该插件名下 metadata 从其当前 version 沿连续版本号逐级迁移到最新。迁移以「字符串进、
字符串出」运行；失败则停在该 version、下次重试，让作者修脚本后再成功。模板可读取 `metadata_version`
以兼容仍未迁移成功的老数据。

## 核心设计决策（贯穿三层）

1. **version / plugin_id 放在 `image_metadata` 表**（新增两列），**不动 `images` 表**。
   - 快速定位：`WHERE plugin_id = ? AND version < M` 扫 metadata 行，无需 join images。
   - 天然按内容迁移：metadata 行被多图共享，就地 UPDATE 一行即同时迁移所有引用它的图片；version 是
     metadata 内容的内在属性，无需逐图记录。
2. **去重键改复合键 `(plugin_id, version, content_hash)`**：去掉 `content_hash` 单列 UNIQUE。同一
   content_hash 可在不同 version / 不同插件下并存为多行。旧插件无 version 概念时（version=0）按插件+内容
   去重不受影响；迁移产生的新内容按「插件+新版本+新哈希」独立去重。
3. **空 metadata（图片 `metadata_id IS NULL`）**：无 metadata 行即无可迁移对象，天然跳过、不参与。
4. **执行时机**：安装/更新 + 每次启动载入（插件进入已安装缓存即触发；全为最新时查询零命中近零成本）。
5. **历史迁移冻结**：改 `insert_or_get_image_metadata_id` 签名时，老迁移（v011）不得依赖它——内联其当时
   逻辑。见 Layer 1。
6. **version 暴露走专用路径而非 gallery join**：新增 `images://id_{id}/metadata_full` +
   `get_image_metadata_full` 命令，返回 `{ version, data, ... }`，仅详情/EJS 迁移使用。
7. **迁移完成事件精准化**：每个插件迁移跑完只发**一次** `images-change`，载荷
   `{ reason:"metadata-migrate", pluginIds:[该插件] }`（**不**枚举 imageIds）。前端按 reason+plugin 作用域
   决定是否刷新。

## 迁移脚本契约

- 包内路径 `metadata_migrations/v{N}.rhai`，`N` 为正整数。
- 每脚本定义 `fn migrate(metadata)`：入参为上一版本 metadata **字符串**（`image_metadata.data` 原文），
  返回新版本 metadata **字符串**。最佳实践：脚本读/写 `version` 字段对账，版本不符就 `throw`（视为失败）。
- 连续性：从「行当前 `version` + 1」起找 `v{N}.rhai`，缺号即停（后续不执行）。

## 层间接口契约

- **L1 → L2**：存储原语
  - `Storage::metadata_rows_below_version(plugin_id, m) -> Vec<(id, data, version)>`
  - `Storage::writeback_migrated_metadata_row(row_id, plugin_id, new_version, new_data)`（内含命中复合键
    时的合并/repoint/删除逻辑）
  - `insert_or_get_image_metadata_id(conn, data, plugin_id, version)` /
    `Storage::insert_or_get_image_metadata_row(value, plugin_id, version)`
- **L1 → L2/L3**：`Storage::get_image_metadata_full(image_id) -> Option<{ version, data, ... }>`
- **L2 → L3**：Tauri 命令 `get_image_metadata_full`；事件
  `images-change{ reason:"metadata-migrate", pluginIds }`

## 文档（Layer 4 统一补）

见 [Layer 4 · 文档同步层](plugin-metadata-migration-phase4-docs.md)：`apps/docs/`（Starlight）+
`docs/RHAI_API.md`/`docs/PLUGIN_FORMAT.md` + `cocs/crawler/METADATA_MIGRATION.md`(+`cocs/README.md` 索引)
+ `CHANGELOG.md`，统一在代码三层落定后同步。

## 端到端验证（全部完成后）

见各层文件 Verification；端到端串测：旧插件爬图（version=0）→ 装带 `v1/v2.rhai` 新插件 → 行 version 升到
2、多图同步、命中已有 hash 合并去重、收到一次 `metadata-migrate` 事件、插件过滤画廊刷新、详情 EJS 更新；
失败路径（v2 throw → 停在 v1，修好重装 → 升 v2）；连续性（缺 v2 → 只迁到 v1）。`bun check -c kabegame`
做类型校验，不跑完整 build。
