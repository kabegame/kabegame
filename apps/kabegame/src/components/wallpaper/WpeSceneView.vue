<script setup lang="ts">
/**
 * WPE 场景壁纸（`x-wpe/scene`）的视图：场景宿主（`apps/wpe-scene`，P3-0）的 `file:` iframe 外壳，地位等同
 * `WallpaperStage` web 层的网页壁纸 iframe。编译、渲染、用户属性与后处理档位都在宿主里，这里不碰。
 *
 * - 地址：`get_wpe_scene_host_url` + `kbScene=<图片 id>` + `kbInstance=<实例号>`；换目标就换实例号、重建 iframe。
 * - 状态：宿主经 `wpe_scene_report` 报 `ready` / `fallback`，后端以 `wpe-scene-status` 发回本窗口，这里只认本实例号，
 *   照旧 emit `ready` / `fallback(reasons)`；取不到宿主地址时 emit `fallback(["host:unavailable"])`。
 * - 暂停与音量：回应本 iframe 里垫片的音量请求（`wpeWebVolume.ts` 的协议，消息带 `paused`，垫片转成
 *   `setPaused`），`volume` / `paused` 变化时主动推。第一次收到请求说明垫片已在跑，emit `alive`：
 *   壁纸窗口从此把 ping 交给宿主里的垫片应答。
 * - 样式：`styleMode` 经 `wpeSceneStyle.ts` 的协议交给宿主，由它铺放。
 * - 显示缩放：iframe 实际显示大小 ÷ 布局大小（`displayScaleOf`），同一协议交给宿主，宿主按它把画布缩到实际显示
 *   大小。预览画布（`WallpaperPreviewCanvas`）按内容尺寸布局、再整体 `scale`，这个 transform 在 iframe 里量不到，
 *   只能在这里量。宿主请求时必回；iframe 尺寸变化（ResizeObserver）、窗口尺寸变化时量一次；只有祖先 transform
 *   变了时（弹窗缩放、预览弹窗动画）布局尺寸不变、哪个 observer 都不触发，所以再按 250ms 轮询比较，只在值变时推。
 * - 指针：`interactive` 时 iframe 接收指针事件，宿主自己算 `g_PointerPosition`。开场（P5a 收尾）宿主还没收到过事件，
 *   iframe 建好（`load`）与宿主报 ready 时各问一次 Rust 光标在本窗口里的位置（`wpe_scene_cursor`，桌面壁纸窗口的页面
 *   收不到鼠标事件，只能问 Rust），按 iframe 显示矩形换成归一化坐标交给宿主当初值；命令返回 null（非 Windows）或
 *   非桌面环境时用本页最近一次 `pointermove` / `pointerdown` 的位置，也没有就不发。不交互时不发。
 */
import { invoke } from "@/api";
import { IS_ANDROID, IS_WEB } from "@/env";
import { logger } from "@/utils/logger";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { Mode, WallpaperTarget } from "./types";
import { WEB_SANDBOX } from "./webSandbox";
import {
  displayScaleOf,
  isWpeSceneStyleRequest,
  scenePointerIn,
  wpeSceneDisplayMessage,
  wpeScenePointerMessage,
  wpeSceneStyleMessage,
} from "./wpeSceneStyle";
import { isWpeVolumeRequest, webHostVolume, wpeVolumeMessage } from "./wpeWebVolume";
import { wpeContextMenuPoint, type ViewportPoint } from "./wpeContextMenu";

/**
 * 祖先 transform 变化不触发任何 observer，按这个间隔核对显示缩放。不用 rAF：桌面壁纸窗口里场景一直在，
 * 每帧唤醒父页面主线程不值得；最多晚这么久跟上，期间画面只是被浏览器多缩放一下。
 */
const DISPLAY_CHECK_INTERVAL_MS = 250;
/** 显示缩放的相对变化小于这个值不推：亚像素抖动不值得让宿主重算画布。 */
const DISPLAY_SCALE_EPSILON = 1e-4;

const props = withDefaults(
  defineProps<{
    target: WallpaperTarget;
    styleMode: Mode;
    paused?: boolean;
    volume: number;
    interactive?: boolean;
  }>(),
  { paused: false, interactive: false },
);
const emit = defineEmits<{
  ready: [];
  fallback: [reasons: string[]];
  alive: [];
  /** 宿主里点了右键（垫片转发，`wpeContextMenu.ts`），坐标已换算到本页面视口 */
  contextmenu: [point: ViewportPoint];
}>();
const frame = ref<HTMLIFrameElement | null>(null);
const src = ref("");
let instance = "";
let alive = false;
let generation = 0;
let disposed = false;
let unlisten: UnlistenFn | null = null;
/** 最近推给当前宿主的显示缩放；换宿主（重建 iframe）时清空。 */
let postedScale: number | null = null;
let resizeObserver: ResizeObserver | null = null;
let displayTimer: number | undefined;
/** 本页最近一次 `pointermove` / `pointerdown` 的视口坐标（CSS 像素）：问不到 Rust 时的开场指针。 */
let pagePointer: { x: number; y: number } | null = null;

function onPagePointer(event: PointerEvent) {
  pagePointer = { x: event.clientX, y: event.clientY };
}

function postVolume() {
  const target = frame.value?.contentWindow;
  if (!target) return;
  try {
    target.postMessage(wpeVolumeMessage(webHostVolume(props.volume, props.paused), props.paused), "*");
  } catch (error) {
    logger.warn(`场景宿主音量发送失败: ${error}`);
  }
}

function postStyle() {
  frame.value?.contentWindow?.postMessage(wpeSceneStyleMessage(props.styleMode), "*");
}

