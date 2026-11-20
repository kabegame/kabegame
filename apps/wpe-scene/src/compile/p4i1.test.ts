/**
 * P4i 步骤 1：粒子光照放行（phase-4i-particle-lighting.md）。
 * - 能力表：开了 `LIGHTING`（材质写的、着色器缺省值）、`DOUBLESIDEDLIGHTING` 的粒子材质不再报不支持项；
 * - 只有粒子开了光照时 bundle 也带 `lights`（渲染器据此每帧写灯光数组，粒子 draw 与图层同一个构建函数）；
 * - 本机有 WPE 时用真翻译器编 `3823357259` 的光晕材质原样（`genericparticle` + `LIGHTING`、additive、halo）、带点光的粒子、rope
 *   （`genericropeparticle`），钉住：不报不支持项、程序声明了灯光与环境光 uniform、请求带 `LIGHTS_*`。
 * 画面一致性由步骤 0 的 11 组整帧对照证明（p4-particles-REPORT「P4i 语义的实测核对」），这里只钉编译期的形状。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { compileScene, type SceneBundle } from "./bundle";
import type { SceneReader } from "./fs";
import { Wpesl2wgsl, type TranslateRequest, type TranslateResult } from "../wpesl2wgsl";

vi.mock("../fileUrl", () => ({ fileToUrl: (path: string) => path }));

const ORTHO = { orthogonalprojection: { width: 1920, height: 1080 } };

/** 3823357259 的 `materials/workshop/3778352003/presets/thunderbolt_glow.json` 原样。 */
const GLOW_MATERIAL = {
  passes: [
    {
      alphawriting: "default",
      blending: "additive",
      combos: { LIGHTING: 1 },
      cullmode: "nocull",
      depthtest: "disabled",
      depthwrite: "disabled",
      shader: "genericparticle",
      textures: ["particle/halo"],
    },
  ],
};

const lightObject = (id: number) => ({
  id,
  name: "L",
  light: "lpoint",
  origin: "960 560 300",
  angles: "0 0 0",
  scale: "1 1 1",
  color: "1 0.6 0.3",
  intensity: 2,
  radius: 900,
  exponent: 1,
  castshadow: false,
  visible: true,
});

/** 一个粒子对象（maxcount 3、sphererandom），材质与 renderer 可换；`lights` 给了就加 `lightconfig` 与灯对象。 */
function project(material: unknown, options: { renderer?: string; lights?: number } = {}): Record<string, unknown> {
  const general = options.lights ? { ...ORTHO, lightconfig: { point: options.lights } } : ORTHO;
  const objects: unknown[] = [{ id: 1, particle: "particles/p.json" }];
  for (let i = 0; i < (options.lights ?? 0); i++) objects.push(lightObject(10 + i));
  return {
    "P:/p/project.json": { file: "scene.json" },
    "P:/p/scene.json": { general, objects },
    "P:/p/particles/p.json": {
      material: "materials/pm.json",
      maxcount: 3,
      emitter: [{ name: "sphererandom", rate: 1 }],
      ...(options.renderer ? { renderer: [{ id: 40, name: options.renderer }] } : {}),
    },
    "P:/p/materials/pm.json": material,
  };
}

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

/** 工程文件在内存里，其余（WPE 的 assets）读磁盘。 */
function mixedReader(files: Record<string, unknown>): SceneReader {
  const memory = memoryReader(files);
  const reader: SceneReader = {
    async readWhole(path) {
      if (path.replace(/\\/g, "/") in files) return memory.readWhole(path);
      try {
        return new Uint8Array(readFileSync(path));
      } catch {
        throw new TypeError("Failed to fetch");
      }
    },
    async readRange(path, start, end) {
      return (await reader.readWhole(path)).slice(start, end);
    },
  };
  return reader;
}

/** 假翻译器：请求里写了的 COMBO 原样回成 `source: "request"`（`usesLighting` 读它）。 */
function fakeTranslator() {
  const translator = {
    async translate(request: TranslateRequest): Promise<TranslateResult> {
      const combos = Object.entries(request.combos ?? {}).map(([name, value]) => ({
        name,
        value: Number(value),
        source: "request" as const,
      }));
      return { ok: true, uniforms: [], textures: [], combos } as unknown as TranslateResult;
    },
  } as unknown as Wpesl2wgsl;
  return translator;
}

const compile = (reader: SceneReader, translator: Wpesl2wgsl, sceneAssets = ["A:/assets"]) =>
  compileScene({
    projectDir: "P:/p",
    sceneAssets,
    reader,
    translator,
    postprocess: "disabled",
    exhaustive: true,
  });

