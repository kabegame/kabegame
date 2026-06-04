<template>
  <Teleport to="body">
    <div
      v-if="kamechanEnabled"
      ref="hostEl"
      class="kamechan-host"
      :class="{ 'is-minimized': minimized, 'is-dragging': isDragging }"
      :style="hostStyle"
      @contextmenu.prevent="showMenu"
      @touchstart.passive="handleTouchStart"
      @touchmove.passive="cancelLongPress"
      @touchend.passive="cancelLongPress"
      @touchcancel.passive="cancelLongPress"
    >
      <KameBubble
        :text="currentMessage?.text ?? ''"
        :type="currentMessage?.type ?? 'info'"
        :visible="!!currentMessage"
        :more-text="moreText"
        :side="bubbleSide"
        :max-width="bubbleMaxWidth"
        :compact="minimized"
      />

      <button
        v-if="minimized"
        class="kamechan-minimized"
        type="button"
        aria-label="Kamechan"
        title="Kamechan"
        @pointerdown="startDrag"
        @click="handleMinimizedClick"
      >
        <img :src="appLogoUrl" alt="" draggable="false" />
      </button>

      <button
        v-else
        class="kamechan-mascot"
        :class="`is-${state}`"
        type="button"
        aria-label="Kamechan"
        title="Kamechan"
        @pointerdown="startDrag"
        @click="handleMascotClick"
      >
        <img
          class="kamechan-mascot__image"
          :src="imageSrc"
          alt=""
          draggable="false"
        />
      </button>

    </div>
    <ActionRenderer
      :visible="menuVisible"
      :position="menuPosition"
      :actions="actions"
      :context="actionContext"
      :z-index="2000"
      @close="hideMenu"
      @command="handleCommand"
    />
    <KamechanHistoryDialog v-model="historyVisible" />
  </Teleport>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, type CSSProperties } from "vue";
import { storeToRefs } from "pinia";
import { Clock, Hide, Minus } from "@element-plus/icons-vue";
import ActionRenderer from "@kabegame/core/components/ActionRenderer.vue";
import { useActionMenu } from "@kabegame/core/composables/useActionMenu";
import { useKameMessageStore } from "@kabegame/core/stores/kameMessage";
import { useSettingsStore } from "@kabegame/core/stores/settings";
import type { ActionContext, ActionItem } from "@kabegame/core/actions/types";
import { useI18n } from "@kabegame/i18n";
import appLogoUrl from "@/assets/icon-small.png";
import { useKamechanMachine } from "./useKamechanMachine";
import KameBubble from "./KameBubble.vue";
import KamechanHistoryDialog from "./KamechanHistoryDialog.vue";

const { t } = useI18n();
const store = useKameMessageStore();
const settingsStore = useSettingsStore();
const { queue } = storeToRefs(store);
const {
  state,
  imageSrc,
  wave,
} = useKamechanMachine();

const minimized = ref(false);
const historyVisible = ref(false);
const hostEl = ref<HTMLElement | null>(null);
const position = ref<{ left: number; bottom: number } | null>(null);
const isDragging = ref(false);
const viewportSize = ref({
  width: typeof window === "undefined" ? 0 : window.innerWidth,
  height: typeof window === "undefined" ? 0 : window.innerHeight,
});
let longPressTimer: ReturnType<typeof setTimeout> | null = null;

const positionStorageKey = "kabegame:kamechan-position";
const minimizedStorageKey = "kabegame:kamechan-minimized";
const dragThresholdPx = 5;
const viewportMarginPx = 8;
const bubbleViewportMarginPx = 12;
const bubblePreferredWidthPx = 260;
const bubbleMaxWidthPx = 320;
const bubbleMinWidthPx = 160;

let dragState: {
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startLeft: number;
  startBottom: number;
  hostWidth: number;
  hostHeight: number;
  dragged: boolean;
} | null = null;
let suppressNextClick = false;

const {
  visible: menuVisible,
  position: menuPosition,
  show: showActionMenu,
  hide: hideMenu,
} = useActionMenu<"kamechan">();

