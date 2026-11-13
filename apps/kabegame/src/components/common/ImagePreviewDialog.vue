<template>
  <!-- Android 全屏预览：使用 photoswipe-vue 组件，关闭按钮用组件自带的 -->
  <PhotoSwipe
    v-if="IS_ANDROID"
    ref="pswpRef"
    :open="previewModal.isOpen.value"
    :index="pswpCurrentIndex"
    :data-source="pswpDataSource"
    :loop="false"
    :z-index="previewFullscreenZIndex"
    :close-on-vertical-drag="true"
    @update:open="previewModal.close"
    :on-vertical-drag="handlePswpVerticalDrag"
    :on-before-close="handlePswpBeforeClose"
    @change="handlePswpChange"
    @close="handlePswpClose"
    @swipe="handlePswpSwipe"
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
            <Trash2 :size="24" :stroke-width="2" />
            <span>{{ swipeDeleteReady ? "释放删除" : "上划删除" }}</span>
          </div>
        </div>
      </Transition>
    </template>
  </PhotoSwipe>

  <!-- 桌面端 Dialog 预览 -->
  <template v-else>
    <!-- 层级用 previewModal 的栈位（2000 起），吉祥物按栈位浮在预览之上；预览里再弹出的新浮层向 EP 计数器取号（3000 起），在它之上 -->
    <DialogRoot :open="previewModal.isOpen.value" @update:open="handleDialogOpenChange">
      <DialogPortal>
        <DialogOverlay
          data-kb-motion
          class="fixed inset-0 bg-[var(--kb-overlay)] data-[state=open]:animate-[kb-fade-in_160ms_ease-out] data-[state=closed]:animate-[kb-fade-out_120ms_ease-in]"
          :style="{ zIndex: previewFullscreenZIndex }"
        />
        <!-- 只做透明度动画：缩放会让打开瞬间量到的容器尺寸偏小，Panzoom 按它适配就错位了；
             也不能有 transform，全屏时预览区是 position: fixed，要相对视口 -->
        <DialogContent
          data-kb-trap
          data-kb-motion
          aria-describedby=""
          class="image-preview-dialog fixed inset-0 m-auto box-border flex h-[90vh] w-[90vw] flex-col overflow-hidden rounded-kb-lg bg-kb-surface-raised text-kb-fg shadow-kb-lg outline-none data-[state=open]:animate-[kb-fade-in_160ms_ease-out] data-[state=closed]:animate-[kb-fade-out_120ms_ease-in]"
          :style="{ zIndex: previewFullscreenZIndex }"
          @open-auto-focus="handleDialogOpenAutoFocus"
          @pointer-down-outside="handleDialogPointerDownOutside"
          @focus-outside="keepOpenOnForeign"
          @interact-outside="handleDialogPointerDownOutside"
        >
          <header class="flex h-12 shrink-0 items-center gap-3 border-0 border-b border-solid border-kb-line pl-5 pr-3">
            <DialogTitle class="m-0 min-w-0 flex-1 truncate text-[15px] font-600 leading-6 text-kb-fg">
              {{ previewDialogTitle }}
            </DialogTitle>
            <Tooltip :content="t('common.close')">
              <DialogClose as-child>
                <Button variant="ghost" size="icon-sm" :aria-label="t('common.close')">
                  <X />
                </Button>
              </DialogClose>
            </Tooltip>
          </header>
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
              <!-- 面板自带折叠外壳：展开的 flex:1 争夺侧栏空间，收拢的只占标题行；基本信息内容紧凑，按自然高度 -->
              <div class="preview-detail-drawer-scroll preview-detail-drawer-scroll-left">
                <ImageBasicInfoPanel
                  :image="previewImage"
                  :plugins="plugins"
                  @open-task="emit('open-task', $event)"
                  @open-gallery-filter="handleOpenGalleryFilter"
                  @open-color-sort="emit('open-color-sort', $event)"
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
                <PanelLeftClose v-if="detailDrawerLeftOpen" />
                <PanelLeftOpen v-else />
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
                <PanelRightClose v-if="detailDrawerOpen" />
                <PanelRightOpen v-else />
              </button>
              <button
                v-if="isAppFullscreen"
                type="button"
                class="preview-fullscreen-close"
                :aria-label="t('gallery.exitFullscreen')"
                @click.stop="toggleAppFullscreen"
              >
                <X />
              </button>
              <!-- 网页壁纸是跨源 iframe，指针在它上面时容器收不到 mousemove；照底部工具条的常驻热区，
               在箭头所在的竖向中段各放一条常驻热区唤出箭头 -->
              <template v-if="isPreviewWallpaper">
                <div v-if="props.canPrev" class="preview-nav-hotzone left" @mouseenter="previewHoverSide = 'left'" />
                <div v-if="props.canNext" class="preview-nav-hotzone right" @mouseenter="previewHoverSide = 'right'" />
              </template>
              <!-- 箭头的有无直接表达上层意图：没有下一张就不渲染，不做置灰态 -->
              <div
                v-if="props.canPrev"
                class="preview-nav-zone left"
                :class="{ visible: previewHoverSide === 'left' }"
                @click.stop="goPrev"
                @mouseleave="handleNavZoneLeave"
              >
                <div class="preview-nav-stack">
                  <button class="preview-nav-btn" type="button" :class="{ disabled: navPending }" aria-label="上一张">
                    <ChevronLeft />
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
                      <ChevronsLeft />
                      <ChevronsLeft />
                    </span>
                  </button>
                </div>
              </div>
              <div
                v-if="props.canNext"
                class="preview-nav-zone right"
                :class="{ visible: previewHoverSide === 'right' }"
                @click.stop="goNext"
                @mouseleave="handleNavZoneLeave"
              >
                <div class="preview-nav-stack">
                  <button class="preview-nav-btn" type="button" :class="{ disabled: navPending }" aria-label="下一张">
                    <ChevronRight />
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
                      <ChevronsRight />
                      <ChevronsRight />
                    </span>
                  </button>
                </div>
              </div>
              <!-- 非视频 WPE 壁纸（web / scene）：和单独的图片一样按内容比例显示，可交互；页面接收指针事件，
               不走 Panzoom，也不挂 VideoControls -->
              <div v-if="previewImage && isPreviewWallpaper" class="preview-wallpaper-wrapper absolute inset-0">
                <WallpaperPreviewCanvas ref="wallpaperCanvasRef" :content-size="previewWallpaperSize">
                  <ImageContent
                    ref="previewContentRef"
                    :image="previewImage"
                    prefer="original"
                    :video-playing="!wallpaperPaused"
                    interactive
                    @ready="handlePreviewReady"
                    @scene-live="previewSceneLive = $event"
                    @wallpaper-contextmenu="openPreviewContextMenuAt"
                  />
                </WallpaperPreviewCanvas>
              </div>
              <div v-if="previewImage && isPreviewStatic" ref="panzoomWrapperRef" class="panzoom-wrapper">
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
                <!-- 缩放只对 Panzoom 图片有意义；壁纸画布只保留全屏 -->
                <template v-if="isPreviewStatic">
                  <button class="control-btn" type="button" :aria-label="t('gallery.zoomOut')" @click="panzoomZoomOut">
                    <ZoomOut />
                  </button>
                  <button class="control-btn" type="button" :aria-label="t('gallery.zoomIn')" @click="panzoomZoomIn">
                    <ZoomIn />
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
                </template>
                <!-- 壁纸的右键菜单项按原顺序平铺成图标按钮（壁纸里的右键由垫片转发，见 wpeContextMenu.ts） -->
                <template v-if="isPreviewWallpaper && wallpaperBarActions.length > 0">
                  <template v-for="action in wallpaperBarActions" :key="action.key">
                    <span v-if="action.divider" class="control-bar-divider" />
                    <button
                      class="control-btn"
                      type="button"
                      :title="action.label"
                      :aria-label="action.label"
                      :disabled="action.disabled"
                      @click="handlePreviewActionCommand(action.command)"
                    >
                      <component :is="action.icon" />
                    </button>
                  </template>
                </template>
                <!-- 控制条定宽左对齐：普通图片靠缩放滑块撑开，壁纸没有弹性项，靠 ml-auto 贴到最右 -->
                <button
                  class="control-btn ml-auto"
                  type="button"
                  :aria-label="isAppFullscreen ? t('gallery.exitFullscreen') : t('gallery.fullscreen')"
                  @click="toggleAppFullscreen"
                >
                  <Maximize v-if="!isAppFullscreen" />
                  <Minimize v-else />
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
                <!-- 网页与场景壁纸：作者属性面板（改动经 metadataId 补丁让页面 / 场景重读）。暂停、设为封面、
                 清空脚本存储在右键菜单与工具条里，面板只留恢复默认封面 -->
                <WpeWebPropertiesPanel
                  v-if="previewImage && hasWpeUserProperties(previewImage.type)"
                  :image-id="previewImage.id"
                  :image-type="previewImage.type"
                  fill-when-expanded
                  :restorable-cover="previewWallpaperLive"
                />
                <ImagePluginDescriptionPanel v-else :image="previewImage" fill-when-expanded />
              </div>
            </KbResizable>
          </div>
        </DialogContent>
      </DialogPortal>
    </DialogRoot>
    <!-- 桌面端预览内右键：与单张图片相同的上下文菜单（Reka 下拉，打开时向 EP 计数器取号，压在预览之上） -->
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
import { imageTitleName, useWindowTitlePart } from "@/composables/useWindowTitle";
import { FAVORITE_ALBUM_ID, HIDDEN_ALBUM_ID } from "@/services/albums";
import type { Component, Ref } from "vue";
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { Subscription } from "rxjs";
import {
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Maximize,
  Minimize,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Trash2,
  X,
  ZoomIn,
  ZoomOut,
} from "@lucide/vue";
import { DialogClose, DialogContent, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from "reka-ui";
import { Button, Tooltip } from "@/components/ui";
import { isInAnyLayer, keepOpenOnForeign } from "@/components/ui/compat";
import { useLocalStorage } from "@vueuse/core";
import { useI18n } from "@kabegame/i18n";
import type { ImageInfo } from "../../types/image";
import ImageContent from "../image/ImageContent.vue";
import WallpaperPreviewCanvas, { type CoverRegionScope } from "../wallpaper/WallpaperPreviewCanvas.vue";
import ImageLabelsPanel from "../image/ImageLabelsPanel.vue";
import PswpSlideContent from "./PswpSlideContent.vue";
import ImageBasicInfoPanel, {
  type ImageDetailGalleryFilterTarget,
  type ImageDetailSurfRecordTarget,
} from "./ImageBasicInfoPanel.vue";
import ImageNativeMetadataPanel from "./ImageNativeMetadataPanel.vue";
import ImagePluginDescriptionPanel from "./ImagePluginDescriptionPanel.vue";
import WpeWebPropertiesPanel from "../wallpaper/WpeWebPropertiesPanel.vue";
import KbResizable from "./KbResizable.vue";
import PreviewControlBar from "./PreviewControlBar.vue";
import PreviewRangeSlider from "./PreviewRangeSlider.vue";
import VideoControls from "./VideoControls.vue";
import { useSettingsStore } from "../../stores/settings";
import { useKameMessageStore } from "../../stores/kameMessage";
import ActionRenderer from "../ActionRenderer.vue";
import { resolveActionIcon, type ActionItem, type ActionContext } from "../../actions/types";
import type { ImageActionContext } from "../../actions/imageActions";
import { captureWpeCover, clearWpeSceneStorage } from "../../utils/wpeWallpaperCommands";
// @ts-expect-error - Vue SFC component import, types resolved via package.json exports
import PhotoSwipe from "photoswipe-vue/vue";
import "photoswipe-vue/photoswipe.css";
import { usePanzoomPreview } from "../../composables/usePanzoomPreview";
import { useAudioKeepAlive } from "../../composables/useAudioKeepAlive";
import { usePreviewMediaSession } from "../../composables/usePreviewMediaSession";
import { useModal } from "../../composables/useModal";
import { compatibleToUrl, fileToUrl, thumbnailToUrl } from "../../utils/fileUrl";
import { fetchImageById } from "../../utils/imageRow";
import { batchWindow, imagePatches$, on, triggers$ } from "../../services/kbEvents";
import {
  hasWpeUserProperties,
  isNativeMetadataEligible,
  isVideoPlaybackType,
  isWpeSceneType,
  isWpeVideoType,
  isWpeWallpaperContentType,
} from "../../utils/mediaMime";
import type { Plugin } from "@/stores/plugins";
import { IS_ANDROID, IS_WEB } from "@/env.ts";

const { t } = useI18n();
/** 与模板 v-if 一致：Android（含平板宽屏）一律用 PhotoSwipe，不能按 isCompact 宽度断点判断。 */
const USE_PSWP = IS_ANDROID;
const settingsStore = useSettingsStore();
const previewModal = useModal({ layers: 3 });
const previewContextMenu = useModal();
const previewFullscreenZIndex = computed(() => previewModal.zIndex.value);
const previewOverlayZIndex = computed(() => previewModal.zIndex.value + 10);
const previewControlZIndex = computed(() => previewModal.zIndex.value + 20);
const kameMessageStore = useKameMessageStore();
/** 每个预览实例各占一个隐藏来源，多实例互不覆盖 */
const kamechanHideOwner = `image-preview-${Math.random().toString(36).slice(2)}`;

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
  /** 与 open-gallery-filter 同理：不在此处关闭预览，由上层导航完成后再关 */
  (e: "open-color-sort", hex: string): void;
  (e: "open-surf-record", target: ImageDetailSurfRecordTarget): void;
  /** 用户要求切换；上层算出目标并回设 props.image */
  /** source：用户手动（箭头 / 键盘 / 滑动）还是幻灯片自动播放；上层只用手动翻页推断「自动」切图方向 */
  (e: "switch", payload: { direction: "prev" | "next"; source: "manual" | "slideshow" }): void;
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
const isPreviewVideo = computed(() => isVideoPlaybackType(previewImage.value?.type));
/** 非视频 WPE 壁纸（web / scene）：壁纸画布内嵌壁纸组件，WPE 视频仍是视频预览。 */
const isPreviewWallpaper = computed(() => isWpeWallpaperContentType(previewImage.value?.type));
/** 网页与场景只在桌面实时运行（`wpe` feature），Android / Web 只显示预览图，没有可暂停的实例 */
const previewWallpaperLive = computed(() => !IS_ANDROID && !IS_WEB && isPreviewWallpaper.value);
/** 预览这一份的暂停状态，切图时复位；桌面的暂停是设置 `wallpaperPaused`，互不影响 */
const wallpaperPaused = ref(false);
/** 网页壁纸加载完；场景退回预览图时也会置位，所以场景看 `previewSceneLive` */
const previewWallpaperReady = ref(false);
const previewSceneLive = ref(false);
/** 画面确定在实时渲染：场景出了首帧，网页 iframe 加载完。之前与退回预览图时为假，暂停与设为封面置灰 */
const previewRendering = computed(() =>
  isWpeSceneType(previewImage.value?.type) ? previewSceneLive.value : previewWallpaperReady.value,
);
/** 场景的分辨率，画布按它定比例；网页壁纸没有宽高，透视场景读不到 */
const previewWallpaperSize = computed(() => {
  const image = previewImage.value;
  return image?.width && image?.height ? { width: image.width, height: image.height } : null;
});
const wallpaperCanvasRef = ref<InstanceType<typeof WallpaperPreviewCanvas> | null>(null);
/** 预览的封面截取来源：主窗口里的画布，用户看到什么就截到什么。点击时才取画布，区域也是那时才量 */
const previewCoverSource: CoverRegionScope = (run) => {
  const canvas = wallpaperCanvasRef.value;
  return canvas ? canvas.withCaptureRegion(run) : Promise.reject(new Error("wallpaper canvas is not mounted"));
};
/** Panzoom 图片分支的条件。 */
const isPreviewStatic = computed(() => !isPreviewVideo.value && !isPreviewWallpaper.value);

// 桌面预览视频期间保持音频输出设备常驻，避免暂停后恢复播放漏掉开头声音
const audioKeepAlive = useAudioKeepAlive();
usePreviewMediaSession(previewImage, previewVisible);
const desktopVideoActive = computed(
  () => !USE_PSWP && previewVisible.value && (isPreviewVideo.value || isPreviewWallpaper.value),
);
watch(desktopVideoActive, (active) => {
  if (active) audioKeepAlive.start();
  else audioKeepAlive.stop();
});
const previewHoverSide = ref<"left" | "right" | null>(null);
const previewNotFound = ref(false);
const isAppFullscreen = ref(false);
const previewShouldHideKamechan = computed(() => (USE_PSWP ? previewVisible.value : isAppFullscreen.value));

const previewContainerRef = ref<HTMLElement | null>(null);
const previewContentRef = ref<InstanceType<typeof ImageContent> | null>(null);
/** 桌面预览视频：从 ImageContent 暴露的 videoEl 取，供 VideoControls 绑定 */
const previewVideoEl = computed<HTMLVideoElement | null>(() => previewContentRef.value?.videoEl ?? null);
/** 紧凑模式 PhotoSwipe slot：用 item.id 反查三项窗口 */
/** 与 PhotoSwipe 数据源同一份窗口（含关闭动画期间的冻结），否则冻结的幻灯片找不到图会被 v-if 收掉。 */
const imageById = (id: string | number | undefined): ImageInfo | null =>
  pswpWindow.value.find((img) => img.id === id) ?? null;
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

const getOriginalPreviewUrl = (image: ImageInfo) => {
  // 目录型壁纸的 local_path 不是文件：播放只走 compatible_path（入口视频本身或兼容副本）。
  if (isWpeVideoType(image.type)) {
    const compatible = normalizeDesktopPath(image.compatiblePath);
    return compatible ? compatibleToUrl(compatible) : "";
  }
  return toFileUrl(image.localPath);
};

const getThumbnailPreviewUrl = (image: ImageInfo) => {
  const thumbPath = image.thumbnailPath;
  const normalized = normalizeDesktopPath(thumbPath);
  if (normalized && normalized !== normalizeDesktopPath(image.localPath)) {
    return thumbnailToUrl(normalized);
  }
  return getOriginalPreviewUrl(image);
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
  computed(() => !USE_PSWP),
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
  kameMessageStore.setKamechanHidden(kamechanHideOwner, hidden);
};

useWindowTitlePart("preview", () => (previewVisible.value ? imageTitleName(previewImage.value) : ""));
const previewDialogTitle = computed(() => imageTitleName(previewImage.value) || "图片预览");

const isTextInputLike = (target: EventTarget | null) => {
  const el = target as HTMLElement | null;
  const tag = el?.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || !!el?.isContentEditable;
};

const isButtonLike = (target: EventTarget | null) => {
  const el = target as HTMLElement | null;
  return !!el?.closest?.('button, [role="button"]');
};

/**
 * 紧凑模式 PhotoSwipe：三项滑动窗口 `[prev, current, next]`，内容由上层按 id 实时算出。
 * 页边界或视图外时不足三项，所以**当前位不恒为 1**，必须显式算（见 pswpCurrentIndex）。
 *
 * 窗口和下标都是上层状态的投影，单向下发；回流只有用户手势：
 * - 用户滑动落定（swipe）或在窗口边缘继续滑（reach-boundary）→ 和桌面箭头一样 requestSwitch(方向)；
 * - 上层挪动 previewedId → 重算窗口与下标 → PhotoSwipe 先按 id 重定位、再收敛到下标。
 *   滑动后上层算出的新窗口里当前图正是 PhotoSwipe 已经停住的那张，所以通常是 no-op。
 * PhotoSwipe 的 change 不回流：它也会由初始化、重定位、程序导航触发，不能当作用户翻页。
 */
/**
 * 关闭动画期间冻结：弹窗一关上层就清掉 previewedId（见 notifyCompactPreviewClose），窗口
 * 会立即变空；不冻结的话 PhotoSwipe 的幻灯片在关闭动画一开始就被抽走，只剩背景淡出。
 * 重新打开时 previewVisible 先变 true，窗口照常跟上层走。
 */
let lastPswpWindow: ImageInfo[] = [];
const pswpWindow = computed<ImageInfo[]>(() => {
  const items = [props.prevImage, previewImage.value, props.nextImage].filter((img): img is ImageInfo => !!img);
  if (!previewVisible.value && items.length === 0) return lastPswpWindow;
  lastPswpWindow = items;
  return items;
});

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
    const isVideo = isVideoPlaybackType(img.type);
    const thumbUrl = getThumbnailPreviewUrl(img);
    return {
      src: url,
      type: isVideo ? "video" : "image",
      mime: isVideo && img.type?.startsWith("video/") ? img.type : undefined,
      poster: isVideo && thumbUrl !== url ? thumbUrl : undefined,
      controls: isVideo ? true : undefined,
      playsInline: isVideo ? true : undefined,
      width: img.width || fallbackW,
      height: img.height || fallbackH,
      id: img.id,
    };
  });
});

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
let imageSubscription: Subscription | null = null;

