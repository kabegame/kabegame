<template>
  <div class="image-content" :class="{ 'is-compact': isCompact }">
    <!-- 彻底加载失败 -->
    <div v-if="isLost" class="ic-lost">
      <ImageNotFound :show-image="false" />
    </div>

    <template v-else>
      <!-- 骨架覆盖层：delayed 防止快速解码时闪烁；GIF 以 <img> 渲染，不需要独立骨架 -->
      <div v-if="showLoading" class="ic-loading ic-loading-overlay">
        <el-skeleton :rows="0" animated>
          <template #template>
            <el-skeleton-item
              :variant="isVideo ? 'rect' : 'image'"
              :style="{ width: '100%', height: '100%' }"
            />
          </template>
        </el-skeleton>
      </div>

      <!-- 双图层：prefer=original 且缩略图与原图 URL 不同 -->
      <template v-if="!isVideo || isVideo && prefer === 'thumbnail' && IS_ANDROID">
        <img
          v-if="!thumbFailed"
          :key="`thumb:${thumbnailUrl}`"
          :src="thumbnailUrl"
          loading="lazy"
          decoding="async"
          class="ic-img thumbnail-layer"
          :alt="image.id"
          draggable="false"
          @load="onThumbLoad"
          @error="onThumbError"
          @dragstart.prevent
        />
        <img
          v-if="!originalFailed && prefer === 'original'"
          :key="`orig:${originalLayerSrc}`"
          :src="originalLayerSrc"
          loading="lazy"
          decoding="async"
          class="ic-img original-layer"
          :alt="image.id"
          draggable="false"
          @load="onOriginalLoad"
          @error="onOriginalError"
          @dragstart.prevent
        />
      </template>

      <!-- 视频 -->
      <video
        v-else
        :key="`video:${videoSrc}`"
        ref="videoEl"
        :src="videoSrc"
        class="ic-img ic-video"
        draggable="false"
        :muted="videoMuted"
        :loop="videoLoop"
        :controls="nativeVideoControls"
        poster=""
        preload="auto"
        playsinline
        webkit-playsinline="true"
        disablepictureinpicture="true"
        disableremoteplayback=""
        @loadeddata="onVideoReady"
        @canplay="onVideoReady"
        @error="onVideoError"
        @dragstart.prevent
        @mousedown.prevent
      />
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch, watchEffect } from "vue";
import { storeToRefs } from "pinia";
import type { ImageInfo, ImagePrefer } from "../../types/image";
import ImageNotFound from "../common/ImageNotFound.vue";
import { isVideoMediaType } from "../../utils/mediaMime";
import { useUiStore } from "../../stores/ui";
import { useLoadingDelay } from "../../composables/useLoadingDelay";
import { fileToUrl, thumbnailToUrl, compatibleToUrl } from "../../httpServer";
import { IS_ANDROID } from "../../env";

// ---- Path → URL helpers (pure) ----
const normalizeDesktopPath = (path: string | undefined): string =>
  (path || "").trimStart().replace(/^\\\\\?\\/, "").trim();

const toFileUrl = (path: string | undefined): string => {
  const normalized = normalizeDesktopPath(path);
  return normalized ? fileToUrl(normalized) : "";
};

const toThumbnailUrl = (path: string | undefined): string => {
  const normalized = normalizeDesktopPath(path);
  return normalized ? thumbnailToUrl(normalized) : "";
};

interface Props {
  image: ImageInfo;
  prefer: ImagePrefer;
  videoPlaying?: boolean;
  nativeVideoControls?: boolean;
  videoMuted?: boolean;
  videoLoop?: boolean;
  resetVideoOnPause?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  videoPlaying: false,
  nativeVideoControls: false,
  videoMuted: false,
  videoLoop: true,
  resetVideoOnPause: false,
});

const emit = defineEmits<{
  ready: [];
  error: [];
  videoPlayFail: [];
}>();

const { isCompact } = storeToRefs(useUiStore());
const { showLoading, startLoading, finishLoading } = useLoadingDelay(300);

// ---- Media type ----
const isVideo = computed(() => isVideoMediaType(props.image.type));

// ---- Explicit URL derivation ----
// 缩略图层 URL：桌面为缩略图文件；安卓为本地文件代理（无独立缩略图或偏好原图时为空）。
const thumbnailUrl = computed(() => {
  const thumbnail = toThumbnailUrl(props.image.thumbnailPath);
  if (thumbnail) return thumbnail;
  if (IS_ANDROID && (isVideo.value || props.prefer !== "original")) {
    return toFileUrl(props.image.localPath);
  }
  return "";
});
// 浏览器兼容副本 URL：走 /compatible；Android 本地服务不做库校验，只按路径读取。
const compatibleUrl = computed(() =>
  props.image.compatiblePath ? compatibleToUrl(normalizeDesktopPath(props.image.compatiblePath)) : ""
);
// 原始文件 URL：桌面为文件路径，Android 可为 content:// 或普通路径。
const localUrl = computed(() => toFileUrl(props.image.localPath));

