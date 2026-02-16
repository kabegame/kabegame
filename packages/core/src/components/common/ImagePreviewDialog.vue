<template>
  <!-- Android 全屏预览（透明度动画展开/关闭） -->
  <Teleport v-if="IS_ANDROID" to="body">
    <Transition name="preview-fade">
      <div v-if="previewVisible" class="image-preview-fullscreen" @click.self="closePreview">
      <div ref="previewContainerRef" class="preview-container"
        @contextmenu.prevent.stop="handlePreviewDialogContextMenu"
        @touchstart.prevent="handleTouchStart"
        @touchmove.prevent="handleTouchMove"
        @touchend.prevent="handleTouchEnd"
        @touchcancel.prevent="handleTouchEnd"  
      >
        <!-- Pager 结构：prev/current/next 三张图片 -->
        <div class="preview-pager" :style="{ transform: `translateX(${pagerOffset}px)`, transition: pagerSettling ? 'transform 0.16s ease-out' : 'none' }">
          <!-- 上一张 -->
          <div v-if="prevImageUrl && props.images.length > 1" class="preview-pager-item preview-pager-prev">
            <img :src="prevImageUrl" class="preview-image preview-image-android preview-image-adjacent" alt="上一张" />
          </div>
          <!-- 当前张 -->
          <div class="preview-pager-item preview-pager-current">
            <img v-if="previewImageUrl" ref="previewImageRef" :src="previewImageUrl" class="preview-image preview-image-android" alt="预览图片"
              :style="previewImageStyle" @load="handlePreviewImageLoad" @error="handlePreviewImageError" />
            <div v-else-if="previewNotFound && !previewImageLoading" class="preview-not-found">
              <ImageNotFound />
            </div>
          </div>
          <!-- 下一张 -->
          <div v-if="nextImageUrl && props.images.length > 1" class="preview-pager-item preview-pager-next">
            <img :src="nextImageUrl" class="preview-image preview-image-android preview-image-adjacent" alt="下一张" />
          </div>
        </div>
        <div v-if="previewImageLoading" class="preview-loading">
          <div class="preview-loading-inner">正在加载原图…</div>
        </div>
        <!-- Android 操作栏 / Desktop 上下文菜单 -->
        <ActionRenderer
          v-if="previewActions && previewActions.length > 0"
          :visible="IS_ANDROID ? actionBarVisible : previewContextMenuVisible"
          :position="previewContextMenuPosition"
          :actions="previewActions"
          :context="previewActionContext"
          :mode="IS_ANDROID ? 'actionsheet' : 'contextmenu'"
          @close="handlePreviewActionClose"
          @command="handlePreviewActionCommand" />
      </div>
    </div>
    </Transition>
  </Teleport>

  <!-- 桌面端 Dialog 预览 -->
  <el-dialog v-else v-model="previewVisible" :title="previewDialogTitle" width="90%" :close-on-click-modal="true"
    class="image-preview-dialog" :show-close="true" :lock-scroll="true" @close="closePreview">
    <div v-if="previewVisible" ref="previewContainerRef" class="preview-container"
      @contextmenu.prevent.stop="handlePreviewDialogContextMenu" @mousemove="handlePreviewMouseMoveWithDrag"
      @mouseleave="handlePreviewMouseLeaveAll" @wheel.prevent="handlePreviewWheel" @mouseup="stopPreviewDrag">
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
      <img v-if="previewImageUrl" ref="previewImageRef" :src="previewImageUrl" class="preview-image" alt="预览图片"
        :style="previewImageStyle" @load="handlePreviewImageLoad" @error="handlePreviewImageError"
        @mousedown.prevent.stop="startPreviewDrag" @dragstart.prevent />
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
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { ElMessage } from "element-plus";
import { ArrowLeftBold, ArrowRightBold } from "@element-plus/icons-vue";
import { isTauri } from "@tauri-apps/api/core";
import type { ImageInfo, ImageUrlMap } from "../../types/image";
import ImageNotFound from "./ImageNotFound.vue";
import { useImageUrlMapCache } from "../../composables/useImageUrlMapCache";
import { IS_ANDROID } from "../../env";
import { useModalStackStore } from "../../stores/modalStack";
import ActionRenderer from "../ActionRenderer.vue";
import type { ActionItem, ActionContext } from "../../actions/types";

const props = defineProps<{
  images: ImageInfo[];
  imageUrlMap: ImageUrlMap;
  /** Actions for context menu / action sheet. */
  actions?: ActionItem<ImageInfo>[];
}>();

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
const previewScale = ref(1);
const previewTranslateX = ref(0);
const previewTranslateY = ref(0);
const previewBaseSize = ref({ width: 0, height: 0 });
const previewContainerSize = ref({ width: 0, height: 0 });
const previewAvailableSize = ref({ width: 0, height: 0 });
// 缓存 container 的 rect，避免 mousemove/wheel 高频触发时反复 getBoundingClientRect() 导致强制布局与掉帧
const previewContainerRect = ref({ left: 0, top: 0, width: 0, height: 0 });
const previewDragging = ref(false);
const previewDragStart = ref({ x: 0, y: 0 });
const previewDragStartTranslate = ref({ x: 0, y: 0 });
const previewImageLoading = ref(false);
// 仅释放本组件创建的 blob url，避免误删外部缓存的 url
const ownedOriginalBlobUrls = ref<Map<string, string>>(new Map());
const loadSeq = ref(0);
// 导航请求序号：用于“阻止切换直到 original ready”时的竞态保护
const navSeq = ref(0);
const pendingNav = ref<{ seq: number; index: number } | null>(null);
// 预加载 promise（按 imageId 去重）：resolve=true 表示预加载成功（能解码/加载），resolve=false 表示失败（文件不存在/权限/解码失败等）
const inFlightOriginalLoads = new Map<string, Promise<boolean>>();

