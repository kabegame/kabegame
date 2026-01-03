<template>
  <div class="image-grid-root" :class="{ 'is-zooming': isZoomingLayout, 'is-reordering': isReordering }"
    @click="handleRootClick">
    <!-- 空状态显示 -->
    <EmptyState v-if="images.length === 0 && showEmptyState" />

    <transition-group v-else name="fade-in-list" tag="div" class="image-grid" :class="{ 'reorder-mode': isReorderMode }"
      :style="gridStyle">
      <ImageItem v-for="(image, index) in images" :key="image.id" :image="image" :image-url="imageUrlMap[image.id]"
        :image-click-action="imageClickAction" :use-original="props.columns > 0 && props.columns <= 2"
        :aspect-ratio-match-window="props.aspectRatioMatchWindow" :window-aspect-ratio="props.windowAspectRatio"
        :selected="effectiveSelectedIds.has(image.id)" :grid-columns="actualColumns" :grid-index="index"
        :total-images="images.length" :is-reorder-mode="isReorderMode"
        :reorder-selected="isReorderMode && reorderSourceIndex === index"
        @click="(e) => handleItemClick(image, index, e)" @dblclick="(e) => handleItemDblClick(image, index, e)"
        @contextmenu="(e) => handleItemContextMenu(image, index, e)" @long-press="() => handleLongPress(index)"
        @reorder-click="() => handleReorderClick(index)" />
    </transition-group>

    <!-- 加载更多（下沉到 ImageGrid，可由父组件控制显示） -->
    <!-- 当图片列表为空但 hasMore 为 true 时，仍需显示加载更多按钮，避免用户删除当前页后无法继续加载 -->
    <LoadMoreButton v-if="showLoadMoreButton && (images.length > 0 || hasMore)" :has-more="hasMore"
      :loading="loadingMore" @load-more="emit('loadMore')" />

    <!-- 右键菜单（下沉到 ImageGrid，可由父组件控制是否启用） -->
    <GalleryContextMenu v-if="enableContextMenu" :visible="contextMenuVisible" :position="contextMenuPosition"
      :image="contextMenuImage" :selected-count="effectiveSelectedIds.size" :selected-image-ids="effectiveSelectedIds"
      @close="closeContextMenu" @command="handleContextMenuCommand" />

    <!-- 图片预览对话框（下沉到 ImageGrid，el-dialog 默认会 teleport 到 body） -->
    <el-dialog v-model="previewVisible" title="图片预览" width="90%" :close-on-click-modal="true"
      class="image-preview-dialog" :show-close="true" :lock-scroll="true" @close="closePreview">
      <div v-if="previewImageUrl" ref="previewContainerRef" class="preview-container"
        @contextmenu.prevent.stop="handlePreviewDialogContextMenu" @mousemove="handlePreviewMouseMoveWithDrag"
        @mouseleave="handlePreviewMouseLeaveAll" @wheel.prevent="handlePreviewWheel" @mouseup="stopPreviewDrag">
        <!-- 左侧 1/5 热区：仅鼠标靠近时显示按钮 -->
        <div class="preview-nav-zone left" :class="{ visible: previewHoverSide === 'left' }" @click.stop="goPrev">
          <button class="preview-nav-btn" type="button" :class="{ disabled: !canGoPrev }" aria-label="上一张">
            <el-icon>
              <ArrowLeftBold />
            </el-icon>
          </button>
        </div>
        <!-- 右侧 1/5 热区：仅鼠标靠近时显示按钮 -->
        <div class="preview-nav-zone right" :class="{ visible: previewHoverSide === 'right' }" @click.stop="goNext">
          <button class="preview-nav-btn" type="button" :class="{ disabled: !canGoNext }" aria-label="下一张">
            <el-icon>
              <ArrowRightBold />
            </el-icon>
          </button>
        </div>
        <img ref="previewImageRef" :src="previewImageUrl" class="preview-image" alt="预览图片" :style="previewImageStyle"
          @load="handlePreviewImageLoad" @mousedown.prevent.stop="startPreviewDrag" @dragstart.prevent />
      </div>
    </el-dialog>

    <!-- 预览对话框中的右键菜单 -->
    <div class="preview-context-menu-wrapper">
      <GalleryContextMenu v-if="enableContextMenu && previewContextMenuVisible" :visible="previewContextMenuVisible"
        :position="previewContextMenuPosition" :image="previewImage" :selected-count="1"
        :selected-image-ids="previewImage ? new Set([previewImage.id]) : new Set()" @close="closePreviewContextMenu"
        @command="handlePreviewContextMenuCommand" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import ImageItem from "./ImageItem.vue";
