<template>
  <div ref="rootEl" class="image-item" :class="{
    'image-item-selected': selected,
    'item-entering': enteringClassActive,
    'item-leaving': isLeaving,
    'image-item-android': isCompact,
    'image-item-hidden': image.isHidden,
    'image-item-horizontal': horizontal,
  }" :style="rootStyle" :data-id="image.id" @mouseenter="handleMouseEnter" @mouseleave="handleMouseLeave"
    @contextmenu.prevent="$emit('contextmenu', $event)" @animationend="handleAnimationEnd">
    <!-- 本地文件缺失标识：不阻挡点击/选择/右键 -->
    <el-tooltip v-if="originalMissing && !isLost" content="这张图片找不到了" placement="top" :show-after="300">
      <div class="missing-file-badge">
        <el-icon :size="14">
          <WarningFilled />
        </el-icon>
      </div>
    </el-tooltip>
    <!-- 视频标识：右上角播放/暂停切换按钮（可控视频） -->
    <div v-if="isControllableVideo" class="video-play-badge video-play-badge-interactive"
      role="button" :aria-label="videoShouldPlay ? '暂停' : '播放'"
      @click.stop="handleToggleVideoPlay" @dblclick.stop @contextmenu.stop.prevent>
      <el-icon :size="14">
        <VideoPause v-if="videoShouldPlay" />
        <VideoPlay v-else />
      </el-icon>
    </div>
    <!-- 视频标识：GIF 等不可控形态，仅作为静态指示 -->
    <div v-else-if="isVideo" class="video-play-badge" aria-hidden="true">
      <el-icon :size="14">
        <VideoPlay />
      </el-icon>
    </div>
    <div class="image-wrapper" :style="aspectRatioStyle"
      @dblclick.stop="$emit('dblclick', $event)" @contextmenu.prevent.stop="$emit('contextmenu', $event)"
      @click.stop="handleWrapperClick" @touchstart="handleTouchStart" @touchmove="handleTouchMove"
      @touchend="handleTouchEnd">
      <ImageContent ref="contentRef" :image="image" :prefer="effectivePrefer"
        :video-playing="videoShouldPlay" video-muted reset-video-on-pause />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onUnmounted, watch } from "vue";
import { ref, toRef } from "vue";
import { WarningFilled, VideoPlay, VideoPause } from "@element-plus/icons-vue";
import type { ImageInfo } from "../../types/image";
import ImageContent from "./ImageContent.vue";
import type { ImagePrefer } from "../../composables/useImageItemLoader";
import { isVideoMediaType } from "../../utils/mediaMime";
import { storeToRefs } from "pinia";
import { useUiStore } from "@kabegame/core/stores/ui";

interface Props {
  image: ImageInfo;
  prefer: ImagePrefer; // 优先原图还是缩略图（透传 ImageContent）
  selected?: boolean; // 是否被选中
  isEntering?: boolean; // 是否正在入场（用于虚拟滚动的动画）
  isLeaving?: boolean; // 是否正在离开（用于虚拟滚动的动画）
  horizontal?: boolean; // 水平方向：盒子用 height: 100% 撑满主轴，width 由 aspect-ratio 决定
  videoPlaying?: boolean; // 视频是否正在播放（由上层协调，确保同一时间只有一个视频在播放）
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
  hoverVideoPreview: [active: boolean]; // 鼠标悬停视频预览播放状态
}>();

const rootEl = ref<HTMLElement | null>(null);
const contentRef = ref<InstanceType<typeof ImageContent> | null>(null);
const { isCompact } = storeToRefs(useUiStore());

// 缺失/丢失状态来自 ImageContent（用于角标显示）
const originalMissing = computed(() => contentRef.value?.originalMissing ?? false);
const isLost = computed(() => contentRef.value?.isLost ?? false);

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

// Android 长按检测
let longPressTimer: ReturnType<typeof setTimeout> | null = null;
let longPressFired = false;
let touchStartPos = { x: 0, y: 0 };
let touchMoved = false;

