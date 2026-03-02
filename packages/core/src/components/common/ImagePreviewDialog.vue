<template>
  <!-- Android 全屏预览：使用 photoswipe-vue 组件，关闭按钮用组件自带的 -->
  <PhotoSwipe
    v-if="IS_ANDROID"
    ref="pswpRef"
    v-model:open="previewVisible"
    v-model:index="previewIndex"
    :data-source="pswpDataSource"
    :loop="true"
    :zIndex="2000"
    :close-on-vertical-drag="true"
    close-on-back
    :on-vertical-drag="handlePswpVerticalDrag"
    :on-before-close="handlePswpBeforeClose"
    @change="handlePswpChange"
    @close="handlePswpClose"
    @ui-visible-change="handlePswpUiVisibleChange"
  >
    <!-- ActionSheet 通过 default slot 放入 PswpUI 的 .pswp__hide-on-close 中 -->
    <ActionRenderer
      v-if="actions.length > 0"
      visible
      :position="previewContextMenuPosition"
      :actions="actions"
      :context="previewActionContext"
      mode="actionsheet"
      :teleport="false"
      :no-transition="true"
      @close="handlePswpActionClose"
      @command="handlePreviewActionCommand"
    />
    <!-- 上划删除区域通过 overlay slot 放入 .pswp 根级 -->
    <template #overlay>
      <Transition name="swipe-delete-zone">
        <div v-show="swipeDeleteActive" class="swipe-delete-zone" :class="{ ready: swipeDeleteReady }">
          <div class="swipe-delete-zone-content">
            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M3 6h18M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
              <line x1="10" y1="11" x2="10" y2="17" />
              <line x1="14" y1="11" x2="14" y2="17" />
            </svg>
            <span>{{ swipeDeleteReady ? '释放删除' : '上划删除' }}</span>
          </div>
        </div>
      </Transition>
    </template>
  </PhotoSwipe>

  <!-- 桌面端 Dialog 预览 -->
  <el-dialog v-else v-model="previewVisible" :title="previewDialogTitle" width="90%" :close-on-click-modal="true"
    class="image-preview-dialog" :show-close="true" :lock-scroll="true" @close="closePreview">
    <div v-if="previewVisible" ref="previewContainerRef" class="preview-container"
      @contextmenu.prevent.stop="handlePreviewDialogContextMenu" @mousemove="handlePreviewMouseMove"
      @mouseleave="handlePreviewMouseLeave" @wheel.prevent="handlePanzoomWheel">
      <div v-if="props.images.length > 1" class="preview-nav-zone left"
        :class="{ visible: previewHoverSide === 'left' }" @click.stop="goPrev">
        <button class="preview-nav-btn" type="button" :class="{ disabled: isAtFirst }" aria-label="上一张">
          <el-icon>
            <ArrowLeftBold />
          </el-icon>
        </button>
      </div>
      <div v-if="props.images.length > 1" class="preview-nav-zone right"
        :class="{ visible: previewHoverSide === 'right' }" @click.stop="goNext">
        <button class="preview-nav-btn" type="button" :class="{ disabled: isAtLast }" aria-label="下一张">
          <el-icon>
            <ArrowRightBold />
          </el-icon>
        </button>
      </div>
      <div v-if="previewImageUrl" ref="panzoomWrapperRef" class="panzoom-wrapper">
        <img ref="previewImageRef" :src="previewImageUrl" class="preview-image" alt="预览图片"
          @load="handlePreviewImageLoad" @error="handlePreviewImageError" @dragstart.prevent />
      </div>
      <div v-else-if="previewNotFound && !previewImageLoading" class="preview-not-found">
        <ImageNotFound />
      </div>
      <div v-if="previewImageLoading" class="preview-loading">
        <div class="preview-loading-inner">正在加载原图…</div>
      </div>
    </div>
  </el-dialog>

</template>

<script setup lang="ts">
import type { Ref } from "vue";
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { ElMessage } from "element-plus";
import { ArrowLeftBold, ArrowRightBold } from "@element-plus/icons-vue";
import type { ImageInfo, ImageUrlMap } from "../../types/image";
import ImageNotFound from "./ImageNotFound.vue";
import { useImageUrlMapCache } from "../../composables/useImageUrlMapCache";
import { IS_ANDROID } from "../../env";
import ActionRenderer from "../ActionRenderer.vue";
import type { ActionItem, ActionContext } from "../../actions/types";
// @ts-expect-error - Vue SFC component import, types resolved via package.json exports
import PhotoSwipe from "photoswipe-vue/vue";
import "photoswipe-vue/photoswipe.css";
import { usePanzoomPreview } from "../../composables/usePanzoomPreview";

