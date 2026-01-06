<template>
  <div ref="containerEl" class="image-grid-container" :class="{
    'hide-scrollbar': hideScrollbar,
  }">
    <slot name="before-grid" />

    <div class="image-grid-root"
      :class="{ 'is-zooming': isZoomingLayout, 'is-reordering': isReordering, 'is-deleting': isDeletingLayout }"
      @click="handleRootClick">
      <!-- 空状态显示 -->
      <EmptyState v-if="images.length === 0 && showEmptyState" />

      <template v-else>
        <div v-if="enableVirtualScroll" class="image-grid" :class="{ 'reorder-mode': isReorderMode }"
          :style="gridStyle">
          <ImageItem v-for="item in renderedItems" :key="item.image.id" :image="item.image"
            :image-url="getEffectiveImageUrl(item.image.id)"
            :image-click-action="settingsStore.values.imageClickAction || 'none'" :use-original="imageGridColumns <= 2"
            :window-aspect-ratio="effectiveAspectRatio" :selected="effectiveSelectedIds.has(item.image.id)"
            :grid-columns="imageGridColumns" :grid-index="item.index" :is-reorder-mode="isReorderMode"
            :reorder-selected="isReorderMode && reorderSourceIndex === item.index"
            @click="(e) => handleItemClick(item.image, item.index, e)"
            @dblclick="(e) => handleItemDblClick(item.image, item.index, e)"
            @contextmenu="(e) => handleItemContextMenu(item.image, item.index, e)"
            @long-press="() => handleLongPress(item.index)" @reorder-click="() => handleReorderClick(item.index)"
            @blob-url-invalid="handleBlobUrlInvalid" />
        </div>
        <transition-group v-else name="fade-in-list" tag="div" class="image-grid"
          :class="{ 'reorder-mode': isReorderMode }" :style="gridStyle">
          <ImageItem v-for="(image, index) in images" :key="image.id" :image="image"
            :image-url="getEffectiveImageUrl(image.id)"
            :image-click-action="settingsStore.values.imageClickAction || 'none'" :use-original="imageGridColumns <= 2"
            :window-aspect-ratio="effectiveAspectRatio" :selected="effectiveSelectedIds.has(image.id)"
            :grid-columns="imageGridColumns" :grid-index="index" :is-reorder-mode="isReorderMode"
            :reorder-selected="isReorderMode && reorderSourceIndex === index"
            @click="(e) => handleItemClick(image, index, e)" @dblclick="(e) => handleItemDblClick(image, index, e)"
            @contextmenu="(e) => handleItemContextMenu(image, index, e)" @long-press="() => handleLongPress(index)"
            @reorder-click="() => handleReorderClick(index)" @blob-url-invalid="handleBlobUrlInvalid" />
        </transition-group>
      </template>

      <!-- 右键菜单（下沉到 ImageGrid，可由父组件控制是否启用） -->
      <component :is="contextMenuComponent" v-if="enableContextMenu && contextMenuComponent"
        :visible="contextMenuVisible" :position="contextMenuPosition" :image="contextMenuImage"
        :selected-count="effectiveSelectedIds.size" :selected-image-ids="effectiveSelectedIds" @close="closeContextMenu"
        @command="handleContextMenuCommand" />

      <ImagePreviewDialog ref="previewRef" :images="images" :image-url-map="imageUrlMapForPreview"
        :context-menu-component="contextMenuComponent" @context-command="handlePreviewContextCommand" />

      <ImageDetailDialog v-model="showImageDetail" :image="detailImage" />

      <AddToAlbumDialog v-model="showAddToAlbumDialog" :image-ids="pendingAddToAlbumImageIds"
        @added="emit('addedToAlbum')" />
    </div>

    <!-- 容器尾部插槽：用于“加载更多”等，仅在需要的页面注入 -->
    <slot name="footer" />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch, type Component } from "vue";
import { storeToRefs } from "pinia";
import { invoke } from "@tauri-apps/api/core";
import ImageItem from "./ImageItem.vue";
import type { ImageInfo } from "@/stores/crawler";
import EmptyState from "@/components/common/EmptyState.vue";
import { useSettingsStore } from "@/stores/settings";
import { useUiStore } from "@/stores/ui";
import { useCrawlerStore } from "@/stores/crawler";
import { useAlbumStore } from "@/stores/albums";
import { useDebounceFn, useEventListener } from "@vueuse/core";
import { useDragScroll } from "@/composables/useDragScroll";
import ImagePreviewDialog from "@/components/common/ImagePreviewDialog.vue";
import ImageDetailDialog from "@/components/ImageDetailDialog.vue";
import AddToAlbumDialog from "@/components/AddToAlbumDialog.vue";

