/**
 * 透视相机（P5d 步骤 2，`.claude/plans/wpe-import/3-scene/phase5/phase-5d-camera-depth.md`「步骤 2」点 3）：纯函数，不碰 GPU。
 *
 * - **来源**：「相机对象 > 路径 > 基准」三选一（rea-p5-camera 3.2、4.2）。基准与路径表来自编译期（`compile/camera.ts` 的
 *   `SceneCameraJson`）；相机对象（P5d 步骤 3）每帧按 `objects` 倒序选第一个自身与父链都可见的（`activeCameraObject`），有它时路径
 *   不推进，透视场景的 fov 取它的（`perspectiveCamera` 的 `fov`）。
 * - **正交场景的相机对象**（P5d 步骤 3，`orthographicCameraObjectFrame`）：V = lookAtRH(eye + s, center + s, up)（s 是正交抖动），
 *   VP = 正交投影（总缩放 `general.zoom × camera.zoom`）· V，`g_EyePosition` 加相机的 eye.xy，视图向量取 V，透视覆盖在相机 V 上做
 *   （`particleViewProjection` 的 `view`）。没有可见相机对象时正交场景照旧是单位视图（P5a），不经过这里。
 * - **路径**（rea-p5-camera 3.2【确】，`p5d-path` 实测）：状态三元组（路径下标 `G+0xe4`、关键帧下标 `G+0xe8`、本路径内时间
 *   `G+0xec`）。每帧先求值、再 `t += dt`：
 *   1. `t < k[i].t`：取 k[i]，段末 e = k[i].t + (i + 1 < n ? k[i+1].t : 0)；
 *   2. 否则 i 是最后一帧：取 k[i]，e = duration − k[i].t；
 *   3. 否则插值 s = (t − k[i].t)/(k[i+1].t − k[i].t)，`p0 + (p1 − p0)·(−s³ + 1.5s² + 0.5s)`（两端切线 (p1 − p0)/2、不乘段长），
 *      e = k[i+1].t；up 不归一化（lookAt 里归一化）。
 *   推进后 t > e 时：i + 1 < n 且 duration > k[i+1].t 就 i + 1，否则切到下一条路径（越界回 0）、i = 0、t = 0（余量丢掉）。路径之间
 *   硬切，永远循环。1、2 两条的段末是读码的怪癖（3.3），照做。
 * - **抖动**：三维（`shakeOffset3`），eye 与 center 加同一个偏移，在 lookAt 之前（rea-p5-camera 第 5 节，`p5d-shakep` 实测）。
 * - **视图**：`lookAtRH`（rea-p5-camera 1.2）。**投影**：反向深度的 `perspectiveRH`（1.1，`p5d-persp` / `p5d-persp-b` 实测），fov 取
 *   `general.fov`（度，竖直）钳到 [0.1, 179.9]，`nearz` / `farz` 每帧读，宽高比取场景目标（就是画布）。透视场景里 `zoom` 不起作用（1.4）。
 * - **视图向量**（rea-p5-camera 8，`p5d-tilt` 实测）：`g_ViewForward` = f = normalize(center − eye)、`g_ViewRight` = s = normalize(f × up)、
 *   `g_ViewUp` = u = s × f，都是世界空间的向量（行向量约定下 V 的第 2 列取负、第 0 列、第 1 列）。
 *
 * 矩阵约定同 `math.ts`：列向量约定的数学矩阵、列主序存（`m[c * 4 + r]`）。WPE 是行向量约定，它的 `mRC` 就是这里缓冲的下标
 * `R * 4 + C`（转置后按列主序存，等于原矩阵按行主序存），所以下面注释里的 m00、m22、m23、m32 直接对应缓冲下标 0、10、11、14。
 * 数值照 WPE 存 float32（`Float32Array`、`Math.fround`）；中间量按 double 算，差别在 float 舍入以内。
 *
 * 求值时刻同 P5a 的抖动（`render/shake.ts`）：渲染器在帧开头算、粒子步进之后交给 `GpuScene.setCamera`（WPE 先更新对象再更新相机，粒子
 * 模拟用上一帧的相机），补画帧 dt 为 0、路径不推进。路径状态归渲染器，整场重编译保留（同视差点，WPE 改属性不重建场景）。
 */
