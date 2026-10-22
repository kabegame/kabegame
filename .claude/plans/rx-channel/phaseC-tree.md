# Phase C（树）：useTreeModel 重写为 pathql 观察方

状态：方案，未实施。

### 总体设计思路

现在的树模型是「自己拉数据」：`TreeDataSource` 给出返回 Promise 的 `getChildren` / `getRootsPage`，模型在展开、加载更多、
`reload()` 时调用它们，用每节点的 `loadTokens` 挡迟到结果；事件刷新则由宿主订阅 `dataChangeHub`，自己判断哪些目录受影响，
再调 `reloadRoots()` / `refreshChildren()` / `reload()`。数据的新旧判断、刷新时机、相关性全散在模型和两个宿主里，
而且根列表的 `reloadSection` 没有 token，靠 hub 串行执行 `onBatch` 才不出错。

重写后模型变成**观察方**：树的每个「分支」（某个分区的根列表，或某个节点的子项）的每一页，对应 pathql 核心上的一个 `all` key。
数据源不再读数据，只**描述**这一页要查什么（`PathqlQuery[]`）、结果怎么解析成元素、这一页对哪些事件敏感。模型维护一个
**观察集合**——当前可见分支的已加载页——用 `computed` 从句柄状态（展开、已加载页数）和宿主的响应式参数（前缀、搜索词、范围）
现算出全部 key，交给 `usePathqlLookMany` 观察。于是：

- **展开 / 加载更多 / 改搜索词 / 切 hide 前缀**都只是观察集合变化。模型对新进入集合的 key 发 `pathqlRequest$`（这些都是用户操作），
  离开集合的 key 自动退订、迟到结果被丢弃。不再有 `reload()` / `refreshChildren()` / `loadTokens`。
- **事件刷新**完全交给核心：每页带自己的 `refreshOn`，同一页被多个树实例（侧栏 + 选择器弹窗）观察时共用一个窗口、一次请求。
  宿主不再订阅任何事件，`affectsAlbumDir` 这类相关性下沉为数据源的 `refreshOn(branch)`。
- **数据落地**：模型按「(分支, 页)」而不是按 key 存页数据，所以搜索词变化导致 key 改变时，旧数据一直显示到新 key 的结果到达，
  不闪空；合并各页（按 key 去重）后走现有的 key diff（`applyChildren`），句柄、展开态、`expandedMemory` 语义不变。
- **晚到的字段**（画册图片计数）作为页的补充查询 `extra`：独立 key、独立 `refreshOn`，结果是 `key → 字段补丁`，
  只打到句柄上，不挡行渲染；结构查询刷新后沿用最近一次补丁，计数不闪空。成员变化只重读补充查询，不重读行。

关键决策：

- **只观察可见分支**（自身展开且所有祖先展开）。收起的已加载分支保留句柄与数据但停止观察，再展开时重新请求。
  旧实现会在 `reload` 时把收起分支也重枚举一遍；按可见收窄后，刷新成本只与屏幕上的内容有关。
- **一页一个 key**，而不是一个分支一个 key。分支一个 key（把全部页放进同一批）能拿到同一快照，但每次加载更多都要重读前面所有页，
  画册标签根页的图片计数是秒级 GROUP BY，代价不可接受。一页一个 key 时，同一事件会让各页在同一窗口首票同时请求，
  快照几乎一致；跨页的短暂重复由按 key 去重吸收。
- **对宿主仍是 Promise**：`expand` / `loadMore` 返回的 promise 在该页数据（或错误）落地时 resolve。这由模型自己观察实现，
  不需要核心提供「请求并等待」，核心「请求不交还结果」的约定不变。画册树「按选中项祖先链逐级展开」的逻辑因此不用改写。
- **宿主不活跃即停观察**：新增 `active()`，为 false 时观察集合为空（保留句柄与数据），恢复时整组重新请求。
  这就是侧栏「隐藏期记脏、显示补刷」，代价是每次显示都读一次，不再区分期间有没有变更。

### 现状锚点

