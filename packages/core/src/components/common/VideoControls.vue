<template>
  <div
    class="video-controls-hover-zone"
    :class="{ 'is-fullscreen': isFullscreen }"
    @mouseenter="handleHotzoneEnter"
    @mouseleave="handleHotzoneLeave"
  />
  <div
    class="video-controls"
    :class="{ hidden: !controlsVisible, 'is-fullscreen': isFullscreen }"
    @mouseenter="handleControlsEnter"
    @mouseleave="handleControlsLeave"
  >
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
      <input
        class="seek-range"
        type="range"
        min="0"
        max="100"
        step="0.1"
        :value="seekPercent"
        aria-label="Seek"
        @mousedown="handleSeekDragStart"
        @touchstart="handleSeekDragStart"
        @input="handleSeekInput"
        @change="commitSeek"
        @click.stop
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
        <input
          class="volume-range vertical"
          type="range"
          min="0"
          max="1"
          step="0.01"
          :value="volume"
          aria-label="Volume"
          @input="handleVolumeInput"
          @mousedown.stop
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
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";

const props = withDefaults(
  defineProps<{
    video: HTMLVideoElement | null;
    /** When false, hide play/pause button (e.g. preview dialog: video always plays, no pause to avoid white frame). */
    showPlayPause?: boolean;
  }>(),
  { showPlayPause: true }
);

const isPlaying = ref(false);
const currentTime = ref(0);
const duration = ref(0);
const isMuted = ref(false);
const volume = ref(1);
const lastVolume = ref(1);
const isFullscreen = ref(false);
const controlsVisible = ref(true);
const isPointerInside = ref(false);
const isSeekDragging = ref(false);
const seekDraftTime = ref<number | null>(null);
const isVolumeHover = ref(false);
const volumePanelActive = ref(false);

let hideTimer: ReturnType<typeof setTimeout> | null = null;
let volumePanelTimer: ReturnType<typeof setTimeout> | null = null;
let progressRaf: number | null = null;
let currentVideo: HTMLVideoElement | null = null;
let debugVideoSeq = 0;

// #region agent log
const debugVideoLog = (message: string, data: Record<string, unknown>, hypothesisId: string) => {
  fetch("http://127.0.0.1:7584/ingest/c0bebee6-485b-4fa2-aa0e-0bbc81e4acc7", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Debug-Session-Id": "a16946",
    },
    body: JSON.stringify({
      sessionId: "a16946",
      runId: "pre-fix",
      hypothesisId,
      location: "packages/core/src/components/common/VideoControls.vue",
      message,
      data,
      timestamp: Date.now(),
    }),
  }).catch(() => {});
};
// #endregion

const ensureDebugVideoId = (video: HTMLVideoElement | null) => {
  if (!video) return null;
  if (!video.dataset.kgPreviewDebugId) {
    debugVideoSeq += 1;
    video.dataset.kgPreviewDebugId = String(debugVideoSeq);
  }
  return video.dataset.kgPreviewDebugId;
};

const trackedMediaEvents = ["loadstart", "loadeddata", "canplay", "play", "pause", "emptied", "seeking", "seeked"] as const;