const props = withDefaults(defineProps<{
  images: ImageInfo[];
  imageUrlMap: ImageUrlMap;
  /** Actions for context menu / action sheet. */
  actions?: ActionItem<ImageInfo>[];
}>(), {
  actions: () => [],
});

watch(() => props.images.length, () => {
  console.log(props.images);
});

const emit = defineEmits<{
  (e: "contextCommand", payload: { command: string; image: ImageInfo }): void;
}>();

const previewVisible = ref(false);
const previewImageUrl = ref("");
const previewImagePath = ref("");
const previewImage = ref<ImageInfo | null>(null);
const previewIndex = ref<number>(-1);
const previewHoverSide = ref<"left" | "right" | null>(null);
const previewNotFound = ref(false);

const previewContainerRef = ref<HTMLElement | null>(null);
const previewImageRef = ref<HTMLImageElement | null>(null);
const pswpRef = ref<InstanceType<typeof PhotoSwipe> | null>(null);
// Panzoom 由 usePanzoomPreview 提供，在 notifyPreviewInteracting / markPreviewInteracting 定义后初始化
let panzoomWrapperRef!: Ref<HTMLElement | null>;
let handlePanzoomWheel!: (event: WheelEvent) => void;
let panzoomReset!: () => void;
let panzoomDestroy!: () => void;
// Android 上划删除相关状态
const swipeDeleteActive = ref(false);
const swipeDeleteReady = ref(false);
let isFromVerticalDrag = false;
let verticalDragResetTimer: ReturnType<typeof setTimeout> | null = null;
const previewScale = ref(1);
const previewTranslateX = ref(0);
const previewTranslateY = ref(0);
const previewBaseSize = ref({ width: 0, height: 0 });
const previewContainerSize = ref({ width: 0, height: 0 });
const previewAvailableSize = ref({ width: 0, height: 0 });
// 缓存 container 的 rect，避免 mousemove/wheel 高频触发时反复 getBoundingClientRect() 导致强制布局与掉帧
const previewContainerRect = ref({ left: 0, top: 0, width: 0, height: 0 });
// previewDragging、previewDragStart、previewDragStartTranslate 已删除，由 Panzoom 替代（仅桌面端）
const previewImageLoading = ref(false);
// 导航请求序号：用于“阻止切换直到 original ready”时的竞态保护

const previewContextMenuVisible = ref(false);
const previewContextMenuPosition = ref({ x: 0, y: 0 });

// Android 触摸手势状态

// Android PSWP UI 可见性（ActionSheet 随 PSWP UI 自动显隐，无需手动控制）
const pswpUiVisible = ref(false);
let longPressTimer: ReturnType<typeof setTimeout> | null = null;

// 全局 cache（用于同步生成 original asset URL）
const urlCache = useImageUrlMapCache();

const clamp = (val: number, min: number, max: number) => Math.min(max, Math.max(min, val));

// 计算 cover scale（填满屏幕的缩放比例）

// previewWheelZooming、wheelZoomTimer、wheelRaf、wheelSteps、wheelLastClientX/Y 已删除，由 Panzoom 替代（仅桌面端）

// 预览交互标记：用于通知上层暂停后台加载，优先保证预览拖拽/缩放丝滑
const previewInteracting = ref(false);
let previewInteractTimer: ReturnType<typeof setTimeout> | null = null;
const notifyPreviewInteracting = (active: boolean) => {
  if (previewInteracting.value === active) return;
  previewInteracting.value = active;
  try {
    window.dispatchEvent(
      new CustomEvent("preview-interacting-change", { detail: { active } })
    );
  } catch {
    // ignore
  }
};
const markPreviewInteracting = () => {
  notifyPreviewInteracting(true);
  if (previewInteractTimer) clearTimeout(previewInteractTimer);
  previewInteractTimer = setTimeout(() => {
    previewInteractTimer = null;
    notifyPreviewInteracting(false);
  }, 260);
};

// 初始化 Panzoom（需在 markPreviewInteracting 之后，以便传入回调）
({
  wrapperRef: panzoomWrapperRef,
  handleWheel: handlePanzoomWheel,
  reset: panzoomReset,
  destroy: panzoomDestroy,
} = usePanzoomPreview(
  previewVisible,
  computed(() => !IS_ANDROID),
  {
    onPanzoomStart: () => notifyPreviewInteracting(true),
    onPanzoomEnd: markPreviewInteracting,
  }
));

