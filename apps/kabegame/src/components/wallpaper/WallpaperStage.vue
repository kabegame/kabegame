<script setup lang="ts">
/**
 * 壁纸渲染组件（纯组件）：base / top 双层 + prep → enter → commit 过渡状态机、tile 平铺、
 * WPE 视频作者属性样式。逻辑从原 `src/wallpaper.ts` 一对一搬来。
 *
 * 约束：
 * - 只靠 props 驱动：不 invoke、不 listen、不读 settingsStore；数据绑定由调用方
 *   （壁纸窗口 `WallpaperWindow.vue`，以及后续的图库预览）负责。唯一例外是 web 层 iframe 的
 *   宿主桥（`wpeWebBridge.ts`）：页面里的 WPE 垫片碰不到 IPC，由桥代为拉取状态、代为 listen，
 *   随 iframe 一起创建与销毁。
 * - 铺满父元素（父元素需有确定尺寸），可放在任意尺寸容器里。
 * - WPE 网页壁纸（`x-wpe/web`）走独立的 web 层：一次只存在一个跨源 iframe，不参与 base / top
 *   双层过渡；切入时等页面 load 后整层淡入盖住媒体层，切走时新媒体先直设到 base、web 层淡出后
 *   **销毁** iframe（先置 about:blank 再移除），让渲染进程回收。
 * - DOM 仍按原实现命令式操作：模板 ref 只在 onMounted 时取一次元素，存到普通变量里
 *   （同原 `initDOM()`）。原因是视频 commit 会交换 base / top 两个 `<video>` 的角色，
 *   且清 src 必须用 `removeAttribute` 才不触发 error；若改成响应式 class / style / src 绑定，
 *   Vue 的 patch 会与这些命令式改动互相覆盖。这些元素在模板里只有静态属性，Vue 不会再 patch 它们。
 */
import { onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { compatibleToUrl, fileToUrl, initHttpServerBaseUrl, wpeEntryUrl } from "@/utils/fileUrl";
import type { Mode, Transition, WallpaperStageDebugState, WallpaperTarget, WpeVideoProps } from "./types";
import { attachWpeWebBridge } from "./wpeWebBridge";

type Phase = "idle" | "prep" | "enter";
type MediaType = "image" | "video" | "web";

/**
 * WPE 网页壁纸 iframe 的 sandbox：
 * - `allow-same-origin` 必须有，否则页面变成 opaque origin，`localStorage` 抛错、相对资源的 Cookie 语义改变；
 * - 不给 top-navigation / popups / modals / downloads：壁纸页面不需要导航父窗口、弹窗或下载，
 *   `alert` 在壁纸里也不该出现。
 */
const WEB_SANDBOX = "allow-scripts allow-same-origin allow-pointer-lock allow-forms";
/** iframe 没有 error 事件（404 也会触发 load），只能靠超时兜底。 */
const WEB_LOAD_TIMEOUT_MS = 8_000;
/** 首次导航的补发时机：届时仍停在初始 about:blank 就重新赋一次 src（见 createWebFrame）。 */
const WEB_NAV_KICK_MS = 3_000;
/** web 层淡入 / 淡出的兜底时长（略长于 CSS 过渡）。 */
const WEB_FADE_GUARD_MS = 1_400;

interface Props {
  /** 要显示什么；null 清空。 */
  target: WallpaperTarget | null;
  /** fill / fit / stretch / center / tile */
  styleMode: Mode;
  /** none / fade / slide / zoom */
  transition: Transition;
  /** 0…1 */
  volume: number;
  /** 0.25…3（越界按原逻辑钳制） */
  playbackRate: number;
  /** true 时暂停视频（应用背景不可见、预览关闭时用）；桌面壁纸窗口不传 */
  paused?: boolean;
  /** 预览内嵌为 true：媒体层接收指针事件；桌面默认 false（与原实现一致，媒体层 pointer-events: none） */
  interactive?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  paused: false,
  interactive: false,
});

const emit = defineEmits<{ error: [message: string]; ready: [] }>();

// 模板 ref：只在 onMounted 时读取一次
const rootRef = ref<HTMLElement | null>(null);
const stageRef = ref<HTMLElement | null>(null);
const baseImgRef = ref<HTMLImageElement | null>(null);
const topImgRef = ref<HTMLImageElement | null>(null);
const baseVideoRef = ref<HTMLVideoElement | null>(null);
const topVideoRef = ref<HTMLVideoElement | null>(null);
const baseTileRef = ref<HTMLElement | null>(null);
const topTileRef = ref<HTMLElement | null>(null);
const webLayerRef = ref<HTMLElement | null>(null);

// 状态管理
let baseSrc = "";
let topSrc = "";
let baseVideoSrc = "";
let topVideoSrc = "";
let phase: Phase = "idle";
let lastRawPath = "";
let currentPath = "";
let currentTarget: WallpaperTarget | null = null;
let pendingTarget: WallpaperTarget | null = null;
let queuedTarget: WallpaperTarget | null = null;
let busy = false;
let currentMediaType: MediaType = "image";

// 调试状态
let lastError = "";
let lastErrorAt = 0;
let transitionGuardTimer: number | null = null;

// DOM 元素引用（onMounted 时从模板 ref 取得；视频 commit 时会交换 base/top）
let rootEl: HTMLElement | null = null;
let stageEl: HTMLElement | null = null;
let baseImgEl: HTMLImageElement | null = null;
let topImgEl: HTMLImageElement | null = null;
let baseVideoEl: HTMLVideoElement | null = null;
let topVideoEl: HTMLVideoElement | null = null;
let baseTileEl: HTMLElement | null = null;
let topTileEl: HTMLElement | null = null;
let webLayerEl: HTMLElement | null = null;

// ---- web 层（WPE 网页壁纸）----
// iframe 命令式创建 / 销毁（同媒体层的命令式约定）；webToken 每次销毁递增，
// 让还在 await 的进入 / 离开流程发现自己已过期后放弃。
let webFrameEl: HTMLIFrameElement | null = null;
/** 当前 iframe 的宿主桥（替页面里的 WPE 垫片拉取状态、代为 listen），随 iframe 销毁。 */
let webBridge: { dispose(): void } | null = null;
let webToken = 0;
let webVisible = false;
let webLoadTimer: number | null = null;
let webKickTimer: number | null = null;
let webLoadResolve: (() => void) | null = null;
let webFadeTimer: number | null = null;
let webFadeResolve: (() => void) | null = null;
let webFadeCleanup: (() => void) | null = null;

// ---- base 层图片加载重试 ----
// base 层加载失败即白屏，不能只记日志：带退避重试（瞬时故障——如唤醒瞬间
// 本地文件服务尚未恢复——几次内即可自愈），加载成功后计数清零。
let baseImgRetryCount = 0;
let baseImgRetryTimer: number | null = null;

// 防止并发请求同一路径的 Map（仅用于 prefetch 去重）
const inflight = new Set<string>();

