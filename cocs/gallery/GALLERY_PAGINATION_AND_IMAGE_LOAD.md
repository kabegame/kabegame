# 画廊分页与 SimplePage 图片加载数据流

本文档说明**主应用内**通过 `provider` 路径浏览图片列表时的分页、每页条数设置与前后端调用链，便于排查「翻页不对」「改每页条数不刷新」「列表为空」等问题。  
虚拟盘（VD）Greedy 目录树仍使用后端固定的 `LEAF_SIZE`（与 SimplePage 可配置页大小无关），详见下文「与 VD 的区别」。

## 与 `PROVIDER_IMAGEQUERY_COMPOSABLE.md` 的关系

- `PROVIDER_IMAGEQUERY_COMPOSABLE.md` 描述 **ImageQuery 如何组合**（JOIN / WHERE / ORDER）以及 Provider 解析与缓存。
- **本文档**描述：**路径 + 页码 + 每页条数** 如何落到 **一次浏览请求**（`browse_gallery_provider`）与前端 `offset` / 分页器对齐。

两者互补：查询语义见前者，分页与加载条数见本文。

## 核心概念

| 概念 | 说明 |
|------|------|
| **provider 路径** | 路由 `query.path`（如 `all/1`、`album/<uuid>/1`、`task/<id>/1`），末尾数字段为**逻辑页码**（第几页）。 |
| **SimplePage** | Provider 解析结果为「叶子」：`ProviderDescriptor::SimplePage { query, page }`。后端按 `ImageQuery` 计数 + **offset/limit** 取一页。 |
| **Greedy / 非 SimplePage** | 目录树、range 分解等；后端 `browse.rs` 内仍用固定 `LEAF_SIZE = 100` 做贪心分段，**不使用**用户配置的每页条数。 |
| **每页条数 `galleryPageSize`** | 用户设置 `100 / 500 / 1000`，持久化在 Rust `Settings`（JSON 键 `galleryPageSize`），仅影响 **SimplePage** 的 `limit` 与 offset 计算。 |

## 后端

### 命令：`browse_gallery_provider`

- **位置**：[`src-tauri/kabegame/src/commands/image.rs`](/src-tauri/kabegame/src/commands/image.rs)（Tauri 命令，参数 `page_size`）。
- **前端 invoke**：必须使用 **camelCase** 参数名 **`pageSize`**（与 Tauri 对前端参数名的约定一致），否则会出现缺少参数错误。
- **实现**：[`src-tauri/kabegame-core/src/gallery/browse.rs`](/src-tauri/kabegame-core/src/gallery/browse.rs) 的 `browse_gallery_provider(storage, provider_rt, path, page_size)`。

### SimplePage 分支（可配置页大小）

- 对 `page_size` 做白名单归一：`100 | 500 | 1000`，否则按 `100`。
- `offset = (page - 1) * page_size`，`get_images_info_range_by_query(query, offset, page_size)`。
- 返回 `GalleryBrowseResult`：`total`、`base_offset`、`range_total`、`entries`（当前页图片列表）。

### Metadata 懒加载（列表不带插件 JSON）

为减少翻页时读取/传输/解析整页插件 JSON，**浏览列表**路径统一不返回 metadata，只返回 `metadata_id`：

- **Provider / storage 查询**：列表只带 `metadata_id`，不内联 `metadata.data`。
- **详情区**：通过 `metadata_id` 或 `imageId` 懒加载 JSON。

详情区（EJS / 原始键值）按需加载：

- **命令**：`get_image_metadata`（[`kabegame/src/commands/image.rs`](/src-tauri/kabegame/src/commands/image.rs)），参数 **`imageId`**（与前端 camelCase 一致）。
- **实现**：[`Storage::get_metadata`](/src-tauri/kabegame-core/src/storage/images.rs) 通过 provider 路径读取 `metadata.data`。

### 与 VD / Greedy 的区别

- **SimplePage**：一页行数 = 用户设置的 `galleryPageSize`（经上述 clamp）。
- **Greedy 等路径**：`browse.rs` 仍使用文件内 `LEAF_SIZE = 100` 做目录拆分，**不**读 `galleryPageSize`。

### 设置持久化

