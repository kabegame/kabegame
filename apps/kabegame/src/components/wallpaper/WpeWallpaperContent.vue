<script setup lang="ts">
/**
 * 一张 WPE 网页 / 场景壁纸的实时画面：网页壁纸是 `file:` iframe，场景是 `WpeSceneView`（场景宿主 iframe）。只管这一张怎么
 * 跑起来、跑没跑起来，不管铺放之外的显示（过渡、打底的缩略图、退回画面都是调用方的事），也不读任何设置：音量、暂停、可交互、
 * 场景样式与场景设置全部由参数给。都经 `ImageContent` 的 wallpaper 形态挂上来：桌面（`Wallpaper`）给后端算好的 `target`，图库不给，
 * 按 `imageId` 经 `get_wallpaper_target_for_image` 取（和桌面共用后端 `build_wallpaper_target`）。`x-wpe/video` 不走这里。
 *
 * 事件：
 * - `live`：实时画面出来了。网页是 iframe load（导航了但 {@link WEB_LOAD_TIMEOUT_MS} 内没 load 也算，页面已在画，只记 warn）；
 *   场景是宿主报首帧，之后属性变化让退回的场景重新可渲染时会再发。
 * - `fail(reasons)`：实时画面显示不了，调用方当「原图加载失败」显示退回画面。网页：没有入口、导航没启动（多半没带 CEF 补丁 05）、
 *   导航被改写成 about:blank#blocked；场景：宿主报 `fallback`（不支持、编译失败、渲染器建不起来、设备反复丢失，都和编译 / 渲染
 *   有关；运行时脚本出错宿主只禁用那个回调，不会走到这里）、宿主不可用，以及 {@link SCENE_RESULT_TIMEOUT_MS} 内既没有新的加载进度也没有结果
 *   （`render:timeout`）。退回的场景宿主仍挂着（属性变化可能让它重新可渲染），只有超时才卸载宿主。
 * - `error(message)`：目标取不到（行已删、IPC 失败），致命，调用方显示丢失态。
 * - `contextmenu(point)`：壁纸里点了右键（`wpeContextMenu.ts`），坐标已换算到本页面视口。
 * - `progress(progress)`：场景首次加载的进度（`wpeSceneProgress.ts`），出结果之前原样转发；网页壁纸没有。
 *
 * 网页壁纸 iframe（壁纸显示重构步骤 1 从原 `WallpaperStage` 搬来，规则不变）：
 * - 直接赋入口 `file://` 的 `src`：应用页是 http / tauri 源，Chromium 默认在渲染进程用 `SecurityOrigin::CanDisplay` 拦下
 *   （`Not allowed to load local resource`，iframe 停在 about:blank），主窗口与壁纸窗口靠 CEF 补丁 05（建窗前
 *   `allow_app_local_resources`）放行。补丁只开门，能加载哪些文件由运行时闸门按库内网页壁纸目录裁决，所以换壁纸一律销毁重建
 *   iframe，不在原 iframe 上改 `src`；销毁时先置 about:blank 让渲染进程立刻卸载页面再移出 DOM，页面登记的监听由 Tauri 随
 *   `SubframeDestroyed` 清掉。
 * - iframe 命令式创建（先插入再赋 `src`，插入时初始空文档的 load 靠 `isInitialBlank` 忽略），不经 Vue 的 patch。
 * - 音量：垫片经 `postMessage` 要宿主音量，只回答自己当前 iframe 的请求（主窗口里应用背景与预览各有一个），回 `volume`（`paused`
 *   时为 0）；`volume` / `paused` / `interactive` 变化时主动推（协议见 `wpeWebVolume.ts`）。`paused` 也经这条消息交给垫片：iframe
 *   保持可见，垫片照 WPE 冻结 rAF、计时器、`AudioContext`、CSS 动画与媒体元素并调页面的 `setPaused`（暂停中打开的先让页面
 *   画起来，见垫片 `installFreeze`）。
 * - 鼠标：iframe 不收真实鼠标（`pointer-events: none`）。`interactive` 经音量消息交给垫片，垫片在可交互且没暂停时向
 *   `tauri-plugin-cursor` 登记本 frame，Rust 把全局光标直接注入它。Linux 拿不到全局光标，退回可交互的 iframe 直接收真实鼠标
 *   （`framePointer.ts`）。
 *
 * 壁纸窗口的 ping：网页 iframe 存在（含加载中），或场景宿主的垫片已经发过音量请求时，交给 iframe 里的垫片应答
 * （`delegatesPing`）；页面卡死就不应答、照样触发重载。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import { invoke } from "@/api/rpc";
import { logger } from "@/utils/logger";
import { WPE_FOLLOW_SCENE_SETTINGS, type WpeSceneSettings } from "@/utils/wpeSettings";
import { isSceneTarget, isWebTarget } from "./targetKind";
import type { Mode, WallpaperTarget } from "./types";
import { isWpeVolumeRequest, webHostVolume, wpeVolumeMessage } from "./wpeWebVolume";
import { wpeContextMenuPoint, type ViewportPoint } from "./wpeContextMenu";
import { framePointerEvents } from "./framePointer";
import { WEB_SANDBOX } from "./webSandbox";
import type { WpeSceneProgress } from "./wpeSceneProgress";
import WpeSceneView from "./WpeSceneView.vue";

/** iframe 没有 error 事件（404 也会触发 load），只能靠超时判断导航到底启动了没有。 */
const WEB_LOAD_TIMEOUT_MS = 8_000;
/**
 * 场景迟迟没有结果（既没首帧也没退回，例如 Worker 卡住、取设备挂起）时判失败、卸载宿主的时限：挂上宿主起算，**每收到一条加载进度
 * 重新计时**，大场景慢慢加载但一直在动时不会被提前判失败。本机实测编译到首帧 0.3–0.6 s，大场景几秒；这期间桌面与图库都显示
 * 模糊的缩略图与进度，所以给得宽。壁纸窗口的 init 看门狗只等设置与目标、不等画面，ping 看门狗在宿主起来之前由应用页应答，和这个时限无关。
 */
