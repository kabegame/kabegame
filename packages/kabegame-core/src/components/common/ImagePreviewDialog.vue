<template>
  <!-- Android 全屏预览：使用 photoswipe-vue 组件，关闭按钮用组件自带的 -->
  <PhotoSwipe v-if="uiStore.isCompact" ref="pswpRef" :open="previewModal.isOpen.value" v-model:index="previewIndex"
    :data-source="pswpDataSource" :loop="false" :z-index="previewFullscreenZIndex" :close-on-vertical-drag="true"
    @update:open="previewModal.close"
    :on-vertical-drag="handlePswpVerticalDrag" :on-before-close="handlePswpBeforeClose" @change="handlePswpChange"
    @close="handlePswpClose" @ui-visible-change="handlePswpUiVisibleChange" @reach-boundary="handlePswpReachBoundary">
	    <!-- 每张幻灯片统一用 PswpSlideContent 渲染（缩略图→原图流式覆盖；视频随控件显隐播放/暂停） -->
	    <template #slide="{ item, active, onReady, onError }">
	      <PswpSlideContent v-if="item && imageById(item.id)" :image="imageById(item.id)!" :active="active"
	        :ui-visible="pswpUiVisible" @ready="onReady" @error="onError" @video-play-fail="handleVideoPlayFail" />
	    </template>
    <!-- 安卓：图片标题居中覆盖显示 -->
    <div v-if="previewImage?.displayName"
      class="pswp-image-title-container">
      <span class="pswp-image-title-text">
        {{ previewImage.displayName }}
      </span>
    </div>
    <!-- ActionSheet 通过 default slot 放入 PswpUI 的 .pswp__hide-on-close 中 -->
    <!-- visible 为true，与ui一起显隐，ui显隐由 photoswipe-vue 组件自动管理 -->
    <ActionRenderer v-if="actions.length > 0" visible :position="previewContextMenuPosition" :actions="actions"
      :context="previewActionContext" mode="actionsheet" :teleport="false" :no-transition="true"
      :zIndex="previewControlZIndex" :modal-back="false" @close="handlePswpActionClose" @command="handlePreviewActionCommand" />
    <!-- 上划删除区域通过 overlay slot 放入 .pswp 根级 -->
    <template #overlay>
      <Transition name="swipe-delete-zone">
        <div v-show="swipeDeleteActive" class="swipe-delete-zone" :class="{ ready: swipeDeleteReady }" :style="{ zIndex: previewOverlayZIndex + 10 }">
          <div class="swipe-delete-zone-content">
            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
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
  <template v-else>
    <el-dialog :model-value="previewModal.isOpen.value" :title="previewDialogTitle" width="90%" :close-on-click-modal="true"
      class="image-preview-dialog" :show-close="true" :lock-scroll="true"
      :z-index="previewFullscreenZIndex" @update:model-value="previewModal.close" @close="closePreview">
      <div v-if="previewModal.isOpen.value" class="preview-desktop-body">
        <div ref="previewContainerRef" class="preview-container" :class="{ 'is-app-fullscreen': isAppFullscreen }"
          @contextmenu.prevent.stop="handlePreviewDialogContextMenu" @mousemove="handlePreviewMouseMove"
          @mouseleave="handlePreviewMouseLeave" @wheel.prevent="handlePreviewWheel">
          <button v-if="!isAppFullscreen" type="button" class="preview-detail-toggle"
            :class="{ visible: previewHoverSide === 'right' || detailDrawerOpen }"
            :title="t('gallery.toggleDetailPanel')" :aria-expanded="detailDrawerOpen" aria-label="toggle detail panel"
            @click.stop="toggleDetailDrawer">
            <svg class="preview-detail-drawer-icon" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg"
              aria-hidden="true">
              <path fill="currentColor"
                d="M176 752a16 16 0 0 0-16 16v64c0 8.832 7.168 16 16 16h672a16 16 0 0 0 16-16v-64a16 16 0 0 0-16-16H176zm240-192a16 16 0 0 0-16 16v64c0 8.832 7.168 16 16 16h432a16 16 0 0 0 16-16V576a16 16 0 0 0-16-16H416zM299.264 395.392a16 16 0 0 0-22.592.064L171.264 501.376a16 16 0 0 0 .064 22.592l105.408 104.896a16 16 0 0 0 27.264-11.328V406.784a16 16 0 0 0-4.736-11.392zM416 368a16 16 0 0 0-16 16v64c0 8.832 7.168 16 16 16h432A16 16 0 0 0 864 448V384a16 16 0 0 0-16-16H416zm-240-192A16 16 0 0 0 160 192v64c0 8.832 7.168 16 16 16h672A16 16 0 0 0 864 256V192a16 16 0 0 0-16-16H176z" />
            </svg>
          </button>
          <button v-if="isAppFullscreen" type="button" class="preview-fullscreen-close"
            :aria-label="t('gallery.exitFullscreen')" @click.stop="toggleAppFullscreen">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M18.3 5.71 12 12l6.3 6.29-1.41 1.41L10.59 13.41 4.3 19.7 2.89 18.29 9.17 12 2.89 5.71 4.3 4.3l6.29 6.29 6.3-6.29z" />
            </svg>
          </button>
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
          <div v-if="previewImage && !isPreviewVideo" ref="panzoomWrapperRef" class="panzoom-wrapper">
            <ImageContent ref="previewContentRef" :image="previewImage" prefer="original"
              @ready="handlePreviewReady" />
          </div>
          <PreviewControlBar
            ref="imageControlBarRef"
            v-if="previewImage && !isPreviewVideo"
            :is-fullscreen="isAppFullscreen"
            :keep-visible="zoomSliderDragging"
          >
            <button class="control-btn" type="button" :aria-label="t('gallery.zoomOut')" @click="panzoomZoomOut">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M5 11h14v2H5z" />
              </svg>
            </button>
            <button class="control-btn" type="button" :aria-label="t('gallery.zoomIn')" @click="panzoomZoomIn">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M19 11h-6V5h-2v6H5v2h6v6h2v-6h6z" />
              </svg>
            </button>
            <div class="zoom-progress-wrap">
              <PreviewRangeSlider
                :model-value="zoomSliderValue"
                :min="100"
                :max="1000"
                :step="1"
                :aria-label="t('gallery.zoomRatio')"
                @drag-start="handleZoomSliderDragStart"
                @update:model-value="handleZoomSliderInput"
                @change="handleZoomSliderCommit"
              />
              <span class="zoom-progress-text">{{ zoomPercentText }}</span>
            </div>
            <button class="control-btn" type="button"
              :aria-label="isAppFullscreen ? t('gallery.exitFullscreen') : t('gallery.fullscreen')"
              @click="toggleAppFullscreen">
              <svg v-if="!isAppFullscreen" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M7 14H5v5h5v-2H7v-3zm0-4h2V7h3V5H5v5zm10 7h-3v2h5v-5h-2v3zm0-12v3h2V5h-5v2h3z" />
              </svg>
              <svg v-else viewBox="0 0 24 24" aria-hidden="true">
                <path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm8 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z" />
              </svg>
            </button>
          </PreviewControlBar>
          <div v-if="previewImage && isPreviewVideo" class="preview-video-wrapper">
            <ImageContent ref="previewContentRef" :image="previewImage" prefer="original"
              video-playing video-loop @ready="handlePreviewReady" />
            <VideoControls :video="previewVideoEl" :show-play-pause="true" :is-fullscreen="isAppFullscreen"
              @toggle-fullscreen="toggleAppFullscreen" />
          </div>
        </div>
        <aside class="preview-detail-drawer" :class="{ 'is-open': detailDrawerOpen }" @click.stop
          @wheel.stop>
          <div class="preview-detail-drawer-scroll">
            <ImageDetailContent
              :image="previewImage"
              :plugins="plugins"
              @open-task="emit('open-task', $event)"
              @open-gallery-filter="handleOpenGalleryFilter"
              @open-surf-record="emit('open-surf-record', $event)"
            />
          </div>
        </aside>
      </div>
    </el-dialog>
    <!-- 桌面端预览内右键：与单张图片相同的上下文菜单（z-index 高于 el-dialog 以免被遮） -->
    <ActionRenderer v-if="actions.length > 0" :visible="previewContextMenu.isOpen.value"
      :position="previewContextMenuPosition" :actions="actions" :context="previewActionContext" mode="contextmenu"
      :z-index="previewContextMenu.zIndex.value" @close="closePreviewContextMenu" @command="handlePreviewActionCommand" />
  </template>

