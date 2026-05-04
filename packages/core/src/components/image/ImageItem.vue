<template>
  <div ref="rootEl" class="image-item" :class="[
    {
      'image-item-selected': selected,
      'item-entering': enteringClassActive,
      'item-leaving': isLeaving,
      'image-item-android': isCompact,
      'image-item-hidden': image.isHidden,
      'image-item-fill': fillBox,
      'image-item-horizontal': horizontal,
    },
    thumbnailObjectPositionClass,
  ]" :style="rootStyle" :data-id="image.id" @contextmenu.prevent="$emit('contextmenu', $event)" @animationend="handleAnimationEnd">
    <!-- 本地文件缺失标识：不阻挡点击/选择/右键 -->
    <el-tooltip v-if="originalMissing && !isLost" content="这张图片找不到了" placement="top" :show-after="300">
      <div class="missing-file-badge">
        <el-icon :size="14">
          <WarningFilled />
        </el-icon>
      </div>
    </el-tooltip>
    <!-- 视频标识：右上角播放/暂停切换按钮（可控视频，video 元素） -->
    <div v-if="isControllableVideo" class="video-play-badge video-play-badge-interactive"
      role="button" :aria-label="videoPlaying ? '暂停' : '播放'"
      @click.stop="handleToggleVideoPlay" @dblclick.stop @contextmenu.stop.prevent>
      <el-icon :size="14">
        <VideoPause v-if="videoPlaying" />
        <VideoPlay v-else />
      </el-icon>
    </div>
    <!-- 视频标识：GIF 等不可控形态，仅作为静态指示 -->
    <div v-else-if="isVideo" class="video-play-badge" aria-hidden="true">
      <el-icon :size="14">
        <VideoPlay />
      </el-icon>
    </div>
    <transition name="fade-in" mode="out-in">
      <div v-if="!displayUrl" key="loading" class="image-wrapper" :style="aspectRatioStyle"
        @dblclick.stop="$emit('dblclick', $event)" @contextmenu.prevent.stop="$emit('contextmenu', $event)"
        @click.stop="handleWrapperClick" @touchstart="handleTouchStart" @touchmove="handleTouchMove"
        @touchend="handleTouchEnd">
        <div v-if="isLost" class="thumbnail-lost">
          <ImageNotFound :show-image="false" />
        </div>
        <!-- 与 content 分支一致：loading 骨架使用 overlay 绝对铺满；视频不用 image 形骨架，避免中央出现图片占位 -->
        <div v-else class="thumbnail-loading thumbnail-loading-overlay">
          <el-skeleton v-if="!isVideo" :rows="0" animated>
            <template #template>
              <el-skeleton-item variant="image" :style="{ width: '100%', height: '100%' }" />
            </template>
          </el-skeleton>
        </div>
      </div>
      <div v-else key="content" class="image-wrapper" :style="aspectRatioStyle"
        @dblclick.stop="$emit('dblclick', $event)" @contextmenu.prevent.stop="$emit('contextmenu', $event)"
        @click.stop="handleWrapperClick" @touchstart="handleTouchStart" @touchmove="handleTouchMove"
        @touchend="handleTouchEnd">
        <!-- 加载期间显示骨架覆盖层；视频不叠 image 形骨架（与预览弹窗一致，避免中央图片占位） -->
        <div v-if="isImageLoading && !isVideo" class="thumbnail-loading thumbnail-loading-overlay">
          <el-skeleton :rows="0" animated>
            <template #template>
              <el-skeleton-item variant="image" :style="{ width: '100%', height: '100%' }" />
            </template>
          </el-skeleton>
        </div>
        <!-- 桌面双图：先缩略图，原图加载后淡入 -->
        <template v-if="!isCompact && useDesktopLayers && !isVideo">
          <img v-if="!thumbnailLoadFailed" :src="thumbnailUrl" loading="lazy" decoding="async"
            class="thumbnail thumbnail-layer" :alt="image.id" draggable="false" @load="handleThumbnailLoad"
            @error="handleThumbnailError" />
          <img :src="originalUrl" loading="lazy" decoding="async"
            :class="['thumbnail', 'original-layer', { 'original-layer-visible': originalLoaded }]" :alt="image.id"
            draggable="false" @load="handleOriginalLoad" @error="handleOriginalError" />
        </template>
        <!-- GIF 缩略图（历史数据与 Android）：用 img；mp4 缩略图：用 video 元素 -->
        <img v-else-if="isVideoRenderedAsImage" :src="displayUrl" loading="lazy" decoding="async"
          :class="['thumbnail', { 'thumbnail-loading': isImageLoading, 'thumbnail-hidden': isImageLoading, 'thumbnail-android': isCompact }]"
          :style="{ visibility: isImageLoading ? 'hidden' : 'visible' }" :alt="image.id" draggable="false"
          @load="handleImageLoad" @error="handleImageError" />
        <video v-else-if="isVideo" ref="videoEl" :src="displayUrl" class="thumbnail" draggable="false" muted loop poster=""
          preload="auto" playsinline webkit-playsinline="true" disablepictureinpicture="true" disableremoteplayback=""
          @dragstart.prevent @mousedown.prevent />
        <!-- 单图（桌面无独立缩略图） -->
        <img v-else-if="true" :src="displayUrl" loading="lazy" decoding="async"
          :class="['thumbnail', { 'thumbnail-loading': isImageLoading, 'thumbnail-hidden': isImageLoading, 'thumbnail-android': isCompact }]"
          :style="{ visibility: isImageLoading ? 'hidden' : 'visible' }" :alt="image.id" draggable="false"
          @load="handleImageLoad" @error="handleImageError" />
      </div>
    </transition>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onUnmounted, watch, watchEffect } from "vue";
