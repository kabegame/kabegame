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
| **视图本体 `viewBody`** | 路由 `query.path`、route store 与 localStorage 只保存「看什么、怎么排」（如 `album/<uuid>/sort/by-time/_kb_desc`），不含页码和页大小。 |
| **行路径 `rowsPath`** | `ImageGrid` 查询出口把分页尾追加到视图本体：`withPaged(viewBody, pageSize, page)` → `<viewBody>/_kb_x<N>x/<页>`。 |
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
- **CLI**：`pathql query` 直接查询 PathQL，不读取 `galleryPageSize`；分页大小和页码由查询路径本身表达（如 `images://gallery/all/_kb_x100x/1`）。

## 前端

### 设置层

- **Store**：[`apps/kabegame/src/stores/settings.ts`](/apps/kabegame/src/stores/settings.ts)。
- `settings.galleryPageSize` 是每页条数的唯一真源；设置页、查询条 Android picker 与其它页大小控件都只写该设置。
- `ImageGrid` 通过 `normalizeGalleryPageSize(settings.values.galleryPageSize)` 实时读取，route store 不保存、也不反向回写页大小。

### 路由与页码

- 四个 path-route store（画廊、画册详情、任务详情、畅游详情）只持有查询、排序和各自身份字段；
  `computedPath`、`?path=` 与画廊 localStorage 都是 `viewBody`，不含 `_kb_x<N>x/<页>`。
- 解析旧路径时仍会识别并剥掉 `_kb_x<N>x/<页>`，但页码和页大小直接丢弃，不迁移到本地状态或设置。
- [`usePagedGallery.ts`](/apps/kabegame/src/composables/usePagedGallery.ts) 在每个 `ImageGrid` 实例内持有 `currentPage`，
  并用 [`galleryPath.ts`](/apps/kabegame/src/utils/galleryPath.ts) 的唯一入口
  `withPaged(viewBody, pageSize, page)` 生成 `rowsPath`。
- `viewBody` 变化时页码同步回到 1，因此刷新、重启、浏览器后退和切换筛选/数据源都从第 1 页开始；
  keep-alive 下仅切走再切回同一视图时实例仍可保留本地页码。
- 页大小变化时保留旧页首张图的位置：
  `newPage = floor((oldPage - 1) * oldPageSize / newPageSize) + 1`。翻页和换页大小都不修改 URL。

### 拉取当前页图片

- **组件**：[`apps/kabegame/src/components/ImageGrid.vue`](/apps/kabegame/src/components/ImageGrid.vue)。
- 行与总数拆成两个独立读：行用 `pathql_fetch(path)`，总数用 `pathql_count(path)` 的 `total`；
  新旧由前端请求服务按路径分配的请求序号判断（见下文「kbEvents」）。
- 两者在后端都通过 PathQL 只读连接池执行，可以在不同连接上并行查询，不再与单写连接互相排队。
- 行路径带页码，首次加载、翻页、换筛选和相关数据变更都会重读；计数路径由 adapter 的
  `computeCountPath` 推导，只在路径变化或相关数据变更时重读。单纯翻页不再跑 COUNT。
- 每次应用快照前清空 `useProvideImageMetadataCache` 的 per-page 缓存；列表行仍不内联 metadata。
- [`apps/kabegame/src/composables/usePagedGallery.ts`](/apps/kabegame/src/composables/usePagedGallery.ts)
  只负责页码、越界回退与预览跨页；行和总数分别由 ImageGrid 的两个 live 状态更新。

### 预览深链接定位（`pvwimgid` 指向视图外的图）

`ImagePreviewDialog` 的 `image` prop 允许只传裸 id，但开启跟页时不提前走这条单图路线。
带 `pvwimgid` 的链接先记录目标预览 id，等待当前路径的快照应用完成；在本页找到行就显示，
否则按当前过滤与排序算出序号，换成页码跳过去，直到目标页快照确认后才传入 `ImageInfo`。

序号由一条 PathQL 路径给出，形态是 `<当前视图去掉分页尾>/~~/rank/~~/id_<id>`：

