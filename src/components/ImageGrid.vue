<template>
  <div class="image-grid-root" :class="{ 'is-zooming': isZoomingLayout }" @click="handleRootClick" ref="rootEl">
    <div ref="gridContainerEl" class="image-grid-container" :style="containerStyle">
      <transition-group v-if="!useVirtualScroll || isMeasuring" name="fade-in-list" tag="div" class="image-grid" :style="gridStyle">
        <ImageItem v-for="(image, index) in images" :key="image.id" :image="image" :image-url="imageUrlMap[image.id]"
          :image-click-action="imageClickAction" :use-original="props.columns > 0 && props.columns <= 2"
          :aspect-ratio-match-window="props.aspectRatioMatchWindow" :window-aspect-ratio="props.windowAspectRatio"
          :selected="effectiveSelectedIds.has(image.id)" :can-move-item="canMoveItem" :grid-columns="actualColumns"
          :grid-index="index" :total-images="images.length" @click="(e) => handleItemClick(image, index, e)"
          @dblclick="(e) => handleItemDblClick(image, e)" @contextmenu="(e) => handleItemContextMenu(image, index, e)"
          @move="(img, dir) => handleMove(img, dir)" />
      </transition-group>
      <div v-else class="image-grid" :style="gridStyle">
        <ImageItem v-for="(image, index) in visibleImages" :key="image.id" :image="image" :image-url="imageUrlMap[image.id]"
          :image-click-action="imageClickAction" :use-original="props.columns > 0 && props.columns <= 2"
          :aspect-ratio-match-window="props.aspectRatioMatchWindow" :window-aspect-ratio="props.windowAspectRatio"
          :selected="effectiveSelectedIds.has(image.id)" :can-move-item="canMoveItem" :grid-columns="actualColumns"
          :grid-index="virtualStartIndex + index" :total-images="images.length"
          @click="(e) => handleItemClick(image, virtualStartIndex + index, e)"
          @dblclick="(e) => handleItemDblClick(image, e)"
          @contextmenu="(e) => handleItemContextMenu(image, virtualStartIndex + index, e)"
          @move="(img, dir) => handleMove(img, dir)" />
      </div>
    </div>

    <!-- 加载更多（下沉到 ImageGrid，可由父组件控制显示） -->
    <!-- 当图片列表为空时，不显示加载更多按钮，避免与空白占位元素同时显示 -->
    <LoadMoreButton v-if="showLoadMoreButton && images.length > 0" :has-more="hasMore" :loading="loadingMore"
      @load-more="emit('loadMore')" />

    <!-- 右键菜单（下沉到 ImageGrid，可由父组件控制是否启用） -->
    <GalleryContextMenu v-if="enableContextMenu" :visible="contextMenuVisible" :position="contextMenuPosition"
      :image="contextMenuImage" :selected-count="effectiveSelectedIds.size" :selected-image-ids="effectiveSelectedIds"
      @close="closeContextMenu" @command="handleContextMenuCommand" />

    <!-- 图片预览对话框（下沉到 ImageGrid，el-dialog 默认会 teleport 到 body） -->
    <el-dialog v-model="previewVisible" title="图片预览" width="90%" :close-on-click-modal="true"
      class="image-preview-dialog" :show-close="true" :lock-scroll="true" @close="closePreview">
      <div v-if="previewImageUrl" class="preview-container" @contextmenu.prevent.stop="handlePreviewContextMenu">
        <img :src="previewImageUrl" class="preview-image" alt="预览图片" />
      </div>
    </el-dialog>

    <!-- 预览对话框中的右键菜单（使用 teleport 确保在应用顶层） -->
    <Teleport to="body">
      <GalleryContextMenu v-if="enableContextMenu && previewContextMenuVisible" :visible="previewContextMenuVisible"
        :position="previewContextMenuPosition" :image="previewImage" :selected-count="1"
        :selected-image-ids="previewImage ? new Set([previewImage.id]) : new Set()" @close="closePreviewContextMenu"
        @command="handlePreviewContextMenuCommand" />
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch, nextTick } from "vue";
import ImageItem from "./ImageItem.vue";
import type { ImageInfo } from "@/stores/crawler";
import LoadMoreButton from "@/components/LoadMoreButton.vue";
import GalleryContextMenu from "@/components/GalleryContextMenu.vue";

