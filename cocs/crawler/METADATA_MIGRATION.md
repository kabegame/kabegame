# 插件 Metadata 迁移流程

本文记录 crawler 插件图片 metadata 迁移的运行链路、约束与排查入口。

## 目标

插件写入的图片 metadata 会被 `templates/description.ejs`、图片详情面板、MCP / provider 路径消费。插件升级后如果 metadata 结构变化，历史图片不能依赖一次性数据库大迁移，而应由插件随包提供**单一迁移脚本**，由应用按**插件版本**门控增量收敛。

## 包结构与脚本契约

插件在 `package.json` 用 `kbMetadataMigration`（单字符串路径）声明唯一迁移脚本，应用不做命名/下标遍历：

```json
{ "kbMetadataMigration": "metadata_migrations/migrate.js" }
```

- 脚本必须是 `.js` 自包含 ES module，可导出 `migrate` 与 `provideLabels`（两者均允许 `async`，至少导出一个）。
- `export function migrate(input)` 可选；`input` 与返回值都是 JSON 字符串。缺失时按恒等迁移处理。
- `export function provideLabels(input)` 可选；只在 `migrate` 成功后调用，入参是迁移后的 JSON 字符串，返回 `KabegameLabelInput[]`。无 `migrate` 时直接使用原始字符串。
- 标签 `key` 必须符合 `[a-zA-Z0-9_\-() ]+`（空格不在首尾、不连续）且不超过 64 字节；`category` 是 `/` 分隔的父级 key，缺省为插件 id；`name` 只在首次创建标签时使用。不合规项记录警告后丢弃。
- 运行环境为**裸 `deno_core` JsRuntime**：无扩展、无 ops、无宿主桥，`import` 会失败（脚本必须自包含）。
- 脚本必须**幂等、一步到位**：靠 metadata 内自维护的 `schema` 标记识别输入是哪个历史结构，把任意历史结构直接迁到当前结构；已是当前结构时原样返回。不要在脚本里做「逐版本链式」变换。
- 旧的 `kbMetadataMigrations` 数组键已停止支持：core 加载完全不解析；CLI `plugin pack` 遇到即报可读错误。

## packed 插件版本

`metadata.plugin_version` 列（原 `image_metadata` 表，v024 起改名为 `metadata`；`image_metadata` 现为图片原生元数据表）记录「图片下载时的插件版本」，为 u32 packed 编码：每字节一段，`3.4.1` → `0x00030401`（`(major<<16)|(minor<<8)|patch`），直接比较大小即可比较版本先后。因此插件版本必须是 `a.b.c` 且每段 ≤255（加载/打包时校验，见 `pack_plugin_version`）。

该列**由应用维护，插件不可读写**：

- 写入路径（`Kabegame.downloadImage` / `Kabegame.createImageMetadata`、webview `ctx.downloadImage`）不再接受任何版本参数，应用自动盖当前运行插件的 packed 版本；V8 与 WebView 都从运行中 `Task.params.plugin_version()` 派生。
- 迁移 runner 处理一行后，无论脚本装载、`migrate` 或 `provideLabels` 是否成功，都把该行 `plugin_version` 盖为当前插件 packed 版本；失败时写回原 data。
- 无插件语境的写入（folder-sync、surf）恒为 0，永不参与迁移。
- 插件对自己数据结构的版本理解只放在 metadata 内（`schema` 字段自检）。

## 写入与去重

写入统一进入 `metadata` 表，按 `(plugin_id, plugin_version, data)` 去重合并。`plugin_id` / `plugin_version` 落在 `metadata` 上而不是 `images` 上：metadata 行可被多张图片、失败重试记录或后续合并引用。图片列表只携带 `metadata_id` 与派生的 `plugin_version`（前端 `pluginVersion`），用于前端 metadata 缓存失效。

## 执行流程

1. 插件解析阶段读取 `kbMetadataMigration` 脚本源码挂到 `Plugin.metadata_migration`，并把 `Plugin.version` pack 成 `Plugin.version_packed`。
2. 插件安装 / 更新成功后触发后台迁移；应用启动加载已安装插件（`refresh_plugins` → `install_plugin_from_kgpg`）同样走该路径，所以每次启动都会检查（无待迁移行时一条 SELECT 早退）。CLI 本进程不调度 metadata 迁移；被跳过的迁移由应用下次启动刷新插件时按版本门控补跑。`MetadataMigrationService` 保证同一插件只有一个 runner；运行中再次 refresh / install 时覆盖保存最新 `Plugin` 到 `pending`，当前轮完成后续跑一轮。
3. 运行器查询当前插件 `plugin_version < version_packed` 的 metadata 行；`data` 字段 trim 后为空串或字面量 `"null"` 视为没有 metadata，直接排除在外，不跑迁移脚本；结果为空直接结束。
4. 有待处理行时先登记 `{ pluginId, total, processed, startedAtMs }` 并发送 `busy-tasks-change`；装载一次脚本，两个导出都缺失才算装载失败，缺 `migrate` 按恒等处理。
5. 逐行调用 `migrate(data)`；成功后才调用 `provideLabels(migrated)`。标签先挂到当前 metadata 行引用的全部图片，然后才写回/合并 metadata，避免重定向后丢失原引用集。
6. 无论装载或行级执行是否成功，都把 `plugin_version` 盖为 `version_packed`；失败时写回原 data，不在下次启动无限重试。
7. 写回时如果目标 `(plugin_id, plugin_version, data)` 已有行，会把 `images.metadata_id` 与 `task_failed_images.metadata_id` 合并到既有行并删除重复行。
8. 每行回写完成后 `processed += 1`。成功、错误或 guard 异常退出都会从运行态移除，并发送
   `metadata-migration-finished { pluginId, total, processed, error }`；成功静默，失败由前端 toast。