```
images://gallery/hide/album/<id>/sort/by-time/_kb_desc  /~~/ rank /~~/ id_2719
└───── 内层 pq_nest_1：过滤 + ORDER BY，无 LIMIT ─────┘      │         │
                                     打 row_index 列 ───────┘         │
                             既有 id_<id> 路由挑出目标行 ──────────────┘
```

- 必须分三层：窗口函数在 `WHERE` 之后求值，`WHERE id = ?` 与 `ROW_NUMBER()` 同层时序号恒为 1。
- 内层**不能带分页**：定位要的是全集里的位置。前端直接使用 `usePagedGallery.viewBody`；它保留
  `_kb_desc` 与排序段。不要复用 `stripComposablePathTail`，它连 `_kb_desc` 一起剥，会把序号算反。
- `ROW_NUMBER() OVER ()` 不写 ORDER BY，靠的是 `~~` 把内层冻结为物化 CTE 后、扫描序即内层
  `ORDER BY` 序（见 `cocs/provider-dsl/RULES.md` §2.1）。**前提是排序为全序**：gallery 的每条
  sort provider 都以 `images.id asc` 收尾，`gallery_route` 的默认排序同样带这条兜底。
  少了它，`ORDER BY … LIMIT` 的 top-N sorter 与全量 sort 可能给同一并列组不同次序 —— 定位会落到
  相邻页，分页本身也会在并列跨页处重复/漏行。
- 空结果 = 这张图**不在该视图里**（被过滤掉、或 `hide/` 开着而它已隐藏），不是错误：保持单图模式。
- `page = floor((row_index - 1) / pageSize) + 1`。页大小不进 `viewBody`；换页大小不必重查 rank，
  只需按新页大小换算目标页并读取新的 `rowsPath`。

统一入口是 `reconcilePreview`：观察目标 id、列表、路径、激活状态与跟页开关，切图或 `images`
变化后（渲染前）重查目标 id，判定**不对称**：
- **在当前快照里**：直接采用这一行，不等读取空闲。快照随时可能被事件刷新过时，等空闲换不来更新的
  结论；下一个快照落地时会再查一遍。视图内切图（邻居本就取自 `images`）与跨页交接（分页器在新页
  快照落地后才交出 id）因此不会把中间的 `null` 传给已打开的弹窗——否则弹窗把 `null` 当关闭，
  被动刷新在途时（web 弱网下可持续数秒）切图会先关闭再打开。在途定位请求只在就绪页命中时结束。
- **不在**：在途读取可能把它带回来，只在 `loadedKey === rawViewPath()` 且 `!rowsQuery.loading` 时
  才定位或降级，期间保留上一帧。`rowsQuery` 按行路径 key 计数真实在途读取，必须等快照应用和当前 key
  的全部请求结束；旧页返回不能提前结束新页 loading，同路径刷新也不会拿旧快照先定位。

URL 入口只设置目标 id，不负责取图或定位；列表更新、
手动翻页、过滤变化和重新开启开关都走同一个入口。用户隐藏/删除导致当前图离开视图时仍由
下标锚点（`previewAnchor`）先接管，不能定位旧图。预览上/下一张跨页时，`pendingPreviewBoundary`
持续到分页器交出新 id，跟页协调暂不介入，避免定位切换前的旧图。

弹窗的 `ImageInfo` 保存在 `ImageGrid.previewImageInfo`，不直接由 `images` 的当前页成员计算。
快照先更新网格，随后检查当前 id：找到就更新预览对象；没找到则保留上一份对象直到定位与翻页
完成。`jumpToPage()` 只修改 composable 的本地页码，不保证数据已到；必须等目标页快照实际包含同一 id，才能
替换成目标页的行。整个阶段 `image` prop 不经过字符串/null，图片内容和 Panzoom 实例不会因
所有权切换卸载，缩放和平移得以保留。首次打开没有旧对象时保持 `null`，目标页确认之前不打开
弹窗；定位为空或关闭跟页时进入单图模式：已持有这张图的对象（被动刷新刚把它移出视图，例如打开预览
才回填原生元数据、不再满足 `!词` 搜索）就继续给同一个对象，弹窗不重取、缩放不丢；没有对象（深链接首开）
才交给裸 id 的单图路线。视图外的图不给左右箭头（`previewCanPrev/Next` 只看它在当前列表里的位置）。
定位错误不等于不在视图中，保留旧预览
或等待态，后续快照再次尝试。因等待新 URL 目标而收起旧弹窗的 close 回报，不得取消新目标。

