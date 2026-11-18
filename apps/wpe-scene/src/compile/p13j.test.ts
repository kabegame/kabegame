/**
 * P13j-1（预光照，普通图层）的单测（`.claude/plans/wpe-import/3-scene/phase13/phase-13j-prelighting.md`）：
 * - 编译期：基础材质开 `LIGHTING` 或 `REFLECTION`、又走合成路径（effect、colorBlendMode 混合）时编 `SceneLayer.prelit`（基础材质 +
 *   `PRELIGHTING=1`，同 key），不再报 `lighting:prelighting`；不走合成、没开光照 / 反射的不编；
 * - uniform：`staticBuiltins` 给了 `alt` 才写三个 Alt 矩阵，`g_AltNormalModelMatrix` 同 `g_NormalModelMatrix` 的快速归一化
 *   （`p13j-fx` 抓帧：转 0.3、缩放 1.2 的世界矩阵 → 0.9542453 / 0.2951826 / 0.9983081）。
 * P13j-2（puppet）：变体另带 puppet 组合键（没有 `SKINNING_ALPHA`，skinned 时 `PRELIGHTINGDUALVERTEX`，`prelit_mat.asm`）、`nocull`；
 * `a_PositionC1` 读位置那一项（`meshAttributes` 的 `dualVertex`）；渲染图的基础步骤画网格（几何 `puppet`、标 `prelit`、不剔除）。
 * 整帧与 WPE 的对照见 p13-REPORT「P13j 的实测」（`p13j-fx` / `-tilt` / `-cbm` / `-fog` / `-legacy` / `-inst`）。
 */
import { gunzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import mdlFixture from "../puppet/fixtures/p12b2-mdl.json";
import { planLayer } from "../render/graph";
import { meshVertexLayout } from "../render/mesh";
import { compileScene, type SceneBundle } from "./bundle";
import type { SceneReader } from "./fs";
import { meshAttributes, mdlStride, parseMdl } from "./mdl";
import type { JsonObject } from "./model";
import { buildPuppet } from "./puppet";
import { staticBuiltins } from "../render/uniforms";
import type { InterfaceVariable, TranslateRequest, TranslateResult, Wpesl2wgsl } from "../wpesl2wgsl";

vi.mock("../fileUrl", () => ({ fileToUrl: (path: string) => path }));

/** rig4 网格 0 没有 bit2：`boneAlpha` 为真时给它的组合键补上 `SKINNING_ALPHA`，看预光照变体去掉它。 */
const hooks = vi.hoisted(() => ({ boneAlpha: false }));
vi.mock("./puppet", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./puppet")>();
  return {
    ...actual,
    buildPuppet: (...args: Parameters<typeof actual.buildPuppet>) => {
      const built = actual.buildPuppet(...args);
      if (hooks.boneAlpha && built.puppet) built.puppet.combos = { ...built.puppet.combos, SKINNING_ALPHA: 1 };
      return built;
    },
  };
});

function memoryReader(files: Record<string, unknown>): SceneReader {
  const reader: SceneReader = {
    async readWhole(path) {
      const value = files[path.replace(/\\/g, "/")];
      if (value === undefined) throw new TypeError("Failed to fetch");
      if (value instanceof Uint8Array) return value;
      return new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value));
    },
    async readRange(path, start, end) {
      return (await reader.readWhole(path)).slice(start, end);
    },
  };
  return reader;
}

/** 收到的请求（P13j-2 的用例看组合键）。 */
const requests: TranslateRequest[] = [];
/**
 * 组合键原样回填进结果（预光照按程序的组合键判定）。属性照 `genericimage4.vert`：`a_Position`、`a_TexCoord`，`SKINNING` 时
 * `a_BlendIndices` / `a_BlendWeights`，`PRELIGHTINGDUALVERTEX` 时 `a_PositionC1`。
 */
