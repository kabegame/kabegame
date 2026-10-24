# 过滤走查 Phase F：前端按画册事件收紧刷新

> 依赖 [phaseE.md](phaseE.md) 的新事件（`albums-*` / `album-changed` 补丁、`album-images-added` / `-deleted` / `-change`），
> 以及 [phaseB.md](phaseB.md) 的 `imageViewRelevance`。

### 总体设计思路

phaseE 之后，画册事件已经说清了「哪张表、增删改了什么」，但各观察方仍按现有口径「画册对上就刷新」，画册页过度刷新最明显：

- 重命名当前画册时，网格会重读，可网格读的 `album/<id>` 只含直接成员，跟画册名无关；
- 页头计数读 `album-tree/<id>`，不带 `hide/`，却对子画册改名、新建空子画册都重读；
- 画廊里删任意一张图，画册页总数都会重读；
- 画册树的分区根对任何画册的成员变化都重读每个分区的计数。

本阶段沿用 Phase B 的原则：**不新增 SQL**，只在现有 `refreshOn` 上收紧，判断不了就刷新。三条主线：

1. **收藏只打补丁**：收藏就是收藏画册的成员增删，`favorite` 由 `imagePatches$` 原地补丁。只有真正以收藏为条件的视图才刷新：
   - 收藏画册页；
   - 「无画册」视图（它的 SQL 是 `is_favorite or NOT EXISTS …`）；
   - 画册树系统区的计数；
   - 以收藏或「无画册」为上下文的侧栏。
2. **隐藏按 hide 开关处理，不按图判断**：隐藏 / 取消隐藏只是隐藏画册自身的成员增删，事件不带图片所在的画册和图片行。
   hide 开启的视图收到就刷新，关闭的视图只由 `patchHidden` 按 id 打灰，phaseE 已经是这个口径，本阶段不动。
   唯一要补的是删图：删图造成的隐藏画册 deleted 带 `imagesDeleted`，「无画册」等触发要跳过它，交给 `images-deleted`。
3. **画册结构按依赖收紧**：网格不依赖画册名；页头计数只受子画册移入移出与删除影响；画册树的计数不受改名影响；
   画廊只有在「无画册」或标签搜索时才关心画册结构。

### 现状锚点

**a. ImageGrid 总数对任何删除都刷新**（`ImageGrid.vue:431`）
```ts
const rowsRefreshOn = [...adapter.refreshOn, deletedTrigger(() => images.value.map((image) => image.id))];
// 现状：画册页的成员删除另有本画册的 album-images-deleted，这条对画册页是多余的
const countRefreshOn = [...adapter.refreshOn, deletedTrigger(), on("images-added", () => !!currentUnfilteredCountPath())];
```

**c. 画册页网格**（`adapters/album.ts:84`）
```ts
refreshOn: [
  ...patchTriggers(view),
  on("album-images-added", (p) => p.albumId === params.albumId()),
  on("album-images-deleted", (p) => p.albumId === params.albumId()),
  ...hiddenTrigger(view),
  // 现状：任何排序都刷新，不看当前是否按画册顺序排序
  on("album-images-change", (p) => p.albumId === params.albumId()),
  // 现状：本画册的结构 / 行字段补丁也刷新；网格读 album/<id>，只含直接成员
  on("album-changed", (p) => p.patch.id === params.albumId() && (albumChangeKinds(p).structure || albumChangeKinds(p).row)),
],
```

**d. 画册页头**（`composables/useAlbumQuery.ts`）
```ts
// 现状：详情对子孙改名也刷新（sameChain 同时匹配祖先与子孙）
// 现状：计数（album-tree/<id>，不带 hide/）对新建子画册、子画册改名都刷新
```

**e. 画册树**（`components/albums/AlbumTreeView.vue:177`）
```ts
// 现状：extra（计数）对改名也刷新；分区根 path() 为 null，任何画册的成员事件都重读每个分区（含系统区）的计数
on("album-images-added", (payload) => albumEventAffectsDir(…, path())),
```

**f. 画廊与侧栏**（`adapters/gallery.ts:48`、`galleryFilterTree/facetTreeSource.ts:120`）
```ts
// 现状：任何画册结构补丁都重读画廊
on("album-changed", (payload) => { const kinds = albumChangeKinds(payload); return kinds.structure || (routeStore.effectiveNoAlbum && kinds.row); }),
// 现状：hide 也算画册敏感，hide 开时往普通画册加图也重读侧栏
return /(^|\/)(?:album|album-tree|no-album|hide)(?:\/|$)/.test(path);
```

