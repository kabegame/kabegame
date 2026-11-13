/**
 * P8 步骤 1 的编译侧单测（`.claude/plans/wpe-import/3-scene/phase8/phase-8-image-material.md`「步骤 1」）：
 * - 能力表：对象 `clampuvs` / `nointerpolation` 的 JSON 布尔值放行（null 同没写）；绑属性、挂脚本、别的取值照报
 *   `object:clampuvs` / `object:nointerpolation`（WPE 运行中改这两位不重建合成 RT，rea-p8-layer §3，推断，没有实测）；
 * - 图层上的两个字段：`clampUVs` 缺省 true、只有 JSON false 才关，`noInterpolation` 缺省 false、只认 JSON true。WPE 基类构造给图层
 *   `+0x304` 置 bit15（clampuvs）、清 bit14（nointerpolation），之后只有对象 JSON（和脚本）写这两位，基础纹理 `.tex` 的标志不写
 *   （rea-p8-layer §3.1，p8-REPORT「合成 RT 与基础纹理的采样」）。
 * 合成 RT 按这两个字段怎么采样见 `render/p8.test.ts`。
 *
 * P8 步骤 2（同计划「步骤 2 — 形状对象」）：
 * - 能力表：形状对象（`isShapeObject`：`shape` 是字符串、没有别的内容）不再报 `object:shape`，`shape` 加 `image` 照报；`alignment`、
 *   `colorBlendMode`、`clampuvs`、`alpha` / `color` / `brightness` 中性，`perspective: true` 照报；组里的形状报
 *   `model:passthrough:children:shape`（rea-p8-layer 1.1、1.9）；
 * - 编译（`compileShape`）：`passes` 为空；`size` 缺省正交高 × 正交高（宽高不等的场景也是高）、`"300 200"`、数字铺满；effect 不看
 *   `visible` 全编（`enabled` 真、不登记开关的绑定）；`DIRECTDRAW` 实例写 0 也编成 1（看翻译请求），槽 0 不预留；点取第一个 effect、
 *   找不全为 null；`shape:*` 照报的四个键；`colorBlendMode` 非 0 不编 passthrough（rea-p8-layer 1.3–1.9，p8-REPORT 结论 4、5）；
 * - 本机有 WPE 时用真翻译器编 WPE 自带的 `lightshafts`（`p8-shape` 的 S1、S4、S9、S10）：点、`DIRECTDRAW`、四边形与 RenderDoc 的
 *   `vs_in` 逐位相同。
 * 渲染图、四边形与矩阵见 `render/p8.test.ts`。
 *
 * P8 步骤 3（同计划「步骤 3 — 对齐」，rea-p8-layer 2.1、2.4，p8-REPORT 结论 6，补测 `p8-align2`）：
 * - `alignmentIndex`：9 个名字按 WPE 枚举表取下标；大小写不对、数字、`{user, value}`、null 等一律 0（`center`）；
 * - 能力表：图像层 8 种取值都不报（不再有 `object:alignment`），别的对象中性；图像层上挂 `{script}` 报 `object:alignment:script`；
 *   fullscreen 图层带非 center 的对齐报 `object:alignment:fullscreen`；脚本 API 表不再有 `layer.alignment`；
 * - 编译：图像层填 `SceneLayer.alignment`（绑属性、数字为 0，不登记绑定），别的对象不填。
 * 偏移、矩阵、四边形与脚本读写见 `render/p8.test.ts`。
 *
 * P8 步骤 4（同计划「步骤 4 — 图层依赖」，rea-p8-render 第 1、2 节，p8-REPORT「图层依赖」与结论 7–9、12）：
 * - `dependencyIds`：数组、对象取值、重复、负数 / 小数 / 字符串 / null 跳过、模型对象列的也算；`layerCompositeName`；棋盘格逐像素、标志与采样；
 * - 能力表：`dependencies` 不再报 `object:dependencies`，粒子对象有不是数字的元素报 `particle:dependencies`；
 * - 编译：名字解析（被依赖 → `layerComposites`；没被依赖、不存在、`_b`、不是图像层 → 棋盘格，整场一张；`bind` 的槽不动；注解 `default`
 *   同样）、`TEX<n>FORMAT`（LDR 0；HDR 下经依赖置位 0、自带 `0x10` 且在前 14、在后 0）、照报的四键、被依赖时编 `passthrough`
 *   （`BLENDMODE` 0 / cbm）、`lighting:prelighting`、`dependedOn`。
 * 渲染图、独占 RT 与编码见 `render/p8.test.ts`。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ALIGNMENTS, alignmentIndex, alignmentName } from "./alignment";
import { compileScene, SHAPE_POINT_CONSTANTS, shapeLayerSize, shapePoints, type SceneLayer } from "./bundle";
import { checkerTexture, dependencyIds, LAYER_COMPOSITE_PREFIX, layerCompositeName } from "./dependencies";
import {
  checkObjectFeatures,
  checkSceneFeatures,
  groupChildIssues,
  isShapeObject,
  shapeIssues,
  textureSlotRead,
} from "./features";
import type { SceneReader } from "./fs";
import type { SceneObject } from "./model";
import { MISSING_SCRIPT_API, scanScriptApi } from "./scriptApi";
import { TEX_FLAGS } from "./tex";
import { shapeQuad } from "../render/layout";
import {
  Wpesl2wgsl,
  type TextureBinding,
  type TranslateRequest,
  type TranslateResult,
  type UniformLayout,
} from "../wpesl2wgsl";

vi.mock("../fileUrl", () => ({ fileToUrl: (path: string) => path }));

// ———— 能力表 ————

function objectKeys(object: SceneObject): string[] {
  const keys = new Set<string>();
  checkObjectFeatures(object, keys);
  return [...keys].sort();
}
const image = (extra: Record<string, unknown>): SceneObject => ({ id: 1, image: "models/a.json", ...extra });

describe("能力表：clampuvs / nointerpolation（P8 步骤 1）", () => {
  it.each(["clampuvs", "nointerpolation"])("%s：JSON true / false 不报，null 同没写", (key) => {
    expect(objectKeys(image({ [key]: true }))).toEqual([]);
    expect(objectKeys(image({ [key]: false }))).toEqual([]);
    expect(objectKeys(image({ [key]: null }))).toEqual([]);
    expect(objectKeys(image({ clampuvs: true, nointerpolation: true }))).toEqual([]);
    expect(objectKeys(image({ clampuvs: false, nointerpolation: false }))).toEqual([]);
  });

  it.each(["clampuvs", "nointerpolation"])(
    "%s：绑属性、挂脚本、写成 1 / 0 / 字符串照报（只报一次，不另报成未知键）",
    (key) => {
      const reported = [`object:${key}`];
      expect(objectKeys(image({ [key]: { user: "p", value: true } }))).toEqual(reported);
      expect(objectKeys(image({ [key]: { user: "p", value: false } }))).toEqual(reported);
      expect(objectKeys(image({ [key]: { script: "export function update(v) { return v; }", value: true } }))).toEqual(
        reported,
      );
      expect(objectKeys(image({ [key]: 1 }))).toEqual(reported);
      expect(objectKeys(image({ [key]: 0 }))).toEqual(reported);
      expect(objectKeys(image({ [key]: "true" }))).toEqual(reported);
    },
  );

  it("两个键各报各的", () => {
    expect(objectKeys(image({ clampuvs: { user: "a", value: true }, nointerpolation: "true" }))).toEqual([
      "object:clampuvs",
      "object:nointerpolation",
    ]);
    expect(objectKeys(image({ clampuvs: true, nointerpolation: 1 }))).toEqual(["object:nointerpolation"]);
  });

  it("没有基础纹理的对象同一规则（rea-p8-layer §3.3）：分组节点、文本上的 JSON 布尔值不报", () => {
    expect(objectKeys({ id: 1, name: "group", clampuvs: true, nointerpolation: false })).toEqual([]);
    expect(objectKeys({ id: 1, text: "a", clampuvs: true })).toEqual([]);
    expect(objectKeys({ id: 1, text: "a", clampuvs: { user: "p", value: true } })).toEqual(["object:clampuvs"]);
  });

  it("整场检查：写了这两个键的场景（语料的 15 + 3 张都是 JSON 布尔）不再报", () => {
    const keys = new Set<string>();
    checkSceneFeatures(
      {
        general: { orthogonalprojection: { width: 1920, height: 1080 } },
        objects: [
          { id: 1, image: "models/a.json", origin: "960 540 0", clampuvs: true },
          { id: 2, image: "models/a.json", origin: "960 540 0", nointerpolation: true },
        ],
      },
      keys,
    );
    expect([...keys]).toEqual([]);
  });
});

// ———— 编译：图层上的两个字段 ————

function memoryReader(files: Record<string, Uint8Array | string>): SceneReader {
  const bytes = (path: string) => {
    const value = files[path.replace(/\\/g, "/")];
    if (value === undefined) throw new TypeError("Failed to fetch");
    return typeof value === "string" ? new TextEncoder().encode(value) : value;
  };
  return {
    async readWhole(path) {
      return bytes(path);
    },
    async readRange(path, start, end) {
      return bytes(path).slice(start, end);
    },
  };
}

function parts(...buffers: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(buffers.reduce((sum, bytes) => sum + bytes.length, 0));
  let at = 0;
  for (const bytes of buffers) {
    out.set(bytes, at);
    at += bytes.length;
  }
  return out;
}
const u32 = (value: number) => {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, true);
  return out;
};
const magic = (text: string) => parts(new TextEncoder().encode(text), new Uint8Array([0]));
/** RGBA8 单 mip 的 `.tex`（TEXB0002），64×64，`flags` 是头里的标志字（`TEX_FLAGS`）。 */
function tex(flags: number): Uint8Array {
  const size = 64;
  const data = new Uint8Array(size * size * 4);
  return parts(
    magic("TEXV0005"),
    magic("TEXI0001"),
    u32(0),
    u32(flags),
    u32(size),
    u32(size),
    u32(size),
    u32(size),
    u32(0),
    magic("TEXB0002"),
    u32(1),
    u32(1),
    u32(size),
    u32(size),
    u32(0),
    u32(data.length),
    u32(data.length),
    data,
  );
}

