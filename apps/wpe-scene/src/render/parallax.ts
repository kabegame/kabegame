/**
 * 相机视差（P5a 步骤 2）：每帧一次的视差点 P 与 `g_ParallaxPosition`，以及每次绘制按根对象算的平移。纯函数，不碰 GPU。
 *
 * 公式照读码（rea-p5-camera.md 第 6 节），2026-11-10 对 WPE 逐项实测（p5-REPORT「P5a 语义的实测核对」，`ana_a.txt`）：
 * - **目标点**：指针先钳到 0…1、y 翻成向上（`mx = clamp(ptr.x)`、`my = clamp(1 − ptr.y)`），再在场景中心与指针之间按
 *   `mi = cameraparallaxmouseinfluence` 插值：`P* = eye.xy + (W·(0.5(1 − mi) + mx·mi), H·(0.5(1 − mi) + my·mi))`。`mi` 不钳制：
 *   `p5a-ptrm2` 的 mi = −2 时 P = (−960, 1620)，在场景外。
 * - **平滑**：`delay > 0` 时 `k = min(1, (1 − delay/3)·10·dt)`、`P ← P + (P* − P)·k`，dt 是本帧的帧时间（`p5a-delay27` / `29` 逐帧
 *   实测 k 与公式差 < 1e-5，用上一帧的 dt 对不上）；`delay ≤ 0` 时 P 直接取目标。P 不钳制。`delay ≥ 3` 时 k ≤ 0，P 会远离目标，
 *   照 WPE 不另外处理（语料最大 2.0）。补画帧的帧时间是 0，k 也是 0，P 不动。
 * - **`g_ParallaxPosition`** = `clamp(P / (W, H), 0, 1)`，只进 uniform、和对象平移无关（`3818481122` 的 `depthparallax` 读到
 *   (0.75, 0.25)）。加载时 (0.5, 0.5)，只在开关开着时每帧更新，关着时保留上一次的值。
 * - **对象平移**：`o = amount · depth(根) ⊙ (origin(根).xy − P)`，z 恒 0。只用根对象（沿父链走到顶）的 `origin` 字段与
 *   `parallaxDepth`，子对象整体跟着根走、自己的深度不参与；静止时原点不在中心的层也有偏移（`p5a-static` 7 个方块误差 0）。
 * - **初值**：加载时 P = eye.xy + (W/2, H/2)，即场景中心，开场有一段从中心滑向指针的过渡（`p5a-delay29` 开窗 4 s 后还在途中）。
 *
 * W、H 是场景的正交尺寸（`SceneGeneral.width/height`，不是可能被缩小的渲染目标），偏移是场景单位（`2381978484`：8192×5479 的场景
 * 放进 16:9 窗口，偏移仍按场景单位）。eye 是正交相机的 eye.xy，没有抖动时为 0（步骤 3 起加抖动）。
 * 指针是 `g_PointerPosition`（已按壁纸样式换算，`layout.ts` 的 `scenePointer`）：WPE 的视差点直接用窗口归一化的指针乘场景宽高，
 * 和 `g_PointerPosition` 同源，不是控制点用的反投影。
 *
 * 渲染器与 dev 探针共用：渲染器每帧在粒子与脚本之前 `advanceParallax`，脚本之后按当时的开关与 amount 取 `drawParallax` 交给
 * `GpuScene.setParallax`（WPE 绘制时才读 amount 与开关，rea-p5-camera.md 6.3）；探针按 dt 序列从加载起逐帧推进同一个状态
 * （`replayParallax`）。透视场景 WPE 不移动对象（6.1），透视整张另报 `camera:perspective`，这里只有正交。
 */
import type { GeneralValues } from "../compile/bindings";

/** 视差的输入（`SceneState.general` 与帧量），由 `parallaxInput` 组装。 */
export interface ParallaxInput {
  /** `general.cameraparallax`：关着时 `advanceParallax` 不推进。 */
  enabled: boolean;
  /** `cameraparallaxamount`。 */
  amount: number;
  /** `cameraparallaxdelay`。 */
  delay: number;
  /** `cameraparallaxmouseinfluence`，不钳制。 */
  mouseInfluence: number;
  /** `g_PointerPosition`（左上原点、y 向下，可能超出 0…1）。 */
  pointer: readonly [number, number];
  /** 正交相机的 eye.xy：没有抖动时为 0（步骤 3 起加抖动）。 */
  eye: readonly [number, number];
  /** 场景的正交尺寸 W、H。 */
  width: number;
  height: number;
  /** 本帧的帧时间（补画帧为 0）。 */
  frametime: number;
}

/** 视差用到的四个 general 字段（`SceneState.general` 满足）。 */
export type ParallaxFields = Pick<
  GeneralValues,
  "cameraparallax" | "cameraparallaxamount" | "cameraparallaxdelay" | "cameraparallaxmouseinfluence"
>;

/** 一帧的帧量：指针、帧时间与场景的正交尺寸。 */
export interface ParallaxFrame {
  pointer: readonly [number, number];
  frametime: number;
  width: number;
  height: number;
  /** 缺省 (0, 0)：正交、没有抖动。 */
  eye?: readonly [number, number];
}

/** 跨帧保留的视差状态。 */
export interface ParallaxState {
  /** 视差点 P（场景坐标，y 向上，不钳制）。 */
  point: [number, number];
  /** `g_ParallaxPosition`：开关开着时每帧更新，关着时保留上一次的值。 */
  position: [number, number];
}

