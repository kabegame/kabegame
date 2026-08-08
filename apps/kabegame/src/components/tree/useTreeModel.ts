import { shallowReactive, shallowRef, watch, type Ref, type ShallowRef } from "vue";
import type { TreeDataSource, TreeNodeHandle, TreeRow, TreeSection } from "./types";

/**
 * 树模型：持有节点句柄表（展开/懒加载态），对外产出扁平可见行数组。
 *
 * 同构 vscode indexTreeModel 的可见行投影，但不抄它的增量 splice 簿记——
 * 本仓消费者都是百级节点，结构变化后 O(n) 全量 rebuild 并整体替换
 * shallowRef，由 v-for 的 keyed patch 吃掉差量。节点内部可变状态
 * （loading/计数等）在 shallowReactive 句柄上，视图直接读，不触发投影重建。
 */
export interface TreeModel<T> {
  rows: ShallowRef<TreeRow<T>[]>;
  nodeByKey(key: string): TreeNodeHandle<T> | undefined;
  /** 全部存活句柄（含收起的）；auto-expand 同步等遍历用。 */
  allNodes(): TreeNodeHandle<T>[];
  /** 行 key → 当前投影中的行下标（sticky/DnD 用）；不存在返回 -1。 */
  rowIndexByKey(key: string): number;
  expand(key: string): Promise<void>;
  collapse(key: string): void;
  toggle(key: string): Promise<void>;
  /** 重新枚举某节点子项：按 key diff，保留仍存在后代的句柄（展开态/计数态不丢）。 */
  refreshChildren(key: string): Promise<void>;
  /** 刷新所有已加载分支的子项枚举（整树集中刷新入口用）。 */
  refreshLoadedChildren(): Promise<void>;
  /** 重新枚举各分区根与所有已加载分支（key diff 保留句柄）。 */
  reload(): Promise<void>;
}

export interface TreeModelOptions<T> {
  dataSource: TreeDataSource<T>;
  sections: () => TreeSection<T>[];
  /** 节点创建时的默认展开判定（对应旧 defaultExpanded / autoExpandRoot 语义）。 */
  defaultExpanded?: (element: T, depth: number) => boolean;
  /** 名称过滤：非空时投影只保留命中行及其祖先链（只作用于已加载子树）。 */
  filterText?: Ref<string>;
  getFilterLabel?: (element: T) => string;
  /** 行剔除（对应旧 emptyState="hide"）；返回 true 的节点不进投影。 */
  isRowHidden?: (element: T) => boolean;
  /** 分支首次完成子项枚举时回调（供宿主注册事件驱动的子项重枚举）。 */
  onChildrenLoaded?: (handle: TreeNodeHandle<T>) => void;
}

interface SectionState<T> {
  section: TreeSection<T>;
  roots: TreeNodeHandle<T>[];
}