/** 假翻译器：一律成功、没有接口，不依赖 wasm。 */
const translator = {
  async translate() {
    return { ok: true, uniforms: [], textures: [], combos: [] };
  },
} as unknown as Wpesl2wgsl;

/** 一组对象；`models/a.json` 是普通图像层，基础纹理的 `.tex` 标志由 `texFlags` 给（缺省 0）。 */
async function compileObjects(objects: Record<string, unknown>[], texFlags = 0) {
  return compileScene({
    projectDir: "P:/p",
    sceneAssets: ["A:/assets"],
    reader: memoryReader({
      "P:/p/project.json": JSON.stringify({ file: "scene.json" }),
      "P:/p/scene.json": JSON.stringify({ general: { orthogonalprojection: { width: 1920, height: 1080 } }, objects }),
      "P:/p/models/a.json": JSON.stringify({ material: "materials/a.json" }),
      "P:/p/materials/a.json": JSON.stringify({ passes: [{ shader: "s", textures: ["a"] }] }),
      "P:/p/materials/a.tex": tex(texFlags),
      "P:/p/shaders/s.vert": "void main() {}",
      "P:/p/shaders/s.frag": "void main() {}",
    }),
    translator,
    postprocess: "disabled",
    exhaustive: true,
  });
}
const object = (id: number, extra: Record<string, unknown> = {}) => ({
  id,
  image: "models/a.json",
  origin: "960 540 0",
  ...extra,
});
const flagsOf = (bundle: Awaited<ReturnType<typeof compileObjects>>) =>
  bundle.layers.map(({ clampUVs, noInterpolation }) => [clampUVs, noInterpolation]);

describe("compileScene：图层的 clampUVs / noInterpolation（P8 步骤 1）", () => {
  it("缺省 clampUVs 真、noInterpolation 假（WPE 基类构造 +0x304 = 0x8040）；JSON true / false 照取，不报", async () => {
    const bundle = await compileObjects([
      object(1),
      object(2, { clampuvs: true }),
      object(3, { clampuvs: false }),
      object(4, { nointerpolation: true }),
      object(5, { nointerpolation: false }),
      object(6, { clampuvs: true, nointerpolation: true }),
      object(7, { clampuvs: false, nointerpolation: false }),
      object(8, { clampuvs: null, nointerpolation: null }),
    ]);
    expect(bundle.unsupported).toEqual([]);
    expect(flagsOf(bundle)).toEqual([
      [true, false],
      [true, false],
      [false, false],
      [true, true],
      [true, false],
      [true, true],
      [false, false],
      [true, false],
    ]);
  });

  it("基础纹理的 .tex 标志不写图层的两位（只管基础纹理自己的采样器）", async () => {
    const all = TEX_FLAGS.clampUVs | TEX_FLAGS.noInterpolation;
    const bundle = await compileObjects([object(1), object(2, { clampuvs: false })], all);
    expect(bundle.unsupported).toEqual([]);
    expect(bundle.textures[0]).toMatchObject({ clampUVs: true, noInterpolation: true });
    expect(flagsOf(bundle)).toEqual([
      [true, false],
      [false, false],
    ]);
    // 纹理标志 0：图层照样缺省钳制
    expect(flagsOf(await compileObjects([object(1)]))).toEqual([[true, false]]);
  });

  it("非布尔值：照报，图层按缺省取（clampuvs 只有 JSON false 才关，nointerpolation 只认 JSON true）", async () => {
    const bundle = await compileObjects([
      object(1, { clampuvs: 0, nointerpolation: 1 }),
      object(2, { clampuvs: { user: "p", value: false }, nointerpolation: { user: "q", value: true } }),
    ]);
    expect(bundle.unsupported).toEqual(["object:clampuvs", "object:nointerpolation"]);
    expect(flagsOf(bundle)).toEqual([
      [true, false],
      [true, false],
    ]);
  });

  it("分组节点同样填（用不到，无害）", async () => {
    const bundle = await compileObjects([
      { id: 1, name: "group", origin: "0 0 0", clampuvs: false, nointerpolation: true },
      { id: 2, name: "group2", origin: "0 0 0" },
    ]);
    expect(bundle.unsupported).toEqual([]);
    expect(flagsOf(bundle)).toEqual([
      [false, true],
      [true, false],
    ]);
  });
});

// ———— P8 步骤 2：形状对象 ————

/** 形状对象（`ignore/p8/gen_p8.py` 的 `shape`）：`effects` 为 undefined 时不写这个键。 */
const shapeObject = (id: number, effects: unknown[] | undefined, extra: Record<string, unknown> = {}): SceneObject => ({
  id,
  name: `S${id}`,
  origin: "480 540 0",
  shape: "quad",
  ...(effects ? { effects } : {}),
  ...extra,
});

describe("能力表：形状对象（P8 步骤 2）", () => {
  const shape = (extra: Record<string, unknown> = {}) =>
    shapeObject(11, [{ file: "effects/lightshafts/effect.json" }], extra);

  it("认法：shape 是字符串（不比较取值）、没有图像 / 模型 / 粒子 / 声音 / 文本 / 灯的内容", () => {
    expect(isShapeObject(shape())).toBe(true);
    expect(isShapeObject(shape({ shape: "circle" }))).toBe(true);
    expect(isShapeObject(shape({ shape: "" }))).toBe(true);
    expect(isShapeObject(shape({ shape: 1 }))).toBe(false);
    expect(isShapeObject(shape({ image: "models/a.json" }))).toBe(false);
    expect(isShapeObject(shape({ particle: "particles/a.json" }))).toBe(false);
    expect(isShapeObject(shape({ text: "a" }))).toBe(false);
    expect(isShapeObject(shape({ sound: ["sounds/a.mp3"] }))).toBe(false);
    expect(isShapeObject({ id: 1, name: "group", origin: "0 0 0" })).toBe(false);
  });

  it("形状对象不再报 object:shape；同时带图像等内容、shape 不是字符串时照未知键报", () => {
    expect(objectKeys(shape())).toEqual([]);
    expect(objectKeys(shape({ shape: "circle" }))).toEqual([]);
    expect(objectKeys(shape({ image: "models/a.json" }))).toEqual(["object:shape"]);
    expect(objectKeys(shape({ shape: 1 }))).toEqual(["object:shape"]);
  });

  it("中性（rea-p8-layer 1.9）：alignment、colorBlendMode、clampuvs / nointerpolation、alpha / color / brightness、visible 绑属性等", () => {
    expect(
      objectKeys(
        shape({
          alignment: "bottom",
          colorBlendMode: 5,
          clampuvs: true,
          nointerpolation: true,
          alpha: 0.5,
          color: "1 0 0",
          brightness: 2,
          visible: { user: { name: "display", condition: "2" }, value: false },
          parallaxDepth: "0 0",
          angles: "0 0 -2.9",
          scale: "2.9 2 1",
          parent: 5,
          size: "300 200",
          disablepropagation: false,
          castshadow: false,
        }),
      ),
    ).toEqual([]);
    // 对齐在形状（与文本）上不在属性查找链上；图像层步骤 3 起已实现，也不报
    expect(objectKeys(image({ alignment: "bottom" }))).toEqual([]);
  });

  it("perspective: true 照报 object:perspective（只放行图像层与模型）", () => {
    expect(objectKeys(shape({ perspective: true }))).toEqual(["object:perspective"]);
  });

  it("组里的形状：groupChildIssues 报 model:passthrough:children:shape", () => {
    const layer = {
      passthroughModel: false,
      passes: [],
      effects: [],
      colorBlendMode: 0,
      fullscreen: false,
      perspective: false,
      particle: null,
    };
    expect(groupChildIssues({ ...layer, shape: { points: null } })).toEqual(["model:passthrough:children:shape"]);
    expect(groupChildIssues({ ...layer, shape: null })).toEqual([]);
    expect(groupChildIssues(layer)).toEqual([]);
  });
});

/** `p8-shape` 的点（`p_shape`，S1–S10 共用）与 `p8-shape2` 的 p2（`p_shape2`）；值是 JSON 字符串按 double 解析的结果。 */
const P1 = {
  point0: "0.24560 0.09457",
  point1: "0.85704 0.06238",
  point2: "0.94690 0.66185",
  point3: "0.07415 0.95000",
};
const P1_VALUES = [
  [0.2456, 0.09457],
  [0.85704, 0.06238],
  [0.9469, 0.66185],
  [0.07415, 0.95],
];
const P2 = { point0: "0.3 0.2", point1: "0.7 0.3", point2: "0.6 0.8", point3: "0.2 0.7" };
const P2_VALUES = [
  [0.3, 0.2],
  [0.7, 0.3],
  [0.6, 0.8],
  [0.2, 0.7],
];

/** 顶点着色器读的 `g_Point0`–`g_Point3`（lightshafts 的写法：`vec2`，注解 `material` 是 `point0`–`point3`）。 */
const pointUniform = (i: number, extra: Partial<UniformLayout> = {}): UniformLayout => ({
  name: `g_Point${i}`,
  type: "vec2<f32>",
  declared: "vec2",
  offset: 64 + i * 16,
  size: 8,
  meta: { material: SHAPE_POINT_CONSTANTS[i] },
  ...extra,
});
const POINTS = [0, 1, 2, 3].map((i) => pointUniform(i));
const engineUniform = (name: string, declared: string, extra: Partial<UniformLayout> = {}): UniformLayout => ({
  name,
  type: declared === "float" ? "f32" : `${declared}<f32>`,
  declared,
  offset: 0,
  size: 16,
  ...extra,
});
/**
 * 槽 0 的纹理：声明了（反射里总有，绑定号 1）。真翻译器在 `DIRECTDRAW = 1` 时给 lightshafts 的输出就是「只有声明」（P8 步骤 2 实测），
 * `TEX0_SAMPLED` 是片元里真的采样的写法（照 `DIRECTDRAW = 0` 的输出）。
 */
