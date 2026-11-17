<template>
  <PreviewControlBar ref="barRef" :is-fullscreen="isFullscreen" :keep-visible="keepVisible">
    <button
      v-if="showPlayPause"
      class="control-btn"
      type="button"
      :aria-label="isPlaying ? 'Pause' : 'Play'"
      @click="togglePlay"
    >
      <svg v-if="!isPlaying" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M8 5v14l11-7z" />
      </svg>
      <svg v-else viewBox="0 0 24 24" aria-hidden="true">
        <path d="M7 5h4v14H7zM13 5h4v14h-4z" />
      </svg>
    </button>

    <div class="seek-wrap">
      <PreviewRangeSlider
        :model-value="seekPercent"
        :min="0"
        :max="100"
        :step="0.1"
        aria-label="Seek"
        @drag-start="handleSeekDragStart"
        @update:model-value="handleSeekInput"
        @change="commitSeek"
      />
      <div class="time-text">{{ displayTime }}</div>
    </div>

    <div class="hover-panel-wrap" @mouseenter="volumePanel.enter" @mouseleave="volumePanel.leave">
      <button class="control-btn" type="button" aria-label="Mute" @click="toggleMute">
        <svg v-if="!isMuted" viewBox="0 0 24 24" aria-hidden="true">
          <path
            d="M3 10v4h4l5 4V6L7 10H3zm13.5 2c0-1.77-1-3.29-2.5-4.03v8.05A4.48 4.48 0 0 0 16.5 12zm0-7.5v2.06c2.89.86 5 3.54 5 6.44 0 2.9-2.11 5.58-5 6.44v2.06c4.01-.91 7-4.49 7-8.5s-2.99-7.59-7-8.5z"
          />
        </svg>
        <svg v-else viewBox="0 0 24 24" aria-hidden="true">
          <path d="M16.5 12c0 1.77-1 3.29-2.5 4.03v-2.21l2.17-2.17c.21.11.33.22.33.35zM3 10v4h4l5 4V6L7 10H3z" />
          <path d="m21 9-2-2-3 3-3-3-2 2 3 3-3 3 2 2 3-3 3 3 2-2-3-3 3-3z" />
        </svg>
      </button>
      <div
        class="slider-panel"
        :class="{ visible: volumePanel.active.value }"
        @mouseenter="volumePanel.enter"
        @mouseleave="volumePanel.leave"
        @click.stop
      >
        <PreviewRangeSlider
          :model-value="volume"
          :min="0"
          :max="1"
          :step="0.01"
          aria-label="Volume"
          vertical
          @update:model-value="handleVolumeInput"
        />
      </div>
    </div>

    <!-- 缩放（预览放大，和图片同一个 Panzoom）：没放大时是放大镜，放大后显示百分比；悬停出竖向滑块，点按钮回到 100% -->
    <div v-if="zoom != null" class="hover-panel-wrap" @mouseenter="zoomPanel.enter" @mouseleave="zoomPanel.leave">
      <button
        class="control-btn zoom-btn"
        type="button"
        :aria-label="t('gallery.zoomRatio')"
        @click="emit('zoom-reset')"
      >
        <ZoomIn v-if="zoomPercent === 100" />
        <span v-else class="zoom-btn-text">{{ zoomPercent }}%</span>
      </button>
      <div
        class="slider-panel"
        :class="{ visible: zoomPanel.active.value }"
        @mouseenter="zoomPanel.enter"
        @mouseleave="zoomPanel.leave"
        @click.stop
      >
        <PreviewRangeSlider
          :model-value="zoomPercent"
          :min="100"
          :max="1000"
          :step="1"
          :aria-label="t('gallery.zoomRatio')"
          vertical
          @drag-start="handleZoomDragStart"
          @update:model-value="handleZoomInput"
          @change="handleZoomCommit"
        />
      </div>
    </div>

    <!-- 播放速度（预览弹窗给 `rate` 才有）：在全屏左边（用户定）；临时值，不保存 -->
    <PreviewSpeedControl
      v-if="rate != null"
      :model-value="rate"
      @update:model-value="emit('update:rate', $event)"
      @active="speedPanelActive = $event"
    />

    <button
      class="control-btn"
      type="button"
      :aria-label="isFullscreen ? 'Exit Fullscreen' : 'Fullscreen'"
      @click="toggleFullscreen"
    >
      <svg v-if="!isFullscreen" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M7 14H5v5h5v-2H7v-3zm0-4h2V7h3V5H5v5zm10 7h-3v2h5v-5h-2v3zm0-12v3h2V5h-5v2h3z" />
      </svg>
      <svg v-else viewBox="0 0 24 24" aria-hidden="true">
        <path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm8 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z" />
      </svg>
    </button>
  </PreviewControlBar>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { useLocalStorage } from "@vueuse/core";