interface Props {
  images: ImageInfo[];
  imageUrlMap: Record<string, { thumbnail?: string; original?: string }>;
  imageClickAction: "preview" | "open";
  columns: number; // 0 表示自动（auto-fill），其他值表示固定列数
  aspectRatioMatchWindow: boolean; // 图片宽高比是否与窗口相同
  windowAspectRatio: number; // 窗口宽高比
  /**
   * 兼容旧用法：由父组件控制选中集合（ImageGrid 不维护选择状态）
   * - 当该值传入时，ImageGrid 将使用它做高亮展示，并继续通过 imageSelect/contextmenu 等事件向上交互
   */
  selectedImages?: Set<string>;

  /**
   * 新用法：将单选/多选逻辑下沉到 ImageGrid
   */
  allowSelect?: boolean; // 是否允许选择（单选/多选逻辑在 grid 内）
  enableContextMenu?: boolean; // 是否启用 grid 内置右键菜单展示

  /**
   * 加载更多能力（下沉）
   */
  showLoadMoreButton?: boolean; // 是否显示加载更多区域
  hasMore?: boolean; // 是否还有更多
  loadingMore?: boolean; // 是否正在加载更多

  /**
   * 移动 item 能力（箭头/事件）
   */
  canMoveItem?: boolean; // 是否允许移动 item
}

const props = defineProps<Props>();

const emit = defineEmits<{
  imageClick: [image: ImageInfo, event?: MouseEvent];
  imageDblClick: [image: ImageInfo, event?: MouseEvent];
  imageSelect: [image: ImageInfo, event: MouseEvent];
  contextmenu: [event: MouseEvent, image: ImageInfo];
  move: [image: ImageInfo, direction: "up" | "down" | "left" | "right"]; // 箭头移动
  loadMore: [];
  selectionChange: [selectedIds: Set<string>];
  contextCommand: [
    payload: {
      command: string;
      image: ImageInfo;
      selectedImageIds: Set<string>;
    }
  ];
}>();

const allowSelect = computed(() => props.allowSelect ?? false);
const enableContextMenu = computed(() => props.enableContextMenu ?? false);
const showLoadMoreButton = computed(() => props.showLoadMoreButton ?? false);
const hasMore = computed(() => props.hasMore ?? false);
const loadingMore = computed(() => props.loadingMore ?? false);
const canMoveItem = computed(() => props.canMoveItem ?? true);

// 内置选择状态（仅在 allowSelect=true 且未传入 selectedImages 时启用）
const internalSelectedIds = ref<Set<string>>(new Set());
const lastSelectedIndex = ref<number>(-1);

const effectiveSelectedIds = computed<Set<string>>(() => {
  return props.selectedImages ?? internalSelectedIds.value;
});

// 右键菜单状态（仅在 enableContextMenu=true 时使用）
const contextMenuVisible = ref(false);
const contextMenuImage = ref<ImageInfo | null>(null);
const contextMenuPosition = ref({ x: 0, y: 0 });

// 图片预览状态
const previewVisible = ref(false);
const previewImageUrl = ref("");
const previewImagePath = ref("");
const previewImage = ref<ImageInfo | null>(null);

// 预览对话框中的右键菜单状态
const previewContextMenuVisible = ref(false);
const previewContextMenuPosition = ref({ x: 0, y: 0 });

// 缩放（列数变化）时启用 move 动画：平时仍保持 none，避免新增/加载更多导致的抖动
const isZoomingLayout = ref(false);
let zoomAnimTimer: ReturnType<typeof setTimeout> | null = null;

// 虚拟滚动相关
const rootEl = ref<HTMLElement | null>(null);
const gridContainerEl = ref<HTMLElement | null>(null);
const useVirtualScroll = computed(() => props.images.length >= 200);
const VIRTUAL_SCROLL_BUFFER = 2; // 额外渲染的行数（上下各2行）
const GRID_GAP = 16; // 网格间距（与 CSS 中的 gap 保持一致）