定位防重只覆盖在途请求及同一 `<rowsPath, id, 页大小, 快照 seq>` 的重复尝试，不永久缓存
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

以下视图都由 `ImageGrid` 从设置读取 `galleryPageSize`，再由 `usePagedGallery` 构造 PathQL 行路径；
`pageSize` 变化时按旧页首张图位置换算页码并刷新：

- [`apps/kabegame/src/views/Gallery.vue`](/apps/kabegame/src/views/Gallery.vue)
- [`apps/kabegame/src/views/Albums.vue`](/apps/kabegame/src/views/Albums.vue)
- [`apps/kabegame/src/views/TaskDetail.vue`](/apps/kabegame/src/views/TaskDetail.vue)
- [`apps/kabegame/src/views/SurfImages.vue`](/apps/kabegame/src/views/SurfImages.vue)

过滤树等辅助请求仍可独立读取计数；ImageGrid 的列表与分页总数必须分别走 `pathql_view`
与 `pathql_count`，不得在翻页时因行路径变化重读未变的计数路径。

### UI：每页条数入口

- **设置**：[`GalleryPageSizeSetting.vue`](/apps/kabegame/src/components/settings/items/GalleryPageSizeSetting.vue)，[`Settings.vue`](/apps/kabegame/src/views/Settings.vue) 应用设置区。
- **Android 四类图片页**：共用 [`GalleryQueryBar.vue`](/apps/kabegame/src/components/gallery/GalleryQueryBar.vue)
  的 header fold + `van-picker`；确认后直接保存 `settings.galleryPageSize`。
- [`GalleryPageSizeControl.vue`](/apps/kabegame/src/components/GalleryPageSizeControl.vue) 若被页面消费，
  `update:pageSize` 的消费方也只能保存设置，不得导航 route store。

Surf 记录列表不分页：`packages/core/src/stores/surf.ts` 初始化时一次性读取全部记录，之后通过 `surf-records-change` / `surf-session-changed` 维护缓存；`Surf.vue` 和 `SurfImages.vue` 都以该 store 为读取源头，不再各自全量刷新。

### i18n

- `settings.galleryPageSize` / `settings.galleryPageSizeDesc`
- `gallery.pageSize`（工具栏/选择器标题）
- `header.galleryPageSize`（Android header fold 文案）

## 图片与画册成员变更事件

### ImageGrid 的刷新来源

ImageGrid 的行与总数只有两种刷新来源，前端不区分操作是否写入：

- **用户操作（不防抖）**：首次加载、翻页、手动刷新，以及当前网格发起且会改变结果集的操作
  （`ctx.mutate(() => ...)`）。写命令不带 `view`、不返回快照，照常广播事件；`mutate` 在操作完成后直接请求
  当前行与总数，结果从数据源落地。永久删除、隐藏/取消隐藏、加入/移出画册与上划移除均已接入。
- **就地字段更新**：不会改变结果集的收藏走 `ctx.patch`，成功后立即修改当前行的 `favorite`。
- **事件（防抖）**：adapter 的 `refreshOn` 声明相关事件（每条只对一种事件：
  `images-change`、`album-images-change`、`album-changed`），防抖后请求，见下文「kbEvents」。
- **字段补丁（不发请求）**：`imagePatches$` 把 `image-changed` 与收藏画册的 `album-images-change`
  各自经 `batchWindow` 防抖、各自合并成 `Map<imageId, Partial<ImageInfo>>`（同 id 后到字段覆盖先到；收藏按到达
  顺序取最后一次），再 `merge` 成一条交给 `patchMany`。两者改的字段不重叠（`image-changed` 不带 `favorite`），
  两条流之间不需要排序。预览弹窗在裸 id 模式下也订阅它，另用 `triggers$` 对 `images-change` /
  `album-images-change` 重读当前图。