import type { ImageInfo } from "@/stores/crawler";
import LoadMoreButton from "@/components/LoadMoreButton.vue";
import GalleryContextMenu from "@/components/GalleryContextMenu.vue";
import EmptyState from "@/components/common/EmptyState.vue";
import { ElMessage } from "element-plus";
import { ArrowLeftBold, ArrowRightBold } from "@element-plus/icons-vue";

interface Props {
  images: ImageInfo[];
  imageUrlMap: Record<string, { thumbnail?: string; original?: string }>;
  imageClickAction: "preview" | "open";
  columns: number; // 列数，表示固定列数
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
   * 空状态显示
   */
  showEmptyState?: boolean; // 是否在 images 为空时显示空状态组件

  /**
   * 是否启用长按调整顺序功能
   */
  enableReorder?: boolean; // 是否启用长按进入调整顺序模式
}

// 图片顺序调整状态
const isReorderMode = ref(false);
const reorderSourceIndex = ref<number>(-1); // 当前选中的图片索引（用于交换）

const props = defineProps<Props>();

const emit = defineEmits<{
  imageClick: [image: ImageInfo, event?: MouseEvent];
  imageDblClick: [image: ImageInfo, event?: MouseEvent];
  imageSelect: [image: ImageInfo, event: MouseEvent];
  contextmenu: [event: MouseEvent, image: ImageInfo];
  loadMore: [];
  selectionChange: [selectedIds: Set<string>];
  contextCommand: [
    payload: {
      command: string;
      image: ImageInfo;
      selectedImageIds: Set<string>;
    }
  ];
  reorder: [newOrder: ImageInfo[]]; // 调整顺序
}>();

const allowSelect = computed(() => props.allowSelect ?? false);
const enableContextMenu = computed(() => props.enableContextMenu ?? false);
const showLoadMoreButton = computed(() => props.showLoadMoreButton ?? false);
const hasMore = computed(() => props.hasMore ?? false);
const loadingMore = computed(() => props.loadingMore ?? false);
const showEmptyState = computed(() => props.showEmptyState ?? false);
const enableReorder = computed(() => props.enableReorder ?? true);

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
const previewIndex = ref<number>(-1);
const previewHoverSide = ref<"left" | "right" | null>(null);

// 预览缩放/拖拽状态
const previewContainerRef = ref<HTMLElement | null>(null);
const previewImageRef = ref<HTMLImageElement | null>(null);
const previewScale = ref(1);
const previewTranslateX = ref(0);
const previewTranslateY = ref(0);
const previewBaseSize = ref({ width: 0, height: 0 });
const previewContainerSize = ref({ width: 0, height: 0 });
const previewAvailableSize = ref({ width: 0, height: 0 }); // 减去 padding 后的实际可用尺寸
const previewDragging = ref(false);
const previewDragStart = ref({ x: 0, y: 0 });
const previewDragStartTranslate = ref({ x: 0, y: 0 });

const clamp = (val: number, min: number, max: number) => Math.min(max, Math.max(min, val));

const clampTranslate = (nextScale: number, nextX: number, nextY: number) => {
  const available = previewAvailableSize.value;
  const base = previewBaseSize.value;
  if (available.width > 0 && available.height > 0 && base.width > 0 && base.height > 0) {
    // 计算缩放后的图片尺寸
    const scaledWidth = base.width * nextScale;
    const scaledHeight = base.height * nextScale;

    // 如果缩放后的图片小于等于容器，则不允许拖拽（居中显示）
    if (scaledWidth <= available.width && scaledHeight <= available.height) {
      return { x: 0, y: 0 };
    }

    // 如果缩放后的图片大于容器，计算允许的最大偏移量
    const maxOffsetX = Math.max(0, (scaledWidth - available.width) / 2);
    const maxOffsetY = Math.max(0, (scaledHeight - available.height) / 2);
    return {
      x: clamp(nextX, -maxOffsetX, maxOffsetX),
      y: clamp(nextY, -maxOffsetY, maxOffsetY),
    };
  }
  return { x: nextX, y: nextY };
};

