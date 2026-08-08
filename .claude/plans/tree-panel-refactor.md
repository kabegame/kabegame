# TreePanel 重构：VSCode 式树基座 + galleryFilterTree 迁移

> **实施状态（2026-08-07）**：批 1 基座 + 批 2 galleryFilterTree 迁移均已实施（用户指示本轮先只做计划 A，故基座与迁移一次落地、画册侧栏消费者留待计划 B）。与原方案的实现差异：①KbTreePanel 改为接收宿主创建的 model（`useTreeModel` 由宿主调用），而非内建 sections/dataSource props；②新增共享内核 `GalleryFacetTreeInner.vue` 承载 model+counts+hub 装配，两个宿主薄壳化（GalleryFilterTree 的 `:key="treeKey"` 挂在 Inner 上）；③hub 注册项增加 `when` 门控以承接旧「计数 enabled=visible / 枚举 enabled=loaded」的差异；④行高统一 32px（含分隔线/小节标题行），sticky/DnD 命中共用整数除法。vue-tsc 0 error；UI 行为等价回归已由用户跑 app 验证通过。
>
> **用户验证期的后续改进（已并入代码，以代码为准）**：⑤sticky 判定从「顶部节点祖先链推导」改为 **CSS sticky 等价的逐行独立判定**（每个「展开且有子」行 natural 位置越过 depth*rowHeight 即贴住，O(n) 扫描；祖先链推导在深层表头进入 sticky 位与 topIndex 进入其子树之间有空窗，会先消失后突现），`useTreeStickyHeaders` 不再依赖 rowIndexByKey；⑥sticky 行背景改由宿主经 `--kb-tree-sticky-bg` / `--kb-tree-sticky-backdrop` 注入面板同款 token（两宿主注入 `--el-kb-filter-dropdown-panel-bg-color`，避免独立白条观感）；⑦sticky 行用 TransitionGroup 加 0.16s 淡入（只做 enter，离开瞬时移除与原生行无缝衔接）。

> 配套关系：本计划是「画册浏览页面布局优化」的前置独立计划（计划 A）。画册树侧栏（计划 B，另文）将作为新基座的第二个消费者。
> 用户已拍板的边界：**尽量保留现有 UI 样式与右侧计数的响应式**；**计数右对齐问题本次不修**（留到以后，避免一次改太多）——重构后计数呈现须与现状逐像素一致（`({{count}})` 紧跟名称之后）。

## 总体设计思路

把「树」从**组件递归**改成**数据投影**。现有 galleryFilterTree 家族的树形完全由 Vue 组件递归表达（`ProviderChildrenNode` 递归 slot，9 个特化组件各自持有枚举逻辑、展开态、计数态、事件订阅），树结构、行渲染、数据获取、刷新机制四件事纠缠在同一层。重构后拆成三层，边界对齐 VSCode `src/vs/base/browser/ui/tree` 的分工：

1. **模型层（`useTreeModel`）**：持有 `TreeNodeHandle` 节点表（展开态、懒加载态、children），对外产出一个**扁平可见行数组** `rows: ShallowRef<TreeRow[]>`——对应 `indexTreeModel` 的可见行投影，但**不抄它的增量 splice 簿记**（`renderNodeCount`/`visibleChildIndex` 是为万级节点准备的）；本仓两个消费者都是百级节点，展开/折叠/懒加载完成后做 **O(n) 全量 rebuild 并整体替换 `shallowRef`**，由 `v-for` 的 keyed patch 吃掉差量。取舍：用 `shallowRef` + 显式 rebuild，不用 `computed` 投影——懒加载与展开是命令式异步流程，`computed` 对深层 reactive 的依赖追踪不可控；`shallowRef` 只在结构变化点替换数组，节点内部可变状态（计数、loading）放在各节点的 `shallowReactive` handle 上，行组件直接读，不触发结构重建。rebuild 单趟顺带回填 `subtreeRowCount`，供 sticky 推走与 DnD 反馈使用。

2. **视图层（`KbTreePanel` + `KbTreeRow`）**：滚动容器 + `v-for` 扁平行。行结构复刻现有 `ProviderChildrenNode` 的 DOM（min-h-8 行高、26px twistie + rotate-90、`pl-[calc(var(--tree-depth)*16px)]` 缩进、hover/active/disabled 配色原样），**行主体是 scoped slot**（对应 VSCode renderer 接口）：galleryFilterTree 的行模板 = 名称 + 内联 `({{count}})`（与现状一致，不做右对齐）；画册树的行模板自己排 icon/名称/计数/装饰。twistie 点击只展开（`@click.stop`），行点击 emit 给消费者。行内容 nowrap 溢出裁剪（类 VSCode）。不做虚拟化，但等高 32px 行 + 扁平数组的架构已为将来虚拟化留好余地。

