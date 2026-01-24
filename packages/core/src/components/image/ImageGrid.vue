<template>
  <div ref="containerEl" class="image-grid-container" :class="{ 'hide-scrollbar': hideScrollbar }" v-bind="$attrs"
    tabindex="0" @keydown="handleKeyDown">
    <slot name="before-grid" />

    <div class="image-grid-root" v-loading="isLoadingOverlay" :class="{ 'is-zooming': isZoomingLayout }"
      @click="handleRootClick" @contextmenu.prevent>
      <!-- 关键：空/刷新时只隐藏 ImageItem 列表，避免 v-if 卸载导致"整页闪烁" -->
      <div class="image-grid-items" v-show="hasImages">
        <div v-if="enableVirtualScroll" class="image-grid" :style="gridStyle">
          <ImageItem v-for="item in renderedItems" :key="item.image.id" :image="item.image"
            :image-url="getEffectiveImageUrl(item.image.id)"
            :image-click-action="settingsStore.values.imageClickAction || 'none'" :use-original="gridColumnsCount <= 2"
            :window-aspect-ratio="effectiveAspectRatio" :selected="effectiveSelectedIds.has(item.image.id)"
            :grid-columns="gridColumnsCount" :grid-index="item.index" :is-entering="item.isEntering"
            @click="(e) => handleItemClick(item.image, item.index, e)"
            @dblclick="() => handleItemDblClick(item.image, item.index)"
            @contextmenu="(e) => handleItemContextMenu(item.image, item.index, e)"
            @retry-download="() => emit('retry-download', { image: item.image })"
            @enter-animation-end="() => handleEnterAnimationEnd(item.image.id)" />
        </div>

        <transition-group v-else name="fade-in-list" tag="div" class="image-grid" :style="gridStyle">
          <ImageItem v-for="(image, index) in images" :key="image.id" :image="image"
            :image-url="getEffectiveImageUrl(image.id)"
            :image-click-action="settingsStore.values.imageClickAction || 'none'" :use-original="gridColumnsCount <= 2"
            :window-aspect-ratio="effectiveAspectRatio" :selected="effectiveSelectedIds.has(image.id)"
            :grid-columns="gridColumnsCount" :grid-index="index" @click="(e) => handleItemClick(image, index, e)"
            @dblclick="() => handleItemDblClick(image, index)"
            @contextmenu="(e) => handleItemContextMenu(image, index, e)"
            @retry-download="() => emit('retry-download', { image })" />
        </transition-group>
      </div>

      <!-- 空状态：overlay（插槽可自定义），不影响 before-grid/footer 等插槽的挂载 -->
      <div v-if="showEmptyOverlay" class="empty-overlay">
        <slot name="empty">
          <EmptyState />
        </slot>
      </div>

      <component :is="contextMenuComponent" v-if="enableContextMenu && contextMenuComponent"
        :visible="contextMenuVisible" :position="contextMenuPosition" :image="contextMenuImage"
        :selected-count="effectiveSelectedIds.size" :selected-image-ids="effectiveSelectedIds" @close="closeContextMenu"
        @command="handleContextMenuCommand" />

      <ImagePreviewDialog ref="previewRef" :images="images" :image-url-map="imageUrlMapForPreview"
        :context-menu-component="contextMenuComponent" @context-command="handlePreviewContextCommand" />
    </div>

    <slot name="footer" />

    <ScrollButtons v-if="hideScrollbar" :get-container="getContainerEl" :threshold="scrollButtonThreshold" />
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onActivated, onDeactivated, onMounted, onUnmounted, ref, watch, type Component } from "vue";
import ImageItem from "./ImageItem.vue";
import type { ImageInfo, ImageUrlMap } from "../../types/image";
import EmptyState from "../common/EmptyState.vue";
import ImagePreviewDialog from "../common/ImagePreviewDialog.vue";
import ScrollButtons from "../common/ScrollButtons.vue";
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
  loading?: boolean; // 加载状态：为 true 时不显示空状态，避免加载过程中闪现空占位符
  /**
   * 加载遮罩（仅覆盖 grid 区域，不覆盖 before-grid/footer 等插槽）。
   * - 不传时默认等同于 `loading`
   * - 典型用法：`loading` 立即为 true 以抑制空态闪烁；`loadingOverlay` 做延迟（避免短 loading 闪烁）
   */
  loadingOverlay?: boolean;
  enableCtrlWheelAdjustColumns?: boolean;
  enableCtrlKeyAdjustColumns?: boolean;
  hideScrollbar?: boolean;
  scrollStableDelay?: number;
  enableScrollStableEmit?: boolean;
  enableScrollButtons?: boolean;
  enableVirtualScroll?: boolean;
  virtualOverscan?: number;
  windowAspectRatio?: number; // 外部传入的窗口宽高比（可选，不传则使用实际窗口宽高比）
}

