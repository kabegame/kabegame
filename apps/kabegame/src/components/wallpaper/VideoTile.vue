<template>
  <canvas
    ref="canvasEl"
    class="wallpaper-video-tile absolute inset-0 z-5 w-full h-full pointer-events-none"
    :style="{ filter: filter || undefined, transform: flip ? 'scaleX(-1)' : undefined }"
  />
</template>

<script setup lang="ts">
/**
 * 桌面壁纸的视频平铺：CSS 背景不能拿 `<video>` 当图源，所以把视频的当前帧画进画布，按 {@link tileRects} 重复铺满
 * （和图片平铺的 CSS 背景同一规则：等比放进、居中一格、向四周重复）。
 *
 * - 视频元素仍由 `ImageContent` 播放、放进居中一格，压在画布下面；画布盖满整层（`z-5`，高于 `ImageContent` 里的各层）。
 * - 有新帧才画（`requestVideoFrameCallback`），暂停时停在最后一帧；画布尺寸变了（`ResizeObserver`，按设备像素）当场重画。
 *   没有 `requestVideoFrameCallback` 的环境退到 rAF，播放位置变了才画。
 * - WPE 视频的作者属性：颜色调整（`filter`）与水平翻转（`flip`）照 `<video>` 的样式加在画布上；格子关于中心对称，
 *   整块画布翻转等于每格各自翻转。
 */
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { tileRects } from "./tileLayout";

const props = defineProps<{
  /** 要平铺的视频（`ImageContent` 的 `<video>`） */
  video: HTMLVideoElement;
  /** WPE 视频的颜色调整（CSS filter），没有时空 */
  filter?: string;
  /** WPE 视频的水平翻转 */
  flip?: boolean;
}>();

const canvasEl = ref<HTMLCanvasElement | null>(null);
let context: CanvasRenderingContext2D | null = null;
let frameHandle: { video: HTMLVideoElement; id: number } | null = null;
let rafHandle = 0;
let lastTime = -1;
let resizeObserver: ResizeObserver | null = null;

function draw() {
  const canvas = canvasEl.value;
  const video = props.video;
  if (!canvas || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || video.videoWidth === 0) return;
  context ??= canvas.getContext("2d");
  if (!context) return;
  lastTime = video.currentTime;
  context.clearRect(0, 0, canvas.width, canvas.height);
  for (const rect of tileRects(canvas.width, canvas.height, video.videoWidth, video.videoHeight))
    context.drawImage(video, rect.x, rect.y, rect.width, rect.height);
}

function schedule() {
  const video = props.video;
  if (typeof video.requestVideoFrameCallback === "function") {
    frameHandle = { video, id: video.requestVideoFrameCallback(onVideoFrame) };
  } else {
    rafHandle = requestAnimationFrame(onAnimationFrame);
  }
}

function cancel() {
  if (frameHandle) frameHandle.video.cancelVideoFrameCallback(frameHandle.id);
  frameHandle = null;
  if (rafHandle) cancelAnimationFrame(rafHandle);
  rafHandle = 0;
}

function onVideoFrame() {
  frameHandle = null;
  draw();
  schedule();
}

function onAnimationFrame() {
  rafHandle = 0;
  if (props.video.currentTime !== lastTime) draw();
  schedule();
}

/** 画布的像素尺寸跟显示尺寸（设备像素）；改尺寸会清空画布，改完立刻重画（ResizeObserver 回调在绘制之前，不闪） */
function resize(entry: ResizeObserverEntry) {
  const canvas = canvasEl.value;
  if (!canvas) return;
  const device = entry.devicePixelContentBoxSize?.[0];
  const width = device ? device.inlineSize : Math.round(entry.contentRect.width * devicePixelRatio);
  const height = device ? device.blockSize : Math.round(entry.contentRect.height * devicePixelRatio);
  if (canvas.width === width && canvas.height === height) return;
  canvas.width = width;
  canvas.height = height;
  draw();
}

onMounted(() => {
  const canvas = canvasEl.value;
  if (canvas && typeof ResizeObserver !== "undefined") {
    resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) resize(entry);
    });
    try {
      resizeObserver.observe(canvas, { box: "device-pixel-content-box" });
    } catch {
      resizeObserver.observe(canvas);
    }
  }
  draw();
  schedule();
});

// 换了视频元素（换源重建了 `<video>`）：改到新元素上等帧，先把它当前的帧画上
watch(
  () => props.video,
  () => {
    cancel();
    lastTime = -1;
    draw();
    schedule();
  },
);

onBeforeUnmount(() => {
  cancel();
  resizeObserver?.disconnect();
  resizeObserver = null;
});
</script>