3. **控制器接口（消费者实现，基座调用）**：
   - `TreeDataSource<T>`（学 `IAsyncDataSource`）：`getKey`/`hasChildren`/`getChildren`（可异步）。展开未加载节点时基座调它并管理 loading/loaded 态；`refreshChildren` 重枚举按 key diff、保留仍存在后代的展开态。
   - `TreeDndController<T>`（学 `ITreeDragAndDrop`）：`canDrag`/`getDragLabel?`/`onDragOver → reaction{accept, position, autoExpand}`/`drop`。**运输层不用 HTML5 DnD**——CEF 在 content 层 veto OS 级拖放会话（`cocs/ui/FILE_DROP_ZONES.md`），页内 drag 事件可靠性存疑；改用 **pointer 事件状态机**（按下→位移阈值→浮影→rect 命中→悬停 500ms 自动展开→落点反馈→提交/取消）。pointer 是普通输入事件，不经过 CEF 的 drag 管线，这正是自研的理由。命中不用 `elementFromPoint`（浮影遮挡），用容器 rect + scrollTop + 等高行直接算 index——与 FILE_DROP_ZONES.md 的 rect 命中经验同源。
   - `useTreeRefreshHub`（**刷新事件参数化**，用户点名需求）：树级集中订阅 N 个后端事件（默认 = 现状：`images-change` + `album-images-change` 带 hidden 画册 filter），节点注册进来后按**每注册项独立 trailing-throttle（默认 3000ms）+ 节点级 filter** 分发——节流粒度与现状 per-node `useImagesChangeRefresh` 完全等价，但监听器数量从 O(挂载节点数) 降到 O(事件数/树)。折叠节点的 handle 与计数订阅保活——等价于现状 `childrenMounted` + `v-show` 的「折叠不销毁」行为。

**sticky 表头是最大的忠实复刻难点**：现状靠 DOM 嵌套 + CSS `position: sticky`（top = depth×32，z = 100−depth，被子树容器底边「推走」）。扁平化后兄弟行没有推挤边界，CSS sticky 只能做到「覆盖替换」而非「推走」。方案：抄 `abstractTree.ts` 的 StickyScrollController 轻量版（`useTreeStickyHeaders`）：等高行让全部计算退化为整数除法；把视口顶部行的「展开且有子」祖先链**复制渲染**到容器顶部 overlay（同一 #row slot、同一背景/blur/shadow、可点击），最深一条用 `subtreeRowCount` 算 translateY 推走偏移。降级备选：「兄弟 CSS sticky」近似（替换代替推走），截图对比可接受时批 1 可先用；**推荐直接上 overlay 版**，一次到位。

**与 context.ts 的关系**：纯函数与缓存（`pathForTreeSegment`、`serializeFilterForTree`、`pureListCache` 及 5 事件全局失效、`countProviderPath`、`useProviderTreeList`）**全部保留不动**——它们是 pathql 语义层，与树无关。`provide/inject` 注入链给出等价替代：特化节点组件删除后，inject 的唯一消费者就是家族自身，故把 `GalleryFilterTreeContext` 对象改为**显式参数**传给 `createGalleryFacetSource(ctx)`；`provideGalleryFilterTreeContext`/`useGalleryFilterTreeContext` 保留导出（标注 deprecated）以零风险过渡。`RefreshTarget`/`registerRefreshTarget`/`defineExpose({refresh})` 机制原样保留。

**放置位置：`apps/kabegame/src/components/tree/`**，不进 vendored 组件包。理由：两个消费者都在 apps 内；行样式直接引用 app 主题 token `--anime-*`，进 `@kabegame/element-plus` 按规范要走 `var.scss` 的 `--kb-el-* ← --anime-*` token map，平添一层间接；基座对 app 的依赖面刻意为零（不 import stores / galleryPath），将来上提成本低。避免过早抽象。

**渐进迁移：分两批**。批 1 = 基座（点 1–5）+ 画册树消费（计划 B）；批 2 = galleryFilterTree 迁移（点 6）。理由：galleryFilterTree 挂在画廊主流程（每个维度 chip 的 panel + 高级弹窗 facet），迁移失误直接伤主路径；而基座 API 最不确定的部分（sections、DnD、sticky overlay、名称过滤）恰好全是**新消费者**的需求——先在无回归风险的画册树上把 API 磨定型，再迁旧树，避免边迁边改接口的二次返工。两批独立提交、独立回归。

**抄 / 不抄清单**（VSCode 参考源码获取方式见文末）：

| VSCode 机制 | 决定 | 说明 |
|---|---|---|
| 模型/视图分离 + 扁平行投影（indexTreeModel） | 抄（全量 rebuild 版） | 百级节点不需要增量 splice |
| `IAsyncDataSource` 懒加载语义（asyncDataTree） | 抄 | hasChildren/getChildren/refresh 保展开态 |
| `ITreeDragAndDrop` 控制器边界 + autoExpand 500ms（abstractTree.ts:102-113） | 抄接口，运输层换 pointer | CEF veto OS drag |
| twistie/缩进渲染约定、点击分离 | 抄 | 26px twistie 列 + depth×16px 缩进（现状值） |
| TreeFindController 的 Filter 模式 | 抄语义 | 匹配 + 祖先可见、只作用已加载子树 |
| StickyScrollController 祖先链 + 推走 | 抄轻量版 | 等高行退化为整数除法 |
| 虚拟化 rowCache/rangeMap、增量 splice、无障碍全套、水平滚动条管理、CompressedObjectTree、setDragImage | 不抄 | 规模不需要；aria 维持现状 aria-busy/aria-disabled 水平 |

## 现状锚点

（行号已在当前工作区逐一核对。）