const setPreviewTransform = (nextScale: number, nextX: number, nextY: number) => {
  const clampedScale = clamp(nextScale, 1, 10);
  const { x, y } = clampTranslate(clampedScale, nextX, nextY);
  previewScale.value = clampedScale;
  previewTranslateX.value = x;
  previewTranslateY.value = y;
};

const measureContainerSize = () => {
  const containerRect = previewContainerRef.value?.getBoundingClientRect();
  if (containerRect) {
    previewContainerSize.value = { width: containerRect.width, height: containerRect.height };
    // 容器尺寸即为可用尺寸（已移除 padding）
    previewAvailableSize.value = {
      width: containerRect.width,
      height: containerRect.height
    };
  }
};

const measureBaseSize = () => {
  // 只在 scale=1 时测量基准尺寸，确保后续缩放/拖拽边界计算正确
  const imageRect = previewImageRef.value?.getBoundingClientRect();
  if (imageRect && previewScale.value === 1) {
    previewBaseSize.value = { width: imageRect.width, height: imageRect.height };
  }
};

// 确保在图片完全渲染后测量尺寸
const measureSizesAfterRender = async () => {
  await nextTick();
  // 等待一帧，确保浏览器完成布局
  await new Promise(resolve => requestAnimationFrame(resolve));
  measureContainerSize();
  measureBaseSize();
};

const resetPreviewTransform = async () => {
  setPreviewTransform(1, 0, 0);
  await measureSizesAfterRender();
};

const previewImageStyle = computed(() => ({
  transform: `translate(${previewTranslateX.value}px, ${previewTranslateY.value}px) scale(${previewScale.value})`,
  transition: previewDragging.value ? "none" : "transform 0.08s ease-out",
  cursor: previewScale.value > 1 ? (previewDragging.value ? "grabbing" : "grab") : "default",
  "transform-origin": "center center",
}));

// 预览导航：当末尾还想“下一张”但尚未加载出来时，暂存待前进步数
const pendingNext = ref<number>(0);
const loadMoreRequestedByPreview = ref(false);

const isTextInputLike = (target: EventTarget | null) => {
  const el = target as HTMLElement | null;
  const tag = el?.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || !!el?.isContentEditable;
};

const setPreviewByIndex = (index: number) => {
  const img = props.images[index];
  if (!img) return;
  const imageUrl = props.imageUrlMap[img.id]?.original || props.imageUrlMap[img.id]?.thumbnail;
  if (!imageUrl) return;

  previewIndex.value = index;
  previewImageUrl.value = imageUrl;
  previewImagePath.value = img.localPath;
  previewImage.value = img;
  resetPreviewTransform();
};

const canGoPrev = computed(() => {
  // 只有 0/1 张时，严格意义没有"上一张"
  if (props.images.length <= 1) return false;
  // 在第一张时：没有上一张（显示灰色），但点击仍可回到最后一张
  if (previewIndex.value === 0) return false;
  return true;
});

const canGoNext = computed(() => {
  if (props.images.length <= 1) return false;
  const lastIndex = props.images.length - 1;
  // 不在最后一张：有下一张
  if (previewIndex.value >= 0 && previewIndex.value < lastIndex) return true;
  // 在最后一张时：如果 hasMore=true，表示还能加载更多，认为"下一张"可用（点击会触发 loadMore）
  // 如果 hasMore=false，没有下一张（显示灰色）
  return hasMore.value;
});

const goPrev = () => {
  if (!previewVisible.value) return;
  if (props.images.length <= 1) {
    ElMessage.info("没有上一张");
    return;
  }
  if (previewIndex.value > 0) {
    setPreviewByIndex(previewIndex.value - 1);
    return;
  }
  // 第一张：回到当前能看到的最后一张（无论 hasMore）
  setPreviewByIndex(props.images.length - 1);
};

