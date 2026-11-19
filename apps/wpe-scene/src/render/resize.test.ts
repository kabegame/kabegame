/**
 * `GpuScene.resize`（方案 A 点 1，`.claude/plans/wpe-import/3-scene/phase-render-size-product.md`）：场景接着跑、只换按场景目标尺寸分配的资源。
 * 判据：「建在 A、换到 B」与「直接建在 B」在资源与一帧的编码轨迹上逐项相同——
 * - 存活的纹理与缓冲（标签、尺寸、格式、用途）：场景目标、深度、快照、反射两张 RT、泛光链、fullscreen 合成 RT 与 fbo、全部 draw 的缓冲；
 * - 一帧的 pass（目标标签与尺寸、清屏与否、有无深度）与每个 draw 的绑定（指向的纹理标签与尺寸、缓冲标签）；
 * - 每个 draw 的 uniform 块字节（`g_Screen`、`g_TexelSize` 等静态值与投影矩阵）。
 * 另测：旧资源都被销毁并从 `owned` 里摘掉；A → B → A 之后资源数与 `targetBytes` 回到基线；只换边距不重建 RT；粒子树、状态没有被重建。
 * 假设备写法同 `l7.test.ts`，另记下每个资源的尺寸与存活。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generalDefaults } from "../compile/bindings";
import {
  FRAMEBUFFER_RT,
  REFLECTION_RT,
  type SceneBundle,
  type SceneEffect,
  type SceneLayer,
  type ScenePass,
  type SceneTexture,
} from "../compile/bundle";
import { parseParticle, particleFov } from "../compile/particles";
import { BLOOM_DEFAULTS } from "../compile/postprocess";
import type { TranslateResult } from "../wpesl2wgsl";
import { alignEdges } from "./layout";
import { GpuScene } from "./scene";
import { SceneState } from "./state";
import type { FrameInput } from "./uniforms";

vi.mock("./device", () => ({ acquireGpu: vi.fn() }));
vi.mock("../fileUrl", () => ({ fileToUrl: (path: string) => path }));

// ———— 假设备：记每个资源的尺寸与存活，编码时按 WebGPU 的规则校验 ————

interface FakeTexture {
  label: string;
  format: string;
  usage: number;
  width: number;
  height: number;
  destroyed: boolean;
  destroy(): void;
  createView(): FakeView;
}
interface FakeView {
  label: string;
  texture: FakeTexture;
}
interface FakeBuffer {
  label: string;
  size: number;
  usage: number;
  bytes: Uint8Array;
  destroyed: boolean;
  destroy(): void;
}
interface FakeBindGroup {
  entries: GPUBindGroupEntry[];
}
interface FakePipeline {
  label: string;
  format: string;
  depth: boolean;
  getBindGroupLayout(): object;
}

/** 一帧编码的记录：pass 的目标与深度、每个 draw 的管线与绑定、每个 draw 的 uniform 字节。 */
interface FrameRecord {
  passes: string[];
  copies: string[];
  draws: { pass: string; pipeline: string; bindings: string[]; uniform: string | null }[];
}

class FakeGpu {
  readonly textures: FakeTexture[] = [];
  readonly buffers: FakeBuffer[] = [];
  readonly device: GPUDevice;
  private frame: FrameRecord = { passes: [], copies: [], draws: [] };
  private readonly pending: { draw: FrameRecord["draws"][number]; buffer: FakeBuffer | null }[] = [];