const TEX0: TextureBinding = { slot: 0, name: "g_Texture0", kind: "2d", binding: 1, samplerBinding: 2 };
const TEX0_DECLARED =
  "@group(0) @binding(1) \nvar g_Texture0_: texture_2d<f32>;\n@group(0) @binding(2) \nvar kb_sampler_g_Texture0_: sampler;\n";
const TEX0_SAMPLED = `${TEX0_DECLARED}@fragment\nfn main() -> @location(0) vec4<f32> {\n    let _e58 = textureSample(g_Texture0_, kb_sampler_g_Texture0_, vec2(0.5));\n    return _e58;\n}\n`;

/** 假翻译器的程序，按着色器名（顶点源码 `// <名字>`）。`ls` 仿 `DIRECTDRAW = 1` 的 lightshafts：读四个点，槽 0 只有声明。 */
const SHAPE_SHADERS: Record<string, Partial<TranslateResult>> = {
  ls: { uniforms: POINTS, textures: [TEX0], fragment: { wgsl: TEX0_DECLARED } },
  // 程序没声明 point3：四个点找不全
  lsnop3: { uniforms: POINTS.slice(0, 3), textures: [TEX0], fragment: { wgsl: TEX0_DECLARED } },
  // point3 只有注解缺省
  lsdef: {
    uniforms: [...POINTS.slice(0, 3), pointUniform(3, { meta: { material: "point3", default: "0.5 0.25" } })],
    textures: [TEX0],
    fragment: { wgsl: TEX0_DECLARED },
  },
  // 读引擎的 g_Color4；g_Alpha 没被读；g_Color 带 material（材质常量，WPE 照材质写）
  lscolor: {
    uniforms: [
      ...POINTS,
      engineUniform("g_Color4", "vec4"),
      engineUniform("g_Alpha", "float", { unused: true }),
      engineUniform("g_Color", "vec3", { meta: { material: "color" } }),
    ],
    textures: [TEX0],
    fragment: { wgsl: TEX0_DECLARED },
  },
  // 片元真的采样槽 0
  lstex0: { uniforms: POINTS, textures: [TEX0], fragment: { wgsl: TEX0_SAMPLED } },
};

/**
 * 一个 lightshafts 那样的 effect 实例（`gen_p8.py` 的 `shafts`）。`effect` 选 effect.json：`SHAPE_SHADERS` 的名字各一个单 pass 的 effect，
 * 另有 `ls2`（两个绘制 pass）、`lsfbo`（带一张 fbo）、`lsstatic`（材质给槽 0 静态纹理、程序采样槽 0）。`combos: null` 时不写 combos。
 */
function shafts(
  id: number,
  options: {
    effect?: string;
    points?: Record<string, string>;
    combos?: Record<string, number> | null;
    visible?: unknown;
  } = {},
) {
  return {
    file: `effects/${options.effect ?? "ls"}/effect.json`,
    id,
    name: "",
    visible: options.visible ?? true,
    passes: [
      {
        ...(options.combos === null
          ? {}
          : { combos: options.combos ?? { DIRECTDRAW: 1, RAYCORNER: 1, RAYMODE: 2, RENDERING: 1 } }),
        constantshadervalues: { ...(options.points ?? P1), rayspeed: 0 },
        id: id + 1,
      },
    ],
  };
}

/** 编一组对象（内存工程 + 记录请求的假翻译器）。`models/a.json` 是普通图像层，`models/compose.json` 是组合层。 */
async function compileShapes(
  objects: Record<string, unknown>[],
  general: Record<string, unknown> = { orthogonalprojection: { width: 1920, height: 1080 } },
) {
  const requests: TranslateRequest[] = [];
  const fake = {
    async translate(request: TranslateRequest): Promise<TranslateResult> {
      requests.push(request);
      const name = /^\/\/ (\S+)/.exec(request.vertex)?.[1] ?? "";
      return { ok: true, uniforms: [], textures: [], combos: [], ...SHAPE_SHADERS[name] };
    },
  } as unknown as Wpesl2wgsl;
  const files: Record<string, Uint8Array | string> = {
    "P:/p/project.json": JSON.stringify({ file: "scene.json" }),
    "P:/p/scene.json": JSON.stringify({ general, objects }),
    "P:/p/models/a.json": JSON.stringify({ material: "materials/a.json" }),
    "P:/p/models/compose.json": JSON.stringify({ material: "materials/a.json", passthrough: true }),
    "P:/p/materials/a.json": JSON.stringify({ passes: [{ shader: "s", textures: ["a"] }] }),
    "P:/p/materials/a.tex": tex(0),
    "P:/p/materials/t0.tex": tex(0),
    "P:/p/shaders/s.vert": "// s",
    "P:/p/shaders/s.frag": "// s",
  };
  const effect = (name: string, json: Record<string, unknown>) => {
    files[`P:/p/effects/${name}/effect.json`] = JSON.stringify(json);
  };
  const material = (name: string, pass: Record<string, unknown>) => {
    files[`P:/p/materials/effects/${name}.json`] = JSON.stringify({
      passes: [{ blending: "normal", depthtest: "disabled", depthwrite: "disabled", cullmode: "nocull", ...pass }],
    });
  };
  for (const name of Object.keys(SHAPE_SHADERS)) {
    effect(name, { passes: [{ material: `materials/effects/${name}.json` }] });
    material(name, { shader: `effects/${name}` });
    files[`P:/p/shaders/effects/${name}.vert`] = `// ${name}`;
    files[`P:/p/shaders/effects/${name}.frag`] = `// ${name}`;
  }
  effect("ls2", { passes: [{ material: "materials/effects/ls.json" }, { material: "materials/effects/ls.json" }] });
  effect("lsfbo", {
    fbos: [{ name: "_rt_x", scale: 1, format: "rgba8888" }],
    passes: [{ material: "materials/effects/ls.json" }],
  });
  effect("lsstatic", { passes: [{ material: "materials/effects/lsstatic.json" }] });
  material("lsstatic", { shader: "effects/lstex0", textures: ["t0"] });
  const bundle = await compileScene({
    projectDir: "P:/p",
    sceneAssets: ["A:/assets"],
    reader: memoryReader(files),
    translator: fake,
    postprocess: "disabled",
    exhaustive: true,
  });
  return { bundle, requests };
}
const byName = (layers: readonly SceneLayer[], name: string) => layers.find((layer) => layer.name === name)!;

