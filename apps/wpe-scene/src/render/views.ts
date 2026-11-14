/**
 * 场景视图（P13b2）：一次场景绘制用的相机量。主视图由 `GpuScene.setCamera` 填；平面反射 pass 的视图由 `mirroredView` 从主视图现算。
 *
 * 规则来自 WPE 2.8.42 的读码与实测（`.claude/plans/wpe-import/3-scene/phase13/rea-p13-passes.md` 1.3、`p13-REPORT.md`「P13b2 的实测」
 * C2、C3、C7）：
 * - 透视场景：视图左乘 `S = diag(1, −1, 1, 1)`、投影的 `P[1][1]` 取反，合起来 `VP' = S·VP·S`（先在世界里关于 y = 0 镜像，再把裁剪坐标的
 *   y 翻过来：读反射图的着色器屏幕 UV 不翻 y，所以反射图要上下颠倒地画）。WPE 是行向量约定、我们是列向量约定，两者互为转置，`S` 对称，
 *   所以写法相同。
 * - 正交场景：视图投影**不变**（C7：反射 pass 的 MVP 与主 pass 逐值相同），反射图就是同一画面去掉不在名单里的对象再画一遍。
 * - 两种场景都把 `g_EyePosition`、`g_ViewRight`、`g_ViewUp` 的 y 取反，`g_ViewForward` 不变（C3）。
 * 粒子 sprite 的朝向 `g_Orientation*` 不在这里（C9：WPE 在对象更新时按主视图写，反射 pass 不重算），调用方保留主视图的值。
 */
import type { Vec3 } from "../compile/camera";
import type { ViewVectors } from "./camera";
import type { Mat4 } from "./math";

/** 一个场景视图的相机量（`GpuScene.view` 是主视图）。 */
export interface SceneView {
  /** 场景级的视图投影 `P·V`（带抖动、缩放、相机对象）。 */
  viewProjection: Mat4;
  /** 透视覆盖（透视粒子、`perspective: true` 的图层）的视图投影。 */
  perspectiveViewProjection: Mat4;
  /** 分开的 P、V（视差在 V 上平移，`GpuScene.viewProjectionOf`）。 */
  sceneCamera: { projection: Mat4; view: Mat4 };
  eye: readonly number[];
  viewVectors: ViewVectors;
}

/** `S·M`：列主序下把第 1 行取反。 */
function negateRow1(m: Mat4): Mat4 {
  const out = new Float32Array(m);
  for (let c = 0; c < 4; c++) out[c * 4 + 1] = -out[c * 4 + 1];
  return out;
}

/** `M·S`：列主序下把第 1 列取反。 */
function negateColumn1(m: Mat4): Mat4 {
  const out = new Float32Array(m);
  for (let r = 0; r < 4; r++) out[4 + r] = -out[4 + r];
  return out;
}

/** `S·M·S`（C2）：第 1 行、第 1 列取反，(1, 1) 两次取反不变。 */
export function mirrorY(m: Mat4): Mat4 {
  return negateColumn1(negateRow1(m));
}

const flipY = (v: readonly number[]): Vec3 => [v[0] ?? 0, -(v[1] ?? 0), v[2] ?? 0];

/** 平面反射 pass 的视图（规则见文件头）。返回新对象，不改 `view`。 */
export function mirroredView(view: SceneView, orthographic: boolean): SceneView {
  const viewVectors: ViewVectors = {
    forward: view.viewVectors.forward,
    right: flipY(view.viewVectors.right),
    up: flipY(view.viewVectors.up),
  };
  const eye = flipY(view.eye);
  if (orthographic)
    return {
      viewProjection: view.viewProjection,
      perspectiveViewProjection: view.perspectiveViewProjection,
      sceneCamera: view.sceneCamera,
      eye,
      viewVectors,
    };
  return {
    viewProjection: mirrorY(view.viewProjection),
    perspectiveViewProjection: mirrorY(view.perspectiveViewProjection),
    // P' = S·P、V' = V·S：P'·V' = S·P·V·S，视差在 V' 上平移时同样成立
    sceneCamera: { projection: negateRow1(view.sceneCamera.projection), view: negateColumn1(view.sceneCamera.view) },
    eye,
    viewVectors,
  };
}