import { ref, toRef } from "vue";
import { WarningFilled, VideoPlay, VideoPause } from "@element-plus/icons-vue";
import type { ImageInfo } from "../../types/image";
import type { ImageClickAction } from "../../stores/settings";
import ImageNotFound from "../common/ImageNotFound.vue";
import { useImageItemLoader } from "../../composables/useImageItemLoader";
import { useSettingsStore } from "../../stores/settings";
import { isVideoMediaType } from "../../utils/mediaMime";
import { storeToRefs } from "pinia";
import { useUiStore } from "@kabegame/core/stores/ui";

interface Props {
  image: ImageInfo;
  imageClickAction: ImageClickAction;
  windowAspectRatio?: number; // 窗口宽高比
  selected?: boolean; // 是否被选中
  gridColumns?: number; // 网格列数
  gridIndex?: number; // 在网格中的索引
  isEntering?: boolean; // 是否正在入场（用于虚拟滚动的动画）
  isLeaving?: boolean; // 是否正在离开（用于虚拟滚动的动画）
  fillBox?: boolean; // gallery 布局：盒宽高比等于图片自然比，填满且不留 letterbox 背景
  horizontal?: boolean; // 水平方向：盒子用 height: 100% 撑满主轴，width 由 aspect-ratio 决定
  videoPlaying?: boolean; // 视频是否正在播放（由上层控制，确保同一时间只有一个视频在播放）
}

const props = withDefaults(defineProps<Props>(), {
  videoPlaying: false,
});

const emit = defineEmits<{
  click: [event?: MouseEvent];
  dblclick: [event?: MouseEvent];
  contextmenu: [event: MouseEvent];
  longpress: []; // Android 长按事件
  enterAnimationEnd: []; // 入场动画结束
  leaveAnimationEnd: []; // 退场动画结束
  toggleVideoPlay: []; // 用户点击右上角播放/暂停按钮，由上层决定是否切换播放状态
}>();

const imageRef = toRef(props, "image");
const gridColumnsRef = toRef(props, "gridColumns");

const rootEl = ref<HTMLElement | null>(null);
const settingsStore = useSettingsStore();
const { isCompact } = storeToRefs(useUiStore());
// 仅桌面端视图：图片溢出方框时的垂直对齐（center/top/bottom），通过 class 控制 .thumbnail 的 object-position
const thumbnailObjectPositionClass = computed(() => {
  if (isCompact.value) return "";
  const pos = settingsStore.values.galleryImageObjectPosition;
  if (pos === "top") return "image-item--object-top";
  if (pos === "bottom") return "image-item--object-bottom";
  return "image-item--object-center";
});

// 虚拟滚动下挂载时已有 isEntering，若直接绑 class 浏览器可能不触发 CSS 动画；延迟一帧再加 class 以触发入场动画
const enteringClassActive = ref(false);
watch(
  () => props.isEntering,
  (isEntering) => {
    if (isEntering) {
      enteringClassActive.value = false;
      nextTick(() => {
        requestAnimationFrame(() => {
          enteringClassActive.value = true;
        });
      });
    } else {
      enteringClassActive.value = false;
    }
  },
  { immediate: true }
);

const {
  displayUrl,
  isImageLoading,
  isLost,
  originalMissing,
  thumbnailUrl,
  originalUrl,
  useDesktopLayers,
  thumbnailLoaded,
  originalLoaded,
  thumbnailLoadFailed,
  handleImageLoad,
  handleImageError,
  handleThumbnailLoad,
  handleOriginalLoad,
  handleThumbnailError,
  handleOriginalError,
} = useImageItemLoader({
  image: imageRef,
  gridColumns: gridColumnsRef,
});