import type { GeneralValues } from "../compile/bindings";
import type { SceneBundle, SceneGeneral, SceneLayer } from "../compile/bundle";
import { DEFAULT_CAMERA, type CameraPath, type SceneCameraJson, type Vec3 } from "../compile/camera";
import {
  effectiveVisible,
  eyePosition,
  particleViewProjection,
  sceneViewProjection,
  worldMatrixOf,
  type ProjectionCrop,
} from "./layout";
import type { Mat4 } from "./math";
import { mulAffine } from "./math";
import type { SceneCamera } from "./scene";
import { shakeOffset, shakeOffset3, type ShakeFields } from "./shake";
import type { SceneState } from "./state";

const f = Math.fround;
/** WPE 的度转弧度常量（`G+0x148 × 0.017453292`，rea-p5-camera 1.1）。 */
const F_DEG_TO_RAD = f(0.017453292);

/** 相机的一个姿态：路径关键帧的插值结果，或基准。`zoom` 透视场景里不起作用（rea-p5-camera 1.4），只为和关键帧同形。 */
export interface CameraPose {
  eye: Vec3;
  center: Vec3;
  up: Vec3;
  zoom: number;
}

/** 路径状态（WPE `G+0xe4` / `+0xe8` / `+0xec`）：路径下标、关键帧下标、本路径内时间（float32）。 */
export interface CameraPathState {
  path: number;
  key: number;
  t: number;
}

/** 加载时的路径状态。 */
export function initialCameraPathState(): CameraPathState {
  return { path: 0, key: 0, t: 0 };
}

/** 路径模式：路径表非空且第 0 条有关键帧（rea-p5-camera 3.2；`compileCamera` 已去掉没有关键帧的路径）。 */
export function usesCameraPaths(paths: readonly CameraPath[]): boolean {
  return paths.length > 0 && paths[0].keys.length > 0;
}

/** 旧的 double 系数 `−s³ + 1.5s² + 0.5s`：只剩 zoom 分量（透视场景不用）与旧测试在用。 */
export function pathEase(s: number): number {
  return -s * s * s + 1.5 * s * s + 0.5 * s;
}

/**
 * 段内一个分量的 Hermite 插值（WPE `0x1401894b5`–`0x1401899b1` 符号执行出的运算树，逐步 float32）：两端切线 (p1 − p0)/2、
 * 不乘段长；`s` 是已求好的 (t − t0)/(t1 − t0)。
 */
function hermiteComponent(p0: number, p1: number, s: number): number {
  const s2 = f(s * s);
  const s3 = f(s2 * s);
  const h10 = f(f(s3 - f(s2 + s2)) + s);
  const h00 = f(f(f(s3 + s3) - f(s2 * 3)) + 1);
  const h11 = f(s3 - s2);
  const h01 = f(f(s2 * 3) - f(s3 + s3));
  const a = f(p0);
  const b = f(p1);
  const d = f(b - a);
  const dh = f(d * 0.5);
  const m0 = f(f(f(a - a) * 0.5) + dh);
  const m1 = f(f(f(b - b) * 0.5) + dh);
  return f(f(f(f(m0 * h10) + f(h00 * a)) + f(m1 * h11)) + f(h01 * b));
}

const lerpVec = (a: Vec3, b: Vec3, s: number): Vec3 => [
  hermiteComponent(a[0], b[0], s),
  hermiteComponent(a[1], b[1], s),
  hermiteComponent(a[2], b[2], s),
];
const keyPose = (key: CameraPath["keys"][number]): CameraPose => ({
  eye: [...key.eye],
  center: [...key.center],
  up: [...key.up],
  zoom: key.zoom,
});

/**
 * 求本帧的姿态并推进（rea-p5-camera 3.2，见文件头）。`dt` 是帧时间（同 `g_Frametime`；补画帧传 0，不推进）。状态越界（不该发生，
 * 比如路径表变了）时从头开始。没有路径时调用方不该调它（`usesCameraPaths`）。
 */
