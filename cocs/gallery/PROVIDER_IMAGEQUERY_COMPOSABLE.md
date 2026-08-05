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
- **唯一查询对象 `GalleryQuery`**（[`galleryQuery.ts`](/apps/kabegame/src/utils/galleryQuery.ts)）：查询是一串节点（AND 序列），节点要么是原子 `is`（一个 `GalleryFilterSet`——各维度取值的 AND，**搜索是其中一个维度** `search: { mode, query }`），要么是 `any`（OR 分支）/ `not`（取非）组合器。旧的「简单过滤 FilterSet + 高级树 AdvancedQuery + search/searchMode」三份状态已统一：route store 只存 `query`（外加 `noAlbum`/`sort`/`page`/`pageSize`），简单过滤只是单原子查询的退化形态，用 `queryFromFilterSet` / `asSingleFilterSet` 在两种视图间投影。`noAlbum` 与 `hide` 并列，是随行路由上下文不是查询（序列化为体首的 `no-album/filter_comb/`）。查询体的序列化/解析（含 `~` 组合器、legacy 形态兼容）全在 `galleryQuery.ts`，整路径（root/no-album/sort/分页）的拼装在 [`galleryPath.ts`](/apps/kabegame/src/utils/galleryPath.ts)，依赖方向恒为 galleryPath → galleryQuery。搜索模式在搜索词为空时不进 path，由各 store 模块级 sticky ref（`galleryStickySearchMode` 等）兜底，经查询行的 `search-mode-change` 事件维护。
- **组件不认识 route store**：所有会改查询的动作汇成一个 `navigate(patch, options)` 事件，由各页转交自己的 path-route store（`GalleryQueryPatch = { query?, noAlbum?, sort?, page?, pageSize? }`，定义在 [`galleryPath.ts`](/apps/kabegame/src/utils/galleryPath.ts)）。跨字段改动一次导航完成，不会被拆成多次互相覆盖。差异靠 props 表达：`filterFeatures` / `sortFeatures`（前端过滤维度固定为 `plugin` / `mediaType` / `date` / `size` / `aspect`；名称语言桶与“设置过壁纸”只保留后端 Provider，不再进入 `GalleryBrowseDimension`）、`searchFeatures`（搜索 chip 可见的目标 tab：画廊/画册详情吃默认全 5 项 `display-name`/`local-path`/`url`/`metadata`/`native-metadata`，任务/畅游详情传 `GALLERY_SEARCH_MODES_BASIC` 只留前三；高级弹窗链路经 `searchModesContext.ts` 的 provide/inject 下发，当前 mode 不在集合内时临时补进 tab 而不静默改写）、`providerContextPrefix`（facet 树的上下文 = store 的 `computedContextPath`，含单原子查询的搜索段）、`contextBase`（高级路径基址 = store 的 `contextPathFor({ query: [] })`，**不含查询体**，查询体含搜索原子由组件自己拼，基址再带一份会重复）、`enableClearAll`（画廊的清除全部在副标题里，故只有三个详情页开）。
- 文案口径（chip 值、安卓折叠菜单标签、排序升降序说法）统一在 [`galleryFilterLabels.ts`](/apps/kabegame/src/utils/galleryFilterLabels.ts)，工具栏与查询行共用一份。
- Android：查询行只渲染「高级查询」按钮，简单过滤 / 排序 / 每页条数仍由各页 `PageHeader` 的 fold 触发——header 通过组件 ref 调 `openFilterPicker` / `openSortPicker` / `openPageSizePicker` 打开 van-picker（高级查询生效时 `openFilterPicker` 直接 no-op，两者在路由上互斥）。
- **高级查询在四条路由上都可用**。detail 路由的查询体写在根前缀之后（`album/<id>/~any/…/~end/sort/…`）：`~` 组合器由引擎在 provider resolve 之前拦截（[`where_group.rs`](/src-tauri/pathql-rs/src/provider/where_group.rs)），分支从组入口 provider 出发，故不需要 DSL 配合；但原子的**搜索格**是普通路径段，需要 `gallery_album_provider` / `gallery_task_provider` / `gallery_surf_provider` 的 resolve 分支里列出 `search`（已加），否则 `album/<id>/search/<mode>/<q>` 路由不到。新形态的规范路径统一根前缀在前、搜索原子在体内；旧形态（`search/<mode>/<q>` 前缀在根之前、`no-album` 混在维度序列体首）解析层仍兼容，写回即归一为新形态。「简单 / 高级」在 UI 上只是同一 `GalleryQuery` 的两种投影：单原子查询两边都能编辑，切视图不动状态；含 或/非/多条件 的查询强制高级视图，带着它切回简单只能清空并 toast 明示。
- **高级弹窗的 facet 树：枚举与计数分家**（[`useAdvancedQueryFacets.ts`](/apps/kabegame/src/composables/useAdvancedQueryFacets.ts) + [`galleryFilterTree/context.ts`](/apps/kabegame/src/components/galleryFilterTree/context.ts)）。旧「减格树」（把其余条件折叠成上下文再列维度）是简单查询「不断收窄」时代的产物，在高级查询里其他条件（尤其取非行的兄弟约束）会把候选列表挤没。现在：**枚举**走纯净路径 `<contextPrefix>/<维度 router>`，与草稿树无关，候选全集稳定，经 `listProviderDirsPure` 按路径缓存（不带 count，images-change / plugin 事件整体失效）；**计数**走整树预测——把候选值经 `filterFromTreeSegment`（`serializeFilterForTree` 的逆）写进 NodePath 所指原子的对应维度，序列化整棵草稿树取命中数，节点上显示与当前命中数基线（`useAdvancedHitCount`）的净变化 `+N/−N/0`（取非/或组的符号由整树语义自然得出）。context 的接缝：`pathForSegment` 恒为计数路径，`listPathForSegment` 缺省回退它（侧栏减格语义不变），`countBaseline` 有值即进入 diff 显示。侧栏简单过滤树（`GalleryFilterTree.vue` provide 侧）完全不变，仍是减格路径 + 绝对计数。组内/取非行的 plugin extend 候选在预测时与选择时同一口径降级为裸插件。
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
