/**
 * 粒子模拟的 float32 算术（P4a 步骤 3）。WPE 的粒子列、模块记录都是 float32，SIMD 逐步舍入；模拟器每一步运算后都
 * `Math.fround`，否则 `starttime` 的步数、长程累加会和 WPE 差一步（`p4-particles-REPORT.md`「`starttime` 的步数要按 float32 算」）。
 *
 * 近似倒数 `rcpps`、近似平方根倒数 `rsqrtps`（相对误差约 3.7e-4，`rea-p4a.md`「基础」）不复刻，按精确值算：确定性工程的
 * 验收限留了余量。两者各有一个函数（`rcp`、`rsqrt`），只在 WPE 用近似指令的位置调用。
 */
export const f32 = Math.fround;

/** float32 的 2π（`sphererandom` 的 φ、`oscillateposition` 的 y 偏移）。 */
export const TWO_PI = f32(2 * Math.PI);
export const PI = f32(Math.PI);

/** `min + t·range`，两次舍入（先乘后加）。 */
export function lerp(min: number, range: number, t: number): number {
  return f32(min + f32(t * range));
}

/** 倒数。只用在 WPE 用 `rcpps` 的位置（按精确倒数算，见文件头）。 */
export function rcp(value: number): number {
  return f32(1 / value);
}

/**
 * 平方根倒数。只用在 WPE 用 `rsqrtps` 的位置（`vortex` 的径向单位向量、`capvelocity` 的截速比例，`rea-p4b-modules.md` B7、
 * B8）：近似值随 CPU 厂商不同，不复刻，按精确值算（P4b 总体设计「近似倒数不复刻」，验收按相对 3.7e-4 放宽）。
 */
export function rsqrt(value: number): number {
  return f32(1 / Math.sqrt(value));
}

/**
 * `M·v`（3×3 乘向量，P4c 步骤 1），`basis[c * 3 + r]` 是第 c 列第 r 个分量（`particles/controlpoints.ts` 的 `ControlPoint`）。
 * 三个分量都是 `(v.x·M0j + v.y·M1j) + v.z·M2j`，逐步 float32。WPE 里有三处，按汇编核对过（float 加法可交换，三种写法逐位相同）：
 * - `FUN_140184440`（`velocityrandom`、`turbulentvelocityrandom` 乘发射器的 `M`）：`x = (v.y·m10 + v.x·m00) + v.z·m20`，
 *   `y`、`z` 是 `(v.x·m0j + v.y·m1j) + v.z·m2j`（`0x140184440`–`0x1401844b6`）；
 * - `boxrandom` 旋转出生点与回退方向：`X = (qx·M00 + qy·M10) + qz·M20`、`Y = (qy·M11 + qx·M01) + qz·M21`、
 *   `Z = (qx·M02 + qy·M12) + qz·M22`（`0x14023890d`–`0x140238963`、回退 `0x140238a9c`–`0x140238af0`）；
 * - `sphererandom` 用 4 宽 SIMD：`(t·q.w + M2·q.z) + (q.y·M1 + M0·q.x)`（`0x140237f29`–`0x140237f60`、回退
 *   `0x14023809b`–`0x1402380d2`），`q.w` 是 ±0，`t` 有限时 `t·q.w` 是 ±0、不改变结果（`t` 为 inf 时 WPE 得 NaN，这里不复刻）。
 */
export function mulBasis(basis: ArrayLike<number>, v: readonly number[]): [number, number, number] {
  const [x, y, z] = v;
  return [
    f32(f32(f32(x * basis[0]) + f32(y * basis[3])) + f32(z * basis[6])),
    f32(f32(f32(x * basis[1]) + f32(y * basis[4])) + f32(z * basis[7])),
    f32(f32(f32(x * basis[2]) + f32(y * basis[5])) + f32(z * basis[8])),
  ];
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
