<template>
  <div class="relative w-full h-full overflow-hidden" :style="{ '--wallpaper-transition-ms': `${transitionMs}ms` }">
    <!-- 一个壁纸一层（数组顺序即叠放顺序，新的在上）；层的显隐与过渡只靠类名，见下面的样式 -->
    <div
      v-for="(layer, index) in layers"
      :key="layer.key"
      class="wallpaper-layer"
      :class="layerClass(layer, index)"
      :data-phase="layer.phase"
      @transitionend="onTransitionEnd(layer, $event)"
    >
      <!-- 平铺的图片：用 ImageContent 交出的当前图源画重复背景，ImageContent 本身留着（加载、ready、出错照旧）但不显示 -->
      <div v-if="layer.tile" class="wallpaper-tile" :style="tileStyle(layer.tile)" />
      <ImageContent
        :ref="(el) => setContentRef(layer.key, el)"
        class="absolute inset-0"
        :class="{ 'opacity-0': !!layer.tile }"
        variant="wallpaper"
        :image="layer.image"
        prefer="original"
        :fit="fitOf(layer.target)"
        :wpe-video="layer.target.wpeVideo ?? null"
        :wallpaper-target="layer.target"
        :video-playing="!paused"
        :playback="playback"
        :interactive="interactive"
        @ready="onLayerReady(layer)"
        @error="onLayerError(layer, '壁纸加载失败')"
        @video-play-fail="setLastError('video play rejected')"
        @wallpaper-fail="(reasons: string[]) => (layer.failure = reasons.join('; '))"
        @wallpaper-contextmenu="emit('contextmenu', $event)"
        @display-change="onDisplayChange(layer)"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 桌面壁纸（壁纸显示重构步骤 5，取代 `WallpaperStage`）：只管「铺放」与「过渡」，媒体全部交给 `ImageContent`（壁纸变体）。
 *
 * - **一个壁纸一层**：每换一次目标挂一层 `ImageContent`（`variant="wallpaper"`，图片行由 `targetImage` 从后端的 `WallpaperTarget`
 *   换来，WPE 视频的作者属性经 `wpeVideo` 下传）。新层 `ready`（有东西可看：画面、加载骨架或丢失图，见 `ImageContent` 的
 *   `variant`）之前不可见（`loading`）；`ready` 后按 `transition` 过渡进来（`entering`），过渡结束（`transitionend`，兜底为时长
 *   + {@link TRANSITION_GUARD_EXTRA_MS}）后成为当前层（`shown`），卸载它下面的旧层（旧的 `<video>`、iframe、场景宿主随卸载释放）。
 *   第一张、或 `transition` 为 none 时 `ready` 就直接成为当前层。
 * - **过渡**（时长在 {@link TRANSITION_MS}）：淡入（新层淡入盖上）、缩放（新层从 1.06 倍缩回并淡入）、滑入（2026-11-15 用户定：
 *   新层从右侧整屏滑进来、同时把旧层推出左边，旧层在过渡期间是 `is-leaving`；以前是右移 32 px 并淡入，几乎看不出是滑动）。
 * - **过渡中来了新目标**：还在 `loading` 的那层直接换掉（不排队）；已经在 `entering` 的先定下来（成为当前层），再进新层。
 *   场景 → 场景时新旧两个宿主在过渡期间短暂并存（用户定）。
 * - **新层显示不了**：同预览（用户定），`ImageContent` 画丢失图并照样 `ready`，桌面照常过渡到它；`error` 只记进调试快照（以前丢掉
 *   新层、保留上一张）。网页 / 场景壁纸的实时画面显示不了只是停在缩略图上、底部红字原因（`ImageContent` 管）。
 * - **样式**：fill / fit / stretch / center 换成 `ImageContent` 的 `fit`（cover / contain / fill / none）；tile 时图片用 `displaySource()`
 *   的地址画重复背景（同 Stage：等比放进、居中重复；先是缩略图，原图出来后 `displayChange` 换成原图），视频按 cover，网页忽略样式，
 *   场景把样式交给宿主（`playback.style`）。
 * - 只靠 props 驱动：不 invoke、不 listen、不读 settingsStore；数据绑定由壁纸窗口（`WallpaperWindow.vue`）负责。
 */
