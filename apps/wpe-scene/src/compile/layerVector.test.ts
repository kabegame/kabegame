/**
 * 图层向量字段的取值（P6b 1e-3 复核）：`origin`、`scale`、`color`（vec3，`FUN_1401a4230`）与 `parallaxDepth`（vec2，`FUN_1401a3fc0`）
 * 和材质常量是 WPE 的同一组 setter：数字铺满各分量，字符串按空格读、少写的分量为 0，布尔 / null / 数组不写。
 * P1 起图层字段用 `numbers` 取，滑块属性（数字）绑 `scale` 只得一个分量、y / z 在建矩阵时补 1：`3836725625` 的「时钟大小」0.72
 * 让文字纵向拉长 1 / 0.72 倍（WPE 抓帧 `A:\p6b\e3text-s\`，Day 上屏高 125.5 = 154 × 1.13179 × 0.72）。
 * - `layerVectorValue` 与 `materialSetter` 逐值相同；
 * - 编译：绑数字铺满；属性值写不进（布尔、条件）时留 JSON 的 `value`，那个也写不进取缺省；
 * - 就地写 = 重编译：`SceneState.write` 的结果和用新属性整场编译的相同；写不进时字段不变、不标脏。
 */
import { describe, expect, it, vi } from "vitest";
import { layerVectorValue, LAYER_VECTOR_FIELDS, type LayerVectorField } from "./bindings";
import { compileScene, type SceneBundle } from "./bundle";
import type { SceneReader } from "./fs";
import { materialSetter } from "./materialValues";
import { TEXT_MATERIALS } from "./texts";
import { SceneState } from "../render/state";
import type { TranslateResult, Wpesl2wgsl } from "../wpesl2wgsl";

vi.mock("../fileUrl", () => ({ fileToUrl: (path: string) => path }));

const ASSETS = "A:/assets";
const FONT_PASS = { shader: "font", blending: "translucent", depthtest: "disabled", depthwrite: "disabled" };
/** 文本对象是最省事的图层：WPE 自带的四个材质照最小形状给，着色器是空的（假翻译器不看）。 */
const FILES: Record<string, unknown> = {
  [`${ASSETS}/${TEXT_MATERIALS.glyphs}`]: { passes: [FONT_PASS] },
  [`${ASSETS}/${TEXT_MATERIALS.color}`]: { passes: [{ ...FONT_PASS, combos: { COLORFONT: 1 } }] },
  [`${ASSETS}/${TEXT_MATERIALS.background}`]: { passes: [{ ...FONT_PASS, shader: "flat" }] },
  [`${ASSETS}/${TEXT_MATERIALS.clearAlpha}`]: {
    passes: [{ ...FONT_PASS, shader: "composelayer", textures: ["_rt_FullFrameBuffer"], combos: { CLEARALPHA: 1 } }],
  },
  ...Object.fromEntries(
    ["font", "flat", "composelayer"].flatMap((name) => [
      [`${ASSETS}/shaders/${name}.vert`, "void main(){}"],
      [`${ASSETS}/shaders/${name}.frag`, "void main(){}"],
    ]),
  ),
};

function memoryReader(files: Record<string, unknown>): SceneReader {
  const reader: SceneReader = {
    async readWhole(path) {
      const value = files[path.replace(/\\/g, "/")];
      if (value === undefined) throw new TypeError("Failed to fetch");
      return new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value));
    },
    async readRange(path, start, end) {
      return (await reader.readWhole(path)).slice(start, end);
    },
  };
  return reader;
}

const translator = {
  async translate(): Promise<TranslateResult> {
    return { ok: true, uniforms: [], textures: [], combos: [], attributes: [] } as unknown as TranslateResult;
  },
} as unknown as Wpesl2wgsl;

type Properties = Record<string, { type?: string; value: unknown }>;

/** 一个文本对象，`fields` 是要测的图层字段（原样进 scene.json）。 */
async function compile(fields: Record<string, unknown>, properties: Properties = {}): Promise<SceneBundle> {
  return compileScene({
    projectDir: "P:/p",
    sceneAssets: [ASSETS],
    reader: memoryReader({
      "P:/p/project.json": { file: "scene.json", general: { properties } },
      "P:/p/scene.json": {
        general: { orthogonalprojection: { width: 1920, height: 1080 } },
        objects: [{ id: 1, name: "T", text: "Ab", font: "systemfont_arial", pointsize: 32, ...fields }],
      },
      ...FILES,
    }),
    translator,
    postprocess: "disabled",
    exhaustive: true,
  });
}

const layerOf = (bundle: SceneBundle) => bundle.layers.find((layer) => layer.object === 0)!;
const FIELDS = Object.keys(LAYER_VECTOR_FIELDS) as LayerVectorField[];
/** 各字段在 scene.json 里写死时的样子（分量数对）。 */
const WRITTEN: Record<LayerVectorField, string> = {
  origin: "100 200 0",
  scale: "2 3 1",
  color: "1 0.5 0.25",
  parallaxDepth: "0.5 0.25",
};