  constructor() {
    const fail = (message: string): never => {
      throw new Error(`WebGPU 校验：${message}`);
    };
    const describeResource = (resource: unknown): string => {
      const view = resource as Partial<FakeView>;
      if (view && view.texture) return `view ${view.texture.label} ${view.texture.width}x${view.texture.height}`;
      const binding = resource as GPUBufferBinding;
      if (binding && binding.buffer) return `buffer ${(binding.buffer as unknown as FakeBuffer).label}`;
      return "sampler";
    };
    const pipelineOf = (descriptor: GPURenderPipelineDescriptor): FakePipeline => {
      const target = descriptor.fragment ? [...descriptor.fragment.targets][0] : undefined;
      return {
        label: descriptor.label ?? "",
        format: target?.format ?? "",
        depth: !!descriptor.depthStencil,
        getBindGroupLayout: () => ({}),
      };
    };
    this.device = {
      limits: { maxTextureDimension2D: 8192 },
      lost: new Promise(() => {}),
      destroy() {},
      createTexture: (descriptor: GPUTextureDescriptor) => {
        const size = descriptor.size as { width: number; height: number };
        const texture: FakeTexture = {
          label: descriptor.label ?? "",
          format: descriptor.format,
          usage: descriptor.usage,
          width: size.width,
          height: size.height,
          destroyed: false,
          destroy: () => {
            texture.destroyed = true;
          },
          createView: () => ({ label: texture.label, texture }),
        };
        this.textures.push(texture);
        return texture;
      },
      createSampler: () => ({}),
      createBuffer: (descriptor: GPUBufferDescriptor) => {
        const buffer: FakeBuffer = {
          label: descriptor.label ?? "",
          size: descriptor.size,
          usage: descriptor.usage,
          bytes: new Uint8Array(descriptor.size),
          destroyed: false,
          destroy: () => {
            buffer.destroyed = true;
          },
        };
        this.buffers.push(buffer);
        return buffer;
      },
      createShaderModule: () => ({ getCompilationInfo: async () => ({ messages: [] }) }),
      createBindGroupLayout: () => ({}),
      createPipelineLayout: () => ({}),
      createRenderPipeline: pipelineOf,
      createRenderPipelineAsync: async (descriptor: GPURenderPipelineDescriptor) => pipelineOf(descriptor),
      createBindGroup: (descriptor: GPUBindGroupDescriptor): FakeBindGroup => {
        // 绑定了已销毁的资源就是 WebGPU 校验错误
        for (const entry of descriptor.entries) {
          const view = entry.resource as unknown as Partial<FakeView>;
          if (view && view.texture?.destroyed) fail(`bind group 绑了已销毁的纹理 ${view.texture.label}`);
          const buffer = (entry.resource as GPUBufferBinding).buffer as unknown as FakeBuffer | undefined;
          if (buffer?.destroyed) fail(`bind group 绑了已销毁的缓冲 ${buffer.label}`);
        }
        return { entries: [...descriptor.entries] };
      },
      createCommandEncoder: () => ({
        beginRenderPass: (descriptor: GPURenderPassDescriptor) => {
          const attachment = [...descriptor.colorAttachments][0]!;
          const view = attachment.view as unknown as FakeView;
          if (view.texture.destroyed) fail(`pass 的目标 ${view.label} 已销毁`);
          const depth = descriptor.depthStencilAttachment
            ? ` depth ${(descriptor.depthStencilAttachment.view as unknown as FakeView).texture.width}x${
                (descriptor.depthStencilAttachment.view as unknown as FakeView).texture.height
              }`
            : "";
          const pass = `${view.label} ${view.texture.width}x${view.texture.height} ${attachment.loadOp}${depth}`;
          this.frame.passes.push(pass);
          let pipeline = "";
          let bindings: string[] = [];
          let buffer: FakeBuffer | null = null;
          const record = () => {
            const draw = { pass, pipeline, bindings, uniform: null as string | null };
            this.frame.draws.push(draw);
            this.pending.push({ draw, buffer });
          };
          return {
            setViewport: (x: number, y: number, w: number, h: number) => {
              this.frame.passes.push(`  viewport ${x},${y} ${w}x${h}`);
            },
            setPipeline(item: FakePipeline) {
              pipeline = item.label;
            },
            setBindGroup(_index: number, group: FakeBindGroup) {
              bindings = group.entries.map((entry) => `${entry.binding}: ${describeResource(entry.resource)}`);
              const first = group.entries.find((entry) => entry.binding === 0);
              buffer = ((first?.resource as GPUBufferBinding | undefined)?.buffer as unknown as FakeBuffer) ?? null;
              if (buffer && !("bytes" in buffer)) buffer = null;
            },
            setVertexBuffer() {},
            setIndexBuffer() {},
            draw: record,
            drawIndexed: record,
            end() {},
          };
        },
        copyTextureToTexture: (
          source: { texture: FakeTexture },
          target: { texture: FakeTexture },
          size: { width: number; height: number },
        ) => {
          if (source.texture.destroyed || target.texture.destroyed) fail("拷贝用了已销毁的纹理");
          if (!(source.texture.usage & GPUTextureUsage.COPY_SRC)) fail(`${source.texture.label} 没有 COPY_SRC`);
          if (!(target.texture.usage & GPUTextureUsage.COPY_DST)) fail(`${target.texture.label} 没有 COPY_DST`);
          this.frame.copies.push(`${source.texture.label} -> ${target.texture.label} ${size.width}x${size.height}`);
        },
        copyTextureToBuffer() {},
        finish: () => ({}),
      }),
      queue: {
        writeBuffer: (buffer: FakeBuffer, offset: number, data: ArrayBuffer, dataOffset = 0, size?: number) => {
          if (buffer.destroyed) fail(`写已销毁的缓冲 ${buffer.label}`);
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

  /** 编码一帧，返回这一帧的记录（uniform 字节在编码结束后读，此时 `writeBuffer` 都已落下）。 */
  encode(scene: GpuScene, state: SceneState): FrameRecord {
    this.frame = { passes: [], copies: [], draws: [] };
    this.pending.length = 0;
    scene.encode(this.device.createCommandEncoder(), state);
    for (const { draw, buffer } of this.pending)
      draw.uniform = buffer ? Buffer.from(buffer.bytes).toString("hex") : null;
    return this.frame;
  }

  /** 存活的资源（标签、尺寸、格式、用途），排序后可直接比较。 */
  live(): { textures: string[]; buffers: string[] } {
    return {
      textures: this.textures
        .filter((texture) => !texture.destroyed)
        .map((texture) => `${texture.label} ${texture.width}x${texture.height} ${texture.format} ${texture.usage}`)
        .sort(),
      buffers: this.buffers
        .filter((buffer) => !buffer.destroyed)
        .map((buffer) => `${buffer.label} ${buffer.size} ${buffer.usage}`)
        .sort(),
    };
  }
}

// ———— 工程 ————

const W = 1920;
const H = 1080;
/** 程序下标：普通图像（读纹理槽 0）、passthrough（fullscreen 合成层）、kbfx、泛光四个、粒子。 */
const PROGRAM = { image: 0, passthrough: 1, kbfx: 2, bq: 3, be: 4, bb: 5, bc: 6, particle: 7 } as const;

/** 带 `g_Screen` / `g_TexelSize` 的程序：MVP 0、VP 64、g_Screen 128、g_TexelSize 144。 */
function program(name: string, slots: number[]): TranslateResult {
  return {
    ok: true,
    vertex: { wgsl: `// ${name} v`, entryPoint: "main" },
    fragment: { wgsl: `// ${name} f`, entryPoint: "main" },
    attributes: [
      { name: "a_Position", type: "vec3", location: 0 },
      { name: "a_TexCoord", type: "vec2", location: 1 },
    ],
    uniforms: [
      { name: "g_ModelViewProjectionMatrix", type: "mat4x4<f32>", declared: "mat4", offset: 0, size: 64 },
      { name: "g_ViewProjectionMatrix", type: "mat4x4<f32>", declared: "mat4", offset: 64, size: 64 },
      { name: "g_Screen", type: "vec3<f32>", declared: "vec3", offset: 128, size: 12 },
      { name: "g_TexelSize", type: "vec2<f32>", declared: "vec2", offset: 144, size: 8 },
    ],
    uniformBlockSize: 160,
    textures: slots.map((slot) => ({ slot, binding: 1 + 2 * slot, samplerBinding: 2 + 2 * slot, kind: "2d" })),
  } as unknown as TranslateResult;
}
const PARTICLE_PROGRAM = {
  ok: true,
  vertex: { wgsl: "// particle v", entryPoint: "main" },
  fragment: { wgsl: "// particle f", entryPoint: "main" },
  attributes: [
    { name: "a_Position", location: 0, type: "vec3" },
    { name: "a_TexCoordVec4", location: 1, type: "vec4" },
    { name: "a_Color", location: 2, type: "vec4" },
    { name: "a_TexCoordC2", location: 3, type: "vec2" },
  ],
  uniforms: [{ name: "g_ModelViewProjectionMatrix", type: "mat4x4<f32>", declared: "mat4", offset: 0, size: 64 }],
  uniformBlockSize: 64,
  textures: [{ slot: 0, binding: 1, samplerBinding: 2, kind: "2d" }],
} as unknown as TranslateResult;

const texture: SceneTexture = {
  path: "t",
  source: "",
  format: 0,
  width: 4,
  height: 4,
  textureWidth: 4,
  textureHeight: 4,
  flags: 0,
  clampUVs: true,
  noInterpolation: false,
  mips: [{ width: 4, height: 4, bytes: new Uint8Array(64) }],
};

function pass(key: string, extra: Partial<ScenePass> = {}): ScenePass {
  return {
    key,
    program: PROGRAM.image,
    blending: "translucent",
    cullmode: "nocull",
    depthtest: "disabled",
    depthwrite: "disabled",
    textures: { 0: 0 },
    runtime: {},
    uniforms: {},
    framebuffer: false,
    ...extra,
  };
}

/** 两个 pass 的 effect：第一个画进 fbo `_rt_Half`（缩一半），第二个上屏。 */
function kbfx(object: number): SceneEffect {
  return {
    source: 0,
    id: 50,
    name: "kbfx",
    file: "effects/kbfx/effect.json",
    fbos: [{ name: "_rt_Half", format: "rgba8888", scale: 2, unique: false, repeat: false }],
    steps: [0, 1].map((i) => ({
      kind: "draw" as const,
      pass: pass(`objects/${object}/effects/0/passes/${i}`, { program: PROGRAM.kbfx, blending: "normal" }),
      target: i === 0 ? "_rt_Half" : null,
      compose: false,
      binds: null,
    })),
    enabled: true,
    visibleBound: false,
    unsupported: [],
  };
}

function layer(object: number, extra: Partial<SceneLayer> = {}): SceneLayer {
  return {
    id: object + 10,
    object,
    parent: null,
    name: `l${object}`,
    origin: [960, 540, 0],
    scale: [1, 1, 1],
    angles: [0, 0, 0],
    size: [W, H],
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
    passes: [pass(`objects/${object}/passes/0`)],
    colorBlendMode: 0,
    effects: [],
    passthrough: null,
    particle: null,
    ...extra,
  };
}

/**
 * 0 背景、1 fullscreen 合成层（合成 RT 取场景目标尺寸 + 带 fbo 的 effect，读快照）、2 读反射图的图层、3 测深度的图层、4 粒子层。
 * 泛光（LDR 四步）、平面反射（名单 [0]）。`perspective` 时是透视场景。
 */
function bundleOf(perspective = false): SceneBundle {
  const particle = parseParticle(
    {
      maxcount: 8,
      emitter: [{ name: "sphererandom", origin: "0 0 0", distancemax: 0, rate: 100 }],
      initializer: [
        { name: "lifetimerandom", min: 100, max: 100 },
        { name: "sizerandom", min: 20, max: 20 },
      ],
    },
    { file: "particles/p.json", orthographic: true },
  );
  particle.passes = [pass("objects/4/particle/passes/0", { program: PROGRAM.particle })];
  const names = ["quarter", "eighth", "blur", "combine"];
  const bloomProgram = (slots: number[]) =>
    ({
      ...program("bloom", slots),
      uniforms: [{ name: "g_RenderVar0", type: "vec4<f32>", declared: "vec4", offset: 0, size: 16 }],
      uniformBlockSize: 16,
    }) as unknown as TranslateResult;
  return {
    general: {
      width: W,
      height: H,
      perspective,
      fields: generalDefaults(),
      clearVariable: false,
      perspectiveOverrideFov: particleFov(undefined),
      postprocess: { level: "enabled", bloomFlag: true, hdrFlag: false, bloom: true, hdr: false },
      bloom: { ...BLOOM_DEFAULTS, tint: [1, 1, 1] },
    },
    layers: [
      layer(0),
      layer(1, {
        passthroughModel: true,
        fullscreen: true,
        fullscreenSize: "scene" as unknown as [number, number],
        size: [2, 2],
        passes: [
          pass("objects/1/passes/0", {
            program: PROGRAM.passthrough,
            textures: {},
            runtime: { 0: FRAMEBUFFER_RT },
            framebuffer: true,
          }),
        ],
        effects: [kbfx(1)],
      }),
      layer(2, { passes: [pass("objects/2/passes/0", { textures: {}, runtime: { 0: REFLECTION_RT } })] }),
      layer(3, {
        passes: [pass("objects/3/passes/0", { depthtest: "enabled", blending: "additive" })],
      }),
      layer(4, { passes: [], particle }),
    ],
    programs: [
      program("image", [0]),
      program("passthrough", [0]),
      program("kbfx", [0]),
      ...names.map((name) => bloomProgram(name === "combine" ? [0, 1] : [0])),
      PARTICLE_PROGRAM,
    ],
    textures: [texture],
    bloom: {
      hdr: false,
      passes: Object.fromEntries(
        names.map((name, index) => [
          name,
          pass(`bloom/${name}`, { program: PROGRAM.bq + index, blending: "normal", textures: {} }),
        ]),
      ),
    },
    reflection: { planar: true, enabled: true, list: [0] },
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

type Size = readonly [number, number];
type Next = Parameters<GpuScene["resize"]>[0];

/** 正交场景在窗口 `size` 下的目标：样式 fill（边距照 `alignEdges`）；`clear` 非空用来测清屏色。 */
const orthoTarget = (size: Size, clear: Next["clear"] = null): Next => ({
  size,
  edges: alignEdges(0, W, H, size[0], size[1]),
  clear,
});
const perspectiveTarget = (size: Size): Next => ({ size, edges: null, clear: null });

/** 建场景：正交带 `target`、透视带 `size`。 */
async function open(next: Next, perspective: boolean) {
  const gpu = new FakeGpu();
  const bundle = bundleOf(perspective);
  const state = SceneState.fromBundle(bundle);
  const scene = await GpuScene.build(gpu.device, bundle, state, new Set(), [], {
    ignoreUnsupported: true,
    particles: { seed: 1 },
    ...(perspective ? { size: next.size } : { target: { ...next, edges: next.edges! } }),
  });
  scene.update(FRAME, state);
  return { gpu, scene, state };
}

interface Internals {
  owned: Set<{ destroy(): void }>;
  trees: Map<number, { system: { alive: number } }>;
  current: { texture: FakeTexture } | null;
  snapshot: { texture: FakeTexture } | null;
  depthTarget: { texture: FakeTexture } | null;
  compositePool: Map<string, unknown[]>;
}
const internals = (scene: GpuScene) => scene as unknown as Internals;

beforeEach(() => {
  vi.stubGlobal("GPUTextureUsage", { RENDER_ATTACHMENT: 1, TEXTURE_BINDING: 2, COPY_SRC: 4, COPY_DST: 8 });
  vi.stubGlobal("GPUBufferUsage", { VERTEX: 1, UNIFORM: 2, COPY_DST: 4, MAP_READ: 8, INDEX: 16 });
  vi.stubGlobal("GPUMapMode", { READ: 1 });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const A: Size = [1280, 720];
const B: Size = [1920, 800];

describe.each([
  ["正交（带 target）", false, orthoTarget],
  ["透视", true, perspectiveTarget],
] as const)("GpuScene.resize：%s", (_name, perspective, target) => {
  it("建在 A 换到 B，和直接建在 B 逐项相同：存活资源、pass、绑定、uniform 字节", async () => {
    const direct = await open(target(B), perspective);
    const resized = await open(target(A), perspective);
    await resized.scene.resize(target(B), resized.state);
    resized.scene.update(FRAME, resized.state);

    expect([resized.scene.width, resized.scene.height]).toEqual([B[0], B[1]]);
    expect(resized.gpu.live()).toEqual(direct.gpu.live());
    expect(resized.scene.targetBytes).toBe(direct.scene.targetBytes);
    const a = resized.gpu.encode(resized.scene, resized.state);
    const b = direct.gpu.encode(direct.scene, direct.state);
    // 覆盖面：场景目标 + 反射 pass + 泛光链 + 深度 + 快照拷贝 + fullscreen 合成 RT
    expect(b.passes.some((pass) => pass.startsWith("scene target 1920x800") && pass.includes("depth 1920x800"))).toBe(
      true,
    );
    expect(b.passes.some((pass) => pass.startsWith("_rt_Reflection 1920x800"))).toBe(true);
    expect(b.passes.some((pass) => pass.startsWith("_rt_Bloom 240x100"))).toBe(true);
    expect(b.copies.some((copy) => copy.includes("_rt_FullFrameBuffer 1920x800"))).toBe(true);
    expect(b.copies.some((copy) => copy.includes("-> composite 1920x800"))).toBe(true);
    expect(a).toEqual(b);
    // g_Screen / g_TexelSize 跟着新尺寸（每个 draw 的静态块里）：任一 draw 的字节里能找到 (1920, 800, 2.4)
    const screen = Buffer.from(new Float32Array([B[0], B[1], B[0] / B[1]]).buffer).toString("hex");
    expect(a.draws.some((draw) => draw.uniform?.includes(screen))).toBe(true);
    const old = Buffer.from(new Float32Array([A[0], A[1], A[0] / A[1]]).buffer).toString("hex");
    expect(a.draws.some((draw) => draw.uniform?.includes(old))).toBe(false);
  });

  it("旧的场景级资源都被销毁、不留在 owned 里；A → B → A 之后资源与 targetBytes 回到基线", async () => {
    const { gpu, scene, state } = await open(target(A), perspective);
    const baseline = gpu.live();
    const bytes = scene.targetBytes;
    const ownedBefore = internals(scene).owned.size;
    const oldTargets = [
      internals(scene).current!.texture,
      internals(scene).snapshot!.texture,
      internals(scene).depthTarget!.texture,
    ];
    const oldSized = gpu.textures.filter(
      (texture) => !texture.destroyed && texture.width === A[0] && texture.height === A[1],
    );
    expect(oldSized.length).toBeGreaterThan(4);

    await scene.resize(target(B), state);
    for (const texture of [...oldTargets, ...oldSized]) {
      expect(texture.destroyed, texture.label).toBe(true);
      expect(internals(scene).owned.has(texture)).toBe(false);
    }
    // 没有任何存活的纹理还是旧尺寸（场景纹理 4×4 与反射 / 泛光的缩小级不会恰好是 A 的尺寸）
    expect(gpu.live().textures.some((entry) => entry.includes(` ${A[0]}x${A[1]} `))).toBe(false);
    // 共享合成 RT 池里旧尺寸的那组也释放了
    expect([...internals(scene).compositePool.keys()].some((key) => key.startsWith(`${A[0]}x${A[1]}|`))).toBe(false);
    expect(scene.targetBytes).not.toBe(bytes);

    await scene.resize(target(A), state);
    scene.update(FRAME, state);
    expect(gpu.live()).toEqual(baseline);
    expect(scene.targetBytes).toBe(bytes);
    expect(internals(scene).owned.size).toBe(ownedBefore);
    // 之后照常画
    expect(() => gpu.encode(scene, state)).not.toThrow();
  });

  it("尺寸没变什么都不做；粒子树与状态不被重建、存活粒子不变", async () => {
    const { gpu, scene, state } = await open(target(A), perspective);
    scene.stepParticles(0.1, 1, state, [0.5, 0.5]);
    const system = internals(scene).trees.get(4)!.system;
    const alive = system.alive;
    expect(alive).toBeGreaterThan(0);
    state.layers.get(0)!.alpha = 0.25;
    const layers = state.layers;

    const before = gpu.textures.length + gpu.buffers.length;
    await scene.resize(target(A), state);
    expect(gpu.textures.length + gpu.buffers.length).toBe(before);

    await scene.resize(target(B), state);
    expect(internals(scene).trees.get(4)!.system).toBe(system);
    expect(system.alive).toBe(alive);
    expect(state.layers).toBe(layers);
    expect(state.layers.get(0)!.alpha).toBe(0.25);
    expect(() => gpu.encode(scene, state)).not.toThrow();
  });

  it("多次 resize 串行：不 await 连发，最后落在最后一次的尺寸，资源不泄漏", async () => {
    const { gpu, scene, state } = await open(target(A), perspective);
    const direct = await open(target([1000, 600]), perspective);
    const runs = [
      scene.resize(target(B), state),
      scene.resize(target([1600, 900]), state),
      scene.resize(target([1000, 600]), state),
    ];
    await Promise.all(runs);
    scene.update(FRAME, state);
    expect([scene.width, scene.height]).toEqual([1000, 600]);
    expect(gpu.live()).toEqual(direct.gpu.live());
  });
});

describe("GpuScene.resize：正交场景的边距与清屏色", () => {
  it("只换边距 / 清屏色、尺寸不变：不重建任何 RT（没有新纹理 / 缓冲），投影与清屏色换新", async () => {
    const { gpu, scene, state } = await open(orthoTarget(B), false);
    const before = gpu.textures.length + gpu.buffers.length;
    const frame = gpu.encode(scene, state);
    const created = gpu.textures.length + gpu.buffers.length;
    const mvpBefore = frame.draws[0].uniform;

    // 同尺寸、fit（边距不同、清屏色换成 schemecolor）
    await scene.resize({ size: B, edges: alignEdges(1, W, H, B[0], B[1]), clear: [0, 0, 0.6] }, state);
    scene.update(FRAME, state);
    expect(gpu.textures.length + gpu.buffers.length).toBe(created); // 编码时的副本缓冲已在 created 里
    expect(before).toBeLessThanOrEqual(created);
    const after = gpu.encode(scene, state);
    expect(after.draws[0].uniform).not.toBe(mvpBefore);
    expect(gpu.textures.length + gpu.buffers.length).toBe(created);
    expect(after.passes).toEqual(frame.passes);
  });

  it("清屏色变了、尺寸与边距不变：只换清屏色", async () => {
    const { gpu, scene, state } = await open(orthoTarget(A), false);
    const created = gpu.textures.length + gpu.buffers.length;
    await scene.resize(orthoTarget(A, [0.25, 0.5, 0.75]), state);
    expect(gpu.textures.length + gpu.buffers.length).toBe(created);
    expect((scene as unknown as { targetClear: unknown }).targetClear).toEqual([0.25, 0.5, 0.75]);
  });

  it("换到 B 后的清屏色、边距同直接建在 B（带 schemecolor 的样式）", async () => {
    const fit = (size: Size): Next => ({ size, edges: alignEdges(1, W, H, size[0], size[1]), clear: [0, 0, 0.6] });
    const direct = await open(fit(B), false);
    const resized = await open(fit(A), false);
    await resized.scene.resize(fit(B), resized.state);
    resized.scene.update(FRAME, resized.state);
    expect(resized.gpu.encode(resized.scene, resized.state)).toEqual(direct.gpu.encode(direct.scene, direct.state));
  });

  it("超过设备纹理上限：报 render:target-size，场景保持原状继续可画", async () => {
    const { gpu, scene, state } = await open(orthoTarget(A), false);
    const baseline = gpu.live();
    await expect(scene.resize(orthoTarget([9000, 720]), state)).rejects.toThrow(/render:target-size/);
    expect([scene.width, scene.height]).toEqual([A[0], A[1]]);
    expect(gpu.live()).toEqual(baseline);
    expect(() => gpu.encode(scene, state)).not.toThrow();
  });
});
