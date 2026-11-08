/**
 * P4b 步骤 5（`genericparticle` 的 `REFRACT`、`CUTOUT`，以及 `REFRACT` 带出的 `NORMALMAP`）：
 * - 能力表放行这三个 COMBO，`LIGHTING` 与别的 COMBO 照报；
 * - 粒子材质任何槽位的帧表纹理都当普通纹理（不报 `tex:animation`），多图像、空帧表照报，effect 材质里照报；
 * - 本机有 WPE 时用真翻译器编一个仿 `p4b-refract` / `p4b-refract2` 的工程（材质照 `ignore/p4/proj/p4b-refract`），
 *   用假设备建场景，钉住：快照的位置与次数（存活数为 0 也拷）、`NORMALMAP` 由槽 1 的纹理带出、没开折射时 `NORMALMAP`
 *   不改着色器、法线图按原格式交给翻译器（`TEX1FORMAT`），以及渲染时 uniform 缓冲里的常量。常量是步骤 0 的 WPE 实测值
 *   （计划步骤 5「思路」）：`g_RefractAmount` 取材质值（0.2、缺省 0.05、0.1），`g_Cutout*` 0.3 / 0.5 / 0.8，
 *   `g_Overbright` 1，`g_ViewRight` (1, 0, 0)、`g_ViewUp` (0, 1, 0)，正交与透视粒子相同。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { compileScene, FRAMEBUFFER_RT, type SceneBundle } from "./bundle";
import { checkParticleProgram } from "./features";
import type { SceneReader } from "./fs";
import type { MaterialPass } from "./model";
import { TEX_FLAGS } from "./tex";
import { planParticleLayer } from "../render/graph";
import { GpuScene } from "../render/scene";
import { SceneState } from "../render/state";
import { Wpesl2wgsl, type TranslateRequest, type TranslateResult } from "../wpesl2wgsl";

vi.mock("../fileUrl", () => ({ fileToUrl: (path: string) => path }));
vi.mock("../render/device", () => ({ acquireGpu: vi.fn() }));

describe("能力表：折射、裁切与法线图的 COMBO", () => {
  const result = (combos: TranslateResult["combos"]): TranslateResult => ({ ok: true, combos });
  const check = (pass: MaterialPass, translated: TranslateResult | null = null) => {
    const keys = new Set<string>();
    checkParticleProgram(pass, translated, keys);
    return [...keys].sort();
  };

  it("材质写的 REFRACT、CUTOUT 放行（大小写、布尔都认）", () => {
    expect(check({ combos: { REFRACT: 1 } })).toEqual([]);
    expect(check({ combos: { CUTOUT: 1 } })).toEqual([]);
    expect(check({ combos: { refract: true, cutout: true } })).toEqual([]);
  });

  it("NORMALMAP 由槽 1 的纹理带出（source texture）时放行，开不开折射都放行（没开时不起作用，语料 2903412088）", () => {
    const normal = { name: "NORMALMAP", value: 1, source: "texture" } as const;
    expect(
      check({ combos: { REFRACT: 1 } }, result([normal, { name: "REFRACT", value: 1, source: "request" }])),
    ).toEqual([]);
    expect(check({}, result([normal]))).toEqual([]);
  });

  it("LIGHTING 仍报 particle:lighting，别的 COMBO 仍报 particle:combo:<名字>", () => {
    expect(check({ combos: { REFRACT: 1, LIGHTING: 1 } })).toEqual(["particle:lighting"]);
    expect(check({ combos: { CUTOUT: 1, DOUBLESIDEDLIGHTING: 1 } })).toEqual(["particle:combo:DOUBLESIDEDLIGHTING"]);
  });
});

// ———— 没有 WPE 也能跑的编译期用例：内存工程 + 假翻译器 ————

function bytes(...chunks: (Uint8Array | number[])[]): Uint8Array {
  const arrays = chunks.map((chunk) => (chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk)));
  const out = new Uint8Array(arrays.reduce((sum, chunk) => sum + chunk.length, 0));
  let at = 0;
  for (const chunk of arrays) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}
const u32 = (value: number) => {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value >>> 0, true);
  return out;
};
const f32 = (value: number) => {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setFloat32(0, value, true);
  return out;
};
const magic = (text: string) => bytes(new TextEncoder().encode(text), [0]);

/**
 * 一张 RGBA8888 的 64² `.tex`（TEXB0003，每张图像一级 mip），`frames` 给了就是 TEXS0002 帧表（每帧 32² 网格）。
 * mip 数据是每像素 1 字节的花样，不按格式算长度（同 `sheet.test.ts`）。
 */
