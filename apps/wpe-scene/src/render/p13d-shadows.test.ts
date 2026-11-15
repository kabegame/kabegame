/**
 * P13d 阴影的纯计算：点光六面的视图投影、平行光三级联、图集打包与方块变换，对 WPE 抓帧的原值逐位核对。
 * 夹具 `shadowMath.fixture.json` 来自 `A:\p13d\sweep\` 的抓帧（`kbp rdc consts --no-clock`，`ignore/p13/d/ana/dump_expect.py`），
 * 工程 `ignore/p13/d/gen_d0.py`：
 * - po：正交 1920×1080，点光 (1300, 800, 500)、半径 1500，low；
 * - pp：透视，点光 (2, 5, 1)、半径 20，low；
 * - dir：透视，平行光 angles (0, −0.3, −1.2)，相机 eye (0, 2, 8)、看 (0, 0, −10)，low（dir-cd 改了 cascadedistance、dir-b 相机平移、
 *   dir-high 是 high 档）；
 * - multi：两盏点光 + 一盏平行光，ultra。
 */
import { describe, expect, it } from "vitest";
import {
  collectSceneLights,
  lightBufferLayout,
  lightFrame,
  lightFrameUniforms,
  type LightCounts,
} from "../compile/lights";
import type { SceneObject } from "../compile/model";
import { lookAtVectors } from "./camera";
import {
  cascadeViewProjection,
  packShadowAtlas,
  planShadows,
  pointShadowProjection,
  pointShadowViews,
  shadowBlockSize,
} from "./shadowMath";
import { multiply } from "./math";
import fixture from "./shadowMath.fixture.json";

const f32 = (values: readonly number[]) => Array.from(new Float32Array(values));
const plain = (value: unknown) => value as string | number | boolean | null | undefined;
const NONE = { pointShadow: 0, directionalShadow: 0, spotShadow: 0, spotCookie: 0, spotShadowCookie: 0 };

describe("点光（D1）", () => {
  it("方块边长与 fov 按档位", () => {
    expect([1, 2, 3, 4].map(shadowBlockSize)).toEqual([256, 256, 512, 1024]);
  });

  it.each([
    ["po", [1300, 800, 500], 1500, true, fixture.po_vp],
    ["pp", [2, 5, 1], 20, false, fixture.pp_vp],
  ])("%s：地面那次绘制的 6 个面 VP 逐位相同（P32 − 0.00333）", (_name, origin, radius, ortho, expected) => {
    const { shadow } = pointShadowProjection({ radius, lightSourceSize: 0 }, 1, ortho);
    const views = pointShadowViews(origin).map((view) => Array.from(multiply(shadow, view)));
    expect(views.flat()).toEqual(f32(expected));
  });

  it("uniform 的 (P22, P32, P23, P33) 不带偏移（3287715210 抓帧）", () => {
    const { info } = pointShadowProjection({ radius: 700.21997, lightSourceSize: 0 }, 1, true);
    expect(info).toEqual(f32([0.00143, 1.00143, -1, 0]).map((v, i) => (i < 2 ? info[i] : v)));
    expect(info[0]).toBeCloseTo(1 / 699.22, 6);
    expect(info[1]).toBeCloseTo(700.22 / 699.22, 6);
  });
});

describe("平行光三级联（D2）", () => {
  const light = (cascades: [number, number, number]) => ({
    matrix: collectSceneLights(
      [{ light: "ldirectional", angles: "0 -0.3 -1.2", origin: "0 10 0" } as SceneObject],
      plain,
    )[0].matrix,
    cascades,
  });
  const forwardOf = (eye: [number, number, number]) =>
    lookAtVectors(eye, [eye[0], eye[1] - 2, eye[2] - 18], [0, 1, 0]).forward;
  const ulp = (a: number, b: number) => {
    const buf = new DataView(new ArrayBuffer(8));
    buf.setFloat32(0, a, true);
    buf.setFloat32(4, b, true);
    return Math.abs(buf.getInt32(0, true) - buf.getInt32(4, true));
  };
  it.each([
    ["dir", [3, 10, 100], [0, 2, 8], 256, fixture.dir_proj],
    ["dir-cd", [5, 20, 60], [0, 2, 8], 256, fixture.dircd_proj],
    ["dir-b", [3, 10, 100], [0.013, 2, 8.007], 256, fixture.dirb_proj],
    ["dir-high", [3, 10, 100], [0, 2, 8], 512, fixture.dirhigh_proj],
  ] as const)(
    "%s：三级的 VP 和 uniform 差不超过 2 ulp（由角度算的轴分量，三角函数）",
    (_n, cd, eye, size, expected) => {
      const ours = [0, 1, 2].flatMap((c) =>
        Array.from(
          cascadeViewProjection(light(cd as [number, number, number]), c, forwardOf(eye as never), eye, false, size),
        ),
      );
      const worst = Math.max(...ours.map((v, i) => ulp(v, Math.fround(expected[i]))));
      expect(worst).toBeLessThanOrEqual(2);
    },
  );

  it("阴影 pass 用的 VP（planShadows 的视图）只在 [14] 减 0.0005，三级和 dir 抓帧的阴影 pass 差不超过 2 ulp", () => {
    // 夹具本身：uniform 0.5109016、阴影 pass 0.5104015
    expect(Math.fround(fixture.dir_proj[14] - fixture.dir_shadowpass[14])).toBeCloseTo(0.0005, 6);
    const eye: [number, number, number] = [0, 2, 8];
    const forward = forwardOf(eye);
    const counts: LightCounts = { ...NONE, point: 0, spot: 0, tube: 0, directional: 1, directionalShadow: 1 };
    const objects = [
      { light: "ldirectional", angles: "0 -0.3 -1.2", origin: "0 10 0", castshadow: true },
    ] as SceneObject[];
    const frame = lightFrame(collectSceneLights(objects, plain), counts, 1, forward);
    const plan = planShadows(frame, 1, forward, eye, false, null);
    const ours = [0, 1, 2].flatMap((c) => Array.from(plan.views[c][0].viewProjection));
    const worst = Math.max(...ours.map((v, i) => ulp(v, Math.fround(fixture.dir_shadowpass[i]))));
    expect(worst).toBeLessThanOrEqual(2);
  });
});