const clampTranslate = (nextScale: number, nextX: number, nextY: number) => {
  const available = previewAvailableSize.value;
  const base = previewBaseSize.value;
  if (available.width > 0 && available.height > 0 && base.width > 0 && base.height > 0) {
    const scaledWidth = base.width * nextScale;
    const scaledHeight = base.height * nextScale;
    if (scaledWidth <= available.width && scaledHeight <= available.height) {
      return { x: 0, y: 0 };
    }
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
    previewContainerRect.value = {
      left: containerRect.left,
      top: containerRect.top,
      width: containerRect.width,
      height: containerRect.height,
    };
    previewContainerSize.value = { width: containerRect.width, height: containerRect.height };
    previewAvailableSize.value = {
      width: containerRect.width,
      height: containerRect.height,
    };
  }
};

const measureBaseSize = () => {
  const imageRect = previewImageRef.value?.getBoundingClientRect();
  if (imageRect && previewScale.value === 1) {
    previewBaseSize.value = { width: imageRect.width, height: imageRect.height };
  }
};

const measureSizesAfterRender = async () => {
  await nextTick();
  await new Promise((resolve) => requestAnimationFrame(resolve));
  measureContainerSize();
  measureBaseSize();
};

// resetPreviewTransform 已删除，由 panzoomReset()（usePanzoomPreview）替代（仅桌面端）

// previewImageStyle 已删除，由 Panzoom 自动管理 transform（仅桌面端）

const previewDialogTitle = computed(() => {
  if (!previewImage.value?.localPath) {
    return "图片预览";
  }
  // 从路径中提取文件名（支持 Windows 和 Unix 路径分隔符）
  const path = previewImage.value.localPath;
  const fileName = path.split(/[/\\]/).pop() || path;
  return fileName || "图片预览";
});

const isTextInputLike = (target: EventTarget | null) => {
  const el = target as HTMLElement | null;
  const tag = el?.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || !!el?.isContentEditable;
};

/** 只读：从全局 cache 或 props 取原图 URL（不主动创建） */
const getOriginalUrlFor = (imageId: string) => {
  return (
    urlCache.imageUrlMap.value[imageId]?.original ||
    props.imageUrlMap?.[imageId]?.original ||
    ""
  );
};

/** Android PhotoSwipe：根据当前 images 构建 dataSource 数组（只读 URL） */
const pswpDataSource = computed(() => {
  const fallbackW = 1920;
  const fallbackH = 1080;
  return props.images.map((img) => {
    const url = getOriginalUrlFor(img.id) || props.imageUrlMap?.[img.id]?.thumbnail || "";
    return {
      src: url,
      width: img.width || fallbackW,
      height: img.height || fallbackH,
    };
  });
});

const setPreviewByIndex = (index: number) => {
  const img = props.images[index];
  if (!img) return;

  previewIndex.value = index;
  previewImagePath.value = img.localPath;
  previewImage.value = img;
  previewNotFound.value = false;

  // 只读：从 cache 或 props 获取 URL，不主动创建
  const data = props.imageUrlMap?.[img.id];
  const thumb = data?.thumbnail || "";
  const originalUrl = getOriginalUrlFor(img.id);

  previewNotFound.value = false;
  previewImageLoading.value = false;
  previewImageUrl.value = (originalUrl || thumb || "").trim();

  // 尺寸/缩放状态重置：立即触发一次（仅桌面端）
  panzoomReset();
};

// 仅用于 UI：首尾循环时，位于边界的方向箭头置灰（但仍可点击触发循环）
const isAtFirst = computed(() => {
  if (props.images.length <= 1) return false;
  if (!previewVisible.value) return false;
  const idx = previewIndex.value >= 0 ? previewIndex.value : 0;
  return idx === 0;
});

const isAtLast = computed(() => {
  if (props.images.length <= 1) return false;
  if (!previewVisible.value) return false;
  const idx = previewIndex.value >= 0 ? previewIndex.value : 0;
  return idx === props.images.length - 1;
});

// 获取相邻图片的 URL（用于 pager）
const getAdjacentImageUrl = (offset: number): string => {
  const idx = previewIndex.value;
  if (idx < 0) return "";
  const targetIdx = idx + offset;
  if (targetIdx < 0 || targetIdx >= props.images.length) return "";
  const img = props.images[targetIdx];
  if (!img) return "";
  
  // 优先使用 original，否则使用 thumbnail
  const originalUrl = getOriginalUrlFor(img.id);
  if (originalUrl) return originalUrl;
  
  const data = props.imageUrlMap?.[img.id];
  return data?.thumbnail || "";
};


// Pager offset（用于滑动切换动画）
const pagerOffset = ref(0);
const pagerSettling = ref(false);

// 切换节流：100ms 内最多只执行一次切换，避免快速连击导致状态混乱
let navThrottleTimer: ReturnType<typeof setTimeout> | null = null;
let isNavThrottled = false;
const NAV_THROTTLE_MS = 100;

