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

- [`src-tauri/core/src/storage/gallery.rs`](/src-tauri/core/src/storage/gallery.rs)
  - `SqlFragment`
  - `ImageQuery`
  - builder API：`with_join` / `with_where` / `with_order` / `merge`
  - SQL 生成：`build_sql` / `build_count_sql`
  - 内省：`is_ascending` / `to_desc` / `album_id` / `is_unfiltered`

## 查询组件分层（可复用原理）

### 1) 数据源组件（JOIN + 可选 WHERE）

- `album_source(album_id)`：`album_images ai` 关联 + `ai.album_id = ?`
- `task_source(task_id)`：`task_images ti` 关联 + `ti.task_id = ?`

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
- `sort_by_task_order()`

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

- [`src-tauri/core/src/providers/main_root.rs`](/src-tauri/core/src/providers/main_root.rs)
- [`src-tauri/core/src/providers/common.rs`](/src-tauri/core/src/providers/common.rs)
- [`src-tauri/core/src/gallery/browse.rs`](/src-tauri/core/src/gallery/browse.rs)
- [`src-tauri/core/src/providers/vd_ops.rs`](/src-tauri/core/src/providers/vd_ops.rs)
- [`src-tauri/core/src/storage/gallery.rs`](/src-tauri/core/src/storage/gallery.rs)

画册详情（`album/<albumId>/…`）在 `MainAlbumsProvider::resolve_child` 下挂 `MainAlbumEntryProvider`：默认分支按抓取时间排序（`album_source` + `sort_by_crawled_at`），与 `desc`、`album-order`（`album_source` + `sort_by_album_order`）、`wallpaper-order` 子目录（画册内仅「曾设为壁纸」+ `sort_by_wallpaper_set_at`）组合；`album-order` 与 `wallpaper-order` 均支持子目录 `desc` 表示倒序。另支持 `image-only` / `video-only` 根段（`MainAlbumMediaEntryProvider` 等），在画册内叠加 `media_type_filter`。语义与根级 `all` / `wallpaper-order` 对齐。前端路径拼装见 [`apps/main/src/utils/albumPath.ts`](/apps/main/src/utils/albumPath.ts)。

画廊根级另有 `media-type/image`、`media-type/video`（`MainMediaTypeGroupProvider`）；虚拟盘中文根目录在 `RootProvider` 中为「按种类」→「图片」/「视频」（`MediaTypeGroupProvider`）。

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

- 位置：[`src-tauri/core/src/providers/cache.rs`](/src-tauri/core/src/providers/cache.rs)
- `key_prefix` 已提升（当前 `v4`，见 [`cache.rs`](/src-tauri/core/src/providers/cache.rs) 默认值）

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

- **唯一数据源**：`Storage::get_gallery_day_groups()`（按自然日 `YYYY-MM-DD` 聚合计数，SQL 在 [`storage/gallery.rs`](/src-tauri/core/src/storage/gallery.rs)）。
- **月分组**：不再单独跑按月 `GROUP BY` SQL；由 [`storage/gallery_time.rs`](/src-tauri/core/src/storage/gallery_time.rs) 的 `gallery_month_groups_from_days` 从日列表聚合得到，与前端年/月/树一致。
- **`GalleryTimeFilterPayload`**：`{ months, days }`，一次返回给前端；Tauri 命令 `get_gallery_time_filter_data`。
- **`providers` 对 `gallery_time` 的再导出**：`kabegame_core::providers` 仍导出 `GalleryTimeFilterPayload` 等与 `storage::gallery_time` 相同符号（便于与插件分组等并列使用）。
- **Gallery Main `date/*`**：`MainDateGroupProvider` 根目录为**年份**（`main_date_browse::gallery_distinct_years`）；子路径解析为 `MainDateScopedProvider`（年→月→日），与画廊 `date/<YYYY|YYYY-MM|YYYY-MM-DD>` 一致。
- **VD「按时间」**：`VdByDateProvider` 复用 `list_main_date_browse_root_entries` / `main_date_child_provider`，并额外提供「范围」与说明文件；时间层级与 Main 相同，不再单独按月平铺。

## 前端（画廊路径控件位置）

- 桌面：过滤 / 排序在 [`apps/main/src/components/GalleryToolbar.vue`](/apps/main/src/components/GalleryToolbar.vue) 中位于 `PageHeader` 与大页分页器之间的工具行（根路径为 `all` / `wallpaper-order` / `date/<YYYY|YYYY-MM|YYYY-MM-DD>` / `plugin/<id>` / `media-type/image|video` 时显示过滤；「按时间」为年→月→日嵌套子菜单，单链父级仅一项时在 [`apps/main/src/utils/galleryTimeFilterMenu.ts`](/apps/main/src/utils/galleryTimeFilterMenu.ts) 中折叠省略；数据来自 `get_gallery_time_filter_data`；「按插件」数据来自 `get_gallery_plugin_groups`；「按种类」为图片/视频子菜单；排序始终可用）。`PageHeader` 折叠栏中的过滤控件见 [`apps/main/src/header/comps/GalleryFilterControl.vue`](/apps/main/src/header/comps/GalleryFilterControl.vue)，行为一致。
- Android：同一文件内仍通过 `PageHeader` 的 fold 打开 van-picker；选「按时间」时分步选择（与折叠后的层级一致）；选「按插件」时再弹出插件列表 picker；选「按种类」时再弹出图片/视频 picker。
- 画册详情过滤条：[`apps/main/src/components/AlbumDetailBrowseToolbar.vue`](/apps/main/src/components/AlbumDetailBrowseToolbar.vue)，除全部 / 设置过壁纸外支持仅图片 / 仅视频（路径见 [`albumPath.ts`](/apps/main/src/utils/albumPath.ts)）。
- 按种类数量：Tauri 命令 `get_gallery_media_type_counts`（全库）、`get_album_media_type_counts`（单画册）；数据来自 `Storage::get_gallery_media_type_counts` / `get_album_media_type_counts`（[`storage/gallery.rs`](/src-tauri/core/src/storage/gallery.rs)），过滤下拉与折叠标签旁展示 `(n)`。

**分页与每页条数（SimplePage）**：路径末尾页码、`galleryPageSize` 设置与 `browse_gallery_provider` 调用链见 [`GALLERY_PAGINATION_AND_IMAGE_LOAD.md`](GALLERY_PAGINATION_AND_IMAGE_LOAD.md)（与本文的 ImageQuery 组合正交，可对照阅读）。

## 相关代码索引

- [`src-tauri/core/src/storage/gallery.rs`](/src-tauri/core/src/storage/gallery.rs)
- [`src-tauri/core/src/storage/gallery_time.rs`](/src-tauri/core/src/storage/gallery_time.rs)
- [`src-tauri/core/src/providers/main_date_browse.rs`](/src-tauri/core/src/providers/main_date_browse.rs)
- [`src-tauri/core/src/providers/common.rs`](/src-tauri/core/src/providers/common.rs)
- [`src-tauri/core/src/providers/main_root.rs`](/src-tauri/core/src/providers/main_root.rs)
- [`src-tauri/core/src/providers/date_group.rs`](/src-tauri/core/src/providers/date_group.rs)（`VdByDateProvider` + 范围）
- [`src-tauri/core/src/gallery/browse.rs`](/src-tauri/core/src/gallery/browse.rs)
- [`src-tauri/core/src/providers/vd_ops.rs`](/src-tauri/core/src/providers/vd_ops.rs)
- [`src-tauri/core/src/providers/cache.rs`](/src-tauri/core/src/providers/cache.rs)
