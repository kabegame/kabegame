/**
 * dev 探针回放的逐帧指针（P5a 收尾：回放逐帧光标，dev 专用）。
 *
 * 回放收的光标一律是 WPE 的 `g_PointerPosition`：抓帧窗口归一化坐标（原点左上、y 朝下、不钳制）。探针照渲染器（`render/renderer.ts`
 * 的 `setPointer` / `cursorOf`）从它推出两个量，壁纸样式固定 `fill`（WPE 测试窗口就是居中盖满裁切）：
 * - `g_PointerPosition`（uniform、视差点）：`scenePointer("fill", …)`，即原样；
 * - 控制点跟随指针的 `cursor`（光标下的场景纹理坐标）：`sceneCursor("fill", scenePlacement("fill", 场景宽, 场景高, 窗口宽, 窗口高), …)`。
 * 窗口没给或与场景同尺寸时两者都原样，和加这一项之前逐字节相同；不同尺寸时与 kbp replay（`replayLib.ts` 的 `"track"` 分支）同一换算。
 * 场景尺寸用 `bundle.general.width/height`（视差点与 `particleTrack` 的 `size` 用的同一个）。
 */
import { sceneCursor, scenePlacement, scenePointer } from "../render/layout";

export type Point = [number, number];

export interface ReplayPointerOptions {
  /** 固定的 `g_PointerPosition`：预热、回放的每一帧和读回那一帧都用它；缺省 `[0.5, 0.5]`。不和 `pointers` 同给。 */
  pointer?: readonly [number, number];
  /** 逐帧的 `g_PointerPosition`，和回放的 `dts` 等长（第 i 项是第 i + 1 帧）；要有回放。 */
  pointers?: readonly (readonly [number, number])[];
  /** 抓帧窗口尺寸 `[宽, 高]`（像素）；缺省或与场景同尺寸时光标原样。 */
  window?: readonly [number, number];
}

/** 回放每一帧的两个量，下标同 `dts`；没有回放时只有一项（读回那一帧）。 */
export interface ReplayPointers {
  /** 每帧的 `g_PointerPosition`（uniform 与视差点）。 */
  pointers: Point[];
  /** 每帧控制点跟随指针的 `cursor`（光标下的场景纹理坐标，`GpuScene.stepParticles`）。 */
  cursors: Point[];
  /** 预热（`GpuScene.build` 的 `particles.cursor`）用的 cursor：第 0 项。 */
  warmup: Point;
}

const isPoint = (value: unknown): value is readonly [number, number] =>
  Array.isArray(value) && value.length === 2 && value.every((x) => typeof x === "number" && Number.isFinite(x));

/** 窗口尺寸：两个正的有限数。 */
function checkWindow(window: unknown): asserts window is readonly [number, number] {
  if (!isPoint(window) || !(window[0] > 0 && window[1] > 0)) {
    throw new Error(`window 要是 [宽, 高]（两个正数，像素），收到 ${JSON.stringify(window)}`);
  }
}

/**
 * 读回画布尺寸 `[宽, 高]`（`renderFrame` 的 `canvas`，第 5 批）：两个正整数；给了 `maxDimension`（设备的 `maxTextureDimension2D`）
 * 时各不超过它。不合法抛错，合法原样返回。
 */
export function checkCanvas(canvas: unknown, maxDimension?: number): [number, number] {
  const ok =
    Array.isArray(canvas) &&
    canvas.length === 2 &&
    canvas.every((x) => typeof x === "number" && Number.isInteger(x) && x > 0);
  if (!ok) throw new Error(`canvas 要是 [宽, 高]（两个正整数，像素），收到 ${JSON.stringify(canvas)}`);
  const size = canvas as [number, number];
  if (maxDimension !== undefined && (size[0] > maxDimension || size[1] > maxDimension)) {
    throw new Error(`canvas ${size[0]}×${size[1]} 超过设备的纹理上限 ${maxDimension}`);
  }
  return size;
}