const currentMessage = computed(() => queue.value[queue.value.length - 1] ?? null);
const queuedExtraCount = computed(() => Math.max(0, queue.value.length - 1));
const kamechanEnabled = computed(() => settingsStore.values.kamechanEnabled !== false);
const moreText = computed(() =>
  queuedExtraCount.value > 0
    ? t("kamechan.moreMessages", { count: queuedExtraCount.value })
    : ""
);

const actions = computed<ActionItem<"kamechan">[]>(() => [
  {
    key: "history",
    command: "history",
    label: t("kamechan.history"),
    icon: Clock,
  },
  {
    key: "minimize",
    command: "minimize",
    label: t("kamechan.minimize"),
    icon: Minus,
  },
  {
    key: "disable",
    command: "disable",
    label: t("kamechan.disable"),
    icon: Hide,
    dividerBefore: true,
  },
]);

const actionContext = computed<ActionContext<"kamechan">>(() => ({
  target: "kamechan",
  selectedIds: new Set<string>(),
  selectedCount: 0,
}));

const hostStyle = computed<CSSProperties>(() => {
  if (!position.value) return {};
  return {
    left: `${position.value.left}px`,
    bottom: `${position.value.bottom}px`,
  };
});

const hostMetrics = computed(() => {
  const rect = hostEl.value?.getBoundingClientRect();
  const fallbackWidth = viewportSize.value.width <= 520
    ? minimized.value ? 48 : 96
    : minimized.value ? 54 : 128;
  const fallbackLeft = position.value?.left ?? (viewportSize.value.width <= 520 ? 10 : 18);

  return {
    left: rect?.left ?? fallbackLeft,
    width: rect?.width ?? fallbackWidth,
  };
});

const bubbleSide = computed<"left" | "right">(() => {
  const { left, width } = hostMetrics.value;
  const anchorInset = getBubbleAnchorInset(width);
  const leftSpace = left + anchorInset - bubbleViewportMarginPx;
  const rightSpace = viewportSize.value.width - (left + width - anchorInset) - bubbleViewportMarginPx;

  return leftSpace < bubblePreferredWidthPx && rightSpace > leftSpace ? "right" : "left";
});

const bubbleMaxWidth = computed(() => {
  const { left, width } = hostMetrics.value;
  const anchorInset = getBubbleAnchorInset(width);
  const availableWidth = bubbleSide.value === "right"
    ? viewportSize.value.width - (left + width - anchorInset) - bubbleViewportMarginPx
    : left + anchorInset - bubbleViewportMarginPx;
  return `${Math.max(bubbleMinWidthPx, Math.min(bubbleMaxWidthPx, availableWidth))}px`;
});

function restore() {
  minimized.value = false;
  wave();
}

function handleMascotClick(event: MouseEvent) {
  if (consumeSuppressedClick(event)) return;
  wave();
}

function handleMinimizedClick(event: MouseEvent) {
  if (consumeSuppressedClick(event)) return;
  restore();
}

function handleCommand(command: string) {
  hideMenu();
  if (command === "history") {
    historyVisible.value = true;
    return;
  }
  if (command === "minimize") {
    minimized.value = true;
    return;
  }
  if (command === "disable") {
    void settingsStore.save("kamechanEnabled", false);
  }
}

function showMenu(event: MouseEvent) {
  cancelLongPress();
  showActionMenu("kamechan", event);
}

function cancelLongPress() {
  if (!longPressTimer) return;
  clearTimeout(longPressTimer);
  longPressTimer = null;
}

function handleTouchStart(event: TouchEvent) {
  cancelLongPress();
  const touch = event.touches[0];
  if (!touch) return;
  longPressTimer = setTimeout(() => {
    longPressTimer = null;
    const syntheticEvent = new MouseEvent("contextmenu", {
      clientX: touch.clientX,
      clientY: touch.clientY,
      bubbles: true,
      cancelable: true,
    });
    showActionMenu("kamechan", syntheticEvent);
  }, 520);
}

