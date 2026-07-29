import { computed, nextTick, onBeforeUnmount, ref, type CSSProperties } from "vue";
import { useUiStore } from "../stores/ui";

const OPEN_DELAY_MS = 400;
const CLOSE_DELAY_MS = 200;
const LONG_PRESS_MS = 500;
const LONG_PRESS_MOVE_TOLERANCE_PX = 10;
const PANEL_WIDTH = 320;
const PANEL_GAP = 12;
const VIEWPORT_MARGIN = 12;

/**
 * 插件卡片 hover 快捷预览的交互逻辑（桌面 hover 悬浮面板 / 紧凑端长按底部抽屉）。
 * 只管"何时显示、显示谁、贴哪"，不关心预览内容怎么来——内容由调用方按 activeItem 自行装配，
 * 避免这个可复用 composable 反向依赖某个具体页面的数据形状。
 */
export function usePluginQuickPreview<T>() {
  const uiStore = useUiStore();
  const compact = computed(() => uiStore.isCompact);

  const visible = ref(false);
  const activeItem = ref<T | null>(null) as import("vue").Ref<T | null>;
  const panelRef = ref<HTMLElement | null>(null);
  const panelStyle = ref<CSSProperties>({});

  let openTimer: ReturnType<typeof setTimeout> | null = null;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;
  let anchorEl: HTMLElement | null = null;

  const clearOpenTimer = () => {
    if (openTimer) {
      clearTimeout(openTimer);
      openTimer = null;
    }
  };
  const clearCloseTimer = () => {
    if (closeTimer) {
      clearTimeout(closeTimer);
      closeTimer = null;
    }
  };

  const positionPanel = () => {
    if (!anchorEl) return;
    const anchorRect = anchorEl.getBoundingClientRect();
    const panelEl = panelRef.value;
    const panelHeight = panelEl?.offsetHeight || 460;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let left = anchorRect.right + PANEL_GAP;
    if (left + PANEL_WIDTH + VIEWPORT_MARGIN > vw) {
      // 右侧放不下：翻到卡片左边
      left = anchorRect.left - PANEL_WIDTH - PANEL_GAP;
    }
    left = Math.max(VIEWPORT_MARGIN, Math.min(left, vw - PANEL_WIDTH - VIEWPORT_MARGIN));

    let top = anchorRect.top;
    top = Math.max(VIEWPORT_MARGIN, Math.min(top, vh - panelHeight - VIEWPORT_MARGIN));

    panelStyle.value = {
      position: "fixed",
      left: `${left}px`,
      top: `${top}px`,
      zIndex: 2000,
    };
  };

  const show = (item: T, el: HTMLElement) => {
    anchorEl = el;
    activeItem.value = item;
    visible.value = true;
    void nextTick(positionPanel);
  };

  const close = () => {
    clearOpenTimer();
    clearCloseTimer();
    visible.value = false;
    anchorEl = null;
  };

  const scheduleClose = () => {
    clearCloseTimer();
    closeTimer = setTimeout(close, CLOSE_DELAY_MS);
  };

  const cancelScheduledClose = () => {
    clearCloseTimer();
  };

  // ---- 桌面 hover ----
  const onCardMouseenter = (item: T, event: MouseEvent) => {
    if (compact.value) return;
    cancelScheduledClose();
    clearOpenTimer();
    const el = event.currentTarget as HTMLElement;
    openTimer = setTimeout(() => {
      openTimer = null;
      show(item, el);
    }, OPEN_DELAY_MS);
  };

  const onCardMouseleave = () => {
    if (compact.value) return;
    clearOpenTimer();
    if (visible.value) scheduleClose();
  };

  // 供 `v-on="cardListeners(item)"` 使用：对象语法的键是事件名本身，不带 `on` 前缀。
  const cardListeners = (item: T) => ({
    mouseenter: (e: MouseEvent) => onCardMouseenter(item, e),
    mouseleave: onCardMouseleave,
    touchstart: (e: TouchEvent) => onTouchStart(item, e),
    touchmove: onTouchMove,
    touchend: onTouchEnd,
  });

  const panelListeners = {
    mouseenter: cancelScheduledClose,
    mouseleave: () => {
      if (!compact.value) scheduleClose();
    },
  };

  // ---- 紧凑端长按 ----
  let longPressTimer: ReturnType<typeof setTimeout> | null = null;
  let longPressFired = false;
  let touchStart = { x: 0, y: 0 };
  let touchMoved = false;

  const onTouchStart = (item: T, event: TouchEvent) => {
    if (!compact.value) return;
    if (event.touches.length !== 1) return;
    const touch = event.touches[0];
    touchStart = { x: touch.clientX, y: touch.clientY };
    touchMoved = false;
    longPressFired = false;
    const el = event.currentTarget as HTMLElement;
    longPressTimer = setTimeout(() => {
      longPressTimer = null;
      if (touchMoved) return;
      longPressFired = true;
      show(item, el);
    }, LONG_PRESS_MS);
  };

  const onTouchMove = (event: TouchEvent) => {
    if (!compact.value || !longPressTimer) return;
    const touch = event.touches[0];
    const dx = Math.abs(touch.clientX - touchStart.x);
    const dy = Math.abs(touch.clientY - touchStart.y);
    if (dx > LONG_PRESS_MOVE_TOLERANCE_PX || dy > LONG_PRESS_MOVE_TOLERANCE_PX) {
      touchMoved = true;
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
  };

  // 长按已触发时吞掉本次 touchend 的合成 click，避免抽屉刚弹出又被当作点击卡片直接跳转详情。
  const onTouchEnd = (event: TouchEvent) => {
    if (longPressTimer) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
    if (longPressFired) {
      event.preventDefault();
      longPressFired = false;
    }
  };

  onBeforeUnmount(() => {
    clearOpenTimer();
    clearCloseTimer();
    if (longPressTimer) clearTimeout(longPressTimer);
  });

  return {
    visible,
    compact,
    activeItem,
    panelRef,
    panelStyle,
    cardListeners,
    panelListeners,
    close,
  };
}
