/**
 * 场景属性关键帧的曲线（P10a 步骤 1）：关键帧解析、`wraploop` 预处理、整数帧采样与缓存、帧间插值。纯 TS，不依赖 GPU 与编译管线。
 *
 * 依据：`.claude/plans/wpe-import/3-scene/phase10/rea-p10-keyframes.md`（读码，第 2、3、5 节，第 14 节参考实现）与 `p10-REPORT.md`
 * （实测）。WPE 全程 float32（`mulss` / `addss`），这里每一步都过 `Math.fround`，括号就是汇编的运算顺序，和读码模型
 * `ignore/p10/rea/kfmodel.py` 在整数帧上逐位一致。
 *
 * 求值分两级（读码第 2 节）：先按整数帧求贝塞尔值并缓存（`Channel.sample`），再在相邻两个整数帧之间线性插值（`frameValues`）。
 */
import type { AnimationClock } from "./clock";

const f = Math.fround;

/** 关键帧标志（读码第 2 节）：`back` 开、`front` 开、`step`。运行时只看 `KEY_STEP`，另两位只给 `wraploop` 用。 */
export const KEY_BACK = 1;
export const KEY_FRONT = 2;
export const KEY_STEP = 4;

/** 一个关键帧（WPE 0x1c 字节：`{int frame, float value, uint flags, float backX, backY, frontX, frontY}`）。数值都是 float32。 */
export interface ParsedKey {
  frame: number;
  value: number;
  flags: number;
  bx: number;
  by: number;
  fx: number;
  fy: number;
}

/** 求值要用的时钟字段（有父的动画传父的时钟，读码第 1、7 节）。 */
export type ClockView = Pick<AnimationClock, "t" | "spf" | "length">;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** `back` / `front` 是对象，且 `enabled` 不是 `false`：缺省或不是布尔都算开（读码第 2 节「加载」）。 */
function tangentOn(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && value.enabled !== false;
}

/** 切线分量：是数才读，否则 0。 */
function component(value: unknown): number {
  return typeof value === "number" ? f(value) : 0;
}

/**
 * 一个 `cN` 数组 → 关键帧（`FUN_1401a8ce0`，读码第 2 节）：
 * - `value`、`frame` 都必须是数，否则跳过这个关键帧；
 * - `frame` 截断（`asInt`），必须大于上一个收下的帧号（初值 −1），所以负帧号和截断后不递增的都跳过；
 * - `step: true` 时 flags 为 4，不读切线；
 * - 否则开着的一侧读 `x`、`y`，关着的一侧四个分量保持 0。`magic`、`lockangle`、`locklength` 不读（第 6 节）。
 *
 * `arr` 不是数组时返回空数组；它算不算一个通道由调用方决定（WPE 只数连续存在的 `cN` 数组，第 5 节）。
 */
export function parseChannel(arr: unknown): ParsedKey[] {
  const out: ParsedKey[] = [];
  if (!Array.isArray(arr)) return out;
  let last = -1;
  for (const item of arr) {
    if (!isRecord(item) || typeof item.value !== "number" || typeof item.frame !== "number") continue;
    const frame = Math.trunc(item.frame);
    if (frame <= last) continue;
    last = frame;
    const key: ParsedKey = { frame, value: f(item.value), flags: 0, bx: 0, by: 0, fx: 0, fy: 0 };
    if (item.step === true) key.flags = KEY_STEP;
    else {
      if (tangentOn(item.back)) {
        key.flags |= KEY_BACK;
        key.bx = component(item.back.x);
        key.by = component(item.back.y);
      }
      if (tangentOn(item.front)) {
        key.flags |= KEY_FRONT;
        key.fx = component(item.front.x);
        key.fy = component(item.front.y);
      }
    }
    out.push(key);
  }
  return out;
}

/**
 * `wraploop`（`FUN_1401a98b0`，读码第 3 节），加载时对每个通道做一次。返回新数组，不改入参：
 * 1. 少于 2 个关键帧不处理；
 * 2. 从后往前删掉 `frame > length` 的，至少留 1 个，剩下少于 2 个就停；
 * 3. 末帧不在 `length` 就追加 `{frame: length, 其它全 0}`；
 * 4. 末帧的值改成首帧的值。首帧前切线开着时，末帧后切线取它的反；关着时只清末帧的 back 位，**原来的 `bx` / `by` 保留**
 *    （运行时不看位，旧值照样生效，实测 `wrapres`）。
 */
export function applyWraploop(keys: readonly ParsedKey[], length: number): ParsedKey[] {
  const out = keys.map((key) => ({ ...key }));
  if (out.length < 2) return out;
  const first = { ...out[0] };
  while (out.length > 1 && out[out.length - 1].frame > length) out.pop();
  if (out.length < 2) return out;
  if (out[out.length - 1].frame !== length) out.push({ frame: length, value: 0, flags: 0, bx: 0, by: 0, fx: 0, fy: 0 });
  const last = out[out.length - 1];
  if (first.flags & KEY_FRONT) {
    last.flags |= KEY_BACK;
    last.bx = -first.fx;
    last.by = -first.fy;
  } else last.flags &= ~KEY_BACK;
  last.value = first.value;
  return out;
}

/** 二分的初始步长、停止容差（帧）与次数上限（`0x1404926fc`、`0x140492708`，读码第 2 节）。 */
const STEP0 = f(0.999);
const TOLERANCE = 0.01;
const MAX_ITERATIONS = 1000;

