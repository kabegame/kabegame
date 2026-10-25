# 画廊分页与 SimplePage 图片加载数据流

本文档说明**主应用内**通过 `provider` 路径浏览图片列表时的分页、每页条数设置与前后端调用链，便于排查「翻页不对」「改每页条数不刷新」「列表为空」等问题。  
虚拟盘（VD）Greedy 目录树仍使用后端固定的 `LEAF_SIZE`（与 SimplePage 可配置页大小无关），详见下文「与 VD 的区别」。

## 与 `PROVIDER_IMAGEQUERY_COMPOSABLE.md` 的关系

- `PROVIDER_IMAGEQUERY_COMPOSABLE.md` 描述 **ImageQuery 如何组合**（JOIN / WHERE / ORDER）以及 Provider 解析与缓存。
- **本文档**描述：**路径 + 页码 + 每页条数** 如何落到 **行读取与计数批**（`pathql_fetch` / `pathql_all`）与前端 `offset` / 分页器对齐。

两者互补：查询语义见前者，分页与加载条数见本文。

## 核心概念

| 概念 | 说明 |
|------|------|
| **视图本体 `viewBody`** | 路由 `query.path`、route store 与 localStorage 只保存「看什么、怎么排」（如 `album/<uuid>/sort/by-time/_kb_desc`），不含页码和页大小。 |
| **行路径 `rowsPath`** | `ImageGrid` 查询出口把分页尾追加到视图本体：`withPaged(viewBody, pageSize, page)` → `<viewBody>/_kb_x<N>x/<页>`。 |
| **取数路径** | `toLookupRowsPath(withGalleryPrefix(rowsPath))` → `images://filter/<视图>/_kb_x<N>x/<页>/~~/rank/~~p/lookup/gallery`；只用于行请求。 |
| **SimplePage（历史实现）** | Provider 解析结果为「叶子」：`ProviderDescriptor::SimplePage { query, page }`。后端按 `ImageQuery` 计数 + **offset/limit** 取一页。 |
| **Greedy / 非 SimplePage** | 目录树、range 分解等；后端 `browse.rs` 内仍用固定 `LEAF_SIZE = 100` 做贪心分段，**不使用**用户配置的每页条数。 |
| **每页条数 `galleryPageSize`** | 用户设置 `100 / 500 / 1000`，持久化在 Rust `Settings`（JSON 键 `galleryPageSize`），仅影响 **SimplePage** 的 `limit` 与 offset 计算。 |

## 后端

### 画廊窄路由分页与回表

当前网格行读取统一为 `pathql_fetch`，provider 分为三层：

```text
images://filter/<视图>/_kb_x<N>x/<页> /~~/ rank /~~p/ lookup/gallery
         id 过滤、排序、切页             本页取序       主键回表、补字段、按 p.row_index 排序
```

- `images_root_provider` 只贡献 `images.id AS id`。`filter` 直接进入 `gallery_router`，后者持有全部
  list / resolve 与默认排序；hide、搜索、画册、任务、畅游等子 provider 的 delegate 全部折回窄路由。
- `gallery_route` 只持有 21 个列表字段，list / resolve 委托 `gallery_router`。宽入口 `images://gallery`
  在根 resolve 经过 `gallery_entry_router` 先折默认排序，再进入字段层，保证裸 `gallery/~not/...`
  组合器在组外已有排序基线；原有裸 gallery 与全局分页默认顺序也保留。
- `rank` 扫内层物化 CTE，为本页行打从 1 起的 `row_index`；`lookup` 将 images 按 `images.id = p.id`
  回表，最后的 `gallery` 补字段。外层只按 `p.row_index` 排，不重放可能引用内层 JOIN 别名的排序。
  画册的 `album_order` 经 `images.*` / `p.*` 保留，按画册顺序的翻页不丢字段、不变序。
