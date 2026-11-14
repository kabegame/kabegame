/**
 * uniform 求逆照 WPE 用单精度（`.claude/plans/wpe-import/3-scene/phase-f32-inverse.md`）：WPE 写 `g_*Inverse` 时一律现算 `FUN_14005f730`
 * （rea-matrix-order 2.5），我们用 `uniformInverse`（`invertF32`）。
 * 夹具 `uniformInverse.fixture.json` 是 WPE 抓帧里的「矩阵 → 逆」：前三个是同一次绘制同时读了 MVP 与它的逆，两边都是 WPE 的值；第四个
 * `g_EffectTextureProjectionMatrix` WPE 那次绘制没读原矩阵，原矩阵取探针轨迹（同一次绘制的其它矩阵与 WPE 逐位相同）。
 * 每个样本 `math.ts` 的 `invert`（double 余子式）都和 WPE 差末位，所以下面每处调用方改回 `invert` 都会失败。
 * 夹具按位存成十六进制（JSON 会把 −0 写成 0，WPE 的逆里有 ±0），由 `ignore/prs/rerun/inv_fixture.ts` 从抓帧常量提取。
 */
import { describe, expect, it } from "vitest";
import type { LayerState } from "./state";
import { uniformInverse } from "./inverseF32";
import { identity, invert, type Mat4 } from "./math";
import { drawUniformValues, particleUniformValues, staticBuiltins, textUniformValues } from "./uniforms";
import { trailEye } from "../particles/vertices";
import fixture from "./uniformInverse.fixture.json";

interface Sample {
  source: string;
  name: string;
  matrix: Float32Array;
  wpeInverse: Float32Array;
}
const fromHex = (words: string[]) => new Float32Array(Uint32Array.from(words, (word) => parseInt(word, 16)).buffer);
const SAMPLES: Sample[] = (fixture as { source: string; name: string; matrix: string[]; wpeInverse: string[] }[]).map(
  (item) => ({ ...item, matrix: fromHex(item.matrix), wpeInverse: fromHex(item.wpeInverse) }),
);

const bits = (values: ArrayLike<number>) => Array.from(new Int32Array(Float32Array.from(values).buffer));
const sameBits = (a: ArrayLike<number>, b: ArrayLike<number>) =>
  a.length === b.length && bits(a).every((x, i) => x === bits(b)[i]);

const LAYER: LayerState = {
  origin: [0, 0, 0],
  scale: [1, 1, 1],
  angles: [0, 0, 0],
  alpha: 1,
  color: [1, 1, 1],
  brightness: 1,
  visible: true,
  parallaxDepth: [1, 1],
  parent: null,
};
/** `drawUniformValues` 的图层还要 `size`。 */
const DRAW_LAYER = { ...LAYER, size: [2, 2] };
const COMMON = { colorScale: 1, screenSize: [1920, 1080] as [number, number], textures: [], eye: [960, 540, 2000] };
const IDENTITY = Array.from(identity());

/** `uniformInverse(m)` 与 `invert(m)` 不同的输入才能分出调用方用的是哪一个。 */
function distinguishes(m: Mat4): boolean {
  return !sameBits(uniformInverse(m)!, invert(m)!);
}

describe("uniformInverse：照 WPE 的 FUN_14005f730", () => {
  it.each(SAMPLES.map((sample) => [sample.source, sample] as const))(
    "%s：和 WPE 逐位相同，invert 不同",
    (_source, sample) => {
      const m = sample.matrix;
      expect(sameBits(uniformInverse(m)!, sample.wpeInverse)).toBe(true);
      expect(sameBits(invert(m)!, sample.wpeInverse)).toBe(false);
    },
  );

  it("奇异矩阵返回 null（invertF32 得到 inf / NaN）", () => {
    expect(uniformInverse(new Float32Array(16))).toBeNull();
    const flat = identity();
    flat[0] = 0; // x 方向缩成 0
    expect(uniformInverse(flat)).toBeNull();
  });
});

