<template>
  <div ref="containerEl" class="image-grid-container" :class="{ 'hide-scrollbar': hideScrollbar }">
    <slot name="before-grid" />

    <div
      class="image-grid-root"
      :class="{ 'is-zooming': isZoomingLayout, 'is-reordering': isReordering }"
      @click="handleRootClick"
      @contextmenu.prevent
    >
      <EmptyState v-if="images.length === 0 && showEmptyState" />

      <template v-else>
        <div
          v-if="enableVirtualScroll"
          class="image-grid"
          :class="{ 'reorder-mode': isReorderMode }"
          :style="gridStyle"
        >
          <ImageItem
            v-for="item in renderedItems"
            :key="item.image.id"
            :image="item.image"
            :image-url="getEffectiveImageUrl(item.image.id)"
            :image-click-action="settingsStore.values.imageClickAction || 'none'"
            :use-original="gridColumnsCount <= 2"
            :window-aspect-ratio="effectiveAspectRatio"
            :selected="effectiveSelectedIds.has(item.image.id)"
            :grid-columns="gridColumnsCount"
            :grid-index="item.index"
            :is-reorder-mode="isReorderMode"
            :reorder-selected="isReorderMode && reorderSourceIndex === item.index"
            @click="(e) => handleItemClick(item.image, item.index, e)"
            @dblclick="(e) => handleItemDblClick(item.image, item.index, e)"
            @contextmenu="(e) => handleItemContextMenu(item.image, item.index, e)"
            @long-press="() => handleLongPress(item.index)"
            @reorder-click="() => handleReorderClick(item.index)"
            @blob-url-invalid="handleBlobUrlInvalid"
          />
        </div>

        <transition-group
          v-else
          name="fade-in-list"
          tag="div"
          class="image-grid"
          :class="{ 'reorder-mode': isReorderMode }"
          :style="gridStyle"
        >
          <ImageItem
            v-for="(image, index) in images"
            :key="image.id"
            :image="image"
            :image-url="getEffectiveImageUrl(image.id)"
            :image-click-action="settingsStore.values.imageClickAction || 'none'"
            :use-original="gridColumnsCount <= 2"
            :window-aspect-ratio="effectiveAspectRatio"
            :selected="effectiveSelectedIds.has(image.id)"
            :grid-columns="gridColumnsCount"
            :grid-index="index"
            :is-reorder-mode="isReorderMode"
            :reorder-selected="isReorderMode && reorderSourceIndex === index"
            @click="(e) => handleItemClick(image, index, e)"
            @dblclick="(e) => handleItemDblClick(image, index, e)"
            @contextmenu="(e) => handleItemContextMenu(image, index, e)"
            @long-press="() => handleLongPress(index)"
            @reorder-click="() => handleReorderClick(index)"
            @blob-url-invalid="handleBlobUrlInvalid"
          />
        </transition-group>
      </template>

      <component
        :is="contextMenuComponent"
        v-if="enableContextMenu && contextMenuComponent"
        :visible="contextMenuVisible"
        :position="contextMenuPosition"
        :image="contextMenuImage"
        :selected-count="effectiveSelectedIds.size"
        :selected-image-ids="effectiveSelectedIds"
        @close="closeContextMenu"
        @command="handleContextMenuCommand"
      />

      <ImagePreviewDialog
        ref="previewRef"
        :images="images"
        :image-url-map="imageUrlMapForPreview"
        :context-menu-component="contextMenuComponent"
        @context-command="handlePreviewContextCommand"
      />
    </div>

    <slot name="footer" />
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch, type Component } from "vue";
import { useDebounceFn } from "@vueuse/core";
import ImageItem from "./ImageItem.vue";
import type { ImageInfo, ImageUrlMap } from "../../types/image";
import EmptyState from "../common/EmptyState.vue";
import ImagePreviewDialog from "../common/ImagePreviewDialog.vue";
import { useSettingsStore } from "../../stores/settings";
import { useUiStore } from "../../stores/ui";
import { useDragScroll } from "../../composables/useDragScroll";