- `filter` / `lookup` 是根 resolve 的内部入口，不列举。MCP、侧栏与维度列举仍走 gallery 宽入口，
  因为分组 SQL 会读取 `sub.type` / `sub.crawled_at` 等列。过滤的 resolve 不依赖动态列举反查。
- `no-album` 的收藏条件直接查成员 EXISTS，不引用 `is_favorite` 投影别名，因此窄入口也能独立执行。
- 本次只改 provider 与前端路径转换，复用已有 `~~` / `~~p`，没有增加引擎能力。

### Metadata 懒加载（列表不带插件 JSON）

为减少翻页时读取/传输/解析整页插件 JSON，**浏览列表**路径统一不返回 metadata，只返回 `metadata_id`：

- **Provider / storage 查询**：列表只带 `metadata_id`，不内联 `metadata.data`。
- **详情区**：通过 `metadata_id` 或 `imageId` 懒加载 JSON。

详情区（EJS / 原始键值）按需加载：

- **命令**：`get_image_metadata`（[`kabegame/src/commands/image.rs`](/src-tauri/kabegame/src/commands/image.rs)），参数 **`imageId`**（与前端 camelCase 一致）。
- **实现**：[`Storage::get_metadata`](/src-tauri/kabegame-core/src/storage/images.rs) 通过 provider 路径读取 `metadata.data`。

### 聚合查询：`pathql_all`

`pathql_all({ queries })` 接受 `list` / `entry` / `fetch` / `count` 查询数组，按请求顺序执行并一次返回对应的结果数组；
任一查询失败整批失败（`count` 失败不会吞成 0）。`list` 的 `withCount` 缺省为 false。每条路径在命令边界解码一次。
Tauri 与 Web JSON-RPC 复用 core 命令；Web 只对 `fetch` 下标的结果做媒体路径改写。

宿主在 `spawn_blocking` 的同一线程钉住一个只读连接，开启读事务；PathQL 运行时串行执行 SQL，
执行器经 thread-local 复用该连接，整批 SQL 从首次读取起共享同一个 WAL 快照，中途提交的写入不可见。
嵌套调用沿用外层快照，正常返回、失败或 panic 都会结束事务并归还连接。
`plugin://` 数据来自插件内存等非 SQL 来源，不受该数据库快照约束。

前端 `pathqlAllKey` 按固定字段顺序（`list` 显式补 `withCount: false`）规范化查询数组 JSON；
`kind: "all"` 把整批视为核心上的一个 key，复用 pending 窗口、观察方与事件窗口。
`useLookAll` 是 `usePathqlLooker` 的薄包装，只观察 `results`，不发请求。
ImageGrid 一批读 `[count(分子)]` 或 `[count(分子), count(分母)]`，分子只读一次；分子分母共享 SQL 读快照，
行仍独立请求。翻页不改变计数批 key，不重读计数。

### 与 VD / Greedy 的区别

- **网格分页**：一页行数 = 用户设置的 `galleryPageSize`（前端归一为 100 / 500 / 1000）。
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
- `withPaged` 生成的分页路径仍是 `rawViewPath`、`loadedKey`、路径校验、计数推导与预览定位的依据。
  只在 `currentRowsPath` 出口用 `toLookupRowsPath` 改写行取数路径；rows 观察方及其请求使用转换后的 key，
  不把 lookup 路径写回路由或本地分页状态。画册单行封面仍走原来的宽路径。
- 行与计数批分开读取：行用 `pathql_fetch(lookupPath)`，总数用 `useLookAll` 观察 `pathql_all(queries)` 的计数批；
  新旧由前端请求服务按 key 分配的请求序号判断（见下文「kbEvents」）。
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
  sort provider 都以 `images.id asc` 收尾，`gallery_router` 的默认排序同样带这条兜底。
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

过滤树等辅助请求仍可独立读取计数；ImageGrid 的列表与分页总数必须分别走 `pathql_fetch`
与 `pathql_all` 计数批，不得在翻页时因行路径变化重读未变的计数路径。

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

