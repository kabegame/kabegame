# 过滤走查 Phase E：画册方面按事件内容收紧刷新

> 依赖 [phaseB.md](phaseB.md) 的 `imageViewRelevance`（`ImageViewState`、`patchTriggers`、`deletedTrigger`、`hiddenTrigger`）。
> 与 [phaseC.md](phaseC.md)、[phaseD.md](phaseD.md) 无关，可以独立实施。

### 总体设计思路

Phase B 收紧的是图片事件（新增 / 删除 / 字段补丁）。画册方面的事件（`album-images-change` 七种 reason、`album-changed` /
`album-added` / `album-deleted`）各观察方基本还是「画册对上就刷新」：不看 reason，也不看自己读的路径带不带 `hide/`、
算不算子树，结果是画册页过度刷新最明显。例如隐藏一张图，后端会给它所在的每个画册发一条 `hide`；即使画册页没开 hide、
本来只需要把卡片打灰，网格的行和总数、页头计数、侧栏画册树的计数也全都要重读一遍。重命名当前画册时，网格同样会重读，
但网格读的 `album/<id>` 只含直接成员，跟画册名毫无关系。

本阶段沿用 Phase B 的原则：**不新增 SQL**，只在现有 `refreshOn` 上收紧，判断不了就刷新。核心是一个公共判断
`membershipAffects(payload, hide)`：七种 reason 各自改变什么后端早已分好，观察方只要说清自己读的路径带不带 `hide/`，
就能判断一条成员事件会不会改变自己的结果集。具体是：

- `add` / `delete` 是可见成员增删，一律相关；
- `add-hidden` / `delete-hidden` 是已隐藏图片的增删，只有不带 `hide/` 的路径能看到；
- `hide` / `unhide` 是成员没变、隐藏状态变了，只有带 `hide/` 的路径受影响；
- `order` 不改变任何结果集，只有按画册顺序排序的行需要重读；
- 隐藏画册本身的事件一律相关，因为读隐藏画册的路径从不带 `hide/`。

画册结构事件按「我读的东西依赖画册的哪部分」收紧：

- **网格**：直接成员不依赖画册名、父级和类型，只有查询里开了标签搜索时，标签路径（`label_path`）变化才影响结果；
- **页头计数**（`album-tree/<id>`，含子树）：只有子画册移入移出（`parentId`）和删除会改变它，改名不会，新建的画册也是空的；
- **页头详情**：祖先改名会改面包屑，子孙改名不影响，只有子孙的增删和移动会改子画册数。

关键决策：

- **不改后端事件**，所有判断都只用 payload 已有的字段（reason、albumIds、ancestorPath、changes 的键）。
- **成员事件已覆盖删除**：画册成员被整行删除时，后端会按画册发 `delete` / `delete-hidden`。所以画册页总数不必再对任何
  `images-deleted` 刷新，让 adapter 声明这一点即可。
- **标签搜索时宁愿多刷**：成员事件的 payload 不带画册类型，分不出是不是标签画册。所以查询用了标签搜索时，任何成员增删
  都刷新。这也顺便补上了现在漏掉的刷新：画廊和画册页在标签搜索下给图挂标签时，现在都不刷新。

### 现状锚点

**a. 画册页网格**（`components/imageGrid/adapters/album.ts:84`）
```ts
refreshOn: [
  ...patchTriggers(view),
  // 现状：本画册的任何成员事件都刷新，不看 reason（hide / unhide / add-hidden / order 都会触发行与总数重读）
  on("album-images-change", (payload) => !!params.albumId() && payload.albumIds.includes(params.albumId())),
  // 现状：本画册改名 / 移动 / 改 labelKey / 改 syncMode 都重读网格；网格读 album/<id>，只含直接成员
  on("album-changed", (payload) => {
    const id = params.albumId();
    if (!id || payload.albumId !== id) return false;
    const kinds = albumChangeKinds(payload);
    return kinds.structure || kinds.row;
  }),
],
```

**b. ImageGrid 总数的删除触发**（`components/ImageGrid.vue:431`）
```ts
const rowsRefreshOn = [...adapter.refreshOn, deletedTrigger(() => images.value.map((image) => image.id))];
const countRefreshOn = [
  ...adapter.refreshOn,
  deletedTrigger(), // 现状：任何删除都重读总数；画册页的成员删除另有 album-images-change，这里对画册页是多余的
  on("images-added", () => !!currentUnfilteredCountPath()),
];
```

