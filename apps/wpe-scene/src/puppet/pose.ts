/**
 * puppet 姿势（P12a 步骤 2 点 1）：帧号、淡入淡出、采样、三种混合、父链与蒙皮矩阵。纯 TS，不依赖 GPU 与编译管线。
 *
 * 依据：`.claude/plans/wpe-import/3-scene/phase12/rea-p12-runtime.md` 第 3–7 节与「对实现的含义」（读码），
 * `p12-REPORT.md` 第一部分用例 1–3（实测），参考实现 `ignore/p12/rea/runtime/posemodel.py`。
 *
 * 姿势按骨骼排，每骨骼 `POSE_STRIDE` = 10 个 f32：平移 xyz、四元数 w x y z、缩放 xyz（WPE 是 SoA 的 10 个平面，`N4` 对齐，rea-RT
 * 「结构的叫法」；这里改成按骨骼连续存，只是排法不同，每个数的算法与运算顺序不变）。动画帧数据同样排法：第 f 帧第 b 根骨骼在
 * `(f × 骨骼数 + b) × 10`（编译期 `compile/puppet.ts` 转好）。
 */
import { mulAffine, nrRsqrt, signBit, trsMatrix } from "./math";

const f = Math.fround;

/** 每骨骼的姿势分量数：T(3) q(4) S(3)。 */
export const POSE_STRIDE = 10;

/** `FLT_EPSILON`（`0x1404925e0`）：淡入淡出时长的下限（rea-RT 5.1）。 */
const FLT_EPSILON = 2 ** -23;

/** 动画层标志（WPE `AL+0xd0`，rea-RT 1.5）：visible bit0、additive bit1、blendin bit2、blendout bit3。 */
export const LAYER_VISIBLE = 1;
export const LAYER_ADDITIVE = 2;
export const LAYER_BLENDIN = 4;
export const LAYER_BLENDOUT = 8;

/** 线性插值的分量（平移、缩放）在每骨骼 10 个数里的位置。 */
const LINEAR = [0, 1, 2, 7, 8, 9] as const;

/** 时钟模式位 single（同 `animation/clock.ts` 的 `SINGLE`，淡入淡出只看它）。 */
const SINGLE = 2;

/** 相邻两个整数帧与帧间权重。 */
export interface FrameIndex {
  lo: number;
  hi: number;
  frac: number;
}

/**
 * 帧号（`FUN_140170580`，rea-RT 3.1；P10 的 `curve.ts` `frameValues` 内联的同一套）：`frac = fmodf(t, spf) / spf`，
 * `lo = clamp(trunc(t / spf), 0, length − 1)`、`hi = min(lo + 1, length)`。帧号是 `t / spf`，不是 `t × fps`；循环回绕处第 length 帧到
 * 第 0 帧不插值（时钟回绕后直接落在第 0 帧附近）。写 `out` 并返回它。
 */
export function frameIndex(clock: { t: number; spf: number }, length: number, out: FrameIndex): FrameIndex {
  const { t, spf } = clock;
  const m = Math.min(Math.trunc(f(t / spf)), length - 1);
  out.lo = m > 0 ? m : 0;
  out.hi = Math.min(out.lo + 1, length);
  out.frac = f(f(t % spf) / spf);
  return out;
}

/**
 * 一层的权重（`FUN_14026c8b0`，rea-RT 5.1；p12-REPORT 用例 2 逐位成立）：`w = blend × 淡入 × 淡出`，用推进之后的 `t`、`D`。
 * - 淡入（blendin 位）：时长 `min(D/2, blendtime)` 秒、线性，`min(D, blendtime) ≤ FLT_EPSILON` 时为 1；非 single 第一次到 1 后**永久清掉**
 *   blendin 位（隐藏再显示不再淡入），所以会改 `layer.flags`；
 * - 淡出（blendout 位，加载时非 single 已清掉）：`(D − t) / min(D/2, blendtime)`，大于 1 时不乘；single 播完（`t = D`）后恒 0。
 * 不钳 `blend`，负数照用。
 */