describe("调用方都用 uniformInverse", () => {
  it("staticBuiltins 的四个逆：模型、effect 模型、effect MVP、effect 纹理投影，和 WPE 逐位相同", () => {
    for (const sample of SAMPLES) {
      const m = sample.matrix;
      const values = staticBuiltins({
        modelViewProjection: identity(),
        modelViewProjectionInverse: null,
        model: m,
        viewProjection: identity(),
        effectModel: m,
        effectModelViewProjection: m,
        effectTextureProjection: m,
        layer: LAYER,
        ...COMMON,
      });
      for (const name of [
        "g_ModelMatrixInverse",
        "g_EffectModelMatrixInverse",
        "g_EffectModelViewProjectionMatrixInverse",
        "g_EffectTextureProjectionMatrixInverse",
      ])
        expect(sameBits(values[name], sample.wpeInverse), `${sample.source} ${name}`).toBe(true);
    }
  });

  it("奇异的模型矩阵：逆是单位阵（同以前）", () => {
    const values = staticBuiltins({
      modelViewProjection: identity(),
      modelViewProjectionInverse: null,
      model: new Float32Array(16),
      viewProjection: identity(),
      layer: LAYER,
      ...COMMON,
    });
    expect(values.g_ModelMatrixInverse).toEqual(IDENTITY);
    expect(values.g_ModelViewProjectionMatrixInverse).toEqual(IDENTITY);
  });

  it("drawUniformValues / textUniformValues / particleUniformValues 的 MVP 逆", () => {
    for (const sample of SAMPLES) {
      const viewProjection = sample.matrix;
      const world = identity();
      const results = {
        draw: drawUniformValues({
          step: { role: "direct", inputs: {} },
          layer: DRAW_LAYER,
          world,
          constants: {},
          viewProjection,
          ...COMMON,
        }),
        text: textUniformValues({
          step: { part: "glyphs", space: "direct" },
          layer: LAYER,
          layout: { mesh: null, padding: [0, 0], compositeSize: [4, 4] } as unknown as Parameters<
            typeof textUniformValues
          >[0]["layout"],
          world,
          viewProjection,
          constants: {},
          ...COMMON,
        }),
        particle: particleUniformValues({
          layer: LAYER,
          world,
          constants: {},
          viewProjection,
          ...COMMON,
        }),
      };
      for (const [kind, values] of Object.entries(results)) {
        const mvp = Float32Array.from(values.g_ModelViewProjectionMatrix);
        expect(distinguishes(mvp), `${sample.source} ${kind}：输入分得出两种求逆`).toBe(true);
        expect(
          sameBits(values.g_ModelViewProjectionMatrixInverse, uniformInverse(mvp)!),
          `${sample.source} ${kind}`,
        ).toBe(true);
      }
    }
  });

  it("粒子拖尾的眼位（trailEye）用同一个逆", () => {
    const eye = [960, 540, 2000];
    let distinguished = 0;
    for (const sample of SAMPLES) {
      const model = sample.matrix;
      const m = uniformInverse(model)!;
      const f = Math.fround;
      const row = (r: number) => f(f(f(f(m[r] * eye[0]) + f(m[4 + r] * eye[1])) + f(m[8 + r] * eye[2])) + m[12 + r]);
      expect(trailEye(eye, model), sample.source).toEqual([row(0), row(1), row(2)]);
      // 改回 invert 时眼位要有样本不同（这组输入分得出两种求逆）
      const n = invert(model)!;
      const rowN = (r: number) => f(f(f(f(n[r] * eye[0]) + f(n[4 + r] * eye[1])) + f(n[8 + r] * eye[2])) + n[12 + r]);
      if (!sameBits([row(0), row(1), row(2)], [rowN(0), rowN(1), rowN(2)])) distinguished++;
    }
    expect(distinguished).toBeGreaterThan(0);
  });
});