**c. 画册页头**（`composables/useAlbumQuery.ts:19`）
```ts
// 现状：sameChain 同时匹配祖先（path.startsWith(p)）与子孙（p.startsWith(path)）
const sameChain = (name, payload, id) => { /* ... */ return paths === "wildcard" || paths.some((p) => p.startsWith(path) || path.startsWith(p)); };

const detail = usePathqlLookAll({
  // albums://id_、ancestors_、subtree_（子画册数）
  refreshOn: [
    // 现状：子孙改名也重读详情
    on("album-changed", (p) => p.albumId === albumId.value || (albumChangeKinds(p).structure && sameChain("album-changed", p, p.albumId))),
    on("album-added", (p) => sameChain("album-added", p, p.id)),
    on("album-deleted", (p) => sameChain("album-deleted", p, p.albumId)),
  ],
});
const count = usePathqlLookAll({
  // images://gallery/album-tree/<id>：含子树，不带 hide/ 前缀
  refreshOn: [
    // 现状：不看 reason；hide / unhide / order 不改变这个计数也会重读
    on("album-images-change", (p) => !!albumId.value && (!!p.albumIds?.includes(albumId.value) || (!!self() && !!p.ancestorPath?.startsWith(self()!)))),
    // 现状：新建子画册（空的）也重读
    on("album-added", (p) => affectsCount("album-added", p)),
    on("album-deleted", (p) => affectsCount("album-deleted", p)),
    // 现状：子画册改名也重读
    on("album-changed", (p) => albumChangeKinds(p).structure && affectsCount("album-changed", p)),
  ],
});
```

**d. 画册树**（`components/albums/AlbumTreeView.vue:177`）
```ts
const prefix = computed(() => (route.hide ? "hide/" : "")); // extra 的计数路径带这个前缀，隐藏画册那一行除外
refreshOn(branch, part) {
  const path = () => (branch.kind === "section" ? null : /* 父节点 ancestorPath */);
  const structure = [
    on("album-added", (payload) => albumEventAffectsDir("album-added", payload, path())),
    on("album-deleted", (payload) => albumEventAffectsDir("album-deleted", payload, path())),
    // 现状：extra（图片计数）也对改名刷新
    on("album-changed", (payload) => { /* (kinds.structure || (part === "page" && kinds.row)) && affectsDir */ }),
  ];
  return part === "page"
    ? structure
    : [
        ...structure,
        // 现状：分区根 path() 为 null，任何画册的任何成员事件都重读每个分区的计数（含收藏 / 隐藏那一区），也不看 reason
        on("album-images-change", (payload) => albumEventAffectsDir("album-images-change", payload, path())),
      ];
},
```

**e. 画廊**（`components/imageGrid/adapters/gallery.ts:48`）
```ts
on("album-images-change", () => routeStore.effectiveNoAlbum), // 现状：无画册时不看 reason；标签搜索时挂标签不刷新（漏）
on("album-changed", (payload) => {
  const kinds = albumChangeKinds(payload);
  return kinds.structure || (routeStore.effectiveNoAlbum && kinds.row); // 现状：任何画册改名都重读画廊
}),
// 现状：不听 album-deleted；无画册时靠删画册后补发的空 order 事件刷新，标签搜索时删标签不刷新（漏）
```

**f. 画廊侧栏**（`components/galleryFilterTree/facetTreeSource.ts:120`）
```ts
function hasAlbumSensitiveContext() {
  const path = normalizeProviderPath(ctx.prefix.value).replace(/^images:\/\//, "");
  // 现状：hide 也算画册敏感；hide 开启时往普通画册加图也重读侧栏，而隐藏画册成员已由 hiddenTrigger 负责
  return /(^|\/)(?:album|album-tree|no-album|hide)(?:\/|$)/.test(path);
}
```

**g. 后端成员事件的 reason**（`kabegame-core/src/storage/image_events.rs:152`）
```rust
// 加入隐藏画册：隐藏画册发 add-hidden，图片所在的其它每个画册各发 hide
// 加入普通画册：可见图发 add，已隐藏的图发 add-hidden；移除同理（delete / delete-hidden / unhide）
// 整行删除走 ImagesDeleted 上下文：每个画册发 delete / delete-hidden
// 排序：order（删画册时还会给子树每个画册补发一条 imageIds 为空的 order）
```

### 点 1 — 公共判断（`services/kbEvents/events.ts`、`imageViewRelevance.ts`）

