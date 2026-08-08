import { onBeforeUnmount, shallowRef, watch, type Ref, type ShallowRef } from "vue";
import type { TreeNodeHandle, TreeRow } from "./types";

export interface TreeStickyEntry<T> {
  node: TreeNodeHandle<T>;
  /** 相对滚动容器视口顶部的固定位置（depth * rowHeight）。 */
  top: number;
  /** 被子树末尾推走时的上移偏移（translateY 负向），0 = 未被推。 */
  pushOffset: number;
}

/**
 * sticky 表头控制器：vscode abstractTree StickyScrollController 的轻量同构。
 *
 * 旧实现靠 DOM 嵌套 + CSS position:sticky（top=depth*32、被子树容器底边推走）；
 * 扁平行没有推挤边界，故改为：把视口顶部行的「展开且有子」祖先链复制渲染到
 * 容器顶部 overlay。等高行让全部计算退化为整数除法。
 */
export function useTreeStickyHeaders<T>(options: {
  scroller: Ref<HTMLElement | null>;
  rows: ShallowRef<TreeRow<T>[]>;
  rowHeight: number;
  enabled?: () => boolean;
}): ShallowRef<TreeStickyEntry<T>[]> {
  const entries = shallowRef<TreeStickyEntry<T>[]>([]);
  let rafId: number | null = null;

  function compute() {
    rafId = null;
    const scroller = options.scroller.value;
    if (!scroller || (options.enabled && !options.enabled())) {
      if (entries.value.length) entries.value = [];
      return;
    }
    const { rowHeight } = options;
    const rows = options.rows.value;
    const scrollTop = scroller.scrollTop;
    if (scrollTop <= 0 || rows.length === 0) {
      if (entries.value.length) entries.value = [];
      return;
    }
    // CSS sticky 等价语义：每个「展开且有子」的行独立判定——natural 位置一越过
    // 自己的 sticky 位（depth*rowHeight）就贴住，直到被子树末行推走。
    // 不能用「顶部节点祖先链」推导（vscode StickyScrollController 的做法）：
    // 深层表头在“被切到 sticky 位”与“topIndex 进入其子树”之间有 depth*rowHeight
    // 的窗口，期间会滑进上级 overlay 底下消失，整块划走后才突然出现。
    // 行数百级，O(n) 逐行扫描足够便宜。
    const next: TreeStickyEntry<T>[] = [];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (row.kind !== "node") continue;
      const node = row.node;
      if (!node.hasChildren || !node.expanded) continue;
      const top = node.depth * rowHeight;
      const naturalTop = i * rowHeight - scrollTop;
      // 行还没滚到它的 sticky 位置之上：不需要贴
      if (naturalTop >= top) continue;
      // 推走：子树末行滚出到 sticky 行底边之上时，把 sticky 行往上顶
      const subtreeEndTop = (i + node.subtreeRowCount) * rowHeight - scrollTop;
      const stickyBottom = top + rowHeight;
      const pushOffset = subtreeEndTop < stickyBottom ? stickyBottom - subtreeEndTop : 0;
      // 整条已被完全推出视口：跳过
      if (pushOffset >= rowHeight) continue;
      next.push({ node, top, pushOffset });
    }
    entries.value = next;
  }

  function schedule() {
    if (rafId != null) return;
    rafId = requestAnimationFrame(compute);
  }

  let boundScroller: HTMLElement | null = null;
  watch(
    options.scroller,
    (el) => {
      if (boundScroller) boundScroller.removeEventListener("scroll", schedule);
      boundScroller = el ?? null;
      if (el) el.addEventListener("scroll", schedule, { passive: true });
      schedule();
    },
    { immediate: true },
  );
  watch(options.rows, () => schedule());

  onBeforeUnmount(() => {
    if (boundScroller) boundScroller.removeEventListener("scroll", schedule);
    if (rafId != null) cancelAnimationFrame(rafId);
  });

  return entries;
}