- **用户操作（不防抖）**：路径变化（导航、翻页、换筛选、激活）、手动刷新，以及当前网格发起且会改变结果集的操作
  （`ctx.mutate(() => ...)`）。写命令不带 `view`、不返回快照，照常广播事件；`mutate` 在操作完成后
  `pathqlRequest$.next` 当前行与总数即返回，结果从数据源落地。永久删除、隐藏/取消隐藏、加入/移出画册与上划移除均已接入。
- **就地字段更新**：不会改变结果集的收藏走 `ctx.patch`，成功后立即修改当前行的 `favorite`。
- **事件（防抖）**：adapter `refreshOn` 按内容判断新增 / 字段与画册事件，ImageGrid 为行追加当前持有行的删除包含判断、为总数追加任何删除都刷新（`deletesViaMembership` 画册除外），核心按统一窗口请求。
- **字段补丁（不发请求）**：`imagePatches$` 将单图 / 多图补丁共用一个窗口，收藏与隐藏画册成员各自开窗，
  合并为 `Map<imageId, Partial<ImageInfo>>` 后交给 `patchMany`；同 id 后到字段覆盖先到。
  裸 id 预览的字段事件只打补丁，另用 `triggers$` 对包含当前 id 的删除及非系统画册成员增删重读当前图。
- **其它消费方**（画册树、画册页头部、运行配置、标签面板等）同样是 pathql 核心的观察方。
  画册成员携带 `ancestorPath`，结构事件提供新旧祖先路径，已加载目录按路径前缀判断相关性。
  任务 / 畅游新增按完整行归属判断；普通纯计数观察方删除一律刷新，画册计数由成员事件定位，字段变化依赖见下表。

### kbEvents（`services/kbEvents/`，rxjs）

前端的事件与 pathql 数据源统一在 [`services/kbEvents`](/apps/kabegame/src/services/kbEvents/index.ts)，
事件 payload 类型也定义在这里（`events.ts`）。分三层，事件源与数据源是两种不同的 observable：

- **事件源** `kbEvent$(name)`：基于 `listen`（Tauri 事件或 Web SSE），同名事件共享一次监听，不解析内容。
  `events.ts` 的 `KbEventMap` 只是类型表；`on(event, relevant)` 声明一条单事件触发，`triggers$` 把多条合成刷新信号流。
- **pathql 核心**（单例，`pathqlSource.ts`）：按 `kind + key` 维护请求序列、rows / all 数据状态与观察方注册。
  - **请求**：唯一入口 `pathqlRequest$.next([kind, key])`，next 即返回、不等待、不交还结果。主动请求只有两条通路：
    核心的事件窗口与发起方的用户操作。每次请求序号 +1，可与在途请求并行；每个 key 维护 pending 窗口
    `(acked, requested]`，像 TCP 累计确认：任一请求返回就确认并取消它之前的全部 pending，序号不大于已确认的返回
    静默丢弃（如 1、2、3 在途，2 先返回则更新并取消 1；1 再返回被丢弃；3 返回再更新）。
  - **观察方**：`lookPathql(kind, key, refreshOn)` 订阅期间注册一个观察方，收到 `data`（最后可得的数据）与
    `status`（最新请求的 `{ seq, loading, error }`）。loading 与 error 只属于最新请求，二者序号相同，可以领先于
    数据的序号：最新请求失败时数据仍是更早成功的那次；更早请求的失败只确认、不进状态。新请求发出即清掉旧错误。
    观察方只看不请求。`refreshOn` 是观察方的过滤器，同一 key 所有观察方的过滤器向核心的**同一个 500ms 窗口**
    （`PATHQL_REFRESH_WAIT_MS`，经 `batchWindow`：空闲首票立即刷新，窗口内的票合并到窗口结束）投票，
    任一同意就刷新一次，结果推给该 key 的全部观察方。
  - 没有观察方且没有在途请求时回收该 key，不把离开路径的旧数据重放给后来者，也不再随事件刷新。