</template>

<script setup lang="ts">
import type { Ref } from "vue";
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { ArrowLeftBold, ArrowRightBold } from "@element-plus/icons-vue";
import { useLocalStorage } from "@vueuse/core";
import { useI18n } from "@kabegame/i18n";
import type { ImageInfo } from "../../types/image";
import ImageContent from "../image/ImageContent.vue";
import PswpSlideContent from "./PswpSlideContent.vue";
import ImageDetailContent, {
  type ImageDetailGalleryFilterTarget,
  type ImageDetailSurfRecordTarget,
} from "./ImageDetailContent.vue";
import PreviewControlBar from "./PreviewControlBar.vue";
import PreviewRangeSlider from "./PreviewRangeSlider.vue";
import VideoControls from "./VideoControls.vue";
import { useUiStore } from "../../stores/ui";
import ActionRenderer from "../ActionRenderer.vue";
import type { ActionItem, ActionContext } from "../../actions/types";
// @ts-expect-error - Vue SFC component import, types resolved via package.json exports
import PhotoSwipe from "photoswipe-vue/vue";
import "photoswipe-vue/photoswipe.css";
import { usePanzoomPreview } from "../../composables/usePanzoomPreview";
import { useAudioKeepAlive } from "../../composables/useAudioKeepAlive";
import { useModal } from "../../composables/useModal";
import { fileToUrl, thumbnailToUrl } from "../../httpServer";
import { isVideoMediaType } from "../../utils/mediaMime";
import { Plugin } from "@kabegame/core/stores/plugins";