describe("compileScene：形状对象（P8 步骤 2）", () => {
  it("编进图层：passes 为空、没有 passthrough，effect 当开着编，点取实例的常量，不报；别的对象 shape 为 null", async () => {
    const { bundle } = await compileShapes([
      shapeObject(11, [shafts(100)]),
      { id: 20, name: "img", image: "models/a.json", origin: "960 540 0" },
      { id: 30, name: "group", origin: "0 0 0" },
    ]);
    expect(bundle.unsupported).toEqual([]);
    const layer = byName(bundle.layers, "S11");
    expect(layer.passes).toEqual([]);
    expect(layer.passthrough).toBeNull();
    expect(layer.shape).toEqual({ points: P1_VALUES });
    expect(layer.effects.map(({ source, enabled, visibleBound }) => [source, enabled, visibleBound])).toEqual([
      [0, true, false],
    ]);
    expect(layer.effects[0].steps.map((step) => step.kind)).toEqual(["draw"]);
    expect(byName(bundle.layers, "img").shape).toBeNull();
    expect(byName(bundle.layers, "group").shape).toBeNull();
  });

  it("size：缺省正交高 × 正交高（宽高不等的场景也取高，不是宽 × 高），字符串按它，数字铺满两维", async () => {
    const objects = [
      shapeObject(11, [shafts(100)]),
      shapeObject(12, [shafts(110)], { size: "300 200" }),
      shapeObject(13, [shafts(120)], { size: 250 }),
    ];
    const sizes = async (general?: Record<string, unknown>) =>
      (await compileShapes(objects, general)).bundle.layers.map((layer) => layer.size);
    expect(await sizes()).toEqual([
      [1080, 1080],
      [300, 200],
      [250, 250],
    ]);
    expect(await sizes({ orthogonalprojection: { width: 2560, height: 1440 } })).toEqual([
      [1440, 1440],
      [300, 200],
      [250, 250],
    ]);
  });

  it("size 绑用户属性：取属性当前值，登记成重编译（同图像层）", async () => {
    const { bundle } = await compileShapes([
      shapeObject(11, [shafts(100)], { size: { user: "sz", value: "300 200" } }),
    ]);
    expect(bundle.layers[0].size).toEqual([300, 200]);
    expect(bundle.bindings.filter((binding) => binding.property === "sz").map((binding) => binding.target)).toEqual([
      { kind: "recompile", reason: "layer-structure", path: "objects/0/size" },
    ]);
  });

  it("shapeLayerSize：字符串缺的分量保持正交高，别的类型不写（推断，语料 0 个）", () => {
    expect(shapeLayerSize(undefined, 1080)).toEqual([1080, 1080]);
    expect(shapeLayerSize("300", 1080)).toEqual([300, 1080]);
    expect(shapeLayerSize("300 200 7", 1080)).toEqual([300, 200]);
    expect(shapeLayerSize(true, 1080)).toEqual([1080, 1080]);
    expect(shapeLayerSize(Number.NaN, 1080)).toEqual([1080, 1080]);
  });

  it("effect 不看 visible：写死不可见、绑属性的都编进来、enabled 为真，不登记 effect 开关的绑定（p8-shape2 的 SB、SC）", async () => {
    const { bundle } = await compileShapes([
      shapeObject(11, [shafts(100), shafts(102, { visible: false })]),
      shapeObject(12, [shafts(110, { visible: false })]),
      shapeObject(13, [shafts(120, { visible: { user: "fx", value: false } })]),
    ]);
    expect(bundle.unsupported).toEqual([]);
    expect(
      bundle.layers.map((layer) =>
        layer.effects.map(({ source, enabled, visibleBound }) => [source, enabled, visibleBound]),
      ),
    ).toEqual([
      [
        [0, true, false],
        [1, true, false],
      ],
      [[0, true, false]],
      [[0, true, false]],
    ]);
    expect(bundle.bindings.filter((binding) => binding.target.kind === "effect")).toEqual([]);
  });

  it("DIRECTDRAW：实例写 0、没写 combos 都编成 1（写在实例覆盖之后，p8-shape 的 S9）；槽 0 不预留；普通图像层的 effect 不改", async () => {
    const { bundle, requests } = await compileShapes([
      shapeObject(11, [shafts(100, { combos: { DIRECTDRAW: 0, RAYMODE: 2 } })]),
      shapeObject(12, [shafts(110, { combos: null })]),
      {
        id: 20,
        image: "models/a.json",
        origin: "960 540 0",
        effects: [shafts(200, { combos: { DIRECTDRAW: 0, RAYMODE: 7 } })],
      },
    ]);
    expect(bundle.unsupported).toEqual([]);
    const ls = requests.filter((request) => request.vertex === "// ls");
    const image = ls.filter((request) => request.combos?.RAYMODE === 7);
    const shapes = ls.filter((request) => request.combos?.RAYMODE !== 7);
    // 普通图像层：照实例的 0，槽 0 预留给合成 RT
    expect(image.map((request) => [request.combos?.DIRECTDRAW, request.textures?.some((t) => t.slot === 0)])).toEqual([
      [0, true],
    ]);
    expect(shapes.map((request) => [request.combos?.DIRECTDRAW, request.textures?.some((t) => t.slot === 0)])).toEqual([
      [1, false],
      [1, false],
    ]);
  });

  it("点：取第一个 effect 第一个绘制 pass 的常量（画的是最后一个，p8-shape2 的 SA）；注解缺省也算；找不全为 null", async () => {
    const { bundle } = await compileShapes([
      shapeObject(11, [shafts(100, { points: P2 }), shafts(102)]),
      shapeObject(12, [shafts(110, { effect: "lsnop3" })]),
      // 第一个找不全、最后一个全：仍是 null（几何只看第一个）
      shapeObject(13, [shafts(120, { effect: "lsnop3" }), shafts(122)]),
      shapeObject(14, [
        shafts(130, { effect: "lsdef", points: { point0: P1.point0, point1: P1.point1, point2: P1.point2 } }),
      ]),
    ]);
    expect(bundle.unsupported).toEqual([]);
    expect(bundle.layers.map((layer) => layer.shape?.points)).toEqual([
      P2_VALUES,
      null,
      null,
      [...P1_VALUES.slice(0, 3), [0.5, 0.25]],
    ]);
  });

  it("shapePoints：第一个 effect 没有绘制 pass 或程序时为 null；值不足两项的那格不算", () => {
    const draw = (program: number | null, uniforms: Record<string, number[]>) => ({
      kind: "draw" as const,
      pass: {
        key: "k",
        program,
        blending: "normal",
        cullmode: "nocull",
        depthtest: "disabled",
        depthwrite: "disabled",
        textures: {},
        runtime: {},
        uniforms,
        framebuffer: false,
      },
      target: null,
      compose: false,
      binds: null,
    });
    const effect = (steps: SceneLayer["effects"][number]["steps"]) =>
      ({
        source: 0,
        id: 0,
        name: "",
        file: "",
        fbos: [],
        steps,
        enabled: true,
        visibleBound: false,
        unsupported: [],
      }) as SceneLayer["effects"][number];
    const values = { g_Point0: [0.1, 0.2], g_Point1: [0.3, 0.4], g_Point2: [0.5, 0.6], g_Point3: [0.7, 0.8] };
    const programs = [{ uniforms: POINTS }];
    expect(shapePoints({ effects: [effect([draw(0, values)])] }, programs)).toEqual([
      [0.1, 0.2],
      [0.3, 0.4],
      [0.5, 0.6],
      [0.7, 0.8],
    ]);
    expect(shapePoints({ effects: [] }, programs)).toBeNull();
    expect(shapePoints({ effects: [effect([{ kind: "copy", source: "a", target: "b" }])] }, programs)).toBeNull();
    expect(shapePoints({ effects: [effect([draw(null, values)])] }, programs)).toBeNull();
    expect(shapePoints({ effects: [effect([draw(0, { ...values, g_Point3: [0.7] })])] }, programs)).toBeNull();
    // 绘制步骤前面有命令：取第一个绘制步骤
    expect(
      shapePoints({ effects: [effect([{ kind: "copy", source: "a", target: "b" }, draw(0, values)])] }, programs)?.[3],
    ).toEqual([0.7, 0.8]);
  });

  it("照报 shape:effects：没有 effect（空列表或没写）", async () => {
    for (const effects of [[], undefined]) {
      const { bundle } = await compileShapes([shapeObject(11, effects)]);
      expect(bundle.unsupported).toEqual(["shape:effects"]);
      expect(bundle.layers[0].shape).toEqual({ points: null });
    }
  });

  it("照报 shape:effect-passes：最后一个 effect 有两个绘制 pass、或有 fbo；前面的 effect 不查（永远不画）", async () => {
    const unsupported = async (effects: unknown[]) =>
      (await compileShapes([shapeObject(11, effects)])).bundle.unsupported;
    expect(await unsupported([shafts(100, { effect: "ls2" })])).toEqual(["shape:effect-passes"]);
    expect(await unsupported([shafts(100, { effect: "lsfbo" })])).toEqual(["shape:effect-passes"]);
    expect(await unsupported([shafts(100, { effect: "ls2" }), shafts(102)])).toEqual([]);
  });

  it("照报 shape:uniform:<名字>：画的程序读 WPE 不写的引擎 uniform（没被读的、带 material 的不算），只看最后一个 effect", async () => {
    const unsupported = async (effects: unknown[]) =>
      (await compileShapes([shapeObject(11, effects)])).bundle.unsupported;
    expect(await unsupported([shafts(100, { effect: "lscolor" })])).toEqual(["shape:uniform:g_Color4"]);
    expect(await unsupported([shafts(100, { effect: "lscolor" }), shafts(102)])).toEqual([]);
  });

  it("照报 shape:texture0：画的程序读槽 0 而材质没给纹理；只声明不读、材质给了静态纹理都不报（槽 0 照常编成静态纹理）", async () => {
    const unsupported = async (effects: unknown[]) =>
      (await compileShapes([shapeObject(11, effects)])).bundle.unsupported;
    expect(await unsupported([shafts(100, { effect: "lstex0" })])).toEqual(["shape:texture0"]);
    expect(await unsupported([shafts(100, { effect: "lstex0" }), shafts(102)])).toEqual([]);
    const { bundle } = await compileShapes([
      shapeObject(11, [shafts(100, { effect: "lsstatic" })]),
      shapeObject(12, [shafts(110)]),
    ]);
    expect(bundle.unsupported).toEqual([]);
    expect(bundle.layers[0].effects[0].steps[0]).toMatchObject({ kind: "draw", pass: { textures: { 0: 0 } } });
    expect(bundle.textures[0].path).toBe("materials/t0.tex");
  });

  it("colorBlendMode 非 0 不编 passthrough；对齐、alpha、color、brightness、clampuvs 中性：不报", async () => {
    const { bundle } = await compileShapes([
      shapeObject(11, [shafts(100)], {
        colorBlendMode: 5,
        alignment: "bottom",
        alpha: 0.5,
        color: "1 0 0",
        brightness: 2,
        clampuvs: true,
      }),
    ]);
    expect(bundle.unsupported).toEqual([]);
    expect(bundle.layers[0].passthrough).toBeNull();
  });

  it("perspective: true 照报 object:perspective，图层不取它", async () => {
    const { bundle } = await compileShapes([shapeObject(11, [shafts(100)], { perspective: true })]);
    expect(bundle.unsupported).toEqual(["object:perspective"]);
    expect(bundle.layers[0].perspective).toBe(false);
  });

  it("组里的形状照报 model:passthrough:children:shape", async () => {
    const { bundle } = await compileShapes([
      { id: 1, name: "group", image: "models/compose.json", origin: "960 540 0", size: "400 400" },
      shapeObject(11, [shafts(100)], { parent: 1 }),
    ]);
    expect(byName(bundle.layers, "S11").group).toBe(0);
    expect(bundle.unsupported).toContain("model:passthrough:children:shape");
  });
});

describe("shapeIssues / textureSlotRead（P8 步骤 2）", () => {
  it("textureSlotRead：没有这个槽为假；没有 WGSL（手写数据）按读了；只有声明为假；任一阶段引用为真", () => {
    expect(textureSlotRead({ textures: [] }, 0)).toBe(false);
    expect(textureSlotRead({ textures: [TEX0] }, 1)).toBe(false);
    expect(textureSlotRead({ textures: [TEX0] }, 0)).toBe(true);
    expect(textureSlotRead({ textures: [TEX0], fragment: { wgsl: TEX0_DECLARED } }, 0)).toBe(false);
    expect(
      textureSlotRead({ textures: [TEX0], vertex: { wgsl: TEX0_DECLARED }, fragment: { wgsl: TEX0_SAMPLED } }, 0),
    ).toBe(true);
    expect(
      textureSlotRead({ textures: [TEX0], vertex: { wgsl: TEX0_SAMPLED }, fragment: { wgsl: TEX0_DECLARED } }, 0),
    ).toBe(true);
    // 名字是别的标识符的前缀（`g_Texture0_` 与 `g_Texture0_x`）不算引用
    expect(
      textureSlotRead({ textures: [TEX0], fragment: { wgsl: `${TEX0_DECLARED}var<private> g_Texture0_x: f32;\n` } }, 0),
    ).toBe(false);
  });

  it("shapeIssues：只看最后一个 effect；程序缺失时只查结构", () => {
    const pass = (program: number | null, textures: Record<number, number> = {}) => ({
      key: "k",
      program,
      blending: "normal",
      cullmode: "nocull",
      depthtest: "disabled",
      depthwrite: "disabled",
      textures,
      runtime: {},
      uniforms: {},
      framebuffer: false,
    });
    const effect = (program: number | null, extra: Partial<SceneLayer["effects"][number]> = {}) =>
      ({
        source: 0,
        id: 0,
        name: "",
        file: "",
        fbos: [],
        steps: [{ kind: "draw", pass: pass(program), target: null, compose: false, binds: null }],
        enabled: true,
        visibleBound: false,
        unsupported: [],
        ...extra,
      }) as SceneLayer["effects"][number];
    const programs: TranslateResult[] = [
      { ok: true, uniforms: POINTS, textures: [TEX0], fragment: { wgsl: TEX0_DECLARED } },
      { ok: true, uniforms: [engineUniform("g_Alpha", "float")], textures: [TEX0], fragment: { wgsl: TEX0_SAMPLED } },
    ];
    expect(shapeIssues({ effects: [] }, programs)).toEqual(["shape:effects"]);
    expect(shapeIssues({ effects: [effect(0)] }, programs)).toEqual([]);
    expect(shapeIssues({ effects: [effect(1)] }, programs).sort()).toEqual(["shape:texture0", "shape:uniform:g_Alpha"]);
    expect(shapeIssues({ effects: [effect(1), effect(0)] }, programs)).toEqual([]);
    expect(shapeIssues({ effects: [effect(null)] }, programs)).toEqual([]);
    expect(shapeIssues({ effects: [effect(0, { steps: [] })] }, programs)).toEqual(["shape:effect-passes"]);
    expect(
      shapeIssues({ effects: [effect(0, { steps: [{ kind: "copy", source: "a", target: "b" }] })] }, programs),
    ).toEqual(["shape:effect-passes"]);
  });
});