- **`usePathqlLooker`**：Vue 组合式观察方。key 变化时注销旧 key、注册新 key（旧路径的迟到结果与 loading 不影响新路径），
  key 为 null 时不注册；不带防抖时间、不发请求，返回 `loading` / `error`，最新请求失败时调 `onError`。
  ImageGrid 把路径变化当作用户操作：行路径与规范化计数批 key 各一个 watch，key 一变就 `pathqlRequest$.next`（翻页不改计数路径，
  不重读总数）；手动刷新、`mutate`、预览定位重取本页同样只 next。首次加载失败与事件刷新失败都经 `onError` 交给
  adapter 的 `onLoadError` / `onCountError`。加载遮罩只在「当前路径还没有数据且最新请求在途」时显示，已有数据时的
  刷新不遮挡；`usePagedGallery` 只管页码、`rowsPath` 与预览边界，不再负责加载。
- **`imagePatches$(waitMs, { patchHidden })`**（`imagePatches.ts`）：`image-changed` 与 `images-change` 共用
  `batchWindow` / `reducePatches`，按 id 合并字段绝对值；收藏与隐藏画册成员分别经
  `reduceFavoriteChanges` / `reduceHiddenChanges` 独立开窗，再 `merge`，只补丁已有对象，不发请求。隐藏流入窗前读取 `patchHidden()`：
  网格 hide 关闭才打 `isHidden` 补丁，开启时直接靠刷新剔除 / 补回，避免先变灰；裸 id 预览始终打补丁。
- 各 adapter 的 `viewState()` 提供当前查询、排序与 hide；相关性 helper 只收紧已有 `refreshOn`，不新增后端查询通路。

### 按事件内容判断相关性（过滤走查 Phase B）

`imageViewRelevance.ts` 采用「能证明无关才跳过」：`images-added` 任一行可能命中就刷新，
只检查顶层 AND 的 `is` 原子，`any` / `not` 内条件与搜索一律视为可能。插件 id 不同排除，同插件的扩展内容不判断。
媒体类型与 `gallery_media_type_provider` 一致：忽略大小写，裸 `video` 与 `video/…` 都是视频，其余是图片；
格式取 `/` 后的小写值（无 `/` 则整串）。日期按 `crawled_at_seconds` 的 `> 253402300799` 阈值转换秒 / 毫秒，
格式化为系统本地年月日；Web 因服务器时区未知不排除，缺失或超出可靠范围的日期也视为可能。
大小与 `gallery_size_range_provider` 一致，B / KB / MB / GB 不区分大小写，默认下界 1、上界 2^53−1，
区间左闭右开，`unknown` 是空值或非正数。宽高比预设桶复用 `aspectBucketForDimensions`，任意区间用整数交叉乘法，
左开右闭，宽高缺失或非正只有 `unknown` 命中。无法可靠解析的单位 / 区间、超出 JS 安全整数的计算视为可能。

任务 / 畅游的新增另检查 `taskId` / `surfRecordId`；画册不听图片新增，成员进出由本画册的 `album-images-added` / `album-images-deleted` 负责，
隐藏 / 取消隐藏只是隐藏画册自身的成员增删：hide 开启的视图（含画册页）一律刷新，hide 关闭时只由 `imagePatches$` 按 id 打 `isHidden` 补丁。无画册与标签搜索的画册依赖见下文 Phase F。

单图 / 多图字段变化共用 `patchTriggers`，忽略 id 本身，空补丁不刷新，任一相关字段即刷新：