// 已对哪个目标发出过 ready（每个目标只发一次）
let readyEmittedKey = "";

/** 给调试面板读的响应式快照，由 updateDebugPanel() 同步。 */
const debug = reactive<WallpaperStageDebugState>({
  mode: props.styleMode,
  transition: props.transition,
  phase: "idle",
  media: "image",
  rawPath: "",
  currentPath: "",
  lastError: "",
  lastErrorAt: 0,
});

/** 原实现直接赋值 `lastError`；这里同时记录时刻，非空且 `notify` 时向上 emit error。 */
function setLastError(message: string, notify = true) {
  lastError = message;
  lastErrorAt = performance.now();
  if (message && notify) emit("error", message);
}

function getPathExt(path: string): string {
  return (path.split(".").pop() || "").toLowerCase();
}

function isVideoPath(path: string): boolean {
  const ext = getPathExt(path);
  return ["mp4", "mov", "wmv", "webm", "mkv"].includes(ext);
}

function targetKey(target: WallpaperTarget): string {
  return `${target.id}|${target.path}`;
}

function isWpeTarget(target: WallpaperTarget): boolean {
  return (target.type || "").trim().toLowerCase().startsWith("x-wpe/");
}

/** WPE 网页壁纸：走独立 web 层（iframe），不进 base / top 双层。 */
function isWebTarget(target: WallpaperTarget): boolean {
  return (target.type || "").trim().toLowerCase() === "x-wpe/web";
}

async function getWebUrl(target: WallpaperTarget): Promise<string> {
  await initHttpServerBaseUrl();
  const url = wpeEntryUrl(target.id);
  if (!url) {
    throw new Error(`无法获取网页壁纸 URL: ${target.path}`);
  }
  return url;
}

/** 是否按视频播放：优先看行类型，缺失时回退旧扩展名逻辑。 */
function isVideoTarget(target: WallpaperTarget): boolean {
  const type = (target.type || "").trim().toLowerCase();
  if (type === "x-wpe/video" || type === "video" || type.startsWith("video/")) return true;
  if (type) return false;
  return isVideoPath(target.path);
}

async function getVideoUrl(target: WallpaperTarget): Promise<string> {
  await initHttpServerBaseUrl();
  if (isWpeTarget(target)) {
    // compatible_path 始终有值：入口视频本身，或解不了的编码生成的兼容副本。
    const compatible = (target.compatiblePath || "").trim();
    const url = compatible ? compatibleToUrl(compatible) : "";
    if (!url) {
      throw new Error(`无法获取视频 URL: ${target.path}`);
    }
    return url;
  }
  const url = fileToUrl(target.path);
  if (!url) {
    throw new Error(`无法获取视频 URL: ${target.path}`);
  }
  return url;
}

/** 通过项目 HTTP 文件服务获取图片 URL（壁纸仅桌面端，无 Android） */
async function getImageUrl(path: string): Promise<string> {
  await initHttpServerBaseUrl();
  const url = fileToUrl(path);
  if (!url) {
    throw new Error(`无法获取图片 URL: ${path}`);
  }
  return url;
}

function prefetchTarget(target: WallpaperTarget) {
  if (!target?.path) return;
  if (isVideoTarget(target) || isWpeTarget(target)) return;
  if (inflight.has(target.path)) return;
  inflight.add(target.path);
  void getImageUrl(target.path)
    .finally(() => inflight.delete(target.path))
    .catch(() => {});
}

function getImgStyle(): Record<string, string> {
  const base: Record<string, string> = {};
  switch (props.styleMode) {
    case "fill":
      base.objectFit = "cover";
      base.objectPosition = "center";
      break;
    case "fit":
      base.objectFit = "contain";
      base.objectPosition = "center";
      break;
    case "stretch":
      base.objectFit = "fill";
      base.objectPosition = "center";
      break;
    case "center":
      base.objectFit = "none";
      base.objectPosition = "center";
      break;
    case "tile":
      break;
  }
  return base;
}

/** 正在渲染的目标：过渡期间 top 层是新目标。 */
function renderingTarget(): WallpaperTarget | null {
  return pendingTarget ?? currentTarget;
}

/** Kabegame 的壁纸样式覆盖 WPE 作者对齐方式（与点 7b 的合并表一致）。 */
function effectiveAlignment(): WpeVideoProps["alignment"] {
  switch (props.styleMode) {
    case "fill":
      return "cover";
    case "fit":
      return "fill"; // WPE 的 fill 等价于 contain
    case "stretch":
      return "stretch";
    case "center":
      return "center";
    case "tile":
      return "cover";
  }
  return "cover";
}

function objectFitForAlignment(alignment: WpeVideoProps["alignment"]): string {
  switch (alignment) {
    case "fill":
      return "contain";
    case "stretch":
      return "fill";
    case "center":
    case "free":
      return "none";
    case "cover":
    default:
      return "cover";
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : 0));
}

/**
 * 视频元素样式：WPE 视频按作者 `alignmentposition` 决定溢出轴位置；
 * 其余视频沿用旧逻辑（cover / center）。
 */
function getVideoStyle(): Record<string, string> {
  const imgStyle = getImgStyle();
  const target = renderingTarget();
  if (!target || !isWpeTarget(target) || !isVideoTarget(target)) {
    return {
      objectFit: imgStyle.objectFit || "cover",
      objectPosition: imgStyle.objectPosition || "center",
    };
  }

  const alignment = effectiveAlignment();
  const wpe = target.wpeVideo;
  const position = clamp(wpe?.position ?? 0, -1, 1);
  const percent = `${50 + position * 50}%`;
  const objectPosition = alignment === "cover" || alignment === "fill" ? `${percent} ${percent}` : "center";

  return {
    objectFit: objectFitForAlignment(alignment),
    objectPosition,
  };
}

/** WPE 颜色调整（−1…1）→ CSS filter；量纲待真机对比校准。 */
function wpeVideoFilter(wpe: WpeVideoProps | null | undefined): string {
  const color = wpe?.color;
  if (!color) return "";
  const brightness = 1 + clamp(color.brightness, -1, 1);
  const contrast = 1 + clamp(color.contrast, -1, 1);
  const saturation = 1 + clamp(color.saturation, -1, 1);
  const hue = clamp(color.hue, -1, 1) * 180;
  return `brightness(${brightness}) contrast(${contrast}) saturate(${saturation}) hue-rotate(${hue}deg)`;
}

/**
 * 把只在整屏生效的 WPE 属性放到 stage 上：
 * - `flip_h` → `scaleX(-1)`；
 * - center / free 的 `offset` / `zoom` → 整体位移与缩放（避开视频元素自己的过渡 transform）；
 * - `schemecolor` → 容器背景色（留边颜色）。
 */