export function useTreeModel<T>(options: TreeModelOptions<T>): TreeModel<T> {
  const { dataSource } = options;
  const rows = shallowRef<TreeRow<T>[]>([]);
  const handles = new Map<string, TreeNodeHandle<T>>();
  const rowIndex = new Map<string, number>();
  const sectionStates: SectionState<T>[] = [];
  /** 每节点子项枚举的防竞态 token（对应旧实现的 listToken）。 */
  const loadTokens = new Map<string, number>();

  function createHandle(
    element: T,
    depth: number,
    parent: TreeNodeHandle<T> | null,
    sectionId: string,
  ): TreeNodeHandle<T> {
    const key = dataSource.getKey(element);
    const hasChildren = dataSource.hasChildren(element);
    const handle = shallowReactive({
      key,
      element,
      depth,
      parent,
      sectionId,
      hasChildren,
      children: null,
      expanded: hasChildren ? (options.defaultExpanded?.(element, depth) ?? false) : false,
      loading: false,
      loaded: false,
      subtreeRowCount: 0,
    }) as TreeNodeHandle<T>;
    handles.set(key, handle);
    return handle;
  }

  function dropSubtree(handle: TreeNodeHandle<T>) {
    // 按身份而非 key 删：节点在树内移动时（如画册从子画册拖到根），新位置的
    // 句柄已经用同一 key 占了表位，这里释放旧位置的残影不能把新句柄一起抹掉。
    if (handles.get(handle.key) === handle) {
      handles.delete(handle.key);
      loadTokens.delete(handle.key);
    }
    for (const child of handle.children ?? []) dropSubtree(child);
  }

  async function loadChildren(handle: TreeNodeHandle<T>): Promise<void> {
    if (!handle.hasChildren) return;
    const token = (loadTokens.get(handle.key) ?? 0) + 1;
    loadTokens.set(handle.key, token);
    handle.loading = true;
    let elements: T[] = [];
    try {
      elements = await dataSource.getChildren(handle.element);
    } catch {
      elements = [];
    }
    // 竞态/已被移除：丢弃结果
    if (loadTokens.get(handle.key) !== token || !handles.has(handle.key)) return;
    applyChildren(handle, elements);
    handle.loading = false;
    const firstLoad = !handle.loaded;
    handle.loaded = true;
    rebuild();
    if (firstLoad) options.onChildrenLoaded?.(handle);
  }

  /**
   * 把存活句柄对齐到新的元素快照。子项掉光时必须回到未加载态：
   * 光改 hasChildren 不清 children，投影仍会照着旧数组渲染（子节点被移走后
   * 会在旧父下留残影），而 loadChildren 又因 !hasChildren 直接返回、清不掉。
   */
  function syncExistingHandle(handle: TreeNodeHandle<T>, element: T) {
    handle.element = element;
    handle.hasChildren = dataSource.hasChildren(element);
    if (!handle.hasChildren) {
      for (const child of handle.children ?? []) dropSubtree(child);
      handle.children = null;
      handle.expanded = false;
      handle.loaded = false;
    }
  }

  /** 子项 key diff：保留仍存在的句柄（含其后代与展开态），新键新建，消失键整棵释放。 */
  function applyChildren(handle: TreeNodeHandle<T>, elements: T[]) {
    const prev = new Map((handle.children ?? []).map((c) => [c.key, c]));
    const next: TreeNodeHandle<T>[] = [];
    for (const element of elements) {
      const key = dataSource.getKey(element);
      const existing = prev.get(key);
      if (existing) {
        prev.delete(key);
        syncExistingHandle(existing, element);
        next.push(existing);
      } else {
        const created = createHandle(element, handle.depth + 1, handle, handle.sectionId);
        next.push(created);
      }
    }
    for (const removed of prev.values()) dropSubtree(removed);
    handle.children = next;
    // 新建的默认展开节点级联加载
    for (const child of next) {
      if (child.expanded && child.hasChildren && child.children === null && !child.loading) {
        void loadChildren(child);
      }
    }
  }

  function matchesFilter(handle: TreeNodeHandle<T>, text: string): boolean {
    const label = options.getFilterLabel?.(handle.element) ?? "";
    return label.toLowerCase().includes(text);
  }

  /**
   * 投影一个节点子树。返回该节点贡献的可见行数（含自身）。
   * 过滤模式下忽略 expanded：命中行 + 祖先链可见（只搜已加载子树）。
   */
  function projectNode(
    handle: TreeNodeHandle<T>,
    out: TreeRow<T>[],
    filterLower: string,
  ): number {
    if (options.isRowHidden?.(handle.element)) {
      handle.subtreeRowCount = 0;
      return 0;
    }
    if (!filterLower) {
      const start = out.length;
      out.push({ kind: "node", key: handle.key, node: handle });
      if (handle.expanded && handle.children) {
        for (const child of handle.children) projectNode(child, out, filterLower);
      }
      handle.subtreeRowCount = out.length - start;
      return handle.subtreeRowCount;
    }
    // 过滤模式：先投影子树到临时数组，命中或有命中后代才保留自身
    const childRows: TreeRow<T>[] = [];
    let childCount = 0;
    for (const child of handle.children ?? []) {
      childCount += projectNode(child, childRows, filterLower);
    }
    const selfMatch = matchesFilter(handle, filterLower);
    if (!selfMatch && childCount === 0) {
      handle.subtreeRowCount = 0;
      return 0;
    }
    out.push({ kind: "node", key: handle.key, node: handle });
    for (const row of childRows) out.push(row);
    handle.subtreeRowCount = 1 + childCount;
    return handle.subtreeRowCount;
  }

  function rebuild() {
    const filterLower = (options.filterText?.value ?? "").trim().toLowerCase();
    const out: TreeRow<T>[] = [];
    for (const state of sectionStates) {
      const { section } = state;
      const sectionStart = out.length;
      if (section.separatorBefore) {
        out.push({ kind: "separator", key: `__sep:${section.id}`, sectionId: section.id });
      }
      if (section.header) {
        out.push({ kind: "section-header", key: `__hdr:${section.id}`, sectionId: section.id });
      }
      let contributed = 0;
      for (const root of state.roots) {
        contributed += projectNode(root, out, filterLower);
      }
      // 整段无内容（数据为空或过滤无命中）：连同分隔线/小节标题一起隐藏
      if (contributed === 0) {
        out.length = sectionStart;
      }
    }
    rowIndex.clear();
    out.forEach((row, index) => rowIndex.set(row.key, index));
    rows.value = out;
  }

  /**
   * 自顶向下重枚举所有已加载分支的子项（父先于子）。
   * 只重枚举根不够：节点在分支之间移动后，旧父的 children 仍挂着它（旧位置留残影），
   * 而移进来的新父不会自己发现它（新位置不出现）。未加载的分支保持惰性。
   */
  async function refreshLoadedBranches(): Promise<void> {
    const walk = async (nodes: TreeNodeHandle<T>[]): Promise<void> => {
      for (const node of nodes) {
        if (node.loaded) await loadChildren(node);
        if (node.children) await walk(node.children);
      }
    };
    for (const state of sectionStates) await walk(state.roots);
  }

  async function reloadSection(state: SectionState<T>): Promise<void> {
    let elements: T[] = [];
    try {
      elements = await state.section.roots();
    } catch {
      elements = [];
    }
    const prev = new Map(state.roots.map((r) => [r.key, r]));
    const next: TreeNodeHandle<T>[] = [];
    for (const element of elements) {
      const key = dataSource.getKey(element);
      const existing = prev.get(key);
      if (existing) {
        prev.delete(key);
        syncExistingHandle(existing, element);
        next.push(existing);
      } else {
        const created = createHandle(element, 0, null, state.section.id);
        next.push(created);
      }
    }
    for (const removed of prev.values()) dropSubtree(removed);
    state.roots = next;
    for (const root of next) {
      if (root.expanded && root.hasChildren && root.children === null && !root.loading) {
        void loadChildren(root);
      }
    }
  }

  async function reload(): Promise<void> {
    const sections = options.sections();
    // 分区结构变化（增删分区）时整体重建分区表，句柄按 key 复用
    if (
      sectionStates.length !== sections.length ||
      sectionStates.some((s, i) => s.section.id !== sections[i].id)
    ) {
      const prevRoots = new Map(
        sectionStates.flatMap((s) => s.roots.map((r) => [r.key, r] as const)),
      );
      sectionStates.length = 0;
      for (const section of sections) {
        sectionStates.push({ section, roots: [] });
      }
      // 旧根句柄整棵释放（分区变化视为结构性重置）
      for (const root of prevRoots.values()) dropSubtree(root);
    } else {
      sectionStates.forEach((s, i) => (s.section = sections[i]));
    }
    await Promise.all(sectionStates.map((state) => reloadSection(state)));
    await refreshLoadedBranches();
    rebuild();
  }

  async function expand(key: string): Promise<void> {
    const handle = handles.get(key);
    if (!handle || !handle.hasChildren || handle.expanded) return;
    handle.expanded = true;
    if (handle.children === null) {
      rebuild(); // 先把 loading 态行投出去
      await loadChildren(handle);
    } else {
      rebuild();
    }
  }

  function collapse(key: string): void {
    const handle = handles.get(key);
    if (!handle || !handle.expanded) return;
    handle.expanded = false;
    rebuild();
  }

  async function toggle(key: string): Promise<void> {
    const handle = handles.get(key);
    if (!handle) return;
    if (handle.expanded) collapse(key);
    else await expand(key);
  }

  async function refreshChildren(key: string): Promise<void> {
    const handle = handles.get(key);
    if (!handle || !handle.hasChildren) return;
    await loadChildren(handle);
  }

  async function refreshLoadedChildren(): Promise<void> {
    const loaded = [...handles.values()].filter((h) => h.loaded);
    await Promise.all(loaded.map((h) => loadChildren(h)));
  }

  if (options.filterText) {
    watch(options.filterText, () => rebuild());
  }

  void reload();

  return {
    rows,
    nodeByKey: (key) => handles.get(key),
    allNodes: () => [...handles.values()],
    rowIndexByKey: (key) => rowIndex.get(key) ?? -1,
    expand,
    collapse,
    toggle,
    refreshChildren,
    refreshLoadedChildren,
    reload,
  };
}