// core 版：明确去掉 favorite/addToAlbum
export type ContextCommand =
  | "detail"
  | "copy"
  | "open"
  | "openFolder"
  | "wallpaper"
  | "exportToWE"
  | "exportToWEAuto"
  | "remove";

type MultiImagePayload = { selectedImageIds: ReadonlySet<string> };
type ImagePayload = { image: ImageInfo };

type ContextCommandPayloadMap = {
  open: ImagePayload;
  openFolder: ImagePayload;
  detail: ImagePayload;
  copy: ImagePayload & MultiImagePayload;
  wallpaper: ImagePayload & MultiImagePayload;
  exportToWE: ImagePayload & MultiImagePayload;
  exportToWEAuto: ImagePayload & MultiImagePayload;
  remove: ImagePayload & MultiImagePayload;
};

export type ContextCommandPayload<T extends ContextCommand = ContextCommand> = {
  command: T;
} & ContextCommandPayloadMap[T];

interface Props {
  images: ImageInfo[];
  imageUrlMap: ImageUrlMap;
  contextMenuComponent?: Component;
  onContextCommand?: (
    payload: ContextCommandPayload
  ) => ContextCommand | null | undefined | Promise<ContextCommand | null | undefined>;
  showEmptyState?: boolean;
  canReorder?: boolean;
  enableCtrlWheelAdjustColumns?: boolean;
  enableCtrlKeyAdjustColumns?: boolean;
  hideScrollbar?: boolean;
  scrollStableDelay?: number;
  enableScrollStableEmit?: boolean;
  enableVirtualScroll?: boolean;
  virtualOverscan?: number;
}

const props = defineProps<Props>();
const emit = defineEmits<{
  "scroll-stable": [];
  reorder: [payload: { aId: string; aOrder: number; bId: string; bOrder: number }];
  // 兼容旧 API（不再由 core 触发，但保留事件名避免上层 TS/模板报错）
  addedToAlbum: [];
}>();

const settingsStore = useSettingsStore();
const uiStore = useUiStore();
const showEmptyState = computed(() => props.showEmptyState ?? false);
const canReorder = computed(() => props.canReorder ?? true);
const enableContextMenu = computed(() => !!props.contextMenuComponent);
const enableCtrlWheelAdjustColumns = computed(() => props.enableCtrlWheelAdjustColumns ?? false);
const enableCtrlKeyAdjustColumns = computed(() => props.enableCtrlKeyAdjustColumns ?? false);
const hideScrollbar = computed(() => props.hideScrollbar ?? false);
const scrollStableDelay = computed(() => props.scrollStableDelay ?? 180);
const enableScrollStableEmit = computed(() => props.enableScrollStableEmit ?? true);
const enableVirtualScroll = computed(() => props.enableVirtualScroll ?? true);
const virtualOverscanRows = computed(() => Math.max(0, props.virtualOverscan ?? 8));

const images = computed(() => props.images || []);
const imageGridColumns = computed(() => uiStore.imageGridColumns);

// reorder 状态
const isReorderMode = ref(false);
const reorderSourceIndex = ref<number>(-1);

// 缩放动画标记（列数变化时）
const isZoomingLayout = ref(false);
let zoomAnimTimer: ReturnType<typeof setTimeout> | null = null;

const isReordering = ref(false);
let reorderAnimTimer: ReturnType<typeof setTimeout> | null = null;

const gridColumnsCount = computed(() => (imageGridColumns.value > 0 ? imageGridColumns.value : 1));
const gridGapPx = computed(() => Math.max(4, 16 - (gridColumnsCount.value - 1)));
const BASE_GRID_PADDING_Y = 6;
const BASE_GRID_PADDING_X = 8;

// 虚拟滚动测量
const measuredItemHeight = ref<number | null>(null);
const virtualStartRow = ref(0);
const virtualEndRow = ref(0);

const containerEl = ref<HTMLElement | null>(null);
useDragScroll(containerEl);

// 选择状态（内部维护）
const internalSelectedIds = ref<Set<string>>(new Set());
const lastSelectedIndex = ref<number>(-1);
const effectiveSelectedIds = computed<Set<string>>(() => internalSelectedIds.value);