function applyWpeStageStyles() {
  if (!stageEl) return;
  const target = renderingTarget();
  const active = !!target && isWpeTarget(target) && isVideoTarget(target);
  const wpe = active ? target?.wpeVideo : null;
  const alignment = active ? effectiveAlignment() : "cover";

  const transforms: string[] = [];
  if (active && wpe) {
    if (wpe.flipH) transforms.push("scaleX(-1)");
    if (alignment === "center" || alignment === "free") {
      const x = clamp(wpe.offsetX, -1, 1) * 100;
      const y = clamp(wpe.offsetY, -1, 1) * 100;
      transforms.push(`translate(${x}%, ${y}%)`);
    }
    if (alignment === "free") {
      transforms.push(`scale(${clamp(wpe.zoom, 0.01, 8)})`);
    }
  }
  stageEl.style.transform = transforms.join(" ");

  if (rootEl) {
    const background = active ? wpe?.background : null;
    rootEl.style.backgroundColor = background ? `rgb(${background[0]}, ${background[1]}, ${background[2]})` : "";
  }

  const filter = active ? wpeVideoFilter(wpe) : "";
  for (const el of [baseVideoEl, topVideoEl]) {
    if (el) el.style.filter = filter;
  }
}

function getBaseTileStyle(): Record<string, string> {
  return {
    backgroundImage: baseSrc ? `url("${baseSrc}")` : "",
    backgroundRepeat: "repeat",
    backgroundPosition: "center",
    backgroundSize: "contain",
  };
}

function getTopTileStyle(): Record<string, string> {
  return {
    backgroundImage: topSrc ? `url("${topSrc}")` : "",
    backgroundRepeat: "repeat",
    backgroundPosition: "center",
    backgroundSize: "contain",
  };
}

function getTopClasses(): string[] {
  if (!topSrc) return [];
  if (props.transition === "none") return [];
  return [props.transition, phase];
}

function applyStyles() {
  const imgStyle = getImgStyle();
  const videoStyle = getVideoStyle();

  // 应用图片样式
  if (baseImgEl) {
    Object.assign(baseImgEl.style, {
      objectFit: imgStyle.objectFit || "",
      objectPosition: imgStyle.objectPosition || "",
    });
  }
  if (topImgEl) {
    Object.assign(topImgEl.style, {
      objectFit: imgStyle.objectFit || "",
      objectPosition: imgStyle.objectPosition || "",
    });
  }
  if (baseVideoEl) {
    Object.assign(baseVideoEl.style, {
      objectFit: videoStyle.objectFit || "cover",
      objectPosition: videoStyle.objectPosition || "center",
    });
  }
  if (topVideoEl) {
    Object.assign(topVideoEl.style, {
      objectFit: videoStyle.objectFit || "cover",
      objectPosition: videoStyle.objectPosition || "center",
    });
  }

  applyWpeStageStyles();

  // 应用 tile 样式
  if (baseTileEl) {
    const baseTileStyle = getBaseTileStyle();
    Object.assign(baseTileEl.style, baseTileStyle);
  }
  if (topTileEl) {
    const topTileStyle = getTopTileStyle();
    Object.assign(topTileEl.style, topTileStyle);
  }

  // 应用 top 层类名和样式（图片/ tile）
  if (topImgEl || topTileEl) {
    const topClasses = getTopClasses();
    const el = topImgEl || topTileEl;
    if (el) {
      el.className = `wallpaper-${topImgEl ? "img" : "tile"} top ${topClasses.join(" ")}`.trim();
    }
  }
  // 视频 top 层使用同一套过渡类名
  if (topVideoEl && topVideoSrc) {
    const topClasses = props.transition === "none" ? [] : [props.transition, phase];
    topVideoEl.className = `wallpaper-img top ${topClasses.join(" ")}`.trim();
  }
}

// ---- web 层 ----

/** web 层类名：`animated <transition>` 决定过渡曲线，`visible` 决定终态；none 时瞬时切换。 */
function setWebLayerClasses(visible: boolean) {
  webVisible = visible;
  if (!webLayerEl) return;
  const classes = ["wallpaper-web-layer"];
  if (props.transition !== "none") classes.push("animated", props.transition);
  if (visible) classes.push("visible");
  webLayerEl.className = classes.join(" ");
}

function settleWebLoad() {
  if (webLoadTimer) {
    window.clearTimeout(webLoadTimer);
    webLoadTimer = null;
  }
  if (webKickTimer) {
    window.clearTimeout(webKickTimer);
    webKickTimer = null;
  }
  const resolve = webLoadResolve;
  webLoadResolve = null;
  resolve?.();
}

function settleWebFade() {
  if (webFadeTimer) {
    window.clearTimeout(webFadeTimer);
    webFadeTimer = null;
  }
  webFadeCleanup?.();
  webFadeCleanup = null;
  const resolve = webFadeResolve;
  webFadeResolve = null;
  resolve?.();
}

/** 等 web 层当前这次 opacity 过渡结束（transition 为 none 时立即返回）。 */
function waitWebFade(): Promise<void> {
  settleWebFade();
  const el = webLayerEl;
  if (!el || props.transition === "none") return Promise.resolve();
  return new Promise<void>((resolve) => {
    webFadeResolve = resolve;
    const onEnd = (e: TransitionEvent) => {
      if (e.target !== el || e.propertyName !== "opacity") return;
      settleWebFade();
    };
    el.addEventListener("transitionend", onEnd);
    webFadeCleanup = () => el.removeEventListener("transitionend", onEnd);
    webFadeTimer = window.setTimeout(settleWebFade, WEB_FADE_GUARD_MS);
  });
}

/** iframe 的指针事件：预览内嵌可交互，桌面窗口与媒体层一样不接收。 */
function applyWebInteractive() {
  if (webFrameEl) webFrameEl.style.pointerEvents = props.interactive ? "auto" : "none";
}

/** paused 对 web 层只做 visibility: hidden（省掉合成，不冻结页面脚本；冻结留给后续垫片）。 */
function applyWebPaused() {
  if (webLayerEl) webLayerEl.style.visibility = props.paused ? "hidden" : "";
}

/**
 * iframe 是否还停在插入时的初始 about:blank（与父页面同源，可读 location）；已导航到跨源页面时读取会抛错。
 * 导航进行中（尚未提交）也会返回 true，所以只在补发时机检查。
 */
function isInitialBlank(frame: HTMLIFrameElement): boolean {
  try {
    return frame.contentWindow?.location.href === "about:blank";
  } catch {
    return false;
  }
}

