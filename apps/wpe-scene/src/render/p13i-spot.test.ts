/**
 * P13i 聚光阴影：灯光整块缓冲里聚光的四段与投影、图集打包、阴影 pass 的视图投影，对 WPE 抓帧的原值核对。
 * 夹具 `spotShadow.fixture.json` 来自 `A:\p13i\` 的抓帧（`kbp rdc consts --no-clock`，`ignore/p13/i/make_fixture.py`），
 * 工程 `ignore/p13/i/gen_i.py`（透视的基准相机 eye (0, 6, 10) 看原点）：
 * - spot：聚光 (1, 6, 1) 朝下、外锥 40°、半径 20，low / high；
 * - tilt：聚光 (−4, 5, 2)、angles (0, 0.4, −1.0)、外锥 35°，low；
 * - mix：带阴影的点光、普通聚光（objects 在前）、带阴影的聚光、带阴影的平行光，low / high；
 * - ortho：正交 1920×1080，聚光 (1150, 650, 700) 朝 −Z、外锥 35°、半径 2000，low。
 */
import { describe, expect, it } from "vitest";
import { collectSceneLights, lightCounts, lightFrame, lightFrameUniforms } from "../compile/lights";
import type { SceneObject } from "../compile/model";
import { lookAtVectors } from "./camera";
import { planShadows } from "./shadowMath";
import fixture from "./spotShadow.fixture.json";

/** float32 化并把 −0 统一成 +0（WPE 的方向列与我们的世界矩阵在零的符号上不同，不影响画面）。 */
const f32 = (values: readonly number[]) => Array.from(new Float32Array(values), (v) => v + 0);
const plain = (value: unknown) => value as string | number | boolean | null | undefined;
const DOWN = "0 0 -1.5708";

type Case = {
  objects: Record<string, unknown>[];
  lightconfig: Record<string, number>;
  orthographic?: boolean;
};

const spot = (origin: string, extra: Record<string, unknown> = {}) => ({
  light: "lspot",
  origin,
  angles: DOWN,
  color: "1 1 1",
  intensity: 4,
  radius: 20,
  castshadow: true,
  innercone: 25,
  outercone: 40,
  exponent: 1,
  ...extra,
});

const CASES: Record<string, Case> = {
  spot: { objects: [spot("1 6 1")], lightconfig: { spot: 1, spotshadow: 1 } },
  tilt: {
    objects: [spot("-4 5 2", { angles: "0 0.4 -1.0", innercone: 20, outercone: 35, color: "1 0.9 0.7" })],
    lightconfig: { spot: 1, spotshadow: 1 },
  },
  mix: {
    objects: [
      { light: "lpoint", origin: "-3 4 2", radius: 20, intensity: 1.5, color: "0.6 0.6 1", castshadow: true },
      spot("3 6 -1", { castshadow: false, color: "1 0.6 0.6" }),
      spot("1 6 1", { color: "0.6 1 0.6" }),
      { light: "ldirectional", origin: "0 10 0", angles: "0 -0.3 -1.2", intensity: 0.6, castshadow: true },
    ],
    lightconfig: { point: 1, pointshadow: 1, spot: 2, spotshadow: 1, directional: 1, directionalshadow: 1 },
  },
  ortho: {
    objects: [spot("1150 650 700", { angles: "0 1.5708 0", innercone: 20, outercone: 35, radius: 2000, intensity: 3 })],
    lightconfig: { spot: 1, spotshadow: 1 },
    orthographic: true,
  },
};

const QUALITY: Record<string, number> = { low: 1, high: 3 };

function run(tag: string) {
  const [name, level] = tag.split("-") as [string, string];
  const { objects, lightconfig, orthographic = false } = CASES[name];
  const quality = QUALITY[level];
  const eye: [number, number, number] = orthographic ? [960, 540, 2000] : [0, 6, 10];
  const forward = orthographic ? [0, 0, -1] : lookAtVectors(eye, [0, 0, 0], [0, 1, 0]).forward;
  const counts = lightCounts({ lightconfig }, quality);
  const frame = lightFrame(collectSceneLights(objects as SceneObject[], plain), counts, quality, forward);
  const plan = planShadows(frame, quality, forward, eye, orthographic, null);
  return { frame, plan, uniforms: lightFrameUniforms(frame) };
}

const TAGS = Object.keys(fixture) as (keyof typeof fixture)[];

describe("聚光阴影的灯光缓冲与投影（P13i，对 WPE 抓帧）", () => {
  for (const tag of TAGS) {
    it(`${tag}：LSpot 四个数组、ShadowProjection 与方块变换、点光投影逐位相同`, () => {
      const { uniforms } = run(tag);
      const lit = fixture[tag].lit as Record<string, number[]>;
      for (const name of Object.keys(lit)) {
        if (name === "g_Texture6Texel") continue;
        expect(f32(uniforms[name]), name).toEqual(f32(lit[name]));
      }
    });

    it(`${tag}：阴影 pass 的视图投影（聚光 [14] − 0.0005）与图集尺寸`, () => {
      const { plan } = run(tag);
      // WPE 每个投射者一次 draw，把它看得到的视图压紧成实例数组（长度 6，尾部重复）：点光的六面一组，聚光与三级联一组。我们按条目
      // 逐视图画，所以比较两边视图矩阵的集合
      const key = (m: readonly number[]) => JSON.stringify(f32(m));
      const expected = new Set(fixture[tag].shadowViews.flat().map(key));
      const ours = new Set(plan.views.flat().map((view) => key(Array.from(view.viewProjection))));
      expect([...ours].sort()).toEqual([...expected].sort());
      const texel = (fixture[tag].lit as Record<string, number[]>).g_Texture6Texel;
      if (texel) expect([plan.width, plan.height]).toEqual([texel[2], texel[3]]);
    });
  }
});