**a. 数据源是 Promise 形态**（`components/tree/types.ts`）
```ts
export interface TreeDataSource<T> {
  getKey(element: T): string;
  hasChildren(element: T): boolean;
  getChildren(element: T): T[] | Promise<T[]>;           // 现状：模型直接调用读取
  getChildrenPage?(element: T, page: number): Promise<T[]>;
  totalChildren?(element: T): number;
  getRootsPage?(sectionId: string, page: number): Promise<T[]>;
  pageSize?: number;
}
```

**b. 子项读取靠 token 挡竞态，根列表没有**（`components/tree/useTreeModel.ts`）
```ts
async function loadChildren(handle: TreeNodeHandle<T>): Promise<void> {
  const token = (loadTokens.get(handle.key) ?? 0) + 1;    // 现状：每节点 token
  loadTokens.set(handle.key, token);
  // ……await getChildrenPage / getChildren
  if (loadTokens.get(handle.key) !== token || !handles.has(handle.key)) return;
  applyChildren(handle, elements);
}

async function reloadSection(state: SectionState<T>): Promise<void> {
  // 现状：没有 token，两次 reload 重叠时旧根列表可能后到并覆盖新的
  const chunks = await Promise.all(/* 已加载的每一页 getRootsPage */);
  // ……key diff 写入 state.roots
}
```

**c. 画册树宿主自己订阅 hub 并决定刷新哪些目录**（`components/albums/AlbumTreeView.vue`）
```ts
const unsubscribe = subscribeChanges({
  waitMs: GRID_REFRESH_WAIT_MS,
  onBatch: async (batch) => {
    if (affectsAlbumDir(batch, null)) await model.reloadRoots();       // 现状：根区任一画册变化即重读
    await Promise.all(
      model.loadedHandles()                                             // 现状：含收起的已加载分支
        .filter((handle) => affectsAlbumDir(batch, handle.element.ancestorPath))
        .map((handle) => model.refreshChildren(handle.key)),
    );
  },
});
```

**d. 晚到的图片计数手工打到句柄上**（`components/albums/AlbumTreeView.vue`、`services/albums.ts`）
```ts
function withLateCounts(page: AlbumPage): AlbumNode[] {
  for (const node of page.nodes) {
    if (node.count === null) node.count = model.nodeByKey(node.id)?.element.count ?? null; // 现状：沿用旧计数防闪空
  }
  void page.imageCounts.then((counts) => { /* 句柄还是这一轮的行才覆盖 element */ });
  return page.nodes;
}
// fetchPageWithCounts：rows 与 ~~/children 一起等，~~/images 单独交付（三次 pathql_fetch，三个快照）
```

**e. 侧栏宿主自己订阅 hub、记脏、整树 reload**（`components/galleryFilterTree/GalleryFacetTreeInner.vue`）
```ts
const unsubscribeChanges = isDeltaMode
  ? () => {}
  : subscribeChanges({
      waitMs: GRID_REFRESH_WAIT_MS,
      filter: sidebarBatchRelevant,
      onBatch: async () => {
        if (!props.ctx.visible.value) { sidebarDirty = true; return; } // 现状：隐藏期记脏
        await refreshSidebar();                                       // 现状：model.reload() 重列根与已加载分支
      },
    });
```

**f. diff 模式的纯净列举缓存与它的失效订阅**（`components/galleryFilterTree/context.ts`）
```ts
const pureListCache = new Map<string, Promise<ProviderChildDir[]>>(); // 现状：跨弹窗开合复用候选全集
function ensurePureListCacheInvalidation() {
  subscribeChanges({ waitMs: GRID_REFRESH_WAIT_MS, filter: /* … */, onBatch: invalidatePureProviderListCache });
}
```

### 点 1 — 数据源改为查询描述（`components/tree/types.ts`）
- **新增**
  - `TreeBranch<T>`、`TreePage<T>`、`TreeQuerySource<T>`。
- **删除**
  - `TreeDataSource<T>`、`TreeSection.roots`。
