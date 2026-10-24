# 过滤走查 Phase B：前端按事件内容收紧图片视图的刷新

> 依赖 [phaseA.md](phaseA.md) 的事件协议（`images-added` 带 `ImageInfo`、`images-deleted` 只带 id、补丁 `{ id, ...字段 }`）。

### 总体设计思路

Phase A 之后，每个图片事件都说明了「发生了什么」，但各消费方仍然一律刷新。本阶段只改前端：各页面现有的
`refreshOn` 在事件内容与自身视图状态（查询、排序、hide）之间做判断，能证明无关就不刷新，证明不了照常刷新。
判断逻辑抽成公共 helper，入参只是视图状态，画廊、画册、任务、畅游与侧栏、畅游计数共用。

四类事件各有一种判断。新增：拿新图的完整行比对查询——插件、媒体类型、日期、大小、宽高比能判定的维度不满足即排除，
任务 / 畅游视图另看行里的归属；只看查询最外层的条件，`any` / `not` 与搜索一律视为可能。删除：有行的视图只在当前行
包含被删 id 时刷新；只有计数的观察方照常刷新。补丁：按「字段 → 依赖」表判断，例如只有 `thumbnailPath` 从不刷新、
`displayName` 只在按名称排序或按名称搜索时刷新。隐藏：视图过滤隐藏图（hide 开启）时，隐藏画册成员变化直接刷新剔除、
不打 `isHidden` 补丁，避免图片先变灰再消失；不过滤时只打补丁、不刷新。

### 现状锚点（Phase A 之后）

**a. adapter 一律刷新**（`components/imageGrid/adapters/gallery.ts`）
```ts
refreshOn: [
  // 现状：任何图片事件都刷新
  on("images-added"), on("images-deleted"), on("images-change"), on("image-changed"),
  on("album-images-change", isHiddenAlbumChange),
  on("album-images-change", () => routeStore.effectiveNoAlbum),
  on("album-changed", ...),
],
```

**b. 补丁流不区分视图**（`services/kbEvents/imagePatches.ts`）
```ts
export function imagePatches$(waitMs: number): Observable<ImagePatchBatch> {
  return merge(
    merge(kbEvent$("image-changed"), kbEvent$("images-change")).pipe(batchWindow(waitMs, reducePatches)),
    kbEvent$<AlbumImagesChangePayload>("album-images-change").pipe(batchWindow(waitMs, reduceFavoriteChanges)),
    // 现状：hide 开启的视图也会先把图标灰，随后刷新才剔除
    kbEvent$<AlbumImagesChangePayload>("album-images-change").pipe(batchWindow(waitMs, reduceHiddenChanges)),
  );
}
```

**c. 查询工具只能问维度**（`utils/galleryQuery.ts:520`）
```ts
/** 查询的任意原子是否用到了某维度（grid adapter 刷新启发式用）。 */
export function queryUsesDimension(query: GalleryQuery, dimension: GalleryFilterDimension): boolean
// 现状：问不到「有没有用到某个搜索模式」
```

**d. 预览弹窗**（`components/common/ImagePreviewDialog.vue`）
```ts
triggers$([
  on("images-deleted", (p) => p.imageIds.includes(id)),
  on("images-change"), on("image-changed"), // 现状：字段已打补丁，仍重新解析
  on("album-images-change", (p) => (p.imageIds ?? []).includes(id)),
])
```

### 点 1 — 公共判断（新增 `services/kbEvents/imageViewRelevance.ts`、`utils/galleryQuery.ts`）

- **新增**
  - `galleryQuery.ts`：`queryUsesSearchMode(query, mode)`。
```ts
/** 查询里是否有生效的搜索词勾选了该模式。 */
export function queryUsesSearchMode(query: GalleryQuery, mode: GallerySearchPathMode): boolean {
  return query.some((node) => {
    if (isIsNode(node)) return isActiveSearchTerm(node.is.search) && searchTermModes(node.is.search).includes(mode);
    if (isAnyNode(node)) return node.any.some((branch) => queryUsesSearchMode(branch, mode));
    return queryUsesSearchMode(node.not, mode);
  });
}
```
  - `imageViewRelevance.ts`：