export function layerWeight(
  layer: { flags: number; blendtime: number },
  clock: { t: number; D: number; flags: number },
  blend: number,
): number {
  let w = f(blend);
  const { t, D } = clock;
  const blendtime = f(layer.blendtime);
  if (layer.flags & LAYER_BLENDIN) {
    let k = 1;
    if (Math.min(D, blendtime) > FLT_EPSILON) {
      k = f(t / Math.min(f(D * 0.5), blendtime));
      if (!(k <= 1)) k = 1;
    }
    w = f(k * w);
    if (!(clock.flags & SINGLE) && k >= 1) layer.flags &= ~LAYER_BLENDIN;
  }
  if (layer.flags & LAYER_BLENDOUT && Math.min(D, blendtime) > FLT_EPSILON) {
    const g = f(f(D - t) / Math.min(f(D * 0.5), blendtime));
    if (g <= 1) w = f(w * g);
  }
  return w;
}

/**
 * 一层在 `lo` / `hi` 两帧间的样本（三个采样函数共用的部分，rea-RT 4）：只写 `mask` 为 1 的骨骼。
 * - 平移、缩放：`(1 − f)·a + f·b`；
 * - 旋转 nlerp：`dot = (z·z' + y·y') + (x·x' + w·w')`，点积的符号位为负时用 `−f`（最短路径），`q = (1 − f)·a + f'·b`，再乘 `nrRsqrt`。
 * `frames` 是编译期转好的帧数据（见文件头）。
 */
export function sampleLayer(
  frames: Float32Array,
  mask: Uint8Array,
  bones: number,
  lo: number,
  hi: number,
  frac: number,
  out: Float32Array,
): void {
  const g = f(1 - frac);
  for (let b = 0; b < bones; b++) {
    if (!mask[b]) continue;
    const a = (lo * bones + b) * POSE_STRIDE;
    const c = (hi * bones + b) * POSE_STRIDE;
    const o = b * POSE_STRIDE;
    for (const k of LINEAR) out[o + k] = f(f(g * frames[a + k]) + f(frac * frames[c + k]));
    const dot = f(
      f(f(frames[c + 6] * frames[a + 6]) + f(frames[c + 5] * frames[a + 5])) +
        f(f(frames[c + 4] * frames[a + 4]) + f(frames[c + 3] * frames[a + 3])),
    );
    const fp = signBit(dot) ? -frac : frac;
    for (let k = 3; k < 7; k++) out[o + k] = f(f(g * frames[a + k]) + f(fp * frames[c + k]));
    normalizeQuat(out, o + 3);
  }
}

/** `q *= nrRsqrt((z² + y²) + (x² + w²))`（采样与混合的归一化，rea-RT 4、5.2）。 */
function normalizeQuat(q: Float32Array, o: number): void {
  const n2 = f(f(f(q[o + 3] * q[o + 3]) + f(q[o + 2] * q[o + 2])) + f(f(q[o + 1] * q[o + 1]) + f(q[o] * q[o])));
  const k = nrRsqrt(n2);
  for (let i = 0; i < 4; i++) q[o + i] = f(k * q[o + i]);
}

/**
 * 把一层的样本叠进姿势（rea-RT 5.2；p12-REPORT 用例 3：覆盖 / 混合 / 加法、层序、缺轨道取来源都成立）。`src` 是来源：第一个可见层是
 * 静止姿势 `rest`，之后是上一层的结果（就是 `pose` 本身，逐骨骼先读后写，可以原地）。`mask` 为 0 的骨骼写来源（保持来源，不是绑定姿势）。
 * - `w == 1`（精确相等，`ucomiss`）且非加法：**覆盖**，取样本；
 * - 非加法其它 w：**混合**，T / S 为 `样本·w + 来源·(1 − w)`，q 为 `nlerp(来源, 样本, w)`（点积的符号位取 `−w`，结果再归一化）；
 * - 加法：T / S 为 `(样本 − 静止)·w + 来源`（缩放也是加的），q 为 `来源 ⊗ nlerp(单位, conj(静止) ⊗ 样本, w)`（Hamilton 积的各分量
 *   照读码的顺序，结果不再归一化）。
 * 权重和不归一化，也不和绑定姿势补足。
 */
