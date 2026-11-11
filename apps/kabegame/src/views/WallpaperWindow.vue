<script setup lang="ts">
/**
 * 壁纸窗口根组件（`index.html?window=wallpaper`）：承担原 `src/wallpaper.ts` 里 `init()` 的全部职责——
 * 看门狗、`setting-change` 监听、启动时并行拉取设置与当前壁纸、`wallpaper_window_ready` 握手、dev 调试面板，
 * 再把结果作为 props 交给纯渲染组件 `WallpaperStage`。后端仍是唯一属主，本窗口是「自驱动」的观察方。
 *
 * 窗口模式下每块在线屏一个这样的窗口。后端只告诉每个窗口一条布置（显示哪个壁纸目标、出不出声），
 * 样式、过渡与当前壁纸由窗口自己从 `wallpaperTargets[布置的目标]` 读。
 */
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { computed, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import { invoke, listen, type UnlistenFn } from "@/api/rpc";
import { IS_DEV } from "@/env";
import WallpaperStage from "@/components/wallpaper/WallpaperStage.vue";
import { isPausableTarget } from "@/components/wallpaper/targetKind";
import type { Mode, Transition, WallpaperTarget } from "@/components/wallpaper/types";
import type { WallpaperCapabilities } from "@/composables/useWallpaperCapabilities";
import {
  displayModeOfTarget,
  effectiveStyle,
  effectiveTransition,
  TARGET_MULTIPLE,
  WALLPAPER_ASSIGNMENT_EVENT,
  type DisplayModeCapability,
  type WallpaperTargets,
  type WallpaperWindowAssignment,
} from "@/utils/wallpaperTargets";
import {
  FRAME_MONITOR_SAMPLE_MS,
  getFrameMonitorLevel,
  useFrameMonitorStore,
  type FrameMonitorLevel,
  type FrameMonitorSnapshot,
} from "@/stores/frameMonitor";
import "@/styles/debug-panel.css";

const stage = ref<InstanceType<typeof WallpaperStage> | null>(null);

/** 直接作为 WallpaperStage 的 props。初值与原实现的模块级默认值一致。 */
const state = reactive<{
  target: WallpaperTarget | null;
  styleMode: Mode;
  transition: Transition;
  volume: number;
  playbackRate: number;
  paused: boolean;
}>({
  target: null,
  styleMode: "fill",
  transition: "fade",
  /** 视频壁纸音量 0~1，与设置页、预览内逻辑一致 */
  volume: 1,
  /** 视频播放速率 0.25～3 */
  playbackRate: 1,
  /** 设置 `wallpaperPaused`；是否真的暂停看 `stagePaused` */
  paused: false,
});

/**
 * 后端给本窗口的布置：显示哪个壁纸目标、出不出声。启动时取一次（`get_wallpaper_window_assignment`），
 * 之后随 `wallpaper-assignment` 更新（切显示器模式、主屏换了）。取不到时为 null，按 `multiple` 目标、出声处理。
 */
const assignment = ref<WallpaperWindowAssignment | null>(null);

/** 本窗口显示的壁纸目标 id。 */
const targetId = computed(() => assignment.value?.targetId ?? TARGET_MULTIPLE);

/**
 * 本窗口显示布置给它的壁纸目标：样式、过渡、当前壁纸都从 `wallpaperTargets[targetId]` 读。
 * 这里是算有效样式 / 过渡要用的原始输入（启动时拉一次，目标表之后随 `setting-change` 更新），
 * 归一化规则与后端控制器相同（见 `utils/wallpaperTargets.ts`）。本窗口不挂设置 store，所以自己留一份。
 */
const targetSource: {
  targets: WallpaperTargets;
  /** 窗口模式下列出的显示器模式及各自的样式 / 过渡；读不到能力表时为空，样式 / 过渡直接用存下来的值 */
  combos: DisplayModeCapability[];
} = { targets: {}, combos: [] };

/** 壁纸窗口只属于窗口模式：目标里按壁纸模式存的样式 / 过渡取这一份。 */
const WINDOW_MODE = "window";

/** 上一次看到的本窗口目标的当前壁纸 id；`undefined` 表示还没读过目标。 */
let lastImageId: string | null | undefined;

/**
 * 按 `targetSource` 与布置重算本窗口目标的有效样式 / 过渡并写进 `state`。
 * 返回该目标的当前壁纸 id 是否与上次不同（调用方据此重新取壁纸目标）。
 */
function applyTargetConfig(): boolean {
  const config = targetSource.targets[targetId.value] ?? null;
  // 布置先到、带着这个目标的 `setting-change` 还没到（两者不走同一条通道，先后不保证）：
  // 画面先不动，等目标配置到了再算，免得按「没有配置」闪一下默认样式、多取一次壁纸
  if (!config && lastImageId !== undefined) return false;
  const displayMode = displayModeOfTarget(targetId.value);
  const combo = targetSource.combos.find((item) => item.value === displayMode);

  const styleMode = effectiveStyle(config, WINDOW_MODE, combo) as Mode;
  if (styleMode !== state.styleMode) {
    lastStyleTs.value = new Date().toLocaleTimeString();
    state.styleMode = styleMode;
  }
  const transition = effectiveTransition(config, WINDOW_MODE, combo) as Transition;
  if (transition !== state.transition) {
    lastTransitionTs.value = new Date().toLocaleTimeString();
    state.transition = transition;
  }

  const imageId = config?.currentImageId ?? null;
  const imageChanged = lastImageId !== undefined && imageId !== lastImageId;
  lastImageId = imageId;
  return imageChanged;
}

/** 交给 Stage 的音量：布置不出声时为 0（同一张壁纸各屏各播一份，只让主屏窗口出声）。 */
const stageVolume = computed(() => (assignment.value?.audible === false ? 0 : state.volume));

/** 视频、网页、场景共用设置页的「暂停壁纸」，换壁纸后仍保持；图片不受影响。 */
const stagePaused = computed(() => state.paused && state.target !== null && isPausableTarget(state.target));

// 调试状态（窗口侧）
const windowLabel = ref("");
const readyInvoked = ref(false);
const lastImageTs = ref("");
const lastStyleTs = ref("");
const lastTransitionTs = ref("");
/** 窗口侧错误；与 WallpaperStage 的 lastError 按赋值时刻「后写者胜」合并显示（原实现两者共用一个变量）。 */
const windowError = ref("");
const windowErrorAt = ref(0);

/**
 * 接收当前壁纸目标，交给 `WallpaperStage` 渲染。网页壁纸（`x-wpe/web`）同样在这里渲染：它是 web 层里的
 * `file:` iframe（与图库预览同一套），窗口本身不导航；后端只按当前壁纸开关桌面鼠标转发。
 */
function acceptTarget(target: WallpaperTarget | null) {
  if (!target?.path) return;
  state.target = target;
}

function setWindowError(message: string) {
  windowError.value = message;
  windowErrorAt.value = performance.now();
}

// 帧率（dev）：与主窗口 FrameMonitor 共用同一个 store 与采样口径（300ms 窗口内的最低 / 平均 rAF 帧率），
// 用来直接看壁纸窗口挂到 WorkerW 之后 rAF 有没有被降频，不必再经 CDP 测。
const frameMonitorStore = useFrameMonitorStore();
const frameSnapshot = ref<FrameMonitorSnapshot | null>(null);
let frameMonitorHookId: number | null = null;
const fpsClass = (level: FrameMonitorLevel) =>
  level === "bad" ? "text-red-300" : level === "warn" ? "text-yellow-300" : "text-emerald-300";
const minFpsText = computed(() => (frameSnapshot.value ? String(frameSnapshot.value.minFps) : "--"));
const avgFpsText = computed(() => (frameSnapshot.value ? String(frameSnapshot.value.avgFps) : "--"));
const minFpsClass = computed(() => fpsClass(getFrameMonitorLevel(frameSnapshot.value?.minFps ?? null)));
const avgFpsClass = computed(() => fpsClass(getFrameMonitorLevel(frameSnapshot.value?.avgFps ?? null)));

const stageDebug = computed(() => stage.value?.debugState() ?? null);
const displayedError = computed(() => {
  const s = stageDebug.value;
  if (s && s.lastErrorAt >= windowErrorAt.value) return s.lastError;
  return windowError.value;
});

// 事件监听器（setting-change、布置变化）
let unlistenSettingChange: UnlistenFn | null = null;
let unlistenAssignment: UnlistenFn | null = null;

function isAssignment(value: unknown): value is WallpaperWindowAssignment {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<WallpaperWindowAssignment>;
  return typeof candidate.targetId === "string" && candidate.targetId !== "" && typeof candidate.audible === "boolean";
}

/**
 * `targetSource` 或布置变了之后：样式 / 过渡就地更新；本窗口目标的当前壁纸 id 变了才重新取壁纸目标
 * （轮播位置等其它字段的写入、别的目标换壁纸都不触发；换到另一个目标而它的当前壁纸与画面上的相同也不触发）。
 */
async function reapplyTargetSource() {
  if (!applyTargetConfig()) return;
  lastImageTs.value = new Date().toLocaleTimeString();
  // 明确带上目标：取到的壁纸与刚才比较的配置是同一个目标的
  const requested = targetId.value;
  try {
    const target = await invoke<WallpaperTarget | null>("get_current_wallpaper_target", { target: requested });
    // 等待期间布置又换了目标：这份结果作废，新布置那一次会自己取
    if (requested !== targetId.value) return;
    acceptTarget(target);
  } catch {
    // 忽略，可能是无壁纸
  }
}

// ---- ping 应答 ----
// 后端每 10s 发一次 ping，连续 3 次没应答就重载。页面不计时，避免 hidden 定时器节流。
// 挂载即应答：ping 只管「活着」，init 有没有跑通仍归 init 看门狗。
// 网页壁纸显示期间不应答，交给 web 层 iframe 里的垫片：页面卡死就不应答，照样触发整页重载。
// 切换的短暂间隙最多漏一两次（阈值 3 次），不会误触发重载。
let unlistenPing: UnlistenFn | null = null;

async function listenPing() {
  const label = getCurrentWebviewWindow().label;
  unlistenPing = await listen<{ label: string; seq: number }>("wallpaper-ping", (event) => {
    if (event.payload.label !== label) return; // 只应答本窗口
    if (stage.value?.delegatesPing()) return; // 网页或已启动的场景宿主由垫片应答
    invoke("wallpaper_pong", { seq: event.payload.seq }).catch(() => {});
  });
}

// ---- init 看门狗 ----
// 睡眠瞬间 renderer 被杀 → CEF `on_render_process_terminated` reload → 重载后
// init() 的首个 IPC await（listen/invoke）恰逢系统挂起，响应永久丢失（Tauri
// invoke 无超时），init 卡死在中途 → 永久白屏（2026-08 实测复现）。
// 对策：init 未在期限内跑完就整页重载。挂起期间定时器被冻结，唤醒后才触发，
// 此时 IPC 已恢复，重载后的 init 必然成功；成功后清零重试计数。
const INIT_RETRY_KEY = "wallpaperInitRetry";
let initDone = false;

function armInitWatchdog() {
  const attempt = Number(sessionStorage.getItem(INIT_RETRY_KEY) || "0");
  // 15s 起步，指数退避封顶 2min：避免后端长期不可用时高频重载
  const delay = Math.min(15_000 * 2 ** attempt, 120_000);
  window.setTimeout(() => {
    if (initDone) return;
    sessionStorage.setItem(INIT_RETRY_KEY, String(attempt + 1));
    location.reload();
  }, delay);
}

async function init() {
  // 先武装看门狗再碰任何 await：init 的每个 IPC await 都可能在系统挂起
  // 瞬间永久 pending
  armInitWatchdog();

  try {
    windowLabel.value = getCurrentWebviewWindow().label;
  } catch (e) {
    setWindowError(`getCurrentWebviewWindow failed: ${String(e)}`);
  }

  // 监听 setting-change 事件（payload 为 { key: value } 形式的变更对象）
  unlistenSettingChange = await listen<Record<string, unknown>>("setting-change", async (event) => {
    const raw = event.payload;
    const changes =
      raw && typeof raw === "object" && "changes" in raw && typeof (raw as { changes?: unknown }).changes === "object"
        ? ((raw as { changes: Record<string, unknown> }).changes as Record<string, unknown>)
        : raw && typeof raw === "object"
          ? (raw as Record<string, unknown>)
          : {};
    // 目标的任何一次写入都发整个 map。显示器模式、默认屏、在线屏不用看：本窗口显示哪个目标由后端的布置决定
    if ("wallpaperTargets" in changes && changes.wallpaperTargets && typeof changes.wallpaperTargets === "object") {
      targetSource.targets = changes.wallpaperTargets as WallpaperTargets;
      await reapplyTargetSource();
    }
    if ("wallpaperVolume" in changes && typeof changes.wallpaperVolume === "number") {
      const v = changes.wallpaperVolume;
      state.volume = Math.min(1, Math.max(0, Number.isFinite(v) ? v : 1));
    }
    if ("wallpaperVideoPlaybackRate" in changes && typeof changes.wallpaperVideoPlaybackRate === "number") {
      state.playbackRate = Math.min(3, Math.max(0.25, changes.wallpaperVideoPlaybackRate));
    }
    if ("wallpaperPaused" in changes && typeof changes.wallpaperPaused === "boolean") {
      state.paused = changes.wallpaperPaused;
    }
  });

  // 布置变化（切显示器模式、主屏换了）：换目标后样式 / 过渡 / 当前壁纸都改读新目标。
  // 先登记再取初值：登记之后才发生的变化由事件带来，之前的由下面那次读取带来。
  let assignmentEventSeen = false;
  unlistenAssignment = await listen<WallpaperWindowAssignment>(WALLPAPER_ASSIGNMENT_EVENT, (event) => {
    if (!isAssignment(event.payload)) return;
    assignmentEventSeen = true;
    assignment.value = event.payload;
    void reapplyTargetSource();
  });

  // 初始化时从 settings 拉取当前状态
  try {
    // 先拿布置：之后读哪个目标的配置与当前壁纸都取决于它。读不到（后端没有这个窗口的记录）按 multiple 目标处理
    const assigned = await invoke<WallpaperWindowAssignment | null>("get_wallpaper_window_assignment").catch(
      () => null,
    );
    // 读取在途时先到的事件更新，不让这份结果盖掉它
    if (!assignmentEventSeen && isAssignment(assigned)) assignment.value = assigned;

    // 能力表只用来归一化样式 / 过渡，读不到就直接用存下来的值，不让它连累整个初始化
    const requested = targetId.value;
    const [targetsRes, capabilitiesRes, volumeRes, playbackRateRes, pausedRes, targetRes] = await Promise.all([
      invoke<WallpaperTargets>("get_wallpaper_targets"),
      invoke<WallpaperCapabilities>("get_wallpaper_capabilities").catch(() => null),
      invoke<number>("get_wallpaper_volume"),
      invoke<number>("get_wallpaper_video_playback_rate"),
      invoke<boolean>("get_wallpaper_paused"),
      invoke<WallpaperTarget | null>("get_current_wallpaper_target", { target: requested }),
    ]);
    // 赋值顺序即 WallpaperStage 各 watch 的执行顺序：样式 → 过渡 → 音量 → 倍速 → 暂停 → 目标，
    // 与原实现「先应用样式 / 音量 / 循环，再 setTarget」一致。
    targetSource.targets = targetsRes && typeof targetsRes === "object" ? targetsRes : {};
    targetSource.combos = capabilitiesRes?.displayModes?.[WINDOW_MODE] ?? [];
    // 读取期间布置换了目标：事件那一次重算时目标表还没到，这里按现在的目标再算一遍并自己取壁纸
    const retargeted = requested !== targetId.value;
    applyTargetConfig();
    if (typeof volumeRes === "number" && Number.isFinite(volumeRes)) {
      state.volume = Math.min(1, Math.max(0, volumeRes));
    }
    if (typeof playbackRateRes === "number" && Number.isFinite(playbackRateRes)) {
      state.playbackRate = Math.min(3, Math.max(0.25, playbackRateRes));
    }
    if (typeof pausedRes === "boolean") {
      state.paused = pausedRes;
    }
    if (retargeted) {
      const current = targetId.value;
      const target = await invoke<WallpaperTarget | null>("get_current_wallpaper_target", { target: current });
      if (current === targetId.value) acceptTarget(target);
    } else {
      acceptTarget(targetRes);
    }
  } catch (e) {
    setWindowError(`init settings fetch failed: ${String(e)}`);
  }

  // 壁纸窗口 ready 握手（初始加载完成后通知后端，用于 remount/show）
  try {
    readyInvoked.value = true;
    await invoke("wallpaper_window_ready");
  } catch (e) {
    setWindowError(`invoke wallpaper_window_ready failed: ${String(e)}`);
  }

  // init 完整跑通：解除看门狗并清零重载计数
  initDone = true;
  sessionStorage.removeItem(INIT_RETRY_KEY);
}

function cleanup() {
  unlistenPing?.();
  unlistenPing = null;
  unlistenSettingChange?.();
  unlistenSettingChange = null;
  unlistenAssignment?.();
  unlistenAssignment = null;
}

// 子组件 WallpaperStage 的 onMounted 先于这里执行，等价于原实现 init() 开头的 initDOM()。
onMounted(() => {
  void listenPing();
  void init();
  // 清理：页面卸载（含看门狗 reload）时释放监听，同原实现
  window.addEventListener("beforeunload", cleanup);
  if (IS_DEV) {
    frameMonitorHookId = frameMonitorStore.registerHook({
      intervalMs: FRAME_MONITOR_SAMPLE_MS,
      callback: (snapshot) => {
        frameSnapshot.value = snapshot;
      },
    });
  }
});

onBeforeUnmount(() => {
  window.removeEventListener("beforeunload", cleanup);
  cleanup();
  if (frameMonitorHookId !== null) {
    frameMonitorStore.unregisterHook(frameMonitorHookId);
    frameMonitorHookId = null;
  }
});
</script>

<template>
  <div class="wallpaper-root relative w-screen h-screen overflow-hidden bg-transparent">
    <!-- interactive：网页壁纸 iframe 要接收后端从桌面注入的鼠标事件 -->
    <!-- 音量：布置不出声的窗口（各屏复制时的副屏）恒为 0，其余 props 各窗口相同 -->
    <WallpaperStage
      ref="stage"
      :target="state.target"
      :style-mode="state.styleMode"
      :transition="state.transition"
      :volume="stageVolume"
      :playback-rate="state.playbackRate"
      :paused="stagePaused"
      interactive
    />
    <!-- 调试面板（开发模式），内容与原实现一致 -->
    <div v-if="IS_DEV" class="debug-panel">
      <div class="debug-title">Wallpaper Debug</div>
      <div>
        fps:
        <span class="text-zinc-400">MIN</span>
        <span class="ml-1" :class="minFpsClass">{{ minFpsText }}</span>
        <span class="text-zinc-400 ml-2">AVG</span>
        <span class="ml-1" :class="avgFpsClass">{{ avgFpsText }}</span>
      </div>
      <div>label: {{ windowLabel || "unknown" }}</div>
      <div>target: {{ targetId }}{{ assignment ? (assignment.audible ? "" : " (muted)") : " (no assignment)" }}</div>
      <div>ready invoked: {{ readyInvoked ? "yes" : "no" }}</div>
      <div>last image ts: {{ lastImageTs || "-" }}</div>
      <div>last style ts: {{ lastStyleTs || "-" }}</div>
      <div>last transition ts: {{ lastTransitionTs || "-" }}</div>
      <div>mode: {{ stageDebug?.mode ?? state.styleMode }}</div>
      <div>media: {{ stageDebug?.media ?? "image" }}</div>
      <div>transition: {{ stageDebug?.transition ?? state.transition }}</div>
      <div class="debug-path">rawPath: {{ stageDebug?.rawPath || "-" }}</div>
      <div v-if="displayedError" class="debug-error">error: {{ displayedError }}</div>
    </div>
  </div>
</template>

<style>
/*
 * 壁纸窗口的全局文档样式（原 wallpaper.html 内联 <style>）：本组件只在壁纸窗口的 bootstrap chunk 里加载，
 * 不会影响主窗口。必须用非 scoped 的 <style>：要作用到 html / body / #app，且窗口是透明的，
 * 背景必须显式透明（anime-theme.css 给 body 设了主题背景，这里用更高特异性的选择器盖掉）。
 */
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}
html,
html > body {
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: transparent;
}
#app {
  width: 100%;
  height: 100%;
  background: transparent;
}
</style>