const translator = {
  async translate(request: TranslateRequest): Promise<TranslateResult> {
    requests.push(request);
    const combos = Object.entries(request.combos ?? {}).map(([name, value]) => ({
      name,
      value: Number(value),
      source: "request" as const,
    }));
    const on = (name: string) => Number(request.combos?.[name] ?? 0) !== 0;
    const attributes: InterfaceVariable[] = [
      { name: "a_Position", location: 0, type: "vec3" },
      { name: "a_TexCoord", location: 1, type: "vec2" },
      ...(on("SKINNING")
        ? [
            { name: "a_BlendIndices", location: 2, type: "uvec4" },
            { name: "a_BlendWeights", location: 3, type: "vec4" },
          ]
        : []),
      ...(on("PRELIGHTINGDUALVERTEX") ? [{ name: "a_PositionC1", location: 4, type: "vec3" }] : []),
    ];
    return { ok: true, uniforms: [], textures: [], combos, attributes } as unknown as TranslateResult;
  },
} as unknown as Wpesl2wgsl;

/** p12b2-mdl 的 rig4（skinned 的图像 puppet，p12b2-tc 的「没有纹理通道」用例也用它）。 */
const RIG = new Uint8Array(gunzipSync(Buffer.from(mdlFixture.mdls["models/rig4.mdl"], "base64")));

const ASSETS = "A:/assets";
const ORTHO = { orthogonalprojection: { width: 1920, height: 1080 } };

async function compile(objects: JsonObject[]): Promise<SceneBundle> {
  const material = (combos: Record<string, number>) => ({ passes: [{ shader: "s", blending: "translucent", combos }] });
  const files: Record<string, unknown> = {
    "P:/p/project.json": { file: "scene.json", general: { properties: {} } },
    "P:/p/scene.json": { general: ORTHO, objects },
    "P:/p/shaders/s.vert": "void main(){}",
    "P:/p/shaders/s.frag": "void main(){}",
    "P:/p/materials/lit.json": material({ LIGHTING: 1 }),
    "P:/p/materials/refl.json": material({ REFLECTION: 1 }),
    "P:/p/materials/plain.json": material({ LIGHTING: 0 }),
    "P:/p/models/lit.json": { material: "materials/lit.json" },
    "P:/p/models/refl.json": { material: "materials/refl.json" },
    "P:/p/models/plain.json": { material: "materials/plain.json" },
    "P:/p/models/litpup.json": { material: "materials/lit.json", puppet: "models/rig4.mdl" },
    "P:/p/models/plainpup.json": { material: "materials/plain.json", puppet: "models/rig4.mdl" },
    "P:/p/models/rig4.mdl": RIG,
    "P:/p/effects/fx/effect.json": { passes: [{ material: "materials/fx.json" }] },
    "P:/p/materials/fx.json": { passes: [{ shader: "s", blending: "translucent", textures: [null] }] },
    [`${ASSETS}/materials/util/effectpassthrough.json`]: { passes: [{ shader: "s" }] },
    [`${ASSETS}/materials/util/effectpassthrough_4.json`]: { passes: [{ shader: "s" }] },
  };
  return compileScene({
    projectDir: "P:/p",
    sceneAssets: [ASSETS],
    reader: memoryReader(files),
    translator,
    postprocess: "disabled",
    exhaustive: true,
  });
}

const image = (model: string, extra: JsonObject = {}): JsonObject => ({ image: model, origin: "0 0 0", ...extra });
const fx = { effects: [{ file: "effects/fx/effect.json" }] };
const comboOf = (bundle: SceneBundle, program: number | null | undefined, name: string) =>
  program == null ? undefined : bundle.programs[program].combos?.find((combo) => combo.name === name)?.value;

describe("预光照变体（P13j-1）", () => {
  it("LIGHTING + effect：编 prelit（同 key、PRELIGHTING=1），不报 lighting:prelighting", async () => {
    const bundle = await compile([image("models/lit.json", fx)]);
    const layer = bundle.layers[0];
    expect(layer.prelit).toBeDefined();
    expect(layer.prelit!.key).toBe(layer.passes[0].key);
    expect(comboOf(bundle, layer.prelit!.program, "PRELIGHTING")).toBe(1);
    expect(comboOf(bundle, layer.passes[0].program, "PRELIGHTING")).toBeUndefined();
    expect(bundle.unsupported).not.toContain("lighting:prelighting");
    expect(bundle.unsupported).not.toContain("combo:PRELIGHTING");
  });

  it("只开 REFLECTION、colorBlendMode 混合也走预光照（材质标志 `+0x1fc & 0x18`）", async () => {
    const bundle = await compile([image("models/refl.json", { colorBlendMode: 1 })]);
    expect(bundle.layers[0].prelit).toBeDefined();
  });

  it("不走合成、没开光照 / 反射的不编", async () => {
    const bundle = await compile([image("models/lit.json"), image("models/plain.json", fx)]);
    expect(bundle.layers.map((layer) => layer.prelit)).toEqual([undefined, undefined]);
  });
});