const { t } = useI18n();
const uiStore = useUiStore();
const previewModal = useModal({ layers: 3 });
const previewContextMenu = useModal();
const previewFullscreenZIndex = computed(() => previewModal.zIndex.value);
const previewOverlayZIndex = computed(() => previewModal.zIndex.value + 10);
const previewControlZIndex = computed(() => previewModal.zIndex.value + 20);
const previewHidesKamechanClass = "image-preview-hides-kamechan";

const props = withDefaults(defineProps<{
  images: ImageInfo[];
  /** Actions for context menu / action sheet. */
  actions?: ActionItem<ImageInfo>[];
  /** 用于预览内详情抽屉解析插件名（与 ImageDetailDialog 一致） */
  plugins?: Array<Plugin>;
}>(), {
  actions: () => [],
  plugins: () => [],
});

/** 桌面端预览内详情侧栏开关（localStorage，与 mergeDefaults 容错非法值） */
const detailDrawerOpen = useLocalStorage("kabegame-preview-detail-open", false, {
  mergeDefaults: true,
});

const emit = defineEmits<{
  (e: "contextCommand", payload: { command: string; image: ImageInfo }): void;
  (e: "open-task", taskId: string): void;
  (e: "open-gallery-filter", target: ImageDetailGalleryFilterTarget): void;
  (e: "open-surf-record", target: ImageDetailSurfRecordTarget): void;
  (e: "preview-navigate", payload: PreviewNavigatePayload): void;
  (e: "preview-page-boundary", payload: PreviewPageBoundaryPayload): void;
  (e: "preview-detail-toggle", payload: { open: boolean; image: ImageInfo | null }): void;
  (e: "preview-close", payload: { image: ImageInfo | null }): void;
}>();

type PreviewNavigatePayload = {
  direction: "prev" | "next";
  fromIndex: number;
  toIndex: number;
  wrapped: boolean;
  image: ImageInfo;
};

type PreviewPageBoundaryPayload = {
  direction: "prev" | "next";
  index: number;
  image: ImageInfo;
};

const previewVisible = previewModal.isOpen;
const previewImageUrl = ref("");
const previewImagePath = ref("");
const previewIndex = ref<number>(-1);
const currentImageId = ref<string | null>(null);
/** 紧凑模式（Android/web 窄屏）：PhotoSwipe 使用的索引列表，映射回 props.images 原始索引。 */
const androidFilteredIndices = computed(() =>
  props.images.map((_, i) => i),
);

// previewImage 改为 computed，确保始终反映 props.images 的最新数据（如收藏状态变化）
const previewImage = computed<ImageInfo | null>(() => {
  const idx = previewIndex.value;
  if (idx < 0) return null;
  if (uiStore.isCompact) {
    const origIdx = androidFilteredIndices.value[idx];
    if (origIdx == null || origIdx >= props.images.length) return null;
    return props.images[origIdx] ?? null;
  }
  if (idx >= props.images.length) return null;
  return props.images[idx] ?? null;
});
const isPreviewVideo = computed(() => isVideoMediaType(previewImage.value?.type));

// 桌面预览视频期间保持音频输出设备常驻，避免暂停后恢复播放漏掉开头声音
const audioKeepAlive = useAudioKeepAlive();
const desktopVideoActive = computed(
  () => !uiStore.isCompact && previewVisible.value && isPreviewVideo.value
);
watch(desktopVideoActive, (active) => {
  if (active) audioKeepAlive.start();
  else audioKeepAlive.stop();
});
const previewHoverSide = ref<"left" | "right" | null>(null);
const previewNotFound = ref(false);
const isAppFullscreen = ref(false);
const previewShouldHideKamechan = computed(() =>
  uiStore.isCompact ? previewVisible.value : isAppFullscreen.value
);

const previewContainerRef = ref<HTMLElement | null>(null);
const previewContentRef = ref<InstanceType<typeof ImageContent> | null>(null);
/** 桌面预览视频：从 ImageContent 暴露的 videoEl 取，供 VideoControls 绑定 */
const previewVideoEl = computed<HTMLVideoElement | null>(() => previewContentRef.value?.videoEl ?? null);
/** 紧凑模式 PhotoSwipe slot：用 item.id 反查 props.images */
const imageById = (id: string | number | undefined): ImageInfo | null =>
  props.images.find((img) => img.id === id) ?? null;
const imageControlBarRef = ref<InstanceType<typeof PreviewControlBar> | null>(null);
const pswpRef = ref<InstanceType<typeof PhotoSwipe> | null>(null);
// Panzoom 由 usePanzoomPreview 提供，在 notifyPreviewInteracting / markPreviewInteracting 定义后初始化
let panzoomWrapperRef!: Ref<HTMLElement | null>;
let handlePanzoomWheel!: (event: WheelEvent) => void;
let panzoomReset!: () => void;
let panzoomDestroy!: () => void;
let panzoomZoomIn!: () => void;
let panzoomZoomOut!: () => void;
let panzoomZoomTo!: (scale: number, animate?: boolean) => void;
let panzoomScale!: Ref<number>;
// Android 上划删除相关状态
const swipeDeleteActive = ref(false);
const swipeDeleteReady = ref(false);
let isFromVerticalDrag = false;
let verticalDragResetTimer: ReturnType<typeof setTimeout> | null = null;
// 缓存 container 的 rect，避免 mousemove/wheel 高频触发时反复 getBoundingClientRect() 导致强制布局与掉帧
const previewContainerRect = ref({ left: 0, top: 0, width: 0, height: 0 });
// previewDragging、previewDragStart、previewDragStartTranslate 已删除，由 Panzoom 替代（仅桌面端）
const previewImageLoading = ref(false);
const previewContextMenuVisible = previewContextMenu.isOpen;
const previewContextMenuPosition = ref({ x: 0, y: 0 });
const zoomSliderDragging = ref(false);