| 字段 | 触发条件 |
| --- | --- |
| `thumbnailPath`、`compatiblePath` | 只打补丁 |
| `lastSetWallpaperAt` | 按设壁纸时间排序 |
| `displayName` | 按名称排序或有效 display-name 搜索 |
| `metadataId` | 有效 metadata 搜索或插件维度（含扩展） |
| `imageMetadataId` | 有效 native-metadata 搜索 |
| `pluginId` | 插件维度 |
| `postUrl` | 有效 url 搜索 |
| `taskId` | 从不刷新：只在删除 / 清理任务时置空，供预览「打开任务」按钮就地消失；被删任务的详情页自行离开 |
| 表外字段（含 `surfRecordId`） | 保守刷新；畅游 adapter 显式声明归属依赖 |

`queryUsesSearchMode` 与维度依赖都递归 any / not；空词、未勾选模式不生效。
侧栏计数把当前浏览维度从简单条件扣掉，合并前缀高级查询；前缀无法解析时新增 / 补丁仍刷新。插件分面另依赖 `pluginId` 分组与扩展用到的 `metadataId`，两者变化保守刷新。
畅游计数的新增按记录 id，补丁仅在出现 `surfRecordId` 字段时刷新（null 也算）；hide 开启才因隐藏画册变化刷新。

ImageGrid 的删除触发由 `deletedTrigger(heldIds?)` 生成，行与总数分开：行传当前持有行 id，后台删除 id 不在其中时不重读行；
总数默认不传，任何删除都重读，页外删除后总数也随之更新。画册 adapter 标记 `deletesViaMembership: true`，总数不追加此触发：后端删图会向每个原属画册发送带 `imagesDeleted: true` 的成员删除，因此无关删图不会重读本画册总数。
有分母（过滤时的未过滤总数）时，计数批另对任何 `images-added` 重读：分母与分子同批读取，而 adapter 的新增判断只看过滤后的查询。
侧栏 / 畅游等只有计数的观察方没有行可比较，删除一律刷新。新增不判断排序位置，默认画廊下载仍刷新。
裸 id 预览不因新增或字段变化重新解析；只在删除 / 非系统画册成员增删包含当前 id 时重读，字段与收藏 / 隐藏直接保鲜。

画册与图片删除写命令不再返回 `albumChanges` 副本；无状态 services 不做本地事件投递。发起写入的组件请求自己观察的 key，其它观察方等后端事件。
画册树不维护全量列表或全量计数，只重拉相关的已加载目录；画册视图仍由操作后请求或事件触发的查询决定过滤、排序和分页后的最终行位置。
预览中的 `ImageLabelsPanel` 不走 `mutate`（替换底层列表会跳页），作为 `albums://of_image_<id>/album_kind/label`
的 rows 观察方：切图与面板内增删后请求自身 key，别处成员变更与已挂标签改名 / 删除经核心窗口刷新。

### 画册事件按依赖刷新（过滤走查 Phase F）

- **收藏**：普通画廊、任务、畅游和普通画册仅由 `imagePatches$` 更新心形，裸 id 预览不重解析，标签面板不重读。
  收藏画册自身、无画册视图、树系统区及收藏 / 无画册上下文侧栏仍刷新；标签搜索按下述保守口径处理。
- **无画册与标签搜索**：画廊、任务、畅游共用 `noAlbumTriggers`（非隐藏成员增删、删画册；带 `imagesDeleted` 的成员删除跳过，交给图片删除触发）。
  四个网格共用 `labelSearchTriggers`，递归检查有效 label 搜索；成员增删无法识别标签类型，任意画册成员增删都保守刷新；标签结构补丁、移动与删除同样刷新，排序不触发。
- **画册网格**：直接成员不依赖画册名、位置等行字段，删除自身仍刷新；改序仅在 `by-album-order` 下刷新，行与总数共用过滤器，故会连带读总数。
  hide 开关仍由 `hiddenTrigger` 负责，不按图片所在画册猜测相关性。
