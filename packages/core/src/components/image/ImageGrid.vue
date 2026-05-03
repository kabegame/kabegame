<template>
  <div ref="containerEl" class="image-grid-container" :class="[
      { 'hide-scrollbar': hideScrollbar },
      { 'scrolls-whole-container': scrollWholeContainer && !isHorizontal },
      `layout-${layoutDirection}`,
    ]" v-bind="$attrs" tabindex="0" @keydown="handleKeyDown">
    <slot name="before-grid" />

    <div ref="innerScrollEl" class="image-grid-scroll" :class="`layout-${layoutDirection}`">
      <div class="image-grid-root" v-loading="isLoadingOverlay" :class="{ 'is-zooming': isZoomingLayout }"
        @click="handleRootClick" @contextmenu.prevent>
        <!-- 关键：空/刷新时只隐藏 ImageItem 列表，避免 v-if 卸载导致"整页闪烁" -->
        <div class="image-grid-items" v-show="hasImages">
          <template v-if="layoutMode === 'grid'">
            <div v-if="virtualScrollActive" class="image-grid" :class="`layout-${layoutDirection}`" :style="gridStyle">
              <ImageItem v-for="item in renderedItems" :key="item.image.id" :image="item.image"
                :image-click-action="settingsStore.values.imageClickAction || 'none'"
                :window-aspect-ratio="getEffectiveAspectRatioForItem(item.image)" :selected="selectedIds.has(item.image.id)"
                :grid-columns="gridColumnsCount" :grid-index="item.index" :is-entering="item.isEntering"
                :horizontal="isHorizontal"
                :video-playing="playingVideoId === item.image.id"
                @click="(e) => handleItemClick(item.image, item.index, e)"
                @dblclick="() => handleItemDblClick(item.image, item.index)"
                @contextmenu="(e) => handleItemContextMenu(item.image, item.index, e)"
                @toggle-video-play="() => handleToggleVideoPlay(item.image.id)"
                @enter-animation-end="() => handleEnterAnimationEnd(item.image.id)" />
            </div>

            <transition-group v-else name="fade-in-list" tag="div" class="image-grid"
              :class="`layout-${layoutDirection}`" :style="gridStyle">
              <ImageItem v-for="(image, index) in images" :key="image.id" :image="image"
                :image-click-action="settingsStore.values.imageClickAction || 'none'"
                :window-aspect-ratio="getEffectiveAspectRatioForItem(image)" :selected="selectedIds.has(image.id)"
                :grid-columns="gridColumnsCount" :grid-index="index" :horizontal="isHorizontal"
                :video-playing="playingVideoId === image.id"
                @click="(e) => handleItemClick(image, index, e)"
                @dblclick="() => handleItemDblClick(image, index)"
                @contextmenu="(e) => handleItemContextMenu(image, index, e)"
                @toggle-video-play="() => handleToggleVideoPlay(image.id)" />
            </transition-group>
          </template>

          <div v-else class="image-gallery" :class="`layout-${layoutDirection}`" :style="galleryStyle">
            <div v-for="(bucket, bi) in galleryBuckets" :key="bi"
              :class="isHorizontal ? 'image-gallery-row' : 'image-gallery-column'"
              :style="{ gap: gridGapPx + 'px' }">
              <ImageItem v-for="entry in bucket" :key="entry.image.id" :image="entry.image"
                :image-click-action="settingsStore.values.imageClickAction || 'none'"
                :window-aspect-ratio="aspectRatioOf(entry.image)" :selected="selectedIds.has(entry.image.id)"
                :grid-columns="gridColumnsCount" :grid-index="entry.index" fill-box :horizontal="isHorizontal"
                :video-playing="playingVideoId === entry.image.id"
                @click="(e) => handleItemClick(entry.image, entry.index, e)"
                @dblclick="() => handleItemDblClick(entry.image, entry.index)"
                @contextmenu="(e) => handleItemContextMenu(entry.image, entry.index, e)"
                @toggle-video-play="() => handleToggleVideoPlay(entry.image.id)" />
            </div>
          </div>
        </div>

        <!-- 空状态：overlay（插槽可自定义），不影响 before-grid/footer 等插槽的挂载 -->
        <div v-if="showEmptyOverlay" class="empty-overlay">
          <slot name="empty">
            <EmptyState />
          </slot>
        </div>

        <!-- New action-based context menu -->
        <ActionRenderer
          v-if="enableContextMenu && actions && actions.length > 0"
          :visible="contextMenuVisible"
          :position="contextMenuPosition"
          :actions="actions"
          :context="contextMenuActionContext"
          :zIndex="1900"
          @close="closeContextMenu"
          @command="handleContextMenuCommand" />

        <ImagePreviewDialog
          ref="previewRef"
          :images="images"
          :actions="actions"
          :plugins="plugins"
          @context-command="handlePreviewContextCommand"
          @open-task="emit('open-task', $event)" />
      </div>
    </div>

    <slot name="footer" />

    <ScrollButtons v-if="hideScrollbar" :get-container="getContainerEl" :threshold="scrollButtonThreshold" />
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onActivated, onDeactivated, onMounted, onUnmounted, ref, watch } from "vue";
import ImageItem from "./ImageItem.vue";
import type { ImageInfo } from "../../types/image";
import EmptyState from "../common/EmptyState.vue";
import ImagePreviewDialog from "../common/ImagePreviewDialog.vue";
import ScrollButtons from "../common/ScrollButtons.vue";
import { useSettingsStore } from "../../stores/settings";
import { useModalBack } from "../../composables/useModalBack";
import { useModalStackStore } from "../../stores/modalStack";
import { useUiStore } from "../../stores/ui";
import { useDragScroll } from "../../composables/useDragScroll";
import { IS_ANDROID, IS_WEB } from "../../env";
import { isVideoMediaType } from "../../utils/mediaMime";
import { openVideo } from "tauri-plugin-picker-api";

async function tryOpenVideo(path: string) {
  if (IS_WEB) return;
  await openVideo(path);
}
import ActionRenderer from "../ActionRenderer.vue";
import type { ActionItem, ActionContext } from "../../actions/types";

