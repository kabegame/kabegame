/**
 * 透视相机（P5d 步骤 2，`.claude/plans/wpe-import/3-scene/phase5/phase-5d-camera-depth.md`「步骤 2」点 3）：纯函数，不碰 GPU。
 *
 * - **来源**：「相机对象 > 路径 > 基准」三选一（rea-p5-camera 3.2、4.2），相机对象归步骤 3（透视场景有可见相机对象时整张照报
 *   `object:camera`），这里只有后两个。基准与路径表来自编译期（`compile/camera.ts` 的 `SceneCameraJson`）。
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
import { DEFAULT_CAMERA, type CameraPath, type SceneCameraJson, type Vec3 } from "../compile/camera";
import type { Mat4 } from "./math";
import { multiply } from "./math";
import { shakeOffset3, type ShakeFields } from "./shake";

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

/** 段内插值的系数 `−s³ + 1.5s² + 0.5s`（两端切线 (p1 − p0)/2 的 Hermite，rea-p5-camera 3.2）。 */
export function pathEase(s: number): number {
  return -s * s * s + 1.5 * s * s + 0.5 * s;
}

const lerpVec = (a: Vec3, b: Vec3, h: number): Vec3 => [
  f(a[0] + (b[0] - a[0]) * h),
  f(a[1] + (b[1] - a[1]) * h),
  f(a[2] + (b[2] - a[2]) * h),
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
    const span = k[i + 1].t - k[i].t;
    // 两个关键帧同一时刻：WPE 除出 inf / NaN（语料 0），这里直接取后一帧
    const h = pathEase(span > 0 ? (t - k[i].t) / span : 1);
    const [a, b] = [k[i], k[i + 1]];
    pose = {
      eye: lerpVec(a.eye, b.eye, h),
      center: lerpVec(a.center, b.center, h),
      up: lerpVec(a.up, b.up, h),
      zoom: f(a.zoom + (b.zoom - a.zoom) * h),
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

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
/** `XMVector3Normalize`：长度为 0 时得 0 向量（不是 NaN）。 */
function normalize(v: Vec3): Vec3 {
  const length = Math.sqrt(dot(v, v));
  return length > 0 ? [v[0] / length, v[1] / length, v[2] / length] : [0, 0, 0];
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

/** lookAt 的三个轴：f = normalize(center − eye)、s = normalize(f × up)、u = s × f（rea-p5-camera 1.2）。 */
export function lookAtVectors(eye: Vec3, center: Vec3, up: Vec3): ViewVectors {
  const forward = normalize(sub(center, eye));
  const right = normalize(cross(forward, up));
  return { forward, right, up: cross(right, forward) };
}

/**
 * `LookAtRH`（`FUN_14019d920`，rea-p5-camera 1.2【确】）：行向量下 V 的三列是 (s, u, −f)、平移 (−s·eye, −u·eye, f·eye)；
 * 相机看 −Z。这里是它的转置（列向量约定），列主序存。
 */
export function lookAtRH(eye: Vec3, center: Vec3, up: Vec3): Mat4 {
  const { forward: fw, right: s, up: u } = lookAtVectors(eye, center, up);
  const m = new Float32Array(16);
  m[0] = s[0];
  m[4] = s[1];
  m[8] = s[2];
  m[12] = -dot(s, eye);
  m[1] = u[0];
  m[5] = u[1];
  m[9] = u[2];
  m[13] = -dot(u, eye);
  m[2] = -fw[0];
  m[6] = -fw[1];
  m[10] = -fw[2];
  m[14] = dot(fw, eye);
  m[15] = 1;
  return m;
}

/**
 * 反向深度的透视（`FUN_14009a360` = `XMMatrixPerspectiveFovRH` 把 near / far 互换，rea-p5-camera 1.1、1.2【确】，`p5d-persp` /
 * `p5d-persp-b` 实测）：m00 = cot(fov/2)/aspect、m11 = cot(fov/2)、m22 = n/(f − n)、m23 = −1、m32 = n·f/(f − n)，其余 0。
 * ndc.z = −m22 − m32/z_view：z_view = −near 时 1、−far 时 0。WebGPU 的深度范围也是 [0, 1]，原样用。
 */
export function perspectiveRH(fovRadians: number, aspect: number, near: number, far: number): Mat4 {
  const cot = Math.cos(fovRadians / 2) / Math.sin(fovRadians / 2);
  const range = near / (far - near);
  const m = new Float32Array(16);
  m[0] = cot / aspect;
  m[5] = cot;
  m[10] = range;
  m[11] = -1;
  m[14] = range * far;
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
  /** 来源姿态（`stepCameraSource`）。 */
  pose: CameraPose;
  fields: CameraFields;
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
  const projection = perspectiveRH(perspectiveFov(fields.fov), aspect, f(fields.nearz), f(fields.farz));
  const vectors = lookAtVectors(eye, center, pose.up);
  // `+ 0` 把 −0 换成 +0（正对相机时叉积里的 −0，写进缓冲没有分别，只为比较方便）
  const round = (v: Vec3): Vec3 => [f(v[0]) + 0, f(v[1]) + 0, f(v[2]) + 0];
  return {
    view,
    projection,
    viewProjection: multiply(projection, view),
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