/** 创建 iframe 并等待它的 load（或超时）；被 teardownWeb 打断时也会返回。 */
function createWebFrame(url: string, imageId: string): Promise<void> {
  settleWebLoad();
  const layer = webLayerEl;
  if (!layer) return Promise.resolve();
  const frame = document.createElement("iframe");
  frame.className = "wallpaper-web-frame";
  frame.setAttribute("sandbox", WEB_SANDBOX);
  frame.setAttribute("allow", "autoplay; fullscreen");
  frame.setAttribute("referrerpolicy", "no-referrer");
  frame.setAttribute("title", "wallpaper-web");
  frame.addEventListener("load", () => {
    if (frame !== webFrameEl) return;
    const src = frame.getAttribute("src") || "";
    if (!src || src === "about:blank") return;
    settleWebLoad();
    markReady();
  });
  webFrameEl = frame;
  applyWebInteractive();
  const done = new Promise<void>((resolve) => {
    webLoadResolve = resolve;
  });
  webLoadTimer = window.setTimeout(() => {
    webLoadTimer = null;
    if (frame !== webFrameEl) return;
    setLastError("wpe web entry load timeout");
    updateDebugPanel();
    settleWebLoad();
  }, WEB_LOAD_TIMEOUT_MS);
  // 真机（CEF 149）偶发：「先设 src 再插入」的 iframe 首次导航不启动，一直停在初始 about:blank，
  // 重新赋一次 src 即恢复。所以先插入再设 src（插入时初始空文档的 load 由上面的 src 判断忽略），
  // 并在补发时机仍停在初始文档时再赋一次。
  // 宿主桥在插入 DOM、设 src 之前挂上：垫片在文档开始时就会发 listen / pull
  webBridge?.dispose();
  webBridge = attachWpeWebBridge(frame, url, imageId);
  layer.appendChild(frame);
  frame.src = url;
  webKickTimer = window.setTimeout(() => {
    webKickTimer = null;
    if (frame !== webFrameEl || !isInitialBlank(frame)) return;
    frame.src = url;
  }, WEB_NAV_KICK_MS);
  return done;
}

/** 销毁 iframe：先置 about:blank 让渲染进程立刻卸载页面，再移出 DOM；同时打断进行中的进入 / 离开。 */
function teardownWeb() {
  webToken += 1;
  settleWebLoad();
  settleWebFade();
  webBridge?.dispose();
  webBridge = null;
  const frame = webFrameEl;
  webFrameEl = null;
  if (frame) {
    try {
      frame.src = "about:blank";
    } catch {
      // ignore
    }
    frame.remove();
  }
  setWebLayerClasses(false);
  if (webLayerEl) webLayerEl.style.display = "none";
}

/** 清空 base / top 媒体层（web 淡入完成后释放底下的图片 / 视频）。 */
function clearMediaLayers() {
  baseSrc = "";
  topSrc = "";
  baseVideoSrc = "";
  topVideoSrc = "";
  clearImgSrc(baseImgEl);
  clearImgSrc(topImgEl);
  if (topImgEl) topImgEl.style.opacity = "0";
  if (baseTileEl) baseTileEl.style.backgroundImage = "";
  if (topTileEl) {
    topTileEl.style.backgroundImage = "";
    topTileEl.style.opacity = "0";
  }
  resetVideoElement(baseVideoEl);
  resetVideoElement(topVideoEl);
}

/** 处理串行队列里积压的下一个目标（与 commitTopToBase 末尾同一逻辑）。 */
function drainQueue() {
  if (queuedTarget && (!currentTarget || targetKey(queuedTarget) !== targetKey(currentTarget))) {
    const next = queuedTarget;
    queuedTarget = null;
    prefetchTarget(next);
    setTimeout(() => void setTarget(next), 0);
  } else {
    queuedTarget = null;
  }
}

/**
 * 切入网页壁纸：等新页面 load 后整层淡入盖住当前媒体层，淡入完成再释放媒体层。
 * web → web 时先淡出旧页面并销毁，保证同一时间只有一个 iframe。调用方已置 busy。
 */
async function enterWeb(next: WallpaperTarget, normalizedPath: string) {
  const url = await getWebUrl(next);
  setLastError("");
  if (webFrameEl) {
    if (webVisible && props.transition !== "none") {
      const leaving = webToken;
      setWebLayerClasses(false);
      await waitWebFade();
      if (leaving !== webToken) return;
    }
    teardownWeb();
  }
  const token = webToken;
  pendingTarget = next;
  phase = "prep";
  if (webLayerEl) webLayerEl.style.display = "block";
  setWebLayerClasses(false);
  applyWebPaused();
  updateDebugPanel();

  // 等页面 load（或超时）再淡入，避免先露出一块空白页
  await createWebFrame(url, next.id);
  if (token !== webToken) return;
  // 等浏览器渲染 prep 状态，再切到 visible 触发过渡
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  if (token !== webToken) return;
  phase = "enter";
  setWebLayerClasses(true);
  updateDebugPanel();
  await waitWebFade();
  if (token !== webToken) return;

  clearMediaLayers();
  currentMediaType = "web";
  currentTarget = next;
  currentPath = normalizedPath;
  pendingTarget = null;
  phase = "idle";
  busy = false;
  updateModeDisplay();
  applyStyles();
  updateDebugPanel();
  drainQueue();
}

/** 从网页壁纸切走：新媒体已直设到 base，web 层淡出后销毁 iframe。 */
async function leaveWeb() {
  if (!webFrameEl) return;
  const token = webToken;
  if (props.transition !== "none" && webVisible) {
    setWebLayerClasses(false);
    await waitWebFade();
    if (token !== webToken) return;
  }
  teardownWeb();
}

/** 安全清除 img 元素的 src：使用 removeAttribute 避免触发 error 事件 */
function clearImgSrc(el: HTMLImageElement | null) {
  if (!el) return;
  el.removeAttribute("src");
}

function commitTopToBase() {
  if (transitionGuardTimer) {
    window.clearTimeout(transitionGuardTimer);
    transitionGuardTimer = null;
  }
  // 视频 top → base：交换 base/top 元素引用，避免重新加载视频导致闪烁
  if (topVideoSrc) {
    baseVideoSrc = topVideoSrc;
    topVideoSrc = "";
    phase = "idle";
    if (pendingTarget) currentTarget = pendingTarget;
    currentPath = currentTarget?.path || currentPath;
    pendingTarget = null;
    busy = false;
    // top 已在播放新内容，直接提升为 base；旧 base 降为 top 待复用
    if (topVideoEl) topVideoEl.className = "wallpaper-img base";
    if (baseVideoEl) baseVideoEl.className = "wallpaper-img top";
    [baseVideoEl, topVideoEl] = [topVideoEl, baseVideoEl];
    resetVideoElement(topVideoEl);
    updateModeDisplay();
    applyStyles();
    if (queuedTarget && (!currentTarget || targetKey(queuedTarget) !== targetKey(currentTarget))) {
      const next = queuedTarget;
      queuedTarget = null;
      prefetchTarget(next);
      setTimeout(() => void setTarget(next), 0);
    } else {
      queuedTarget = null;
    }
    updateDebugPanel();
    return;
  }
  if (!topSrc) return;
  baseSrc = topSrc;
  topSrc = "";
  phase = "idle";
  if (pendingTarget) currentTarget = pendingTarget;
  currentPath = currentTarget?.path || currentPath;
  pendingTarget = null;
  busy = false;

  // 更新 DOM
  if (props.styleMode !== "tile") {
    if (baseImgEl) baseImgEl.src = baseSrc;
    if (topImgEl) {
      clearImgSrc(topImgEl);
      topImgEl.style.opacity = "0";
    }
  } else {
    if (baseTileEl) {
      const baseTileStyle = getBaseTileStyle();
      Object.assign(baseTileEl.style, baseTileStyle);
    }
    if (topTileEl) {
      topTileEl.style.backgroundImage = "";
      topTileEl.style.opacity = "0";
    }
  }
  applyStyles();

  // 处理队列
  if (queuedTarget && (!currentTarget || targetKey(queuedTarget) !== targetKey(currentTarget))) {
    const next = queuedTarget;
    queuedTarget = null;
    prefetchTarget(next);
    setTimeout(() => {
      void setTarget(next);
    }, 0);
  } else {
    queuedTarget = null;
  }
}

