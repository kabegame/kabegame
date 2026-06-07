<template>
  <div class="image-content" :class="{ 'is-compact': isCompact }">
    <!-- 无内容 / 加载 / 丢失 -->
    <template v-if="!displayUrl">
      <div v-if="isLost" class="ic-lost">
        <ImageNotFound :show-image="false" />
      </div>
      <!-- 视频不叠 image 形骨架，避免中央出现图片占位 -->
      <!-- <div v-else-if="!isVideo" class="ic-loading ic-loading-overlay">
        <el-skeleton :rows="0" animated>
          <template #template>
            <el-skeleton-item variant="image" :style="{ width: '100%', height: '100%' }" />
          </template>
        </el-skeleton>
      </div> -->
    </template>

    <template v-else>
      <!-- 加载期间的骨架覆盖层（仅图片） -->
      <div v-if="isImageLoading && !isVideo && !useLayerShell" class="ic-loading ic-loading-overlay">
        <el-skeleton :rows="0" animated>
          <template #template>
            <el-skeleton-item variant="image" :style="{ width: '100%', height: '100%' }" />
          </template>
        </el-skeleton>
      </div>
      <!-- 视频加载骨架：用纯矩形 shimmer 避免首帧前全白 -->
      <div v-if="isVideo && !isVideoRenderedAsImage && !videoReady" class="ic-loading ic-loading-overlay">
        <el-skeleton :rows="0" animated>
          <template #template>
            <el-skeleton-item variant="rect" :style="{ width: '100%', height: '100%' }" />
          </template>
        </el-skeleton>
      </div>

      <!-- 桌面双图外壳：缩略图打底，原图盖在其上，原图流式解码自然覆盖缩略图（无 opacity gate）。
           key 绑定 src：切换图片时强制换新元素，避免旧图残留（互斥显示）。原图加载失败则隐藏该层，避免破碎图。 -->
      <template v-if="useLayerShell">
        <img v-if="!thumbnailLoadFailed" :key="`thumb:${thumbnailUrl}`" :src="thumbnailUrl" loading="lazy"
          decoding="async" class="ic-img thumbnail-layer" :alt="image.id" draggable="false"
          @load="handleThumbnailLoad" @error="handleThumbnailError" @dragstart.prevent />
        <img v-if="useDesktopLayers && !originalFailed && preferOriginal" :key="`orig:${originalUrl}`" :src="originalUrl"
          loading="lazy" decoding="async" class="ic-img original-layer" :alt="image.id" draggable="false"
          @load="onOriginalLoad" @error="onOriginalError" @dragstart.prevent />
      </template>

      <!-- GIF 等以图片形态渲染的“视频” -->
      <img v-else-if="isVideoRenderedAsImage" :key="`gif:${displayUrl}`" :src="displayUrl" loading="lazy"
        decoding="async" class="ic-img" :style="{ visibility: isImageLoading ? 'hidden' : 'visible' }"
        :alt="image.id" draggable="false" @load="onImageLoad" @error="onImageError" @dragstart.prevent />

      <!-- 视频：用 videoSrc——grid/gallery 用压缩短视频缩略（prefer=thumbnail），预览用原视频（prefer=original） -->
      <video v-else-if="isVideo" :key="`video:${videoSrc}`" ref="videoEl" :src="videoSrc" class="ic-img ic-video"
        draggable="false" :muted="videoMuted" :loop="videoLoop" :controls="nativeVideoControls" poster=""
        preload="auto" playsinline webkit-playsinline="true" disablepictureinpicture="true"
        disableremoteplayback="" @loadeddata="onVideoReady" @error="onImageError" @dragstart.prevent
        @mousedown.prevent />

      <!-- 单图 -->
      <img v-else :key="`img:${displayUrl}`" :src="displayUrl" loading="lazy" decoding="async" class="ic-img"
        :style="{ visibility: isImageLoading ? 'hidden' : 'visible' }" :alt="image.id" draggable="false"
        @load="onImageLoad" @error="onImageError" @dragstart.prevent />
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, toRef, watch, watchEffect } from "vue";
import { storeToRefs } from "pinia";
import type { ImageInfo } from "../../types/image";
import ImageNotFound from "../common/ImageNotFound.vue";
import { useImageItemLoader, type ImagePrefer } from "../../composables/useImageItemLoader";
import { isVideoMediaType } from "../../utils/mediaMime";
import { useUiStore } from "../../stores/ui";

interface Props {
  image: ImageInfo;
  /** 优先展示原图还是缩略图（透传给 loader）。盒子始终 contain（盒子比例由上层决定）。 */
  prefer: ImagePrefer;
  /** 外部控制视频播放意图（grid: 由上层协调；预览/PhotoSwipe: 作为 autoplay 触发） */
  videoPlaying?: boolean;
  /** 视频使用原生 controls（一般不用，PhotoSwipe 用点击切换） */
  nativeVideoControls?: boolean;
  /** 视频静音（grid 为 true） */
  videoMuted?: boolean;
  /** 视频循环 */
  videoLoop?: boolean;
  /** 暂停时是否复位到起点（grid hover 结束复位；播放器场景保持进度） */
  resetVideoOnPause?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  videoPlaying: false,
  clickToPlayVideo: false,
  nativeVideoControls: false,
  videoMuted: false,
  videoLoop: true,
  resetVideoOnPause: false,
});

