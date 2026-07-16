# 插件 Metadata 迁移流程

本文记录 crawler 插件图片 metadata 迁移的运行链路、约束与排查入口。

## 目标

插件写入的图片 metadata 会被 `templates/description.ejs`、图片详情面板、MCP / provider 路径消费。插件升级后如果 metadata 结构变化，历史图片不能依赖一次性数据库大迁移，而应由插件随包提供**单一迁移脚本**，由应用按**插件版本**门控增量收敛。

## 包结构与脚本契约

插件在 `package.json` 用 `kbMetadataMigration`（单字符串路径）声明唯一迁移脚本，应用不做命名/下标遍历：

```json
{ "kbMetadataMigration": "metadata_migrations/migrate.js" }
```

- 脚本必须是 `.js` 自包含 ES module，`export function migrate(input)`（允许 `async`）。
- `input` 入参和返回值都是 JSON 字符串；脚本内用原生 `JSON.parse` / `JSON.stringify` / `RegExp` / `Date` 做结构化读写。
- 运行环境为**裸 `deno_core` JsRuntime**：无扩展、无 ops、无宿主桥，`import` 会失败（脚本必须自包含）。
- 脚本必须**幂等、一步到位**：靠 metadata 内自维护的 `schema` 标记识别输入是哪个历史结构，把任意历史结构直接迁到当前结构；已是当前结构时原样返回。不要在脚本里做「逐版本链式」变换。
- 旧的 `kbMetadataMigrations` 数组键已停止支持：core 加载完全不解析；CLI `plugin pack` 遇到即报可读错误。

## packed 插件版本

`image_metadata.plugin_version` 列记录「图片下载时的插件版本」，为 u32 packed 编码：每字节一段，`3.4.1` → `0x00030401`（`(major<<16)|(minor<<8)|patch`），直接比较大小即可比较版本先后。因此插件版本必须是 `a.b.c` 且每段 ≤255（加载/打包时校验，见 `pack_plugin_version`）。

该列**由应用维护，插件不可读写**：

- 写入路径（`Kabegame.downloadImage` / `Kabegame.createImageMetadata`、webview `ctx.downloadImage`）不再接受任何版本参数，应用自动盖当前运行插件的 packed 版本；V8 与 WebView 都从运行中 `Task.params.plugin_version()` 派生。
- 迁移 runner 成功迁移一行后，把该行 `plugin_version` 盖为当前插件 packed 版本。
- 无插件语境的写入（folder-sync、surf）恒为 0，永不参与迁移。
- 插件对自己数据结构的版本理解只放在 metadata 内（`schema` 字段自检）。

## 写入与去重

写入统一进入 `image_metadata` 表，按 `(plugin_id, plugin_version, data)` 去重合并。`plugin_id` / `plugin_version` 落在 `image_metadata` 上而不是 `images` 上：metadata 行可被多张图片、失败重试记录或后续合并引用。图片列表只携带 `metadata_id` 与派生的 `plugin_version`（前端 `pluginVersion`），用于前端 metadata 缓存失效。

## 执行流程

1. 插件解析阶段读取 `kbMetadataMigration` 脚本源码挂到 `Plugin.metadata_migration`，并把 `Plugin.version` pack 成 `Plugin.version_packed`。
2. 插件安装 / 更新成功后触发后台迁移；应用启动加载已安装插件（`refresh_plugins` → `install_plugin_from_kgpg`）同样走该路径，所以每次启动都会检查（无待迁移行时一条 SELECT 早退）。
3. 运行器查询当前插件 `plugin_version < version_packed` 的 metadata 行；为空直接结束。
4. 装载一次 `migrate` 导出，逐行调用 `migrate(data)`；成功则写回并把该行 `plugin_version` 盖为 `version_packed`。
5. 某行执行失败只跳过该行（版本不动，下次触发重试）；脚本装载失败则整体报错。
6. 写回时如果目标 `(plugin_id, plugin_version, data)` 已有行，会把 `images.metadata_id` 与 `task_failed_images.metadata_id` 合并到既有行并删除重复行。
7. 有实际变更时发出 `images-change`，`reason = "metadata-migrate"`，`plugin_ids = [plugin_id]`。事件作用域只覆盖受影响插件，前端据此刷新相关 metadata 缓存。

历史切换说明：`v021_image_metadata_plugin_version` 一次性把旧 `version` 计数器列改名为 `plugin_version` 并全部归 0（旧值作废），之后由迁移 runner 按上述流程收敛；脚本幂等保证重跑安全。

## 关键路径

L1 存储 / 迁移：

- `src-tauri/kabegame-core/src/storage/migrations/init.rs`：`image_metadata` 结构与 `(plugin_id, plugin_version)` 去重索引。
- `src-tauri/kabegame-core/src/storage/migrations/v021_image_metadata_plugin_version.rs`：列改名 + 归 0 的一次性迁移。
- `src-tauri/kabegame-core/src/storage/images.rs`：metadata 写入（`insert_image_metadata_row`）、迁移行查询（`metadata_rows_below_plugin_version`）、合并写回（`writeback_migrated_metadata_row`）、GC。

L2 插件 / V8：

- `src-tauri/kabegame-core/src/plugin/mod.rs`：`kbMetadataMigration` 解析、`pack_plugin_version`、安装 / 启动后调度迁移。
- `src-tauri/kabegame-core/src/plugin/v8/ops.rs`：写入自动盖章（从 `Task.params.plugin_version()` 读取）。
- `src-tauri/kabegame-core/src/plugin/metadata_migration.rs`：裸 `JsRuntime` 迁移运行器（side ES module + `migrate` 导出）与 `metadata-migrate` 事件；CLI 不再加载 V8，也不再提供 `plugin run migrate`。

L3 查询 / 前端：

- `src-tauri/kabegame-core/src/providers/dsl/images/images_metadata_full_provider.json5`：`images://id_{id}/metadata_full` 的完整 metadata 行路径。
- `packages/kabegame-core/src/components/common/ImageDetailContent.vue`：详情区读取 `get_image_metadata_full` 并把 `plugin_version` 交给模板渲染。
- `packages/kabegame-core/src/composables/useImageMetadataCache.ts`、`apps/kabegame/src/composables/useImagesChangeRefresh.ts`：metadata 缓存（key 含 `pluginVersion`）与 `metadata-migrate` 刷新原因。

## 排查要点

- 历史图片没有迁移：确认 `kbMetadataMigration` 指向 `.js` 且 `export function migrate(input)` 返回 JSON 字符串；确认插件版本可被 pack（`a.b.c`、每段 ≤255）。
- 部分行未升级：查看日志里的 `[metadata-migration]` 装载 / 执行错误；失败行会在下次安装、更新或启动重试。
- 迁移反复执行：脚本不幂等——已是当前结构时必须原样返回（迁移后行会盖成当前 packed 版本，正常不会再被选中；只有插件版本再次升级才会重跑）。
- 详情区仍显示旧内容：确认列表行的 `pluginVersion` 是否变化，以及前端是否收到 `reason = "metadata-migrate"` 且 `plugin_ids` 包含该插件。