// Android 触摸手势状态

// Android PSWP UI 可见性（ActionSheet 随 PSWP UI 自动显隐，无需手动控制）
const pswpUiVisible = ref(false);
let longPressTimer: ReturnType<typeof setTimeout> | null = null;


const normalizeDesktopPath = (path: string | undefined) =>
  (path || "").trimStart().replace(/^\\\\\?\\/, "").trim();

const toFileUrl = (path: string | undefined) => {
  const normalized = normalizeDesktopPath(path);
  if (!normalized) return "";
  return fileToUrl(normalized);
};

const getOriginalPreviewUrl = (image: ImageInfo) =>
  toFileUrl(image.localPath);

const getThumbnailPreviewUrl = (image: ImageInfo) => {
  const thumbPath = image.thumbnailPath;
  const normalized = normalizeDesktopPath(thumbPath);
  return normalized ? thumbnailToUrl(normalized) : getOriginalPreviewUrl(image);
};

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
  scale: panzoomScale,
  handleWheel: handlePanzoomWheel,
  reset: panzoomReset,
  destroy: panzoomDestroy,
  zoomIn: panzoomZoomIn,
  zoomOut: panzoomZoomOut,
  zoomTo: panzoomZoomTo,
} = usePanzoomPreview(
  previewVisible,
  computed(() => !uiStore.isCompact),
  {
    onPanzoomStart: () => notifyPreviewInteracting(true),
    onPanzoomEnd: markPreviewInteracting,
  }
));

const zoomPercent = computed(() => Math.round((panzoomScale?.value ?? 1) * 100));
const zoomPercentText = computed(() => `${zoomPercent.value}%`);
const zoomSliderValue = computed(() => Math.min(1000, Math.max(100, zoomPercent.value)));

const handleZoomSliderDragStart = () => {
  zoomSliderDragging.value = true;
  notifyPreviewInteracting(true);
};

const handleZoomSliderInput = (value: number) => {
  zoomSliderDragging.value = true;
  panzoomZoomTo(value / 100);
  markPreviewInteracting();
};

const handleZoomSliderCommit = (value: number) => {
  panzoomZoomTo(value / 100);
  zoomSliderDragging.value = false;
  markPreviewInteracting();
};

const handleDocumentZoomPointerUp = () => {
  if (!zoomSliderDragging.value) return;
  zoomSliderDragging.value = false;
  markPreviewInteracting();
};

/** 切换详情抽屉并重置 Panzoom，使图片按新容器尺寸适配（含抽屉动画结束后再对齐一次） */
const toggleDetailDrawer = () => {
  detailDrawerOpen.value = !detailDrawerOpen.value;
  emit("preview-detail-toggle", {
    open: detailDrawerOpen.value,
    image: previewImage.value,
  });
  panzoomReset();
  void nextTick(() => {
    requestAnimationFrame(() => {
      panzoomReset();
    });
    window.setTimeout(() => {
      panzoomReset();
    }, 240);
  });
};

const handleOpenGalleryFilter = (target: ImageDetailGalleryFilterTarget) => {
  // 不在此处关闭预览：交由处理 open-gallery-filter 的上层在导航完成后再关闭
  // （仅当为 gallery 内部导航时）。提前关闭会让 previewedId/pvwimgid 的写入与
  // 上层的 push 导航在同一 tick 竞争，导致 filter 路径被旧 URL 覆盖。
  emit("open-gallery-filter", target);
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
  }
};

const measureContainerAfterRender = async () => {
  await nextTick();
  await new Promise((resolve) => requestAnimationFrame(resolve));
  measureContainerSize();
};

const toggleAppFullscreen = (event?: MouseEvent) => {
  isAppFullscreen.value = !isAppFullscreen.value;
  void nextTick(() => {
    requestAnimationFrame(() => {
      measureContainerSize();
      panzoomReset();
      imageControlBarRef.value?.refreshPointerPosition(event);
    });
  });
};

const syncKamechanVisibilityForPreview = (hidden: boolean) => {
  if (typeof document === "undefined") return;
  document.body.classList.toggle(previewHidesKamechanClass, hidden);
};

const previewDialogTitle = computed(() => {
  const img = previewImage.value;
  if (img?.displayName) return img.displayName;
  if (!img?.localPath) {
    return "图片预览";
  }
  // 从路径中提取文件名（支持 Windows 和 Unix 路径分隔符）
  const path = img.localPath;
  const fileName = path.split(/[/\\]/).pop() || path;
  return fileName || "图片预览";
});

