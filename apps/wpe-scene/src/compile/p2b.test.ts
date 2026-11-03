import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { HDR_BLOOM_MATERIALS, LDR_BLOOM_MATERIALS, POSTPROCESS_UNIFORMS } from "./bloom";
import { compileScene, type SceneBundle } from "./bundle";
import { checkProgramFeatures } from "./features";
import type { SceneReader } from "./fs";
import { parseWpeJson } from "./model";
import { BLOOM_DEFAULTS, bloomParams, scenePostprocessState } from "./postprocess";
import { Wpesl2wgsl, type TranslateResult } from "../wpesl2wgsl";
import { staticBuiltins } from "../render/uniforms";
import { identity } from "../render/math";

vi.mock("../fileUrl", () => ({ fileToUrl: (path: string) => path }));

function memoryReader(files: Record<string, string>): SceneReader & { reads: string[] } {
  const reads: string[] = [];
  const bytes = (path: string) => {
    const value = files[path.replace(/\\/g, "/")];
    if (value === undefined) throw new TypeError("Failed to fetch");
    return new TextEncoder().encode(value);
  };
  return {
    reads,
    async readWhole(path) {
      reads.push(path);
      return bytes(path);
    },
    async readRange(path, start, end) {
      reads.push(`${path}:${start}-${end}`);
      return bytes(path).slice(start, end);
    },
  };
}

describe("泛光参数", () => {
  it("缺键取 WPE 场景构造函数的默认值", () => {
    expect(bloomParams(undefined)).toEqual(BLOOM_DEFAULTS);
    expect(BLOOM_DEFAULTS).toEqual({
      strength: 2,
      threshold: 0.65,
      tint: [1, 1, 1],
      hdrStrength: 2,
      hdrThreshold: 1,
      hdrFeather: 0.1,
      hdrScatter: 1.619,
      hdrIterations: 8,
    });
  });
  it("数字、`r g b` 字符串、属性对象（取当前值）与只导出 applyUserProperties 的脚本（取 value）", () => {
    const general = {
      bloomstrength: { script: "export function applyUserProperties() {}", value: 1.12 },
      bloomthreshold: { user: "t", value: 0.81 },
      bloomtint: "0.26667 0.00392 0.00392",
      bloomhdrstrength: { user: "glow", value: 2 },
      bloomhdrfeather: 0,
      bloomhdrscatter: 1.13,
      bloomhdrthreshold: 0.7,
      bloomhdriterations: 3.9,
    };
    expect(bloomParams(general, { glow: 4 })).toEqual({
      strength: 1.12,
      threshold: 0.81,
      tint: [0.26667, 0.00392, 0.00392],
      hdrStrength: 4,
      hdrThreshold: 0.7,
      hdrFeather: 0,
      hdrScatter: 1.13,
      hdrIterations: 3,
    });
  });
  it("取不到合法数字的保留默认值", () => {
    expect(bloomParams({ bloomstrength: "abc", bloomtint: "1 1", bloomhdriterations: null })).toMatchObject({
      strength: 2,
      tint: [1, 1, 1],
      hdrIterations: 8,
    });
  });
  it("HDR 判定：工坊 3286859278 的 bloom 是属性对象、hdr 为 true，超高档走 HDR", () => {
    const general = { bloom: { user: "postprocessing", value: true }, hdr: true };
    expect(scenePostprocessState("ultra", general)).toEqual({ level: "ultra", bloom: true, hdr: true });
    expect(scenePostprocessState("enabled", general)).toEqual({ level: "enabled", bloom: true, hdr: false });
    expect(scenePostprocessState("ultra", general, { postprocessing: false })).toEqual({
      level: "ultra",
      bloom: false,
      hdr: false,
    });
    // bloom 缺键：泛光默认开，但 HDR 要求场景里写明（G3）
    expect(scenePostprocessState("ultra", { hdr: true })).toMatchObject({ bloom: true, hdr: false });
  });
});

describe("宽松 JSON", () => {
  it("WPE 容忍的尾逗号：对象 / 数组结尾的逗号去掉再解析，字符串里的不动", () => {
    expect(parseWpeJson('{"a": [1, 2,], "b": "x,]",}')).toEqual({ a: [1, 2], b: "x,]" });
    expect(() => parseWpeJson('{"a": }')).toThrow();
  });
});

describe("HDR 下的颜色系数", () => {
  const input = {
    modelViewProjection: identity(),
    modelViewProjectionInverse: identity(),
    model: identity(),
    viewProjection: identity(),
    layer: { alpha: 0.5, color: [1, 0.5, 0.25] },
    textures: [],
    screenSize: [4, 2] as [number, number],
    eye: [],
  };
  it("g_Color4 = (color · k, alpha)，g_Color 同乘；k 缺省 1", () => {
    expect(staticBuiltins(input).g_Color4).toEqual([1, 0.5, 0.25, 0.5]);
    const hdr = staticBuiltins({ ...input, colorScale: 3 });
    expect(hdr.g_Color4).toEqual([3, 1.5, 0.75, 0.5]);
    expect(hdr.g_Color).toEqual([3, 1.5, 0.75]);
    expect(hdr.g_Alpha).toEqual([0.5]);
  });
});