export function blendInto(
  pose: Float32Array,
  src: Float32Array,
  sample: Float32Array,
  mask: Uint8Array,
  w: number,
  additive: boolean,
  rest: Float32Array,
  bones: number,
): void {
  const override = !additive && w === 1;
  const omw = f(1 - w);
  for (let b = 0; b < bones; b++) {
    const o = b * POSE_STRIDE;
    if (!mask[b]) {
      if (src !== pose) for (let k = 0; k < POSE_STRIDE; k++) pose[o + k] = src[o + k];
      continue;
    }
    if (override) {
      for (let k = 0; k < POSE_STRIDE; k++) pose[o + k] = sample[o + k];
      continue;
    }
    if (!additive) {
      // 混合（`0x1401f9320` 循环）
      const sw = src[o + 3];
      const sx = src[o + 4];
      const sy = src[o + 5];
      const sz = src[o + 6];
      const d2 = f(f(f(sample[o + 6] * sz) + f(sample[o + 5] * sy)) + f(f(sample[o + 4] * sx) + f(sample[o + 3] * sw)));
      const wp = signBit(d2) ? -w : w;
      for (const k of LINEAR) pose[o + k] = f(f(sample[o + k] * w) + f(src[o + k] * omw));
      pose[o + 3] = f(f(wp * sample[o + 3]) + f(sw * omw));
      pose[o + 4] = f(f(wp * sample[o + 4]) + f(sx * omw));
      pose[o + 5] = f(f(wp * sample[o + 5]) + f(sy * omw));
      pose[o + 6] = f(f(wp * sample[o + 6]) + f(sz * omw));
      normalizeQuat(pose, o + 3);
      continue;
    }
    // 加法（`0x1401f9bf0` 循环）
    const Sw = src[o + 3];
    const Sx = src[o + 4];
    const Sy = src[o + 5];
    const Sz = src[o + 6];
    for (const k of LINEAR) pose[o + k] = f(f(f(sample[o + k] - rest[o + k]) * w) + src[o + k]);
    // r* = conj(静止)；d = r* ⊗ 样本
    const rw = rest[o + 3];
    const rx = -rest[o + 4];
    const ry = -rest[o + 5];
    const rz = -rest[o + 6];
    const qw = sample[o + 3];
    const qx = sample[o + 4];
    const qy = sample[o + 5];
    const qz = sample[o + 6];
    const dw = f(f(f(f(qw * rw) - f(qx * rx)) - f(qy * ry)) - f(qz * rz));
    const dx = f(f(f(f(qw * rx) + f(qx * rw)) + f(qz * ry)) - f(qy * rz));
    const dy = f(f(f(f(qw * ry) + f(qy * rw)) + f(qx * rz)) - f(qz * rx));
    const dz = f(f(f(f(qw * rz) + f(qz * rw)) + f(qy * rx)) - f(qx * ry));
    // nlerp(单位, d, w)：点积就是 dw（照读码写成和 (1, 0, 0, 0) 的完整点积，分量顺序同采样）
    const e = f(f(f(dy * 0) + f(dz * 0)) + f(f(dx * 0) + f(dw * 1)));
    const wp = signBit(e) ? -w : w;
    const zero = f(0 * omw);
    const aw0 = f(f(wp * dw) + omw);
    const ax0 = f(f(wp * dx) + zero);
    const ay0 = f(f(wp * dy) + zero);
    const az0 = f(f(wp * dz) + zero);
    const k = nrRsqrt(f(f(f(az0 * az0) + f(ay0 * ay0)) + f(f(ax0 * ax0) + f(aw0 * aw0))));
    const aw = f(k * aw0);
    const ax = f(k * ax0);
    const ay = f(k * ay0);
    const az = f(k * az0);
    // 来源 ⊗ qa（来源在右边的那一项照读码：`out = src ⊗ qa`，Hamilton 展开的各分量顺序同上）
    pose[o + 3] = f(f(f(f(aw * Sw) - f(ax * Sx)) - f(ay * Sy)) - f(az * Sz));
    pose[o + 4] = f(f(f(f(aw * Sx) + f(ax * Sw)) + f(az * Sy)) - f(ay * Sz));
    pose[o + 5] = f(f(f(f(aw * Sy) + f(ay * Sw)) + f(ax * Sz)) - f(az * Sx));
    pose[o + 6] = f(f(f(f(aw * Sz) + f(az * Sw)) + f(ay * Sx)) - f(ax * Sy));
  }
}