export function stepCameraPath(
  paths: readonly CameraPath[],
  state: CameraPathState,
  dt: number,
): { pose: CameraPose; next: CameraPathState } {
  let { path, key: i, t } = state;
  if (path >= paths.length || i >= paths[path].keys.length) {
    path = 0;
    i = 0;
    t = 0;
  }
  const current = paths[path];
  const k = current.keys;
  const n = k.length;
  let pose: CameraPose;
  let end: number;
  if (t < k[i].t) {
    pose = keyPose(k[i]);
    end = k[i].t + (i + 1 < n ? k[i + 1].t : 0);
  } else if (i === n - 1) {
    pose = keyPose(k[i]);
    end = current.duration - k[i].t;
  } else {
    const span = f(f(k[i + 1].t) - f(k[i].t));
    // 两个关键帧同一时刻：WPE 除出 inf / NaN（语料 0），这里直接取后一帧
    const h = span > 0 ? f(f(t - f(k[i].t)) / span) : 1;
    const [a, b] = [k[i], k[i + 1]];
    pose = {
      eye: lerpVec(a.eye, b.eye, h),
      center: lerpVec(a.center, b.center, h),
      up: lerpVec(a.up, b.up, h),
      zoom: f(a.zoom + (b.zoom - a.zoom) * pathEase(h)),
    };
    end = k[i + 1].t;
  }
  // float 累加（`p5d-path` 第二圈按日志 dt 推，和 WPE 差 ≤ 3.6e-6）
  t = f(t + f(dt));
  if (t > f(end)) {
    if (i + 1 < n && current.duration > k[i + 1].t) i += 1;
    else {
      path = (path + 1) % paths.length;
      i = 0;
      t = 0;
    }
  }
  return { pose, next: { path, key: i, t } };
}

/** 基准姿态（没有路径时；基准 zoom 恒 1，透视场景里不起作用）。 */
export function baseCameraPose(camera: Pick<SceneCameraJson, "eye" | "center" | "up">): CameraPose {
  return { eye: [...camera.eye], center: [...camera.center], up: [...camera.up], zoom: 1 };
}

/** 本帧的来源姿态（路径 > 基准）并推进路径状态；没有路径时状态原样返回。 */
export function stepCameraSource(
  camera: SceneCameraJson,
  state: CameraPathState,
  dt: number,
): { pose: CameraPose; next: CameraPathState } {
  return usesCameraPaths(camera.paths)
    ? stepCameraPath(camera.paths, state, dt)
    : { pose: baseCameraPose(camera), next: state };
}

/**
 * dev 探针的确定性回放：从加载时的状态起按逐帧 dt 推路径状态机（同 `replayParallax`），返回推完之后的状态；读回的那一帧拿它求值。
 * 没有路径时恒为初始状态。
 */
export function replayCameraPath(paths: readonly CameraPath[], dts: readonly number[]): CameraPathState {
  let state = initialCameraPathState();
  if (!usesCameraPaths(paths)) return state;
  for (const dt of dts) state = stepCameraPath(paths, state, dt).next;
  return state;
}

/** 视图的三个世界空间单位向量（`g_ViewForward` / `g_ViewRight` / `g_ViewUp`）。 */
export interface ViewVectors {
  forward: Vec3;
  right: Vec3;
  up: Vec3;
}

/** 正交场景的视图向量（视图恒为单位阵，rea-p5-camera 8 的「默认」）。 */
export const ORTHO_VIEW_VECTORS: Readonly<ViewVectors> = Object.freeze({
  forward: [0, 0, -1] as Vec3,
  right: [1, 0, 0] as Vec3,
  up: [0, 1, 0] as Vec3,
});

/** 一份逐步 float32 的 lookAt 结果：三个轴（f、s、u，u 不再归一化）。 */
function lookAtF32(eye: Vec3, center: Vec3, up: Vec3): { fw: Vec3; s: Vec3; u: Vec3 } {
  const [ex, ey, ez] = [f(eye[0]), f(eye[1]), f(eye[2])];
  const [cx, cy, cz] = [f(center[0]), f(center[1]), f(center[2])];
  const [ux, uy, uz] = [f(up[0]), f(up[1]), f(up[2])];
  let fx = f(cx - ex);
  let fy = f(cy - ey);
  let fz = f(cz - ez);
  // 先倒数再乘；长度 0 时 1/0 = Infinity、0·Infinity = NaN，照 WPE 不特判
  let inv = f(1 / f(Math.sqrt(f(f(f(fx * fx) + f(fy * fy)) + f(fz * fz)))));
  fx = f(fx * inv);
  fy = f(fy * inv);
  fz = f(fz * inv);
  let sx = f(f(uz * fy) - f(uy * fz));
  let sy = f(f(ux * fz) - f(uz * fx));
  let sz = f(f(uy * fx) - f(ux * fy));
  inv = f(1 / f(Math.sqrt(f(f(f(sx * sx) + f(sy * sy)) + f(sz * sz)))));
  sx = f(sx * inv);
  sy = f(sy * inv);
  sz = f(sz * inv);
  const vx = f(f(sy * fz) - f(sz * fy));
  const vy = f(f(sz * fx) - f(sx * fz));
  const vz = f(f(sx * fy) - f(sy * fx));
  return { fw: [fx, fy, fz], s: [sx, sy, sz], u: [vx, vy, vz] };
}