/**
 * 第 `i` 帧（整数）的值（`FUN_1401a9bc0`，读码第 2 节）：
 * - 没有关键帧时 0；
 * - `i ≤ 首帧` 取首帧值，`i ≥ 末帧` 取末帧值；
 * - 段内 `i` 正好是左端帧，或右端关键帧带 `step`，取左端值；
 * - 否则三次贝塞尔：x 以半段长为单位、y 是值的绝对偏移，x 用步进搜索反解出 t（t 从 0 开始，步长 0.999 每次先减半再走，
 *   `|x − i| < 0.01` 帧或满 1000 次停），关着的切线按 (0, 0)。
 */
function evaluate(keys: readonly ParsedKey[], i: number): number {
  const n = keys.length;
  if (n === 0) return 0;
  if (i <= keys[0].frame) return keys[0].value;
  for (let j = 1; j < n; j++) {
    const a = keys[j - 1];
    const b = keys[j];
    if (!(a.frame <= i && i < b.frame)) continue;
    if (a.frame === i || (b.flags & KEY_STEP) !== 0) return a.value;
    const h = f(f(b.frame - a.frame) * 0.5);
    const x1 = f(f(h * a.fx) + a.frame);
    const x2 = f(f(h * b.bx) + b.frame);
    // 初值 (i − f0) / (f1 − f0) 是整数除法，段内恒为 0（WPE 的写法）
    let t = 0;
    let step = STEP0;
    for (let iteration = 0; ;) {
      const s = f(1 - t);
      const x = f(
        f(f(f(x1 * f(f(f(s * 3) * s) * t)) + f(f(f(s * s) * s) * a.frame)) + f(x2 * f(f(f(s * 3) * t) * t))) +
          f(f(f(t * t) * t) * b.frame),
      );
      if (Math.abs(f(x - i)) < TOLERANCE) break;
      step = f(step * 0.5);
      t = x > i ? f(t - step) : f(t + step);
      if (++iteration >= MAX_ITERATIONS) break;
    }
    t = Math.min(t, 1);
    if (t < 0) t = 0;
    const s = f(1 - t);
    const y1 = f(a.value + a.fy);
    const y2 = f(b.value + b.by);
    return f(
      f(f(f(y1 * f(f(f(s * 3) * s) * t)) + f(f(f(s * s) * s) * a.value)) + f(y2 * f(f(f(s * 3) * t) * t))) +
        f(f(f(t * t) * t) * b.value),
    );
  }
  return keys[n - 1].value;
}

/**
 * 一条通道：关键帧加整数帧值缓存（WPE 通道的后 0x18 字节）。第一次要第 i 帧时把缓存扩到 i + 1、补算所有缺的帧（读码第 2 节）。
 * 关键帧运行时不变，缓存永不作废。
 */
export class Channel {
  readonly keys: readonly ParsedKey[];
  private cache: Float32Array;
  /** 已算好的帧数：第 `0 … filled − 1` 帧在缓存里。 */
  private filled = 0;

  /** `capacity` 是预分配的帧数（通常 `length + 1`），不够时按需扩。 */
  constructor(keys: readonly ParsedKey[], capacity = 0) {
    this.keys = keys;
    this.cache = new Float32Array(Math.max(0, Math.trunc(capacity)));
  }

  /** 第 `i` 帧（整数）的值。负帧号不缓存（帧间插值不会要，见 `frameValues`）。 */
  sample(i: number): number {
    if (i < 0) return evaluate(this.keys, i);
    if (i < this.filled) return this.cache[i];
    if (i >= this.cache.length) {
      const grown = new Float32Array(Math.max(i + 1, this.cache.length * 2));
      grown.set(this.cache.subarray(0, this.filled));
      this.cache = grown;
    }
    for (let frame = this.filled; frame <= i; frame++) this.cache[frame] = evaluate(this.keys, frame);
    this.filled = i + 1;
    return this.cache[i];
  }
}

/**
 * 帧间插值（`0x1401723d8`–`0x140172697`，读码第 2 节）：时钟的 `t`、`spf`、`length`（有父的取父的）定出相邻两个整数帧
 * `lo` / `hi` 与权重 `a`，每个通道 `sample(lo) × (1 − a) + sample(hi) × a` 写进 `out[通道下标]`。不分配内存。
 * - `lo` 钳在 `[0, length − 1]`、`hi = min(lo + 1, length)`：第 `length` 帧之后的关键帧永远取不到；
 * - `t < 0` 时 `frac` 为负（`fmodf` 的符号随被除数），值在第 0、1 帧的连线上往外延伸不到一帧（负 `rate`、`setFrame` 负数）。
 */
export function frameValues(clock: ClockView, channels: readonly Channel[], out: Float32Array | number[]): void {
  const { t, spf, length } = clock;
  const frac = f(t % spf);
  const fi = Math.trunc(f(t / spf));
  const m = Math.min(fi, length - 1);
  const lo = m > 0 ? m : 0;
  const hi = Math.min(lo + 1, length);
  const a = f(frac / spf);
  const b = f(1 - a);
  for (let c = 0; c < channels.length; c++) {
    const channel = channels[c];
    out[c] = f(f(channel.sample(lo) * b) + f(channel.sample(hi) * a));
  }
}