// ---- Mutable load state ----
const thumbFailed    = ref(false);
const originalFailed = ref(false);
const videoFailed    = ref(false);
// 兼容副本加载失败：原图层回落到原始文件重试一次。
const compatibleError = ref(false);
// 视频回退：先尝试兼容副本，失败后降为原始文件。
const videoUsedFallback = ref(false);

const videoEl  = ref<HTMLVideoElement | null>(null);

// 原图层实际 src：兼容副本可用且未失败时优先，否则回落原始文件（回落由 compatibleError 驱动）。
const originalLayerSrc = computed(() =>
  compatibleUrl.value && !compatibleError.value ? compatibleUrl.value : localUrl.value
);

const videoSrc = computed(() => {
  const compatibleOrLocal = compatibleUrl.value || localUrl.value;
  if (videoUsedFallback.value) {
    return localUrl.value || compatibleOrLocal;
  }
  return props.prefer === "original"
    ? (compatibleOrLocal || thumbnailUrl.value)
    : (thumbnailUrl.value || compatibleOrLocal);
});

// ---- Derived exposed state ----
const isLost = computed(() =>
  // 安卓下只要图片丢失
  IS_ANDROID ?
    !isVideo.value && originalFailed.value || isVideo.value && (thumbFailed.value || originalFailed.value)
    // 非安卓，视频不回退，图片回退
    : isVideo.value && (thumbFailed.value || originalFailed.value) || !isVideo.value && thumbFailed.value && originalFailed.value 
);

const originalMissing = computed(() => originalFailed.value);

// ---- Reset on image identity change (NOT on prefer — preserves hover no-flash) ----
// When ImageItem flips effectivePrefer thumbnail→original, the two URLs don't change, so this
// watch doesn't fire, showLoading stays false, and the already-cached thumbnail layer is instant.
watch(
  () => props.image.id,
  () => {
    thumbFailed.value       = false;
    originalFailed.value    = false;
    videoFailed.value       = false;
    compatibleError.value   = false;
    videoUsedFallback.value = false;

    const hasAnyUrl = isVideo.value
      ? !!videoSrc.value
      : !!(thumbnailUrl.value || compatibleUrl.value || localUrl.value);

    if (!hasAnyUrl) {
      finishLoading();
      return;
    }
    startLoading();
  },
  { immediate: true }
);

watch(isLost, (lost) => { if (lost) emit("error"); });

// ---- Handlers: dual layer ----
const onThumbLoad = () => {
  finishLoading();
  emit("ready");
};
const onThumbError = () => {
  thumbFailed.value = true;
  // If original also failed, both layers gone → isLost fires error via watch
  if (originalFailed.value) finishLoading();
};
const onOriginalLoad = () => {
  finishLoading();
  emit("ready");
};
const onOriginalError = () => {
  // 原图层优先加载兼容副本；兼容副本失败时先回落到原始文件重试一次
  if (compatibleUrl.value && !compatibleError.value) {
    compatibleError.value = true;
    return; // originalLayerSrc 自动切到原始文件，触发重新加载
  }
  originalFailed.value = true;
  // Thumbnail layer still visible; skeleton clears only when thumb also done
  if (thumbFailed.value) finishLoading();
};

// ---- Handlers: video ----
const onVideoReady = () => {
  finishLoading();
  emit("ready");
};
const onVideoError = () => {
  // 若当前播放的是兼容副本（与原始文件不同），先降级到原始文件重试一次
  if (!videoUsedFallback.value && compatibleUrl.value && compatibleUrl.value !== localUrl.value) {
    videoUsedFallback.value = true;
    return; // videoSrc computed 自动切换到 localUrl，触发重新加载
  }
  const el = videoEl.value;
  const me = el?.error;
  console.log('[KbgVideo] error', {
    src: el?.currentSrc || videoSrc.value,
    code: me?.code,            // 1=ABORTED 2=NETWORK 3=DECODE 4=SRC_NOT_SUPPORTED
    message: me?.message,
    networkState: el?.networkState,
    readyState: el?.readyState,
    type: props.image.type,
  });
  videoFailed.value = true;
  finishLoading();
};

// ---- Video playback control (unchanged) ----
watchEffect(() => {
  const el = videoEl.value;
  if (!el || !isVideo.value || (isVideo.value && IS_ANDROID) || props.nativeVideoControls) return;
  if (props.videoPlaying) {
    void el.play().catch(() => {
      emit("videoPlayFail");
    });
  } else {
    el.pause();
    if (props.resetVideoOnPause) {
      try { el.currentTime = 0; } catch { /* some platforms throw on currentTime write */ }
    }
  }
});

defineExpose({ videoEl, originalMissing, isLost });
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

  .thumbnail-layer {
    z-index: 1;
  }

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
