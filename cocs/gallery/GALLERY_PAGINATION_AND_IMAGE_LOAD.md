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

### 预览深链接定位（`pvwimgid` 指向视图外的图）

`ImagePreviewDialog` 的 `image` prop 允许只传裸 id，但开启跟页时不提前走这条单图路线。
带 `pvwimgid` 的链接先记录目标预览 id，等待当前路径的快照应用完成；在本页找到行就显示，
否则按当前过滤与排序算出序号，换成页码跳过去，直到目标页快照确认后才传入 `ImageInfo`。

序号由一条 PathQL 路径给出，形态是 `<当前视图去掉分页尾>/~~/rank/~~/id_<id>`：

```
images://gallery/hide/album/<id>/sort/by-time/desc  /~~/ rank /~~/ id_2719
└───── 内层 pq_nest_1：过滤 + ORDER BY，无 LIMIT ─────┘      │         │
                                     打 row_index 列 ───────┘         │
                             既有 id_<id> 路由挑出目标行 ──────────────┘
```

- 必须分三层：窗口函数在 `WHERE` 之后求值，`WHERE id = ?` 与 `ROW_NUMBER()` 同层时序号恒为 1。
- 内层**不能带分页**：定位要的是全集里的位置。前端用 `stripPageTail`（只剥 `[x<N>x/]<页码>`，
  **保留 `desc` 与排序段**）从 `routeStore.computedPath` 推出内层；不要复用
  `stripComposablePathTail`，它连 `desc` 一起剥，会把序号算反。
- `ROW_NUMBER() OVER ()` 不写 ORDER BY，靠的是 `~~` 把内层冻结为物化 CTE 后、扫描序即内层
  `ORDER BY` 序（见 `cocs/provider-dsl/RULES.md` §2.1）。**前提是排序为全序**：gallery 的每条
  sort provider 都以 `images.id asc` 收尾，`gallery_route` 的默认排序同样带这条兜底。
  少了它，`ORDER BY … LIMIT` 的 top-N sorter 与全量 sort 可能给同一并列组不同次序 —— 定位会落到
  相邻页，分页本身也会在并列跨页处重复/漏行。
- 空结果 = 这张图**不在该视图里**（被过滤掉、或 `hide/` 开着而它已隐藏），不是错误：保持单图模式。
- `page = floor((row_index - 1) / pageSize) + 1`。页大小不进路径，换页大小不必重查。

统一入口是 `reconcilePreviewForReadyPage`：观察目标 id、列表、路径、激活状态与跟页开关，
只在 `loadedKey === rawViewPath()` 且 `!liveQuery.loading` 时协调。`liveQuery` 按查询 key 计数真实
在途读取，必须等快照应用和当前 key 的全部请求结束；旧页返回不能提前结束新页 loading，
同路径刷新也不会拿旧快照先定位。URL 入口只设置目标 id，不负责取图或定位；列表更新、
手动翻页、过滤变化和重新开启开关都走同一个入口。用户隐藏/删除导致当前图离开视图时仍由
下标锚点（`previewAnchor`）先接管，不能定位旧图。预览上/下一张跨页时，`pendingPreviewBoundary`
持续到分页器交出新 id，跟页协调暂不介入，避免定位切换前的旧图。

弹窗的 `ImageInfo` 保存在 `ImageGrid.previewImageInfo`，不直接由 `images` 的当前页成员计算。
快照先更新网格，随后检查当前 id：找到就更新预览对象；没找到则保留上一份对象直到定位与翻页
完成。`jumpToPage()` 只等待路由导航，不保证数据已到；必须等目标页快照实际包含同一 id，才能
替换成目标页的行。整个阶段 `image` prop 不经过字符串/null，图片内容和 Panzoom 实例不会因
所有权切换卸载，缩放和平移得以保留。首次打开没有旧对象时保持 `null`，目标页确认之前不打开
弹窗；只有定位为空或关闭跟页时才交给裸 id 的单图路线。定位错误不等于不在视图中，保留旧预览
或等待态，后续快照再次尝试。因等待新 URL 目标而收起旧弹窗的 close 回报，不得取消新目标。

