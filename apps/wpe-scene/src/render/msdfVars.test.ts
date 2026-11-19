/**
 * MSDF 字形 pass 的 `g_RenderVar0..3`（P6f 点 5，`render/uniforms.ts` 的 `msdfRenderVars`，rea-p6f-msdf 4.2）。
 * - p6f-deco 抓帧（`ignore/p6/f0/out/rd/dump.json`，十一个对象）逐位相同：抓帧里只有着色器读到的几个才有值（没有 `RV3.yzw`：WPE 留残值、
 *   我们写 0，`font.frag` 不读，只比 `.x`）；
 * - 5.1 让位、6 的上限、NaN 与关着的开关：抓帧覆盖不到的分支（照汇编的算式，没有 WPE 真值）；
 * - `SceneState` 的装饰参数写入：只标脏图层、不标重排。
 */
import { describe, expect, it } from "vitest";
import { identity } from "./math";
import { msdfRenderVars, textUniformValues } from "./uniforms";
import type { LayerState } from "./state";
import { TEXT_DECOR_DEFAULTS, type TextDecor } from "../text/fields";

const f = Math.fround;
/** `5.1f` 在 exe 里是 0x40a33334（抓帧 d2 实测），不是 `Math.fround(5.1)`。 */
const LIMIT = 5.100000381469727;

type Spec = Partial<TextDecor> & { pointsize?: number };

/** p6f-deco 的十一个对象（`ignore/p6/f0/defs/p6f.py` 的 `p6f_deco`；开关之外的参数取缺省）。 */
const DECO: { spec: Spec; expected: Record<string, number[]> }[] = [
  {
    // d1：描边，白色
    spec: { outline: true, outlinecolor: [1, 1, 1] },
    expected: { RV0: [24, 0.9599999785423279, 0, 0], RV1: [1, 1, 1, 0] },
  },
  {
    // d2：厚度 40 被 5.1 截住
    spec: { outline: true, outlinethickness: 40, outlinecolor: [0, 0, 1] },
    expected: { RV0: [24, 5.100000381469727, 0, 0], RV1: [0, 0, 1, 0] },
  },
  {
    // d3：模糊 2
    spec: { blur: true, blursize: 2 },
    expected: { RV0: [24, 0, 0.47999998927116394, 0] },
  },
  {
    // d4：投影，白色
    spec: { dropshadow: true, dropshadowcolor: [1, 1, 1] },
    expected: {
      RV0: [24, 0, 0, 1.4399999380111694],
      RV1: [0, 0, 0, 0.9599999785423279],
      RV2: [1, 1, 1, 0.9599999785423279],
      RV3: [1],
    },
  },
  {
    // d5：负偏移不钳，大小 2
    spec: { dropshadow: true, dropshadowoffset: [-10, 20], dropshadowsize: 2, dropshadowcolor: [0, 1, 1] },
    expected: {
      RV0: [24, 0, 0, 0.47999998927116394],
      RV1: [0, 0, 0, -2.3999998569488525],
      RV2: [0, 1, 1, 4.799999713897705],
      RV3: [1],
    },
  },
  {
    // d6：三者同开
    spec: {
      outline: true,
      outlinethickness: 5,
      blur: true,
      blursize: 4,
      dropshadow: true,
      dropshadowcolor: [1, 1, 1],
      outlinecolor: [0, 0, 1],
    },
    expected: {
      RV0: [24, 1.1999999284744263, 0.9599999785423279, 1.4399999380111694],
      RV1: [0, 0, 1, 0.9599999785423279],
      RV2: [1, 1, 1, 0.9599999785423279],
      RV3: [1],
    },
  },
  {
    // d7：不透明度 1.5（不钳）
    spec: { dropshadow: true, dropshadowopacity: 1.5, dropshadowcolor: [1, 1, 1] },
    expected: {
      RV0: [24, 0, 0, 1.4399999380111694],
      RV1: [0, 0, 0, 0.9599999785423279],
      RV2: [1, 1, 1, 0.9599999785423279],
      RV3: [1.5],
    },
  },
  {
    // d8：只开 msdf，三个开关都关
    spec: {},
    expected: { RV0: [24, 0, 0, 0] },
  },
  {
    // d9：msdf + 描边
    spec: { outline: true, outlinecolor: [1, 1, 1] },
    expected: { RV0: [24, 0.9599999785423279, 0, 0], RV1: [1, 1, 1, 0] },
  },
  {
    // d10：12 磅的投影，s' = (32 / 12) · 0.24
    spec: { dropshadow: true, pointsize: 12, dropshadowcolor: [1, 1, 1] },
    expected: {
      RV0: [24, 0, 0, 3.8399999141693115],
      RV1: [0, 0, 0, 2.559999942779541],
      RV2: [1, 1, 1, 2.559999942779541],
      RV3: [1],
    },
  },
  {
    // d11：厚度 0.2 抬到下限 1
    spec: { outline: true, outlinethickness: 0.2, outlinecolor: [1, 1, 1] },
    expected: { RV0: [24, 0.23999999463558197, 0, 0], RV1: [1, 1, 1, 0] },
  },
];

