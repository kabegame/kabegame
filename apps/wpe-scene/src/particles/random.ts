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
   * 一个原始 u32（P4j 步骤 3，`layerimage` 的表项下标，rea-p4j-layerimage.md 3.3）：和 `a()` / `b()` 取自**同一个**来源、推进同一串
   * （WPE 也是同一个 MT19937，`FUN_14007d8f0` 与 `uA` 的 `FUN_1401f4bc0` 共用状态）。可选：没实现的随机源（单测手写的）由
   * {@link uniformIndex} 退到 `⌊a()·2³²⌋`。
   */
  u32?(): number;
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
 * 标准 MT19937（C++ `std::mt19937`）：种子 → 每次一个 u32（P4j 步骤 4a）。WPE 的粒子随机数是 MT19937（`rea-p4a.md`「基础」），
 * 把 WPE 侧的种子换成约定值（`wpe-renderdoc` 的 `seed`）后，回放侧用同一个种子的这个生成器就能得到同一串 u32（j0rng 实测）。
 * 初始化是 `mt[i] = 1812433253·(mt[i−1] ^ (mt[i−1] >> 30)) + i`，每 624 个一轮 twist；MSVC 的实现换了缓冲布局、不改输出序列。
 * 自检值（C++ 标准 [rand.predef]）：种子 5489 的第 1 个是 3499211612、第 10000 个是 4123659995。
 * 只给 dev 回放用（`GpuScene` 的 `ParticleOptions.mt19937`、`particleTrack`），产品路径不引用。
 */
export function mt19937(seed: number): Uint32Source {
  const mt = new Uint32Array(624);
  mt[0] = seed >>> 0;
  for (let i = 1; i < 624; i++) {
    const prev = mt[i - 1] ^ (mt[i - 1] >>> 30);
    mt[i] = (Math.imul(1812433253, prev) + i) >>> 0;
  }
  let index = 624;
  const twist = (): void => {
    for (let i = 0; i < 624; i++) {
      const y = (mt[i] & 0x80000000) | (mt[(i + 1) % 624] & 0x7fffffff);
      let v = mt[(i + 397) % 624] ^ (y >>> 1);
      if (y & 1) v ^= 0x9908b0df;
      mt[i] = v >>> 0;
    }
    index = 0;
  };
  return () => {
    if (index >= 624) twist();
    let y = mt[index++];
    y ^= y >>> 11;
    y ^= (y << 7) & 0x9d2c5680;
    y ^= (y << 15) & 0xefc60000;
    y ^= y >>> 18;
    return y >>> 0;
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

/**
 * 注入表（`{ <objects 下标>: [R, …] }`）的键都要是粒子对象的 `objects` 下标（dev 回放，P11b2 走查起）：写成对象 id 或别的下标时
 * 那一项以前静默不起作用、退回种子随机数，要到比像素才发现对不上。有不认识的键就报错，列出场景里的粒子对象。
 */
export function checkInjectedKeys(
  random: Readonly<Record<number, readonly number[]>> | undefined,
  layers: readonly { object: number; name: string; particle?: unknown }[],
): void {
  if (!random) return;
  const particles = layers.filter((layer) => layer.particle);
  const known = new Set(particles.map((layer) => String(layer.object)));
  const unknown = Object.keys(random).filter((key) => !known.has(key));
  if (!unknown.length) return;
  const list = particles.map((layer) => `${layer.object}「${layer.name}」`).join("、") || "没有";
  throw new Error(
    `random 的键 ${unknown.join("、")} 不是粒子对象的 objects 下标（键是 scene.json objects 数组的下标，不是对象 id）；场景里的粒子对象：${list}`,
  );
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

  u32(): number {
    return this.next() >>> 0;
  }

  a(): number {
    return intervalValue(this.next(), LO_A, HI_A);
  }

  b(): number {
    return intervalValue(this.next(), LO_B, HI_B);
  }
}

/**
 * `std::uniform_int_distribution<u32>(0, n − 1)` 在 MSVC 上的取法（rea-p4j-layerimage.md 3.3，`0x140238f0a`–`0x140238f8d`）：Lemire 乘法加拒绝。
 * `m = u32·n`（64 位）；`(m mod 2³²) < n` 时 `t = (2³² − n) mod n`，低 32 位 `< t` 就重抽；结果是 `⌊m / 2³²⌋`。通常取 1 个 u32，`n` 不是 2 的幂时
 * 以 `(2³² mod n)/2³²` 的概率多取。随机源没有 `u32` 时退到 `⌊a()·2³²⌋`（只给单测手写的随机源用，序列本来就不对应 WPE）。
 * 64 位乘法拆成 16 位两半算，不靠 BigInt，高低 32 位都是精确整数。
 */
export function uniformIndex(random: ParticleRandom, n: number): number {
  if (!(n > 0)) return 0;
  const draw = (): number => (random.u32 ? random.u32() >>> 0 : Math.floor(random.a() * 2 ** 32) >>> 0);
  const nl = n % 65536;
  const nh = Math.floor(n / 65536);
  let hi = 0;
  let lo = 0;
  const multiply = (u: number): void => {
    const ul = u % 65536;
    const uh = Math.floor(u / 65536);
    const ll = ul * nl;
    const mid = ul * nh + uh * nl + Math.floor(ll / 65536); // < 2³⁴，精确
    lo = (mid % 65536) * 65536 + (ll % 65536);
    hi = uh * nh + Math.floor(mid / 65536);
  };
  multiply(draw());
  if (lo < n) {
    const t = (2 ** 32 - n) % n;
    while (lo < t) multiply(draw());
  }
  return hi;
}