// ———— 真翻译器：WPE 自带的 lightshafts（本机有 WPE 时） ————

const wasm = join(__dirname, "..", "wpesl2wgsl", "wpesl2wgsl.wasm");
const root = process.env.KABEGAME_WPE_ROOT;
const lightshafts = join(root ?? "", "assets", "effects", "lightshafts", "effect.json");

/** 内存里的工程文件盖在磁盘之上（其余路径照常读 WPE 安装目录，同 `stageUniforms.test.ts`）。 */
function overlayReader(files: Record<string, string>): SceneReader {
  const own = (path: string) => {
    const text = files[path.replace(/\\/g, "/")];
    return text === undefined ? null : new TextEncoder().encode(text);
  };
  const disk = (path: string) => {
    try {
      return new Uint8Array(readFileSync(path));
    } catch {
      throw new TypeError("Failed to fetch");
    }
  };
  return {
    async readWhole(path) {
      return own(path) ?? disk(path);
    },
    async readRange(path, start, end) {
      const bytes = own(path) ?? disk(path);
      if (start >= bytes.length) throw new TypeError("Failed to fetch");
      return bytes.slice(start, end);
    },
  };
}

/** `p8-shape` 的 lightshafts 实例（`gen_p8.py` 的 `shafts`：`colorastart` 各不相同、`rayspeed` / `noiseamount` 为 0）。 */
const wpeShafts = (
  id: number,
  colorastart: string,
  combos: Record<string, number> = { DIRECTDRAW: 1, RAYCORNER: 1, RAYMODE: 2, RENDERING: 1 },
) => ({
  file: "effects/lightshafts/effect.json",
  id,
  name: "",
  visible: true,
  passes: [
    {
      combos,
      constantshadervalues: {
        colorastart,
        colorend: "0.4 0.9 1",
        colorwexponent: 1,
        colorwintensity: 1,
        noiseamount: 0,
        noisescale: 0.85,
        ...P1,
        rayfeather: "0.22 0.1",
        rayradius: 0.15,
        rayscale: "0.4 1.01",
        raysmoothness: 0.54,
        rayspeed: 0,
      },
      id: id + 1,
    },
  ],
});

/**
 * `p8-shape` S1、S10 两次绘制的 `vs_in`（`ignore/p8/out/dump.json`，`A:\p8\p8-shape-fps20\p8-shape-fps20-frame157.rdc` 事件 67、227；
 * 索引 (0, 2, 1, 0, 3, 2) 展开前的四个顶点），按 p0–p3。
 */
const WPE_S1 = [
  [-274.75201416015625, 437.86444091796875],
  [385.60321044921875, 472.62957763671875],
  [482.65203857421875, -174.7979736328125],
  [-459.9179992675781, -486.0],
];
const WPE_S10 = [
  [-76.31999969482422, 81.08599853515625],
  [107.11199951171875, 87.52400207519531],
  [134.07000732421875, -32.3699951171875],
  [-127.75499725341797, -90.0],
];

describe.skipIf(!root || !existsSync(wasm) || !existsSync(lightshafts))(
  "真翻译器：WPE 自带的 lightshafts（p8-shape）",
  () => {
    it("S1、S4、S9、S10：不报；点取实例常量、DIRECTDRAW 编成 1、最后一个 effect 的变体；四边形与 RenderDoc 的 vs_in 逐位相同", async () => {
      const translator = await Wpesl2wgsl.fromBytes(readFileSync(wasm));
      const objects = [
        shapeObject(1, [wpeShafts(100, "1 0 0")]),
        shapeObject(4, [
          wpeShafts(130, "1 1 0"),
          wpeShafts(132, "1 0 1", { DIRECTDRAW: 1, RAYCORNER: 1, RAYMODE: 1, RENDERING: 1 }),
        ]),
        shapeObject(9, [wpeShafts(180, "0 0 0.5", { DIRECTDRAW: 0, RAYCORNER: 1, RAYMODE: 2, RENDERING: 1 })]),
        shapeObject(10, [wpeShafts(190, "0.75 0.25 0")], { size: "300 200" }),
      ];
      const bundle = await compileScene({
        projectDir: "P:/p",
        sceneAssets: [join(root!, "assets")],
        reader: overlayReader({
          "P:/p/project.json": JSON.stringify({ file: "scene.json" }),
          "P:/p/scene.json": JSON.stringify({
            general: { orthogonalprojection: { width: 1920, height: 1080 } },
            objects,
          }),
        }),
        translator,
        postprocess: "disabled",
        exhaustive: true,
      });
      expect(bundle.unsupported).toEqual([]);
      const combo = (layer: SceneLayer, effect: number, name: string) => {
        const step = layer.effects[effect].steps[0];
        if (step.kind !== "draw" || step.pass.program === null) throw new Error("没有程序");
        return bundle.programs[step.pass.program].combos?.find((item) => item.name === name)?.value;
      };
      for (const layer of bundle.layers) {
        expect(layer.shape?.points, layer.name).toEqual(P1_VALUES);
        expect(shapeIssues(layer, bundle.programs), layer.name).toEqual([]);
        for (const e of layer.effects.keys()) expect(combo(layer, e, "DIRECTDRAW"), layer.name).toBe(1);
        // DIRECTDRAW = 1 的 lightshafts 不读槽 0（反射里照样声明了）
        const step = layer.effects.at(-1)!.steps[0];
        if (step.kind === "draw")
          expect(textureSlotRead(bundle.programs[step.pass.program!], 0), layer.name).toBe(false);
      }
      const [s1, s4, , s10] = bundle.layers;
      expect([combo(s4, 0, "RAYMODE"), combo(s4, 1, "RAYMODE")]).toEqual([2, 1]);
      expect([s1.size, s10.size]).toEqual([
        [1080, 1080],
        [300, 200],
      ]);
      // 带的顺序是 [p1, p0, p2, p3]
      const corners = (layer: SceneLayer) => {
        const [v1, v0, v2, v3] = shapeQuad(layer.size, layer.shape!.points).map((vertex) =>
          vertex.position.slice(0, 2),
        );
        return [v0, v1, v2, v3];
      };
      expect(corners(s1)).toEqual(WPE_S1);
      expect(corners(s10)).toEqual(WPE_S10);
    });
  },
);

// ———— P8 步骤 3：对齐 ————

describe("alignmentIndex / alignmentName（P8 步骤 3，rea-p8-layer 2.1）", () => {
  it("9 个名字按 WPE 枚举表 0x1404e97f0 的顺序取下标，名字读回同一个", () => {
    expect(ALIGNMENTS).toEqual([
      "center",
      "top",
      "topright",
      "right",
      "bottomright",
      "bottom",
      "bottomleft",
      "left",
      "topleft",
    ]);
    ALIGNMENTS.forEach((name, index) => {
      expect(alignmentIndex(name), name).toBe(index);
      expect(alignmentName(index)).toBe(name);
    });
  });

  it("查不到或不是字符串一律 center：大小写不对、空串、数字（p8-align2 的 N）、{user, value}（U）、null / undefined", () => {
    for (const value of ["TopLeft", "TOP", " top", "", "middle", 3, 0, 8, true, null, undefined, ["top"]])
      expect(alignmentIndex(value), JSON.stringify(value)).toBe(0);
    expect(alignmentIndex({ user: "alignprop", value: "topleft" })).toBe(0);
    expect(alignmentIndex({ script: "export function update(v) { return v; }", value: "topleft" })).toBe(0);
  });

  it("alignmentName：表外的下标（含 undefined、小数、负数）按 center", () => {
    for (const index of [undefined, -1, 9, 1.5]) expect(alignmentName(index)).toBe("center");
  });
});

