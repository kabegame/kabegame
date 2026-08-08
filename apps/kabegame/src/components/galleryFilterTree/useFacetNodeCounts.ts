import { computed, onBeforeUnmount, shallowReactive, watch } from "vue";
import { serializeFilterSet } from "@/utils/galleryPath";
import type { TreeModel } from "@/components/tree/useTreeModel";
import type { TreeRefreshHub } from "@/components/tree/useTreeRefreshHub";
import { countProviderPath, type GalleryFilterTreeContext } from "./context";
import type { FacetNode, GalleryFacetSource } from "./facetTreeSource";

/**
 * 每节点计数态（从旧 ProviderChildrenNode 的行内状态搬到适配层 Map）：
 * - 折叠保活：状态挂在 key 上，节点收起（不在投影里）时计数与订阅仍在
 * - visible 门控：面板关着不请求、事件被丢弃；打开时全量刷一遍（旧 watch(visible)）
 * - delta 模式：提供 countBaseline 即显示 `count − baseline`（+N/−N/0）
 * - 每节点在 ctx.registerRefreshTarget 注册（GalleryFilterTree.refresh() 集中刷新机制不变）
 */
interface CountState {
  count: number | null;
  loading: boolean;
}

interface TrackedNode {
  state: CountState;
  token: number;
  unregisterHub: () => void;
  unregisterTarget: () => void;
}

export function useFacetNodeCounts(options: {
  ctx: GalleryFilterTreeContext;
  hub: TreeRefreshHub;
  model: TreeModel<FacetNode>;
  source: GalleryFacetSource;
}) {
  const { ctx, hub, model, source } = options;
  const tracked = new Map<string, TrackedNode>();
  const isDeltaMode = computed(() => !!ctx.countBaseline);

  async function refresh(key: string): Promise<void> {
    const entry = tracked.get(key);
    const node = model.nodeByKey(key);
    if (!entry || !node) return;
    const token = ++entry.token;
    entry.state.loading = true;
    try {
      const next = await countProviderPath(source.descriptor(node.element).countPath);
      if (token === entry.token) entry.state.count = next;
    } catch {
      if (token === entry.token) entry.state.count = 0;
    } finally {
      if (token === entry.token) entry.state.loading = false;
    }
  }

  async function refreshAll(): Promise<void> {
    await Promise.all([...tracked.keys()].map((key) => refresh(key)));
  }

  function track(key: string, element: FacetNode) {
    if (tracked.has(key)) return;
    const entry: TrackedNode = {
      state: shallowReactive<CountState>({ count: null, loading: false }),
      token: 0,
      unregisterHub: hub.register({
        waitMs: 3000,
        when: () => ctx.visible.value,
        filter: source.countRefreshFilter(element),
        onRefresh: () => refresh(key),
      }),
      unregisterTarget: ctx.registerRefreshTarget({ refresh: () => refresh(key) }),
    };
    tracked.set(key, entry);
    if (ctx.visible.value) void refresh(key);
  }

  function dispose(key: string) {
    const entry = tracked.get(key);
    if (!entry) return;
    entry.token++;
    entry.unregisterHub();
    entry.unregisterTarget();
    tracked.delete(key);
  }

  // 投影行变化：新出现的节点建态；句柄已被模型释放的清态。
  // （收起的节点不在 rows 里但句柄还在 → 保活，不清。）
  watch(
    model.rows,
    (rows) => {
      for (const row of rows) {
        if (row.kind === "node") track(row.key, row.node.element);
      }
      for (const key of [...tracked.keys()]) {
        if (!model.nodeByKey(key)) dispose(key);
      }
    },
    { immediate: true },
  );

  // 面板打开：全量刷一遍（旧实现每个节点 watch(visible)）。
  watch(
    () => ctx.visible.value,
    (visible) => {
      if (visible) void refreshAll();
    },
  );

  // 计数路径随过滤/草稿变化（高级面板 diff 模式）：全量重取。
  // GalleryFilterTree 侧由 treeKey 重挂覆盖，此 watch 冗余但无害。
  watch(
    () => serializeFilterSet(ctx.filters.value),
    () => {
      if (ctx.visible.value) void refreshAll();
    },
  );

  onBeforeUnmount(() => {
    for (const key of [...tracked.keys()]) dispose(key);
  });

  function stateOf(key: string): CountState | undefined {
    return tracked.get(key)?.state;
  }

  function deltaOf(key: string): number | null {
    if (!isDeltaMode.value) return null;
    const count = stateOf(key)?.count ?? null;
    const baseline = ctx.countBaseline?.value;
    if (count == null || baseline == null) return null;
    return count - baseline;
  }

  /** 与旧 displayCount 逐字符一致（"..." / "+N" / "−N" / "0" / String(count)）。 */
  function displayOf(key: string): string {
    if (isDeltaMode.value) {
      const delta = deltaOf(key);
      if (delta == null) return "...";
      if (delta > 0) return `+${delta}`;
      if (delta < 0) return `−${-delta}`;
      return "0";
    }
    const count = stateOf(key)?.count ?? null;
    if (count == null) return "...";
    return String(count);
  }

  function deltaSignOf(key: string): number {
    return Math.sign(deltaOf(key) ?? 0);
  }

  function isEmptyOf(key: string): boolean {
    if (isDeltaMode.value) return deltaOf(key) === 0;
    const count = stateOf(key)?.count ?? null;
    return count !== null && count === 0;
  }

  function loadingOf(key: string): boolean {
    return stateOf(key)?.loading ?? false;
  }

  return { isDeltaMode, displayOf, deltaSignOf, isEmptyOf, loadingOf, refreshAll };
}