```ts
export interface ImageViewState {
  query: GalleryQuery;
  sort: GallerySort;
  hide: boolean;
}

/** 新图是否可能落进该查询：只看顶层 is 节点（AND），能判定的维度不满足即排除；any / not、search 视为可能 */
export function imageMayMatchQuery(image: ImageInfo, query: GalleryQuery): boolean;

/** images-added：任一新图通过 accept（根归属）且 imageMayMatchQuery 才刷新 */
export function addedTrigger(view: () => ImageViewState, accept?: (image: ImageInfo) => boolean): EventTrigger;

/** 补丁字段 → 会改变哪些视图的结果集或顺序；表外字段一律视为相关 */
const FIELD_DEPS: Record<string, (view: ImageViewState) => boolean> = {
  thumbnailPath: () => false,
  compatiblePath: () => false,
  lastSetWallpaperAt: (v) => v.sort.field === "by-set-time",
  displayName: (v) => v.sort.field === "by-name" || queryUsesSearchMode(v.query, "display-name"),
  metadataId: (v) => queryUsesSearchMode(v.query, "metadata") || queryUsesDimension(v.query, "plugin"),
  imageMetadataId: (v) => queryUsesSearchMode(v.query, "native-metadata"),
  pluginId: (v) => queryUsesDimension(v.query, "plugin"),
  postUrl: (v) => queryUsesSearchMode(v.query, "url"),
};

/** image-changed / images-change 两条触发；extra 供个别视图补充字段依赖 */
export function patchTriggers(view: () => ImageViewState, extra?: Record<string, (view: ImageViewState) => boolean>): EventTrigger[];

/** 视图过滤隐藏图时，隐藏画册成员增删要刷新剔除 / 补回 */
export function hiddenTrigger(view: () => ImageViewState): EventTrigger;
```
    > 说明：`imageMayMatchQuery` 各维度与后端同口径——
    > - 插件：`pluginId` 不等于筛选插件即排除（`extendPath` 插件相同时视为可能）。
    > - 媒体类型：`type` 是否 `video/` 开头判 kind；format 取 `/` 之后小写比较。
    > - 日期：`crawledAt` 按后端 `crawled_at_seconds` 同一阈值（> 253402300799 视为毫秒）换成秒，格式化成本地
    >   `YYYY-MM-DD`，不以筛选段开头即排除；web 版不做（浏览器与服务器时区可能不同）。
    > - 大小：段解析与 `gallery_size_range_provider` 一致（空下限 1、空上限 2^53-1），`size` 为空只有 `unknown` 段可能命中。
    > - 宽高比：预设桶用 `aspectBucketForDimensions`；任意 `<w>x<h>` 区间左开右闭比较，宽高缺失只有 `unknown` 段可能命中。

### 点 2 — 补丁流按视图门控隐藏补丁（`services/kbEvents/imagePatches.ts`）

- **修改**
```ts
export function imagePatches$(waitMs: number, opts: { patchHidden: () => boolean }): Observable<ImagePatchBatch> {
  return merge(
    merge(kbEvent$("image-changed"), kbEvent$("images-change")).pipe(batchWindow(waitMs, reducePatches)),
    kbEvent$<AlbumImagesChangePayload>("album-images-change").pipe(batchWindow(waitMs, reduceFavoriteChanges)),
    kbEvent$<AlbumImagesChangePayload>("album-images-change").pipe(
      filter(() => opts.patchHidden()),           // 修改：hide 开启的视图不打，交给刷新剔除
      batchWindow(waitMs, reduceHiddenChanges),
    ),
  );
}
```

### 点 3 — ImageGrid 与 adapter

- **修改**
  - `GridAdapter` 增加 `viewState(): ImageViewState`（四个 route store 都有 `query` / `sort`，`hide` 取全局路由）。
  - ImageGrid 统一加删除触发，行与总数共用；补丁流按视图门控。
```ts
const deletedTrigger = on("images-deleted", (p) => {
  const ids = new Set(images.value.map((image) => image.id));
  return p.imageIds.some((id) => ids.has(id)); // 新增：视图知道自己有哪些 id
});
const refreshOn = [...adapter.refreshOn, deletedTrigger];
imagePatchSubscription = imagePatches$(GRID_REFRESH_WAIT_MS, {
  patchHidden: () => !adapter.viewState().hide,  // 修改
}).subscribe(patchMany);
```
  - 四个 adapter：