const previewContextMenuVisible = ref(false);
const previewContextMenuPosition = ref({ x: 0, y: 0 });

// Android 触摸手势状态
const touchState = ref<{
  touches: Touch[];
  initialDistance: number;
  initialScale: number;
  initialTranslate: { x: number; y: number };
  swipeStartX: number;
  swipeStartY: number;
  isSwiping: boolean;
  isPinching: boolean;
  // Pager 状态
  pagerOffset: number;
  isPagerDragging: boolean;
  pagerSettling: boolean;
} | null>(null);

// 双击检测状态（独立于 touchState，避免 touchEnd 清空时丢失）
const lastTapTime = ref(0);
const lastTapX = ref(0);
const lastTapY = ref(0);

// Android 操作栏状态（长按预览区触发/关闭）
const actionBarVisible = ref(false);
const LONG_PRESS_MS = 500;
let longPressTimer: ReturnType<typeof setTimeout> | null = null;

// Android 系统返回栈：预览时操作栏显示则注册一层，第一次返回关闭操作栏，第二次返回关闭预览
const modalStack = useModalStackStore();
const actionBarStackId = ref<string | null>(null);
watch(
  () => IS_ANDROID && previewVisible.value && actionBarVisible.value,
  (shouldRegister) => {
    if (!shouldRegister) {
      if (actionBarStackId.value) {
        modalStack.remove(actionBarStackId.value);
        actionBarStackId.value = null;
      }
      return;
    }
    // 使用 nextTick 确保操作栏层压在预览层之上，避免单次返回同时关闭预览和 bar
    nextTick(() => {
      if (!previewVisible.value || !actionBarVisible.value) return;
      actionBarStackId.value = modalStack.push(() => {
        actionBarVisible.value = false;
      });
    });
  },
  { immediate: true }
);

// 全局 cache（用于同步生成 original asset URL）
const urlCache = useImageUrlMapCache();

const clamp = (val: number, min: number, max: number) => Math.min(max, Math.max(min, val));

// 计算 cover scale（填满屏幕的缩放比例）
const computeCoverScale = (): number => {
  const available = previewAvailableSize.value;
  const base = previewBaseSize.value;
  if (available.width > 0 && available.height > 0 && base.width > 0 && base.height > 0) {
    const widthRatio = available.width / base.width;
    const heightRatio = available.height / base.height;
    return clamp(Math.max(widthRatio, heightRatio), 1, 10);
  }
  return 1;
};

// 双击缩放：以点击点为中心进行 cover/contain 切换
const handleDoubleTapZoom = async (tapX: number, tapY: number) => {
  if (!IS_ANDROID || !previewVisible.value) return;
  
  measureContainerSize();
  await nextTick();
  measureBaseSize();
  
  const coverScale = computeCoverScale();
  const currentScale = previewScale.value;
  const isCurrentlyCovered = currentScale >= coverScale * 0.95; // 允许 5% 误差
  
  let targetScale: number;
  if (isCurrentlyCovered) {
    // 当前已 cover，缩回 contain
    targetScale = 1;
  } else {
    // 当前未 cover，放大到 cover
    targetScale = coverScale;
  }
  
  if (Math.abs(targetScale - currentScale) < 0.01) return; // 已经达到目标
  
  // 计算点击点相对容器中心的坐标
  const rect = previewContainerRect.value;
  const containerCenterX = rect.width / 2;
  const containerCenterY = rect.height / 2;
  const relativeX = tapX - (rect.left + containerCenterX);
  const relativeY = tapY - (rect.top + containerCenterY);
  
  // 计算当前点击点在图片坐标系中的位置
  // 图片坐标 u = (屏幕坐标 p - 平移 t) / 缩放 s
  const imageX = (relativeX - previewTranslateX.value) / currentScale;
  const imageY = (relativeY - previewTranslateY.value) / currentScale;
  
  // 目标缩放时，让该点成为屏幕中心
  const targetX = -imageX * targetScale;
  const targetY = -imageY * targetScale;
  
  setPreviewTransform(targetScale, targetX, targetY);
};

// wheel 缩放：合批到 rAF，每帧最多执行一次布局测量与 transform 更新
const previewWheelZooming = ref(false);
let wheelZoomTimer: ReturnType<typeof setTimeout> | null = null;
let wheelRaf: number | null = null;
let wheelSteps = 0; // 每个 wheel 事件累计 ±1，最终换算到 scale
let wheelLastClientX = 0;
let wheelLastClientY = 0;

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