**g. 预览与标签面板**（`ImagePreviewDialog.vue:883`、`ImageLabelsPanel.vue:167`）
```ts
on("album-images-added", (p) => p.imageIds.includes(id)), // 现状：收藏 / 隐藏也重解析，补丁已覆盖 favorite / isHidden
on("album-images-added", (p) => p.imageIds.includes(props.image.id)), // 现状：收藏 / 隐藏也重读标签
```

**h. 任务 / 畅游的「无画册」缺口**（zoucha.md MQ9）
```ts
// stores/taskDetailRoute.ts:60-66、surfImagesRoute.ts:53-56 —— 路由会叠加全局 no-album
// adapters/task.ts:35-39、surf.ts:33-37 —— 现状：不听普通成员事件，加入画册 / 收藏后不刷新
```

### 点 1 — 公共判断（`services/kbEvents/imageViewRelevance.ts`、`events.ts`）

- **新增**
```ts
// imageViewRelevance.ts
/** 标签搜索依赖标签路径与标签成员；成员事件分不出标签画册，任何成员增删都算 */
export function labelSearchTriggers(view: () => ImageViewState): EventTrigger[] {
  const uses = () => queryUsesSearchMode(view().query, "label");
  return [
    on("album-images-added", () => uses()),
    on("album-images-deleted", () => uses()),
    on("album-changed", (p) => uses() && albumChangeKinds(p).structure),
    on("albums-change", (p) => uses() && albumChangeKinds(p).structure),
    on("album-moved", () => uses()), // 移动标签或标签目录会改变 label_path
    on("albums-deleted", () => uses()),
  ];
}

/** 收藏画册成员变化只对「无画册」视图有意义，其余视图靠 imagePatches$ 打补丁 */
export function noAlbumTriggers(noAlbum: () => boolean): EventTrigger[] {
  return [
    on("album-images-added", (p) => noAlbum() && p.albumId !== HIDDEN_ALBUM_ID),
    on("album-images-deleted", (p) => noAlbum() && p.albumId !== HIDDEN_ALBUM_ID && !p.imagesDeleted),
    on("albums-deleted", () => noAlbum()),
  ];
}
```
    > 说明：「无画册」忽略隐藏画册成员（见 `gallery_no_album_router.json5`），hide 由下面的隐藏触发负责。删图本身由 `images-deleted` 处理。

- **不变**
  - `hiddenTrigger`：hide 开启时对隐藏画册的 added / deleted 一律刷新，关闭时不刷新（由 `imagePatches$` 打补丁）。

### 点 2 — 总数的删除触发与任务 / 畅游的「无画册」（`ImageGrid.vue`、`imageGrid/types.ts`、`adapters/{task,surf}.ts`）

- **新增**
```ts
// types.ts
export interface GridAdapter {
  // ...
  /** 成员删除都经 album-images-deleted 到达，总数不再追加任何删除都刷新的 deletedTrigger() */
  deletesViaMembership?: boolean;
}
```
- **修改**
```ts
// ImageGrid.vue
const countRefreshOn = [
  ...adapter.refreshOn,
  ...(adapter.deletesViaMembership ? [] : [deletedTrigger()]), // 修改
  on("images-added", () => !!currentUnfilteredCountPath()),
];
```
  - task / surf 补上 `...noAlbumTriggers(() => routeStore.effectiveNoAlbum)`，修复 MQ9。

### 点 3 — 画册页网格（`adapters/album.ts`）

- **修改**
```ts
refreshOn: [
  ...patchTriggers(view),
  on("album-images-added", (p) => p.albumId === params.albumId()),
  on("album-images-deleted", (p) => p.albumId === params.albumId()),
  ...hiddenTrigger(view), // 不变：hide 开启时隐藏 / 取消隐藏一律刷新
  // 修改：排序只在按画册顺序排序时重读（总数也会读一次，换来不拆行与总数的 refreshOn）
  on("album-images-change", (p) => p.albumId === params.albumId() && routeStore.sort.field === "by-album-order"),
  ...labelSearchTriggers(view),
  // 删除：本画册的 album-changed（直接成员不依赖画册名 / 父级 / labelKey / syncMode；画册行由页头观察）
],
deletesViaMembership: true,
```

### 点 4 — 画册页头（`composables/useAlbumQuery.ts`）

