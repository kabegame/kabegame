/**
 * renderer 的朝向（P4c 步骤 5）：`sprite`、`spritetrail` 共用的 `orientation`、`axis`、`flags` 解析，和每次绘制写的
 * `g_OrientationForward / Right / Up`。依据 `.claude/plans/wpe-import/3-scene/phase4/rea-p4c-render.md` 7.1、7.2、7.4（读码【确】），
 * 两段汇编都按 `ignore/p4/rea/wp.asm` 逐条核对过，24 组四角实测见 `p4-particles-REPORT.md`「P4c 语义的实测核对」与
 * `ignore/p4/c5` 的离线四角。
 *
 * **记号。** rea 7.2 的 `M` 是行主序、「第 i 行 = 本地第 i 轴在世界里的向量」，内存里就是 `g_ModelMatrix` 的 16 个 float。
 * 我们的 `Mat4`（`render/math.ts`）是列主序、同一份字节上传，所以 rea 的第 i 行就是我们的第 i 列 `W[4i..4i+2]`：
 * - rea 的 `v·M`（本地 → 世界）= `mat3(W)·v`，第 j 个分量 `(v.y·W[4+j] + v.x·W[j]) + v.z·W[8+j]`（`toWorld`）；
 * - rea 的 `M·v`（与三行分别点积）= `mat3(W)ᵀ·v`，第 i 个分量 `(v.y·W[4i+1] + v.x·W[4i]) + v.z·W[4i+2]`（`toLocal`）。
 * 每一步都舍入成 float32，加法的结合顺序照汇编（float 加法可交换，只有结合顺序影响结果）。
 */
import type { Mat4 } from "../render/math";
import { f32 } from "./f32";
import type { ParticleFieldValue } from "./modules";

export type Vec3 = [number, number, number];

/** 0 screen、1 upright、2 fixed（`FUN_1401c22e0` 写 `p+8`）。 */
export type ParticleOrientationMode = 0 | 1 | 2;

/** renderer 的朝向（`FUN_1401c22e0`，rea-p4c-render.md 7.1）：解析期一次算好。 */
export interface ParticleOrientation {
  /** 0 screen、1 upright、2 fixed：只认精确的 `"upright"` / `"fixed"`（区分大小写），其它都是 0。 */
  mode: ParticleOrientationMode;
  /** 归一化后的 axis（float32）；精确的 (0,0,0) 换成 (0,1,0)。 */
  axis: Vec3;
  /** 派生的 t（`fixed` 用作上方向）。 */
  t: Vec3;
  /** flags 低 8 位（`p+0x30` 是一个字节）；只有 bit0 有读者（7.6）。 */
  flags: number;
}

/** `orientation` 字符串 → 模式（`0x1401c2612`–`0x1401c268b`：长度 7 且等于 `"upright"` 得 1，长度 5 且等于 `"fixed"` 得 2）。 */
export function orientationMode(value: unknown): ParticleOrientationMode {
  return value === "upright" ? 1 : value === "fixed" ? 2 : 0;
}

/** `cross(a, b)`，每个分量 `f(f(p) − f(q))`（乘法可交换，减法先后照叉乘定义）。 */
function cross(a: readonly number[], b: readonly number[]): Vec3 {
  return [
    f32(f32(a[1] * b[2]) - f32(a[2] * b[1])),
    f32(f32(a[2] * b[0]) - f32(a[0] * b[2])),
    f32(f32(a[0] * b[1]) - f32(a[1] * b[0])),
  ];
}

/**
 * 归一化：`s = (x² + y²) + z²`，`inv = 1 / sqrt(s)`（`sqrtss` 后 `divss`，不是近似倒数），各分量乘 `inv`。零向量得 NaN（0·∞），
 * 和 WPE 一样不特判。解析期的 `FUN_14005eb80`、`r`、`t` 与朝向函数尾部的三次归一化都是这个写法（朝向函数写成 `(y² + x²) + z²`，
 * 加法可交换，逐位相同）。
 */