import { computed, reactive, ref, watch, type ComponentPublicInstance } from "vue";
import ImageContent from "@/components/image/ImageContent.vue";
import type { ImageInfo } from "@/types/image";
import { WPE_FOLLOW_SCENE_SETTINGS, type WpeSceneSettings } from "@/utils/wpeSettings";
import { isVideoTarget, stageMediaOf } from "./targetKind";
import type { Mode, Transition, WallpaperDebugState, WallpaperPlayback, WallpaperTarget } from "./types";
import type { ViewportPoint } from "./wpeContextMenu";
import type { MediaFit } from "./wpeVideoStyle";

/** 各过渡的时长（经 `--wallpaper-transition-ms` 交给样式，这里是唯一来源）。滑入 1.5 s 是用户定的，推得慢一点才看得出是滑动。 */
const TRANSITION_MS: Record<Transition, number> = { none: 0, fade: 800, slide: 1_500, zoom: 900 };
/** 过渡的兜底：时长再加这么久，`transitionend` 没来（元素被隐藏、过渡被打断）也要提交。 */
const TRANSITION_GUARD_EXTRA_MS = 600;

const props = withDefaults(
  defineProps<{
    /** 要显示什么；null 清空。 */
    target: WallpaperTarget | null;
    /** fill / fit / stretch / center / tile */
    styleMode: Mode;
    /** none / fade / slide / zoom */
    transition: Transition;
    /** 0…1：视频与网页、场景壁纸的音量 */
    volume: number;
    /** 0.25…3（越界钳制）：视频倍速 */
    playbackRate: number;
    /** 暂停：视频停、网页由垫片冻结、场景停帧 */
    paused?: boolean;
    /** 网页 / 场景壁纸收鼠标（Rust 注入）：桌面壁纸窗口为 true */
    interactive?: boolean;
    /** 场景后处理 / 反射 / 阴影 / 体积光：桌面传全局「壁纸设置」 */
    sceneSettings?: WpeSceneSettings;
  }>(),
  { paused: false, interactive: false, sceneSettings: () => WPE_FOLLOW_SCENE_SETTINGS },
);

const emit = defineEmits<{
  error: [message: string];
  /** 新目标可以显示了（开始过渡或直接换上）；每个目标一次 */
  ready: [];
  /** 网页 / 场景壁纸里点了右键，坐标已换算到本页面视口 */
  contextmenu: [point: ViewportPoint];
}>();

interface Layer {
  key: number;
  target: WallpaperTarget;
  image: ImageInfo;
  /** `loading`：等 ready，不可见；`entering`：过渡中；`shown`：当前层 */
  phase: "loading" | "entering" | "shown";
  /** 平铺时的图片地址（`displaySource()`）；不平铺、或不是图片时 null */
  tile: string | null;
  /** 网页 / 场景显示不了的原因（只进调试快照） */
  failure: string;
}

const layers = reactive<Layer[]>([]);
let nextKey = 1;
const transitionMs = computed(() => TRANSITION_MS[props.transition] ?? 0);
let guardTimer: number | undefined;
const contentRefs = new Map<number, InstanceType<typeof ImageContent>>();

function setContentRef(key: number, el: Element | ComponentPublicInstance | null) {
  if (el) contentRefs.set(key, el as InstanceType<typeof ImageContent>);
  else contentRefs.delete(key);
}

const playback = computed<WallpaperPlayback>(() => ({
  volume: props.volume,
  playbackRate: props.playbackRate,
  sceneSettings: props.sceneSettings,
  style: props.styleMode,
}));

/** 壁纸样式 → `ImageContent` 的 `fit`；平铺时图片按放进（底下另画重复背景），视频按盖满 */
const FIT: Record<Mode, MediaFit> = { fill: "cover", fit: "contain", stretch: "fill", center: "none", tile: "contain" };
function fitOf(target: WallpaperTarget): MediaFit {
  if (props.styleMode === "tile" && isVideoTarget(target)) return "cover";
  return FIT[props.styleMode];
}

/** 平铺的重复背景（同 Stage）：等比放进、居中、重复 */
function tileStyle(url: string): Record<string, string> {
  return {
    backgroundImage: `url("${url}")`,
    backgroundRepeat: "repeat",
    backgroundPosition: "center",
    backgroundSize: "contain",
  };
}