describe("layerVectorValue：同 WPE 的向量 setter", () => {
  it("数字铺满；字符串少写的分量为 0、多写的不要；布尔 / null / 数组 / 对象不写", () => {
    expect(layerVectorValue("scale", 0.72)).toEqual([0.72, 0.72, 0.72]);
    expect(layerVectorValue("parallaxDepth", 0.5)).toEqual([0.5, 0.5]);
    expect(layerVectorValue("origin", "1 2")).toEqual([1, 2, 0]);
    expect(layerVectorValue("color", "1 0.5 0.25 9")).toEqual([1, 0.5, 0.25]);
    expect(layerVectorValue("scale", "2")).toEqual([2, 0, 0]);
    expect(layerVectorValue("scale", "")).toEqual([0, 0, 0]);
    for (const value of [true, false, null, undefined, [1, 2, 3], { value: 1 }]) {
      expect(layerVectorValue("scale", value), JSON.stringify(value)).toBeNull();
    }
  });

  it("和材质常量的 setter 逐值相同（同一组 WPE setter，共用 `setterValue`）", () => {
    const values = [0, 0.72, -3, 1e9, "1", "1 2", "1 2 3", "1 2 3 4", " 1  2", "1,2", "a b", "", true, null, [1, 2]];
    for (const field of FIELDS)
      for (const value of values) {
        expect(layerVectorValue(field, value), `${field} ${JSON.stringify(value)}`).toEqual(
          materialSetter(LAYER_VECTOR_FIELDS[field], value),
        );
      }
  });
});

describe("编译：向量字段绑标量属性", () => {
  it("3836725625 的形状：scale 绑滑块 0.72 → 三个分量都是 0.72（以前只得 [0.72]）", async () => {
    const bundle = await compile(
      { scale: { user: "clocksize", value: "0.72000 0.72000 0.72000" } },
      { clocksize: { type: "slider", value: 0.72 } },
    );
    expect(layerOf(bundle).scale).toEqual([0.72, 0.72, 0.72]);
  });

  it("四个字段绑数字都铺满；写死的字符串照读", async () => {
    for (const field of FIELDS) {
      const bound = await compile(
        { [field]: { user: "p", value: WRITTEN[field] } },
        { p: { type: "slider", value: 3 } },
      );
      expect(layerOf(bound)[field], field).toEqual(new Array(LAYER_VECTOR_FIELDS[field]).fill(3));
      const written = await compile({ [field]: WRITTEN[field] });
      expect(layerOf(written)[field], field).toEqual(WRITTEN[field].split(" ").map(Number));
    }
  });

  it("属性值写不进（布尔、条件换成的布尔）时留 JSON 的 value；value 也写不进时取缺省", async () => {
    const bool = await compile(
      { parallaxDepth: { user: "flag", value: "0.5 0.25" } },
      { flag: { type: "bool", value: true } },
    );
    expect(layerOf(bool).parallaxDepth).toEqual([0.5, 0.25]);
    const conditioned = await compile(
      { scale: { user: { name: "mode", condition: "a" }, value: "2 2 2" } },
      { mode: { type: "combo", value: "a" } },
    );
    expect(layerOf(conditioned).scale).toEqual([2, 2, 2]);
    const neither = await compile({ scale: { user: "flag", value: true } }, { flag: { type: "bool", value: true } });
    expect(layerOf(neither).scale).toEqual([1, 1, 1]);
  });
});

describe("就地写 = 重编译（SceneState.write）", () => {
  it("数字与字符串：写进的值和用新属性整场编译的相同，标脏", async () => {
    for (const field of FIELDS) {
      const fields = { [field]: { user: "p", value: WRITTEN[field] } };
      const bundle = await compile(fields, { p: { type: "slider", value: 1 } });
      const state = SceneState.fromBundle(bundle);
      const binding = bundle.bindings.find((item) => item.target.kind === "layer" && item.target.field === field)!;
      for (const raw of [0.72, "4 5"]) {
        state.takeDirty();
        expect(state.write(binding, raw)).toBe("applied");
        const recompiled = await compile(fields, { p: { type: "slider", value: raw } });
        expect(state.layers.get(0)![field], `${field} ${raw}`).toEqual(layerOf(recompiled)[field]);
        expect(state.takeDirty().layers.has(0)).toBe(true);
      }
    }
  });

  it("写不进（布尔）：字段不变、不标脏，同 WPE 的 setter 不改字段", async () => {
    const bundle = await compile({ scale: { user: "p", value: "2 2 2" } }, { p: { type: "slider", value: 0.5 } });
    const state = SceneState.fromBundle(bundle);
    const binding = bundle.bindings.find((item) => item.target.kind === "layer")!;
    state.takeDirty();
    expect(state.write(binding, true)).toBe("applied");
    expect(state.layers.get(0)!.scale).toEqual([0.5, 0.5, 0.5]);
    expect(state.takeDirty().layers.size).toBe(0);
  });
});