import { ZoomIn } from "@lucide/vue";
import { useI18n } from "@kabegame/i18n";
import PreviewControlBar from "./PreviewControlBar.vue";
import PreviewRangeSlider from "./PreviewRangeSlider.vue";
import PreviewSpeedControl from "./PreviewSpeedControl.vue";

const props = withDefaults(
  defineProps<{
    video: HTMLVideoElement | null;
    /** When false, hide play/pause button (e.g. preview dialog: video always plays, no pause to avoid white frame). */
    showPlayPause?: boolean;
    isFullscreen?: boolean;
    /** 当前缩放百分比（100–1000，预览弹窗的 Panzoom）；不传不显示缩放按钮 */
    zoom?: number | null;
    /** 播放速度（0.25–4，预览弹窗持有的临时值）；不传不显示倍速按钮。改了 emit `update:rate`，由调用方设到视频上 */
    rate?: number | null;
  }>(),
  { showPlayPause: true, isFullscreen: false, zoom: null, rate: null },
);

const emit = defineEmits<{
  (e: "toggle-fullscreen", event?: MouseEvent): void;
  (e: "zoom-drag-start"): void;
  (e: "zoom-input", percent: number): void;
  (e: "zoom-commit", percent: number): void;
  /** 点缩放按钮：回到 100% */
  (e: "zoom-reset"): void;
  (e: "update:rate", rate: number): void;
}>();

const { t } = useI18n();

const barRef = ref<InstanceType<typeof PreviewControlBar> | null>(null);
const isPlaying = ref(false);
const currentTime = ref(0);
const duration = ref(0);
// 视频音量 / 静音状态持久化，跨视频与会话保留用户偏好。
const storedVolume = useLocalStorage("kabegame-video-volume", 1);
const storedMuted = useLocalStorage("kabegame-video-muted", false);
const isMuted = ref(false);
const volume = ref(1);
const lastVolume = ref(storedVolume.value > 0 ? storedVolume.value : 1);
const isSeekDragging = ref(false);
const seekDraftTime = ref<number | null>(null);
const zoomDragging = ref(false);
const speedPanelActive = ref(false);

let progressRaf: number | null = null;
let currentVideo: HTMLVideoElement | null = null;

const trackedMediaEvents = [
  "loadstart",
  "loadeddata",
  "canplay",
  "play",
  "pause",
  "emptied",
  "seeking",
  "seeked",
] as const;

const handleDebugMediaEvent = (event: Event) => {
  const video = event.currentTarget as HTMLVideoElement | null;
  if (!video) return;
};

const formatTime = (seconds: number): string => {
  if (!Number.isFinite(seconds) || seconds < 0) return "00:00";
  const rounded = Math.floor(seconds);
  const mins = Math.floor(rounded / 60);
  const secs = rounded % 60;
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
};

const effectiveCurrentTime = computed(() => {
  if (isSeekDragging.value && seekDraftTime.value != null) return seekDraftTime.value;
  return currentTime.value;
});