function startDrag(event: PointerEvent) {
  if (event.pointerType === "mouse" && event.button !== 0) return;
  const el = hostEl.value;
  if (!el) return;

  cleanupDrag();
  const rect = el.getBoundingClientRect();
  dragState = {
    pointerId: event.pointerId,
    startClientX: event.clientX,
    startClientY: event.clientY,
    startLeft: rect.left,
    startBottom: window.innerHeight - rect.bottom,
    hostWidth: rect.width,
    hostHeight: rect.height,
    dragged: false,
  };
  suppressNextClick = false;
  isDragging.value = false;

  window.addEventListener("pointermove", handleDragMove, { passive: false });
  window.addEventListener("pointerup", stopDrag, { passive: true });
  window.addEventListener("pointercancel", stopDrag, { passive: true });
}

function handleDragMove(event: PointerEvent) {
  if (!dragState || event.pointerId !== dragState.pointerId) return;

  const dx = event.clientX - dragState.startClientX;
  const dy = event.clientY - dragState.startClientY;
  const distance = Math.hypot(dx, dy);

  if (!dragState.dragged && distance < dragThresholdPx) return;

  event.preventDefault();
  cancelLongPress();
  dragState.dragged = true;
  suppressNextClick = true;
  isDragging.value = true;
  position.value = clampPosition({
    left: dragState.startLeft + dx,
    bottom: dragState.startBottom - dy,
  }, dragState.hostWidth, dragState.hostHeight);
}

function stopDrag(event: PointerEvent) {
  if (!dragState || event.pointerId !== dragState.pointerId) return;

  const shouldSave = dragState.dragged;
  cleanupDrag();
  if (shouldSave) {
    persistPosition();
  }
}

function cleanupDrag() {
  window.removeEventListener("pointermove", handleDragMove);
  window.removeEventListener("pointerup", stopDrag);
  window.removeEventListener("pointercancel", stopDrag);
  dragState = null;
  isDragging.value = false;
}

function consumeSuppressedClick(event: MouseEvent) {
  if (!suppressNextClick) return false;
  event.preventDefault();
  event.stopPropagation();
  suppressNextClick = false;
  return true;
}

function clampPosition(
  nextPosition: { left: number; bottom: number },
  hostWidth = hostEl.value?.getBoundingClientRect().width ?? 0,
  hostHeight = hostEl.value?.getBoundingClientRect().height ?? 0
) {
  const maxLeft = Math.max(viewportMarginPx, viewportSize.value.width - hostWidth - viewportMarginPx);
  const maxBottom = Math.max(viewportMarginPx, viewportSize.value.height - hostHeight - viewportMarginPx);
  return {
    left: Math.min(Math.max(viewportMarginPx, nextPosition.left), maxLeft),
    bottom: Math.min(Math.max(viewportMarginPx, nextPosition.bottom), maxBottom),
  };
}

function persistPosition() {
  if (!position.value) return;
  try {
    localStorage.setItem(positionStorageKey, JSON.stringify(position.value));
  } catch {
    // Ignore storage failures; dragging should still work for the current session.
  }
}

function persistMinimized() {
  try {
    localStorage.setItem(minimizedStorageKey, minimized.value ? "1" : "0");
  } catch {
    // Ignore storage failures; minimizing should still work for the current session.
  }
}

function restorePersistedMinimized() {
  try {
    minimized.value = localStorage.getItem(minimizedStorageKey) === "1";
  } catch {
    minimized.value = false;
  }
}

function restorePersistedPosition() {
  try {
    const raw = localStorage.getItem(positionStorageKey);
    if (!raw) return;
    const parsed = JSON.parse(raw) as Partial<{ left: number; bottom: number }>;
    if (typeof parsed.left !== "number" || typeof parsed.bottom !== "number") return;
    position.value = clampPosition({ left: parsed.left, bottom: parsed.bottom });
  } catch {
    position.value = null;
  }
}

function clampCurrentPosition() {
  updateViewportSize();
  if (!position.value) return;
  position.value = clampPosition(position.value);
  persistPosition();
}

function updateViewportSize() {
  viewportSize.value = {
    width: window.innerWidth,
    height: window.innerHeight,
  };
}

function getBubbleAnchorInset(hostWidth: number) {
  return hostWidth <= 180 ? 14 : 18;
}

watch(minimized, async () => {
  persistMinimized();
  await nextTick();
  clampCurrentPosition();
});

