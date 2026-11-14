/**
 * P12b1 步骤 3–5 的渲染侧单测（`.claude/plans/wpe-import/3-scene/phase12/phase-12b-attach-morph-clip.md`，WPE 语义见
 * `ignore/p12/b/rea/clip-morph-attach.txt`），无 GPU：
 * - 挂点：`worldMatrixOf` 的 `attach` 钩子（`W = W_父 · ((Pose · Att) · L)`，两次 `multiply`）、没有钩子 / 钩子返回 null 时字节同以前；
 *   `GpuScene` 里挂点子对象的矩阵 uniform 用父 puppet 的姿势，姿势每帧变、不写任何状态也每次 `sync` 刷新；
 * - 帧里的顺序：渲染器与 dev 探针都是「puppet → 粒子」；
 * - 骨骼透明度与变形：`g_BonesAlpha` / `g_MorphOffsets`（u32）/ `g_MorphWeights` 每帧写进每个 puppet 绘制的块（没有透明度来源时全 1）；
 *   变形纹理一律 `rgba32float`（没有 `float32-filterable` 时退回 `render:morph-texture`）与 texel 转换；
 * - 裁切遮罩：渲染图的命令展开（3491865410 那样的 normal / clear / mask / target / clear / mask / target / normal，直接上屏与合成路径）、
 *   遮罩 RT 的尺寸与格式、编码的 pass 序列与每次绘制的索引数。
 */
import { existsSync, readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generalDefaults } from "../compile/bindings";
import type { SceneBundle, SceneLayer, ScenePass, ScenePuppetLayer } from "../compile/bundle";
import { particleFov } from "../compile/particles";
import { BLOOM_DEFAULTS } from "../compile/postprocess";
import type { PuppetClipping } from "../compile/puppet";
import { Wpesl2wgsl, translateWithIncludes, type InterfaceVariable, type TranslateResult } from "../wpesl2wgsl";
import { planLayer, type DrawStep, type LayerPlan, type LayerStep } from "./graph";
import { layerLocalMatrix, worldMatrixOf, drawMatrixOf, type LayerTransform } from "./layout";
import { identity, multiply, type Mat4 } from "./math";
import { clipMaskSize, morphTexelData, type PuppetSource } from "./puppet";
import { checkRenderable, GpuScene, stepPipeline, uploadableTextures } from "./scene";
import { SceneState } from "./state";
import { UniformBlock, type UniformEntry } from "./uniforms";
import type { FrameInput } from "./uniforms";

vi.mock("./device", () => ({ acquireGpu: vi.fn() }));
vi.mock("../fileUrl", () => ({ fileToUrl: (path: string) => path }));

// ———— 手写的图层 ————

const pass = (key: string, partial: Partial<ScenePass> = {}): ScenePass => ({
  key,
  program: 0,
  blending: "translucent",
  cullmode: "nocull",
  depthtest: "disabled",
  depthwrite: "disabled",
  textures: {},
  runtime: {},
  uniforms: {},
  framebuffer: false,
  ...partial,
});

const segments = (sizes: number[]) => sizes.map((size) => Uint16Array.from({ length: size }, (_, i) => i % 4));

/** 3491865410 那样的命令表（p12-REPORT 二 3.2）：普通 / 清 + 遮罩 + 目标 / 清 + 遮罩 + 目标 / 普通，6 段。 */
function clipping(): PuppetClipping {
  return {
    commands: [
      { kind: "normal", segment: 0 },
      { kind: "clip", record: 0, mask: 1, target: 2 },
      { kind: "clip", record: 1, mask: 3, target: 4 },
      { kind: "normal", segment: 5 },
    ],
    segments: segments([3, 6, 9, 12, 15, 18]),
    records: [{ mask: "materials/masks/a.tex" }, { mask: "materials/masks/b.tex" }],
  };
}

const MORPH_SIDE = 2;
const morphTexels = () => Int16Array.from([0, 0, 0, 32767, 100, -200, 32767, -32768, -1, 1, 0, 5, 7, 8, 9, 10]);

function puppetOf(partial: Partial<ScenePuppetLayer> = {}): ScenePuppetLayer {
  return {
    path: "models/p.mdl",
    mesh: {
      format: 0x9,
      stride: 20,
      vertices: new Uint8Array(80),
      indices: new Uint8Array(12),
      vertexCount: 4,
      indexCount: 6,
    },
    combos: { SKINNING: 1, BONECOUNT: 2 },
    skeleton: {
      parents: new Int32Array([-1, 0]),
      inverseBind: new Float32Array(32),
      rest: new Float32Array(20),
      restMatrices: new Float32Array(32),
    },
    animations: [],
    layers: [],
    attachments: [],
    boneAlpha: false,
    morph: null,
    clipping: null,
    composite: false,
    passes: [pass("objects/0/passes/0", { program: 1 })],
    upload: null,
    ...partial,
  };
}

function layerOf(object: number, partial: Partial<SceneLayer> = {}): SceneLayer {
  return {
    id: object + 10,
    object,
    parent: null,
    name: `L${object}`,
    origin: [100, 50, 0],
    scale: [1, 1, 1],
    angles: [0, 0, 0],
    size: [200, 100],
    alpha: 1,
    color: [1, 1, 1],
    brightness: 1,
    visible: true,
    visibleBound: false,
    parallaxDepth: [1, 1],
    solidLayer: false,
    instanced: false,
    noPadding: false,
    perspective: false,
    passthroughModel: false,
    group: null,
    subtree: [],
    groupUpload: null,
    copyBackground: true,
    clampUVs: true,
    noInterpolation: false,
    fullscreen: false,
    fullscreenSize: null,
    passes: [pass(`objects/${object}/passes/0`, { program: 0 })],
    colorBlendMode: 0,
    effects: [],
    passthrough: null,
    particle: null,
    ...partial,
  };
}

const draws = (plan: LayerPlan): DrawStep[] => plan.steps.filter((step): step is DrawStep => step.kind === "draw");
const kinds = (plan: LayerPlan) =>
  plan.steps.map((step: LayerStep) =>
    step.kind === "draw"
      ? `${step.role}:${step.pass.key.split("/").slice(2).join("/")}→${step.target.kind}${step.segment === undefined ? "" : `#${step.segment}`}`
      : step.kind === "clear"
        ? `clear:${step.target.kind}`
        : step.kind,
  );

/** puppet 直接上屏 / 合成要用的材质变体（遮罩 pass 两条记录各一个，目标 pass）。 */
const clipPasses = () => ({
  masks: [pass("objects/0/puppetclip/0", { program: 2 }), pass("objects/0/puppetclip/1", { program: 2 })],
  target: pass("objects/0/passes/0", { program: 3, cullmode: "nocull", depthtest: "enabled" }),
});

