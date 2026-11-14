/**
 * P13b2 渲染侧（`.claude/plans/wpe-import/3-scene/phase13/phase-13b2-reflection-on.md`「点 3」「点 4」「点 5」）：假设备上的反射 pass。
 * - 反射开且有名单：主 pass 之前多一个 `_rt_Reflection reflection` pass，按名单画、只画名单里的；`clearenabled` 开时颜色与深度都清，
 *   关时都接着画（p13-REPORT C5、C6）；
 * - 反射副本：自己的 uniform 缓冲，bind group 只换 binding 0；块 = 主块 + 反射视图的相机项（正交场景 VP 不变、eye 的 y 取反，C7；
 *   透视场景 S·VP·S，C2）；每帧量跟着主块；
 * - HDR：副本用加载时建好的 rgba8unorm 管线（场景目标是 rgba16float）；
 * - 反射关时和 P13b1 一样只清屏。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generalDefaults } from "../compile/bindings";
import { REFLECTION_RT, type SceneBundle, type SceneLayer, type ScenePass } from "../compile/bundle";
import { particleFov } from "../compile/particles";
import { BLOOM_DEFAULTS } from "../compile/postprocess";
import type { TranslateResult } from "../wpesl2wgsl";
import { identity, translation } from "./math";
import { GpuScene } from "./scene";
import { SceneState } from "./state";
import type { FrameInput } from "./uniforms";

vi.mock("./device", () => ({ acquireGpu: vi.fn() }));
vi.mock("../fileUrl", () => ({ fileToUrl: (path: string) => path }));

// ———— 假设备：记录 pass、每个 pass 里的绘制（管线、bind group）、深度附件、管线的目标格式 ————

interface FakeBuffer {
  label: string;
  usage: number;
  bytes: Uint8Array;
  destroy(): void;
}
interface FakeBindGroup {
  label: string;
  entries: GPUBindGroupEntry[];
}
interface FakePipeline {
  format: string;
}
interface DrawRecord {
  pipeline: FakePipeline | null;
  bindGroup: FakeBindGroup | null;
}
interface PassRecord {
  label: string;
  target: string;
  loadOp: string;
  clear: { r: number; g: number; b: number; a: number } | null;
  depthLoadOp: string | null;
  draws: DrawRecord[];
}

class FakeGpu {
  readonly buffers: FakeBuffer[] = [];
  readonly passes: PassRecord[] = [];
  readonly pipelines: FakePipeline[] = [];
  readonly device: GPUDevice;

  constructor() {
    this.device = {
      limits: { maxTextureDimension2D: 8192 },
      lost: new Promise(() => {}),
      destroy() {},
      createTexture: (descriptor: GPUTextureDescriptor) => {
        const label = descriptor.label ?? "";
        return {
          label,
          format: descriptor.format,
          destroy() {},
          createView: () => ({ label }),
        };
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
      createRenderPipeline: (descriptor: GPURenderPipelineDescriptor) => this.pipelineOf(descriptor),
      createRenderPipelineAsync: async (descriptor: GPURenderPipelineDescriptor) => this.pipelineOf(descriptor),
      createBindGroup: (descriptor: GPUBindGroupDescriptor): FakeBindGroup => ({
        label: descriptor.label ?? "",
        entries: [...descriptor.entries],
      }),
      createCommandEncoder: () => ({
        beginRenderPass: (descriptor: GPURenderPassDescriptor) => {
          const color = [...descriptor.colorAttachments][0]!;
          const value = color.clearValue as GPUColorDict | undefined;
          const record: PassRecord = {
            label: descriptor.label ?? "",
            target: (color.view as unknown as { label: string }).label,
            loadOp: color.loadOp,
            clear: value ? { r: value.r, g: value.g, b: value.b, a: value.a } : null,
            depthLoadOp: descriptor.depthStencilAttachment?.depthLoadOp ?? null,
            draws: [],
          };
          this.passes.push(record);
          let current: DrawRecord = { pipeline: null, bindGroup: null };
          return {
            setViewport() {},
            setPipeline(pipeline: FakePipeline) {
              current.pipeline = pipeline;
            },
            setBindGroup(_index: number, group: FakeBindGroup) {
              current.bindGroup = group;
            },
            setVertexBuffer() {},
            setIndexBuffer() {},
            draw() {
              record.draws.push(current);
              current = { ...current };
            },
            drawIndexed() {
              record.draws.push(current);
              current = { ...current };
            },
            end() {},
          };
        },
        copyTextureToTexture() {},
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

  private pipelineOf(descriptor: GPURenderPipelineDescriptor): FakePipeline {
    const pipeline = { format: [...(descriptor.fragment?.targets ?? [])][0]?.format ?? "" };
    this.pipelines.push(pipeline);
    return pipeline;
  }

  encode(scene: GpuScene, state: SceneState): PassRecord[] {
    this.passes.length = 0;
    scene.encode(this.device.createCommandEncoder(), state);
    return [...this.passes];
  }
}

beforeEach(() => {
  vi.stubGlobal("GPUTextureUsage", { RENDER_ATTACHMENT: 16, TEXTURE_BINDING: 4, COPY_SRC: 1, COPY_DST: 2 });
  vi.stubGlobal("GPUBufferUsage", { VERTEX: 32, UNIFORM: 64, COPY_DST: 8, MAP_READ: 1, INDEX: 16 });
  vi.stubGlobal("GPUMapMode", { READ: 1 });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ———— 工程 ————

/** 相机程序：MVP（偏移 0）、eye（64）、g_Time（76），没有纹理。 */
const CAMERA_PROGRAM = {
  ok: true,
  vertex: { wgsl: "// cam v", entryPoint: "main" },
  fragment: { wgsl: "// cam f", entryPoint: "main" },
  attributes: [
    { name: "a_Position", type: "vec3", location: 0 },
    { name: "a_TexCoord", type: "vec2", location: 1 },
  ],
  uniforms: [
    { name: "g_ModelViewProjectionMatrix", type: "mat4x4<f32>", declared: "mat4", offset: 0, size: 64 },
    { name: "g_EyePosition", type: "vec3<f32>", declared: "vec3", offset: 64, size: 12 },
    { name: "g_Time", type: "f32", declared: "float", offset: 76, size: 4 },
  ],
  uniformBlockSize: 80,
  textures: [],
} as unknown as TranslateResult;