- **新增**
```ts
// events.ts
/** 一条成员事件会不会改变某条路径的结果集；hide 指该路径是否带 `hide/` 前缀。order 不改结果集，由需要的观察方单独判断。 */
export function membershipAffects(payload: AlbumImagesChangePayload, hide: boolean): boolean {
  if (isHiddenAlbumChange(payload)) return true; // 读隐藏画册的路径从不带 hide/
  switch (payload.reason) {
    case "add":
    case "delete":
      return true;
    case "add-hidden":
    case "delete-hidden":
      return !hide;
    case "hide":
    case "unhide":
      return hide;
    case "order":
      return false;
    default:
      return true; // 未知 reason 保守刷新
  }
}
```
```ts
// imageViewRelevance.ts
/**
 * 查询用了标签搜索时，标签路径与标签成员都会改变结果。成员事件分不出是不是标签画册，所以任何成员增删都算；
 * 删画册会连带删掉成员，也要刷新。
 */
export function labelSearchTriggers(view: () => ImageViewState): EventTrigger[] {
  const uses = () => queryUsesSearchMode(view().query, "label");
  return [
    on("album-images-change", (payload) => uses() && membershipAffects(payload, view().hide)),
    on("album-changed", (payload) => uses() && albumChangeKinds(payload).structure),
    on("album-deleted", () => uses()),
  ];
}
```
- **修改**
  - `albumChangeKinds` 多返回 `moved`（changes 含 `parentId`），供只关心移动的计数观察方使用。
```ts
export function albumChangeKinds(payload: AlbumChangedPayload): { structure: boolean; row: boolean; moved: boolean } {
  const changes = payload.changes ?? {};
  const has = (field: string) => Object.prototype.hasOwnProperty.call(changes, field);
  return { structure: ALBUM_STRUCTURE_FIELDS.some(has), row: ALBUM_ROW_FIELDS.some(has), moved: has("parentId") }; // 修改：新增 moved
}
```
  - `index.ts` 导出 `membershipAffects`、`labelSearchTriggers`。

### 点 2 — 画册页网格（`adapters/album.ts`、`imageGrid/types.ts`、`ImageGrid.vue`）

- **修改**
```ts
// album.ts
// 新增：成员判断用实际路径的 hide；隐藏画册页忽略 hide（ignoreHide），viewState 保持原值，避免影响 patchHidden
const pathHidesHidden = () => routeStore.hide && params.albumId() !== HIDDEN_ALBUM_ID;
refreshOn: [
  ...patchTriggers(view),
  // 修改：本画册的成员事件按 reason 判断；hide 关闭时 hide / unhide 只由 imagePatches$ 打灰，不刷新
  on("album-images-change", (payload) =>
    !!params.albumId() && payload.albumIds.includes(params.albumId()) && membershipAffects(payload, pathHidesHidden())),
  // 新增：order 只在按画册顺序排序时重读（总数也会跟着读一次，换来不改 ImageGrid 的触发拆分）
  on("album-images-change", (payload) =>
    payload.reason === "order" && payload.albumIds.includes(params.albumId()) && routeStore.sort.field === "by-album-order"),
  // 新增：标签搜索时跟随标签结构与成员
  ...labelSearchTriggers(view),
  // 删除：本画册的 album-changed 触发（直接成员不依赖画册名 / 父级 / labelKey / syncMode；画册行由页头观察）
],
// 新增：画册成员的整行删除都会到达本画册的 delete / delete-hidden，总数不再听 images-deleted
deletesViaMembership: true,
```
```ts
// types.ts
export interface GridAdapter {
  // ...
  /** 新增：成员删除都经 album-images-change 到达；ImageGrid 的总数不再追加任何删除都刷新的 deletedTrigger() */
  deletesViaMembership?: boolean;
}
```
```ts
// ImageGrid.vue
const countRefreshOn = [
  ...adapter.refreshOn,
  ...(adapter.deletesViaMembership ? [] : [deletedTrigger()]), // 修改
  on("images-added", () => !!currentUnfilteredCountPath()),
];
```
    > 说明：行的 `deletedTrigger(heldIds)` 保留，命中时与成员事件落在同一个 500ms 窗口，不会多读。

### 点 3 — 画册页头（`composables/useAlbumQuery.ts`）

