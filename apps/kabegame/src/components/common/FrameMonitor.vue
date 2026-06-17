<template>
  <div
    v-if="visible"
    class="fixed right-3 top-3 z-[4000] h-8 w-36 pointer-events-none select-none inline-flex items-center justify-center gap-2 rounded-md border border-zinc-600/60 bg-zinc-950/75 font-mono text-[11px] shadow-lg backdrop-blur-md"
    aria-label="frame monitor"
  >
    <span class="inline-flex items-center gap-1">
      <span class="text-zinc-400">MIN</span>
      <span :class="minFpsClass">{{ displayMinFps }}</span>
    </span>
    <span class="inline-flex items-center gap-1">
      <span class="text-zinc-400">AVG</span>
      <span :class="avgFpsClass">{{ displayAvgFps }}</span>
    </span>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { IS_DEV } from "@kabegame/core/env";
import {
  FRAME_MONITOR_SAMPLE_MS,
  getFrameMonitorLevel,
  useFrameMonitorStore,
  type FrameMonitorLevel,
  type FrameMonitorSnapshot,
} from "@/stores/frameMonitor";

const visible = IS_DEV;
const frameMonitorStore = useFrameMonitorStore();
const snapshot = ref<FrameMonitorSnapshot | null>(frameMonitorStore.getSnapshot());
let frameMonitorHookId: number | null = null;

onMounted(() => {
  frameMonitorHookId = frameMonitorStore.registerHook({
    intervalMs: FRAME_MONITOR_SAMPLE_MS,
    callback: (nextSnapshot) => {
      snapshot.value = nextSnapshot;
    },
  });
});

onUnmounted(() => {
  if (frameMonitorHookId !== null) {
    frameMonitorStore.unregisterHook(frameMonitorHookId);
    frameMonitorHookId = null;
  }
});

const displayAvgFps = computed(() => (
  snapshot.value === null ? "--" : String(snapshot.value.avgFps)
));
const displayMinFps = computed(() => (
  snapshot.value === null ? "--" : String(snapshot.value.minFps)
));

const getFpsClass = (level: FrameMonitorLevel) => {
  switch (level) {
    case "bad":
      return "text-red-300";
    case "warn":
      return "text-yellow-300";
    default:
      return "text-emerald-300";
  }
};

const avgFpsClass = computed(() => getFpsClass(getFrameMonitorLevel(snapshot.value?.avgFps ?? null)));
const minFpsClass = computed(() => getFpsClass(getFrameMonitorLevel(snapshot.value?.minFps ?? null)));
</script>