const resetPreviewTransform = async () => {
  setPreviewTransform(1, 0, 0);
  await measureSizesAfterRender();
};

const previewImageStyle = computed(() => ({
  transform: `translate(${previewTranslateX.value}px, ${previewTranslateY.value}px) scale(${previewScale.value})`,
  transition: previewDragging.value || previewWheelZooming.value ? "none" : "transform 0.08s ease-out",
  cursor: previewScale.value > 1 ? (previewDragging.value ? "grabbing" : "grab") : "default",
  "transform-origin": "center center",
}));

const previewDialogTitle = computed(() => {
  if (!previewImage.value?.localPath) {
    return "图片预览";
  }
  // 从路径中提取文件名（支持 Windows 和 Unix 路径分隔符）
  const path = previewImage.value.localPath;
  const fileName = path.split(/[/\\]/).pop() || path;
  return fileName || "图片预览";
});

// Android 下 actionsheet 不展示「仔细欣赏」「欣赏更多」
// Actions 可见性由各 action 的 visible() 控制（如 imageActions 在 Android 上隐藏 open/openFolder）
const previewActions = computed(() => props.actions ?? []);

const isTextInputLike = (target: EventTarget | null) => {
  const el = target as HTMLElement | null;
  const tag = el?.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || !!el?.isContentEditable;
};

const getOriginalUrlFor = (imageId: string) => {
  return props.imageUrlMap?.[imageId]?.original || ownedOriginalBlobUrls.value.get(imageId) || "";
};

async function preloadImageUrl(url: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const img = new Image();
    img.decoding = "async";
    img.loading = "eager";
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("preload failed"));
    img.src = url;
  });
}

const getOrCreateOriginalUrlFor = (image: ImageInfo) => {
  const hit = getOriginalUrlFor(image.id);
  if (hit) return hit;
  if (!image.localPath) return "";
  return urlCache.ensureOriginalAssetUrl(image.id, image.localPath) || "";
};

const ensureOriginalPreload = (image: ImageInfo, originalUrl: string) => {
  if (!originalUrl) return Promise.resolve(false);
  const inflight = inFlightOriginalLoads.get(image.id);
  if (inflight) return inflight;
  const p = preloadImageUrl(originalUrl)
    .then(() => {
      // preload 成功后更新到本地缓存（用于 prefetch 场景）
      if (!ownedOriginalBlobUrls.value.has(image.id)) {
        ownedOriginalBlobUrls.value.set(image.id, originalUrl);
      }
      return true;
    })
    .catch(() => false)
    .finally(() => {
      inFlightOriginalLoads.delete(image.id);
    });
  inFlightOriginalLoads.set(image.id, p);
  return p;
};

const waitWithTimeout = async <T,>(
  p: Promise<T>,
  ms: number
): Promise<{ settled: true; value: T } | { settled: false }> => {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<{ settled: false }>((resolve) => {
    timer = setTimeout(() => resolve({ settled: false }), ms);
  });
  const result = await Promise.race([
    p.then((value) => ({ settled: true as const, value })),
    timeout,
  ]);
  if (timer) clearTimeout(timer);
  return result;
};

const releaseOwnedOriginalUrl = (imageId: string) => {
  const url = ownedOriginalBlobUrls.value.get(imageId);
  if (url && url.startsWith("blob:")) {
    try {
      URL.revokeObjectURL(url);
    } catch {
      // ignore
    }
  }
  ownedOriginalBlobUrls.value.delete(imageId);
};

const releaseAllOwnedOriginalUrls = () => {
  for (const id of ownedOriginalBlobUrls.value.keys()) {
    releaseOwnedOriginalUrl(id);
  }
};

const setPreviewByIndex = (index: number, opts?: { showLoading?: boolean }) => {
  const img = props.images[index];
  if (!img) return;

  previewIndex.value = index;
  previewImagePath.value = img.localPath;
  previewImage.value = img;
  previewNotFound.value = false;

  // // 新策略：预览切换只展示 original（如果 original 未就绪，应由导航层阻止切换）
  // const originalUrl = getOriginalUrlFor(img.id);
  // if (!originalUrl) {
  //   previewImageUrl.value = "";
  //   previewImageLoading.value = false;
  //   previewNotFound.value = true;
  //   return;
  // }

  // previewImageLoading.value = false;
  // previewNotFound.value = false;
  // previewImageUrl.value = originalUrl;
  // resetPreviewTransform();
  // 立即同步生成 original asset URL（如果 imageUrlMap 里还没有）
  const data = props.imageUrlMap?.[img.id];
  const thumb = data?.thumbnail || "";
  const originalUrl = getOrCreateOriginalUrlFor(img);

  previewNotFound.value = false;
  previewImageLoading.value = !!opts?.showLoading;
  previewImageUrl.value = (originalUrl || thumb || "").trim();

  // 尺寸/缩放状态重置：立即触发一次
  resetPreviewTransform();

  // 后台预加载原图（不阻塞 UI；是否显示 loading 由导航层决定）
  if (originalUrl) void ensureOriginalPreload(img, originalUrl);

  // 预取相邻：始终进行（不依赖当前图是否加载完）
  if (typeof requestIdleCallback !== "undefined") {
    requestIdleCallback(() => prefetchAdjacent(), { timeout: 2000 });
  } else {
    setTimeout(() => prefetchAdjacent(), 80);
  }
};

