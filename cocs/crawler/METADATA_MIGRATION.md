# 插件 Metadata 迁移流程

本文记录 crawler 插件图片 metadata 版本化迁移的运行链路、约束与排查入口。

## 目标

插件写入的图片 metadata 会被 `templates/description.ejs`、图片详情面板、MCP / provider 路径消费。插件升级后如果 metadata 结构变化，历史图片不能依赖一次性数据库大迁移，而应由插件随包提供增量迁移脚本。

## 包结构与脚本契约

插件 `.kgpg` 可包含：

```text
metadata_migrations/
  v1.rhai
  v2.rhai
```

- 文件名格式固定为 `metadata_migrations/v{N}.rhai`，`N` 为从 `1` 开始的正整数。
- 每个脚本必须定义 `fn migrate(metadata)`。
- `metadata` 入参和返回值都是 JSON 字符串；脚本内可用 `parse_json(text)` 与 `to_json(value)` 做结构化读写。
- 版本必须连续。运行时只执行从 `v1.rhai` 开始的连续版本；中间断档后面的版本不会执行。
- 历史迁移冻结约定：已经发布过的 `vN.rhai` 不应再改语义。需要修正历史结构时，追加新的 `v{N+1}.rhai`，让所有用户按同一链路收敛。

## 写入与去重

Rhai 入口：

- `download_image(url, #{ metadata, metadata_version })`
- `create_image_metadata(metadata, #{ version })`

`metadata_version` / `version` 必须是纯自然数，缺省为 `0`。写入统一进入 `image_metadata` 表，并按 `(plugin_id, version, content_hash)` 复合键去重。`content_hash` 由 JSON 文本计算，同一插件、同一版本、相同内容复用同一行。

`plugin_id` 和 `version` 落在 `image_metadata` 上，而不是 `images` 上，原因是 metadata 行可被多张图片、失败重试记录或后续合并引用；版本属于 metadata 结构本身，不属于单张图片。图片列表只携带 `metadata_id` 与派生的 `metadata_version`，用于前端缓存失效。

## 执行流程

1. 插件解析阶段从 ZIP 读取 `metadata_migrations/v{N}.rhai`，解析版本号并挂到 `Plugin.metadata_migrations`。
2. 插件安装 / 更新成功后触发后台迁移；应用启动加载已安装插件时也会触发。
3. 运行器计算从 `v1` 开始的最新连续版本 `latest`。
4. 查询当前插件 `version < latest` 的 metadata 行。
5. 每行从当前版本下一版开始逐版调用 `migrate(metadata)`。
6. 某一版编译或执行失败时，该行停止在已成功版本；下一次安装、更新或启动会重试。
7. 写回时如果目标 `(plugin_id, version, content_hash)` 已有行，会把 `images.metadata_id` 与 `task_failed_images.metadata_id` 合并到既有行并删除重复行。
8. 有实际变更时发出 `images-change`，`reason = "metadata-migrate"`，`plugin_ids = [plugin_id]`。事件作用域只覆盖受影响插件，前端据此刷新相关 metadata 缓存。

## 关键路径

L1 存储 / 迁移：

- `src-tauri/kabegame-core/src/storage/migrations/init.rs`：`image_metadata` 结构与 `(plugin_id, version, content_hash)` 唯一索引。
- `src-tauri/kabegame-core/src/storage/migrations/v016_image_metadata_version_plugin.rs`：旧表补 `plugin_id` / `version` 的迁移。
- `src-tauri/kabegame-core/src/storage/images.rs`：metadata 写入、读取、迁移行查询、合并写回、GC。

L2 插件 / Rhai：

- `src-tauri/kabegame-core/src/plugin/mod.rs`：解析 `.kgpg` 内 `metadata_migrations/v{N}.rhai`，插件安装 / 更新后调度迁移。
- `src-tauri/kabegame-core/src/plugin/rhai.rs`：`download_image` 的 `metadata_version`，`create_image_metadata(map, #{ version })`。
- `src-tauri/kabegame-core/src/plugin/metadata_migration.rs`：迁移运行器、连续版本判断、`parse_json` / `to_json`、`metadata-migrate` 事件。

L3 查询 / 前端：

- `src-tauri/kabegame-core/src/providers/dsl/images/images_metadata_full_provider.json5`：`images://id_{id}/metadata_full` 的完整 metadata 行路径。
- `src-tauri/kabegame-core/src/providers/dsl/images/images_id_provider.json5`：图片 id 路由挂载 `metadata_full`。
- `src-tauri/kabegame/src/commands/image.rs`、`src-tauri/kabegame/src/commands_core/image.rs`：`get_image_metadata` / `get_image_metadata_full` 命令。
- `packages/core/src/components/common/ImageDetailContent.vue`：详情区读取 `get_image_metadata_full` 并把 `metadata_version` 交给模板渲染。
- `packages/core/src/composables/useImageMetadataCache.ts`、`apps/kabegame/src/composables/useImagesChangeRefresh.ts`：metadata 缓存与 `metadata-migrate` 刷新原因。

## 排查要点

- 新图片仍是旧结构：检查插件脚本是否在 `download_image` 传了正确的 `metadata_version`，或 `create_image_metadata` 是否传了 `#{ version: N }`。
- 历史图片没有迁移：检查 `metadata_migrations` 是否从 `v1.rhai` 连续命名，`fn migrate(metadata)` 是否返回 JSON 字符串。
- 部分行未升级：查看日志里的 `[metadata-migration]` 编译 / 执行错误；失败行会在下次安装、更新或启动重试。
- 详情区仍显示旧内容：确认列表行的 `metadata_version` 是否变化，以及前端是否收到 `reason = "metadata-migrate"` 且 `plugin_ids` 包含该插件。