const stopImageSubscription = () => {
  imageSubscription?.unsubscribe();
  imageSubscription = null;
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

const PREVIEW_REFRESH_WAIT_MS = 300;

const startImageSubscription = (id: string) => {
  stopImageSubscription();
  const subscription = new Subscription();
  // 字段补丁只改「当前 id 的内容」，绝不改「当前 id 本身」
  subscription.add(
    imagePatches$(PREVIEW_REFRESH_WAIT_MS, { patchHidden: () => true }).subscribe((patches) => {
      const fields = patches.get(id);
      if (currentId.value !== id || !fields || !resolvedImage.value) return;
      resolvedImage.value = { ...resolvedImage.value, ...fields };
    }),
  );
  // 粗信号：重拉一次。确认 0 行才算消失——这里 emit resolve-failed，
  // 不是跳下一张；跳不跳是上层的事（它有列表和用户意图）。
  subscription.add(
    triggers$([
      // 字段直接打补丁；删除仅在包含当前图片时重解析。
      on("images-deleted", (p) => p.imageIds.includes(id)),
      // 收藏 / 隐藏由 imagePatches$ 补丁保鲜，普通画册成员变化才重解析
      on(
        "album-images-added",
        (p) => ![FAVORITE_ALBUM_ID, HIDDEN_ALBUM_ID].includes(p.albumId) && p.imageIds.includes(id),
      ),
      on(
        "album-images-deleted",
        (p) => ![FAVORITE_ALBUM_ID, HIDDEN_ALBUM_ID].includes(p.albumId) && p.imageIds.includes(id),
      ),
    ])
      .pipe(batchWindow(PREVIEW_REFRESH_WAIT_MS, () => true))
      .subscribe(() => {
        if (currentId.value === id) void resolveCurrentImage(id);
      }),
  );
  imageSubscription = subscription;
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
    if (id !== prevId || !imageSubscription) {
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
  wallpaperPaused.value = false;
  previewWallpaperReady.value = false;
  previewSceneLive.value = false;
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

const requestSwitch = (direction: "prev" | "next", source: "manual" | "slideshow" = "manual") => {
  if (!previewVisible.value) return;
  if (navPending.value) return;
  if (!canGo(direction)) return;
  navPending.value = true;
  emit("switch", { direction, source });
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
    requestSwitch(direction, "slideshow");
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

/** 在视口坐标处弹出上下文菜单；已经开着时挪到新位置 */
const openPreviewContextMenuAt = (point: { x: number; y: number }) => {
  if (!previewImage.value) return;
  if (!props.actions?.length) return;
  previewContextMenuPosition.value = { x: point.x, y: point.y };
  previewContextMenu.open();
};

const handlePreviewDialogContextMenu = (event: MouseEvent) => {
  openPreviewContextMenuAt({ x: event.clientX, y: event.clientY });
};

const closePreviewContextMenu = () => {
  previewContextMenu.close();
};

/** 桌面对话框：Esc、点遮罩、右上角 × 都经这里关闭（开只由 props.image 驱动） */
const handleDialogOpenChange = (open: boolean) => {
  if (!open) closePreview();
};
/** 打开时焦点落在对话框本身，而不是第一个按钮（侧栏开关平时是透明的） */
const handleDialogOpenAutoFocus = (event: Event) => {
  event.preventDefault();
  // Reka 把这个事件派发在对话框内容元素上
  (event.target as HTMLElement | null)?.focus?.({ preventScroll: true });
};
/**
 * 点到吉祥物不关预览：它按栈位浮在预览之上，原来的 EP 对话框只在点遮罩本身时才关。
 * 点到旧浮层（属性面板里共用表单控件的 EP 下拉、取色器）也不关。
 */
const handleDialogPointerDownOutside = (event: Event & { detail?: { originalEvent?: Event } }) => {
  const target = event.detail?.originalEvent?.target ?? event.target;
  if (target instanceof Element && target.closest(".kamechan-host")) {
    event.preventDefault();
    return;
  }
  keepOpenOnForeign(event);
};

/** 设为封面进行中：菜单项与工具条按钮置灰，也挡住重复触发 */
const coverBusy = ref(false);

const previewActionContext = computed<ImageActionContext>(() => ({
  target: previewImage.value,
  selectedIds: previewImage.value ? new Set([previewImage.value.id]) : new Set<string>(),
  selectedCount: previewImage.value ? 1 : 0,
  // 实例状态只在弹窗里：画廊的菜单不带它，依赖实例的项不显示
  wallpaperPreview: previewWallpaperLive.value
    ? { live: previewRendering.value, paused: wallpaperPaused.value, coverBusy: coverBusy.value }
    : undefined,
}));

/**
 * 设为封面：截的是这一份预览的画面。截取期间盖在画布上的工具条、箭头等按 `data-kb-cover-capture` 隐藏（见样式），
 * 从工具条或右键菜单点的时候它们正显示着。
 */
async function setPreviewCover(imageId: string) {
  if (coverBusy.value || !previewRendering.value) return;
  coverBusy.value = true;
  try {
    await captureWpeCover(imageId, previewCoverSource, t);
  } finally {
    coverBusy.value = false;
  }
}

/** 只对这一份实例有意义的命令由弹窗自己处理，不交给上层（上层不知道画面出没出来）。处理了返回 true */
function handleWallpaperCommand(command: string, image: ImageInfo): boolean {
  if (command === "pauseWallpaper") {
    if (previewRendering.value) wallpaperPaused.value = !wallpaperPaused.value;
    return true;
  }
  if (command === "setCover") {
    void setPreviewCover(image.id);
    return true;
  }
  if (command === "clearStorage") {
    void clearWpeSceneStorage(image.id, t);
    return true;
  }
  return false;
}

// 壁纸预览的工具条按钮：右键菜单的可见项按原顺序平铺（桌面菜单没有子菜单）
const wallpaperBarActions = computed(() => {
  const ctx = previewActionContext.value;
  return props.actions
    .filter((action) => action.command && action.icon && (action.visible === undefined || action.visible(ctx)))
    .map((action, index) => {
      const label = typeof action.label === "function" ? action.label(ctx) : action.label;
      const suffix = typeof action.suffix === "function" ? action.suffix(ctx) : action.suffix;
      const divider = typeof action.dividerBefore === "function" ? action.dividerBefore(ctx) : action.dividerBefore;
      return {
        key: action.key,
        command: action.command!,
        label: suffix ? `${label} ${suffix}` : label,
        // 同 ActionRenderer：iconBy 包出来的解析器按上下文解析，图标组件原样用
        icon: resolveActionIcon(action.icon, ctx),
        disabled: typeof action.disabled === "function" ? action.disabled(ctx) : !!action.disabled,
        divider: index > 0 && !!divider,
      };
    });
});

const handlePswpActionClose = () => {
  if (USE_PSWP) {
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
  if (USE_PSWP) {
    // 紧凑模式（PhotoSwipe）：hide PSWP UI after command
    // ActionSheet 的 handleClick 会同时 emit command 和 close，所以这里不需要再调用 setUiVisible
    // close 事件会通过 handlePswpActionClose 处理 UI 隐藏
  } else {
    closePreviewContextMenu();
  }
  if (handleWallpaperCommand(command, payload.image)) return;
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

// 从箭头区移进网页壁纸 iframe 后容器再也收不到 mousemove，只能在离开时收起
const handleNavZoneLeave = (event: MouseEvent) => {
  if ((event.relatedTarget as Element | null)?.tagName === "IFRAME") previewHoverSide.value = null;
};

const handlePreviewWheel = (event: WheelEvent) => {
  if (isPreviewVideo.value || isPreviewWallpaper.value) return;
  handlePanzoomWheel(event);
};

// stopPreviewDrag 已删除，由 Panzoom 自动处理（仅桌面端）

// Android 触摸手势处理

// ImageContent 内部已处理缩略图→原图流式覆盖与丢失态显示；这里只在内容就绪后对齐 Panzoom（桌面图片）。
const handlePreviewReady = () => {
  previewImageLoading.value = false;
  previewWallpaperReady.value = true;
  if (USE_PSWP || isPreviewVideo.value || isPreviewWallpaper.value) return;
  void measureContainerAfterRender().then(() => {
    panzoomReset();
  });
};

const consumePreviewShortcut = (event: KeyboardEvent) => {
  event.preventDefault();
  event.stopPropagation();
};

const togglePreviewVideoPlayback = () => {
  const video = previewVideoEl.value;
  if (!video) return;
  if (video.paused || video.ended) {
    void video.play().catch(() => {
      // 播放可能因媒体尚未就绪或平台策略被拒绝，保持当前暂停态即可。
    });
  } else {
    video.pause();
  }
};

const seekPreviewVideoBy = (seconds: number) => {
  const video = previewVideoEl.value;
  if (!video) return;
  const currentTime = Number.isFinite(video.currentTime) ? video.currentTime : 0;
  const maxTime = Number.isFinite(video.duration) ? video.duration : Number.POSITIVE_INFINITY;
  video.currentTime = Math.min(maxTime, Math.max(0, currentTime + seconds));
};

/** 事件目标在预览之上的另一层浮层里（预览自己也是 Reka 对话框，所以要排除它本身） */
const isInPreviewSubLayer = (target: EventTarget | null) => {
  if (!(target instanceof Element) || !isInAnyLayer(target)) return false;
  return !target.closest(".image-preview-dialog");
};

const handlePreviewKeyDown = (event: KeyboardEvent) => {
  if (!previewVisible.value) return;
  // 预览里再弹出的浮层（右键菜单、属性面板的选择框 / 气泡）自己处理方向键与回车，预览不翻页
  if (isInPreviewSubLayer(event.target)) return;
  const target = event.target as HTMLInputElement | null;
  const isRangeArrow =
    target?.tagName === "INPUT" && target.type === "range" && (event.key === "ArrowLeft" || event.key === "ArrowRight");
  if (isTextInputLike(event.target) && !isRangeArrow) return;
  // 侧栏里自带方向键语义的控件（滑块、分段 / 单选、标签页）：方向键交给控件，不翻页
  if (
    (event.key === "ArrowLeft" || event.key === "ArrowRight") &&
    (event.target as Element | null)?.closest?.("[role=slider],[role=radio],[role=tab],[role=spinbutton]")
  )
    return;
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
  const isBareSpace =
    (event.code === "Space" || event.key === " ") &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    !event.shiftKey;
  if (isPreviewVideo.value && isBareSpace && !isButtonLike(event.target)) {
    consumePreviewShortcut(event);
    if (!event.repeat) togglePreviewVideoPlayback();
    return;
  }
  const isVideoSeekShortcut =
    isPreviewVideo.value &&
    (event.ctrlKey || event.metaKey) &&
    !event.altKey &&
    !event.shiftKey &&
    (event.key === "ArrowLeft" || event.key === "ArrowRight");
  if (isVideoSeekShortcut) {
    consumePreviewShortcut(event);
    seekPreviewVideoBy(event.key === "ArrowLeft" ? -5 : 5);
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
  if (!USE_PSWP) return;
  previewModal.close();
  videoPaused.value = false;
  if (longPressTimer) {
    clearTimeout(longPressTimer);
    longPressTimer = null;
  }
  closePreviewContextMenu();
}

/**
 * 紧凑模式下每次打开只通知上层一次关闭。返回键等外部路径只关掉 previewModal，PhotoSwipe
 * 的 close 要等关闭动画结束才发；这段动画期间上层 previewedId 还在，下载刷新换入同 id 的
 * 新 ImageInfo 会让 props.image 的 watch 把预览重新打开（看起来就是「按返回没反应」）。
 * 所以弹窗一关就立刻通知，动画结束时的那次由这里去重。
 */
let compactCloseNotified = false;
function notifyCompactPreviewClose(image: ImageInfo | null) {
  if (compactCloseNotified) return;
  compactCloseNotified = true;
  emit("preview-close", { image });
}

watch(previewVisible, (visible) => {
  if (!USE_PSWP) return;
  if (visible) {
    compactCloseNotified = false;
    return;
  }
  notifyCompactPreviewClose(previewImage.value);
});

const closePreview = () => {
  const closedImage = previewImage.value;
  isAppFullscreen.value = false;
  if (USE_PSWP) {
    previewModal.close();
    doAndroidPreviewCleanup();
    notifyCompactPreviewClose(closedImage);
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
    if (visible && !USE_PSWP) {
      await nextTick();
      await measureContainerAfterRender();
    }
  },
);

watch(
  () => previewImage.value?.id,
  (id) => {
    if (id && !USE_PSWP) {
      if (isPreviewVideo.value || isPreviewWallpaper.value) return;
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

/** PhotoSwipe 当前停住的那张；只用来判断显示的图是否真的换了，不回流给上层 */
let pswpShownId: string | null = null;

/** 只重置本地手势 / 播放状态。同一张图被重定位（下载刷新、窗口平移）时不算换图。 */
const handlePswpChange = ({ index }: { index: number }) => {
  if (!USE_PSWP || index < 0) return;
  const target = pswpWindow.value[index];
  if (!target || target.id === pswpShownId) return;
  pswpShownId = target.id;

  initialPanY = null;
  if (verticalDragResetTimer) {
    clearTimeout(verticalDragResetTimer);
    verticalDragResetTimer = null;
  }
  swipeDeleteActive.value = false;
  swipeDeleteReady.value = false;
  isFromVerticalDrag = false;
  videoPaused.value = false;
};

/** 用户滑动已落定：和桌面箭头一样请求上层切图，上层回设的新窗口通常与当前显示一致。 */
const handlePswpSwipe = ({ direction }: { direction: "prev" | "next"; index: number }) => {
  if (!USE_PSWP) return;
  requestSwitch(direction);
};

const handlePswpReachBoundary = ({ direction }: { direction: "prev" | "next"; index: number }) => {
  if (!USE_PSWP) return;
  // 窗口边缘 ≠ 列表边界：是不是真的到头由上层的 canPrev / canNext 说了算
  requestSwitch(direction);
};

/** Android：视频幻灯片双击切换播放/暂停（photoswipe-vue 只对 video 类型 slide 触发） */
const handleVideoDoubleTap = () => {
  videoPaused.value = !videoPaused.value;
};

const handleVideoPlayFail = () => {
  if (!USE_PSWP) return;
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
  notifyCompactPreviewClose(closedImage);
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

if (!USE_PSWP) {
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
 * 紧凑模式下打开与窗口 / 下标在同一轮渲染下发，PhotoSwipe 初始化时读到的就是当前图。
 */
watch(
  () => props.image,
  (value) => {
    if (value) {
      if (!previewVisible.value) {
        previewModal.open();
        videoPaused.value = false;
        pswpShownId = null;
      }
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
.image-preview-dialog {
  .preview-desktop-body {
    display: flex;
    flex-direction: row;
    flex: 1 1 auto;
    min-height: 0;
    min-width: 0;
    width: 100%;
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

    /* 截壁纸封面时只留壁纸画布：工具条、箭头、抽屉开关都盖在画布上，从工具条或右键菜单点「设为封面」时它们正显示着
       （WallpaperPreviewCanvas 的 withCaptureRegion 设这个属性并等两帧） */
    html[data-kb-cover-capture] & > :not(.preview-wallpaper-wrapper) {
      visibility: hidden;
    }

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

  /* 叠在画面上的圆形按钮（侧栏开关、全屏退出、翻页箭头、幻灯片）：深色半透明 + 白色图标，在任何壁纸上都看得清 */
  .preview-detail-toggle,
  .preview-fullscreen-close,
  .preview-nav-btn,
  .preview-slideshow-btn {
    box-sizing: border-box;
    padding: 0;
    border: 0;
    border-radius: 999px;
    background: rgba(16, 14, 20, 0.42);
    color: #fff;
    font: inherit;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    user-select: none;
    backdrop-filter: blur(8px);
    transition:
      opacity 0.12s ease,
      background-color 0.15s ease,
      transform 0.12s ease;

    &:hover {
      background: rgba(16, 14, 20, 0.62);
    }

    &:active {
      transform: scale(0.96);
    }

    &:focus-visible {
      outline: none;
      box-shadow: 0 0 0 2px var(--kb-ring);
    }
  }

  .preview-detail-toggle,
  .preview-fullscreen-close {
    position: absolute;
    top: 12px;
    right: 12px;
    z-index: 4;
    width: 36px;
    height: 36px;

    svg {
      width: 18px;
      height: 18px;
    }
  }

  .preview-detail-toggle {
    opacity: 0;
    pointer-events: none;

    &.visible {
      opacity: 0.72;
      pointer-events: auto;
    }

    &.visible:hover {
      opacity: 1;
    }
  }

  .preview-fullscreen-close {
    opacity: 0.72;

    &:hover {
      opacity: 1;
    }
  }

  .preview-detail-toggle-left {
    right: auto;
    left: 12px;
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
    background: var(--kb-surface-raised);
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
      border-left-color: var(--kb-line);
    }

    &.is-resizing {
      transition: none;
    }
  }

  .preview-detail-drawer-left {
    border-right: 1px solid transparent;
    border-left: 0;

    &.is-open {
      border-right-color: var(--kb-line);
      border-left-color: transparent;
    }
  }

  .preview-detail-drawer-scroll {
    height: 100%;
    overflow-x: hidden;
    overflow-y: auto;
    padding: 12px;
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

    svg {
      width: 22px;
      height: 22px;
    }

    &.disabled {
      opacity: 0.45;
    }
  }

  // 只在网页壁纸预览时渲染：叠在 iframe 上、低于箭头区，只占箭头所在的中段以少挡页面交互
  .preview-nav-hotzone {
    position: absolute;
    top: 30%;
    bottom: 30%;
    width: min(20%, 96px);
    z-index: 1;

    &.left {
      left: 0;
    }

    &.right {
      right: 0;
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
    justify-content: flex-start;
    overflow: hidden;
    transform: translateX(-50%);

    &:active {
      transform: translateX(-50%) scale(0.96);
    }

    /* 播放中用强调色，和「选中」同一语义 */
    &.playing,
    &.playing:hover {
      background: var(--kb-accent);
    }

    svg {
      flex: none;
      width: 28px;
      height: 14px;
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

.pswp-image-title-container {
  color: #fff;
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