const isTextInputLike = (target: EventTarget | null) => {
  const el = target as HTMLElement | null;
  const tag = el?.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || !!el?.isContentEditable;
};

/** 紧凑模式 PhotoSwipe：根据当前 images 构建 dataSource 数组（只读 URL）。 */
const pswpDataSource = computed(() => {
  const fallbackW = 1920;
  const fallbackH = 1080;
  const source = uiStore.isCompact
    ? androidFilteredIndices.value.map((idx) => props.images[idx]).filter(Boolean)
    : props.images;
  const items = source.map((img) => {
    const url = getOriginalPreviewUrl(img) || getThumbnailPreviewUrl(img) || "";
    const isVideo = isVideoMediaType(img.type);
    return {
      src: url,
      type: isVideo ? "video" : "image",
      mime: isVideo && img.type?.startsWith("video/") ? img.type : undefined,
      poster: isVideo ? getThumbnailPreviewUrl(img) : undefined,
      controls: isVideo ? true : undefined,
      playsInline: isVideo ? true : undefined,
      width: img.width || fallbackW,
      height: img.height || fallbackH,
      id: img.id,
    };
  });
  return items;
});

const setPreviewByIndex = (
  index: number,
  opts?: { resetPanzoom?: boolean }
) => {
  const img = props.images[index];
  if (!img) return;

  const resetPanzoom = opts?.resetPanzoom !== false;

  previewIndex.value = index;
  currentImageId.value = img.id;
  previewImagePath.value = img.localPath;
  // previewImage 现在是 computed，无需手动赋值
  previewNotFound.value = false;

  const thumb = getThumbnailPreviewUrl(img);
  const originalUrl = getOriginalPreviewUrl(img);

  previewNotFound.value = false;
  previewImageLoading.value = false;
  previewImageUrl.value = (originalUrl || thumb || "").trim();

  // 尺寸/缩放状态重置：切换图片时重置；仅列表重排（如同 id 的索引变化）时可保留 Panzoom
  if (!isPreviewVideo.value && resetPanzoom) {
    panzoomReset();
  }
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
  const originalUrl = getOriginalPreviewUrl(img);
  if (originalUrl) return originalUrl;

  return getThumbnailPreviewUrl(img);
};


// Pager offset（用于滑动切换动画）
const pagerOffset = ref(0);
const pagerSettling = ref(false);

// 切换节流：100ms 内最多只执行一次切换，避免快速连击导致状态混乱
let navThrottleTimer: ReturnType<typeof setTimeout> | null = null;
let isNavThrottled = false;
const NAV_THROTTLE_MS = 100;

const startNavThrottle = () => {
  isNavThrottled = true;
  if (navThrottleTimer) clearTimeout(navThrottleTimer);
  navThrottleTimer = setTimeout(() => {
    navThrottleTimer = null;
    isNavThrottled = false;
  }, NAV_THROTTLE_MS);
};

const emitPreviewNavigate = (
  direction: "prev" | "next",
  fromIndex: number,
  toIndex: number,
  wrapped: boolean,
  image: ImageInfo | undefined
) => {
  if (!image) return;
  emit("preview-navigate", {
    direction,
    fromIndex,
    toIndex,
    wrapped,
    image,
  });
};

const getOriginalIndexForPreviewIndex = (index: number) => {
  if (!uiStore.isCompact) return index;
  return androidFilteredIndices.value[index] ?? -1;
};

const emitPreviewPageBoundary = (
  direction: "prev" | "next",
  previewListIndex = previewIndex.value
) => {
  const origIndex = getOriginalIndexForPreviewIndex(previewListIndex);
  const image = origIndex >= 0 ? props.images[origIndex] : undefined;
  if (!image) return;
  emit("preview-page-boundary", {
    direction,
    index: origIndex,
    image,
  });
};

const navigateWithPreloadGate = (targetIndex: number) => {
  if (!previewVisible.value) return;
  setPreviewByIndex(targetIndex);
};

const goPrev = () => {
  if (!previewVisible.value) return;
  if (isNavThrottled) return;
  const idx = previewIndex.value >= 0 ? previewIndex.value : 0;
  if (idx <= 0) {
    startNavThrottle();
    emitPreviewPageBoundary("prev", idx);
    return;
  }
  const targetIndex = idx - 1;

  startNavThrottle();

  navigateWithPreloadGate(targetIndex);
  emitPreviewNavigate("prev", idx, targetIndex, false, props.images[targetIndex]);
};

const goNext = () => {
  if (!previewVisible.value) return;
  if (isNavThrottled) return;
  const lastIndex = props.images.length - 1;
  const idx = previewIndex.value >= 0 ? previewIndex.value : 0;
  if (idx >= lastIndex) {
    startNavThrottle();
    emitPreviewPageBoundary("next", idx);
    return;
  }
  const targetIndex = idx + 1;

  startNavThrottle();

  navigateWithPreloadGate(targetIndex);
  emitPreviewNavigate("next", idx, targetIndex, false, props.images[targetIndex]);
};