- **其它尚未迁移的消费方**（画册树、侧栏、头部计数、标签面板等）仍在全局单例
  [`dataChangeHub.ts`](/apps/kabegame/src/services/dataChangeHub.ts)。hub 对每个订阅者按 500ms 时间窗合并
  reason 与各 id 集合；画册维度含 `albumIds` / `albumImageIds`、`albumPaths` / `albumPathsWildcard` 和结构字段集合。
  画册成员事件携带画册 `ancestorPath`；新增、删除、改名、移动事件也提供新旧祖先路径，已加载目录用路径前缀判断相关性。
  任一 `images-change` 缺少 task/surf/plugin 维度时把该维度记为 wildcard。回调串行执行，执行期间的新批次会合并后补跑。

### kbEvents（`services/kbEvents/`，rxjs）

ImageGrid 的行、总数与字段补丁已迁到 [`services/kbEvents`](/apps/kabegame/src/services/kbEvents/index.ts)，
`dataChangeHub` / `liveQuery` 在迁移期保留给其它消费方。分三层，事件源与数据源是两种不同的 observable：

- **事件源** `kbEvent$(name)`：基于 `listen`（Tauri 事件或 Web SSE），同名事件共享一次监听，不解析内容。
  `events.ts` 的 `KbEventMap` 只是类型表；`on(event, relevant)` 声明一条单事件触发，`triggers$` 把多条合成刷新信号流。
- **pathql 核心**（单例，`pathqlSource.ts`）：按 `kind + key` 维护请求序列、rows / count 数据状态与观察方注册。
  - **请求**：`requestPathql(kind, key)` 每次序号 +1，可与在途请求并行；返回时序号大于当前数据状态的就更新，
    更小的静默丢弃（如接连发出 A、B，B 先返回则更新，A 后返回被丢弃）。用户操作直接调用，不防抖。
  - **观察方**：`lookPathql(kind, key, refreshOn)` 订阅期间注册一个观察方，收到数据、在途状态与事件刷新失败；
    观察方只看不请求。`refreshOn` 是观察方的过滤器，同一 key 所有观察方的过滤器向核心的**同一个 500ms 窗口**
    （`PATHQL_REFRESH_WAIT_MS`，经 `batchWindow`：空闲首票立即刷新，窗口内的票合并到窗口结束）投票，
    任一同意就刷新一次，结果推给该 key 的全部观察方。
  - 没有观察方且没有在途请求时回收该 key，不把离开路径的旧数据重放给后来者，也不再随事件刷新。
- **`usePathqlLooker`**：Vue 组合式观察方。key 变化时注销旧 key、注册新 key（旧路径的迟到结果与 loading 不影响新路径），
  key 为 null 时不注册；不带防抖时间、不发请求。ImageGrid 在计数路径变化时自己请求总数，首次加载 / 翻页 / 刷新 / `mutate` 自己请求行。
- **`imagePatches$(waitMs)`**（`imagePatches.ts`）：字段补丁流，每种事件一个 `batchWindow` + 自己的 reduce
  （`reduceImageChanged` / `reduceFavoriteChanges`），合并后 `merge`；与数据源无关，不发请求。
- 各 adapter 的 `refreshOn`：gallery 响应带 reason 的 `images-change`、「无画册」视图下的
  `album-images-change`，以及改结构字段（「无画册」视图下也含行字段）的 `album-changed`；album 响应
  `images-change`、包含本画册的 `album-images-change` 与本画册的 `album-changed`；task / surf 只按
  `taskIds` / `surfRecordIds` 或缺维度粗过滤 `images-change`。`album-added` / `album-deleted` 旧实现实际
  不触发网格刷新，暂不列入。

画册写命令始终返回本次已发送事件的 `albumChanges` 副本。无状态 `services/albums.ts` 把返回的
成员事件用 `publishLocal` 立即投递；hub 记录其 `seq`，随后到达的同序号后端事件直接丢弃。画册树不维护全量
列表或全量计数，只重拉相关的已加载目录；画册视图仍由操作后请求或事件触发的查询决定过滤、排序和分页后的最终行位置。
预览中的 `ImageLabelsPanel` 为避免替换底层列表导致跳页，保留 500ms 被动刷新。