// Android 长按检测
let longPressTimer: ReturnType<typeof setTimeout> | null = null;
let longPressFired = false;
let touchStartPos = { x: 0, y: 0 };
let touchMoved = false;

const handleTouchStart = (event: TouchEvent) => {
  if (!isCompact.value) return;
  if (event.touches.length !== 1) {
    // 多指触摸，取消长按检测
    if (longPressTimer) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
    return;
  }
  const touch = event.touches[0];
  touchStartPos = { x: touch.clientX, y: touch.clientY };
  touchMoved = false;
  longPressFired = false;

  longPressTimer = setTimeout(() => {
    if (!touchMoved && !longPressFired) {
      longPressFired = true;
      emit("longpress");
    }
    longPressTimer = null;
  }, 500);
};

const handleTouchMove = (event: TouchEvent) => {
  if (!isCompact.value) return;
  // 检测移动距离，超过阈值则取消长按
  if (event.touches.length === 1 && longPressTimer) {
    const touch = event.touches[0];
    const dx = Math.abs(touch.clientX - touchStartPos.x);
    const dy = Math.abs(touch.clientY - touchStartPos.y);
    if (dx > 10 || dy > 10) {
      touchMoved = true;
      if (longPressTimer) {
        clearTimeout(longPressTimer);
        longPressTimer = null;
      }
    }
  }
};

const handleTouchEnd = () => {
  if (!isCompact.value) return;
  if (longPressTimer) {
    clearTimeout(longPressTimer);
    longPressTimer = null;
  }
  // 如果长按已触发，标记需要跳过本次 click
  // 标记会在 handleWrapperClick 中使用，然后重置
};

onUnmounted(() => {
  if (longPressTimer) {
    clearTimeout(longPressTimer);
    longPressTimer = null;
  }
});

const aspectRatioStyle = computed(() => {
  // aspect-ratio = 宽 / 高；windowAspectRatio 本身就是宽/高
  const r = props.windowAspectRatio && props.windowAspectRatio > 0 ? props.windowAspectRatio : null;
  return r
    ? { aspectRatio: `${r}` }
    : { aspectRatio: "16 / 9" };
});
// 水平方向：把 aspect-ratio 也挂在 root 上，这样 flex 能基于 height 推导 width。
const rootStyle = computed<Record<string, string> | undefined>(() => {
  if (!props.horizontal) return undefined;
  return aspectRatioStyle.value as Record<string, string>;
});
const isVideo = computed(() => isVideoMediaType(props.image.type));

function pathFromUrlLike(value: string | undefined): string {
  const raw = (value || "").trim();
  if (!raw) return "";
  try {
    const u = new URL(raw, window.location.origin);
    const pathParam = u.searchParams.get("path");
    if (pathParam) return pathParam;
    return decodeURIComponent(u.pathname || raw);
  } catch {
    const noHash = raw.split("#", 1)[0] || "";
    const noQuery = noHash.split("?", 1)[0] || noHash;
    try {
      return decodeURIComponent(noQuery);
    } catch {
      return noQuery;
    }
  }
}

function hasPathExtension(value: string | undefined, ext: string): boolean {
  const path = pathFromUrlLike(value).trim().toLowerCase();
  return path.endsWith(`.${ext.toLowerCase()}`);
}

const displayPreviewPath = computed(() =>
  displayUrl.value || props.image.thumbnailPath || props.image.localPath
);
const isGifVideoPreview = computed(() => isVideo.value && hasPathExtension(displayPreviewPath.value, "gif"));
const isVideoRenderedAsImage = computed(() => isVideo.value && isGifVideoPreview.value);
// GIF 预览不可控；mp4 预览走 <video>，由上层统一控制播放/暂停。
const isControllableVideo = computed(() => isVideo.value && !isVideoRenderedAsImage.value);

const videoEl = ref<HTMLVideoElement | null>(null);

// 同步 videoPlaying 到真实 video 元素：true → play()；false → pause() 并复位到起点
watchEffect(() => {
  const el = videoEl.value;
  if (!el || !isControllableVideo.value) return;
  if (props.videoPlaying) {
    void el.play().catch(() => { /* 忽略浏览器拦截/卸载竞态 */ });
  } else {
    el.pause();
    try { el.currentTime = 0; } catch { /* 部分平台 currentTime 写入会抛 */ }
  }
});

const handleToggleVideoPlay = () => {
  emit("toggleVideoPlay");
};