```ts
/** 树的一个分支：分区的根列表，或某节点的子项。 */
export type TreeBranch<T> = { kind: "section"; sectionId: string } | { kind: "children"; parent: T };

/** 分支的一页：结构查询决定有哪些元素；可选的补充查询给晚到的字段，按元素 key 打补丁、不挡行渲染。 */
export interface TreePage<T> {
  queries: readonly PathqlQuery[];
  parse(results: readonly unknown[]): T[];
  extra?: {
    queries: readonly PathqlQuery[];
    parse(results: readonly unknown[]): Map<string, Partial<T>>;
  };
}

export interface TreeQuerySource<T> {
  getKey(element: T): string;
  hasChildren(element: T): boolean;
  /**
   * 分支第 page 页（1 起）；null 表示没有这一页。可读宿主的响应式参数（前缀、搜索词、范围），
   * 参数变化即 key 变化，模型据此重新请求。查询只能依赖父元素的稳定字段（如 id、ancestorPath）。
   */
  page(branch: TreeBranch<T>, page: number): TreePage<T> | null;
  /** 这一页结构查询 / 补充查询各自的事件过滤器。 */
  refreshOn(branch: TreeBranch<T>, part: "page" | "extra"): readonly EventTrigger[];
  /** 不提供则不分页：只有第 1 页，没有「加载更多」。 */
  pageSize?: number;
  totalChildren?(element: T): number;
}
```

### 点 2 — 模型改为观察方（`components/tree/useTreeModel.ts`）
- **新增**
  - `active?: () => boolean` 选项；为 false 时观察集合为空，句柄与数据保留。
  - 观察集合 `observed = computed(() => Map<key, { branchId, page, part }>)`：遍历分区根与可见展开节点，
    对已加载页数（至少 1）调用 `source.page()`，以 `pathqlAllKey(queries)` 为 key。
  - 用 `usePathqlLookMany({ kind: "all", keys, refreshOn })` 观察；`watch(observed)` 对新进入的 key 发 `pathqlRequest$.next(["all", key])`。
  - `pageData: Map<branchId, T[][]>` 与 `extraPatches: Map<branchId, Map<elementKey, Partial<T>>>`：按（分支, 页）存，
    结果到达后合并各页（按 key 去重）、叠加补丁、走 `applyChildren` / 根列表 diff，再 `rebuild()`。
  - 等待表 `waiters: Map<pageId, resolve[]>`：`expand` / `loadMore` 的 promise 在该页首个结果或错误到达时 resolve。
  - `refresh(): Promise<void>`：重新请求当前观察集合的全部 key（手动刷新、插件签名变化等用户操作），
    在这些页的结果或错误全部落地时 resolve（同样走等待表）。画册页刷新按钮靠它控制转圈：
    `Albums.vue` 的 `handleRefresh` → `AlbumTreePanel.reload` → `AlbumTreeView` 暴露的 `reload` 改接 `model.refresh()`。
- **修改**
  - `expand` 只改 `expanded` / `expandedMemory` 并等待第 1 页；`loadMore` 只把 `loadedPages` 加一并等待新页。
  - `handle.loading` / 分区 `loading` 由各页的 `lookMany.loading(key)` 推出；出错时保留上一份子项（旧实现是清空）。
  - `hasMore`：有 `totalChildren` 时按合并后的数量比，否则按最后一页是否满页。
- **删除**
  - `loadTokens`、`loadChildren`、`reloadSection`、`refreshLoadedBranches`、`refreshChildren`、`refreshLoadedChildren`、
    `reloadRoots`、`reload`、`loadedHandles`、`onChildrenLoaded`、构造时的 `void reload()`。
