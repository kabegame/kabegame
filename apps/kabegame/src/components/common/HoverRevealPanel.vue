<template>
  <!-- 触发器包一层锚点元素：定位只需要它的 rect，不改子节点自身的盒模型职责 -->
  <div
    class="hover-reveal"
    @mouseenter="onTriggerMouseenter"
    @mouseleave="onTriggerMouseleave"
    @touchstart="onTouchStart"
    @touchmove="onTouchMove"
    @touchend="onTouchEnd"
  >
    <slot />

    <!-- 桌面 hover：贴触发元素弹出，跟随翻转/贴边定位 -->
    <Teleport to="body">
      <div
        v-if="visible && !compact"
        ref="panelRef"
        :style="panelStyle"
        @mouseenter="cancelScheduledClose"
        @mouseleave="onPanelMouseleave"
        @click="handlePanelClick"
      >
        <slot name="panel" />
      </div>
    </Teleport>

    <!-- 紧凑端长按：同一张面板以底部抽屉形态展现。首次触发后才挂载，避免长列表里
         每个触发器都常驻一个 drawer 实例 -->
    <el-drawer
      v-if="drawerMounted"
      :model-value="visible && compact"
      direction="btt"
      size="auto"
      :with-header="false"
      append-to-body
      :class="drawerClass"
      @update:model-value="(v: boolean) => (v ? null : close())"
      @click="handlePanelClick"
    >
      <div class="hover-reveal-drawer-body">
        <slot name="panel" />
      </div>
    </el-drawer>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch, type CSSProperties } from "vue";
import { ElDrawer, useZIndex } from "@kabegame/element-plus";
import { useUiStore } from "../../stores/ui";

const LONG_PRESS_MS = 500;
const LONG_PRESS_MOVE_TOLERANCE_PX = 10;
const PANEL_GAP = 12;
const VIEWPORT_MARGIN = 12;

/**
 * 悬浮揭示面板：hover（桌面）/ 长按（紧凑端）在触发元素旁弹出一张面板。
 *
 * 只管「何时显示、贴哪」，面板内容由 `panel` 插槽给出——避免这个通用组件反向依赖
 * 某个具体页面的数据形状。桌面面板贴触发元素右侧，右边放不下则翻到左侧，并夹在视口内。
 */
const props = withDefaults(
  defineProps<{
    /** 为真时完全不弹（如「全部」这类没有可预览内容的行） */
    disabled?: boolean;
    openDelay?: number;
    closeDelay?: number;
    /** 面板宽度（px），仅用于定位计算；实际宽度由面板内容自己决定，两者应一致 */
    panelWidth?: number;
    /** 紧凑端是否支持长按弹出底部抽屉 */
    longPress?: boolean;
    /** 透传给紧凑端抽屉的 class（抽屉 append-to-body，样式需由非 scoped 规则命中） */
    drawerClass?: string;
  }>(),
  {
    disabled: false,
    openDelay: 400,
    closeDelay: 200,
    panelWidth: 320,
    longPress: true,
    drawerClass: undefined,
  },
);

const emit = defineEmits<{
  /** 面板被点击（桌面浮层或紧凑端抽屉）；组件已自行关闭 */
  "panel-click": [];
}>();

const uiStore = useUiStore();
const { nextZIndex } = useZIndex();
const compact = computed(() => uiStore.isCompact);

const visible = ref(false);
const drawerMounted = ref(false);
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

// 面板可能弹在 dialog 内的 select 下拉之上，固定 z-index 会被压住；打开时向 EP 的
// 全局计数要一个当前最高层级。
const panelZIndex = ref(2000);