/** 读反射图的程序：纹理槽 0。 */
const READER_PROGRAM = {
  ...CAMERA_PROGRAM,
  vertex: { wgsl: "// reader v", entryPoint: "main" },
  textures: [{ slot: 0, binding: 1, samplerBinding: 2, kind: "2d" }],
} as unknown as TranslateResult;

function pass(partial: Partial<ScenePass> = {}): ScenePass {
  return {
    key: "objects/0/passes/0",
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
  };
}

function layerOf(object: number, extra: Partial<SceneLayer> = {}): SceneLayer {
  return {
    id: 10 + object,
    object,
    parent: null,
    name: `l${object}`,
    origin: [960, 540, 0],
    scale: [1, 1, 1],
    angles: [0, 0, 0],
    size: [100, 100],
    alpha: 1,
    color: [1, 1, 1],
    brightness: 1,
    visible: true,
    visibleBound: false,
    parallaxDepth: [1, 1],
    solidLayer: true,
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
    passes: [pass({ key: `objects/${object}/passes/0` })],
    colorBlendMode: 0,
    effects: [],
    passthrough: null,
    particle: null,
    ...extra,
  };
}

/**
 * 对象 0、1：普通图像层（相机程序）；对象 2：读 `_rt_Reflection` 的图像层（不在名单）。名单默认 [0]。
 */
