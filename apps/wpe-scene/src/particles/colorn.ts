/**
 * `instanceoverride.colorn`（P4b 步骤 6）：HSV 平移与实例颜色。依据 `.claude/plans/wpe-import/3-scene/phase4/rea-p4b-render.md`
 * 7.1（加载期）、7.3（`FUN_14022bd40` 生效判断 → `FUN_1401d15a0` 重算）、7.4（0xc 记录、`0x200000` 的来源是场景 `version`）。
 *
 * 两种作用方式可以同时生效：
 * - **平移：** 每个颜色模块的颜色按「`colorn` 与系统色的 HSV 差」平移（0xb `colorrandom` 的 min、max，0xc `colorchange` 的
 *   startvalue、endvalue，两端各自平移）。P4g 步骤 1 起另有两种记录：0xd `hsvcolorrandom` 把色相区间与 S / V 区间居中到 `colorn`
 *   （`recenterHsvRange`，步长不动），0xe `colorlist` 把 `colorn` 与第一项的 HSV 差当平移（`ColornState.listShift`）。
 * - **实例颜色：** 系统标志 `0x200000`（场景 `version` < 5，或没有颜色模块）时，新粒子的颜色初值是 `colorn`，颜色模块再乘到它上面。
 *
 * 运行中改值时从基值重算（记录里保留基色与系统色的 HSV），不在上一次的结果上累加。子系统另要父的生效位（`colornState` 的
 * `parentActive`，P4e 步骤 1）。HDR 下的 `brightness`（P4f 步骤 2，rea-p4f-script.md 第 7 节）再乘到实例颜色上：`k` 见
 * `instanceBrightness`，乘法在 `ParticleSystem.applyColorn`（`colorn` 之后）。
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

/**
 * `hsvcolorrandom` 的 0xd 记录里参与重算的基值（rea-p4g-color.md 3.2）：`huemin`、有符号区间 `span`（`s ≤ 1` 时是 0）、
 * S / V 各自的 min 与 range。步长、档数不在重算里。
 */
export interface HsvRangeBase {
  huemin: number;
  span: number;
  saturationmin: number;
  saturationrange: number;
  valuemin: number;
  valuerange: number;
}

/**
 * 0xd 重算（`FUN_1401d15a0` case 0xd，rea-p4g-color.md 3.2；全部 float32）：
 * ```
 * 不生效：写回基值
 * 生效（hc, sc, vc = colorn 的 HSV）：
 *   huemin'   = (hc − (span·0.5 + huemin)) + huemin         // 不取模、不钳；span 有符号
 *   smin'     = clamp01((sc − (srange·0.5 + smin)) + smin)
 *   srange'   = (smin' + srange > 1) ? 1 − smin' : srange     // 超出 1 时截短
 *   （V 同 S，用 vc）
 * ```
 * `target` 为 null 表示不生效。`span` 是 0 时（`huesteps ≤ 1`）`huemin' = hc`：实测 `hsv-colorn-fixed` 的粒子色相就是 `colorn` 的色相
 * （P4g 步骤 0b 更正读码的「`span = d == 0 ? 1 : d`」，那条只在 `s > 1` 分支里成立，已在解析时处理）。
 */
export function recenterHsvRange(base: HsvRangeBase, target: readonly number[] | null): HsvRangeBase {
  if (!target) return { ...base };
  const [hc, sc, vc] = target;
  const huemin = f32(f32(hc - f32(f32(base.span * 0.5) + base.huemin)) + base.huemin);
  const center = (min: number, range: number, c: number): [number, number] => {
    const lo = clamp01(f32(f32(c - f32(f32(range * 0.5) + min)) + min));
    return [lo, f32(lo + range) > 1 ? f32(1 - lo) : range];
  };
  const [saturationmin, saturationrange] = center(base.saturationmin, base.saturationrange, sc);
  const [valuemin, valuerange] = center(base.valuemin, base.valuerange, vc);
  return { huemin, span: base.span, saturationmin, saturationrange, valuemin, valuerange };
}

/**
 * `colorlist` 的颜色项解析（rea-p4g-color.md 1.3 第 4 步，`FUN_1401c7bb9`–`0x1401c7db5`）：`s` 是一个字符串项，返回原值的三个分量
 * （不 ÷255、不钳制），丢掉时返回 null。
 * ```
 * 空串：(0, 0, 0)
 * a = atof(从 p)；在 p 之后找空格，找不到丢掉；p 落在该空格上，跳过连续空格；b = atof(从 p)；再找空格，找不到丢掉；跳过空格；c = atof(从 p)
 * ```
 * 所以 `"a b "` 是 (a, b, 0)，`"a "` 丢掉；只认空格（0x20）；第四个及以后的数忽略。`atof` 遇到非数字得 0。
 * 「在 p 之后找空格」从当前数的起点找：前导空格会让第一次找到的空格落在第一个数之前【推：读码是 `strchr` 的写法，没有单独测前导空格的串】。
 */