describe("编译：泛光链与 brightness", () => {
  const project = JSON.stringify({ file: "scene.json" });
  const scene = (general: Record<string, unknown>, objects: unknown[] = [{ id: 1, name: "a", brightness: 3 }]) =>
    JSON.stringify({ general: { orthogonalprojection: { width: 64, height: 32 }, ...general }, objects });
  const compile = (general: Record<string, unknown>, postprocess: "disabled" | "enabled" | "ultra", files = {}) =>
    compileScene({
      projectDir: "P:/p",
      sceneAssets: ["A:/assets"],
      reader: memoryReader({ "P:/p/project.json": project, "P:/p/scene.json": scene(general), ...files }),
      translator: null,
      postprocess,
      exhaustive: true,
    });
  it("关闭档或场景 bloom 为 false 时没有泛光链", async () => {
    expect((await compile({ bloom: true, hdr: true }, "disabled")).bloom).toBeNull();
    expect((await compile({ bloom: false }, "ultra")).bloom).toBeNull();
  });
  it("场景没有对象时不跑泛光（A1）", async () => {
    const bundle = await compileScene({
      projectDir: "P:/p",
      sceneAssets: ["A:/assets"],
      reader: memoryReader({ "P:/p/project.json": project, "P:/p/scene.json": scene({}, []) }),
      translator: null,
      postprocess: "enabled",
    });
    expect(bundle.general.postprocess.bloom).toBe(true);
    expect(bundle.bloom).toBeNull();
  });
  it("开启档读 LDR 的四个 util 材质，超高档读 HDR 的五个；缺了照常记 material:missing", async () => {
    const ldr = await compile({}, "enabled");
    expect(ldr.bloom?.hdr).toBe(false);
    for (const { material } of Object.values(LDR_BLOOM_MATERIALS))
      expect(ldr.unsupported).toContain(`material:missing:${material}`);
    const hdr = await compile({ bloom: true, hdr: true }, "ultra");
    expect(hdr.bloom?.hdr).toBe(true);
    for (const { material } of Object.values(HDR_BLOOM_MATERIALS))
      expect(hdr.unsupported).toContain(`material:missing:${material}`);
    // 收尾用 combine_hdr 的 LINEAR 变体（画布是 8 位 sRGB 编码，见 compile/bloom.ts）
    expect(HDR_BLOOM_MATERIALS.combine.material).toBe("materials/util/combine_hdr_upsample_linear.json");
  });
  it("材质在 assets 里时编出各 pass（没有翻译器时只缺程序）", async () => {
    const files: Record<string, string> = {};
    for (const { material } of Object.values(LDR_BLOOM_MATERIALS))
      files[`A:/assets/${material}`] = JSON.stringify({
        passes: [{ shader: material.split("/").at(-1)!.replace(".json", "") }],
      });
    const bundle = await compile({}, "enabled", files);
    expect(Object.keys(bundle.bloom!.passes).sort()).toEqual(["blur", "combine", "eighth", "quarter"]);
    expect(bundle.unsupported).toContain("shader:wasm-missing");
    expect(bundle.unsupported.some((key) => key.startsWith("material:missing:materials/util"))).toBe(false);
  });
  it("图层 brightness 解析（默认 1），HDR 由渲染器决定是否乘", async () => {
    const bundle = await compile({ bloom: true, hdr: true }, "ultra");
    expect(bundle.layers[0].brightness).toBe(3);
  });
  it("g_RenderVar0 只在泛光 pass 放行，图层材质里照报", () => {
    const result = { ok: true, uniforms: [{ name: "g_RenderVar0", type: "vec4<f32>", offset: 0, size: 16 }] };
    const keys = new Set<string>();
    checkProgramFeatures(result as TranslateResult, keys);
    expect([...keys]).toEqual(["uniform:g_RenderVar0"]);
    keys.clear();
    checkProgramFeatures(result as TranslateResult, keys, POSTPROCESS_UNIFORMS);
    expect([...keys]).toEqual([]);
  });
});

// 本机语料：泛光 / combine 着色器用 WPE assets 原件翻译
const root = process.env.KABEGAME_WPE_ROOT;
const wasm = join(__dirname, "..", "wpesl2wgsl", "wpesl2wgsl.wasm");
const fsReader: SceneReader = {
  async readWhole(path) {
    try {
      return new Uint8Array(readFileSync(path));
    } catch {
      throw new TypeError("Failed to fetch");
    }
  },
  async readRange(path, start, end) {
    let bytes: Buffer;
    try {
      bytes = readFileSync(path);
    } catch {
      throw new TypeError("Failed to fetch");
    }
    if (start >= bytes.length) throw new TypeError("Failed to fetch");
    return new Uint8Array(bytes.subarray(start, end));
  },
};