/** 后端的壁纸目标换成 `ImageContent` 要的图片行（只用到这些字段；没有类型的旧目标按扩展名定是不是视频） */
function targetImage(target: WallpaperTarget): ImageInfo {
  const type = (target.type || "").trim().toLowerCase() || (isVideoTarget(target) ? "video/mp4" : "image/jpeg");
  return {
    id: target.id,
    type,
    localPath: target.path,
    compatiblePath: target.compatiblePath ?? "",
    thumbnailPath: target.previewPath ?? "",
    localExists: true,
  } as ImageInfo;
}

function targetKey(target: WallpaperTarget): string {
  return `${target.id}|${target.path}`;
}

// ---- 调试快照 ----
let lastRawPath = "";
let lastError = "";
let lastErrorAt = 0;
const debug = reactive<WallpaperDebugState>({
  mode: props.styleMode,
  transition: props.transition,
  phase: "idle",
  media: "image",
  rawPath: "",
  currentPath: "",
  lastError: "",
  lastErrorAt: 0,
  sceneFallback: "",
});

function setLastError(message: string) {
  lastError = message;
  lastErrorAt = performance.now();
  updateDebug();
  if (message) emit("error", message);
}

function updateDebug() {
  const top = layers[layers.length - 1];
  const shown = [...layers].reverse().find((layer) => layer.phase === "shown") ?? null;
  debug.mode = props.styleMode;
  debug.transition = props.transition;
  debug.phase = top?.phase === "loading" ? "prep" : top?.phase === "entering" ? "enter" : "idle";
  debug.media = shown ? stageMediaOf(shown.target) : "image";
  debug.rawPath = lastRawPath;
  debug.currentPath = shown?.target.path ?? "";
  debug.lastError = lastError;
  debug.lastErrorAt = lastErrorAt;
  debug.sceneFallback = shown?.failure ?? "";
}
watch(() => layers.map((layer) => `${layer.key}:${layer.phase}:${layer.failure}`).join(","), updateDebug);
watch(() => [props.styleMode, props.transition], updateDebug);

// ---- 层的进出 ----

function clearGuard() {
  window.clearTimeout(guardTimer);
  guardTimer = undefined;
}

/** `layer` 成为当前层：卸载它下面的全部旧层。 */
function commit(layer: Layer) {
  const index = layers.indexOf(layer);
  if (index < 0) return;
  clearGuard();
  layer.phase = "shown";
  layers.splice(0, index);
}

function setTarget(raw: WallpaperTarget) {
  const path = raw.path
    .trimStart()
    .replace(/^\\\\\?\\/, "")
    .trim();
  if (!path) {
    setLastError("路径为空");
    return;
  }
  lastRawPath = raw.path;
  const target: WallpaperTarget = { ...raw, path };
  const top = layers[layers.length - 1];
  // 和最上面那层是同一个目标（正在进来或已经是当前）：不动
  if (top && targetKey(top.target) === targetKey(target)) return;
  // 还在加载的那层直接换掉；正在过渡的先定下来
  if (top?.phase === "loading") layers.pop();
  else if (top?.phase === "entering") commit(top);
  setLastError("");
  layers.push({ key: nextKey++, target, image: targetImage(target), phase: "loading", tile: null, failure: "" });
  updateDebug();
}

function refreshTile(layer: Layer) {
  const source = props.styleMode === "tile" ? contentRefs.get(layer.key)?.displaySource() : null;
  layer.tile = source?.kind === "image" ? source.url : null;
}

function onLayerReady(layer: Layer) {
  if (layer.phase !== "loading" || !layers.includes(layer)) return;
  refreshTile(layer);
  emit("ready");
  const below = layers.some((other) => other !== layer && other.phase === "shown");
  if (!below || props.transition === "none") {
    commit(layer);
    return;
  }
  // 先让浏览器按 loading 的样子画一帧（过渡的起点），再切到 entering 触发过渡
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      if (layer.phase !== "loading" || !layers.includes(layer)) return;
      layer.phase = "entering";
      clearGuard();
      guardTimer = window.setTimeout(() => {
        if (layer.phase === "entering") commit(layer);
      }, transitionMs.value + TRANSITION_GUARD_EXTRA_MS);
    }),
  );
}

