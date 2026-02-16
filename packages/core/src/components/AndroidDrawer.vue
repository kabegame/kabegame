<template>
  <div v-bind="$attrs">
    <Teleport to="body">
      <Transition name="android-drawer-fade">
        <div
          v-show="showWrap"
          class="android-drawer-wrap"
          @click.self="handleBackdropClick">
          <!-- 背景遮罩：透明度随 offset 变化 -->
          <div
            class="android-drawer-backdrop"
            :style="{ opacity: backdropOpacity }"
            @click="handleBackdropClick"
          />
          <!-- 抽屉面板：宽度 100%，可拖拽滑出 -->
          <div
            ref="panelRef"
            class="android-drawer-panel"
            :style="{ transform: `translateX(${offsetPx}px)` }"
            @touchstart="onTouchStart"
            @touchend="onTouchEnd"
          >
            <div class="android-drawer-panel-inner">
              <header class="android-drawer-header">
                <div class="android-drawer-header-content">
                  <slot name="header" />
                </div>
                <button
                  v-if="showCloseButton"
                  type="button"
                  class="android-drawer-close"
                  aria-label="关闭"
                  @click.stop.prevent="handleCloseClick"
                  @touchend.stop.prevent="handleCloseClick"
                >
                  <el-icon><Close /></el-icon>
                </button>
              </header>
              <div class="android-drawer-body">
                <slot />
              </div>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick, onUnmounted } from "vue";
import { Close } from "@element-plus/icons-vue";

defineOptions({ inheritAttrs: false });

const props = withDefaults(
  defineProps<{
    modelValue: boolean;
    /** 拖拽超过该比例（0~1）即关闭 */
    closeThreshold?: number;
    /** 是否显示右上角关闭按钮，默认 true */
    showCloseButton?: boolean;
  }>(),
  { closeThreshold: 0.25, showCloseButton: true }
);

const emit = defineEmits<{
  "update:modelValue": [value: boolean];
  open: [];
  opened: [];
  close: [];
  closed: [];
}>();

const panelRef = ref<HTMLElement | null>(null);
const panelWidthPx = ref(400);
const offsetPx = ref(400);
/** 关闭动画进行中时保持挂载，以便播放滑出动画 */
const isClosing = ref(false);

const showWrap = computed(() => props.modelValue || isClosing.value);

const backdropOpacity = computed(() => {
  if (panelWidthPx.value <= 0) return showWrap.value ? 1 : 0;
  const o = Math.max(0, Math.min(1, 1 - offsetPx.value / panelWidthPx.value));
  return o;
});

let touchStartX = 0;
let touchStartY = 0;
let touchStartOffset = 0;
let animating = false;
/** 一次触摸内只响应最先的方向：'horizontal' 只拖抽屉，'vertical' 只滚动 */
let touchIntent: "horizontal" | "vertical" | null = null;
const INTENT_THRESHOLD_PX = 10;
const OPEN_DURATION = 280;
const CLOSE_DURATION = 220;

function measurePanel() {
  if (!panelRef.value) return;
  panelWidthPx.value = panelRef.value.getBoundingClientRect().width;
}

function animateTo(targetPx: number, duration: number, onDone?: () => void) {
  animating = true;
  const start = offsetPx.value;
  const startTime = performance.now();
  const tick = (now: number) => {
    const elapsed = now - startTime;
    const t = Math.min(1, elapsed / duration);
    const ease = 1 - (1 - t) * (1 - t);
    offsetPx.value = start + (targetPx - start) * ease;
    if (t < 1) {
      requestAnimationFrame(tick);
    } else {
      animating = false;
      onDone?.();
    }
  };
  requestAnimationFrame(tick);
}

function open() {
  emit("open");
  isClosing.value = false;
  offsetPx.value = typeof window !== "undefined" ? window.innerWidth : 400;
  nextTick(() => {
    requestAnimationFrame(() => {
      measurePanel();
      offsetPx.value = panelWidthPx.value;
      animateTo(0, OPEN_DURATION, () => {
        emit("opened");
      });
    });
  });
}

function close() {
  if (isClosing.value || animating) return;
  emit("close");
  isClosing.value = true;
  animateTo(panelWidthPx.value, CLOSE_DURATION, () => {
    offsetPx.value = panelWidthPx.value;
    isClosing.value = false;
    emit("update:modelValue", false);
    emit("closed");
  });
}