### 一致性

后端 `GlobalEmitter` 为 `image-changed`、`images-change`、`album-images-change` 与 `album-changed`
共用一个单调递增计数器，四者 payload 都携带 `seq`；迁移期的 `dataChangeHub` 仍用它做本地发布去重。

ImageGrid 的行与总数不依赖后端 `seq`，只靠前端请求序列：

- 每次请求（事件防抖后或用户操作）都在发出时分配新序号，可并行；返回时序号大于当前数据状态才更新，
  旧的在途请求不会覆盖新状态；
- 写操作完成后的直接请求与随后到达的本次写事件触发的请求各一次，允许多读，按序号落地，结果一致；
- 读数据期间新发出的事件会再触发一次请求，允许多拉但不会漏变更；
- 若写操作删空最后一页，新总数到达后由 `usePagedGallery` 的 total watcher 把页码夹回新的最后一页。

### `images-change`（`AppEvent::ImagesChange`，`images` 表）

- 后端通过 `GlobalEmitter::emit_images_change` 广播，reason 只包括 `add` / `delete` / `change`。
- Payload：必带 `seq`、`reason`、`imageIds`，可选 `taskIds` / `surfRecordIds` / `pluginIds`。
  这些可选维度只是免费 hint：删除图片不再为 payload 额外查询 surf/plugin，删除任务只带 task；维度缺失表示
  无法排除当前视图，而不是“不相关”。
- 删除畅游记录会补发带 `surfRecordIds` 的 `change`；整理每批重写缩略图/兼容路径后会按批补发 `change`。
- 原生元数据挂载会改变 `search/native-metadata` 的成员：`ensure_native_metadata_for_hash/_for_image` 返回
  `NativeMetadataAttached.changed_image_ids`（实际改了 `image_metadata_id` 的图片，已挂同一行的不算），
  `image_metadata_id` 是图片字段，统一经 `image_events::emit_native_metadata_attached` 先发
  `image-changed`（`imageMetadataId`）再发 `images-change("change")`：预览按需解析（`get_image_native_metadata`）
  立即发，整理回填用 `native_metadata_image_patch` 并入本批补丁，下载入库只为同哈希的旧图补发（新图随后有 `add`）。
  前端原生元数据缓存 key 为 `imageId@n<imageMetadataId>`（插件元数据为 `m<metadataId>`），面板在同一张图只换
  `imageMetadataId` 时保留旧内容重新取数，不闪。
- ImageGrid 的行、总数与字段补丁都经 `kbEvents` 监听；`useImagesChangeRefresh.ts`
  仍保留给 Surf.vue、工具栏等旧消费方。
  `GalleryToolbar` 接收当前 `filter`，在同一次刷新中并行读取过滤后 count 与仅保留 `hide` 上下文的总 count，
  两条都完成后才整体替换副标题计数，避免 `images-change` 后显示出跨两代的“数量 / 总数”。

### `image-changed`（`AppEvent::ImageChanged`，`ImageInfo` 字段）

- Payload 为 `seq` + `patches[]`；每组 patch 用 `imageIds` 表示共享同一份 `diff` 的图片。`diff` 键为
  `ImageInfo` camelCase 字段，值是绝对值快照，不是增量。
- 同一次写入先发 `image-changed`即时 patch 当前页，再发 `images-change("change", ids)`；后者保留
  500ms 权威快照对账，处理排序、搜索成员与分面变化。`EventHold` 保持两条事件的顺序。
- 可 patch 字段为 `displayName`、`pluginId`、`metadataId`、`imageMetadataId`、`postUrl`、
  `thumbnailPath`、`compatiblePath`、`localPath`、`surfRecordId`、`taskId`、`lastSetWallpaperAt`、
  `isHidden`、`favorite`、`type`、`size`。`width` / `height` 刻意排除，避免正在预览时打断 PhotoSwipe 缩放。