- **修改**
```ts
// 新增：按方向区分祖先（含自身）与严格子孙
const relation = (name: string, payload: unknown): { ancestor: boolean; descendant: boolean } => {
  const path = self();
  const paths = albumEventPaths(name, payload);
  if (!path || paths === "wildcard") return { ancestor: true, descendant: true };
  return {
    ancestor: paths.some((p) => path.startsWith(p)),
    descendant: paths.some((p) => p !== path && p.startsWith(path)),
  };
};

const detail = usePathqlLookAll({
  refreshOn: [
    on("album-changed", (p) => {
      if (p.albumId === albumId.value) return true;
      const kinds = albumChangeKinds(p);
      const r = relation("album-changed", p);
      // 修改：祖先的结构变化改面包屑；子孙只有移动会改子画册数
      return (r.ancestor && kinds.structure) || (r.descendant && kinds.moved);
    }),
    on("album-added", (p) => relation("album-added", p).descendant), // 修改：新画册只可能是子孙
    on("album-deleted", (p) => sameChain("album-deleted", p, p.albumId)), // 不变：删自身 / 祖先要回落，删子孙改子画册数
  ],
});
const count = usePathqlLookAll({
  // images://gallery/album-tree/<id>：不带 hide/ 前缀
  refreshOn: [
    on("album-images-change", (p) =>
      !!albumId.value &&
      (!!p.albumIds?.includes(albumId.value) || (!!self() && !!p.ancestorPath?.startsWith(self()!))) &&
      membershipAffects(p, false)), // 修改：hide / unhide / order 不改这个计数
    // 删除：album-added（新画册是空的；带图新建的标签画册随后会发成员事件）
    on("album-deleted", (p) => affectsCount("album-deleted", p)),
    on("album-changed", (p) => albumChangeKinds(p).moved && affectsCount("album-changed", p)), // 修改：只有移入移出改变子树
  ],
});
```

### 点 4 — 画册树（`components/albums/AlbumTreeView.vue`）

- **修改**
```ts
refreshOn(branch, part) {
  const path = () => /* 不变 */;
  // 新增：分区根按事件所在根画册归属分区；根画册不在已加载节点里，说明它不在任何已显示的页上
  const inBranch = (name: string, payload: unknown, albumIds: readonly string[] = []) => {
    if (branch.kind !== "section") return albumEventAffectsDir(name, payload, path());
    if (branch.sectionId === "system") return albumIds.some((id) => id === FAVORITE_ALBUM_ID || id === HIDDEN_ALBUM_ID);
    const paths = albumEventPaths(name, payload);
    if (paths === "wildcard") return true;
    return paths.some((p) => {
      const root = model.nodeByKey(p.split("/").filter(Boolean)[0] ?? "")?.element;
      return !root || sectionOf(root) === branch.sectionId; // 找不到时保守刷新
    });
  };
  const structure = [
    on("album-added", (payload) => albumEventAffectsDir("album-added", payload, path())),
    on("album-deleted", (payload) => albumEventAffectsDir("album-deleted", payload, path())),
    on("album-changed", (payload) => {
      const kinds = albumChangeKinds(payload);
      // 修改：page 读名称与行字段，看 structure / row；extra 只读计数，只看移动
      const relevant = part === "page" ? kinds.structure || kinds.row : kinds.moved;
      return relevant && albumEventAffectsDir("album-changed", payload, path());
    }),
  ];
  return part === "page"
    ? structure
    : [
        ...structure,
        // 修改：按 reason 与 prefix 判断，分区根再按根画册归属分区
        on("album-images-change", (payload) =>
          membershipAffects(payload, !!prefix.value) && inBranch("album-images-change", payload, payload.albumIds)),
      ];
},
```
    > 说明：分区根的 extra 现在要等根画册节点加载后才能判断归属。找不到根画册时保守刷新，所以首屏和翻页不会漏刷。

### 点 5 — 画廊与侧栏（`adapters/gallery.ts`、`galleryFilterTree/facetTreeSource.ts`）

- **修改**
```ts
// gallery.ts
refreshOn: [
  addedTrigger(view),
  ...patchTriggers(view),
  hiddenTrigger(view),
  ...labelSearchTriggers(view), // 新增：补上标签搜索下挂标签 / 删标签 / 改标签路径的刷新
  // 修改：无画册时按 reason；隐藏只看隐藏画册之外的归属，hide / unhide 由 hiddenTrigger 负责
  on("album-images-change", (payload) => routeStore.effectiveNoAlbum && membershipAffects(payload, routeStore.hide)),
  // 修改：只有无画册时才关心画册结构 / 行字段；任意画册改名不再重读画廊
  on("album-changed", (payload) => {
    const kinds = albumChangeKinds(payload);
    return routeStore.effectiveNoAlbum && (kinds.structure || kinds.row);
  }),
  // 新增：删画册会让其成员变成无画册；现在靠补发的空 order 事件，order 被 membershipAffects 排除后改听 album-deleted
  on("album-deleted", () => routeStore.effectiveNoAlbum),
],
```
```ts
// facetTreeSource.ts
function hasAlbumSensitiveContext() {
  const path = normalizeProviderPath(ctx.prefix.value).replace(/^images:\/\//, "");
  // 修改：去掉 hide（隐藏画册成员已由 hiddenTrigger 负责）；标签搜索时同样依赖画册
  return /(^|\/)(?:album|album-tree|no-album)(?:\/|$)/.test(path) ||
    (contextQuery.value !== null && queryUsesSearchMode(contextQuery.value, "label"));
}
```
  - 侧栏的 `album-images-change` 改为 `hasAlbumSensitiveContext() && membershipAffects(payload, view().hide)`。