// 定义所有支持的 command 类型
export type ContextCommand =
  | "detail"
  | "favorite"
  | "copy"
  | "open"
  | "openFolder"
  | "wallpaper"
  | "exportToWE"
  | "addToAlbum"
  | "remove";

type MultiImagePayload = {
  /**
   * 选中集合（只读）：用于批量操作（remove/copy/wallpaper/export/addToAlbum...）
   * - 若为空或未提供，调用方可按单张处理（image.id）
   */
  selectedImageIds: ReadonlySet<string>;
};

type ImagePayload = {
  image: ImageInfo;
};

// 为每个 command 定义对应的 payload 类型（只包含必要字段）
type ContextCommandPayloadMap = {
  // 纯单张操作：不需要 selection
  open: ImagePayload;
  openFolder: ImagePayload;

  // 默认处理需要知道是否多选时：带 selection
  detail: ImagePayload;
  addToAlbum: ImagePayload & MultiImagePayload;

  // 业务层可能做批量：带 selection（即使目前只用单张，也给上层扩展空间）
  favorite: ImagePayload & MultiImagePayload;
  copy: ImagePayload & MultiImagePayload;
  wallpaper: ImagePayload & MultiImagePayload;
  exportToWE: ImagePayload & MultiImagePayload;
  remove: ImagePayload & MultiImagePayload;
};

// 泛型类型：根据 command 类型返回对应的 payload
export type ContextCommandPayload<T extends ContextCommand = ContextCommand> = {
  command: T;
} & ContextCommandPayloadMap[T];

interface Props {
  images: ImageInfo[];
  imageUrlMap: Record<string, { thumbnail?: string; original?: string }>;

  // 传入一个vue组件类
  contextMenuComponent?: Component;

  /**
   * context-command：由父组件处理；如果返回值 === command，则继续执行 ImageGrid 内置默认处理
   */
  onContextCommand?: (
    payload: ContextCommandPayload
  ) => ContextCommand | null | undefined | Promise<ContextCommand | null | undefined>;

  /**
   * 空状态显示
   */
  showEmptyState?: boolean; // 是否在 images 为空时显示空状态组件

  /**
   * 是否启用长按调整顺序功能
   */
  canReorder?: boolean; // 是否启用长按进入调整顺序模式

  /**
   * 容器行为（从 ImageContainer 合并而来）
   */
  enableCtrlWheelAdjustColumns?: boolean; // Ctrl+滚轮调整列数（通过 emit('adjust-columns') 通知父组件）
  enableCtrlKeyAdjustColumns?: boolean; // Ctrl + +/- 调整列数
  hideScrollbar?: boolean; // 隐藏滚动条（仍可滚动）
  scrollStableDelay?: number; // scrollStable 防抖时间
  enableScrollStableEmit?: boolean; // 是否发出 scrollStable

  /**
   * 是否启用虚拟滚动（仅渲染视口附近的行，减少节点数量）
   */
  enableVirtualScroll?: boolean;
  /**
   * 虚拟滚动额外预渲染的行数（上下各）
   */
  virtualOverscan?: number;
}

// 图片顺序调整状态
const isReorderMode = ref(false);
const reorderSourceIndex = ref<number>(-1); // 当前选中的图片索引（用于交换）

const props = defineProps<Props>();

// 从设置 store 读取 imageClickAction 并转换为 imageDoubleClickAction
const settingsStore = useSettingsStore();
const uiStore = useUiStore();
const crawlerStore = useCrawlerStore();
const albumStore = useAlbumStore();
const { FAVORITE_ALBUM_ID } = storeToRefs(albumStore);
const { imageGridColumns } = storeToRefs(uiStore);

// 窗口宽高比（在 ImageGrid 中初始化）
const windowAspectRatio = ref<number>(16 / 9); // 默认值

const previewRef = ref<InstanceType<typeof ImagePreviewDialog> | null>(null);

// 内置对话框状态（详情/加入画册）
const showImageDetail = ref(false);
const detailImage = ref<ImageInfo | null>(null);
const showAddToAlbumDialog = ref(false);
const pendingAddToAlbumImageIds = ref<string[]>([]);