**a. `ProviderChildrenNode.vue` 行模板**（`apps/kabegame/src/components/galleryFilterTree/ProviderChildrenNode.vue:12-54`）——迁移必须逐 class 保留的 DOM：

```html
<div
  class="provider-tree-node__row min-h-8 flex items-center pl-[calc(var(--tree-depth)*16px)] rounded-[6px] text-[var(--anime-text-primary)] hover:bg-[rgba(255,107,157,0.07)]"
  :class="{
    '!bg-[rgba(255,107,157,0.14)] !text-[var(--anime-primary)]': active,
    'opacity-50 hover:bg-transparent': isDisabled,
    '!text-[var(--anime-text-muted)]': isEmpty && !active,
  }" :aria-busy="loading" :aria-disabled="isDisabled">
  <button v-if="hasChildren"
    class="w-[26px] h-[26px] flex-none inline-flex items-center justify-center border-0 bg-transparent text-inherit cursor-pointer transition-transform duration-150 ease-[ease]"
    :class="{ 'rotate-90': isExpanded, '!cursor-not-allowed': isDisabled }" @click.stop="setExpanded(!isExpanded)">
    <el-icon><ArrowRight /></el-icon>
  </button>
  <span v-else class="flex-none w-[26px]" />
  <button class="min-w-0 flex-1 h-[30px] flex items-center gap-1 border-0 bg-transparent text-inherit text-left cursor-pointer" ... @click="onLabelClick">
    <span class="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">{{ name }}</span>
    <span class="flex-none text-[var(--anime-text-secondary)] text-xs" :class="{ delta红绿/empty灰化 }">({{ displayCount }})</span>
  </button>
</div>
```
> 现状：计数 `({{ displayCount }})` 紧跟名称（gap-1 内联）。**本次保持原样，不做右对齐。**

**b. 懒挂载与折叠保活**（同文件 `:110-119`；模板 `:56-62`）：

```ts
const localExpanded = ref(props.defaultExpanded);
const childrenMounted = ref(props.defaultExpanded);   // 现状：首次展开才挂 children
const hasChildren = computed(() => Boolean(slots.default));
const hasStickyHeader = computed(() => hasChildren.value && isExpanded.value);
// 模板：<div v-if="hasChildren && childrenMounted" v-show="isExpanded"><slot /></div>
// 现状：折叠后 DOM 保留（v-show），子孙计数订阅持续存活
```

**c. delta 模式与计数刷新**（同文件 `:120-149, 180-211`）：

```ts
const isDeltaMode = computed(() => !!countBaseline);       // 高级面板 diff 模式
const displayCount = computed(() => { /* "..." / "+N" / "−N" / "0" / String(count) */ });
const isEmpty = computed(() =>
  isDeltaMode.value ? delta.value === 0 : count.value !== null && count.value === 0);
const shouldHide = computed(() => props.emptyState === "hide" && isEmpty.value);
const isDisabled = computed(() => props.emptyState === "disable" && isEmpty.value);
const nodeStyle = computed(() => ({
  "--tree-depth": props.depth,
  "--tree-sticky-top": `${props.depth * 32}px`,
  "--tree-sticky-z-index": String(100 - props.depth),
}));
async function refresh() {   // token 防竞态；countProviderPath = pathqlEntry(...).total
  const token = ++refreshToken; ...
  const next = await countProviderPath(props.path);
  if (token === refreshToken) count.value = next; ...
}
useImagesChangeRefresh({ enabled: visible, waitMs: props.debounce /*3000*/,
  filter: (payload) => (props.filter ? props.filter(payload) : true), onRefresh: refresh });
useAlbumImagesChangeRefresh({ enabled: visible, waitMs: props.debounce,
  filter: isHiddenAlbumChange,          // 现状：album 侧写死只认 HIDDEN_ALBUM_ID
  onRefresh: refresh });
```

**d. sticky 表头 CSS**（同文件 `:255-263`）——依赖 DOM 嵌套（子树容器底边推走）：

```scss
.provider-tree-node--sticky > .provider-tree-node__row {
  position: sticky;
  top: calc(var(--provider-tree-sticky-offset, 0px) + var(--tree-sticky-top, 0px));
  z-index: var(--tree-sticky-z-index);
  background: var(--el-bg-color-overlay, rgba(255, 255, 255, 0.96));
  backdrop-filter: blur(8px);
  box-shadow: 0 1px 0 rgba(255, 107, 157, 0.1);
}
```

**e. context.ts 的注入面与纯净缓存**（`context.ts:39-71, 138-187`）：

```ts
export interface GalleryFilterTreeContext {
  filter / filters / dimension / prefix / visible / autoExpandRoot: ComputedRef<...>;
  pathForSegment: (segment: string) => string;
  listPathForSegment?: (segment: string) => string;
  countBaseline?: ComputedRef<number | null>;   // 提供即 diff 模式
  registerRefreshTarget: (target: RefreshTarget) => () => void;
}
const pureListCache = new Map<string, Promise<ProviderChildDir[]>>();
// images-change / album-images-change / plugin-added / plugin-updated / plugin-deleted 五事件全局 clear
export function useProviderTreeList() { /* deltaMode ? listProviderDirsPure : listProviderDirs */ }
export async function countProviderPath(path: string): Promise<number> { /* pathqlEntry(...).total */ }
```