- **修改**
```ts
// 新增：自身路径含自身与全部祖先的 id；子孙前端不持有
const inChain = (id: string) => !!self() && pathHasAlbum(self()!, id);           // 我或我的祖先（按 id）
const inChainPath = (path: string) => !!self() && self()!.startsWith(path);      // 我或我的祖先（按路径）
const underSelf = (path: string) => !!self() && path !== self() && path.startsWith(self()!); // 严格子孙
const inSubtree = (p: AlbumImagesPayload) =>
  p.albumId === albumId.value || (!!self() && p.ancestorPath.startsWith(self()!));

const detail = usePathqlLookAll({
  refreshOn: [
    // 修改：自身任何补丁；祖先的结构变化改面包屑；不在链上的画册改名不影响详情（补丁不再含位置）
    ...albumPatchTriggers((patch, kinds) => patch.id === albumId.value || (inChain(patch.id) && kinds.structure)),
    // 新增：移动的是我或祖先 → 链变了；子孙移入（新路径在我下面）或移出（旧路径在我下面）→ 子画册数变了
    on("album-moved", (p) => inChain(p.id) || underSelf(p.newAncestorPath) || underSelf(p.oldAncestorPath)),
    on("albums-added", (p) => p.albums.some((a) => underSelf(a.ancestorPath))), // 修改：新画册只可能是子孙，新行带路径
    // 修改：删自身 / 祖先要回落，删子孙会改子画册数；其它画册的删除不影响
    on("albums-deleted", (p) => p.albums.some((a) => inChainPath(a.ancestorPath) || underSelf(a.ancestorPath))),
  ],
});
const count = usePathqlLookAll({
  // images://gallery/album-tree/<id>：不带 hide/，隐藏画册事件只在当前画册就是隐藏画册时相关
  refreshOn: [
    on("album-images-added", inSubtree),
    on("album-images-deleted", inSubtree),
    // 删除：albums-added（新画册是空的，带图新建的标签画册随后会发成员事件）
    // 修改：只有删子孙改变子树计数；删我或祖先时详情会回落，计数不用读
    on("albums-deleted", (p) => p.albums.some((a) => underSelf(a.ancestorPath))),
    // 修改：只有子孙移入移出改变子树；移动的是我或祖先、或在子树内部挪动时计数不变
    on("album-moved", (p) => !inChain(p.id) && underSelf(p.newAncestorPath) !== underSelf(p.oldAncestorPath)),
    // 删除：album-changed / albums-change（改名等补丁不改变子树计数）
  ],
});
```
    > 说明：删除和移动都带了路径，改名只看是否在链上，页头的三类判断都是精确的，不需要持有子孙。
  - 新增 `albumPatchTriggers(fn)`，同时挂 `album-changed` 与 `albums-change`，按补丁逐条判断。补丁不含位置，
    位置变化只看 `album-moved`。收到 `album-moved` 时，自身与祖先链的路径按 phaseE 点 5 改写。

### 点 5 — 画册树（`components/albums/AlbumTreeView.vue`）

- **修改**
```ts
refreshOn(branch, part) {
  const path = () => /* 不变 */;
  const hidePrefixed = () => !!prefix.value;
  // 新增：分区根按根画册归属分区；根画册不在已加载节点里时保守刷新
  const inBranch = (ancestorPath: string) => {
    if (branch.kind !== "section") return albumEventAffectsDir(ancestorPath, path());
    if (branch.sectionId === "system") return false; // 系统区单独判断
    const root = model.nodeByKey(ancestorPath.split("/").filter(Boolean)[0] ?? "")?.element;
    return !root || sectionOf(root) === branch.sectionId;
  };
  // 新增：系统区只认收藏 / 隐藏（隐藏计数不带 prefix，隐藏画册事件总会改它）
  const systemHit = (p: AlbumImagesPayload) =>
    branch.kind === "section" && branch.sectionId === "system" &&
    (p.albumId === FAVORITE_ALBUM_ID || p.albumId === HIDDEN_ALBUM_ID);
  // 新增：一条成员事件影响哪些目录的计数
  const memberHit = (p: AlbumImagesPayload) => {
    if (systemHit(p)) return true;
    if (p.albumId !== HIDDEN_ALBUM_ID) return inBranch(p.ancestorPath);
    // 隐藏画册：事件不带图片所在的画册，带 hide/ 前缀的计数一律刷新（不变）；删图造成的由各原属画册自己的 deleted 定位
    return hidePrefixed() && !p.imagesDeleted;
  };
  const affects = (p: string) => albumEventAffectsDir(p, path());
  // 新增：补丁不带路径；名称与行字段只显示在已加载的行上，所以从已加载节点取路径，找不到就无需刷新
  const heldPath = (id: string) => model.nodeByKey(id)?.element.ancestorPath;
  const structure = [
    on("albums-added", (p) => p.albums.some((a) => affects(a.ancestorPath))),   // 新行自带路径
    on("albums-deleted", (p) => p.albums.some((a) => affects(a.ancestorPath))), // 修改：被删的根自带路径，不要求已加载
    // 修改：补丁只影响显示名称与行字段的 page，extra（计数）不听补丁
    ...(part === "page"
      ? albumPatchTriggers((patch, kinds) => {
          const held = heldPath(patch.id);
          return (kinds.structure || kinds.row) && !!held && affects(held);
        })
      : []),
    // 新增：移动带新旧路径，page 与 extra 都按两侧位置判断，不要求被移动的画册已加载
    on("album-moved", (p) => affects(p.oldAncestorPath) || affects(p.newAncestorPath)),
  ];
  return part === "page"
    ? structure
    : [...structure, on("album-images-added", memberHit), on("album-images-deleted", memberHit)];
},
```
    > 说明：增、删、移动三种画册表事件都自带路径，不依赖已加载节点；只有补丁靠已加载节点定位，而补丁改的名称和行字段
    > 本来就只显示在已加载的行上。收到 `album-moved` 时，已加载子孙节点的路径按 phaseE 点 5 改写，后续计算才不会用错。
    >
    > 带 `hide/` 前缀时，删图造成的成员删除也会从隐藏计数之外的普通计数里消失。这些图的每个原属画册都有自己的
    > deleted，所以走 `inBranch(p.ancestorPath)`。只有隐藏画册自己那条带 `imagesDeleted` 的事件，才对带前缀的目录不处理。

