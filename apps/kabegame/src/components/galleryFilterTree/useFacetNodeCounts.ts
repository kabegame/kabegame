import { computed, onBeforeUnmount, shallowReactive, watch } from "vue";
import { serializeFilterSet } from "@/utils/galleryPath";
import type { TreeModel } from "@/components/tree/useTreeModel";
import { countProviderPath, type GalleryFilterTreeContext } from "./context";
import type { FacetNode, GalleryFacetSource } from "./facetTreeSource";

/**
 * 高级查询 diff 模式的逐候选预测计数：
 * - 仅在 countBaseline 存在时建立节点态，侧栏模式直接读 element.count；
 * - 面板打开、草稿变化或新候选加载时计算；
 * - 不订阅任何数据变更事件。
 */
interface CountState {
  count: number | null;
  loading: boolean;
}

interface TrackedNode {
  state: CountState;
  token: number;
}

export function useFacetNodeCounts(options: {
  ctx: GalleryFilterTreeContext;
  model: TreeModel<FacetNode>;
  source: GalleryFacetSource;
}) {
  const { ctx, model, source } = options;
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

  function track(key: string) {
    if (tracked.has(key)) return;
    const entry: TrackedNode = {
      state: shallowReactive<CountState>({ count: null, loading: false }),
      token: 0,
    };
    tracked.set(key, entry);
    if (ctx.visible.value) void refresh(key);
  }

  function dispose(key: string) {
    const entry = tracked.get(key);
    if (!entry) return;
    entry.token++;
    tracked.delete(key);
  }

  // 投影行变化：新出现的节点建态；句柄已被模型释放的清态。
  // （收起的节点不在 rows 里但句柄还在 → 保活，不清。）
  watch(
    model.rows,
    (rows) => {
      if (!isDeltaMode.value) return;
      for (const row of rows) {
        if (row.kind === "node") track(row.key);
      }
      for (const key of [...tracked.keys()]) {
        if (!model.nodeByKey(key)) dispose(key);
      }
    },
    { immediate: true },
  );

  // 面板打开：全量刷一遍。
  watch(
    () => ctx.visible.value,
    (visible) => {
      if (visible) void refreshAll();
    },
  );

  // 计数路径随草稿变化：仅面板可见时全量重取。
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
    const count = model.nodeByKey(key)?.element.count ?? null;
    if (count == null) return "...";
    return String(count);
  }

  function deltaSignOf(key: string): number {
    return Math.sign(deltaOf(key) ?? 0);
  }

  function isEmptyOf(key: string): boolean {
    if (isDeltaMode.value) return deltaOf(key) === 0;
    const count = model.nodeByKey(key)?.element.count ?? null;
    return count !== null && count === 0;
  }

  function loadingOf(key: string): boolean {
    return isDeltaMode.value ? (stateOf(key)?.loading ?? false) : false;
  }

  return { isDeltaMode, displayOf, deltaSignOf, isEmptyOf, loadingOf, refreshAll };
}