function bundleOf(
  options: { enabled?: boolean; list?: number[]; hdr?: boolean; clearenabled?: boolean; perspective?: boolean } = {},
): SceneBundle {
  const hdr = options.hdr ?? false;
  const fields = generalDefaults();
  if (options.clearenabled === false) fields.clearenabled = false;
  const reader = pass({ key: "objects/2/passes/0", program: 1, runtime: { 0: REFLECTION_RT } });
  return {
    general: {
      width: 1920,
      height: 1080,
      perspective: options.perspective ?? false,
      fields,
      clearVariable: options.clearenabled === false,
      perspectiveOverrideFov: particleFov(undefined),
      postprocess: { level: hdr ? "ultra" : "disabled", bloomFlag: hdr, hdrFlag: hdr, bloom: false, hdr },
      bloom: { ...BLOOM_DEFAULTS, tint: [1, 1, 1] },
    },
    layers: [layerOf(0), layerOf(1), layerOf(2, { passes: [reader] })],
    programs: [CAMERA_PROGRAM, READER_PROGRAM],
    textures: [],
    bloom: null,
    reflection:
      options.enabled === false ? { planar: true } : { planar: true, enabled: true, list: options.list ?? [0] },
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

async function open(bundle: SceneBundle, size?: [number, number]) {
  const gpu = new FakeGpu();
  const state = SceneState.fromBundle(bundle);
  const scene = await GpuScene.build(gpu.device, bundle, state, new Set(), [], {
    particles: { seed: 1 },
    ...(size ? { size } : {}),
  } as never);
  scene.update(FRAME, state);
  return { gpu, scene, state };
}

/** bind group 的 binding 0 指向的缓冲。 */
function uniformBufferOf(group: FakeBindGroup | null): FakeBuffer {
  const entry = group!.entries.find((item) => item.binding === 0)!;
  return (entry.resource as GPUBufferBinding).buffer as unknown as FakeBuffer;
}
const floats = (buffer: FakeBuffer, from: number, count: number) =>
  Array.from(new Float32Array(buffer.bytes.buffer, from * 4, count));

describe("反射 pass（P13b2）", () => {
  it("反射开：主 pass 之前一个 `_rt_Reflection reflection` pass，只画名单里的；读反射图的不画", async () => {
    const { gpu, scene, state } = await open(bundleOf({ list: [0] }));
    state.general.clearcolor = [0.2, 0.4, 0.6];
    const passes = gpu.encode(scene, state);
    expect(passes.map((item) => item.label)).toEqual(["_rt_Reflection reflection", "scene"]);
    expect(passes[0]).toMatchObject({ target: "_rt_Reflection", loadOp: "clear" });
    expect(passes[0].clear).toEqual({ r: 0.2, g: 0.4, b: 0.6, a: 1 });
    expect(passes[0].draws).toHaveLength(1);
    expect(passes[1].draws).toHaveLength(3);
  });

  it("名单顺序与成员：[0, 1] 两次绘制，第一帧建副本、之后复用同一块缓冲", async () => {
    const { gpu, scene, state } = await open(bundleOf({ list: [0, 1] }));
    const first = gpu.encode(scene, state)[0].draws.map((draw) => uniformBufferOf(draw.bindGroup));
    const second = gpu.encode(scene, state)[0].draws.map((draw) => uniformBufferOf(draw.bindGroup));
    expect(first).toHaveLength(2);
    expect(second[0]).toBe(first[0]);
    expect(second[1]).toBe(first[1]);
    expect(first[0]).not.toBe(first[1]);
  });

  it("副本只换 binding 0：缓冲不是主 draw 的；正交场景 MVP 不变、eye 的 y 取反（C7）、每帧量同主块", async () => {
    const { gpu, scene, state } = await open(bundleOf({ list: [0] }));
    const [reflection, main] = gpu.encode(scene, state);
    const copy = uniformBufferOf(reflection.draws[0].bindGroup);
    const original = uniformBufferOf(main.draws[0].bindGroup);
    expect(copy).not.toBe(original);
    expect(floats(copy, 0, 16)).toEqual(floats(original, 0, 16));
    const eye = floats(original, 16, 3);
    expect(floats(copy, 16, 3)).toEqual([eye[0], -eye[1], eye[2]]);
    expect(floats(copy, 19, 1)).toEqual(floats(original, 19, 1));
    // 每帧量更新后，下一帧编码时副本跟上
    scene.update({ ...FRAME, time: 7 }, state);
    gpu.encode(scene, state);
    expect(floats(copy, 19, 1)).toEqual([7]);
  });

  it("透视场景：副本的 MVP 用 S·VP·S（C2）", async () => {
    const { gpu, scene, state } = await open(bundleOf({ list: [0], perspective: true }), [1920, 1080]);
    // VP = T(0, 5, 0)：S·T(0, 5, 0)·S = T(0, −5, 0)，所以副本的 MVP 只有 y 平移比主块少 10
    const vp = translation(0, 5, 0);
    scene.setCamera({
      kind: "perspective",
      frame: {
        view: vp,
        projection: identity(),
        viewProjection: vp,
        eye: [0, 3, 8],
        center: [0, 0, 0],
        vectors: { forward: [0, 0, -1], right: [1, 0, 0], up: [0, 1, 0] },
      },
    } as never);
    scene.setParallax(null, state);
    scene.update(FRAME, state);
    const [reflection, main] = gpu.encode(scene, state);
    const copy = floats(uniformBufferOf(reflection.draws[0].bindGroup), 0, 16);
    const original = floats(uniformBufferOf(main.draws[0].bindGroup), 0, 16);
    expect(copy[13]).toBeCloseTo(original[13] - 10, 4);
    expect(copy.filter((_, i) => i !== 13)).toEqual(original.filter((_, i) => i !== 13));
    expect(floats(uniformBufferOf(reflection.draws[0].bindGroup), 16, 3)).toEqual([0, -3, 8]);
  });

  it("clearenabled: false：反射 pass 颜色与深度都 load（C6）", async () => {
    const { gpu, scene, state } = await open(bundleOf({ list: [0], clearenabled: false }));
    const [reflection] = gpu.encode(scene, state);
    expect(reflection).toMatchObject({ label: "_rt_Reflection reflection", loadOp: "load" });
  });

  it("HDR：副本用加载时建好的 rgba8unorm 管线，主 draw 用 rgba16float 的", async () => {
    const { gpu, scene, state } = await open(bundleOf({ list: [0], hdr: true }));
    const [reflection, main] = gpu.encode(scene, state);
    expect(reflection.draws[0].pipeline?.format).toBe("rgba8unorm");
    expect(main.draws[0].pipeline?.format).toBe("rgba16float");
  });

  it("反射关：同 P13b1 只清屏，不画（没有副本）", async () => {
    const { gpu, scene, state } = await open(bundleOf({ enabled: false }));
    const passes = gpu.encode(scene, state);
    expect(passes.map((item) => item.label)).toEqual(["_rt_Reflection clear", "scene"]);
    expect(passes[0].draws).toEqual([]);
    expect(gpu.buffers.some((buffer) => buffer.label.endsWith(" reflection"))).toBe(false);
  });

  it("不可见的名单对象不进反射 pass", async () => {
    const { gpu, scene, state } = await open(bundleOf({ list: [0, 1] }));
    state.layers.get(1)!.visible = false;
    expect(gpu.encode(scene, state)[0].draws).toHaveLength(1);
  });
});