- **画册页头**：详情依赖自身补丁、祖先结构补丁、子孙增删及涉及自身链 / 子孙的移动，子孙改名不刷新。
  计数不带 hide：`label_dir` 只听直接子画册增删与涉及直接子项的移动，不听成员事件；`label` 只听自身成员增删；
  其它类型听自身 / 子孙成员增删、严格子孙删除、子树跨边界移动，空子画册新增、改名、内部移动不重读图片计数。移动自身或祖先时沿用路径前缀改写。
- **画册树**：普通分区 extra 按事件路径根节点所属分区判断，根节点未加载则保守刷新；系统区成员事件只认收藏 / 隐藏，收藏不会误刷其它分区。
  hide 开时隐藏成员增删刷新所有带前缀计数；隐藏画册的 `imagesDeleted` 删除只处理系统区，其它画册计数由各原属画册的成员删除定位。
  补丁只影响已持有行的 page，extra 不听补丁或排序；删除 / 移动不要求被删 / 被移动的画册已加载。
- **侧栏与标签面板**：画册敏感上下文为 `album` / `album-tree` / `no-album` 或有效标签搜索，只有 hide 不响应普通画册成员；未知前缀保守刷新。
  标签面板跳过系统画册与排序，删标签目录按已挂标签路径前缀判断，移动标签或其祖先时重读并立即改写持有路径。

### 一致性

后端 `GlobalEmitter` 为图片、画册行与画册成员的全部增删改事件
共用一个单调递增计数器，payload 都携带 `seq`；前端目前不消费它（`kbEvent$` 只透传）。

ImageGrid 的行与总数不依赖后端 `seq`，只靠前端请求序列：

- 每次请求（事件窗口或用户操作）都在发出时分配新序号，可并行；任一请求返回即取消它之前的全部 pending，
  旧的在途请求不会覆盖新状态；
- 写操作完成后的用户请求与随后到达的本次写事件触发的请求各一次，允许多读，按序号落地，结果一致；
- 读数据期间新发出的事件会再触发一次请求，允许多拉但不会漏变更；
- 若写操作删空最后一页，新总数到达后由 `usePagedGallery` 的 total watcher 把页码夹回新的最后一页。

### 图片行新增、删除与字段补丁

| 事件 | Payload | 含义 |
| --- | --- | --- |
| `images-added` | `{ seq, images: ImageInfo[] }` | 真正插入图片行，携带完整 camelCase 行 |
| `images-deleted` | `{ seq, imageIds: string[] }` | 删除图片行，不携带归属维度 |
| `image-changed` | `{ seq, patch: { id, ...字段 } }` | 一张图的字段变化 |
| `images-change` | `{ seq, patches: [{ id, ...字段 }] }` | 多张图的字段变化 |

- `GlobalEmitter::emit_image_patches` 是字段变化的唯一出口：按 id 合并，后到字段覆盖；丢弃空字段，
  按不同图片数量分流，0 张不发。`emit_image_fields` 将共享字段展开后复用此出口。
  所有值都是绝对值；不再使用旧 `reason`、共享 `diff`、归属 id 列表，也不成对补发粗事件。
- 下载器在原生元数据 best-effort 持久化后，把 `imageMetadataId` 写回新图行再发 `images-added`；
  不支持或解析失败时为空。查看时懒挂原生元数据发单图字段补丁；整理按原批次收集逐图补丁，
  metadata 迁移整轮末尾按最终 `{ id, metadataId }` 展开发送，循环结构留给 Phase C / D。
- 删除畅游记录只为实际关联图片发送 `{ id, surfRecordId: null }`，0 张不发。
  删除 / 清理任务时外键置空，为原属图片发 `{ id, taskId: null }` 补丁，只打补丁、不触发任何视图刷新；TaskDetail 读到空行时，有历史返回，否则回 `/gallery`。
- `ImageGrid` 对字段补丁用 `patchMany` 更新在手行和预览；同一图片变更 `metadataId` /
  `imageMetadataId` 后自然更换 metadata cache key。排序、搜索成员与分面变化按字段依赖触发权威查询。
