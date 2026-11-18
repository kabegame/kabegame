/**
 * P13j-1（预光照，普通图层）的单测（`.claude/plans/wpe-import/3-scene/phase13/phase-13j-prelighting.md`）：
 * - 编译期：基础材质开 `LIGHTING` 或 `REFLECTION`、又走合成路径（effect、colorBlendMode 混合）时编 `SceneLayer.prelit`（基础材质 +
 *   `PRELIGHTING=1`，同 key），不再报 `lighting:prelighting`；不走合成、没开光照 / 反射的不编；puppet 仍照报（P13j-2）；
 * - uniform：`staticBuiltins` 给了 `alt` 才写三个 Alt 矩阵，`g_AltNormalModelMatrix` 同 `g_NormalModelMatrix` 的快速归一化
 *   （`p13j-fx` 抓帧：转 0.3、缩放 1.2 的世界矩阵 → 0.9542453 / 0.2951826 / 0.9983081）。
 * 整帧与 WPE 的对照见 p13-REPORT「P13j 的实测」（`p13j-fx` / `-tilt` / `-cbm` / `-fog` / `-legacy` / `-inst`）。
 */
import { describe, expect, it, vi } from "vitest";
import { compileScene, type SceneBundle } from "./bundle";
import type { SceneReader } from "./fs";
import type { JsonObject } from "./model";
import { staticBuiltins } from "../render/uniforms";
import type { TranslateRequest, TranslateResult, Wpesl2wgsl } from "../wpesl2wgsl";

vi.mock("../fileUrl", () => ({ fileToUrl: (path: string) => path }));

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

/** 组合键原样回填进结果（预光照按程序的组合键判定）。 */
const translator = {
  async translate(request: TranslateRequest): Promise<TranslateResult> {
    const combos = Object.entries(request.combos ?? {}).map(([name, value]) => ({
      name,
      value: Number(value),
      source: "request" as const,
    }));
    return { ok: true, uniforms: [], textures: [], combos, attributes: [] } as unknown as TranslateResult;
  },
} as unknown as Wpesl2wgsl;

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