const handlePreviewDialogContextMenu = (event: MouseEvent) => {
  if (!previewImage.value) return;
  if (!props.actions?.length) return;
  previewContextMenuPosition.value = { x: event.clientX, y: event.clientY };
  previewContextMenu.open();
};

const closePreviewContextMenu = () => {
  previewContextMenu.close();
};

const previewActionContext = computed<ActionContext<ImageInfo>>(() => ({
  target: previewImage.value,
  selectedIds: previewImage.value ? new Set([previewImage.value.id]) : new Set<string>(),
  selectedCount: previewImage.value ? 1 : 0,
}));

const handlePswpActionClose = () => {
  if (uiStore.isCompact) {
    // 关闭 ActionSheet 时隐藏 PSWP UI（使用 setUiVisible 避免 toggle 语义歧义）
    pswpRef.value?.setUiVisible(false);
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
  if (uiStore.isCompact) {
    // 紧凑模式（PhotoSwipe）：hide PSWP UI after command
    // ActionSheet 的 handleClick 会同时 emit command 和 close，所以这里不需要再调用 setUiVisible
    // close 事件会通过 handlePswpActionClose 处理 UI 隐藏
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

const handlePreviewWheel = (event: WheelEvent) => {
  if (isPreviewVideo.value) return;
  handlePanzoomWheel(event);
};

// stopPreviewDrag 已删除，由 Panzoom 自动处理（仅桌面端）

// Android 触摸手势处理


// ImageContent 内部已处理缩略图→原图流式覆盖与丢失态显示；这里只在内容就绪后对齐 Panzoom（桌面图片）。
const handlePreviewReady = () => {
  previewImageLoading.value = false;
  if (uiStore.isCompact || isPreviewVideo.value) return;
  void measureContainerAfterRender().then(() => {
    panzoomReset();
  });
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
  // Backspace：隐藏当前预览图片；Delete：删除当前预览图片
  if ((event.key === "Delete" || event.key === "Backspace") && previewImage.value) {
    event.preventDefault();
    event.stopPropagation();
    if ("stopImmediatePropagation" in event) {
      (event as any).stopImmediatePropagation();
    }
    emit("contextCommand", {
      command: event.key === "Backspace" ? "addToHidden" : "remove",
      image: previewImage.value,
    });
    return;
  }
};

/** 紧凑模式预览关闭后的清理（不调用 pswp.close），避免 destroy 时重复关闭且确保遮罩移除 */
function doAndroidPreviewCleanup() {
  if (!uiStore.isCompact) return;
  previewModal.close();
  pswpUiVisible.value = false;
  if (longPressTimer) {
    clearTimeout(longPressTimer);
    longPressTimer = null;
  }
  closePreviewContextMenu();
}

const closePreview = () => {
  const closedImage = previewImage.value;
  isAppFullscreen.value = false;
  if (uiStore.isCompact) {
    previewModal.close();
    doAndroidPreviewCleanup();
    previewIndex.value = -1;
    emit("preview-close", { image: closedImage });
    return;
  }
  previewModal.close();
  previewImageUrl.value = "";
  previewImagePath.value = "";
  previewIndex.value = -1;
  // previewImage 现在是 computed，设置 previewIndex = -1 即可
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
  emit("preview-close", { image: closedImage });
};

const performSwipeDelete = () => {
  if (!previewImage.value) return;
  emit("contextCommand", { command: "swipe-remove", image: previewImage.value });
};

// handlePreviewImageDeleted 已被删除，逻辑合并到下方的 props.images watcher 中

watch(
  () => props.images,
  () => {
    if (!previewVisible.value) return;
    if (!currentImageId.value) return;

    const foundIndex = props.images.findIndex((img) => img.id === currentImageId.value);

    if (foundIndex !== -1) {
      if (uiStore.isCompact) {
        const pswpIdx = androidFilteredIndices.value.indexOf(foundIndex);
        if (pswpIdx >= 0 && pswpIdx !== previewIndex.value) {
          previewIndex.value = pswpIdx;
        }
      } else {
        if (foundIndex !== previewIndex.value) {
          // 前面插入项等导致索引右移：仍是同一张图，勿重置桌面端放缩/平移
          setPreviewByIndex(foundIndex, { resetPanzoom: false });
        }
      }
    } else {
      if (props.images.length === 0) {
        closePreview();
      } else if (uiStore.isCompact) {
        const filteredLen = androidFilteredIndices.value.length;
        if (filteredLen <= previewIndex.value) {
          const newPswpIdx = Math.max(0, filteredLen - 1);
          previewIndex.value = newPswpIdx;
          const origIdx = androidFilteredIndices.value[newPswpIdx];
          currentImageId.value = origIdx != null ? props.images[origIdx]?.id ?? null : null;
        } else {
          const origIdx = androidFilteredIndices.value[previewIndex.value];
          currentImageId.value = origIdx != null ? props.images[origIdx]?.id ?? null : null;
        }
      } else {
        if (props.images.length <= previewIndex.value) {
          const newIndex = props.images.length - 1;
          previewIndex.value = newIndex;
          setPreviewByIndex(newIndex);
        } else {
          setPreviewByIndex(previewIndex.value);
        }
      }
    }
  }
);

watch(
  () => previewVisible.value,
  async (visible) => {
    if (visible && !uiStore.isCompact) {
      await nextTick();
      await measureContainerAfterRender();
    }
  }
);

watch(
  () => previewImage.value?.id,
  (id) => {
    if (id && !uiStore.isCompact) {
      if (isPreviewVideo.value) return;
      panzoomReset();
    }
  }
);

// 桌面端：预览区尺寸变化（抽屉、窗口缩放）时更新缓存 rect 并重置 Panzoom，使图片与容器对齐
let resizeObserver: ResizeObserver | null = null;

const setupResizeObserver = () => {
  if (resizeObserver) {
    resizeObserver.disconnect();
  }
  const container = previewContainerRef.value;
  if (!container) return;
  resizeObserver = new ResizeObserver(() => {
    if (!previewVisible.value) return;
    measureContainerSize();
    panzoomReset();
  });
  resizeObserver.observe(container);
};

// Android PhotoSwipe 事件处理
// 跟踪初始 panY 值（slide 中心位置），用于判断方向
let initialPanY: number | null = null;
const handlePswpVerticalDrag = ({ panY, preventDefault }: { panY: number; preventDefault: () => void }) => {
  if (initialPanY === null) {
    initialPanY = panY;
  }

  const offset = panY - initialPanY;
  const viewportHeight = window.innerHeight;
  const ratio = offset / (viewportHeight / 3);

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
    swipeDeleteActive.value = true;
    const absRatio = Math.abs(ratio);
    swipeDeleteReady.value = absRatio >= 0.4;
    isFromVerticalDrag = true;

    verticalDragResetTimer = setTimeout(() => {
      isFromVerticalDrag = false;
      swipeDeleteActive.value = false;
      swipeDeleteReady.value = false;
      verticalDragResetTimer = null;
    }, 300);
  }
};

// 重置初始 panY：关闭预览时见下方 watch；左右切换时见 handlePswpChange；上划删除成功后见 handlePswpBeforeClose
watch(() => previewVisible.value, (visible) => {
  if (!visible) {
    initialPanY = null;
  }
});

watch(previewShouldHideKamechan, syncKamechanVisibilityForPreview, { immediate: true });

const handlePswpBeforeClose = (source?: string): boolean => {
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
        performSwipeDelete();
        pswpRef.value?.recoverFromVerticalDrag?.();
        initialPanY = null;
      }
      return false;
    }
  }
  return true;
};

