import {
  computed,
  nextTick,
  onScopeDispose,
  shallowReactive,
  shallowRef,
  watch,
  watchEffect,
  type Ref,
  type ShallowRef,
} from "vue";
import { pathqlAllKey, pathqlRequest$ } from "@/services/kbEvents/pathqlSource";
import { usePathqlLookMany } from "@/services/kbEvents/usePathqlLookMany";
import type { TreeBranch, TreePage, TreeQuerySource, TreeNodeHandle, TreeRow, TreeSection } from "./types";

export interface TreeModel<T> {
  rows: ShallowRef<TreeRow<T>[]>;
  nodeByKey(key: string): TreeNodeHandle<T> | undefined;
  /** 全部存活句柄，包含收起分支。 */
  allNodes(): TreeNodeHandle<T>[];
  rowIndexByKey(key: string): number;
  expand(key: string): Promise<void>;
  collapse(key: string): void;
  toggle(key: string): Promise<void>;
  loadMore(target: string | { sectionId: string }): Promise<void>;
  /** 请求当前观察集合，等各查询结果或错误落地；不等待随后出现的新分支。 */
  refresh(): Promise<void>;
}

export interface TreeModelOptions<T> {
  dataSource: TreeQuerySource<T>;
  sections: () => TreeSection<T>[];
  active?: () => boolean;
  defaultExpanded?: (element: T, depth: number) => boolean;
  filterText?: Ref<string>;
  getFilterLabel?: (element: T) => string;
  isRowHidden?: (element: T) => boolean;
}

interface SectionState<T> {
  section: TreeSection<T>;
  roots: TreeNodeHandle<T>[];
  loadedPages: number;
  hasMore: boolean;
  loading: boolean;
}

interface PageRef<T> {
  branchId: string;
  branch: TreeBranch<T>;
  page: number;
  part: "page" | "extra";
  spec: TreePage<T>;
}