function handleBackdropClick() {
  if (!animating) close();
}

function handleCloseClick() {
  close();
}

function onTouchStart(e: TouchEvent) {
  if (animating) return;
  const t = e.touches[0];
  if (t) {
    touchStartX = t.clientX;
    touchStartY = t.clientY;
    touchStartOffset = offsetPx.value;
    touchIntent = null;
  }
}

function onTouchMove(e: TouchEvent) {
  if (animating) return;
  const t = e.touches[0];
  if (!t) return;
  const dx = t.clientX - touchStartX;
  const dy = t.clientY - touchStartY;

  if (touchIntent === null) {
    const absDx = Math.abs(dx);
    const absDy = Math.abs(dy);
    if (absDx > INTENT_THRESHOLD_PX || absDy > INTENT_THRESHOLD_PX) {
      touchIntent = absDx >= absDy ? "horizontal" : "vertical";
    }
  }

  if (touchIntent === "horizontal") {
    const next = touchStartOffset + dx;
    offsetPx.value = Math.max(0, Math.min(panelWidthPx.value, next));
    e.preventDefault();
  }
}

function onTouchEnd() {
  touchIntent = null;
  if (animating) return;
  const threshold = panelWidthPx.value * props.closeThreshold;
  if (offsetPx.value >= threshold) {
    close();
  } else {
    animateTo(0, OPEN_DURATION);
  }
}

watch(
  () => props.modelValue,
  (val) => {
    if (val) {
      open();
    } else {
      if (!isClosing.value && offsetPx.value < panelWidthPx.value * 0.5) {
        close();
      } else {
        offsetPx.value = panelWidthPx.value;
        isClosing.value = false;
      }
    }
  }
);

let touchMoveCleanup: (() => void) | null = null;
watch(
  panelRef,
  (el) => {
    touchMoveCleanup?.();
    touchMoveCleanup = null;
    if (el) {
      el.addEventListener("touchmove", onTouchMove, { passive: false });
      touchMoveCleanup = () => {
        el.removeEventListener("touchmove", onTouchMove);
      };
    }
  },
  { immediate: true }
);
onUnmounted(() => {
  touchMoveCleanup?.();
});
</script>

<style scoped lang="scss">
.android-drawer-wrap {
  position: fixed;
  inset: 0;
  z-index: 2000;
  pointer-events: auto;
}

.android-drawer-backdrop {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  transition: opacity 0.15s ease-out;
  pointer-events: auto;
}

.android-drawer-panel {
  position: absolute;
  top: 0;
  right: 0;
  width: 100%;
  max-width: 100%;
  height: 100%;
  background: var(--anime-bg-card, #1e1e1e);
  box-shadow: -4px 0 24px rgba(0, 0, 0, 0.25);
  will-change: transform;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.android-drawer-panel-inner {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  padding-bottom: env(safe-area-inset-bottom);
}

.android-drawer-header {
  flex-shrink: 0;
  padding-top: calc(16px + env(safe-area-inset-top));
  padding-right: 12px;
  padding-bottom: 16px;
  padding-left: 20px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.android-drawer-header-content {
  flex: 1;
  min-width: 0;
}

.android-drawer-close {
  flex-shrink: 0;
  width: 36px;
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: var(--el-text-color-regular, rgba(255, 255, 255, 0.85));
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
  -webkit-tap-highlight-color: transparent;
  position: relative;
  z-index: 1;
}
.android-drawer-close:hover {
  background: rgba(255, 255, 255, 0.08);
  color: var(--el-text-color-primary, #fff);
}
.android-drawer-close:active {
  background: rgba(255, 255, 255, 0.12);
}
.android-drawer-close .el-icon {
  font-size: 20px;
}

.android-drawer-body {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
  -webkit-overflow-scrolling: touch;
  padding-left: 2em;
  padding-right: 2em;
}

.android-drawer-fade-enter-active,
.android-drawer-fade-leave-active {
  transition: opacity 0.2s ease;
}
.android-drawer-fade-enter-from,
.android-drawer-fade-leave-to {
  opacity: 0;
}
</style>
