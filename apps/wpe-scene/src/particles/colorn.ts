/**
 * `instanceoverride.colorn`（P4b 步骤 6）：HSV 平移与实例颜色。依据 `.claude/plans/wpe-import/3-scene/phase4/rea-p4b-render.md`
 * 7.1（加载期）、7.3（`FUN_14022bd40` 生效判断 → `FUN_1401d15a0` 重算）、7.4（0xc 记录、`0x200000` 的来源是场景 `version`）。
 *
 * 两种作用方式可以同时生效：
 * - **平移：** 每个颜色模块的颜色按「`colorn` 与系统色的 HSV 差」平移（0xb `colorrandom` 的 min、max，0xc `colorchange` 的
 *   startvalue、endvalue，两端各自平移）。
 * - **实例颜色：** 系统标志 `0x200000`（场景 `version` < 5，或没有颜色模块）时，新粒子的颜色初值是 `colorn`，颜色模块再乘到它上面。
 *
 * 运行中改值时从基值重算（记录里保留基色与系统色的 HSV），不在上一次的结果上累加。`brightness`（HDR 时乘实例颜色）不做，
 * 由能力表照报；子系统另要父的生效位（`colornState` 的 `parentActive`，P4e 步骤 1）。
 *
 * 全部按 float32 逐步舍入（WPE 是 `divss` / `mulss` / `subss`），只有 `hsv2rgb` 里两次 `fmod` 是双精度（`cvtss2sd` 后调 CRT
 * `fmod`，再转回 float）。JS 的 `%` 和 C 的 `fmod` 一样按被除数的符号取余、结果精确。
 */
import type { SceneParticle } from "../compile/particles";
import { f32 } from "./f32";

/** 三个分量（float32）。 */
export type Rgb = readonly [number, number, number];

/** `rgb2hsv` 里判「没有饱和度」的阈值（`d < 1e-5`）。 */
const HSV_EPSILON = f32(1e-5);
/** 生效判断里「和系统色几乎相同」的阈值：0.9/255（`0x14022bd7f` 起，三个分量都小于它才算相同）。 */
export const COLORN_NEAR = f32(0.0035294117);
/** 系统 `flags` bit3：禁用 `colorn` 与 `brightness`（rea-p4a.md C3，`0x14022be10`）。 */
const DISABLE_COLORN = 8;

/**
 * `FUN_1401b8b90`（7.3）：全部 float32，除法是 `divss`。
 * ```
 * mx = max(r,g,b); d = mx − min(r,g,b); v = mx
 * d < 1e-5 或 mx ≤ 0：h = 0、s = 0
 * 否则 s = d/mx；h = (r < mx) ? ((g < mx) ? (r−g)/d + 4 : (b−r)/d + 2) : (g−b)/d；h /= 6；h < 0 时 h += 1
 * ```
 */
export function rgb2hsv(color: readonly number[]): [number, number, number] {
  const r = f32(color[0]);
  const g = f32(color[1]);
  const b = f32(color[2]);
  const mx = Math.max(r, g, b);
  const d = f32(mx - Math.min(r, g, b));
  if (d < HSV_EPSILON || mx <= 0) return [0, 0, mx];
  const s = f32(d / mx);
  let h = r < mx ? (g < mx ? f32(f32(f32(r - g) / d) + 4) : f32(f32(f32(b - r) / d) + 2)) : f32(f32(g - b) / d);
  h = f32(h / 6);
  if (h < 0) h = f32(h + 1);
  return [h, s, mx];
}

/**
 * `FUN_1401b8c70`（7.3）：
 * ```
 * C = v·s; H = (float) fmod((double)(h·6), 6.0)
 * X = C·(1 − |fmod((double)H, 2.0) − 1|)   （双精度算，再转 float）
 * m = v − C
 * [0,1):(C,X,0) [1,2):(X,C,0) [2,3):(0,C,X) [3,4):(0,X,C) [4,5):(X,0,C) [5,6):(C,0,X) 其它:(0,0,0)
 * 各分量 + m
 * ```
 */
export function hsv2rgb(h: number, s: number, v: number): [number, number, number] {
  const c = f32(f32(v) * f32(s));
  const hh = f32(f32(f32(h) * 6) % 6);
  // 双精度：C（float 转 double）乘上 double 的 `1 − |fmod(H, 2) − 1|`，最后才转回 float
  const x = f32(c * (1 - Math.abs((hh % 2) - 1)));
  const m = f32(f32(v) - c);
  let rgb: [number, number, number];
  if (hh >= 0 && hh < 1) rgb = [c, x, 0];
  else if (hh >= 1 && hh < 2) rgb = [x, c, 0];
  else if (hh >= 2 && hh < 3) rgb = [0, c, x];
  else if (hh >= 3 && hh < 4) rgb = [0, x, c];
  else if (hh >= 4 && hh < 5) rgb = [x, 0, c];
  else if (hh >= 5 && hh < 6) rgb = [c, 0, x];
  else rgb = [0, 0, 0];
  return [f32(rgb[0] + m), f32(rgb[1] + m), f32(rgb[2] + m)];
}