const displayTime = computed(() => `${formatTime(effectiveCurrentTime.value)} / ${formatTime(duration.value)}`);

const seekPercent = computed(() => {
  if (!duration.value) return 0;
  return Math.min(100, Math.max(0, (effectiveCurrentTime.value / duration.value) * 100));
});
const showControls = () => {
  barRef.value?.show();
};

const scheduleHideControls = (delay = 1000) => {
  barRef.value?.scheduleHide(delay);
};

/** 悬停面板（音量、缩放各一个）：进入即显示，离开 180 ms 后收起（移到面板上不收） */
function useHoverPanel() {
  const active = ref(false);
  let timer: ReturnType<typeof setTimeout> | null = null;
  const clear = () => {
    if (!timer) return;
    clearTimeout(timer);
    timer = null;
  };
  const enter = () => {
    clear();
    active.value = true;
    showControls();
  };
  const leave = () => {
    clear();
    timer = setTimeout(() => {
      active.value = false;
      timer = null;
      scheduleHideControls(1000);
    }, 180);
    scheduleHideControls(1000);
  };
  const reset = () => {
    clear();
    active.value = false;
  };
  return { active, enter, leave, reset };
}

const volumePanel = useHoverPanel();
const zoomPanel = useHoverPanel();

const keepVisible = computed(
  () =>
    isSeekDragging.value ||
    volumePanel.active.value ||
    zoomDragging.value ||
    zoomPanel.active.value ||
    speedPanelActive.value,
);

const zoomPercent = computed(() => Math.min(1000, Math.max(100, Math.round(props.zoom ?? 100))));

const stopProgressRaf = () => {
  if (progressRaf == null) return;
  cancelAnimationFrame(progressRaf);
  progressRaf = null;
};

const startProgressRaf = () => {
  if (progressRaf != null || isSeekDragging.value) return;
  const update = () => {
    if (!currentVideo || currentVideo.paused || currentVideo.ended) {
      progressRaf = null;
      return;
    }
    currentTime.value = currentVideo.currentTime || 0;
    progressRaf = requestAnimationFrame(update);
  };
  progressRaf = requestAnimationFrame(update);
};

const syncFromVideo = () => {
  if (!currentVideo) return;
  isPlaying.value = !currentVideo.paused && !currentVideo.ended;
  if (!isSeekDragging.value) {
    currentTime.value = currentVideo.currentTime || 0;
  }
  duration.value = Number.isFinite(currentVideo.duration) ? currentVideo.duration : 0;
  isMuted.value = currentVideo.muted || currentVideo.volume === 0;
  volume.value = currentVideo.volume;
  if (currentVideo.volume > 0) {
    lastVolume.value = currentVideo.volume;
  }
};

const handlePlay = () => {
  syncFromVideo();
  startProgressRaf();
  scheduleHideControls(1000);
};

const handlePause = () => {
  syncFromVideo();
  stopProgressRaf();
  showControls();
  scheduleHideControls(1000);
};

const handleEnded = () => {
  syncFromVideo();
  stopProgressRaf();
  showControls();
};

const handleTimeUpdate = () => {
  if (isSeekDragging.value) return;
  syncFromVideo();
};

const handleMetadata = () => {
  syncFromVideo();
};

const handleVolumeUpdate = () => {
  syncFromVideo();
  if (currentVideo) {
    storedVolume.value = currentVideo.volume;
    storedMuted.value = currentVideo.muted;
  }
};

// 应用持久化的音量 / 静音偏好到当前视频元素。
const applyStoredVolume = () => {
  if (!currentVideo) return;
  const restored = Math.min(1, Math.max(0, Number.isFinite(storedVolume.value) ? storedVolume.value : 1));
  currentVideo.volume = restored;
  currentVideo.muted = storedMuted.value || restored === 0;
  if (restored > 0) lastVolume.value = restored;
};

const handleVideoClick = () => {
  if (!props.showPlayPause) return;
  void togglePlay();
};