/** lookAt 的三个轴：f = normalize(center − eye)、s = normalize(f × up)、u = s × f（rea-p5-camera 1.2；逐步 float32，同 `lookAtRH`）。 */
export function lookAtVectors(eye: Vec3, center: Vec3, up: Vec3): ViewVectors {
  const { fw, s, u } = lookAtF32(eye, center, up);
  return { forward: fw, right: s, up: u };
}

/**
 * `LookAtRH`（`FUN_14019d920`，rea-p5-camera 1.2【确】）：行向量下 V 的三列是 (s, u, −f)、平移 (−s·eye, −u·eye, f·eye)；
 * 相机看 −Z。这里是它的转置（列向量约定），列主序存。每个二元运算都 float32 舍入（补修，汇编逐步）。
 */
export function lookAtRH(eye: Vec3, center: Vec3, up: Vec3): Mat4 {
  const { fw, s, u } = lookAtF32(eye, center, up);
  const [ex, ey, ez] = [f(eye[0]), f(eye[1]), f(eye[2])];
  const d3 = (a: Vec3) => f(f(f(a[0] * ex) + f(a[1] * ey)) + f(a[2] * ez));
  const m = new Float32Array(16);
  m[0] = s[0];
  m[4] = s[1];
  m[8] = s[2];
  m[12] = -d3(s);
  m[1] = u[0];
  m[5] = u[1];
  m[9] = u[2];
  m[13] = -d3(u);
  m[2] = -fw[0];
  m[6] = -fw[1];
  m[10] = -fw[2];
  m[14] = d3(fw);
  m[15] = 1;
  return m;
}

/** 按位模式取 float32 常量（WPE exe 里的原值）。 */
const bits = (u: number): number => new Float32Array(new Uint32Array([u]).buffer)[0];
const C_1DIV2PI = bits(0x3e22f983);
const C_2PI = bits(0x40c90fdb);
const C_PIDIV2 = bits(0x3fc90fdb);
const C_PI = bits(0x40490fdb);
const SIN_S6 = bits(0x32cd365b);
const SIN_S5 = bits(0x3638b88e);
const SIN_S4 = bits(0x39500bf1);
const SIN_S3 = bits(0x3c088886);
const SIN_S2 = bits(0x3e2aaaab);
const COS_C5 = bits(0x348bdd11);
const COS_C4 = bits(0x37cfb4c2);
const COS_C3 = bits(0x3ab609aa);
const COS_C2 = bits(0x3d2aaaa3);
/** 导出给测试核对常量。 */
export const XM_SINCOS_CONSTANTS = {
  C_1DIV2PI,
  C_2PI,
  C_PIDIV2,
  C_PI,
  S6: SIN_S6,
  S5: SIN_S5,
  S4: SIN_S4,
  S3: SIN_S3,
  S2: SIN_S2,
  C5: COS_C5,
  C4: COS_C4,
  C3: COS_C3,
  C2: COS_C2,
};

/** DirectXMath `XMScalarSinCos`（WPE `0x14009a360` 内联），逐步 float32：sin 11 次、cos 10 次多项式。 */
export function xmScalarSinCos(value: number): [number, number] {
  let y = f(value);
  let q = f(y * C_1DIV2PI);
  q = y >= 0 ? Math.trunc(f(q + 0.5)) : Math.trunc(f(q - 0.5));
  y = f(y - f(C_2PI * q));
  let sign = 1;
  if (y > C_PIDIV2) {
    y = f(C_PI - y);
    sign = -1;
  } else if (y < -C_PIDIV2) {
    y = f(-C_PI - y);
    sign = -1;
  }
  const y2 = f(y * y);
  let a = f(SIN_S5 - f(y2 * SIN_S6));
  a = f(a * y2);
  a = f(a - SIN_S4);
  a = f(a * y2);
  a = f(a + SIN_S3);
  a = f(a * y2);
  a = f(a - SIN_S2);
  a = f(a * y2);
  a = f(a + 1);
  const sin = f(a * y);
  let b = f(COS_C4 - f(y2 * COS_C5));
  b = f(b * y2);
  b = f(b - COS_C3);
  b = f(b * y2);
  b = f(b + COS_C2);
  b = f(b * y2);
  b = f(b - 0.5);
  b = f(b * y2);
  b = f(b + 1);
  return [sin, f(b * sign)];
}