const props = defineProps<Props>();
const emit = defineEmits<{
  "scroll-stable": [];
  "retry-download": [payload: { image: ImageInfo }];
  // 兼容旧 API（不再由 core 触发，但保留事件名避免上层 TS/模板报错）
  addedToAlbum: [];
}>();

const settingsStore = useSettingsStore();
const uiStore = useUiStore();
const showEmptyState = computed(() => props.showEmptyState ?? false);
const isLoading = computed(() => props.loading ?? false);
const isLoadingOverlay = computed(() => props.loadingOverlay ?? isLoading.value);

// 从 store 解析宽高比设置
const parseAspectRatioFromStore = (value: string | null | undefined): number | null => {
  if (!value) return null;
  // 解析 "16:9" 格式
  if (value.includes(":") && !value.startsWith("custom:")) {
    const [w, h] = value.split(":").map(Number);
    if (w && h && h > 0) {
      return w / h;
    }
  }
  // 解析 "custom:1920:1080" 格式
  if (value.startsWith("custom:")) {
    const parts = value.replace("custom:", "").split(":");
    const [w, h] = parts.map(Number);
    if (w && h && h > 0) {
      return w / h;
    }
  }
  return null;
};

const storeAspectRatio = computed(() => {
  return parseAspectRatioFromStore(settingsStore.values.galleryImageAspectRatio);
});
const enableContextMenu = computed(() => !!props.contextMenuComponent);
const enableCtrlWheelAdjustColumns = computed(() => props.enableCtrlWheelAdjustColumns ?? false);
const enableCtrlKeyAdjustColumns = computed(() => props.enableCtrlKeyAdjustColumns ?? false);
const hideScrollbar = computed(() => props.hideScrollbar ?? false);
const scrollStableDelay = computed(() => props.scrollStableDelay ?? 180);
const enableScrollStableEmit = computed(() => props.enableScrollStableEmit ?? true);
const enableVirtualScroll = computed(() => props.enableVirtualScroll ?? true);
const virtualOverscanRows = computed(() => Math.max(0, props.virtualOverscan ?? 20));
// const enableScrollButtons = computed(() => props.enableScrollButtons ?? true);
const scrollButtonThreshold = 2000;

const images = computed(() => props.images || []);
const hasImages = computed(() => images.value.length > 0);
const imageGridColumns = computed(() => uiStore.imageGridColumns);
// 只有在不处于加载状态且确实没有图片时才显示空状态，避免加载过程中闪现空占位符
const showEmptyOverlay = computed(() => showEmptyState.value && !hasImages.value && !isLoading.value);

// 入场/退场动画跟踪（仅虚拟滚动模式下使用）
const enteringIds = ref<Set<string>>(new Set());
const previousImageIds = ref<Set<string>>(new Set());

// 缩放动画标记（列数变化时）
const isZoomingLayout = ref(false);
let zoomAnimTimer: ReturnType<typeof setTimeout> | null = null;

const gridColumnsCount = computed(() => (imageGridColumns.value > 0 ? imageGridColumns.value : 1));
const gridGapPx = computed(() => Math.max(4, 16 - (gridColumnsCount.value - 1)));
const BASE_GRID_PADDING_Y = 6;
const BASE_GRID_PADDING_X = 8;

// 虚拟滚动测量
const measuredItemHeight = ref<number | null>(null);
const virtualStartRow = ref(0);
const virtualEndRow = ref(0);

const containerEl = ref<HTMLElement | null>(null);

// keep-alive/Tab 切换时，组件可能“已挂载但不可见/尺寸为 0”。
// 此时若测量 ImageItem 高度，会得到 0 并被缓存，导致虚拟滚动 rowHeight 计算错误（滚动抖动）。
const canMeasureLayout = () => {
  const el = containerEl.value;
  if (!el) return false;
  return el.clientWidth > 0 && el.clientHeight > 0;
};