describe.skipIf(!root || !existsSync(wasm))("本机 P2b 样本", () => {
  const compile = async (dir: string, options: Partial<Parameters<typeof compileScene>[0]> = {}) =>
    compileScene({
      projectDir: dir,
      sceneAssets: [join(root!, "assets")],
      reader: fsReader,
      translator: await Wpesl2wgsl.fromBytes(readFileSync(wasm)),
      ...options,
    });
  const sample = (name: string) => join(root!, "projects", "defaultprojects", name);
  const combos = (bundle: SceneBundle, name: string) =>
    Object.fromEntries(
      (bundle.programs[bundle.bloom!.passes[name as "combine"]!.program!].combos ?? [])
        .filter((c) => c.value !== 0)
        .map((c) => [c.name, c.value]),
    );
  const materialOf = (bundle: SceneBundle, name: string) =>
    Object.fromEntries(
      (bundle.programs[bundle.bloom!.passes[name as "combine"]!.program!].uniforms ?? []).map((u) => [
        u.name,
        u.meta?.material ?? null,
      ]),
    );

  it("razer_bedroom 开启档：LDR 四个 pass 全部翻译通过", async () => {
    const bundle = await compile(sample("razer_bedroom"), { postprocess: "enabled", exhaustive: true });
    expect(bundle.unsupported).toEqual([]);
    expect(bundle.bloom?.hdr).toBe(false);
    expect(bundle.general.bloom).toMatchObject({ strength: 1, threshold: 1 });
    expect(materialOf(bundle, "quarter")).toMatchObject({
      g_BloomStrength: "bloomstrength",
      g_BloomThreshold: "bloomthreshold",
      g_BloomTint: "bloomtint",
      g_TexelSize: null,
    });
    expect(bundle.programs[bundle.bloom!.passes.combine!.program!].textures?.map((t) => t.slot)).toEqual([0, 1]);
  }, 60000);
  it("razer_bedroom 超高档：HDR 五个 pass，COMBO 与材质名对上", async () => {
    const bundle = await compile(sample("razer_bedroom"), { postprocess: "ultra", exhaustive: true });
    expect(bundle.unsupported).toEqual([]);
    expect(bundle.general.postprocess).toEqual({ level: "ultra", bloom: true, hdr: true });
    expect(bundle.bloom?.hdr).toBe(true);
    expect(combos(bundle, "downsampleBloom")).toMatchObject({ BLOOM: 1 });
    expect(combos(bundle, "upsample")).toMatchObject({ UPSAMPLE: 1 });
    expect(combos(bundle, "upsampleCubic")).toMatchObject({ UPSAMPLE: 1, BICUBIC: 1 });
    expect(combos(bundle, "combine")).toMatchObject({ LINEAR: 1 });
    expect(materialOf(bundle, "downsampleBloom")).toMatchObject({
      g_BloomStrength: "bloomstrength",
      g_BloomBlendParams: "blend",
      g_BloomTint: "bloomtint",
      g_RenderVar0: null,
    });
    expect(materialOf(bundle, "upsample")).toMatchObject({ g_BloomScatter: "scatter" });
    expect(bundle.bloom!.passes.upsample!.blending).toBe("additive");
    // HDR 下 wave 层的 brightness 3 进了 bundle（B10 / J5：g_Color4 = (3, 3, 3, 1)）
    expect(bundle.layers.some((layer) => layer.brightness === 3)).toBe(true);
  }, 60000);
  it("razer_vortex 的 bloom 为 false：任何档位都没有泛光链", async () => {
    const bundle = await compile(sample("razer_vortex"), { postprocess: "ultra" });
    expect(bundle.unsupported).toEqual([]);
    expect(bundle.bloom).toBeNull();
  }, 60000);
  const ghost = join(root ?? "", "..", "..", "workshop", "content", "431960", "3286859278");
  it.skipIf(!existsSync(ghost))(
    "工坊 3286859278：bloom 写成属性对象，超高档仍走 HDR",
    async () => {
      // 快速路径（这张还有别的不支持项，确定退回后不再编译泛光链；列全时会撞上带尾逗号的 effect.json，见 PLAN P2b 遗留）
      const bundle = await compile(ghost, { postprocess: "ultra" });
      expect(bundle.general.postprocess).toEqual({ level: "ultra", bloom: true, hdr: true });
      // 抓帧里的常量：scatter 1.6、hdrstrength 5（g_BloomStrength = 5 / (1 + 1.6^6) = 0.28126）
      expect(bundle.general.bloom).toMatchObject({ hdrStrength: 5, hdrThreshold: 1, hdrIterations: 8 });
      expect(bundle.general.bloom.hdrScatter).toBeCloseTo(1.6, 6);
    },
    120000,
  );
});