describe("能力表：对齐（P8 步骤 3）", () => {
  it("图像层：8 种取值都不报（语料 24 张、158 个对象都是字符串）；绑属性、写数字、查不到的名字按 center，也不报", () => {
    for (const name of ALIGNMENTS) expect(objectKeys(image({ alignment: name })), name).toEqual([]);
    expect(objectKeys(image({ alignment: { user: "alignprop", value: "topleft" } }))).toEqual([]);
    expect(objectKeys(image({ alignment: 3 }))).toEqual([]);
    expect(objectKeys(image({ alignment: "TopLeft" }))).toEqual([]);
  });

  it("别的对象不在对齐的查找链上，中性：分组节点、文本、形状、粒子（只看对齐这一键）", () => {
    expect(objectKeys({ id: 1, name: "group", origin: "0 0 0", alignment: "topleft" })).toEqual([]);
    expect(objectKeys({ id: 1, text: "a", alignment: "topleft" })).toEqual([]);
    expect(
      objectKeys(shapeObject(11, [{ file: "effects/lightshafts/effect.json" }], { alignment: "topleft" })),
    ).toEqual([]);
    const particle = (extra: Record<string, unknown>) => objectKeys({ id: 1, particle: "particles/p.json", ...extra });
    expect(particle({ alignment: "topleft" })).toEqual(particle({}));
  });

  it("图像层上挂 {script}：照报 object:alignment:script（字段脚本写回枚举没有实现）；别的对象上不报", () => {
    const script = { script: "export function update(v) { return v; }", value: "topleft" };
    expect(objectKeys(image({ alignment: script }))).toEqual(["object:alignment:script"]);
    expect(objectKeys({ id: 1, text: "a", alignment: script })).toEqual([]);
  });

  it("整场检查：带对齐的图像层不再报", () => {
    const keys = new Set<string>();
    checkSceneFeatures(
      {
        general: { orthogonalprojection: { width: 1920, height: 1080 } },
        objects: ALIGNMENTS.map((alignment, id) => ({ id, image: "models/a.json", origin: "960 540 0", alignment })),
      },
      keys,
    );
    expect([...keys]).toEqual([]);
  });

  it("脚本 API 表不再有 layer.alignment（图像层上已实现，script/api.ts）：thisLayer.alignment 读写不报", () => {
    expect(MISSING_SCRIPT_API.layer.some((entry) => entry.name === "alignment")).toBe(false);
    const source = "export function update(v) { thisLayer.alignment = 'topleft'; return thisLayer.alignment; }";
    expect(scanScriptApi({ source, owner: { kind: "layer" }, layer: 0 })).toEqual([]);
  });
});

/** `models/a.json` 普通图像层，`models/fs.json` 是 fullscreen（P5b 步骤 3），`models/auto.json` 是 autosize（槽 0 的 64×64）。 */
async function compileAligned(objects: Record<string, unknown>[], userProperties: Record<string, unknown> = {}) {
  return compileScene({
    projectDir: "P:/p",
    sceneAssets: ["A:/assets"],
    reader: memoryReader({
      "P:/p/project.json": JSON.stringify({
        file: "scene.json",
        general: { properties: { alignprop: { order: 1, text: "alignprop", type: "textinput", value: "topleft" } } },
      }),
      "P:/p/scene.json": JSON.stringify({ general: { orthogonalprojection: { width: 1920, height: 1080 } }, objects }),
      "P:/p/models/a.json": JSON.stringify({ material: "materials/a.json" }),
      "P:/p/models/fs.json": JSON.stringify({ material: "materials/a.json", fullscreen: true }),
      "P:/p/models/auto.json": JSON.stringify({ material: "materials/a.json", autosize: true }),
      "P:/p/materials/a.json": JSON.stringify({ passes: [{ shader: "s", textures: ["a"] }] }),
      "P:/p/materials/a.tex": tex(0),
      "P:/p/shaders/s.vert": "void main() {}",
      "P:/p/shaders/s.frag": "void main() {}",
    }),
    translator,
    postprocess: "disabled",
    exhaustive: true,
    userProperties,
  });
}

describe("compileScene：图层的 alignment（P8 步骤 3）", () => {
  it("图像层填下标（9 种）；绑属性（U）与数字（N）为 0，不登记绑定；分组节点不填", async () => {
    const bundle = await compileAligned([
      ...ALIGNMENTS.map((alignment, i) => object(i + 1, { alignment })),
      object(20, { name: "U", alignment: { user: "alignprop", value: "topleft" } }),
      object(21, { name: "N", alignment: 3 }),
      object(22, { name: "plain" }),
      { id: 23, name: "group", origin: "0 0 0", alignment: "topleft" },
    ]);
    expect(bundle.unsupported).toEqual([]);
    expect(bundle.layers.map((layer) => layer.alignment)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 0, 0, 0, undefined]);
    expect(bundle.bindings.some((binding) => binding.property === "alignprop")).toBe(false);
    // 属性当前值换成别的字符串也一样（setter 没有绑定分支，不按属性值求）
    const changed = await compileAligned([object(1, { alignment: { user: "alignprop", value: "topleft" } })], {
      alignprop: { type: "textinput", value: "bottom" },
    });
    expect(changed.layers[0].alignment).toBe(0);
  });

  it("形状层不填（不在它的查找链上）", async () => {
    const { bundle } = await compileShapes([shapeObject(11, [shafts(100)], { alignment: "bottom" })]);
    expect(bundle.unsupported).toEqual([]);
    expect(bundle.layers[0].alignment).toBeUndefined();
  });

  it("fullscreen 图层带非 center 的对齐照报 object:alignment:fullscreen；center、绑属性、数字（都按 center）不报", async () => {
    const fs = (id: number, alignment: unknown) => ({ id, image: "models/fs.json", origin: "960 540 0", alignment });
    expect((await compileAligned([fs(1, "topleft")])).unsupported).toEqual(["object:alignment:fullscreen"]);
    expect((await compileAligned([fs(1, "bottom")])).unsupported).toEqual(["object:alignment:fullscreen"]);
    for (const alignment of ["center", { user: "alignprop", value: "topleft" }, 3])
      expect((await compileAligned([fs(1, alignment)])).unsupported, JSON.stringify(alignment)).toEqual([]);
  });

  it("尺寸是 autosize 之后的（偏移按它算，render/state.ts）：autosize 取槽 0 的 64×64，对象 size 不算", async () => {
    const bundle = await compileAligned([
      { id: 1, image: "models/auto.json", origin: "960 540 0", size: "300 200", alignment: "topleft" },
    ]);
    expect(bundle.unsupported).toEqual([]);
    expect(bundle.layers[0]).toMatchObject({ alignment: 8, size: [64, 64] });
  });
});

// ———— P8 步骤 4：图层依赖 ————

const composite = (id: number, suffix = "a") => `${LAYER_COMPOSITE_PREFIX}${id}_${suffix}`;
const YELLOW = [255, 255, 0, 255];
const BLACK = [0, 0, 0, 255];

describe("dependencyIds / layerCompositeName / checkerTexture（P8 步骤 4，rea-p8-render 1.1、2.1、2.6）", () => {
  it("并集：数组、对象取值都收，重复只算一次；负数、小数、字符串、null、布尔、对象元素跳过；不是数组 / 对象的值等于没写；模型、粒子对象列的数字也算", () => {
    const ids = dependencyIds([
      { id: 1, image: "models/a.json", dependencies: [10, 11, 10] },
      { id: 2, image: "models/a.json", dependencies: { a: 12, b: 11 } },
      { id: 3, image: "models/a.json", dependencies: [-1, 1.5, "13", null, true, { id: 14 }, 15] },
      { id: 4, model: "models/m.mdl", dependencies: [16] },
      { id: 5, particle: "particles/p.json", dependencies: [{ id: 17, type: "emitterimage", index: 0 }, 18] },
      { id: 6, image: "models/a.json", dependencies: 19 },
      { id: 7, image: "models/a.json", dependencies: "20" },
      { id: 8, image: "models/a.json" },
    ]);
    expect([...ids].sort((a, b) => a - b)).toEqual([10, 11, 12, 15, 16, 18]);
  });

  it("名字：前缀 + 十进制 id + `_a`（后缀写死，没有 `_b`）", () => {
    expect(LAYER_COMPOSITE_PREFIX).toBe("_rt_imageLayerComposite_");
    expect(layerCompositeName(16613)).toBe("_rt_imageLayerComposite_16613_a");
    expect(layerCompositeName(0)).toBe("_rt_imageLayerComposite_0_a");
  });

  it("棋盘格：6×6 RGBA8 一级 mip，(0, 0) 黑、(1, 0) 黄、(0, 1) 黄，逐行黑黄交替（p8-dep 的 4–6）；标志 9、重复、点采样", () => {
    const texture = checkerTexture();
    expect(texture).toMatchObject({
      format: 0,
      width: 6,
      height: 6,
      textureWidth: 6,
      textureHeight: 6,
      flags: 9,
      clampUVs: false,
      noInterpolation: true,
    });
    expect(texture.mips.map((mip) => [mip.width, mip.height, mip.bytes?.length])).toEqual([[6, 6, 144]]);
    expect(texture.encoded).toBeUndefined();
    expect(texture.video).toBeUndefined();
    const bytes = texture.mips[0].bytes!;
    const pixel = (x: number, y: number) => Array.from(bytes.slice((y * 6 + x) * 4, (y * 6 + x) * 4 + 4));
    expect(pixel(0, 0)).toEqual(BLACK);
    expect(pixel(1, 0)).toEqual(YELLOW);
    expect(pixel(0, 1)).toEqual(YELLOW);
    expect(pixel(1, 1)).toEqual(BLACK);
    // 整张：K 黑、Y 黄，只有这两种颜色
    const rows = [0, 1, 2, 3, 4, 5].map((y) =>
      [0, 1, 2, 3, 4, 5]
        .map((x) => {
          const value = pixel(x, y);
          return JSON.stringify(value) === JSON.stringify(YELLOW)
            ? "Y"
            : JSON.stringify(value) === JSON.stringify(BLACK)
              ? "K"
              : "?";
        })
        .join(""),
    );
    expect(rows).toEqual(["KYKYKY", "YKYKYK", "KYKYKY", "YKYKYK", "KYKYKY", "YKYKYK"]);
  });

  it("棋盘格每次新建像素缓冲（bundle 交给主线程时会转移 mip 的缓冲）", () => {
    expect(checkerTexture().mips[0].bytes!.buffer).not.toBe(checkerTexture().mips[0].bytes!.buffer);
  });
});

