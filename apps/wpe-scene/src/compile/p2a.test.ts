import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { compileScene, fboFormat, needsFramebuffer, passthroughMaterial, type SceneBundle } from "./bundle";
import { decodeEncodedTextures, TextureDecodeCache } from "./decode";
import { checkEffectFeatures, checkProgramFeatures, checkSceneFeatures, ENGINE_UNIFORMS, scanValue } from "./features";
import type { SceneReader } from "./fs";
import { isStaticScript, scriptExports } from "./model";
import {
  readWpePostprocessing,
  resolvePostprocessLevel,
  scenePostprocessState,
  wpeConfigPath,
  wpeLevelOf,
  wpePostprocessingOf,
} from "./postprocess";
import { parseTex } from "./tex";
import { Wpesl2wgsl, type TranslateResult } from "../wpesl2wgsl";
import { frameBuiltins, staticBuiltins } from "../render/uniforms";
import { identity } from "../render/math";

vi.mock("../fileUrl", () => ({ fileToUrl: (path: string) => path }));

function memoryReader(files: Record<string, Uint8Array | string>): SceneReader & { reads: string[] } {
  const reads: string[] = [];
  const bytes = (path: string) => {
    const value = files[path];
    if (value === undefined) throw new TypeError("Failed to fetch");
    return typeof value === "string" ? new TextEncoder().encode(value) : value;
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

describe("场景后处理档位", () => {
  const config = (value?: string) =>
    JSON.stringify({
      "?installdirectory": "D:/x",
      someone: { general: { user: value === undefined ? {} : { postprocessing: value } } },
    });
  it("WPE config.json：跳过 ? 开头的键，取第一个有 postprocessing 的用户", () => {
    expect(wpePostprocessingOf(config("ultra"))).toBe("ultra");
    expect(wpePostprocessingOf(config())).toBeNull();
    expect(wpePostprocessingOf("不是 JSON")).toBeNull();
  });
  it("WPE 取值：只认 disabled / ultra / displayhdr，其它非空当开启，缺失当关闭", () => {
    expect(wpeLevelOf("disabled")).toBe("disabled");
    expect(wpeLevelOf("ultra")).toBe("ultra");
    expect(wpeLevelOf("displayhdr")).toBe("ultra");
    expect(wpeLevelOf("enabled")).toBe("enabled");
    expect(wpeLevelOf("high")).toBe("enabled");
    expect(wpeLevelOf("")).toBe("disabled");
    expect(wpeLevelOf(null)).toBe("disabled");
  });
  it("设置：固定档位不看 WPE，跟随时按 WPE，读不到按关闭", () => {
    expect(resolvePostprocessLevel("enabled", "disabled")).toBe("enabled");
    expect(resolvePostprocessLevel("disabled", "ultra")).toBe("disabled");
    expect(resolvePostprocessLevel("follow", "ultra")).toBe("ultra");
    expect(resolvePostprocessLevel("follow", null)).toBe("disabled");
    expect(resolvePostprocessLevel(undefined, "high")).toBe("enabled");
  });
  it("场景实际状态：泛光缺键即开；HDR 要超高且 bloom、hdr 的生效值都为 true", () => {
    expect(scenePostprocessState("disabled", { bloom: true, hdr: true })).toEqual({
      level: "disabled",
      bloom: false,
      hdr: false,
    });
    expect(scenePostprocessState("enabled", {})).toMatchObject({ bloom: true, hdr: false });
    expect(scenePostprocessState("enabled", { bloom: false })).toMatchObject({ bloom: false });
    expect(scenePostprocessState("enabled", { bloom: true, hdr: true })).toMatchObject({ bloom: true, hdr: false });
    expect(scenePostprocessState("ultra", { bloom: true, hdr: true })).toMatchObject({ bloom: true, hdr: true });
    expect(scenePostprocessState("ultra", { hdr: true })).toMatchObject({ bloom: true, hdr: false });
    // 写成属性对象：泛光与 HDR 都取生效值（P2b 更正，工坊 3286859278 超高档抓帧）
    expect(scenePostprocessState("ultra", { bloom: { user: "x", value: true }, hdr: true })).toMatchObject({
      bloom: true,
      hdr: true,
    });
    expect(
      scenePostprocessState("ultra", { bloom: { user: "x", value: true }, hdr: true }, { x: false }),
    ).toMatchObject({ bloom: false, hdr: false });
    expect(
      scenePostprocessState("ultra", { bloom: true, hdr: { user: "h", value: false } }, { h: true }),
    ).toMatchObject({ hdr: true });
    expect(scenePostprocessState("enabled", { bloom: { user: "x", value: false } })).toMatchObject({ bloom: false });
    expect(scenePostprocessState("enabled", { bloom: { user: "x", value: false } }, { x: true })).toMatchObject({
      bloom: true,
    });
    expect(scenePostprocessState("enabled", { bloom: { value: false } })).toMatchObject({ bloom: false });
    // 生效值不是 bool：WPE 不改位，保留默认开
    expect(scenePostprocessState("enabled", { bloom: { value: "0" } })).toMatchObject({ bloom: true });
  });
  it("按 sceneAssets 定位安装目录的 config.json，只读", async () => {
    expect(wpeConfigPath("D:\\Steam\\wallpaper_engine\\assets")).toBe("D:\\Steam\\wallpaper_engine\\config.json");
    expect(wpeConfigPath("/opt/wpe/assets/")).toBe("/opt/wpe/config.json");
    const reader = memoryReader({ "B:\\wpe\\config.json": config("ultra") });
    expect(await readWpePostprocessing(reader, ["A:\\wpe\\assets", "B:\\wpe\\assets"])).toBe("ultra");
    expect(await readWpePostprocessing(reader, [])).toBeNull();
  });
});

describe("脚本静态规则（D10）", () => {
  const vortex =
    "'use strict';\n\nexport function applyUserProperties(userProperties) {\n\tthisObject.colormode = 1;\n}\n";
  it("导出名的词法扫描", () => {
    expect(scriptExports(vortex)).toEqual(["applyUserProperties"]);
    expect(scriptExports("export function update(value) { return value; }\nexport function init() {}")).toEqual([
      "update",
      "init",
    ]);
    expect(scriptExports("const a = 1; export { a as update, b };")).toEqual(["update", "b"]);
    expect(scriptExports("// export function update() {}\nexport const applyUserProperties = () => {};")).toEqual([
      "applyUserProperties",
    ]);
    expect(scriptExports("export default function () {}")).toContain("default");
  });
  it("只导出 applyUserProperties 的按 value 静态处理，其余报 value:script", () => {
    expect(isStaticScript(vortex)).toBe(true);
    expect(isStaticScript("export function update(v) { return v; }")).toBe(false);
    expect(isStaticScript("export function applyUserProperties() {}\nexport function init() {}")).toBe(false);
    const keys = new Set<string>();
    scanValue({ colormode: { script: vortex, value: 0 } }, keys);
    expect([...keys]).toEqual([]);
    scanValue({ color: { script: "export function update() {}", value: "1 0 0" } }, keys);
    expect([...keys]).toEqual(["value:script"]);
  });
});

describe("能力表裁决", () => {
  const vortexGeneral = {
    ambientcolor: "0.3 0.3 0.3",
    bloom: false,
    bloomstrength: 2,
    bloomthreshold: 0.65,
    camerafade: true,
    cameraparallax: false,
    cameraparallaxamount: 0.5,
    camerapreview: true,
    camerashake: false,
    camerashakeamplitude: 0.5,
    clearcolor: "0.7 0.7 0.7",
    clearenabled: true,
    farz: 10000,
    fov: 50,
    nearz: 0.01,
    norecompile: true,
    orthogonalprojection: { width: 3840, height: 2160 },
    skylightcolor: "0.3 0.3 0.3",
    zoom: 1,
    hdr: true,
  };
  const vortexObject = {
    angles: "0 0 0",
    colorBlendMode: 12,
    copybackground: true,
    effects: [],
    id: 13,
    image: "models/vortex.json",
    ledsource: true,
    locktransforms: true,
    name: "vortex",
    origin: "1920 1080 0",
    parallaxDepth: "1 1",
    perspective: false,
    scale: "1 1 1",
    size: "3840 2160",
    solid: true,
    visible: true,
    alignment: "center",
    brightness: 3,
  };
  it("中性字段放行：关闭的视差 / 抖动、zoom 1、ledsource、parallaxDepth、居中、brightness、copybackground、solid", () => {
    const keys = new Set<string>();
    checkSceneFeatures({ general: vortexGeneral, objects: [vortexObject] }, keys);
    expect([...keys]).toEqual([]);
  });
  it("真正改变画面的照报", () => {
    const keys = new Set<string>();
    checkSceneFeatures(
      {
        general: { ...vortexGeneral, cameraparallax: true, zoom: 2 },
        objects: [{ ...vortexObject, alignment: "topleft", perspective: true }],
      },
      keys,
    );
    expect([...keys].sort()).toEqual([
      "general:cameraparallax",
      "general:zoom",
      "object:alignment",
      "object:perspective",
    ]);
  });
  it("着色器：没有 meta.material 的引擎 uniform 要在内置表里，引擎 COMBO 照报", () => {
    const keys = new Set<string>();
    const result = {
      ok: true,
      uniforms: [
        { name: "g_Time", type: "f32", offset: 0, size: 4 },
        { name: "g_Texture3Resolution", type: "vec4<f32>", offset: 16, size: 16 },
        { name: "g_Brightness", type: "f32", offset: 32, size: 4, meta: { material: "brightness" } },
        { name: "g_AudioSpectrum16Left", type: "array<vec4<f32>, 16>", offset: 48, size: 256 },
      ],
      combos: [
        { name: "HUEMODE", value: 1, source: "request" },
        { name: "VERSION", value: 2, source: "request" },
        { name: "SPRITESHEET", value: 1, source: "request" },
        { name: "LIGHTING", value: 0, source: "default" },
      ],
    } as TranslateResult;
    checkProgramFeatures(result, keys);
    expect([...keys].sort()).toEqual(["combo:SPRITESHEET", "uniform:g_AudioSpectrum16Left"]);
  });
  it("内置 uniform 表与渲染器写的值一一对应", () => {
    const written = new Set([
      ...Object.keys(
        staticBuiltins({
          modelViewProjection: identity(),
          modelViewProjectionInverse: identity(),
          model: identity(),
          viewProjection: identity(),
          layer: { alpha: 1, color: [1, 1, 1] },
          textures: [],
          screenSize: [1, 1],
          eye: [],
          ambient: [0, 0, 0],
          skylight: [0, 0, 0],
        }),
      ),
      ...Object.keys(frameBuiltins({ time: 0, frametime: 0, daytime: 0, pointer: [0, 0], pointerLast: [0, 0] })),
    ]);
    expect([...written].sort()).toEqual([...ENGINE_UNIFORMS].sort());
  });
  it("effect：逐项检查实例、effect.json、fbo 与命令", () => {
    const keys = new Set<string>();
    checkEffectFeatures(
      { file: "effects/x/effect.json", id: 1, passes: [{ id: 2, combos: {}, usertextures: ["a"] } as never] },
      {
        name: "x",
        gizmos: [{}],
        passes: [
          { material: "m.json", target: "_rt_A" },
          { command: "swap", source: "_rt_A", target: "_rt_B" },
          { command: "copy", source: "_rt_A", target: "_rt_A" },
          { command: "blit", source: "_rt_A", target: "_rt_A" },
          { material: "m.json", target: "_rt_Missing" },
        ],
        fbos: [{ name: "_rt_A", scale: 2, format: "rgba_backbuffer" }],
      },
      "x",
      keys,
    );
    expect([...keys].sort()).toEqual([
      "effect:x:command:blit",
      "effect:x:pass:usertextures",
      "effect:x:swap-operands",
      "effect:x:target:_rt_Missing",
    ]);
  });
  it("需要帧缓冲：材质名 → 着色器注解 default", () => {
    const shader = (slot: number, fallback?: string) =>
      ({
        ok: true,
        textures: [
          {
            slot,
            name: `g_Texture${slot}`,
            kind: "2d",
            binding: 1,
            samplerBinding: 2,
            meta: fallback ? { default: fallback } : {},
          },
        ],
      }) as TranslateResult;
    expect(needsFramebuffer([], shader(4, "_rt_FullFrameBuffer"))).toBe(true);
    // 材质给了名字就不看注解
    expect(needsFramebuffer([null, null, null, null, "util/white"], shader(4, "_rt_FullFrameBuffer"))).toBe(false);
    expect(needsFramebuffer(["_rt_FullFrameBuffer"], null)).toBe(true);
    expect(needsFramebuffer(["vortex"], shader(1, "util/white"))).toBe(false);
  });
  it("passthrough 材质看 scene.json 顶层 version", () => {
    expect(passthroughMaterial(undefined)).toBe("materials/util/effectpassthrough.json");
    expect(passthroughMaterial(2)).toBe("materials/util/effectpassthrough.json");
    expect(passthroughMaterial(3)).toBe("materials/util/effectpassthrough_4.json");
  });
  it("fbo 格式：backbuffer 随 HDR，不认识的按 rgba8888", () => {
    expect(fboFormat("rgba_backbuffer", false)).toBe("rgba8888");
    expect(fboFormat("rgba_backbuffer", true)).toBe("rgba16161616f");
    expect(fboFormat("rgb_backbuffer", false)).toBe("rgb888");
    expect(fboFormat("r16f", false)).toBe("r16f");
    expect(fboFormat("whatever", false)).toBe("rgba8888");
    expect(fboFormat(undefined, false)).toBe("rgba8888");
  });
});

describe("FreeImage .tex 与解码缓存", () => {
  const u32 = (v: number) => {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, v >>> 0, true);
    return b;
  };
  const magic = (t: string) => new Uint8Array([...new TextEncoder().encode(t), 0]);
  const join = (...parts: Uint8Array[]) => {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  };
  // 头写 4096×4096、图像 3840×2160，两级 PNG mip
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  const tex = join(
    magic("TEXV0005"),
    magic("TEXI0001"),
    u32(0),
    u32(2),
    u32(4096),
    u32(4096),
    u32(3840),
    u32(2160),
    u32(0),
    magic("TEXB0003"),
    u32(1),
    u32(13),
    u32(2),
    ...[3840, 1920].flatMap((w) => [u32(w), u32(w * 0.5625), u32(0), u32(0), u32(png.length), png]),
  );
  it("mip 不在 Worker 读，只给出磁盘区间（含 pkg 条目的偏移）", async () => {
    const result = await parseTex({
      source: "pkg",
      path: "P:\\scene.pkg:materials/a.tex",
      size: tex.length,
      location: { path: "P:\\scene.pkg", offset: 1000 },
      readRange: async (start, end) => tex.slice(start, end),
    });
    expect(result.unsupported).toEqual([]);
    expect(result.images[0].mips.every((mip) => mip.bytes === undefined)).toBe(true);
    expect(result.encoded?.mime).toBe("image/png");
    expect(result.encoded?.path).toBe("P:\\scene.pkg");
    const first = result.images[0].mips[0];
    expect(result.encoded?.mips[0]).toEqual({ start: 1000 + first.offset, end: 1000 + first.offset + png.length });
    expect(result.encoded?.mips).toHaveLength(2);
  });
  it("编译后纹理尺寸取头里的图像尺寸（UV 为 1），mip 留给主线程解码", async () => {
    const files: Record<string, Uint8Array | string> = {
      "P:\\project.json": JSON.stringify({ file: "scene.json" }),
      "P:\\scene.json": JSON.stringify({
        general: { orthogonalprojection: { width: 3840, height: 2160 } },
        objects: [{ id: 1, image: "models/a.json" }],
      }),
      "P:\\models\\a.json": JSON.stringify({ material: "materials/a.json" }),
      "P:\\materials\\a.json": JSON.stringify({ passes: [{ textures: ["a"] }] }),
      "P:\\materials\\a.tex": tex,
    };
    const bundle = await compileScene({
      projectDir: "P:",
      sceneAssets: ["A:"],
      reader: memoryReader(files),
      translator: null,
      postprocess: "disabled",
      exhaustive: true,
    });
    expect(bundle.textures[0]).toMatchObject({ width: 3840, height: 2160, textureWidth: 3840, textureHeight: 2160 });
    expect(bundle.textures[0].mips).toEqual([]);
    expect(bundle.textures[0].encoded?.mips).toHaveLength(2);
    // 尺寸缺失时取基础纹理的图像尺寸（autosize）
    expect(bundle.layers[0].size).toEqual([3840, 2160]);
  });
  it("缓存：同一区间只读、只解码一次；retain 关闭不再用的位图；失败不进缓存", async () => {
    const reader = memoryReader({ "F:\\a.tex": new Uint8Array(100) });
    let decoded = 0;
    const closed: number[] = [];
    const cache = new TextureDecodeCache(reader, async (bytes) => {
      decoded++;
      const id = decoded;
      return { width: bytes.length, height: 1, close: () => closed.push(id) } as unknown as ImageBitmap;
    });
    const bundle = {
      textures: [
        {
          mips: [],
          encoded: {
            mime: "image/png",
            path: "F:\\a.tex",
            mips: [
              { start: 0, end: 10 },
              { start: 10, end: 15 },
            ],
          },
        },
      ],
    } as unknown as SceneBundle;
    await decodeEncodedTextures(bundle, cache);
    expect(bundle.textures[0].mips.map((mip) => mip.width)).toEqual([10, 5]);
    // 重新编译：同一区间命中缓存
    const again = structuredClone({ ...bundle, textures: [{ ...bundle.textures[0], mips: [] }] }) as SceneBundle;
    await decodeEncodedTextures(again, cache);
    expect(decoded).toBe(2);
    expect(reader.reads).toHaveLength(2);
    cache.retain(new Set(["F:\\a.tex|0|10"]));
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(closed).toEqual([2]);
    expect(cache.size).toBe(1);
    await expect(cache.get("F:\\missing.tex", 0, 4, "image/png")).rejects.toThrow("Failed to fetch");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(cache.size).toBe(1);
  });
});

// 本机语料：P2a 的两张主样本按档位与强制渲染的结构
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

describe.skipIf(!root || !existsSync(wasm))("本机 P2a 样本", () => {
  const compile = async (sample: string, options: Partial<Parameters<typeof compileScene>[0]> = {}) =>
    compileScene({
      projectDir: join(root!, "projects", "defaultprojects", sample),
      sceneAssets: [join(root!, "assets")],
      reader: fsReader,
      translator: await Wpesl2wgsl.fromBytes(readFileSync(wasm)),
      ...options,
    });
  it("没写 size 的图层先取模型 width / height（deep_space 的 Background 槽 0 是 480×270 的遮罩）", async () => {
    const bundle = await compile("deep_space", { postprocess: "disabled" });
    expect(bundle.layers.map((layer) => layer.size)).toEqual([
      [1920, 1080],
      [1920, 1080],
    ]);
  }, 60000);
  it("razer_vortex：三层各一个 tint（rz 着色器），HUEMODE 与用户属性进 uniform，底图是 7 级 PNG", async () => {
    const bundle = await compile("razer_vortex", { postprocess: "disabled" });
    expect(bundle.unsupported).toEqual([]);
    expect(bundle.layers.map((layer) => [layer.name, layer.effects.length, layer.colorBlendMode])).toEqual([
      ["vortex", 1, 0],
      ["THS", 1, 0],
      ["led", 1, 0],
    ]);
    const vortex = bundle.textures.find((t) => t.path === "materials/vortex.tex")!;
    expect(vortex).toMatchObject({ width: 3840, height: 2160, textureWidth: 3840, textureHeight: 2160 });
    expect(vortex.encoded?.mips).toHaveLength(7);
    const step = bundle.layers[0].effects[0].steps[0];
    expect(step.kind).toBe("draw");
    if (step.kind !== "draw") return;
    // 槽 1 = wave（实例覆盖 [null, "wave"]），槽 0 留给上一步输出
    expect(Object.keys(step.pass.textures)).toEqual(["1"]);
    expect(bundle.textures[step.pass.textures[1]].path).toBe("materials/wave.tex");
    const program = bundle.programs[step.pass.program!];
    expect(program.combos?.find((c) => c.name === "HUEMODE")?.value).toBe(0);
    // brightness 绑定用户属性（项目默认 1），speedx 绑定 ui_editor_properties_speed（0.3），colormode 是静态脚本的 value 0
    expect(step.pass.uniforms.g_Brightness).toEqual([1]);
    expect(step.pass.uniforms.g_ScrollX).toEqual([0.3]);
    expect(step.pass.uniforms.g_CMode).toEqual([0]);
    const ths = bundle.layers[1].effects[0].steps[0];
    if (ths.kind === "draw")
      expect(bundle.programs[ths.pass.program!].combos?.find((c) => c.name === "HUEMODE")?.value).toBe(1);
    // vortex 本身 bloom: false：开启 / 超高都不报后处理
    expect((await compile("razer_vortex", { postprocess: "ultra" })).unsupported).toEqual([]);
  }, 60000);
  it("razer_bedroom：三档都只剩 value:script（泛光 / HDR 是 P2b）；强制渲染时 passthrough 用 genericimage3", async () => {
    for (const postprocess of ["disabled", "enabled", "ultra"] as const)
      expect((await compile("razer_bedroom", { postprocess, exhaustive: true })).unsupported).toEqual(["value:script"]);
    const forced = await compile("razer_bedroom", { postprocess: "disabled", force: true });
    const blended = forced.layers.filter((layer) => layer.colorBlendMode !== 0);
    expect(blended.map((layer) => layer.colorBlendMode).sort()).toEqual([11, 11, 11, 11, 11, 12]);
    for (const layer of blended) {
      expect(layer.passthrough?.framebuffer).toBe(true);
      expect(layer.passthrough?.uniforms.g_Color4).toEqual([1, 1, 1, 1]);
      const program = forced.programs[layer.passthrough!.program!];
      expect(program.combos?.find((c) => c.name === "BLENDMODE")?.value).toBe(layer.colorBlendMode);
      expect(program.textures?.some((t) => t.slot === 4 && t.meta?.default === "_rt_FullFrameBuffer")).toBe(true);
    }
    // 9 条 scroll（其中 1 条在隐藏图层上）+ 6 条 tint
    const effects = forced.layers.flatMap((layer) => layer.effects.map((effect) => effect.file));
    expect(effects.filter((file) => file.includes("scroll"))).toHaveLength(9);
    expect(effects.filter((file) => file.includes("tint"))).toHaveLength(6);
  }, 60000);
});