// 虚拟滚动状态
const scrollTop = ref(0);
const containerHeight = ref(0);
const rowHeight = ref(0);
const calculatedCols = ref(0); // 计算出的列数（用于 auto-fill）
const isMeasuring = ref(true); // 是否处于测量模式（初始时需要渲染所有元素来测量）

const cols = computed(() => {
  if (actualColumns.value > 0) {
    return actualColumns.value;
  }
  // 对于 auto-fill，使用计算出的列数
  return calculatedCols.value;
});

// 计算可见范围
const virtualStartIndex = computed(() => {
  if (!useVirtualScroll.value || rowHeight.value === 0 || cols.value === 0) {
    return 0;
  }
  const startRow = Math.max(0, Math.floor(scrollTop.value / rowHeight.value) - VIRTUAL_SCROLL_BUFFER);
  return startRow * cols.value;
});

const virtualEndIndex = computed(() => {
  if (!useVirtualScroll.value || rowHeight.value === 0 || cols.value === 0) {
    return props.images.length;
  }
  const visibleRows = Math.ceil(containerHeight.value / rowHeight.value);
  const endRow = Math.min(
    Math.ceil(props.images.length / cols.value),
    Math.ceil(scrollTop.value / rowHeight.value) + visibleRows + VIRTUAL_SCROLL_BUFFER
  );
  return Math.min(props.images.length, endRow * cols.value);
});

const visibleImages = computed(() => {
  if (!useVirtualScroll.value || isMeasuring.value || cols.value === 0 || rowHeight.value === 0) {
    // 如果虚拟滚动未启用，或处于测量模式，或列数/行高未计算完成，渲染所有图片
    return props.images;
  }
  return props.images.slice(virtualStartIndex.value, virtualEndIndex.value);
});

// 计算占位符高度
const paddingTop = computed(() => {
  if (!useVirtualScroll.value || rowHeight.value === 0 || cols.value === 0) {
    return 0;
  }
  const startRow = Math.max(0, Math.floor(scrollTop.value / rowHeight.value) - VIRTUAL_SCROLL_BUFFER);
  return startRow * rowHeight.value;
});

const paddingBottom = computed(() => {
  if (!useVirtualScroll.value || rowHeight.value === 0 || cols.value === 0) {
    return 0;
  }
  const totalRows = Math.ceil(props.images.length / cols.value);
  const endRow = Math.min(
    totalRows,
    Math.ceil(scrollTop.value / rowHeight.value) +
      Math.ceil(containerHeight.value / rowHeight.value) +
      VIRTUAL_SCROLL_BUFFER
  );
  const remainingRows = totalRows - endRow;
  return Math.max(0, remainingRows * rowHeight.value);
});

const containerStyle = computed(() => {
  if (!useVirtualScroll.value || isMeasuring.value || cols.value === 0 || rowHeight.value === 0) {
    // 如果虚拟滚动未启用，或处于测量模式，或列数/行高未计算完成，不使用占位符
    return {};
  }
  return {
    paddingTop: `${paddingTop.value}px`,
    paddingBottom: `${paddingBottom.value}px`,
  };
});

// 计算行高和列数（从 DOM 获取）
const calculateDimensions = () => {
  if (!useVirtualScroll.value || !gridContainerEl.value) {
    return;
  }
  const grid = gridContainerEl.value.querySelector<HTMLElement>(".image-grid");
  if (!grid) {
    return;
  }
  const items = grid.querySelectorAll<HTMLElement>(".image-item");
  if (items.length === 0) {
    return;
  }
  
  const firstItem = items[0] as HTMLElement;
  const firstRect = firstItem.getBoundingClientRect();
  const computedStyle = window.getComputedStyle(grid);
  const gap = parseFloat(computedStyle.gap) || GRID_GAP;
  
  // 计算行高
  const newRowHeight = firstRect.height + gap;
  if (newRowHeight > 0) {
    rowHeight.value = newRowHeight;
  }
  
  // 如果是 auto-fill，计算列数
  if (actualColumns.value === 0) {
    let colsCount = 1;
    for (let i = 1; i < items.length; i++) {
      const rect = items[i].getBoundingClientRect();
      if (Math.abs(rect.top - firstRect.top) < 15) {
        colsCount++;
      } else {
        break;
      }
    }
    if (colsCount > 0) {
      calculatedCols.value = colsCount;
    }
  }
  
  // 如果测量完成，退出测量模式
  if (isMeasuring.value && rowHeight.value > 0 && cols.value > 0) {
    isMeasuring.value = false;
  }
};