const SCENE_RESULT_TIMEOUT_MS = 30_000;

const props = withDefaults(
  defineProps<{
    /** 图片 id；不给 `target` 时按它取目标 */
    imageId: string;
    /** 桌面壁纸窗口给后端算好的目标；不给时按 `imageId` 取 */
    target?: WallpaperTarget | null;
    /** 场景的铺放（交给宿主，留白用 `schemecolor`）；网页壁纸铺满、不吃样式 */
    styleMode?: Mode;
    /** 0…1：网页壁纸经垫片乘到页面音量上，场景交给宿主 */
    volume?: number;
    /** 网页由垫片冻结、场景停帧，画面停在最后一帧 */
    paused?: boolean;
    /** 壁纸收鼠标（Rust 注入，见文件头）：预览与桌面为 true，应用背景为 false */
    interactive?: boolean;
    /** 场景后处理 / 反射 / 阴影 / 体积光（已按能否跟随 WPE 换算），原样交给 `WpeSceneView` */
    sceneSettings?: WpeSceneSettings;
  }>(),
  {
    target: undefined,
    styleMode: "fill",
    volume: 1,
    paused: false,
    interactive: false,
    sceneSettings: () => WPE_FOLLOW_SCENE_SETTINGS,
  },
);

const emit = defineEmits<{
  live: [];
  fail: [reasons: string[]];
  error: [message: string];
  contextmenu: [point: ViewportPoint];
  progress: [progress: WpeSceneProgress];
}>();

/** 正在显示的目标（取到之后才有）；换目标时先清空再换，网页 iframe 与场景宿主都随之重建。 */
const resolved = shallowRef<WallpaperTarget | null>(null);
const kind = computed<"web" | "scene" | null>(() => {
  const target = resolved.value;
  if (!target) return null;
  if (isWebTarget(target)) return "web";
  if (isSceneTarget(target)) return "scene";
  return null;
});
/** 结果：`loading` → `live` / `failed`；场景之后还可能在两者之间切换（属性变化、运行中退回） */
let result: "loading" | "live" | "failed" = "loading";
let lastReasons: string[] = [];

/** 每换一次目标加一：还在等目标、等 load 的旧流程据此放弃。 */
let generation = 0;
let disposed = false;

function setLive() {
  if (result === "live") return;
  result = "live";
  lastReasons = [];
  emit("live");
}

function setFailed(reasons: string[]) {
  result = "failed";
  lastReasons = reasons;
  emit("fail", reasons);
}

// ---- 取目标 ----

function targetKey(target: WallpaperTarget | null | undefined): string {
  return target ? `${target.id}|${target.path}` : "";
}

async function resolveTarget() {
  const id = ++generation;
  teardownWeb();
  stopSceneTimer();
  sceneMounted.value = false;
  sceneAlive = false;
  resolved.value = null;
  result = "loading";
  lastReasons = [];
  if (props.target) {
    resolved.value = props.target;
  } else {
    try {
      const next = await invoke<WallpaperTarget | null>("get_wallpaper_target_for_image", { imageId: props.imageId });
      if (disposed || id !== generation) return;
      if (!next?.path) {
        emit("error", "wallpaper target not found");
        return;
      }
      resolved.value = next;
    } catch (error) {
      if (disposed || id !== generation) return;
      logger.error(`获取壁纸目标失败: ${error}`);
      emit("error", String(error));
      return;
    }
  }
  if (kind.value === "web") void startWeb(id);
  else if (kind.value === "scene") startScene();
  else setFailed([`type:${resolved.value?.type ?? "?"}`]);
}

