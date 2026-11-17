/**
 * 粒子随机数（P4a 步骤 3）。
 *
 * WPE 用 MT19937、按时间做种（`rea-p4a.md`「基础」），序列本来就不可复现，所以这里不复刻 MT19937，只用可设种子的
 * 32 位生成器，保持两点：
 * - 两个区间：A `[0, 1)`（`ctx+0x20/24`）、B `[1e-5, 1)`（`ctx+0x28/2c`），各模块用哪个区间照读码；
 * - 取值公式 `(u32 >> 8)·2⁻²⁴·(hi − lo) + lo`：24 位尾数，float32 运算。
 *
 * 抽取顺序由调用方决定（`emitters.ts`、`initializers.ts` 照读码的顺序抽）。
 */
import { f32 } from "./f32";

export interface ParticleRandom {
  /** A 区间 `[0, 1)`。 */
  a(): number;
  /** B 区间 `[1e-5, 1)`。 */
  b(): number;
  /**
   * 色相分档的独立随机源（P4g 步骤 1，`hsvcolorrandom`，rea-p4g-color.md 2.1 / 2.4）：返回 MSVC CRT `rand()` 的值，整数 0..32767。
   * WPE 的 `rand()` 是每条场景渲染线程一个、种子取 QPC 的 LCG，和粒子的 MT19937（`a` / `b`）不是同一个流，所以这里**不占 `R` 的流**：
   * 抽它不会推动 `a()` / `b()` 的序列。可选：不实现的随机源（单测里手写的）由 `hueRandOf` 退到全局的缺省源。
   */
  hueRand?(): number;
}

/** 一个 32 位无符号整数的来源。 */
export type Uint32Source = () => number;

/** 色相分档来源：每次返回一个 CRT `rand()` 的值（整数 0..32767）。 */
export type HueSource = () => number;

/**
 * 缺省的色相分档来源：固定种子的 mulberry32 取高 15 位（和 CRT `rand()` 同一个值域）。WPE 的序列不可复刻（种子是 QPC），这里只保证
 * 「每次 0..32767 近似均匀」；没有 `hueRand` 的随机源（单测手写的）退到它，所以它是全进程共用、顺序依赖调用次序，只在不关心档位时用。
 */
const FALLBACK_HUE_SEED = 0x9e3779b9;
let fallbackHue: HueSource = hueFromSeed(FALLBACK_HUE_SEED);

/** 取一个随机源的色相分档值：实现了 `hueRand` 用它，否则退到全局缺省源。 */
export function hueRandOf(random: ParticleRandom): number {
  return random.hueRand ? random.hueRand() : fallbackHue();
}

/** 重置全局缺省色相源（单测用，让没有 `hueRand` 的随机源也可复现）；可传种子或来源。 */
export function resetFallbackHue(source: number | HueSource = FALLBACK_HUE_SEED): void {
  fallbackHue = typeof source === "number" ? hueFromSeed(source) : source;
}

/** 种子 → 色相分档来源（mulberry32 的高 15 位）。 */
export function hueFromSeed(seed: number): HueSource {
  const next = mulberry32(seed);
  return () => next() >>> 17;
}

/**
 * 按调用顺序顶替色相分档（dev 探针 / 回放用）：第 k 次调用取 `values[k]`（CRT `rand()` 的值，整数 0..32767，超出范围按 `& 0x7fff`），
 * 用完退回 `fallback`。每次调用得到一个从头计数的新来源。用法：`random.hue = injectedHue([0, 32767, 16384], hueFromSeed(1))`，
 * 或 `new SeededRandom(seed, injectedHue(...))`。想固定档位用 `fixedHue(r)`：`r` 与档数 `s`（`huesteps`）的对应是
 * `k = min(trunc(r/32767·(s+1)), s)`。
 */
export function injectedHue(values: readonly number[], fallback: HueSource = hueFromSeed(1)): HueSource {
  let next = 0;
  return () => (next < values.length ? values[next++] & 0x7fff : fallback());
}

/** 每次都返回同一个 CRT `rand()` 值（固定档位）。 */
export function fixedHue(value: number): HueSource {
  return () => value & 0x7fff;
}

const LO_A = 0;
const HI_A = 1;
const LO_B = f32(1e-5);
const HI_B = 1;
const UNIT = 2 ** -24;

/** `(u32 >> 8)·2⁻²⁴·(hi − lo) + lo`，float32：先乘范围再加下限，各舍入一次。 */
export function intervalValue(u32: number, lo: number, hi: number): number {
  const unit = (u32 >>> 8) * UNIT; // 24 位整数乘 2 的幂，float32 下精确
  return f32(f32(unit * f32(hi - lo)) + lo);
}

/** mulberry32：种子相同则序列相同。 */
export function mulberry32(seed: number): Uint32Source {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };
}

/**
 * 出生时 `R` 的替换（`ParticleSystem` 的可选参数）：参数是这次照常抽到的值，返回写进 `R` 列的值。只给 dev 探针与回放工具用，
 * 产品路径不传。
 */
export type ParticleROverride = (drawn: number) => number;

/**
 * 按出生顺序顶替 `R`：第 k 个出生的粒子取 `values[k]`（按 float32），用完退回照常抽到的值（P4b 步骤 2 的探针：`randomframe`
 * 的 frame 就是 `R`，从 WPE 轨迹读出来注入后和 WPE 逐像素比）。每次调用得到一个从头计数的新替换。
 */
export function injectedR(values: readonly number[]): ParticleROverride {
  let next = 0;
  return (drawn) => (next < values.length ? f32(values[next++]) : drawn);
}

export class SeededRandom implements ParticleRandom {
  private readonly next: Uint32Source;
  /**
   * 色相分档来源（`hueRand`）。公开可写：构造后随时换（`random.hue = injectedHue([...])`），探针 / 回放注入档位用。缺省是自己的一条
   * 流（种子由 `source` 的种子推出，`source` 是函数时固定），和 `a()` / `b()` 的流互不影响。
   */
  hue: HueSource;

  /**
   * 传数字时作种子（mulberry32），也可以传任意 32 位来源（测试用）。`hue` 是色相分档来源（`HueSource`）或种子，缺省按 `source` 推出。
   */
  constructor(source: number | Uint32Source = 1, hue?: number | HueSource) {
    this.next = typeof source === "number" ? mulberry32(source) : source;
    this.hue =
      typeof hue === "function"
        ? hue
        : hueFromSeed(hue ?? (typeof source === "number" ? (source ^ FALLBACK_HUE_SEED) >>> 0 : FALLBACK_HUE_SEED));
  }

  hueRand(): number {
    return this.hue();
  }

  a(): number {
    return intervalValue(this.next(), LO_A, HI_A);
  }

  b(): number {
    return intervalValue(this.next(), LO_B, HI_B);
  }
}