// 更新窗口宽高比
const updateWindowAspectRatio = () => {
  windowAspectRatio.value = window.innerWidth / window.innerHeight;
};

// 使用窗口宽高比
const effectiveAspectRatio = computed(() => {
  return windowAspectRatio.value;
});

const emit = defineEmits<{
  "scroll-stable": [];
  // albumdetail 需要此事件
  addedToAlbum: [];
  reorder: [payload: { aId: string; aOrder: number; bId: string; bOrder: number }]; // 交换两张图片的 order
}>();

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

// 网格相关
const gridColumnsCount = computed(() => (imageGridColumns.value > 0 ? imageGridColumns.value : 1));
const gridGapPx = computed(() => Math.max(4, 16 - (gridColumnsCount.value - 1)));
const BASE_GRID_PADDING_Y = 6;
const BASE_GRID_PADDING_X = 8;

// 虚拟滚动测量
const measuredItemHeight = ref<number | null>(null);
const virtualStartRow = ref(0);
const virtualEndRow = ref(0);

const containerEl = ref<HTMLElement | null>(null);

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
  return Math.ceil(props.images.length / gridColumnsCount.value);
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
  const nextEnd = Math.max(
    nextStart,
    Math.min(totalRows.value - 1, endRow + overscan)
  );
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

let lastZoomAnim: Animation | null = null;
const prefersReducedMotion = () => {
  try {
    return window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false;
  } catch {
    return false;
  }
};

const pulseZoomAnimation = () => {
  if (prefersReducedMotion()) return;
  const container = containerEl.value;
  if (!container) return;
  const grid = container.querySelector<HTMLElement>(".image-grid");
  if (!grid || !(grid as any).animate) return;

  lastZoomAnim?.cancel?.();
  lastZoomAnim = grid.animate(
    [
      { transform: "scale(0.985)", opacity: 0.96 },
      { transform: "scale(1)", opacity: 1 },
    ],
    { duration: 160, easing: "cubic-bezier(0.2, 0, 0, 1)" }
  );
};

// 内置选择状态（仅在 allowSelect=true 且未传入 selectedImages 时启用）
const internalSelectedIds = ref<Set<string>>(new Set());
const lastSelectedIndex = ref<number>(-1);

const effectiveSelectedIds = computed<Set<string>>(() => internalSelectedIds.value);

// 对 imageUrlMap 的本地覆盖：用于处理 Blob URL 失效重建后的缓存
const localUrlOverrides = ref<Record<string, { thumbnail?: string; original?: string }>>({});
// 仅用于“ImageItem 本地重建出来的 blob url”：保存 Blob 引用，避免被 GC 后 URL 失效导致闪烁
const localBlobObjects = new Map<string, Blob>();
const getEffectiveImageUrl = (id: string) => {
  const base = props.imageUrlMap?.[id];
  const ov = localUrlOverrides.value?.[id];
  if (!ov) return base;
  // overrides 仅在 Blob URL 失效重建时出现，数量很少：只对这类 id 做浅合并
  return { ...(base || {}), ...(ov || {}) };
};

// 预览需要完整 map：避免每次都 O(N) 全量合并；仅在 overrides 变化时增量合并
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

// 右键菜单状态（仅在 enableContextMenu=true 时使用）
const contextMenuVisible = ref(false);
const contextMenuImage = ref<ImageInfo | null>(null);
const contextMenuPosition = ref({ x: 0, y: 0 });

// 缩放（列数变化）时启用 move 动画：平时仍保持 none，避免新增/加载更多导致的抖动
const isZoomingLayout = ref(false);
let zoomAnimTimer: ReturnType<typeof setTimeout> | null = null;

// 交换图片时启用 move 动画
const isReordering = ref(false);
let reorderAnimTimer: ReturnType<typeof setTimeout> | null = null;

// 删除图片时启用 move 动画（避免平时加载更多导致抖动）
const isDeletingLayout = ref(false);
let deletingAnimTimer: ReturnType<typeof setTimeout> | null = null;

const startDeleteMoveAnimation = (durationMs = 450) => {
  isDeletingLayout.value = true;
  if (deletingAnimTimer) clearTimeout(deletingAnimTimer);
  deletingAnimTimer = setTimeout(() => {
    isDeletingLayout.value = false;
    deletingAnimTimer = null;
  }, Math.max(0, durationMs));
};