// ---- 网页壁纸 ----

const webContainerRef = ref<HTMLElement | null>(null);
let webFrameEl: HTMLIFrameElement | null = null;
let webLoadTimer: number | null = null;

/** iframe 当前文档的地址：仍与父页面同源（初始 about:blank、被改写成的 about:blank#blocked）时可读，导航到 `file:` 后返回 null。 */
function sameOriginHref(frame: HTMLIFrameElement): string | null {
  try {
    return frame.contentWindow?.location.href ?? null;
  } catch {
    return null;
  }
}

/** iframe 是否还停在插入时的初始 about:blank（导航进行中、尚未提交也算）。 */
function isInitialBlank(frame: HTMLIFrameElement): boolean {
  return sameOriginHref(frame) === "about:blank";
}

function clearWebLoadTimer() {
  if (webLoadTimer) {
    window.clearTimeout(webLoadTimer);
    webLoadTimer = null;
  }
}

/** iframe 的 `pointer-events`：鼠标由 Rust 注入时一律 `none`，Linux 退回时可交互才 `auto`。 */
function applyWebPointerEvents() {
  if (webFrameEl) webFrameEl.style.pointerEvents = framePointerEvents(props.interactive);
}

/** 把宿主音量（含暂停、可交互）发给 iframe 里的垫片；iframe 还停在初始 about:blank 时也照发，页面起来后垫片会自己再要。 */
function postWebVolume() {
  const target = webFrameEl?.contentWindow;
  if (!target) return;
  try {
    // 对方是跨源的 `file:` 文档；消息只有音量与状态，不限定 targetOrigin
    target.postMessage(
      wpeVolumeMessage(webHostVolume(props.volume, props.paused), props.paused, props.interactive),
      "*",
    );
  } catch (error) {
    logger.warn(`网页壁纸音量发送失败: ${error}`);
  }
}

/** 垫片的消息：只认来自本组件当前 iframe 的。音量请求回当前音量；右键换算到本页面视口后往上抛。 */
function onWindowMessage(event: MessageEvent) {
  const frame = webFrameEl;
  const target = frame?.contentWindow;
  if (!frame || !target || event.source !== target) return;
  if (isWpeVolumeRequest(event.data)) {
    postWebVolume();
    return;
  }
  if (!event.isTrusted) return;
  const point = wpeContextMenuPoint(event.data, frame);
  if (point) emit("contextmenu", point);
}

/** 建 iframe、赋入口，等 load 或超时定结果。容器随 `kind` 变成 web 才渲染出来，所以先等这一轮渲染。 */
async function startWeb(id: number) {
  const entry = resolved.value?.webEntry;
  if (!entry) {
    setFailed(["web:no-entry"]);
    return;
  }
  await nextTick();
  const container = webContainerRef.value;
  if (disposed || id !== generation || !container) return;
  const frame = document.createElement("iframe");
  frame.className = "wallpaper-web-frame";
  frame.setAttribute("sandbox", WEB_SANDBOX);
  frame.setAttribute("allow", "autoplay; fullscreen");
  frame.setAttribute("referrerpolicy", "no-referrer");
  frame.setAttribute("title", "wallpaper-web");
  frame.addEventListener("load", () => {
    if (frame !== webFrameEl || result !== "loading") return;
    // 插入时初始空文档的 load：忽略
    if (isInitialBlank(frame)) return;
    clearWebLoadTimer();
    // 仍与父页面同源却不是初始文档：导航被浏览器改写（about:blank#blocked 等），壁纸页面没有加载
    const blocked = sameOriginHref(frame);
    if (blocked !== null) {
      logger.warn(`网页壁纸 ${props.imageId} 导航被拦：${blocked}`);
      setFailed(["web:blocked"]);
      return;
    }
    setLive();
  });
  webFrameEl = frame;
  applyWebPointerEvents();
  webLoadTimer = window.setTimeout(() => {
    webLoadTimer = null;
    if (frame !== webFrameEl || result !== "loading") return;
    // 仍停在初始 about:blank：导航根本没启动，多半是 CEF 没带补丁 05，赋 `file:` 的 src 被 `CanDisplay` 拦下
    if (isInitialBlank(frame)) {
      logger.warn(`网页壁纸 ${props.imageId} 没有导航（CEF 补丁 05 缺失？）`);
      setFailed(["web:not-navigated"]);
      return;
    }
    // 导航了、只是还没 load 完（子资源慢）：页面已经在画，照样当实时画面
    logger.warn(`网页壁纸 ${props.imageId} ${WEB_LOAD_TIMEOUT_MS} ms 内没有 load，先显示`);
    setLive();
  }, WEB_LOAD_TIMEOUT_MS);
  // 先插入再赋 src（插入时初始空文档的 load 由上面的 isInitialBlank 忽略）
  container.appendChild(frame);
  frame.src = entry;
}