// 预览与 context menu
const previewRef = ref<InstanceType<typeof ImagePreviewDialog> | null>(null);
const contextMenuVisible = ref(false);
const contextMenuImage = ref<ImageInfo | null>(null);
const contextMenuPosition = ref({ x: 0, y: 0 });

// 对 imageUrlMap 的本地覆盖：用于处理 Blob URL 失效重建后的缓存
const localUrlOverrides = ref<Record<string, { thumbnail?: string; original?: string }>>({});
const localBlobObjects = new Map<string, Blob>();

const getEffectiveImageUrl = (id: string) => {
  const base = props.imageUrlMap?.[id];
  const ov = localUrlOverrides.value?.[id];
  if (!ov) return base;
  return { ...(base || {}), ...(ov || {}) };
};
const imageUrlMapForPreview = computed(() => {
  const base = props.imageUrlMap || {};
  const ov = localUrlOverrides.value || {};
  const keys = Object.keys(ov);
  if (keys.length === 0) return base;
  const merged: Record<string, { thumbnail?: string; original?: string }> = { ...base };
  for (const id of keys) {
    merged[id] = { ...(base[id] || {}), ...(ov[id] || {}) };
  }
  return merged;
});

// 窗口宽高比（用于 item aspect ratio）
const windowAspectRatio = ref<number>(16 / 9);
const updateWindowAspectRatio = () => {
  windowAspectRatio.value = window.innerWidth / window.innerHeight;
};
const effectiveAspectRatio = computed(() => windowAspectRatio.value);

const estimatedItemHeight = () => {
  const container = containerEl.value;
  if (!container) return 240;
  const availableWidth =
    container.clientWidth - BASE_GRID_PADDING_X * 2 - gridGapPx.value * (gridColumnsCount.value - 1);
  const columnWidth = Math.max(1, availableWidth / gridColumnsCount.value);
  const ratio = windowAspectRatio.value || 16 / 9;
  return columnWidth / ratio;
};

const rowHeightWithGap = computed(() => {
  const h = measuredItemHeight.value ?? estimatedItemHeight();
  return h + gridGapPx.value;
});

const totalRows = computed(() => {
  if (gridColumnsCount.value <= 0) return 0;
  return Math.ceil(images.value.length / gridColumnsCount.value);
});

const virtualPaddingTop = computed(() => {
  if (!enableVirtualScroll.value) return 0;
  return virtualStartRow.value * rowHeightWithGap.value;
});

const virtualPaddingBottom = computed(() => {
  if (!enableVirtualScroll.value) return 0;
  const rowsAfter = Math.max(0, totalRows.value - (virtualEndRow.value + 1));
  return rowsAfter * rowHeightWithGap.value;
});

const updateVirtualRange = () => {
  if (!enableVirtualScroll.value) return;
  const container = containerEl.value;
  if (!container) return;
  const rh = rowHeightWithGap.value || 1;
  const scrollTop = Math.max(0, container.scrollTop);
  const height = container.clientHeight || 0;
  const startRow = Math.floor(scrollTop / rh);
  const endRow = Math.ceil((scrollTop + height) / rh);
  const overscan = virtualOverscanRows.value;
  const nextStart = Math.max(0, startRow - overscan);
  const nextEnd = Math.max(nextStart, Math.min(totalRows.value - 1, endRow + overscan));
  virtualStartRow.value = isFinite(nextStart) ? nextStart : 0;
  virtualEndRow.value = isFinite(nextEnd) ? nextEnd : 0;
};

const measureItemHeight = () => {
  if (!enableVirtualScroll.value) return;
  const grid = containerEl.value?.querySelector<HTMLElement>(".image-grid");
  const firstItem = grid?.querySelector<HTMLElement>(".image-item");
  if (firstItem) {
    measuredItemHeight.value = firstItem.getBoundingClientRect().height;
  } else {
    measuredItemHeight.value = estimatedItemHeight();
  }
};

const scheduleVirtualUpdate = () => {
  if (!enableVirtualScroll.value) return;
  requestAnimationFrame(() => {
    measureItemHeight();
    updateVirtualRange();
  });
};