describe("puppet 的预光照（P13j-2）", () => {
  const puppetImage = (extra: JsonObject = {}) =>
    image("models/litpup.json", { size: "256 256", animationlayers: [], ...fx, ...extra });
  const prelitRequests = () => requests.filter((request) => request.combos?.PRELIGHTING === 1);

  it("LIGHTING + effect：变体 = 基础材质 + PRELIGHTING + puppet 组合键 + PRELIGHTINGDUALVERTEX，同 key、nocull，不报", async () => {
    const skin = buildPuppet(parseMdl(RIG), [], "models/rig4.mdl").puppet!.combos;
    expect(skin.SKINNING).toBe(1);
    requests.length = 0;
    const bundle = await compile([puppetImage()]);
    const layer = bundle.layers[0];
    expect(layer.puppet?.composite).toBe(true);
    expect(layer.prelit).toMatchObject({ key: "objects/0/passes/0", cullmode: "nocull" });
    expect(prelitRequests().map((request) => request.combos)).toEqual([
      { LIGHTING: 1, PRELIGHTING: 1, ...skin, PRELIGHTINGDUALVERTEX: 1 },
    ]);
    expect(bundle.unsupported).not.toContain("lighting:prelighting");
    // `a_PositionC1` 读位置那一项，不算缺属性
    expect(bundle.unsupported.filter((key) => key.startsWith("mdl:"))).toEqual([]);
  });

  it("没有 SKINNING_ALPHA（`prelit_mat.asm` 不写它）；直接上屏 / 上屏的变体照旧带", async () => {
    hooks.boneAlpha = true;
    try {
      requests.length = 0;
      const bundle = await compile([puppetImage()]);
      const [prelit] = prelitRequests();
      expect(prelit.combos).not.toHaveProperty("SKINNING_ALPHA");
      expect(prelit.combos).toMatchObject({ SKINNING: 1, PRELIGHTINGDUALVERTEX: 1 });
      expect(comboOf(bundle, bundle.layers[0].puppet!.upload!.program, "SKINNING_ALPHA")).toBe(1);
    } finally {
      hooks.boneAlpha = false;
    }
  });

  it("不走合成（没有 effect、没有混合、没被依赖）不编；不开光照 / 反射不编", async () => {
    expect((await compile([puppetImage({ effects: [] })])).layers[0].prelit).toBeUndefined();
    const plain = await compile([image("models/plainpup.json", { size: "256 256", animationlayers: [], ...fx })]);
    expect(plain.layers[0].puppet?.composite).toBe(true);
    expect(plain.layers[0].prelit).toBeUndefined();
  });

  it("渲染图：基础步骤画网格进合成 RT（几何 puppet、标 prelit、关混合、不剔除、不内缩），上屏仍是 puppet.upload", async () => {
    const bundle = await compile([puppetImage()]);
    const layer = bundle.layers[0];
    const sizes = bundle.textures.map(() => ({ width: 32, height: 32, textureWidth: 32, textureHeight: 32 }));
    const plan = planLayer(layer, sizes);
    expect(plan.reasons).toEqual([]);
    const draws = plan.steps.filter((step) => step.kind === "draw");
    const base = draws.find((step) => step.role === "base");
    expect(base).toMatchObject({
      pass: layer.prelit,
      geometry: "puppet",
      prelit: true,
      blending: null,
      target: { kind: "composite", index: 0 },
      inset: [0, 0],
    });
    expect(base!.raster.cull).toBe(false);
    // 前面没有清屏：WPE 画网格前不清合成 RT
    expect(plan.steps.indexOf(base!)).toBe(plan.steps.findIndex((step) => step.kind !== "snapshot"));
    expect(plan.steps.some((step) => step.kind === "clear")).toBe(false);
    const upload = draws.find((step) => step.role === "passthrough");
    expect(upload).toMatchObject({ pass: layer.puppet!.upload, geometry: "puppet" });
    expect(upload).not.toHaveProperty("prelit");
  });
});