### 点 6 — 画廊、侧栏、预览、标签面板

- **修改**
```ts
// adapters/gallery.ts
refreshOn: [
  addedTrigger(view),
  ...patchTriggers(view),
  ...labelSearchTriggers(view),                              // 新增
  ...noAlbumTriggers(() => routeStore.effectiveNoAlbum),     // 修改：取代原先不看 reason 的成员触发
  // 修改：只有无画册时才关心画册结构 / 行字段，任意画册改名不再重读画廊
  ...albumPatchTriggers((_patch, kinds) => routeStore.effectiveNoAlbum && (kinds.structure || kinds.row)),
],
```
```ts
// facetTreeSource.ts
function hasAlbumSensitiveContext() {
  const path = normalizeProviderPath(ctx.prefix.value).replace(/^images:\/\//, "");
  // 修改：去掉 hide（隐藏画册成员由隐藏触发负责）；标签搜索同样依赖画册
  return /(^|\/)(?:album|album-tree|no-album)(?:\/|$)/.test(path) ||
    (contextQuery.value !== null && queryUsesSearchMode(contextQuery.value, "label"));
}
// 隐藏：hide 开且隐藏画册事件时刷新（侧栏是计数，不区分持有，同 ImageGrid 总数口径；取消隐藏带 images 时按上下文查询判断）
```
```ts
// ImagePreviewDialog.vue —— 修改：收藏 / 隐藏只靠 imagePatches$ 补丁，不再重解析
on("album-images-added", (p) => !isSystemAlbum(p.albumId) && p.imageIds.includes(id)),
on("album-images-deleted", (p) => !isSystemAlbum(p.albumId) && p.imageIds.includes(id)),
// ImageLabelsPanel.vue —— 修改：收藏 / 隐藏不是标签，不重读；删画册时看已挂标签的路径是否以被删路径开头
//（删标签目录会连带删掉下面的叶子）
on("albums-deleted", (p) => labels.value.some((label) => p.albums.some((a) => label.ancestorPath.startsWith(a.ancestorPath)))),
// 移动已挂标签或它的上级目录会改变标签路径文案
on("album-moved", (p) => labels.value.some((label) => pathHasAlbum(label.ancestorPath, p.id))),
```
    > 说明：`ImagePreviewDialog.vue:882` 的注释说补丁之外仍要重拉。实施前要先核实原因：如果重解析只为了刷新 `favorite` / `isHidden`，
    > 现在补丁已经覆盖；否则保留系统画册的重解析。

### 点 7 — 测试、文档

