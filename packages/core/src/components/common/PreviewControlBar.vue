<template>
  <div
    ref="hotzoneRef"
    class="preview-control-bar-hover-zone"
    :class="{ 'is-fullscreen': isFullscreen }"
    @mouseenter="handleHotzoneEnter"
    @mouseleave="handleHotzoneLeave"
  />
  <div
    ref="controlsRef"
    class="preview-control-bar"
    :class="{ hidden: !controlsVisible, 'is-fullscreen': isFullscreen }"
    @mouseenter="handleControlsEnter"
    @mouseleave="handleControlsLeave"
  >
    <slot />
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, ref } from "vue";

const props = withDefaults(
  defineProps<{
    isFullscreen?: boolean;
    keepVisible?: boolean;
  }>(),
  {
    isFullscreen: false,
    keepVisible: false,
  }
);

const controlsVisible = ref(false);
const isPointerInside = ref(false);
const hotzoneRef = ref<HTMLElement | null>(null);
const controlsRef = ref<HTMLElement | null>(null);

let hideTimer: ReturnType<typeof setTimeout> | null = null;

const clearHideTimer = () => {
  if (!hideTimer) return;
  clearTimeout(hideTimer);
  hideTimer = null;
};

const scheduleHideControls = (delay = 1000) => {
  clearHideTimer();
  hideTimer = setTimeout(() => {
    if (isPointerInside.value || props.keepVisible) return;
    controlsVisible.value = false;
    hideTimer = null;
  }, delay);
};

const showControls = () => {
  controlsVisible.value = true;
  clearHideTimer();
};

const pointInRect = (x: number, y: number, rect: DOMRect) =>
  x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;

const isPointerInInteractiveArea = (x: number, y: number) => {
  const hotzoneRect = hotzoneRef.value?.getBoundingClientRect();
  if (hotzoneRect && pointInRect(x, y, hotzoneRect)) return true;
  const controlsRect = controlsRef.value?.getBoundingClientRect();
  return !!controlsRect && pointInRect(x, y, controlsRect);
};

const refreshPointerPosition = (event?: MouseEvent | PointerEvent | null, delay = 1000) => {
  if (!event) {
    isPointerInside.value = false;
    scheduleHideControls(delay);
    return;
  }
  isPointerInside.value = isPointerInInteractiveArea(event.clientX, event.clientY);
  if (isPointerInside.value) {
    showControls();
  } else {
    scheduleHideControls(delay);
  }
};

function handleHotzoneEnter() {
  isPointerInside.value = true;
  showControls();
}

function handleHotzoneLeave() {
  isPointerInside.value = false;
  scheduleHideControls(1000);
}

function handleControlsEnter() {
  isPointerInside.value = true;
  showControls();
}

function handleControlsLeave() {
  isPointerInside.value = false;
  scheduleHideControls(1000);
}

onBeforeUnmount(() => {
  clearHideTimer();
});

defineExpose({
  show: showControls,
  scheduleHide: scheduleHideControls,
  refreshPointerPosition,
});
</script>

<style scoped lang="scss">
.preview-control-bar-hover-zone {
  position: absolute;
  left: 20%;
  right: 20%;
  bottom: 0;
  height: 76px;
  z-index: 3;

  &.is-fullscreen {
    left: 5%;
    right: 5%;
  }
}

.preview-control-bar {
  position: absolute;
  left: 20%;
  right: 20%;
  bottom: 16px;
  z-index: 4;
  min-height: 44px;
  padding: 8px 10px;
  border-radius: 12px;
  display: flex;
  align-items: center;
  gap: 10px;
  color: #fff;
  background: rgba(15, 16, 20, 0.56);
  backdrop-filter: blur(8px);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
  opacity: 1;
  pointer-events: auto;
  transition: opacity 0.2s ease;

  &.hidden {
    opacity: 0;
    pointer-events: none;
  }

  &.is-fullscreen {
    left: 5%;
    right: 5%;
  }
}

:deep(.control-btn) {
  width: 30px;
  height: 30px;
  border: none;
  border-radius: 999px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: inherit;
  background: rgba(255, 255, 255, 0.1);
  cursor: pointer;
  transition: background-color 0.16s ease;

  &:hover {
    background: rgba(255, 255, 255, 0.2);
  }

  svg {
    width: 18px;
    height: 18px;
    fill: currentColor;
  }
}

:deep(.time-text) {
  width: 110px;
  font-size: 12px;
  line-height: 1;
  text-align: center;
  user-select: none;
  color: rgba(255, 255, 255, 0.92);
}

:deep(.control-bar-spacer) {
  flex: 1;
}
</style>
