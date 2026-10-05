<template>
  <!-- Android 全屏预览：使用 photoswipe-vue 组件，关闭按钮用组件自带的 -->
  <PhotoSwipe
    v-if="uiStore.isCompact"
    ref="pswpRef"
    :open="previewModal.isOpen.value"
    :index="pswpCommandIndex"
    :data-source="pswpDataSource"
    :loop="false"
    :z-index="previewFullscreenZIndex"
    :close-on-vertical-drag="true"
    @update:open="previewModal.close"
    :on-vertical-drag="handlePswpVerticalDrag"
    :on-before-close="handlePswpBeforeClose"
    @change="handlePswpChange"
    @close="handlePswpClose"
    @reach-boundary="handlePswpReachBoundary"
    @video-double-tap="handleVideoDoubleTap"
  >
    <!-- 每张幻灯片统一用 PswpSlideContent 渲染（缩略图→原图流式覆盖；视频双击切换播放/暂停，与控件显隐无关） -->
    <template #slide="{ item, active, onReady, onError }">
      <PswpSlideContent
        v-if="item && imageById(item.id)"
        :image="imageById(item.id)!"
        :active="active"
        :paused="videoPaused"
        @ready="onReady"
        @error="onError"
        @video-play-fail="handleVideoPlayFail"
      />
    </template>
    <!-- 安卓：图片标题居中覆盖显示 -->
    <div v-if="previewImage?.displayName" class="pswp-image-title-container">
      <span class="pswp-image-title-text">
        {{ previewImage.displayName }}
      </span>
    </div>
    <!-- ActionSheet 通过 default slot 放入 PswpUI 的 .pswp__hide-on-close 中 -->
    <!-- visible 为true，与ui一起显隐，ui显隐由 photoswipe-vue 组件自动管理 -->
    <ActionRenderer
      v-if="actions.length > 0"
      visible
      :position="previewContextMenuPosition"
      :actions="actions"
      :context="previewActionContext"
      mode="actionsheet"
      :teleport="false"
      :no-transition="true"
      :zIndex="previewControlZIndex"
      :modal-back="false"
      @close="handlePswpActionClose"
      @command="handlePreviewActionCommand"
    />
    <!-- 上划删除区域通过 overlay slot 放入 .pswp 根级 -->
    <template #overlay>
      <Transition name="swipe-delete-zone">
        <div
          v-show="swipeDeleteActive"
          class="swipe-delete-zone"
          :class="{ ready: swipeDeleteReady }"
          :style="{ zIndex: previewOverlayZIndex + 10 }"
        >
          <div class="swipe-delete-zone-content">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M3 6h18M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
              <line x1="10" y1="11" x2="10" y2="17" />
              <line x1="14" y1="11" x2="14" y2="17" />
            </svg>
            <span>{{ swipeDeleteReady ? "释放删除" : "上划删除" }}</span>
          </div>
        </div>
      </Transition>
    </template>
  </PhotoSwipe>

  <!-- 桌面端 Dialog 预览 -->
  <template v-else>
    <el-dialog
      :model-value="previewModal.isOpen.value"
      :title="previewDialogTitle"
      width="90%"
      :close-on-click-modal="true"
      class="image-preview-dialog"
      :show-close="true"
      :lock-scroll="true"
      :z-index="previewFullscreenZIndex"
      @update:model-value="previewModal.close"
      @close="closePreview"
    >
      <div
        v-if="previewModal.isOpen.value"
        class="preview-desktop-body"
        :class="{ 'is-app-fullscreen': isAppFullscreen }"
      >
        <KbResizable
          v-model="detailDrawerLeftWidth"
          tag="aside"
          side="right"
          class="kb-side-pane preview-detail-drawer preview-detail-drawer-left"
          :class="{ 'is-open': detailDrawerLeftOpen }"
          :default-size="PREVIEW_DRAWER_DEFAULT_WIDTH"
          :handle-title="t('gallery.toggleImageInfoPanel')"
          @resize-start="handleDrawerResizeStart('left')"
          @resize-end="handleDrawerResizeEnd"
          @click.stop
          @wheel.stop
        >
          <!-- 面板自带折叠外壳：展开的 flex:1 争夺侧栏空间，收拢的只占标题行 -->
          <div class="preview-detail-drawer-scroll preview-detail-drawer-scroll-left">
            <ImageBasicInfoPanel
              :image="previewImage"
              :plugins="plugins"
              fill-when-expanded
              @open-task="emit('open-task', $event)"
              @open-gallery-filter="handleOpenGalleryFilter"
              @open-surf-record="emit('open-surf-record', $event)"
            />
            <!-- 标签面板：点标签跳画册页后要顺手关掉预览，故把本地 closePreview 接到 navigate 上 -->
            <ImageLabelsPanel v-if="previewImage" :image="previewImage" @navigate="closePreview" />
            <ImageNativeMetadataPanel
              v-if="isNativeMetadataEligible(previewImage?.type)"
              :image="previewImage"
              fill-when-expanded
            />
          </div>
        </KbResizable>
        <div
          ref="previewContainerRef"
          class="preview-container"
          :class="{ 'is-app-fullscreen': isAppFullscreen }"
          :style="isAppFullscreen ? { zIndex: previewFullscreenZIndex } : undefined"
          @contextmenu.prevent.stop="handlePreviewDialogContextMenu"
          @mousemove="handlePreviewMouseMove"
          @mouseleave="handlePreviewMouseLeave"
          @wheel.prevent="handlePreviewWheel"
        >
          <button
            v-if="!isAppFullscreen"
            type="button"
            class="preview-detail-toggle preview-detail-toggle-left"
            :class="{ visible: previewHoverSide === 'left' || detailDrawerLeftOpen }"
            :title="t('gallery.toggleImageInfoPanel')"
            :aria-expanded="detailDrawerLeftOpen"
            :aria-label="t('gallery.toggleImageInfoPanel')"
            @click.stop="toggleDetailDrawerLeft"
          >
            <svg
              class="preview-detail-drawer-icon"
              viewBox="0 0 1024 1024"
              xmlns="http://www.w3.org/2000/svg"
              aria-hidden="true"
            >
              <path
                fill="currentColor"
                d="M176 752a16 16 0 0 0-16 16v64c0 8.832 7.168 16 16 16h672a16 16 0 0 0 16-16v-64a16 16 0 0 0-16-16H176zm240-192a16 16 0 0 0-16 16v64c0 8.832 7.168 16 16 16h432a16 16 0 0 0 16-16V576a16 16 0 0 0-16-16H416zM299.264 395.392a16 16 0 0 0-22.592.064L171.264 501.376a16 16 0 0 0 .064 22.592l105.408 104.896a16 16 0 0 0 27.264-11.328V406.784a16 16 0 0 0-4.736-11.392zM416 368a16 16 0 0 0-16 16v64c0 8.832 7.168 16 16 16h432A16 16 0 0 0 864 448V384a16 16 0 0 0-16-16H416zm-240-192A16 16 0 0 0 160 192v64c0 8.832 7.168 16 16 16h672A16 16 0 0 0 864 256V192a16 16 0 0 0-16-16H176z"
              />
            </svg>
          </button>
          <button
            v-if="!isAppFullscreen"
            type="button"
            class="preview-detail-toggle"
            :class="{ visible: previewHoverSide === 'right' || detailDrawerOpen }"
            :title="t('gallery.toggleDetailPanel')"
            :aria-expanded="detailDrawerOpen"
            :aria-label="t('gallery.toggleDetailPanel')"
            @click.stop="toggleDetailDrawer"
          >
            <svg
              class="preview-detail-drawer-icon"
              viewBox="0 0 1024 1024"
              xmlns="http://www.w3.org/2000/svg"
              aria-hidden="true"
            >
              <path
                fill="currentColor"
                d="M176 752a16 16 0 0 0-16 16v64c0 8.832 7.168 16 16 16h672a16 16 0 0 0 16-16v-64a16 16 0 0 0-16-16H176zm240-192a16 16 0 0 0-16 16v64c0 8.832 7.168 16 16 16h432a16 16 0 0 0 16-16V576a16 16 0 0 0-16-16H416zM299.264 395.392a16 16 0 0 0-22.592.064L171.264 501.376a16 16 0 0 0 .064 22.592l105.408 104.896a16 16 0 0 0 27.264-11.328V406.784a16 16 0 0 0-4.736-11.392zM416 368a16 16 0 0 0-16 16v64c0 8.832 7.168 16 16 16h432A16 16 0 0 0 864 448V384a16 16 0 0 0-16-16H416zm-240-192A16 16 0 0 0 160 192v64c0 8.832 7.168 16 16 16h672A16 16 0 0 0 864 256V192a16 16 0 0 0-16-16H176z"
              />
            </svg>
          </button>
          <button
            v-if="isAppFullscreen"
            type="button"
            class="preview-fullscreen-close"
            :aria-label="t('gallery.exitFullscreen')"
            @click.stop="toggleAppFullscreen"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path
                d="M18.3 5.71 12 12l6.3 6.29-1.41 1.41L10.59 13.41 4.3 19.7 2.89 18.29 9.17 12 2.89 5.71 4.3 4.3l6.29 6.29 6.3-6.29z"
              />
            </svg>
          </button>
          <!-- 箭头的有无直接表达上层意图：没有下一张就不渲染，不做置灰态 -->
          <div
            v-if="props.canPrev"
            class="preview-nav-zone left"
            :class="{ visible: previewHoverSide === 'left' }"
            @click.stop="goPrev"
          >
            <div class="preview-nav-stack">
              <button class="preview-nav-btn" type="button" :class="{ disabled: navPending }" aria-label="上一张">
                <el-icon>
                  <ArrowLeftBold />
                </el-icon>
              </button>
              <!-- 幻灯片播放：与箭头同显隐；stop 防止冒泡到 zone 触发单步切换 -->
              <button
                class="preview-slideshow-btn"
                type="button"
                :class="{ playing: slideshowDirection === 'prev' }"
                :aria-label="
                  slideshowDirection === 'prev' ? t('gallery.slideshowStop') : t('gallery.slideshowPlayPrev')
                "
                :title="slideshowDirection === 'prev' ? t('gallery.slideshowStop') : t('gallery.slideshowPlayPrev')"
                @click.stop="toggleSlideshow('prev')"
              >
                <span class="preview-slideshow-track">
                  <el-icon><DArrowLeft /></el-icon>
                  <el-icon><DArrowLeft /></el-icon>
                </span>
              </button>
            </div>
          </div>
          <div
            v-if="props.canNext"
            class="preview-nav-zone right"
            :class="{ visible: previewHoverSide === 'right' }"
            @click.stop="goNext"
          >
            <div class="preview-nav-stack">
              <button class="preview-nav-btn" type="button" :class="{ disabled: navPending }" aria-label="下一张">
                <el-icon>
                  <ArrowRightBold />
                </el-icon>
              </button>
              <!-- 幻灯片播放：与箭头同显隐；stop 防止冒泡到 zone 触发单步切换 -->
              <button
                class="preview-slideshow-btn"
                type="button"
                :class="{ playing: slideshowDirection === 'next' }"
                :aria-label="
                  slideshowDirection === 'next' ? t('gallery.slideshowStop') : t('gallery.slideshowPlayNext')
                "
                :title="slideshowDirection === 'next' ? t('gallery.slideshowStop') : t('gallery.slideshowPlayNext')"
                @click.stop="toggleSlideshow('next')"
              >
                <span class="preview-slideshow-track">
                  <el-icon><DArrowRight /></el-icon>
                  <el-icon><DArrowRight /></el-icon>
                </span>
              </button>
            </div>
          </div>
          <div v-if="previewImage && !isPreviewVideo" ref="panzoomWrapperRef" class="panzoom-wrapper">
            <!-- 未缩放时 panzoom 拖不动画面，把指针让给原生拖拽（拖出图片 + 残影） -->
            <ImageContent
              ref="previewContentRef"
              :image="previewImage"
              prefer="original"
              :native-drag="!panzoomCanPan"
              @ready="handlePreviewReady"
            />
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
            <button
              class="control-btn"
              type="button"
              :aria-label="isAppFullscreen ? t('gallery.exitFullscreen') : t('gallery.fullscreen')"
              @click="toggleAppFullscreen"
            >
              <svg v-if="!isAppFullscreen" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M7 14H5v5h5v-2H7v-3zm0-4h2V7h3V5H5v5zm10 7h-3v2h5v-5h-2v3zm0-12v3h2V5h-5v2h3z" />
              </svg>
              <svg v-else viewBox="0 0 24 24" aria-hidden="true">
                <path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm8 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z" />
              </svg>
            </button>
          </PreviewControlBar>
          <div v-if="previewImage && isPreviewVideo" class="preview-video-wrapper">
            <ImageContent
              ref="previewContentRef"
              :image="previewImage"
              prefer="original"
              video-playing
              video-loop
              @ready="handlePreviewReady"
            />
            <VideoControls
              :video="previewVideoEl"
              :show-play-pause="true"
              :is-fullscreen="isAppFullscreen"
              @toggle-fullscreen="toggleAppFullscreen"
            />
          </div>
        </div>
        <!-- 抽屉开关只由用户控制，不随内容有无自动收起（避免切图时闪出/闪收）；
             无插件内容时面板自身渲染为空 -->
        <KbResizable
          v-model="detailDrawerRightWidth"
          tag="aside"
          side="left"
          class="kb-side-pane preview-detail-drawer"
          :class="{ 'is-open': detailDrawerOpen }"
          :default-size="PREVIEW_DRAWER_DEFAULT_WIDTH"
          :handle-title="t('gallery.toggleDetailPanel')"
          @resize-start="handleDrawerResizeStart('right')"
          @resize-end="handleDrawerResizeEnd"
          @click.stop
          @wheel.stop
        >
          <div class="preview-detail-drawer-scroll preview-detail-drawer-scroll-right">
            <ImagePluginDescriptionPanel :image="previewImage" fill-when-expanded />
          </div>
        </KbResizable>
      </div>
    </el-dialog>
    <!-- 桌面端预览内右键：与单张图片相同的上下文菜单（z-index 高于 el-dialog 以免被遮） -->
    <ActionRenderer
      v-if="actions.length > 0"
      :visible="previewContextMenu.isOpen.value"
      :position="previewContextMenuPosition"
      :actions="actions"
      :context="previewActionContext"
      mode="contextmenu"
      :z-index="previewContextMenu.zIndex.value"
      @close="closePreviewContextMenu"
      @command="handlePreviewActionCommand"
    />
  </template>