// 双击不切全屏（双击就是两次单击）：全屏只走控制条的按钮

const attachVideo = (video: HTMLVideoElement | null) => {
  if (currentVideo === video) return;
  if (currentVideo) {
    trackedMediaEvents.forEach((eventName) => currentVideo?.removeEventListener(eventName, handleDebugMediaEvent));
    currentVideo.removeEventListener("play", handlePlay);
    currentVideo.removeEventListener("pause", handlePause);
    currentVideo.removeEventListener("ended", handleEnded);
    currentVideo.removeEventListener("timeupdate", handleTimeUpdate);
    currentVideo.removeEventListener("loadedmetadata", handleMetadata);
    currentVideo.removeEventListener("durationchange", handleMetadata);
    currentVideo.removeEventListener("volumechange", handleVolumeUpdate);
    currentVideo.removeEventListener("click", handleVideoClick);
  }

  currentVideo = video;
  stopProgressRaf();
  volumePanel.reset();
  zoomPanel.reset();
  if (!currentVideo) {
    isPlaying.value = false;
    currentTime.value = 0;
    duration.value = 0;
    return;
  }

  trackedMediaEvents.forEach((eventName) => currentVideo?.addEventListener(eventName, handleDebugMediaEvent));
  currentVideo.addEventListener("play", handlePlay);
  currentVideo.addEventListener("pause", handlePause);
  currentVideo.addEventListener("ended", handleEnded);
  currentVideo.addEventListener("timeupdate", handleTimeUpdate);
  currentVideo.addEventListener("loadedmetadata", handleMetadata);
  currentVideo.addEventListener("durationchange", handleMetadata);
  currentVideo.addEventListener("volumechange", handleVolumeUpdate);
  currentVideo.addEventListener("click", handleVideoClick);
  applyStoredVolume();
  syncFromVideo();
  if (!currentVideo.paused && !currentVideo.ended) {
    startProgressRaf();
  }
};

const handleDocumentPointerUp = () => {
  // 缩放滑块在面板外松开时滑块自己不发 change，这里收尾，控制条恢复自动隐藏
  if (zoomDragging.value) {
    zoomDragging.value = false;
    scheduleHideControls(1000);
  }
  if (!isSeekDragging.value) return;
  if (currentVideo && seekDraftTime.value != null) {
    currentVideo.currentTime = Math.min(duration.value || 0, Math.max(0, seekDraftTime.value));
    currentTime.value = currentVideo.currentTime || 0;
  }
  isSeekDragging.value = false;
  seekDraftTime.value = null;
  if (!currentVideo) return;
  if (!currentVideo.paused && !currentVideo.ended) {
    startProgressRaf();
  }
  showControls();
  scheduleHideControls(1000);
};

watch(
  () => props.video,
  (video) => {
    attachVideo(video);
  },
  { immediate: true },
);

watch(
  () => isSeekDragging.value,
  (dragging) => {
    if (dragging) {
      showControls();
    }
  },
);

const togglePlay = async () => {
  if (!currentVideo) return;
  if (currentVideo.paused || currentVideo.ended) {
    try {
      await currentVideo.play();
    } catch {
      // ignore play interruption
    }
  } else {
    currentVideo.pause();
  }
  // showControls();
};

const handleSeekDragStart = () => {
  if (!currentVideo) return;
  isSeekDragging.value = true;
  stopProgressRaf();
  showControls();
};

const handleSeekInput = (value: number) => {
  if (!currentVideo || !duration.value) return;
  const nextTime = (value / 100) * duration.value;
  const safeTime = Number.isFinite(nextTime) ? nextTime : 0;
  seekDraftTime.value = safeTime;
  currentVideo.currentTime = safeTime;
  currentTime.value = safeTime;
  showControls();
};