const handleWrapperClick = (event?: MouseEvent) => {
  // Android 下，如果刚触发了长按，跳过本次 click
  if (isCompact.value && longPressFired) {
    longPressFired = false;
    return;
  }
  emit("click", event);
};

const handleAnimationEnd = (event: AnimationEvent) => {
  if (event.animationName === "itemEnter") {
    emit("enterAnimationEnd");
  } else if (event.animationName === "itemLeave") {
    emit("leaveAnimationEnd");
  }
};
</script>

<style scoped lang="scss">
.image-item {
  border: 2px solid var(--anime-border);
  border-radius: 16px;
  overflow: hidden;
  cursor: pointer;
  position: relative;
  transition: transform 0.25s cubic-bezier(0.4, 0, 0.2, 1), box-shadow 0.25s ease, border-color 0.25s ease;
  background: var(--anime-bg-card);
  box-shadow: var(--anime-shadow);
  box-sizing: border-box;
  will-change: transform, box-shadow;
  user-select: none;
  -webkit-tap-highlight-color: transparent;

  /* 隐藏图片：盖在所有图层（含桌面双图的原图 original-layer z-index:2 以及 video/GIF）最上面的半透明遮罩。
     `isolation: isolate` 让 image-wrapper 自成一层独立 stacking context，遮罩只在 wrapper 内部生效，
     而 .image-item 上的角标（video-play-badge / missing-file-badge）作为 wrapper 的兄弟节点仍显示在遮罩之上。 */
  &.image-item-hidden {
    .image-wrapper {
      isolation: isolate;

      &::after {
        content: "";
        position: absolute;
        inset: 0;
        z-index: 9;
        pointer-events: none;
        background: rgba(20, 20, 24, 0.55);
        border-radius: inherit;
      }
    }
  }

  /* Android：无背景、无边框，更紧凑 */
  &.image-item-android {
    border: none;
    background: transparent;
    box-shadow: none;
    border-radius: 0;

    .image-wrapper,
    .image-preview-wrapper {
      border-radius: 0;
    }

    .thumbnail.thumbnail-android {
      border-radius: 0;
      background: transparent;
    }

    &.image-item-selected {
      border: none;
      box-shadow: 0 0 0 2px rgba(255, 107, 157, 0.6);
      outline: none;
    }
  }

  html:not(.platform-android) &:hover {
    // transform: translateY(-6px) scale(1.015);
    // box-shadow: var(--anime-shadow-hover);
    outline: 3px solid var(--anime-primary-light);
    outline-offset: -2px;
  }

  &.image-item-selected {
    border-color: #ff6b9d;
    border-width: 2px;
    box-shadow:
      0 0 0 3px rgba(255, 107, 157, 0.4),
      0 0 20px rgba(255, 107, 157, 0.5),
      0 4px 12px rgba(255, 107, 157, 0.3);
    outline: 4px solid #ff6b9d;
    outline-offset: -2px;

    html:not(.platform-android) &:hover {
      border-color: #ff4d8a;
      outline: 5px solid #ff4d8a;
      outline-offset: -2px;
      box-shadow:
        0 0 0 3px rgba(255, 77, 138, 0.5),
        0 0 30px rgba(255, 107, 157, 0.6),
        0 6px 16px rgba(255, 107, 157, 0.4);
    }
  }

  .image-wrapper,
  .image-preview-wrapper {
    width: 100%;
    position: relative;
    cursor: pointer;
    overflow: hidden;
    border-radius: 14px 14px 0 0;
    will-change: contents;
    -webkit-tap-highlight-color: transparent;

    &::before {
      content: '';
      display: block;
      width: 100%;
    }
  }

  .thumbnail {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    border-radius: 14px 14px 0 0;
    object-fit: cover;
    will-change: contents, opacity;
    -webkit-tap-highlight-color: transparent;
  }

  /* 仅桌面端：图片溢出方框时的垂直对齐（Android 使用 contain，不适用） */
  &.image-item--object-top .thumbnail:not(.thumbnail-android) {
    object-position: center top;
  }

  &.image-item--object-bottom .thumbnail:not(.thumbnail-android) {
    object-position: center bottom;
  }

  &.image-item--object-center .thumbnail:not(.thumbnail-android) {
    object-position: center center;
  }

  .thumbnail {
    &.thumbnail-loading {
      animation: fadeInImage 0.4s ease-in;
    }

    // 桌面双图：底层缩略图
    &.thumbnail-layer {
      z-index: 1;
    }

    // 桌面双图：顶层原图，加载完成后淡入
    &.original-layer {
      z-index: 2;
      opacity: 0;
      transition: opacity 0.35s ease-in;

      &.original-layer-visible {
        opacity: 1;
      }
    }

    // Android 下使用 contain 模式，完整展示图片
    &.thumbnail-android {
      object-fit: contain;
      background: var(--anime-bg-card);
    }
  }

  /* 水平方向：item 在横向滚动容器里作为"列/行"的单元，
     应由 aspect-ratio 从 height 推导 width，而不是默认的 width → height。
     关键：flex-shrink: 0 防止在 width: max-content 容器内被挤压。 */
  &.image-item-horizontal {
    height: 100%;
    width: auto;
    flex-shrink: 0;
    .image-wrapper,
    .image-preview-wrapper {
      height: 100%;
      width: auto;
    }
  }

  /* gallery 填充模式：盒宽高比 = 图片自然比，用 cover 即可无裁切地铺满，
     且不需要 letterbox 背景色——避免加载过程中露出卡片色块。
     同时去掉所有圆角，让画廊列的瓷砖完全贴合。 */
  &.image-item-fill {
    border-radius: 0;

    .thumbnail.thumbnail-android {
      object-fit: cover;
      background: transparent;
    }

    .image-wrapper,
    .image-preview-wrapper {
      border-radius: 0;
    }

    .thumbnail {
      border-radius: 0;
    }
  }

  .thumbnail-loading {
    width: 100%;
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;

    >* {
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
    }
  }

  /* 加载骨架覆盖层：不阻挡点击/选择；避免破裂图闪现 */
  .thumbnail-loading-overlay {
    position: absolute;
    inset: 0;
    z-index: 2;
    pointer-events: none;
  }

  .thumbnail-hidden {
    opacity: 0;
  }
}