// core 版保留通用图片意图；favorite/addToAlbum 等 kabegame 专属入口仍在 wrapper 层扩展。
export type ContextCommand =
  | "detail"
  | "copy"
  | "open"
  | "share"
  | "openFolder"
  | "wallpaper"
  | "exportToWE"
  | "exportToWEAuto"
  | "addToHidden"
  | "remove"
  | "swipe-remove";

type MultiImagePayload = { selectedImageIds: ReadonlySet<string> };
type ImagePayload = { image: ImageInfo };

type ContextCommandPayloadMap = {
  open: ImagePayload;
  openFolder: ImagePayload;
  detail: ImagePayload;
  copy: ImagePayload & MultiImagePayload;
  wallpaper: ImagePayload & MultiImagePayload;
  share: ImagePayload;
  exportToWE: ImagePayload & MultiImagePayload;
  exportToWEAuto: ImagePayload & MultiImagePayload;
  addToHidden: ImagePayload & MultiImagePayload;
  remove: ImagePayload & MultiImagePayload;
  "swipe-remove": ImagePayload;
};

export type ContextCommandPayload<T extends ContextCommand = ContextCommand> = {
  command: T;
} & (T extends keyof ContextCommandPayloadMap ? ContextCommandPayloadMap[T] : ImagePayload);

interface Props {
  images?: ImageInfo[];
  /** Actions for context menu / action sheet. */
  actions?: ActionItem<ImageInfo>[];
  onContextCommand?: (
    payload: ContextCommandPayload
  ) => ContextCommand | null | undefined | Promise<ContextCommand | null | undefined>;
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
  /** 让外层 image-grid-container 自己成为滚动容器，before-grid 与图片共享同一个 sticky 上下文。 */
  scrollWholeContainer?: boolean;
  /** 插件列表（用于桌面预览内详情抽屉显示插件名称） */
  plugins?: Array<{ id: string; name?: string }>;
}

const props = withDefaults(defineProps<Props>(), {
  images: () => [],
  enableCtrlWheelAdjustColumns: false,
  enableCtrlKeyAdjustColumns: false,
  hideScrollbar: false,
  scrollStableDelay: 180,
  enableScrollStableEmit: true,
  enableVirtualScroll: true,
  virtualOverscan: 2,
  scrollWholeContainer: false,
});

const emit = defineEmits<{
  "scroll-stable": [];
  // 兼容旧 API（不再由 core 触发，但保留事件名避免上层 TS/模板报错）
  addedToAlbum: [];
  "open-task": [taskId: string];
}>();

const settingsStore = useSettingsStore();
/** 本栅格实例内的选择集，不跨页面/路由共享 */
const selectedIds = ref<Set<string>>(new Set());
/** 当前正在播放的视频 id（同一时间最多一个），点击右上角按钮切换 */
const playingVideoId = ref<string | null>(null);
const handleToggleVideoPlay = (imageId: string) => {
  playingVideoId.value = playingVideoId.value === imageId ? null : imageId;
};
const modalStackStore = useModalStackStore();
const uiStore = useUiStore();

const isLoading = computed(() => props.loading ?? false);
const isLoadingOverlay = computed(() => props.loadingOverlay ?? isLoading.value);
/*----------------- 宽高比相关 -----------------*/
// 从 store 解析宽高比设置
// 安卓不需要宽高比设置，图片自动适应
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

/*----------------- 虚拟滚动相关 -----------------*/
const virtualOverscanRows = computed(() => Math.max(0, props.virtualOverscan));
// const enableScrollButtons = computed(() => props.enableScrollButtons ?? true);
const scrollButtonThreshold = 2000;

/*----------------- 图片相关 -----------------*/
const hasImages = computed(() => (props.images ?? []).length > 0);
const imageGridColumns = computed(() => uiStore.imageGridColumns);
const isCompact = computed(() => uiStore.isCompact);
// 只有在不处于加载状态且确实没有图片时才显示空状态，避免加载过程中闪现空占位符
const showEmptyOverlay = computed(() => !hasImages.value && !isLoading.value);

// keep-alive 激活状态：deactivated 时不应改写本实例选择
const isComponentActive = ref(true);

// 入场/退场动画跟踪（仅虚拟滚动模式下使用）
const enteringIds = ref<Set<string>>(new Set());
const previousImageIds = ref<Set<string>>(new Set());

// 缩放动画标记（列数变化时）
const isZoomingLayout = ref(false);
let zoomAnimTimer: ReturnType<typeof setTimeout> | null = null;

const gridColumnsCount = computed(() => (imageGridColumns.value > 0 ? imageGridColumns.value : 1));
// 紧凑布局：栅格更紧凑，空白更少。整体间距为历史值的 1/3，让网格更紧凑。
const gridGapPx = computed(() => {
  const base = isCompact.value
    ? Math.max(2, 6 - (gridColumnsCount.value - 1))
    : Math.max(4, 16 - (gridColumnsCount.value - 1));
  return Math.max(1, Math.round(base / 3));
});
const BASE_GRID_PADDING_Y = computed(() => (isCompact.value ? 4 : 6));
const BASE_GRID_PADDING_X = computed(() => (isCompact.value ? 4 : 8));

// 虚拟滚动测量
const measuredItemHeight = ref<number | null>(null);
const virtualStartRow = ref(0);
const virtualEndRow = ref(0);

// 外层容器：默认只做键盘/焦点/resize；scrollWholeContainer 时也作为滚动元素。
const containerEl = ref<HTMLElement | null>(null);
const innerScrollEl = ref<HTMLElement | null>(null);
// 实际滚动容器：默认是内部 scroll；纵向整页滚动时切到外层容器让 before-grid 共享 sticky 上下文。
// 水平布局依赖内部 scroll 的固定高度链条，仍保持旧滚动容器。
const scrollEl = computed(() =>
  props.scrollWholeContainer && !isHorizontal.value ? containerEl.value : innerScrollEl.value
);

