/**
 * 场景加载进度（壁纸显示重构步骤 2）：宿主（`apps/wpe-scene/src/progress.ts`）只在首次加载时按阶段经 postMessage 报
 * `{ type: WPE_SCENE_PROGRESS, stage, done, total }`，`WpeSceneView` 核对来源后往上报，这里把它换成 0…1 的总进度。
 *
 * - 阶段与权重（一处常量，宿主不关心）：`page` 是应用页自己的阶段（挂上 iframe 到第一条消息：宿主启动、拉属性、等设置），其余四个
 *   来自宿主；`gpu` 是「准备渲染」，编译、解码完就进入，含文本、脚本 `init`、取设备与建 GPU 场景。权重按本机实测的用时定（2026-11-15：
 *   82 层的大场景 页面 / 编译 / 解码 / 准备与 GPU / 首帧 ≈ 5 / 49 / 8 / 37 / 1 %，小场景编译占得更多），「开始渲染」日志里有各段
 *   用时，可以照着调。
 * - **单调**：一次加载里总进度只增不减（被取代的加载、阶段内乱序都不会让它倒退），由使用方用 `Math.max` 保证。
 * - **不停**：宿主同步阻塞（粒子预热、排版、建图层）时发不出消息，`creepProgress` 在当前阶段的区间里按时间逼近区间上沿的 90%，
 *   下一条真实消息一到就以它为准。
 *
 * 字面量与阶段名在宿主另有一份，测试比对。
 */

export const WPE_SCENE_PROGRESS = "kabegame:wpe-scene-progress";

export const WPE_SCENE_PROGRESS_STAGES = ["page", "compile", "decode", "gpu", "frame"] as const;
export type WpeSceneProgressStage = (typeof WPE_SCENE_PROGRESS_STAGES)[number];

/** 各阶段占总进度的份额（和为 100）。 */
export const WPE_SCENE_PROGRESS_WEIGHTS: Readonly<Record<WpeSceneProgressStage, number>> = {
  page: 5,
  compile: 50,
  decode: 10,
  gpu: 30,
  frame: 5,
};

export interface WpeSceneProgress {
  stage: WpeSceneProgressStage;
  done: number;
  total: number;
}

/** 宿主的进度消息（`page` 只在应用页，宿主不发）。 */
export function isWpeSceneProgressMessage(
  data: unknown,
): data is WpeSceneProgress & { type: typeof WPE_SCENE_PROGRESS } {
  if (!data || typeof data !== "object") return false;
  const message = data as Record<string, unknown>;
  return (
    message.type === WPE_SCENE_PROGRESS &&
    typeof message.stage === "string" &&
    message.stage !== "page" &&
    (WPE_SCENE_PROGRESS_STAGES as readonly string[]).includes(message.stage) &&
    typeof message.done === "number" &&
    typeof message.total === "number" &&
    Number.isFinite(message.done) &&
    Number.isFinite(message.total)
  );
}

/** 阶段在总进度里的区间 `[起点, 终点]`（0…1）。 */
export function stageRange(stage: WpeSceneProgressStage): [number, number] {
  let start = 0;
  for (const name of WPE_SCENE_PROGRESS_STAGES) {
    const width = WPE_SCENE_PROGRESS_WEIGHTS[name] / 100;
    if (name === stage) return [start, start + width];
    start += width;
  }
  return [1, 1];
}

/** 总进度（0…1）：阶段起点 + 阶段宽度 × `done / total`；`total` 不大于 0 时当这一阶段已完成，越界的夹进区间。 */
export function overallProgress(progress: WpeSceneProgress): number {
  const [start, end] = stageRange(progress.stage);
  const fraction = progress.total > 0 ? Math.min(1, Math.max(0, progress.done / progress.total)) : 1;
  return start + (end - start) * fraction;
}

/** 逼近的时间常数：没有新消息时，约这么久走完到目标剩余距离的 63%。 */
export const WPE_SCENE_PROGRESS_CREEP_MS = 3_000;

/**
 * 不停（见文件头）：从 `value`（这一阶段最近一次的真实进度）起，过了 `elapsedMs` 之后显示到哪。目标是阶段区间上沿的 90%，
 * 永远到不了上沿，下一阶段的消息来了才跨过去；`value` 已经越过目标时原样返回。
 */
export function creepProgress(
  value: number,
  stage: WpeSceneProgressStage,
  elapsedMs: number,
  tauMs = WPE_SCENE_PROGRESS_CREEP_MS,
): number {
  const [start, end] = stageRange(stage);
  const target = start + (end - start) * 0.9;
  if (value >= target || elapsedMs <= 0) return value;
  return value + (target - value) * (1 - Math.exp(-elapsedMs / tauMs));
}