const renderedItems = computed(() => {
  if (!enableVirtualScroll.value) return [];
  const cols = gridColumnsCount.value;
  const start = Math.max(0, virtualStartRow.value * cols);
  const end = Math.min(images.value.length, (virtualEndRow.value + 1) * cols);
  const out: Array<{ image: ImageInfo; index: number }> = [];
  for (let i = start; i < end; i++) {
    const img = images.value[i];
    if (img) out.push({ image: img, index: i });
  }
  return out;
});

const gridStyle = computed(() => {
  const columns = gridColumnsCount.value;
  const gap = gridGapPx.value;
  const paddingTop = BASE_GRID_PADDING_Y + (enableVirtualScroll.value ? virtualPaddingTop.value : 0);
  const paddingBottom = BASE_GRID_PADDING_Y + (enableVirtualScroll.value ? virtualPaddingBottom.value : 0);
  return {
    gridTemplateColumns: `repeat(${columns}, 1fr)`,
    gap: `${gap}px`,
    paddingTop: `${paddingTop}px`,
    paddingBottom: `${paddingBottom}px`,
    paddingLeft: `${BASE_GRID_PADDING_X}px`,
    paddingRight: `${BASE_GRID_PADDING_X}px`,
  } as any;
});

const closeContextMenu = () => {
  contextMenuVisible.value = false;
  contextMenuImage.value = null;
};

const openContextMenu = (image: ImageInfo, index: number, event: MouseEvent) => {
  contextMenuImage.value = image;
  contextMenuPosition.value = { x: event.clientX, y: event.clientY };
  contextMenuVisible.value = true;
  // 右键时同步选择逻辑
  const current = internalSelectedIds.value;
  if (current.size === 0 || !current.has(image.id)) {
    setSingleSelection(image.id, index);
  }
};

const setSingleSelection = (imageId: string, index: number) => {
  internalSelectedIds.value = new Set([imageId]);
  lastSelectedIndex.value = index;
};

const toggleSelection = (imageId: string, index: number) => {
  const next = new Set(internalSelectedIds.value);
  if (next.has(imageId)) next.delete(imageId);
  else next.add(imageId);
  internalSelectedIds.value = next;
  lastSelectedIndex.value = index;
};

const rangeSelect = (index: number) => {
  if (lastSelectedIndex.value === -1) return;
  const start = Math.min(lastSelectedIndex.value, index);
  const end = Math.max(lastSelectedIndex.value, index);
  const next = new Set(internalSelectedIds.value);
  for (let i = start; i <= end; i++) {
    const id = images.value[i]?.id;
    if (id) next.add(id);
  }
  internalSelectedIds.value = next;
};

const shouldIgnoreKeyTarget = (event: KeyboardEvent) => {
  const target = event.target as HTMLElement | null;
  const tag = target?.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target?.isContentEditable;
};

const handleRootClick = (event: MouseEvent) => {
  const target = event.target as HTMLElement | null;
  const clickedOutside =
    !target?.closest(".image-item") &&
    !target?.closest(".context-menu");

  if (contextMenuVisible.value) {
    closeContextMenu();
    return;
  }

  // 空白处点击：清理单选（多选保留），退出调整模式
  if (clickedOutside) {
    if (internalSelectedIds.value.size <= 1) {
      internalSelectedIds.value = new Set();
      lastSelectedIndex.value = -1;
    }
    exitReorderMode();
  }
};

const handleItemClick = (image: ImageInfo, index: number, event?: MouseEvent) => {
  if (!event) return;
  if (event.shiftKey) {
    rangeSelect(index);
    return;
  }
  if (event.ctrlKey || event.metaKey) {
    toggleSelection(image.id, index);
    return;
  }
  if (internalSelectedIds.value.size > 1 && internalSelectedIds.value.has(image.id)) {
    return;
  }
  setSingleSelection(image.id, index);
};