describe("worldMatrixOf：挂点钩子（P12b1 步骤 3 点 2）", () => {
  const T = (x: number, y = 0): Mat4 => Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, 0, 1]);
  const layers = new Map<number, LayerTransform>([
    [0, { origin: [100, 0, 0], angles: [0, 0, 0], scale: [1, 1, 1], parent: null }],
    [1, { origin: [10, 20, 0], angles: [0, 0, 0.5], scale: [2, 2, 1], parent: 0 }],
    [2, { origin: [1, 1, 0], angles: [0, 0, 0], scale: [1, 1, 1], parent: 1 }],
  ] as unknown as [number, LayerTransform][]);

  it("没有钩子 / 钩子返回 null：同以前（逐字节）", () => {
    const plain = worldMatrixOf(2, layers, new Map());
    expect(worldMatrixOf(2, layers, new Map(), undefined)).toEqual(plain);
    expect(worldMatrixOf(2, layers, new Map(), () => null)).toEqual(plain);
    expect(drawMatrixOf(2, layers, new Map(), () => null)).toEqual(drawMatrixOf(2, layers, new Map()));
  });

  it("对象 1 挂在骨骼上：W₁ = W₀ · ((Pose · Att) · L₁)，孙对象 W₂ = W₁ · L₂；先 Pose · Att 再乘 L（两次 multiply）", () => {
    const pose = T(30, 5);
    const att = T(2, 3);
    const pre = multiply(pose, att);
    const hook = (object: number) => (object === 1 ? pre : null);
    const l0 = layerLocalMatrix(layers.get(0)!);
    const l1 = layerLocalMatrix(layers.get(1)!);
    const l2 = layerLocalMatrix(layers.get(2)!);
    const expected1 = multiply(l0, multiply(pre, l1));
    expect(worldMatrixOf(1, layers, new Map(), hook)).toEqual(expected1);
    expect(worldMatrixOf(2, layers, new Map(), hook)).toEqual(multiply(expected1, l2));
    // 根对象有钩子时：本地矩阵同样左乘（没有父矩阵可乘）
    const rootHook = (object: number) => (object === 0 ? pre : null);
    expect(worldMatrixOf(0, layers, new Map(), rootHook)).toEqual(multiply(pre, l0));
    // 钩子改变结果（姿势不同、世界矩阵不同）
    expect(worldMatrixOf(1, layers, new Map(), hook)).not.toEqual(worldMatrixOf(1, layers, new Map()));
  });

  it("drawMatrixOf 经同一个钩子（图层画自己、粒子与控制点都走它）", () => {
    const pre = T(30, 5);
    const hook = (object: number) => (object === 1 ? pre : null);
    expect(drawMatrixOf(1, layers, new Map(), hook)).toEqual(worldMatrixOf(1, layers, new Map(), hook));
  });
});

describe("变形纹理与遮罩 RT 的纯函数（P12b1 步骤 4、5）", () => {
  it("texel 转换：max(c / 32767, −1)（float32，−32768 取 −1）", () => {
    const texels = morphTexels();
    const floats = morphTexelData(texels);
    expect(floats).toBeInstanceOf(Float32Array);
    expect(floats[3]).toBe(1);
    expect(floats[4]).toBe(Math.fround(100 / 32767));
    expect(floats[5]).toBe(Math.fround(-200 / 32767));
    expect(floats[6]).toBe(1);
    expect(floats[7]).toBe(-1);
    expect(floats[8]).toBe(Math.fround(-1 / 32767));
  });

  it("遮罩 RT 尺寸：场景目标宽高各整除 2，至少 2", () => {
    expect(clipMaskSize(1920, 1080)).toEqual([960, 540]);
    expect(clipMaskSize(1921, 1081)).toEqual([960, 540]);
    expect(clipMaskSize(3, 1)).toEqual([2, 2]);
  });

  it("stepPipeline：画进遮罩 RT 的步骤是 r8unorm、三角形列表、剔除按自己的 raster、不带深度", () => {
    const maskStep: DrawStep = {
      kind: "draw",
      role: "direct",
      pass: pass("m", { program: 2 }),
      effect: null,
      target: { kind: "clip-mask" },
      inputs: {},
      geometry: "puppet",
      uv: [1, 1],
      inset: [0, 0],
      blending: "translucent",
      raster: { test: false, write: false, cull: true },
      segment: 1,
    };
    const spec = stepPipeline(maskStep, "rgba8unorm", () => "rgba8unorm", false, null, "20:0@0:float32x3", true);
    expect(spec).toMatchObject({ format: "r8unorm", topology: "triangle-list", cull: "back", blending: "translucent" });
    expect(spec.depth).toBeUndefined();
  });
});