const navigateWithPreloadGate = (targetIndex: number) => {
  if (!previewVisible.value) return;
  setPreviewByIndex(targetIndex);
};

const goPrev = () => {
  if (!previewVisible.value) return;
  if (isNavThrottled) return;
  const idx = previewIndex.value >= 0 ? previewIndex.value : 0;
  const targetIndex = idx > 0 ? idx - 1 : props.images.length - 1;
  const didWrap = idx === 0;
  if (didWrap) {
    ElMessage.info("一下子跳到最后一张啦");
  }

  // 开启节流
  isNavThrottled = true;
  if (navThrottleTimer) clearTimeout(navThrottleTimer);
  navThrottleTimer = setTimeout(() => {
    navThrottleTimer = null;
    isNavThrottled = false;
  }, NAV_THROTTLE_MS);

  navigateWithPreloadGate(targetIndex);
};

const goNext = () => {
  if (!previewVisible.value) return;
  if (isNavThrottled) return;
  const lastIndex = props.images.length - 1;
  const idx = previewIndex.value >= 0 ? previewIndex.value : 0;
  const targetIndex = idx < lastIndex ? idx + 1 : 0;
  const didWrap = idx === lastIndex;
  if (didWrap) {
    ElMessage.info("回到第一张啦");
  }

  // 开启节流
  isNavThrottled = true;
  if (navThrottleTimer) clearTimeout(navThrottleTimer);
  navThrottleTimer = setTimeout(() => {
    navThrottleTimer = null;
    isNavThrottled = false;
  }, NAV_THROTTLE_MS);

  navigateWithPreloadGate(targetIndex);
};

const handlePreviewDialogContextMenu = (event: MouseEvent) => {
  if (!previewImage.value) return;
  if (!props.actions?.length) return;
  previewContextMenuPosition.value = { x: event.clientX, y: event.clientY };
  previewContextMenuVisible.value = true;
};

const closePreviewContextMenu = () => {
  previewContextMenuVisible.value = false;
};

const previewActionContext = computed<ActionContext<ImageInfo>>(() => ({
  target: previewImage.value,
  selectedIds: previewImage.value ? new Set([previewImage.value.id]) : new Set<string>(),
  selectedCount: previewImage.value ? 1 : 0,
}));

const handlePswpActionClose = () => {
  if (IS_ANDROID) {
    // 关闭 ActionSheet 时隐藏 PSWP UI
    pswpRef.value?.toggleUI();
  } else {
    closePreviewContextMenu();
  }
};

const handlePreviewActionClose = () => {
  if (IS_ANDROID) {
    // 已由 handlePswpActionClose 处理
  } else {
    closePreviewContextMenu();
  }
};

const handlePreviewActionCommand = (command: string) => {
  if (!previewImage.value) return;
  const payload = {
    command,
    image: previewImage.value,
  };
  if (IS_ANDROID) {
    // On Android, hide PSWP UI after command (except for remove which may close preview)
    if (command !== "remove") {
      pswpRef.value?.toggleUI();
    }
  } else {
    closePreviewContextMenu();
  }
  emit("contextCommand", payload);
};

const handlePreviewMouseMove = (event: MouseEvent) => {
  // 使用缓存 rect，避免每次 mousemove 强制布局
  if (previewContainerRect.value.width <= 0) {
    measureContainerSize();
  }
  const rect = previewContainerRect.value;
  const x = event.clientX - rect.left;
  const w = rect.width || 0;
  if (w <= 0) return;
  const edge = w * 0.2;
  if (x <= edge) previewHoverSide.value = "left";
  else if (x >= w - edge) previewHoverSide.value = "right";
  else previewHoverSide.value = null;
};

const handlePreviewMouseLeave = () => {
  previewHoverSide.value = null;
};

// stopPreviewDrag 已删除，由 Panzoom 自动处理（仅桌面端）

// Android 触摸手势处理


const handlePreviewImageLoad = async () => {
  await measureSizesAfterRender();
  if (previewBaseSize.value.width > 0 && previewBaseSize.value.height > 0) {
    const container = previewAvailableSize.value;
    const base = previewBaseSize.value;
    if (base.width <= container.width && base.height <= container.height) {
      setPreviewTransform(1, 0, 0);
    }
    prevAvailableSize.value = { ...previewAvailableSize.value };
  }
  previewImageLoading.value = false;
};

