# 插件商店缓存链路

本文档描述 **商店 index.json** 与 **远程插件包（.kgpg）** 的两级缓存如何读写、何时失效，以及安装路径如何复用缓存。便于 AI/开发者快速对照代码，避免与「下载器」「已安装插件目录」混淆。

---

## 1. 概念区分

| 概念 | 存储位置 | 用途 |
|------|----------|------|
| **index 缓存** | SQLite 表 `plugin_source_cache`（按 `source_id` 存整份 JSON 字符串） | 商店列表：避免每次打开都请求远程 `index.json` |
| **插件包缓存** | 磁盘 `cache_dir/store-cache/<source_id>/<plugin_id>.kgpg` | 安装/预览：在版本匹配时复用已下载的 `.kgpg`，减少重复下载 |
| **已安装插件** | `data_dir/plugins-directory/*.kgpg` | 用户实际使用的插件，与商店缓存无关 |

路径由 `AppPaths` 计算（`store_cache_dir`、`store_plugin_cache_file` 等），见 `src-tauri/kabegame-core/src/app_paths.rs`。

---

## 2. 流程总览

```
拉取商店列表（get_store_plugins / fetch_store_plugins）
    → fetch_plugins_from_source_cached(source, force_refresh, revalidate_if_stale_after_secs)
        ├─ force_refresh=true：HTTP GET index_url → save_source_cache（覆盖）
        ├─ force_refresh=false：读 plugin_source_cache 行（json_content + updated_at）→ 解析 plugins
        │     ├─ 无有效缓存：HTTP GET → save_source_cache
        │     ├─ revalidate_if_stale_after_secs 为 Some：若 now - updated_at >= 该秒数 → 视为过期 → HTTP GET → save_source_cache
        │     └─ 否则：直接返回缓存解析结果（不发起 HTTP）
        └─ （前端）应用启动：先同步 load（force_refresh=false，不按时间失效）恢复缓存，再 force_refresh=true 静默拉远程；此后每 4h 强制刷新
             └─ 打开商店 tab 仍传 revalidateIfStaleAfterSecs=14400 兜底重拉，静默比对列表签名，有变化则更新 UI 并提示

从商店安装（preview_store_install，且传入 source_id + version）
    → ensure_plugin_cached(...)
        ├─ 若 store-cache/.../<plugin_id>.kgpg 存在且 manifest.version == expected_version → 直接返回该路径（不下载）
        └─ 否则删除旧文件 → 下载 → 写入同一路径
    → load_remote_plugin（轻量记录，fileOrigin={kind:store,sourceId}）→ import_plugin_from_zip
        → install_plugin_from_kgpg 完整解析并校验 min_app_version → 复制/安装到 plugins-directory

无 source_id 或 version（兼容路径）
    → download_plugin_to_temp：仅临时文件，不走 store-cache 长期缓存
```

---

## 3. 涉及代码文件

| 层级 | 文件路径 | 作用 |
|------|----------|------|
| 列表 + 双级缓存核心 | `src-tauri/kabegame-core/src/plugin/mod.rs` | `fetch_store_plugins`、`fetch_plugins_from_source_cached`、`fetch_plugins_from_source`、`ensure_plugin_cached`、`download_plugin_to_temp` |
| index 持久化 | `src-tauri/kabegame-core/src/storage/plugin_sources.rs` | `get_source_cache`、`get_source_cache_row`（含 `updated_at`）、`save_source_cache` |
| 安装预览命令 | `src-tauri/kabegame/src/commands/plugin.rs` | `preview_store_install`：有 `source_id`+`version` 时走 `ensure_plugin_cached` |
| IPC | `src-tauri/kabegame/src/ipc/handlers/plugin.rs` | 主应用 IPC 入口；自包含 CLI 不读取插件商店 |
| 路径 | `src-tauri/kabegame-core/src/app_paths.rs` | `store_cache_dir`、`store_plugin_cache_dir`、`store_plugin_cache_file` |
| 前端数据 | `apps/kabegame/src/stores/pluginMarket.ts` | `usePluginMarketStore`：源列表、各源原始列表、远程图标与可更新插件集合的唯一属主；`startRefreshPlugins` 启动缓存加载、强制刷新与 4h 周期刷新；`revalidateInBackground` 支持按阈值或强制静默刷新；监听 `plugin-sources-changed` |
| 前端页面 | `apps/kabegame/src/views/PluginBrowser.vue` | tab 绑定 `?tab=`、骨架屏、对话框；手动刷新 `forceRefresh: true` |

---

## 4. index.json 缓存（SQLite）