### 点 6 — 测试、文档

- **测试**
  - `membershipAffects`：七种 reason 在 hide 开 / 关下的取值，隐藏画册事件恒为真，未知 reason 为真。
  - `labelSearchTriggers`：没用标签搜索时全为假，用了时三种事件各自为真。
  - 画册 adapter（`adapters/imageEvents.test.ts`）：
    - hide 关时 hide / unhide 不刷新，hide 开时 add-hidden 不刷新；
    - 隐藏画册页忽略 hide；
    - order 只在 by-album-order 下刷新；
    - 改名不刷新。
  - `ImageGrid.previewFollowPage.test.ts`：`deletesViaMembership` 时总数不听 `images-deleted`，行仍按包含判断。
  - `useAlbumQuery`：子孙改名不刷新详情、子孙移动刷新详情与计数、新建子画册只刷新详情、hide 类事件不刷新计数。
  - `AlbumTreeView`：分区根只对本分区根画册的事件刷新 extra、系统区只认收藏 / 隐藏、改名不刷新 extra。
  - 画廊：任意画册改名不刷新、无画册时 album-deleted 刷新、标签搜索时挂标签刷新。
  - `facetTreeSource`：只有 hide 的上下文不再响应普通画册成员。
- **文档**：
  - `cocs/gallery/GALLERY_PAGINATION_AND_IMAGE_LOAD.md`：`album-images-change` 七种 reason 段补「各观察方按 reason 与 hide 前缀判断」。
  - `cocs/gallery/PROVIDER_IMAGEQUERY_COMPOSABLE.md`：侧栏画册敏感上下文。
  - `AGENTS.md` 与 `.cursor/rules/view-mutation.mdc` 的 ImageGrid 段：`deletesViaMembership`、成员事件按 reason 判断。
  - `versions/latest/regression.md`、`changelog.md`。

### 验证

用 debug ingest 在 `pathqlSource.ts` 的请求入口插桩（`// DEBUG-ALBUM`），按 key 统计重读次数。

| 场景 | 预期 |
|---|---|
| 画册页 hide 关，隐藏本画册一张图 | 网格 0 次，卡片原地打灰；页头计数 0 次；树 extra 只重读隐藏画册所在的系统区 |
| 画册页 hide 开，隐藏本画册一张图 | 网格行与总数各 1 次，图被剔除；页头计数 0 次 |
| 画册页 hide 开，把一张已隐藏的图加进本画册 | 网格 0 次；页头计数 1 次 |
| 重命名当前画册 | 网格 0 次；页头详情 1 次；树 page 1 次、extra 0 次 |
| 重命名子画册 | 页头详情 0 次、计数 0 次 |
| 新建子画册 | 页头详情 1 次（子画册数 +1）、计数 0 次 |
| 把带图的子画册移出当前画册 | 页头详情与计数各 1 次 |
| 画册页按画册顺序 / 按时间排序时拖动排序 | 前者网格重读，后者 0 次 |
| 画廊删除一张不在当前画册的图 | 画册页总数 0 次 |
| 往普通画册加图（下载输出画册） | 只重读该画册所在分区的树 extra，其它分区 0 次 |
| 画廊重命名任意画册 | 画廊 0 次（未开无画册、未用标签搜索时） |
| 画廊开无画册后删除一个带图画册 | 画廊刷新，原成员出现 |
| 画廊用标签搜索时给图挂上匹配的标签 | 画廊刷新，图出现（现状不刷新） |
| 画廊只开 hide，往普通画册加图 | 侧栏 0 次 |

### 已知边界

- **标签搜索时多刷**：成员事件分不出标签画册，开了标签搜索后任何画册的成员增删都会刷新。
- **order 也会重读总数**：按画册顺序排序时拖动会多读一次总数。拆开行与总数的触发需要给 adapter 加第二份 `refreshOn`，
  不值得为这一次请求增加复杂度。同理，按设壁纸时间、名称排序的字段补丁现在也会连带重读总数，本阶段不处理。
- **分区根依赖已加载节点**：根画册节点没加载时保守刷新。分区很长、只加载了前几页时，后面页的画册事件仍会重读第一页的计数。
- **页外字段补丁**：表外字段对页外图片仍会刷新画册页总数（Phase B 的保守口径），因为前端不知道页外图片是不是本画册成员。
