/**
 * 粒子模块用的三个噪声函数（P4b 步骤 4），照 WPE 2.8.42 逐位移植，不用开源实现：结构来自 Gustavson 的 simplex，但二维的
 * 梯度选择、三维的单形顶点顺序（坐标相等时）和第 4 个角的哈希都和原版不同。依据
 * `.claude/plans/wpe-import/3-scene/phase4/rea-p4b-modules.md` C1–C3（读码【确】），汇编原件在 `ignore/p4/rea/p4b-mod/`
 * （`noise3_sse4.asm`）与 `ignore/p4/rea/wp.asm`（`0x14027b090`、`0x14027b170`）。
 *
 * P4d 步骤 4b 另加 `fbm1`（`snoise1` 的分形和，`remapinitialvalue` 的 `fbmnoise`）；`remapvalue` 的噪声是 FastNoise2，在 `fastnoise2.ts`。
 *
 * 全部是 float32 进、float32 出，每一步 `Math.fround`；加法、乘法的结合顺序照汇编（`a·b + c` 是 `mulss` 再 `addss`，没有 FMA）。
 * 常量表与标量常量在 `noiseTables.ts`（由 `noise-tables.json` 生成）。
 */
import { f32 } from "./f32";
import {
  F2,
  F3,
  G2,
  G2_CORNER2,
  G3,
  G3_CORNER3,
  GRAD_X,
  GRAD_Y,
  GRAD_Z,
  MINUS_TWO,
  ONE,
  PERM,
  PERM512,
  PERM_MOD12,
  SNOISE1_SCALE,
  SNOISE2_RADIUS,
  SNOISE2_SCALE,
  SNOISE3_RADIUS,
  SNOISE3_SCALE,
  TWO_G3,
} from "./noiseTables";

/** `cvttss2si` 越界（NaN、`|x| ≥ 2³¹`）时的结果 `0x80000000`。 */
const INT_INDEFINITE = -2147483648;

/** `cvttss2si`：向零截断成 int32；越界得 `0x80000000`。 */
function truncToInt(x: number): number {
  return x > -2147483649 && x < 2147483648 ? Math.trunc(x) : INT_INDEFINITE;
}

/**
 * C1、C2 的取整：截断再修正（`cvttss2si`，`cvtsi2ss` 转回 float 后 `comiss`，大于 `x` 时减 1，`cmovbe`）。NaN 走
 * 「不大于」分支，得 `0x80000000`。减 1 是 32 位整数运算（`lea ecx, [rax − 1]`）。
 */
function floorTrunc(x: number): number {
  const i = truncToInt(x);
  return f32(i) > x ? (i - 1) | 0 : i;
}

/**
 * C3 的取整：`roundps` 向下取整再 `cvtps2dq`（越界同样得 `0x80000000`）。
 */
function floorRound(x: number): number {
  return truncToInt(Math.floor(x));
}

/** 四次方：`t2 = t·t`、`t4 = t2·t2`（两次 `mulss`）。 */
function pow4(t: number): number {
  const t2 = f32(t * t);
  return f32(t2 * t2);
}

/**
 * C1，`FUN_14027b090`：Gustavson `SimplexNoise1234::noise1`，系数 0.395（`0x3eca3d71`），没有半径截断（`t` 恒为非负）。
 * `turbulentvelocityrandom` 用。梯度 `g = (h & 7) + 1`，`h & 8` 时取负；整数输入时为 0。
 * ```
 * i0 = floorTrunc(x);  x0 = x − f32(i0);  x1 = x0 − 1
 * n0 = (g(perm[i0 & 255])·x0)·(1 − x0²)⁴;  n1 = (g(perm[(i0 + 1) & 255])·x1)·(1 − x1²)⁴
 * return (n1 + n0)·0.395
 * ```
 */
export function snoise1(x: number): number {
  const i0 = floorTrunc(x);
  const x0 = f32(x - f32(i0));
  const x1 = f32(x0 - ONE);
  const n0 = f32(f32(grad1(PERM[i0 & 255]) * x0) * pow4(f32(ONE - f32(x0 * x0))));
  const n1 = f32(f32(grad1(PERM[(i0 + 1) & 255]) * x1) * pow4(f32(ONE - f32(x1 * x1))));
  return f32(f32(n1 + n0) * SNOISE1_SCALE);
}

