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
    expect(scenePostprocessState("ultra", general)).toEqual({
      level: "ultra",
      bloomFlag: true,
      hdrFlag: true,
      bloom: true,
      hdr: true,
    });
    expect(scenePostprocessState("enabled", general)).toEqual({
      level: "enabled",
      bloomFlag: true,
      hdrFlag: true,
      bloom: true,
      hdr: false,
    });
    // 属性关掉泛光，HDR 判定不变：判定读 JSON 的 value（K3）
    expect(scenePostprocessState("ultra", general, { postprocessing: false })).toEqual({
      level: "ultra",
      bloomFlag: false,
      hdrFlag: true,
      bloom: false,
      hdr: true,
    });
    // bloom 缺键：泛光默认开，但 HDR 要求场景里写明（G3）
    expect(scenePostprocessState("ultra", { hdr: true })).toMatchObject({ bloom: true, hdr: false });
  });
  it("hdrFlag 是场景位：不看档位，也不看 HDR 判定；缺键或不是 bool 时为 false", () => {
    for (const level of ["disabled", "enabled", "ultra"] as const) {
      expect(scenePostprocessState(level, { hdr: true }).hdrFlag).toBe(true);
      expect(scenePostprocessState(level, { hdr: false }).hdrFlag).toBe(false);
      expect(scenePostprocessState(level, {}).hdrFlag).toBe(false);
      expect(scenePostprocessState(level, undefined).hdrFlag).toBe(false);
      expect(scenePostprocessState(level, { hdr: 1 }).hdrFlag).toBe(false);
      expect(scenePostprocessState(level, { hdr: { user: "h", value: true } }, { h: "1" }).hdrFlag).toBe(false);
      expect(scenePostprocessState(level, { hdr: { user: "h", value: false } }, { h: true }).hdrFlag).toBe(true);
    }
    // ctl-nobloom：场景位 true，实际渲染是 LDR（K5）
    expect(scenePostprocessState("ultra", { bloom: false, hdr: true })).toMatchObject({ hdrFlag: true, hdr: false });
  });
  it("文件值只认 bool 或对象的 bool value，其余都不判 HDR", () => {
    const state = (fileBloom: unknown) =>
      scenePostprocessState("ultra", { bloom: true, hdr: true }, {}, undefined, fileBloom).hdr;
    expect(state(true)).toBe(true);
    expect(state({ user: "p", value: true })).toBe(true);
    expect(state({ script: "x", value: true })).toBe(true);
    expect(state(false)).toBe(false);
    expect(state({ user: "p", value: false })).toBe(false);
    expect(state({ user: "p" })).toBe(false);
    expect(state({ user: "p", value: "true" })).toBe(false);
    expect(state(1)).toBe(false);
    expect(state(null)).toBe(false);
  });
  it("bloomFlag 是场景位：不看档位；缺键或不是 bool 时为 true", () => {
    expect(scenePostprocessState("disabled", { bloom: true })).toMatchObject({ bloomFlag: true, bloom: false });
    expect(scenePostprocessState("disabled", { bloom: false })).toMatchObject({ bloomFlag: false, bloom: false });
    expect(scenePostprocessState("disabled", {})).toMatchObject({ bloomFlag: true, bloom: false });
    expect(scenePostprocessState("enabled", { bloom: { user: "p", value: "1" } })).toMatchObject({ bloomFlag: true });
    expect(scenePostprocessState("disabled", { bloom: { user: "p", value: true } }, { p: false })).toMatchObject({
      bloomFlag: false,
    });
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
  const SCRIPT = "export function update(value) { return value; }";
  const project = JSON.stringify({ file: "scene.json" });
  const scene = (general: Record<string, unknown>, objects: unknown[] = [{ id: 1, name: "a", brightness: 3 }]) =>
    JSON.stringify({ general: { orthogonalprojection: { width: 64, height: 32 }, ...general }, objects });
  const compile = (
    general: Record<string, unknown>,
    postprocess: "disabled" | "enabled" | "ultra",
    files = {},
    userProperties: Record<string, boolean> = {},
    scriptOverrides: Record<string, boolean> = {},
  ) =>
    compileScene({
      projectDir: "P:/p",
      sceneAssets: ["A:/assets"],
      reader: memoryReader({ "P:/p/project.json": project, "P:/p/scene.json": scene(general), ...files }),
      translator: null,
      postprocess,
      userProperties,
      scriptOverrides,
      exhaustive: true,
    });
  it("关闭档或场景 bloom 写死 false 时没有泛光链", async () => {
    expect((await compile({ bloom: true, hdr: true }, "disabled")).bloom).toBeNull();
    expect((await compile({ bloom: false }, "ultra")).bloom).toBeNull();
  });
  it("bloom 绑了属性且当前为 false：档位允许就有链，场景位是 false，绑定目标就地", async () => {
    const general = { bloom: { user: "p", value: true } };
    const off = await compile(general, "enabled", {}, { p: false });
    expect(off.bloom).not.toBeNull();
    expect(off.general.postprocess).toMatchObject({ bloomFlag: false, bloom: false });
    expect(off.bindings).toContainEqual({ property: "p", target: { kind: "bloom-enabled" } });
    // 属性打开时同样有链
    expect((await compile(general, "enabled", {}, { p: true })).general.postprocess.bloom).toBe(true);
  });
  describe("HDR 判定读场景文件（K3）", () => {
    it.each([
      [true, false, true],
      [false, true, false],
      [true, true, true],
      [false, false, false],
    ])("JSON value %s、属性 %s：HDR %s，开关跟属性，链的形态跟判定", async (value, property, hdr) => {
      const bundle = await compile({ bloom: { user: "p", value }, hdr: true }, "ultra", {}, { p: property });
      expect(bundle.general.postprocess).toMatchObject({ bloomFlag: property, bloom: property, hdrFlag: true, hdr });
      // 绑了属性：四组都建链。关着的两组运行中打开，泛光的形态就是这条链
      expect(bundle.bloom?.hdr).toBe(hdr);
    });
    it("`bloom: false` 被脚本覆盖成 true：仍是 LDR，但开着、有链", async () => {
      const opened = await compile({ bloom: false, hdr: true }, "ultra", {}, {}, { "general/bloom": true });
      expect(opened.general.postprocess).toMatchObject({ bloomFlag: true, bloom: true, hdrFlag: true, hdr: false });
      expect(opened.bloom?.hdr).toBe(false);
    });
    it("挂了脚本的 bloom 被覆盖：判定读文件里的 value，开关读覆盖后的值", async () => {
      const general = { bloom: { script: SCRIPT, value: false }, hdr: true };
      const opened = await compile(general, "ultra", {}, {}, { "general/bloom": true });
      expect(opened.general.postprocess).toMatchObject({ bloomFlag: true, hdr: false });
      const kept = await compile({ ...general, bloom: { script: SCRIPT, value: true } }, "ultra");
      expect(kept.general.postprocess).toMatchObject({ bloomFlag: true, hdr: true });
    });
    it("文件缺 bloom 键：被覆盖成 true 也不算写明，不判 HDR", async () => {
      const opened = await compile({ hdr: true }, "ultra", {}, {}, { "general/bloom": true });
      expect(opened.general.postprocess).toMatchObject({ bloomFlag: true, bloom: true, hdr: false });
    });
    it("general.hdr 绑属性：改属性影响判定，目标格式跟判定（3c 已定 12，有意不跟 WPE）", async () => {
      const on = await compile({ bloom: true, hdr: { user: "h", value: false } }, "ultra", {}, { h: true });
      expect(on.general.postprocess).toMatchObject({ hdrFlag: true, hdr: true });
      expect(on.bloom?.hdr).toBe(true);
      const off = await compile({ bloom: true, hdr: { user: "h", value: true } }, "ultra", {}, { h: false });
      expect(off.general.postprocess).toMatchObject({ hdrFlag: false, hdr: false });
      expect(off.bloom?.hdr).toBe(false);
      expect(off.bindings).toContainEqual({
        property: "h",
        target: { kind: "recompile", reason: "postprocess-hdr", path: "general.hdr" },
      });
    });
    it("scriptOverrides 写 general/hdr：影响判定与 hdrFlag", async () => {
      const raised = await compile({ bloom: true, hdr: false }, "ultra", {}, {}, { "general/hdr": true });
      expect(raised.general.postprocess).toMatchObject({ hdrFlag: true, hdr: true });
      expect(raised.bloom?.hdr).toBe(true);
      const lowered = await compile({ bloom: true, hdr: true }, "ultra", {}, {}, { "general/hdr": false });
      expect(lowered.general.postprocess).toMatchObject({ hdrFlag: false, hdr: false });
      const hung = { bloom: true, hdr: { script: SCRIPT, value: false } };
      const script = await compile(hung, "ultra", {}, {}, { "general/hdr": true });
      expect(script.general.postprocess).toMatchObject({ hdrFlag: true, hdr: true });
    });
  });
  it("档位关闭时不建链：绑了属性、挂了脚本都不算，位怎么变都没有效果", async () => {
    const bound = await compile({ bloom: { user: "p", value: true } }, "disabled", {}, { p: true });
    expect(bound.bloom).toBeNull();
    expect(bound.general.postprocess).toMatchObject({ bloomFlag: true, bloom: false });
    expect((await compile({ bloom: { script: SCRIPT, value: true } }, "disabled")).bloom).toBeNull();
  });
  it("bloom 挂了脚本且当前为 false：有链；写死 false 的场景带别的脚本不算", async () => {
    const hung = await compile({ bloom: { script: SCRIPT, value: false } }, "enabled");
    expect(hung.bloom).not.toBeNull();
    expect(hung.general.postprocess).toMatchObject({ bloomFlag: false, bloom: false });
    expect(hung.scripts.list[0]).toMatchObject({ target: { kind: "bloom-enabled" }, valueType: "bool" });
    const other = await compile({ bloom: false, bloomstrength: { script: SCRIPT, value: 2 } }, "enabled");
    expect(other.scripts.list).toHaveLength(1);
    expect(other.bloom).toBeNull();
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
    expect(bundle.general.postprocess).toEqual({
      level: "ultra",
      bloomFlag: true,
      hdrFlag: true,
      bloom: true,
      hdr: true,
    });
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
      expect(bundle.general.postprocess).toEqual({
        level: "ultra",
        bloomFlag: true,
        hdrFlag: true,
        bloom: true,
        hdr: true,
      });
      // 抓帧里的常量：scatter 1.6、hdrstrength 5（g_BloomStrength = 5 / (1 + 1.6^6) = 0.28126）
      expect(bundle.general.bloom).toMatchObject({ hdrStrength: 5, hdrThreshold: 1, hdrIterations: 8 });
      expect(bundle.general.bloom.hdrScatter).toBeCloseTo(1.6, 6);
    },
    120000,
  );
});
