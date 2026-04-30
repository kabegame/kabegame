# Phase 7c — DSL 全量迁移完结篇

## Context

承接 Phase 7b 完成态：

- pathql-rs 引擎完整（globals + Field 简写 + path-only fetch/count + ProviderInvocation::ByDelegate 对称语义 + instance-static key + 等）
- 已迁 DSL：gallery_route / gallery_all_router 链 / gallery_hide_router / gallery_search_router 壳 / sort_provider / page_size / query_page / bigger_crawler_time / album_bigger_order
- Storage `*_by_query` 全删；core / app-main 零 ProviderQuery

**剩余在 programmatic 的 26 个 provider**（[programmatic/mod.rs](d:/Codes/kabegame/src-tauri/core/src/providers/programmatic/mod.rs)）：

| 模块 | provider |
|---|---|
| **gallery filters (13)** | albums router/entry · plugins router/entry · tasks router/entry · surfs router/entry · media_type router/entry · search display_name router/query · wallpaper_order · date_range router/entry |
| **gallery dates (4)** | dates_router · year · month · day |
| **VD (9)** | all · albums · album_entry · sub_album_gate · plugins · tasks · surfs · media_type · dates |

[programmatic/gallery_root.rs](d:/Codes/kabegame/src-tauri/core/src/providers/programmatic/gallery_root.rs) 中 `RootProvider` / `GalleryRouteProvider` / `GalleryAllRouter` / `GalleryPaginateRouter` / `GalleryPageRouter` 几个 struct 是 6c 之后的 dead code（已被 DSL 接管，注册被注释）—— 一并清理。[programmatic/shared.rs](d:/Codes/kabegame/src-tauri/core/src/providers/programmatic/shared.rs) `SortProvider` 同理。

**目标**：所有 26 个 provider 迁 DSL；删除 [programmatic/](d:/Codes/kabegame/src-tauri/core/src/providers/programmatic/) 整目录；新建 E2E 测试；memory + RULES 收尾。

完成后：
- `programmatic/` 不存在或仅留空 stub
- DSL .json5 文件 ≥ 35
- `register_all_hardcoded` 退化为 `Ok(())` 或一并删除
- E2E 测试覆盖 gallery + vd + i18n + LRU 主路径

## Stage A — Gallery Filters 迁移（6 commits / 13 provider）

每子任务：新建 DSL 文件 → 同步 `dsl_loader.rs` DSL_FILES → 注释 programmatic register → parity 测试 → commit。

| 子任务 | DSL 新建 | 替代 programmatic |
|---|---|---|
| **S1 albums** | `gallery/albums/gallery_albums_router.json5`<br>`gallery/albums/gallery_album_provider.json5` | `gallery_albums::GalleryAlbumsRouter` / `GalleryAlbumProvider` |
| **S2 plugins** | `gallery/plugins/gallery_plugins_router.json5`<br>`gallery/plugins/gallery_plugin_provider.json5` | `gallery_filters::GalleryPluginsRouter` / `GalleryPluginProvider` —— **用 `get_plugin` host SQL 函数**（[Phase 7a S2](d:/Codes/kabegame/.claude/plans/phase7a-foundation.md) 已就绪）：动态 list SQL `SELECT json_extract(get_plugin(images.plugin_id), '$.id') AS plugin_id, json_extract(get_plugin(images.plugin_id), '$.name') AS plugin_name FROM (SELECT DISTINCT images.plugin_id FROM (${composed}) AS sub) AS p`，meta 用 `get_plugin(${row.plugin_id})` 整体 |
| **S3 tasks** | `gallery/tasks/gallery_tasks_router.json5`<br>`gallery/tasks/gallery_task_provider.json5` | `gallery_filters::GalleryTasksRouter` / `GalleryTaskProvider` |
| **S4 surfs** | `gallery/surfs/gallery_surfs_router.json5`<br>`gallery/surfs/gallery_surf_provider.json5` | `gallery_filters::GallerySurfsRouter` / `GallerySurfProvider` |
| **S5 media_type + wallpaper_order** | `gallery/media_type/gallery_media_type_router.json5`<br>`gallery/media_type/gallery_media_type_provider.json5`<br>`gallery/gallery_wallpaper_order_router.json5` | `GalleryMediaTypeRouter` / `Provider` / `GalleryWallpaperOrderRouter` |
| **S6 search + date_range** | `gallery/search/gallery_search_display_name_router.json5`<br>`gallery/search/gallery_search_display_name_query_provider.json5`<br>`gallery/date_range/gallery_date_range_router.json5`<br>`gallery/date_range/gallery_date_range_entry_provider.json5` | `GallerySearchDisplayNameRouter` / `Query` / `GalleryDateRangeRouter` / `Entry` |

**通用模式**（每个 router + entry 对子）：
- **router**: list 用动态 SQL 扫 distinct 维度（plugin_id / task_id / surf 等）；resolve regex 接 entry 段并实例化 entry provider
- **entry provider**: properties 接维度 ID；query.where 加该维度过滤；list "desc" + 动态分页 delegate；resolve regex `x([1-9][0-9]*)x` + 裸数字 + `desc`（与 gallery_all_router 模式同）