**f. 两个宿主**：
- `GalleryFilterTree.vue`：模板硬编码 6 个维度节点（Any/Date/MediaType/Size/Aspect/Plugins，`:1-14`）；`refreshTargets` 集合 + `defineExpose({ refresh })`（`:54-65, 96`）；`treeKey = [contextPrefix, dimension, serializeFilterSet(filters)].join("|")` 整树重建（`:76-78`）；`provideGalleryFilterTreeContext({... pathForSegment: pathForTreeSegment(...), registerRefreshTarget })`（`:84-94`）；宽 320px、`--gallery-filter-tree-max-height: min(60vh, 420px)`、`--provider-tree-row-height: 32px`（`:99-122`）。宿主接线在 `GalleryQueryBar.vue`（KbFilterDropdown `#panel`，`:visible` 绑弹层开合）。
- `AdvancedFacetTreePanel.vue`：同一 provide 面，多给 `listPathForSegment: facet.listPathForSegment`、`countBaseline: facet.baselineCount`（`:110-121`，即 diff 模式）；`contextPrefix` 默认 `images://gallery/`（`:62`）；单维度 roots = Any + `v-else-if` 单个维度节点（`:6-26`）；`autoExpandRoot` 恒 true（`:116`）。

**g. 特化节点代表 `DateChildProviderChildrenNode.vue`**（9 个组件同构：懒枚举 + token 防竞态 + prefix 校验）：

```ts
async function refreshChildren() {
  if (!canHaveChildren.value) return;
  const token = ++listToken;
  const expectedPrefix = prefix.value;
  const entries = await listDirs(`${listPath.value}/`);
  if (token !== listToken || expectedPrefix !== prefix.value) return;
  childRows.value = entries.map(...).filter((row) => !pattern || pattern.test(row.seg));
  loaded.value = true;
}
```

**h. VSCode 参考锚点**（获取方式见文末）：`tree/tree.ts:211-215`（`IAsyncDataSource`）、`:234-236`（`ITreeDragAndDrop.onDragOver → ITreeDragOverReaction{accept, bubble, autoExpand, effect}`）；`tree/abstractTree.ts:102-113`（autoExpand 500ms 定时器）、`:1275-1345`（StickyScrollController 推走）；`tree/indexTreeModel.ts:19-23`（增量簿记，不抄）；`list/listView.ts:1306-1465`（行反馈与 drop 清理）；`workbench/contrib/files/browser/views/explorerViewer.ts:1571-1740`（FileDragAndDrop 实战）。

## 分点实施方案

### 点 1 — 基座类型与模型层（批 1，`apps/kabegame/src/components/tree/`）

- **新增** `types.ts`
  > 基座全部公共类型；对 app 零依赖（不 import stores / galleryPath）。

```ts
export interface TreeDataSource<T> {
  getKey(element: T): string;
  hasChildren(element: T): boolean;
  /** 懒加载：展开未加载节点时调用（学 IAsyncDataSource.getChildren） */
  getChildren(element: T): T[] | Promise<T[]>;
}

/** 节点句柄：shallowReactive，视图直接读；结构字段变化由模型层负责触发 rebuild */
export interface TreeNodeHandle<T> {
  readonly key: string;
  readonly element: T;
  readonly depth: number;
  readonly parent: TreeNodeHandle<T> | null;
  readonly sectionId: string;
  hasChildren: boolean;
  children: TreeNodeHandle<T>[] | null;  // null = 未加载
  expanded: boolean;
  loading: boolean;                       // getChildren 进行中（对应现状 aria-busy）
  loaded: boolean;                        // 至少成功枚举过一次
  /** rebuild 时回填：含自身的可见行数，供 sticky 推走与 DnD 反馈 */
  subtreeRowCount: number;
}

export type TreeRow<T> =
  | { kind: "node"; key: string; node: TreeNodeHandle<T> }
  | { kind: "section-header"; key: string; sectionId: string }
  | { kind: "separator"; key: string; sectionId: string };

/** 分区：如画册侧栏 =「收藏/垃圾桶固定项区 + 分隔线 + 画册树区 + 本地文件夹区」 */
export interface TreeSection<T> {
  id: string;
  header?: boolean;          // 渲染 section-header 行（内容由 #section-header slot 出）
  separatorBefore?: boolean;
  roots: () => T[] | Promise<T[]>;
}
```

- **新增** `useTreeModel.ts` —— 展开/折叠/懒加载 + 扁平投影 + 名称过滤。

```ts
export function useTreeModel<T>(options: {
  dataSource: TreeDataSource<T>;
  sections: () => TreeSection<T>[];
  /** 对应现状 defaultExpanded / autoExpandRoot（学 asyncDataTree collapseByDefault 反相） */
  defaultExpanded?: (element: T, depth: number) => boolean;
  /** 名称过滤（TreeFindController Filter 模式）：匹配 + 祖先可见；只作用已加载子树 */
  filterText?: Ref<string>;
  getFilterLabel?: (element: T) => string;
}): {
  rows: ShallowRef<TreeRow<T>[]>;
  nodeByKey(key: string): TreeNodeHandle<T> | undefined;
  expand(key: string): Promise<void>;   // 未加载则先 getChildren（token 防竞态，同现状 listToken）
  collapse(key: string): void;
  toggle(key: string): Promise<void>;
  /** 重新枚举某节点子项：按 key diff，保留仍存在后代的展开态与 handle（计数态不丢） */
  refreshChildren(key: string): Promise<void>;
  reload(): Promise<void>;              // 整树重建（现状 treeKey 重建的模型层等价物）
}
```
  > 承重细节：`expand` 时 `getChildren` 完成前 `loading=true`；折叠**不**销毁 handle（订阅保活，等价现状 v-show）；过滤变化只 rebuild 不动 handle。