/**
 * 反向深度的透视（`FUN_14009a360` = `XMMatrixPerspectiveFovRH` 把 near / far 互换，rea-p5-camera 1.1、1.2【确】，`p5d-persp` /
 * `p5d-persp-b` 实测）：m00 = cot(fov/2)/aspect、m11 = cot(fov/2)、m22 = n/(f − n)、m23 = −1、m32 = n·f/(f − n)，其余 0。
 * ndc.z = −m22 − m32/z_view：z_view = −near 时 1、−far 时 0。WebGPU 的深度范围也是 [0, 1]，原样用。
 */
export function perspectiveRH(fovRadians: number, aspect: number, near: number, far: number): Mat4 {
  const [fov, asp, n, fa] = [f(fovRadians), f(aspect), f(near), f(far)];
  const [sin, cos] = xmScalarSinCos(f(fov * 0.5));
  const height = f(cos / sin);
  const width = f(height / asp);
  const range = f(n / f(fa - n));
  const m = new Float32Array(16);
  m[0] = width;
  m[5] = height;
  m[10] = range;
  m[11] = -1;
  m[14] = f(range * fa);
  return m;
}

/** fov（度）→ 弧度：钳到 [0.1, 179.9]（`0x140189b12`），再乘 WPE 的 float 常量（rea-p5-camera 1.1、1.3）。 */
export function perspectiveFov(degrees: number): number {
  const clamped = f(Math.min(179.9, Math.max(0.1, Number.isFinite(degrees) ? degrees : 50)));
  return f(clamped * F_DEG_TO_RAD);
}

/** 透视相机每帧读的 general 字段（`SceneState.general` 满足）。 */
export type CameraFields = Pick<GeneralValues, "fov" | "nearz" | "farz"> & ShakeFields;

export interface PerspectiveCameraInput {
  /** 来源姿态（`stepCameraSource`，或生效的相机对象 `activeCameraObject`）。 */
  pose: CameraPose;
  fields: CameraFields;
  /** 竖直 fov（度）：生效的相机对象的 `fov`（P5d 步骤 3，rea-p5-camera 4.2）；不给时取 `fields.fov`。同样钳制。 */
  fov?: number;
  /** 本帧的 `g_Time`（抖动用，同正交）。 */
  time: number;
  /** 场景目标尺寸（透视场景就是画布，宽高比取它）。 */
  width: number;
  height: number;
}

/** 透视的一帧相机：交给 `GpuScene.setCamera`。 */
export interface PerspectiveCameraFrame {
  view: Mat4;
  projection: Mat4;
  /** `projection · view`（列向量约定；WPE 的 V·P）。 */
  viewProjection: Mat4;
  /** 抖动之后的 eye（`g_EyePosition`），float32。 */
  eye: Vec3;
  center: Vec3;
  /** 视图向量（float32）。 */
  vectors: ViewVectors;
}

/**
 * 透视的一帧相机（rea-p5-camera 1、5、8）：来源姿态加三维抖动（eye 与 center 同移）→ lookAtRH → 反向深度透视（fov 钳制、
 * nearz / farz 当帧读、宽高比取场景目标）。
 */