.thumbnail-lost {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 10px;
  box-sizing: border-box;
  font-size: 13px;
  color: rgba(255, 255, 255, 0.78);
  background: rgba(0, 0, 0, 0.18);
  border: 1px dashed rgba(255, 255, 255, 0.22);
  border-radius: 14px 14px 0 0;
  user-select: none;
  text-align: center;
}

.lost-text {
  width: 100%;
  max-width: 100%;
  font-size: 12px;
  line-height: 1.35;
  color: rgba(255, 255, 255, 0.88);
  word-break: break-word;
  line-clamp: 3;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.missing-file-badge {
  position: absolute;
  top: 8px;
  right: 8px;
  z-index: 2;
  width: 22px;
  height: 22px;
  border-radius: 999px;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: auto;
  cursor: help;
  color: #fff;
  background: rgba(245, 108, 108, 0.92);
  border: 1px solid rgba(255, 255, 255, 0.7);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.18);
  transition: background 0.2s ease;

  &:hover {
    background: rgba(245, 108, 108, 1);
  }
}

.video-play-badge {
  position: absolute;
  top: 8px;
  right: 8px;
  z-index: 1;
  width: 22px;
  height: 22px;
  border-radius: 999px;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
  color: #fff;
  background: rgba(0, 0, 0, 0.5);
  border: 1px solid rgba(255, 255, 255, 0.4);
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.2);
}

/* 可控视频的播放/暂停按钮：让 badge 接收点击 */
.video-play-badge-interactive {
  pointer-events: auto;
  cursor: pointer;
  transition: background 0.15s ease, transform 0.15s ease;

  &:hover {
    background: rgba(0, 0, 0, 0.7);
    transform: scale(1.08);
  }

  &:active {
    transform: scale(0.96);
  }
}

.fade-in-enter-active {
  transition: opacity 0.3s ease-in, transform 0.3s ease-out;
}

.fade-in-leave-active {
  transition: opacity 0.2s ease-out, transform 0.2s ease-in;
}

.fade-in-enter-from,
.fade-in-leave-to {
  opacity: 0;
  transform: scale(0.95);
}

.fade-in-enter-to,
.fade-in-leave-from {
  opacity: 1;
  transform: scale(1);
}

@keyframes fadeInImage {
  from {
    opacity: 0;
  }

  to {
    opacity: 1;
  }
}

/* 入场动画（与 transition-group fade-in-list 一致） */
@keyframes itemEnter {
  from {
    opacity: 0;
    transform: translateY(8px);
  }

  to {
    opacity: 1;
    transform: translateY(0);
  }
}

/* 退场动画（与 transition-group fade-in-list 一致） */
@keyframes itemLeave {
  from {
    opacity: 1;
    transform: translateY(0);
  }

  to {
    opacity: 0;
    transform: translateY(8px);
  }
}

.item-entering {
  animation: itemEnter 0.25s ease forwards;
}

.item-leaving {
  animation: itemLeave 0.25s ease forwards;
  pointer-events: none;
}
</style>
