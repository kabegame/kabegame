# Provider + ImageQuery 可组合系统

本文档记录画廊与虚拟盘共用的 Provider 查询系统，说明当前实现、调用链和扩展原理。

## 目标

- 把 SQL 语义拆成三个正交维度：`JOIN`（数据源）、`WHERE`（过滤）、`ORDER BY`（排序）。
- 让上层 Provider 组合片段，下层 Provider 只接收组合后的 `ImageQuery` 并执行。
- Gallery 与 VD 复用同一套查询表达，不再依赖字符串嗅探。

## 核心结构

`ImageQuery` 已从旧的 `decorator + params` 重构为结构化模型：

- `joins: Vec<SqlFragment>`
- `wheres: Vec<SqlFragment>`
- `order_bys: Vec<String>`

对应实现位于：

- [`src-tauri/kabegame-core/src/storage/gallery.rs`](/src-tauri/kabegame-core/src/storage/gallery.rs)
  - `SqlFragment`
  - `ImageQuery`
  - builder API：`with_join` / `with_where` / `with_order` / `merge`
  - SQL 生成：`build_sql` / `build_count_sql`
  - 内省：`is_ascending` / `to_desc` / `album_id` / `is_unfiltered`

## 查询组件分层（可复用原理）

### 1) 数据源组件（JOIN + 可选 WHERE）

- `album_source(album_id)`：`album_images ai` 关联 + `ai.album_id = ?`
- `task_source(task_id)`：`images.task_id = ?`（单图单任务，无需 JOIN）

这类组件定义“从哪张关系表取图”，通常由“分组 Provider”贡献。

### 2) 过滤组件（WHERE）

- `wallpaper_set_filter()`：只看设过壁纸
- `plugin_filter(plugin_id)`
- `date_filter(ym)`
- `date_range_filter(start, end)`
- `surf_record_filter(id)`
- `media_type_filter(media_type)`：`COALESCE(images.type, 'image') = ?`（`image` / `video`）；别名 `by_media_type` 带默认按抓取时间排序

这类组件定义“保留哪些记录”，通常由 root/provider 路径语义贡献。

### 3) 排序组件（ORDER BY）

- `sort_by_crawled_at(asc)`
- `sort_by_wallpaper_set_at(asc)`
- `sort_by_album_order(asc)`
- `sort_by_task_order()`（当前等价于 `images.crawled_at ASC`）

这类组件定义“输出顺序”，可与任意数据源/过滤自由组合。

### 4) 兼容别名构造函数

旧接口仍保留（如 `by_album`、`all_by_wallpaper_set`），但内部改为组件组合，避免外部调用方大面积改动。

## Provider 组合与执行链路

1. Root 或 Group Provider 根据路径语义创建基础 `ImageQuery`（过滤/数据源/排序）。
2. `CommonProvider` 只持有 `query`，不关心 query 来源。
3. 列表与分页时，`Storage` 通过：
   - `build_count_sql()` 执行总数查询
   - `build_sql()` 执行分页查询
4. Gallery Browse 与 VD 删除逻辑均复用同一个 `ImageQuery`。

关键文件：

- [`src-tauri/kabegame-core/src/providers/main_root.rs`](/src-tauri/kabegame-core/src/providers/main_root.rs)
- [`src-tauri/kabegame-core/src/providers/common.rs`](/src-tauri/kabegame-core/src/providers/common.rs)
- [`src-tauri/kabegame-core/src/gallery/browse.rs`](/src-tauri/kabegame-core/src/gallery/browse.rs)
- [`src-tauri/kabegame-core/src/providers/vd_ops.rs`](/src-tauri/kabegame-core/src/providers/vd_ops.rs)
- [`src-tauri/kabegame-core/src/storage/gallery.rs`](/src-tauri/kabegame-core/src/storage/gallery.rs)

画册详情（`album/<albumId>/…`）在 `MainAlbumsProvider::resolve_child` 下挂 `MainAlbumEntryProvider`：默认分支按抓取时间排序（`album_source` + `sort_by_crawled_at`），与 `desc`、`album-order`（`album_source` + `sort_by_album_order`）、`wallpaper-order` 子目录（画册内仅「曾设为壁纸」+ `sort_by_wallpaper_set_at`）组合；`album-order` 与 `wallpaper-order` 均支持子目录 `desc` 表示倒序。另支持 `image-only` / `video-only` 根段（`MainAlbumMediaEntryProvider` 等），在画册内叠加 `media_type_filter`。语义与根级 `all` / `wallpaper-order` 对齐。前端路径拼装见 [`apps/kabegame/src/utils/albumPath.ts`](/apps/kabegame/src/utils/albumPath.ts)。

画廊根级另有 `media-type/image`、`media-type/video`（`MainMediaTypeGroupProvider`）；虚拟盘中文根目录在 `RootProvider` 中为「按种类」→「图片」/「视频」（`MediaTypeGroupProvider`）。