const adjustColumnsInternal = (delta: number) => {
  uiStore.adjustImageGridColumn(delta);
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
    const id = props.images[i]?.id;
    if (id) next.add(id);
  }
  internalSelectedIds.value = next;
};

const isBlockingOverlayOpen = () => {
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

  // 内置选择逻辑
  if (!event) return;
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
  // 普通单击：
  // - 如果多选状态下点击已选中的图片，保持多选不变（避免双击时第一次点击破坏多选）
  // - 否则切换为单选
  if (internalSelectedIds.value.size > 1 && internalSelectedIds.value.has(image.id)) {
    return;
  }
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

  // 双击行为下沉：根据设置执行 open/preview
  const action = settingsStore.values.imageClickAction || "none";
  if (action === "preview") {
    previewRef.value?.open(index);
    return;
  }
  if (action === "open") {
    invoke("open_file_path", { filePath: image.localPath }).catch((err) => {
      console.error("打开文件失败:", err);
    });
  }
};

const syncSelectionForRightClick = (image: ImageInfo, index: number) => {
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

  if (isBlockingOverlayOpen()) return;

  openContextMenu(image, index, event);
};

const handleContextMenuCommand = (command: string) => {
  if (!contextMenuImage.value) return;

  const cmd = command as ContextCommand;
  const payload = buildContextPayload(cmd, contextMenuImage.value);
  closeContextMenu();
  void dispatchContextCommand(payload);
};

const buildContextPayload = (command: ContextCommand, image: ImageInfo): ContextCommandPayload => {
  const selected = new Set(effectiveSelectedIds.value);
  switch (command) {
    case "open":
    case "openFolder":
      return { command, image };
    default:
      return { command, image, selectedImageIds: selected } as ContextCommandPayload;
  }
};

const getSelectedIdsForCommand = (payload: { image: ImageInfo; selectedImageIds?: ReadonlySet<string> }) => {
  const ids = payload.selectedImageIds;
  return ids && ids.size > 0 ? ids : new Set([payload.image.id]);
};

const updateFavoriteInStores = (imageId: string, favorite: boolean) => {
  // 1) 更新 crawlerStore.images（画廊/分页数据的源之一）
  const idx = crawlerStore.images.findIndex((i) => i.id === imageId);
  if (idx !== -1) {
    crawlerStore.images = crawlerStore.images.map((img) =>
      img.id === imageId ? ({ ...img, favorite } as ImageInfo) : img
    );
  }

  // 2) 更新收藏画册缓存（若已加载），保证“收藏画册详情页”即时增删
  const favAlbumId = FAVORITE_ALBUM_ID.value;
  if (!favAlbumId) return;

  const currentCount = albumStore.albumCounts[favAlbumId] || 0;
  albumStore.albumCounts[favAlbumId] = Math.max(
    0,
    currentCount + (favorite ? 1 : -1)
  );

  const list = albumStore.albumImages[favAlbumId];
  if (Array.isArray(list)) {
    const pos = list.findIndex((i) => i.id === imageId);
    if (favorite) {
      if (pos === -1) {
        // 尽可能复用当前 props.images 中的对象，避免额外请求
        const src = props.images.find((i) => i.id === imageId);
        if (src) list.push({ ...src, favorite } as ImageInfo);
      } else {
        // 就地更新
        list[pos] = { ...list[pos], favorite } as ImageInfo;
      }
    } else {
      // 取消收藏：如果正在查看收藏画册，应从列表移除（而不是清缓存）
      if (pos !== -1) list.splice(pos, 1);
    }
  }
};

const setWallpaperForImages = async (imagesToProcess: ImageInfo[]) => {
  if (!imagesToProcess || imagesToProcess.length === 0) return;
  // 单选：直接设置壁纸
  if (imagesToProcess.length === 1) {
    await invoke("set_wallpaper_by_image_id", { imageId: imagesToProcess[0].id });
    return;
  }
  // 多选：创建“桌面画册x”，添加图片，开启轮播并切换到该画册
  await albumStore.loadAlbums();
  let albumName = "桌面画册1";
  let counter = 1;
  while (albumStore.albums.some((a) => a.name === albumName)) {
    counter++;
    albumName = `桌面画册${counter}`;
  }
  const createdAlbum = await albumStore.createAlbum(albumName);
  const imageIds = imagesToProcess.map((img) => img.id);
  await albumStore.addImagesToAlbum(createdAlbum.id, imageIds);

  const currentSettings = await invoke<{
    wallpaperRotationEnabled: boolean;
    wallpaperRotationAlbumId: string | null;
  }>("get_settings");
  if (!currentSettings.wallpaperRotationEnabled) {
    await invoke("set_wallpaper_rotation_enabled", { enabled: true });
  }
  await invoke("set_wallpaper_rotation_album_id", { albumId: createdAlbum.id });
};