export function parseColorItem(s: string): [number, number, number] | null {
  if (s === "") return [0, 0, 0];
  const atof = (from: number): number => {
    const m = /^[ \t\n\v\f\r]*[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(s.slice(from));
    return m ? Number(m[0]) : 0;
  };
  const skipSpaces = (from: number): number => {
    let p = from;
    while (s[p] === " ") p++;
    return p;
  };
  const a = atof(0);
  let q = s.indexOf(" ", 0);
  if (q < 0) return null;
  let p = skipSpaces(q);
  const b = atof(p);
  q = s.indexOf(" ", p);
  if (q < 0) return null;
  p = skipSpaces(q);
  return [a, b, atof(p)];
}

/**
 * `colorlist` 的 `colors` 取值 → 有效项的 RGB 原值（按顺序，float32）。三种形状：
 * - 数组：逐项，只认字符串项，`parseColorItem` 切不出三个数的整项丢掉；
 * - 字符串：当作只有这一项的列表【推：实测 `colors` 缺键时粒子是白色——缺省值字符串 `"1 1 1"` 被当成一项白色；读码说非数组就跳过循环，
 *   和实测不符，这里让「缺省字符串」与「显式写同一个字符串」走同一条路】；
 * - 缺键：同缺省字符串 `"1 1 1"`（`missing`）；其它形状（数字、对象）：空列表（调用方在解析处按不支持报）。
 */
export function colorListRgb(raw: unknown, missing = false): [number, number, number][] {
  const items = missing ? ["1 1 1"] : Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
  const out: [number, number, number][] = [];
  for (const item of items) {
    if (typeof item !== "string") continue;
    const rgb = parseColorItem(item);
    if (rgb) out.push([f32(rgb[0]), f32(rgb[1]), f32(rgb[2])]);
  }
  return out;
}

/**
 * 出生时的 HSV 列表（扁平 `h, s, v, h, s, v, …`）：每项 `rgb2hsv`（分量大于 1 时 `v > 1`，出生时 V 钳到 [0, 1] 所以等效 `v = 1`）；
 * 没有有效项时补一项 HSV (0, 1, 1)（纯红，1.3 第 6 条）。系统色与这一步不同：没有有效项时不改系统色（`particleColorSystem`）。
 */
export function colorListHsv(rgb: readonly (readonly number[])[]): number[] {
  if (!rgb.length) return [0, 1, 1];
  return rgb.flatMap((color) => rgb2hsv(color));
}

export interface ColornState {
  /** 三条都满足：已设（r ≥ 0）、不是三个分量都和系统色差 < 0.9/255、系统 flags 没有 bit3（7.3）。 */
  active: boolean;
  /**
   * 生效时 `colorn` 的 HSV（`hc, sc, vc`），否则 null：0xd 记录把 `hsvcolorrandom` 的区间居中到它（`recenterHsvRange`），0xe 记录用它
   * 减第一项的 HSV 当平移（`listShift`）。
   */
  target: readonly [number, number, number] | null;
  /**
   * 0xe（`colorlist`）的平移：生效时 `(hc − h0, sc − s0, vc − v0)`，`(h0, s0, v0)` 是记录里第一项的 HSV（不是系统色的 HSV，二者
   * 通常相同；列表没有有效项时 `h0` 是补出的红色而系统色是别的模块的，rea-p4g-color.md 3.3）；不生效写 (0, 0, 0)。
   */
  listShift(first: readonly number[]): [number, number, number];
  /**
   * 新粒子 rgb 初值里 `colorn` 的那一项：`0x200000`（`version` < 5 或没有颜色模块）且生效时是 `colorn`，否则 (1, 1, 1)（7.3「实例
   * 颜色与亮度」）。这里不乘 `k`：HDR 下的 `brightness` 由 `ParticleSystem.applyColorn` 再逐通道乘上（`instanceBrightness`）。颜色
   * initializer 乘在最终的初值上面，`colorchange` 每遍再乘到当前色上（7.4 第 4 小节）。
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
  if (!active) return { active, target: null, listShift: () => [0, 0, 0], instanceColor: [1, 1, 1], shift: unchanged };
  const target = rgb2hsv(value);
  const origin = rgb2hsv(system);
  return {
    active,
    target: [target[0], target[1], target[2]],
    listShift: (first) => [f32(target[0] - first[0]), f32(target[1] - first[1]), f32(target[2] - first[2])],
    instanceColor: def.colorSystem.instanceColor ? value : [1, 1, 1],
    shift: (color) => shiftColor(color, target, origin),
  };
}

/**
 * HDR 下 `instanceoverride.brightness` 的乘数 `k`（P4f 步骤 2，rea-p4f-script.md 第 7 节，`FUN_1401d15a0` 开头
 * `0x1401d15ec`–`0x1401d1609`）：
 * ```
 * k = (HDR 位 && !(sys.flags & 8)) ? io.brightness : 1.0
 * instColor = (colorn 生效 && 0x200000) ? colorn·k : (k, k, k)      // mulss，逐通道 float32，不钳制
 * alpha 初值 = io.alpha                                              // 不乘 k
 * ```
 * HDR 位只在加载时判定（P3 K3），即编译期写进系统定义的 `def.hdr`；`flags & 8` 看本系统自己的（子系统、事件实例各看各的），值是对象上的
 * `brightness`（子孙从根取）。实测 `p4f-bright`：超高档 0.5 / 2 得 0.235 / 0.941，`colorn` (0.25, 1, 0.25) 乘 2 得 (0.5, 2, 0.5)，
 * `flags 8` 与关闭档不变。
 */
export function instanceBrightness(def: Pick<SceneParticle, "hdr" | "flags">, brightness: number): number {
  return def.hdr && (def.flags & DISABLE_COLORN) === 0 ? f32(brightness) : 1;
}