**meta 字段**：每个 entry 在 list 时返 `meta` —— 用 host SQL 函数（`get_plugin`）或 typed JSON 包装（`{kind: "task", data: {...}}`）。具体形态由 [provider.rs::wrap_typed_meta_json](d:/Codes/kabegame/src-tauri/core/src/providers/provider.rs) 决定 wire format。

## Stage B — Gallery Dates 迁移（2 commits / 4 provider + 1 host SQL 函数）

### S7-a — `crawled_at_seconds` host SQL 函数

[storage/dsl_funcs.rs](d:/Codes/kabegame/src-tauri/core/src/storage/dsl_funcs.rs) 加 `register_crawled_at_seconds`：

```rust
conn.create_scalar_function(
    "crawled_at_seconds", 1,
    FunctionFlags::SQLITE_DETERMINISTIC | FunctionFlags::SQLITE_INNOCUOUS,
    |ctx| {
        let v: i64 = ctx.get(0)?;
        Ok(if v > 253_402_300_799 { v / 1000 } else { v })
    },
)
```

抽掉全工程 4 处 `CASE WHEN crawled_at > 253402300799 THEN .../1000 ELSE ... END`：
- [storage/gallery.rs:191](d:/Codes/kabegame/src-tauri/core/src/storage/gallery.rs#L191) `get_gallery_day_groups`
- [programmatic/gallery_dates.rs](d:/Codes/kabegame/src-tauri/core/src/providers/programmatic/gallery_dates.rs) 3 处（行 100 / 174 / 243）—— 这些会在 S7-b 删除
- [programmatic/gallery_filters.rs:622](d:/Codes/kabegame/src-tauri/core/src/providers/programmatic/gallery_filters.rs#L622) date_range —— 已在 Stage A S6 删除（先后顺序看实际执行）

完成后 `grep 253402300799 src-tauri/` 仅剩 `dsl_funcs.rs` 一处函数定义。

### S7-b — 4 个日期 DSL provider

| DSL 文件 | 责任 |
|---|---|
| `dsl/gallery/dates/gallery_dates_router.json5` | list 动态 SQL `SELECT DISTINCT strftime('%Y', crawled_at_seconds(images.crawled_at), 'unixepoch') AS year FROM (${composed}) AS sub`；key `${row.year}y`；resolve `([0-9]{4})y` |
| `dsl/gallery/dates/gallery_date_year_provider.json5` | properties.year；query.where strftime('%Y', ...) = `${properties.year}`；list desc + 月份动态 SQL + 分页 delegate；resolve `([0-9]{2})m` + 转发 sort + xNNNx + 裸数字 |
| `dsl/gallery/dates/gallery_date_month_provider.json5` | properties.year_month；同模式，扫 days |
| `dsl/gallery/dates/gallery_date_day_provider.json5` | properties.ymd；终端，list 仅 desc + 分页；resolve 转发 |

每层 list 末尾的"desc + 分页"模式重复 ~25 行（DSL 暂无 include 机制）。

## Stage C — VD 迁移（3 commits / 9 provider）

### S8 — vd_all + vd_albums + vd_album_entry + vd_sub_album_gate

| DSL | 责任 |
|---|---|
| `dsl/vd/all/vd_all_provider.json5` | 应用全局排序 / fields；list / resolve 接分页路径段（与 gallery 类似）|
| `dsl/vd/albums/vd_albums_provider.json5` | list 动态 SQL 拿 albums + 嵌套子 album；resolve 接 album_id 段 → album_entry |
| `dsl/vd/albums/vd_album_entry_provider.json5` | properties.album_id；query.where album_id 过滤；list 子 album + 该 album 图片分页 |
| `dsl/vd/albums/vd_sub_album_gate_provider.json5` | 子 album 闸门 router（按 VD 业务逻辑）|

### S9 — vd_plugins + vd_tasks + vd_surfs + vd_media_type

`vd_plugins_provider` 用 `get_plugin` host SQL 函数 + i18n 解析 plugin name —— 通过 `${global.locale}` 或路径参数传 locale。

`vd_zh_CN_root_router` / `vd_en_US_root_router` 已经是 DSL（[Phase 7a S1](d:/Codes/kabegame/.claude/plans/phase7a-foundation.md)），它们的 list 现在指向 programmatic vd_plugins_provider 等 —— 切换为指向新 DSL provider；同时 properties 传 locale。

### S10 — vd_dates

与 gallery_dates 完全平行，但路径段走 i18n 翻译（`年` / `月` / `日` vs `Year` / `Month` / `Day`）—— 由 `vd_zh_CN_root` / `vd_en_US_root` 各自挂载不同段名 + 同一 vd_dates 内核。

实现方案（避免两套 dates DSL）：
- `vd_dates_provider`（一份 DSL）—— resolve 接 segment 时**用 instance-static key + properties.year_segment_suffix** 让 zh_CN 用 "年"、en_US 用 "Y"；或者
- 两套独立 DSL：`vd_zh_CN_dates_provider` / `vd_en_US_dates_provider` 各自硬编码 segment 名

**推荐后者**：dates 路径少（年/月/日），重复 3 个 segment 名比模板化更清晰。

## Stage D — Programmatic 模块删除（1 commit）

### S11 — `programmatic/` 整目录删除

**前置**：Stage A-C 完成；所有 register_xxx 调用都已注释。

| 改动 |
|---|
| 删除 [providers/programmatic/](d:/Codes/kabegame/src-tauri/core/src/providers/programmatic/) 整目录（8 个 .rs 文件，2152 行）|
| [providers/mod.rs](d:/Codes/kabegame/src-tauri/core/src/providers/mod.rs) 删 `mod programmatic;` |
| [providers/init.rs](d:/Codes/kabegame/src-tauri/core/src/providers/init.rs) `init_runtime` 删 `register_all_hardcoded` 调用 |
| `register_all_hardcoded` 函数本身：要么删除，要么留空 stub `pub fn register_all_hardcoded(_: &mut ProviderRegistry) -> Result<(), RegistryError> { Ok(()) }` 给未来插件留口 —— 推荐删除 |
| Tauri cleanup audit | grep `crate::providers::programmatic` / `programmatic::*` import → 0 引用 |

## Stage E — E2E 测试 + 文档收尾（1 commit）

### S12 — `core/tests/dsl_e2e.rs` + memory + RULES

| 文件 | 改动 |
|---|---|
| [core/tests/dsl_e2e.rs](d:/Codes/kabegame/src-tauri/core/tests/dsl_e2e.rs) 新建 | fixture DB（commit 入 repo）+ 测试用例：<br>(a) `/gallery/all/x100x/1/` SQL + image set 断言<br>(b) `/vd/i18n-zh_CN/按画册/{album_id}/` 与 `/vd/i18n-en_US/albums/{album_id}/` 等价 image set<br>(c) `/vd/i18n-zh_CN/按插件/{plugin_id}/` plugin name 按 locale 切换<br>(d) LRU 测试：连续访问 100 不同 page，cache 不击穿<br>(e) 主路径 fold + build_sql snapshot |
| memory `project_dsl_architecture.md` | 加一条决策："Phase 7c 完成 DSL 全量迁移；programmatic/ 模块删除；core 内 SQL 字符串总数 = host SQL 函数 + storage 业务 SQL（albums/tasks/etc.）" |
| [RULES.md](d:/Codes/kabegame/cocs/provider-dsl/RULES.md) | 总结性收尾段：所有 v0.7 引擎特性落地 + 28+ provider DSL 化案例参考；§11.1 host SQL 函数清单加 `crawled_at_seconds` |
| [cocs/README.md](d:/Codes/kabegame/cocs/README.md) | provider-dsl 章节状态从"迁移期共存"更新到"全量 DSL 化完成" |

## 风险

- **gallery filter 数量大（13 provider × 6 commits = 6 个 stage A）**：每 commit 体积可控，但累计风险高。每 stage 独立 parity 测试 + 手测主路径
- **plugins / VD 用 get_plugin 的 i18n locale 传递**：vd_zh_CN / vd_en_US 各自传 properties.locale 到 plugins provider；`get_plugin('id', ${properties.locale})` 模板渲染时把 locale 作为 bind 参数
- **LRU 缓存影响**：迁移期间 DSL 与 programmatic 共存，路径解析结果可能在缓存里串。每个 stage commit 后清缓存（启动 dev server）确认行为
- **fields alias 列名硬契约扩散**：每个 entry provider 的 fields 顺序 / alias 名要与对应 typed mapper（`Album` / `Task` / `SurfRecord`）匹配 —— 但这些用 `get_album()` / `get_task()` 等 host SQL 函数返 typed JSON 时，alias 名由函数 JSON 决定，不是 DSL fields；新建 host SQL 函数 `get_album` / `get_task` / `get_surf_record` 类似 `get_plugin` 模式（**S2 替代方案**）
- **VD `按时间` 嵌套 i18n**：参见 S10 的两套独立 DSL 方案
- **commit 数量大（12 + 个）**：可在每个 stage 完成时合并到一个 PR，减少 review 体积；trunk 仍 commit-by-commit

## 子任务执行顺序

S1 → S2 → S3 → S4 → S5 → S6 → S7-a → S7-b → S8 → S9 → S10 → S11 → S12

每步独立 commit，trunk 全程编译干净。每个 stage 完成跑一次 `cargo test -p kabegame-core` + `bun check` + 浏览主路径手测。

## 完成 Phase 7c 后

整个 Phase 7 完结。进入 **Phase 8+**（基础维护期）：
- DSL include / mixin 机制（解决分页尾巴 4-7 处重复 25 行问题）
- sync/async feature 切换 trait 签名 + 内置 `sqlx_executor` feature
- 多方言完整支持（Postgres / Mysql build_sql 完整 placeholder 渲染）
- 非 SQL executor 抽象（`ResourceExecutor`）
- 性能调优：LRU 容量上限 / 命中率监控
- 第三方插件可声明 DSL provider（namespace 机制扩展）