const exportToWallpaperEngineProject = async (imagesToProcess: ImageInfo[]) => {
  if (!imagesToProcess || imagesToProcess.length === 0) return;
  const mp = await invoke<string | null>("get_wallpaper_engine_myprojects_dir");
  if (!mp) return;
  const title =
    imagesToProcess.length === 1
      ? `Kabegame_${imagesToProcess[0].id}`
      : `Kabegame_${imagesToProcess.length}_Images`;
  const imagePaths = imagesToProcess.map((i) => i.localPath);
  const res = await invoke<{ projectDir: string; imageCount: number }>(
    "export_images_to_we_project",
    { imagePaths, title, outputParentDir: mp, options: null }
  );
  // 导出完成后打开目录（失败忽略）
  if (res?.projectDir) {
    invoke("open_file_path", { filePath: res.projectDir }).catch(() => void 0);
  }
};

const applyDefaultContextCommand = (payload: ContextCommandPayload) => {
  // 内置处理：尽量覆盖“通用能力”（不依赖各页面业务）
  switch (payload.command) {
    case "detail": {
      const ids = getSelectedIdsForCommand(payload);
      if (ids.size <= 1) {
        detailImage.value = payload.image;
        showImageDetail.value = true;
      }
      return;
    }
    case "favorite": {
      // 只对当前 image 做切换（多选下的批量收藏由页面业务决定）
      const newFavorite = !(payload.image.favorite ?? false);
      invoke("toggle_image_favorite", { imageId: payload.image.id, favorite: newFavorite })
        .then(() => {
          // 让当前列表立刻响应（就地更新）
          payload.image.favorite = newFavorite;
          updateFavoriteInStores(payload.image.id, newFavorite);
        })
        .catch((err) => console.error("切换收藏失败:", err));
      return;
    }
    case "addToAlbum": {
      const ids = Array.from(getSelectedIdsForCommand(payload));
      pendingAddToAlbumImageIds.value = ids;
      showAddToAlbumDialog.value = true;
      return;
    }
    case "open": {
      invoke("open_file_path", { filePath: payload.image.localPath }).catch((err) => {
        console.error("打开文件失败:", err);
      });
      return;
    }
    case "openFolder": {
      invoke("open_file_folder", { filePath: payload.image.localPath }).catch((err) => {
        console.error("打开文件夹失败:", err);
      });
      return;
    }
    case "wallpaper": {
      const ids = getSelectedIdsForCommand(payload);
      const imagesToProcess =
        ids.size > 0
          ? props.images.filter((i) => ids.has(i.id))
          : [payload.image];
      setWallpaperForImages(imagesToProcess).catch((err) =>
        console.error("设置壁纸失败:", err)
      );
      return;
    }
    case "copy": {
      // 走 Tauri 接口（Windows 原生剪贴板文件拷贝）
      const ids = getSelectedIdsForCommand(payload);
      const imagesToCopy =
        ids.size > 0
          ? props.images.filter((i) => ids.has(i.id))
          : [payload.image];
      const paths = imagesToCopy.map((i) => i.localPath).filter(Boolean);
      if (paths.length === 0) return;
      invoke("copy_files_to_clipboard", { paths }).catch((err) =>
        console.error("复制到剪贴板失败:", err)
      );
      return;
    }
    case "exportToWE": {
      const ids = getSelectedIdsForCommand(payload);
      const imagesToProcess =
        ids.size > 0
          ? props.images.filter((i) => ids.has(i.id))
          : [payload.image];
      exportToWallpaperEngineProject(imagesToProcess).catch((err) =>
        console.error("导出 WE 工程失败:", err)
      );
      return;
    }
    default:
      return;
  }
};

const dispatchContextCommand = async (payload: ContextCommandPayload) => {
  const result = await props.onContextCommand?.(payload);
  const shouldDefault = !props.onContextCommand || result === payload.command;
  if (shouldDefault) {
    applyDefaultContextCommand(payload);
  }
};

const handlePreviewContextCommand = (payload: { command: string; image: ImageInfo }) => {
  const cmd = payload.command as ContextCommand;
  void dispatchContextCommand(buildContextPayload(cmd, payload.image));
};