const emit = defineEmits<{
  /** 已有可见内容（缩略图/单图/视频就绪） */
  ready: [];
  /** 加载彻底失败（lost） */
  error: [];
  /** 用户直接点击视频后开始播放 */
  videoUserPlay: [];
  /** 用户直接点击视频后暂停 */
  videoUserPause: [];
  /** 播放失败 */
  videoPlayFail: [];
}>();

const imageRef = toRef(props, "image");
const preferRef = toRef(props, "prefer");
const { isCompact } = storeToRefs(useUiStore());

const {
  displayUrl,
  isImageLoading,
  isLost,
  originalMissing,
  thumbnailUrl,
  originalUrl,
  useDesktopLayers,
  thumbnailLoadFailed,
  handleImageLoad,
  handleImageError,
  handleThumbnailLoad,
  handleOriginalLoad,
  handleThumbnailError,
  handleOriginalError,
} = useImageItemLoader({ image: imageRef, prefer: preferRef });

const videoEl = ref<HTMLVideoElement | null>(null);
/** 视频首帧是否就绪（loadeddata），未就绪时显示视频骨架避免全白 */
const videoReady = ref(false);
/** 原图加载失败：隐藏 original-layer，回落到缩略图，避免破碎图 */
const originalFailed = ref(false);
const preferOriginal = computed(() => props.prefer == 'original');

const isVideo = computed(() => isVideoMediaType(props.image.type));
/** 视频源随 prefer：original→原视频（预览）；thumbnail→压缩短视频缩略（grid/gallery）。
 *  注意不能用 loader 的 displayUrl——双图策略下它会被置为缩略图 URL。 */
const videoSrc = computed(() =>
  props.prefer === "original"
    ? originalUrl.value || thumbnailUrl.value
    : thumbnailUrl.value || originalUrl.value
);

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
const isVideoRenderedAsImage = computed(
  () => isVideo.value && hasPathExtension(displayPreviewPath.value, "gif")
);

/** 桌面双图外壳：与 ImageItem 同条件——非视频、有独立缩略图与原图 */
const useLayerShell = computed(() =>
  !isVideo.value &&
  !!thumbnailUrl.value &&
  !!originalUrl.value &&
  thumbnailUrl.value !== originalUrl.value &&
  (!thumbnailLoadFailed.value || useDesktopLayers.value)
);

// ---- ready / error 上报（供 PhotoSwipe slot 与预览清除 loading 用） ----
const onImageLoad = (event: Event) => {
  handleImageLoad(event);
  emit("ready");
};
const onImageError = (event: Event) => {
  handleImageError();
  // handleImageError 会在彻底失败时置 isLost；fallback 时仍在加载
  void event;
};
const onOriginalLoad = () => {
  handleOriginalLoad();
  emit("ready");
};
const onOriginalError = () => {
  originalFailed.value = true;
  handleOriginalError();
};
const onVideoReady = () => {
  videoReady.value = true;
  emit("ready");
};

// 切换媒体时重置视频骨架 / 原图失败状态
watch(
  () => [props.image.id, displayUrl.value, originalUrl.value] as const,
  () => {
    videoReady.value = false;
    originalFailed.value = false;
  }
);

// 缩略图打底就绪即视为“有可见内容”
watch(
  () => isImageLoading.value,
  (loading) => {
    if (!loading && !isLost.value && displayUrl.value) emit("ready");
  }
);
watch(
  () => isLost.value,
  (lost) => {
    if (lost) emit("error");
  }
);

// 视频播放：外部 videoPlaying 驱动；使用原生 controls 时不介入，交给用户/浏览器
watchEffect(() => {
  const el = videoEl.value;
  if (!el || !isVideo.value || isVideoRenderedAsImage.value || props.nativeVideoControls) return;
  if (props.videoPlaying) {
    void el.play().catch(() => {
      console.log('auto play blocked');
      emit("videoPlayFail");
    });
  } else {
    el.pause();
    if (props.resetVideoOnPause) {
      try { el.currentTime = 0; } catch { /* 部分平台 currentTime 写入会抛 */ }
    }
  }
});

defineExpose({
  videoEl,
  originalMissing,
  isLost,
});
</script>

<style scoped lang="scss">
.image-content {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;

  .ic-img {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    object-fit: contain;
    will-change: contents, opacity;
    -webkit-tap-highlight-color: transparent;
  }

  // 桌面双图：底层缩略图
  .thumbnail-layer {
    z-index: 1;
  }

  // 桌面双图：顶层原图，始终不透明，流式解码自然覆盖缩略图
  .original-layer {
    z-index: 2;
  }

  .ic-loading {
    width: 100%;
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;

    > * {
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
    }
  }

  .ic-loading-overlay {
    position: absolute;
    inset: 0;
    z-index: 3;
    pointer-events: none;
  }

  .ic-lost {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
  }
}
</style>