/**
 * 光标换算用的窗口（第 5 批）：`window ?? canvas`。读回画布就是模拟的壁纸窗口，没给 `window` 时光标按画布换算；两个都给而不相等时
 * 抛错（光标和读回的画面会对不上）。都没给时为 undefined（光标原样，同以前）。
 */
export function pointerWindow(
  window: readonly [number, number] | undefined,
  canvas: readonly [number, number] | undefined,
): readonly [number, number] | undefined {
  if (window !== undefined) checkWindow(window);
  if (canvas !== undefined) checkCanvas(canvas);
  if (window && canvas && (window[0] !== canvas[0] || window[1] !== canvas[1])) {
    throw new Error(
      `window ${window[0]}×${window[1]} 与 canvas ${canvas[0]}×${canvas[1]} 不同：读回画布就是模拟的窗口，光标按它换算，两者要相同（或只给一个）`,
    );
  }
  return window ?? canvas;
}

/**
 * 窗口上的指针 → `g_PointerPosition` 与 `cursor`（壁纸样式 `fill`）。`window` 没给或与场景同尺寸时原样（cursor 与 pointer 相同）。
 */
export function windowPointer(
  scene: readonly [number, number],
  window?: readonly [number, number],
): (pointer: readonly [number, number]) => { pointer: Point; cursor: Point } {
  if (window !== undefined) checkWindow(window);
  if (!window || (window[0] === scene[0] && window[1] === scene[1])) {
    return ([x, y]) => ({ pointer: [x, y], cursor: [x, y] });
  }
  const [width, height] = window;
  const placement = scenePlacement("fill", scene[0], scene[1], width, height);
  return ([x, y]) => ({
    pointer: scenePointer("fill", placement, width, height, x, y),
    cursor: sceneCursor("fill", placement, width, height, x, y),
  });
}

/**
 * `particleTrack` 的逐帧光标：窗口归一化 → 光标下的场景纹理坐标（`sceneCursor("fill", …)`）。`window` 没给或与场景同尺寸时原样返回
 * 同一个数组（逐字节同加这一项之前）。
 */
export function sceneCursors(
  cursors: readonly (readonly [number, number])[],
  scene: readonly [number, number],
  window?: readonly [number, number],
): readonly (readonly [number, number])[] {
  if (window !== undefined) checkWindow(window);
  if (!window || (window[0] === scene[0] && window[1] === scene[1])) return cursors;
  const convert = windowPointer(scene, window);
  return cursors.map((point) => convert(point).cursor);
}

/**
 * 回放每一帧的 `g_PointerPosition` 与 `cursor`。`frames` 是回放的帧数（`particles.dts.length`），没有回放时为 undefined（只有读回那一帧）。
 * 只给 `pointer`（或都不给）时每一帧都是它；给 `pointers` 时逐帧取，要有回放、和 `dts` 等长、不和 `pointer` 同给。
 */
export function replayPointers(
  options: ReplayPointerOptions,
  scene: readonly [number, number],
  frames: number | undefined,
): ReplayPointers {
  const convert = windowPointer(scene, options.window);
  const count = Math.max(1, frames ?? 0);
  let raw: readonly (readonly [number, number])[];
  if (options.pointers !== undefined) {
    if (options.pointer !== undefined) throw new Error("pointer 与 pointers 不能同时给");
    if (!frames) throw new Error("pointers 要和 particles 一起给（逐帧指针是回放的每一帧）");
    if (options.pointers.length !== frames) {
      throw new Error(`pointers 有 ${options.pointers.length} 项，应和 particles.dts 等长（${frames} 项）`);
    }
    options.pointers.forEach((point, i) => {
      if (!isPoint(point)) throw new Error(`pointers[${i}] 要是 [x, y]（两个有限数），收到 ${JSON.stringify(point)}`);
    });
    raw = options.pointers;
  } else {
    const fixed = options.pointer ?? [0.5, 0.5];
    raw = Array.from({ length: count }, () => fixed);
  }
  const converted = raw.map(convert);
  const cursors = converted.map((item) => item.cursor);
  return { pointers: converted.map((item) => item.pointer), cursors, warmup: cursors[0] };
}