function handleTopTransitionEnd(e: TransitionEvent) {
  if (e.target !== e.currentTarget) return;
  if (props.transition === "none") return;
  if (phase !== "enter") return;
  if (e.propertyName !== "opacity") return;
  commitTopToBase();
}

function handleImageError(type: "base" | "top") {
  if (type === "top") {
    if (currentMediaType === "video") return;
    setLastError("top 层图片加载失败");
    if (transitionGuardTimer) {
      window.clearTimeout(transitionGuardTimer);
      transitionGuardTimer = null;
    }
    topSrc = "";
    phase = "idle";
    pendingTarget = null;
    busy = false;
    if (topImgEl) {
      clearImgSrc(topImgEl);
      topImgEl.style.opacity = "0";
    }
    if (topTileEl) {
      topTileEl.style.backgroundImage = "";
      topTileEl.style.opacity = "0";
    }
  } else {
    setLastError("base 层图片加载失败");
    if (baseSrc && props.styleMode !== "tile" && baseImgRetryCount < 5) {
      const delay = Math.min(2_000 * 2 ** baseImgRetryCount, 30_000);
      baseImgRetryCount += 1;
      if (baseImgRetryTimer) window.clearTimeout(baseImgRetryTimer);
      baseImgRetryTimer = window.setTimeout(() => {
        baseImgRetryTimer = null;
        if (!baseImgEl || !baseSrc || props.styleMode === "tile") return;
        // removeAttribute 后重设同一 URL 才会重新发起加载
        clearImgSrc(baseImgEl);
        baseImgEl.src = baseSrc;
      }, delay);
    }
  }
  updateDebugPanel();
}

function resetVideoElement(el: HTMLVideoElement | null) {
  if (!el) return;
  try {
    el.pause();
    el.removeAttribute("src");
    el.load();
  } catch {
    // ignore
  }
}

/** 播放成功后取消静音并应用当前音量设置 */
function unmuteVideo(el: HTMLVideoElement | null) {
  if (!el) return;
  const v = Math.min(1, Math.max(0, Number.isFinite(props.volume) ? props.volume : 1));
  el.volume = v;
  el.muted = v === 0;
}

/** 将当前音量应用到所有视频元素 */
function applyWallpaperVolume() {
  const v = Math.min(1, Math.max(0, Number.isFinite(props.volume) ? props.volume : 1));
  if (baseVideoEl) {
    baseVideoEl.volume = v;
    baseVideoEl.muted = v === 0;
  }
  if (topVideoEl) {
    topVideoEl.volume = v;
    topVideoEl.muted = v === 0;
  }
}

/** 当前生效的播放速率（0.25～3） */
function getPlaybackRateMagnitude(): number {
  return Math.min(3, Math.max(0.25, Number.isFinite(props.playbackRate) ? props.playbackRate : 1));
}

/** 将 loop 与 playbackRate 应用到单个视频元素 */
function applyVideoLoopToElement(el: HTMLVideoElement | null) {
  if (!el) return;
  el.setAttribute("loop", "");
  el.playbackRate = getPlaybackRateMagnitude();
}

/** 将 loop 与 playbackRate 应用到所有视频元素 */
function applyVideoLoopMode() {
  applyVideoLoopToElement(baseVideoEl);
  applyVideoLoopToElement(topVideoEl);
}

/** 将当前播放速率应用到所有视频元素 */
function applyWallpaperPlaybackRate() {
  const rate = getPlaybackRateMagnitude();
  for (const el of [baseVideoEl, topVideoEl]) {
    if (!el?.src) continue;
    el.playbackRate = rate;
  }
}

async function playVideo(el: HTMLVideoElement | null, src: string) {
  if (!el) return;
  if (el.src !== src) {
    el.src = src;
  }
  applyVideoLoopToElement(el);
  // 新增能力 paused：只设源不播放；pause() 同时取消 autoplay（桌面窗口不传 paused，不走这里）
  if (props.paused) {
    el.pause();
    return;
  }
  // 强制先静音再 play:壁纸窗口没有用户手势,Chromium 只允许静音自动播放。
  // applyWallpaperVolume(设置 hydrate / setting-change)可能已把元素取消静音,
  // 若带声调用 play() 会被 NotAllowedError 拒绝并停在第 0 帧。
  el.muted = true;
  try {
    await el.play();
    unmuteVideo(el);
  } catch (err) {
    // 自动播放被拒绝时记录原因(不再静默吞掉),后续事件会重试
    const e = err as DOMException;
    setLastError(`play rejected: ${e?.name || "?"}: ${e?.message || err}`, false);
    updateDebugPanel();
  }
}