function tex(frames?: number, images = 1): Uint8Array {
  const flags = TEX_FLAGS.clampUVs | (frames !== undefined ? TEX_FLAGS.animated : 0);
  const image = bytes(u32(1), u32(64), u32(64), u32(0), u32(64 * 64), u32(64 * 64), new Uint8Array(64 * 64));
  const sheet =
    frames === undefined
      ? new Uint8Array()
      : bytes(
          magic("TEXS0002"),
          u32(frames),
          ...Array.from({ length: frames }, (_, i) =>
            bytes(u32(0), f32(0.05), f32((i % 2) * 32), f32(Math.floor(i / 2) * 32), f32(32), f32(0), f32(0), f32(32)),
          ),
        );
  return bytes(
    magic("TEXV0005"),
    magic("TEXI0001"),
    u32(0),
    u32(flags),
    u32(64),
    u32(64),
    u32(64),
    u32(64),
    u32(0),
    magic("TEXB0003"),
    u32(images),
    u32(-1),
    ...Array.from({ length: images }, () => image),
    sheet,
  );
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

/** 假翻译器：每次请求都记下来，按 `reply` 回复。 */
function fakeTranslator(reply: (request: TranslateRequest) => Partial<TranslateResult> = () => ({})) {
  const requests: TranslateRequest[] = [];
  const translator = {
    async translate(request: TranslateRequest): Promise<TranslateResult> {
      requests.push(request);
      return { ok: true, uniforms: [], textures: [], combos: [], ...reply(request) } as TranslateResult;
    },
  } as unknown as Wpesl2wgsl;
  return { translator, requests };
}

describe("compileScene：粒子其它槽位的帧表纹理（P4b 步骤 5）", () => {
  const ORTHO = { orthogonalprojection: { width: 1920, height: 1080 } };
  const files = (extra: Record<string, unknown> = {}) => ({
    "P:/p/project.json": { file: "scene.json" },
    "P:/p/scene.json": { general: ORTHO, objects: [{ id: 1, particle: "particles/p.json" }] },
    "P:/p/particles/p.json": {
      material: "materials/pm.json",
      maxcount: 3,
      emitter: [{ name: "sphererandom", rate: 1 }],
    },
    "P:/p/materials/particle/plain.tex": tex(),
    "P:/p/materials/particle/sheet.tex": tex(4),
    "P:/p/materials/particle/multi.tex": tex(4, 2),
    "P:/p/materials/particle/empty.tex": tex(0),
    "P:/p/shaders/genericparticle.vert": "void main(){}",
    "P:/p/shaders/genericparticle.frag": "void main(){}",
    "P:/p/shaders/s.vert": "void main(){}",
    "P:/p/shaders/s.frag": "void main(){}",
    ...extra,
  });
  const particleMaterial = (textures: string[]) => ({
    "P:/p/materials/pm.json": { passes: [{ shader: "genericparticle", textures }] },
  });
  const compile = (reader: SceneReader, translator: Wpesl2wgsl) =>
    compileScene({
      projectDir: "P:/p",
      sceneAssets: ["A:/assets"],
      reader,
      translator,
      postprocess: "disabled",
      exhaustive: true,
    });

  it("槽 1 是多图像、空帧表：照报 tex:animation:multi-image / empty，只去掉 tex:animation", async () => {
    const multi = await compile(
      memoryReader(files(particleMaterial(["particle/plain", "particle/multi"]))),
      fakeTranslator().translator,
    );
    expect(multi.unsupported).toEqual(["tex:animation:multi-image"]);
    const empty = await compile(
      memoryReader(files(particleMaterial(["particle/plain", "particle/empty"]))),
      fakeTranslator().translator,
    );
    expect(empty.unsupported).toEqual(["tex:animation:empty"]);
  });

  it("槽 1 按着色器注解 default 绑到帧表纹理：同样不报，按普通纹理绑定；帧表语义仍只看槽 0", async () => {
    const { translator } = fakeTranslator(() => ({
      textures: [
        { slot: 0, name: "g_Texture0", kind: "2d", binding: 1, samplerBinding: 2 },
        { slot: 1, name: "g_Texture1", kind: "2d", binding: 3, samplerBinding: 4, meta: { default: "particle/sheet" } },
      ] as TranslateResult["textures"],
    }));
    const bundle = await compile(memoryReader(files(particleMaterial(["particle/plain"]))), translator);
    expect(bundle.unsupported).toEqual([]);
    const pass = bundle.layers[0].particle!.passes[0];
    expect(pass.textures).toEqual({ 0: 0, 1: 1 });
    expect(bundle.textures[1].path).toBe("materials/particle/sheet.tex");
    expect(bundle.textures[1].sheet).toBeDefined();
    expect(bundle.layers[0].particle!.spriteSheet).toBe(false);
  });

  it("effect 材质里的帧表纹理照报 tex:animation（图像层的帧动画属 P6）", async () => {
    const bundle = await compile(
      memoryReader(
        files({
          "P:/p/scene.json": {
            general: ORTHO,
            objects: [{ id: 1, image: "models/a.json", effects: [{ file: "effects/e/effect.json" }] }],
          },
          "P:/p/models/a.json": { material: "materials/a.json", width: 64, height: 64 },
          "P:/p/materials/a.json": { passes: [{ shader: "s", textures: ["particle/plain"] }] },
          "P:/p/effects/e/effect.json": { passes: [{ material: "materials/fx.json" }] },
          "P:/p/materials/fx.json": { passes: [{ shader: "s", textures: [null, "particle/sheet"] }] },
        }),
      ),
      fakeTranslator().translator,
    );
    expect(bundle.unsupported).toEqual(["tex:animation"]);
  });
});

// ———— 本机有 WPE：真翻译器 + 假设备 ————

const root = process.env.KABEGAME_WPE_ROOT;
const wasm = join(__dirname, "..", "wpesl2wgsl", "wpesl2wgsl.wasm");

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

/**
 * 仿 `p4b-refract`（对象顺序：图像 → P → Q → R → CUT → P0 → PP）加 `p4b-refract2` 的 S、N0、N1。材质照
 * `ignore/p4/proj/p4b-refract/materials/particle/*.json`，纹理都在 WPE `assets`。
 */
const REFRACT_SCENE = {
  names: ["img", "P", "Q", "R", "CUT", "P0", "PP", "S", "N0", "N1"],
  files(): Record<string, unknown> {
    const material = (textures: string[], combos: Record<string, number>, constants: Record<string, number> = {}) => ({
      passes: [
        {
          shader: "genericparticle",
          cullmode: "nocull",
          depthtest: "disabled",
          depthwrite: "disabled",
          blending: "translucent",
          textures,
          combos,
          constantshadervalues: constants,
        },
      ],
    });
    const system = (name: string, extra: Record<string, unknown> = {}) => ({
      material: `materials/particle/${name}.json`,
      maxcount: 8,
      emitter: [{ name: "sphererandom", origin: "960 540 0", distancemax: 0, rate: 10 }],
      initializer: [
        { name: "lifetimerandom", min: 3, max: 3 },
        { name: "sizerandom", min: 40, max: 40 },
      ],
      ...extra,
    });
    const objects = REFRACT_SCENE.names.map((name, i) =>
      name === "img"
        ? { id: i + 1, name, image: "models/img.json", origin: "960 540 0", size: "480 480" }
        : { id: i + 1, name, particle: `particles/${name}.json` },
    );
    return {
      "P:/p/project.json": { file: "scene.json" },
      "P:/p/scene.json": { general: { orthogonalprojection: { width: 1920, height: 1080 } }, objects },
      "P:/p/models/img.json": { material: "materials/img.json", width: 480, height: 480 },
      "P:/p/materials/img.json": {
        passes: [{ shader: "genericimage2", blending: "translucent", textures: ["util/white"] }],
      },
      "P:/p/particles/P.json": system("rf-normal"),
      "P:/p/particles/Q.json": system("rf-plain"),
      "P:/p/particles/R.json": system("rf-rg88"),
      "P:/p/particles/CUT.json": system("cutout"),
      // 寿命 0.3 s、每秒 1 个：开场与之后都有没有存活粒子的帧
      "P:/p/particles/P0.json": system("rf-plain", {
        emitter: [{ name: "sphererandom", origin: "960 540 0", distancemax: 0, rate: 1 }],
        initializer: [
          { name: "lifetimerandom", min: 0.3, max: 0.3 },
          { name: "sizerandom", min: 40, max: 40 },
        ],
      }),
      "P:/p/particles/PP.json": system("rf-normal", { flags: 4 }),
      "P:/p/particles/S.json": system("rf-sheet"),
      "P:/p/particles/N0.json": system("n0"),
      "P:/p/particles/N1.json": system("n1"),
      "P:/p/materials/particle/rf-normal.json": material(
        ["util/white", "particle/drop_normal"],
        { REFRACT: 1 },
        { ui_editor_properties_refract_amount: 0.2 },
      ),
      "P:/p/materials/particle/rf-plain.json": material(["util/white"], { REFRACT: 1 }),
      "P:/p/materials/particle/rf-rg88.json": material(
        ["util/white", "particle/smoke/smoke2normal"],
        { REFRACT: 1 },
        { ui_editor_properties_refract_amount: 0.1 },
      ),
      "P:/p/materials/particle/cutout.json": material(
        ["particle/misc/lambda"],
        { CUTOUT: 1 },
        {
          ui_editor_properties_cutout_start: 0.3,
          ui_editor_properties_cutout_end: 0.5,
          ui_editor_properties_cutout_opacity: 0.8,
        },
      ),
      "P:/p/materials/particle/rf-sheet.json": material(
        ["particle/water/rain_drops_sheet", "particle/water/rain_drops_sheet_normal"],
        { REFRACT: 1 },
      ),
      "P:/p/materials/particle/n0.json": material(["util/white", "particle/drop_normal"], {}),
      "P:/p/materials/particle/n1.json": material(["util/white"], {}),
    };
  },
};

// ———— 假设备（照 `render/particles.test.ts`）：记录缓冲内容与编码轨迹（快照拷贝记为 `copy`） ————

interface FakeBuffer {
  label: string;
  bytes: Uint8Array;
}

class FakeGpu {
  readonly trace: string[] = [];
  readonly device: GPUDevice;

  constructor() {
    const pass = () => ({
      setViewport() {},
      setPipeline() {},
      setBindGroup() {},
      setVertexBuffer() {},
      setIndexBuffer() {},
      draw: (count: number) => this.trace.push(`draw ${count}`),
      drawIndexed: (count: number) => this.trace.push(`drawIndexed ${count}`),
      end() {},
    });
    this.device = {
      limits: { maxTextureDimension2D: 8192 },
      lost: new Promise(() => {}),
      destroy() {},
      createTexture: (descriptor: GPUTextureDescriptor) => ({
        label: descriptor.label ?? "",
        format: descriptor.format,
        createView: () => ({ label: descriptor.label ?? "" }),
        destroy() {},
      }),
      createSampler: () => ({}),
      createBuffer: (descriptor: GPUBufferDescriptor): FakeBuffer & { destroy(): void } => ({
        label: descriptor.label ?? "",
        bytes: new Uint8Array(descriptor.size),
        destroy() {},
      }),
      createShaderModule: () => ({ getCompilationInfo: async () => ({ messages: [] }) }),
      createBindGroupLayout: () => ({}),
      createPipelineLayout: () => ({}),
      createRenderPipeline: () => ({ getBindGroupLayout: () => ({}) }),
      createRenderPipelineAsync: async () => ({ getBindGroupLayout: () => ({}) }),
      createBindGroup: () => ({}),
      createCommandEncoder: () => ({
        beginRenderPass: () => pass(),
        copyTextureToTexture: () => this.trace.push("copy"),
        copyTextureToBuffer() {},
        finish: () => ({}),
      }),
      queue: {
        writeBuffer: (buffer: FakeBuffer, offset: number, data: ArrayBuffer, dataOffset = 0, size?: number) => {
          buffer.bytes.set(new Uint8Array(data, dataOffset, size ?? data.byteLength - dataOffset), offset);
        },
        writeTexture() {},
        submit() {},
        onSubmittedWorkDone: async () => {},
      },
      pushErrorScope() {},
      popErrorScope: async () => null,
    } as unknown as GPUDevice;
  }

  encode(scene: GpuScene, state: SceneState): string[] {
    this.trace.length = 0;
    scene.encode(this.device.createCommandEncoder(), state);
    return [...this.trace];
  }
}

interface DrawView {
  object: number;
  particles: { count: number } | null;
  uniformBuffer: FakeBuffer;
}
const particleDraw = (scene: GpuScene, object: number): DrawView =>
  [...(scene as unknown as { draws: Set<DrawView> }).draws].find((draw) => draw.object === object && draw.particles)!;

describe.skipIf(!root || !existsSync(wasm))("真翻译器：折射、裁切工程（仿 p4b-refract / p4b-refract2）", () => {
  let compiled: { bundle: SceneBundle; requests: TranslateRequest[] } | null = null;
  /** 编一次，几个用例共用（真翻译器 + 2 MB 的法线图，单次约 1 秒）。 */
  async function compileRefract() {
    if (compiled) return compiled;
    const translator = await Wpesl2wgsl.fromBytes(readFileSync(wasm));
    const requests: TranslateRequest[] = [];
    const spy = {
      translate(request: TranslateRequest) {
        requests.push(request);
        return translator.translate(request);
      },
    } as unknown as Wpesl2wgsl;
    const bundle = await compileScene({
      projectDir: "P:/p",
      sceneAssets: [join(root!, "assets")],
      reader: mixedReader(REFRACT_SCENE.files()),
      translator: spy,
      postprocess: "disabled",
      exhaustive: true,
    });
    compiled = { bundle, requests };
    return compiled;
  }
  const object = (name: string) => REFRACT_SCENE.names.indexOf(name);
  const layerOf = (bundle: SceneBundle, name: string) => bundle.layers.find((layer) => layer.object === object(name))!;
  const passOf = (bundle: SceneBundle, name: string) => layerOf(bundle, name).particle!.passes[0];
  const programOf = (bundle: SceneBundle, name: string) => bundle.programs[passOf(bundle, name).program!];
  const REFRACTING = ["P", "Q", "R", "P0", "PP", "S"];
  const NOT_REFRACTING = ["CUT", "N0", "N1"];

  beforeEach(() => {
    vi.stubGlobal("GPUTextureUsage", { RENDER_ATTACHMENT: 1, TEXTURE_BINDING: 2, COPY_SRC: 4, COPY_DST: 8 });
    vi.stubGlobal("GPUBufferUsage", { VERTEX: 1, UNIFORM: 2, COPY_DST: 4, MAP_READ: 8, INDEX: 16 });
    vi.stubGlobal("GPUMapMode", { READ: 1 });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("没有不支持项；折射材质读帧缓冲（槽 3 = _rt_FullFrameBuffer），裁切与没开折射的不读", async () => {
    const { bundle } = await compileRefract();
    expect(bundle.unsupported).toEqual([]);
    for (const name of REFRACTING) {
      const pass = passOf(bundle, name);
      expect(pass.program, name).not.toBeNull();
      expect(pass.framebuffer, name).toBe(true);
      expect(pass.runtime, name).toEqual({ 3: FRAMEBUFFER_RT });
      expect(programOf(bundle, name).textures?.find((texture) => texture.slot === 3)?.meta?.default, name).toBe(
        FRAMEBUFFER_RT,
      );
    }
    for (const name of NOT_REFRACTING) {
      expect(passOf(bundle, name).framebuffer, name).toBe(false);
      expect(passOf(bundle, name).runtime, name).toEqual({});
    }
  }, 120000);

  it("NORMALMAP 由槽 1 绑的纹理带出（source texture），只看槽位：开没开折射都定义，没有槽 1 就没有", async () => {
    const { bundle } = await compileRefract();
    const normalmap = (name: string) => programOf(bundle, name).combos?.find((combo) => combo.name === "NORMALMAP");
    for (const name of ["P", "R", "PP", "S", "N0"])
      expect(normalmap(name), name).toEqual({ name: "NORMALMAP", value: 1, source: "texture" });
    for (const name of ["Q", "P0", "CUT", "N1"]) expect(normalmap(name), name).toBeUndefined();
    expect(programOf(bundle, "P").combos?.find((combo) => combo.name === "REFRACT")).toMatchObject({
      value: 1,
      source: "request",
    });
    expect(programOf(bundle, "CUT").combos?.find((combo) => combo.name === "CUTOUT")).toMatchObject({
      value: 1,
      source: "request",
    });
  }, 120000);

  it("没开折射时 NORMALMAP 不起作用：N0（绑了槽 1）与 N1（没绑）翻译出的着色器逐字相同", async () => {
    const { bundle } = await compileRefract();
    const n0 = programOf(bundle, "N0"),
      n1 = programOf(bundle, "N1");
    expect(n0).not.toBe(n1);
    expect(n0.vertex!.wgsl).toBe(n1.vertex!.wgsl);
    expect(n0.fragment!.wgsl).toBe(n1.fragment!.wgsl);
    // 开了折射的才用 g_Texture1
    expect(n0.textures?.some((texture) => texture.slot === 1)).toBe(false);
    expect(programOf(bundle, "P").textures?.some((texture) => texture.slot === 1)).toBe(true);
  }, 120000);

  it("法线图按原格式交给翻译器（TEX1FORMAT：drop_normal 是 RGBA 0、smoke2normal 是 RG88 8）", async () => {
    const { bundle, requests } = await compileRefract();
    const formatOf = (name: string, slot: number) => {
      const path = bundle.textures[passOf(bundle, name).textures[slot]].path;
      return { path, format: bundle.textures[passOf(bundle, name).textures[slot]].format };
    };
    expect(formatOf("P", 1)).toEqual({ path: "materials/particle/drop_normal.tex", format: 0 });
    expect(formatOf("R", 1)).toEqual({ path: "materials/particle/smoke/smoke2normal.tex", format: 8 });
    const refract = requests.filter((request) => request.combos?.REFRACT === 1);
    expect(refract.some((request) => request.textures?.some((t) => t.slot === 1 && t.format === 8))).toBe(true);
    expect(refract.some((request) => request.textures?.some((t) => t.slot === 1 && t.format === 0))).toBe(true);
  }, 120000);

  it("帧表法线图（S 的槽 1）是普通纹理：不报 tex:animation，帧表语义按槽 0（rain_drops_sheet）", async () => {
    const { bundle } = await compileRefract();
    const pass = passOf(bundle, "S");
    const slot0 = bundle.textures[pass.textures[0]],
      slot1 = bundle.textures[pass.textures[1]];
    expect(slot0.path).toBe("materials/particle/water/rain_drops_sheet.tex");
    expect(slot1.path).toBe("materials/particle/water/rain_drops_sheet_normal.tex");
    expect(slot1.sheet).toBeDefined();
    expect(layerOf(bundle, "S").particle!.spriteSheet).toBe(true);
  }, 120000);

  it("粒子层计划：折射层先 snapshot 再画、槽 3 读快照；裁切与没开折射的层没有 snapshot", async () => {
    const { bundle } = await compileRefract();
    for (const name of REFRACTING) {
      const plan = planParticleLayer(layerOf(bundle, name));
      expect(plan.reasons, name).toEqual([]);
      expect(
        plan.steps.map((step) => step.kind),
        name,
      ).toEqual(["snapshot", "particles"]);
      const draw = plan.steps[1];
      expect(draw.kind === "particles" && draw.inputs[3], name).toEqual({ kind: "framebuffer" });
    }
    for (const name of NOT_REFRACTING)
      expect(
        planParticleLayer(layerOf(bundle, name)).steps.map((step) => step.kind),
        name,
      ).toEqual(["particles"]);
  }, 120000);

  it("每帧快照次数 = 折射对象数，存活数为 0 的折射层（开场、P0 的空档）照拷", async () => {
    const { bundle } = await compileRefract();
    const gpu = new FakeGpu();
    const state = SceneState.fromBundle(bundle);
    const scene = await GpuScene.build(gpu.device, bundle, state, new Set(), [], { particles: { seed: 1 } });
    const frame = (frametime: number, time: number) => ({
      time,
      frametime,
      daytime: 0.5,
      pointer: [0.5, 0.5] as [number, number],
      pointerLast: [0.5, 0.5] as [number, number],
      cursor: [0.5, 0.5] as [number, number],
    });
    /** 编码一帧（存活数在编码时随顶点上传更新），返回快照次数与各折射层的存活数。 */
    const encode = () => {
      const copies = gpu.encode(scene, state).filter((line) => line === "copy").length;
      return { copies, alive: REFRACTING.map((name) => particleDraw(scene, object(name)).particles!.count) };
    };
    // 建好还没步进：全部 0 个，照样每个折射层拷一次
    const first = encode();
    expect(first.alive.every((count) => count === 0)).toBe(true);
    expect(first.copies).toBe(REFRACTING.length);
    // 走 0.5 s：P0 每秒 1 个、寿命 0.3 s，已经死掉，其余各有存活
    let time = 0;
    for (let i = 0; i < 5; i++) scene.update(frame(0.1, (time += 0.1)), state);
    const later = encode();
    expect(later.alive[REFRACTING.indexOf("P0")]).toBe(0);
    expect(later.alive.filter((count) => count > 0)).toHaveLength(REFRACTING.length - 1);
    expect(later.copies).toBe(REFRACTING.length);
  }, 120000);

  it("渲染时的常量与 WPE 实测相同：g_RefractAmount、g_Cutout*、g_Overbright、视图轴（正交与透视粒子）", async () => {
    const { bundle } = await compileRefract();
    const gpu = new FakeGpu();
    const state = SceneState.fromBundle(bundle);
    const scene = await GpuScene.build(gpu.device, bundle, state, new Set(), [], { particles: { seed: 1 } });
    /** 按真实反射的偏移读这个对象粒子绘制的 uniform 缓冲。 */
    const read = (name: string, uniform: string): number[] | undefined => {
      const entry = programOf(bundle, name).uniforms?.find((item) => item.name === uniform);
      if (!entry) return undefined;
      const buffer = particleDraw(scene, object(name)).uniformBuffer.bytes;
      return Array.from(new Float32Array(buffer.buffer, entry.offset, Math.round(entry.size / 4)));
    };
    const f = Math.fround;
    expect(read("P", "g_RefractAmount")).toEqual([f(0.2)]);
    expect(read("Q", "g_RefractAmount")).toEqual([f(0.05)]); // 着色器注解缺省
    expect(read("R", "g_RefractAmount")).toEqual([f(0.1)]);
    expect(read("PP", "g_RefractAmount")).toEqual([f(0.2)]);
    expect(read("CUT", "g_CutoutStart")).toEqual([f(0.3)]);
    expect(read("CUT", "g_CutoutEnd")).toEqual([f(0.5)]);
    expect(read("CUT", "g_CutoutOpacity")).toEqual([f(0.8)]);
    for (const name of [...REFRACTING, ...NOT_REFRACTING]) expect(read(name, "g_Overbright"), name).toEqual([1]);
    // 视图轴：正交（P）与透视（PP，flags & 4）相同；折射着色器两个都声明了
    expect(layerOf(bundle, "PP").particle!.flags & 4).toBe(4);
    for (const name of ["P", "PP"]) {
      expect(read(name, "g_ViewRight"), name).toEqual([1, 0, 0]);
      expect(read(name, "g_ViewUp"), name).toEqual([0, 1, 0]);
    }
  }, 120000);
});