const canGoPrev = computed(() => {
  if (props.images.length <= 1) return false;
  if (!previewVisible.value) return false;
  return true;
});

const canGoNext = computed(() => {
  if (props.images.length <= 1) return false;
  if (!previewVisible.value) return false;
  return true;
});

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

const prevImageUrl = computed(() => getAdjacentImageUrl(-1));
const nextImageUrl = computed(() => getAdjacentImageUrl(1));

// Pager offset（用于滑动切换动画）
const pagerOffset = ref(0);
const pagerSettling = ref(false);

// 切换节流：100ms 内最多只执行一次切换，避免快速连击导致状态混乱
let navThrottleTimer: ReturnType<typeof setTimeout> | null = null;
let isNavThrottled = false;
const NAV_THROTTLE_MS = 100;

const NAV_PRELOAD_WAIT_MS = 300;

const navigateWithPreloadGate = async (targetIndex: number) => {
  if (!previewVisible.value) return;
  const target = props.images[targetIndex];
  if (!target) return;

  // 导航序号：防止连续点击导致旧的 await 回来覆盖新状态
  const seq = ++navSeq.value;
  pendingNav.value = { seq, index: targetIndex };

  const data = props.imageUrlMap?.[target.id];
  const thumb = (data?.thumbnail || "").trim();
  const originalUrl = getOrCreateOriginalUrlFor(target).trim();

  // 如果没有 originalUrl（例如没有 localPath），只能直接切换（靠 img onerror 决定 notFound/回落）
  if (!originalUrl) {
    setPreviewByIndex(targetIndex, { showLoading: false });
    pendingNav.value = null;
    return;
  }

  // 开始预加载（不影响当前图显示）
  const preloadPromise = ensureOriginalPreload(target, originalUrl);
  const waited = await waitWithTimeout(preloadPromise, NAV_PRELOAD_WAIT_MS);

  // 被更新的导航请求覆盖了：直接丢弃
  if (seq !== navSeq.value) return;

  if (waited.settled) {
    // 300ms 内预加载有结果（成功/失败）-> 无需 loading，直接切换
    if (waited.value) {
      setPreviewByIndex(targetIndex, { showLoading: false });
      // 确保展示 original（setPreviewByIndex 会优先 original）
      previewImageUrl.value = originalUrl;
      previewNotFound.value = false;
      previewImageLoading.value = false;
    } else {
      // 预加载失败：优先回落 thumbnail；否则显示 not found
      setPreviewByIndex(targetIndex, { showLoading: false });
      if (thumb) {
        previewImageUrl.value = thumb;
        previewNotFound.value = false;
      } else {
        previewImageUrl.value = "";
        previewNotFound.value = true;
      }
      previewImageLoading.value = false;
    }
    pendingNav.value = null;
    return;
  }

  // 超过 300ms 仍未出结果：切换到下一张并显示 loading；等预加载完成后再更新成原图/回落/找不到
  setPreviewByIndex(targetIndex, { showLoading: true });
  // 这里保持优先 originalUrl：浏览器可能仍显示旧图直到新图就绪，但 loading 会覆盖其上
  previewImageUrl.value = originalUrl || thumb || "";
  previewNotFound.value = false;
  previewImageLoading.value = true;

  const ok = await preloadPromise;
  if (seq !== navSeq.value) return;
  if (!previewVisible.value) return;
  if (previewImage.value?.id !== target.id) return;

  if (ok) {
    previewImageUrl.value = originalUrl;
    previewNotFound.value = false;
    previewImageLoading.value = false;
  } else if (thumb) {
    previewImageUrl.value = thumb;
    previewNotFound.value = false;
    previewImageLoading.value = false;
  } else {
    previewImageUrl.value = "";
    previewNotFound.value = true;
    previewImageLoading.value = false;
  }
  resetPreviewTransform();
  // 切换图片时重置 pager
  if (IS_ANDROID) {
    pagerOffset.value = 0;
    pagerSettling.value = false;
  }
  pendingNav.value = null;
};

const goPrev = async () => {
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

  await navigateWithPreloadGate(targetIndex);
};