</template>

<script setup lang="ts">
import type { Ref } from "vue";
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { ArrowLeftBold, ArrowRightBold, DArrowLeft, DArrowRight } from "@kabegame/element-plus-icons";
import { useLocalStorage } from "@vueuse/core";
import { useI18n } from "@kabegame/i18n";
import type { ImageInfo } from "../../types/image";
import ImageContent from "../image/ImageContent.vue";
import ImageLabelsPanel from "../image/ImageLabelsPanel.vue";
import PswpSlideContent from "./PswpSlideContent.vue";
import ImageBasicInfoPanel, {
  type ImageDetailGalleryFilterTarget,
  type ImageDetailSurfRecordTarget,
} from "./ImageBasicInfoPanel.vue";
import ImageNativeMetadataPanel from "./ImageNativeMetadataPanel.vue";
import ImagePluginDescriptionPanel from "./ImagePluginDescriptionPanel.vue";
import KbResizable from "./KbResizable.vue";
import PreviewControlBar from "./PreviewControlBar.vue";
import PreviewRangeSlider from "./PreviewRangeSlider.vue";
import VideoControls from "./VideoControls.vue";
import { useUiStore } from "../../stores/ui";
import { useSettingsStore } from "../../stores/settings";
import ActionRenderer from "../ActionRenderer.vue";
import type { ActionItem, ActionContext } from "../../actions/types";
// @ts-expect-error - Vue SFC component import, types resolved via package.json exports
import PhotoSwipe from "photoswipe-vue/vue";
import "photoswipe-vue/photoswipe.css";
import { usePanzoomPreview } from "../../composables/usePanzoomPreview";
import { useAudioKeepAlive } from "../../composables/useAudioKeepAlive";
import { useModal } from "../../composables/useModal";
import { fileToUrl, thumbnailToUrl } from "../../utils/fileUrl";
import { fetchImageById } from "../../utils/imageRow";
import { subscribeChanges } from "../../services/dataChangeHub";
import { isNativeMetadataEligible, isVideoMediaType } from "../../utils/mediaMime";
import type { Plugin } from "@/stores/plugins";