const handleItemDblClick = (image: ImageInfo, index: number, event?: MouseEvent) => {
  if (isReorderMode.value) {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    return;
  }
  const action = settingsStore.values.imageClickAction || "none";
  if (action === "preview") {
    previewRef.value?.open(index);
    return;
  }
  if (action === "open") {
    void dispatchContextCommand(buildContextPayload("open", image));
  }
};

const handleItemContextMenu = (image: ImageInfo, index: number, event: MouseEvent) => {
  if (isReorderMode.value) {
    exitReorderMode();
    return;
  }
  if (!enableContextMenu.value) return;
  openContextMenu(image, index, event);
};

const buildContextPayload = (command: ContextCommand, image: ImageInfo): ContextCommandPayload => {
  const selected = new Set(effectiveSelectedIds.value);
  switch (command) {
    case "open":
    case "openFolder":
      return { command, image } as any;
    default:
      return { command, image, selectedImageIds: selected } as any;
  }
};

const dispatchContextCommand = async (payload: ContextCommandPayload) => {
  await props.onContextCommand?.(payload);
};

const handleContextMenuCommand = (command: string) => {
  if (!contextMenuImage.value) return;
  const cmd = command as ContextCommand;
  const payload = buildContextPayload(cmd, contextMenuImage.value);
  closeContextMenu();
  void dispatchContextCommand(payload);
};

const handlePreviewContextCommand = (payload: { command: string; image: ImageInfo }) => {
  const cmd = payload.command as ContextCommand;
  void dispatchContextCommand(buildContextPayload(cmd, payload.image));
};

const handleBlobUrlInvalid = (payload: {
  oldUrl: string;
  newUrl: string;
  newBlob?: Blob;
  imageId: string;
  localPath: string;
}) => {
  if (!payload?.newUrl) return;
  const img = images.value.find((i) => i.id === payload.imageId);
  if (!img) return;
  if (payload.newUrl.startsWith("blob:") && payload.newBlob) {
    localBlobObjects.set(payload.newUrl, payload.newBlob);
  }
  const old = payload.oldUrl;
  if (old && old.startsWith("blob:") && localBlobObjects.has(old)) {
    setTimeout(() => {
      if (!localBlobObjects.has(old)) return;
      try { URL.revokeObjectURL(old); } catch { }
      localBlobObjects.delete(old);
    }, 5000);
  }
  const isThumbnail = !!img.thumbnailPath && payload.localPath === (img.thumbnailPath || img.localPath);
  const current = localUrlOverrides.value[payload.imageId] || {};
  localUrlOverrides.value = {
    ...localUrlOverrides.value,
    [payload.imageId]: { ...current, ...(isThumbnail ? { thumbnail: payload.newUrl } : { original: payload.newUrl }) },
  };
};

// scroll-stable：给上层用于触发“加载图片 URL”
let scrollStableTimer: number | null = null;
const emitScrollStable = () => {
  if (!enableScrollStableEmit.value) return;
  if (scrollStableTimer) window.clearTimeout(scrollStableTimer);
  scrollStableTimer = window.setTimeout(() => emit("scroll-stable"), scrollStableDelay.value);
};

const pulseZoomAnimation = () => {
  const container = containerEl.value;
  if (!container) return;
  const grid = container.querySelector<HTMLElement>(".image-grid");
  if (!grid || !(grid as any).animate) return;
  (grid as any).animate(
    [
      { transform: "scale(0.985)", opacity: 0.96 },
      { transform: "scale(1)", opacity: 1 },
    ],
    { duration: 160, easing: "cubic-bezier(0.2, 0, 0, 1)" }
  );
};

const markZoomingLayout = (durationMs = 200) => {
  isZoomingLayout.value = true;
  if (zoomAnimTimer) clearTimeout(zoomAnimTimer);
  zoomAnimTimer = setTimeout(() => {
    isZoomingLayout.value = false;
    zoomAnimTimer = null;
  }, Math.max(0, durationMs));
  pulseZoomAnimation();
};

watch(
  () => gridColumnsCount.value,
  () => {
    markZoomingLayout();
    scheduleVirtualUpdate();
  }
);

const onScroll = useDebounceFn(() => {
  emitScrollStable();
  scheduleVirtualUpdate();
}, 16);