- Grid 经 `imagePatches$` 收到合并后的补丁，用 `patchMany` 单次遍历当前页并替换一次数组；`metadataId` 变化会自然改变 metadata cache key，
  无需额外失效。

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
  `album-tree/<id>` 的 entry 总数同口径。`/hide` 对应 `hide/` 前缀（不数隐藏画册里的图片）。`label_dir` 不挂图，
  `~~/images` 不给它出行。行与 `child_count` 先到即渲染，`image_count` 是慢查询，单独到达后再补进树行。每页固定 3 条 SQL，
  内层分页物化为 CTE、子树走 `idx_albums_ancestor_path` 区间，见 [../provider-dsl/RULES.md](../provider-dsl/RULES.md) §2.1。
- Plasma 壁纸插件（`src-plasma-wallpaper-plugin/plugin/wallpaperbackend.cpp`）同时订阅上述两类事件：画册路径以 `album-images-change` 为主；`images-change` 在画册视图下主要响应 `delete`/`change`（删文件、壁纸顺序等）。

## 排查清单

1. **翻页页码不对**：确认 `query.path` 不含 `_kb_x`，`usePagedGallery.currentPage` 是期望值，且
   `rowsPath === withPaged(viewBody, pageSize, currentPage)`；翻页不应触发 route store 导航。
2. **改每页条数后仍显示旧页**：确认入口只写 `settings.galleryPageSize`，`ImageGrid` 的归一化
   `pageSize` 已更新，且本地页码按旧页首张图位置换算后触发新的 `rowsPath` 读取。
3. **VD 下列表仍是 100 一段**：符合设计；Greedy 路径不使用 `galleryPageSize`。
4. **删除后列表延迟或闪回**：确认写操作经 `ctx.mutate` 发起，操作后行与总数都直接请求并从
   `pathqlData$` 落地；不要靠事件防抖回刷当前操作，也不要直接写入命令返回值。
5. **任务/畅游详情收到无关刷新**：检查 adapter `refreshOn` 对 `taskIds` / `surfRecordIds` 的判断。缺维度必须刷新，带维度时才允许按 id 排除。
6. **带 `pvwimgid` 的链接没跳到目标图所在页**：先直接查
   `images://<视图>/~~/rank/~~/id_<id>`（`kabegame-cli pathql query … --fetch`）。返回空集说明图确实不在
   该视图（检查 `hide/` 与过滤段）；有 `row_index` 但页码不对，查前端是否误用了
   `stripComposablePathTail` 而把 `_kb_desc` 剥掉了。
7. **定位落到相邻页 / 分页在某处重复或漏行**：当前排序不是全序。检查该 sort provider 的 `order` 是否
   以 `images.id asc` 收尾；排序路由负责先清空上游排序，下游 provider 必须自己补回这条兜底。

## 涉及文件（速查）

| 层级 | 文件 |
|------|------|
| Rust 浏览 | `src-tauri/kabegame-core/src/gallery/browse.rs` |
| Tauri 命令 | `src-tauri/kabegame/src/commands/image.rs` |
| CLI PathQL 查询 | `src-tauri/kabegame-cli/src/main.rs` |
| 设置 | `src-tauri/kabegame-core/src/settings.rs` |
| 前端设置 | `apps/kabegame/src/stores/settings.ts` |
| 路由视图本体 | `apps/kabegame/src/stores/{gallery,albumDetail,taskDetail,surfImages}Route.ts` |
| 本地页码 / 行路径 | `apps/kabegame/src/composables/usePagedGallery.ts`、`apps/kabegame/src/utils/galleryPath.ts` |
| 视图快照 | `src-tauri/kabegame-core/src/commands/view.rs` |
| 变更聚合 | `apps/kabegame/src/services/dataChangeHub.ts` |
| 事件源 / pathql 数据源 | `apps/kabegame/src/services/kbEvents/` |
| 实时查询（迁移期旧实现） | `apps/kabegame/src/services/liveQuery.ts` |
| 列表加载 | `apps/kabegame/src/components/ImageGrid.vue` |
| 深链接定位（前端） | `apps/kabegame/src/services/imageLocate.ts` |
| 序号 provider | `src-tauri/kabegame-core/src/providers/dsl/shared/rank_provider.json5` |