const goNext = () => {
  if (!previewVisible.value) return;
  if (props.images.length <= 1) {
    ElMessage.info("没有下一张");
    return;
  }
  const lastIndex = props.images.length - 1;
  if (previewIndex.value >= 0 && previewIndex.value < lastIndex) {
    setPreviewByIndex(previewIndex.value + 1);
    return;
  }

  // 已经在末尾：如果还有更多，记录一次“想要下一张”，并触发 loadMore
  if (hasMore.value) {
    pendingNext.value += 1;
    tryFulfillPendingNext();
    return;
  }

  // 已经在末尾且没有更多：回到第一张，并提示用户
  if (props.images.length > 0) {
    setPreviewByIndex(0);
    ElMessage.info("已回到第一张");
  }
};

const tryFulfillPendingNext = () => {
  // 尽可能消耗 pendingNext（如果已经有更多图片了，就直接前进）
  while (pendingNext.value > 0 && previewIndex.value >= 0 && previewIndex.value < props.images.length - 1) {
    setPreviewByIndex(previewIndex.value + 1);
    pendingNext.value -= 1;
  }

  // 还想前进，但目前已到末尾：如果还有更多并且不在加载中，则触发一次 loadMore
  const atEnd = previewIndex.value >= 0 && previewIndex.value >= props.images.length - 1;
  if (
    pendingNext.value > 0 &&
    atEnd &&
    hasMore.value &&
    !loadingMore.value &&
    !loadMoreRequestedByPreview.value
  ) {
    loadMoreRequestedByPreview.value = true;
    emit("loadMore");
    return;
  }

  // 如果确定没有更多（hasMore=false）但仍在等待“下一张”，则回滚到当前能拿到的第一张
  if (pendingNext.value > 0 && atEnd && !hasMore.value && !loadingMore.value) {
    pendingNext.value = 0;
    loadMoreRequestedByPreview.value = false;
    if (props.images.length > 0) {
      setPreviewByIndex(0);
      ElMessage.info("已回到第一张");
    }
  }
};

// 预览对话框中的右键菜单状态
const previewContextMenuVisible = ref(false);
const previewContextMenuPosition = ref({ x: 0, y: 0 });

// 缩放（列数变化）时启用 move 动画：平时仍保持 none，避免新增/加载更多导致的抖动
const isZoomingLayout = ref(false);
let zoomAnimTimer: ReturnType<typeof setTimeout> | null = null;

// 交换图片时启用 move 动画
const isReordering = ref(false);
let reorderAnimTimer: ReturnType<typeof setTimeout> | null = null;

const prefersReducedMotion = () => {
  try {
    return window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false;
  } catch {
    return false;
  }
};