describe("能力表：dependencies（P8 步骤 4）", () => {
  it("各种对象上都中性（只进并集）：图像层、分组节点、文本、模型、粒子的数字元素都不报；不再有 object:dependencies", () => {
    expect(objectKeys(image({ dependencies: [2, 3] }))).toEqual([]);
    // 图像层上写成对象元素：WPE 的基类跳过，中性
    expect(objectKeys(image({ dependencies: [{ id: 2 }] }))).toEqual([]);
    expect(objectKeys({ id: 1, name: "group", origin: "0 0 0", dependencies: [2] })).toEqual([]);
    expect(objectKeys({ id: 1, text: "a", dependencies: [2] })).toEqual([]);
    const model = (extra: Record<string, unknown>) => objectKeys({ id: 1, model: "models/m.mdl", ...extra });
    expect(model({ dependencies: [2] })).toEqual(model({}));
    const particle = (extra: Record<string, unknown>) => objectKeys({ id: 1, particle: "particles/p.json", ...extra });
    expect(particle({ dependencies: [2, 3] })).toEqual(particle({}));
    const keys = new Set<string>();
    checkSceneFeatures(
      {
        general: { orthogonalprojection: { width: 1920, height: 1080 } },
        objects: [
          { id: 1, image: "models/a.json", origin: "960 540 0", visible: false },
          { id: 2, image: "models/a.json", origin: "960 540 0", dependencies: [1] },
          { id: 3, name: "group", origin: "0 0 0", dependencies: [1, 2] },
        ],
      },
      keys,
    );
    expect([...keys]).toEqual([]);
  });

  it("粒子对象的 dependencies 有不是数字的元素：particle:dependencies（发射图 / 碰撞模型依赖没做）", () => {
    const particle = (extra: Record<string, unknown>) => objectKeys({ id: 1, particle: "particles/p.json", ...extra });
    const base = particle({});
    const reported = [...base, "particle:dependencies"].sort();
    expect(particle({ dependencies: [{ id: 2, type: "emitterimage", index: 0, mask: "" }] })).toEqual(reported);
    expect(particle({ dependencies: [2, "3"] })).toEqual(reported);
    expect(particle({ dependencies: { a: { id: 2, type: "collisionmodel" } } })).toEqual(reported);
    expect(particle({ dependencies: [] })).toEqual(base);
  });
});

/** 纹理槽的反射（翻译器 `textures` 的一项），绑定号按 `1 + 2n`。 */
const textureSlot = (slot: number, meta?: Record<string, unknown>): TextureBinding => ({
  slot,
  name: `g_Texture${slot}`,
  kind: "2d",
  binding: 1 + 2 * slot,
  samplerBinding: 2 + 2 * slot,
  ...(meta ? { meta } : {}),
});

/** 步骤 4 的假翻译器程序（按着色器名，顶点源码 `// <名字>`）。 */
const DEP_SHADERS: Record<string, Partial<TranslateResult>> = {
  s: { textures: [textureSlot(0)] },
  // 开了光照的基础材质（`usesLighting`）
  lit: { textures: [textureSlot(0)], combos: [{ name: "LIGHTING", value: 1, source: "request" }] },
  // effect：槽 0–3 由实例 `textures` 给
  ref: { textures: [0, 1, 2, 3].map((slot) => textureSlot(slot)) },
  // effect：槽 1、2 只有注解缺省
  refdef: {
    textures: [textureSlot(0), textureSlot(1, { default: composite(10) }), textureSlot(2, { default: composite(99) })],
  },
  // passthrough 上屏（WPE 的 `effectpassthrough.json`）
  genericimage3: { textures: [textureSlot(0)] },
};
const EFFECT_SHADERS = ["ref", "refdef"];

/**
 * 一组对象（内存工程 + 记录请求的假翻译器）。`models/a.json` 普通图像层（translucent，槽 0 是 64×64 的 `a`），`models/lit.json` 开光照，
 * `models/compose.json` 组合层；effect `ref`（槽 0–3 由实例 `textures` 给）、`refbind`（同一个材质，槽 1 是 `bind` 的 `previous`）、
 * `refdef`（槽 1、2 只有注解缺省）；passthrough 材质是 `effectpassthrough.json`（`genericimage3`）。
 */
async function compileDeps(
  objects: Record<string, unknown>[],
  options: { general?: Record<string, unknown>; postprocess?: "disabled" | "ultra" } = {},
) {
  const requests: TranslateRequest[] = [];
  const fake = {
    async translate(request: TranslateRequest): Promise<TranslateResult> {
      requests.push(request);
      const name = /^\/\/ (\S+)/.exec(request.vertex)?.[1] ?? "";
      return { ok: true, uniforms: [], textures: [], combos: [], ...DEP_SHADERS[name] };
    },
  } as unknown as Wpesl2wgsl;
  const files: Record<string, Uint8Array | string> = {
    "P:/p/project.json": JSON.stringify({ file: "scene.json" }),
    "P:/p/scene.json": JSON.stringify({
      general: { orthogonalprojection: { width: 1920, height: 1080 }, ...options.general },
      objects,
    }),
    "P:/p/models/a.json": JSON.stringify({ material: "materials/a.json" }),
    "P:/p/models/lit.json": JSON.stringify({ material: "materials/lit.json" }),
    "P:/p/models/compose.json": JSON.stringify({ material: "materials/a.json", passthrough: true }),
    "P:/p/materials/a.json": JSON.stringify({ passes: [{ shader: "s", blending: "translucent", textures: ["a"] }] }),
    "P:/p/materials/lit.json": JSON.stringify({
      passes: [{ shader: "lit", blending: "translucent", textures: ["a"] }],
    }),
    "P:/p/materials/a.tex": tex(0),
    "P:/p/materials/util/effectpassthrough.json": JSON.stringify({
      passes: [{ shader: "genericimage3", blending: "normal", depthtest: "disabled", depthwrite: "disabled" }],
    }),
  };
  for (const name of Object.keys(DEP_SHADERS)) {
    const path = EFFECT_SHADERS.includes(name) ? `effects/${name}` : name;
    files[`P:/p/shaders/${path}.vert`] = `// ${name}`;
    files[`P:/p/shaders/${path}.frag`] = `// ${name}`;
  }
  const effectMaterial = (shader: string) =>
    JSON.stringify({
      passes: [{ shader, blending: "normal", depthtest: "disabled", depthwrite: "disabled", cullmode: "nocull" }],
    });
  files["P:/p/materials/effects/ref.json"] = effectMaterial("effects/ref");
  files["P:/p/materials/effects/refdef.json"] = effectMaterial("effects/refdef");
  files["P:/p/effects/ref/effect.json"] = JSON.stringify({ passes: [{ material: "materials/effects/ref.json" }] });
  files["P:/p/effects/refbind/effect.json"] = JSON.stringify({
    passes: [{ material: "materials/effects/ref.json", bind: [{ name: "previous", index: 1 }] }],
  });
  files["P:/p/effects/refdef/effect.json"] = JSON.stringify({
    passes: [{ material: "materials/effects/refdef.json" }],
  });
  const bundle = await compileScene({
    projectDir: "P:/p",
    sceneAssets: ["A:/assets"],
    reader: memoryReader(files),
    translator: fake,
    postprocess: options.postprocess ?? "disabled",
    exhaustive: true,
  });
  return { bundle, requests };
}
/** 普通图像层（`models/a.json`）。 */
const imageObject = (id: number, name: string, extra: Record<string, unknown> = {}) => ({
  id,
  name,
  image: "models/a.json",
  origin: "960 540 0",
  ...extra,
});
/** 一个 effect 实例：`textures` 覆盖材质的槽位（null 保留材质自己的）。 */
const refEffect = (textures: (string | null)[], file = "ref") => ({
  file: `effects/${file}/effect.json`,
  id: 500,
  name: file,
  visible: true,
  passes: [{ textures }],
});
/** 图层第 `e` 个 effect 的第一个绘制 pass。 */
function effectPass(layer: SceneLayer, e = 0) {
  const step = layer.effects[e]?.steps[0];
  if (step?.kind !== "draw") throw new Error(`${layer.name} 的 effect ${e} 没有绘制 pass`);
  return step.pass;
}
const checkerOf = (bundle: { textures: readonly { path: string }[] }) =>
  bundle.textures.flatMap((texture, index) => (texture.path === "<checker>" ? [index] : []));

describe("compileScene：图层依赖的名字解析（P8 步骤 4，rea-p8-render 2.1、2.6）", () => {
  it("被依赖的图像层 → layerComposites（不进 runtime / textures）；没被依赖、id 不存在、_b、不是图像层 → 棋盘格，整场一张；不报 texture:rendertarget", async () => {
    const { bundle } = await compileDeps([
      imageObject(10, "A", { visible: false }),
      // 70 是分组节点：列进 dependencies 也不是图像层
      imageObject(20, "B", { dependencies: [10, 70], effects: [refEffect([null, composite(10)])] }),
      imageObject(30, "C", {
        effects: [refEffect([null, composite(40), composite(99), composite(10, "b")])],
      }),
      imageObject(40, "D"),
      { id: 70, name: "G", origin: "0 0 0" },
      imageObject(80, "H", { effects: [refEffect([null, composite(70)])] }),
    ]);
    expect(bundle.unsupported).toEqual([]);
    // 图像层填 dependedOn，分组节点不填
    expect(bundle.layers.map((layer) => layer.dependedOn)).toEqual([true, false, false, false, undefined, false]);
    const b = effectPass(byName(bundle.layers, "B"));
    expect(b.layerComposites).toEqual({ 1: 0 });
    expect(b.textures[1]).toBeUndefined();
    expect(b.runtime).toEqual({});
    const [checker, ...more] = checkerOf(bundle);
    expect(more).toEqual([]);
    expect(bundle.textures[checker]).toEqual(checkerTexture());
    const c = effectPass(byName(bundle.layers, "C"));
    expect(c.textures).toEqual({ 1: checker, 2: checker, 3: checker });
    expect(c.layerComposites).toBeUndefined();
    expect(effectPass(byName(bundle.layers, "H")).textures).toEqual({ 1: checker });
    // 别的 pass 不带这个键
    expect("layerComposites" in byName(bundle.layers, "A").passes[0]).toBe(false);
  });

  it("没有引用不到的名字时不加棋盘格", async () => {
    const { bundle } = await compileDeps([
      imageObject(10, "A", { visible: false }),
      imageObject(20, "B", { dependencies: [10], effects: [refEffect([null, composite(10)])] }),
    ]);
    expect(checkerOf(bundle)).toEqual([]);
  });

  it("bind 占了的槽不动（bind 胜出，rea-p8-render 第 3 节）：自己读自己的 _a 写在 bind 槽上也不报 dependency:self", async () => {
    const { bundle } = await compileDeps([
      imageObject(10, "A", { dependencies: [10], effects: [refEffect([null, composite(10)], "refbind")] }),
      imageObject(20, "B", { effects: [refEffect([null, composite(99)], "refbind")] }),
    ]);
    expect(bundle.unsupported).toEqual([]);
    for (const layer of bundle.layers) {
      const pass = effectPass(layer);
      expect(pass.layerComposites, layer.name).toBeUndefined();
      expect(pass.textures[1], layer.name).toBeUndefined();
    }
    expect(checkerOf(bundle)).toEqual([]);
  });

  it("注解 default 写的名字同一规则：被依赖 → layerComposites，解析不到 → 棋盘格；材质写了的槽不看注解", async () => {
    const { bundle } = await compileDeps([
      imageObject(10, "A", { visible: false }),
      imageObject(20, "B", { dependencies: [10], effects: [refEffect([], "refdef")] }),
      imageObject(30, "C", { effects: [refEffect([null, "a", composite(10)], "refdef")] }),
    ]);
    expect(bundle.unsupported).toEqual([]);
    const [checker] = checkerOf(bundle);
    const b = effectPass(byName(bundle.layers, "B"));
    expect(b.layerComposites).toEqual({ 1: 0 });
    expect(b.textures).toEqual({ 2: checker });
    const c = effectPass(byName(bundle.layers, "C"));
    // 槽 1 是材质写的静态纹理 a，槽 2 是材质写的 A 的 _a（注解的 99 不看）
    expect(c.textures).toEqual({ 1: 0 });
    expect(c.layerComposites).toEqual({ 2: 0 });
  });
});

