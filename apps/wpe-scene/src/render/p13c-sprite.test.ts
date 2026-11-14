/**
 * P13c 渲染侧（`.claude/plans/wpe-import/3-scene/phase13/phase-13c-sprite.md`「点 2」「点 3」；p13-REPORT「P13c 的实测」）：
 * - `spriteScale`：WPE 的公式（S1：half 工程 n = 3362 → k = 0.737888，n ≥ 4556（1080 高）钳到 1，n/2 整除）；
 * - `spriteViewProjection`：`P · V'`，V' 去掉平移（S5）；
 * - 假设备上的编码：计算 pass（算 k、写光斑的 uniform 缓冲）→ 光斑 → 计数 pass（清零计数、读深度纹理、不挂深度附件）→ 遮挡方块（接着场景
 *   pass）；参数块是视图向量、场景目标高的平方与三个成员的字下标；光斑的 uniform 缓冲带 STORAGE；遮挡方块只写 alpha（S3）；场景深度带
 *   TEXTURE_BINDING；CPU 写的光斑按 k = 0、遮挡方块两个轴 × 0.2，两次的 MVP 都不随视图平移变。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generalDefaults } from "../compile/bindings";
import type { SceneBundle, SceneLayer, ScenePass } from "../compile/bundle";
import { particleFov } from "../compile/particles";
import { BLOOM_DEFAULTS } from "../compile/postprocess";
import { spriteModel } from "../compile/sprite";
import type { TranslateResult } from "../wpesl2wgsl";
import { identity, multiply, translation } from "./math";
import { GpuScene } from "./scene";
import { spriteScale, spriteViewProjection } from "./sprite";
import { SceneState } from "./state";
import type { FrameInput } from "./uniforms";

vi.mock("./device", () => ({ acquireGpu: vi.fn() }));
vi.mock("../fileUrl", () => ({ fileToUrl: (path: string) => path }));

describe("spriteScale / spriteViewProjection（S1、S5）", () => {
  it("k = min(512 · ⌊n/2⌋ / Hs², 1)，float32", () => {
    expect(spriteScale(3362, 1080)).toBe(Math.fround(Math.fround(Math.fround(1681) / 1166400) * 512));
    expect(spriteScale(3362, 1080)).toBeCloseTo(0.737888, 6);
    // ⌊n/2⌋：奇数同下一个偶数
    expect(spriteScale(3363, 1080)).toBe(spriteScale(3362, 1080));
    expect(spriteScale(6724, 1080)).toBe(1);
    expect(spriteScale(0, 1080)).toBe(0);
  });
  it("视图去掉平移：只剩旋转，P · V'", () => {
    const projection = translation(0, 0, 0.5);
    const view = multiply(translation(4, 5, 6), translation(0, 0, 0));
    expect(Array.from(spriteViewProjection({ projection, view }))).toEqual(Array.from(projection));
  });
});

// ———— 假设备 ————

interface FakeBuffer {
  label: string;
  usage: number;
  bytes: Uint8Array;
  destroy(): void;
}
interface FakeTexture {
  label: string;
  usage: number;
}

class FakeGpu {
  readonly buffers: FakeBuffer[] = [];
  readonly textures: FakeTexture[] = [];
  /** 编码轨迹：`pass <标签> <目标> <load>`、`draw <写掩码>`、`compute <标签>`、`clear <缓冲>`。 */
  readonly trace: string[] = [];
  readonly device: GPUDevice;

  constructor() {
    const trace = this.trace;
    this.device = {
      limits: { maxTextureDimension2D: 8192 },
      lost: new Promise(() => {}),
      destroy() {},
      createTexture: (descriptor: GPUTextureDescriptor) => {
        const label = descriptor.label ?? "";
        this.textures.push({ label, usage: descriptor.usage });
        return { label, format: descriptor.format, destroy() {}, createView: () => ({ label }) };
      },
      createSampler: () => ({}),
      createBuffer: (descriptor: GPUBufferDescriptor) => {
        const buffer: FakeBuffer = {
          label: descriptor.label ?? "",
          usage: descriptor.usage,
          bytes: new Uint8Array(descriptor.size),
          destroy() {},
        };
        this.buffers.push(buffer);
        return buffer;
      },
      createShaderModule: () => ({ getCompilationInfo: async () => ({ messages: [] }) }),
      createBindGroupLayout: () => ({}),
      createPipelineLayout: () => ({}),
      createRenderPipeline: (descriptor: GPURenderPipelineDescriptor) => ({
        mask: [...(descriptor.fragment?.targets ?? [])][0]?.writeMask,
        label: descriptor.label,
      }),
      createRenderPipelineAsync: async (descriptor: GPURenderPipelineDescriptor) => ({
        mask: [...(descriptor.fragment?.targets ?? [])][0]?.writeMask,
        label: descriptor.label,
      }),
      createComputePipeline: (descriptor: GPUComputePipelineDescriptor) => ({
        label: descriptor.label,
        getBindGroupLayout: () => ({}),
      }),
      createBindGroup: (descriptor: GPUBindGroupDescriptor) => ({ entries: [...descriptor.entries] }),
      createCommandEncoder: () => ({
        beginRenderPass: (descriptor: GPURenderPassDescriptor) => {
          const color = [...descriptor.colorAttachments][0]!;
          const target = (color.view as unknown as { label: string }).label;
          const depth = descriptor.depthStencilAttachment ? " depth" : "";
          trace.push(`pass ${descriptor.label} ${target} ${color.loadOp}${depth}`);
          let pipeline: { mask?: number } = {};
          return {
            setViewport() {},
            setPipeline(next: { mask?: number }) {
              pipeline = next;
            },
            setBindGroup() {},
            setVertexBuffer() {},
            setIndexBuffer() {},
            draw() {
              trace.push(`  draw mask ${pipeline.mask}`);
            },
            drawIndexed() {
              trace.push(`  draw mask ${pipeline.mask}`);
            },
            end() {},
          };
        },
        beginComputePass: (descriptor: GPUComputePassDescriptor) => {
          trace.push(`compute ${descriptor.label}`);
          return { setPipeline() {}, setBindGroup() {}, dispatchWorkgroups() {}, end() {} };
        },
        clearBuffer: (buffer: FakeBuffer) => trace.push(`clear ${buffer.label}`),
        copyTextureToTexture() {},
        copyBufferToBuffer() {},
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
}

beforeEach(() => {
  vi.stubGlobal("GPUTextureUsage", { COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, RENDER_ATTACHMENT: 16 });
  vi.stubGlobal("GPUBufferUsage", { MAP_READ: 1, COPY_DST: 8, INDEX: 16, VERTEX: 32, UNIFORM: 64, STORAGE: 128 });
  vi.stubGlobal("GPUShaderStage", { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 });
  vi.stubGlobal("GPUMapMode", { READ: 1 });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ———— 工程 ————

/** sprite 两份材质共用的程序：MVP（0）、g_ViewUp（64）、g_ViewRight（80）、g_Alpha（92）。 */
const SPRITE_PROGRAM = {
  ok: true,
  vertex: { wgsl: "// sprite v", entryPoint: "main" },
  fragment: { wgsl: "// sprite f", entryPoint: "main" },
  attributes: [
    { name: "a_Position", type: "vec3", location: 0 },
    { name: "a_TexCoord", type: "vec2", location: 1 },
  ],
  uniforms: [
    { name: "g_ModelViewProjectionMatrix", type: "mat4x4<f32>", declared: "mat4", offset: 0, size: 64 },
    { name: "g_ViewUp", type: "vec3<f32>", declared: "vec3", offset: 64, size: 12 },
    { name: "g_ViewRight", type: "vec3<f32>", declared: "vec3", offset: 80, size: 12 },
    { name: "g_Alpha", type: "f32", declared: "float", offset: 92, size: 4 },
  ],
  uniformBlockSize: 96,
  textures: [],
} as unknown as TranslateResult;

function pass(partial: Partial<ScenePass>): ScenePass {
  return {
    key: "objects/0/sprite/passes/0",
    program: 0,
    blending: "additive",
    cullmode: "nocull",
    depthtest: "disabled",
    depthwrite: "disabled",
    textures: {},
    runtime: {},
    uniforms: {},
    framebuffer: false,
    ...partial,
  };
}

function spriteLayer(): SceneLayer {
  const body = pass({});
  const occlusion = pass({ key: "objects/0/occlusion/passes/0", blending: "normal", depthtest: "enabled" });
  return {
    id: 30,
    object: 0,
    parent: null,
    name: "sun",
    origin: [5, 5, 5],
    scale: [3, 3, 3],
    angles: [0.5, 0.2, 0],
    size: [0, 0],
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
    passes: [],
    colorBlendMode: 0,
    effects: [],
    passthrough: null,
    particle: null,
    sortClass: "opaque",
    model: spriteModel("materials/sun.json", [body], [occlusion]),
    sprite: { material: "materials/sun.json" },
  } as SceneLayer;
}

function bundle(): SceneBundle {
  return {
    general: {
      width: 1920,
      height: 1080,
      perspective: true,
      fields: generalDefaults(),
      clearVariable: false,
      perspectiveOverrideFov: particleFov(undefined),
      postprocess: { level: "disabled", bloomFlag: false, hdrFlag: false, bloom: false, hdr: false },
      bloom: { ...BLOOM_DEFAULTS, tint: [1, 1, 1] },
    },
    layers: [spriteLayer()],
    programs: [SPRITE_PROGRAM],
    textures: [],
    bloom: null,
    unsupported: [],
    bindings: [],
    scripts: { list: [] },
  } as unknown as SceneBundle;
}

const FRAME: FrameInput = {
  time: 1,
  frametime: 0.05,
  daytime: 0.5,
  pointer: [0.5, 0.5],
  pointerLast: [0.5, 0.5],
  cursor: [0.5, 0.5],
};
const UP = [0, 1, 0];
const RIGHT = [-Math.SQRT1_2, 0, -Math.SQRT1_2];

async function open() {
  const gpu = new FakeGpu();
  const sceneBundle = bundle();
  const state = SceneState.fromBundle(sceneBundle);
  const scene = await GpuScene.build(gpu.device, sceneBundle, state, new Set(), [], {
    particles: { seed: 1 },
    size: [1920, 1080],
  } as never);
  // 相机：视图带平移（光斑应当不跟着平移）
  const view = translation(4, 5, 6);
  const projection = translation(0, 0, 0.5);
  scene.setCamera({
    kind: "perspective",
    frame: {
      view,
      projection,
      viewProjection: multiply(projection, view),
      eye: [-4, -5, -6],
      center: [0, 0, 0],
      vectors: { forward: [0, 0, -1], right: RIGHT, up: UP },
    },
  } as never);
  scene.setParallax(null, state);
  scene.update(FRAME, state);
  return { gpu, scene, state, projection };
}

const floats = (buffer: FakeBuffer, from: number, count: number) =>
  Array.from(new Float32Array(buffer.bytes.buffer, from * 4, count));

describe("sprite 的编码（P13c 点 2）", () => {
  it("计算 pass → 光斑 → 计数 pass（清零、不挂深度）→ 遮挡方块（接着场景 pass，只写 alpha）", async () => {
    const { gpu, scene, state } = await open();
    gpu.trace.length = 0;
    scene.encode(gpu.device.createCommandEncoder(), state);
    expect(gpu.trace).toEqual([
      "compute sprite scale",
      "pass scene scene target clear depth",
      "  draw mask 7",
      "clear layer 30 sprite count",
      "pass sprite occlusion count sprite count target clear",
      "  draw mask 0",
      "pass scene scene target load depth",
      "  draw mask 8",
    ]);
  });

  it("参数块：视图向量、场景目标高的平方、三个成员的字下标", async () => {
    const { gpu, scene, state } = await open();
    scene.encode(gpu.device.createCommandEncoder(), state);
    const params = gpu.buffers.find((buffer) => buffer.label.endsWith("sprite scale params"))!;
    const f32 = floats(params, 0, 7);
    expect(f32.slice(0, 3)).toEqual(UP.map(Math.fround));
    expect(f32[3]).toBe(1080 * 1080);
    expect(f32.slice(4, 7)).toEqual(RIGHT.map(Math.fround));
    expect(Array.from(new Uint32Array(params.bytes.buffer, 28, 3))).toEqual([64 / 4, 80 / 4, 92 / 4]);
  });

  it("缓冲与纹理的用途：光斑的 uniform 缓冲带 STORAGE（遮挡方块的不带），场景深度带 TEXTURE_BINDING", async () => {
    const { gpu } = await open();
    const uniforms = gpu.buffers.filter((buffer) => buffer.usage & 64);
    const storage = uniforms.filter((buffer) => buffer.usage & 128);
    expect(storage).toHaveLength(1);
    expect(storage[0].label).toContain("mesh 0");
    expect(gpu.textures.find((texture) => texture.label === "scene depth")!.usage & 4).toBe(4);
  });

  it("CPU 写的 uniform：光斑按 k = 0，遮挡方块两个轴 × 0.2；两次的 MVP 都是 P · V'（不随视图平移变）", async () => {
    const { gpu, projection } = await open();
    const [body, occlusion] = gpu.buffers.filter((buffer) => buffer.usage & 64 && /mesh [01]/.test(buffer.label));
    const mvp = Array.from(spriteViewProjection({ projection, view: identity() }));
    for (const buffer of [body, occlusion]) expect(floats(buffer, 0, 16)).toEqual(mvp);
    expect(floats(body, 16, 3)).toEqual([0, 0, 0]);
    expect(floats(body, 23, 1)).toEqual([0]);
    expect(floats(occlusion, 16, 3)).toEqual(UP.map((x) => Math.fround(x * 0.2)));
    expect(floats(occlusion, 20, 3)).toEqual(RIGHT.map((x) => Math.fround(x * 0.2)));
  });

  it("不可见时整层不画（不计数、不算 k）", async () => {
    const { gpu, scene, state } = await open();
    state.layers.get(0)!.visible = false;
    gpu.trace.length = 0;
    scene.encode(gpu.device.createCommandEncoder(), state);
    expect(gpu.trace.some((line) => line.startsWith("compute") || line.includes("count"))).toBe(false);
  });
});
