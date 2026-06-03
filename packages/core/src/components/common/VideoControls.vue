<template>
  <PreviewControlBar ref="barRef" :is-fullscreen="isFullscreen" :keep-visible="keepVisible">
    <button v-if="showPlayPause" class="control-btn" type="button" :aria-label="isPlaying ? 'Pause' : 'Play'" @click="togglePlay">
      <svg v-if="!isPlaying" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M8 5v14l11-7z" />
      </svg>
      <svg v-else viewBox="0 0 24 24" aria-hidden="true">
        <path d="M7 5h4v14H7zM13 5h4v14h-4z" />
      </svg>
    </button>

    <div class="time-text">{{ displayTime }}</div>

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
    </div>

    <div class="volume-wrap" @mouseenter="handleVolumeEnter" @mouseleave="handleVolumeLeave">
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
        class="volume-panel"
        :class="{ visible: volumePanelVisible }"
        @mouseenter="handleVolumeEnter"
        @mouseleave="handleVolumeLeave"
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

    <button class="control-btn" type="button" :aria-label="isFullscreen ? 'Exit Fullscreen' : 'Fullscreen'" @click="toggleFullscreen">
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
import { computed, onBeforeUnmount, ref, watch } from "vue";
import PreviewControlBar from "./PreviewControlBar.vue";
import PreviewRangeSlider from "./PreviewRangeSlider.vue";

const props = withDefaults(
  defineProps<{
    video: HTMLVideoElement | null;
    /** When false, hide play/pause button (e.g. preview dialog: video always plays, no pause to avoid white frame). */
    showPlayPause?: boolean;
    isFullscreen?: boolean;
  }>(),
  { showPlayPause: true, isFullscreen: false }
);

const emit = defineEmits<{
  (e: "toggle-fullscreen"): void;
}>();

const barRef = ref<InstanceType<typeof PreviewControlBar> | null>(null);
const isPlaying = ref(false);
const currentTime = ref(0);
const duration = ref(0);
const isMuted = ref(false);
const volume = ref(1);
const lastVolume = ref(1);
const isSeekDragging = ref(false);
const seekDraftTime = ref<number | null>(null);
const volumePanelActive = ref(false);

let volumePanelTimer: ReturnType<typeof setTimeout> | null = null;
let progressRaf: number | null = null;
let currentVideo: HTMLVideoElement | null = null;

const trackedMediaEvents = ["loadstart", "loadeddata", "canplay", "play", "pause", "emptied", "seeking", "seeked"] as const;

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

const displayTime = computed(
  () => `${formatTime(effectiveCurrentTime.value)} / ${formatTime(duration.value)}`
);

const seekPercent = computed(() => {
  if (!duration.value) return 0;
  return Math.min(100, Math.max(0, (effectiveCurrentTime.value / duration.value) * 100));
});
const keepVisible = computed(() => !isPlaying.value || isSeekDragging.value || volumePanelActive.value);
const volumePanelVisible = computed(() => volumePanelActive.value);

const clearVolumePanelTimer = () => {
  if (!volumePanelTimer) return;
  clearTimeout(volumePanelTimer);
  volumePanelTimer = null;
};

const showControls = () => {
  barRef.value?.show();
};

const scheduleHideControls = (delay = 1000) => {
  barRef.value?.scheduleHide(delay);
};

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
};

const handleVideoClick = () => {
  if (!props.showPlayPause) return;
  void togglePlay();
};

const handleVideoDblClick = () => {
  void toggleFullscreen();
};

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
    currentVideo.removeEventListener("dblclick", handleVideoDblClick);
  }

  currentVideo = video;
  stopProgressRaf();
  clearVolumePanelTimer();
  volumePanelActive.value = false;
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
  currentVideo.addEventListener("dblclick", handleVideoDblClick);
  syncFromVideo();
  if (!currentVideo.paused && !currentVideo.ended) {
    startProgressRaf();
  }
};

const handleDocumentPointerUp = () => {
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
  { immediate: true }
);

watch(
  () => isSeekDragging.value,
  (dragging) => {
    if (dragging) {
      showControls();
    }
  }
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
  showControls();
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

const toggleFullscreen = () => {
  emit("toggle-fullscreen");
  showControls();
};

const handleVolumeEnter = () => {
  clearVolumePanelTimer();
  volumePanelActive.value = true;
  showControls();
};

const handleVolumeLeave = () => {
  clearVolumePanelTimer();
  volumePanelTimer = setTimeout(() => {
    volumePanelActive.value = false;
    volumePanelTimer = null;
    scheduleHideControls(1000);
  }, 180);
  scheduleHideControls(1000);
};

onBeforeUnmount(() => {
  clearVolumePanelTimer();
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
}

.volume-wrap {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
}

.volume-panel {
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
  transition: opacity 0.2s ease, transform 0.2s ease;

  &.visible {
    opacity: 1;
    transform: translate(-50%, 0);
    pointer-events: auto;
  }
}

</style>