describe("打包与方块变换（D5、R4）", () => {
  it("同边长一行排，5 块 ultra 是 5120×1024", () => {
    const layout = packShadowAtlas(new Array(5).fill(0).map((_, i) => ({ point: i < 2, size: 1024 })));
    expect([layout.width, layout.height]).toEqual([5120, 1024]);
    expect(layout.blocks.map((b) => b.x)).toEqual([0, 1024, 2048, 3072, 4096]);
  });

  it("点光排在平行光之前（multi-ultra 的方块变换）", () => {
    const counts: LightCounts = {
      ...NONE,
      point: 2,
      spot: 0,
      tube: 0,
      directional: 1,
      pointShadow: 2,
      directionalShadow: 1,
    };
    const objects = [
      { light: "lpoint", origin: "2 5 1", radius: 20, castshadow: true },
      { light: "lpoint", origin: "-3 4 2", radius: 20, castshadow: true },
      { light: "ldirectional", angles: "0 -0.3 -1.2", castshadow: true },
    ] as SceneObject[];
    const forward = lookAtVectors([0, 6, 10], [0, 0, 0], [0, 1, 0]).forward;
    const frame = lightFrame(collectSceneLights(objects, plain), counts, 4, forward);
    planShadows(frame, 4, forward, [0, 6, 10], false, null);
    const uniforms = lightFrameUniforms(frame);
    expect(uniforms.g_LFeature_ShadowPointProjectionTransform).toEqual(f32(fixture.multi_ptf));
    expect(uniforms.g_LFeature_ShadowProjectionTransform).toEqual(f32(fixture.multi_tf));
  });

  it("打包键：点光优先于边长（R4.2），同类按边长降序、再按条目顺序", () => {
    // 平行光条目在前、边长更大，点光仍排第一个（聚光这类边长不同的方块接进来之前，灯的排序已经让点光在前，规则本身要单独守住）
    const layout = packShadowAtlas([
      { point: false, size: 1024 },
      { point: true, size: 256 },
      { point: false, size: 512 },
    ]);
    expect(layout.sizes).toEqual([256, 1024, 512]);
    expect(layout.positions[0]).toEqual([0, 0]);
  });

  it("上一帧布局在边长序列相同时复用；图集够大时不动（R4.5）", () => {
    const first = packShadowAtlas([{ point: true, size: 256 }]);
    const again = packShadowAtlas([{ point: true, size: 256 }], first);
    expect(again.positions).toBe(first.positions);
  });
});

describe("灯光整块缓冲（R2）", () => {
  it("投射灯多于 pointshadow：多出来的写进槽 1、被普通灯覆盖（over 抓帧）", () => {
    const counts: LightCounts = { ...NONE, point: 3, spot: 0, tube: 0, directional: 0, pointShadow: 1 };
    const objects = [
      { light: "lpoint", origin: "2 5 1", radius: 20, intensity: 2, color: "1 0.6 0.6", castshadow: true },
      { light: "lpoint", origin: "-3 4 2", radius: 20, intensity: 2, color: "0.6 0.6 1", castshadow: true },
      { light: "lpoint", origin: "0 3 -4", radius: 20, intensity: 2, color: "0.6 1 0.6" },
    ] as SceneObject[];
    const forward = lookAtVectors([0, 6, 10], [0, 0, 0], [0, 1, 0]).forward;
    const frame = lightFrame(collectSceneLights(objects, plain), counts, 1, forward);
    const uniforms = lightFrameUniforms(frame);
    // 抓帧：槽 0 = LB（dot(origin, forward) 更小）、槽 1 = LC（覆盖了 LA）、槽 2 空
    expect(uniforms.g_LPoint_Origin).toEqual([-3, 4, 2, 2, 0, 3, -4, 2, 0, 0, 0, 0]);
    expect(uniforms.g_LPoint_Color).toEqual(f32([1.2, 1.2, 2, 20, 1.2, 2, 1.2, 20, 0, 0, 0, 0]));
    expect(frame.entries.map((e) => e.light.object)).toEqual([1]);
  });

  it("布局：各段按声明顺序、阴影投影在灯之后", () => {
    const layout = lightBufferLayout({
      ...NONE,
      point: 2,
      spot: 0,
      tube: 0,
      directional: 1,
      pointShadow: 1,
      directionalShadow: 1,
    });
    expect(layout.slices.g_LFeature_ShadowProjection).toEqual([24, 48]);
    expect(layout.slices.g_LFeature_ShadowPointProjection).toEqual([84, 4]);
  });
});