/** 蒙皮要用的骨骼数据（`ScenePuppet.skeleton` 的子集）。 */
export interface SkinSkeleton {
  parents: Int32Array;
  /** 每骨骼 16 个 f32，绑定姿势的逆。 */
  inverseBind: Float32Array;
  /** 静止姿势的来源矩阵（没有可见层时局部矩阵直接取它，不经分解，rea-RT 6.1）。 */
  restMatrices: Float32Array;
}

/** 每骨骼的蒙皮输出：12 个 f32。 */
export const SKIN_STRIDE = 12;

/**
 * 蒙皮矩阵（rea-RT 6.1–6.3；p12-REPORT 用例 1–3 与 `check3203` 逐帧对上）：
 * - 局部：有可见层时 `[mat4_cast(q)·diag(S) | T]`（`trsMatrix`），没有时直接取静止来源矩阵；
 * - 模型空间 `B_i = B_parent · M_i`，按骨骼下标一遍（仿射乘法；父在后面时读到的是 `world` 里上一帧留下的值，同 WPE 复用 `P+0x2c8`）；
 * - 蒙皮 `K_i = B_i · 逆绑定_i`。
 * `world` 是每骨骼 16 个 f32 的工作区（跨帧保留），`out` 每骨骼 `SKIN_STRIDE` = 12 个：K 的前三列各自的 xyz、再第四列的 xyz，即
 * `(c0.xyz, c1.xyz, c2.xyz, c3.xyz)`。按 WPE 的行向量说法就是「4 行 × 前 3 列，行主序」，和 RenderDoc 读到的 `g_Bones` 同序
 * （`ignore/p12/out/wpe-3203778110-kbp-fps20-1920x1080-consts.json` 的 `draws[*].vs.g_Bones`）。
 */
export function skinMatrices(
  pose: Float32Array | null,
  skeleton: SkinSkeleton,
  world: Float32Array,
  out: Float32Array,
): void {
  const { parents, inverseBind, restMatrices } = skeleton;
  const bones = parents.length;
  const local = scratch.local;
  const temp = scratch.temp;
  for (let i = 0; i < bones; i++) {
    if (pose) trsMatrix(pose, i * POSE_STRIDE, local, 0);
    else for (let k = 0; k < 16; k++) local[k] = restMatrices[i * 16 + k];
    const parent = parents[i];
    if (parent < 0) world.set(local, i * 16);
    else {
      mulAffine(world, parent * 16, local, 0, temp, 0);
      world.set(temp, i * 16);
    }
  }
  for (let i = 0; i < bones; i++) {
    mulAffine(world, i * 16, inverseBind, i * 16, temp, 0);
    const o = i * SKIN_STRIDE;
    out[o] = temp[0];
    out[o + 1] = temp[1];
    out[o + 2] = temp[2];
    out[o + 3] = temp[4];
    out[o + 4] = temp[5];
    out[o + 5] = temp[6];
    out[o + 6] = temp[8];
    out[o + 7] = temp[9];
    out[o + 8] = temp[10];
    out[o + 9] = temp[12];
    out[o + 10] = temp[13];
    out[o + 11] = temp[14];
  }
}

/** 工作格（单线程，函数之间不重入）。 */
const scratch = { local: new Float32Array(16), temp: new Float32Array(16) };
