# Layer 2 · 引擎接口层

> 总览见 [plugin-metadata-migration.md](plugin-metadata-migration.md)。依赖 [Layer 1](plugin-metadata-migration-phase1-data.md)
> 暴露的存储原语。本层做 kgpg 解析、迁移引擎+运行器、Rhai 写入接口、触发点、Tauri 命令、事件。

## 范围
- kgpg 解析出迁移脚本到 `Plugin`。
- 迁移 Rhai 引擎 + 运行器（编排 Layer 1 存储原语）。
- `download_image` opt `metadata_version`、`create_image_metadata` opts 重载、WebView 入口（带
  plugin_id/version）。
- 触发点（安装/更新 + 启动）。
- `get_image_metadata_full` Tauri 命令；`metadata-migrate` 事件发射。

## 涉及文件
- `src-tauri/kabegame-core/src/plugin/mod.rs`（Plugin 结构 + parse_kgpg + install 触发）
- `src-tauri/kabegame-core/src/plugin/metadata_migration.rs`（新：引擎 + 运行器）
- `src-tauri/kabegame-core/src/plugin/rhai.rs`（download_image opt / create_image_metadata）
- `src-tauri/kabegame/src/commands/crawler.rs`（WebView 下载入口）
- `src-tauri/kabegame/src/startup.rs`（启动触发）
- `src-tauri/kabegame/src/commands_core/image.rs` & `src-tauri/kabegame/src/commands/image.rs`
  （`get_image_metadata_full` 命令）

## 步骤

### 2.1 kgpg → Plugin 收集迁移脚本
- `Plugin`（`plugin/mod.rs:29`）新增 `#[serde(skip)] pub metadata_migrations: Vec<(u32, String)>`。
- `parse_kgpg` 的 ZIP 遍历（`:1894`）加分支：匹配 `metadata_migrations/vN.rhai`（正则取正整数 N）读源码
  push `(N, src)`；`Ok(Plugin{...})`（`:2103`）及其它 `Plugin` 字面量补该字段（编译器会逐个报缺）。

### 2.2 迁移引擎 + 运行器（新文件 `plugin/metadata_migration.rs`）
- **引擎**：仿 `RhaiCrawlerRuntime::new`（`rhai.rs:489`）建最小 `Engine`（`Engine::new()` +
  `ChronoPackage` + `set_max_expr_depths`），额外注册 `parse_json(string)->Dynamic`、
  `to_json(Dynamic)->string`（复用 `rhai_dynamic_to_json_value`/`rhai_map_to_json_value`）便于作者操作
  JSON。**不**注册 download_image 等副作用函数。每个 `v{N}.rhai` 预编译为 AST，调用
  `engine.call_fn::<String>(&mut scope, &ast, "migrate", (input,))`。
- **`run_metadata_migrations_for_plugin(plugin: &Plugin)`**：
  1. `metadata_migrations` 排序，求从 1 起最大**连续** version `M`；无 v1 直接返回。
  2. `Storage::metadata_rows_below_version(plugin_id, M)`（Layer 1）。
  3. 逐行：`cur=version, data=data`；`for v in cur+1..=M`：`call_fn` 抛错/非字符串即 `break`（停在该
     version，记日志）；成功则**仅在内存中**累积 `data=新串, cur=v`（**不**每步写库）。
  4. 整条链跑完后，若 `cur` 推进，对该行调用 `Storage::writeback_migrated_metadata_row(...)`（Layer 1，
     **只写回一次**，内部处理合并/repoint）。
  5. **事件**：该插件所有行处理结束后，只发**一次** `images-change`，且不枚举 imageIds：
     `emit_images_change("metadata-migrate", &[], None, None, Some(&[plugin_id]))`（`emitter.rs:213`）。
  - 整批包在一个事务里；运行器以 **`tokio::spawn` 后台执行**，不阻塞安装/启动。

### 2.3 触发点
- `install_plugin_from_kgpg`（`plugin/mod.rs:556` 发完 added/updated 事件后）spawn
  `run_metadata_migrations_for_plugin(&plugin)`。
- `startup.rs init_kgpg_plugin`：在 `ensure_installed_cache_initialized` +
  `register_installed_plugin_providers` 之后，对 `pm.get_all()` 每个已装插件 spawn 迁移。

### 2.4 Rhai 写入接口（plugin_id / version）
- `rhai.rs:parse_download_image_opts_from_map`：签名加 `plugin_id: &str`；新增解析 opt
  `metadata_version`（仅纯自然数 `is_int && >=0`，`unit`/缺省→`0`，其它报错），插入 `metadata` 行时带上
  plugin_id + 该 version（调用 Layer 1 的 `insert_or_get_image_metadata_row(value, plugin_id, version)`）。
  两个 `download_image` 注册闭包（`rhai.rs:1588/1615`）把 plugin_id 传入。
- `create_image_metadata`（`rhai.rs:1638`）：**新增 opts-map 重载** —— 注册 `create_image_metadata(m)`
  （version=0）与 `create_image_metadata(m, opts)`（`opts` 为 map，读 `opts.version`：纯自然数，`<0`/非整数
  报错，缺省 0）。两者都捕获 plugin_id holder 落库带 plugin_id。旧插件 `create_image_metadata(m)` 行为不变。
- WebView 下载入口 `commands/crawler.rs:399-400`（`insert_or_get_image_metadata_row(&value)`）：补
  plugin_id（已有插件上下文）+ 可选 `metadata_version`（与 Rhai opt 对齐）。
- 其它现有 `insert_or_get_image_metadata_row` 调用（如有）补默认 plugin_id/version。

> 注：`metadata_version` 走 opt / `create_image_metadata` 第二参 → 直接写入 metadata 行的 `version`，
> **无需**改 `DownloadJob`/`add_image`/images 表。

### 2.5 get_image_metadata_full 命令
- 新 Tauri 命令 `get_image_metadata_full(imageId) -> { version, data, ... } | null`，包装 Layer 1 的
  `Storage::get_image_metadata_full`；与 `get_image_metadata`（`commands_core/image.rs:102` /
  `commands/image.rs:51`）并列注册到两套 command 表。

## 暴露给前端的接口
- Tauri 命令 `get_image_metadata_full`
- 事件 `images-change{ reason:"metadata-migrate", pluginIds:[plugin] }`

## 本层验证
- `bun check -c kabegame --skip vue` 通过。
- 装带 `v1.rhai`/`v2.rhai` 的插件 → 该插件 metadata 行 `version` 升到 2、`data` 已变、命中已有 hash 合并
  去重；每个插件迁移完只收到一次 `metadata-migrate` 事件（无 imageIds）。
- 失败路径：`v2.rhai` 写 `throw` → 停在 v1；修好重装 → 升 v2。连续性：缺 v2 → 只迁到 v1。
- `download_image(url, #{ metadata_version: 2, metadata: #{...} })` 与
  `create_image_metadata(#{...}, #{ version: 2 })` → 新行 `version=2`、`plugin_id` 正确；非自然数报错；
  缺省 → 0。
- `get_image_metadata_full(imageId)` 返回 `{ version, data, ... }`。