/** 销毁 iframe：先置 about:blank 让渲染进程立刻卸载页面，再移出 DOM。 */
function teardownWeb() {
  clearWebLoadTimer();
  const frame = webFrameEl;
  webFrameEl = null;
  if (!frame) return;
  try {
    frame.src = "about:blank";
  } catch {
    // ignore
  }
  frame.remove();
}

// ---- 场景壁纸 ----

/** 宿主挂着；超时后置 false 卸载（终止编译、销毁 GPU 设备）。 */
const sceneMounted = ref(false);
/** 宿主里的垫片发过音量请求：从此 ping 交给它应答。 */
let sceneAlive = false;
let sceneTimer: number | null = null;

function stopSceneTimer() {
  if (sceneTimer) {
    window.clearTimeout(sceneTimer);
    sceneTimer = null;
  }
}

function armSceneTimer() {
  stopSceneTimer();
  sceneTimer = window.setTimeout(onSceneTimeout, SCENE_RESULT_TIMEOUT_MS);
}

function startScene() {
  sceneAlive = false;
  sceneMounted.value = true;
  armSceneTimer();
}

/** 加载进度：出结果之前转发，并重新计时（「30 s 内没有新进度」才算超时） */
function onSceneProgress(progress: WpeSceneProgress) {
  if (result !== "loading" || !sceneMounted.value) return;
  armSceneTimer();
  emit("progress", progress);
}

function onSceneReady() {
  stopSceneTimer();
  setLive();
}

function onSceneFallback(reasons: string[]) {
  stopSceneTimer();
  setFailed(reasons);
}

/** 迟迟没有结果：判失败、卸载宿主，不让它一直占着 GPU 设备与 Worker。 */
function onSceneTimeout() {
  sceneTimer = null;
  if (result !== "loading") return;
  logger.warn(
    `场景壁纸 ${resolved.value?.id ?? props.imageId} ${SCENE_RESULT_TIMEOUT_MS} ms 内没有新进度也没有结果，卸载宿主`,
  );
  sceneMounted.value = false;
  sceneAlive = false;
  setFailed(["render:timeout"]);
}

// ---- 生命周期 ----

watch(
  () => [props.imageId, targetKey(props.target)].join("\n"),
  () => {
    if (!disposed) void resolveTarget();
  },
);
watch(
  () => props.interactive,
  () => {
    applyWebPointerEvents();
    postWebVolume();
  },
);
watch(() => [props.volume, props.paused], postWebVolume);

onMounted(() => {
  // 垫片的音量请求：先于 iframe 装好，页面起来后的第一次请求一定有人答
  window.addEventListener("message", onWindowMessage);
  void resolveTarget();
});

onBeforeUnmount(() => {
  disposed = true;
  generation++;
  window.removeEventListener("message", onWindowMessage);
  teardownWeb();
  stopSceneTimer();
  sceneMounted.value = false;
});

/** 壁纸窗口的 ping 是否交给 iframe 里的垫片应答（见文件头）。 */
function delegatesPing(): boolean {
  return !!webFrameEl || (sceneMounted.value && sceneAlive);
}

/** 调试快照用：当前结果与退回原因。 */
function state(): { kind: "web" | "scene" | null; result: typeof result; reasons: string[] } {
  return { kind: kind.value, result, reasons: lastReasons };
}

defineExpose({ delegatesPing, state });
</script>

<template>
  <div class="relative w-full h-full">
    <!-- 网页壁纸：iframe 由 startWeb / teardownWeb 命令式创建与销毁 -->
    <div v-if="kind === 'web'" ref="webContainerRef" class="wpe-web-container absolute inset-0" />
    <WpeSceneView
      v-else-if="kind === 'scene' && sceneMounted && resolved"
      class="absolute inset-0"
      :target="resolved"
      :style-mode="styleMode"
      :paused="paused"
      :volume="volume"
      :interactive="interactive"
      :scene-settings="sceneSettings"
      @alive="sceneAlive = true"
      @ready="onSceneReady"
      @fallback="onSceneFallback"
      @progress="onSceneProgress"
      @contextmenu="emit('contextmenu', $event)"
    />
  </div>
</template>

<style scoped>
/* iframe 是命令式创建的，没有本组件的 data-v 属性，需 :deep；pointer-events 由 applyWebPointerEvents 内联设置 */
.wpe-web-container :deep(.wallpaper-web-frame) {
  display: block;
  width: 100%;
  height: 100%;
  border: 0;
  background: transparent;
}
</style>
