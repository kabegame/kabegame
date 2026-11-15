<script lang="ts">
/** 主显示器逻辑尺寸：同一会话只问一次（模块级缓存）。 */
let desktopSizeCache: { width: number; height: number } | null = null;
let desktopSizePromise: Promise<{ width: number; height: number }> | null = null;

/** 画布占窗口内容区的比例。后端截整窗再按它裁，不用 CDP 的 `clip`（整个窗口会跳变，见 `capture_screenshot`）。 */
export interface CoverRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 包住一次按区域截图：区域在这里量，隐藏与恢复也都在这里，调用方只管在回调里截。 */
export type CoverRegionScope = <T>(run: (region: CoverRegion) => Promise<T>) => Promise<T>;

/**
 * 截图期间 `<html>` 上的属性：盖在画布上的 UI 按它隐藏（看板娘 `KamechanMascot.vue`、预览容器里的工具条与箭头
 * `ImagePreviewDialog.vue`、弹出层见本文件末尾的样式）。
 */
const COVER_CAPTURE_ATTR = "data-kb-cover-capture";
/** 等这一帧时窗口可能被遮挡，rAF 不触发，等不到就按超时往下走。 */
const FRAME_TIMEOUT_MS = 100;

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, FRAME_TIMEOUT_MS);
    requestAnimationFrame(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** 两个矩形的交集；不相交时宽高为 0。 */
export function intersectRect(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): CoverRegion {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
}
</script>

<script setup lang="ts">
/**
 * 预览弹窗里的壁纸画布（纯布局）：给插槽一块固定尺寸的画布，再整体 `scale` 进可用区域并居中，没有背景，
 * 看起来和单独一张图一样。尺寸取 `contentSize`，也就是图片行的宽高；网页壁纸没有固有尺寸，透视场景读不到分辨率，
 * 这时按主显示器逻辑分辨率，页面照这个尺寸排版。
 * 预览放大时，Panzoom 变换的是包住本组件的那一层（`ImagePreviewDialog`），本组件的布局不变；接住真实鼠标的覆盖层在
 * 变换层之外（`WallpaperPointerOverlay`）。放大倍数经 `zoom` 提供给画布里的场景（`WALLPAPER_PREVIEW_ZOOM`），它按
 * `sceneDisplayScale` 定画布分辨率。
 * 注入的点击会把键盘焦点切进壁纸 iframe：等真实左键松开后还给父页面（`keepFocusOutOfFrames`），预览的 Esc、方向键才照常。
 * Linux 退回 iframe 直接收真实鼠标，不管焦点。
 */
import { computed, onBeforeUnmount, onMounted, provide, ref } from "vue";
import { primaryMonitor } from "@tauri-apps/api/window";
import { NATIVE_FRAME_POINTER, keepFocusOutOfFrames } from "./framePointer";
import { WALLPAPER_PREVIEW_ZOOM } from "./wpeSceneStyle";

const props = withDefaults(
  defineProps<{
    contentSize?: { width: number; height: number } | null;
    /** 预览的 Panzoom 缩放（没放大为 1） */
    zoom?: number;
  }>(),
  { contentSize: null, zoom: 1 },
);
// 画布里的场景按它定画布分辨率（`sceneDisplayScale`）
provide(
  WALLPAPER_PREVIEW_ZOOM,
  computed(() => props.zoom),
);

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
        console.warn("[WallpaperPreviewCanvas] primaryMonitor 失败，回退 window.screen:", error);
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
const size = computed(() => props.contentSize ?? desktop.value);
const containerRef = ref<HTMLElement | null>(null);
const canvasRef = ref<HTMLElement | null>(null);
const available = ref({ width: 0, height: 0 });
let observer: ResizeObserver | null = null;

const scale = computed(() => {
  const { width, height } = available.value;
  if (width <= 0 || height <= 0) return 0;
  return Math.min(width / size.value.width, height / size.value.height);
});

/** 画布缩放后在容器里的居中偏移。 */
const offset = computed(() => {
  const k = scale.value;
  return {
    left: (available.value.width - size.value.width * k) / 2,
    top: (available.value.height - size.value.height * k) / 2,
  };
});

const canvasStyle = computed(() => {
  const k = scale.value;
  return {
    width: `${size.value.width}px`,
    height: `${size.value.height}px`,
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

// 注入的点击切进画布里的壁纸 iframe 的焦点，真实左键松开后还给父页面
let stopFrameFocus: (() => void) | null = null;

onMounted(() => {
  if (NATIVE_FRAME_POINTER) {
    stopFrameFocus = keepFocusOutOfFrames((frame) => canvasRef.value?.contains(frame) ?? false);
  }
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
  stopFrameFocus?.();
  stopFrameFocus = null;
});

/**
 * 隐藏看板娘、弹出层等盖在画布上的东西，等两帧让它们从合成结果里消失、量画布矩形，`run` 结束后恢复，出错也恢复。
 * 弹出层是直接藏，不是等它关完：右键菜单点完还要淡出 100 ms，Reka 等退场动画放完才移除，等多久都和帧率、动画时长绑在一起。
 * 量的是实际画布，外层容器带留白。给了 `viewport`（预览里壁纸的可见区域，Panzoom 的父元素）时只截两者的交集：放大后
 * 画布超出可见区域，截看得见的那一块，不截进侧栏（后端只按整张截图钳制）。窗口被完全遮挡时矩形可能量得出来，但截到的
 * 是残缺的画面，所以也报错，不截。
 */
const withCaptureRegion = async <T,>(
  run: (region: CoverRegion) => Promise<T>,
  viewport?: Element | null,
): Promise<T> => {
  const root = document.documentElement;
  root.setAttribute(COVER_CAPTURE_ATTR, "");
  try {
    await nextFrame();
    await nextFrame();
    const canvas = canvasRef.value;
    // 壁纸层出画面后还要淡入，这时截到的是黑底。只等过渡：页面里可能有循环动画，等不到头
    const fading = canvas?.getAnimations({ subtree: true }).filter((item) => item instanceof CSSTransition) ?? [];
    await Promise.allSettled(fading.map((item) => item.finished));
    const canvasRect = canvas?.getBoundingClientRect();
    const rect = canvasRect && viewport ? intersectRect(canvasRect, viewport.getBoundingClientRect()) : canvasRect;
    if (document.visibilityState !== "visible" || !rect || rect.width <= 0 || rect.height <= 0) {
      throw new Error("wallpaper canvas is not visible");
    }
    const { innerWidth, innerHeight } = window;
    return await run({
      x: rect.x / innerWidth,
      y: rect.y / innerHeight,
      width: rect.width / innerWidth,
      height: rect.height / innerHeight,
    });
  } finally {
    root.removeAttribute(COVER_CAPTURE_ATTR);
  }
};

defineExpose({ withCaptureRegion });
</script>

<template>
  <div ref="containerRef" class="relative w-full h-full overflow-hidden">
    <div ref="canvasRef" class="absolute origin-top-left overflow-hidden" :style="canvasStyle">
      <slot />
    </div>
  </div>
</template>

<style>
/*
 * 截壁纸封面时藏起全部弹出层（右键菜单、提示、气泡都包在 Reka 的这个外层里，传送到 body 下，不在预览容器里）。
 * 设为封面多半从右键菜单点：菜单关掉后还要淡出 100 ms（`kb-pop-out`），截图只等两帧，不藏就会截进去。
 */
html[data-kb-cover-capture] [data-reka-popper-content-wrapper] {
  visibility: hidden;
}
</style>
