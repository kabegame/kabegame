import { onScopeDispose, ref, watch, type Ref } from "vue";
import {
  WPE_SCENE_PROGRESS_STAGES,
  creepProgress,
  overallProgress,
  type WpeSceneProgress,
  type WpeSceneProgressStage,
} from "@/components/wallpaper/wpeSceneProgress";

/** 宿主阻塞期间进度条往前挪的节奏；条本身带宽度过渡，看起来是连续的。 */
export const WPE_LOAD_PROGRESS_TICK_MS = 150;

/**
 * 一次场景加载的进度条状态（`ImageContent` 的 wallpaper 形态，规则见 `wpeSceneProgress.ts`）：
 * - `start()` 从应用页自己的 `page` 阶段的 0 开始（挂上 iframe 到宿主第一条消息）；
 * - `report()` 收宿主的进度：总进度只增不减、阶段只往前走（被取代的加载重新从 `compile` 报，不让条倒退）；
 * - `active` 为真期间按 {@link WPE_LOAD_PROGRESS_TICK_MS} 逼近当前阶段上沿的 90%（`creepProgress`），宿主同步阻塞时条也在动；
 * - `complete()` 走满（实时画面出来、或确定显示不了时，覆盖层随后淡出）。
 */
export function useWpeLoadProgress(active: Ref<boolean>) {
  /** 0…1 */
  const value = ref(0);
  const stage = ref<WpeSceneProgressStage>("page");
  /** 当前阶段最近一次的真实计数（覆盖层显示「done / total」）；还没有消息时为 null */
  const count = ref<{ done: number; total: number } | null>(null);
  /** 最近一次真实进度（开始时是 0）与那一刻：逼近从这里算 */
  let base = 0;
  let baseAt = performance.now();
  let timer: number | undefined;

  function tick() {
    value.value = Math.max(value.value, creepProgress(base, stage.value, performance.now() - baseAt));
  }

  function stopTimer() {
    window.clearInterval(timer);
    timer = undefined;
  }

  watch(
    active,
    (on) => {
      stopTimer();
      if (on) timer = window.setInterval(tick, WPE_LOAD_PROGRESS_TICK_MS);
    },
    { immediate: true },
  );
  onScopeDispose(stopTimer);

  function start() {
    value.value = 0;
    stage.value = "page";
    count.value = null;
    base = 0;
    baseAt = performance.now();
  }

  function report(progress: WpeSceneProgress) {
    if (WPE_SCENE_PROGRESS_STAGES.indexOf(progress.stage) < WPE_SCENE_PROGRESS_STAGES.indexOf(stage.value)) return;
    stage.value = progress.stage;
    count.value = { done: progress.done, total: progress.total };
    base = Math.max(value.value, overallProgress(progress));
    baseAt = performance.now();
    value.value = base;
  }

  function complete() {
    value.value = 1;
  }

  return { value, stage, count, start, report, complete };
}