// 监听容器尺寸变化：列数变化/侧栏伸缩/布局变化会影响 item 宽度->高度，需要触发虚拟滚动重算
let containerResizeObserver: ResizeObserver | null = null;
const setupContainerResizeObserver = () => {
  if (containerResizeObserver) return;
  const el = containerEl.value;
  if (!el) return;
  if (typeof ResizeObserver === "undefined") return;
  containerResizeObserver = new ResizeObserver(() => {
    scheduleVirtualUpdate();
  });
  containerResizeObserver.observe(el);
};

// 让快捷键仅在 grid“有焦点”时生效（不使用 window 全局监听）
const focusGrid = () => {
  const el = containerEl.value;
  if (!el) return;
  const active = document.activeElement as HTMLElement | null;
  const tag = active?.tagName;
  const isEditing = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || !!active?.isContentEditable;
  if (isEditing) return;
  try {
    if (document.activeElement !== el) el.focus({ preventScroll: true } as any);
  } catch {
    // ignore
  }
};

// keep-alive/Tab 切换时保持滚动位置（对齐 before-src 行为）
const savedScrollTop = ref<number>(0);
let saveScrollRaf: number | null = null;
const saveScrollPosition = () => {
  if (saveScrollRaf != null) cancelAnimationFrame(saveScrollRaf);
  saveScrollRaf = requestAnimationFrame(() => {
    saveScrollRaf = null;
    if (containerEl.value) {
      savedScrollTop.value = containerEl.value.scrollTop;
    }
  });
};

// 选择状态（内部维护）
const selectedIds = ref<Set<string>>(new Set());
const lastSelectedIndex = ref<number>(-1);
const effectiveSelectedIds = computed<Set<string>>(() => selectedIds.value);

// 预览与 context menu
const previewRef = ref<InstanceType<typeof ImagePreviewDialog> | null>(null);
const contextMenuVisible = ref(false);
const contextMenuImage = ref<ImageInfo | null>(null);
const contextMenuPosition = ref({ x: 0, y: 0 });

const getEffectiveImageUrl = (id: string) => props.imageUrlMap?.[id];
const imageUrlMapForPreview = computed(() => props.imageUrlMap || {});

// 窗口宽高比（用于 item aspect ratio）
const windowAspectRatio = ref<number>(16 / 9);
const updateWindowAspectRatio = () => {
  windowAspectRatio.value = window.innerWidth / window.innerHeight;
};
const effectiveAspectRatio = computed(() => {
  // 优先使用 store 中的宽高比设置，其次使用外部传入的 prop，最后使用实际窗口宽高比
  if (storeAspectRatio.value !== null && storeAspectRatio.value > 0) {
    return storeAspectRatio.value;
  }
  if (props.windowAspectRatio !== undefined && props.windowAspectRatio > 0) {
    return props.windowAspectRatio;
  }
  return windowAspectRatio.value;
});

const estimatedItemHeight = () => {
  const container = containerEl.value;
  if (!container) return 240;
  const availableWidth =
    container.clientWidth - BASE_GRID_PADDING_X * 2 - gridGapPx.value * (gridColumnsCount.value - 1);
  const columnWidth = Math.max(1, availableWidth / gridColumnsCount.value);
  // 行高估算应与 ImageItem 实际使用的 aspectRatio 一致，否则虚拟滚动 paddingTop 会漂移
  const ratio = effectiveAspectRatio.value || 16 / 9;
  return columnWidth / ratio;
};

const rowHeightWithGap = computed(() => {
  const h = measuredItemHeight.value ?? estimatedItemHeight();
  return h + gridGapPx.value;
});