const handlePswpChange = ({ index }: { index: number }) => {
  if (index < 0) return;
  if (uiStore.isCompact) {
    const previousOrigIdx = currentImageId.value
      ? props.images.findIndex((img) => img.id === currentImageId.value)
      : -1;
    const previousFilteredIdx = previousOrigIdx >= 0
      ? androidFilteredIndices.value.indexOf(previousOrigIdx)
      : -1;
    const origIdx = androidFilteredIndices.value[index];
    if (origIdx == null || origIdx >= props.images.length) return;
    initialPanY = null;
    if (verticalDragResetTimer) {
      clearTimeout(verticalDragResetTimer);
      verticalDragResetTimer = null;
    }
    swipeDeleteActive.value = false;
    swipeDeleteReady.value = false;
    isFromVerticalDrag = false;
    previewIndex.value = index;
    const img = props.images[origIdx];
    if (img) currentImageId.value = img.id;
    if (img && previousOrigIdx >= 0 && previousOrigIdx !== origIdx) {
      const direction = index > previousFilteredIdx ? "next" : "prev";
      emitPreviewNavigate(direction, previousOrigIdx, origIdx, false, img);
    }
  } else {
    if (index >= props.images.length) return;
    previewIndex.value = index;
    const img = props.images[index];
    if (img) currentImageId.value = img.id;
  }
};

const handlePswpReachBoundary = ({ direction, index }: { direction: "prev" | "next"; index: number }) => {
  if (!uiStore.isCompact) return;
  emitPreviewPageBoundary(direction, index);
};

/** 紧凑模式切换控件（点击显示顶部栏）时，更新 UI 可见性状态 */
const handlePswpUiVisibleChange = ({ visible }: { visible: boolean }) => {
  if (uiStore.isCompact) {
    pswpUiVisible.value = visible;
  }
};

const handleVideoPlayFail = () => {
  if (!uiStore.isCompact) return;
  pswpRef.value?.setUiVisible(true);
};

const handlePswpClose = () => {
  const closedImage = previewImage.value;
  doAndroidPreviewCleanup();
  previewIndex.value = -1;
  swipeDeleteActive.value = false;
  swipeDeleteReady.value = false;
  isFromVerticalDrag = false;
  if (verticalDragResetTimer) {
    clearTimeout(verticalDragResetTimer);
    verticalDragResetTimer = null;
  }
  emit("preview-close", { image: closedImage });
};

onMounted(() => {
  window.addEventListener("keydown", handlePreviewKeyDown, true);
  document.addEventListener("mouseup", handleDocumentZoomPointerUp);
  document.addEventListener("touchend", handleDocumentZoomPointerUp, { passive: true });
});