`images.type` 现存格式键，因此格式细分值使用规范后缀（如 `jpg` / `mov` / `mkv`），不再显示旧标准 MIME 的 `jpeg` / `quicktime` / `x-matroska` 子类型。

## desc 子目录统一规则

以前靠硬编码判断“是否 all_recent / wallpaper_set asc”，现在统一为结构化判断：

- 展示 desc 入口：`query.is_ascending()`
- 切换到 desc：`query.to_desc()`

这样 `CommonProvider`、`MainWallpaperOrderProvider`、`MainSurfRecordProvider` 和 `browse.rs` 使用同一规则，不再手写分支。

## VD 复用点

- `vd_ops::album_id_from_query` 已改为 `query.album_id()`。
- 删除文件能力判断 `query_can_delete_child_file` 依赖结构化内省，而非 SQL 字符串包含判断。

这保证了后续 SQL 片段重排、补充条件时 VD 逻辑仍稳定。

## 缓存兼容策略

`ImageQuery` 序列化结构改变后，必须提升 Provider 缓存 key 版本：

- 位置：[`src-tauri/kabegame-core/src/providers/cache.rs`](/src-tauri/kabegame-core/src/providers/cache.rs)
- `key_prefix` 已提升（当前 `v4`，见 [`cache.rs`](/src-tauri/kabegame-core/src/providers/cache.rs) 默认值）

原则：只要 `ProviderDescriptor` 或 `ImageQuery` 的序列化字段语义变化，就 bump 版本，避免历史缓存污染运行时。

## 扩展原理（新增功能时怎么做）

以下是新增查询能力时的标准步骤。

### A. 新增一个过滤条件（WHERE）

例：新增“仅横图”过滤。

1. 在 `ImageQuery` 增加组件函数（如 `landscape_filter()`）。
2. 在对应 Provider 路径分支中把该过滤与既有数据源/排序 `merge`。
3. 不改 `Storage` 查询执行层（它只认 `build_sql/build_count_sql`）。
4. 若需要 VD 能力控制，补充结构化内省函数，避免字符串匹配。

### B. 新增一个排序策略（ORDER BY）

例：按 `last_set_wallpaper_at DESC` 且空值在后。

1. 增加排序组件函数（如 `sort_by_wallpaper_set_at_desc_nulls_last()`）。
2. 在 root 或分组 Provider 里替换排序组件。
3. 确保 `is_ascending/to_desc` 的语义仍成立；若不成立，新增专用方向判断函数。

### C. 新增一个数据源（JOIN）

例：按某新关系表 `collection_images ci` 分组。

1. 增加 `collection_source(id)`（JOIN + 主键过滤）。
2. 增加对应排序（如 `sort_by_collection_order()`）。
3. 组合为别名构造函数（如 `by_collection(id)`）。
4. 在 Main/VD 路由 Provider 中接入该构造函数。

## 设计约束与最佳实践

- 不在 Provider 中手工拼整段 SQL 字符串；统一通过 `ImageQuery` 组件组合。
- 新能力优先做成“小组件函数”，再用别名函数聚合，保持复用。
- 内省逻辑只基于结构化字段（`joins/wheres/order_bys`），避免 `contains("...")`。
- count 与 list 必须共享同一查询来源，只在 `ORDER BY` 是否参与上区分。
- 任何序列化结构变化都需要缓存版本升级。

## 抓取时间分组（gallery_time / main_date_browse）

- **唯一数据源**：`Storage::get_gallery_day_groups()`（按自然日 `YYYY-MM-DD` 聚合计数，SQL 在 [`storage/gallery.rs`](/src-tauri/kabegame-core/src/storage/gallery.rs)）。
- **月分组**：不再单独跑按月 `GROUP BY` SQL；由 [`storage/gallery_time.rs`](/src-tauri/kabegame-core/src/storage/gallery_time.rs) 的 `gallery_month_groups_from_days` 从日列表聚合得到，与前端年/月/树一致。
- **`GalleryTimeFilterPayload`**：`{ months, days }`，一次返回给前端；Tauri 命令 `get_gallery_time_filter_data`。
- **`providers` 对 `gallery_time` 的再导出**：`kabegame_core::providers` 仍导出 `GalleryTimeFilterPayload` 等与 `storage::gallery_time` 相同符号（便于与插件分组等并列使用）。
- **Gallery Main `date/*`**：`MainDateGroupProvider` 根目录为**年份**（`main_date_browse::gallery_distinct_years`）；子路径解析为 `MainDateScopedProvider`（年→月→日），与画廊 `date/<YYYY|YYYY-MM|YYYY-MM-DD>` 一致。
- **VD「按时间」**：`VdByDateProvider` 复用 `list_main_date_browse_root_entries` / `main_date_child_provider`，并额外提供「范围」与说明文件；时间层级与 Main 相同，不再单独按月平铺。

## 前端（画廊路径控件位置）