export function perspectiveCamera(input: PerspectiveCameraInput): PerspectiveCameraFrame {
  const { pose, fields } = input;
  const [sx, sy, sz] = shakeOffset3(fields, input.time);
  const eye: Vec3 = [f(pose.eye[0] + sx), f(pose.eye[1] + sy), f(pose.eye[2] + sz)];
  const center: Vec3 = [f(pose.center[0] + sx), f(pose.center[1] + sy), f(pose.center[2] + sz)];
  const view = lookAtRH(eye, center, pose.up);
  const aspect = f(input.width / input.height);
  const projection = perspectiveRH(perspectiveFov(input.fov ?? fields.fov), aspect, f(fields.nearz), f(fields.farz));
  const vectors = lookAtVectors(eye, center, pose.up);
  // `+ 0` 把 −0 换成 +0（正对相机时叉积里的 −0，写进缓冲没有分别，只为比较方便）
  const round = (v: Vec3): Vec3 => [f(v[0]) + 0, f(v[1]) + 0, f(v[2]) + 0];
  return {
    view,
    projection,
    // VP = P ⊗ V：WPE 的仿射乘法（rea-matrix-order 2.1）
    viewProjection: mulAffine(projection, view),
    eye,
    center,
    vectors: { forward: round(vectors.forward), right: round(vectors.right), up: round(vectors.up) },
  };
}

/**
 * 加载时的透视相机（`GpuScene` 建场景时用，预热的指针反投影与第一批 uniform）：路径从头（或基准）、`g_Time` 0。渲染器第一帧就用
 * `setCamera` 换成当帧的。`camera` 缺省（手写的 bundle）按基准的构造值、没有路径。
 */
export function initialPerspectiveFrame(
  camera: SceneCameraJson | null | undefined,
  fields: CameraFields,
  width: number,
  height: number,
): PerspectiveCameraFrame {
  const source = camera ?? { ...DEFAULT_CAMERA, paths: [] };
  const { pose } = stepCameraSource(source, initialCameraPathState(), 0);
  return perspectiveCamera({ pose, fields, time: 0, width, height });
}

/** 本帧生效的相机对象（P5d 步骤 3，`activeCameraObject`）。 */
export interface ActiveCameraObject {
  /** `objects` 下标。 */
  object: number;
  /** eye = 世界矩阵的平移、center = eye − 第 2 列（看本地 −Z）、up = 第 1 列（本地 +Y，带缩放，lookAt 里归一化），float32；`zoom` 同下。 */
  pose: CameraPose;
  /** 相机对象的 `fov`（度，`SceneState.cameras`）：只有透视场景用（正交场景 WPE 不改 `G+0x148`，rea-p5-camera 4.2）。 */
  fov: number;
  /** 相机对象的 `zoom`：正交场景乘进 `general.zoom`（`G.zoom × G+0x114`，rea-p5-camera 第 1 节第 4 步），透视场景不起作用。 */
  zoom: number;
}

/**
 * 本帧生效的相机对象（rea-p5-camera 4.2【确】，步骤 0 `p5d-camp-1` / `-2` 实测）：按 `objects` 下标从大到小找第一个自身与父链都可见
 * （`effectiveVisible`）的相机图层（`SceneLayer.camera` 非空），取它的世界矩阵（`worldMatrixOf`，含父链）：eye = 平移（列主序缓冲的
 * [12..14]）、center = eye − 第 2 列（[8..10]）、up = 第 1 列（[4..6]）。都不可见或没有相机对象时为 null（回到路径 / 基准，正交场景是
 * 单位视图）。`fov` / `zoom` 读 `SceneState.cameras`（就地写之后的值），状态里没有时取编译期的。`worlds` 是 `worldMatrixOf` 的缓存，
 * 跟随调用方的一次状态快照。
 */
export function activeCameraObject(
  bundle: { readonly layers: readonly SceneLayer[] },
  state: Pick<SceneState, "layers" | "cameras">,
  worlds: Map<number, Mat4> = new Map(),
): ActiveCameraObject | null {
  let best: { object: number; fov: number; zoom: number } | null = null;
  for (const layer of bundle.layers) {
    if (!layer.camera || (best && layer.object < best.object) || !state.layers.has(layer.object)) continue;
    if (!effectiveVisible(layer.object, state.layers)) continue;
    best = { object: layer.object, ...(state.cameras.get(layer.object) ?? layer.camera) };
  }
  if (!best) return null;
  const w = worldMatrixOf(best.object, state.layers, worlds);
  const eye: Vec3 = [f(w[12]), f(w[13]), f(w[14])];
  const pose: CameraPose = {
    eye,
    center: [f(eye[0] - w[8]), f(eye[1] - w[9]), f(eye[2] - w[10])],
    up: [f(w[4]), f(w[5]), f(w[6])],
    zoom: best.zoom,
  };
  return { object: best.object, pose, fov: best.fov, zoom: best.zoom };
}