function normalize(v: readonly number[]): Vec3 {
  const s = f32(f32(f32(v[0] * v[0]) + f32(v[1] * v[1])) + f32(v[2] * v[2]));
  const inv = f32(1 / f32(Math.sqrt(s)));
  return [f32(v[0] * inv), f32(v[1] * inv), f32(v[2] * inv)];
}

/**
 * 解析 renderer 的朝向（`FUN_1401c22e0`，`0x1401c25d6`–`0x1401c29b2`）。`fields` 是模块表解析出的 `orientation`、`axis`
 * （double 分量，WPE `atof` 后 `cvtsd2ss`，这里舍入成 float32）与 `flags`（模块表已取低 8 位）。
 * ```
 * axis = (ax, ay, az)
 * if ax == ay == az == 0（精确比较，-0 也算）: axis = (0, 1, 0)            // 0x1401c2759–0x1401c2783
 * else: axis = normalize(axis)                                              // FUN_14005eb80
 * if axis.x == 0 && axis.z == 0: t = (0, 0, −1)                             // 0x1401c27aa，常量 0x1404929b8 = −1
 * else:
 *     r' = (az − ay·0, ax·0 − az·0, ay·0 − ax)                              // 0x1401c27df 起，·0 真的算
 *     t  = normalize(cross(axis, r'))                                       // r' 不归一化就进叉乘
 * ```
 * 派生的 `r = normalize(r')` 在粒子路径没有读者，不存。
 */
export function readOrientation(fields: Readonly<Record<string, ParticleFieldValue>>): ParticleOrientation {
  const raw = (fields.axis as number[] | undefined) ?? [0, 0, 0];
  const [ax, ay, az] = [f32(raw[0] ?? 0), f32(raw[1] ?? 0), f32(raw[2] ?? 0)];
  const axis: Vec3 = ax === 0 && ay === 0 && az === 0 ? [0, 1, 0] : normalize([ax, ay, az]);
  let t: Vec3;
  if (axis[0] === 0 && axis[2] === 0) t = [0, 0, -1];
  else {
    const [x, y, z] = axis;
    const r: Vec3 = [f32(z - f32(y * 0)), f32(f32(x * 0) - f32(z * 0)), f32(f32(y * 0) - x)];
    t = normalize(cross(axis, r));
  }
  return {
    mode: orientationMode(fields.orientation),
    axis,
    t,
    flags: Number(fields.flags ?? 0) & 0xff,
  };
}

/** rea 的 `v·M`：本地 → 世界，第 j 个分量 `(v.y·W[4+j] + v.x·W[j]) + v.z·W[8+j]`（见文件头）。 */
function toWorld(model: Mat4, v: readonly number[]): Vec3 {
  const out: Vec3 = [0, 0, 0];
  for (let j = 0; j < 3; j++)
    out[j] = f32(f32(f32(v[1] * model[4 + j]) + f32(v[0] * model[j])) + f32(v[2] * model[8 + j]));
  return out;
}

/** rea 的 `M·v`：与 `W` 的三列分别点积，第 i 个分量 `(v.y·W[4i+1] + v.x·W[4i]) + v.z·W[4i+2]`（见文件头）。 */
function toLocal(model: Mat4, v: readonly number[]): Vec3 {
  const out: Vec3 = [0, 0, 0];
  for (let i = 0; i < 3; i++)
    out[i] = f32(f32(f32(v[1] * model[4 * i + 1]) + f32(v[0] * model[4 * i])) + f32(v[2] * model[4 * i + 2]));
  return out;
}

export interface OrientationBasis {
  forward: Vec3;
  right: Vec3;
  up: Vec3;
}