describe("planLayer：裁切命令展开（P12b1 步骤 5 点 3，3491865410 的 6 段）", () => {
  // 基础 pass 测深度：目标段的深度借它（translucent 只测不写）
  const direct = (partial: Partial<ScenePuppetLayer> = {}) =>
    layerOf(0, {
      passes: [pass("objects/0/passes/0", { program: 0, depthtest: "enabled" })],
      puppet: puppetOf({ clipping: clipping(), clip: clipPasses(), ...partial }),
    });

  it("直接上屏：normal / clear / mask / target / clear / mask / target / normal，每步用自己的段；遮罩画进 clip-mask、目标回场景", () => {
    const plan = planLayer(direct(), []);
    expect(plan.reasons).toEqual([]);
    expect(kinds(plan)).toEqual([
      "direct:passes/0→scene#0",
      "clear:clip-mask",
      "direct:puppetclip/0→clip-mask#1",
      "direct:passes/0→scene#2",
      "clear:clip-mask",
      "direct:puppetclip/1→clip-mask#3",
      "direct:passes/0→scene#4",
      "direct:passes/0→scene#5",
    ]);
    const [normal0, mask0, target0] = draws(plan);
    // 普通段用 puppet 的直接上屏 pass；遮罩 / 目标固定 translucent，遮罩没有深度，目标深度借基础 pass（translucent 不写）
    expect(normal0.pass.program).toBe(1);
    expect(mask0.pass.program).toBe(2);
    expect(mask0.blending).toBe("translucent");
    expect(mask0.raster).toEqual({ test: false, write: false, cull: false });
    expect(target0.pass.program).toBe(3);
    expect(target0.blending).toBe("translucent");
    expect(target0.raster).toEqual({ test: true, write: false, cull: false });
    // 目标段读遮罩 RT（g_Texture8）；遮罩段与普通段不读
    expect(target0.inputs[8]).toEqual({ kind: "clip-mask" });
    expect(mask0.inputs[8]).toBeUndefined();
    expect(normal0.inputs[8]).toBeUndefined();
    // 都画 puppet 网格、不内缩
    for (const step of draws(plan)) expect(step.geometry).toBe("puppet");
  });

  it("基础材质 additive（colorBlendMode 31）只改普通段的混合：目标段仍是 translucent，不用基础材质的混合", () => {
    const plan = planLayer(direct({}), []);
    const additive = planLayer({ ...direct(), colorBlendMode: 31 }, []);
    expect(draws(additive)[0].blending).toBe("additive");
    expect(draws(additive).find((step) => step.pass.program === 3)!.blending).toBe("translucent");
    expect(draws(plan)[0].blending).toBe("translucent");
  });

  it("带变形：槽 5 绑变形纹理（普通、遮罩、目标三种 pass 都是），没变形时不绑", () => {
    const morph = { scale: 1, vertices: 1, targets: 1, side: MORPH_SIDE, texels: morphTexels() };
    const plan = planLayer(direct({ morph }), []);
    for (const step of draws(plan)) expect(step.inputs[5]).toEqual({ kind: "morph", object: 0 });
    for (const step of draws(planLayer(direct(), []))) expect(step.inputs[5]).toBeUndefined();
  });

  it("没有 clip（材质没编出来）：报 render:puppet-clip；没有 clipping 的 puppet 仍是一个绘制，没有 segment 字段（同 P12a）", () => {
    const missing = planLayer(layerOf(0, { puppet: puppetOf({ clipping: clipping(), clip: null }) }), []);
    expect(missing.reasons).toContain("render:puppet-clip");
    const plain = planLayer(layerOf(0, { puppet: puppetOf() }), []);
    expect(kinds(plain)).toEqual(["direct:passes/0→scene"]);
    expect("segment" in draws(plain)[0]).toBe(false);
  });

  it("合成路径（有 effect）：基础 pass 画进合成 RT、effect 留在链里，最后的上屏按同一张命令表展开，槽 0 是合成 RT", () => {
    const upload = pass("objects/0/puppetupload", { program: 1, blending: "normal" });
    const fx = {
      source: 0,
      id: 1,
      name: "",
      file: "effects/x/effect.json",
      fbos: [],
      steps: [
        {
          kind: "draw" as const,
          pass: pass("objects/0/effects/0/passes/0", { program: 4, blending: "normal" }),
          target: null,
          compose: false,
          binds: null,
        },
      ],
      enabled: true,
      visibleBound: false,
      unsupported: [],
    };
    const plan = planLayer(
      layerOf(0, {
        effects: [fx],
        puppet: puppetOf({
          composite: true,
          passes: [],
          upload,
          clipping: clipping(),
          clip: clipPasses(),
        }),
      }),
      [{ width: 100, height: 60, textureWidth: 128, textureHeight: 64 }],
    );
    expect(plan.reasons).toEqual([]);
    expect(kinds(plan)).toEqual([
      "base:passes/0→composite",
      "effect:effects/0/passes/0→composite",
      "passthrough:puppetupload→scene#0",
      "clear:clip-mask",
      "passthrough:puppetclip/0→clip-mask#1",
      "passthrough:passes/0→scene#2",
      "clear:clip-mask",
      "passthrough:puppetclip/1→clip-mask#3",
      "passthrough:passes/0→scene#4",
      "passthrough:puppetupload→scene#5",
    ]);
    const tail = draws(plan).slice(2);
    // 普通段、遮罩段、目标段的槽 0 都是最后一次写入的合成 RT
    for (const step of tail) expect(step.inputs[0]).toEqual({ kind: "composite", index: 1 });
    // 一律 UV 0–1（上屏采样合成 RT 全图）
    for (const step of tail) expect(step.uv).toEqual([1, 1]);
  });
});

// ———— GpuScene：假设备 ————

interface FakeBuffer {
  label: string;
  bytes: Uint8Array;
  usage: number;
  destroy(): void;
}
interface FakeTexture {
  label: string;
  format: string;
  size: { width: number; height: number };
  destroy(): void;
}

/** 假设备：缓冲字节、纹理的格式与上传数据、建管线的描述，以及一帧的编码轨迹。 */
class FakeGpu {
  readonly trace: string[] = [];
  readonly pipelines: GPURenderPipelineDescriptor[] = [];
  readonly buffers: FakeBuffer[] = [];
  readonly textures: FakeTexture[] = [];
  readonly uploads: { texture: FakeTexture; data: ArrayBufferView; layout: GPUTexelCopyBufferLayout }[] = [];
  readonly device: GPUDevice;

  constructor() {
    const trace = this.trace;
    const renderPass = () => ({
      setViewport() {},
      setPipeline(pipeline: { label: string }) {
        trace.push(`  pipeline ${pipeline.label}`);
      },
      setBindGroup() {},
      setVertexBuffer() {},
      setIndexBuffer(buffer: FakeBuffer, format: string) {
        trace.push(`  indices ${buffer.label} ${format} ${buffer.bytes.byteLength}`);
      },
      draw(count: number) {
        trace.push(`  draw ${count}`);
      },
      drawIndexed(count: number) {
        trace.push(`  drawIndexed ${count}`);
      },
      end() {},
    });
    this.device = {
      limits: { maxTextureDimension2D: 8192 },
      lost: new Promise(() => {}),
      destroy() {},
      createTexture: (descriptor: GPUTextureDescriptor) => {
        const texture = {
          label: descriptor.label ?? "",
          format: descriptor.format,
          size: descriptor.size as { width: number; height: number },
          createView: () => ({ label: descriptor.label ?? "" }),
          destroy() {},
        };
        this.textures.push(texture);
        return texture;
      },
      createSampler: () => ({}),
      createBuffer: (descriptor: GPUBufferDescriptor) => {
        const buffer = {
          label: descriptor.label ?? "",
          bytes: new Uint8Array(descriptor.size),
          usage: descriptor.usage,
          destroy() {},
        };
        this.buffers.push(buffer);
        return buffer;
      },
      createShaderModule: () => ({ getCompilationInfo: async () => ({ messages: [] }) }),
      createBindGroupLayout: () => ({}),
      createPipelineLayout: () => ({}),
      createRenderPipeline: () => ({ getBindGroupLayout: () => ({}) }),
      createRenderPipelineAsync: async (descriptor: GPURenderPipelineDescriptor) => {
        this.pipelines.push(descriptor);
        return { label: `${descriptor.label} mask ${[...descriptor.fragment!.targets][0]?.writeMask}` };
      },
      createBindGroup: () => ({}),
      createCommandEncoder: () => ({
        beginRenderPass: (descriptor: GPURenderPassDescriptor) => {
          const attachment = [...descriptor.colorAttachments][0]!;
          const { label } = attachment.view as unknown as { label: string };
          trace.push(`pass ${label} ${attachment.loadOp}`);
          return renderPass();
        },
        copyTextureToTexture() {},
        copyTextureToBuffer() {},
        finish: () => ({}),
      }),
      queue: {
        writeBuffer: (
          buffer: FakeBuffer,
          offset: number,
          data: ArrayBuffer | ArrayBufferView,
          dataOffset = 0,
          size?: number,
        ) => {
          const bytes = ArrayBuffer.isView(data)
            ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
            : new Uint8Array(data);
          const chunk = bytes.subarray(dataOffset, size === undefined ? undefined : dataOffset + size);
          if (chunk.byteLength % 4) throw new Error(`writeBuffer 长度 ${chunk.byteLength} 不是 4 的倍数`);
          buffer.bytes.set(chunk, offset);
        },
        writeTexture: (
          destination: { texture: FakeTexture },
          data: ArrayBuffer | ArrayBufferView,
          layout: GPUTexelCopyBufferLayout,
        ) => {
          const view = ArrayBuffer.isView(data) ? data : new Uint8Array(data);
          this.uploads.push({ texture: destination.texture, data: view, layout });
        },
        submit() {},
        onSubmittedWorkDone: async () => {},
      },
      pushErrorScope() {},
      popErrorScope: async () => null,
    } as unknown as GPUDevice;
  }
}