watch(kamechanEnabled, (enabled) => {
  if (!enabled) {
    hideMenu();
    store.closeKamechanQueue();
  }
});

onMounted(() => {
  updateViewportSize();
  void settingsStore.load("kamechanEnabled");
  restorePersistedMinimized();
  restorePersistedPosition();
  window.addEventListener("resize", clampCurrentPosition, { passive: true });

  for (const src of ["/kamechan/stand/stand.png", "/kamechan/wave/wave.png"]) {
    const image = new Image();
    image.src = src;
    void image.decode?.().catch(() => {});
  }
});

onBeforeUnmount(() => {
  cancelLongPress();
  cleanupDrag();
  window.removeEventListener("resize", clampCurrentPosition);
});
</script>

<style scoped lang="scss">
.kamechan-host {
  position: fixed;
  left: 18px;
  bottom: 18px;
  z-index: 1600;
  width: 128px;
  height: 264px;
  display: flex;
  align-items: flex-end;
  justify-content: center;
  pointer-events: none;
}

.kamechan-mascot,
.kamechan-minimized {
  appearance: none;
  border: 0;
  background: transparent;
  cursor: pointer;
  user-select: none;
  -webkit-user-drag: none;
  padding: 0;
  color: inherit;
  pointer-events: auto;
  touch-action: none;

  &:focus-visible {
    outline: 2px solid var(--anime-primary);
    outline-offset: 2px;
  }
}

.kamechan-mascot {
  position: relative;
  display: flex;
  align-items: flex-end;
  justify-content: center;
  width: 128px;
  height: 264px;
  overflow: hidden;
  transition: transform 0.16s ease;
}

.kamechan-mascot__image {
  display: block;
  width: auto;
  height: 264px;
  max-width: 176px;
  max-height: 264px;
  object-fit: contain;
  filter: drop-shadow(0 8px 14px rgba(119, 80, 160, 0.22));
  transform-origin: 50% 100%;
  transition: filter 0.16s ease;
  pointer-events: none;
}

.kamechan-mascot:hover {
  transform: translateY(-2px);
}

.kamechan-host.is-dragging .kamechan-mascot {
  cursor: grabbing;
  transform: none;
}

.kamechan-host.is-dragging .kamechan-minimized {
  cursor: grabbing;
}

.kamechan-mascot:hover .kamechan-mascot__image {
  filter: drop-shadow(0 10px 18px rgba(119, 80, 160, 0.28));
}

.kamechan-mascot:active {
  transform: translateY(1px);
}

.kamechan-mascot.is-waving {
  animation-name: kamechan-wave-bounce;
  animation-duration: 1.2s;
  animation-timing-function: ease;
}

.kamechan-minimized {
  position: absolute;
  left: 0;
  bottom: 0;
  width: 54px;
  height: 54px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.92);
  box-shadow: 0 8px 24px rgba(24, 24, 40, 0.2);
  backdrop-filter: blur(10px);

  img {
    display: block;
    width: 34px;
    height: 34px;
    object-fit: contain;
    pointer-events: none;
  }
}

.kamechan-host.is-minimized {
  width: 54px;
  height: 54px;
}

@keyframes kamechan-wave-bounce {
  0%,
  100% {
    transform: translateY(0) rotate(0deg);
  }

  24% {
    transform: translateY(-4px) rotate(-2deg);
  }

  52% {
    transform: translateY(-2px) rotate(2deg);
  }

  76% {
    transform: translateY(-3px) rotate(-1deg);
  }
}

@media (max-width: 520px) {
  .kamechan-host {
    width: 96px;
    height: 204px;
    left: max(10px, env(safe-area-inset-left));
    bottom: calc(74px + env(safe-area-inset-bottom));
  }

  .kamechan-mascot {
    width: 96px;
    height: 204px;
  }

  .kamechan-mascot__image {
    width: auto;
    height: 196px;
    max-width: 130px;
    max-height: 196px;
  }

  .kamechan-host.is-minimized {
    width: 48px;
    height: 48px;
  }

  .kamechan-minimized {
    width: 48px;
    height: 48px;
  }
}
</style>