// 计算列数（对于 auto-fill）
const calculateColumns = () => {
  if (!useVirtualScroll.value || actualColumns.value > 0 || !gridContainerEl.value) {
    return;
  }
  const grid = gridContainerEl.value.querySelector<HTMLElement>(".image-grid");
  if (!grid) {
    return;
  }
  const items = grid.querySelectorAll<HTMLElement>(".image-item");
  if (items.length === 0) {
    return;
  }
  // 计算第一行有多少个元素
  const firstRect = items[0].getBoundingClientRect();
  let colsCount = 1;
  for (let i = 1; i < items.length; i++) {
    const rect = items[i].getBoundingClientRect();
    if (Math.abs(rect.top - firstRect.top) < 15) {
      colsCount++;
    } else {
      break;
    }
  }
  calculatedCols.value = colsCount;
};

// 处理滚动事件
const handleScroll = () => {
  if (!useVirtualScroll.value || !rootEl.value) {
    return;
  }
  const container = rootEl.value.closest(".gallery-view") as HTMLElement | null;
  if (!container) {
    return;
  }
  scrollTop.value = container.scrollTop;
  containerHeight.value = container.clientHeight;
};

// 初始化虚拟滚动
const initVirtualScroll = () => {
  if (!useVirtualScroll.value) {
    return;
  }
  nextTick(() => {
    const container = rootEl.value?.closest(".gallery-view") as HTMLElement | null;
    if (!container) {
      return;
    }
    containerHeight.value = container.clientHeight;
    scrollTop.value = container.scrollTop;
    
    // 延迟计算，等待 DOM 渲染完成
    setTimeout(() => {
      calculateDimensions();
    }, 100);
    
    // 监听滚动
    container.addEventListener("scroll", handleScroll, { passive: true });
    
    // 使用 ResizeObserver 监听容器大小变化
    const resizeObserver = new ResizeObserver(() => {
      containerHeight.value = container.clientHeight;
      calculateDimensions();
    });
    resizeObserver.observe(container);
    
    // 保存清理函数
    (rootEl.value as any).__resizeObserver = resizeObserver;
  });
};

// 清理虚拟滚动
const cleanupVirtualScroll = () => {
  const container = rootEl.value?.closest(".gallery-view") as HTMLElement | null;
  if (container) {
    container.removeEventListener("scroll", handleScroll);
  }
  if (rootEl.value && (rootEl.value as any).__resizeObserver) {
    (rootEl.value as any).__resizeObserver.disconnect();
    delete (rootEl.value as any).__resizeObserver;
  }
};

const prefersReducedMotion = () => {
  try {
    return window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false;
  } catch {
    return false;
  }
};

// 计算实际列数
const actualColumns = computed(() => {
  if (props.columns > 0) {
    return props.columns;
  }
  // 对于 auto-fill，返回 0，让 ImageItem 从 DOM 计算实际列数
  return 0;
});

const syncSelectionToParent = () => {
  // 只在内部模式下向外同步
  if (props.selectedImages) return;
  if (!allowSelect.value) return;
  emit("selectionChange", new Set(internalSelectedIds.value));
};

const setSingleSelection = (imageId: string, index: number) => {
  internalSelectedIds.value = new Set([imageId]);
  lastSelectedIndex.value = index;
  syncSelectionToParent();
};

const toggleSelection = (imageId: string, index: number) => {
  const next = new Set(internalSelectedIds.value);
  if (next.has(imageId)) next.delete(imageId);
  else next.add(imageId);
  internalSelectedIds.value = next;
  lastSelectedIndex.value = index;
  syncSelectionToParent();
};

