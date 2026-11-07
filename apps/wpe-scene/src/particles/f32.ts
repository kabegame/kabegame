/**
 * 粒子模拟的 float32 算术（P4a 步骤 3）。WPE 的粒子列、模块记录都是 float32，SIMD 逐步舍入；模拟器每一步运算后都
 * `Math.fround`，否则 `starttime` 的步数、长程累加会和 WPE 差一步（`p4-particles-REPORT.md`「`starttime` 的步数要按 float32 算」）。
 *
 * 近似倒数 `rcpps`（相对误差约 3.7e-4，`rea-p4a.md`「基础」）不复刻，按精确除法算：确定性工程的验收限留了余量。
 */
export const f32 = Math.fround;

/** float32 的 2π（`sphererandom` 的 φ、`oscillateposition` 的 y 偏移）。 */
export const TWO_PI = f32(2 * Math.PI);
export const PI = f32(Math.PI);

/** `min + t·range`，两次舍入（先乘后加）。 */
export function lerp(min: number, range: number, t: number): number {
  return f32(min + f32(t * range));
}

/** 倒数。 */
export function rcp(value: number): number {
  return f32(1 / value);
}

export function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/**
 * 两个 float32 按位或（`alphafade` 的掩码选择在 `in > out`、两段同时命中时的结果，`rea-p4a.md` B「`alphafade`」）。
 * 只在这一处用，所以共用一块暂存。
 */
const scratch = new Float32Array(2);
const bits = new Uint32Array(scratch.buffer);
export function orBits(a: number, b: number): number {
  scratch[0] = a;
  scratch[1] = b;
  bits[0] = bits[0] | bits[1];
  return scratch[0];
}