定位防重只覆盖在途请求及同一 `<分页路径, id, 页大小, 快照 seq>` 的重复尝试，不永久缓存
`<视图>|<id>`。目标页到达时如果持续下载又改变了位置，按该快照重新定位；后续跨页同样可以
重新定位。切图、关预览、停用视图、手动导航或关闭开关会使旧请求失效，迟到结果不能改页。
手动导航后若目标 id 未取消且仍开启跟页，新页就绪后会重新定位到该 id；防重命中不代表不存在，
不得清空旧对象或开启裸 id 模式。

开关是「外观」里的 `previewFollowPage`（localStorage 后端，**默认开**）。关掉后不查序号、不跳页，
弹窗仍以裸 id 把那张图画出来，只是没有左右箭头 —— 即重构后的单图模式本身。

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
- **被动通道**：下载、同步、整理、其他窗口或 MCP 引起的 `image-changed`、`images-change`、`album-images-change` 与
  画册结构字段变更进入全局单例
  [`dataChangeHub.ts`](/apps/kabegame/src/services/dataChangeHub.ts)。hub 对每个订阅者按 500ms 时间窗合并
  reason 与各 id 集合，并按 imageId 浅合并 `imagePatches`（后到字段覆盖先到字段）；画册维度另含
  `albumIds` / `albumImageIds`、按到达顺序保存的 `favoriteOps`，以及
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

后端 `GlobalEmitter` 为 `image-changed`、`images-change`、`album-images-change` 与进入 hub 的
`album-changed` 共用一个单调递增计数器，四者 payload 都携带 `seq`。

读取视图快照时必须**先读取 `seq`，再执行 rows/count 查询**。带 `view` 的写命令在写库前取得全局
`EventHold`：期间两类视图事件照常分配 `seq` 但暂存，快照读完、守卫析构后才按序广播。因此事件不会触发
查询来插队同一次主动快照，且出错路径也会由 `Drop` 放行：

- `liveQuery` 的 `appliedSeq` 已覆盖某事件时，`maxSeq <= appliedSeq` 的回声批次不再重拉；
- 任意返回快照的 `seq < appliedSeq` 时丢弃，旧的在途请求不会覆盖新列表；
- 读数据期间新发出的事件具有更大的序号，随后会再触发一次拉取，允许多拉但不会漏变更。

### `images-change`（`AppEvent::ImagesChange`，`images` 表）

- 后端通过 `GlobalEmitter::emit_images_change` 广播，reason 只包括 `add` / `delete` / `change`。
- Payload：必带 `seq`、`reason`、`imageIds`，可选 `taskIds` / `surfRecordIds` / `pluginIds`。
  这些可选维度只是免费 hint：删除图片不再为 payload 额外查询 surf/plugin，删除任务只带 task；维度缺失表示
  无法排除当前视图，而不是“不相关”。
- 删除畅游记录会补发带 `surfRecordIds` 的 `change`；整理每批重写缩略图/兼容路径后会按批补发 `change`。
- ImageGrid 只通过 `dataChangeHub` 监听；`useImagesChangeRefresh.ts` 仍保留给 Surf.vue、工具栏等旧消费方。

### `image-changed`（`AppEvent::ImageChanged`，`ImageInfo` 字段）

- Payload 为 `seq` + `patches[]`；每组 patch 用 `imageIds` 表示共享同一份 `diff` 的图片。`diff` 键为
  `ImageInfo` camelCase 字段，值是绝对值快照，不是增量。
- 同一次写入先发 `image-changed`即时 patch 当前页，再发 `images-change("change", ids)`；后者保留
  500ms 权威快照对账，处理排序、搜索成员与分面变化。`EventHold` 保持两条事件的顺序。
- 可 patch 字段为 `displayName`、`pluginId`、`metadataId`、`pluginVersion`、`postUrl`、
  `thumbnailPath`、`compatiblePath`、`localPath`、`surfRecordId`、`taskId`、`lastSetWallpaperAt`、
  `isHidden`、`favorite`、`type`、`size`。`width` / `height` 刻意排除，避免正在预览时打断 PhotoSwipe 缩放。
