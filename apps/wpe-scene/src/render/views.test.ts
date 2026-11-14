import { describe, expect, it } from "vitest";
import { ORTHO_VIEW_VECTORS } from "./camera";
import { identity } from "./math";
import { mirroredView, mirrorY, type SceneView } from "./views";

// WPE 抓帧的常量（p13-REPORT「P13b2 的实测」C2、C3，工程 p13b2-persp，`A:\p13b2\persp-on\persp-on-frame178.rdc`）。
// WPE 行向量约定、按行存的 16 个数，就是我们列向量约定、列主序的同一个矩阵（互为转置），所以可以直接比
const MAIN_VP = [
  1.206284999847412, 0, 0, 0, 0, 2.046888828277588, 2.9827797334291972e-6, -0.2982749938964844, 0, -0.6396527290344238,
  9.54489496507449e-6, -0.954479992389679, 0, -1.0234445333480835, 0.09991569072008133, 8.530664443969727,
];
const REFLECTED_VP = [
  1.206284999847412, 0, 0, 0, 0, 2.046888828277588, -2.9827797334291972e-6, 0.2982749938964844, 0, 0.6396527290344238,
  9.54489496507449e-6, -0.954479992389679, 0, 1.0234445333480835, 0.09991569072008133, 8.530664443969727,
];

/** 逐值比较用：WPE 导出的常量分不出 ±0，取反后的 0 记成 0。 */
const values = (m: ArrayLike<number>) => Array.from(m, (v) => (v === 0 ? 0 : v));

function view(vp: number[], eye: number[], vectors = ORTHO_VIEW_VECTORS): SceneView {
  return {
    viewProjection: new Float32Array(vp),
    perspectiveViewProjection: new Float32Array(vp),
    sceneCamera: { projection: new Float32Array(vp), view: identity() },
    eye,
    viewVectors: { forward: [...vectors.forward], right: [...vectors.right], up: [...vectors.up] },
  };
}

describe("场景视图的镜像（P13b2）", () => {
  it("透视：S·VP·S 和 WPE 反射 pass 的 g_ViewProjectionMatrix 逐值相同（C2）", () => {
    expect(values(mirrorY(new Float32Array(MAIN_VP)))).toEqual(values(new Float32Array(REFLECTED_VP)));
    const mirrored = mirroredView(view(MAIN_VP, [0, 3, 8]), false);
    expect(values(mirrored.viewProjection)).toEqual(values(new Float32Array(REFLECTED_VP)));
    expect(values(mirrored.perspectiveViewProjection)).toEqual(values(new Float32Array(REFLECTED_VP)));
  });

  it("透视：eye、right、up 的 y 取反，forward 不变（C3，探针 event 77 / 182）", () => {
    const main = view(MAIN_VP, [0, 3, 8], {
      forward: [0, -0.2982749938964844, -0.954479992389679],
      right: [1, 0, 0],
      up: [0, 0.954479992389679, -0.2982749938964844],
    });
    const mirrored = mirroredView(main, false);
    expect(mirrored.eye).toEqual([0, -3, 8]);
    expect(mirrored.viewVectors.forward).toEqual([0, -0.2982749938964844, -0.954479992389679]);
    expect(mirrored.viewVectors.up).toEqual([0, -0.954479992389679, -0.2982749938964844]);
    expect(Object.is(mirrored.viewVectors.right[1], -0)).toBe(true);
  });

  it("透视：分开的 P、V 镜像后相乘仍是 S·P·V·S", () => {
    const projection = new Float32Array(MAIN_VP);
    const v = new Float32Array([1, 0, 0, 0, 0, 0.8, 0.6, 0, 0, -0.6, 0.8, 0, 0.5, -2, -8, 1]);
    const main: SceneView = { ...view(MAIN_VP, [0, 3, 8]), sceneCamera: { projection, view: v } };
    const { sceneCamera } = mirroredView(main, false);
    const product = (a: Float32Array, b: Float32Array) => {
      const out = new Float32Array(16);
      for (let c = 0; c < 4; c++)
        for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) out[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
      return out;
    };
    expect(values(product(sceneCamera.projection, sceneCamera.view))).toEqual(values(mirrorY(product(projection, v))));
  });

  it("正交：视图投影不变（同一个对象），只翻 eye、right、up（C7）", () => {
    const vp = [1 / 960, 0, 0, 0, 0, 1 / 540, 0, 0, 0, 0, 0.00025, 0, -1, -1, 0.5, 1];
    const main = view(vp, [960, 540, 2000]);
    const mirrored = mirroredView(main, true);
    expect(mirrored.viewProjection).toBe(main.viewProjection);
    expect(mirrored.perspectiveViewProjection).toBe(main.perspectiveViewProjection);
    expect(mirrored.sceneCamera).toBe(main.sceneCamera);
    expect(mirrored.eye).toEqual([960, -540, 2000]);
    expect(mirrored.viewVectors.up).toEqual([0, -1, 0]);
    expect(mirrored.viewVectors.forward).toEqual([0, 0, -1]);
  });

  it("不改输入", () => {
    const main = view(MAIN_VP, [0, 3, 8]);
    mirroredView(main, false);
    expect([...main.viewProjection]).toEqual([...new Float32Array(MAIN_VP)]);
    expect(main.eye).toEqual([0, 3, 8]);
  });
});