- 裸 id 预览对字段只打补丁，删除 / 非系统画册成员增删包含当前 id 时重解析；新增不影响已在手的图。
- 删除事件仍可带请求中的不存在 id；网格统一只在当前持有行命中时刷新。
  Windows 虚拟盘对新增从完整行提取 taskId 通知任务目录，图片增删 / 字段补丁刷新画廊树；
  删除不再携带 taskId，正在浏览的任务目录不会因图片删除立即更新。
- `GalleryToolbar` 只注入 `gridTotalKey` 的 `{ total, unfilteredTotal }`；分子与可选分母仍由同一
  `pathql_all` 读快照读取，工具栏不另注册观察方。

### 画册行与成员事件（Phase E）

| 表 | 事件 | Payload |
| --- | --- | --- |
| albums | `albums-added` | `{ seq, albums: Album[] }`，一次写操作批量发送完整行 |
| albums | `albums-deleted` | `{ seq, albums: [{ id, ancestorPath }] }`，只包含被删子树根 |
| albums | `album-moved` | `{ seq, id, oldAncestorPath, newAncestorPath }`，只包含移动根 |
| albums | `album-changed` / `albums-change` | `{ seq, patch }` / `{ seq, patches }`，只含真正变化的绝对值，永不含 parentId / ancestorPath |
| album_images | `album-images-added` / `album-images-deleted` | `{ seq, albumId, ancestorPath, imageIds, imagesDeleted? }` |
| album_images | `album-images-change` | 排序，只有实际 UPDATE 改变的成员 id；空操作不发 |

- `image_events.rs` 只对实际新增 / 移除的成员发增删，不再有七种 reason，也不按是否隐藏拆分。
  隐藏 / 取消隐藏只发隐藏画册自身一条 added / deleted，不带图片所在的其它画册，也不带图片行：
  hide 开启的观察方收到就刷新（带 `hide/` 前缀的画册树计数一律刷新），hide 关闭的网格与预览只按 `imageIds` 打 `isHidden` 补丁。
  整行删图的每个原属画册各发 deleted，带 `imagesDeleted: true`，不作为取消隐藏补丁。
- 收藏 / 隐藏的 added 与 deleted 分别推导 `favorite` / `isHidden` 展示补丁；排序不产生这些补丁。
- `emit_album_patches` 按 id 合并、丢弃空字段，单画册发 `album-changed`，多画册发 `albums-change`。
  删画册只发根删除事件，不补发空 order；依赖原空 order 的观察方改听 `albums-deleted`。
- 移动、文件夹改链与转换提升均发 `album-moved`。改链同时动祖先与子孙时，祖先在前，子孙旧路径接续祖先移动后的路径。
  树（含收起的已加载节点）、页头自身与祖先、标签面板收到移动即改写路径前缀，移动根 parentId 从新路径计算。
- IPC 加入 / 移出 / 排序 / 删除画册统一走 core 命令；MCP 两个改序入口发排序事件；虚拟盘按 albumId 通知目录，隐藏画册事件整体失效画册目录。
  外部 IPC 订阅者需迁移事件名，VS Code 扩展由其仓库独立修改。
- Phase E 完成协议迁移，Phase F 在现有查询上收紧 `refreshOn`，详见前述 Phase F 依赖；隐藏仍按 hide 开关整体刷新。
- 前端不维护全量画册列表或计数。`albumPageQueries` 描述每页结构批次：`albums://<过滤段>/x<N>x/<页>`
  行与 `…/~~/children[/search/<q>][/<类型段>]` 的 `child_count` 经 `pathql_all` 同快照读取。
  `TreePage.extra` 另批读取本页行与 `…/~~/images[/hide]` 的 `image_count`，本页行用来为无分组结果的画册补 0，
  也保证补充结果先到时可应用。每页两批、共四条 fetch；各页之间与结构 / extra 之间不保证同一快照。
  两个计数在 `~~` 后按画册 `GROUP BY`；图片数是子树成员行数（标签叶子即直接成员），
  与 `images://gallery/[hide/]album/<id>`、`album-tree/<id>` entry 总数同口径。`label_dir` 不挂图，显示直接子画册数。
  行与 `child_count` 先渲染，图片计数独立补丁、不挡行渲染，结构刷新沿用最近补丁。内层分页物化为 CTE、
  子树走 `idx_albums_ancestor_path` 区间，见 [../provider-dsl/RULES.md](../provider-dsl/RULES.md) §2.1。