/**
 * 三个朝向向量的原值（`FUN_1402298b0`，rea-p4c-render.md 7.2），可能含 NaN（`orientationBasis` 判断）。`model` 是这次绘制的
 * 模型矩阵（列主序 `Mat4`，只用 3×3；本地系统是对象世界矩阵，世界空间系统是单位阵）；`vf`、`vup` 是相机的视线与上方向。
 * ```
 * bit0 = flags & 1                                      // 0x1402298c2：cl = ~flags & 1
 * screen（0x140229c35）:  F = −vf
 *                         U = bit0 ? vup : (0,1,0)·M     // 0x140229c67，乘数向量 0x140492e30 = (1,1,1,1)，与 toWorld 逐位相同
 *                         d = (F.y·U.y + F.x·U.x) + F.z·U.z;  U = U − F·d
 * upright（0x140229ab8）: U = bit0 ? (0,1,0) : axis·M;  R = vf × U;  F = R × U
 * fixed（0x14022997d）:   bit0 ? (F = axis, U = t，原样拷贝，0x140229a87) : (F = axis·M, U = t·M)
 * 公共尾（0x140229d55）:  F' = M·F;  U' = M·U;  R' = U' × F'
 *                         Forward = normalize(F')、Right = normalize(R')、Up = normalize(U')
 * ```
 * 结果在模型本地空间，着色器再乘 MVP（`ComputeParticleTangents` 以 (Right, Up, Forward) 为三行）。
 */
export function orientationVectors(
  orientation: ParticleOrientation,
  model: Mat4,
  vf: readonly number[],
  vup: readonly number[],
): OrientationBasis {
  const follow = (orientation.flags & 1) === 0;
  let F: Vec3;
  let U: Vec3;
  if (orientation.mode === 0) {
    F = [-vf[0], -vf[1], -vf[2]];
    U = follow ? toWorld(model, [0, 1, 0]) : [vup[0], vup[1], vup[2]];
    const d = f32(f32(f32(F[1] * U[1]) + f32(F[0] * U[0])) + f32(F[2] * U[2]));
    U = [f32(U[0] - f32(F[0] * d)), f32(U[1] - f32(F[1] * d)), f32(U[2] - f32(d * F[2]))];
  } else if (orientation.mode === 1) {
    U = follow ? toWorld(model, orientation.axis) : [0, 1, 0];
    F = cross(cross(vf, U), U);
  } else if (follow) {
    F = toWorld(model, orientation.axis);
    U = toWorld(model, orientation.t);
  } else {
    F = [...orientation.axis];
    U = [...orientation.t];
  }
  const forward = toLocal(model, F);
  const up = toLocal(model, U);
  return { forward: normalize(forward), right: normalize(cross(up, forward)), up: normalize(up) };
}

/**
 * `g_OrientationForward / Right / Up`（`orientationVectors`）；任一分量是 NaN 时为 null：这次绘制不画。WPE 里这时四角全是
 * NaN、图元被丢弃（`upright` 的轴平行于视线，rea-p4c-render.md 7.4，实测 S7 的 `gs_out` 是 NaN）。WGSL 没有可靠的 NaN 判断，
 * 所以在 CPU 上判、整次绘制跳过（`render/scene.ts`）。
 */
export function orientationBasis(
  orientation: ParticleOrientation,
  model: Mat4,
  vf: readonly number[],
  vup: readonly number[],
): OrientationBasis | null {
  const basis = orientationVectors(orientation, model, vf, vup);
  const vectors = [basis.forward, basis.right, basis.up];
  return vectors.some((vector) => vector.some(Number.isNaN)) ? null : basis;
}

/**
 * 正交场景的视线与上方向（视图是单位阵，p3-script-REPORT L2）：`g_ViewForward = −V 第 2 列 = (0, 0, −1)`、
 * `g_ViewUp = V 第 1 列 = (0, 1, 0)`（rea-p4c-render.md 7.2）。透视场景（P5d 步骤 2）用相机的视线与上方向（`render/camera.ts` 的
 * `ViewVectors`，`GpuScene` 交给朝向计算）；透视粒子（系统 `flags` bit2）的覆盖只改视图平移和投影（`FUN_1401e5b60`，6.4），不改这两个。
 */
export const VIEW_FORWARD: Vec3 = [0, 0, -1];
export const VIEW_UP: Vec3 = [0, 1, 0];
