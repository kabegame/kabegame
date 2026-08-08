import { onBeforeUnmount, shallowRef, type Ref, type ShallowRef } from "vue";
import type {
  TreeDndController,
  TreeDragOverReaction,
  TreeDropPosition,
  TreeNodeHandle,
  TreeRow,
} from "./types";

/**
 * 树内节点拖拽：接口学 vscode ITreeDragAndDrop，运输层为 pointer 事件状态机。
 *
 * 不用 HTML5 DnD：本 runtime（tauri-runtime-cef）在 content 层 veto 了 OS 级
 * 拖放会话（见 cocs/ui/FILE_DROP_ZONES.md），页内 drag 事件不可靠；pointer
 * 是普通输入事件，不经过 CEF 的 drag 管线。命中不用 elementFromPoint
 * （浮影遮挡），用容器 rect + scrollTop + 等高行直接算行下标。
 */
export interface TreeDragState<T> {
  sourceKey: string;
  label: string;
  /** 指针位置（viewport 坐标），浮影跟随。 */
  x: number;
  y: number;
  /** 当前命中：null = 分区空白/根区域。 */
  targetKey: string | null;
  position: TreeDropPosition;
  accept: boolean;
  /** 插入线（before/after 反馈）的容器内 y 坐标与缩进；null = 无插入线。 */
  insertLine: { top: number; indent: number } | null;
}

const DRAG_THRESHOLD_PX = 5;
const AUTO_EXPAND_DELAY_MS = 500;
const EDGE_SCROLL_ZONE_PX = 24;
const EDGE_SCROLL_MAX_PX_PER_FRAME = 14;

