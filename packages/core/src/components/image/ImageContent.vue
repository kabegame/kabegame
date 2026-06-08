<template>
  <div class="image-content" :class="{ 'is-compact': isCompact }">
    <!-- 彻底加载失败 -->
    <div v-if="isLost" class="ic-lost">
      <ImageNotFound :show-image="false" />
    </div>

    <template v-else>
      <!-- 骨架覆盖层：delayed 防止快速解码时闪烁；GIF 以 <img> 渲染，不需要独立骨架 -->
      <div v-if="showLoading && !isVideoRenderedAsImage" class="ic-loading ic-loading-overlay">
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
      <template v-if="dualLayer">
        <img
          v-if="!thumbFailed"
          :key="`thumb:${plan.thumbnailUrl}`"
          :src="plan.thumbnailUrl"
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
          v-if="!originalFailed"
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

      <!-- GIF 等以图片形态渲染的"视频" -->
      <img
        v-else-if="isVideoRenderedAsImage"
        :key="`gif:${singleUrl}`"
        :src="singleUrl"
        loading="lazy"
        decoding="async"
        class="ic-img"
        :alt="image.id"
        draggable="false"
        @load="onSingleLoad"
        @error="onSingleError"
        @dragstart.prevent
      />

      <!-- 视频 -->
      <video
        v-else-if="isVideo"
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

      <!-- 单图（prefer=thumbnail，或 prefer=original 但无独立缩略图） -->
      <img
        v-else
        :key="`img:${singleUrl}`"
        :src="singleUrl"
        loading="lazy"
        decoding="async"
        class="ic-img"
        :alt="image.id"
        draggable="false"
        @load="onSingleLoad"
        @error="onSingleError"
        @dragstart.prevent
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
    try { return decodeURIComponent(noQuery); } catch { return noQuery; }
  }
}

function hasPathExtension(value: string | undefined, ext: string): boolean {
  return pathFromUrlLike(value).trim().toLowerCase().endsWith(`.${ext.toLowerCase()}`);
}

const displayPreviewPath = computed(() =>
  plan.value.thumbnailUrl || props.image.thumbnailPath || props.image.localPath
);
const isVideoRenderedAsImage = computed(
  () => isVideo.value && hasPathExtension(displayPreviewPath.value, "gif")
);

// ---- Dual layer: prefer=original with distinct thumbnail & original ----
const dualLayer = computed(() =>
  !isVideo.value &&
  props.prefer === "original" &&
  !!plan.value.thumbnailUrl &&
  !!plan.value.originalUrl &&
  plan.value.thumbnailUrl !== plan.value.originalUrl
);

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
const singleLost     = ref(false);
const thumbFailed    = ref(false);
const originalFailed = ref(false);
const videoFailed    = ref(false);

const videoEl  = ref<HTMLVideoElement | null>(null);

const singleUrl = computed(() =>
  useFallback.value ? singleFallbackUrl.value : singlePrimaryUrl.value
);
const videoSrc = computed(() =>
  props.prefer === "original"
    ? (plan.value.originalUrl || plan.value.thumbnailUrl)
    : (plan.value.thumbnailUrl || plan.value.originalUrl)
);

// ---- Derived exposed state ----
const isLost = computed(() =>
  isVideo.value
    ? videoFailed.value
    : dualLayer.value
      ? (thumbFailed.value && originalFailed.value)
      : singleLost.value
);

const originalMissing = computed(() => {
  if (IS_ANDROID || isVideo.value) return false;
  if (dualLayer.value) return originalFailed.value;
  if (props.prefer === "thumbnail" && props.image.localExists === false && !!plan.value.thumbnailUrl)
    return true;
  if (useFallback.value && props.prefer === "original") return true;
  return false;
});

// ---- Reset on image identity change (NOT on prefer — preserves hover no-flash) ----
// When ImageItem flips effectivePrefer thumbnail→original, the two URLs don't change, so this
// watch doesn't fire, showLoading stays false, and the already-cached thumbnail layer is instant.
watch(
  () => [props.image.id, plan.value.thumbnailUrl, plan.value.originalUrl] as const,
  () => {
    useFallback.value    = false;
    singleLost.value     = false;
    thumbFailed.value    = false;
    originalFailed.value = false;
    videoFailed.value    = false;

    const hasAnyUrl = isVideo.value
      ? !!videoSrc.value
      : !!(singlePrimaryUrl.value || singleFallbackUrl.value ||
           plan.value.thumbnailUrl || plan.value.originalUrl);

    if (!hasAnyUrl) {
      singleLost.value = true;
      finishLoading();
      return;
    }
    startLoading();
  },
  { immediate: true }
);

watch(isLost, (lost) => { if (lost) emit("error"); });

// ---- Handlers: single image / GIF ----
const onSingleLoad = (event: Event) => {
  const img = event.target as HTMLImageElement;
  if (img.complete && img.naturalHeight !== 0) {
    finishLoading();
    emit("ready");
  }
};
const onSingleError = () => {
  if (!useFallback.value && singleFallbackUrl.value) {
    useFallback.value = true;
  } else {
    singleLost.value = true;
    finishLoading();
  }
};

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
  if (!el || !isVideo.value || isVideoRenderedAsImage.value || props.nativeVideoControls) return;
  if (props.videoPlaying) {
    void el.play().catch(() => {
      console.log("auto play blocked");
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