- 画册树 / 侧栏以 `TreeQuerySource` 描述查询和单事件过滤器，`useTreeModel` 只观察可见展开分支的已加载页，
  一页一个 `all` key。新 key 与手动刷新经 `pathqlRequest$` 请求，Promise 在模型等待表中完成；核心不返回结果。
  收起 / 不活跃停观察而保留数据，再展开 / 激活重新请求；换 key 与错误均不清空旧子项。
  成员增删只重读相关目录的 extra，排序不刷新树计数；新增 / 删除 / 移动按路径影响结构与 extra，字段补丁只刷新持有行的 page；
  `albumEventPaths` 从增删或移动事件中取路径，补丁只用已持有路径定位、未持有行不触发，带路径事件缺路径时保守通配，子目录只匹配严格后代。多个实例对同一事件、同 key 只投一票。
- 仓库内已无旧 `src-plasma-wallpaper-plugin` 源码；外部集成订阅应按上述四种图片事件协议迁移。

## 排查清单

1. **翻页页码不对**：确认 `query.path` 不含 `_kb_x`，`usePagedGallery.currentPage` 是期望值，且
   `rowsPath === withPaged(viewBody, pageSize, currentPage)`；翻页不应触发 route store 导航。
2. **改每页条数后仍显示旧页**：确认入口只写 `settings.galleryPageSize`，`ImageGrid` 的归一化
   `pageSize` 已更新，且本地页码按旧页首张图位置换算后触发新的 `rowsPath` 读取。
3. **VD 下列表仍是 100 一段**：符合设计；Greedy 路径不使用 `galleryPageSize`。
4. **删除后列表延迟或闪回**：确认写操作经 `ctx.mutate` 发起，操作后行与总数都经 `pathqlRequest$` 请求并从
   观察方落地；不要靠事件防抖回刷当前操作，也不要直接写入命令返回值。
5. **切回页面后网格为空但总数正常**（dev）：改 `kbEvents` 源码后的 HMR 会让 `@/router` 重建出未挂到 app 的
   实例，adapter `isActive` 恒为 false、key 一直是 null。整页重载即恢复，真机测试前先重载。
6. **任务/畅游详情收到无关刷新**：检查新增事件行里的 `taskId` / `surfRecordId`；字段补丁按依赖表判断，删除时行只检查当前持有行，总数任何删除都重读。
7. **带 `pvwimgid` 的链接没跳到目标图所在页**：先直接查
   `images://<视图>/~~/rank/~~/id_<id>`（`kabegame-cli pathql query … --fetch`）。返回空集说明图确实不在
   该视图（检查 `hide/` 与过滤段）；有 `row_index` 但页码不对，查前端是否误用了
   `stripComposablePathTail` 而把 `_kb_desc` 剥掉了。
8. **定位落到相邻页 / 分页在某处重复或漏行**：当前排序不是全序。检查该 sort provider 的 `order` 是否
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
| 事件源 / pathql 数据源 | `apps/kabegame/src/services/kbEvents/` |
| 列表加载 | `apps/kabegame/src/components/ImageGrid.vue` |
| 深链接定位（前端） | `apps/kabegame/src/services/imageLocate.ts` |
| 序号 provider | `src-tauri/kabegame-core/src/providers/dsl/shared/rank_provider.json5` |