### 点 2 — 视图层（批 1）

- **新增** `KbTreeRow.vue`
  > 行容器 + twistie，class 与现状锚点 a **逐字相同**；新增仅 `whitespace-nowrap overflow-hidden`（行 nowrap，类 VSCode）与 `group`（供消费者 hover 装饰）。

```html
<div
  class="kb-tree-row group min-h-8 flex items-center pl-[calc(var(--tree-depth)*16px)] rounded-[6px] text-[var(--anime-text-primary)] hover:bg-[rgba(255,107,157,0.07)] whitespace-nowrap overflow-hidden"
  :class="{
    '!bg-[rgba(255,107,157,0.14)] !text-[var(--anime-primary)]': active,
    'opacity-50 hover:bg-transparent': disabled,
    '!text-[var(--anime-text-muted)]': muted && !active,
  }"
  :style="{ '--tree-depth': depth }" :aria-busy="busy" :aria-disabled="disabled"
  @click="$emit('row-click')">
  <button v-if="expandable" type="button" :disabled="disabled"
    class="w-[26px] h-[26px] flex-none inline-flex items-center justify-center border-0 bg-transparent text-inherit cursor-pointer transition-transform duration-150 ease-[ease]"
    :class="{ 'rotate-90': expanded, '!cursor-not-allowed': disabled }"
    @click.stop="$emit('toggle')">
    <el-icon><ArrowRight /></el-icon>
  </button>
  <span v-else class="flex-none w-[26px]" />
  <slot />   <!-- 行主体：消费者全权（名称/图标/计数/装饰） -->
</div>
```

- **新增** `KbTreePanel.vue`（`<script setup lang="ts" generic="T">`）

```ts
const props = withDefaults(defineProps<{
  sections: TreeSection<T>[];
  dataSource: TreeDataSource<T>;
  dnd?: TreeDndController<T> | null;
  filterText?: string;
  getFilterLabel?: (el: T) => string;
  defaultExpanded?: (el: T, depth: number) => boolean;
  rowHeight?: number;        // 默认 32：sticky / DnD 命中共用的等高行常量
  stickyHeaders?: boolean;   // 默认 true
  rowState?: (el: T) => { active?: boolean; disabled?: boolean; muted?: boolean; hidden?: boolean };
}>(), { rowHeight: 32, stickyHeaders: true });
const emit = defineEmits<{ "row-click": [element: T]; "update:expanded": [element: T, expanded: boolean] }>();
// slots: #row="{ node, element }"  #section-header="{ sectionId }"
defineExpose({ expand, collapse, refreshChildren, reload, nodeByKey });
```
  > 模板 = 滚动容器（`overflow-y-auto overflow-x-hidden`，继承宿主 `--provider-tree-sticky-offset` 约定）+ `v-for rows` 渲染三类行 + sticky overlay（点 3）+ DnD 反馈层（点 5）。`rowState().hidden` 承接现状 `emptyState="hide"` 语义（投影时剔除）。

### 点 3 — sticky 表头 overlay 控制器（批 1）

- **新增** `useTreeStickyHeaders.ts` —— 轻量同构 abstractTree 的 StickyScrollController。

```ts
export function useTreeStickyHeaders<T>(options: {
  scroller: Ref<HTMLElement | null>;
  rows: ShallowRef<TreeRow<T>[]>;
  rowHeight: number;   // 32
}): ComputedRef<Array<{ node: TreeNodeHandle<T>; top: number; pushOffset: number }>> {
  // scroll(passive) + rAF 合帧：
  // 1. topIndex = floor(scrollTop / rowHeight)；取 rows[topIndex..] 第一个 node 行
  // 2. sticky 链 = 该节点祖先链中「expanded && hasChildren」者（含自身若展开）
  //    —— 对齐现状 hasStickyHeader = hasChildren && isExpanded
  // 3. 每条 top = depth * rowHeight（现状 --tree-sticky-top = depth*32）
  // 4. 推走：节点扁平区间末行 = rowIndex(node) + node.subtreeRowCount；
  //    若 (末行*rowHeight − scrollTop) < (depth+1)*rowHeight，pushOffset = 差值（translateY 上移）
}
```
  > overlay 行复用 `KbTreeRow` + 同一 `#row` slot，容器加现状 sticky 样式（锚点 d：`--el-bg-color-overlay` 背景 + blur(8px) + 粉线 shadow，z = 100−depth），绑定与真行相同的 click/toggle——现状 sticky 行本就是可交互真行。
  > 降级备选：「兄弟 CSS sticky」近似（每个 node 行 `position:sticky; top:depth*32`），推走退化为覆盖替换；批 1 截图对比可接受可先用，批 2 前必须敲定。**推荐直接 overlay 版**。