- **写入时机**：`fetch_plugins_from_source` 成功拉取并解析远程 JSON 后，将**整份**响应序列化写入 `plugin_source_cache`（`INSERT OR REPLACE`）。
- **读取时机**：`force_refresh == false` 时通过 `get_source_cache_row` 取 `json_content` 与 **`updated_at`（Unix 秒）**；若能解析出非空 `plugins` 数组，且未配置「按时间重拉」或缓存未过期，则直接返回，**不发起 HTTP**。
- **按时间后台重拉**：请求参数 `revalidate_if_stale_after_secs == Some(secs)` 且 `force_refresh == false` 时，若 `now - updated_at >= secs`，则走网络拉取并更新缓存（与强制刷新的网络路径相同）。
- **强制刷新**：`force_refresh == true` 时始终重新 GET，成功后 **覆盖** DB 中的 index 缓存（忽略 `revalidate_if_stale_after_secs`）。
- **注意**：刷新列表**不会**批量删除磁盘上的各插件 `.kgpg` 缓存；仅更新「目录」层面的 index 缓存。

---

## 5. 插件包缓存（磁盘 store-cache）

- **路径**：`<cache_dir>/store-cache/<source_id>/<plugin_id>.kgpg`（`plugin_id` 通常来自下载 URL 中的文件名 stem）。
- **写入 / 更新**：`ensure_plugin_cached` 在需要时下载并 `fs::write` 到该路径。
- **命中条件**：文件存在 + `read_plugin_manifest` 得到的 **version** 与调用方传入的 **`expected_version` 一致** → 视为命中，**不再下载**。
- **失效**：版本不一致、文件损坏或无法读 manifest → 删除该文件后重新下载。
- **列表与缓存不一致**：index 刷新后若某插件版本升级，旧 `.kgpg` 会在下次 `ensure_plugin_cached` 时因版本不匹配被替换；若某插件从 index 中移除，已缓存的 `.kgpg` **不会**因「仅刷新列表」自动删除，可能长期残留；删除整个商店源时会删除该 `source_id` 下缓存目录（见 `delete_plugin_source` 与 `store_plugin_cache_dir` 清理）。

---

## 6. 远程图标与缓存

- `fetch_remote_plugin_icon_v3` 在提供 `source_id` + `plugin_id` 时，**优先**从已存在的 `store_plugin_cache_file` 读 icon，避免重复 Range 请求；缓存不存在再走 HTTP Range。详见 `plugin/mod.rs` 中 `fetch_remote_plugin_icon_v3`。

---

## 7. 前端生命周期（`usePluginMarketStore` + `?tab=`）

- **启动加载与刷新**：App 在已安装插件加载后调用一次 `startRefreshPlugins()`。store 先通过 `ensureSources()` / `ensureStorePlugins(sourceId)` 从后端 SQLite index 缓存恢复各源列表与导航角标，再用 `revalidateInBackground(sourceId, { force: true })` 静默强制刷新所有源；全平台（含 Web）一致，且不改 `loadingBySource`，启动刷新期间进入插件页不会闪骨架屏。
- **周期与 tab 兜底**：启动强制刷新完成后，store 每 4h 对当时存在的所有源静默强制刷新一次；进入商店 tab 仍调用 `revalidateInBackground`，由后端按 `updated_at` 与 4h 阈值决定是否走网络。周期刷新必须强制，避免首次网络写入时间晚于定时器起点而使 4h 首轮被 stale 判断跳过。
- **保存**：数据存在 Pinia store，跨路由存活。App 没有 keep-alive，`PluginBrowser` 从详情返回会重挂载，但直接复用 store，不重拉列表与图标、不闪骨架屏。
- **installedVersion 现算**：store 只存后端原始列表，`pluginsBySource` 在读取时按 `usePluginStore().visiblePlugins` 叠加 `installedVersion`。安装 / 更新 / 删除插件由 `plugin-added` / `plugin-changed` / `plugin-deleted` 驱动 `pluginStore`，商店卡片自动跟随，无需重拉商店。
- **可更新唯一判据**：`isStoreUpdateAvailable` 同时要求商店版本高于已安装版本且 `minAppIncompatible` 不为真；`updatableInstalledIds` 按插件 id 去重。桌面侧栏、紧凑端底部 tab 的数字角标，插件页各商店源 tab 的数字角标（只计该源条目），商店卡片红点和商店条目快捷预览统一读这套结果，不兼容的新版本不会提示更新。已安装 tab 的卡片与快捷预览不提示更新：从那里点进去的是本地插件详情，不能执行更新，入口只在商店源。角标统一用组件库的 `v-corner-badge`（与 `el-badge` 同外观）。
- **安装守卫**：前端详情按钮继续按 `minAppIncompatible` 禁用；后端共同入口 `install_plugin_from_kgpg` 在复制前复用 `check_min_app_version` 校验完整解析所得 `min_app_version`，因此商店安装、文件导入和拖入导入都不能绕过最低应用版本要求。
- **事件刷新**：store 首次使用时注册一次 `plugin-sources-changed` → `loadSources()`。后端在 storage 层 `add_source` / `update_source` / `delete_source` 写库后（释放锁后）以 `reason: added|updated|deleted` + `sourceId` 广播；官方源名 i18n 同步也发同名事件。自身写操作完成后页面直接 `loadSources()`，不依赖事件回刷；重复刷新幂等。
- **`loadSources()` 的副作用**：清掉已不存在源的列表、加载标记与 `store:<id>:*` 图标；已加载源的 `indexUrl` 变了则 `forceRefresh` 重拉（旧 index 缓存不再可信）。
- **tab 导航参数**：当前 tab 是 settings 的 query 后端键 `pluginBrowserTab`（URL 参数 `tab`，与 `autoConfigTab` 共用参数名、各自在本页读取）：`installed` 编码为空，商店 tab 为 `store:<sourceId>`。切 tab 用 `replace`，所以进详情时 history 里那条已带 `?tab=`，`router.back()` 回来即恢复。页面只在 `route.name === "PluginBrowser"` 时读写（settings 层只做哑同步）；URL 指向不存在的源时回落到 `installed`，当前源被删 / 事件刷新后消失时同样回落。详情页无历史可回时，远程条目回到 `?tab=store:<source>`。