- **Rust**：`SettingKey::GalleryPageSize`、getter/setter（与 `gallery_grid_columns` 同类模式）。
- **CLI**：`pathql query` 直接查询 PathQL，不读取 `galleryPageSize`；分页大小和页码由查询路径本身表达（如 `images://gallery/all/x100x/1`）。

## 前端

### 设置层

- **Store**：[`packages/core/src/stores/settings.ts`](/packages/core/src/stores/settings.ts)  
  - `AppSettings.galleryPageSize`  
  - `buildSettingKeyMap` 中 `get_gallery_page_size` / `set_gallery_page_size`，参数名 `size`（全平台通用键）。

### 路由与页码

- **Composable**：[`apps/kabegame/src/composables/useProviderPathRoute.ts`](/apps/kabegame/src/composables/useProviderPathRoute.ts)  
  - 仅维护 `currentPath / providerRootPath / currentPage`，不再额外暴露 `currentOffset`。  
  - 大页分页器直接使用 `currentPage`，`pageSize` 只用于后端查询条数与翻页重载。

### 拉取当前页图片

- **组件**：[`apps/kabegame/src/components/ImageGrid.vue`](/apps/kabegame/src/components/ImageGrid.vue)。
- 首次加载、翻页与事件刷新统一调用 `pathql_view({ rows, count })`，一次 IPC 返回
  `{ rows, total, seq }`，不再把 `pathql_fetch(rows)` 与 `pathql_entry(count)` 分成两次请求。
- `rows` 是带页码的当前列表路径；`count` 由 adapter 的 `computeCountPath` 从同一视图推导。
- 每次应用快照前清空 `useProvideImageMetadataCache` 的 per-page 缓存；列表行仍不内联 metadata。
- [`apps/kabegame/src/composables/usePagedGallery.ts`](/apps/kabegame/src/composables/usePagedGallery.ts)
  只负责页码、越界回退与预览跨页，数据和总数由同一个视图快照更新。

### Metadata 详情与前端缓存

- **Composable**：[`packages/core/src/composables/useImageMetadataCache.ts`](/packages/core/src/composables/useImageMetadataCache.ts) — `useProvideImageMetadataCache()` 向子组件树 `provide` 懒加载解析器（内部 `Map` 缓存 + `invoke("get_image_metadata", { imageId })`）。
- **详情 UI**：[`packages/core/src/components/common/ImageDetailContent.vue`](/packages/core/src/components/common/ImageDetailContent.vue) — `inject` 解析器；若列表项已有可渲染 `metadata` 则直接用，否则异步拉取并合并为 `effectiveMetadata`。
- **详情来源**：`ImageDetailContent.vue` 的来源优先显示 `pluginId` 对应插件；没有 `pluginId` 但有 `surfRecordId` 时，通过 `packages/core/src/stores/surf.ts` 读取 Surf host 并可跳转 `/surf/:host/images`；两者都没有时显示 `unknown`。
- **接入视图**（在拉取当前 leaf 前 `clearCache`）：[`Gallery.vue`](/apps/kabegame/src/views/Gallery.vue)（经 `useGalleryImages` 的 `onBeforeFetch`）、[`Albums.vue`](/apps/kabegame/src/views/Albums.vue)、[`TaskDetail.vue`](/apps/kabegame/src/views/TaskDetail.vue)、[`SurfImages.vue`](/apps/kabegame/src/views/SurfImages.vue)。

### 使用 SimplePage 列表的视图（需统一）

以下视图从设置读取 `galleryPageSize`，经各自 route store 与 `ImageGrid` adapter 构造 PathQL 路径，并在 **`pageSize` 变化时回到第 1 页并刷新**：

- [`apps/kabegame/src/views/Gallery.vue`](/apps/kabegame/src/views/Gallery.vue)
- [`apps/kabegame/src/views/Albums.vue`](/apps/kabegame/src/views/Albums.vue)
- [`apps/kabegame/src/views/TaskDetail.vue`](/apps/kabegame/src/views/TaskDetail.vue)
- [`apps/kabegame/src/views/SurfImages.vue`](/apps/kabegame/src/views/SurfImages.vue)

过滤树等辅助请求仍可独立读取计数；ImageGrid 的列表与分页总数必须走 `pathql_view`，不能重新拆成两次请求。

### UI：每页条数入口