/** 只描述、观察当前可见分支；用户操作经唯一请求入口发出，结果通过 key diff 落地。 */
export function useTreeModel<T>(options: TreeModelOptions<T>): TreeModel<T> {
  const { dataSource } = options;
  const rows = shallowRef<TreeRow<T>[]>([]);
  const handles = new Map<string, TreeNodeHandle<T>>();
  const rowIndex = new Map<string, number>();
  const sectionStates = shallowReactive<SectionState<T>[]>([]);
  const expandedMemory = new Set<string>();
  // 数据按分支、页保存，查询参数换 key 时保留上一份内容。
  const pageData = new Map<string, Map<number, T[]>>();
  const extraPatches = new Map<string, Map<number, Map<string, Partial<T>>>>();
  // 一次等待只绑定当前 key；退订、分支移除与卸载也必须释放等待。
  const waiters = new Map<string, Set<() => void>>();
  const snapshots = new Map<string, readonly unknown[]>();
  let disposed = false;

  function settle(key: string) {
    const pending = waiters.get(key);
    waiters.delete(key);
    pending?.forEach((resolve) => resolve());
  }

  function waitFor(key: string): Promise<void> {
    return new Promise((resolve) => {
      const pending = waiters.get(key) ?? new Set();
      pending.add(resolve);
      waiters.set(key, pending);
    });
  }

  function childrenId(key: string) {
    return `children:${key}`;
  }

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
      expanded: hasChildren && (expandedMemory.has(key) || (options.defaultExpanded?.(element, depth) ?? false)),
      loading: false,
      loaded: false,
      hasMore: false,
      loadedPages: 1,
      subtreeRowCount: 0,
    }) as TreeNodeHandle<T>;
    handles.set(key, handle);
    return handle;
  }

  function clearBranch(id: string) {
    pageData.delete(id);
    extraPatches.delete(id);
  }

  function dropSubtree(handle: TreeNodeHandle<T>) {
    // 移动时新位置可能已用同 key 登记，释放旧位置不能抹掉新句柄及其页数据。
    if (handles.get(handle.key) === handle) {
      handles.delete(handle.key);
      clearBranch(childrenId(handle.key));
    }
    for (const child of handle.children ?? []) dropSubtree(child);
  }

  function syncExistingHandle(handle: TreeNodeHandle<T>, element: T) {
    handle.element = element;
    handle.hasChildren = dataSource.hasChildren(element);
    if (handle.hasChildren && expandedMemory.has(handle.key)) handle.expanded = true;
    if (!handle.hasChildren) {
      for (const child of handle.children ?? []) dropSubtree(child);
      handle.children = null;
      handle.expanded = false;
      handle.loaded = false;
      handle.hasMore = false;
      handle.loadedPages = 1;
      clearBranch(childrenId(handle.key));
    }
  }

  function diff(previous: TreeNodeHandle<T>[], elements: T[], parent: TreeNodeHandle<T> | null, sectionId: string) {
    const prev = new Map(previous.map((handle) => [handle.key, handle]));
    const next = elements.map((element) => {
      const key = dataSource.getKey(element);
      const handle = prev.get(key);
      if (!handle) return createHandle(element, parent ? parent.depth + 1 : 0, parent, sectionId);
      prev.delete(key);
      syncExistingHandle(handle, element);
      return handle;
    });
    for (const removed of prev.values()) dropSubtree(removed);
    return next;
  }

  watch(
    options.sections,
    (sections) => {
      const prev = new Map(sectionStates.map((state) => [state.section.id, state]));
      const next = sections.map((section) => {
        const state = prev.get(section.id);
        prev.delete(section.id);
        if (state) {
          state.section = section;
          return state;
        }
        return shallowReactive({
          section,
          roots: [],
          loadedPages: 1,
          hasMore: false,
          loading: false,
        }) as SectionState<T>;
      });
      for (const state of prev.values()) {
        state.roots.forEach(dropSubtree);
        clearBranch(`section:${state.section.id}`);
      }
      sectionStates.splice(0, sectionStates.length, ...next);
    },
    { immediate: true },
  );

  const observed = computed(() => {
    // 同一个 key 可以服务多个分支 / 页，不能用最后一个引用覆盖前面的引用。
    const out = new Map<string, PageRef<T>[]>();
    function add(branchId: string, branch: TreeBranch<T>, pages: number) {
      for (let page = 1; page <= Math.max(1, pages); page++) {
        const spec = dataSource.page(branch, page);
        if (!spec) break;
        const put = (part: "page" | "extra", key: string) => {
          const refs = out.get(key) ?? [];
          refs.push({ branchId, branch, page, part, spec });
          out.set(key, refs);
        };
        put("page", pathqlAllKey(spec.queries));
        if (spec.extra) put("extra", pathqlAllKey(spec.extra.queries));
      }
    }
    function walk(nodes: TreeNodeHandle<T>[]) {
      for (const handle of nodes) {
        if (!handle.expanded || !handle.hasChildren || options.isRowHidden?.(handle.element)) continue;
        add(childrenId(handle.key), { kind: "children", parent: handle.element }, handle.loadedPages);
        walk(handle.children ?? []);
      }
    }
    if (!(options.active?.() ?? true)) return out;
    for (const state of sectionStates) {
      add(`section:${state.section.id}`, { kind: "section", sectionId: state.section.id }, state.loadedPages);
      walk(state.roots);
    }
    return out;
  });

  function patchesOf(branchId: string): Map<string, Partial<T>> {
    const patches = new Map<string, Partial<T>>();
    for (const [, page] of [...(extraPatches.get(branchId)?.entries() ?? [])].sort(([a], [b]) => a - b)) {
      for (const [key, patch] of page) patches.set(key, { ...patches.get(key), ...patch });
    }
    return patches;
  }

  function applyBranch(ref: PageRef<T>) {
    const pages = pageData.get(ref.branchId);
    if (!pages) return;
    const unique = new Map<string, T>();
    const patches = patchesOf(ref.branchId);
    for (const [, elements] of [...pages.entries()].sort(([a], [b]) => a - b)) {
      for (const element of elements) {
        const key = dataSource.getKey(element);
        unique.set(key, patches.has(key) ? { ...element, ...patches.get(key) } : element);
      }
    }
    const elements = [...unique.values()];
    const parent = ref.branch.kind === "children" ? handles.get(dataSource.getKey(ref.branch.parent)) : undefined;
    const sectionId = ref.branch.kind === "section" ? ref.branch.sectionId : undefined;
    const state = sectionStates.find((state) => state.section.id === sectionId);
    const owner = parent ?? state;
    if (!owner) return;
    const last = pages.get(owner.loadedPages);
    owner.hasMore =
      !!dataSource.pageSize &&
      (parent && dataSource.totalChildren
        ? elements.length < dataSource.totalChildren(parent.element)
        : (last?.length ?? 0) >= dataSource.pageSize);
    if (parent) {
      parent.children = diff(parent.children ?? [], elements, parent, parent.sectionId);
      parent.loaded = true;
    } else if (state) state.roots = diff(state.roots, elements, null, state.section.id);
  }

  function applyPage(ref: PageRef<T>, results: readonly unknown[]) {
    if (ref.part === "page") {
      const pages = pageData.get(ref.branchId) ?? new Map<number, T[]>();
      pages.set(ref.page, ref.spec.parse(results));
      pageData.set(ref.branchId, pages);
    } else {
      const pages = extraPatches.get(ref.branchId) ?? new Map<number, Map<string, Partial<T>>>();
      pages.set(ref.page, ref.spec.extra!.parse(results));
      extraPatches.set(ref.branchId, pages);
      const branch = ref.branch;
      const nodes =
        branch.kind === "children"
          ? handles.get(dataSource.getKey(branch.parent))?.children
          : sectionStates.find((state) => state.section.id === branch.sectionId)?.roots;
      const patches = patchesOf(ref.branchId);
      // 补充结果只修改当前句柄字段；不重建结构，也不影响展开加载状态。
      for (const handle of nodes ?? []) {
        const patch = patches.get(handle.key);
        if (patch) handle.element = { ...handle.element, ...patch };
      }
      return;
    }
    applyBranch(ref);
  }

  const look = usePathqlLookMany({
    kind: "all",
    keys: () => [...observed.value.keys()],
    refreshOn: (key) => (observed.value.get(key) ?? []).flatMap((ref) => dataSource.refreshOn(ref.branch, ref.part)),
    onResult: (key, snapshot) => {
      snapshots.set(key, snapshot.results);
      try {
        for (const ref of observed.value.get(key) ?? []) applyPage(ref, snapshot.results);
      } finally {
        settle(key);
      }
    },
    onError: (key) => settle(key),
  });

  watch(
    observed,
    (next, prev) => {
      for (const key of prev?.keys() ?? [])
        if (!next.has(key)) {
          snapshots.delete(key);
          settle(key);
        }
      for (const [key, refs] of next) {
        if (!prev?.has(key)) {
          pathqlRequest$.next(["all", key]);
          continue;
        }
        // 新分支复用正在观察的同一 key 时，不会再注册观察方；从最近结果补落地。
        const added = refs.filter(
          (ref) =>
            !prev
              .get(key)!
              .some((old) => old.branchId === ref.branchId && old.page === ref.page && old.part === ref.part),
        );
        const snapshot = snapshots.get(key);
        if (snapshot) for (const ref of added) applyPage(ref, snapshot);
        if (added.length && !look.loading(key)) settle(key);
      }
    },
    { immediate: true, flush: "sync" },
  );

  // loading 只来自结构页；慢补充查询不会让展开箭头一直转圈。
  watchEffect(() => {
    const busy = new Set<string>();
    for (const [key, refs] of observed.value) {
      if (look.loading(key)) for (const ref of refs) if (ref.part === "page") busy.add(ref.branchId);
    }
    for (const state of sectionStates) state.loading = busy.has(`section:${state.section.id}`);
    for (const handle of handles.values()) handle.loading = busy.has(childrenId(handle.key));
    rebuild();
  });

  function matchesFilter(handle: TreeNodeHandle<T>, text: string): boolean {
    const label = options.getFilterLabel?.(handle.element) ?? "";
    return label.toLowerCase().includes(text);
  }

  /**
   * 投影一个节点子树。返回该节点贡献的可见行数（含自身）。
   * 过滤模式下忽略 expanded：命中行 + 祖先链可见（只搜已加载子树）。
   */
  function projectNode(handle: TreeNodeHandle<T>, out: TreeRow<T>[], filterLower: string): number {
    if (options.isRowHidden?.(handle.element)) {
      handle.subtreeRowCount = 0;
      return 0;
    }
    if (!filterLower) {
      const start = out.length;
      out.push({ kind: "node", key: handle.key, node: handle });
      if (handle.expanded && handle.children) {
        for (const child of handle.children) projectNode(child, out, filterLower);
        if (handle.hasMore) {
          out.push({
            kind: "load-more",
            key: `__more:${handle.key}`,
            parentKey: handle.key,
            sectionId: handle.sectionId,
            loading: handle.loading,
          });
        }
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
      if (!filterLower && state.hasMore) {
        out.push({
          kind: "load-more",
          key: `__more-root:${section.id}`,
          parentKey: null,
          sectionId: section.id,
          loading: state.loading,
        });
        contributed += 1;
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

  async function waitPage(branchId: string, page: number): Promise<void> {
    // 同步观察方先登记，自动请求 watcher 随后运行，等待不会漏掉新请求的结果。
    const key = [...observed.value].find(([, refs]) =>
      refs.some((ref) => ref.branchId === branchId && ref.page === page && ref.part === "page"),
    )?.[0];
    if (key && !disposed && (look.loading(key) || !snapshots.has(key))) await waitFor(key);
  }

  function pendingPages(branchId: string): string[] {
    return [...observed.value]
      .filter(
        ([key, refs]) =>
          (look.loading(key) || waiters.has(key)) &&
          refs.some((ref) => ref.branchId === branchId && ref.part === "page"),
      )
      .map(([key]) => key);
  }

  async function expand(key: string): Promise<void> {
    const handle = handles.get(key);
    if (!handle || !handle.hasChildren) return;
    if (handle.expanded) {
      await Promise.all(pendingPages(childrenId(key)).map(waitFor));
      return;
    }
    handle.expanded = true;
    expandedMemory.add(key);
    await waitPage(childrenId(key), 1);
  }

  function collapse(key: string) {
    const handle = handles.get(key);
    if (!handle) return;
    handle.expanded = false;
    expandedMemory.delete(key);
  }

  async function toggle(key: string) {
    if (handles.get(key)?.expanded) collapse(key);
    else await expand(key);
  }

  async function loadMore(target: string | { sectionId: string }): Promise<void> {
    const owner =
      typeof target === "string" ? handles.get(target) : sectionStates.find((s) => s.section.id === target.sectionId);
    const id = typeof target === "string" ? childrenId(target) : `section:${target.sectionId}`;
    if (!owner) return;
    const pending = pendingPages(id);
    if (pending.length) {
      await Promise.all(pending.map(waitFor));
      return;
    }
    if (!dataSource.pageSize || !owner.hasMore) return;
    const failed = [...observed.value].find(
      ([key, refs]) => look.error(key) != null && refs.some((ref) => ref.branchId === id && ref.part === "page"),
    )?.[0];
    if (failed) {
      // 保留旧子项时也保留失败页的页码；再次加载先重试，不能跳过缺失的一页。
      const retry = waitFor(failed);
      pathqlRequest$.next(["all", failed]);
      await retry;
      return;
    }
    owner.loadedPages++;
    await waitPage(id, owner.loadedPages);
  }

  async function refresh(): Promise<void> {
    await nextTick();
    if (disposed) return;
    const keys = [...observed.value.keys()];
    const pending = keys.map(waitFor);
    for (const key of keys) pathqlRequest$.next(["all", key]);
    await Promise.all(pending);
  }

  onScopeDispose(() => {
    disposed = true;
    for (const key of [...waiters.keys()]) settle(key);
  });

  return {
    rows,
    nodeByKey: (key) => handles.get(key),
    allNodes: () => [...handles.values()],
    rowIndexByKey: (key) => rowIndex.get(key) ?? -1,
    expand,
    collapse,
    toggle,
    loadMore,
    refresh,
  };
}