---

## 8. 前端详情与文件缓存

桌面、Android、Web 的 `get_plugins` 都返回轻量列表（图标、packageJson、assetKeys 等），Web 不再逐个补 `get_plugin_detail`，也不再写 `pluginCacheDb`。
`usePluginDetailLoader` 对商店详情只用内存缓存，按插件 id、sourceId 隔离并校验 expectedVersion；响应晚到时不得覆盖新选择。`storePluginCacheDb` 只保留 icons 表，v2 升级删除 details 表。

后端已安装与商店 map 只保留轻量记录，正文、模板、推荐配置和图片统一经 `/plugin_file` 从对应 kgpg 按需读取。
商店详情请求带 `source=<sourceId>`，文件 URL 带 `v=<version>`；导入商店包的预览沿用 store 来源，不占用导入文件的 8 项预览 LRU。
前端文本缓存按完整 URL 隔离来源与版本，安装/更新版本变化或删除时按 pluginId 失效。推荐配置响应含动态 `isImported`，始终 `no-store`。
详见 [PLUGIN_FILE_ENDPOINT.md](PLUGIN_FILE_ENDPOINT.md)。

---

## 9. 缓存操作对照

| 操作 | index（DB） | 各插件 .kgpg（磁盘） |
|------|-------------|----------------------|
| 打开商店 tab、首次同步加载 | 优先用缓存（不按时间失效） | 不参与列表加载 |
| 应用启动 | 先读缓存，再静默强制拉远程并覆盖 | 不参与列表加载 |
| 启动后每 4h | 静默强制拉远程并覆盖 | 不参与列表加载 |
| 打开商店 tab、后台静默（缓存至少 4h 未更新才网络拉取） | 可能更新 index 行 | 不参与列表加载 |
| 用户「刷新」当前商店源 | 重新拉取并覆盖 | 不自动清空 |
| 安装/预览（带 source_id + version） | 不单独写 | **版本匹配则直接用缓存文件** |

---

## 工作评价（文档维护）

- **优点**：与实现一一对应，区分 DB 索引缓存与磁盘包缓存，并写明 `preview_store_install` 分支。
- **可维护性**：后续若增加「刷新时清空 store-cache」或 SHA256 校验策略，只需更新本文档与对应小节。

## 运行配置写入与本地推荐导入态

运行配置 add / copy 比较新配置插件，update 比较新旧插件，delete 比较旧插件的推荐导入态；
只读已安装包与同 id 且包文件仍在本地的 `store_plugin_cache` 条目，不下载。写库提交后按 pluginId 合并，
每个插件最多发送一条 `plugin-changed { pluginId, changes: { recommendedConfigs: { <path>: { imported } } } }`，
仅包含导入态实际变化的路径；同一路径优先采用已安装插件的新状态，没有该状态时采用变化来源的新状态。
事件经既有 `GlobalEmitter::hold()` 与 `auto-config-change` 同批放行；只改名称、计划时间等不影响匹配的字段不发插件事件。
覆盖安装（升级或同版本重装）也发 `plugin-changed`，`changes` 是必含 `version` 的完整插件 JSON；首次安装与卸载仍用 `plugin-added` / `plugin-deleted`。

商店来源按各自本地包内容独立计算，即使与已安装版本不同也参与路径变化检测；预览不在比较范围。
导入态 patch 不触发插件 store 的列表、详情缓存更新（只有含 `version` 的完整覆盖安装 patch 才应用）。
推荐卡片通过 `useRecommendedPresets` 观察 `plugin://byStore/<sourceId>/<id>/<version>/recommended`，
同插件的 version / recommendedConfigs patch 驱动核心刷新；商店包只读本地缓存。预览使用 byPreview，
已安装使用 installed；均共用来源基址和同一观察方。
