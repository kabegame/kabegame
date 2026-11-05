<script lang="ts">
/** 主显示器逻辑尺寸：同一会话只问一次（模块级缓存）。 */
let desktopSizeCache: { width: number; height: number } | null = null;
let desktopSizePromise: Promise<{ width: number; height: number }> | null = null;
</script>

<script setup lang="ts">
/**
 * 预览弹窗里的「桌面画布」（纯布局）：按主显示器逻辑分辨率给插槽一块固定尺寸的画布，再整体
 * `scale` 进可用区域并居中。用户看到的就是设到桌面上的样子，页面按桌面尺寸排版，并能交互。
 * 画布本身不拦指针事件。
 */
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { primaryMonitor } from "@tauri-apps/api/window";

function fallbackDesktopSize(): { width: number; height: number } {
  return {
    width: Math.max(1, Math.round(window.screen?.width || 1920)),
    height: Math.max(1, Math.round(window.screen?.height || 1080)),
  };
}

async function resolveDesktopSize(): Promise<{ width: number; height: number }> {
  if (desktopSizeCache) return desktopSizeCache;
  if (!desktopSizePromise) {
    desktopSizePromise = (async () => {
      try {
        const monitor = await primaryMonitor();
        if (monitor && monitor.size.width > 0 && monitor.size.height > 0) {
          const scale = monitor.scaleFactor > 0 ? monitor.scaleFactor : 1;
          return {
            width: Math.round(monitor.size.width / scale),
            height: Math.round(monitor.size.height / scale),
          };
        }
      } catch (error) {
        console.warn("[WallpaperDesktopCanvas] primaryMonitor 失败，回退 window.screen:", error);
      }
      return fallbackDesktopSize();
    })().then((size) => {
      desktopSizeCache = size;
      return size;
    });
  }
  return desktopSizePromise;
}

const desktop = ref(desktopSizeCache ?? fallbackDesktopSize());
const containerRef = ref<HTMLElement | null>(null);
const available = ref({ width: 0, height: 0 });
let observer: ResizeObserver | null = null;

const scale = computed(() => {
  const { width, height } = available.value;
  if (width <= 0 || height <= 0) return 0;
  return Math.min(width / desktop.value.width, height / desktop.value.height);
});

/** 画布缩放后在容器里的居中偏移。 */
const offset = computed(() => {
  const k = scale.value;
  return {
    left: (available.value.width - desktop.value.width * k) / 2,
    top: (available.value.height - desktop.value.height * k) / 2,
  };
});

const canvasStyle = computed(() => {
  const k = scale.value;
  return {
    width: `${desktop.value.width}px`,
    height: `${desktop.value.height}px`,
    left: `${offset.value.left}px`,
    top: `${offset.value.top}px`,
    transform: `scale(${k})`,
    visibility: k > 0 ? "visible" : "hidden",
  } as Record<string, string>;
});

function measure() {
  const el = containerRef.value;
  if (!el) return;
  available.value = { width: el.clientWidth, height: el.clientHeight };
}

onMounted(() => {
  measure();
  observer = new ResizeObserver(() => measure());
  if (containerRef.value) observer.observe(containerRef.value);
  void resolveDesktopSize().then((size) => {
    desktop.value = size;
  });
});

onBeforeUnmount(() => {
  observer?.disconnect();
  observer = null;
});
</script>

<template>
  <div ref="containerRef" class="relative w-full h-full overflow-hidden">
    <div class="absolute origin-top-left overflow-hidden bg-black shadow-lg" :style="canvasStyle">
      <slot />
    </div>
  </div>
</template>
