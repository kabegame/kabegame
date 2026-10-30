<script setup lang="ts">
/**
 * 壁纸窗口根组件（`index.html?window=wallpaper`）：承担原 `src/wallpaper.ts` 里 `init()` 的全部职责——
 * 看门狗、`setting-change` 监听、启动时并行拉取设置与当前壁纸、`wallpaper_window_ready` 握手、dev 调试面板，
 * 再把结果作为 props 交给纯渲染组件 `WallpaperStage`。后端仍是唯一属主，本窗口是「自驱动」的观察方。
 */
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { computed, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import { invoke, listen, type UnlistenFn } from "@/api/rpc";
import { IS_DEV } from "@/env";
import WallpaperStage from "@/components/wallpaper/WallpaperStage.vue";
import type { Mode, Transition, WallpaperTarget } from "@/components/wallpaper/types";
import { wpeKind } from "@/utils/mediaMime";
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
}>({
  target: null,
  styleMode: "fill",
  transition: "fade",
  /** 视频壁纸音量 0~1，与设置页、预览内逻辑一致 */
  volume: 1,
  /** 视频播放速率 0.25～3 */
  playbackRate: 1,
});

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
 * 接收当前壁纸目标。桌面网页壁纸（`x-wpe/web`）由 Rust 的 `WindowWallpaperManager::set_wallpaper_path`
 * 把整个窗口导航到 `file://` 入口，这里不渲染、保持现有画面，避免与 Rust 抢导航。
 */
function acceptTarget(target: WallpaperTarget | null) {
  if (!target?.path) return;
  if (wpeKind(target.type) === "web") return;
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

// 事件监听器（setting-change）
let unlistenSettingChange: UnlistenFn | null = null;

// ---- ping 应答 ----
// 后端每 10s 发一次 ping，连续 3 次没应答就重载。页面不计时，避免 hidden 定时器节流。
// 挂载即应答：ping 只管「活着」，init 有没有跑通仍归 init 看门狗。
let unlistenPing: UnlistenFn | null = null;

async function listenPing() {
  const label = getCurrentWebviewWindow().label;
  unlistenPing = await listen<{ label: string; seq: number }>("wallpaper-ping", (event) => {
    if (event.payload.label !== label) return; // 只应答本窗口
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
    if ("wallpaperStyle" in changes && typeof changes.wallpaperStyle === "string") {
      lastStyleTs.value = new Date().toLocaleTimeString();
      state.styleMode = changes.wallpaperStyle as Mode;
    }
    if ("wallpaperRotationTransition" in changes && typeof changes.wallpaperRotationTransition === "string") {
      lastTransitionTs.value = new Date().toLocaleTimeString();
      state.transition = changes.wallpaperRotationTransition as Transition;
    }
    if ("currentWallpaperImageId" in changes) {
      lastImageTs.value = new Date().toLocaleTimeString();
      try {
        const target = await invoke<WallpaperTarget | null>("get_current_wallpaper_target");
        acceptTarget(target);
      } catch {
        // 忽略，可能是无壁纸
      }
    }
    if ("wallpaperVolume" in changes && typeof changes.wallpaperVolume === "number") {
      const v = changes.wallpaperVolume;
      state.volume = Math.min(1, Math.max(0, Number.isFinite(v) ? v : 1));
    }
    if ("wallpaperVideoPlaybackRate" in changes && typeof changes.wallpaperVideoPlaybackRate === "number") {
      state.playbackRate = Math.min(3, Math.max(0.25, changes.wallpaperVideoPlaybackRate));
    }
  });

  // 初始化时从 settings 拉取当前状态
  try {
    const [styleRes, transitionRes, volumeRes, playbackRateRes, targetRes] = await Promise.all([
      invoke<string>("get_wallpaper_rotation_style"),
      invoke<string>("get_wallpaper_rotation_transition"),
      invoke<number>("get_wallpaper_volume"),
      invoke<number>("get_wallpaper_video_playback_rate"),
      invoke<WallpaperTarget | null>("get_current_wallpaper_target"),
    ]);
    // 赋值顺序即 WallpaperStage 各 watch 的执行顺序：样式 → 过渡 → 音量 → 倍速 → 目标，
    // 与原实现「先应用样式 / 音量 / 循环，再 setTarget」一致。
    if (styleRes && typeof styleRes === "string") {
      state.styleMode = styleRes as Mode;
    }
    if (transitionRes && typeof transitionRes === "string") {
      state.transition = transitionRes as Transition;
    }
    if (typeof volumeRes === "number" && Number.isFinite(volumeRes)) {
      state.volume = Math.min(1, Math.max(0, volumeRes));
    }
    if (typeof playbackRateRes === "number" && Number.isFinite(playbackRateRes)) {
      state.playbackRate = Math.min(3, Math.max(0.25, playbackRateRes));
    }
    acceptTarget(targetRes);
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
    <WallpaperStage
      ref="stage"
      :target="state.target"
      :style-mode="state.styleMode"
      :transition="state.transition"
      :volume="state.volume"
      :playback-rate="state.playbackRate"
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