```ts
// 画廊
refreshOn: [
  addedTrigger(view),
  ...patchTriggers(view),
  hiddenTrigger(view),
  on("album-images-change", () => routeStore.effectiveNoAlbum),
  on("album-changed", ...),                                 // 画册方面留给后续 phase
],
// 任务
refreshOn: [addedTrigger(view, (image) => image.taskId === tid()), ...patchTriggers(view), hiddenTrigger(view)],
// 畅游
refreshOn: [
  addedTrigger(view, (image) => image.surfRecordId === rid()),
  ...patchTriggers(view, { surfRecordId: () => true }),
  hiddenTrigger(view),
],
// 画册：成员进出由 album-images-change 负责，不听 images-added；隐藏已含在本画册的 hide / unhide 成员事件里
refreshOn: [
  ...patchTriggers(view),
  on("album-images-change", (p) => /* 本画册 id 命中，现状 */),
  on("album-changed", (p) => /* 本画册，现状 */),
],
```
- **删除**
  - 各 adapter 里 Phase A 机械迁移的四条无条件触发与 `isHiddenAlbumChange` 触发。

### 点 4 — 其余消费方

- **修改**
  - `ImagePreviewDialog.vue`：只有当前图被删才重新解析；补丁走 `imagePatches$(..., { patchHidden: () => true })`。
```ts
triggers$([
  on("images-deleted", (p) => p.imageIds.includes(id)),
  on("album-images-change", (p) => (p.imageIds ?? []).includes(id)),
])
```
  - `facetTreeSource.ts`（只有计数）：`images-added` 用 `addedTrigger` 以侧栏上下文查询判断；`images-deleted` 照常刷新；补丁按 `patchTriggers`。
  - `useSurfImageCounts.ts`（只有计数）：`images-added` 按行里的 `surfRecordId`；`images-deleted` 全部刷新；补丁里有 `surfRecordId` 时刷新。

### 点 5 — 测试、文档

- **测试**：`imageMayMatchQuery` 各维度（毫秒 / 秒 crawledAt、size / aspect 的 unknown、any / not 不排除）、
  `queryUsesSearchMode`、`patchTriggers` 字段表逐项、`patchHidden` 门控、ImageGrid 删除触发的包含判断、预览只在删除当前图时重解析。
- **文档**：`cocs/gallery/GALLERY_PAGINATION_AND_IMAGE_LOAD.md`（过滤器）、`.cursor/rules/view-mutation.mdc`、`AGENTS.md`、
  `versions/latest/regression.md`、`changelog.md`。

### 验证

debug ingest 在 `pathqlSource` 请求入口按 kind + key 计数（`// DEBUG-FILTER`）：

| 场景 | 预期刷新 |
|---|---|
| 画廊筛插件 Y，下载插件 X | 0 |
| 画廊筛「视频」，下载图片 | 0 |
| 默认画廊，下载 | 刷新 |
| 任务 A 详情页，任务 B 下载 | 0 |
| 整理补缩略图 | 只打补丁，0 次重读 |
| 壁纸轮播 | 默认排序 0 次；按设壁纸时间排序时重读 |
| MCP 改名 | 按名称排序 / 搜索时重读，否则只打补丁 |
| 隐藏一张图，hide 关闭 | 图变灰，不重读 |
| 隐藏一张图，hide 开启 | 不变灰，重读后消失 |
| 后台删除本页之外的图 | 本页不刷新 |
| 预览打开时下载 | 预览不重解析 |

### 已知边界

- **行的删除只按包含判断**：后台删除本页之外的图时行不重读，总数经 `deletedTrigger()` 任何删除都刷新。
- **只有计数的观察方**（侧栏、畅游计数、画册树、隐藏数量）没有 id 可比，`images-deleted` 一律刷新。
- **新增不做位置判断**：默认视图下载时第 1 页的行其实不变，仍然刷新。
- **search 维度不排除**：新图的名称 / metadata 匹配交给刷新判断。
- 画廊的画册类事件（noAlbum、label 搜索）放到画册方面的 phase 走查。