onUnmounted(() => {
  window.removeEventListener("keydown", handlePreviewKeyDown, true);
  document.removeEventListener("mouseup", handleDocumentZoomPointerUp);
  document.removeEventListener("touchend", handleDocumentZoomPointerUp);
  syncKamechanVisibilityForPreview(false);
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

if (!uiStore.isCompact) {
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
  if (uiStore.isCompact) {
    console.log('open preview');
    const img = props.images[index];
    const pswpIndex = androidFilteredIndices.value.indexOf(index);
    if (pswpIndex < 0) return;
    previewIndex.value = pswpIndex;
    if (img) {
      currentImageId.value = img.id;
    }
    previewModal.open();
    pswpUiVisible.value = false;
    return;
  }
  // 桌面端：先打开 dialog，再触发 setPreviewByIndex
  previewModal.open();
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
body.image-preview-hides-kamechan .kamechan-host {
  display: none !important;
}

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
    flex-direction: column !important;
    justify-content: stretch !important;
    align-items: stretch !important;
    overflow: hidden !important;
    min-height: 0 !important;
    height: calc(90vh - 50px) !important;
  }

  .preview-desktop-body {
    display: flex;
    flex-direction: row;
    flex: 1 1 auto;
    min-height: 0;
    min-width: 0;
    width: 100%;
    height: 100%;
    align-items: stretch;
  }

  .preview-container {
    flex: 1 1 auto;
    min-width: 0;
    width: 100%;
    height: 100%;
    display: flex;
    justify-content: center;
    align-items: center;
    overflow: hidden;
    box-sizing: border-box;
    position: relative;

    &.is-app-fullscreen {
      position: fixed;
      inset: 0;
      z-index: v-bind(previewFullscreenZIndex);
      background: #000;
    }
  }

  .preview-detail-toggle,
  .preview-fullscreen-close {
    position: absolute;
    top: 12px;
    right: 12px;
    z-index: 4;
    width: 40px;
    height: 40px;
    border-radius: 999px;
    border: none;
    background: rgba(0, 0, 0, 0.38);
    color: #fff;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    box-shadow: 0 6px 16px rgba(0, 0, 0, 0.2);
    opacity: 0;
    pointer-events: none;
    transition:
      opacity 0.12s ease,
      background 0.15s ease,
      transform 0.12s ease;

    &.visible {
      opacity: 0.5;
      pointer-events: auto;
    }

    &.visible:hover {
      opacity: 1;
      background: rgba(0, 0, 0, 0.52);
      transform: scale(1.04);
    }

    .preview-detail-drawer-icon {
      width: 18px;
      height: 18px;
      flex-shrink: 0;
      display: block;
    }

    svg {
      width: 18px;
      height: 18px;
      fill: currentColor;
    }
  }

  .preview-fullscreen-close {
    opacity: 0.72;
    pointer-events: auto;

    &:hover {
      opacity: 1;
      background: rgba(0, 0, 0, 0.52);
      transform: scale(1.04);
    }
  }

  .preview-detail-drawer {
    flex: 0 0 0;
    width: 0;
    min-width: 0;
    max-width: 320px;
    overflow: hidden;
    box-sizing: border-box;
    border-left: 1px solid transparent;
    background: var(--anime-bg-card, rgba(255, 255, 255, 0.96));
    opacity: 0;
    transition:
      flex-basis 0.22s ease,
      width 0.22s ease,
      min-width 0.22s ease,
      opacity 0.18s ease,
      border-color 0.18s ease;

    &.is-open {
      flex: 0 0 320px;
      min-width: 30%;
      opacity: 1;
      border-left-color: var(--anime-border, rgba(0, 0, 0, 0.12));
    }
  }

  .preview-detail-drawer-scroll {
    height: 100%;
    overflow-x: hidden;
    overflow-y: auto;
    padding: 12px 14px 16px;
    box-sizing: border-box;
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

  .preview-video-wrapper {
    width: 100%;
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    position: relative;
    overflow: hidden;
  }

  .preview-video {
    width: 100%;
    height: 100%;
    max-width: 100% !important;
    max-height: 100% !important;
    object-fit: contain;
    display: block;
  }

  .zoom-progress-wrap {
    flex: 1;
    min-width: 120px;
    display: flex;
    align-items: center;
    gap: 10px;
    user-select: none;
  }

  .zoom-progress-text {
    width: 44px;
    font-size: 12px;
    line-height: 1;
    text-align: right;
    color: rgba(255, 255, 255, 0.92);
    font-variant-numeric: tabular-nums;
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

// Android 上划删除警告区域（z-index 需在 photoswipe-vue 根层之上）
.swipe-delete-zone {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
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
  z-index: v-bind(previewFullscreenZIndex);
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

.pswp-image-title-container {
  color: var(--anime-secondary-light);
  width: 100%;
  align-items: center;
  justify-content: center;
  display: flex;
  height: 100%;
  position: absolute;
  inset: 0;
  pointer-events: none;
  text-align: center;
}

.pswp-image-title-text {
  width: 60%;
  overflow: hidden;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
  line-clamp: 3;
  overflow-wrap: anywhere;
  text-overflow: ellipsis;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);
}
</style>
