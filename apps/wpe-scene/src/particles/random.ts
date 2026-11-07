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
}

/** 一个 32 位无符号整数的来源。 */
export type Uint32Source = () => number;

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

export class SeededRandom implements ParticleRandom {
  private readonly next: Uint32Source;

  /** 传数字时作种子（mulberry32），也可以传任意 32 位来源（测试用）。 */
  constructor(source: number | Uint32Source = 1) {
    this.next = typeof source === "number" ? mulberry32(source) : source;
  }

  a(): number {
    return intervalValue(this.next(), LO_A, HI_A);
  }

  b(): number {
    return intervalValue(this.next(), LO_B, HI_B);
  }
}