### 点 4 — 刷新事件参数化（批 1）

- **新增** `useTreeRefreshHub.ts` —— 树级集中订阅 + per-node 节流分发。基座不认识任何具体事件/画册 ID。

```ts
export interface TreeRefreshSource {
  event: string;                        // "images-change" | "album-images-change" | "plugin-added" | ...
  filter?: (payload: any) => boolean;   // source 级过滤（如 album 侧只认 hidden 画册）
}
export function useTreeRefreshHub(options: {
  enabled: Ref<boolean>;                // 对应现状 enabled: visible
  sources: TreeRefreshSource[];         // ← 参数化点：监听哪些事件由消费者决定
}): {
  register(entry: {
    waitMs?: number;                    // 默认 3000（现状 debounce）
    filter?: (event: string, payload: any) => boolean;   // 节点级过滤（如 plugin 节点按 pluginIds）
    onRefresh: () => void | Promise<void>;
  }): () => void;
}
```
  > 实现：每个 source 一个 `listen()`（`@/api/rpc`），enabled 翻转时 start/stop（复刻 `useImagesChangeRefresh.ts:50-76`）；分发时每个注册项走**自己独立的** `useTrailingThrottleFn`（`useTrailingThrottle.ts` 原样复用）——节流粒度与现状 per-node 完全等价。

- **新增** `galleryFilterTree/refreshSources.ts`（批 2 用，批 1 可先落）
  > 默认值 = 现状：双事件，album 侧带 hidden filter。`HIDDEN_ALBUM_ID` 依赖留在 app 层，不进基座。

```ts
export function defaultGalleryTreeRefreshSources(): TreeRefreshSource[] {
  return [
    { event: "images-change" },
    { event: "album-images-change",
      filter: (p: AlbumImagesChangePayload) => (p.albumIds ?? []).includes(HIDDEN_ALBUM_ID) },
  ];
}
```
  > 画册树侧栏传自己的 sources（由计划 B 定）。

### 点 5 — pointer DnD 控制器（批 1）

- **新增** `useTreeDnd.ts` —— 接口学 `ITreeDragAndDrop`，运输层为 pointer 状态机。

```ts
export type TreeDropPosition = "before" | "inside" | "after";
export interface TreeDragOverReaction {
  accept: boolean;
  position?: TreeDropPosition;   // 反馈落点；inside=整行高亮，before/after=插入线
  autoExpand?: boolean;          // 悬停同一节点 500ms 自动展开（学 abstractTree.ts:102-113）
}
export interface TreeDndController<T> {
  canDrag(element: T): boolean;
  getDragLabel?(element: T): string;                  // 浮影文本；缺省用行名
  onDragOver(source: T, target: T | null, sector: TreeDropPosition): boolean | TreeDragOverReaction;
  drop(source: T, target: T | null, position: TreeDropPosition): void | Promise<void>;
}
```

  状态机（KbTreePanel 内部装配，`dnd` prop 为空则完全不绑事件）：
  1. `pointerdown`（主键、命中 node 行、非 twistie）：记录候选 key 与起点，不 preventDefault（保点击）。
  2. `pointermove` 位移 > 5px 且 `canDrag` → 进入拖拽：`setPointerCapture`、`document.body` 加 `user-select:none`，创建浮影（`position:fixed` 跟随指针的 chip，内容 `getDragLabel`）。
  3. 命中：**不用 `elementFromPoint`**（浮影遮挡），`index = floor((clientY − scrollerRect.top + scrollTop) / rowHeight)`；`section-header`/`separator` 行与容器空白 → `target = null` 交消费者裁决；扇区三分：行内 y 比例 <25% `before` / >75% `after` / 其余 `inside`（VSCode 四分 sector 的简化）。
  4. `onDragOver` → reaction：`inside` 给目标行加 drop 高亮类；`before/after` 画 2px 插入线（绝对定位横线，x 起点带缩进）；同一节点 `autoExpand` 悬停 500ms 定时器 → `model.expand`（换目标即清定时器）。
  5. 边缘自动滚动：指针距容器上下缘 <24px 时 rAF 按距离比例滚动。
  6. `pointerup` 合法 → `controller.drop`；`Escape` / `pointercancel` / 指针出窗 → 取消。全路径清理：浮影、feedback、user-select、capture、定时器。
  7. touch（`pointerType === "touch"`）：默认**不启用**（与滚动冲突）；预留 `longPressMs` 选项（350ms 长按启动），Android 需要时再开。

### 点 6 — galleryFilterTree 迁移（批 2，行为等价）

- **新增** `galleryFilterTree/facetTreeSource.ts`
  > 把 9 个特化组件的枚举与描述逻辑收敛为一个 dataSource + descriptor。`GalleryFilterTreeContext` **显式传参**，不再 inject。