// 处理 Blob URL 无效事件（ImageItem 已在本地重建 newUrl，这里只做缓存同步）
const handleBlobUrlInvalid = (payload: {
  oldUrl: string;
  newUrl: string;
  newBlob?: Blob;
  imageId: string;
  localPath: string;
}) => {
  if (!payload?.newUrl) return;
  const img = props.images.find((i) => i.id === payload.imageId);
  if (!img) return;

  // 保存新建 Blob 引用，避免 URL 后续失效（仅对本地重建的 URL 生效）
  if (payload.newUrl.startsWith("blob:") && payload.newBlob) {
    localBlobObjects.set(payload.newUrl, payload.newBlob);
  }

  // 旧 URL 的释放不能太早（否则可能在 <img> 还未切换完成时出现破裂图/闪烁）
  // 这里仅释放“我们自己持有 Blob 引用”的旧 URL；其余 URL（例如由 useGalleryImages 管理）不在这里动。
  const old = payload.oldUrl;
  if (old && old.startsWith("blob:") && localBlobObjects.has(old)) {
    setTimeout(() => {
      // 再次确认仍然是我们持有的，避免误删
      if (!localBlobObjects.has(old)) return;
      try {
        URL.revokeObjectURL(old);
      } catch {
        // ignore
      } finally {
        localBlobObjects.delete(old);
      }
    }, 5000);
  }

  const isThumbnail =
    !!img.thumbnailPath && payload.localPath === (img.thumbnailPath || img.localPath);
  const current = localUrlOverrides.value[payload.imageId] || {};
  localUrlOverrides.value = {
    ...localUrlOverrides.value,
    [payload.imageId]: {
      ...current,
      ...(isThumbnail ? { thumbnail: payload.newUrl } : { original: payload.newUrl }),
    },
  };
};

// 处理长按进入调整模式
const handleLongPress = (index: number) => {
  if (!canReorder.value) return; // 如果禁用 reorder，直接返回
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

  const source = props.images[sourceIndex];
  const target = props.images[targetIndex];
  if (!source || !target) return;

  const sourceOrder = (source.order ?? source.crawledAt) as number;
  const targetOrder = (target.order ?? target.crawledAt) as number;

  // 启用交换动画
  isReordering.value = true;
  if (reorderAnimTimer) clearTimeout(reorderAnimTimer);
  // 给 transition-group 的 move 过渡留出足够时间
  reorderAnimTimer = setTimeout(() => {
    isReordering.value = false;
    reorderAnimTimer = null;
  }, 450);

  // 通知父组件：只交换两张图片的 order（父组件负责更新列表与落库）
  emit("reorder", {
    aId: source.id,
    aOrder: targetOrder,
    bId: target.id,
    bOrder: sourceOrder,
  });

  // 退出调整模式
  exitReorderMode();
};

// 对外暴露：让父组件在执行批量命令后清空选择（选择逻辑仍在 grid 内）
const clearSelection = () => {
  internalSelectedIds.value = new Set();
  lastSelectedIndex.value = -1;
};

// 退出调整模式
const exitReorderMode = () => {
  isReorderMode.value = false;
  reorderSourceIndex.value = -1;
};

// 向父组件暴露方法（保持原有 ref API）
defineExpose({
  getContainerEl: () => containerEl.value,
  getSelectedIds: () => new Set(internalSelectedIds.value),
  clearSelection,
  exitReorderMode,
  startDeleteMoveAnimation,
});

const shouldIgnoreKeyTarget = (event: KeyboardEvent) => {
  const target = event.target as HTMLElement | null;
  const tag = target?.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    target?.isContentEditable
  );
};

// 计算网格列样式
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

  if (isBlockingOverlayOpen()) return;

  if (!clickedOutside) return;

  if (contextMenuVisible.value) {
    closeContextMenu();
    return;
  }

  if (internalSelectedIds.value.size === 1) {
    internalSelectedIds.value = new Set();
    lastSelectedIndex.value = -1;
  }
};