const commitSeek = (value: number) => {
  if (!currentVideo || !duration.value) return;
  const nextTime = (value / 100) * duration.value;
  currentVideo.currentTime = Number.isFinite(nextTime) ? nextTime : 0;
  currentTime.value = currentVideo.currentTime || 0;
  isSeekDragging.value = false;
  seekDraftTime.value = null;
  if (!currentVideo.paused && !currentVideo.ended) {
    startProgressRaf();
  }
  showControls();
};

const handleVolumeInput = (value: number) => {
  if (!currentVideo) return;
  const nextVolume = Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
  currentVideo.volume = nextVolume;
  currentVideo.muted = nextVolume === 0;
  if (nextVolume > 0) {
    lastVolume.value = nextVolume;
  }
  syncFromVideo();
  showControls();
};

const toggleMute = () => {
  if (!currentVideo) return;
  if (currentVideo.muted || currentVideo.volume === 0) {
    const restored = lastVolume.value > 0 ? lastVolume.value : 1;
    currentVideo.muted = false;
    currentVideo.volume = restored;
  } else {
    if (currentVideo.volume > 0) lastVolume.value = currentVideo.volume;
    currentVideo.muted = true;
  }
  syncFromVideo();
  showControls();
};

const refreshControlsPointerAfterLayout = (event?: MouseEvent) => {
  void nextTick(() => {
    requestAnimationFrame(() => {
      barRef.value?.refreshPointerPosition(event);
    });
  });
};

const toggleFullscreen = (event?: MouseEvent) => {
  emit("toggle-fullscreen", event);
  showControls();
  refreshControlsPointerAfterLayout(event);
};

// 缩放只发事件，由预览弹窗经 Panzoom 缩放（和图片的缩放滑块同一套处理）
const handleZoomDragStart = () => {
  zoomDragging.value = true;
  showControls();
  emit("zoom-drag-start");
};

const handleZoomInput = (percent: number) => {
  emit("zoom-input", percent);
  showControls();
};

const handleZoomCommit = (percent: number) => {
  zoomDragging.value = false;
  emit("zoom-commit", percent);
  scheduleHideControls(1000);
};

onBeforeUnmount(() => {
  volumePanel.reset();
  zoomPanel.reset();
  stopProgressRaf();
  attachVideo(null);
  document.removeEventListener("mouseup", handleDocumentPointerUp);
  document.removeEventListener("touchend", handleDocumentPointerUp);
});

document.addEventListener("mouseup", handleDocumentPointerUp);
document.addEventListener("touchend", handleDocumentPointerUp, { passive: true });
</script>

<style scoped lang="scss">
.seek-wrap {
  flex: 1;
  position: relative;
}

.time-text {
  position: absolute;
  top: calc(50% + 8px);
  right: 0;
  font-size: 12px;
  line-height: 1;
  text-align: right;
  color: rgba(255, 255, 255, 0.92);
  font-variant-numeric: tabular-nums;
  user-select: none;
  pointer-events: none;
}

.hover-panel-wrap {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
}

/* 放大后显示百分比（最长「1000%」），宽度随内容；没放大时是图标，同其它按钮 30px */
.control-btn.zoom-btn {
  width: auto;
  min-width: 30px;
  padding: 0 6px;
}

.zoom-btn-text {
  font-size: 11px;
  line-height: 1;
  font-variant-numeric: tabular-nums;
  user-select: none;
}

.slider-panel {
  position: absolute;
  bottom: calc(100% + 8px);
  left: 50%;
  width: 34px;
  height: 120px;
  padding: 8px 6px;
  border-radius: 10px;
  background: rgba(15, 16, 20, 0.82);
  backdrop-filter: blur(8px);
  box-shadow: 0 8px 20px rgba(0, 0, 0, 0.35);
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0;
  transform: translate(-50%, 6px);
  pointer-events: none;
  transition:
    opacity 0.2s ease,
    transform 0.2s ease;

  &.visible {
    opacity: 1;
    transform: translate(-50%, 0);
    pointer-events: auto;
  }
}
</style>