const handlePreviewImageError = () => {
  // 预览图加载失败（常见：original 文件被删/路径失效/权限问题）：
  // 回落到 thumbnail，避免预览一直空白/破图。
  const img = previewImage.value;
  if (!previewVisible.value || !img) {
    previewImageLoading.value = false;
    return;
  }

  const data = props.imageUrlMap?.[img.id];
  const thumb = data?.thumbnail || "";
  const current = previewImageUrl.value || "";

  // 避免死循环：如果已经在用 thumbnail 仍失败，则只结束 loading
  if (!thumb || current === thumb) {
    previewImageLoading.value = false;
    previewImageUrl.value = "";
    previewNotFound.value = true;
    return;
  }

  previewImageUrl.value = thumb;
  previewImageLoading.value = false;
  previewNotFound.value = false;
  // 图片加载完成后重置缩放（仅桌面端）
  panzoomReset();
};

const handlePreviewKeyDown = (event: KeyboardEvent) => {
  if (!previewVisible.value) return;
  if (isTextInputLike(event.target)) return;
  if ((event.ctrlKey || event.metaKey) && (event.key === "c" || event.key === "C")) {
    if (!previewImage.value) return;
    event.preventDefault();
    event.stopPropagation();
    if ("stopImmediatePropagation" in event) {
      (event as any).stopImmediatePropagation();
    }
    emit("contextCommand", { command: "copy", image: previewImage.value });
    return;
  }
  if (event.key === "ArrowLeft") {
    event.preventDefault();
    void goPrev();
    return;
  }
  if (event.key === "ArrowRight") {
    event.preventDefault();
    void goNext();
    return;
  }
  // Delete / Backspace：快速删除当前预览图片
  if ((event.key === "Delete" || event.key === "Backspace") && previewImage.value) {
    event.preventDefault();
    emit("contextCommand", { command: "remove", image: previewImage.value });
    return;
  }
};

/** Android 预览关闭后的清理（不调用 pswp.close），避免 destroy 时重复关闭且确保遮罩移除 */
function doAndroidPreviewCleanup() {
  if (!IS_ANDROID) return;
  previewVisible.value = false;
  pswpUiVisible.value = false;
  if (longPressTimer) {
    clearTimeout(longPressTimer);
    longPressTimer = null;
  }
  closePreviewContextMenu();
}

const closePreview = () => {
  if (IS_ANDROID) {
    previewVisible.value = false;
    doAndroidPreviewCleanup();
    previewImage.value = null;
    previewIndex.value = -1;
    return;
  }
  previewVisible.value = false;
  previewImageUrl.value = "";
  previewImagePath.value = "";
  previewImage.value = null;
  previewIndex.value = -1;
  previewHoverSide.value = null;
  closePreviewContextMenu();
  previewImageLoading.value = false;
  panzoomDestroy();
  if (previewInteractTimer) clearTimeout(previewInteractTimer);
  previewInteractTimer = null;
  notifyPreviewInteracting(false);
  if (navThrottleTimer) clearTimeout(navThrottleTimer);
  navThrottleTimer = null;
  isNavThrottled = false;
};

const performSwipeDelete = () => {
  if (!previewImage.value) return;
  emit("contextCommand", { command: "swipe-remove", image: previewImage.value });
};

const handlePreviewImageDeleted = () => {
  if (!previewVisible.value) return;
  if (props.images.length === 0) {
    closePreview();
    return;
  }
  let newIndex: number;
  if (previewIndex.value >= 0 && previewIndex.value < props.images.length) {
    newIndex = previewIndex.value;
  } else if (previewIndex.value >= props.images.length) {
    newIndex = props.images.length - 1;
  } else {
    newIndex = 0;
  }
  
  // Android: 响应式更新，只需同步 index 和 image
  if (IS_ANDROID) {
    previewIndex.value = newIndex;
    previewImage.value = props.images[newIndex] ?? null;
  } else {
    setPreviewByIndex(newIndex);
  }
};

watch(
  () => props.images.length,
  (_nextLen, _prevLen) => {
    if (!previewVisible.value) return;
    if (previewImage.value) {
      const idx = props.images.findIndex((i) => i.id === previewImage.value?.id);
      if (idx !== -1) {
        previewIndex.value = idx;
      } else {
        handlePreviewImageDeleted();
      }
    }
  }
);

watch(
  () => previewVisible.value,
  async (visible) => {
    if (visible) {
      if (!IS_ANDROID) {
        await nextTick();
        await measureSizesAfterRender();
        prevAvailableSize.value = { ...previewAvailableSize.value };
      }
    } else {
      prevAvailableSize.value = { width: 0, height: 0 };
    }
  }
);

watch(
  () => previewImageUrl.value,
  (url) => {
    if (url && !IS_ANDROID) {
      setPreviewTransform(1, 0, 0);
    }
  }
);