const clamp01 = (value: number): number => (value < 0 ? 0 : value > 1 ? 1 : value);

/**
 * 平移一个颜色（0xb / 0xc 的 `active` 分支，7.3、7.4 第 3 小节）：把 c 的 HSV 加上 `colorn` 与系统色的 HSV 差。
 * ```
 * (h,s,v) = rgb2hsv(c)
 * h' = (hc − h0) + h;  h' = h' − floor(h')     （roundss 9，取模到 [0, 1)）
 * s' = clamp((sc − s0) + s, 0, 1)
 * v' = clamp((vc − v0) + v, 0, 1)
 * ```
 * `target` 是 `colorn` 的 HSV，`system` 是系统色的 HSV（WPE 存在记录里）。差值先算（`dh = hc − h0`），再加到 c 的分量上。
 */
export function shiftColor(
  color: readonly number[],
  target: readonly number[],
  system: readonly number[],
): [number, number, number] {
  const [h, s, v] = rgb2hsv(color);
  const dh = f32(target[0] - system[0]);
  const ds = f32(target[1] - system[1]);
  const dv = f32(target[2] - system[2]);
  let hue = f32(dh + h);
  hue = f32(hue - Math.floor(hue));
  return hsv2rgb(hue, clamp01(f32(ds + s)), clamp01(f32(dv + v)));
}

/**
 * `%.5f` 往返（7.1）：WPE 把颜色按 `"%.5f %.5f %.5f"` 写回 JSON，再按 float 读回。
 *
 * `toFixed` 按 double 的精确值舍入，正好落在中点（二进制恰好是 x.xxxxx5，即 j/64 这类值）时取较大的一个，MSVC 的 `printf`
 * 可能取偶数，两者差 1e-5。这种值在颜色里几乎不出现，不处理。
 */
export function roundTrip5(value: number): number {
  return f32(Number(f32(value).toFixed(5)));
}

export interface ColornState {
  /** 三条都满足：已设（r ≥ 0）、不是三个分量都和系统色差 < 0.9/255、系统 flags 没有 bit3（7.3）。 */
  active: boolean;
  /**
   * 新粒子 rgb 初值：`0x200000`（`version` < 5 或没有颜色模块）且生效时是 `colorn`，否则 (1, 1, 1)（7.3「实例颜色与亮度」，
   * k = 1，`brightness` 不做）。颜色 initializer 乘在它上面，`colorchange` 每遍再乘到当前色上（7.4 第 4 小节）。
   */
  instanceColor: Rgb;
  /** 生效时平移一个颜色，不生效时原样返回（WPE 把基值写回）。结果都是 float32。 */
  shift(color: readonly number[]): number[];
}

/**
 * `FUN_14022bd40` + `FUN_1401d15a0` 开头（7.3）：从系统色（`def.colorSystem`，加载期从颜色模块推出、已 `%.5f` 往返）与当前
 * `colorn` 算一次。`colorn` 为 null 等同 WPE 的 `−1 −1 −1`（未设）。每次改值都整个重算，不保留上一次的结果。
 * `parentActive`：子系统（P4e 步骤 1，rea-p4e-children 3.4）另要父的生效位（`+0x3f7` bit1）为真；顶层不给（真）。
 */
export function colornState(
  def: Pick<SceneParticle, "colorSystem" | "flags">,
  colorn: readonly number[] | null,
  parentActive = true,
): ColornState {
  const system = def.colorSystem.rgb;
  const value = colorn ? ([f32(colorn[0]), f32(colorn[1]), f32(colorn[2])] as const) : null;
  const near = (i: number) => f32(Math.abs(f32(system[i] - value![i]))) < COLORN_NEAR;
  const active =
    parentActive &&
    value !== null &&
    !(value[0] < 0) &&
    !(near(0) && near(1) && near(2)) &&
    (def.flags & DISABLE_COLORN) === 0;
  const unchanged = (color: readonly number[]) => [f32(color[0]), f32(color[1]), f32(color[2])];
  if (!active) return { active, instanceColor: [1, 1, 1], shift: unchanged };
  const target = rgb2hsv(value);
  const origin = rgb2hsv(system);
  return {
    active,
    instanceColor: def.colorSystem.instanceColor ? value : [1, 1, 1],
    shift: (color) => shiftColor(color, target, origin),
  };
}
