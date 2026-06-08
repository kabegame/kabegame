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
          v-if="!IS_ANDROID && !thumbFailed"
          :key="`thumb:${plan.thumbnailUrl}`"
          :src="plan.thumbnailUrl"
          loading="eager"
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
          :key="`orig:${plan.originalUrl}`"
          :src="plan.originalUrl"
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
import type { ImageInfo } from "../../types/image";
import ImageNotFound from "../common/ImageNotFound.vue";
import { buildImageUrlPlan, type ImagePrefer } from "../../composables/imageUrlPlan";
import { isVideoMediaType } from "../../utils/mediaMime";
import { useUiStore } from "../../stores/ui";
import { useLoadingDelay } from "../../composables/useLoadingDelay";
import { IS_ANDROID } from "../../env";

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

// ---- URL plan (pure, synchronous) ----
const plan = computed(() => buildImageUrlPlan(props.image, props.prefer));

// ---- Media type ----
const isVideo = computed(() => isVideoMediaType(props.image.type));

// ---- Single-image URL derivation ----
const singlePrimaryUrl = computed(() =>
  props.prefer === "original"
    ? (plan.value.originalUrl || plan.value.thumbnailUrl)
    : (plan.value.thumbnailUrl || plan.value.originalUrl)
);
const singleFallbackUrl = computed(() => {
  const alt = props.prefer === "original" ? plan.value.thumbnailUrl : plan.value.originalUrl;
  return alt && alt !== singlePrimaryUrl.value ? alt : "";
});

// ---- Mutable load state ----
const useFallback    = ref(false);
const thumbFailed    = ref(false);
const originalFailed = ref(false);
const videoFailed    = ref(false);

const videoEl  = ref<HTMLVideoElement | null>(null);

const videoSrc = computed(() =>
  props.prefer === "original"
    ? (plan.value.originalUrl || plan.value.thumbnailUrl)
    : (plan.value.thumbnailUrl || plan.value.originalUrl)
);

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
    useFallback.value    = false;
    thumbFailed.value    = false;
    originalFailed.value = false;
    videoFailed.value    = false;

    const hasAnyUrl = isVideo.value
      ? !!videoSrc.value
      : !!(singlePrimaryUrl.value || singleFallbackUrl.value ||
           plan.value.thumbnailUrl || plan.value.originalUrl);

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