// 键盘快捷键（仅内部选择模式）
const handleKeyDown = (event: KeyboardEvent) => {
  if (isBlockingOverlayOpen()) return;

  if (shouldIgnoreKeyTarget(event)) return;

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
    return;
  }

  // Ctrl/Cmd + A：全选
  if ((event.ctrlKey || event.metaKey) && (event.key === "a" || event.key === "A")) {
    event.preventDefault();
    internalSelectedIds.value = new Set(props.images.map((img) => img.id));
    lastSelectedIndex.value = props.images.length > 0 ? props.images.length - 1 : -1;
    return;
  }

  // Backspace / Delete：交给父组件执行删除逻辑（grid 只负责发出意图）
  if (event.key === "Backspace" && internalSelectedIds.value.size > 0) {
    event.preventDefault();
    const first =
      props.images.find((img) => internalSelectedIds.value.has(img.id)) || props.images[0];
    if (first) {
      void dispatchContextCommand(buildContextPayload("remove", first));
    }
    return;
  }
  if (event.key === "Delete" && internalSelectedIds.value.size > 0) {
    event.preventDefault();
    const first =
      props.images.find((img) => internalSelectedIds.value.has(img.id)) || props.images[0];
    if (first) {
      void dispatchContextCommand(buildContextPayload("remove", first));
    }
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

onMounted(async () => {
  // 初始化时加载设置（如果尚未加载）
  if (settingsStore.values.imageClickAction === undefined) {
    await settingsStore.load("imageClickAction");
  }

  // 初始化窗口宽高比
  updateWindowAspectRatio();
  window.addEventListener("resize", updateWindowAspectRatio);

  window.addEventListener("keydown", handleKeyDown);

  // 监听页面刷新/离开
  window.addEventListener("beforeunload", handleBeforeUnload);

  // 监听 tab 可见性变化
  document.addEventListener("visibilitychange", handleVisibilityChange);

  scheduleVirtualUpdate();
});

onUnmounted(() => {
  window.removeEventListener("resize", updateWindowAspectRatio);
  window.removeEventListener("keydown", handleKeyDown);
  window.removeEventListener("beforeunload", handleBeforeUnload);
  document.removeEventListener("visibilitychange", handleVisibilityChange);

  // 清理 ImageItem 本地重建的 blob urls
  for (const url of localBlobObjects.keys()) {
    try {
      URL.revokeObjectURL(url);
    } catch {
      // ignore
    }
  }
  localBlobObjects.clear();
});

watch(
  () => imageGridColumns.value,
  (next, prev) => {
    if (next === prev) return;

    // 轻微缩放提示（容器级动效）
    pulseZoomAnimation();

    // transition-group move：仅在“列数变化”时允许移动过渡，避免加载更多导致抖动
    if (prefersReducedMotion()) return;
    isZoomingLayout.value = true;
    if (zoomAnimTimer) clearTimeout(zoomAnimTimer);
    zoomAnimTimer = setTimeout(() => {
      isZoomingLayout.value = false;
      zoomAnimTimer = null;
    }, 450);
  },
  { flush: "pre" }
);

watch(
  () => props.images,
  (nextImages, prevImages) => {
    // 列表变化时：内部选择集清理掉已不存在的 id
    // 性能关键：十万级列表下，任何“每次变更都 props.images.map(...)”都会让滚动/窗口拖动明显卡顿。
    if (internalSelectedIds.value.size === 0) return;

    // “加载更多/加载全部”通常是纯追加：旧项不会消失，此时无需做 O(N) 扫描。
    if (prevImages && prevImages.length > 0 && nextImages.length >= prevImages.length) {
      const prevFirst = prevImages[0]?.id;
      const prevLast = prevImages[prevImages.length - 1]?.id;
      const nextFirst = nextImages[0]?.id;
      const nextLastAtPrev = nextImages[prevImages.length - 1]?.id;
      if (
        prevFirst &&
        prevLast &&
        prevFirst === nextFirst &&
        prevLast === nextLastAtPrev
      ) {
        return;
      }
    }

    // 只有在“刷新/重排/删除”等可能导致旧项消失时，才做一次全量集合构建。
    const ids = new Set(nextImages.map((i) => i.id));
    const next = new Set<string>();
    internalSelectedIds.value.forEach((id) => {
      if (ids.has(id)) next.add(id);
    });
    if (next.size !== internalSelectedIds.value.size) {
      internalSelectedIds.value = next;
    }
  },
  { deep: false }
);

const renderedItems = computed(() => {
  if (!enableVirtualScroll.value) {
    return props.images.map((image, index) => ({ image, index }));
  }
  const columns = gridColumnsCount.value;
  if (columns <= 0 || props.images.length === 0) return [];
  const clampedStart = Math.min(virtualStartRow.value, Math.max(0, totalRows.value - 1));
  const clampedEnd = Math.min(
    Math.max(clampedStart, virtualEndRow.value),
    Math.max(0, totalRows.value - 1)
  );
  const startIndex = clampedStart * columns;
  const endIndex = Math.min(props.images.length, (clampedEnd + 1) * columns);
  const slice = props.images.slice(startIndex, endIndex);
  return slice.map((image, offset) => ({ image, index: startIndex + offset }));
});

watch(
  () => [props.images.length, gridColumnsCount.value, windowAspectRatio.value, enableVirtualScroll.value],
  () => {
    scheduleVirtualUpdate();
  }
);

watch(
  () => gridGapPx.value,
  () => {
    scheduleVirtualUpdate();
  }
);

// 防抖滚动触发 scroll-stable（用于懒加载 blob url 等）
useEventListener(
  containerEl,
  "scroll",
  useDebounceFn(
    () => {
      if (!enableScrollStableEmit.value) return;
      emit("scroll-stable");
    },
    () => scrollStableDelay.value
  ),
  { passive: true }
);

// 虚拟滚动：实时更新可视行
let virtualScrollRaf: number | null = null;
const scheduleVirtualRangeUpdate = () => {
  if (!enableVirtualScroll.value) return;
  if (virtualScrollRaf != null) return;
  virtualScrollRaf = requestAnimationFrame(() => {
    virtualScrollRaf = null;
    updateVirtualRange();
  });
};
useEventListener(containerEl, "scroll", scheduleVirtualRangeUpdate, { passive: true });

onUnmounted(() => {
  if (virtualScrollRaf != null) {
    cancelAnimationFrame(virtualScrollRaf);
    virtualScrollRaf = null;
  }
});

// Ctrl+滚轮调整列数（阻止浏览器缩放）
useEventListener(
  containerEl,
  "wheel",
  (event: WheelEvent) => {
    if (!enableCtrlWheelAdjustColumns.value) return;
    if (!event.ctrlKey) return;
    event.preventDefault();
    const delta = event.deltaY > 0 ? 1 : -1;
    adjustColumnsInternal(delta);
  },
  { passive: false }
);

// Ctrl + +/- 调整列数
useEventListener(window, "keydown", (event: KeyboardEvent) => {
  if (!enableCtrlKeyAdjustColumns.value) return;
  if (!event.ctrlKey && !event.metaKey) return;
  if (shouldIgnoreKeyTarget(event)) return;
  const key = event.key;
  if (key !== "+" && key !== "=" && key !== "-" && key !== "_") return;
  event.preventDefault();
  const delta = key === "+" || key === "=" ? 1 : -1;
  adjustColumnsInternal(delta);
});
useDragScroll(containerEl);

</script>

<style scoped lang="scss">
.image-grid-container {
  width: 100%;
  height: 100%;
  overflow-y: auto;
  overflow-x: hidden;
  /* 为图片悬浮上移效果留出空间，避免被容器截断 */
  padding-top: 6px;
  padding-bottom: 6px;
}

.image-grid-container.hide-scrollbar {
  scrollbar-width: none;
  /* Firefox */
  -ms-overflow-style: none;
  /* IE/旧 Edge */
}

.image-grid-container.hide-scrollbar::-webkit-scrollbar {
  display: none;
  width: 0;
  height: 0;
}

/* 拖拽滚动：cursor 提示下沉到真实滚动容器（ImageGrid 内部） */
.image-grid-container.drag-scroll-enabled {
  cursor: grab;
}

.image-grid-container.drag-scroll-active {
  cursor: grabbing;
  user-select: none;
}

/* 拖拽滚动时：禁用图片项交互与 hover（避免指针扫过 5000 个卡片导致大量 hover/重绘） */
.image-grid-container.drag-scroll-active :deep(.image-item) {
  pointer-events: none;
  transition: none !important;
}

.image-grid-container.drag-scroll-active :deep(.image-item:hover) {
  transform: none !important;
  outline: none !important;
}

.image-grid-container :deep(.image-grid-root) {
  overflow: visible;
}

.image-grid-root {
  will-change: scroll-position; // 优化滚动性能
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
  will-change: transform; // 优化列表元素移动性能
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

.image-grid-root.is-deleting :deep(.fade-in-list-move) {
  /* 删除图片时：允许元素平滑移动，使后续图片“顶上来” */
  transition: transform 0.35s ease;
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

<style lang="scss"></style>