```ts
export type FacetNode =
  | { kind: "any" }
  | { kind: "dim-date" }    | { kind: "date"; segments: string[] }
  | { kind: "dim-media" }   | { kind: "media-kind"; mediaKind: "image" | "video" }
  |                           { kind: "media-format"; mediaKind: "image" | "video"; format: string }
  | { kind: "dim-size" }    | { kind: "size"; range: string }
  | { kind: "dim-aspect" }  | { kind: "aspect"; range: string }
  | { kind: "dim-plugins" } | { kind: "plugin"; pluginId: string }
  | { kind: "plugin-extend"; pluginId: string; extendPath: string; isLeaf: boolean; isPlain: boolean };

export function createGalleryFacetSource(ctx: GalleryFilterTreeContext, deps: {...}): {
  dataSource: TreeDataSource<FacetNode>;
  roots: (dims: GalleryBrowseDimension[]) => FacetNode[];
  descriptor: (n: FacetNode) => {
    name: string;              // labelForSegments / pluginLabel / BUCKETS labelKey 原样搬
    path: string;              // ctx.pathForSegment(serialize(n)) —— 计数路径
    selectable: boolean;       // 维度根 false、plain extend false，其余 true
    defaultExpanded: boolean;  // 各组件 defaultExpanded computed 原样搬（active 祖先链展开）
    active: boolean;
    filterOnSelect: GalleryFilter;                       // emit("update:filter") 载荷
    imagesFilter?: (p: ImagesChangePayload) => boolean;  // plugin 系的 unknownOrMatchingPlugin
    extraSources?: TreeRefreshSource[];                  // dim-plugins 的 plugin-added/updated/deleted
  };
}
```
  > `getChildren` 迁移对照（逐个搬；token 防竞态改由模型层承担、prefix 校验保留在 source 内）：`dim-date` ← DateProviderChildrenNode（`^(\d{4})y$` 过滤）；`date` ← DateChildProviderChildrenNode（月/日 pattern，`segments.length < 3` 才有子）；`dim-media` → 静态两项；`media-kind` ← MediaTypeProviderChildrenNode；`dim-size`/`dim-aspect` → 静态 BUCKETS；`dim-plugins` ← PluginsProviderChildrenNode（deltaMode 不按 count>0 过滤的分支原样）；`plugin` ← PluginProviderChildrenNode；`plugin-extend` ← PluginExtendProviderChildrenNode（isLeaf 无子）。全部走 `useProviderTreeList()` 等价出口（`listDirs`/`listProviderDirsPure` 缓存不动）。

- **新增** `galleryFilterTree/useFacetNodeCounts.ts`
  > 计数态从行组件搬到适配层 Map（折叠保活）：per-node `{ count, loading }` shallowReactive；`visible` 翻真 / `path` 变化时 `countProviderPath` 刷新（token 防竞态，锚点 c 的 refresh 原样）；`hub.register({ waitMs: 3000, filter: 节点 imagesFilter })`；`ctx.registerRefreshTarget` 注册（整树 refresh() 机制不变）；delta 展示（displayCount/deltaSign/isEmpty）从锚点 c 原样搬入。

- **修改** `GalleryFilterTree.vue`
  > 对外 props/emits/`defineExpose({refresh})` **一字不变**（GalleryQueryBar 零改动）；内部换 KbTreePanel；`:key="treeKey"` 保留在 KbTreePanel 上——整树重建语义等价，计数 Map 随实例重建。`#row` 模板 = 锚点 a 的名称 + 内联 `({{count}})` 按钮，逐 class 相同（**不做右对齐**）。

- **修改** `AdvancedFacetTreePanel.vue`
  > 同样换 KbTreePanel；ctx 里 `countBaseline`/`listPathForSegment` 照传（delta 全在 useFacetNodeCounts 与 source 的 deltaMode 分支）；单维度 roots = `[any, dim-<dimension>]`；`autoExpandRoot: true` → `defaultExpanded` 对 depth 0 恒真（现状 syncAutoExpand 语义）。

- **修改** `galleryFilterTree/context.ts`
  > 只动注入层：`provideGalleryFilterTreeContext`/`useGalleryFilterTreeContext` 标 `@deprecated`（替代 = ctx 显式传参给 createGalleryFacetSource），其余一行不改。

- **删除**（批 2 收尾，确认无引用后）：`ProviderChildrenNode.vue`、`AnyProviderChildrenNode.vue`、`DateProviderChildrenNode.vue`、`DateChildProviderChildrenNode.vue`、`MediaTypeProviderChildrenNode.vue`、`SizeProviderChildrenNode.vue`、`AspectProviderChildrenNode.vue`、`PluginsProviderChildrenNode.vue`、`PluginProviderChildrenNode.vue`、`PluginExtendProviderChildrenNode.vue`（共 10 个）。
  > `emptyState="hide"/"disable"` 与 `initialCount` 已确认全仓无外部使用者（现状全走默认 "show"），能力由 `rowState().hidden/disabled` 与计数 Map 初值承接。

### 点 7 — 不变面（明确不动）

`GalleryQueryBar.vue`（#panel 接线、refreshProviderFilterTree）、`GalleryAdvancedQueryConditionRow.vue`、`useImagesChangeRefresh.ts`/`useAlbumImagesChangeRefresh.ts`（其他页面仍在用）、`useTrailingThrottle.ts`、`services/pathql`、后端全部。

## 风险与验证

**主要风险**：R1 sticky overlay 与 CSS 嵌套 sticky 的视觉差（推走动画）——截图逐帧对比把关，保留 CSS 近似降级；R2 折叠保活语义（计数态/订阅必须在模型与 Map 层，不在行组件）——回归清单专项；R3 pointer DnD 在 CEF 输入管线的实际表现（capture、双屏缩放）——运行时验证；R4 galleryFilterTree 在画廊主流程——分批隔离。