// 桌面端：当 urlCache 中原图 URL 就绪时自动更新 previewImageUrl
watch(
  () => {
    const id = previewImage.value?.id;
    return id ? urlCache.imageUrlMap.value[id]?.original : undefined;
  },
  (newOriginal) => {
    if (!newOriginal || !previewVisible.value || IS_ANDROID) return;
    if (previewImageUrl.value !== newOriginal) {
      previewImageUrl.value = newOriginal;
      previewNotFound.value = false;
      previewImageLoading.value = false;
    }
  }
);

let resizeObserver: ResizeObserver | null = null;
const prevAvailableSize = ref({ width: 0, height: 0 });

const setupResizeObserver = () => {
  if (resizeObserver) {
    resizeObserver.disconnect();
  }
  const container = previewContainerRef.value;
  if (!container) return;
  resizeObserver = new ResizeObserver(() => {
    if (!previewVisible.value) return;
    const prevAvailable = { ...prevAvailableSize.value };
    measureContainerSize();
    prevAvailableSize.value = { ...previewAvailableSize.value };
    if (previewScale.value === 1) {
      measureBaseSize();
      if (previewBaseSize.value.width > 0 && previewBaseSize.value.height > 0) {
        const containerSize = previewAvailableSize.value;
        const base = previewBaseSize.value;
        if (base.width <= containerSize.width && base.height <= containerSize.height) {
          setPreviewTransform(1, 0, 0);
        }
      }
    } else {
      const currentScale = previewScale.value;
      const currentX = previewTranslateX.value;
      const currentY = previewTranslateY.value;
      const available = previewAvailableSize.value;
      const base = previewBaseSize.value;
      if (available.width > 0 && available.height > 0 && base.width > 0 && base.height > 0) {
        const scaledWidth = base.width * currentScale;
        const scaledHeight = base.height * currentScale;
        if (scaledWidth <= available.width && scaledHeight <= available.height) {
          setPreviewTransform(1, 0, 0);
          nextTick(() => {
            measureBaseSize();
          });
        } else {
          if (prevAvailable.width <= 0 || prevAvailable.height <= 0) {
            setPreviewTransform(currentScale, currentX, currentY);
          } else {
            const prevMaxOffsetX = Math.max(0, (scaledWidth - prevAvailable.width) / 2);
            const prevMaxOffsetY = Math.max(0, (scaledHeight - prevAvailable.height) / 2);
            const newMaxOffsetX = Math.max(0, (scaledWidth - available.width) / 2);
            const newMaxOffsetY = Math.max(0, (scaledHeight - available.height) / 2);
            let relativeX = 0;
            let relativeY = 0;
            if (prevMaxOffsetX > 0) {
              relativeX = currentX / prevMaxOffsetX;
            }
            if (prevMaxOffsetY > 0) {
              relativeY = currentY / prevMaxOffsetY;
            }
            const newX = newMaxOffsetX > 0 ? relativeX * newMaxOffsetX : 0;
            const newY = newMaxOffsetY > 0 ? relativeY * newMaxOffsetY : 0;
            setPreviewTransform(currentScale, newX, newY);
          }
        }
      } else {
        setPreviewTransform(1, 0, 0);
        nextTick(() => {
          measureBaseSize();
        });
      }
    }
  });
  resizeObserver.observe(container);
};

// Android PhotoSwipe 事件处理
// 跟踪初始 panY 值（slide 中心位置），用于判断方向
let initialPanY: number | null = null;
const handlePswpVerticalDrag = ({ panY, preventDefault }: { panY: number; preventDefault: () => void }) => {
  // panY 是 slide 的 pan.y 值，需要相对于 centerY 计算比例
  // 由于无法直接访问 centerY，我们使用第一次调用时的 panY 作为基准（假设初始时 panY ≈ centerY）
  if (initialPanY === null) {
    initialPanY = panY;
  }
  
  // 计算相对于初始位置的偏移（简化：假设初始 panY 就是 centerY）
  const offset = panY - initialPanY;
  const viewportHeight = window.innerHeight;
  const ratio = offset / (viewportHeight / 3);
  
  // 清除之前的重置定时器
  if (verticalDragResetTimer) {
    clearTimeout(verticalDragResetTimer);
    verticalDragResetTimer = null;
  }
  
  if (ratio > 0) {
    // 下划：阻止默认行为（视觉效果和关闭）
    preventDefault();
    swipeDeleteActive.value = false;
    swipeDeleteReady.value = false;
    isFromVerticalDrag = false;
  } else {
    // 上划：允许默认视觉效果，追踪删除状态
    swipeDeleteActive.value = true;
    const absRatio = Math.abs(ratio);
    swipeDeleteReady.value = absRatio >= 0.4; // PhotoSwipe 的 MIN_RATIO_TO_CLOSE 阈值
    isFromVerticalDrag = true;
    
    // 设置延时重置标志（确保 drag end → close 调用链中标志有效）
    verticalDragResetTimer = setTimeout(() => {
      isFromVerticalDrag = false;
      verticalDragResetTimer = null;
    }, 300);
  }
};