// 限制拖拽滚动最大速度：每 0.2 秒滚动一行
useDragScroll(containerEl, {
  maxVelocityPxPerMs: () => rowHeightWithGap.value / 100,
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
  if (!canMeasureLayout()) return;
  const grid = containerEl.value?.querySelector<HTMLElement>(".image-grid");
  const firstItem = grid?.querySelector<HTMLElement>(".image-item");
  if (firstItem) {
    const h = firstItem.getBoundingClientRect().height;
    measuredItemHeight.value = h > 1 ? h : estimatedItemHeight();
  } else {
    measuredItemHeight.value = estimatedItemHeight();
  }
};

const renderedItems = computed(() => {
  if (!enableVirtualScroll.value) return [];
  const cols = gridColumnsCount.value;
  const start = Math.max(0, virtualStartRow.value * cols);
  const end = Math.min(images.value.length, (virtualEndRow.value + 1) * cols);
  const out: Array<{ image: ImageInfo; index: number; isEntering: boolean }> = [];

  // 添加当前可视区域的图片
  for (let i = start; i < end; i++) {
    const img = images.value[i];
    if (img) {
      out.push({
        image: img,
        index: i,
        isEntering: enteringIds.value.has(img.id),
      });
    }
  }

  // 按 index 排序，确保顺序正确
  out.sort((a, b) => a.index - b.index);

  return out;
});

let gridDestroyed = false;

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
  const current = selectedIds.value;
  if (current.size === 0 || !current.has(image.id)) {
    setSingleSelection(image.id, index);
  }
};

const setSingleSelection = (imageId: string, index: number) => {
  selectedIds.value = new Set([imageId]);
  lastSelectedIndex.value = index;
};

const toggleSelection = (imageId: string, index: number) => {
  const next = new Set(selectedIds.value);
  if (next.has(imageId)) next.delete(imageId);
  else next.add(imageId);
  selectedIds.value = next;
  lastSelectedIndex.value = index;
};

const rangeSelect = (index: number) => {
  if (lastSelectedIndex.value === -1) return;
  const start = Math.min(lastSelectedIndex.value, index);
  const end = Math.max(lastSelectedIndex.value, index);
  const next = new Set(selectedIds.value);
  for (let i = start; i <= end; i++) {
    const id = images.value[i]?.id;
    if (id) next.add(id);
  }
  selectedIds.value = next;
};

const shouldIgnoreKeyTarget = (event: KeyboardEvent) => {
  const target = event.target as HTMLElement | null;
  const tag = target?.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target?.isContentEditable;
};

// 键盘快捷键（仅在 grid 获得焦点时生效；不使用 window 全局监听；不 stopPropagation，允许冒泡）
const handleKeyDown = (event: KeyboardEvent) => {
  if (shouldIgnoreKeyTarget(event)) return;

  // Ctrl/Cmd + +/-：调整列数（原来是 window 监听）
  if (enableCtrlKeyAdjustColumns.value && (event.ctrlKey || event.metaKey)) {
    if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      uiStore.adjustImageGridColumn(-1);
      return;
    }
    if (event.key === "-" || event.key === "_") {
      event.preventDefault();
      uiStore.adjustImageGridColumn(1);
      return;
    }
  }

  // Ctrl/Cmd + A：全选（对齐 before-src）
  if ((event.ctrlKey || event.metaKey) && (event.key === "a" || event.key === "A")) {
    event.preventDefault();
    selectedIds.value = new Set(props.images.map((img) => img.id));
    lastSelectedIndex.value = props.images.length > 0 ? props.images.length - 1 : -1;
    return;
  }

  // Ctrl/Cmd + C：复制（仅单选；多选请走右键菜单）
  if ((event.ctrlKey || event.metaKey) && (event.key === "c" || event.key === "C")) {
    if (selectedIds.value.size !== 1) return;
    const onlyId = Array.from(selectedIds.value)[0];
    const image = onlyId ? props.images.find((img) => img.id === onlyId) : undefined;
    if (!image) return;
    event.preventDefault();
    void dispatchContextCommand(buildContextPayload("copy", image));
    return;
  }

  // ESC：清空选择
  if (event.key === "Escape") {
    selectedIds.value = new Set();
    lastSelectedIndex.value = -1;
    closeContextMenu();
    return;
  }

  // Backspace / Delete：交给父组件执行删除逻辑（grid 只负责发出意图）
  if ((event.key === "Backspace" || event.key === "Delete") && selectedIds.value.size > 0) {
    event.preventDefault();
    const first = props.images.find((img) => selectedIds.value.has(img.id)) || props.images[0];
    if (first) {
      void dispatchContextCommand(buildContextPayload("remove", first));
    }
    return;
  }
};