/** 交给 `GpuScene.setParallax` 的一帧视差（开关关着时为 null）。 */
export interface SceneParallax {
  point: readonly [number, number];
  amount: number;
}

/** 钳到 0…1；NaN 当 0（透视场景 W = 0 时 WPE 除出 NaN，钳制分支把它变成 0，rea-p5-camera.md 6.2【推】）。 */
function clamp01(value: number): number {
  return value > 0 ? Math.min(1, value) : 0;
}

/** 场景中心 = 加载时的 P（eye 为 0 时）。 */
export function initialParallaxPoint(
  width: number,
  height: number,
  eye: readonly [number, number] = [0, 0],
): [number, number] {
  return [eye[0] + width / 2, eye[1] + height / 2];
}

/** 目标点：指针钳到 0…1、y 翻成向上，再在场景中心与指针之间按 `mouseInfluence` 插值，加 eye.xy。 */
export function parallaxTarget(
  input: Pick<ParallaxInput, "mouseInfluence" | "pointer" | "eye" | "width" | "height">,
): [number, number] {
  const mi = input.mouseInfluence;
  const mx = clamp01(input.pointer[0]);
  const my = clamp01(1 - input.pointer[1]);
  const base = 0.5 * (1 - mi);
  return [input.eye[0] + input.width * (base + mx * mi), input.eye[1] + input.height * (base + my * mi)];
}

/** 一帧的平滑系数 `k = min(1, (1 − delay/3)·10·dt)`；`delay ≤ 0` 时为 null（P 直接取目标）。 */
export function parallaxSmoothing(delay: number, frametime: number): number | null {
  return delay > 0 ? Math.min(1, (1 - delay / 3) * 10 * frametime) : null;
}

/** 一帧：`delay > 0` 时 `P ← P + (目标 − P)·k`，否则 P = 目标。P 不钳制。 */
export function stepParallaxPoint(
  previous: readonly [number, number],
  input: Pick<ParallaxInput, "delay" | "mouseInfluence" | "pointer" | "eye" | "width" | "height" | "frametime">,
): [number, number] {
  const target = parallaxTarget(input);
  const k = parallaxSmoothing(input.delay, input.frametime);
  if (k === null) return target;
  return [previous[0] + (target[0] - previous[0]) * k, previous[1] + (target[1] - previous[1]) * k];
}

/** `g_ParallaxPosition = clamp(P / (W, H), 0, 1)`。 */
export function parallaxUniform(point: readonly [number, number], width: number, height: number): [number, number] {
  return [clamp01(point[0] / width), clamp01(point[1] / height)];
}

/**
 * 对象平移 `o = amount · depth ⊙ (origin.xy − P)`，`depth` 与 `origin` 取根对象的。`depth` 只有一个分量时铺满两个
 * （属性滑块的数字绑到 `parallaxDepth` 上：WPE 的向量 setter 把数字铺满各分量，p3-script-REPORT 对 vec3 对象字段实测；`numbers`
 * 给图层字段存的是原样分量）。
 */
export function parallaxOffset(
  amount: number,
  depth: readonly number[],
  origin: readonly number[],
  point: readonly [number, number],
): [number, number] {
  const dx = depth[0] ?? 1;
  const dy = depth[1] ?? dx;
  return [amount * dx * ((origin[0] ?? 0) - point[0]), amount * dy * ((origin[1] ?? 0) - point[1])];
}

/** 由 `SceneState.general` 的四个字段与帧量组装输入。 */
export function parallaxInput(fields: ParallaxFields, frame: ParallaxFrame): ParallaxInput {
  return {
    enabled: fields.cameraparallax,
    amount: fields.cameraparallaxamount,
    delay: fields.cameraparallaxdelay,
    mouseInfluence: fields.cameraparallaxmouseinfluence,
    pointer: frame.pointer,
    eye: frame.eye ?? [0, 0],
    width: frame.width,
    height: frame.height,
    frametime: frame.frametime,
  };
}

/** 加载新场景时的状态：P 在场景中心，`g_ParallaxPosition` 为 (0.5, 0.5)。 */
export function initialParallaxState(width: number, height: number): ParallaxState {
  return { point: initialParallaxPoint(width, height), position: [0.5, 0.5] };
}

/**
 * 推进一帧（帧开头、粒子与脚本之前，rea-p5-camera.md 6.2「与相机同一步」）：开着时推进 P、更新 `g_ParallaxPosition`；关着时原样返回
 * （P 不更新，`g_ParallaxPosition` 保留上一次的值）。
 */
export function advanceParallax(state: ParallaxState, input: ParallaxInput): ParallaxState {
  if (!input.enabled) return state;
  const point = stepParallaxPoint(state.point, input);
  return { point, position: parallaxUniform(point, input.width, input.height) };
}

/** 本帧绘制用的视差（`GpuScene.setParallax`）：开关与 amount 取当时的值，关着时为 null（不加平移）。 */
export function drawParallax(state: ParallaxState, fields: ParallaxFields): SceneParallax | null {
  return fields.cameraparallax ? { point: state.point, amount: fields.cameraparallaxamount } : null;
}

/** dev 探针的确定性回放：从 `state` 起按帧时间序列逐帧推进（开关与指针不变，探针没有脚本）。 */
export function replayParallax(
  state: ParallaxState,
  fields: ParallaxFields,
  frame: Omit<ParallaxFrame, "frametime">,
  frametimes: readonly number[],
): ParallaxState {
  let current = state;
  for (const frametime of frametimes)
    current = advanceParallax(current, parallaxInput(fields, { ...frame, frametime }));
  return current;
}