/** 正交场景带相机对象的一帧（P5d 步骤 3）的输入。 */
export interface OrthographicCameraInput {
  /** 生效的相机对象的姿态（`activeCameraObject`）。 */
  pose: CameraPose;
  /** 本帧的正交抖动 s（`render/shake.ts` 的 `shakeOffset`），z 为 0。 */
  shake: readonly [number, number];
  /** 总缩放 `general.zoom × camera.zoom`（float32，`orthographicCameraZoom`）。 */
  zoom: number;
  general: Pick<SceneGeneral, "width" | "height" | "perspectiveOverrideFov">;
  /** 投影的裁切（dev 探针按指定尺寸画，`GpuScene.build` 的 `target`）：给了就带进正交投影与透视覆盖；缺省不裁，字节同以前。 */
  crop?: ProjectionCrop;
}

/** 正交场景带相机对象的一帧（交给 `GpuScene.setCamera` 的正交那种的 `cameraObject`）。 */
export interface OrthographicCameraFrame {
  /** V = lookAtRH(eye + s, center + s, up)。 */
  view: Mat4;
  /** 场景投影 `sceneViewProjection(general, zoom)`（P）：`GpuScene` 分开存 P 与 V，每次 draw 现算视差后的 `P ⊗ V`（rea-matrix-order 2.3）。 */
  projection: Mat4;
  /** `mulAffine(projection, V)`（WPE 的 `FUN_1400d4200` 写法，rea-matrix-order 2.1）。 */
  viewProjection: Mat4;
  /** 透视覆盖（透视粒子、`perspective: true` 的图像层 / 模型）：`particleViewProjection(general, zoom, V)`。 */
  perspectiveViewProjection: Mat4;
  /** `g_EyePosition` = (eye.x + s.x + W/2, eye.y + s.y + H/2, 2000)。 */
  eye: number[];
  /** 视差点的 eye.xy（补测 `p5d-camo-par`）：相机的 eye.xy + s，float32。 */
  parallaxEye: [number, number];
  /** 视图向量（float32）：取 V（步骤 0 `p5d-camo-r`）。 */
  vectors: ViewVectors;
}

/** 正交场景的总缩放（rea-p5-camera 第 1 节第 4 步：`G.zoom × G+0x114`），float32。 */
export function orthographicCameraZoom(generalZoom: number, cameraZoom: number): number {
  return f(f(generalZoom) * f(cameraZoom));
}

/**
 * 正交场景带相机对象的一帧（rea-p5-camera 4.3、6.2、7.2，步骤 0 `p5d-camo-c` / `-o` / `-r` 与补测 `-pp` / `-ppr` / `-par` /
 * `-shake` 实测）：抖动加在相机的 eye 与 center 上（z 不变）再 lookAt；正交投影仍是 0..W × 0..H（总缩放绕场景中心），所以世界点
 * (x, y) 落在投影坐标 (x − eye.x − s.x, y − eye.y − s.y)（angles 为 0 时）；`g_EyePosition` 照正交公式加上 eye.xy + s。
 */
export function orthographicCameraObjectFrame(input: OrthographicCameraInput): OrthographicCameraFrame {
  const { pose, general, zoom } = input;
  const [sx, sy] = input.shake;
  const eye: Vec3 = [f(pose.eye[0] + sx), f(pose.eye[1] + sy), pose.eye[2]];
  const center: Vec3 = [f(pose.center[0] + sx), f(pose.center[1] + sy), pose.center[2]];
  const view = lookAtRH(eye, center, pose.up);
  const vectors = lookAtVectors(eye, center, pose.up);
  // `+ 0` 把 −0 换成 +0（同 `perspectiveCamera`）
  const round = (v: Vec3): Vec3 => [f(v[0]) + 0, f(v[1]) + 0, f(v[2]) + 0];
  const projection = sceneViewProjection(general, zoom, input.crop?.edges);
  return {
    view,
    projection,
    viewProjection: mulAffine(projection, view),
    perspectiveViewProjection: particleViewProjection(general, zoom, view, input.crop),
    eye: eyePosition(general, [eye[0], eye[1]]),
    parallaxEye: [eye[0], eye[1]],
    vectors: { forward: round(vectors.forward), right: round(vectors.right), up: round(vectors.up) },
  };
}