```ts
const observed = computed(() => {
  const out = new Map<string, PageRef>();
  const add = (branchId: string, branch: TreeBranch<T>, pages: number) => {
    for (let page = 1; page <= Math.max(1, pages); page++) {
      const spec = source.page(branch, page);
      if (!spec) break;
      out.set(pathqlAllKey(spec.queries), { branchId, branch, page, part: "page", spec });
      if (spec.extra) out.set(pathqlAllKey(spec.extra.queries), { branchId, branch, page, part: "extra", spec });
    }
  };
  if (!(options.active?.() ?? true)) return out; // 新增：不活跃即停观察
  for (const state of sectionStates) {
    add(`section:${state.id}`, { kind: "section", sectionId: state.id }, state.loadedPages);
    walkVisible(state.roots, (handle) => add(handle.key, { kind: "children", parent: handle.element }, handle.loadedPages));
  }
  return out;
});

const look = usePathqlLookMany({
  kind: "all",
  keys: () => [...observed.value.keys()],
  refreshOn: (key) => {
    const ref = observed.value.get(key)!;
    return source.refreshOn(ref.branch, ref.part);
  },
  onResult: (key, snapshot) => applyPage(observed.value.get(key), snapshot.results), // 只认（分支, 页），旧 key 已退订
  onError: (key, error) => settleWaiters(observed.value.get(key), error),
});

// 新进入观察集合的 key 是用户操作带来的（首次、展开、加载更多、参数变化、重新激活），直接请求
watch(observed, (next, prev) => {
  for (const key of next.keys()) if (!prev?.has(key)) pathqlRequest$.next(["all", key]);
}, { immediate: true });
```
> 说明：`refreshOn` 在 key 注册时求值，过滤器内部读响应式状态即可；分支父元素被新快照替换但 id 不变时，查询不变、key 不变，不会重读。

### 点 3 — KbTreePanel 与模型接口（`components/tree/KbTreePanel.vue`）
- **修改**
  - 面板只用到 `rows` / `nodeByKey` / `expand` / `toggle` / `loadMore`，签名不变，面板无需改动；`TreeModel` 接口删去上面列出的方法，新增 `refresh()`。

### 点 4 — 画廊侧栏过滤树（`components/galleryFilterTree/`）
- **修改**
  - `facetTreeSource.ts` 改为 `TreeQuerySource<FacetNode>`：每个分支都是一条 `list` 查询（侧栏 `<路径>/_kb_co`，diff 模式纯净列举），
    `parse` 复用现有的过滤与 `groupedCount` / `extensionCount` 映射。
  - `refreshOn`：侧栏为 `on("images-change", 带 reason)`，加上画册敏感上下文下的 `album-images-change` / `album-changed`（结构字段）；
    diff 模式返回 `[]`（已打开的高级面板不随数据刷新，与现状一致）。
  - `GalleryFacetTreeInner.vue`：`active: () => ctx.visible.value`；插件签名变化 → `model.refresh()`；整树刷新入口 → `model.refresh()`。
- **删除**
  - `GalleryFacetTreeInner` 的 `subscribeChanges`、`sidebarDirty` / `pluginDirty`、`refreshSidebar` / `refreshPluginRoots`。
  - `context.ts` 的 `pureListCache`、`listProviderDirsPure`、`ensurePureListCacheInvalidation`、`invalidatePureProviderListCache`：
    高级面板常驻不重建，观察方在就保有数据，开合面板不改 key 就不重读，缓存不再需要（原计划 Phase E 的一项随之完成）。
```ts
refreshOn: (branch, part) =>
  deltaMode.value
    ? []
    : [
        on("images-change", (p) => !!p.reason),
        on("album-images-change", () => hasAlbumSensitiveContext()),
        on("album-changed", (p) => hasAlbumSensitiveContext() && albumChangeKinds(p).structure),
      ],
```

### 点 5 — 画册树（`components/albums/AlbumTreeView.vue`、`services/albums.ts`）
- **新增**
  - `services/albums.ts`：`albumPageQueries(target, page, prefix, kinds, pageSize, search)` 返回
    `{ queries: [fetch base, fetch base/~~/children…], extra: [fetch base/~~/images[/hide]] }` 与对应 `parse`；
    `fetchPageWithCounts` 只剩给非树调用方（若无则删除）。
  - `kbEvents/events.ts`：`KbEventMap` 增加 `album-added` / `album-deleted`；`albumEventPaths(name, payload): string[] | "wildcard"`
    （`ancestorPath` / `oldAncestorPath`，缺失即通配），取代 `dataChangeHub.affectsAlbumDir` 的批次版本。
  - 系统分区一页：`[fetch albums://id_<收藏>, fetch albums://id_<隐藏>]`，`extra` 为两条 `count`（隐藏画册不带 hide 前缀）；搜索仍在 `parse` 里按显示名过滤。