9. 标签成员有变化时聚合发出 `album-images-change`；metadata 有实际变更时，在事务内取出受影响图片，
   按最终 `metadataId + pluginVersion` 分组发 `image-changed`，再发 `images-change`（`reason = "change"`）对账视图成员与排序。

前端通过聚合 `get_busy_tasks_snapshot.metadataMigrations` 每 500ms 拉取运行态，在忙碌面板中按插件显示
图标、名称、百分比与 `processed / total`，不提供取消按钮。任务从快照消失即移除卡片；finished 事件
只补失败提示与 `lastError`，成功不会打扰启动流程。

历史切换说明：`v021_image_metadata_plugin_version` 一次性把旧 `version` 计数器列改名为 `plugin_version` 并全部归 0（旧值作废），之后由迁移 runner 按上述流程收敛；脚本幂等保证重跑安全。

## 关键路径

L1 存储 / 迁移：

- `src-tauri/kabegame-core/src/storage/migrations/init.rs`：`metadata` 表（v024 前名为 `image_metadata`）结构与 `(plugin_id, plugin_version)` 去重索引。
- `src-tauri/kabegame-core/src/storage/migrations/v021_image_metadata_plugin_version.rs`：列改名 + 归 0 的一次性迁移。
- `src-tauri/kabegame-core/src/storage/images.rs`：metadata 写入（`insert_metadata_row`）、迁移行查询（`metadata_rows_below_plugin_version`）、合并写回（`writeback_migrated_metadata_row`）、GC。

L2 插件 / V8：

- `src-tauri/kabegame-core/src/plugin/mod.rs`：`kbMetadataMigration` 解析、`pack_plugin_version`、安装 / 启动后调度迁移。
- `src-tauri/kabegame-core/src/plugin/v8/ops.rs`：写入自动盖章（从 `Task.params.plugin_version()` 读取）。
- `src-tauri/kabegame-core/src/plugin/metadata_migration.rs`：裸 `JsRuntime` 迁移运行器（side ES module + `migrate` 导出）、同插件串行/pending 续跑、运行态快照与 finished 事件，以及 `image-changed` / `images-change(change)` 成对事件；CLI 不再提供 `plugin run migrate`。

L3 查询 / 前端：

- `src-tauri/kabegame-core/src/providers/dsl/images/images_metadata_full_provider.json5`：`images://id_{id}/metadata_full` 的完整 metadata 行路径。
- `apps/kabegame/src/components/common/ImageDetailContent.vue`：详情区读取 `get_image_metadata_full` 并把 `plugin_version` 交给模板渲染。
- `apps/kabegame/src/composables/useImageMetadataCache.ts`、`apps/kabegame/src/services/dataChangeHub.ts`：metadata 缓存（key 含 `metadataId` / `pluginVersion`）与图片字段 patch 批处理。
- `apps/kabegame/src/stores/metadataMigration.ts`、`components/busy/BusyMetadataMigrationCard.vue`：迁移运行态镜像与无取消按钮的忙碌卡片。

## 排查要点

- 历史图片没有迁移：确认 `kbMetadataMigration` 指向 `.js`，且至少导出 `migrate` / `provideLabels` 之一；确认插件版本可被 pack（`a.b.c`、每段 ≤255）。
- 标签未补上：查看 `[metadata-migration] ... provideLabels` / `label apply failed` 日志；确认返回值是数组，key/category 符合标识符约束。
- 部分行内容未升级：查看日志里的 `[metadata-migration]` 装载 / 执行错误。失败行也会盖当前版本，不会自动重试；修复脚本后需提升插件版本才会再次入选。
- 迁移反复执行：确认插件版本确实已提升；单个版本无论成败只处理一次。`migrate` 仍应幂等，以安全支持后续版本的再次执行。
- 详情区仍显示旧内容：确认前端是否先收到含最终 `metadataId` / `pluginVersion` 的 `image-changed`，
  以及随后的 `images-change` 是否为 `reason = "change"` 且 `pluginIds` 包含该插件。