async function setTarget(target: WallpaperTarget) {
  if (!target.path) return;
  lastRawPath = target.path;

  const normalizedPath = target.path
    .trimStart()
    .replace(/^\\\\\?\\/, "")
    .trim();

  if (!normalizedPath) {
    setLastError("路径为空");
    updateDebugPanel();
    return;
  }

  const next: WallpaperTarget = { ...target, path: normalizedPath };

  // 去重 1
  if (
    currentTarget &&
    targetKey(next) === targetKey(currentTarget) &&
    ((currentMediaType === "image" && !!baseSrc) ||
      (currentMediaType === "video" && !!baseVideoEl?.src) ||
      (currentMediaType === "web" && !!webFrameEl))
  ) {
    return;
  }
  // 去重 2
  if (pendingTarget && targetKey(next) === targetKey(pendingTarget) && phase !== "idle") {
    return;
  }

  // 严格串行
  if (busy || phase !== "idle") {
    queuedTarget = next;
    prefetchTarget(next);
    return;
  }
  busy = true;
  try {
    if (isWebTarget(next)) {
      queuedTarget = null;
      await enterWeb(next, normalizedPath);
      return;
    }
    // 从网页壁纸切走：媒体层此时为空，下面两条分支都会走「首帧直设」，设好后再淡出并销毁 web 层
    const fromWeb = !!webFrameEl;
    const isVideoMedia = isVideoTarget(next);
    if (isVideoMedia) {
      const videoUrl = await getVideoUrl(next);
      setLastError("");
      currentMediaType = "video";
      clearImgSrc(topImgEl);
      if (topImgEl) topImgEl.style.opacity = "0";
      clearImgSrc(baseImgEl);
      if (topTileEl) {
        topTileEl.style.backgroundImage = "";
        topTileEl.style.opacity = "0";
      }
      if (baseTileEl) baseTileEl.style.backgroundImage = "";

      // 无过渡或首帧：直接设 base
      if (props.transition === "none" || !baseVideoSrc) {
        baseVideoSrc = videoUrl;
        topVideoSrc = "";
        phase = "idle";
        currentTarget = next;
        currentPath = normalizedPath;
        pendingTarget = null;
        queuedTarget = null;
        resetVideoElement(topVideoEl);
        await playVideo(baseVideoEl, videoUrl);
        updateModeDisplay();
        applyStyles();
        busy = false;
        updateDebugPanel();
        if (fromWeb) void leaveWeb();
        return;
      }

      // 有过渡：新视频进 top 层，与图片同一套 prep → enter
      topVideoSrc = videoUrl;
      phase = "prep";
      pendingTarget = next;
      queuedTarget = null;
      resetVideoElement(topVideoEl);
      if (topVideoEl) {
        topVideoEl.src = videoUrl;
        topVideoEl.style.opacity = "0";
        applyVideoLoopToElement(topVideoEl);
      }
      updateModeDisplay();
      applyStyles();
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
      if (topVideoEl) topVideoEl.style.opacity = "";
      phase = "enter";
      applyStyles();
      if (topVideoEl) {
        if (props.paused) {
          // 新增能力 paused：不播放，仅取消 autoplay（桌面窗口不走这里）
          topVideoEl.pause();
        } else {
          // 同 playVideo:先静音保证自动播放获准,成功后再按音量恢复
          topVideoEl.muted = true;
          void topVideoEl
            .play()
            .then(() => unmuteVideo(topVideoEl))
            .catch((err) => {
              const e = err as DOMException;
              setLastError(`top play rejected: ${e?.name || "?"}: ${e?.message || err}`, false);
              updateDebugPanel();
            });
        }
      }
      if (transitionGuardTimer) window.clearTimeout(transitionGuardTimer);
      transitionGuardTimer = window.setTimeout(() => {
        if (phase === "enter" && topVideoSrc) commitTopToBase();
      }, 1400);
      busy = false;
      updateDebugPanel();
      return;
    }

    const url = await getImageUrl(normalizedPath);

    setLastError("");
    currentMediaType = "image";
    baseVideoSrc = "";
    topVideoSrc = "";
    resetVideoElement(baseVideoEl);
    resetVideoElement(topVideoEl);
    updateModeDisplay();

    // 首次/无过渡：直接替换
    if (!baseSrc || props.transition === "none") {
      baseSrc = url;
      topSrc = "";
      phase = "idle";
      currentTarget = next;
      currentPath = normalizedPath;
      pendingTarget = null;
      queuedTarget = null;
      busy = false;

      // 更新 DOM
      if (props.styleMode !== "tile") {
        if (baseImgEl) baseImgEl.src = baseSrc;
        if (topImgEl) {
          clearImgSrc(topImgEl);
          topImgEl.style.opacity = "0";
        }
      } else {
        if (baseTileEl) {
          const baseTileStyle = getBaseTileStyle();
          Object.assign(baseTileEl.style, baseTileStyle);
        }
        if (topTileEl) {
          topTileEl.style.backgroundImage = "";
          topTileEl.style.opacity = "0";
        }
        // tile 用背景图，没有 load 事件：URL 就绪即视为 ready
        markReady();
      }
      applyStyles();
      updateDebugPanel();
      if (fromWeb) void leaveWeb();
      return;
    }

    // 有过渡：top 覆盖 base，进入动画
    topSrc = url;
    phase = "prep";
    pendingTarget = next;
    queuedTarget = null;

    // 更新 DOM
    if (props.styleMode !== "tile") {
      if (topImgEl) {
        topImgEl.src = topSrc;
        topImgEl.style.opacity = "0";
      }
    } else {
      if (topTileEl) {
        const topTileStyle = getTopTileStyle();
        Object.assign(topTileEl.style, topTileStyle);
        topTileEl.style.opacity = "0";
      }
      markReady();
    }
    applyStyles();

    // 等待浏览器渲染 prep 状态
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

    // 清除内联 opacity，让 CSS 类控制过渡动画
    // 内联 style.opacity 优先级高于类选择器，若不清除会阻止 .top.fade.enter { opacity:1 } 生效
    if (props.styleMode !== "tile") {
      if (topImgEl) topImgEl.style.opacity = "";
    } else {
      if (topTileEl) topTileEl.style.opacity = "";
    }

    phase = "enter";
    applyStyles();

    // 兜底定时器
    if (transitionGuardTimer) {
      window.clearTimeout(transitionGuardTimer);
    }
    transitionGuardTimer = window.setTimeout(() => {
      if (phase === "enter") {
        commitTopToBase();
      }
    }, 1400);
    updateDebugPanel();
  } catch (e) {
    setLastError(String(e));
    busy = false;
    topSrc = "";
    phase = "idle";
    pendingTarget = null;
    if (topImgEl) {
      clearImgSrc(topImgEl);
      topImgEl.style.opacity = "0";
    }
    if (topTileEl) {
      topTileEl.style.backgroundImage = "";
      topTileEl.style.opacity = "0";
    }
    updateDebugPanel();
  }
}

/** 把当前状态同步到调试快照（原实现直接重写调试面板的 innerHTML）。 */
function updateDebugPanel() {
  debug.mode = props.styleMode;
  debug.transition = props.transition;
  debug.phase = phase;
  debug.media = currentMediaType;
  debug.rawPath = lastRawPath;
  debug.currentPath = currentPath;
  debug.lastError = lastError;
  debug.lastErrorAt = lastErrorAt;
}

/** 新增：当前渲染目标首次可见时发一次 ready（每个目标只发一次）。 */
function markReady() {
  const target = renderingTarget();
  const key = target ? targetKey(target) : "";
  if (!key || key === readyEmittedKey) return;
  readyEmittedKey = key;
  emit("ready");
}