- **画廊**：[`GalleryToolbar.vue`](/apps/kabegame/src/components/GalleryToolbar.vue)（桌面下拉；Android：header fold + `van-picker`）。
- **画册页**：[`Albums.vue`](/apps/kabegame/src/views/Albums.vue) 中栏的 `GalleryQueryBar` + `GalleryBigPaginator`。
- **任务 / 畅游**：分页器上方工具行内嵌 `GalleryPageSizeControl`（`android-ui="inline"`）。
- **设置**：[`GalleryPageSizeSetting.vue`](/apps/kabegame/src/components/settings/items/GalleryPageSizeSetting.vue)，[`Settings.vue`](/apps/kabegame/src/views/Settings.vue) 应用设置区。

Surf 记录列表不分页：`packages/core/src/stores/surf.ts` 初始化时一次性读取全部记录，之后通过 `surf-records-change` / `surf-session-changed` 维护缓存；`Surf.vue` 和 `SurfImages.vue` 都以该 store 为读取源头，不再各自全量刷新。

### i18n

- `settings.galleryPageSize` / `settings.galleryPageSizeDesc`
- `gallery.pageSize`（工具栏/选择器标题）
- `header.galleryPageSize`（Android header fold 文案）

## 图片与画册成员变更事件

### ImageGrid 的主动 / 被动双通道

ImageGrid 把数据变化分成两条通道：

- **主动通道**：当前网格发起且会改变结果集的写操作走 `ctx.mutate`。命令携带当前
  `ViewQuery { rows, count }`，写入并发出事件后立即读取并返回 `ViewSnapshot`，前端直接应用，不等待防抖。
  永久删除、隐藏/取消隐藏、加入/移出画册与上划移除均已接入。
- **就地字段更新**：不会改变结果集的收藏走 `ctx.patch`，成功后立即修改当前行的 `favorite`。
- **被动通道**：下载、同步、整理、其他窗口或 MCP 引起的 `images-change`、`album-images-change` 与
  画册结构字段变更进入全局单例
  [`dataChangeHub.ts`](/apps/kabegame/src/services/dataChangeHub.ts)。hub 对每个订阅者按 500ms 时间窗合并
  reason 与各 id 集合；画册维度另含 `albumIds` / `albumImageIds`、按到达顺序保存的 `favoriteOps`，以及
  `albumPaths` / `albumPathsWildcard` 和结构字段集合。画册成员事件携带画册 `ancestorPath`；新增、删除、
  改名、移动事件也提供新旧祖先路径，已加载目录用路径前缀判断相关性。任一 `images-change` 缺少
  task/surf/plugin 维度时把该维度记为 wildcard。回调串行执行，执行期间的新批次会合并后补跑。
- [`liveQuery.ts`](/apps/kabegame/src/services/liveQuery.ts) 以 `{ rows, count }` 为 key 共享同一在途请求；
  inactive 时只标脏，恢复后补拉。gallery/album 全部相关，task 与 surf 只按免费维度或 wildcard 粗过滤。

画册写命令除 `view` 外始终返回本次已发送事件的 `albumChanges` 副本。无状态 `services/albums.ts` 把返回的
成员事件用 `publishLocal` 立即投递；hub 记录其 `seq`，随后到达的同序号后端事件直接丢弃。画册树不维护全量
列表或全量计数，只重拉相关的已加载目录；画册视图仍由主动快照或被动查询决定过滤、排序和分页后的最终行位置。
预览中的 `ImageLabelsPanel` 为避免替换底层列表导致跳页，保留 500ms 被动刷新。

### `seq` 一致性协议

后端 `GlobalEmitter` 为 `images-change`、`album-images-change` 与进入 hub 的 `album-changed` 共用一个
单调递增计数器，三者 payload 都携带 `seq`。

读取视图快照时必须**先读取 `seq`，再执行 rows/count 查询**。带 `view` 的写命令在写库前取得全局
`EventHold`：期间两类视图事件照常分配 `seq` 但暂存，快照读完、守卫析构后才按序广播。因此事件不会触发
查询来插队同一次主动快照，且出错路径也会由 `Drop` 放行：

- `liveQuery` 的 `appliedSeq` 已覆盖某事件时，`maxSeq <= appliedSeq` 的回声批次不再重拉；
- 任意返回快照的 `seq < appliedSeq` 时丢弃，旧的在途请求不会覆盖新列表；
- 读数据期间新发出的事件具有更大的序号，随后会再触发一次拉取，允许多拉但不会漏变更。