describe("compileScene：TEX<n>FORMAT（P8 步骤 4 核对表最后一行）", () => {
  // P 自带 0x10（cbm 7）排在引用方 R 前面，Q 没有 0x10，S 自带 0x10 排在后面；都经 R 的 dependencies 被依赖
  const objects = [
    imageObject(10, "P", { colorBlendMode: 7 }),
    imageObject(11, "Q"),
    imageObject(20, "R", {
      dependencies: [10, 11, 12],
      effects: [refEffect([null, composite(10), composite(11), composite(12)])],
    }),
    imageObject(12, "S", { colorBlendMode: 7 }),
  ];
  const formatsOf = (requests: TranslateRequest[]) =>
    requests.filter((request) => request.vertex === "// ref").map((request) => request.textures);
  const HDR = { general: { bloom: true, hdr: true }, postprocess: "ultra" } as const;

  it("LDR 一律 0", async () => {
    const { requests } = await compileDeps(objects);
    expect(formatsOf(requests)).toEqual([
      [{ slot: 0 }, { slot: 1, format: 0 }, { slot: 2, format: 0 }, { slot: 3, format: 0 }],
    ]);
  });

  it("HDR：自带 0x10 且排在前面的 14（RT 已建好），经依赖置位的 0（全部材质之后才建），自带 0x10 排在后面的 0", async () => {
    const { bundle, requests } = await compileDeps(objects, HDR);
    expect(bundle.general.postprocess.hdr).toBe(true);
    expect(formatsOf(requests)).toEqual([
      [{ slot: 0 }, { slot: 1, format: 14 }, { slot: 2, format: 0 }, { slot: 3, format: 0 }],
    ]);
  });

  it("HDR：棋盘格 0（没被依赖、自带 0x10 的也是，同时报 dependency:passthrough-undeclared）", async () => {
    const { bundle, requests } = await compileDeps(
      [
        imageObject(10, "T", { colorBlendMode: 7 }),
        imageObject(20, "R", { effects: [refEffect([null, composite(10)])] }),
      ],
      HDR,
    );
    expect(bundle.unsupported).toContain("dependency:passthrough-undeclared");
    expect(formatsOf(requests)).toEqual([[{ slot: 0 }, { slot: 1, format: 0 }]]);
  });
});

describe("compileScene：被依赖图层的编译与照报（P8 步骤 4）", () => {
  it("被依赖时编 passthrough：cbm 0 / 31 时 BLENDMODE 0、cbm 7 时 7，g_Color4 = 1、槽 0 由渲染图填；没被依赖、cbm 0 不编", async () => {
    const { bundle, requests } = await compileDeps([
      imageObject(10, "A0", { visible: false }),
      imageObject(11, "A31", { colorBlendMode: 31 }),
      imageObject(12, "A7", { colorBlendMode: 7 }),
      imageObject(13, "N"),
      imageObject(20, "B", { dependencies: [10, 11, 12] }),
    ]);
    expect(bundle.unsupported).toEqual([]);
    const combos = requests
      .filter((request) => request.vertex === "// genericimage3")
      .map((request) => request.combos)
      .sort((a, b) => Number(a?.BLENDMODE) - Number(b?.BLENDMODE));
    // A0 与 A31 同一个变体（翻译缓存只请求一次）
    expect(combos).toEqual([
      { BLENDMODE: 0, FOG_COMPUTED: 1 },
      { BLENDMODE: 7, FOG_COMPUTED: 1 },
    ]);
    for (const [index, name] of ["A0", "A31", "A7"].entries()) {
      const pass = byName(bundle.layers, name).passthrough;
      expect(pass, name).toMatchObject({ key: `objects/${index}/passthrough`, uniforms: { g_Color4: [1, 1, 1, 1] } });
      expect(pass!.textures[0], name).toBeUndefined();
    }
    expect(byName(bundle.layers, "N").passthrough).toBeNull();
    expect(byName(bundle.layers, "B").passthrough).toBeNull();
  });

  it("照报 dependency:self：被依赖的图层在自己的 pass 里读自己的 _a（不在 bind 槽上）", async () => {
    const { bundle } = await compileDeps([
      imageObject(10, "A", { dependencies: [10], effects: [refEffect([null, composite(10)])] }),
    ]);
    expect(bundle.unsupported).toEqual(["dependency:self"]);
    expect(effectPass(bundle.layers[0]).layerComposites).toEqual({ 1: 0 });
  });

  it("照报 dependency:passthrough-undeclared：名字指向没被依赖、自带 0x10 的图层（绑棋盘格）；cbm 31 的不报", async () => {
    const reported = await compileDeps([
      imageObject(10, "T", { colorBlendMode: 7 }),
      imageObject(20, "R", { effects: [refEffect([null, composite(10)])] }),
    ]);
    expect(reported.bundle.unsupported).toEqual(["dependency:passthrough-undeclared"]);
    const [checker] = checkerOf(reported.bundle);
    expect(effectPass(byName(reported.bundle.layers, "R")).textures).toEqual({ 1: checker });
    const plain = await compileDeps([
      imageObject(10, "T", { colorBlendMode: 31 }),
      imageObject(20, "R", { effects: [refEffect([null, composite(10)])] }),
    ]);
    expect(plain.bundle.unsupported).toEqual([]);
  });

  it("colorBlendMode 绑属性：名字表按属性当前值判 0x10", async () => {
    const bound = await compileDeps([
      imageObject(10, "T", { colorBlendMode: { user: "cbm", value: 7 } }),
      imageObject(20, "R", { effects: [refEffect([null, composite(10)])] }),
    ]);
    expect(bound.bundle.unsupported).toEqual(["dependency:passthrough-undeclared"]);
  });

  it("照报 dependency:group：被依赖的是组（有子层的组合层）；没有子层的组合层不报、照编 passthrough", async () => {
    const compose = (id: number, name: string) => ({
      id,
      name,
      image: "models/compose.json",
      origin: "500 300 0",
      size: "600 300",
    });
    const group = await compileDeps([
      compose(10, "G"),
      imageObject(11, "child", { parent: 10 }),
      imageObject(20, "B", { dependencies: [10] }),
    ]);
    expect(group.bundle.unsupported).toEqual(["dependency:group"]);
    const single = await compileDeps([compose(10, "CL"), imageObject(20, "B", { dependencies: [10] })]);
    expect(single.bundle.unsupported).toEqual([]);
    expect(single.bundle.layers[0]).toMatchObject({ dependedOn: true, passthroughModel: true });
    expect(single.bundle.layers[0].passthrough).not.toBeNull();
  });

  it("照报 dependency:text：文本对象的 id 在并集里；文本层不填 dependedOn", async () => {
    const text = { id: 10, name: "T", text: "abc", origin: "960 540 0" };
    const depended = await compileDeps([text, imageObject(20, "B", { dependencies: [10] })]);
    expect(depended.bundle.unsupported).toContain("dependency:text");
    expect(depended.bundle.layers[0].dependedOn).toBeUndefined();
    const plain = await compileDeps([text, imageObject(20, "B")]);
    expect(plain.bundle.unsupported).not.toContain("dependency:text");
  });

  it("lighting:prelighting：被依赖、基础材质开光照（WPE 的 0x10 同样把光照挪到基础 pass）；没被依赖、没有 effect 不报", async () => {
    const lit = (id: number, name: string) => ({ ...imageObject(id, name), image: "models/lit.json" });
    const depended = await compileDeps([lit(10, "L"), imageObject(20, "B", { dependencies: [10] })]);
    expect(depended.bundle.unsupported).toContain("lighting:prelighting");
    const plain = await compileDeps([lit(10, "L"), imageObject(20, "B")]);
    expect(plain.bundle.unsupported).not.toContain("lighting:prelighting");
  });

  it("模型对象列的 dependencies 同样给图像层置位（3509243656 的两个模型对象）", async () => {
    const { bundle } = await compileDeps([
      imageObject(10, "A", { visible: false }),
      { id: 20, name: "M", model: "models/missing.mdl", origin: "0 0 0", dependencies: [10] },
    ]);
    expect(bundle.layers[0].dependedOn).toBe(true);
    expect(bundle.layers[0].passthrough).not.toBeNull();
  });
});