function updateModeDisplay() {
  if (currentMediaType === "web") {
    // 网页壁纸：媒体层已清空，全部隐藏（web 层自己管显示）
    for (const el of [baseImgEl, topImgEl, baseTileEl, topTileEl, baseVideoEl, topVideoEl]) {
      if (el) el.style.display = "none";
    }
    return;
  }
  if (currentMediaType === "video") {
    if (baseImgEl) baseImgEl.style.display = "none";
    if (topImgEl) topImgEl.style.display = "none";
    if (baseTileEl) baseTileEl.style.display = "none";
    if (topTileEl) topTileEl.style.display = "none";
    if (baseVideoEl) baseVideoEl.style.display = "block";
    if (topVideoEl) topVideoEl.style.display = topVideoSrc ? "block" : "none";
    return;
  }

  // 根据模式显示/隐藏对应的元素
  if (props.styleMode !== "tile") {
    // 图片模式：显示图片，隐藏 tile
    if (baseImgEl) baseImgEl.style.display = "block";
    if (topImgEl) topImgEl.style.display = "block";
    if (baseTileEl) baseTileEl.style.display = "none";
    if (topTileEl) topTileEl.style.display = "none";
    if (baseVideoEl) baseVideoEl.style.display = "none";
    if (topVideoEl) topVideoEl.style.display = "none";
  } else {
    // Tile 模式：显示 tile，隐藏图片
    if (baseImgEl) baseImgEl.style.display = "none";
    if (topImgEl) topImgEl.style.display = "none";
    if (baseTileEl) baseTileEl.style.display = "block";
    if (topTileEl) topTileEl.style.display = "block";
    if (baseVideoEl) baseVideoEl.style.display = "none";
    if (topVideoEl) topVideoEl.style.display = "none";
  }
}

function applyStyleFromMode() {
  if (currentMediaType === "video" || currentMediaType === "web") {
    applyStyles();
    updateDebugPanel();
    return;
  }
  if (baseSrc) {
    if (props.styleMode !== "tile") {
      if (baseImgEl) baseImgEl.src = baseSrc;
    } else {
      if (baseTileEl) {
        const baseTileStyle = getBaseTileStyle();
        Object.assign(baseTileEl.style, baseTileStyle);
      }
    }
  }
  if (topSrc) {
    if (props.styleMode !== "tile") {
      if (topImgEl) topImgEl.src = topSrc;
    } else {
      if (topTileEl) {
        const topTileStyle = getTopTileStyle();
        Object.assign(topTileEl.style, topTileStyle);
      }
    }
  }
  applyStyles();
  updateDebugPanel();
}

/** 新增能力 paused：暂停 / 恢复当前视频。桌面窗口不传 paused（恒为 false），只在其变化时触发。 */
function applyPaused() {
  applyWebPaused();
  if (currentMediaType !== "video") return;
  if (props.paused) {
    baseVideoEl?.pause();
    topVideoEl?.pause();
    return;
  }
  if (baseVideoSrc) void playVideo(baseVideoEl, baseVideoSrc);
  if (topVideoSrc && topVideoEl) void playVideo(topVideoEl, topVideoSrc);
}

/** 新增：target 置 null 时清空画面（桌面窗口从不传 null，与原实现「无壁纸不处理」一致）。 */
function clearTarget() {
  if (transitionGuardTimer) {
    window.clearTimeout(transitionGuardTimer);
    transitionGuardTimer = null;
  }
  if (baseImgRetryTimer) {
    window.clearTimeout(baseImgRetryTimer);
    baseImgRetryTimer = null;
  }
  queuedTarget = null;
  pendingTarget = null;
  currentTarget = null;
  currentPath = "";
  busy = false;
  phase = "idle";
  baseSrc = "";
  topSrc = "";
  baseVideoSrc = "";
  topVideoSrc = "";
  readyEmittedKey = "";
  teardownWeb();
  if (currentMediaType === "web") currentMediaType = "image";
  clearImgSrc(baseImgEl);
  clearImgSrc(topImgEl);
  if (topImgEl) topImgEl.style.opacity = "0";
  if (baseTileEl) baseTileEl.style.backgroundImage = "";
  if (topTileEl) {
    topTileEl.style.backgroundImage = "";
    topTileEl.style.opacity = "0";
  }
  resetVideoElement(baseVideoEl);
  resetVideoElement(topVideoEl);
  updateModeDisplay();
  applyStyles();
  updateDebugPanel();
}

/** 原 `initDOM()`：取元素并绑定事件监听器。 */
function initDOM() {
  rootEl = rootRef.value;
  stageEl = stageRef.value;
  baseImgEl = baseImgRef.value;
  topImgEl = topImgRef.value;
  baseVideoEl = baseVideoRef.value;
  topVideoEl = topVideoRef.value;
  baseTileEl = baseTileRef.value;
  topTileEl = topTileRef.value;
  webLayerEl = webLayerRef.value;

  // 绑定事件监听器
  // 空 src / 无 src 属性不视为加载错误，仅当有实际 src 加载失败时才触发错误处理
  if (baseImgEl) {
    baseImgEl.addEventListener("error", () => {
      if (!baseImgEl?.getAttribute("src")) return;
      handleImageError("base");
    });
    // 加载成功即重置重试计数，让下一次失败重新从短退避开始
    baseImgEl.addEventListener("load", () => {
      baseImgRetryCount = 0;
      markReady();
    });
  }
  if (topImgEl) {
    topImgEl.addEventListener("transitionend", handleTopTransitionEnd);
    topImgEl.addEventListener("error", () => {
      if (!topImgEl?.getAttribute("src")) return;
      handleImageError("top");
    });
    topImgEl.addEventListener("load", () => {
      if (topImgEl?.getAttribute("src")) markReady();
    });
  }
  // 视频元素：两个元素绑定相同的 transitionend 和角色感知的 error handler，
  // 以支持 commitTopToBase 中 base/top 引用交换后仍能正确工作
  const handleVideoError = (e: Event) => {
    const el = e.currentTarget as HTMLVideoElement;
    if (el === topVideoEl) {
      setLastError("top 层视频加载失败");
      if (transitionGuardTimer) {
        window.clearTimeout(transitionGuardTimer);
        transitionGuardTimer = null;
      }
      topVideoSrc = "";
      phase = "idle";
      pendingTarget = null;
      busy = false;
      resetVideoElement(topVideoEl);
      updateModeDisplay();
    } else {
      setLastError("base 层视频加载失败");
    }
    updateDebugPanel();
  };
  const handleVideoLoaded = (e: Event) => {
    const el = e.currentTarget as HTMLVideoElement;
    if (el.getAttribute("src")) markReady();
  };
  if (baseVideoEl) {
    baseVideoEl.addEventListener("transitionend", handleTopTransitionEnd);
    baseVideoEl.addEventListener("error", handleVideoError);
    baseVideoEl.addEventListener("loadeddata", handleVideoLoaded);
  }
  if (topVideoEl) {
    topVideoEl.addEventListener("transitionend", handleTopTransitionEnd);
    topVideoEl.addEventListener("error", handleVideoError);
    topVideoEl.addEventListener("loadeddata", handleVideoLoaded);
  }
  if (topTileEl) {
    topTileEl.addEventListener("transitionend", handleTopTransitionEnd);
  }
}