/**
 * `snoise1` 的分形和，`FUN_14027b4b0`（P4d 步骤 4b，`remapinitialvalue` 的 `fbmnoise`，rea-p4d-modules.md 2.5；汇编在
 * `ignore/p4/rea/wp.asm`）。调用方传 `{频率 s, 振幅 1, 倍频 2, 增益 0.5}`（`FUN_14005f580` 建的结构，`xmm8 = 1`、`xmm7 = 2` 是
 * initializer 段常驻的常量）与 `octaves`（`transformoctaves`，无符号），循环体内联了 C1（同一张置换表 `0x140484f40`、同样的运算顺序）：
 * ```
 * sum = 0; total = 0; f = s; a = 1
 * 共 octaves 次（octaves = 0 时一次都不跑，0/0 得 NaN）:
 *     n = snoise1(f·v);  total = total + a;  f = f·2;  sum = sum + n·a;  a = a·0.5
 * return sum / total                                  // divss
 * ```
 * 和 FastNoise2 的 FBm（`fastnoise2.ts`）不同：没有种子，归一除的是实际累加的振幅和。两种提前停下和走完逐位相同（不计零的符号）：
 * `sum` 成了 NaN 之后一直是 NaN；`a` 下溢成 0 且 `f` 是 0（`s = 0`）时之后每层只加 ±0。`f` 非零时每层翻倍，至多约 280 层就溢出、
 * `n` 不再有限，`sum` 随之成 NaN，所以 `octaves` 很大时循环次数也有界。
 */
export function fbm1(v: number, frequency: number, octaves: number): number {
  let sum = 0;
  let total = 0;
  let f = frequency;
  let a = 1;
  for (let i = 0; i < octaves; i++) {
    const n = snoise1(f32(f * v));
    total = f32(total + a);
    f = f32(f * 2);
    sum = f32(sum + f32(n * a));
    a = f32(a * 0.5);
    if (Number.isNaN(sum)) break;
    if (a === 0 && f === 0) break;
  }
  return f32(sum / total);
}

/** `snoise1` 的梯度：`f32(h & 7) + 1`，`h & 8` 时翻符号（`xorps` 符号位）。 */
function grad1(h: number): number {
  const g = (h & 7) + 1;
  return h & 8 ? -g : g;
}

/**
 * C2 的梯度（`0x14027b300` 起）：`(h & 0x3c) == 0` 时 `(u, v) = (x, y)`，否则 `(y, x)`——**原版是 `(h & 7) < 4`**；
 * `h & 1` 时 `u` 取负；`h & 2` 时 `v·(−2)`，否则 `v + v`；返回 `v + u`。
 */
export function grad2(h: number, x: number, y: number): number {
  let u: number;
  let v: number;
  if ((h & 0x3c) === 0) {
    u = x;
    v = y;
  } else {
    u = y;
    v = x;
  }
  if (h & 1) u = -u;
  v = h & 2 ? f32(v * MINUS_TWO) : f32(v + v);
  return f32(v + u);
}

/**
 * 二维单形的一个角（C2）：`t = (0.5 − x²) − y²`，`t < 0` 时为 0（`comiss 0, t`；`t` 为 NaN 时照常算），否则
 * `grad·t⁴`（`t⁴` 是两次平方）。
 */
function corner2(h: number, x: number, y: number): number {
  const t = f32(f32(SNOISE2_RADIUS - f32(x * x)) - f32(y * y));
  return t < 0 ? 0 : f32(grad2(h, x, y) * pow4(t));
}

/**
 * C2，`FUN_14027b170`：结构同 `SimplexNoise1234::noise2`，梯度条件是 `(h & 0x3c) == 0`（`grad2`），输出 ×45.23065
 * （`0x4234ec30`）。`positionoffsetrandom` 用。
 * ```
 * s = (x + y)·F2;  i = floorTrunc(x + s);  j = floorTrunc(y + s)
 * t = f32(i + j)·G2                                 // 整数先加
 * x0 = x − (f32(i) − t);  y0 = y − (f32(j) − t)
 * i1 = x0 > y0;  j1 = 1 − i1
 * x1 = (x0 − i1) + G2;  y1 = (y0 − j1) + G2;  x2 = (x0 − 1) + C2;  y2 = (y0 − 1) + C2   // C2 = 0x3ed8658c
 * 哈希按 u8 回绕：perm[ii + perm[jj]]、perm[ii + i1 + perm[jj + j1]]、perm[ii + 1 + perm[jj + 1]]
 * return ((n1 + n0) + n2)·45.23065
 * ```
 */
export function snoise2(x: number, y: number): number {
  const s = f32(f32(x + y) * F2);
  const i = floorTrunc(f32(x + s));
  const j = floorTrunc(f32(y + s));
  const t = f32(f32((i + j) | 0) * G2);
  const x0 = f32(x - f32(f32(i) - t));
  const y0 = f32(y - f32(f32(j) - t));
  // `comiss x0, y0`：`seta` 得 i1，`setbe` 得 j1（NaN 时 i1 = 0、j1 = 1）
  const i1 = x0 > y0 ? 1 : 0;
  const j1 = 1 - i1;
  const x1 = f32(f32(x0 - i1) + G2);
  const y1 = f32(f32(y0 - j1) + G2);
  const x2 = f32(f32(x0 - ONE) + G2_CORNER2);
  const y2 = f32(f32(y0 - ONE) + G2_CORNER2);
  const ii = i & 255;
  const jj = j & 255;
  const n0 = corner2(PERM[(ii + PERM[jj]) & 255], x0, y0);
  const n1 = corner2(PERM[(ii + i1 + PERM[(jj + j1) & 255]) & 255], x1, y1);
  const n2 = corner2(PERM[(ii + 1 + PERM[(jj + 1) & 255]) & 255], x2, y2);
  return f32(f32(f32(n1 + n0) + n2) * SNOISE2_SCALE);
}