// 重置初始 panY（当预览关闭或切换图片时）
watch(() => previewVisible.value, (visible) => {
  if (!visible) {
    initialPanY = null;
  }
});

const handlePswpBeforeClose = (source?: string): boolean => {
  // 当 source === 'verticalDrag' 时拦截（上划删除或回弹）
  if (source === 'verticalDrag') {
    if (isFromVerticalDrag) {
      const wasDeleteReady = swipeDeleteReady.value;
      swipeDeleteActive.value = false;
      swipeDeleteReady.value = false;
      isFromVerticalDrag = false;
      if (verticalDragResetTimer) {
        clearTimeout(verticalDragResetTimer);
        verticalDragResetTimer = null;
      }
      
      if (wasDeleteReady) {
        // 上划删除：触发删除操作，不关闭预览
        performSwipeDelete();
      }
      // 无论是否删除，都拦截关闭（删除时由响应式更新处理，未达阈值时回弹）
      return false;
    }
  }
  // 其他情况允许关闭
  return true;
};

const handlePswpChange = ({ index }: { index: number }) => {
  if (index >= 0 && index < props.images.length) {
    previewIndex.value = index;
    previewImage.value = props.images[index] ?? null;
  }
};

/** 安卓上切换控件（点击显示顶部栏）时，更新 UI 可见性状态 */
const handlePswpUiVisibleChange = ({ visible }: { visible: boolean }) => {
  if (IS_ANDROID) {
    pswpUiVisible.value = visible;
  }
};

const handlePswpClose = () => {
  doAndroidPreviewCleanup();
  previewImage.value = null;
  previewIndex.value = -1;
  swipeDeleteActive.value = false;
  swipeDeleteReady.value = false;
  isFromVerticalDrag = false;
  if (verticalDragResetTimer) {
    clearTimeout(verticalDragResetTimer);
    verticalDragResetTimer = null;
  }
};

onMounted(() => {
  window.addEventListener("keydown", handlePreviewKeyDown, true);
});

onUnmounted(() => {
  window.removeEventListener("keydown", handlePreviewKeyDown, true);
  panzoomDestroy();
  if (previewInteractTimer) {
    clearTimeout(previewInteractTimer);
    previewInteractTimer = null;
  }
  notifyPreviewInteracting(false);
  if (navThrottleTimer) {
    clearTimeout(navThrottleTimer);
    navThrottleTimer = null;
  }
  isNavThrottled = false;
  if (resizeObserver) {
    resizeObserver.disconnect();
    resizeObserver = null;
  }
});

if (!IS_ANDROID) {
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
}


const open = (index: number) => {
  if (IS_ANDROID) {
    previewIndex.value = index;
    previewImage.value = props.images[index] ?? null;
    previewVisible.value = true;
    pswpUiVisible.value = false;
    return;
  }
  // 桌面端：先打开 dialog，再触发 setPreviewByIndex
  previewVisible.value = true;
  setPreviewByIndex(index);
};

defineExpose({
  open,
  close: closePreview,
  previewVisible,
  previewIndex,
});
</script>

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
    height: 50px !important;
    box-sizing: border-box !important;
    overflow: hidden !important;

    .el-dialog__title {
      overflow: hidden !important;
      text-overflow: ellipsis !important;
      white-space: nowrap !important;
      max-width: calc(90vw - 100px) !important;
      display: block !important;
    }
  }

  .el-dialog__body {
    flex: 1 1 auto !important;
    padding: 0 !important;
    display: flex !important;
    justify-content: center !important;
    align-items: center !important;
    overflow: hidden !important;
    min-height: 0 !important;
    height: calc(90vh - 50px) !important;
  }

  .preview-container {
    width: 100%;
    height: 100%;
    display: flex;
    justify-content: center;
    align-items: center;
    overflow: hidden;
    box-sizing: border-box;
    position: relative;
  }

  .preview-loading {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(255, 255, 255, 0.18);
    backdrop-filter: blur(3px);
    z-index: 3;
    pointer-events: none;
  }

  .preview-loading-inner {
    padding: 10px 14px;
    border-radius: 10px;
    background: rgba(0, 0, 0, 0.45);
    color: #ffffff;
    font-size: 14px;
    line-height: 1;
    box-shadow: 0 10px 24px rgba(0, 0, 0, 0.18);
    user-select: none;
  }

  .panzoom-wrapper {
    width: 100%;
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .preview-image {
    max-width: calc(90vw - 40px) !important;
    max-height: calc(90vh - 70px) !important;
    width: auto;
    height: auto;
    object-fit: contain;
    display: block;
    cursor: pointer;
  }

  .preview-not-found {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 14px;
    box-sizing: border-box;
    color: rgba(255, 255, 255, 0.78);
    text-align: center;
    user-select: none;
    z-index: 1;
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
      box-shadow: 0 10px 24px rgba(0, 0, 0, 0.12);
    }

    .el-icon {
      font-size: 18px;
    }
  }
}