- Grid 用 `patchMany` 单次遍历当前页并替换一次数组；`metadataId` / `pluginVersion` 变化会自然改变
  metadata cache key，无需额外失效。

### `album-images-change`（`AppEvent::AlbumImagesChange`，`album_images` 表）

- `image_events.rs` 的私有发送器保证每条事件只描述一个画册；公开写入口统一为
  `emit_membership_added` / `emit_membership_removed`，`imageIds` 只含实际插入或删除的成员。
- Payload：`seq`、`reason`、单元素 `albumIds`、该画册实际变化的 `imageIds` 与 `ancestorPath`；不再携带
  `directCounts`。
- 隐藏/取消隐藏除精确画册成员事件外，一定再发一条 `images-change("change", ids)`，供任务、畅游、工具栏和
  过滤树等其它可见性视图兜底刷新。
- 前端不增量维护全量计数。目录页一次三路 fetch：`albums://<过滤段>/x<N>x/<页>` 取这一页的画册行
  （默认按创建时间排序）；`…/~~/children[/<类型段>]` 与 `…/~~/images[/hide]` 在 `~~` 子查询边界之后按画册
  `GROUP BY`，分别给出 `child_count`（同类型过滤下的直接子画册数，标签目录直接显示它）与 `image_count`
  （子树成员行数，标签叶子即直接成员数），没有行的画册计 0；与 `images://gallery/[hide/]album/<id>`、
  `album-tree/<id>` 的 entry 总数同口径。`/hide` 对应 `hide/` 前缀（不数隐藏画册里的图片）。每页固定 3 条 SQL，
  内层分页物化为 CTE、子树走 `idx_albums_ancestor_path` 区间，见 [../provider-dsl/RULES.md](../provider-dsl/RULES.md) §2.1。
- Plasma 壁纸插件（`src-plasma-wallpaper-plugin/plugin/wallpaperbackend.cpp`）同时订阅上述两类事件：画册路径以 `album-images-change` 为主；`images-change` 在画册视图下主要响应 `delete`/`change`（删文件、壁纸顺序等）。

## 排查清单

1. **翻页页码不对**：确认 `query.path` 末尾页码与 `useProviderPathRoute.currentPage` 一致，且切页后有触发 `navigateToPage`。
2. **改每页条数后仍显示旧页**：确认对应视图对 `pageSize` 有 `watch`，并 `navigateToPage(1)` 或重新 `loadCurrentPage`。
3. **VD 下列表仍是 100 一段**：符合设计；Greedy 路径不使用 `galleryPageSize`。
4. **删除后列表延迟或闪回**：确认调用从 `ctx.mutate` 传入了 `view`，返回快照的 `seq` 被
   `liveQuery.apply` 接收；不要靠 `images-change` 回刷当前操作。
5. **任务/畅游详情收到无关刷新**：检查 hub 批次的 `wildcard.task/surf`。缺维度必须刷新，带维度时才允许按 id 排除。
6. **带 `pvwimgid` 的链接没跳到目标图所在页**：先直接查
   `images://<视图>/~~/rank/~~/id_<id>`（`kabegame-cli pathql query … --fetch`）。返回空集说明图确实不在
   该视图（检查 `hide/` 与过滤段）；有 `row_index` 但页码不对，查前端是否误用了
   `stripComposablePathTail` 而把 `desc` 剥掉了。
7. **定位落到相邻页 / 分页在某处重复或漏行**：当前排序不是全序。检查该 sort provider 的 `order` 是否
   以 `images.id asc` 收尾 —— 用了 `clear: "all"` 的 provider 必须自己补回这条兜底。

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
| 深链接定位（前端） | `apps/kabegame/src/services/imageLocate.ts` |
| 序号 provider | `src-tauri/kabegame-core/src/providers/dsl/shared/rank_provider.json5` |