const handleDebugMediaEvent = (event: Event) => {
  const video = event.currentTarget as HTMLVideoElement | null;
  if (!video) return;
  // #region agent log
  debugVideoLog("media event", {
    event: event.type,
    videoId: ensureDebugVideoId(video),
    src: video.currentSrc || video.src,
    currentTime: video.currentTime,
    duration: Number.isFinite(video.duration) ? video.duration : null,
    paused: video.paused,
    ended: video.ended,
    readyState: video.readyState,
    networkState: video.networkState,
  }, "H1/H2/H4/H5");
  // #endregion
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
const volumePanelVisible = computed(() => controlsVisible.value && volumePanelActive.value);

const clearHideTimer = () => {
  if (!hideTimer) return;
  clearTimeout(hideTimer);
  hideTimer = null;
};

const clearVolumePanelTimer = () => {
  if (!volumePanelTimer) return;
  clearTimeout(volumePanelTimer);
  volumePanelTimer = null;
};

const scheduleHideControls = (delay = 1000) => {
  clearHideTimer();
  if (isPointerInside.value || isSeekDragging.value || volumePanelActive.value) return;
  hideTimer = setTimeout(() => {
    if (isPointerInside.value || isSeekDragging.value || volumePanelActive.value) return;
    controlsVisible.value = false;
    hideTimer = null;
  }, delay);
};

const showControls = () => {
  controlsVisible.value = true;
  clearHideTimer();
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
  showControls();
  scheduleHideControls(1000);
};

const handlePause = () => {
  syncFromVideo();
  stopProgressRaf();
  controlsVisible.value = true;
  clearHideTimer();
};

const handleEnded = () => {
  syncFromVideo();
  stopProgressRaf();
  controlsVisible.value = true;
  clearHideTimer();
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

  // #region agent log
  debugVideoLog("attachVideo", {
    prevVideoId: ensureDebugVideoId(currentVideo),
    nextVideoId: ensureDebugVideoId(video),
    prevSrc: currentVideo?.currentSrc || currentVideo?.src || null,
    nextSrc: video?.currentSrc || video?.src || null,
    prevCurrentTime: currentVideo?.currentTime ?? null,
    nextCurrentTime: video?.currentTime ?? null,
  }, "H5");
  // #endregion

  currentVideo = video;
  stopProgressRaf();
  clearHideTimer();
  clearVolumePanelTimer();
  volumePanelActive.value = false;
  controlsVisible.value = true;

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
    showControls();
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
};

const handleFullscreenChange = () => {
  if (!currentVideo) {
    isFullscreen.value = false;
    return;
  }
  const wrapper = currentVideo.closest(".preview-video-wrapper");
  isFullscreen.value = !!wrapper && document.fullscreenElement === wrapper;
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
  // #region agent log
  debugVideoLog("togglePlay before", {
    videoId: ensureDebugVideoId(currentVideo),
    paused: currentVideo.paused,
    ended: currentVideo.ended,
    currentTime: currentVideo.currentTime,
    duration: Number.isFinite(currentVideo.duration) ? currentVideo.duration : null,
    readyState: currentVideo.readyState,
    networkState: currentVideo.networkState,
  }, "H2/H4/H5");
  // #endregion
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

const handleSeekInput = (event: Event) => {
  if (!currentVideo || !duration.value) return;
  const value = Number((event.target as HTMLInputElement).value);
  const nextTime = (value / 100) * duration.value;
  const safeTime = Number.isFinite(nextTime) ? nextTime : 0;
  seekDraftTime.value = safeTime;
  currentVideo.currentTime = safeTime;
  currentTime.value = safeTime;
  showControls();
};

const commitSeek = (event: Event) => {
  if (!currentVideo || !duration.value) return;
  const value = Number((event.target as HTMLInputElement).value);
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

const handleVolumeInput = (event: Event) => {
  if (!currentVideo) return;
  const value = Number((event.target as HTMLInputElement).value);
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

const toggleFullscreen = async () => {
  if (!currentVideo) return;
  const wrapper = currentVideo.closest(".preview-video-wrapper") as HTMLElement | null;
  if (!wrapper) return;
  try {
    if (document.fullscreenElement === wrapper) {
      await document.exitFullscreen();
    } else if (!document.fullscreenElement) {
      await wrapper.requestFullscreen();
    }
  } catch {
    // ignore unsupported fullscreen transitions
  }
  showControls();
};

function handleHotzoneEnter() {
  isPointerInside.value = true;
  showControls();
}

function handleHotzoneLeave() {
  isPointerInside.value = false;
  scheduleHideControls(1000);
}

function handleControlsEnter() {
  isPointerInside.value = true;
  showControls();
}

function handleControlsLeave() {
  isPointerInside.value = false;
  scheduleHideControls(1000);
}

const handleVolumeEnter = () => {
  clearVolumePanelTimer();
  isVolumeHover.value = true;
  volumePanelActive.value = true;
  showControls();
};

const handleVolumeLeave = () => {
  isVolumeHover.value = false;
  clearVolumePanelTimer();
  volumePanelTimer = setTimeout(() => {
    volumePanelActive.value = false;
    volumePanelTimer = null;
    scheduleHideControls(1000);
  }, 180);
  scheduleHideControls(1000);
}

onBeforeUnmount(() => {
  clearHideTimer();
  clearVolumePanelTimer();
  stopProgressRaf();
  attachVideo(null);
  document.removeEventListener("mouseup", handleDocumentPointerUp);
  document.removeEventListener("touchend", handleDocumentPointerUp);
  document.removeEventListener("fullscreenchange", handleFullscreenChange);
});

document.addEventListener("mouseup", handleDocumentPointerUp);
document.addEventListener("touchend", handleDocumentPointerUp, { passive: true });
document.addEventListener("fullscreenchange", handleFullscreenChange);
</script>

<style scoped lang="scss">
.video-controls-hover-zone {
  position: absolute;
  left: 20%;
  right: 20%;
  bottom: 0;
  height: 76px;
  z-index: 3;

  &.is-fullscreen {
    left: 5%;
    right: 5%;
  }
}

.video-controls {
  position: absolute;
  left: 20%;
  right: 20%;
  bottom: 16px;
  z-index: 4;
  min-height: 44px;
  padding: 8px 10px;
  border-radius: 12px;
  display: flex;
  align-items: center;
  gap: 10px;
  color: #fff;
  background: rgba(15, 16, 20, 0.56);
  backdrop-filter: blur(8px);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
  opacity: 1;
  pointer-events: auto;
  transition: opacity 0.2s ease;

  &.hidden {
    opacity: 0;
    pointer-events: none;
  }

  &.is-fullscreen {
    left: 5%;
    right: 5%;
  }
}

.control-btn {
  width: 30px;
  height: 30px;
  border: none;
  border-radius: 999px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: inherit;
  background: rgba(255, 255, 255, 0.1);
  cursor: pointer;
  transition: background-color 0.16s ease;

  &:hover {
    background: rgba(255, 255, 255, 0.2);
  }

  svg {
    width: 18px;
    height: 18px;
    fill: currentColor;
  }
}

.time-text {
  width: 110px;
  font-size: 12px;
  line-height: 1;
  text-align: center;
  user-select: none;
  color: rgba(255, 255, 255, 0.92);
}

.seek-wrap {
  flex: 1;
}

.seek-range,
.volume-range {
  width: 100%;
  margin: 0;
  cursor: pointer;
  accent-color: #ff5fb8;
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

.volume-range.vertical {
  width: 104px;
  transform: rotate(-90deg);
  transform-origin: center;
}
</style>