const SHADER_STUBS = {
  "P:/p/shaders/genericparticle.vert": "void main(){}",
  "P:/p/shaders/genericparticle.frag": "void main(){}",
};
/** 内存工程（假翻译器）没有纹理文件，不写 `textures`；真翻译器的用例读 WPE assets 的 `util/white`。 */
const litMaterial = (combos: Record<string, number>, textures: string[] = []) => ({
  passes: [{ shader: "genericparticle", textures, combos }],
});

describe("compileScene：粒子光照（假翻译器）", () => {
  it("开了 LIGHTING / DOUBLESIDEDLIGHTING 的粒子材质不报不支持项；只有粒子开光照时 bundle 也带 lights", async () => {
    const files = { ...project(litMaterial({ LIGHTING: 1, DOUBLESIDEDLIGHTING: 1 }), { lights: 2 }), ...SHADER_STUBS };
    const bundle = await compile(memoryReader(files), fakeTranslator());
    expect(bundle.unsupported).toEqual([]);
    expect(bundle.lights?.counts.point).toBe(2);
    expect(bundle.lightObjects).toHaveLength(2);
  });

  it("没灯的场景同样不报（3823357259 的情形：环境光 × 颜色），bundle 带 lights、灯数全 0", async () => {
    const files = { ...project(litMaterial({ LIGHTING: 1 })), ...SHADER_STUBS };
    const bundle = await compile(memoryReader(files), fakeTranslator());
    expect(bundle.unsupported).toEqual([]);
    expect(bundle.lights).toBeDefined();
    expect(bundle.lights!.counts.point).toBe(0);
  });

  it("没开光照的粒子不让 bundle 带 lights；别的未知 COMBO 照报 particle:combo:<名字>", async () => {
    const plain = await compile(memoryReader({ ...project(litMaterial({})), ...SHADER_STUBS }), fakeTranslator());
    expect(plain.unsupported).toEqual([]);
    expect(plain.lights).toBeUndefined();
    const other = await compile(
      memoryReader({ ...project(litMaterial({ LIGHTING: 1, SPECULARMAP: 1 })), ...SHADER_STUBS }),
      fakeTranslator(),
    );
    expect(other.unsupported).toEqual(["particle:combo:SPECULARMAP"]);
  });
});

// ———— 本机有 WPE：真翻译器 ————

const root = process.env.KABEGAME_WPE_ROOT;
const wasm = join(__dirname, "..", "wpesl2wgsl", "wpesl2wgsl.wasm");

describe.skipIf(!root || !existsSync(wasm))("真翻译器：粒子光照的程序", () => {
  async function compileReal(files: Record<string, unknown>) {
    const translator = await Wpesl2wgsl.fromBytes(readFileSync(wasm));
    const requests: TranslateRequest[] = [];
    const spy = {
      translate(request: TranslateRequest) {
        requests.push(request);
        return translator.translate(request);
      },
    } as unknown as Wpesl2wgsl;
    const bundle = await compile(mixedReader(files), spy, [join(root!, "assets")]);
    return { bundle, requests };
  }
  const programOf = (bundle: SceneBundle) => bundle.programs[bundle.layers[0].particle!.passes[0].program!];
  const uniformNames = (bundle: SceneBundle) => (programOf(bundle).uniforms ?? []).map((uniform) => uniform.name);

  it("3823357259 的光晕材质原样（没有灯）：不报、程序开了光照、读环境光，没有灯光数组", async () => {
    const { bundle } = await compileReal(project(GLOW_MATERIAL));
    expect(bundle.unsupported).toEqual([]);
    expect(programOf(bundle).combos?.some((combo) => combo.name === "LIGHTING" && combo.value === 1)).toBe(true);
    expect(uniformNames(bundle)).toContain("g_LightAmbientColor");
    expect(uniformNames(bundle)).not.toContain("g_LPoint_Color");
    expect(bundle.lights?.counts.point).toBe(0);
  }, 30000);

  it("两盏点光：请求带 LIGHTS_POINT 2、程序声明点光数组与模型矩阵", async () => {
    const { bundle, requests } = await compileReal(
      project(litMaterial({ LIGHTING: 1 }, ["util/white"]), { lights: 2 }),
    );
    expect(bundle.unsupported).toEqual([]);
    expect(requests.some((request) => request.litDefines?.LIGHTS_POINT === "2")).toBe(true);
    expect(uniformNames(bundle)).toEqual(
      expect.arrayContaining(["g_LPoint_Color", "g_LPoint_Origin", "g_ModelMatrix"]),
    );
    expect(bundle.lights?.counts.point).toBe(2);
  }, 30000);

  it("rope（genericropeparticle 的 LIGHTING）同样不报、声明点光数组", async () => {
    const { bundle } = await compileReal(
      project(litMaterial({ LIGHTING: 1 }, ["util/white"]), { renderer: "rope", lights: 1 }),
    );
    expect(bundle.unsupported).toEqual([]);
    expect(uniformNames(bundle)).toContain("g_LPoint_Color");
  }, 30000);
});