const positionPanel = () => {
  if (!anchorEl) return;
  const anchorRect = anchorEl.getBoundingClientRect();
  const panelEl = panelRef.value;
  const panelHeight = panelEl?.offsetHeight || 460;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  let left = anchorRect.right + PANEL_GAP;
  if (left + props.panelWidth + VIEWPORT_MARGIN > vw) {
    // 右侧放不下：翻到触发元素左边
    left = anchorRect.left - props.panelWidth - PANEL_GAP;
  }
  left = Math.max(VIEWPORT_MARGIN, Math.min(left, vw - props.panelWidth - VIEWPORT_MARGIN));

  let top = anchorRect.top;
  top = Math.max(VIEWPORT_MARGIN, Math.min(top, vh - panelHeight - VIEWPORT_MARGIN));

  panelStyle.value = {
    position: "fixed",
    left: `${left}px`,
    top: `${top}px`,
    zIndex: panelZIndex.value,
  };
};

const show = async (el: HTMLElement) => {
  anchorEl = el;
  if (compact.value) {
    if (!drawerMounted.value) {
      drawerMounted.value = true;
      await nextTick();
    }
    visible.value = true;
    return;
  }
  panelZIndex.value = nextZIndex();
  visible.value = true;
  await nextTick();
  positionPanel();
};

const close = () => {
  clearOpenTimer();
  clearCloseTimer();
  visible.value = false;
  anchorEl = null;
};

const scheduleClose = () => {
  clearCloseTimer();
  closeTimer = setTimeout(close, props.closeDelay);
};

const cancelScheduledClose = () => {
  clearCloseTimer();
};

// ---- 桌面 hover ----
const onTriggerMouseenter = (event: MouseEvent) => {
  if (compact.value || props.disabled) return;
  cancelScheduledClose();
  clearOpenTimer();
  const el = event.currentTarget as HTMLElement;
  openTimer = setTimeout(() => {
    openTimer = null;
    void show(el);
  }, props.openDelay);
};

const onTriggerMouseleave = () => {
  if (compact.value) return;
  clearOpenTimer();
  if (visible.value) scheduleClose();
};

const onPanelMouseleave = () => {
  if (!compact.value) scheduleClose();
};

const handlePanelClick = () => {
  close();
  emit("panel-click");
};

// ---- 紧凑端长按 ----
let longPressTimer: ReturnType<typeof setTimeout> | null = null;
let longPressFired = false;
let touchStart = { x: 0, y: 0 };
let touchMoved = false;

const onTouchStart = (event: TouchEvent) => {
  if (!compact.value || props.disabled || !props.longPress) return;
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
    void show(el);
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

// 长按已触发时吞掉本次 touchend 的合成 click，避免抽屉刚弹出又被当作点击触发器直接跳转。
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

// 触发元素可能随页面/下拉列表滚动而移动，面板是 fixed 的，需要跟着重算。
const onViewportChange = () => {
  if (visible.value && !compact.value) positionPanel();
};

const bindViewportListeners = () => {
  window.addEventListener("scroll", onViewportChange, true);
  window.addEventListener("resize", onViewportChange);
};
const unbindViewportListeners = () => {
  window.removeEventListener("scroll", onViewportChange, true);
  window.removeEventListener("resize", onViewportChange);
};

watch(visible, (v) => {
  if (v && !compact.value) bindViewportListeners();
  else unbindViewportListeners();
});

watch(
  () => props.disabled,
  (v) => {
    if (v) close();
  },
);

onBeforeUnmount(() => {
  clearOpenTimer();
  clearCloseTimer();
  if (longPressTimer) clearTimeout(longPressTimer);
  unbindViewportListeners();
});

defineExpose({ close });
</script>

<style scoped lang="scss">
/* 紧凑端抽屉：面板铺满宽度、贴底圆角。面板本体的宽度/圆角/阴影是它作为悬浮卡片的
   样式，权重与这里相同且注入顺序不定，只能用 !important 明确覆盖。 */
:deep(.el-drawer__body) {
  padding: 0;
}

.hover-reveal-drawer-body {
  display: flex;
  justify-content: center;
}

.hover-reveal-drawer-body :deep(> *) {
  width: 100% !important;
  max-width: 420px;
  border-radius: 18px 18px 0 0 !important;
  box-shadow: none !important;
  border: none !important;
}
</style>