const rangeSelect = (index: number) => {
  if (lastSelectedIndex.value === -1) return;
  const start = Math.min(lastSelectedIndex.value, index);
  const end = Math.max(lastSelectedIndex.value, index);
  const next = new Set(internalSelectedIds.value);
  for (let i = start; i <= end; i++) {
    const id = props.images[i]?.id;
    if (id) next.add(id);
  }
  internalSelectedIds.value = next;
  syncSelectionToParent();
};

const isBlockingOverlayOpen = () => {
  if (!enableContextMenu.value && !allowSelect.value) return false;
  const overlays = Array.from(document.querySelectorAll<HTMLElement>(".el-overlay"));
  return overlays.some((el) => {
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  });
};

const handleItemClick = (image: ImageInfo, index: number, event?: MouseEvent) => {
  // 兼容旧用法：仍把点击事件向上抛
  emit("imageClick", image, event);

  // 内置选择逻辑（仅在内部模式启用）
  if (!allowSelect.value || props.selectedImages || !event) return;
  if (isBlockingOverlayOpen()) return;

  // Ctrl/Cmd/Shift 多选
  if (event.shiftKey) {
    rangeSelect(index);
    return;
  }
  if (event.ctrlKey || event.metaKey) {
    toggleSelection(image.id, index);
    return;
  }
  // 普通单击：单选
  setSingleSelection(image.id, index);
};

const handleItemDblClick = (image: ImageInfo, event?: MouseEvent) => {
  emit("imageDblClick", image, event);

  // 如果 imageClickAction 是 preview，打开预览对话框
  if (props.imageClickAction === "preview") {
    const imageUrl = props.imageUrlMap[image.id]?.original || props.imageUrlMap[image.id]?.thumbnail;
    if (imageUrl) {
      previewImageUrl.value = imageUrl;
      previewImagePath.value = image.localPath;
      previewImage.value = image;
      previewVisible.value = true;
    }
  }
};

const syncSelectionForRightClick = (image: ImageInfo, index: number) => {
  // 仅内部选择模式才需要（外部受控/不允许选择时忽略）
  if (!allowSelect.value || props.selectedImages) return;
  const current = internalSelectedIds.value;
  if (current.size > 0 && !current.has(image.id)) {
    // 已有选择但右键在未选中图片上：切换为单选该图片
    setSingleSelection(image.id, index);
  } else if (current.size === 0) {
    setSingleSelection(image.id, index);
  }
};

const openContextMenu = (image: ImageInfo, index: number, event: MouseEvent) => {
  contextMenuImage.value = image;
  contextMenuPosition.value = { x: event.clientX, y: event.clientY };
  contextMenuVisible.value = true;

  // 右键时同步选择逻辑（仅内部模式）
  syncSelectionForRightClick(image, index);
};

const closeContextMenu = () => {
  contextMenuVisible.value = false;
  contextMenuImage.value = null;
};

const handleItemContextMenu = (image: ImageInfo, index: number, event: MouseEvent) => {
  // 即使不启用内置菜单，也要保证“右键未选中项 -> 切换选择”生效（便于父组件自定义菜单）
  syncSelectionForRightClick(image, index);

  // 兼容旧用法：仍向上抛出 contextmenu（父组件可自行展示菜单）
  emit("contextmenu", event, image);

  if (!enableContextMenu.value) return;
  if (isBlockingOverlayOpen()) return;

  openContextMenu(image, index, event);
};

const handleContextMenuCommand = (command: string) => {
  if (!contextMenuImage.value) return;
  const payload = {
    command,
    image: contextMenuImage.value,
    selectedImageIds: new Set(effectiveSelectedIds.value),
  };
  closeContextMenu();
  emit("contextCommand", payload);
};

// 处理箭头移动（可开关）
const handleMove = (image: ImageInfo, direction: "up" | "down" | "left" | "right") => {
  if (!canMoveItem.value) return;
  emit("move", image, direction);
};

// 对外暴露：让父组件在执行批量命令后清空选择（选择逻辑仍在 grid 内）
const clearSelection = () => {
  if (props.selectedImages) return; // 外部受控时由父组件清理
  internalSelectedIds.value = new Set();
  lastSelectedIndex.value = -1;
  syncSelectionToParent();
};

defineExpose({
  clearSelection,
});