- **查询行是四页共用的一个组件**：[`apps/kabegame/src/components/gallery/GalleryQueryBar.vue`](/apps/kabegame/src/components/gallery/GalleryQueryBar.vue)——画廊（经 [`GalleryToolbar.vue`](/apps/kabegame/src/components/GalleryToolbar.vue)）、画册详情、任务详情、畅游详情各挂一份。桌面两行：上行是「简单 / 高级」`KbTab` + 排序维度 / 顺序 / 每页条数 chip，下行按模式二选一——简单态是横向滚动的维度 chip 行（搜索是其中一枚 chip，见 [`GallerySearchDropdown.vue`](/apps/kabegame/src/components/gallery/GallerySearchDropdown.vue)），高级态是 PathQL 路径条 + 「配置」入口（弹窗见 [`GalleryAdvancedQueryDialog.vue`](/apps/kabegame/src/components/gallery/GalleryAdvancedQueryDialog.vue)）。两行高度钉死同一档，切模式时下方网格不跳。
- **组件不认识 route store**：所有会改查询的动作汇成一个 `navigate(patch, options)` 事件，由各页转交自己的 path-route store（`GalleryQueryPatch` 定义在 [`galleryPath.ts`](/apps/kabegame/src/utils/galleryPath.ts)）。这样「切回简单过滤时把高级树降级平移」这类跨字段改动才能一次导航完成，不会被拆成多次互相覆盖。差异靠 props 表达：`filterFeatures` / `sortFeatures`（各页可用的维度与排序）、`providerContextPrefix`（facet 树的上下文 = store 的 `computedContextPath`）、`contextBase`（高级路径基址 = store 的 `contextPathFor({ search: "" })`，**不含 search**，search 由组件按当前模式自己拼，基址再带一份会重复）、`enableClearAll`（画廊的清除全部在副标题里，故只有三个详情页开）。
- 文案口径（chip 值、安卓折叠菜单标签、排序升降序说法）统一在 [`galleryFilterLabels.ts`](/apps/kabegame/src/utils/galleryFilterLabels.ts)，工具栏与查询行共用一份。
- Android：查询行只渲染「高级查询」按钮，简单过滤 / 排序 / 每页条数仍由各页 `PageHeader` 的 fold 触发——header 通过组件 ref 调 `openFilterPicker` / `openSortPicker` / `openPageSizePicker` 打开 van-picker（高级查询生效时 `openFilterPicker` 直接 no-op，两者在路由上互斥）。
- **高级查询在四条路由上都可用**。detail 路由的高级树写在根前缀之后（`album/<id>/~any/…/~end/sort/…`）：`~` 组合器由引擎在 provider resolve 之前拦截（[`where_group.rs`](/src-tauri/pathql-rs/src/provider/where_group.rs)），分支从组入口 provider 出发，故不需要 DSL 配合；但原子的**搜索格**是普通路径段，需要 `gallery_album_provider` / `gallery_task_provider` / `gallery_surf_provider` 的 resolve 分支里列出 `search`（已加），否则 `album/<id>/search/<mode>/<q>` 路由不到。三个 route store 因此都带 `advanced` 字段。
- 按种类数量：Tauri 命令 `get_gallery_media_type_counts`（全库）、`get_album_media_type_counts`（单画册）；数据来自 `Storage::get_gallery_media_type_counts` / `get_album_media_type_counts`（[`storage/gallery.rs`](/src-tauri/kabegame-core/src/storage/gallery.rs)），过滤下拉与折叠标签旁展示 `(n)`。

**分页与每页条数（SimplePage）**：路径末尾页码、`galleryPageSize` 设置与 `browse_gallery_provider` 调用链见 [`GALLERY_PAGINATION_AND_IMAGE_LOAD.md`](GALLERY_PAGINATION_AND_IMAGE_LOAD.md)（与本文的 ImageQuery 组合正交，可对照阅读）。

## 相关代码索引

- [`src-tauri/kabegame-core/src/storage/gallery.rs`](/src-tauri/kabegame-core/src/storage/gallery.rs)
- [`src-tauri/kabegame-core/src/storage/gallery_time.rs`](/src-tauri/kabegame-core/src/storage/gallery_time.rs)
- [`src-tauri/kabegame-core/src/providers/main_date_browse.rs`](/src-tauri/kabegame-core/src/providers/main_date_browse.rs)
- [`src-tauri/kabegame-core/src/providers/common.rs`](/src-tauri/kabegame-core/src/providers/common.rs)
- [`src-tauri/kabegame-core/src/providers/main_root.rs`](/src-tauri/kabegame-core/src/providers/main_root.rs)
- [`src-tauri/kabegame-core/src/providers/date_group.rs`](/src-tauri/kabegame-core/src/providers/date_group.rs)（`VdByDateProvider` + 范围）
- [`src-tauri/kabegame-core/src/gallery/browse.rs`](/src-tauri/kabegame-core/src/gallery/browse.rs)
- [`src-tauri/kabegame-core/src/providers/vd_ops.rs`](/src-tauri/kabegame-core/src/providers/vd_ops.rs)
- [`src-tauri/kabegame-core/src/providers/cache.rs`](/src-tauri/kabegame-core/src/providers/cache.rs)