// keep-alive/Tab 切换时，组件可能“已挂载但不可见/尺寸为 0”。
// 此时若测量 ImageItem 高度，会得到 0 并被缓存，导致虚拟滚动 rowHeight 计算错误（滚动抖动）。
const canMeasureLayout = () => {
  const el = scrollEl.value;
  if (!el) return false;
  return el.clientWidth > 0 && el.clientHeight > 0;
};

// 监听容器尺寸变化：列数变化/侧栏伸缩/布局变化会影响 item 宽度->高度，需要触发虚拟滚动重算
let containerResizeObserver: ResizeObserver | null = null;
let observedResizeEl: HTMLElement | null = null;
const setupContainerResizeObserver = (el = scrollEl.value) => {
  if (!el) return;
  if (typeof ResizeObserver === "undefined") return;
  if (!containerResizeObserver) {
    containerResizeObserver = new ResizeObserver(() => {
      scheduleVirtualUpdate();
    });
  }
  if (observedResizeEl === el) return;
  if (observedResizeEl) containerResizeObserver.unobserve(observedResizeEl);
  containerResizeObserver.observe(el);
  observedResizeEl = el;
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

// keep-alive/Tab 切换时保持滚动位置（保存当前滚动主轴）
const savedScrollPos = ref<number>(0);
let saveScrollRaf: number | null = null;
const saveScrollPosition = () => {
  if (saveScrollRaf != null) cancelAnimationFrame(saveScrollRaf);
  saveScrollRaf = requestAnimationFrame(() => {
    saveScrollRaf = null;
    const el = scrollEl.value;
    if (el) {
      savedScrollPos.value = isHorizontal.value ? el.scrollLeft : el.scrollTop;
    }
  });
};

const lastSelectedIndex = ref<number>(-1);

// Android 选择模式
const androidSelectionMode = computed(() => selectedIds.value.size > 0);

// 预览与 context menu
const previewRef = ref<InstanceType<typeof ImagePreviewDialog> | null>(null);
const contextMenuVisible = ref(false);
const contextMenuImage = ref<ImageInfo | null>(null);
const contextMenuPosition = ref({ x: 0, y: 0 });

const contextMenuActionContext = computed<ActionContext<ImageInfo>>(() => ({
  target: contextMenuImage.value,
  selectedIds: selectedIds.value,
  selectedCount: selectedIds.value.size,
  totalCount: (props.images ?? []).length,
}));

const enableContextMenu = computed(() => {
  return !!(props.actions && props.actions.length > 0);
});

// 检查预览是否打开（必须读取 ref 的 .value，否则暴露的 ref 对象始终 truthy，导致栈未正确注册/注销）
const isPreviewOpen = computed(() => {
  const v = previewRef.value?.previewVisible as { value?: boolean } | boolean | undefined;
  if (v == null) return false;
  return typeof v === "object" && "value" in v ? !!v.value : !!v;
});

// 当前预览索引（响应式）
const currentPreviewIndex = computed(() => {
  return previewRef.value?.previewIndex ?? -1;
});

// Android 系统返回键：预览打开时注册到 modalStack
const modalStackId = ref<string | null>(null);

// 窗口宽高比（用于 item aspect ratio）
const windowAspectRatio = ref<number>(16 / 9);
const updateWindowAspectRatio = () => {
  windowAspectRatio.value = window.innerWidth / window.innerHeight;
};
const effectiveAspectRatio = computed(() => {
  // 紧凑模式下不在此处固定 1:1，改为按单张图片在 getEffectiveAspectRatioForItem 里处理
  if (!isCompact.value) {
    if (storeAspectRatio.value !== null && storeAspectRatio.value > 0) {
      return storeAspectRatio.value;
    }
    if (props.windowAspectRatio !== undefined && props.windowAspectRatio > 0) {
      return props.windowAspectRatio;
    }
    return windowAspectRatio.value;
  }
  return 1; // 紧凑模式默认（无 width/height 时用）
});

/** 紧凑模式：按该图 width/height 计算宽高比，行高由该行最高图自适应；宽屏用全局 effectiveAspectRatio */
const getEffectiveAspectRatioForItem = (image: ImageInfo) => {
  if (isCompact.value && image?.width != null && image?.height != null && image.width > 0 && image.height > 0) {
    return image.width / image.height;
  }
  return effectiveAspectRatio.value;
};

/*----------------- Gallery（masonry）布局 + 方向 -----------------*/
const layoutMode = computed<"grid" | "gallery">(
  () => (settingsStore.values.galleryLayoutMode as "grid" | "gallery") ?? "grid"
);
const layoutDirection = computed<"vertical" | "horizontal">(
  () => (settingsStore.values.galleryLayoutDirection as "vertical" | "horizontal") ?? "vertical"
);
const isHorizontal = computed(() => layoutDirection.value === "horizontal");

// grid 布局可虚拟化：纵向按行，横向按列组；masonry/gallery 每项尺寸不定，不启用。
const virtualScrollActive = computed(
  () => props.enableVirtualScroll && layoutMode.value === "grid"
);

// gallery 模式下每张图的宽高比（带 fallback）
const aspectRatioOf = (image: ImageInfo) => {
  if (image?.width != null && image?.height != null && image.width > 0 && image.height > 0) {
    return image.width / image.height;
  }
  return effectiveAspectRatio.value || 16 / 10;
};

/**
 * 均衡分配 masonry 项到 N 个桶（列或行）。
 * 垂直方向：桶=列，列宽相等，项高度 ∝ 1/ratio → 选择累计高度最小的桶。
 * 水平方向：桶=行，行高相等，项宽度 ∝ ratio     → 选择累计宽度最小的桶。
 */
const galleryBuckets = computed<Array<Array<{ image: ImageInfo; index: number }>>>(() => {
  const n = Math.max(1, gridColumnsCount.value);
  const buckets: Array<Array<{ image: ImageInfo; index: number }>> = Array.from({ length: n }, () => []);
  const loads = new Array(n).fill(0);
  const list = props.images ?? [];
  const horizontal = isHorizontal.value;
  list.forEach((image, index) => {
    const ratio = aspectRatioOf(image);
    const weight = horizontal ? (ratio > 0 ? ratio : 1) : 1 / (ratio > 0 ? ratio : 1);
    let target = 0;
    for (let i = 1; i < n; i++) if (loads[i] < loads[target]) target = i;
    buckets[target].push({ image, index });
    loads[target] += weight;
  });
  return buckets;
});

const galleryStyle = computed<Record<string, string>>(() => ({
  gap: `${gridGapPx.value}px`,
  paddingTop: `${BASE_GRID_PADDING_Y.value}px`,
  paddingBottom: `${BASE_GRID_PADDING_Y.value}px`,
  paddingLeft: `${BASE_GRID_PADDING_X.value}px`,
  paddingRight: `${BASE_GRID_PADDING_X.value}px`,
}));

const estimatedItemHeight = () => {
  const container = scrollEl.value;
  if (!container) return 240;
  const ratio = effectiveAspectRatio.value || 16 / 9;
  if (isHorizontal.value) {
    const availableHeight =
      container.clientHeight - BASE_GRID_PADDING_Y.value * 2 - gridGapPx.value * (gridColumnsCount.value - 1);
    const rowHeight = Math.max(1, availableHeight / gridColumnsCount.value);
    return rowHeight * ratio;
  }
  const availableWidth =
    container.clientWidth - BASE_GRID_PADDING_X.value * 2 - gridGapPx.value * (gridColumnsCount.value - 1);
  const columnWidth = Math.max(1, availableWidth / gridColumnsCount.value);
  // 行高估算应与 ImageItem 实际使用的 aspectRatio 一致，否则虚拟滚动 paddingTop 会漂移
  return columnWidth / ratio;
};

const rowHeightWithGap = computed(() => {
  const h = measuredItemHeight.value ?? estimatedItemHeight();
  return h + gridGapPx.value;
});

// 限制拖拽滚动最大速度：每 0.2 秒滚动一行
useDragScroll(scrollEl, {
  maxVelocityPxPerMs: () => rowHeightWithGap.value / 100,
});

const totalRows = computed(() => {
  if (gridColumnsCount.value <= 0) return 0;
  return Math.ceil((props.images ?? []).length / gridColumnsCount.value);
});

const virtualPaddingTop = computed(() => {
  if (!virtualScrollActive.value || isHorizontal.value) return 0;
  return virtualStartRow.value * rowHeightWithGap.value;
});

const virtualPaddingBottom = computed(() => {
  if (!virtualScrollActive.value || isHorizontal.value) return 0;
  const rowsAfter = Math.max(0, totalRows.value - (virtualEndRow.value + 1));
  return rowsAfter * rowHeightWithGap.value;
});

const virtualPaddingLeft = computed(() => {
  if (!virtualScrollActive.value || !isHorizontal.value) return 0;
  return virtualStartRow.value * rowHeightWithGap.value;
});

const virtualPaddingRight = computed(() => {
  if (!virtualScrollActive.value || !isHorizontal.value) return 0;
  const groupsAfter = Math.max(0, totalRows.value - (virtualEndRow.value + 1));
  return groupsAfter * rowHeightWithGap.value;
});

const getGridScrollOffset = () => {
  const container = scrollEl.value;
  const grid = container?.querySelector<HTMLElement>(".image-grid");
  if (!container || !grid) return 0;
  const containerRect = container.getBoundingClientRect();
  const gridRect = grid.getBoundingClientRect();
  if (isHorizontal.value) {
    return Math.max(0, gridRect.left - containerRect.left + container.scrollLeft);
  }
  return Math.max(0, gridRect.top - containerRect.top + container.scrollTop);
};

const updateVirtualRange = () => {
  if (!virtualScrollActive.value) return;
  const container = scrollEl.value;
  if (!container) return;
  const rh = rowHeightWithGap.value || 1;
  const gridOffset = getGridScrollOffset();
  const scrollPos = Math.max(0, (isHorizontal.value ? container.scrollLeft : container.scrollTop) - gridOffset);
  const viewportSize = (isHorizontal.value ? container.clientWidth : container.clientHeight) || 0;
  const startRow = Math.floor(scrollPos / rh);
  const endRow = Math.ceil((scrollPos + viewportSize) / rh);
  const overscan = virtualOverscanRows.value;
  const nextStart = Math.max(0, startRow - overscan);
  const nextEnd = Math.max(nextStart, Math.min(totalRows.value - 1, endRow + overscan));
  virtualStartRow.value = isFinite(nextStart) ? nextStart : 0;
  virtualEndRow.value = isFinite(nextEnd) ? nextEnd : 0;
};

const measureItemHeight = () => {
  if (!virtualScrollActive.value) return;
  if (!canMeasureLayout()) return;
  const grid = scrollEl.value?.querySelector<HTMLElement>(".image-grid");
  const firstItem = grid?.querySelector<HTMLElement>(".image-item");
  if (firstItem) {
    const rect = firstItem.getBoundingClientRect();
    const h = isHorizontal.value ? rect.width : rect.height;
    measuredItemHeight.value = h > 1 ? h : estimatedItemHeight();
  } else {
    measuredItemHeight.value = estimatedItemHeight();
  }
};

const renderedItems = computed(() => {
  if (!virtualScrollActive.value) return [];
  const cols = gridColumnsCount.value;
  const start = Math.max(0, virtualStartRow.value * cols);
  const list = props.images ?? [];
  const end = Math.min(list.length, (virtualEndRow.value + 1) * cols);
  const out: Array<{ image: ImageInfo; index: number; isEntering: boolean }> = [];

  // 添加当前可视区域的图片
  for (let i = start; i < end; i++) {
    const img = list[i];
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

const gridStyle = computed(() => {
  const n = gridColumnsCount.value;
  const gap = gridGapPx.value;
  const paddingTop = BASE_GRID_PADDING_Y.value + (virtualScrollActive.value ? virtualPaddingTop.value : 0);
  const paddingBottom = BASE_GRID_PADDING_Y.value + (virtualScrollActive.value ? virtualPaddingBottom.value : 0);
  const paddingLeft = BASE_GRID_PADDING_X.value + (virtualScrollActive.value ? virtualPaddingLeft.value : 0);
  const paddingRight = BASE_GRID_PADDING_X.value + (virtualScrollActive.value ? virtualPaddingRight.value : 0);
  const style: Record<string, string> = {
    gap: `${gap}px`,
    paddingTop: `${paddingTop}px`,
    paddingBottom: `${paddingBottom}px`,
    paddingLeft: `${paddingLeft}px`,
    paddingRight: `${paddingRight}px`,
  };
  if (isHorizontal.value) {
    // 水平方向：N 行，按 aspect-ratio 自适应宽度，横向滚动
    style.gridTemplateRows = `repeat(${n}, 1fr)`;
    style.gridAutoFlow = "column";
    style.gridAutoColumns = "auto";
    style.height = "100%";
  } else {
    style.gridTemplateColumns = `repeat(${n}, 1fr)`;
    // 紧凑模式：行高由该行最高图决定，格子不拉伸
    if (isCompact.value) {
      style.alignItems = "start";
    }
  }
  return style as any;
});

const closeContextMenu = () => {
  selectedIds.value = new Set();
  contextMenuVisible.value = false;
  contextMenuImage.value = null;
};

watch(() => selectedIds.value.size, (size) => {
  if (size === 0) closeContextMenu();
});

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
    const id = (props.images ?? [])[i]?.id;
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

  // 预览打开时屏蔽 Ctrl+/- 和 Ctrl+A
  if (isPreviewOpen.value) {
    if (props.enableCtrlKeyAdjustColumns && (event.ctrlKey || event.metaKey)) {
      if (event.key === "+" || event.key === "=" || event.key === "-" || event.key === "_") {
        return;
      }
    }
    if ((event.ctrlKey || event.metaKey) && (event.key === "a" || event.key === "A")) {
      return;
    }
  }

  // Ctrl/Cmd + +/-：调整列数（原来是 window 监听）
  // 紧凑布局下不允许调整列数
  if (!isCompact.value && props.enableCtrlKeyAdjustColumns && (event.ctrlKey || event.metaKey)) {
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
    const list = props.images ?? [];
    selectedIds.value = new Set(list.map((img) => img.id));
    lastSelectedIndex.value = list.length > 0 ? list.length - 1 : -1;
    return;
  }

  // Ctrl/Cmd + C：复制（仅单选；多选请走右键菜单）
  if ((event.ctrlKey || event.metaKey) && (event.key === "c" || event.key === "C")) {
    if (selectedIds.value.size !== 1) return;
    const onlyId = Array.from(selectedIds.value)[0];
    const image = onlyId ? (props.images ?? []).find((img) => img.id === onlyId) : undefined;
    if (!image) return;
    event.preventDefault();
    void dispatchContextCommand(buildContextPayload("copy", image));
    return;
  }

  // Backspace：隐藏；Delete：删除。grid 只负责发出意图，具体语义由父组件处理。
  if ((event.key === "Backspace" || event.key === "Delete") && selectedIds.value.size > 0) {
    event.preventDefault();
    const list = props.images ?? [];
    const first = list.find((img) => selectedIds.value.has(img.id)) || list[0];
    if (first) {
      const command = event.key === "Backspace" ? "addToHidden" : "remove";
      void dispatchContextCommand(buildContextPayload(command, first));
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

  // 紧凑模式选择模式下，点击空白处不清空选择（仅通过取消按钮退出）
  if (isCompact.value && androidSelectionMode.value) {
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
  
  // 紧凑模式选择模式下的点击行为
  if (isCompact.value && androidSelectionMode.value) {
    toggleSelection(image.id, index);
    return;
  }

  // 紧凑模式非选择模式下，单击直接预览
  if (isCompact.value && !androidSelectionMode.value) {
    const action = settingsStore.values.imageClickAction || "none";
    if (action === "preview") {
      if (IS_ANDROID && isVideoMediaType(image.type) && image.localPath) {
        void tryOpenVideo(image.localPath);
        return;
      }
      previewRef.value?.open(index);
      return;
    }
    if (action === "open") {
      void dispatchContextCommand(buildContextPayload("open", image));
      return;
    }
    return;
  }
  
  // 桌面端原有逻辑
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
  // 紧凑模式选择中：快速连点会触发 dblclick，避免误开预览（单击已由 handleItemClick 处理）
  if (isCompact.value && androidSelectionMode.value) {
    return;
  }
  if (isCompact.value || IS_WEB) {
    previewRef.value?.open(index);
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
  if (!enableContextMenu.value) return;
  if (isCompact.value && androidSelectionMode.value) {
    if (IS_ANDROID && isVideoMediaType(image.type) && image.localPath) {
      void tryOpenVideo(image.localPath);
      return;
    }
    previewRef.value?.open(index);
    return;
  }
  openContextMenu(image, index, event);
  focusGrid();
};

const buildContextPayload = (command: ContextCommand, image: ImageInfo): ContextCommandPayload => {
  const selected = new Set(selectedIds.value);
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
  // Android 全选/取消全选：由 Grid 处理，不关闭菜单、不交给父组件
  if (command === "selectAll") {
    const list = props.images ?? [];
    selectedIds.value = new Set(list.map((img) => img.id));
    lastSelectedIndex.value = list.length > 0 ? list.length - 1 : -1;
    return;
  }
  if (command === "deselectAll") {
    clearSelection();
    return;
  }
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
  if (!props.enableScrollStableEmit) return;
  if (scrollStableTimer) window.clearTimeout(scrollStableTimer);
  scrollStableTimer = window.setTimeout(() => emit("scroll-stable"), props.scrollStableDelay);
};

const pulseZoomAnimation = () => {
  const container = scrollEl.value;
  if (!container) return;
  const grid = container.querySelector<HTMLElement>(".image-grid, .image-gallery");
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
  if (!virtualScrollActive.value) return;
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
  () => props.enableVirtualScroll,
  () => {
    scheduleVirtualUpdate();
  }
);

// 布局/方向变化：重新测量行高 + 滚动范围
watch([layoutMode, layoutDirection], () => {
  scheduleVirtualUpdate();
});

// 丝滑滚轮：累加目标位置，用 rAF + lerp 把离散 wheel 事件转成平滑滚动；
// 水平布局下把 deltaY 转成横向；Ctrl/Meta+Wheel 留给列数调整。
const smoothWheel = {
  targetX: 0,
  targetY: 0,
  raf: null as number | null,
  active: false,
};
// 越大越跟手、越小越"漂"；snap 为终止阈值。
const SMOOTH_WHEEL_EASE = 0.22;
const SMOOTH_WHEEL_SNAP = 0.5;

const stepSmoothWheel = () => {
  smoothWheel.raf = null;
  const el = scrollEl.value;
  if (!el) {
    smoothWheel.active = false;
    return;
  }
  const maxX = Math.max(0, el.scrollWidth - el.clientWidth);
  const maxY = Math.max(0, el.scrollHeight - el.clientHeight);
  smoothWheel.targetX = Math.max(0, Math.min(maxX, smoothWheel.targetX));
  smoothWheel.targetY = Math.max(0, Math.min(maxY, smoothWheel.targetY));
  const curX = el.scrollLeft;
  const curY = el.scrollTop;
  const dx = smoothWheel.targetX - curX;
  const dy = smoothWheel.targetY - curY;
  const nextX = Math.abs(dx) < SMOOTH_WHEEL_SNAP ? smoothWheel.targetX : curX + dx * SMOOTH_WHEEL_EASE;
  const nextY = Math.abs(dy) < SMOOTH_WHEEL_SNAP ? smoothWheel.targetY : curY + dy * SMOOTH_WHEEL_EASE;
  if (nextX !== curX) el.scrollLeft = nextX;
  if (nextY !== curY) el.scrollTop = nextY;
  const done =
    Math.abs(smoothWheel.targetX - el.scrollLeft) < SMOOTH_WHEEL_SNAP &&
    Math.abs(smoothWheel.targetY - el.scrollTop) < SMOOTH_WHEEL_SNAP;
  if (done) {
    smoothWheel.active = false;
    return;
  }
  smoothWheel.raf = requestAnimationFrame(stepSmoothWheel);
};

// 其它交互（拖拽/键盘/程序化）要独占滚动时，取消当前 wheel 动画，避免相互抢占。
const cancelSmoothWheel = () => {
  if (smoothWheel.raf != null) {
    cancelAnimationFrame(smoothWheel.raf);
    smoothWheel.raf = null;
  }
  smoothWheel.active = false;
};

const handleSmoothWheel = (event: WheelEvent) => {
  if (event.ctrlKey || event.metaKey) return;
  if (event.deltaY === 0 && event.deltaX === 0) return;
  const el = scrollEl.value;
  if (!el) return;
  // 预览 / 弹窗 / 抽屉打开时不接管滚动（避免底层 grid 跟着滚）
  if (isPreviewOpen.value) return;
  const target = event.target as HTMLElement | null;
  if (
    target?.closest(
      ".image-preview-dialog,.el-dialog,.el-drawer,.el-popper,.el-overlay,.pswp"
    )
  )
    return;
  // 事件目标不在当前 scrollEl 内部（例如冒泡自 teleport 的弹层）也不处理
  if (target && !el.contains(target)) return;
  // deltaMode: 0=像素, 1=行, 2=页
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? el.clientHeight || 0 : 1;
  const dy = event.deltaY * unit;
  const dx = event.deltaX * unit;
  event.preventDefault();
  // 非动画中时以真实滚动位置为起点，避免与外部滚动/跳转叠加
  if (!smoothWheel.active) {
    smoothWheel.targetX = el.scrollLeft;
    smoothWheel.targetY = el.scrollTop;
  }
  if (isHorizontal.value) {
    // 水平布局：deltaY 直接推动 scrollLeft；同时尊重触控板横向 deltaX
    smoothWheel.targetX += dy + dx;
  } else {
    smoothWheel.targetY += dy;
    smoothWheel.targetX += dx;
  }
  if (!smoothWheel.active) {
    smoothWheel.active = true;
    smoothWheel.raf = requestAnimationFrame(stepSmoothWheel);
  }
};

// 虚拟滚动：滚动时用 rAF 实时更新可视行，避免 debounce 导致“滚快一点出现空白区域”
let virtualScrollRaf: number | null = null;
const scheduleVirtualRangeUpdate = () => {
  if (!virtualScrollActive.value) return;
  if (virtualScrollRaf != null) return;
  virtualScrollRaf = requestAnimationFrame(() => {
    virtualScrollRaf = null;
    updateVirtualRange();
  });
};

let boundScrollEl: HTMLElement | null = null;

const unbindScrollElement = () => {
  const el = boundScrollEl;
  if (!el) return;
  el.removeEventListener("scroll", emitScrollStable as any);
  el.removeEventListener("scroll", scheduleVirtualRangeUpdate as any);
  el.removeEventListener("scroll", saveScrollPosition as any);
  el.removeEventListener("wheel", handleSmoothWheel as any);
  el.removeEventListener("scroll-buttons-scroll-command", cancelSmoothWheel as any);
  el.removeEventListener("pointerdown", cancelSmoothWheel as any, { capture: true } as any);
  boundScrollEl = null;
};

const bindScrollElement = (el: HTMLElement | null) => {
  if (boundScrollEl === el) return;
  unbindScrollElement();
  if (!el) return;
  boundScrollEl = el;
  setupContainerResizeObserver(el);
  // 1) scroll-stable（内部已用 setTimeout 防抖）
  el.addEventListener("scroll", emitScrollStable, { passive: true } as any);
  // 2) 虚拟滚动范围：每帧更新一次（避免空白）
  el.addEventListener("scroll", scheduleVirtualRangeUpdate, { passive: true } as any);
  // 记录滚动位置（rAF 节流，尽量便宜）
  el.addEventListener("scroll", saveScrollPosition, { passive: true } as any);
  // 丝滑滚轮：rAF + lerp 将离散 wheel 累加到目标位置（保留 Ctrl+Wheel 给列数调整）
  el.addEventListener("wheel", handleSmoothWheel, { passive: false } as any);
  // 外部滚动按钮发起程序化滚动时，也要停止当前 wheel 动画，避免下一帧把 scrollTop 拉回旧目标。
  el.addEventListener("scroll-buttons-scroll-command", cancelSmoothWheel as any);
  // 指针按下时终止 wheel 动画，避免与拖拽滚动/程序化滚动互相抢写 scrollLeft/Top
  el.addEventListener("pointerdown", cancelSmoothWheel, { passive: true, capture: true } as any);
  scheduleVirtualUpdate();
};

watch(
  scrollEl,
  (el) => {
    bindScrollElement(el);
  },
  { immediate: true, flush: "post" },
);

onMounted(async () => {
  updateWindowAspectRatio();
  window.addEventListener("resize", updateWindowAspectRatio);

  // 紧凑模式下不允许通过 Ctrl+Wheel 调整列数
  if (!isCompact.value) {
    window.addEventListener(
      "wheel",
      (e: WheelEvent) => {
        if (!props.enableCtrlWheelAdjustColumns) return;
        if (!(e.ctrlKey || e.metaKey)) return;
        if (shouldIgnoreKeyTarget(e as any)) return;
        // 预览打开时屏蔽 Ctrl+Wheel 调整列数
        if (isPreviewOpen.value) return;
        // 检查事件是否来自预览对话框内部（双重保险）
        const target = e.target as HTMLElement | null;
        if (target?.closest(".image-preview-dialog") || target?.closest(".el-dialog")) {
          return;
        }
        const delta = e.deltaY > 0 ? 1 : -1;
        uiStore.adjustImageGridColumn(delta);
      },
      { passive: true }
    );
  }
});

onUnmounted(async () => {
  window.removeEventListener("resize", updateWindowAspectRatio);
  unbindScrollElement();
  if (smoothWheel.raf != null) {
    cancelAnimationFrame(smoothWheel.raf);
    smoothWheel.raf = null;
  }
  smoothWheel.active = false;
  if (modalStackId.value) {
    modalStackStore.remove(modalStackId.value);
    modalStackId.value = null;
  }
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
  isComponentActive.value = true;
  // keep-alive 激活后恢复滚动位置；并刷新虚拟滚动范围，避免显示错位
  if (!scrollEl.value) return;
  setupContainerResizeObserver();
  if (savedScrollPos.value > 0) {
    requestAnimationFrame(() => {
      const el = scrollEl.value;
      if (!el) return;
      if (isHorizontal.value) el.scrollLeft = savedScrollPos.value;
      else el.scrollTop = savedScrollPos.value;
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
  isComponentActive.value = false;
});

// 检测图片列表变化，标记新增/删除的图片（仅虚拟滚动模式）
watch(
  () => props.images,
  (newImages) => {
    emitScrollStable();
    scheduleVirtualUpdate();

    const newIds = new Set((newImages ?? []).map((img) => img.id));
    const oldIds = previousImageIds.value;

    // 列表里的播放目标如果被移除（换页/筛选/删除），重置播放状态，避免悬挂的"已播放但目标已不存在"
    if (playingVideoId.value && !newIds.has(playingVideoId.value)) {
      playingVideoId.value = null;
    }

    // 判断是否是刷新/换页（新旧列表完全没有交集）还是图片增减
    const hasIntersection = oldIds.size > 0 && [...oldIds].some((id) => newIds.has(id));

    if (isComponentActive.value) {
      if (oldIds.size > 0 && !hasIntersection) {
        // 刷新/换页：新旧列表完全不同，清空选择
        clearSelection();
        // 换页时平滑滚动到顶部/起点，避免保留上一页的滚动位置
        nextTick(() => {
          const el = scrollEl.value;
          if (!el) return;
          if (isHorizontal.value) el.scrollTo({ left: 0, behavior: "smooth" });
          else el.scrollTo({ top: 0, behavior: "smooth" });
        });
      } else if (selectedIds.value.size > 0) {
        // 图片增减：从选择中移除被删除的图片
        const newSelected = new Set([...selectedIds.value].filter((id) => newIds.has(id)));
        if (newSelected.size !== selectedIds.value.size) {
          selectedIds.value = newSelected;
          // 如果 lastSelectedIndex 对应的图片被删除了，重置索引
          if (lastSelectedIndex.value >= 0) {
            const lastImg = (newImages ?? [])[lastSelectedIndex.value];
            if (!lastImg || !newSelected.has(lastImg.id)) {
              lastSelectedIndex.value = newSelected.size > 0 ? -1 : -1;
            }
          }
        }
      }
    }

    // 非虚拟滚动模式下不需要手动处理动画（transition-group 会自动处理）
    if (!props.enableVirtualScroll) {
      previousImageIds.value = newIds;
      return;
    }

    // 关键：当上层"先清空再重建列表"（如换大页/强制刷新）时，
    // 若这里照常计算 leavingItems，会导致旧页的可视区项与新页项在同一索引区间同时渲染，
    // 表现为"隔一个空位/一行只有一半"的错觉（旧项可能还没 URL，只剩骨架）。
    // 把"列表被清空"视为硬重置：直接清空动画跟踪，避免跨页混渲染。
    const newList = newImages ?? [];
    if (newList.length === 0) {
      enteringIds.value = new Set();
      previousImageIds.value = new Set();
      return;
    }

    // 检测新增的图片
    for (const img of newList) {
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

const scrollToVirtualGridIndex = (index: number) => {
  const container = scrollEl.value;
  if (!container) return false;
  const cols = gridColumnsCount.value;
  if (cols <= 0) return false;

  const group = Math.floor(index / cols);
  const gridOffset = getGridScrollOffset();
  cancelSmoothWheel();

  if (isHorizontal.value) {
    const itemLeft = gridOffset + BASE_GRID_PADDING_X.value + group * rowHeightWithGap.value;
    const itemRight = itemLeft + (measuredItemHeight.value ?? estimatedItemHeight());
    const viewportLeft = container.scrollLeft;
    const viewportRight = viewportLeft + container.clientWidth;
    if (itemLeft < viewportLeft) {
      container.scrollTo({ left: itemLeft, behavior: "smooth" });
    } else if (itemRight > viewportRight) {
      container.scrollTo({ left: itemRight - container.clientWidth, behavior: "smooth" });
    }
    return true;
  }

  const itemTop = gridOffset + BASE_GRID_PADDING_Y.value + group * rowHeightWithGap.value;
  const itemBottom = itemTop + (measuredItemHeight.value ?? estimatedItemHeight());
  const viewportTop = container.scrollTop;
  const viewportBottom = viewportTop + container.clientHeight;
  if (itemTop < viewportTop) {
    container.scrollTo({ top: itemTop, behavior: "smooth" });
  } else if (itemBottom > viewportBottom) {
    container.scrollTo({ top: itemBottom - container.clientHeight, behavior: "smooth" });
  }
  return true;
};

// 滚动到指定索引的图片（基于 DOM 元素位置，兼容主轴方向）
const scrollToIndex = (index: number) => {
  const container = scrollEl.value;
  if (!container) return;
  const list = props.images ?? [];
  if (index < 0 || index >= list.length) return;

  const imageId = list[index].id;
  const el = container.querySelector<HTMLElement>(`[data-id="${imageId}"]`);
  if (!el) {
    if (virtualScrollActive.value) {
      scrollToVirtualGridIndex(index);
    }
    return;
  }

  const containerRect = container.getBoundingClientRect();
  const elRect = el.getBoundingClientRect();

  cancelSmoothWheel();
  if (isHorizontal.value) {
    const elLeft = elRect.left - containerRect.left + container.scrollLeft;
    const elRight = elLeft + elRect.width;
    const viewportLeft = container.scrollLeft;
    const viewportRight = viewportLeft + container.clientWidth;
    if (elLeft < viewportLeft) {
      container.scrollTo({ left: elLeft, behavior: "smooth" });
    } else if (elRight > viewportRight) {
      container.scrollTo({ left: elRight - container.clientWidth, behavior: "smooth" });
    }
  } else {
    const elTop = elRect.top - containerRect.top + container.scrollTop;
    const elBottom = elTop + elRect.height;
    const viewportTop = container.scrollTop;
    const viewportBottom = viewportTop + container.clientHeight;
    if (elTop < viewportTop) {
      container.scrollTo({ top: elTop, behavior: "smooth" });
    } else if (elBottom > viewportBottom) {
      container.scrollTo({ top: elBottom - container.clientHeight, behavior: "smooth" });
    }
  }
};

// 监听预览索引变化，同步选中项和视口
watch(
  currentPreviewIndex,
  (newIndex) => {
    // 仅在预览打开且非多选时执行
    if (!isPreviewOpen.value || selectedIds.value.size > 1) return;
    const list = props.images ?? [];
    if (newIndex < 0 || newIndex >= list.length) return;

    const image = list[newIndex];
    if (!image) return;

    // 紧凑模式下预览与选择解耦，不同步选中项
    if (isCompact.value) {
      // 仅滚动到目标图片
      scrollToIndex(newIndex);
      return;
    }

    // 更新选中项为当前预览图片
    setSingleSelection(image.id, newIndex);

    // 滚动到目标图片
    scrollToIndex(newIndex);
  }
);

// 退出紧凑模式选择模式（清空选择）
const exitAndroidSelectionMode = () => {
  if (!isCompact.value) return;
  clearSelection();
};

// Android：选择模式用 useModalBack，弹栈时通过 onClose 清除选择状态
useModalBack(androidSelectionMode, { onClose: clearSelection });

const getContainerEl = () => scrollEl.value ?? containerEl.value;

defineExpose({
  getContainerEl,
  getSelectedIds: () => new Set(selectedIds.value),
  clearSelection,
  exitAndroidSelectionMode,
});
</script>

<style scoped lang="scss">
.image-grid-container {
  height: 100%;
  display: flex;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
  overflow: hidden;
  outline: none;

  &.scrolls-whole-container {
    display: block;
    overflow-y: auto;
    overflow-x: hidden;

    &.layout-horizontal {
      overflow-x: auto;
      overflow-y: hidden;
    }

    .image-grid-scroll {
      overflow: visible;
      height: auto;
      min-height: 0;
    }
  }
}

.image-grid-container:focus {
  outline: none;
}

.image-grid-container:focus-visible {
  outline: none;
}

.image-grid-scroll {
  flex: 1 1 0;
  min-height: 0;
  min-width: 0;

  &.layout-vertical {
    overflow-y: auto;
    overflow-x: hidden;
  }

  &.layout-horizontal {
    overflow-x: auto;
    overflow-y: hidden;
    height: 100%;
  }
}

.hide-scrollbar .image-grid-scroll {
  scrollbar-width: none;
}

.hide-scrollbar .image-grid-scroll::-webkit-scrollbar {
  display: none;
}

.hide-scrollbar.scrolls-whole-container {
  scrollbar-width: none;
}

.hide-scrollbar.scrolls-whole-container::-webkit-scrollbar {
  display: none;
}

.image-grid-root {
  position: relative;
}

.image-grid-container.layout-horizontal .image-grid-root {
  height: 100%;
}

.image-grid-items {
  min-height: 100%;
}

.image-grid-container.layout-horizontal .image-grid-items {
  height: 100%;
  min-height: 0;
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

/* CSS Grid 水平方向：N 行，按内容宽度自动成列 */
.image-grid.layout-horizontal {
  width: max-content;
}

.image-gallery {
  display: flex;
  min-height: 100%;
}

/* 垂直 masonry：N 列纵向堆叠 */
.image-gallery.layout-vertical {
  flex-direction: row;
}

.image-gallery-column {
  flex: 1 1 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

/* 水平 masonry：N 行横向铺开，容器横向滚动 */
.image-gallery.layout-horizontal {
  flex-direction: column;
  height: 100%;
  width: max-content;
}

.image-gallery-row {
  flex: 1 1 0;
  min-height: 0;
  display: flex;
  flex-direction: row;
  align-items: stretch;
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