function varsOf({ pointsize = 32, ...decor }: Spec) {
  return msdfRenderVars({ ...TEXT_DECOR_DEFAULTS, ...decor }, pointsize);
}

describe("msdfRenderVars：p6f-deco 抓帧逐位相同", () => {
  DECO.forEach(({ spec, expected }, i) => {
    it(`d${i + 1}`, () => {
      const vars = varsOf(spec);
      for (const [name, value] of Object.entries(expected)) {
        const actual = vars[`g_Render${name.replace("RV", "Var")}` as keyof typeof vars];
        // RV3 只比 .x；`toEqual` 对 -0 与 0 敏感，抓帧里没有 -0
        expect(actual.slice(0, value.length), `d${i + 1} ${name}`).toEqual(value);
      }
    });
  });
});

describe("msdfRenderVars：抓帧覆盖不到的分支（照汇编，无 WPE 真值）", () => {
  // 8 磅：s' = f32(f32(32 / 8) · f32(0.24))
  const s8 = f(f(32 / 8) * f(0.24));

  it("模糊与描边合计超过 5.1 时描边让位：y = max(5.1 − z, 0)", () => {
    const vars = varsOf({ pointsize: 8, outline: true, outlinethickness: 5, blur: true, blursize: 2 });
    const z = f(s8 * 2);
    // 描边先被 5.1 截住（5 · s' 恰为 4.8，未触顶），z + y > 5.1 才让位
    const y = f(s8 * 5);
    expect(f(z + y)).toBeGreaterThan(LIMIT);
    expect(vars.g_RenderVar0).toEqual([24, f(LIMIT - z), z, 0]);
  });

  it("模糊本身已超过 5.1 时描边归 0（5.1 − z 为负）", () => {
    const vars = varsOf({ pointsize: 8, outline: true, outlinethickness: 5, blur: true, blursize: 6 });
    expect(vars.g_RenderVar0[1]).toBe(0);
    expect(vars.g_RenderVar0[2]).toBe(f(s8 * 6));
  });

  it("不让位时描边保持：合计没超过 5.1", () => {
    const vars = varsOf({ pointsize: 32, outline: true, outlinethickness: 5, blur: true, blursize: 4 });
    expect(vars.g_RenderVar0[1]).toBe(f(f(f(32 / 32) * f(0.24)) * 5));
  });

  it("模糊、投影大小与偏移各自截在 6", () => {
    const vars = varsOf({
      pointsize: 4,
      blur: true,
      blursize: 6,
      dropshadow: true,
      dropshadowsize: 6,
      dropshadowoffset: [100, 100],
    });
    expect(vars.g_RenderVar0[2]).toBe(6);
    expect(vars.g_RenderVar0[3]).toBe(6);
    expect(vars.g_RenderVar1[3]).toBe(6);
    expect(vars.g_RenderVar2[3]).toBe(6);
  });

  it("开关关着的参数不生效：厚度 / 模糊 / 投影大小与偏移归 0，颜色与不透明度照拷", () => {
    const vars = varsOf({
      outlinethickness: 9,
      blursize: 9,
      dropshadowsize: 9,
      dropshadowoffset: [3, 3],
      outlinecolor: [0.25, 0.5, 0.75],
      dropshadowcolor: [0.5, 0.5, 0.5],
      dropshadowopacity: 0.5,
    });
    expect(vars.g_RenderVar0).toEqual([24, 0, 0, 0]);
    expect(vars.g_RenderVar1).toEqual([0.25, 0.5, 0.75, 0]);
    expect(vars.g_RenderVar2).toEqual([0.5, 0.5, 0.5, 0]);
    expect(vars.g_RenderVar3).toEqual([0.5, 0, 0, 0]);
  });

  it("开关开着时大小的下限：模糊、投影 0.01，描边 1", () => {
    const vars = varsOf({
      outline: true,
      outlinethickness: 0,
      blur: true,
      blursize: 0,
      dropshadow: true,
      dropshadowsize: -3,
      dropshadowoffset: [0, 0],
    });
    const s = f(f(32 / 32) * f(0.24));
    expect(vars.g_RenderVar0).toEqual([24, s, f(s * f(0.01)), f(s * f(0.01))]);
  });

  it("字号按排版钳过的值（调用方传 TextMesh.pointsize）：s' 随字号反比", () => {
    const small = varsOf({ pointsize: 16, dropshadow: true });
    const large = varsOf({ pointsize: 64, dropshadow: true });
    expect(small.g_RenderVar0[3]).toBe(f(f(f(32 / 16) * f(0.24)) * 6));
    expect(large.g_RenderVar0[3]).toBe(f(f(f(32 / 64) * f(0.24)) * 6));
  });

  it("NaN 保留（minss / `> 6` 对 NaN 的行为）", () => {
    const vars = varsOf({ outline: true, outlinethickness: NaN });
    expect(vars.g_RenderVar0[1]).toBeNaN();
  });
});