const handleRootClick = (event: MouseEvent) => {
  const target = event.target as HTMLElement | null;
  const clickedOutside = !target?.closest(".image-item") && !target?.closest(".context-menu");

  if (contextMenuVisible.value) {
    closeContextMenu();
    return;
  }

  // 如果点击的是预览对话框相关元素（遮罩、对话框等），不处理清除选择
  // Element Plus dialog 使用 teleport 渲染到 body，但点击遮罩关闭时可能事件仍会传播
  if (target?.closest(".el-overlay") || target?.closest(".el-dialog") || target?.closest(".image-preview-dialog")) {
    return;
  }

  // 空白处点击：清除所有选择（单选和多选）
  if (clickedOutside) {
    focusGrid();
    clearSelection();
  }
};

const handleItemClick = (image: ImageInfo, index: number, event?: MouseEvent) => {
  if (!event) return;
  focusGrid();
  if (event.shiftKey) {
    rangeSelect(index);
    return;
  }
  if (event.ctrlKey || event.metaKey) {
    toggleSelection(image.id, index);
    return;
  }
  if (selectedIds.value.size > 1 && selectedIds.value.has(image.id)) {
    return;
  }
  setSingleSelection(image.id, index);
};

const handleItemDblClick = (image: ImageInfo, index: number) => {
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

const clearSelection = () => {
  selectedIds.value = new Set();
  lastSelectedIndex.value = -1;
};


// Blob URL 的生成/失效/重建统一交给上层 loader + 全局缓存；
// core ImageGrid 不再维护局部 override。

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

// 虚拟滚动测量更新：合并到单个 rAF，避免短时间内多处触发导致重复测量/抖动
let virtualUpdateRaf: number | null = null;
const scheduleVirtualUpdate = () => {
  if (!enableVirtualScroll.value) return;
  if (virtualUpdateRaf != null) return;
  virtualUpdateRaf = requestAnimationFrame(() => {
    virtualUpdateRaf = null;
    // 不可测时不更新，避免把 0 高度写入 measuredItemHeight，或用 0 尺寸更新可视范围
    if (!canMeasureLayout()) return;
    measureItemHeight();
    updateVirtualRange();
  });
};

// 关键：窗口/全屏切换会改变 ImageItem 的布局与实际高度（依赖 windowAspectRatio）。
// 若不重测，虚拟 paddingTop 会与真实行高不一致，滚动时会出现"突然跳一段"的视觉跳动。
watch(
  () => windowAspectRatio.value,
  () => {
    scheduleVirtualUpdate();
  }
);

// 监听 store 中的宽高比设置变化
watch(
  () => settingsStore.values.galleryImageAspectRatio,
  () => {
    scheduleVirtualUpdate();
  }
);

watch(
  () => enableVirtualScroll.value,
  () => {
    scheduleVirtualUpdate();
  }
);

// 虚拟滚动：滚动时用 rAF 实时更新可视行，避免 debounce 导致“滚快一点出现空白区域”
let virtualScrollRaf: number | null = null;
const scheduleVirtualRangeUpdate = () => {
  if (!enableVirtualScroll.value) return;
  if (virtualScrollRaf != null) return;
  virtualScrollRaf = requestAnimationFrame(() => {
    virtualScrollRaf = null;
    updateVirtualRange();
  });
};

onMounted(async () => {
  updateWindowAspectRatio();
  window.addEventListener("resize", updateWindowAspectRatio);

  try {
    await settingsStore.loadMany(["imageClickAction", "galleryImageAspectRatio"]);
  } catch { }

  await nextTick();
  const el = containerEl.value;
  if (el) {
    setupContainerResizeObserver();
    // 1) scroll-stable（内部已用 setTimeout 防抖）
    el.addEventListener("scroll", emitScrollStable, { passive: true } as any);
    // 2) 虚拟滚动范围：每帧更新一次（避免空白）
    el.addEventListener("scroll", scheduleVirtualRangeUpdate, { passive: true } as any);
    // 记录滚动位置（rAF 节流，尽量便宜）
    el.addEventListener("scroll", saveScrollPosition, { passive: true } as any);
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
});

onUnmounted(() => {
  gridDestroyed = true;
  window.removeEventListener("resize", updateWindowAspectRatio);
  if (scrollStableTimer) window.clearTimeout(scrollStableTimer);
  if (zoomAnimTimer) clearTimeout(zoomAnimTimer);
  if (saveScrollRaf != null) cancelAnimationFrame(saveScrollRaf);
  saveScrollRaf = null;
  if (virtualUpdateRaf != null) cancelAnimationFrame(virtualUpdateRaf);
  virtualUpdateRaf = null;
  if (virtualScrollRaf != null) cancelAnimationFrame(virtualScrollRaf);
  virtualScrollRaf = null;
  if (containerResizeObserver) containerResizeObserver.disconnect();
  containerResizeObserver = null;
});

onActivated(() => {
  // keep-alive 激活后恢复滚动位置；并刷新虚拟滚动范围，避免显示错位
  const el = containerEl.value;
  if (!el) return;
  setupContainerResizeObserver();
  if (savedScrollTop.value > 0) {
    requestAnimationFrame(() => {
      if (!containerEl.value) return;
      containerEl.value.scrollTop = savedScrollTop.value;
      scheduleVirtualUpdate();
    });
    return;
  }
  // 即使在顶部，也需要在激活时重测量一次（避免在不可见状态下列数变化测到 0 并被缓存）
  requestAnimationFrame(() => {
    scheduleVirtualUpdate();
  });
});

onDeactivated(() => {
  // deactivated 时不主动重置 measuredItemHeight（保留上一次可见时的正确值）
});

// 检测图片列表变化，标记新增/删除的图片（仅虚拟滚动模式）
watch(
  () => props.images,
  (newImages) => {
    emitScrollStable();
    scheduleVirtualUpdate();

    const newIds = new Set(newImages.map((img) => img.id));
    const oldIds = previousImageIds.value;

    // 判断是否是刷新/换页（新旧列表完全没有交集）还是图片增减
    const hasIntersection = oldIds.size > 0 && [...oldIds].some((id) => newIds.has(id));

    if (oldIds.size > 0 && !hasIntersection) {
      // 刷新/换页：新旧列表完全不同，清空选择
      clearSelection();
    } else if (selectedIds.value.size > 0) {
      // 图片增减：从选择中移除被删除的图片
      const newSelected = new Set([...selectedIds.value].filter((id) => newIds.has(id)));
      if (newSelected.size !== selectedIds.value.size) {
        selectedIds.value = newSelected;
        // 如果 lastSelectedIndex 对应的图片被删除了，重置索引
        if (lastSelectedIndex.value >= 0) {
          const lastImg = newImages[lastSelectedIndex.value];
          if (!lastImg || !newSelected.has(lastImg.id)) {
            lastSelectedIndex.value = newSelected.size > 0 ? -1 : -1;
          }
        }
      }
    }

    // 非虚拟滚动模式下不需要手动处理动画（transition-group 会自动处理）
    if (!enableVirtualScroll.value) {
      previousImageIds.value = newIds;
      return;
    }

    // 关键：当上层"先清空再重建列表"（如换大页/强制刷新）时，
    // 若这里照常计算 leavingItems，会导致旧页的可视区项与新页项在同一索引区间同时渲染，
    // 表现为"隔一个空位/一行只有一半"的错觉（旧项可能还没 URL，只剩骨架）。
    // 把"列表被清空"视为硬重置：直接清空动画跟踪，避免跨页混渲染。
    if (newImages.length === 0) {
      enteringIds.value = new Set();
      previousImageIds.value = new Set();
      return;
    }

    // 检测新增的图片
    for (const img of newImages) {
      if (!oldIds.has(img.id)) {
        enteringIds.value.add(img.id);
      }
    }

    // 更新上一次的图片 ID 集合
    previousImageIds.value = newIds;
  },
  { deep: false, immediate: true }
);

// 入场动画结束回调
const handleEnterAnimationEnd = (imageId: string) => {
  enteringIds.value.delete(imageId);
};

const getContainerEl = () => containerEl.value;

defineExpose({
  getContainerEl,
  getSelectedIds: () => new Set(selectedIds.value),
  clearSelection,
});
</script>

<style scoped lang="scss">
.image-grid-container {
  height: 100%;
  overflow: auto;
  outline: none;
}

.image-grid-container:focus {
  outline: none;
}

.image-grid-container:focus-visible {
  outline: none;
}

.hide-scrollbar {
  scrollbar-width: none;
}

.hide-scrollbar::-webkit-scrollbar {
  display: none;
}

.image-grid-root {
  position: relative;
}

.image-grid-items {
  min-height: 100%;
}

.empty-overlay {
  inset: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 12px;
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
</style>