// Android 上划删除警告区域（z-index 需在 photoswipe-vue 的 .pswp (1500) 之上）
.swipe-delete-zone {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  z-index: 2000;
  height: 80px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(to bottom, rgba(0, 0, 0, 0.6) 0%, rgba(0, 0, 0, 0.3) 50%, transparent 100%);
  pointer-events: none;
  transition: background 0.2s ease;

  &.ready {
    background: linear-gradient(to bottom, rgba(220, 38, 38, 0.7) 0%, rgba(220, 38, 38, 0.4) 50%, transparent 100%);
  }

  .swipe-delete-zone-content {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    color: #fff;
    font-size: 14px;
    font-weight: 500;

    svg {
      width: 24px;
      height: 24px;
      stroke-width: 2;
    }

    span {
      text-shadow: 0 1px 3px rgba(0, 0, 0, 0.5);
    }
  }
}

// 删除警告区域过渡动画
.swipe-delete-zone-enter-active,
.swipe-delete-zone-leave-active {
  transition: opacity 0.2s ease, transform 0.2s ease;
}

.swipe-delete-zone-enter-from {
  opacity: 0;
  transform: translateY(-20px);
}

.swipe-delete-zone-leave-to {
  opacity: 0;
  transform: translateY(-20px);
}

// Android 全屏预览样式（旧 pager 用，保留给桌面端或兼容）
.image-preview-fullscreen:not(.image-preview-pswp-root) {
  position: fixed;
  inset: 0;
  z-index: 2000;
  background: rgba(0, 0, 0, 0.85);
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  touch-action: none;

  .preview-container {
    width: 100%;
    height: 100%;
    display: flex;
    justify-content: center;
    align-items: center;
    overflow: hidden;
    box-sizing: border-box;
    position: relative;
    touch-action: none;
  }

  .preview-pager {
    width: 100%;
    height: 100%;
    position: relative;
    will-change: transform;
  }

  .preview-pager-item {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .preview-pager-prev {
    transform: translateX(-100%);
  }

  .preview-pager-next {
    transform: translateX(100%);
  }

  .preview-image-android {
    max-width: 100vw !important;
    max-height: 100vh !important;
    width: auto;
    height: auto;
    object-fit: contain;
    display: block;
    user-select: none;
    -webkit-user-drag: none;
  }

  .preview-image-adjacent {
    transform: none !important;
    transition: none !important;
  }

  .preview-loading {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(255, 255, 255, 0.18);
    backdrop-filter: blur(3px);
    z-index: 3;
    pointer-events: none;
  }

  .preview-loading-inner {
    padding: 10px 14px;
    border-radius: 10px;
    background: rgba(0, 0, 0, 0.45);
    color: #ffffff;
    font-size: 14px;
    line-height: 1;
    box-shadow: 0 10px 24px rgba(0, 0, 0, 0.18);
    user-select: none;
  }

  .preview-not-found {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 14px;
    box-sizing: border-box;
    color: rgba(255, 255, 255, 0.78);
    text-align: center;
    user-select: none;
    z-index: 1;
  }

  .preview-nav-zone {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 20%;
    display: flex;
    align-items: center;
    z-index: 2;
    transition: opacity 0.12s ease;

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
    background: rgba(255, 95, 184, 0.9);
    color: #ffffff;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    box-shadow: 0 10px 24px rgba(255, 95, 184, 0.28);
    transition: transform 0.12s ease, background-color 0.12s ease, box-shadow 0.12s ease;
    user-select: none;
    backdrop-filter: blur(8px);

    &:active {
      transform: scale(0.95);
      box-shadow: 0 8px 20px rgba(255, 95, 184, 0.24);
    }

    &.disabled {
      background: rgba(201, 201, 201, 0.9);
      box-shadow: 0 10px 24px rgba(0, 0, 0, 0.12);
    }

    .el-icon {
      font-size: 18px;
    }
  }

}
</style>