// 计算实际列数
const actualColumns = computed(() => {
  // 列数为多少就是多少，不再使用 0 表示自动
  return props.columns;
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
  // 如果处于调整模式，点击由 handleReorderClick 处理
  if (isReorderMode.value) {
    handleReorderClick(index);
    return;
  }

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

const handleItemDblClick = (image: ImageInfo, index: number, event?: MouseEvent) => {
  // 调整模式下禁用双击
  if (isReorderMode.value) {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    return;
  }

  emit("imageDblClick", image, event);

  // 如果 imageClickAction 是 preview，打开预览对话框
  if (props.imageClickAction === "preview") {
    const imageUrl = props.imageUrlMap[image.id]?.original || props.imageUrlMap[image.id]?.thumbnail;
    if (imageUrl) {
      previewImageUrl.value = imageUrl;
      previewImagePath.value = image.localPath;
      previewImage.value = image;
      previewIndex.value = index;
      pendingNext.value = 0;
      loadMoreRequestedByPreview.value = false;
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
  // 调整模式下则退出调整模式
  if (isReorderMode.value) {
    exitReorderMode();
    return;
  }

  // 即使不启用内置菜单，也要保证"右键未选中项 -> 切换选择"生效（便于父组件自定义菜单）
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


// 处理长按进入调整模式
const handleLongPress = (index: number) => {
  if (!enableReorder.value) return; // 如果禁用 reorder，直接返回
  if (isReorderMode.value) return; // 已经在调整模式，忽略
  isReorderMode.value = true;
  reorderSourceIndex.value = index;
};

// 处理调整模式下的点击（交换顺序）
const handleReorderClick = (targetIndex: number) => {
  if (!isReorderMode.value) return;

  let sourceIndex = reorderSourceIndex.value;

  // 如果源索引无效（理论上不应该发生，因为 handleLongPress 已设置），使用当前点击的索引作为源
  if (sourceIndex === -1) {
    reorderSourceIndex.value = targetIndex;
    return;
  }

  // 点击同一张图片，不交换，但保持选中状态
  if (sourceIndex === targetIndex) return;

  // 交换两张图片的位置（减少复制操作：使用 slice 只复制一次数组）
  const newOrder = props.images.slice();
  [newOrder[sourceIndex], newOrder[targetIndex]] = [newOrder[targetIndex], newOrder[sourceIndex]];

  // 启用交换动画
  isReordering.value = true;
  if (reorderAnimTimer) clearTimeout(reorderAnimTimer);
  // 给 transition-group 的 move 过渡留出足够时间
  reorderAnimTimer = setTimeout(() => {
    isReordering.value = false;
    reorderAnimTimer = null;
  }, 450);

  // 先发送后端命令，然后通过事件通知父组件更新顺序
  emit("reorder", newOrder);

  // 退出调整模式
  exitReorderMode();
};

// 对外暴露：让父组件在执行批量命令后清空选择（选择逻辑仍在 grid 内）
const clearSelection = () => {
  if (props.selectedImages) return; // 外部受控时由父组件清理
  internalSelectedIds.value = new Set();
  lastSelectedIndex.value = -1;
  syncSelectionToParent();
};

// 退出调整模式
const exitReorderMode = () => {
  isReorderMode.value = false;
  reorderSourceIndex.value = -1;
};

defineExpose({
  clearSelection,
  exitReorderMode,
});

// 计算网格列样式
const gridStyle = computed(() => {
  // 列数为多少就是多少，不再使用 0 表示自动
  // 如果列数为 0 或负数，使用 1 作为最小值（避免 CSS 错误）
  const columns = props.columns > 0 ? props.columns : 1;
  return {
    gridTemplateColumns: `repeat(${columns}, 1fr)`
  };
});

// 空白处点击：优先关菜单，其次清理单选（多选保留），退出调整模式
const handleRootClick = (event: MouseEvent) => {
  const target = event.target as HTMLElement | null;
  const clickedOutside =
    !target?.closest(".image-item") &&
    !target?.closest(".context-menu") &&
    !target?.closest(".el-dialog");

  // 如果处于调整模式且点击了空白处，退出调整模式
  if (isReorderMode.value && clickedOutside) {
    isReorderMode.value = false;
    reorderSourceIndex.value = -1;
    return;
  }

  if (!allowSelect.value || props.selectedImages) return;
  if (isBlockingOverlayOpen()) return;

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

  // ESC：退出调整模式或清空选择
  if (event.key === "Escape") {
    if (isReorderMode.value) {
      isReorderMode.value = false;
      reorderSourceIndex.value = -1;
      return;
    }
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
      command: "remove",
      image: props.images.find((img) => internalSelectedIds.value.has(img.id)) || props.images[0],
      selectedImageIds: new Set(internalSelectedIds.value),
    });
    return;
  }
};

// 处理页面刷新/离开
const handleBeforeUnload = () => {
  if (isReorderMode.value) {
    exitReorderMode();
  }
};

// 处理 tab 可见性变化
const handleVisibilityChange = () => {
  if (document.hidden && isReorderMode.value) {
    // tab 切换到后台时退出调整模式
    exitReorderMode();
  }
};

onMounted(() => {
  if (allowSelect.value && !props.selectedImages) {
    window.addEventListener("keydown", handleKeyDown);
  }

  // 预览对话框左右键切换
  window.addEventListener("keydown", handlePreviewKeyDown);

  // 监听页面刷新/离开
  window.addEventListener("beforeunload", handleBeforeUnload);

  // 监听 tab 可见性变化
  document.addEventListener("visibilitychange", handleVisibilityChange);
});

onUnmounted(() => {
  window.removeEventListener("keydown", handleKeyDown);
  window.removeEventListener("keydown", handlePreviewKeyDown);
  window.removeEventListener("beforeunload", handleBeforeUnload);
  document.removeEventListener("visibilitychange", handleVisibilityChange);
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
  },
  // 尽量在本次渲染前打开 class，确保 move 过渡对本次重排生效
  { flush: "pre" }
);

// 关闭预览对话框
const closePreview = () => {
  previewVisible.value = false;
  previewImageUrl.value = "";
  previewImagePath.value = "";
  previewImage.value = null;
  previewIndex.value = -1;
  pendingNext.value = 0;
  loadMoreRequestedByPreview.value = false;
  previewHoverSide.value = null;
  closePreviewContextMenu();
};

const handlePreviewKeyDown = (event: KeyboardEvent) => {
  if (!previewVisible.value) return;
  if (isTextInputLike(event.target)) return;

  // 只在预览弹窗打开时响应左右键
  if (event.key === "ArrowLeft") {
    event.preventDefault();
    goPrev();
    return;
  }

  if (event.key === "ArrowRight") {
    event.preventDefault();
    goNext();
    return;
  }
};

const handlePreviewMouseMove = (event: MouseEvent) => {
  const el = event.currentTarget as HTMLElement | null;
  if (!el) return;
  const rect = el.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const w = rect.width || 0;
  if (w <= 0) return;
  const edge = w * 0.2; // 1/5
  if (x <= edge) previewHoverSide.value = "left";
  else if (x >= w - edge) previewHoverSide.value = "right";
  else previewHoverSide.value = null;
};

const handlePreviewMouseLeave = () => {
  previewHoverSide.value = null;
};

const handlePreviewMouseMoveWithDrag = (event: MouseEvent) => {
  handlePreviewMouseMove(event);
  handlePreviewDragMove(event);
};

const handlePreviewMouseLeaveAll = () => {
  handlePreviewMouseLeave();
  // 注意：不在这里 stopPreviewDrag，否则鼠标离开容器时拖拽会中断
  // 拖拽结束由 window 级别的 mouseup 事件处理
};

// 处理预览对话框中的右键菜单
const handlePreviewDialogContextMenu = (event: MouseEvent) => {
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

const handlePreviewWheel = (event: WheelEvent) => {
  if (!previewVisible.value) return;
  event.preventDefault();
  const container = previewContainerRef.value;
  if (!container) return;
  const containerRect = container.getBoundingClientRect();
  // 更新容器尺寸，确保边界计算准确
  previewContainerSize.value = { width: containerRect.width, height: containerRect.height };
  previewAvailableSize.value = {
    width: containerRect.width,
    height: containerRect.height
  };

  const prevScale = previewScale.value;
  const factor = event.deltaY < 0 ? 1.1 : 0.9;
  const nextScale = clamp(prevScale * factor, 1, 10);
  if (nextScale === prevScale) return;

  const centerX = containerRect.left + containerRect.width / 2;
  const centerY = containerRect.top + containerRect.height / 2;
  const pointerX = event.clientX - centerX;
  const pointerY = event.clientY - centerY;
  const scaleRatio = nextScale / prevScale;

  const nextX = pointerX - scaleRatio * (pointerX - previewTranslateX.value);
  const nextY = pointerY - scaleRatio * (pointerY - previewTranslateY.value);
  setPreviewTransform(nextScale, nextX, nextY);
};

const startPreviewDrag = (event: MouseEvent) => {
  if (!previewVisible.value) return;
  if (previewScale.value <= 1) return;
  if (event.button !== 0 && event.button !== 1) return;
  // 拖拽开始时更新容器尺寸，确保边界计算准确
  measureContainerSize();
  previewDragging.value = true;
  previewDragStart.value = { x: event.clientX, y: event.clientY };
  previewDragStartTranslate.value = { x: previewTranslateX.value, y: previewTranslateY.value };
};

const handlePreviewDragMove = (event: MouseEvent) => {
  if (!previewDragging.value) return;
  const dx = event.clientX - previewDragStart.value.x;
  const dy = event.clientY - previewDragStart.value.y;
  setPreviewTransform(previewScale.value, previewDragStartTranslate.value.x + dx, previewDragStartTranslate.value.y + dy);
};

const stopPreviewDrag = () => {
  previewDragging.value = false;
};

const handlePreviewImageLoad = async () => {
  // 图片加载完成后，确保尺寸测量准确
  await measureSizesAfterRender();
  // 如果图片尺寸小于容器，确保居中显示（translate 应该为 0）
  if (previewBaseSize.value.width > 0 && previewBaseSize.value.height > 0) {
    const container = previewAvailableSize.value;
    const base = previewBaseSize.value;
    // 如果图片小于容器，确保居中（translate 为 0）
    if (base.width <= container.width && base.height <= container.height) {
      setPreviewTransform(1, 0, 0);
    }
  }
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

// 监听图片列表变化，检测当前预览图片是否被删除
watch(
  () => props.images,
  () => {
    if (!previewVisible.value || !previewImage.value) return;
    // 检查当前预览图片是否还在列表中
    const stillExists = props.images.some((img) => img.id === previewImage.value?.id);
    if (!stillExists) {
      // 当前预览图片已被删除，执行切换或关闭逻辑
      handlePreviewImageDeleted();
    }
  },
  { deep: false }
);

// 列表增长/加载完成时：尝试满足 pendingNext（用于"末尾自动加载更多后跳到下一张"）
// 同时处理当前预览图片被删除的情况
watch(
  () => props.images.length,
  (nextLen, prevLen) => {
    if (!previewVisible.value) return;
    // 如果父组件没有维护 loadingMore（始终为 false），这里用"长度增长"作为一次 loadMore 已完成的信号
    if (nextLen > prevLen) {
      loadMoreRequestedByPreview.value = false;
    }
    // 若当前预览图片被删除/不在列表中，尽量同步 index
    if (previewImage.value) {
      const idx = props.images.findIndex((i) => i.id === previewImage.value?.id);
      if (idx !== -1) {
        previewIndex.value = idx;
      } else {
        // 当前预览图片已被删除
        handlePreviewImageDeleted();
      }
    }
    tryFulfillPendingNext();
  }
);

// 处理当前预览图片被删除的情况
const handlePreviewImageDeleted = () => {
  if (!previewVisible.value) return;

  // 如果一张图片都没有了，直接关闭预览对话框
  if (props.images.length === 0) {
    closePreview();
    return;
  }

  // 如果还有图片，尝试切换到下一张
  // 删除后，后面的图片会前移，所以：
  // - 如果当前索引还在有效范围内，切换到该索引（后面的图片已前移）
  // - 如果当前索引超出范围，切换到最后一张
  if (previewIndex.value >= 0 && previewIndex.value < props.images.length) {
    // 当前索引仍然有效，切换到该索引（相当于原来的下一张）
    setPreviewByIndex(previewIndex.value);
  } else if (previewIndex.value >= props.images.length) {
    // 当前索引超出范围，切换到最后一张
    setPreviewByIndex(props.images.length - 1);
  } else {
    // 索引无效（-1），切换到第一张
    setPreviewByIndex(0);
  }
};

watch(
  () => loadingMore.value,
  (next) => {
    if (!previewVisible.value) return;
    if (next) return;
    // loadingMore 结束：允许下一次由预览触发的 loadMore，并再尝试推进
    loadMoreRequestedByPreview.value = false;
    tryFulfillPendingNext();
  }
);

watch(
  () => previewVisible.value,
  async (visible) => {
    if (visible) {
      // 对话框打开时，等待 DOM 更新后测量尺寸
      await nextTick();
      await measureSizesAfterRender();
    } else {
      stopPreviewDrag();
    }
  }
);

watch(
  () => previewImageUrl.value,
  async (url) => {
    if (url) {
      // 图片 URL 变化时，重置 transform 并等待图片加载
      setPreviewTransform(1, 0, 0);
      // 注意：实际的尺寸测量会在 handlePreviewImageLoad 中进行
    }
  }
);

let resizeObserver: ResizeObserver | null = null;

// 监听预览容器尺寸变化
const setupResizeObserver = () => {
  if (resizeObserver) {
    resizeObserver.disconnect();
  }

  const container = previewContainerRef.value;
  if (!container) return;

  resizeObserver = new ResizeObserver(() => {
    if (previewVisible.value && previewScale.value === 1) {
      // 只有在预览可见且未缩放时才重新测量
      measureContainerSize();
      measureBaseSize();
      // 如果图片小于容器，确保居中
      if (previewBaseSize.value.width > 0 && previewBaseSize.value.height > 0) {
        const containerSize = previewAvailableSize.value;
        const base = previewBaseSize.value;
        if (base.width <= containerSize.width && base.height <= containerSize.height) {
          setPreviewTransform(1, 0, 0);
        }
      }
    } else if (previewVisible.value) {
      // 如果正在缩放，只更新容器尺寸
      measureContainerSize();
    }
  });

  resizeObserver.observe(container);
};

onMounted(() => {
  window.addEventListener("mouseup", stopPreviewDrag);
  window.addEventListener("mousemove", handlePreviewDragMove);
});

onUnmounted(() => {
  window.removeEventListener("mouseup", stopPreviewDrag);
  window.removeEventListener("mousemove", handlePreviewDragMove);
  if (zoomAnimTimer) clearTimeout(zoomAnimTimer);
  if (reorderAnimTimer) clearTimeout(reorderAnimTimer);
  if (resizeObserver) {
    resizeObserver.disconnect();
    resizeObserver = null;
  }
});

// 当预览容器可用时设置 ResizeObserver
watch(
  () => previewContainerRef.value,
  (container) => {
    if (container) {
      setupResizeObserver();
    } else if (resizeObserver) {
      resizeObserver.disconnect();
      resizeObserver = null;
    }
  },
  { immediate: true }
);
</script>

<style scoped lang="scss">
.image-grid-root {
  width: 100%;
}

.image-grid {
  display: grid;
  gap: 16px;
  width: 100%;
  /* 为图片悬浮上移效果留出空间，避免被容器截断 */
  padding-top: 6px;
  padding-bottom: 6px;
  /* 为图片悬浮放大效果留出左右空间，避免在边缘时被裁剪 */
  padding-left: 8px;
  padding-right: 8px;
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

.image-grid-root.is-reordering :deep(.fade-in-list-move) {
  /* 交换图片时：允许元素平滑移动 */
  transition: transform 0.4s ease;
  will-change: transform;
}

/* 调整模式下的晃动动画 */
.image-grid.reorder-mode :deep(.image-item) {
  animation: shake 2s ease-in-out infinite;
  cursor: pointer;
}

@keyframes shake {

  0%,
  100% {
    transform: translateX(0) translateY(0) rotate(0deg);
  }

  10%,
  30%,
  50%,
  70%,
  90% {
    transform: translateX(-2px) translateY(-1px) rotate(-0.5deg);
  }

  20%,
  40%,
  60%,
  80% {
    transform: translateX(2px) translateY(1px) rotate(0.5deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .image-grid.reorder-mode :deep(.image-item) {
    animation: none;
  }
}
</style>

<style lang="scss">
.image-preview-dialog.el-dialog {
  width: 90vw !important;
  height: 90vh !important;
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
    overflow: hidden;
    box-sizing: border-box;
    position: relative;
  }

  .preview-image {
    max-width: 100% !important;
    max-height: 100% !important;
    width: auto;
    height: auto;
    object-fit: contain;
    display: block;
    cursor: pointer;
  }

  .preview-nav-zone {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 20%;
    display: flex;
    align-items: center;
    z-index: 2;
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.12s ease;

    &.visible {
      opacity: 1;
      pointer-events: auto;
    }

    &.left {
      left: 0;
      justify-content: flex-start;
      padding-left: 18px;
    }

    &.right {
      right: 0;
      justify-content: flex-end;
      padding-right: 18px;
    }
  }

  .preview-nav-btn {
    width: 44px;
    height: 44px;
    border-radius: 999px;
    border: none;
    background: #ff5fb8;
    /* 粉色圆形背景 */
    color: #ffffff;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    box-shadow: 0 10px 24px rgba(255, 95, 184, 0.28);
    transition: transform 0.12s ease, background-color 0.12s ease, box-shadow 0.12s ease;
    user-select: none;

    &:hover {
      transform: scale(1.04);
      box-shadow: 0 12px 28px rgba(255, 95, 184, 0.34);
    }

    &.disabled {
      background: #c9c9c9;
      /* 没有上一张/下一张：灰色，但仍可点 */
      box-shadow: 0 10px 24px rgba(0, 0, 0, 0.12);
    }

    .el-icon {
      font-size: 18px;
    }
  }
}

.preview-context-menu-wrapper {
  position: relative;
  z-index: 10000; // 确保高于对话框
}
</style>