/** 原 `cleanup()` 中属于渲染层的部分（setting-change 的解绑留在 WallpaperWindow）。 */
function cleanup() {
  inflight.clear();
  queuedTarget = null;
  pendingTarget = null;
  busy = false;
  if (transitionGuardTimer) {
    window.clearTimeout(transitionGuardTimer);
    transitionGuardTimer = null;
  }
  if (baseImgRetryTimer) {
    window.clearTimeout(baseImgRetryTimer);
    baseImgRetryTimer = null;
  }
  baseVideoSrc = "";
  topVideoSrc = "";
  resetVideoElement(baseVideoEl);
  resetVideoElement(topVideoEl);
  teardownWeb();
}

watch(
  () => props.styleMode,
  () => {
    updateModeDisplay();
    applyStyleFromMode();
  },
);
watch(
  () => props.transition,
  () => {
    applyStyles();
    if (webFrameEl) setWebLayerClasses(webVisible);
    updateDebugPanel();
  },
);
watch(
  () => props.interactive,
  () => applyWebInteractive(),
);
watch(
  () => props.volume,
  () => applyWallpaperVolume(),
);
watch(
  () => props.playbackRate,
  () => applyWallpaperPlaybackRate(),
);
watch(
  () => props.paused,
  () => applyPaused(),
);
watch(
  () => props.target,
  (target) => {
    if (target?.path) {
      void setTarget(target);
    } else if (!target) {
      clearTarget();
    }
  },
);

onMounted(() => {
  initDOM();
  updateModeDisplay();
  applyStyles();
  applyWallpaperVolume();
  applyVideoLoopMode();
  updateDebugPanel();
  if (props.target?.path) {
    void setTarget(props.target);
  }
  // 页面卸载（含看门狗 reload）时同原实现一样释放视频与定时器
  window.addEventListener("beforeunload", cleanup);
});

onBeforeUnmount(() => {
  window.removeEventListener("beforeunload", cleanup);
  cleanup();
});

/** 给 dev 调试面板读 phase / 当前路径 / 最近错误（响应式快照）。 */
function debugState(): Readonly<WallpaperStageDebugState> {
  return debug;
}

defineExpose({ debugState });
</script>

<template>
  <!-- 根：铺满父元素；WPE 留边背景色由 applyWpeStageStyles 命令式写在这里 -->
  <div
    ref="rootRef"
    class="relative w-full h-full overflow-hidden"
    :class="{ 'wallpaper-stage-interactive': interactive }"
  >
    <!-- stage：WPE 翻转 / 位移 / 缩放由 applyWpeStageStyles 命令式写 transform -->
    <div ref="stageRef" class="absolute inset-0 w-full h-full overflow-hidden">
      <!-- 图片模式元素 -->
      <img ref="baseImgRef" class="wallpaper-img base" alt="wallpaper-base" />
      <img ref="topImgRef" class="wallpaper-img top" alt="wallpaper-top" />
      <!-- 视频模式元素（默认隐藏，由脚本控制显示） -->
      <!-- muted 用于满足浏览器自动播放策略，播放成功后由脚本取消静音以恢复声音 -->
      <video
        ref="baseVideoRef"
        class="wallpaper-img base"
        style="display: none"
        autoplay
        muted
        loop
        playsinline
      ></video>
      <video ref="topVideoRef" class="wallpaper-img top" style="display: none" autoplay muted loop playsinline></video>
      <!-- Tile 模式元素（默认隐藏，由脚本控制显示） -->
      <div ref="baseTileRef" class="wallpaper-tile base" style="display: none"></div>
      <div ref="topTileRef" class="wallpaper-tile top" style="display: none"></div>
    </div>
    <!-- Web 层：独立于 base / top 双层，也不受 stage 的 WPE 视频 transform 影响；一次只存在一个 iframe，
         由 createWebFrame / teardownWeb 命令式创建与销毁 -->
    <div ref="webLayerRef" class="wallpaper-web-layer" style="display: none"></div>
  </div>
</template>

<style scoped>
/*
 * 为什么用 <style> 而不是 UnoCSS：
 * - top 层的过渡靠 `.top.fade.enter` / `.top.slide.prep` 这类由脚本拼出的组合类名驱动，
 *   且 `.wallpaper-img.top { transition: none }` 与 `.top.fade.enter` 依赖选择器特异性排序；
 *   工具类无法表达「组合类 → 过渡」。
 * - scoped 即可生效：这些元素都在本组件模板里，带本组件的 data-v 属性，命令式改 className
 *   不会去掉该属性；同时避免 `.top` / `.fade` 这类短类名泄漏到嵌入本组件的主窗口。
 * 规则原样搬自旧 wallpaper.html。
 */
.wallpaper-img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  display: block;
  pointer-events: none;
}

.wallpaper-img.base {
  opacity: 1;
  z-index: 0;
}

.wallpaper-img.top {
  opacity: 0;
  z-index: 1;
  transform: none;
  transition: none;
  will-change: opacity, transform;
}

.wallpaper-tile {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  background-color: transparent;
  pointer-events: none;
}

.wallpaper-tile.base {
  opacity: 1;
  z-index: 0;
}

.wallpaper-tile.top {
  opacity: 0;
  z-index: 1;
  transform: none;
  transition: none;
  will-change: opacity, transform;
}

/* transitions */
.top.fade.enter {
  opacity: 1;
  transition: opacity 800ms ease-in-out;
}

.top.slide.prep {
  opacity: 0;
  transform: translateX(32px);
}

.top.slide.enter {
  opacity: 1;
  transform: translateX(0);
  transition:
    opacity 800ms ease,
    transform 800ms ease;
}

.top.zoom.prep {
  opacity: 0;
  transform: scale(1.06);
}

.top.zoom.enter {
  opacity: 1;
  transform: scale(1);
  transition:
    opacity 900ms ease,
    transform 900ms ease;
}

/* web 层：盖在媒体层之上，整层淡入淡出；slide / zoom 复用媒体层的位移 / 缩放起点 */
.wallpaper-web-layer {
  position: absolute;
  inset: 0;
  z-index: 2;
  opacity: 0;
  transform: none;
}

.wallpaper-web-layer.animated {
  transition: opacity 800ms ease-in-out;
}

.wallpaper-web-layer.animated.slide,
.wallpaper-web-layer.animated.zoom {
  transition:
    opacity 800ms ease,
    transform 800ms ease;
}

.wallpaper-web-layer.slide:not(.visible) {
  transform: translateX(32px);
}

.wallpaper-web-layer.zoom:not(.visible) {
  transform: scale(1.06);
}

.wallpaper-web-layer.visible {
  opacity: 1;
  transform: none;
}

/* iframe 是命令式创建的，没有本组件的 data-v 属性，需 :deep；pointer-events 由 applyWebInteractive 内联设置 */
.wallpaper-web-layer :deep(.wallpaper-web-frame) {
  display: block;
  width: 100%;
  height: 100%;
  border: 0;
  background: transparent;
}

/* interactive：预览内嵌时媒体层接收指针事件（桌面窗口不启用，保持 pointer-events: none） */
.wallpaper-stage-interactive .wallpaper-img,
.wallpaper-stage-interactive .wallpaper-tile {
  pointer-events: auto;
}
</style>