- **测试**
  - `imageViewRelevance.test.ts`：
    - `labelSearchTriggers`、`noAlbumTriggers`：隐藏画册与删图事件不触发。
  - `ImageGrid.previewFollowPage.test.ts`：
    - `deletesViaMembership` 时总数不听 `images-deleted`。
  - `adapters/imageEvents.test.ts`：
    - 画册页：改名不刷新；排序只在 `by-album-order` 下刷新；hide 开时隐藏 / 取消隐藏刷新、关闭时不刷新；
    - task / surf：「无画册」时加入画册刷新。
  - `useAlbumQuery.test.ts`：子孙改名不刷新；子孙移动刷新详情与计数；新建子画册只刷新详情；隐藏画册事件不刷新普通画册的计数。
  - `AlbumTreeView` / `useTreeModel.test.ts`：
    - 分区根只对本分区的事件刷新 extra；
    - 系统区只认收藏 / 隐藏；
    - 改名不刷新 extra；
    - 带 `hide/` 前缀时，隐藏按成员表路径刷新。
  - 画廊：任意画册改名不刷新；收藏不刷新（「无画册」时刷新）；标签搜索时挂标签刷新。
  - `facetTreeSource.test.ts`：只有 hide 的上下文不再响应普通画册成员。
  - `ImagePreviewDialog.events.test.ts`：收藏 / 隐藏只补丁不重解析。
- **文档**：
  - `cocs/gallery/GALLERY_PAGINATION_AND_IMAGE_LOAD.md`：收藏只补丁、`deletesViaMembership`；
  - `cocs/gallery/PROVIDER_IMAGEQUERY_COMPOSABLE.md`：侧栏画册敏感上下文；
  - `AGENTS.md` 与 `.cursor/rules/view-mutation.mdc` 的 ImageGrid 段；
  - `versions/latest/regression.md`、`changelog.md`。

### 验证

用 debug ingest 在 `pathqlSource.ts` 的请求入口插桩（`// DEBUG-ALBUM`），按 key 统计重读次数。

| 场景 | 预期 |
|---|---|
| 画廊收藏 / 取消收藏一张图 | 画廊 0 次，心形原地变化；预览 0 次重解析；画册树只重读系统区 |
| 画廊开「无画册」后收藏一张在普通画册里的图 | 画廊 1 次，图出现 |
| 画廊 hide 开，隐藏 / 取消隐藏任意一张图 | 行与总数各 1 次（不按图判断） |
| 画册页 hide 关，隐藏本画册一张图 | 网格 0 次，卡片打灰；页头计数 0 次 |
| 画册页 hide 开，隐藏任意一张图 | 网格行与总数各 1 次；页头计数 0 次 |
| 重命名当前画册 | 网格 0 次；页头详情 1 次；树 page 1 次、extra 0 次 |
| 重命名子画册 | 页头详情 0 次、计数 0 次 |
| 重命名祖先画册 | 页头详情 1 次（面包屑更新）、计数 0 次 |
| 新建子画册 | 页头详情 1 次、计数 0 次 |
| 把带图的子画册移出当前画册 | 页头详情与计数各 1 次 |
| 删除当前画册 | 页头回落到最近存活的祖先；计数不为它多读 |
| 删除一个标签目录，当前图挂着它下面的标签 | 标签面板 1 次，标签消失 |
| 删除一个折叠分支深处的画册 | 只重读它祖先所在页的计数 |
| 删除一个与当前画册无关的画册 | 页头详情与计数 0 次 |
| 删除当前画册的子画册 | 页头详情与计数各 1 次 |
| 移动一个折叠分支深处的画册 | 只重读新旧两侧祖先所在页的计数 |
| 在当前画册子树内部挪动子画册 | 页头详情 1 次、计数 0 次 |
| 画册页按画册顺序 / 按时间排序时拖动排序 | 前者网格重读，后者 0 次 |
| 画廊删除一张不在当前画册的图 | 画册页总数 0 次 |
| 往普通画册加图（下载输出画册） | 只重读该画册所在分区的树 extra |
| 画廊重命名任意画册 | 画廊 0 次（未开「无画册」、未用标签搜索时） |
| 画廊用标签搜索时给图挂上匹配的标签 | 画廊刷新，图出现 |
| 任务详情开「无画册」后把一张图加入画册 | 网格刷新，图被剔除（现状不刷新） |
| 画廊只开 hide，往普通画册加图 | 侧栏 0 次 |

### 已知边界

- **hide 开启时隐藏一律刷新**：事件不带图片所在画册和图片行，hide 开的视图（网格、带 `hide/` 前缀的画册树计数、侧栏）
  对任何隐藏 / 取消隐藏都重新查询，即使变化的图与当前视图无关。
- **标签搜索时多刷**：成员事件分不出标签画册，开了标签搜索后任何画册的成员增删都会刷新。
- **排序也会重读总数**：按画册顺序排序时拖动会多读一次总数。按设壁纸时间、名称排序的字段补丁同样会连带重读总数，本阶段不处理。
- **分区根依赖已加载节点**：根画册节点没加载时保守刷新。
- **页外字段补丁**：表外字段对页外图片仍会刷新画册页总数（Phase B 的保守口径）。