/**
 * 量显示缩放，变了才推；`force`（宿主请求）时照推。量不出来（还没布局、`scale(0)`）就不推，宿主保持上次的值
 * （起初是 1），轮询会在量得出来时补上。
 */
function postDisplay(force = false) {
  const element = frame.value;
  const target = element?.contentWindow;
  if (!element || !target) return;
  const scale = displayScaleOf(element);
  if (scale === null) return;
  if (!force && postedScale !== null && Math.abs(scale - postedScale) <= postedScale * DISPLAY_SCALE_EPSILON) return;
  postedScale = scale;
  target.postMessage(wpeSceneDisplayMessage(scale), "*");
}

/** 光标在本窗口里的视口坐标：先问 Rust（真实光标），拿不到（null、报错、非桌面环境）用本页最近一次鼠标位置。 */
async function cursorPoint(): Promise<{ x: number; y: number } | null> {
  if (!IS_WEB && !IS_ANDROID) {
    try {
      const point = await invoke<{ x: number; y: number } | null>("wpe_scene_cursor");
      if (point) return point;
    } catch (error) {
      logger.debug(`取光标位置失败: ${error}`);
    }
  }
  return pagePointer;
}

/** 开场指针（P5a 收尾）：`interactive` 时把光标在 iframe 里的归一化坐标交给宿主当初值。等命令期间换了宿主就不发。 */
async function postPointer() {
  if (!props.interactive) return;
  const id = generation;
  const element = frame.value;
  const point = await cursorPoint();
  if (disposed || id !== generation || !props.interactive || !point || frame.value !== element || !element) return;
  const target = element.contentWindow;
  const position = scenePointerIn(element, point);
  if (!target || !position) return;
  target.postMessage(wpeScenePointerMessage(...position), "*");
}

/** 窗口 resize 在祖先的 ResizeObserver 之前派发：预览画布要在那里重算 scale，等这一轮渲染更新跑完再量。 */
function onWindowResize() {
  window.setTimeout(() => postDisplay(), 0);
}

function onWindowMessage(event: MessageEvent) {
  const target = frame.value?.contentWindow;
  if (!target || !event.isTrusted || event.source !== target) return;
  if (isWpeSceneStyleRequest(event.data)) {
    postStyle();
    postDisplay(true);
    return;
  }
  const point = frame.value ? wpeContextMenuPoint(event.data, frame.value) : null;
  if (point) {
    emit("contextmenu", point);
    return;
  }
  if (!isWpeVolumeRequest(event.data)) return;
  postVolume();
  if (!alive) {
    alive = true;
    emit("alive");
  }
}

async function start() {
  const id = ++generation;
  src.value = "";
  alive = false;
  postedScale = null;
  instance = crypto.randomUUID();
  try {
    const base = await invoke<string>("get_wpe_scene_host_url");
    if (disposed || id !== generation) return;
    const url = new URL(base);
    url.searchParams.set("kbScene", props.target.id);
    url.searchParams.set("kbInstance", instance);
    src.value = url.href;
  } catch (error) {
    if (disposed || id !== generation) return;
    logger.warn(`场景宿主不可用: ${error}`);
    emit("fallback", ["host:unavailable"]);
  }
}

onMounted(async () => {
  window.addEventListener("message", onWindowMessage);
  window.addEventListener("resize", onWindowResize);
  window.addEventListener("pointermove", onPagePointer, { capture: true, passive: true });
  window.addEventListener("pointerdown", onPagePointer, { capture: true, passive: true });
  resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => postDisplay());
  if (frame.value) resizeObserver?.observe(frame.value);
  displayTimer = window.setInterval(() => postDisplay(), DISPLAY_CHECK_INTERVAL_MS);
  try {
    const stop = await listen<{ instance: string; kind: string; reasons?: string[] }>("wpe-scene-status", (event) => {
      if (disposed || event.payload.instance !== instance) return;
      if (event.payload.kind === "ready") {
        emit("ready");
        void postPointer();
      } else if (event.payload.kind === "fallback") emit("fallback", event.payload.reasons ?? []);
    });
    if (disposed) stop();
    else unlisten = stop;
  } catch (error) {
    logger.warn(`监听场景宿主状态失败: ${error}`);
    emit("fallback", ["host:unavailable"]);
    return;
  }
  if (!disposed) void start();
});

watch(
  () => [props.target.id, props.target.path, ...(props.target.sceneAssets ?? [])].join("\n"),
  () => {
    if (!disposed && unlisten) void start();
  },
);
watch(() => [props.volume, props.paused], postVolume);
watch(() => props.styleMode, postStyle);
// 换宿主时 iframe 元素随之重建：观察新元素（observe 时会先回调一次）
watch(
  frame,
  (element, previous) => {
    if (previous) resizeObserver?.unobserve(previous);
    if (element) resizeObserver?.observe(element);
  },
  { flush: "post" },
);

onBeforeUnmount(() => {
  disposed = true;
  generation++;
  window.removeEventListener("message", onWindowMessage);
  window.removeEventListener("resize", onWindowResize);
  window.removeEventListener("pointermove", onPagePointer, { capture: true });
  window.removeEventListener("pointerdown", onPagePointer, { capture: true });
  resizeObserver?.disconnect();
  resizeObserver = null;
  window.clearInterval(displayTimer);
  unlisten?.();
  src.value = "";
});
</script>

<template>
  <iframe
    v-if="src"
    ref="frame"
    :src="src"
    :sandbox="WEB_SANDBOX"
    allow="autoplay; fullscreen"
    referrerpolicy="no-referrer"
    title="wallpaper-scene"
    class="block w-full h-full border-0"
    :class="interactive ? 'pointer-events-auto' : 'pointer-events-none'"
    @load="postPointer"
  />
</template>