/**
 * 三维单形的一个角（C3）：`t = ((0.6 − x²) − y²) − z²`，`t < 0` 时为 0（`cmpltps` + `blendvps`），否则
 * `((gz·z + gy·y) + gx·x)·t⁴`。
 */
function corner3(g: number, x: number, y: number, z: number): number {
  const t = f32(f32(f32(SNOISE3_RADIUS - f32(x * x)) - f32(y * y)) - f32(z * z));
  if (t < 0) return 0;
  const dot = f32(f32(f32(GRAD_Z[g] * z) + f32(GRAD_Y[g] * y)) + f32(GRAD_X[g] * x));
  return f32(dot * pow4(t));
}

/**
 * C3，`FUN_1400fd010`（SSE4.1 版，`turbulence` 经虚表 `0x140488440` 槽 2 调用，一次 4 个通道、各通道独立，这里是一个通道）：
 * Gustavson 2012 的三维 simplex，半径 0.6、×32。和原版不同的两处照抄：
 * - **单形顶点顺序**（坐标相等时）：`i1 = y0 ≤ x0 ∧ z0 ≤ x0`、`j1 = x0 < y0 ∧ z0 < y0`、`k1 = x0 < z0 ∧ y0 < z0`；
 *   `i2 = i1 ∨ (x0 < y0 ∧ z0 ≤ x0) ∨ (x0 < z0 ∧ y0 ≤ x0)`，`j2 = j1 ∨ (y0 < z0 ∧ x0 < y0) ∨ (z0 ≤ y0 ∧ y0 ≤ x0)`，
 *   `k2 = k1 ∨ (z0 ≤ y0 ∧ x0 < z0) ∨ (y0 < z0 ∧ z0 ≤ x0)`。`x0 < y0 = z0` 时 `i1 = j1 = k1 = 0`，原版给 `j1 = 1`；
 * - **第 4 个角的哈希** `gi3 = permMod12[ii + 1 + perm[jj + 1 + perm[kk]]]`（复用 `perm[kk] + jj`），原版是 `perm[kk + 1]`。
 *
 * 取整是向下取整（`roundps` 模式 1）；`t = f32(k + j + i)·G3` 整数先加；最后 `(((n3 + n2) + n1) + n0)·32`。
 * 下标最大 511，表都是 512 项，不再取模。
 */
export function snoise3(a: number, b: number, c: number): number {
  const s = f32(f32(f32(b + c) + a) * F3);
  const i = floorRound(f32(a + s));
  const j = floorRound(f32(b + s));
  const k = floorRound(f32(c + s));
  const t = f32(f32((((k + j) | 0) + i) | 0) * G3);
  const x0 = f32(a - f32(f32(i) - t));
  const y0 = f32(b - f32(f32(j) - t));
  const z0 = f32(c - f32(f32(k) - t));
  const i1 = y0 <= x0 && z0 <= x0 ? 1 : 0;
  const j1 = x0 < y0 && z0 < y0 ? 1 : 0;
  const k1 = x0 < z0 && y0 < z0 ? 1 : 0;
  const i2 = i1 || (x0 < y0 && z0 <= x0) || (x0 < z0 && y0 <= x0) ? 1 : 0;
  const j2 = j1 || (y0 < z0 && x0 < y0) || (z0 <= y0 && y0 <= x0) ? 1 : 0;
  const k2 = k1 || (z0 <= y0 && x0 < z0) || (y0 < z0 && z0 <= x0) ? 1 : 0;
  const ii = i & 255;
  const jj = j & 255;
  const kk = k & 255;
  const gi0 = PERM_MOD12[ii + PERM512[jj + PERM512[kk]]];
  const gi1 = PERM_MOD12[ii + i1 + PERM512[jj + j1 + PERM512[kk + k1]]];
  const gi2 = PERM_MOD12[ii + i2 + PERM512[jj + j2 + PERM512[kk + k2]]];
  const gi3 = PERM_MOD12[ii + 1 + PERM512[jj + 1 + PERM512[kk]]];
  const n0 = corner3(gi0, x0, y0, z0);
  const n1 = corner3(gi1, f32(f32(x0 - i1) + G3), f32(f32(y0 - j1) + G3), f32(f32(z0 - k1) + G3));
  const n2 = corner3(gi2, f32(f32(x0 - i2) + TWO_G3), f32(f32(y0 - j2) + TWO_G3), f32(f32(z0 - k2) + TWO_G3));
  const n3 = corner3(
    gi3,
    f32(f32(x0 - ONE) + G3_CORNER3),
    f32(f32(y0 - ONE) + G3_CORNER3),
    f32(f32(z0 - ONE) + G3_CORNER3),
  );
  return f32(f32(f32(f32(n3 + n2) + n1) + n0) * SNOISE3_SCALE);
}