**批 2 行为等价回归清单**（kabegame-chromium 连真实 app 逐项过）：
1. 5 个维度 chip 面板逐一打开：树渲染、「任意」行计数（减本维度语义）、根节点计数。
2. 展开/折叠：twistie 动画、懒枚举只在首次展开、再次展开不重复请求且立即显示旧计数（折叠保活）。
3. 选中：行点击应用过滤并关面板；active 高亮（粉底+主色）；active 祖先链自动展开。
4. 维度根 selectable=false：行点击 = 展开而非选中。
5. **计数位置与现状逐像素一致（本次不做右对齐）**：`({{count}})` 紧跟名称、gap-1、名称 ellipsis。
6. 计数 0 整行灰化但可选；"..." 加载占位。
7. sticky 表头：多级堆叠（top=depth×32）、被子树末尾推走、背景 blur + 底部粉线，与迁移前截图逐帧对比。
8. 事件刷新：导入图片（images-change）、移入/移出隐藏画册（album-images-change + hidden filter）、装卸插件（plugin-* 三事件 + pureListCache 失效）→ 3000ms 节流窗口内更新；plugin 节点只对相关 pluginIds 刷新。
9. treeKey 重建：切换过滤/维度/前缀后整树重置重查。
10. `GalleryFilterTree.refresh()`（refreshProviderFilterTree 入口）仍集中刷新全部已加载节点。
11. 高级弹窗 facet：delta 模式 +N/−N/0、红绿色、0 灰化、候选全集不过滤 count>0、纯净列表缓存复用（反复开合不重复请求）。
12. `visible=false` 不请求、订阅停；打开面板才拉数。

**pointer DnD 的 CEF 运行时验证**（基座落地即做，不等消费者）：用户先跑 `deno task dev -c kabegame`，`kabegame-chromium` skill 连 CDP：`Input.dispatchMouseEvent` 序列 mousePressed（行中心）→ 连续 mouseMoved 超阈值（截图：浮影出现）→ 悬停折叠节点 600ms（截图：自动展开）→ 移到目标行 inside/行缘（截图：高亮/插入线）→ mouseReleased（断言 drop 被调）→ 重复一遍以 Escape 取消（断言无副作用）；拖到容器底缘验证自动滚动；最后真实鼠标手测一轮（CDP 合成事件不完全等价 CEF 原生输入管线）。理论依据写入代码注释：CEF veto 只针对 OS 级 drag session（FILE_DROP_ZONES.md），pointer 属普通输入事件。

**编译验证**：每批完成后跑 `check-kabegame` skill（`--skip cargo`，纯前端改动）。

## 文件清单

**新增（批 1，基座）**
- `apps/kabegame/src/components/tree/types.ts`
- `apps/kabegame/src/components/tree/useTreeModel.ts`
- `apps/kabegame/src/components/tree/useTreeRefreshHub.ts`
- `apps/kabegame/src/components/tree/useTreeStickyHeaders.ts`
- `apps/kabegame/src/components/tree/useTreeDnd.ts`
- `apps/kabegame/src/components/tree/KbTreePanel.vue`
- `apps/kabegame/src/components/tree/KbTreeRow.vue`

**新增（批 2，迁移）**
- `apps/kabegame/src/components/galleryFilterTree/facetTreeSource.ts`
- `apps/kabegame/src/components/galleryFilterTree/useFacetNodeCounts.ts`
- `apps/kabegame/src/components/galleryFilterTree/refreshSources.ts`（批 1 可先落）

**修改（批 2）**
- `apps/kabegame/src/components/galleryFilterTree/GalleryFilterTree.vue`（内部换基座，对外 API 不变）
- `apps/kabegame/src/components/gallery/AdvancedFacetTreePanel.vue`（同上）
- `apps/kabegame/src/components/galleryFilterTree/context.ts`（仅注入函数标 deprecated）

**删除（批 2 收尾）**：galleryFilterTree/ 下 10 个节点组件（ProviderChildrenNode + 9 个特化）。

**不改**：`GalleryQueryBar.vue`、`GalleryAdvancedQueryConditionRow.vue`、`useImagesChangeRefresh.ts`、`useAlbumImagesChangeRefresh.ts`、`useTrailingThrottle.ts`、后端全部。

## 附：VSCode 参考源码获取

实施时若本地无参考克隆，用稀疏浅克隆（约几十 MB）：

```bash
git clone --filter=blob:none --sparse --depth 1 https://github.com/microsoft/vscode.git <目标目录>
cd <目标目录>
git sparse-checkout set src/vs/base/browser/ui/tree src/vs/base/browser/ui/list \
  src/vs/base/browser/ui/sash src/vs/base/browser/ui/splitview \
  src/vs/workbench/contrib/files/browser/views
```

重点文件：`tree/indexTreeModel.ts`（扁平投影）、`tree/asyncDataTree.ts`（懒加载数据源）、`tree/abstractTree.ts`（twistie/缩进/DnD/StickyScrollController/Find）、`list/listWidget.ts`+`listView.ts`（行渲染与 DnD 反馈）、`workbench/contrib/files/browser/views/explorerViewer.ts`（FileDragAndDrop 实战）。