// 计算网格列样式
const gridStyle = computed(() => {
  if (props.columns === 0) {
    // 自动列数
    return {
      gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))'
    };
  } else {
    // 固定列数
    return {
      gridTemplateColumns: `repeat(${props.columns}, 1fr)`
    };
  }
});

// 空白处点击：优先关菜单，其次清理单选（多选保留）
const handleRootClick = (event: MouseEvent) => {
  if (!allowSelect.value || props.selectedImages) return;
  if (isBlockingOverlayOpen()) return;

  const target = event.target as HTMLElement | null;
  const clickedOutside =
    !target?.closest(".image-item") &&
    !target?.closest(".context-menu") &&
    !target?.closest(".el-dialog");

  if (!clickedOutside) return;

  if (contextMenuVisible.value) {
    closeContextMenu();
    return;
  }

  if (internalSelectedIds.value.size === 1) {
    internalSelectedIds.value = new Set();
    lastSelectedIndex.value = -1;
    syncSelectionToParent();
  }
};

// 键盘快捷键（仅内部选择模式）
const handleKeyDown = (event: KeyboardEvent) => {
  if (!allowSelect.value || props.selectedImages) return;
  if (isBlockingOverlayOpen()) return;

  const target = event.target as HTMLElement | null;
  const tag = target?.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target?.isContentEditable) {
    return;
  }

  // ESC：清空选择
  if (event.key === "Escape") {
    internalSelectedIds.value = new Set();
    lastSelectedIndex.value = -1;
    closeContextMenu();
    syncSelectionToParent();
    return;
  }

  // Ctrl/Cmd + A：全选
  if ((event.ctrlKey || event.metaKey) && (event.key === "a" || event.key === "A")) {
    event.preventDefault();
    internalSelectedIds.value = new Set(props.images.map((img) => img.id));
    lastSelectedIndex.value = props.images.length > 0 ? props.images.length - 1 : -1;
    syncSelectionToParent();
    return;
  }

  // Backspace / Delete：交给父组件执行删除逻辑（grid 只负责发出意图）
  if (event.key === "Backspace" && internalSelectedIds.value.size > 0) {
    event.preventDefault();
    emit("contextCommand", {
      command: "remove",
      image: props.images.find((img) => internalSelectedIds.value.has(img.id)) || props.images[0],
      selectedImageIds: new Set(internalSelectedIds.value),
    });
    return;
  }
  if (event.key === "Delete" && internalSelectedIds.value.size > 0) {
    event.preventDefault();
    emit("contextCommand", {
      command: "delete",
      image: props.images.find((img) => internalSelectedIds.value.has(img.id)) || props.images[0],
      selectedImageIds: new Set(internalSelectedIds.value),
    });
    return;
  }
};

onMounted(() => {
  if (allowSelect.value && !props.selectedImages) {
    window.addEventListener("keydown", handleKeyDown);
  }
  if (useVirtualScroll.value) {
    initVirtualScroll();
  }
});

onUnmounted(() => {
  window.removeEventListener("keydown", handleKeyDown);
  cleanupVirtualScroll();
});

watch(
  () => props.columns,
  (next, prev) => {
    if (next === prev) return;
    if (prefersReducedMotion()) return;

    isZoomingLayout.value = true;
    if (zoomAnimTimer) clearTimeout(zoomAnimTimer);
    // 给 transition-group 的 move 过渡留出足够时间（也覆盖节流/连滚）
    zoomAnimTimer = setTimeout(() => {
      isZoomingLayout.value = false;
      zoomAnimTimer = null;
    }, 450);
    
    // 列数变化时重新计算行高
    if (useVirtualScroll.value) {
      nextTick(() => {
        calculateDimensions();
      });
    }
  },
  // 尽量在本次渲染前打开 class，确保 move 过渡对本次重排生效
  { flush: "pre" }
);

// 监听图片数量变化，重新计算尺寸
watch(
  () => props.images.length,
  () => {
    if (useVirtualScroll.value) {
      nextTick(() => {
        calculateDimensions();
      });
    }
  }
);