describe("textUniformValues：MSDF 字形写 g_RenderVar0..3 与图集尺寸", () => {
  const layer: LayerState = {
    origin: [0, 0, 0],
    scale: [1, 1, 1],
    angles: [0, 0, 0],
    alpha: 1,
    color: [1, 0, 0],
    brightness: 1,
    visible: true,
    parallaxDepth: [1, 1],
    parent: null,
  };
  const input = (part: "glyphs" | "background" | "color", msdf?: Parameters<typeof textUniformValues>[0]["msdf"]) => ({
    step: { part, space: "direct" as const },
    layer,
    layout: { mesh: null, padding: [0, 0], compositeSize: [4, 4] } as unknown as Parameters<
      typeof textUniformValues
    >[0]["layout"],
    world: identity(),
    viewProjection: identity(),
    constants: {},
    colorScale: 1,
    screenSize: [1920, 1080] as [number, number],
    // 槽 0 是 512 × 512 的 RGBA8 图集：g_Texture0Resolution = (W, H, W, H)（rea-p6f-msdf 3.1）
    textures: [{ width: 512, height: 512, textureWidth: 512, textureHeight: 512 }],
    eye: [960, 540, 2000],
    msdf,
  });

  it("字形 pass 带 msdf 时写四个 RenderVar 与 g_Texture0Resolution；背景、彩色字形与非 MSDF 不写", () => {
    const decor = { ...TEXT_DECOR_DEFAULTS, outline: true, outlinecolor: [1, 1, 1] as [number, number, number] };
    const values = textUniformValues(input("glyphs", { decor, pointsize: 32 }));
    expect(values.g_RenderVar0).toEqual(msdfRenderVars(decor, 32).g_RenderVar0);
    expect(values.g_RenderVar1).toEqual([1, 1, 1, 0]);
    expect(values.g_Texture0Resolution).toEqual([512, 512, 512, 512]);
    expect(values.g_Color4).toEqual([1, 0, 0, 1]);
    for (const other of [input("background", { decor, pointsize: 32 }), input("glyphs")])
      expect(textUniformValues(other).g_RenderVar0).toBeUndefined();
  });
});