const { t } = useI18n();
const uiStore = useUiStore();
const settingsStore = useSettingsStore();
const previewModal = useModal({ layers: 3 });
const previewContextMenu = useModal();
const previewFullscreenZIndex = computed(() => previewModal.zIndex.value);
const previewOverlayZIndex = computed(() => previewModal.zIndex.value + 10);
const previewControlZIndex = computed(() => previewModal.zIndex.value + 20);
const previewHidesKamechanClass = "image-preview-hides-kamechan";

const props = withDefaults(
  defineProps<{
    /**
     * 唯一真相，也是开关：非空即打开。
     * - `ImageInfo`：上层在当前列表里找到了。**以 props 为准，弹窗不取数、不订阅**
     *   （上层的 `patchMany` 已经在保鲜它，props 会持续流下来）
     * - `string`：上层只知道 id（深链接 / 图在视图外），弹窗自己解析并自行保鲜
     */
    image: string | ImageInfo | null;
    /** 该方向有图可去（含「视图到边界但还有下一页」）；false 则箭头不渲染 */
    canPrev?: boolean;
    canNext?: boolean;
    /** 紧凑模式动画素材：视图内的直接邻居；页边界或视图外为 null */
    prevImage?: ImageInfo | null;
    nextImage?: ImageInfo | null;
    /** Actions for context menu / action sheet. */
    actions?: ActionItem<ImageInfo>[];
    /** 用于预览内详情抽屉解析插件名（与 ImageDetailDialog 一致） */
    plugins?: Array<Plugin>;
  }>(),
  {
    canPrev: false,
    canNext: false,
    prevImage: null,
    nextImage: null,
    actions: () => [],
    plugins: () => [],
  },
);