export function useTreeDnd<T>(options: {
  scroller: Ref<HTMLElement | null>;
  rows: ShallowRef<TreeRow<T>[]>;
  rowHeight: number;
  indentPx: number;
  controller: () => TreeDndController<T> | null | undefined;
  nodeByKey: (key: string) => TreeNodeHandle<T> | undefined;
  expand: (key: string) => Promise<void>;
  getDefaultLabel: (element: T) => string;
}) {
  const dragState = shallowRef<TreeDragState<T> | null>(null);

  interface PendingDrag {
    key: string;
    pointerId: number;
    startX: number;
    startY: number;
  }
  let pending: PendingDrag | null = null;
  let dragging = false;
  let autoExpandKey: string | null = null;
  let autoExpandTimer: ReturnType<typeof setTimeout> | null = null;
  let edgeScrollRaf: number | null = null;
  let edgeScrollSpeed = 0;
  let lastClientX = 0;
  let lastClientY = 0;

  function clearAutoExpand() {
    if (autoExpandTimer) {
      clearTimeout(autoExpandTimer);
      autoExpandTimer = null;
    }
    autoExpandKey = null;
  }

  function stopEdgeScroll() {
    if (edgeScrollRaf != null) {
      cancelAnimationFrame(edgeScrollRaf);
      edgeScrollRaf = null;
    }
    edgeScrollSpeed = 0;
  }

  function cleanup() {
    pending = null;
    dragging = false;
    dragState.value = null;
    clearAutoExpand();
    stopEdgeScroll();
    document.body.style.removeProperty("user-select");
    window.removeEventListener("pointermove", onPointerMove, true);
    window.removeEventListener("pointerup", onPointerUp, true);
    window.removeEventListener("pointercancel", onPointerCancel, true);
    window.removeEventListener("keydown", onKeyDown, true);
  }

  onBeforeUnmount(cleanup);

  /** 行内 y 比例 <25% before / >75% after / 其余 inside（vscode 四分 sector 的简化）。 */
  function sectorOf(offsetInRow: number): TreeDropPosition {
    const ratio = offsetInRow / options.rowHeight;
    if (ratio < 0.25) return "before";
    if (ratio > 0.75) return "after";
    return "inside";
  }

  function hitTest(clientX: number, clientY: number): {
    target: TreeNodeHandle<T> | null;
    sector: TreeDropPosition;
    rowTop: number | null;
  } {
    const scroller = options.scroller.value;
    if (!scroller) return { target: null, sector: "inside", rowTop: null };
    const rect = scroller.getBoundingClientRect();
    if (
      clientX < rect.left ||
      clientX > rect.right ||
      clientY < rect.top ||
      clientY > rect.bottom
    ) {
      return { target: null, sector: "inside", rowTop: null };
    }
    const yInContent = clientY - rect.top + scroller.scrollTop;
    const index = Math.floor(yInContent / options.rowHeight);
    const rows = options.rows.value;
    if (index < 0 || index >= rows.length) {
      return { target: null, sector: "inside", rowTop: null };
    }
    const row = rows[index];
    if (row.kind !== "node") {
      // section-header / separator 行 → 交消费者裁决（target=null）
      return { target: null, sector: "inside", rowTop: null };
    }
    const offsetInRow = yInContent - index * options.rowHeight;
    return {
      target: row.node,
      sector: sectorOf(offsetInRow),
      rowTop: index * options.rowHeight,
    };
  }

  function updateEdgeScroll(clientY: number) {
    const scroller = options.scroller.value;
    if (!scroller) return;
    const rect = scroller.getBoundingClientRect();
    let speed = 0;
    if (clientY < rect.top + EDGE_SCROLL_ZONE_PX) {
      speed = -EDGE_SCROLL_MAX_PX_PER_FRAME *
        Math.min(1, (rect.top + EDGE_SCROLL_ZONE_PX - clientY) / EDGE_SCROLL_ZONE_PX);
    } else if (clientY > rect.bottom - EDGE_SCROLL_ZONE_PX) {
      speed = EDGE_SCROLL_MAX_PX_PER_FRAME *
        Math.min(1, (clientY - (rect.bottom - EDGE_SCROLL_ZONE_PX)) / EDGE_SCROLL_ZONE_PX);
    }
    edgeScrollSpeed = speed;
    if (speed !== 0 && edgeScrollRaf == null) {
      const step = () => {
        edgeScrollRaf = null;
        const el = options.scroller.value;
        if (!el || !dragging || edgeScrollSpeed === 0) return;
        el.scrollTop += edgeScrollSpeed;
        // 滚动改变了行命中：按最近一次指针位置重算
        refreshOver(lastClientX, lastClientY);
        edgeScrollRaf = requestAnimationFrame(step);
      };
      edgeScrollRaf = requestAnimationFrame(step);
    }
    if (speed === 0) stopEdgeScroll();
  }

  function refreshOver(clientX: number, clientY: number) {
    const controller = options.controller();
    const state = dragState.value;
    if (!controller || !state) return;
    const source = options.nodeByKey(state.sourceKey);
    if (!source) {
      cleanup();
      return;
    }
    const { target, sector, rowTop } = hitTest(clientX, clientY);
    // 落到源自身：视为无效落点（原地）
    const isSelf = target?.key === state.sourceKey;
    const raw = isSelf
      ? false
      : controller.onDragOver(source.element, target?.element ?? null, sector);
    const reaction: TreeDragOverReaction =
      typeof raw === "boolean" ? { accept: raw } : raw;
    const position = reaction.position ?? sector;

    // 悬停自动展开（同一节点持续悬停 AUTO_EXPAND_DELAY_MS）
    const wantAutoExpand =
      reaction.accept !== false &&
      reaction.autoExpand &&
      target &&
      target.hasChildren &&
      !target.expanded;
    if (wantAutoExpand && target) {
      if (autoExpandKey !== target.key) {
        clearAutoExpand();
        autoExpandKey = target.key;
        autoExpandTimer = setTimeout(() => {
          const key = autoExpandKey;
          autoExpandTimer = null;
          autoExpandKey = null;
          if (key && dragging) void options.expand(key);
        }, AUTO_EXPAND_DELAY_MS);
      }
    } else {
      clearAutoExpand();
    }

    let insertLine: TreeDragState<T>["insertLine"] = null;
    if (reaction.accept && target && rowTop != null && position !== "inside") {
      insertLine = {
        top: position === "before" ? rowTop : rowTop + options.rowHeight,
        indent: 26 + target.depth * options.indentPx,
      };
    }

    dragState.value = {
      ...state,
      x: clientX,
      y: clientY,
      targetKey: target?.key ?? null,
      position,
      accept: reaction.accept,
      insertLine,
    };
  }

  function onPointerMove(ev: PointerEvent) {
    lastClientX = ev.clientX;
    lastClientY = ev.clientY;
    if (!dragging && pending) {
      if (ev.pointerId !== pending.pointerId) return;
      const dx = ev.clientX - pending.startX;
      const dy = ev.clientY - pending.startY;
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
      const controller = options.controller();
      const handle = options.nodeByKey(pending.key);
      if (!controller || !handle || !controller.canDrag(handle.element)) {
        pending = null;
        return;
      }
      dragging = true;
      document.body.style.userSelect = "none";
      const label =
        controller.getDragLabel?.(handle.element) ??
        options.getDefaultLabel(handle.element);
      dragState.value = {
        sourceKey: pending.key,
        label,
        x: ev.clientX,
        y: ev.clientY,
        targetKey: null,
        position: "inside",
        accept: false,
        insertLine: null,
      };
      pending = null;
    }
    if (!dragging) return;
    ev.preventDefault();
    refreshOver(ev.clientX, ev.clientY);
    updateEdgeScroll(ev.clientY);
  }

  async function onPointerUp(ev: PointerEvent) {
    if (!dragging) {
      pending = null;
      cleanup();
      return;
    }
    const controller = options.controller();
    const state = dragState.value;
    // 先读取状态再清理 UI
    cleanup();
    if (!controller || !state || !state.accept) return;
    const source = options.nodeByKey(state.sourceKey);
    if (!source) return;
    const target = state.targetKey ? options.nodeByKey(state.targetKey) : null;
    if (state.targetKey && !target) return;
    void ev;
    await controller.drop(source.element, target?.element ?? null, state.position);
  }

  function onPointerCancel() {
    cleanup();
  }

  function onKeyDown(ev: KeyboardEvent) {
    if (ev.key === "Escape" && (dragging || pending)) {
      ev.stopPropagation();
      cleanup();
    }
  }

  /** 由行的 pointerdown 调用（主键、非 twistie 区域）。 */
  function onRowPointerDown(key: string, ev: PointerEvent) {
    const controller = options.controller();
    if (!controller) return;
    if (ev.button !== 0) return;
    // touch 默认不启用（与滚动冲突）；需要时再加长按启动
    if (ev.pointerType === "touch") return;
    const handle = options.nodeByKey(key);
    if (!handle || !controller.canDrag(handle.element)) return;
    pending = { key, pointerId: ev.pointerId, startX: ev.clientX, startY: ev.clientY };
    window.addEventListener("pointermove", onPointerMove, true);
    window.addEventListener("pointerup", onPointerUp, true);
    window.addEventListener("pointercancel", onPointerCancel, true);
    window.addEventListener("keydown", onKeyDown, true);
  }

  return {
    dragState,
    onRowPointerDown,
    isDragging: () => dragging,
  };
}