// 监听虚拟滚动启用状态
watch(
  useVirtualScroll,
  (enabled) => {
    if (enabled) {
      isMeasuring.value = true; // 进入测量模式
      nextTick(() => {
        initVirtualScroll();
      });
    } else {
      cleanupVirtualScroll();
      isMeasuring.value = false;
    }
  },
  { immediate: true }
);

// 关闭预览对话框
const closePreview = () => {
  previewVisible.value = false;
  previewImageUrl.value = "";
  previewImagePath.value = "";
  previewImage.value = null;
  closePreviewContextMenu();
};

// 处理预览对话框中的右键菜单
const handlePreviewContextMenu = (event: MouseEvent) => {
  if (!enableContextMenu.value || !previewImage.value) return;
  previewContextMenuPosition.value = { x: event.clientX, y: event.clientY };
  previewContextMenuVisible.value = true;
};

// 关闭预览对话框中的右键菜单
const closePreviewContextMenu = () => {
  previewContextMenuVisible.value = false;
};

// 处理预览对话框中的右键菜单命令
const handlePreviewContextMenuCommand = (command: string) => {
  if (!previewImage.value) return;
  const payload = {
    command,
    image: previewImage.value,
    selectedImageIds: new Set([previewImage.value.id]),
  };
  closePreviewContextMenu();
  emit("contextCommand", payload);
};

watch(
  () => props.images,
  () => {
    // 列表变化时：内部选择集清理掉已不存在的 id
    if (!allowSelect.value || props.selectedImages) return;
    const ids = new Set(props.images.map((i) => i.id));
    const next = new Set<string>();
    internalSelectedIds.value.forEach((id) => {
      if (ids.has(id)) next.add(id);
    });
    if (next.size !== internalSelectedIds.value.size) {
      internalSelectedIds.value = next;
      syncSelectionToParent();
    }
  },
  { deep: false }
);
</script>

<style scoped lang="scss">
.image-grid-root {
  width: 100%;
}

.image-grid-container {
  width: 100%;
  position: relative;
}

.image-grid {
  display: grid;
  gap: 16px;
  width: 100%;
  /* 为图片悬浮上移效果留出空间，避免被容器截断 */
  padding-top: 6px;
  padding-bottom: 6px;
}

/* 列表淡入动画 */
.image-grid-root :deep(.fade-in-list-enter-active) {
  transition: all 0.4s ease-out;
}

.image-grid-root :deep(.fade-in-list-leave-active) {
  transition: all 0.3s ease-in;
}

.image-grid-root :deep(.fade-in-list-enter-from) {
  opacity: 0;
  transform: translateY(20px) scale(0.95);
}

.image-grid-root :deep(.fade-in-list-leave-to) {
  opacity: 0;
  transform: scale(0.9);
}

.image-grid-root :deep(.fade-in-list-move) {
  /* 避免新增元素时旧元素产生移动动画导致列表上跳闪烁 */
  transition: none;
}

.image-grid-root.is-zooming :deep(.fade-in-list-move) {
  /* 缩放（列数变化）时：允许元素平滑移动 */
  transition: transform 0.4s ease;
  will-change: transform;
}
</style>

<style lang="scss">
.image-preview-dialog.el-dialog {
  max-width: 90vw !important;
  max-height: 90vh !important;
  margin: 5vh auto !important;
  display: flex !important;
  flex-direction: column !important;
  overflow: hidden !important;

  .el-dialog__header {
    flex-shrink: 0 !important;
    padding: 15px 20px !important;
    min-height: 50px !important;
  }

  .el-dialog__body {
    flex: 1 1 auto !important;
    padding: 0 !important;
    display: flex !important;
    justify-content: center !important;
    align-items: center !important;
    overflow: hidden !important;
    min-height: 0 !important;
    max-height: calc(90vh - 50px) !important;
  }

  .preview-container {
    width: 100%;
    height: 100%;
    max-width: 100%;
    max-height: 100%;
    display: flex;
    justify-content: center;
    align-items: center;
    padding: 20px;
    overflow: hidden;
    box-sizing: border-box;
  }

  .preview-image {
    max-width: calc(90vw - 40px) !important;
    max-height: calc(90vh - 90px) !important;
    width: auto;
    height: auto;
    object-fit: contain;
    display: block;
    cursor: pointer;
  }
}
</style>