onMounted(async () => {
  updateWindowAspectRatio();
  window.addEventListener("resize", updateWindowAspectRatio);

  try {
    await settingsStore.loadMany(["imageClickAction"]);
  } catch { }

  await nextTick();
  const el = containerEl.value;
  if (el) {
    el.addEventListener("scroll", onScroll, { passive: true } as any);
    scheduleVirtualUpdate();
  }

  window.addEventListener(
    "wheel",
    (e: WheelEvent) => {
      if (!enableCtrlWheelAdjustColumns.value) return;
      if (!(e.ctrlKey || e.metaKey)) return;
      if (shouldIgnoreKeyTarget(e as any)) return;
      const delta = e.deltaY > 0 ? 1 : -1;
      uiStore.adjustImageGridColumn(delta);
    },
    { passive: true }
  );

  window.addEventListener("keydown", (e: KeyboardEvent) => {
    if (!enableCtrlKeyAdjustColumns.value) return;
    if (!(e.ctrlKey || e.metaKey)) return;
    if (shouldIgnoreKeyTarget(e)) return;
    if (e.key === "+" || e.key === "=") uiStore.adjustImageGridColumn(-1);
    if (e.key === "-" || e.key === "_") uiStore.adjustImageGridColumn(1);
  });
});

onUnmounted(() => {
  window.removeEventListener("resize", updateWindowAspectRatio);
  if (scrollStableTimer) window.clearTimeout(scrollStableTimer);
  if (zoomAnimTimer) clearTimeout(zoomAnimTimer);
  if (reorderAnimTimer) clearTimeout(reorderAnimTimer);
});

watch(
  () => props.images,
  () => {
    emitScrollStable();
    scheduleVirtualUpdate();
  },
  { deep: false }
);

const clearSelection = () => {
  internalSelectedIds.value = new Set();
  lastSelectedIndex.value = -1;
};

const exitReorderMode = () => {
  isReorderMode.value = false;
  reorderSourceIndex.value = -1;
};

const handleLongPress = (index: number) => {
  if (!canReorder.value) return;
  if (isReorderMode.value) return;
  isReorderMode.value = true;
  reorderSourceIndex.value = index;
};

const handleReorderClick = (targetIndex: number) => {
  if (!isReorderMode.value) return;
  let sourceIndex = reorderSourceIndex.value;
  if (sourceIndex === -1) {
    reorderSourceIndex.value = targetIndex;
    return;
  }
  if (sourceIndex === targetIndex) return;
  const source = images.value[sourceIndex];
  const target = images.value[targetIndex];
  if (!source || !target) return;

  const sourceOrder = (source.order ?? source.crawledAt ?? 0) as number;
  const targetOrder = (target.order ?? target.crawledAt ?? 0) as number;
  isReordering.value = true;
  if (reorderAnimTimer) clearTimeout(reorderAnimTimer);
  reorderAnimTimer = setTimeout(() => {
    isReordering.value = false;
    reorderAnimTimer = null;
  }, 450);

  emit("reorder", { aId: source.id, aOrder: sourceOrder, bId: target.id, bOrder: targetOrder });
  reorderSourceIndex.value = targetIndex;
};

defineExpose({
  getContainerEl: () => containerEl.value,
  getSelectedIds: () => new Set(internalSelectedIds.value),
  clearSelection,
  exitReorderMode,
});
</script>

<style scoped lang="scss">
.image-grid-container {
  height: 100%;
  overflow: auto;
}
.hide-scrollbar {
  scrollbar-width: none;
}
.hide-scrollbar::-webkit-scrollbar {
  display: none;
}

.image-grid-root {
  position: relative;
  min-height: 100%;
}

.image-grid {
  display: grid;
}

.fade-in-list-move,
.fade-in-list-enter-active,
.fade-in-list-leave-active {
  transition: all 0.25s ease;
}
.fade-in-list-enter-from,
.fade-in-list-leave-to {
  opacity: 0;
  transform: translateY(8px);
}

.image-grid.reorder-mode :deep(.image-item) {
  cursor: pointer;
}
</style>