const goNext = async () => {
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

  await navigateWithPreloadGate(targetIndex);
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

const handlePreviewActionClose = () => {
  if (IS_ANDROID) {
    actionBarVisible.value = false;
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
    // On Android, hide action bar after command (except for remove which may close preview)
    if (command !== "remove") {
      actionBarVisible.value = false;
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

const handlePreviewMouseMoveWithDrag = (event: MouseEvent) => {
  handlePreviewMouseMove(event);
  handlePreviewDragMove(event);
};

const handlePreviewMouseLeaveAll = () => {
  handlePreviewMouseLeave();
};

const applyWheelZoom = () => {
  wheelRaf = null;
  if (!previewVisible.value) return;
  const container = previewContainerRef.value;
  if (!container) return;

  // 每帧最多测量一次（强制布局点）
  measureContainerSize();
  const rect = previewContainerRect.value;
  if (rect.width <= 0 || rect.height <= 0) return;

  const steps = wheelSteps;
  wheelSteps = 0;
  if (steps === 0) return;

  const prevScale = previewScale.value;
  const factor = Math.pow(1.1, steps); // steps<0 时会自动缩小
  const nextScale = clamp(prevScale * factor, 1, 10);
  if (nextScale === prevScale) return;

  const centerX = rect.left + rect.width / 2;
  const centerY = rect.top + rect.height / 2;
  const pointerX = wheelLastClientX - centerX;
  const pointerY = wheelLastClientY - centerY;
  const scaleRatio = nextScale / prevScale;

  const nextX = pointerX - scaleRatio * (pointerX - previewTranslateX.value);
  const nextY = pointerY - scaleRatio * (pointerY - previewTranslateY.value);
  setPreviewTransform(nextScale, nextX, nextY);
};

const handlePreviewWheel = (event: WheelEvent) => {
  if (!previewVisible.value) return;
  event.preventDefault();
  event.stopPropagation();
  // wheel 属于强交互：通知上层暂停后台加载
  markPreviewInteracting();

  wheelLastClientX = event.clientX;
  wheelLastClientY = event.clientY;
  wheelSteps += event.deltaY < 0 ? 1 : -1;
  wheelSteps = clamp(wheelSteps, -12, 12); // 防止同一帧累计过多导致“跳变”

  // 缩放过程中禁用 transition，避免队列化动画导致掉帧
  previewWheelZooming.value = true;
  if (wheelZoomTimer) clearTimeout(wheelZoomTimer);
  wheelZoomTimer = setTimeout(() => {
    previewWheelZooming.value = false;
    wheelZoomTimer = null;
  }, 120);

  if (wheelRaf == null) {
    wheelRaf = requestAnimationFrame(applyWheelZoom);
  }
};

const startPreviewDrag = (event: MouseEvent) => {
  if (!previewVisible.value) return;
  if (previewScale.value <= 1) return;
  if (event.button !== 0 && event.button !== 1) return;
  measureContainerSize();
  previewDragging.value = true;
  // 拖拽开始：标记交互中
  notifyPreviewInteracting(true);
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
  // 拖拽结束后给一点点尾巴（避免马上恢复后台任务导致微卡顿）
  markPreviewInteracting();
};

// Android 触摸手势处理
const getDistance = (touch1: Touch, touch2: Touch): number => {
  const dx = touch2.clientX - touch1.clientX;
  const dy = touch2.clientY - touch1.clientY;
  return Math.sqrt(dx * dx + dy * dy);
};

const getCenter = (touch1: Touch, touch2: Touch): { x: number; y: number } => {
  return {
    x: (touch1.clientX + touch2.clientX) / 2,
    y: (touch1.clientY + touch2.clientY) / 2,
  };
};

const handleTouchStart = (event: TouchEvent) => {
  if (!IS_ANDROID || !previewVisible.value) return;
  
  const touches = Array.from(event.touches);
  if (touches.length === 0) return;

  measureContainerSize();
  
  // 重置 pager 状态
  pagerSettling.value = false;
  
  if (touches.length === 2) {
    // 双指缩放：取消 pager 拖拽
    const distance = getDistance(touches[0], touches[1]);
    touchState.value = {
      touches,
      initialDistance: distance,
      initialScale: previewScale.value,
      initialTranslate: { x: previewTranslateX.value, y: previewTranslateY.value },
      swipeStartX: 0,
      swipeStartY: 0,
      isSwiping: false,
      isPinching: true,
      pagerOffset: 0,
      isPagerDragging: false,
      pagerSettling: false,
    };
    pagerOffset.value = 0;
    notifyPreviewInteracting(true);
  } else if (touches.length === 1) {
    // 单指：可能是滑动切换、拖拽平移或双击
    const touch = touches[0];
    const now = Date.now();
    const isDoubleTap = 
      (now - lastTapTime.value) < 300 &&
      Math.abs(touch.clientX - lastTapX.value) < 50 &&
      Math.abs(touch.clientY - lastTapY.value) < 50;
    
    if (isDoubleTap) {
      // 双击：执行缩放（移除 scale 限制，任意状态下都可以双击）
      if (longPressTimer) {
        clearTimeout(longPressTimer);
        longPressTimer = null;
      }
      void handleDoubleTapZoom(touch.clientX, touch.clientY);
      touchState.value = null;
      pagerOffset.value = 0;
      // 重置双击检测时间，避免连续三次点击被误判为双击
      lastTapTime.value = 0;
      return;
    }
    
    // 更新双击检测状态
    lastTapTime.value = now;
    lastTapX.value = touch.clientX;
    lastTapY.value = touch.clientY;
    
    touchState.value = {
      touches,
      initialDistance: 0,
      initialScale: previewScale.value,
      initialTranslate: { x: previewTranslateX.value, y: previewTranslateY.value },
      swipeStartX: touch.clientX,
      swipeStartY: touch.clientY,
      isSwiping: previewScale.value === 1, // scale=1 时用于滑动切换
      isPinching: false,
      pagerOffset: 0,
      isPagerDragging: false,
      pagerSettling: false,
    };
    pagerOffset.value = 0;
    if (previewScale.value > 1) {
      // scale>1 时用于拖拽平移
      notifyPreviewInteracting(true);
    }
    // 单指长按：达到时长后切换操作栏（触发/关闭）
    const hasActions = previewActions.value && previewActions.value.length > 0;
    if (hasActions && longPressTimer === null) {
      longPressTimer = setTimeout(() => {
        longPressTimer = null;
        if (previewVisible.value) {
          actionBarVisible.value = !actionBarVisible.value;
        }
      }, LONG_PRESS_MS);
    }
  }
};

const handleTouchMove = (event: TouchEvent) => {
  if (!IS_ANDROID || !previewVisible.value || !touchState.value) return;
  
  const touches = Array.from(event.touches);
  if (touches.length === 0) return;

  if (touches.length === 2 && touchState.value.isPinching) {
    // 双指缩放：取消 pager
    const distance = getDistance(touches[0], touches[1]);
    if (touchState.value.initialDistance > 0) {
      const scaleRatio = distance / touchState.value.initialDistance;
      const newScale = clamp(
        touchState.value.initialScale * scaleRatio,
        1,
        10
      );
      
      // 以两指中心为缩放中心
      const center = getCenter(touches[0], touches[1]);
      const rect = previewContainerRect.value;
      const centerX = center.x - (rect.left + rect.width / 2);
      const centerY = center.y - (rect.top + rect.height / 2);
      
      const scaleChange = newScale / touchState.value.initialScale;
      const newX = centerX - scaleChange * (centerX - touchState.value.initialTranslate.x);
      const newY = centerY - scaleChange * (centerY - touchState.value.initialTranslate.y);
      
      setPreviewTransform(newScale, newX, newY);
    }
    touchState.value.touches = touches;
    pagerOffset.value = 0;
  } else if (touches.length === 1) {
    const touch = touches[0];
    const dx = touch.clientX - touchState.value.swipeStartX;
    const dy = touch.clientY - touchState.value.swipeStartY;
    const absDx = Math.abs(dx);
    const absDy = Math.abs(dy);
    // 移动超过阈值则取消长按（不触发/关闭操作栏）
    const movement = Math.sqrt(dx * dx + dy * dy);
    if (movement > 10 && longPressTimer) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
    if (touchState.value.isSwiping && previewScale.value === 1) {
      // scale=1 时：直接作为 pager 拖拽
      const containerWidth = previewContainerRect.value.width;
      if (containerWidth > 0) {
        // 限制拖拽范围，允许一定程度的越界
        const maxOffset = containerWidth * 0.8;
        pagerOffset.value = clamp(dx, -maxOffset, maxOffset);
        touchState.value.isPagerDragging = true;
      }
      touchState.value.touches = touches;
    } else if (previewScale.value > 1 && !touchState.value.isPinching) {
      // scale>1 时：先做图片平移，到达边缘后转为 pager 拖拽
      const newX = touchState.value.initialTranslate.x + dx;
      const newY = touchState.value.initialTranslate.y + dy;
      
      // 计算平移后的边界
      const clamped = clampTranslate(previewScale.value, newX, newY);
      const isAtEdgeX = Math.abs(newX - clamped.x) > 1; // 有越界
      
      if (isAtEdgeX && absDx > absDy * 1.5) {
        // 到达 X 方向边缘且水平滑动占主导：转为 pager 拖拽
        const overX = newX - clamped.x; // 越界量
        const containerWidth = previewContainerRect.value.width;
        if (containerWidth > 0) {
          // 将越界量转换为 pager offset（带阻尼）
          const damping = 0.5; // 阻尼系数，使拖拽感觉更自然
          pagerOffset.value = clamp(overX * damping, -containerWidth * 0.8, containerWidth * 0.8);
          touchState.value.isPagerDragging = true;
        }
        // 图片本身保持在边界
        setPreviewTransform(previewScale.value, clamped.x, clamped.y);
      } else {
        // 正常平移
        setPreviewTransform(previewScale.value, newX, newY);
        pagerOffset.value = 0;
        touchState.value.isPagerDragging = false;
      }
      touchState.value.touches = touches;
    }
  }
};

const handleTouchEnd = (event: TouchEvent) => {
  if (!IS_ANDROID || !previewVisible.value || !touchState.value) return;
  
  const touches = Array.from(event.touches);
  
  if (touches.length === 0) {
    // 所有手指都离开
    const wasPagerDragging = touchState.value.isPagerDragging;
    const currentOffset = pagerOffset.value;
    const containerWidth = previewContainerRect.value.width;
    const threshold = containerWidth * 0.2; // 20% 阈值
    
    if (wasPagerDragging && Math.abs(currentOffset) > threshold) {
      // 超过阈值：完成切换
      pagerSettling.value = true;
      const targetOffset = currentOffset > 0 ? containerWidth : -containerWidth;
      pagerOffset.value = targetOffset;
      
      // 动画结束后切换图片并重置
      setTimeout(() => {
        if (currentOffset > 0) {
          void goPrev();
        } else {
          void goNext();
        }
        pagerOffset.value = 0;
        pagerSettling.value = false;
      }, 160);
    } else if (wasPagerDragging) {
      // 未超过阈值：回弹
      pagerSettling.value = true;
      pagerOffset.value = 0;
      setTimeout(() => {
        pagerSettling.value = false;
      }, 160);
    } else if (touchState.value.isSwiping && previewScale.value === 1) {
      // 原有的滑动切换逻辑（向后兼容）
      const lastTouch = touchState.value.touches[0];
      if (lastTouch) {
        const dx = lastTouch.clientX - touchState.value.swipeStartX;
        const dy = lastTouch.clientY - touchState.value.swipeStartY;
        const absDx = Math.abs(dx);
        const absDy = Math.abs(dy);
        
        // 水平滑动超过 80px 且水平滑动距离大于垂直滑动距离的 2 倍
        if (absDx > 80 && absDx > absDy * 2) {
          if (dx > 0) {
            // 向右滑动 -> 上一张
            void goPrev();
          } else {
            // 向左滑动 -> 下一张
            void goNext();
          }
        }
        // 滑动距离不足时不再用点击切换操作栏，改为长按触发/关闭
      }
    } else {
      // 非滑动情况：仅清理长按计时器（长按已在 timer 回调里处理）
    }
    if (longPressTimer) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
    touchState.value = null;
    markPreviewInteracting();
  } else if (touches.length === 1 && touchState.value.isPinching) {
    // 双指变单指：转为单指拖拽模式（如果已放大）
    const touch = touches[0];
    if (previewScale.value > 1) {
      touchState.value = {
        touches,
        initialDistance: 0,
        initialScale: previewScale.value,
        initialTranslate: { x: previewTranslateX.value, y: previewTranslateY.value },
        swipeStartX: touch.clientX,
        swipeStartY: touch.clientY,
        isSwiping: false,
        isPinching: false,
        pagerOffset: 0,
        isPagerDragging: false,
        pagerSettling: false,
      };
      pagerOffset.value = 0;
    } else {
      // 如果缩放回到 1，清理状态
      touchState.value = null;
      pagerOffset.value = 0;
      markPreviewInteracting();
    }
  }
};

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
  // 当前图已就绪：预取相邻图片的原图，减少切换时 loading 闪烁
  // 放到空闲时，避免与缩放/拖动交互抢 CPU
  if (typeof requestIdleCallback !== "undefined") {
    requestIdleCallback(() => prefetchAdjacent(), { timeout: 2000 });
  } else {
    setTimeout(() => prefetchAdjacent(), 80);
  }
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
  resetPreviewTransform();
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

const closePreview = () => {
  previewVisible.value = false;
  previewImageUrl.value = "";
  previewImagePath.value = "";
  previewImage.value = null;
  previewIndex.value = -1;
  previewHoverSide.value = null;
  closePreviewContextMenu();
  previewImageLoading.value = false;
  previewWheelZooming.value = false;
  if (wheelZoomTimer) clearTimeout(wheelZoomTimer);
  wheelZoomTimer = null;
  if (wheelRaf != null) cancelAnimationFrame(wheelRaf);
  wheelRaf = null;
  wheelSteps = 0;
  if (previewInteractTimer) clearTimeout(previewInteractTimer);
  previewInteractTimer = null;
  notifyPreviewInteracting(false);
  if (navThrottleTimer) clearTimeout(navThrottleTimer);
  navThrottleTimer = null;
  isNavThrottled = false;
  releaseAllOwnedOriginalUrls();
  pendingNav.value = null;
  // Android 触摸状态清理
  if (IS_ANDROID) {
    touchState.value = null;
    pagerOffset.value = 0;
    pagerSettling.value = false;
    actionBarVisible.value = false;
    if (longPressTimer) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
  }
};

const handlePreviewImageDeleted = () => {
  if (!previewVisible.value) return;
  if (props.images.length === 0) {
    closePreview();
    return;
  }
  if (previewIndex.value >= 0 && previewIndex.value < props.images.length) {
    setPreviewByIndex(previewIndex.value);
  } else if (previewIndex.value >= props.images.length) {
    setPreviewByIndex(props.images.length - 1);
  } else {
    setPreviewByIndex(0);
  }
};

watch(
  () => props.images,
  () => {
    // 性能关键：大列表下不要用 deep watch（会对 10w/100w+ 元素做深度遍历/依赖追踪）
    // 这里仅在 images 数组引用发生变化时做一次“校准”，并且只在预览打开时生效。
    if (!previewVisible.value || !previewImage.value) return;
    const currentId = previewImage.value.id;
    // fast-path：index 仍然指向同一张图，只需要更新引用以保持一致
    if (previewIndex.value >= 0 && previewIndex.value < props.images.length) {
      const atIndex = props.images[previewIndex.value];
      if (atIndex && atIndex.id === currentId) {
        previewImage.value = atIndex;
        return;
      }
    }
    // fallback：只在不一致/可能删除/重排时做一次线性查找
    const idx = props.images.findIndex((img) => img.id === currentId);
    if (idx === -1) {
      handlePreviewImageDeleted();
      return;
    }
    previewIndex.value = idx;
    previewImage.value = props.images[idx] || previewImage.value;
  },
  { deep: false }
);

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
      await nextTick();
      await measureSizesAfterRender();
      prevAvailableSize.value = { ...previewAvailableSize.value };
    } else {
      stopPreviewDrag();
      prevAvailableSize.value = { width: 0, height: 0 };
    }
  }
);

watch(
  () => previewImageUrl.value,
  (url) => {
    if (url) {
      setPreviewTransform(1, 0, 0);
      // 切换图片时重置 pager
      if (IS_ANDROID) {
        pagerOffset.value = 0;
        pagerSettling.value = false;
      }
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

onMounted(() => {
  window.addEventListener("mouseup", stopPreviewDrag);
  window.addEventListener("mousemove", handlePreviewDragMove);
  window.addEventListener("keydown", handlePreviewKeyDown, true);
});

onUnmounted(() => {
  window.removeEventListener("mouseup", stopPreviewDrag);
  window.removeEventListener("mousemove", handlePreviewDragMove);
  window.removeEventListener("keydown", handlePreviewKeyDown, true);
  if (wheelZoomTimer) {
    clearTimeout(wheelZoomTimer);
    wheelZoomTimer = null;
  }
  if (wheelRaf != null) {
    cancelAnimationFrame(wheelRaf);
    wheelRaf = null;
  }
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
  releaseAllOwnedOriginalUrls();
});

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

async function ensureOriginalReady(image: ImageInfo, opts: { seq: number; fallbackUrl?: string }) {
  if (!image.localPath) return;
  try {
    const expectedId = image.id;
    // seq === -1 表示预取：不应改变当前显示/交互状态
    const isPrefetch = opts.seq === -1;
    let normalizedPath = image.localPath.trimStart().replace(/^\\\\\?\\/, "").trim();
    if (!normalizedPath) return;
    if (!isTauri()) {
      // 非 Tauri 环境下无法从 localPath 生成可加载 URL：对当前目标图做兜底，避免一直 loading
      if (
        !isPrefetch &&
        previewVisible.value &&
        previewImage.value?.id === expectedId &&
        opts.seq === loadSeq.value
      ) {
        if (opts.fallbackUrl) {
          previewImageUrl.value = opts.fallbackUrl;
          previewNotFound.value = false;
        } else {
          previewImageUrl.value = "";
          previewNotFound.value = true;
        }
        previewImageLoading.value = false;
        resetPreviewTransform();
      }
      return;
    }
    const url = getOrCreateOriginalUrlFor(image);
    if (!url) return;
    const ok = await ensureOriginalPreload(image, url);
    if (isPrefetch) return;
    if (previewVisible.value && previewImage.value?.id === expectedId && opts.seq === loadSeq.value) {
      if (ok) {
        previewImageUrl.value = url;
        previewNotFound.value = false;
      } else if (opts.fallbackUrl) {
        previewImageUrl.value = opts.fallbackUrl;
        previewNotFound.value = false;
      } else {
        previewImageUrl.value = "";
        previewNotFound.value = true;
      }
      previewImageLoading.value = false;
      resetPreviewTransform();
    }
  } catch (error) {
    console.error("Failed to load original image for preview:", error, image);
    if (
      opts.seq !== -1 &&
      previewVisible.value &&
      previewImage.value?.id === image.id &&
      opts.seq === loadSeq.value
    ) {
      if (opts.fallbackUrl) {
        previewImageUrl.value = opts.fallbackUrl;
        previewImageLoading.value = false;
        previewNotFound.value = false;
        resetPreviewTransform();
      } else {
        previewImageLoading.value = false;
        previewImageUrl.value = "";
        previewNotFound.value = true;
      }
    }
  }
}

function prefetchAdjacent() {
  if (!previewVisible.value) return;
  const idx = previewIndex.value;
  if (idx < 0) return;
  const candidates = [idx - 1, idx + 1];
  for (const i of candidates) {
    const img = props.images[i];
    if (!img) continue;
    if (getOriginalUrlFor(img.id)) continue;
    if (!img.localPath) continue;
    // 预取不参与 seq（不应影响当前显示），仅填充缓存
    void ensureOriginalReady(img, { seq: -1 });
  }
}

const open = (index: number) => {
  // 先打开 dialog，再触发 setPreviewByIndex；避免 ensureOriginalReady 在 previewVisible=false 时错过写入 previewImageUrl
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

// Android 全屏预览：展开/关闭透明度动画
.preview-fade-enter-active,
.preview-fade-leave-active {
  transition: opacity 0.2s ease;
}
.preview-fade-enter-from,
.preview-fade-leave-to {
  opacity: 0;
}

// Android 全屏预览样式
.image-preview-fullscreen {
  position: fixed;
  inset: 0;
  z-index: 2000;
  background: rgba(0, 0, 0, 0.85);
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  touch-action: none; // 禁用默认触摸行为

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