/** 桌面端预览内详情侧栏开关（localStorage，与 mergeDefaults 容错非法值） */
const detailDrawerOpen = useLocalStorage("kabegame-preview-detail-open", false, {
  mergeDefaults: true,
});
const detailDrawerLeftOpen = useLocalStorage("kabegame-preview-detail-left-open", false, { mergeDefaults: true });
/** 双击把手复位用；上下限由 CSS（`--kb-resizable-min/max`）给，见下方样式 */
const PREVIEW_DRAWER_DEFAULT_WIDTH = 320;
const detailDrawerLeftWidth = useLocalStorage("kabegame-preview-detail-left-width", PREVIEW_DRAWER_DEFAULT_WIDTH, {
  mergeDefaults: true,
});
const detailDrawerRightWidth = useLocalStorage("kabegame-preview-detail-right-width", PREVIEW_DRAWER_DEFAULT_WIDTH, {
  mergeDefaults: true,
});
type PreviewDrawerSide = "left" | "right";
/** 仅用于「拖拽期间别让 ResizeObserver 抢着重置 Panzoom」，尺寸本身由 KbResizable 管 */
const resizingDrawer = ref<PreviewDrawerSide | null>(null);

const emit = defineEmits<{
  (e: "contextCommand", payload: { command: string; image: ImageInfo }): void;
  (e: "open-task", taskId: string): void;
  (e: "open-gallery-filter", target: ImageDetailGalleryFilterTarget): void;
  (e: "open-surf-record", target: ImageDetailSurfRecordTarget): void;
  /** 用户要求切换；上层算出目标并回设 props.image */
  (e: "switch", payload: { direction: "prev" | "next" }): void;
  /** 解析失败。上层据此弹 message 并清 previewedId（连带清 URL）；弹窗自己不写 URL */
  (e: "resolve-failed", payload: { id: string; reason: "missing" | "error" }): void;
  (e: "preview-detail-toggle", payload: { open: boolean; image: ImageInfo | null }): void;
  (e: "preview-close", payload: { image: ImageInfo | null }): void;
}>();

const previewVisible = previewModal.isOpen;
const previewImageUrl = ref("");
const previewImagePath = ref("");

/** props 的两种形式都能拿到 id——弹窗内部一切逻辑的锚。 */
const currentId = computed<string | null>(() =>
  typeof props.image === "string" ? props.image : (props.image?.id ?? null),
);
/** props 只给了 id 时，弹窗自己解析出来的那份（props 是 ImageInfo 时恒为 null）。 */
const resolvedImage = ref<ImageInfo | null>(null);

/**
 * 归属按 props 形式分流：
 * - `ImageInfo` → 上层所有，props 为准（上层的 patchMany 在保鲜它）
 * - `string`    → 弹窗所有，用自己解析出来的那份
 */
const previewImage = computed<ImageInfo | null>(() =>
  typeof props.image === "string" ? resolvedImage.value : props.image,
);
/** 只给了 id 且还没解析出来：画 loading，不是「不存在」。 */
const previewResolving = computed(() => typeof props.image === "string" && !resolvedImage.value);
const isPreviewVideo = computed(() => isVideoMediaType(previewImage.value?.type));

// 桌面预览视频期间保持音频输出设备常驻，避免暂停后恢复播放漏掉开头声音
const audioKeepAlive = useAudioKeepAlive();
const desktopVideoActive = computed(() => !uiStore.isCompact && previewVisible.value && isPreviewVideo.value);
watch(desktopVideoActive, (active) => {
  if (active) audioKeepAlive.start();
  else audioKeepAlive.stop();
});
const previewHoverSide = ref<"left" | "right" | null>(null);
const previewNotFound = ref(false);
const isAppFullscreen = ref(false);
const previewShouldHideKamechan = computed(() => (uiStore.isCompact ? previewVisible.value : isAppFullscreen.value));