const attribute = (name: string, type: string, location: number): InterfaceVariable =>
  ({ name, location, type }) as InterfaceVariable;

const UNIFORMS = {
  mvp: { name: "g_ModelViewProjectionMatrix", type: "mat4x4<f32>", declared: "mat4", offset: 0, size: 64 },
  model: { name: "g_ModelMatrix", type: "mat4x4<f32>", declared: "mat4", offset: 64, size: 64 },
};

/** 四边形程序：MVP、模型矩阵。 */
function quadProgram(): TranslateResult {
  return {
    ok: true,
    vertex: { wgsl: "// quad v", entryPoint: "main" },
    fragment: { wgsl: "// quad f", entryPoint: "main" },
    attributes: [attribute("a_Position", "vec3", 0), attribute("a_TexCoord", "vec2", 1)],
    uniforms: [UNIFORMS.mvp, UNIFORMS.model],
    uniformBlockSize: 128,
    textures: [],
  } as unknown as TranslateResult;
}

/** puppet 程序（2 根骨骼）：g_Bones、g_BonesAlpha、g_MorphOffsets（u32）、g_MorphWeights、g_Texture5Resolution，槽 5（变形纹理）与可选的槽 8（遮罩 RT）。 */
function puppetProgram(name: string, withClipTexture: boolean): TranslateResult {
  const textures = [{ slot: 5, name: "g_Texture5", kind: "2d", binding: 1, samplerBinding: 2 }];
  if (withClipTexture) textures.push({ slot: 8, name: "g_Texture8", kind: "2d", binding: 3, samplerBinding: 4 });
  return {
    ok: true,
    vertex: { wgsl: `// ${name} v`, entryPoint: "main" },
    fragment: { wgsl: `// ${name} f`, entryPoint: "main" },
    attributes: [attribute("a_Position", "vec3", 0), attribute("a_TexCoord", "vec2", 1)],
    uniforms: [
      UNIFORMS.mvp,
      {
        name: "g_Bones",
        type: "array<mat4x3<f32>, 2>",
        declared: "mat4x3",
        offset: 64,
        size: 128,
        array: 2,
        stride: 64,
      },
      { name: "g_BonesAlpha", type: "array<f32, 2>", declared: "float", offset: 192, size: 32, array: 2, stride: 16 },
      {
        name: "g_MorphOffsets",
        type: "array<u32, 12>",
        declared: "uint",
        offset: 224,
        size: 192,
        array: 12,
        stride: 16,
      },
      {
        name: "g_MorphWeights",
        type: "array<f32, 12>",
        declared: "float",
        offset: 416,
        size: 192,
        array: 12,
        stride: 16,
      },
      { name: "g_Texture5Resolution", type: "vec4<f32>", declared: "vec4", offset: 608, size: 16 },
    ],
    uniformBlockSize: 624,
    textures,
  } as unknown as TranslateResult;
}

const PROGRAMS = { quad: 0, direct: 1, mask: 2, target: 3 } as const;

function bundleOf(layers: SceneLayer[]): SceneBundle {
  return {
    general: {
      width: 1920,
      height: 1080,
      fields: generalDefaults(),
      clearVariable: false,
      perspectiveOverrideFov: particleFov(undefined),
      postprocess: { level: "disabled", bloomFlag: false, hdrFlag: false, bloom: false, hdr: false },
      bloom: { ...BLOOM_DEFAULTS, tint: [1, 1, 1] },
    },
    layers,
    programs: [
      quadProgram(),
      puppetProgram("direct", false),
      puppetProgram("mask", false),
      puppetProgram("target", true),
    ],
    textures: [],
    bloom: null,
    unsupported: [],
    bindings: [],
    scripts: { list: [] },
  };
}

interface DrawView {
  object: number;
  label: string;
  step: { kind: string; segment?: number; role?: string };
  uniformBuffer: FakeBuffer | null;
  pipeline: { label: string };
  mesh: { indexBuffer: FakeBuffer; count: number } | null;
  puppet: number | null;
}
const internals = (scene: GpuScene) => scene as unknown as { draws: Set<DrawView> };
const drawsOf = (scene: GpuScene, object: number) =>
  [...internals(scene).draws].filter((item) => item.object === object);
const floats = (buffer: FakeBuffer, offset: number, count: number, stride = 4) =>
  Array.from({ length: count }, (_, i) => new DataView(buffer.bytes.buffer).getFloat32(offset + i * stride, true));
const uints = (buffer: FakeBuffer, offset: number, count: number, stride = 4) =>
  Array.from({ length: count }, (_, i) => new DataView(buffer.bytes.buffer).getUint32(offset + i * stride, true));

const FRAME: FrameInput = {
  time: 1,
  frametime: 0.05,
  daytime: 0.5,
  pointer: [0.5, 0.5],
  pointerLast: [0.5, 0.5],
  cursor: [0.5, 0.5],
};