/** 场景里的相机对象图层（`SceneLayer.camera` 非空，P5d 步骤 3）：渲染器与探针建场景时取一次，每帧只在它们里面选。 */
export function cameraObjectLayers(bundle: Pick<SceneBundle, "layers">): SceneLayer[] {
  return bundle.layers.filter((layer) => !!layer.camera);
}

/** 一帧相机的输入（渲染器与 dev 探针共用，P5d 步骤 3）。 */
export interface SceneCameraInput {
  /** 场景的相机对象图层（`cameraObjectLayers`）；空时不选，正交与透视都同步骤 2。 */
  cameraLayers: readonly SceneLayer[];
  /** 场景状态：相机对象的可见性与变换（图层字段）、`fov` / `zoom`（`cameras`），脚本之前的 general 字段。 */
  state: Pick<SceneState, "layers" | "cameras" | "general">;
  /** 场景的 general：正交的 W、H（抖动按 H 算）与透视覆盖的 fov。 */
  general: Pick<SceneGeneral, "width" | "height" | "perspectiveOverrideFov">;
  /** 投影的裁切（dev 探针按指定尺寸画）：只对正交场景的相机对象有用，交给 `orthographicCameraObjectFrame`；缺省不裁。 */
  crop?: ProjectionCrop;
  /** 本帧的 `g_Time`（抖动用）。 */
  time: number;
  /** 透视场景：基准与路径、路径状态、本帧推进路径的 dt（补画帧 0）、场景目标尺寸；正交场景为 null。 */
  perspective: {
    camera: SceneCameraJson;
    path: CameraPathState;
    dt: number;
    width: number;
    height: number;
  } | null;
}

export interface SceneCameraResult {
  /** 交给 `GpuScene.setCamera` 的一帧。 */
  camera: SceneCamera;
  /** 视差点的 eye.xy（`parallaxInput` 的 `eye`）：正交是 s（有相机对象时加它的 eye.xy），透视是透视相机的 eye.xy。 */
  eye: [number, number];
  /** 推进之后的路径状态：透视场景有相机对象时原样（WPE 只在没有相机对象时走路径，rea-p5-camera 4.2）；正交场景为 null。 */
  path: CameraPathState | null;
}

/**
 * 一帧的相机（渲染器每帧、dev 探针每个回放帧调，帧开头、粒子步进之前按脚本之前的状态求，粒子步进之后交给 `setCamera`）：
 * - 先选相机对象（`activeCameraObject`）；
 * - 透视场景：有相机对象时用它的姿态与 fov、路径不推进，否则路径 / 基准（`stepCameraSource`，推进 `dt`）；再加三维抖动（`perspectiveCamera`）；
 * - 正交场景：抖动 s（`shakeOffset`）；有相机对象时交 `orthographicCameraObjectFrame`（总缩放 `general.zoom × camera.zoom`），没有时同
 *   P5a（`{ shake, zoom: general.zoom }`，场景里逐字不变）。
 */
export function sceneCameraFrame(input: SceneCameraInput): SceneCameraResult {
  const { state, perspective } = input;
  const active = input.cameraLayers.length ? activeCameraObject({ layers: input.cameraLayers }, state) : null;
  if (perspective) {
    const { pose, next } = active
      ? { pose: active.pose, next: perspective.path }
      : stepCameraSource(perspective.camera, perspective.path, perspective.dt);
    const frame = perspectiveCamera({
      pose,
      ...(active ? { fov: active.fov } : {}),
      fields: state.general,
      time: input.time,
      width: perspective.width,
      height: perspective.height,
    });
    return { camera: { kind: "perspective", frame }, eye: [frame.eye[0], frame.eye[1]], path: next };
  }
  const shake = shakeOffset(state.general, input.time, input.general.height);
  if (!active) return { camera: { shake, zoom: state.general.zoom }, eye: shake, path: null };
  const zoom = orthographicCameraZoom(state.general.zoom, active.zoom);
  const frame = orthographicCameraObjectFrame({
    pose: active.pose,
    shake,
    zoom,
    general: input.general,
    ...(input.crop ? { crop: input.crop } : {}),
  });
  return { camera: { shake, zoom, cameraObject: frame }, eye: frame.parallaxEye, path: null };
}