const previewContainerRef = ref<HTMLElement | null>(null);
const previewContentRef = ref<InstanceType<typeof ImageContent> | null>(null);
/** 桌面预览视频：从 ImageContent 暴露的 videoEl 取，供 VideoControls 绑定 */
const previewVideoEl = computed<HTMLVideoElement | null>(() => previewContentRef.value?.videoEl ?? null);
/** 紧凑模式 PhotoSwipe slot：用 item.id 反查三项窗口 */
const imageById = (id: string | number | undefined): ImageInfo | null =>
  [props.prevImage, previewImage.value, props.nextImage].find((img) => img && img.id === id) ?? null;
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
/** 拖动会否平移画面；为 false 时把指针让给浏览器原生图片拖拽 */
let panzoomCanPan!: Ref<boolean>;
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

/** Android 视频用户暂停态：双击切换，与控件显隐无关；切换幻灯片/重新打开时重置（自动播放） */
const videoPaused = ref(false);
let longPressTimer: ReturnType<typeof setTimeout> | null = null;

const normalizeDesktopPath = (path: string | undefined) =>
  (path || "")
    .trimStart()
    .replace(/^\\\\\?\\/, "")
    .trim();

const toFileUrl = (path: string | undefined) => {
  const normalized = normalizeDesktopPath(path);
  if (!normalized) return "";
  return fileToUrl(normalized);
};

const getOriginalPreviewUrl = (image: ImageInfo) => toFileUrl(image.localPath);

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
    window.dispatchEvent(new CustomEvent("preview-interacting-change", { detail: { active } }));
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
  canPan: panzoomCanPan,
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
  },
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

function resetPanzoomAfterDrawerResize() {
  void nextTick(() => {
    requestAnimationFrame(() => {
      measureContainerSize();
      panzoomReset();
    });
  });
}

function handleDrawerResizeStart(side: PreviewDrawerSide) {
  resizingDrawer.value = side;
  notifyPreviewInteracting(true);
}

/** 拖拽结束与双击复位共用：抽屉宽度变了就得让图片按新容器重新适配 */
function handleDrawerResizeEnd() {
  resizingDrawer.value = null;
  markPreviewInteracting();
  resetPanzoomAfterDrawerResize();
}

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