beforeEach(() => {
  vi.stubGlobal("GPUTextureUsage", { RENDER_ATTACHMENT: 1, TEXTURE_BINDING: 2, COPY_SRC: 4, COPY_DST: 8 });
  vi.stubGlobal("GPUBufferUsage", { VERTEX: 1, UNIFORM: 2, COPY_DST: 4, MAP_READ: 8, INDEX: 16 });
  vi.stubGlobal("GPUMapMode", { READ: 1 });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** 假的 `ScenePuppets`：每次调用返回当前字段值（测试里改它们模拟姿势每帧变）。 */
function fakePuppets() {
  const source = {
    skinValue: new Float32Array(24).fill(0.5),
    poseValue: new Float32Array(32) as Float32Array | null,
    alphaValue: Float32Array.from([0.25, 0.75]) as Float32Array | null,
    morphValue: {
      offsets: Uint32Array.from([2, 4, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
      weights: Float32Array.from([1.5, 0.5, -0.25, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
    } as { offsets: Uint32Array; weights: Float32Array } | null,
  };
  const puppets: PuppetSource = {
    skin: () => source.skinValue,
    pose: (object) => (object === 0 ? source.poseValue : null),
    boneAlpha: () => source.alphaValue,
    morph: () => source.morphValue,
  };
  return { source, puppets };
}

const translation = (x: number, y: number): Mat4 => Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, 0, 1]);

describe("GpuScene：挂点子对象的矩阵（P12b1 步骤 3 点 2）", () => {
  /** 父 puppet（对象 0，origin (400, 300)）与挂在骨骼 1 上的普通图层（对象 1）：Att 是平移 (2, 3)。 */
  const scene = async (withAttachment = true) => {
    const att = translation(2, 3);
    const layers = [
      layerOf(0, { origin: [400, 300, 0], puppet: puppetOf() }),
      layerOf(1, {
        parent: 0,
        origin: [10, 20, 0],
        ...(withAttachment ? { attachment: { parent: 0, bone: 1, matrix: att } } : {}),
      }),
    ];
    const bundle = bundleOf(layers);
    const gpu = new FakeGpu();
    const state = SceneState.fromBundle(bundle);
    const gpuScene = await GpuScene.build(gpu.device, bundle, state, new Set(), []);
    return { gpu, scene: gpuScene, state, bundle, att };
  };
  const model = (item: GpuScene, object: number) =>
    floats(drawsOf(item, object)[0].uniformBuffer!, 64, 16) as unknown as number[];

  it("子对象的 g_ModelMatrix = W_父 · ((Pose[骨骼] · Att) · L)，姿势变了、不写任何状态，下一次 sync 就跟上", async () => {
    const { scene: gpuScene, state, bundle, att } = await scene();
    const { source, puppets } = fakePuppets();
    // 骨骼 1 在模型空间的矩阵：平移 (50, 60)
    source.poseValue!.set(translation(50, 60), 16);
    gpuScene.setPuppets(puppets);
    gpuScene.sync(state);
    gpuScene.update(FRAME, state);
    const expected = (pose: Mat4) => {
      const worlds = new Map<number, Mat4>();
      const w0 = worldMatrixOf(0, state.layers, worlds);
      const l1 = layerLocalMatrix(state.layers.get(1) as unknown as LayerTransform);
      return Array.from(multiply(w0, multiply(multiply(pose, att), l1)));
    };
    expect(model(gpuScene, 1)).toEqual(expected(translation(50, 60)));
    // 下一帧姿势变了：没有任何状态写入，`sync` 仍重算挂点子对象
    source.poseValue!.set(translation(80, -10), 16);
    gpuScene.sync(state);
    gpuScene.update(FRAME, state);
    expect(model(gpuScene, 1)).toEqual(expected(translation(80, -10)));
    expect(bundle.layers[1].attachment).toBeDefined();
  });

  it("没有挂点的普通子对象（以及没有姿势来源时）：同以前的 W_父 · L，姿势变了也不动", async () => {
    const plain = await scene(false);
    const { source, puppets } = fakePuppets();
    source.poseValue!.set(translation(50, 60), 16);
    plain.scene.setPuppets(puppets);
    plain.scene.sync(plain.state);
    plain.scene.update(FRAME, plain.state);
    const worlds = new Map<number, Mat4>();
    expect(model(plain.scene, 1)).toEqual(Array.from(worldMatrixOf(1, plain.state.layers, worlds)));
    // 有挂点、但没有 pose 来源：按普通父子
    const attached = await scene();
    attached.scene.setPuppets({ skin: () => null } as unknown as PuppetSource);
    attached.scene.sync(attached.state);
    attached.scene.update(FRAME, attached.state);
    expect(model(attached.scene, 1)).toEqual(Array.from(worldMatrixOf(1, attached.state.layers, new Map())));
  });
});

describe("帧里的顺序：puppet 先于粒子（P12b1 步骤 3 点 3）", () => {
  const source = (path: string) =>
    readFileSync(new URL(path, import.meta.url), "utf8")
      // 去掉注释行，只看调用本身
      .split("\n")
      .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
      .join("\n");

  it("渲染器：stepPuppets 在 stepParticles 之前，stepParticles 在 setCamera 之前", () => {
    const text = source("./renderer.ts");
    const puppets = text.indexOf("this.options.stepPuppets?.(frametime)");
    const particles = text.indexOf("scene.stepParticles(frametime, wrapped, state, cursor)");
    const camera = text.indexOf("scene.setCamera(camera);");
    expect(puppets).toBeGreaterThan(0);
    expect(puppets).toBeLessThan(particles);
    expect(particles).toBeLessThan(camera);
  });

  it("dev 探针（逐帧回放、读回帧、profile 帧）：puppet 的 frame 都在对应的 stepParticles 之前", () => {
    const corners = source("../dev/particleCorners.ts");
    // 逐帧都画的回放：frametime 那一帧的循环里
    const encodedPuppets = corners.indexOf(
      "options.puppets?.frame(frametime, stateSink(state));\n    scene.sync(state);",
    );
    expect(encodedPuppets).toBeGreaterThan(0);
    // 前 n − 1 帧：beforeStep 里；读回帧：最后一次 stepParticles 之前
    expect(corners).toContain("options.puppets?.frame(dt, stateSink(state));");
    const readback = corners.indexOf("if (particles?.dts.length) options.puppets?.frame(frametime, stateSink(state));");
    const readbackStep = corners.indexOf("scene.stepParticles(frametime, time, state, pointers.cursors[last]);");
    expect(readback).toBeGreaterThan(0);
    expect(readback).toBeLessThan(readbackStep);
    // 粒子之后不再有 puppet 的步进
    expect(corners).not.toMatch(/stepParticles\([^)]*\)[^]{0,120}options\.puppets\?\.frame/);
    const probe = source("../dev/probe.ts");
    expect(probe.indexOf("profiledPuppets?.frame(1 / 60, stateSink(state));")).toBeLessThan(
      probe.indexOf("scene.stepParticles(1 / 60, startTime + i / 60, state, cursor);"),
    );
  });
});

describe("GpuScene：骨骼透明度与变形的 uniform 与变形纹理（P12b1 步骤 4）", () => {
  const morph = { scale: 1.5, vertices: 1, targets: 1, side: MORPH_SIDE, texels: morphTexels() };
  const layers = () => [
    layerOf(0, {
      puppet: puppetOf({
        morph,
        boneAlpha: true,
        combos: { SKINNING: 1, BONECOUNT: 2, SKINNING_ALPHA: 1, MORPHING: 1 },
      }),
    }),
  ];
  const build = async (features: string[]) => {
    const bundle = bundleOf(layers());
    const gpu = new FakeGpu();
    const state = SceneState.fromBundle(bundle);
    const scene = await GpuScene.build(gpu.device, bundle, state, new Set(features), []);
    return { gpu, scene, state, bundle };
  };

  it("每帧写 g_Bones、g_BonesAlpha、g_MorphOffsets（u32）、g_MorphWeights；换值下一帧就跟上", async () => {
    const { scene, state } = await build(["float32-filterable"]);
    const { source, puppets } = fakePuppets();
    scene.setPuppets(puppets);
    scene.update(FRAME, state);
    const [draw] = drawsOf(scene, 0);
    expect(draw.puppet).toBe(0);
    const buffer = draw.uniformBuffer!;
    // mat4x3：每列 vec3 补到 16 字节，前三个是第一列
    expect(floats(buffer, 64, 3)).toEqual([0.5, 0.5, 0.5]);
    expect(floats(buffer, 192, 2, 16)).toEqual([0.25, 0.75]);
    expect(uints(buffer, 224, 3, 16)).toEqual([2, 4, 8]);
    expect(floats(buffer, 416, 3, 16)).toEqual([1.5, 0.5, -0.25]);
    // 变形纹理的尺寸进 g_Texture5Resolution
    expect(floats(buffer, 608, 4)).toEqual([MORPH_SIDE, MORPH_SIDE, MORPH_SIDE, MORPH_SIDE]);
    source.alphaValue = Float32Array.from([1, 0.5]);
    source.morphValue = {
      offsets: Uint32Array.from([1, 12, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
      weights: Float32Array.from([2, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
    };
    scene.update(FRAME, state);
    expect(floats(buffer, 192, 2, 16)).toEqual([1, 0.5]);
    expect(uints(buffer, 224, 2, 16)).toEqual([1, 12]);
    expect(floats(buffer, 416, 2, 16)).toEqual([2, 1]);
  });

  it("没有透明度来源（boneAlpha 为 null / 没有这个函数）：g_BonesAlpha 全 1，不是 0（块的初值会让 puppet 全透明）；没有变形来源时不变形", async () => {
    const { scene, state } = await build(["float32-filterable"]);
    const { source, puppets } = fakePuppets();
    source.alphaValue = null;
    source.morphValue = null;
    scene.setPuppets(puppets);
    scene.update(FRAME, state);
    const buffer = drawsOf(scene, 0)[0].uniformBuffer!;
    expect(floats(buffer, 192, 2, 16)).toEqual([1, 1]);
    expect(uints(buffer, 224, 1)).toEqual([0]);
    scene.setPuppets({ skin: () => new Float32Array(24) });
    scene.update(FRAME, state);
    expect(floats(buffer, 192, 2, 16)).toEqual([1, 1]);
  });

  it("变形纹理一律 rgba32float（有 float32-filterable），值是 max(c / 32767, −1)（float32）", async () => {
    const { gpu } = await build(["float32-filterable"]);
    const texture = gpu.textures.find((item) => item.label === "morph 0")!;
    expect(texture.format).toBe("rgba32float");
    const [upload] = gpu.uploads.filter((item) => item.texture === texture);
    expect(upload.layout).toMatchObject({ bytesPerRow: MORPH_SIDE * 16 });
    const data = new Float32Array(upload.data.buffer, upload.data.byteOffset, 16);
    expect(data[3]).toBe(1);
    expect(data[5]).toBe(Math.fround(-200 / 32767));
    expect(data[7]).toBe(-1);
  });

  it("没有 float32-filterable：checkRenderable 报 render:morph-texture，build 抛错退回", async () => {
    const bundle = bundleOf(layers());
    expect(checkRenderable(bundle, new Set())).toContain("render:morph-texture");
    expect(checkRenderable(bundle, new Set(["float32-filterable"]))).not.toContain("render:morph-texture");
    const gpu = new FakeGpu();
    await expect(
      GpuScene.build(gpu.device, bundle, SceneState.fromBundle(bundle), new Set(), []),
    ).rejects.toMatchObject({
      reasons: expect.arrayContaining(["render:morph-texture"]),
    });
  });
});

describe("GpuScene：裁切遮罩的绘制（P12b1 步骤 5 点 3）", () => {
  const morph = { scale: 1, vertices: 1, targets: 1, side: MORPH_SIDE, texels: morphTexels() };
  const layer = () =>
    layerOf(0, {
      puppet: puppetOf({ morph, clipping: clipping(), clip: clipPasses() }),
    });

  it("直接上屏：遮罩 RT 是 r8unorm、场景目标一半大小；一帧的 pass 与绘制序列 = normal / clear / mask / target / clear / mask / target / normal", async () => {
    const bundle = bundleOf([layer()]);
    const gpu = new FakeGpu();
    const state = SceneState.fromBundle(bundle);
    const scene = await GpuScene.build(gpu.device, bundle, state, new Set(["float32-filterable"]), []);
    const mask = gpu.textures.find((item) => item.label === "clip mask")!;
    expect(mask).toMatchObject({ format: "r8unorm", size: { width: 960, height: 540 } });
    // 画遮罩段的 draw 的管线是 r8unorm
    const maskDraws = drawsOf(scene, 0).filter((item) => item.label.includes("puppetclip") || item.step.segment === 1);
    expect(maskDraws.length).toBeGreaterThan(0);
    const { source, puppets } = fakePuppets();
    void source;
    scene.setPuppets(puppets);
    scene.update(FRAME, state);
    gpu.trace.length = 0;
    scene.encode(gpu.device.createCommandEncoder(), state);
    const lines = gpu.trace.filter((line) => !line.startsWith("  pipeline") && !line.startsWith("  indices"));
    expect(lines).toEqual([
      "pass scene target clear",
      "  drawIndexed 3", // 普通段 0
      "pass clip mask clear", // 清遮罩 RT（记录 0）
      "pass clip mask load",
      "  drawIndexed 6", // 遮罩段 1
      "pass scene target load", // 回场景目标
      "  drawIndexed 9", // 目标段 2
      "pass clip mask clear",
      "pass clip mask load",
      "  drawIndexed 12", // 遮罩段 3
      "pass scene target load",
      "  drawIndexed 15", // 目标段 4
      "  drawIndexed 18", // 普通段 5，接着同一个场景 pass
    ]);
    // 每段自己的索引缓冲，起点 0（label 带段号）、u16
    const indexLines = gpu.trace.filter((line) => line.startsWith("  indices"));
    expect(indexLines).toHaveLength(6);
    expect(indexLines.every((line) => line.includes("uint16"))).toBe(true);
    // 遮罩与目标的管线格式：遮罩 r8unorm，别的和场景目标一样
    const maskPipelines = gpu.pipelines.filter((item) => item.label?.includes("r8unorm"));
    expect(maskPipelines.length).toBeGreaterThan(0);
  });

  it("每个绘制各写自己块里的 puppet uniform（遮罩、目标、普通三种程序都带 g_Bones / 透明度 / 变形）", async () => {
    const bundle = bundleOf([layer()]);
    const gpu = new FakeGpu();
    const state = SceneState.fromBundle(bundle);
    const scene = await GpuScene.build(gpu.device, bundle, state, new Set(["float32-filterable"]), []);
    const { puppets } = fakePuppets();
    scene.setPuppets(puppets);
    scene.update(FRAME, state);
    const all = drawsOf(scene, 0);
    // 6 个绘制：普通 ×2、遮罩 ×2、目标 ×2
    expect(all).toHaveLength(6);
    for (const draw of all) {
      expect(draw.puppet).toBe(0);
      expect(floats(draw.uniformBuffer!, 64, 1)).toEqual([0.5]);
      expect(floats(draw.uniformBuffer!, 192, 2, 16)).toEqual([0.25, 0.75]);
      expect(uints(draw.uniformBuffer!, 224, 2, 16)).toEqual([2, 4]);
    }
    // 每个绘制的索引个数是自己那一段的
    expect(all.map((draw) => draw.mesh!.count).sort((a, b) => a - b)).toEqual([3, 6, 9, 12, 15, 18]);
  });

  it("没有裁切的 puppet 不建遮罩 RT（显存不白占）；identity 世界矩阵的辅助：没有挂点时 worldMatrixOf 不被钩子改变", async () => {
    const bundle = bundleOf([layerOf(0, { puppet: puppetOf() })]);
    const gpu = new FakeGpu();
    await GpuScene.build(gpu.device, bundle, SceneState.fromBundle(bundle), new Set(), []);
    expect(gpu.textures.some((item) => item.label === "clip mask")).toBe(false);
    expect(identity()).toHaveLength(16);
  });
});

// ———— 真翻译器（有 WPE 时） ————

const wasm = new URL("../wpesl2wgsl/wpesl2wgsl.wasm", import.meta.url);
const wpeRoot = process.env.KABEGAME_WPE_ROOT;
const shaderDir = wpeRoot ? `${wpeRoot.replace(/\\/g, "/")}/assets/shaders/` : "";

describe.skipIf(!existsSync(wasm) || !wpeRoot || !existsSync(`${shaderDir}clippingmaskimage4.vert`))(
  "真翻译器：P12b1 的着色器变体（本机 WPE）",
  () => {
    const translate = async (shader: string, combos: Record<string, number>, slots: number[]) =>
      translateWithIncludes(
        await Wpesl2wgsl.fromBytes(readFileSync(wasm)),
        {
          vertex: readFileSync(`${shaderDir}${shader}.vert`, "utf8"),
          fragment: readFileSync(`${shaderDir}${shader}.frag`, "utf8"),
          combos,
          textures: slots.map((slot) => ({ slot, format: 0 })),
        },
        async (name) => (existsSync(shaderDir + name) ? readFileSync(shaderDir + name, "utf8") : null),
      );
    const puppetCombos = { SKINNING: 1, BONECOUNT: 4, SKINNING_ALPHA: 1, MORPHING: 1 };

    it("目标变体（CLIPPINGUVS + CLIPPINGTARGET）：隐藏槽 g_Texture8 与变形槽 g_Texture5 都在反射里，v_ScreenPos 在顶点着色器翻 y、片元按 xy / w 采样；变形用 textureSampleLevel", async () => {
      const result = await translate("genericimage4", { ...puppetCombos, CLIPPINGUVS: 1, CLIPPINGTARGET: 1 }, [0]);
      expect(result.ok).toBe(true);
      expect(result.textures!.map((item) => item.slot)).toEqual([0, 5, 8]);
      const vertex = result.vertex!.wgsl!;
      expect(vertex).toContain("v_ScreenPos.y = -(");
      expect(vertex.match(/textureSample\(/g)).toBeNull();
      expect(vertex).toContain("textureSampleLevel(");
      expect(result.fragment!.wgsl!).toMatch(/textureSample\(g_Texture8_, kb_sampler_g_Texture8_,/);
    });

    it("反射的数组 uniform：g_BonesAlpha / g_MorphOffsets / g_MorphWeights 每项占一个 vec4（步长 16、声明类型 float / uint），写块的字节读回正确", async () => {
      const result = await translate("genericimage4", { ...puppetCombos, CLIPPINGUVS: 1, CLIPPINGTARGET: 1 }, [0]);
      const entry = (name: string) => result.uniforms!.find((item) => item.name === name)!;
      expect(entry("g_BonesAlpha")).toMatchObject({ type: "array<vec4<f32>, 4>", declared: "float", stride: 16 });
      expect(entry("g_MorphOffsets")).toMatchObject({ type: "array<vec4<u32>, 12>", declared: "uint", stride: 16 });
      expect(entry("g_MorphWeights")).toMatchObject({ type: "array<vec4<f32>, 12>", declared: "float", stride: 16 });
      const block = new UniformBlock(result.uniforms as UniformEntry[], result.uniformBlockSize);
      block.set("g_BonesAlpha", Float32Array.from([0.25, 0.5, 0.75, 1]));
      block.set("g_MorphOffsets", Uint32Array.from([2, 4, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
      block.set("g_MorphWeights", Float32Array.from([1.5, 0.5, -0.25, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
      const view = new DataView(block.data);
      const at = (name: string, i: number) => entry(name).offset + i * 16;
      expect([0, 1, 2, 3].map((i) => view.getFloat32(at("g_BonesAlpha", i), true))).toEqual([0.25, 0.5, 0.75, 1]);
      expect([0, 1, 2].map((i) => view.getUint32(at("g_MorphOffsets", i), true))).toEqual([2, 4, 8]);
      expect([0, 1, 2].map((i) => view.getFloat32(at("g_MorphWeights", i), true))).toEqual([1.5, 0.5, -0.25]);
    });

    it("遮罩变体（clippingmaskimage4）：槽 0 / 1 / 5，g_RenderVar0 是引擎 uniform，带 puppet 组合键也能翻译", async () => {
      const result = await translate("clippingmaskimage4", puppetCombos, [0, 1]);
      expect(result.ok).toBe(true);
      expect(result.textures!.map((item) => item.slot)).toEqual([0, 1, 5]);
      expect(result.uniforms!.some((item) => item.name === "g_RenderVar0")).toBe(true);
    });
  },
);

describe("uploadableTextures：裁切遮罩的 pass（P12b1 步骤 5）", () => {
  it("clip.masks 的遮罩纹理（槽 1）与 clip.target 的纹理都要上传，不然建绑定组时视图是 null", () => {
    const clip = {
      masks: [
        pass("objects/0/puppetclip/0", { program: 2, textures: { 0: 6, 1: 7 } }),
        pass("objects/0/puppetclip/1", { program: 2, textures: { 1: 8 } }),
      ],
      target: pass("objects/0/passes/0", { program: 3, textures: { 0: 9 } }),
    };
    const layer = layerOf(0, { passes: [], puppet: puppetOf({ passes: [], clipping: clipping(), clip }) });
    expect([...uploadableTextures({ layers: [layer] })].sort()).toEqual([6, 7, 8, 9]);
    // 没有 clip 的 puppet 不受影响
    expect([...uploadableTextures({ layers: [layerOf(0, { passes: [], puppet: puppetOf({ passes: [] }) })] })]).toEqual(
      [],
    );
  });
});

describe("GpuScene：挂点子树的绘制矩阵照 WPE 的缓存戳（步骤 6b，B1）", () => {
  const att = translation(2, 3);
  /**
   * 0：R 图像根（每帧被脚本写 origin）；1：Q 不挂点的 puppet（父 R）；2：A1 挂 Q 骨骼 1 的 puppet；3：A2 挂 Q 骨骼 1 的图像；
   * 4：A5 是 A1 的普通子图像。姿势只有 Q（对象 1）有。
   */
  const build = async (withAttachment: boolean) => {
    const attachment = withAttachment ? { attachment: { parent: 1, bone: 1, matrix: att } } : {};
    const puppetAt = (object: number) => puppetOf({ passes: [pass(`objects/${object}/passes/0`, { program: 1 })] });
    const layers = [
      layerOf(0, { origin: [400, 300, 0] }),
      layerOf(1, { parent: 0, origin: [10, 20, 0], puppet: puppetAt(1) }),
      layerOf(2, { parent: 1, origin: [5, 5, 0], puppet: puppetAt(2), ...attachment }),
      layerOf(3, { parent: 1, origin: [7, 7, 0], ...attachment }),
      layerOf(4, { parent: 2, origin: [1, 1, 0] }),
    ];
    const bundle = bundleOf(layers);
    const gpu = new FakeGpu();
    const state = SceneState.fromBundle(bundle);
    const scene = await GpuScene.build(gpu.device, bundle, state, new Set(), []);
    const { source, puppets } = fakePuppets();
    puppets.pose = (object) => (object === 1 ? source.poseValue : null);
    scene.setPuppets(puppets);
    return { scene, state, source };
  };
  type Item = Awaited<ReturnType<typeof build>>;
  // 向量属性值按字符串写（同用户属性 / 脚本写回的取值规则）
  const originOf = (f: number) => [400 + f * 40, 300 - f * 15, 0];
  const writeOrigin = (state: SceneState, f: number) =>
    state.write({ property: "p", target: { kind: "layer", object: 0, field: "origin" } }, originOf(f).join(" "));
  const mvp = (scene: GpuScene, object: number) => floats(drawsOf(scene, object)[0].uniformBuffer!, 0, 16);
  const poseAt = (item: Item, f: number) => item.source.poseValue!.set(translation(f * 10, f), 16);

  /** 一帧：姿势 → sync → 更新阶段 → 脚本写 R 的 origin → 渲染阶段 → sync → update（同 `SceneRenderer.render`）。 */
  const frame = (item: Item, f: number, drawPhase = true) => {
    poseAt(item, f);
    item.scene.sync(item.state);
    item.scene.stepParticles(0.05, f * 0.05, item.state);
    writeOrigin(item.state, f);
    const seeded = drawPhase ? item.scene.drawPhase(item.state) : false;
    item.scene.sync(item.state);
    item.scene.update(FRAME, item.state);
    return seeded;
  };
  /** 参照：同一份 bundle，不走更新 / 渲染阶段，R 的 origin 取 `at` 帧、姿势取 `f` 帧，现算出的各对象 MVP。 */
  const reference = async (at: number, f: number) => {
    const ref = await build(true);
    poseAt(ref, f);
    writeOrigin(ref.state, at);
    ref.scene.sync(ref.state);
    ref.scene.update(FRAME, ref.state);
    return ref.scene;
  };

  it("挂点 puppet 与它的子图像滞后一帧（祖先 origin 取上一帧、姿势取本帧），不挂点 puppet 与挂点图像是新值", async () => {
    const item = await build(true);
    for (let f = 1; f <= 4; f++) {
      expect(frame(item, f)).toBe(true);
      // 首帧与第 2 帧带着首帧例外（Q 在第 1 帧取旧值），从第 3 帧起验收
      if (f < 3) continue;
      const fresh = await reference(f, f);
      const lag = await reference(f - 1, f);
      expect(mvp(item.scene, 1), `Q ${f}`).toEqual(mvp(fresh, 1));
      expect(mvp(item.scene, 3), `A2 ${f}`).toEqual(mvp(fresh, 3));
      expect(mvp(item.scene, 2), `A1 ${f}`).toEqual(mvp(lag, 2));
      expect(mvp(item.scene, 4), `A5 ${f}`).toEqual(mvp(lag, 4));
      // 滞后确实不同于新值
      expect(mvp(item.scene, 2)).not.toEqual(mvp(fresh, 2));
      expect(mvp(item.scene, 4)).not.toEqual(mvp(fresh, 4));
    }
  });

  it("没有挂点的场景：drawPhase 返回 false，draw 的字节与不调它时相同", async () => {
    const plain = await build(false);
    const control = await build(false);
    for (let f = 1; f <= 3; f++) {
      expect(frame(plain, f, true)).toBe(false);
      frame(control, f, false);
      for (const object of [0, 1, 2, 3, 4])
        expect(Array.from(drawsOf(plain.scene, object)[0].uniformBuffer!.bytes)).toEqual(
          Array.from(drawsOf(control.scene, object)[0].uniformBuffer!.bytes),
        );
    }
  });

  it("预置不取走：drawPhase 之后连续两次 sync 仍是滞后值（暂停时的补画帧）", async () => {
    const item = await build(true);
    for (let f = 1; f <= 3; f++) frame(item, f);
    const lag = await reference(2, 3);
    item.scene.sync(item.state);
    item.scene.update(FRAME, item.state);
    expect(mvp(item.scene, 2)).toEqual(mvp(lag, 2));
    item.scene.sync(item.state);
    item.scene.update(FRAME, item.state);
    expect(mvp(item.scene, 2)).toEqual(mvp(lag, 2));
  });

  it("drawPhase 之后又有变换写入（不走更新阶段）：预置作废，sync 取现算的新值", async () => {
    const item = await build(true);
    for (let f = 1; f <= 3; f++) frame(item, f);
    // 暂停时改祖先的属性：下一次 sync 按现算（写过的对象戳为 0，渲染时重算）
    writeOrigin(item.state, 4);
    item.scene.sync(item.state);
    item.scene.update(FRAME, item.state);
    const fresh = await reference(4, 3);
    expect(mvp(item.scene, 2)).toEqual(mvp(fresh, 2));
    expect(mvp(item.scene, 4)).toEqual(mvp(fresh, 4));
  });
});