describe("a_PositionC1（meshAttributes 的 dualVertex，P13j-2）", () => {
  // Artorias 部件 5 的网格格式：位置、骨骼索引、权重、UV（stride 52）；WPE 预光照那份加了 a_PositionC1（0x2000000），stride 64、C1 在 12
  const format = 0x1 | 0x800000 | 0x1000000 | 0x8;

  it("格式里没有时补一项指向位置（同偏移），别的项不变；本来有的不补", () => {
    expect(mdlStride(format)).toBe(52);
    expect(mdlStride(format | 0x2000000)).toBe(64);
    expect(meshAttributes(format | 0x2000000).find((item) => item.name === "a_PositionC1")?.offset).toBe(12);
    const plain = meshAttributes(format);
    const dual = meshAttributes(format, true);
    expect(dual.slice(0, plain.length)).toEqual(plain);
    expect(dual.slice(plain.length)).toEqual([
      expect.objectContaining({
        name: "a_PositionC1",
        semantic: "POSITION",
        semanticIndex: 1,
        offset: 0,
        components: 3,
      }),
    ]);
    // a_PositionVec4（变形）：同样指向它，读前三个分量
    expect(meshAttributes(0x10000 | 0x8, true).at(-1)).toMatchObject({ name: "a_PositionC1", offset: 0 });
    const has = format | 0x2000000;
    expect(meshAttributes(has, true)).toEqual(meshAttributes(has));
  });

  it("顶点布局：带 dualVertex 时 a_PositionC1 与 a_Position 同偏移、float32x3；不带时它没数据、接占位", () => {
    const attributes: InterfaceVariable[] = [
      { name: "a_Position", location: 0, type: "vec3" },
      { name: "a_PositionC1", location: 4, type: "vec3" },
    ];
    const dual = meshVertexLayout(attributes, format, true);
    expect(dual.problems).toEqual([]);
    expect(dual.placeholders).toBe(0);
    expect(dual.buffers[0].attributes).toEqual([
      { shaderLocation: 0, offset: 0, format: "float32x3" },
      { shaderLocation: 4, offset: 0, format: "float32x3" },
    ]);
    expect(meshVertexLayout(attributes, format).placeholders).toBe(1);
  });
});

describe("Alt 矩阵（staticBuiltins）", () => {
  const base = {
    modelViewProjection: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
    modelViewProjectionInverse: null,
    model: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
    viewProjection: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
    layer: { color: [1, 1, 1], alpha: 1 } as never,
    textures: [],
    screenSize: [1920, 1080] as [number, number],
    eye: [960, 540, 2000],
  };

  it("不给 alt 时不写", () => {
    const values = staticBuiltins(base);
    expect(values.g_AltModelMatrix).toBeUndefined();
  });

  it("给了 alt：模型原样、法线逐行快速归一化、视图投影原样（p13j-fx 的值）", () => {
    // 转 0.3、缩放 1.2、平移 (700, 540)：抓帧的 g_AltModelMatrix 前两行
    const model = new Float32Array([1.146404, 0.3546243, 0, 0, -0.3546243, 1.146404, 0, 0, 0, 0, 1, 0, 700, 540, 0, 1]);
    const vp = new Float32Array([2 / 1920, 0, 0, 0, 0, 2 / 1080, 0, 0, 0, 0, 0.00025, 0, -1, -1, 0.5, 1]);
    const values = staticBuiltins({ ...base, alt: { model, viewProjection: vp } });
    expect(values.g_AltModelMatrix).toEqual(Array.from(model));
    expect(values.g_AltViewProjectionMatrix).toEqual(Array.from(vp));
    const normal = values.g_AltNormalModelMatrix.map((v) => Math.fround(v));
    expect(normal[0]).toBeCloseTo(0.9542453, 6);
    expect(normal[1]).toBeCloseTo(0.2951826, 6);
    expect(normal.at(-1)).toBeCloseTo(0.9983081, 6);
  });
});