/** 切换左侧图片信息抽屉，并在抽屉过渡的三个时机重置 Panzoom。 */
const toggleDetailDrawerLeft = () => {
  detailDrawerLeftOpen.value = !detailDrawerLeftOpen.value;
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

/**
 * 紧凑模式 PhotoSwipe：三项滑动窗口 `[prev, current, next]`，内容由上层按 id 实时算出。
 * 页边界或视图外时不足三项，所以**当前位不恒为 1**，必须显式算（见 pswpCurrentIndex）。
 */
const pswpWindow = computed<ImageInfo[]>(() =>
  [props.prevImage, previewImage.value, props.nextImage].filter((img): img is ImageInfo => !!img),
);

/** 当前图在窗口里的下标：首张时为 0，末张时为 1，视图外只有一项时为 0。 */
const pswpCurrentIndex = computed(() => {
  const id = currentId.value;
  if (!id) return 0;
  const idx = pswpWindow.value.findIndex((img) => img.id === id);
  return idx >= 0 ? idx : 0;
});

const pswpDataSource = computed(() => {
  const fallbackW = 1920;
  const fallbackH = 1080;
  return pswpWindow.value.map((img) => {
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
});

/**
 * 传给 PhotoSwipe 的 index 是「命令」，不是派生值——只在需要主动导航时写。
 *
 * 绝不能把它做成 `currentId → index` 的 computed：窗口平移时该值会变，触发
 * PhotoSwipe 的 props.index watcher → goTo() → 带动画倒退一张，并清掉用户当前缩放。
 * 窗口平移应当走 PhotoSwipe 自己的 relocate（它按 delta 平移各 holder 逻辑索引，
 * 保留内容相同那几张的缩放平移）。@change 只单向更新本地状态，不回写这里。
 */
const pswpCommandIndex = ref(0);

/** 把当前这张图的 URL / 路径同步到桌面侧渲染状态。 */
const syncPreviewSource = (img: ImageInfo | null) => {
  if (!img) {
    previewImageUrl.value = "";
    previewImagePath.value = "";
    return;
  }
  previewImagePath.value = img.localPath;
  previewNotFound.value = false;
  previewImageLoading.value = false;
  previewImageUrl.value = (getOriginalPreviewUrl(img) || getThumbnailPreviewUrl(img) || "").trim();
};

/* ---------------- 按 id 解析与保鲜（仅 props 为裸 id 时） ----------------
 * props 给了 ImageInfo 就什么都不做：那份归上层所有，由它的 patchMany 保鲜。
 */

let resolveToken = 0;
let unsubscribeImageChanges: (() => void) | null = null;

const stopImageSubscription = () => {
  unsubscribeImageChanges?.();
  unsubscribeImageChanges = null;
};

/** 返回 false 表示已 emit resolve-failed（调用方不必再处理）。 */
const resolveCurrentImage = async (id: string): Promise<boolean> => {
  const token = ++resolveToken;
  try {
    const image = await fetchImageById(id);
    if (token !== resolveToken) return true; // 过期响应，丢弃
    if (!image) {
      emit("resolve-failed", { id, reason: "missing" });
      return false;
    }
    resolvedImage.value = image;
    return true;
  } catch (error) {
    if (token !== resolveToken) return true;
    console.error("预览解析图片失败:", error);
    emit("resolve-failed", { id, reason: "error" });
    return false;
  }
};

const startImageSubscription = (id: string) => {
  stopImageSubscription();
  unsubscribeImageChanges = subscribeChanges({
    waitMs: 300,
    filter: (batch) =>
      batch.imagePatches.has(id) ||
      batch.imageIds.has(id) ||
      // 收藏 / 隐藏是画册成员变更，走 album-images-change，不在 imageIds 里
      batch.albumImageIds.has(id) ||
      batch.favoriteOps.some((op) => op.imageIds.includes(id)) ||
      // 末项兜 wildcard：范围未知的批次必须当作命中自己，漏了会静默不刷新，允许资源倾斜所以放着，建议打开跟页设置
      batch.images.size > 0,
    onBatch: async (batch) => {
      if (currentId.value !== id) return;

      // 事件只改「当前 id 的内容」，绝不改「当前 id 本身」
      const fields: Partial<ImageInfo> = { ...batch.imagePatches.get(id) };
      // favoriteOps 带真实值，按到达顺序取最后一次
      for (const op of batch.favoriteOps) {
        if (op.imageIds.includes(id)) fields.favorite = op.favorite;
      }
      if (Object.keys(fields).length > 0) {
        if (resolvedImage.value) resolvedImage.value = { ...resolvedImage.value, ...fields };
        // 画册成员变更还会影响 isHidden，粗信号仍要重拉；字段 patch 只是让 UI 先到位
        if (!batch.albumImageIds.has(id) && !batch.imageIds.has(id) && batch.images.size === 0) return;
      }
      // 粗信号：重拉一次。确认 0 行才算消失——这里 emit resolve-failed，
      // 不是跳下一张；跳不跳是上层的事（它有列表和用户意图）。
      await resolveCurrentImage(id);
    },
  });
};

watch(
  () => props.image,
  (value, previous) => {
    const id = typeof value === "string" ? value : (value?.id ?? null);
    const prevId = typeof previous === "string" ? previous : (previous?.id ?? null);

    if (!id) {
      resolveToken++;
      resolvedImage.value = null;
      stopImageSubscription();
      return;
    }

    if (typeof value !== "string") {
      // ImageInfo 形式：上层所有。丢掉本地副本并退订（可能刚从 string 形式翻转过来）
      resolveToken++;
      resolvedImage.value = null;
      stopImageSubscription();
      syncPreviewSource(value);
      return;
    }

    // string 形式：弹窗所有。换了 id 才重新解析 / 重新订阅
    if (id !== prevId || !unsubscribeImageChanges) {
      resolvedImage.value = null;
      void resolveCurrentImage(id);
      startImageSubscription(id);
    }
  },
  { immediate: true },
);

watch(
  () => resolvedImage.value,
  (img) => {
    if (typeof props.image === "string") syncPreviewSource(img);
  },
);

/* ---------------- 导航 ---------------- */

/**
 * 切换已经是异步的（上层可能要翻页，耗时可达秒级），所以用 pending 锁而不是固定节流：
 * 发出请求后箭头与按键惰化，props.image 变化才解锁。
 */
const navPending = ref(false);
watch(currentId, (id) => {
  navPending.value = false;
  // 上层清空 image 即关闭：停播放
  if (!id) {
    stopSlideshow();
    return;
  }
  // 每次落地（自动 / 手动箭头 / 键盘 / 上层翻页回设）都从头计时；到头则停
  if (!slideshowDirection.value) return;
  if (!canGo(slideshowDirection.value)) stopSlideshow();
  else restartSlideshowTimer();
});

const canGo = (direction: "prev" | "next") => (direction === "prev" ? props.canPrev : props.canNext);

const requestSwitch = (direction: "prev" | "next") => {
  if (!previewVisible.value) return;
  if (navPending.value) return;
  if (!canGo(direction)) return;
  navPending.value = true;
  emit("switch", { direction });
};

const goPrev = () => requestSwitch("prev");
const goNext = () => requestSwitch("next");

/* ---------------- 幻灯片播放 ---------------- */

/**
 * 计时以「当前图落地」为起点（每次 currentId 变化重挂 setTimeout），而不是固定 setInterval：
 * 跨页加载再慢也不会吃掉下一张的展示时间。到点直接走 requestSwitch，复用 pending 锁与边界判断。
 */
const SLIDESHOW_INTERVAL_MS = { fast: 5000, medium: 10000, slow: 20000 } as const;
const slideshowDirection = ref<"prev" | "next" | null>(null);
let slideshowTimer: ReturnType<typeof setTimeout> | null = null;

const clearSlideshowTimer = () => {
  if (slideshowTimer) clearTimeout(slideshowTimer);
  slideshowTimer = null;
};

const stopSlideshow = () => {
  clearSlideshowTimer();
  slideshowDirection.value = null;
};

const restartSlideshowTimer = () => {
  clearSlideshowTimer();
  const direction = slideshowDirection.value;
  if (!direction) return;
  const ms = SLIDESHOW_INTERVAL_MS[settingsStore.values.previewSlideshowSpeed ?? "fast"] ?? SLIDESHOW_INTERVAL_MS.fast;
  slideshowTimer = setTimeout(() => {
    slideshowTimer = null;
    // 关闭与计时竞争、或到头：直接停，不发 switch
    if (!previewVisible.value || !currentId.value || !canGo(direction)) {
      stopSlideshow();
      return;
    }
    // 落地后由 currentId watcher 续挂下一轮
    requestSwitch(direction);
  }, ms);
};

/** 同向再点停止；否则切到该方向（含首次开始），并重置计时 */
const toggleSlideshow = (direction: "prev" | "next") => {
  if (slideshowDirection.value === direction) {
    stopSlideshow();
    return;
  }
  slideshowDirection.value = direction;
  restartSlideshowTimer();
};

// 落地后上层才把 canPrev/canNext 收回的时序：方向不可达即停
watch(
  () => [props.canPrev, props.canNext] as const,
  () => {
    const direction = slideshowDirection.value;
    if (direction && !navPending.value && !canGo(direction)) stopSlideshow();
  },
);
watch(previewVisible, (visible) => {
  if (!visible) stopSlideshow();
});
watch(
  () => uiStore.isCompact,
  (compact) => {
    if (compact) stopSlideshow();
  },
);

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
  const target = event.target as HTMLInputElement | null;
  const isRangeArrow =
    target?.tagName === "INPUT" && target.type === "range" && (event.key === "ArrowLeft" || event.key === "ArrowRight");
  if (isTextInputLike(event.target) && !isRangeArrow) return;
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
  videoPaused.value = false;
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
    emit("preview-close", { image: closedImage });
    return;
  }
  previewModal.close();
  previewImageUrl.value = "";
  previewImagePath.value = "";
  previewHoverSide.value = null;
  closePreviewContextMenu();
  previewImageLoading.value = false;
  resizingDrawer.value = null;
  panzoomDestroy();
  if (previewInteractTimer) clearTimeout(previewInteractTimer);
  previewInteractTimer = null;
  notifyPreviewInteracting(false);
  navPending.value = false;
  stopSlideshow();
  emit("preview-close", { image: closedImage });
};

const performSwipeDelete = () => {
  if (!previewImage.value) return;
  emit("contextCommand", { command: "swipe-remove", image: previewImage.value });
};

watch(
  () => previewVisible.value,
  async (visible) => {
    if (visible && !uiStore.isCompact) {
      await nextTick();
      await measureContainerAfterRender();
    }
  },
);

watch(
  () => previewImage.value?.id,
  (id) => {
    if (id && !uiStore.isCompact) {
      if (isPreviewVideo.value) return;
      panzoomReset();
    }
  },
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
    if (!resizingDrawer.value) {
      panzoomReset();
    }
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
watch(
  () => previewVisible.value,
  (visible) => {
    if (!visible) {
      initialPanY = null;
    }
  },
);

watch(previewShouldHideKamechan, syncKamechanVisibilityForPreview, { immediate: true });

const handlePswpBeforeClose = (source?: string): boolean => {
  if (source === "verticalDrag") {
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
  if (!uiStore.isCompact || index < 0) return;
  const target = pswpWindow.value[index];
  if (!target) return;

  initialPanY = null;
  if (verticalDragResetTimer) {
    clearTimeout(verticalDragResetTimer);
    verticalDragResetTimer = null;
  }
  swipeDeleteActive.value = false;
  swipeDeleteReady.value = false;
  isFromVerticalDrag = false;
  videoPaused.value = false;

  // 窗口里换了一张 = 用户划到了邻居：请求上层把 props.image 挪过去。
  // 这里不回写 pswpCommandIndex——窗口随后会平移，PhotoSwipe 自己用 relocate 跟上。
  if (target.id === currentId.value) return;
  if (target.id === props.nextImage?.id) requestSwitch("next");
  else if (target.id === props.prevImage?.id) requestSwitch("prev");
};

const handlePswpReachBoundary = ({ direction }: { direction: "prev" | "next"; index: number }) => {
  if (!uiStore.isCompact) return;
  // 窗口边缘 ≠ 列表边界：是不是真的到头由上层的 canPrev / canNext 说了算
  requestSwitch(direction);
};

/** Android：视频幻灯片双击切换播放/暂停（photoswipe-vue 只对 video 类型 slide 触发） */
const handleVideoDoubleTap = () => {
  videoPaused.value = !videoPaused.value;
};

const handleVideoPlayFail = () => {
  if (!uiStore.isCompact) return;
  // 播放失败视为暂停态，并展示控件提示用户；双击可在用户手势内重试播放
  videoPaused.value = true;
  pswpRef.value?.setUiVisible(true);
};

const handlePswpClose = () => {
  const closedImage = previewImage.value;
  doAndroidPreviewCleanup();
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
  stopSlideshow();
  window.removeEventListener("keydown", handlePreviewKeyDown, true);
  document.removeEventListener("mouseup", handleDocumentZoomPointerUp);
  document.removeEventListener("touchend", handleDocumentZoomPointerUp);
  resizingDrawer.value = null;
  syncKamechanVisibilityForPreview(false);
  panzoomDestroy();
  if (previewInteractTimer) {
    clearTimeout(previewInteractTimer);
    previewInteractTimer = null;
  }
  notifyPreviewInteracting(false);
  stopImageSubscription();
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
    { immediate: true },
  );
}

/**
 * props.image 非空即打开。弹窗不再有命令式 open()——开关是上层 previewedId 的投影。
 * 打开瞬间把 PhotoSwipe 的命令索引对准当前图；之后窗口平移一律走 relocate，不再写这里。
 */
watch(
  () => props.image,
  async (value) => {
    if (value) {
      if (!previewVisible.value) {
        previewModal.open();
        videoPaused.value = false;
      }
      await nextTick();
      pswpCommandIndex.value = pswpCurrentIndex.value;
    } else if (previewVisible.value) {
      closePreview();
    }
  },
  { immediate: true },
);

defineExpose({
  close: closePreview,
  previewVisible,
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
    container-type: inline-size;
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

    /* z-index 由模板内联绑定给出（见模板处注释），这里不写 v-bind */
    &.is-app-fullscreen {
      position: fixed;
      inset: 0;
      background: #000;
    }
  }

  /* 全屏时容器 position: fixed 脱离了这条 flex 行，两个抽屉会塌到左侧挤成一团；
     且抽屉是 position: relative（resize handle 需要），与 fixed 容器同属定位层，
     DOM 在后的右抽屉会直接画在全屏图上。全屏即纯图，直接不参与布局 */
  .preview-desktop-body.is-app-fullscreen > .preview-detail-drawer {
    display: none;
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

  .preview-detail-toggle-left {
    right: auto;
    left: 12px;

    .preview-detail-drawer-icon {
      transform: scaleX(-1);
    }
  }

  /* 宽度上下限来自 KbResizable 的 kb-side-pane 预设（与插件详情两侧同一套），这里只管开合形态 */
  .preview-detail-drawer {
    flex: 0 0 0;
    width: 0;
    min-width: 0;
    overflow: hidden;
    box-sizing: border-box;
    position: relative;
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
      flex: 0 0 var(--kb-resizable-clamped);
      width: var(--kb-resizable-clamped);
      opacity: 1;
      border-left-color: var(--anime-border, rgba(0, 0, 0, 0.12));
    }

    &.is-resizing {
      transition: none;
    }
  }

  .preview-detail-drawer-left {
    border-right: 1px solid transparent;
    border-left: 0;

    &.is-open {
      border-right-color: var(--anime-border, rgba(0, 0, 0, 0.12));
      border-left-color: transparent;
    }
  }

  .preview-detail-drawer-scroll {
    height: 100%;
    overflow-x: hidden;
    overflow-y: auto;
    padding: 12px 14px 16px;
    box-sizing: border-box;
  }

  /* 侧栏内多面板：展开的（--fill）flex:1 争夺空间，收拢的只占标题行；面板内部各自滚动 */
  .preview-detail-drawer-scroll-left,
  .preview-detail-drawer-scroll-right {
    display: flex;
    min-height: 0;
    flex-direction: column;
    gap: 12px;
    overflow: hidden;
  }

  /* 高度由侧栏给定；声明为 size 容器，供标签面板用 cqh 按侧栏高度限高 */
  .preview-detail-drawer-scroll-left {
    container-type: size;
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
    position: relative;
    user-select: none;
  }

  .zoom-progress-text {
    position: absolute;
    top: calc(50% + 8px);
    right: 0;
    font-size: 12px;
    line-height: 1;
    text-align: right;
    color: rgba(255, 255, 255, 0.92);
    font-variant-numeric: tabular-nums;
    pointer-events: none;
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
    transition:
      transform 0.12s ease,
      background-color 0.12s ease,
      box-shadow 0.12s ease;
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

  // 箭头 + 幻灯片按钮：按钮绝对定位在箭头正下方，箭头本身仍垂直居中
  .preview-nav-stack {
    position: relative;
    display: flex;
  }

  .preview-slideshow-btn {
    position: absolute;
    top: calc(100% + 10px);
    left: 50%;
    width: 28px;
    height: 28px;
    padding: 0;
    border-radius: 999px;
    border: none;
    background: rgba(255, 95, 184, 0.72);
    color: #ffffff;
    display: flex;
    align-items: center;
    overflow: hidden;
    cursor: pointer;
    box-shadow: 0 6px 16px rgba(255, 95, 184, 0.24);
    transform: translateX(-50%);
    transition:
      transform 0.12s ease,
      background-color 0.12s ease,
      box-shadow 0.12s ease;
    user-select: none;

    &:hover {
      transform: translateX(-50%) scale(1.06);
      box-shadow: 0 8px 20px rgba(255, 95, 184, 0.32);
    }

    &.playing {
      background: #ff5fb8;
    }

    .el-icon {
      flex: none;
      width: 28px;
      font-size: 14px;
    }
  }

  // 两份图标横排、只露一份；播放时整条平移一个图标宽度循环，首尾相同所以无缝
  .preview-slideshow-track {
    display: flex;
    flex: none;
  }

  .preview-nav-zone.right .preview-slideshow-btn.playing .preview-slideshow-track {
    animation: preview-slideshow-scroll-next 0.9s linear infinite;
  }

  .preview-nav-zone.left .preview-slideshow-btn.playing .preview-slideshow-track {
    animation: preview-slideshow-scroll-prev 0.9s linear infinite;
  }

  @media (prefers-reduced-motion: reduce) {
    .preview-slideshow-btn.playing .preview-slideshow-track {
      animation: none !important;
    }
  }
}

@keyframes preview-slideshow-scroll-next {
  from {
    transform: translateX(-28px);
  }
  to {
    transform: translateX(0);
  }
}

@keyframes preview-slideshow-scroll-prev {
  from {
    transform: translateX(0);
  }
  to {
    transform: translateX(-28px);
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
  transition:
    opacity 0.2s ease,
    transform 0.2s ease;
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
    transition:
      transform 0.12s ease,
      background-color 0.12s ease,
      box-shadow 0.12s ease;
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