### `images-change`（`DaemonEvent::ImagesChange`，`images` 表）

- 后端通过 `GlobalEmitter::emit_images_change` 广播，reason 包括 `add` / `delete` / `change` / `rename` /
  `metadata-migrate`。
- Payload：必带 `seq`、`reason`、`imageIds`，可选 `taskIds` / `surfRecordIds` / `pluginIds`。
  这些可选维度只是免费 hint：删除图片不再为 payload 额外查询 surf/plugin，删除任务只带 task；维度缺失表示
  无法排除当前视图，而不是“不相关”。
- 删除畅游记录会补发带 `surfRecordIds` 的 `change`；整理每批重写缩略图/兼容路径后会按批补发 `change`。
- ImageGrid 只通过 `dataChangeHub` 监听；`useImagesChangeRefresh.ts` 仍保留给 Surf.vue、工具栏等旧消费方。

### `album-images-change`（`DaemonEvent::AlbumImagesChange`，`album_images` 表）

- `image_events.rs` 的私有发送器保证每条事件只描述一个画册；公开写入口统一为
  `emit_membership_added` / `emit_membership_removed`，`imageIds` 只含实际插入或删除的成员。
- Payload：`seq`、`reason`、单元素 `albumIds`、该画册实际变化的 `imageIds` 与 `ancestorPath`；不再携带
  `directCounts`。
- 隐藏/取消隐藏除精确画册成员事件外，一定再发一条 `images-change("change", ids)`，供任务、畅游、工具栏和
  过滤树等其它可见性视图兜底刷新。
- 前端不增量维护全量计数。目录页并行列举图片与画册命名空间：前者的 `with_count` 给出每个子画册的
  直接图片数，后者的 `with_count` 给出直接子画册数；普通 / 本地文件夹画册再读取
  `images://gallery/[hide/]album-tree/<id>` 的 entry 总数得到子树成员行之和。标签目录显示直接子画册数，
  标签叶子显示直接成员数。隐藏口径只由 `hide/` 路径前缀表达。
- Plasma 壁纸插件（`src-plasma-wallpaper-plugin/plugin/wallpaperbackend.cpp`）同时订阅上述两类事件：画册路径以 `album-images-change` 为主；`images-change` 在画册视图下主要响应 `delete`/`change`（删文件、壁纸顺序等）。

## 排查清单

1. **翻页页码不对**：确认 `query.path` 末尾页码与 `useProviderPathRoute.currentPage` 一致，且切页后有触发 `navigateToPage`。
2. **改每页条数后仍显示旧页**：确认对应视图对 `pageSize` 有 `watch`，并 `navigateToPage(1)` 或重新 `loadCurrentPage`。
3. **VD 下列表仍是 100 一段**：符合设计；Greedy 路径不使用 `galleryPageSize`。
4. **删除后列表延迟或闪回**：确认调用从 `ctx.mutate` 传入了 `view`，返回快照的 `seq` 被
   `liveQuery.apply` 接收；不要靠 `images-change` 回刷当前操作。
5. **任务/畅游详情收到无关刷新**：检查 hub 批次的 `wildcard.task/surf`。缺维度必须刷新，带维度时才允许按 id 排除。

## 涉及文件（速查）

| 层级 | 文件 |
|------|------|
| Rust 浏览 | `src-tauri/kabegame-core/src/gallery/browse.rs` |
| Tauri 命令 | `src-tauri/kabegame/src/commands/image.rs` |
| CLI PathQL 查询 | `src-tauri/kabegame-cli/src/main.rs` |
| 设置 | `src-tauri/kabegame-core/src/settings.rs` |
| 前端设置 | `packages/core/src/stores/settings.ts` |
| 路由 offset | `apps/kabegame/src/composables/useProviderPathRoute.ts` |
| 视图快照 | `src-tauri/kabegame-core/src/commands/view.rs` |
| 变更聚合 | `apps/kabegame/src/services/dataChangeHub.ts` |
| 实时查询 | `apps/kabegame/src/services/liveQuery.ts` |
| 列表加载 | `apps/kabegame/src/components/ImageGrid.vue` |