/** 进来的那层过渡完：淡入只有透明度、滑入只有位移、缩放两者同时结束，先到的那个就提交 */
function onTransitionEnd(layer: Layer, event: TransitionEvent) {
  if (event.target !== event.currentTarget) return;
  if (event.propertyName !== "opacity" && event.propertyName !== "transform") return;
  if (layer.phase === "entering") commit(layer);
}

/** 显示不了：只记错误。丢失图由 `ImageContent` 画（同预览），它照样 `ready`，这层照常过渡上来 */
function onLayerError(layer: Layer, message: string) {
  setLastError(`${message}: ${layer.target.path}`);
}

/** 当前画面换了（原图盖上了缩略图）：平铺重取图源；还没 ready 的等 ready 时再取 */
function onDisplayChange(layer: Layer) {
  if (layer.phase !== "loading") refreshTile(layer);
}

watch(
  () => props.target,
  (target) => {
    if (target?.path) setTarget(target);
    else if (!target) {
      clearGuard();
      layers.splice(0);
      updateDebug();
    }
  },
  { immediate: true },
);

// 改样式：平铺的图片层要重新取图源（换成平铺或换走）
watch(
  () => props.styleMode,
  () => {
    for (const layer of layers) if (layer.phase !== "loading") refreshTile(layer);
  },
);

function layerClass(layer: Layer, index: number): string[] {
  const classes = [`is-${layer.phase}`];
  if (props.transition !== "none") classes.push("animated", props.transition);
  // 滑入：上面有层正在进来时，当前层被推出左边
  if (
    props.transition === "slide" &&
    layer.phase === "shown" &&
    layers.slice(index + 1).some((other) => other.phase === "entering")
  )
    classes.push("is-leaving");
  return classes;
}

/** 给 dev 调试面板读的响应式快照。 */
function debugState(): Readonly<WallpaperDebugState> {
  return debug;
}

/**
 * 壁纸窗口的 `wallpaper-ping` 是否交给 iframe 里的垫片应答：任一层的网页 iframe 存在、或场景宿主的垫片发过音量请求
 * （`ImageContent.delegatesPing` → `WpeWallpaperContent`）。页面卡死就不应答、照样触发重载；宿主没起来时仍由应用页应答。
 */
function delegatesPing(): boolean {
  return layers.some((layer) => contentRefs.get(layer.key)?.delegatesPing() ?? false);
}

defineExpose({ debugState, delegatesPing });
</script>

<style scoped>
/*
 * 层的显隐与过渡靠类名组合（`is-<phase>` × 过渡名），工具类表达不了「组合类 → 过渡」，所以写在这里。时长取根上的
 * `--wallpaper-transition-ms`（脚本里的 TRANSITION_MS）：fade 新层淡入；zoom 新层从 1.06 倍缩回并淡入（曲线同 Stage）；
 * slide 新层从右侧整屏滑进来、不淡入，旧层（`is-leaving`）同时被推出左边。
 */
.wallpaper-layer {
  position: absolute;
  inset: 0;
}

/* 还没 ready：不可见、不收指针；slide / zoom 停在过渡的起点 */
.wallpaper-layer.is-loading {
  opacity: 0;
  pointer-events: none;
}

.wallpaper-layer.is-loading.slide {
  transform: translateX(100%);
}

.wallpaper-layer.is-loading.zoom {
  transform: scale(1.06);
}

.wallpaper-layer.is-entering,
.wallpaper-layer.is-shown {
  opacity: 1;
  transform: none;
}

.wallpaper-layer.animated.is-entering {
  transition: opacity var(--wallpaper-transition-ms) ease-in-out;
}

/* 滑入只动位移：透明度在进来的那一刻就是 1（起点在屏幕外） */
.wallpaper-layer.animated.is-entering.slide {
  transition: transform var(--wallpaper-transition-ms) ease-in-out;
}

.wallpaper-layer.animated.is-leaving.slide {
  transform: translateX(-100%);
  transition: transform var(--wallpaper-transition-ms) ease-in-out;
}

.wallpaper-layer.animated.is-entering.zoom {
  transition:
    opacity var(--wallpaper-transition-ms) ease,
    transform var(--wallpaper-transition-ms) ease;
}

.wallpaper-tile {
  position: absolute;
  inset: 0;
  pointer-events: none;
}
</style>