const handleTouchStart = (event: TouchEvent) => {
  if (!isCompact.value) return;
  if (event.touches.length !== 1) {
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
};

onUnmounted(() => {
  if (longPressTimer) {
    clearTimeout(longPressTimer);
    longPressTimer = null;
  }
});

// 非画廊网格盒子恒为正方形；画廊布局由上层按图片比例给盒子尺寸。ImageContent 始终 contain。
const aspectRatioStyle = computed(() => ({ aspectRatio: "1 / 1" }));
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

const previewPath = computed(() => props.image.thumbnailPath || props.image.localPath);
const isVideoRenderedAsImage = computed(() => isVideo.value && hasPathExtension(previewPath.value, "gif"));
// GIF 预览不可控；mp4 预览走 <video>，由上层统一控制播放/暂停。
const isControllableVideo = computed(() => isVideo.value && !isVideoRenderedAsImage.value);

const hoverVideoPreviewActive = ref(false);
const hoverOriginalActive = ref(false);
const videoShouldPlay = computed(() => props.videoPlaying || hoverVideoPreviewActive.value);
const HOVER_PREVIEW_DELAY_MS = 200;
let hoverPreviewTimer: ReturnType<typeof setTimeout> | null = null;

// 视频始终用缩略（压缩短视频），不在网格里加载原视频；
// 图片在 hover 时把 prefer 临时升级为 original（替代旧的 forceDesktopLayers）。
const effectivePrefer = computed<ImagePrefer>(() => {
  if (isVideo.value) return "thumbnail";
  return hoverOriginalActive.value && props.prefer === "thumbnail" ? "original" : props.prefer;
});
const canHoverOriginalPreview = computed(() =>
  !isCompact.value &&
  !isVideo.value &&
  props.prefer === "thumbnail" &&
  !originalMissing.value
);

const clearHoverPreviewTimer = () => {
  if (hoverPreviewTimer) {
    clearTimeout(hoverPreviewTimer);
    hoverPreviewTimer = null;
  }
};

const stopHoverPreview = () => {
  clearHoverPreviewTimer();
  if (hoverVideoPreviewActive.value) {
    hoverVideoPreviewActive.value = false;
    emit("hoverVideoPreview", false);
  }
  hoverOriginalActive.value = false;
};

const handleMouseEnter = () => {
  if (isCompact.value) return;
  clearHoverPreviewTimer();
  hoverPreviewTimer = setTimeout(() => {
    hoverPreviewTimer = null;
    if (isCompact.value) return;
    if (isControllableVideo.value) {
      hoverVideoPreviewActive.value = true;
      emit("hoverVideoPreview", true);
      return;
    }
    if (canHoverOriginalPreview.value) {
      hoverOriginalActive.value = true;
    }
  }, HOVER_PREVIEW_DELAY_MS);
};

const handleMouseLeave = () => {
  stopHoverPreview();
};

watch(
  [
    () => props.image.id,
    () => props.image.localPath,
    () => props.image.thumbnailPath,
    () => props.image.type,
  ],
  () => {
    stopHoverPreview();
  }
);

watch(isCompact, (compact) => {
  if (compact) stopHoverPreview();
});

onUnmounted(stopHoverPreview);

const handleToggleVideoPlay = () => {
  if (hoverVideoPreviewActive.value) {
    hoverVideoPreviewActive.value = false;
    emit("hoverVideoPreview", false);
  }
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
  overflow: hidden;
  cursor: pointer;
  position: relative;
  transition: transform 0.25s cubic-bezier(0.4, 0, 0.2, 1), box-shadow 0.25s ease;
  box-sizing: border-box;
  will-change: transform, box-shadow;
  user-select: none;
  -webkit-tap-highlight-color: transparent;

  /* 隐藏图片：盖在所有图层最上面的半透明遮罩。
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

    .image-wrapper {
      border-radius: 0;
    }

    &.image-item-selected {
      border: none;
      box-shadow: 0 0 0 2px rgba(255, 107, 157, 0.6);
      outline: none;
    }
  }

  html:not(.platform-android) &:hover {
    outline: 3px solid var(--anime-primary-light);
    outline-offset: -2px;
  }

  &.image-item-selected {
    box-shadow:
      0 0 0 3px rgba(255, 107, 157, 0.4),
      0 0 20px rgba(255, 107, 157, 0.5),
      0 4px 12px rgba(255, 107, 157, 0.3);
    outline: 4px solid #ff6b9d;
    outline-offset: -2px;

    html:not(.platform-android) &:hover {
      outline: 5px solid #ff4d8a;
      outline-offset: -2px;
      box-shadow:
        0 0 0 3px rgba(255, 77, 138, 0.5),
        0 0 30px rgba(255, 107, 157, 0.6),
        0 6px 16px rgba(255, 107, 157, 0.4);
    }
  }

  .image-wrapper {
    width: 100%;
    position: relative;
    cursor: pointer;
    overflow: hidden;
    will-change: contents;
    -webkit-tap-highlight-color: transparent;
  }

  /* 水平方向：item 在横向滚动容器里作为"列/行"的单元，
     应由 aspect-ratio 从 height 推导 width，而不是默认的 width → height。
     关键：flex-shrink: 0 防止在 width: max-content 容器内被挤压。 */
  &.image-item-horizontal {
    height: 100%;
    width: auto;
    flex-shrink: 0;
    .image-wrapper {
      height: 100%;
      width: auto;
    }
  }

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