- **修改**
  - 数据源 `refreshOn`：
    - 分区根的结构页：任一画册结构事件（`album-added` / `album-deleted` / `album-changed` 结构或行字段）；
    - 某父画册 P 的结构页：结构事件的路径严格位于 P 的 `ancestorPath` 之下（孙辈增删也会改变子项的 `child_count`）；
    - 补充查询（图片计数）：`album-images-change` 的路径位于该分支之下（根分区为任意成员变化）。
    > 说明：下载进画册只重读计数，不重读行；旧实现两者一起重读。
  - `ensureSelectedExpanded` / `ensureAlbumExpanded` 不变（`expand` / `loadMore` 仍是 Promise）；`reloadAndExpand` 改为只调 `ensureSelectedExpanded`：
    前缀、范围、搜索词变化已经通过 key 变化触发重读。
- **删除**
  - `AlbumTreeView` 的 `subscribeChanges` 订阅、`withLateCounts`、`systemRows` 的手工计数 Promise。
- **后端修改**（`kabegame-core/src/storage/albums.rs`）
  - 改名、改 key 的 `album-changed` 补上 `ancestorPath`；否则会被当作通配，刷新所有可见目录。迁走 `publishLocal` 后这是唯一的路径来源。

### 点 6 — 测试、文档
- **修改**
  - `useTreeModel.test.ts` 改为 mock `@/services/pathql`（同 `kbEvents.test.ts`）：展开即请求并等待；事件只刷新可见分支；收起后不再刷新、
    再展开重新请求；参数变化换 key 时旧数据保留到新结果、旧 key 迟到结果丢弃；加载更多只请求新页；补充查询的补丁在结构刷新后保留；
    `active` 为 false 时停观察、恢复后整组请求；出错保留上一份子项。
  - `facetTreeSource.test.ts`、`context.test.ts` 随数据源接口与纯净缓存删除调整。
  - `AGENTS.md`「画册数据按需查询」与 `.cursor/rules/view-mutation.mdc` 的 `dataChangeHub` 表述；
    `cocs/gallery/PROVIDER_IMAGEQUERY_COMPOSABLE.md`（侧栏刷新、候选缓存）、`cocs/gallery/GALLERY_PAGINATION_AND_IMAGE_LOAD.md`（画册目录计数）、
    `cocs/gallery/LABEL_ALBUMS.md`（分页查询树）；`versions/latest/{regression,changelog}.md`。

### 验证
- 单测如上；vue-tsc。
- dev 真机 + debug ingest：画册树展开 / 收起 / 加载更多 / 搜索 / 切 hide；下载进某画册只触发其所在可见目录的计数请求；
  拖动移动画册后新旧父目录各刷新一次；侧栏与选择器弹窗同时打开时同一目录只请求一次；侧栏隐藏期间有下载、显示时补读一次；
  高级面板反复开合不重读候选。

### 已知边界
- 收起的分支停止刷新，再展开时先显示旧数据、随即重读。
- 分页之间不是同一快照；同一事件下各页几乎同时请求，跨页重复由去重吸收，短暂缺失接受。
- 侧栏每次重新显示都读一次，不再区分隐藏期间是否有变更。
- 新进入观察集合的 key 一律请求，即使别的实例刚读过同一 key（例如两个选择器先后打开同一目录）。

### 待定事项
1. 是否同意「只观察可见分支」（收起即停刷新）。
2. 分页：一页一个 key（推荐），还是一个分支一个 key（同一快照，但加载更多重读前面所有页）。
3. 补充查询是否用通用的 `extra` 机制，还是只为画册树特化。
4. 出错时保留上一份子项（推荐），还是像现在一样清空。
