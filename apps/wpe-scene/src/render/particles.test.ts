/**
 * P4a 步骤 4（绘制）：粒子层在渲染图里的形态、透视 / 正交 MVP 与 WPE 实测值、粒子 uniform、帧时钟，以及用假设备核对的
 * 每帧写缓冲、绘制计数、可见性、销毁、遍数。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generalDefaults } from "../compile/bindings";
import {
  FRAMEBUFFER_RT,
  type SceneBundle,
  type SceneLayer,
  type ScenePass,
  type SceneTexture,
} from "../compile/bundle";
import { isEngineUniform, PARTICLE_UNIFORMS } from "../compile/features";
import type { JsonObject } from "../compile/model";
import { childLocalMatrix, parseParticle, particleFov } from "../compile/particles";
import { BLOOM_DEFAULTS } from "../compile/postprocess";
import { replayParticleOptions, replayParticles } from "../dev/particleCorners";
import { pointerScenePoint } from "../particles/controlpoints";
import { trailRenderVar0 } from "../particles/ropetrail";
import { particleSnapshot, particleTrack } from "../particles/track";
import type { ParticleSystem } from "../particles/system";
import type { TranslateResult } from "../wpesl2wgsl";
import { clampFrametime, FrameClock, FRAMETIME_MAX, FRAMETIME_MIN } from "./clock";
import { acquireGpu } from "./device";
import { planLayer, planParticleLayer, planSignature } from "./graph";
import { particleViewProjection, sceneCursor, scenePlacement, sceneViewProjection, worldMatrixOf } from "./layout";
import { identity, multiply, translation, type Mat4 } from "./math";
import { SceneRenderer } from "./renderer";
import {
  buildableLayers,
  checkRenderable,
  GpuScene,
  timingStats,
  uploadableTextures,
  type ParticleOptions,
} from "./scene";
import { SceneState } from "./state";
import { particleBuiltins, particleUniformValues, type FrameInput } from "./uniforms";

vi.mock("./device", () => ({ acquireGpu: vi.fn() }));

/** WPE 实测（2026-11-07 RenderDoc，1920×1080，对象在原点），列主序。 */
const WPE_ORTHO = [0.0010416667, 0, 0, 0, 0, 0.0018518518, 0, 0, 0, 0, 0.00025, 0, -1, -1, 0.5, 1];
const WPE_PERSPECTIVE_95 = [
  0.5154362320899963, 0, 0, 0, 0, 0.9163311123847961, 0, 0, 0, 0, 0.00033344447729177773, -1, -494.81878662109375,
  -494.81878662109375, 4.836672306060791, 494.81884765625,
];
/** `ignore/p4/tracks/p4a-fov60.json` 里粒子绘制的 `mvp`。 */
const WPE_PERSPECTIVE_60 = [
  0.9742785692214966, 0, 0, 0, 0, 1.7320507764816284, 0, 0, 0, 0, 0.00033344447729177773, -1, -935.3074340820312,
  -935.3074340820312, 4.689794063568115, 935.3074340820312,
];

/** 逐项相对误差 ≤ 1e-6（WPE 为 0 的项要求恰好是 0）。 */
function closeRelative(actual: ArrayLike<number>, expected: readonly number[]): void {
  expect(actual.length).toBe(expected.length);
  expected.forEach((value, i) =>
    expect(Math.abs(actual[i] - value), `[${i}] ${actual[i]} vs ${value}`).toBeLessThanOrEqual(1e-6 * Math.abs(value)),
  );
}

const GENERAL_1080 = { width: 1920, height: 1080 };

describe("视图投影对 WPE 实测", () => {
  it("正交：z 项是 0.00025·z + 0.5（反向 Z，深度范围 ±2000）", () => {
    closeRelative(sceneViewProjection(GENERAL_1080), WPE_ORTHO);
  });

  it("透视粒子 fov 95：d = 494.819，反向 Z，near 5、far 15000", () => {
    closeRelative(
      particleViewProjection({ ...GENERAL_1080, perspectiveOverrideFov: particleFov(95) }),
      WPE_PERSPECTIVE_95,
    );
  });

  it("透视粒子 fov 60：d = 935.307", () => {
    closeRelative(
      particleViewProjection({ ...GENERAL_1080, perspectiveOverrideFov: particleFov(60) }),
      WPE_PERSPECTIVE_60,
    );
  });

  it("透视的 z = 0 平面和正交画面重合；+z 朝相机放大 d / (d − z)", () => {
    const ortho = sceneViewProjection(GENERAL_1080);
    const perspective = particleViewProjection({ ...GENERAL_1080, perspectiveOverrideFov: particleFov(95) });
    const ndc = (m: Mat4, x: number, y: number, z: number) => {
      const w = m[3] * x + m[7] * y + m[11] * z + m[15];
      return [(m[0] * x + m[4] * y + m[8] * z + m[12]) / w, (m[1] * x + m[5] * y + m[9] * z + m[13]) / w];
    };
    for (const [x, y] of [
      [0, 0],
      [960, 540],
      [1700, 100],
    ]) {
      const a = ndc(ortho, x, y, 0),
        b = ndc(perspective, x, y, 0);
      expect(Math.abs(a[0] - b[0])).toBeLessThan(1e-5);
      expect(Math.abs(a[1] - b[1])).toBeLessThan(1e-5);
    }
    const d = 540 / Math.tan(particleFov(95) / 2);
    const scale = ndc(perspective, 960 + 100, 540, 300)[0] / ndc(ortho, 960 + 100, 540, 0)[0];
    expect(scale).toBeCloseTo(d / (d - 300), 4);
    // fov 很大时 d + 1000 超过 15000，远平面跟着走
    const narrow = particleViewProjection({ ...GENERAL_1080, perspectiveOverrideFov: particleFov(2) });
    const dNarrow = 540 / Math.tan(particleFov(2) / 2);
    expect(narrow[10]).toBeCloseTo(Math.fround(5 / (dNarrow + 1000 - 5)), 12);
  });
});

describe("粒子 uniform", () => {
  const white = { width: 32, height: 32, textureWidth: 32, textureHeight: 32 };
  const layerState = {
    origin: [0, 0, 0],
    scale: [1, 1, 1],
    angles: [0, 0, 0],
    alpha: 1,
    color: [1, 1, 1],
    brightness: 1,
    visible: true,
    parallaxDepth: [1, 1],
    parent: null,
  };

  it("朝向、视图轴、g_RenderVar0/1 照实测与语义；g_Texture0Resolution 是纹理尺寸", () => {
    const values = particleUniformValues({
      layer: layerState,
      world: translation(0, 0, 0),
      constants: {},
      viewProjection: sceneViewProjection(GENERAL_1080),
      colorScale: 1,
      screenSize: [1920, 1080],
      textures: [white],
      eye: [960, 540, 2000],
    });
    expect(values).toMatchObject({
      g_OrientationUp: [0, 1, 0],
      g_OrientationRight: [1, 0, 0],
      g_OrientationForward: [0, 0, 1],
      g_ViewUp: [0, 1, 0],
      g_ViewRight: [1, 0, 0],
      g_RenderVar0: [0, 0, 0, 0],
      g_RenderVar1: [0, 0, 0, 0],
      g_EyePosition: [960, 540, 2000],
      g_Texture0Resolution: [32, 32, 32, 32],
    });
    closeRelative(values.g_ModelViewProjectionMatrix, WPE_ORTHO);
  });

  it("g_RenderVar1：槽 0 帧表的 renderVar1 原样写（拷贝，不共享数组）；没有帧表为 0（P4b 步骤 2）", () => {
    const sheet = { renderVar1: [0.25, 0.125, 32, 0.25] as [number, number, number, number], npot: true };
    const input = {
      layer: layerState,
      world: translation(0, 0, 0),
      constants: {},
      viewProjection: sceneViewProjection(GENERAL_1080),
      colorScale: 1,
      screenSize: [1920, 1080] as [number, number],
      textures: [{ width: 896, height: 1024, textureWidth: 1024, textureHeight: 1024 }],
      eye: [960, 540, 2000],
    };
    const values = particleUniformValues({ ...input, sheet });
    expect(values.g_RenderVar1).toEqual([0.25, 0.125, 32, 0.25]);
    expect(values.g_RenderVar1).not.toBe(sheet.renderVar1);
    // NPOT 的 `z / x` 来自 g_Texture0Resolution（纹理宽、纹理高、图像宽、图像高），不改
    expect(values.g_Texture0Resolution).toEqual([1024, 1024, 896, 1024]);
    expect(values.g_RenderVar0).toEqual([0, 0, 0, 0]);
    expect(particleUniformValues({ ...input, sheet: null }).g_RenderVar1).toEqual([0, 0, 0, 0]);
    expect(particleBuiltins(sheet).g_RenderVar1).toEqual([0.25, 0.125, 32, 0.25]);
  });

  it("PARTICLE_UNIFORMS（能力表放行的粒子 uniform）每一个都真的写", () => {
    expect(new Set(Object.keys(particleBuiltins()))).toEqual(new Set(PARTICLE_UNIFORMS));
    // 其余粒子着色器的引擎 uniform 由通用路径写
    for (const name of ["g_EyePosition", "g_Texture0Resolution", "g_ModelMatrixInverse"])
      expect(isEngineUniform(name)).toBe(true);
  });

  it("MVP = 视图投影 × 对象世界矩阵；透视粒子换透视的视图投影；材质常量覆盖内置值", () => {
    const perspective = particleViewProjection({ ...GENERAL_1080, perspectiveOverrideFov: particleFov(95) });
    const world = translation(100, 50, 0);
    const values = particleUniformValues({
      layer: layerState,
      world,
      constants: { g_OrientationUp: [0, 0, 1], g_Overbright: [2] },
      viewProjection: perspective,
      colorScale: 1,
      screenSize: [1920, 1080],
      textures: [white],
      eye: [960, 540, 2000],
    });
    expect(values.g_ModelViewProjectionMatrix).toEqual(Array.from(multiply(perspective, world)));
    expect(values.g_ModelMatrix).toEqual(Array.from(world));
    expect(values.g_ViewProjectionMatrix).toEqual(Array.from(perspective));
    expect(values.g_OrientationUp).toEqual([0, 0, 1]);
    expect(values.g_Overbright).toEqual([2]);
  });
});

describe("帧时钟（T2）", () => {
  it("帧时间钳到 [0.0001, 0.25]", () => {
    expect([FRAMETIME_MIN, FRAMETIME_MAX]).toEqual([0.0001, 0.25]);
    expect(clampFrametime(0)).toBe(0.0001);
    expect(clampFrametime(-1)).toBe(0.0001);
    expect(clampFrametime(0.016)).toBe(0.016);
    expect(clampFrametime(0.2084)).toBe(0.2084);
    expect(clampFrametime(3)).toBe(0.25);
    expect(clampFrametime(Number.NaN)).toBe(0.0001);
  });

  it("g_Time 累加钳后的值：卡 2 秒只走 0.25；第一帧 0.0001；补画帧时间不动、帧时间为 0", () => {
    const clock = new FrameClock();
    clock.advance(5); // 第一帧没有上一帧
    expect([clock.frametime, clock.time]).toEqual([0.0001, 0.0001]);
    clock.advance(5 + 1 / 60);
    expect(clock.frametime).toBeCloseTo(1 / 60, 12);
    clock.advance(7 + 1 / 60);
    expect(clock.frametime).toBe(0.25);
    expect(clock.time).toBeCloseTo(0.0001 + 1 / 60 + 0.25, 12);
    const time = clock.time;
    clock.hold();
    expect([clock.frametime, clock.time]).toEqual([0, time]);
    clock.advance(7 + 1 / 60 + 0.00001);
    expect(clock.frametime).toBe(0.0001);
    // 0.25 连续三帧：time 严格加 0.25（WPE fps=5 启动时的实测）
    const before = clock.time;
    for (let i = 1; i <= 3; i++) clock.advance(100 * i);
    expect(clock.time - before).toBeCloseTo(0.75, 12);
  });
});

// ———— 假设备 ————

interface FakeBuffer {
  label: string;
  size: number;
  usage: number;
  bytes: Uint8Array;
  writes: number[];
  destroy(): void;
}

/** 假设备：记录缓冲（标签、用途、写入次数与每次的字节数）、管线拓扑与编码轨迹（顶点缓冲、索引缓冲、绘制次数）。 */
class FakeGpu {
  readonly buffers: FakeBuffer[] = [];
  readonly live = new Set<FakeBuffer>();
  readonly pipelines: { label: string; topology: string; stepMode: string }[] = [];
  readonly trace: string[] = [];
  readonly device: GPUDevice;

  constructor() {
    const pass = () => ({
      setViewport() {},
      setPipeline: (pipeline: { label: string }) => this.trace.push(`pipeline ${pipeline.label}`),
      setBindGroup() {},
      setVertexBuffer: (_slot: number, buffer: FakeBuffer) => this.trace.push(`vertex ${buffer.label}`),
      setIndexBuffer: (buffer: FakeBuffer, format: string) => this.trace.push(`index ${buffer.label} ${format}`),
      // rope（P4d 步骤 1）带实例数：`draw <顶点数> <实例数>`；图层四边形只有顶点数
      draw: (count: number, instances?: number) =>
        this.trace.push(instances === undefined ? `draw ${count}` : `draw ${count} ${instances}`),
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
      createBuffer: (descriptor: GPUBufferDescriptor) => {
        const buffer: FakeBuffer = {
          label: descriptor.label ?? "",
          size: descriptor.size,
          usage: descriptor.usage,
          bytes: new Uint8Array(descriptor.size),
          writes: [],
          destroy: () => this.live.delete(buffer),
        };
        this.buffers.push(buffer);
        this.live.add(buffer);
        return buffer;
      },
      createShaderModule: () => ({ getCompilationInfo: async () => ({ messages: [] }) }),
      createBindGroupLayout: () => ({}),
      createPipelineLayout: () => ({}),
      createRenderPipeline: () => ({ getBindGroupLayout: () => ({}) }),
      createRenderPipelineAsync: async (descriptor: GPURenderPipelineDescriptor) => {
        const pipeline = {
          label: descriptor.label ?? "",
          topology: descriptor.primitive?.topology ?? "",
          stepMode: [...(descriptor.vertex.buffers ?? [])][0]?.stepMode ?? "",
        };
        this.pipelines.push(pipeline);
        return pipeline;
      },
      createBindGroup: () => ({}),
      createCommandEncoder: () => ({
        beginRenderPass: (descriptor: GPURenderPassDescriptor) => {
          const attachment = [...descriptor.colorAttachments][0]!;
          this.trace.push(`pass ${(attachment.view as unknown as { label: string }).label} ${attachment.loadOp}`);
          return pass();
        },
        copyTextureToTexture: () => this.trace.push("copy"),
        copyTextureToBuffer() {},
        finish: () => ({}),
      }),
      queue: {
        writeBuffer: (buffer: FakeBuffer, offset: number, data: ArrayBuffer, dataOffset = 0, size?: number) => {
          const bytes = new Uint8Array(data, dataOffset, size ?? data.byteLength - dataOffset);
          buffer.bytes.set(bytes, offset);
          buffer.writes.push(bytes.byteLength);
        },
        writeTexture() {},
        submit() {},
        onSubmittedWorkDone: async () => {},
      },
      pushErrorScope() {},
      popErrorScope: async () => null,
    } as unknown as GPUDevice;
  }

  buffer(label: string): FakeBuffer {
    const found = this.buffers.find((buffer) => buffer.label === label);
    if (!found) throw new Error(`没有缓冲 ${label}`);
    return found;
  }

  /** 编码一帧，返回这一帧的轨迹。 */
  encode(scene: GpuScene, state: SceneState): string[] {
    this.trace.length = 0;
    scene.encode(this.device.createCommandEncoder(), state);
    return [...this.trace];
  }
}

// ———— bundle ————

const IMAGE_PROGRAM = {
  ok: true,
  vertex: { wgsl: "// image v", entryPoint: "main" },
  fragment: { wgsl: "// image f", entryPoint: "main" },
  attributes: [
    { name: "a_Position", type: "vec3", location: 0 },
    { name: "a_TexCoord", type: "vec2", location: 1 },
  ],
  uniforms: [
    { name: "g_ModelViewProjectionMatrix", type: "mat4x4<f32>", declared: "mat4", offset: 0, size: 64 },
    { name: "g_Time", type: "f32", declared: "float", offset: 64, size: 4 },
  ],
  uniformBlockSize: 80,
  textures: [{ slot: 0, binding: 1, samplerBinding: 2, kind: "2d" }],
} as unknown as TranslateResult;

/** 翻译后 `genericparticle` 的反射（输入顺序与 uniform 偏移照真实输出），外加一个材质常量。 */
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
  uniforms: [
    { name: "g_ModelViewProjectionMatrix", type: "mat4x4<f32>", declared: "mat4", offset: 0, size: 64 },
    { name: "g_ModelMatrixInverse", type: "mat4x4<f32>", declared: "mat4", offset: 64, size: 64 },
    { name: "g_OrientationUp", type: "vec3<f32>", declared: "vec3", offset: 128, size: 12 },
    { name: "g_OrientationRight", type: "vec3<f32>", declared: "vec3", offset: 144, size: 12 },
    { name: "g_OrientationForward", type: "vec3<f32>", declared: "vec3", offset: 160, size: 12 },
    { name: "g_ViewUp", type: "vec3<f32>", declared: "vec3", offset: 176, size: 12 },
    { name: "g_ViewRight", type: "vec3<f32>", declared: "vec3", offset: 192, size: 12 },
    { name: "g_EyePosition", type: "vec3<f32>", declared: "vec3", offset: 208, size: 12 },
    { name: "g_RenderVar0", type: "vec4<f32>", declared: "vec4", offset: 224, size: 16 },
    { name: "g_RenderVar1", type: "vec4<f32>", declared: "vec4", offset: 240, size: 16 },
    { name: "g_Texture0Resolution", type: "vec4<f32>", declared: "vec4", offset: 256, size: 16 },
    { name: "g_Overbright", type: "f32", declared: "float", offset: 272, size: 4, meta: { material: "overbright" } },
    { name: "g_Time", type: "f32", declared: "float", offset: 276, size: 4 },
  ],
  uniformBlockSize: 288,
  textures: [{ slot: 0, binding: 1, samplerBinding: 2, kind: "2d" }],
} as unknown as TranslateResult;

const P = { image: 0, particle: 1 };

function pass(key: string, program: number | null, extra: Partial<ScenePass> = {}): ScenePass {
  return {
    key,
    program,
    blending: "translucent",
    cullmode: "nocull",
    depthtest: "disabled",
    depthwrite: "disabled",
    textures: {},
    runtime: {},
    uniforms: {},
    framebuffer: false,
    ...extra,
  };
}

const texture = (path: string, width: number, height: number): SceneTexture => ({
  path,
  source: "",
  format: 0,
  width,
  height,
  textureWidth: width,
  textureHeight: height,
  flags: 0,
  clampUVs: true,
  noInterpolation: false,
  mips: [{ width, height, bytes: new Uint8Array(width * height * 4) }],
});
/** 0：图像纹理，1：`util/white`。 */
const TEXTURES = () => [texture("image", 128, 64), texture("materials/util/white.tex", 32, 32)];

function baseLayer(object: number, extra: Partial<SceneLayer> = {}): SceneLayer {
  return {
    id: object + 1,
    object,
    parent: null,
    name: `layer ${object}`,
    origin: [0, 0, 0],
    scale: [1, 1, 1],
    angles: [0, 0, 0],
    size: [],
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
    fullscreen: false,
    fullscreenSize: null,
    passes: [],
    colorBlendMode: 0,
    effects: [],
    passthrough: null,
    particle: null,
    ...extra,
  };
}

function imageLayer(object: number, extra: Partial<SceneLayer> = {}): SceneLayer {
  return baseLayer(object, {
    origin: [300, 200, 0],
    size: [128, 64],
    passes: [pass(`objects/${object}/passes/0`, P.image, { textures: { 0: 0 } })],
    ...extra,
  });
}

/**
 * 粒子层：发射器在 (100, 200, 0)、不散开、不动，每秒 10 个，寿命 100 秒，尺寸 40 → 20；不预热。
 * `json` 覆盖系统级键（`flags`、`maxcount`、`starttime`、`emitter`……）。
 */
function particleLayer(object: number, json: JsonObject = {}, extra: Partial<SceneLayer> = {}): SceneLayer {
  const particle = parseParticle(
    {
      maxcount: 16,
      emitter: [{ name: "sphererandom", origin: "100 200 0", distancemax: 0, rate: 10 }],
      initializer: [
        { name: "lifetimerandom", min: 100, max: 100 },
        { name: "sizerandom", min: 40, max: 40 },
      ],
      ...json,
    },
    { file: `particles/${object}.json`, orthographic: true },
  );
  particle.passes = [
    pass(`objects/${object}/particle/passes/0`, P.particle, {
      textures: { 0: 1 },
      blending: "additive",
      uniforms: { g_Overbright: [2] },
    }),
  ];
  return baseLayer(object, { name: `particles ${object}`, particle, ...extra });
}

function bundleOf(layers: SceneLayer[], overrides: Partial<SceneBundle> = {}): SceneBundle {
  return {
    general: {
      ...GENERAL_1080,
      fields: generalDefaults(),
      clearVariable: false,
      perspectiveOverrideFov: particleFov(95),
      postprocess: { level: "disabled", bloomFlag: false, hdrFlag: false, bloom: false, hdr: false },
      bloom: { ...BLOOM_DEFAULTS, tint: [1, 1, 1] },
    },
    layers,
    programs: [IMAGE_PROGRAM, PARTICLE_PROGRAM],
    textures: TEXTURES(),
    bloom: null,
    unsupported: [],
    bindings: [],
    scripts: { list: [] },
    ...overrides,
  };
}

const frame = (frametime: number, time = 1): FrameInput => ({
  time,
  frametime,
  daytime: 0.5,
  pointer: [0.5, 0.5],
  pointerLast: [0.5, 0.5],
  cursor: [0.5, 0.5],
});

/** 一帧，顺序同渲染器（P4c 步骤 4）：先 `stepParticles`（粒子先于脚本），再 `update` 写每帧 uniform（它不再步进粒子）。 */
function stepFrame(scene: GpuScene, input: FrameInput, state?: SceneState): void {
  scene.stepParticles(input.frametime, input.time, state, input.cursor);
  scene.update(input, state);
}

async function open(bundle: SceneBundle, particles: ParticleOptions = { seed: 1 }) {
  const gpu = new FakeGpu();
  const state = SceneState.fromBundle(bundle);
  const scene = await GpuScene.build(gpu.device, bundle, state, new Set(), [], { particles });
  return { gpu, state, scene };
}

interface DrawView {
  label: string;
  object: number;
  particles: { system: ParticleSystem; count: number } | null;
  uniformBuffer: FakeBuffer;
  vertexBuffer: FakeBuffer;
}
const internals = (scene: GpuScene) =>
  scene as unknown as {
    layers: { object: number; ops: ({ kind: "draw"; draw: DrawView } | { kind: string })[] }[];
    draws: Set<DrawView>;
  };
const particleDraw = (scene: GpuScene, object: number): DrawView =>
  [...internals(scene).draws].find((draw) => draw.object === object && draw.particles)!;
/** 一帧轨迹里的绘制相关行（去掉管线与 pass）。 */
const draws = (trace: string[]) => trace.filter((line) => /^(vertex|index|draw)/.test(line));
const floats = (buffer: FakeBuffer, offset: number, count: number) =>
  Array.from(new Float32Array(buffer.bytes.buffer, offset, count));

beforeEach(() => {
  vi.stubGlobal("GPUTextureUsage", { RENDER_ATTACHMENT: 1, TEXTURE_BINDING: 2, COPY_SRC: 4, COPY_DST: 8 });
  vi.stubGlobal("GPUBufferUsage", { VERTEX: 1, UNIFORM: 2, COPY_DST: 4, MAP_READ: 8, INDEX: 16 });
  vi.stubGlobal("GPUMapMode", { READ: 1 });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("渲染图：粒子层", () => {
  it("粒子层的计划是一个 particles 步骤；flags & 4 是透视；读帧缓冲时先拷快照；fbo 名报不支持", () => {
    const plain = planLayer(particleLayer(1), TEXTURES());
    expect(plain.steps).toMatchObject([
      {
        kind: "particles",
        target: { kind: "scene" },
        blending: "additive",
        perspective: false,
        inputs: { 0: { kind: "texture", index: 1 } },
      },
    ]);
    expect(plain.composite).toBeNull();
    expect(plain.reasons).toEqual([]);
    expect(planLayer(particleLayer(1, { flags: 4 }), TEXTURES()).steps[0]).toMatchObject({ perspective: true });

    const layer = particleLayer(1);
    layer.particle!.passes[0] = {
      ...layer.particle!.passes[0],
      runtime: { 1: FRAMEBUFFER_RT, 2: "_rt_Other" },
      framebuffer: true,
    };
    const snapped = planParticleLayer(layer);
    // 快照由渲染器编码时插（P4e 步骤 2），计划里只有读快照的输入
    expect(snapped.steps.map((step) => step.kind)).toEqual(["particles"]);
    expect(snapped.steps[0]).toMatchObject({ inputs: { 1: { kind: "framebuffer" } } });
    expect(snapped.reasons).toEqual(["render:texture-rt:_rt_Other"]);
    // 没有 pass（粒子 JSON 读不到、材质缺失）时为空
    expect(planParticleLayer(baseLayer(1, { particle: { ...layer.particle!, passes: [] } })).steps).toEqual([]);
  });

  it("签名只取 pass 的稳定键", () => {
    const signature = JSON.parse(planSignature(planLayer(particleLayer(3), TEXTURES())));
    expect(signature.steps[0].pass).toBe("objects/3/particle/passes/0");
  });

  it("有粒子 pass 的层建资源；粒子纹理上传；粒子程序进渲染器自查", () => {
    const empty = baseLayer(5, { particle: { ...particleLayer(5).particle!, passes: [] } });
    const bundle = bundleOf([imageLayer(0), particleLayer(1), empty]);
    expect(buildableLayers(bundle).map((layer) => layer.object)).toEqual([0, 1]);
    expect([...uploadableTextures(bundle)].sort()).toEqual([0, 1]);
    expect(checkRenderable(bundle, new Set())).toEqual([]);

    const noProgram = bundleOf([particleLayer(1)]);
    noProgram.layers[0].particle!.passes[0].program = null;
    expect(checkRenderable(noProgram, new Set())).toEqual(["render:no-program"]);

    // 厚格式的 a_TexCoordVec4C1（帧表，P4b 步骤 2）写得了；绳索的 a_TexCoordVec4C2（P4c）照报
    const thick = bundleOf([particleLayer(1)]);
    thick.programs[P.particle] = {
      ...PARTICLE_PROGRAM,
      attributes: [...PARTICLE_PROGRAM.attributes!, { name: "a_TexCoordVec4C1", location: 4, type: "vec4" }],
    };
    expect(checkRenderable(thick, new Set())).toEqual([]);
    const rope = bundleOf([particleLayer(1)]);
    rope.programs[P.particle] = {
      ...PARTICLE_PROGRAM,
      attributes: [...PARTICLE_PROGRAM.attributes!, { name: "a_TexCoordVec4C2", location: 4, type: "vec4" }],
    };
    expect(checkRenderable(rope, new Set())).toEqual(["render:particle-attribute:a_TexCoordVec4C2"]);

    // 能力表报的粒子细分键照常挡住，只有强制渲染才建（P4a 步骤 5 删掉了总括键 particle:pending）
    const blocked = bundleOf([particleLayer(1)], { unsupported: ["particle:operator:turbulence"] });
    expect(checkRenderable(blocked, new Set())).toEqual(["particle:operator:turbulence"]);
    expect(checkRenderable(blocked, new Set(), { ignoreUnsupported: true })).toEqual([]);
  });

  it("粒子材质的常量进 SceneState（就地写按 pass 键）", () => {
    const state = SceneState.fromBundle(bundleOf([particleLayer(1)]));
    expect(state.constants.get("objects/1/particle/passes/0")).toEqual({ g_Overbright: [2] });
  });
});

describe("GpuScene：粒子绘制（假设备）", () => {
  it("粒子层进入步骤序列，和图像层按 objects 顺序交错，画在同一个场景 pass 里", async () => {
    const bundle = bundleOf([imageLayer(0), particleLayer(1), imageLayer(2), particleLayer(3, { flags: 4 })]);
    const { gpu, state, scene } = await open(bundle);
    expect(
      internals(scene).layers.map(({ object, ops }) => [
        object,
        ops.map((op) =>
          op.kind === "draw" ? ((op as { draw: DrawView }).draw.particles ? "particles" : "draw") : op.kind,
        ),
      ]),
    ).toEqual([
      [0, ["draw"]],
      [1, ["particle-tree"]],
      [2, ["draw"]],
      [3, ["particle-tree"]],
    ]);
    stepFrame(scene, frame(0.5), state);
    const trace = gpu.encode(scene, state);
    expect(trace.filter((line) => line.startsWith("pass"))).toEqual(["pass scene target clear"]);
    expect(draws(trace)).toEqual([
      "vertex layer 1 layer 0 direct",
      "draw 4",
      "vertex layer 2 particles 1 particles",
      "index particle indices uint16",
      "drawIndexed 30",
      "vertex layer 3 layer 2 direct",
      "draw 4",
      "vertex layer 4 particles 3 particles",
      "index particle indices uint16",
      "drawIndexed 30",
    ]);
    // 粒子管线是三角形列表，图层四边形是三角形带
    const topology = (needle: string) => gpu.pipelines.filter((p) => p.label.includes(needle)).map((p) => p.topology);
    expect(new Set(topology("scene program 1 "))).toEqual(new Set(["triangle-list"]));
    expect(new Set(topology("scene program 0 "))).toEqual(new Set(["triangle-strip"]));
  });

  it("每帧：步进过才写顶点缓冲（只传存活的部分），drawIndexed 6 倍粒子数；没有粒子不画", async () => {
    const { gpu, state, scene } = await open(bundleOf([particleLayer(1)]));
    const vertexBuffer = gpu.buffer("layer 2 particles 1 particles");
    expect(vertexBuffer.size).toBe(16 * 4 * 52);
    // 没有预热：一个粒子都没有
    expect(draws(gpu.encode(scene, state))).toEqual([]);
    expect(vertexBuffer.writes).toEqual([]);

    stepFrame(scene, frame(0.5), state); // 每秒 10 个 → 5 个
    expect(draws(gpu.encode(scene, state))).toEqual([
      "vertex layer 2 particles 1 particles",
      "index particle indices uint16",
      "drawIndexed 30",
    ]);
    expect(vertexBuffer.writes).toEqual([5 * 4 * 52]);
    // 翻译器的输入顺序：位置 0、a_TexCoordVec4 12、颜色 28、a_TexCoordC2 44
    for (let corner = 0; corner < 4; corner++) {
      const o = corner * 52;
      expect(floats(vertexBuffer, o, 3)).toEqual([100, 200, 0]);
      expect(floats(vertexBuffer, o + 12, 4)).toEqual(
        [
          [0, 0],
          [0, 1],
          [1, 1],
          [1, 0],
        ][corner].concat([0, 20]),
      );
      expect(floats(vertexBuffer, o + 28, 4)).toEqual([1, 1, 1, 1]);
      expect(floats(vertexBuffer, o + 44, 2)).toEqual([0, 0]);
    }

    // 不步进就不重写：补画帧（帧时间 0）同样
    expect(draws(gpu.encode(scene, state)).at(-1)).toBe("drawIndexed 30");
    stepFrame(scene, frame(0), state);
    expect(draws(gpu.encode(scene, state)).at(-1)).toBe("drawIndexed 30");
    expect(vertexBuffer.writes).toHaveLength(1);

    stepFrame(scene, frame(0.3), state); // +3 → 8
    expect(draws(gpu.encode(scene, state)).at(-1)).toBe("drawIndexed 48");
    expect(vertexBuffer.writes).toEqual([5 * 4 * 52, 8 * 4 * 52]);
    expect(particleDraw(scene, 1).particles!.system.alive).toBe(8);
  });

  it("索引缓冲全场一份，按最大的 maxcount 建、只写一次；超过 16384 个粒子用 32 位", async () => {
    const { gpu, state, scene } = await open(bundleOf([particleLayer(1), particleLayer(2, { maxcount: 40 })]));
    const indices = gpu.buffers.filter((buffer) => buffer.usage & 16);
    expect(indices.map((buffer) => [buffer.label, buffer.size, buffer.writes])).toEqual([
      ["particle indices", 40 * 6 * 2, [40 * 6 * 2]],
    ]);
    expect(Array.from(new Uint16Array(indices[0].bytes.buffer, 0, 12))).toEqual([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);
    const count = gpu.buffers.length;
    for (let i = 0; i < 3; i++) {
      stepFrame(scene, frame(0.1), state);
      gpu.encode(scene, state);
    }
    expect(gpu.buffers.length).toBe(count);
    expect(indices[0].writes).toHaveLength(1);

    const big = await open(bundleOf([particleLayer(1, { maxcount: 20000 })]));
    stepFrame(big.scene, frame(0.5), big.state);
    expect(draws(big.gpu.encode(big.scene, big.state))).toContain("index particle indices uint32");
  });

  it("uniform：MVP = 视图投影 × 世界矩阵（父链），透视粒子换透视；粒子 uniform 与材质常量都写进缓冲；改父的 origin 就地刷新", async () => {
    const group = baseLayer(0, { name: "group", origin: [100, 50, 0] });
    const bundle = bundleOf([
      group,
      particleLayer(1, {}, { parent: 0, origin: [10, 0, 0] }),
      particleLayer(2, { flags: 4 }),
    ]);
    const { state, scene } = await open(bundle);
    const ortho = sceneViewProjection(GENERAL_1080);
    const perspective = particleViewProjection(bundle.general);
    const uniforms = (object: number) => particleDraw(scene, object).uniformBuffer;
    expect(floats(uniforms(1), 0, 16)).toEqual(Array.from(multiply(ortho, translation(110, 50, 0))));
    expect(floats(uniforms(2), 0, 16)).toEqual(Array.from(perspective));
    closeRelative(floats(uniforms(2), 0, 16), WPE_PERSPECTIVE_95);
    expect(floats(uniforms(1), 128, 3)).toEqual([0, 1, 0]);
    expect(floats(uniforms(1), 144, 3)).toEqual([1, 0, 0]);
    expect(floats(uniforms(1), 160, 3)).toEqual([0, 0, 1]);
    expect(floats(uniforms(1), 208, 3)).toEqual([960, 540, 2000]);
    expect(floats(uniforms(1), 256, 4)).toEqual([32, 32, 32, 32]);
    expect(floats(uniforms(1), 272, 1)).toEqual([2]);

    state.write({ property: "p", target: { kind: "layer", object: 0, field: "origin" } }, "200 50 0");
    scene.sync(state);
    stepFrame(scene, frame(1 / 60, 2.5), state);
    expect(floats(uniforms(1), 0, 16)).toEqual(Array.from(multiply(ortho, translation(210, 50, 0))));
    // 每帧内置量照常写
    expect(floats(uniforms(1), 276, 1)).toEqual([2.5]);
  });

  it("世界空间系统（P4c 步骤 4，rea-p4c-sim.md 5.3）：模型矩阵是单位阵、MVP 等于视图投影（透视粒子同样）；本地系统不变；改对象变换后仍是单位阵", async () => {
    const group = baseLayer(0, { name: "group", origin: [100, 50, 0] });
    const transform = { parent: 0, origin: [10, 0, 0], angles: [0, 0, 0.5], scale: [2, 2, 1] };
    const bundle = bundleOf([
      group,
      particleLayer(1, { flags: 1 }, transform),
      particleLayer(2, {}, transform),
      particleLayer(3, { flags: 5 }, transform),
    ]);
    const { state, scene } = await open(bundle);
    const ortho = Array.from(sceneViewProjection(GENERAL_1080));
    const perspective = Array.from(particleViewProjection(bundle.general));
    const IDENTITY = Array.from(identity());
    const uniforms = (object: number) => particleDraw(scene, object).uniformBuffer;
    /** draw 的全部静态 uniform（块里没有 `g_ModelMatrix`，按建 draw / 就地刷新的同一个函数取）。 */
    const values = (object: number) => {
      const draw = particleDraw(scene, object) as unknown as {
        step: unknown;
        layer: unknown;
        textureSizes: unknown;
      };
      const internal = scene as unknown as {
        uniformValues(...args: unknown[]): Record<string, number[]>;
      };
      return internal.uniformValues(
        draw.step,
        draw.layer,
        state.layers.get(object),
        draw.textureSizes,
        state,
        new Map(),
      );
    };
    const check = () => {
      const local = Array.from(multiply(sceneViewProjection(GENERAL_1080), worldMatrixOf(2, state.layers, new Map())));
      expect(floats(uniforms(1), 0, 16)).toEqual(ortho);
      // g_ModelMatrixInverse
      expect(floats(uniforms(1), 64, 16)).toEqual(IDENTITY);
      expect(values(1).g_ModelMatrix).toEqual(IDENTITY);
      expect(values(1).g_ModelViewProjectionMatrix).toEqual(ortho);
      expect(floats(uniforms(3), 0, 16)).toEqual(perspective);
      expect(values(3).g_ModelMatrix).toEqual(IDENTITY);
      // 本地系统照旧乘对象世界矩阵（父链）
      expect(floats(uniforms(2), 0, 16)).toEqual(local);
      expect(local).not.toEqual(ortho);
    };
    check();
    // 改父对象的变换：脏图层整块重写，世界空间系统重写后仍是单位阵
    state.write({ property: "p", target: { kind: "layer", object: 0, field: "origin" } }, "700 300 0");
    scene.sync(state);
    stepFrame(scene, frame(1 / 60, 2.5), state);
    check();
    expect(floats(uniforms(2), 0, 16)).toEqual(
      Array.from(multiply(sceneViewProjection(GENERAL_1080), worldMatrixOf(2, state.layers, new Map()))),
    );
  });

  it("控制点的输入（P4c 步骤 1）：建场景按状态里的世界矩阵（父链）预热；每帧按状态重算；不给状态时用加载时的", async () => {
    const group = baseLayer(0, { name: "group", origin: [1000, 0, 0] });
    // 控制点 1 带 flags 2：本地系统里 current = inverse(W)·(100, 100, 0)；发射距离 0，出生点就是它
    const layer = particleLayer(
      1,
      {
        emitter: [{ name: "sphererandom", controlpoint: 1, distancemax: 0, rate: 10 }],
        controlpoint: [{}, { offset: "100 100 0", flags: 2 }],
      },
      { parent: 0 },
    );
    const { state, scene } = await open(bundleOf([group, layer]));
    const system = particleDraw(scene, 1).particles!.system;
    const current = () => Array.from(system.controlPoints.current(1).translation);
    expect(current()).toEqual([-900, 100, 0]);
    state.write({ property: "p", target: { kind: "layer", object: 0, field: "origin" } }, "2000 0 0");
    scene.sync(state);
    stepFrame(scene, frame(0.25), state);
    expect(current()).toEqual([-1900, 100, 0]);
    // 本帧出生的粒子用本帧的值
    expect(system.alive).toBe(2);
    expect(system.columns.position[0][0]).toBe(-1900);
    // 不给 state（dev 探针按 dt 回放）：用加载时的世界矩阵
    scene.stepParticles(0.25, 1);
    expect(current()).toEqual([-900, 100, 0]);
  });

  it("帧表（P4b 步骤 2）：槽 0 纹理带 sheet 的粒子层写 g_RenderVar1，其余仍是 0；就地刷新后保持；顶点写 a_TexCoordVec4C1", async () => {
    const sheet = { renderVar1: [0.125, 0.125, 64, 1] as [number, number, number, number], npot: false };
    const bundle = bundleOf([particleLayer(1), particleLayer(2), particleLayer(3)]);
    bundle.textures.push({ ...texture("materials/particle/fog/fog1.tex", 64, 64), sheet });
    // 槽 0 是帧表纹理；槽 1 的帧表不算（WPE 只看基础材质槽 0）
    bundle.layers[0].particle!.passes[0].textures = { 0: 2 };
    bundle.layers[1].particle!.passes[0].textures = { 0: 1, 1: 2 };
    bundle.layers[0].particle!.spriteSheet = true;
    bundle.programs.push({
      ...PARTICLE_PROGRAM,
      attributes: [...PARTICLE_PROGRAM.attributes!, { name: "a_TexCoordVec4C1", location: 4, type: "vec4" }],
    } as TranslateResult);
    bundle.layers[0].particle!.passes[0].program = 2;
    const { gpu, state, scene } = await open(bundle);
    const uniforms = (object: number) => particleDraw(scene, object).uniformBuffer;
    expect(floats(uniforms(1), 240, 4)).toEqual([0.125, 0.125, 64, 1]);
    expect(floats(uniforms(2), 240, 4)).toEqual([0, 0, 0, 0]);
    expect(floats(uniforms(3), 240, 4)).toEqual([0, 0, 0, 0]);
    // 就地刷新（改图层变换）走同一个 uniformValues，帧表照写
    state.write({ property: "p", target: { kind: "layer", object: 1, field: "origin" } }, "5 0 0");
    scene.sync(state);
    stepFrame(scene, frame(0.25), state);
    expect(floats(uniforms(1), 240, 4)).toEqual([0.125, 0.125, 64, 1]);
    // 出生当帧 frame 是 0，下一帧才按年龄更新
    stepFrame(scene, frame(0.25), state);
    gpu.encode(scene, state);
    // 顶点：步长 17 个 float，C1 在偏移 13（反射顺序的最后一组）：速度列、frame = age / life（寿命 100）
    const draw = particleDraw(scene, 1);
    const system = draw.particles!.system;
    expect(system.alive).toBe(5);
    const { velocity, frame: frames } = system.columns;
    const vertices = floats(draw.vertexBuffer, 0, 17 * 4);
    for (let corner = 0; corner < 4; corner++)
      expect(vertices.slice(corner * 17 + 13, corner * 17 + 17)).toEqual([
        velocity[0][0],
        velocity[1][0],
        velocity[2][0],
        frames[0],
      ]);
    expect(system.columns.frame[0]).toBe(Math.fround(Math.fround(Math.fround(1 / 100) * system.columns.age[0]) * 1));
    expect(system.columns.frame[0]).toBeGreaterThan(0);
  });

  it("dev 探针的 R 注入（replayParticleOptions）：按出生顺序顶替 R，用完退回种子随机数，只改注入的那个粒子层", async () => {
    const json = { animationmode: "randomframe" };
    const bundle = bundleOf([particleLayer(1, json), particleLayer(2, json)]);
    const plain = await open(bundle, { seed: 3 });
    const injected = await open(bundle, replayParticleOptions({ dts: [], seed: 3, random: { 1: [0.25, 0.5] } }));
    for (const { scene, state } of [plain, injected]) stepFrame(scene, frame(0.35), state);
    const columns = (scene: GpuScene, object: number) => particleDraw(scene, object).particles!.system.columns;
    // 0.35 s、每秒 10 个：3 个粒子
    const r = (scene: GpuScene, object: number) => Array.from(columns(scene, object).random.subarray(0, 3));
    const seeded = r(plain.scene, 1);
    expect(r(injected.scene, 1)).toEqual([0.25, 0.5, seeded[2]]);
    // randomframe 的 frame 就是 R
    expect(Array.from(columns(injected.scene, 1).frame.subarray(0, 3))).toEqual([0.25, 0.5, seeded[2]]);
    expect(r(injected.scene, 2)).toEqual(r(plain.scene, 2));
  });

  it("不可见的粒子层不画、不发射，存活粒子清空；重新可见后照常发射（P4a 步骤 5，C8）", async () => {
    const { gpu, state, scene } = await open(bundleOf([imageLayer(0), particleLayer(1, {}, { visibleBound: true })]));
    stepFrame(scene, frame(0.5), state);
    gpu.encode(scene, state);
    const system = particleDraw(scene, 1).particles!.system;
    expect(system.alive).toBe(5);
    state.write({ property: "p", target: { kind: "layer", object: 1, field: "visible" } }, false);
    scene.sync(state);
    stepFrame(scene, frame(0.5), state);
    expect(system.alive).toBe(0);
    expect(system.highWater).toBe(0);
    expect(draws(gpu.encode(scene, state))).toEqual(["vertex layer 1 layer 0 direct", "draw 4"]);
    // 不可见期间不发射
    stepFrame(scene, frame(0.5), state);
    expect(system.alive).toBe(0);
    state.write({ property: "p", target: { kind: "layer", object: 1, field: "visible" } }, true);
    scene.sync(state);
    stepFrame(scene, frame(0.5), state);
    expect(system.alive).toBe(5);
    expect(draws(gpu.encode(scene, state)).at(-1)).toBe("drawIndexed 30");
  });

  it("写死不可见的祖先下面的粒子层不建资源", async () => {
    const { gpu, scene } = await open(
      bundleOf([baseLayer(0, { visible: false }), particleLayer(1, {}, { parent: 0 }), imageLayer(2)]),
    );
    expect(internals(scene).layers.map((layer) => layer.object)).toEqual([2]);
    expect(gpu.buffers.some((buffer) => buffer.label === "particle indices")).toBe(false);
  });

  it("建场景时预热；场景销毁释放全部缓冲", async () => {
    const { gpu, scene } = await open(bundleOf([particleLayer(1, { starttime: 1 })]));
    // starttime 1：步长 0.05 走 20 步，每秒 10 个 → 10 个
    expect(particleDraw(scene, 1).particles!.system.alive).toBe(10);
    expect([...gpu.live].map((buffer) => buffer.label)).toEqual(
      expect.arrayContaining(["particle indices", "layer 2 particles 1 particles"]),
    );
    scene.destroy();
    expect(gpu.live.size).toBe(0);
  });

  it("种子：第 i 个粒子层用 seed + i，按 dt 回放与 particleTrack 逐位相同（探针的确定性回放）", async () => {
    const spread = {
      emitter: [{ name: "sphererandom", origin: "500 500 0", distancemax: 80, speedmax: 30, rate: 20 }],
    };
    const bundle = bundleOf([imageLayer(0), particleLayer(1, spread), particleLayer(2, { ...spread, starttime: 0.5 })]);
    // 第 0 个粒子层写死不可见、不建资源，序号照样算
    bundle.layers.splice(1, 0, particleLayer(5, spread, { visible: false }));
    const dts = [0.1, 0.2, 0.05, 1 / 60];
    const { state, scene } = await open(bundle, { seed: 7 });
    const { time, frametime } = replayParticles(scene, state, { dts, seed: 7 });
    stepFrame(scene, frame(frametime, time), state);
    const track = particleTrack({ layers: bundle.layers, dts, frames: [dts.length], passes: 1, seed: 7 });
    for (const object of [1, 2]) {
      const name = `particles ${object}`;
      const ours = particleSnapshot(particleDraw(scene, object).particles!.system);
      expect(ours.length).toBeGreaterThan(0);
      expect(ours).toEqual(track.frames[0].systems[name]);
    }
    expect(time).toBeCloseTo(0.35 + 1 / 60, 12);
  });

  it("场景时间（P4b 步骤 4）：stepParticles 把这一帧的 g_Time 交给粒子当 T，回放按 times 逐帧传；update 不步进（P4c 步骤 4）", async () => {
    const bundle = bundleOf([particleLayer(1)]);
    const { state, scene } = await open(bundle);
    const step = vi.spyOn(particleDraw(scene, 1).particles!.system, "step");
    // update 只写 uniform，不步进粒子（粒子由调用方在脚本之前先 stepParticles）
    scene.update(frame(0.02, 123.25), state);
    expect(step).not.toHaveBeenCalled();
    scene.stepParticles(0.02, 123.25, state);
    // 第三个参数是控制点的输入（对象世界矩阵，P4c 步骤 1），这里只看前两个
    const timing = (calls: unknown[][]) => calls.map((call) => call.slice(0, 2));
    expect(timing([step.mock.lastCall!])).toEqual([[0.02, 123.25]]);
    expect(replayParticles(scene, state, { dts: [0.1, 0.2, 0.3], times: [5, 5.2, 5.5] })).toEqual({
      time: 5.5,
      frametime: 0.3,
    });
    expect(timing(step.mock.calls.slice(1))).toEqual([
      [0.1, 5],
      [0.2, 5.2],
    ]);
    // 没给 times 时是 dt 的累计值
    replayParticles(scene, state, { dts: [0.1, 0.2, 0.3] });
    expect(timing(step.mock.calls.slice(3))).toEqual([
      [0.1, 0.1],
      [0.2, 0.1 + 0.2],
    ]);
    scene.destroy();
  });
});

describe("GpuScene：拖尾与 sprite 朝向（P4c 步骤 5）", () => {
  // uniform 偏移见 PARTICLE_PROGRAM：Up 128、Right 144、Forward 160、g_RenderVar0 224
  const orientation = (draw: DrawView) => ({
    up: floats(draw.uniformBuffer, 128, 3).map((v) => v + 0),
    right: floats(draw.uniformBuffer, 144, 3).map((v) => v + 0),
    forward: floats(draw.uniformBuffer, 160, 3).map((v) => v + 0),
  });
  const near = (actual: number[], expected: number[]) =>
    expected.forEach((value, i) => expect(actual[i], `${actual} vs ${expected}`).toBeCloseTo(value, 6));
  const ANGLES = (object: number) => ({ kind: "layer", object, field: "angles" }) as const;
  const ORIGIN = (object: number) => ({ kind: "layer", object, field: "origin" }) as const;
  /** 速度定值的粒子层（velocityrandom 的 min = max）。 */
  const moving = (velocity: string, renderer: JsonObject[], json: JsonObject = {}) => ({
    initializer: [
      { name: "lifetimerandom", min: 100, max: 100 },
      { name: "sizerandom", min: 40, max: 40 },
      { name: "velocityrandom", min: velocity, max: velocity },
    ],
    renderer,
    ...json,
  });

  it("朝向按 renderer 与绘制的模型矩阵写（rea-p4c-render.md 7.2）；改对象变换就地重写；世界空间系统用单位阵；材质值优先", async () => {
    const [c, s] = [Math.cos(0.5), Math.sin(0.5)];
    const upright = [{ name: "sprite", flags: 1 }];
    const bundle = bundleOf([
      particleLayer(1, { renderer: upright }, { angles: [0, 0, 0.5] }),
      particleLayer(2, { flags: 1, renderer: upright }, { angles: [0, 0, 0.5] }),
      particleLayer(3, { renderer: [{ name: "sprite", orientation: "upright", axis: "1 0 0" }] }),
      particleLayer(4, { renderer: upright }, { angles: [0, 0, 0.5] }),
    ]);
    bundle.layers[3].particle!.passes[0].uniforms = { g_Overbright: [2], g_OrientationUp: [0, 0, 1] };
    const { state, scene } = await open(bundle);
    // 本地系统、flags 1：本地基反向转（世界里保持直立，S13）
    let local = orientation(particleDraw(scene, 1));
    near(local.right, [c, -s, 0]);
    near(local.up, [s, c, 0]);
    near(local.forward, [0, 0, 1]);
    // 世界空间系统：模型矩阵是单位阵，朝向不看对象的旋转
    expect(orientation(particleDraw(scene, 2))).toEqual({ up: [0, 1, 0], right: [1, 0, 0], forward: [0, 0, 1] });
    // upright 轴 (1,0,0)：纹理转 90°（7.4）
    const turned = orientation(particleDraw(scene, 3));
    near(turned.right, [0, -1, 0]);
    near(turned.up, [1, 0, 0]);
    // 改对象变换：脏图层就地重写朝向；世界空间系统仍是单位基
    state.write({ property: "a", target: ANGLES(1) }, "0 0 0");
    state.write({ property: "b", target: ANGLES(2) }, "0 0 1");
    state.write({ property: "c", target: ANGLES(4) }, "0 0 0");
    scene.sync(state);
    stepFrame(scene, frame(1 / 60), state);
    local = orientation(particleDraw(scene, 1));
    near(local.right, [1, 0, 0]);
    near(local.up, [0, 1, 0]);
    expect(orientation(particleDraw(scene, 2))).toEqual({ up: [0, 1, 0], right: [1, 0, 0], forward: [0, 0, 1] });
    // 材质值优先：就地刷新不覆盖 pass.uniforms 里的名字，其余两个照常重写
    const material = orientation(particleDraw(scene, 4));
    expect(material.up).toEqual([0, 0, 1]);
    near(material.right, [1, 0, 0]);
  });

  it("upright 的轴平行于视线：朝向是 NaN，这次绘制跳过（不 drawIndexed、不传顶点），uniform 照写；对象转开后照常画", async () => {
    const bundle = bundleOf([
      particleLayer(1, { renderer: [{ name: "sprite", orientation: "upright", axis: "0 0 1" }] }),
      particleLayer(2),
    ]);
    const { gpu, state, scene } = await open(bundle);
    stepFrame(scene, frame(0.5), state);
    expect(draws(gpu.encode(scene, state))).toEqual([
      "vertex layer 3 particles 2 particles",
      "index particle indices uint16",
      "drawIndexed 30",
    ]);
    expect(gpu.buffer("layer 2 particles 1 particles").writes).toEqual([]);
    const hidden = orientation(particleDraw(scene, 1));
    expect(hidden.up).toEqual([0, 0, 1]);
    expect(hidden.right.every(Number.isNaN)).toBe(true);
    // 模拟照常（隐藏的是绘制，不是对象）
    expect(particleDraw(scene, 1).particles!.system.alive).toBe(5);
    // 对象绕 x 转：轴离开视线，下一帧照画（不用等步进，顶点已标 stale）
    state.write({ property: "a", target: ANGLES(1) }, "0.5 0 0");
    scene.sync(state);
    expect(draws(gpu.encode(scene, state))).toEqual([
      "vertex layer 2 particles 1 particles",
      "index particle indices uint16",
      "drawIndexed 30",
      "vertex layer 3 particles 2 particles",
      "index particle indices uint16",
      "drawIndexed 30",
    ]);
    // uniform 块在 update 时整块重写
    scene.update(frame(0), state);
    expect(orientation(particleDraw(scene, 1)).right.some(Number.isNaN)).toBe(false);
  });

  it("拖尾：g_RenderVar0 = (length, maxlength, minlength, 0)，sprite 为 0；速度为 0 的粒子不写顶点、不画；sprite 系统速度为 0 照画", async () => {
    const trail = [{ name: "spritetrail", length: 0.08, maxlength: 7, minlength: 12 }];
    const bundle = bundleOf([
      particleLayer(1, { renderer: trail }),
      particleLayer(2),
      particleLayer(3, moving("100 0 0", [{ name: "spritetrail" }])),
    ]);
    const { gpu, state, scene } = await open(bundle);
    expect(floats(particleDraw(scene, 1).uniformBuffer, 224, 4)).toEqual([Math.fround(0.08), 7, 12, 0]);
    expect(floats(particleDraw(scene, 2).uniformBuffer, 224, 4)).toEqual([0, 0, 0, 0]);
    expect(floats(particleDraw(scene, 3).uniformBuffer, 224, 4)).toEqual([Math.fround(0.05), 10, 0, 0]);
    stepFrame(scene, frame(0.5), state);
    // 层 1：5 个粒子都静止，一个都不写；层 2（sprite）照画；层 3 有速度，全写
    expect(draws(gpu.encode(scene, state))).toEqual([
      "vertex layer 3 particles 2 particles",
      "index particle indices uint16",
      "drawIndexed 30",
      "vertex layer 4 particles 3 particles",
      "index particle indices uint16",
      "drawIndexed 30",
    ]);
    expect(particleDraw(scene, 1).particles!.count).toBe(0);
    expect(particleDraw(scene, 1).particles!.system.alive).toBe(5);
    // 层 3：把两个粒子的速度清零，重写顶点后只画 3 个，写的是余下的（按槽序）
    const draw = particleDraw(scene, 3);
    const system = draw.particles!.system;
    for (const slot of [1, 3]) for (let i = 0; i < 3; i++) system.columns.velocity[i][slot] = 0;
    (draw.particles as unknown as { stale: boolean }).stale = true;
    expect(draws(gpu.encode(scene, state)).at(-1)).toBe("drawIndexed 18");
    expect(draw.particles!.count).toBe(3);
  });

  it("拖尾：速度平行于视线的不写；眼位按绘制模型矩阵换到本地，对象移动后不步进也重写顶点", async () => {
    // 粒子在本地 (100, 200, 0)，对象在原点时 eyeLocal = (960, 540, 2000)：速度 (−43, −17, −100) 正好指向眼位（−0.05 倍）
    const bundle = bundleOf([
      particleLayer(1, moving("-43 -17 -100", [{ name: "spritetrail" }])),
      particleLayer(2, moving("0 0 100", [{ name: "spritetrail" }])),
    ]);
    const { gpu, state, scene } = await open(bundle);
    stepFrame(scene, frame(0.5), state);
    expect(draws(gpu.encode(scene, state))).toEqual([
      "vertex layer 3 particles 2 particles",
      "index particle indices uint16",
      "drawIndexed 30",
    ]);
    // 层 2 的对象移到 (860, 340)：本地眼位 (100, 200, 2000) 正在粒子正上方，沿 z 的速度退化
    state.write({ property: "o", target: ORIGIN(2) }, "860 340 0");
    scene.sync(state);
    expect(draws(gpu.encode(scene, state))).toEqual([]);
    // 移回原点：眼位换回，顶点重写，照画
    state.write({ property: "o", target: ORIGIN(2) }, "0 0 0");
    scene.sync(state);
    expect(draws(gpu.encode(scene, state)).at(-1)).toBe("drawIndexed 30");
  });

  it("世界空间的拖尾：眼位就是场景的 g_EyePosition（模型矩阵是单位阵），不随对象移动", async () => {
    const bundle = bundleOf([
      particleLayer(1, moving("0 0 100", [{ name: "spritetrail" }], { flags: 1 }), { origin: [860, 340, 0] }),
    ]);
    const { gpu, state, scene } = await open(bundle);
    // 粒子出生在世界 (960, 540, 0)（对象原点 + 发射器 origin），正好在场景眼位正下方：退化
    stepFrame(scene, frame(0.5), state);
    expect(particleDraw(scene, 1).particles!.system.columns.position[0][0]).toBe(960);
    expect(draws(gpu.encode(scene, state))).toEqual([]);
    state.write({ property: "o", target: ORIGIN(1) }, "0 0 0");
    scene.sync(state);
    // 已发出的粒子留在原地，眼位不变，仍不画
    expect(draws(gpu.encode(scene, state))).toEqual([]);
  });

  it("dev 探针 particleProbe：拖尾跳过退化的粒子，hidden 标出朝向是 NaN 的层", async () => {
    const bundle = bundleOf([
      particleLayer(1, { renderer: [{ name: "spritetrail" }] }),
      particleLayer(2, { renderer: [{ name: "sprite", orientation: "upright", axis: "0 0 1" }] }),
    ]);
    const { state, scene } = await open(bundle);
    stepFrame(scene, frame(0.5), state);
    const trail = scene.particleProbe(1)!;
    expect([trail.count, trail.hidden, trail.trailEye]).toEqual([0, false, [960, 540, 2000]]);
    const upright = scene.particleProbe(2)!;
    expect([upright.count, upright.hidden, upright.trailEye]).toEqual([5, true, null]);
  });
});

/**
 * 翻译后 `genericropeparticle`（`GS_ENABLED`、`THICKFORMAT`，几何着色器展开）的反射：6 个 vec4 输入的顺序照真实输出，
 * `geometry.maxVertices` = 4 + 2·3。
 */
const ROPE_PROGRAM = {
  ok: true,
  vertex: { wgsl: "// rope v", entryPoint: "main" },
  fragment: { wgsl: "// rope f", entryPoint: "main" },
  attributes: [
    { name: "a_PositionVec4", location: 0, type: "vec4" },
    { name: "a_TexCoordVec4", location: 1, type: "vec4" },
    { name: "a_TexCoordVec4C1", location: 2, type: "vec4" },
    { name: "a_TexCoordVec4C2", location: 3, type: "vec4" },
    { name: "a_TexCoordVec4C3", location: 4, type: "vec4" },
    { name: "a_Color", location: 5, type: "vec4" },
  ],
  uniforms: [
    { name: "g_ModelViewProjectionMatrix", type: "mat4x4<f32>", declared: "mat4", offset: 0, size: 64 },
    { name: "g_ModelMatrixInverse", type: "mat4x4<f32>", declared: "mat4", offset: 64, size: 64 },
    { name: "g_EyePosition", type: "vec3<f32>", declared: "vec3", offset: 128, size: 12 },
    { name: "g_OrientationForward", type: "vec3<f32>", declared: "vec3", offset: 144, size: 12 },
    { name: "g_RenderVar0", type: "vec4<f32>", declared: "vec4", offset: 160, size: 16 },
  ],
  uniformBlockSize: 176,
  textures: [{ slot: 0, binding: 1, samplerBinding: 2, kind: "2d" }],
  geometry: { maxVertices: 10 },
} as unknown as TranslateResult;

describe("GpuScene：rope（P4d 步骤 1，几何着色器展开）", () => {
  const P_ROPE = 2;
  /** rope 层：同 `particleLayer`，粒子沿 +x 走（每帧位置不同），renderer 是 rope，pass 用 `ROPE_PROGRAM`。 */
  const ropeLayer = (object: number, rope: JsonObject = {}, json: JsonObject = {}, extra: Partial<SceneLayer> = {}) => {
    const layer = particleLayer(
      object,
      {
        initializer: [
          { name: "lifetimerandom", min: 100, max: 100 },
          { name: "sizerandom", min: 40, max: 40 },
          { name: "velocityrandom", min: "100 0 0", max: "100 0 0" },
        ],
        operator: [{ name: "movement" }],
        renderer: [{ name: "rope", ...rope }],
        ...json,
      },
      extra,
    );
    layer.particle!.passes[0].program = P_ROPE;
    return layer;
  };
  const ropeBundle = (layers: SceneLayer[]) =>
    bundleOf(layers, { programs: [IMAGE_PROGRAM, PARTICLE_PROGRAM, ROPE_PROGRAM] });

  it("实例步进、三角形带；draw(maxVertices, 段数)，不用索引；段数 0 不画；sprite 的路径不变", async () => {
    const { gpu, state, scene } = await open(ropeBundle([particleLayer(1), ropeLayer(2)]));
    const ropeBuffer = gpu.buffer("layer 3 particles 2 particles");
    // 按 maxcount 段分配，每段 96 字节（WPE 同）
    expect(ropeBuffer.size).toBe(16 * 96);
    expect(gpu.buffer("layer 2 particles 1 particles").size).toBe(16 * 4 * 52);
    const pipeline = (program: number) =>
      gpu.pipelines.filter((p) => p.label.startsWith(`scene program ${program} `)).map((p) => [p.topology, p.stepMode]);
    expect(pipeline(P_ROPE)).toEqual([["triangle-strip", "instance"]]);
    expect(pipeline(P.particle)).toEqual([["triangle-list", "vertex"]]);
    // 没有粒子：都不画
    expect(draws(gpu.encode(scene, state))).toEqual([]);
    // 一个粒子：sprite 画，rope 没有段、不画也不传
    stepFrame(scene, frame(0.1), state);
    expect(draws(gpu.encode(scene, state))).toEqual([
      "vertex layer 2 particles 1 particles",
      "index particle indices uint16",
      "drawIndexed 6",
    ]);
    expect(ropeBuffer.writes).toEqual([]);
    for (let i = 0; i < 4; i++) stepFrame(scene, frame(0.1), state);
    expect(draws(gpu.encode(scene, state))).toEqual([
      "vertex layer 2 particles 1 particles",
      "index particle indices uint16",
      "drawIndexed 30",
      "vertex layer 3 particles 2 particles",
      "draw 10 4",
    ]);
    // 只传 4 段
    expect(ropeBuffer.writes).toEqual([4 * 96]);
  });

  it("段顶点按 rope 表写（rea-p4d-rope.md 1.3）；g_RenderVar0 为 0；particleProbe 给段与 maxVertices", async () => {
    const { gpu, state, scene } = await open(ropeBundle([ropeLayer(1)]));
    for (let i = 0; i < 5; i++) stepFrame(scene, frame(0.1), state);
    gpu.encode(scene, state);
    const draw = particleDraw(scene, 1);
    const system = draw.particles!.system;
    const table = Array.from(system.ropeOrder!.slots.subarray(0, system.ropeOrder!.length));
    const pos = (slot: number) => [0, 1, 2].map((axis) => system.columns.position[axis][slot]);
    // 段 1：起点 = 表里第 1 个，终点 = 第 2 个；CP0 = 第 0 个，CP1 = 第 3 个；w：尺寸 20、TL、1 + TP0、终点尺寸
    // TL：R = 10、L = 100，R·L > 存活数 5，Rf = min(60, 10)，N − 1 = 999 > 5，缺省平滑也不平滑：TL = 5
    expect(floats(draw.vertexBuffer, 96, 4)).toEqual([...pos(table[1]), 20]);
    expect(floats(draw.vertexBuffer, 96 + 16, 4)).toEqual([...pos(table[2]), 5]);
    expect(floats(draw.vertexBuffer, 96 + 32, 4)).toEqual([...pos(table[0]), 1]);
    expect(floats(draw.vertexBuffer, 96 + 48, 4)).toEqual([...pos(table[3]), 20]);
    expect(floats(draw.vertexBuffer, 96 + 64, 4)).toEqual([1, 1, 1, 1]);
    expect(floats(draw.vertexBuffer, 96 + 80, 4)).toEqual([1, 1, 1, 1]);
    expect(floats(draw.uniformBuffer, 160, 4)).toEqual([0, 0, 0, 0]);
    const probe = scene.particleProbe(1)!;
    expect([probe.count, probe.rope, probe.vertices.length]).toEqual([4, { maxVertices: 10 }, 4 * 24]);
  });

  it("朝向：screen 的绳不因 g_Orientation* 跳过；ORIENTATION ≠ 0 且朝向是 NaN 时整次跳过（WPE 整条右向量是 NaN）", async () => {
    const bundle = ropeBundle([
      ropeLayer(1, { orientation: "upright", axis: "0 0 1" }),
      ropeLayer(2, {}, {}, { scale: [0, 0, 0] }),
    ]);
    const { gpu, state, scene } = await open(bundle);
    expect(scene.particleProbe(1)!.hidden).toBe(true);
    // 对象缩放为 0：screen 朝向的基是 NaN，但 rope 的 screen 分支不读它
    expect(scene.particleProbe(2)!.hidden).toBe(false);
    for (let i = 0; i < 3; i++) stepFrame(scene, frame(0.1), state);
    expect(draws(gpu.encode(scene, state))).toEqual(["vertex layer 3 particles 2 particles", "draw 10 2"]);
  });
});

/**
 * 翻译后 `genericropeparticle`（`GS_ENABLED`、非 `THICKFORMAT`、`TRAILRENDERER`，几何着色器展开）的反射：4 个 vec4 + 1 个 vec3 输入，
 * 顺序照真实输出，`geometry.maxVertices` = 4 + 2·1。uniform 里故意没有每帧的 `g_Time`：`g_RenderVar0` 也要每帧写。
 */
const TRAIL_PROGRAM = {
  ...ROPE_PROGRAM,
  vertex: { wgsl: "// ropetrail v", entryPoint: "main" },
  attributes: [
    { name: "a_PositionVec4", location: 0, type: "vec4" },
    { name: "a_TexCoordVec4", location: 1, type: "vec4" },
    { name: "a_TexCoordVec4C1", location: 2, type: "vec4" },
    { name: "a_TexCoordVec3C2", location: 3, type: "vec3" },
    { name: "a_Color", location: 4, type: "vec4" },
  ],
  geometry: { maxVertices: 6 },
} as unknown as TranslateResult;

describe("GpuScene：ropetrail（P4d 步骤 2，几何着色器展开 + 每粒子 n 段）", () => {
  const P_ROPE = 2;
  const P_TRAIL = 3;
  /** ropetrail 层：同 `particleLayer`，粒子沿 +x 走，renderer 是 ropetrail（缺省 n 3、间隔 0.15），pass 用 `TRAIL_PROGRAM`。 */
  const trailLayer = (object: number, trail: JsonObject = {}) => {
    const layer = particleLayer(object, {
      initializer: [
        { name: "lifetimerandom", min: 100, max: 100 },
        { name: "sizerandom", min: 40, max: 40 },
        { name: "velocityrandom", min: "100 0 0", max: "100 0 0" },
      ],
      operator: [{ name: "movement" }],
      renderer: [{ name: "ropetrail", segments: 3, length: 0.45, ...trail }],
    });
    layer.particle!.passes[0].program = P_TRAIL;
    return layer;
  };
  const ropeLayer = (object: number) => {
    const layer = particleLayer(object, { renderer: [{ name: "rope" }] });
    layer.particle!.passes[0].program = P_ROPE;
    return layer;
  };
  const trailBundle = (layers: SceneLayer[]) =>
    bundleOf(layers, { programs: [IMAGE_PROGRAM, PARTICLE_PROGRAM, ROPE_PROGRAM, TRAIL_PROGRAM] });

  it("实例步进、三角形带；缓冲按 maxcount × n 段（每段 76 字节）；draw(maxVertices, 存活数 · n)；sprite、rope 的路径不变", async () => {
    const { gpu, state, scene } = await open(trailBundle([particleLayer(1), ropeLayer(2), trailLayer(3)]));
    const trailBuffer = gpu.buffer("layer 4 particles 3 particles");
    expect(trailBuffer.size).toBe(16 * 3 * 76);
    expect(gpu.buffer("layer 3 particles 2 particles").size).toBe(16 * 96);
    const pipeline = (program: number) =>
      gpu.pipelines.filter((p) => p.label.startsWith(`scene program ${program} `)).map((p) => [p.topology, p.stepMode]);
    expect(pipeline(P_TRAIL)).toEqual([["triangle-strip", "instance"]]);
    expect(pipeline(P_ROPE)).toEqual([["triangle-strip", "instance"]]);
    expect(pipeline(P.particle)).toEqual([["triangle-list", "vertex"]]);
    expect(draws(gpu.encode(scene, state))).toEqual([]);
    // 一个粒子：rope 没有段、不画；ropetrail 画 n 段
    stepFrame(scene, frame(0.1), state);
    expect(draws(gpu.encode(scene, state))).toEqual([
      "vertex layer 2 particles 1 particles",
      "index particle indices uint16",
      "drawIndexed 6",
      "vertex layer 4 particles 3 particles",
      "draw 6 3",
    ]);
    for (let i = 0; i < 3; i++) stepFrame(scene, frame(0.1), state);
    expect(draws(gpu.encode(scene, state))).toEqual([
      "vertex layer 2 particles 1 particles",
      "index particle indices uint16",
      "drawIndexed 24",
      "vertex layer 3 particles 2 particles",
      "draw 10 3",
      "vertex layer 4 particles 3 particles",
      "draw 6 12",
    ]);
    // 只传 4 个粒子 × 3 段
    expect(trailBuffer.writes).toEqual([3 * 76, 12 * 76]);
  });

  it("段顶点按槽序每粒子 n 段（rea-p4d-rope.md 5.3）；g_RenderVar0 每帧按计时器写（没有 g_Time 也写）；particleProbe 给段与 maxVertices", async () => {
    const { gpu, state, scene } = await open(trailBundle([trailLayer(1)]));
    const draw = particleDraw(scene, 1);
    const system = draw.particles!.system;
    const renderer = system.def.renderer.ropetrail!;
    // 建 draw 时：计时器初值 0
    expect(floats(draw.uniformBuffer, 160, 4)).toEqual(trailRenderVar0(renderer, 0));
    const seen: number[] = [];
    for (let i = 0; i < 4; i++) {
      const writes = draw.uniformBuffer.writes.length;
      stepFrame(scene, frame(0.1), state);
      expect(draw.uniformBuffer.writes.length).toBe(writes + 1);
      expect(floats(draw.uniformBuffer, 160, 4)).toEqual(trailRenderVar0(renderer, system.trail!.timer));
      seen.push(floats(draw.uniformBuffer, 160, 4)[2]);
    }
    // 间隔 0.15、dt 0.1：出生帧采样（z 0），下一帧剩 0.05（z 2/3），再下一帧采样（z 0）
    expect(seen[0]).toBe(0);
    expect(seen[1]).toBeCloseTo(2 / 3, 6);
    expect(seen[2]).toBe(0);
    gpu.encode(scene, state);
    // 槽 0 的段 1：起点 h[0]、终点 h[1]，CP0 是当前位置，w：尺寸 20、C·K、k
    const trail = system.trail!;
    const h = (slot: number, j: number) =>
      Array.from(trail.positions.subarray((slot * 3 + j) * 3, (slot * 3 + j) * 3 + 3));
    const pos = [0, 1, 2].map((axis) => system.columns.position[axis][0]);
    expect(floats(draw.vertexBuffer, 76, 4)).toEqual([...h(0, 0), 20]);
    expect(floats(draw.vertexBuffer, 76 + 16, 4)).toEqual([...h(0, 1), trail.counts[0]]);
    expect(floats(draw.vertexBuffer, 76 + 32, 4)).toEqual([...pos, 1]);
    expect(floats(draw.vertexBuffer, 76 + 48, 3)).toEqual(h(0, 2));
    expect(floats(draw.vertexBuffer, 76 + 60, 4)).toEqual([1, 1, 1, 1]);
    const probe = scene.particleProbe(1)!;
    expect([probe.count, probe.rope, probe.vertices.length]).toEqual([12, { maxVertices: 6 }, 12 * 19]);
  });
});

describe("GpuScene：指针的跟随点（P4c 步骤 2）", () => {
  const pointerLayer = (extra: JsonObject = {}) =>
    particleLayer(
      1,
      {
        emitter: [{ name: "sphererandom", origin: "0 0 0", distancemax: 0, rate: 10 }],
        controlpoint: [{ flags: 1, offset: "100 50 0" }],
        ...extra,
      },
      { origin: [960, 540, 0] },
    );
  const positions = (system: ParticleSystem, from: number) =>
    Array.from({ length: system.highWater - from }, (_, i) =>
      [0, 1].map((axis) => system.columns.position[axis][from + i]),
    );

  it("stepParticles 每帧按本帧的 cursor 反投影（不是上一帧的），本帧出生的粒子在本帧光标下的场景点；已出生的不动", async () => {
    const { state, scene } = await open(bundleOf([pointerLayer()]));
    const system = particleDraw(scene, 1).particles!.system;
    const born = (cursor: [number, number]) => {
      const from = system.highWater;
      stepFrame(scene, { ...frame(0.1), cursor }, state);
      expect(system.highWater).toBeGreaterThan(from);
      return positions(system, from);
    };
    // (0.25, 0.75) → 场景 (480, 270)；本地再减对象原点 (960, 540)
    for (const [x, y] of born([0.25, 0.75])) {
      expect(x).toBeCloseTo(480 - 960, 3);
      expect(y).toBeCloseTo(270 - 540, 3);
    }
    for (const [x, y] of born([0.75, 0.25])) {
      expect(x).toBeCloseTo(1440 - 960, 3);
      expect(y).toBeCloseTo(810 - 540, 3);
    }
    expect(system.columns.position[0][0]).toBeCloseTo(480 - 960, 3);
    // dev 回放（不给 state 时也一样）：replayParticles 的 cursor 交给每一帧
    const from = system.highWater;
    replayParticles(scene, state, { dts: [0.1, 0.1, 0.1] }, 0, [0.5, 0]);
    for (const [x, y] of positions(system, from)) {
      expect(x).toBeCloseTo(0, 3);
      expect(y).toBeCloseTo(1080 - 540, 3);
    }
    scene.destroy();
  });

  it("build 的 particles.cursor 给加载时的预热；缺省是场景中心", async () => {
    const warm = pointerLayer({ starttime: 0.5 });
    const { scene } = await open(bundleOf([warm]), { seed: 1, cursor: [0.1, 0.9] });
    const system = particleDraw(scene, 1).particles!.system;
    expect(system.highWater).toBeGreaterThan(0);
    for (const [x, y] of positions(system, 0)) {
      expect(x).toBeCloseTo(192 - 960, 3);
      expect(y).toBeCloseTo(108 - 540, 3);
    }
    scene.destroy();
    const center = await open(bundleOf([warm]));
    for (const [x, y] of positions(particleDraw(center.scene, 1).particles!.system, 0)) {
      expect(x).toBeCloseTo(0, 3);
      expect(y).toBeCloseTo(0, 3);
    }
    center.scene.destroy();
  });

  it("单图层重建（effect 切换走的 sync → rebuildLayer）新建的粒子系统，预热用最近一次 stepParticles 的 cursor，不是加载时的", async () => {
    // 粒子层编译期没有 effect、`planParticleLayer` 也不看 effect，计划签名不变，现在的产品路径里粒子层不会单独重建；这里把签名
    // 置旧、把图层标成结构脏，强制走 sync → rebuildStructures → rebuildLayer → createParticles，守住 `particleCursor` 的取值
    const warm = pointerLayer({ starttime: 0.5 });
    const { state, scene } = await open(bundleOf([warm]), { seed: 1, cursor: [0.1, 0.9] });
    const loaded = particleDraw(scene, 1).particles!.system;
    // 加载时的预热在 (192, 108)
    expect(positions(loaded, 0)[0][0]).toBeCloseTo(192 - 960, 3);
    // 之后一帧的光标在 (0.75, 0.25)，场景 (1440, 810)
    stepFrame(scene, { ...frame(0.1), cursor: [0.75, 0.25] }, state);
    const runtime = (scene as unknown as { layers: { object: number; signature: string }[] }).layers.find(
      (layer) => layer.object === 1,
    )!;
    runtime.signature = "stale";
    (state as unknown as { dirtyStructures: Set<number> }).dirtyStructures.add(1);
    scene.sync(state);
    const rebuilt = particleDraw(scene, 1).particles!.system;
    expect(rebuilt).not.toBe(loaded);
    expect(rebuilt.highWater).toBeGreaterThan(0);
    for (const [x, y] of positions(rebuilt, 0)) {
      expect(x).toBeCloseTo(1440 - 960, 3);
      expect(y).toBeCloseTo(810 - 540, 3);
    }
    scene.destroy();
  });
});

describe("渲染器：帧时钟与遍数", () => {
  async function start(
    maxFps: number | undefined,
    bundle = bundleOf([imageLayer(0), particleLayer(1)]),
    beforeLoad?: (renderer: SceneRenderer) => void,
    /** 渲染器每个实时帧的 `beforeFrame`（脚本的位置）里额外做的事（P4c 步骤 4 的帧顺序用例）。 */
    onFrame?: (renderer: SceneRenderer, dt: number) => void,
  ) {
    const frames: FrameRequestCallback[] = [];
    const gpu = new FakeGpu();
    vi.mocked(acquireGpu).mockResolvedValue({
      device: gpu.device,
      features: new Set(),
      info: { vendor: "", architecture: "", description: "", features: [] },
    } as unknown as Awaited<ReturnType<typeof acquireGpu>>);
    vi.stubGlobal("document", { hidden: false, addEventListener() {}, removeEventListener() {} });
    vi.stubGlobal("window", { devicePixelRatio: 1 });
    vi.stubGlobal("navigator", { gpu: { getPreferredCanvasFormat: () => "bgra8unorm" } });
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback));
    vi.stubGlobal("cancelAnimationFrame", () => {});
    const context = {
      configure() {},
      unconfigure() {},
      getCurrentTexture: () => ({ createView: () => ({ label: "canvas" }) }),
    };
    const canvas = {
      width: 100,
      height: 100,
      getContext: () => context,
      getBoundingClientRect: () => ({ width: 100, height: 100 }),
    } as unknown as HTMLCanvasElement;
    const dts: number[] = [];
    const renderer: SceneRenderer = await SceneRenderer.create(canvas, {
      maxFps,
      beforeFrame: (dt) => {
        dts.push(dt);
        onFrame?.(renderer, dt);
      },
    });
    beforeLoad?.(renderer);
    await renderer.load(bundle);
    return { renderer, frames, gpu, dts };
  }

  it("rope 读的 fps 就是 maxFps（缺省 60，P4d 步骤 1，rea-p4d-rope.md 1.2）", async () => {
    const fps = async (maxFps: number | undefined) => {
      const { renderer } = await start(maxFps);
      const value = (renderer.currentScene as unknown as { particleFps: number }).particleFps;
      renderer.destroy();
      return value;
    };
    expect(await fps(10)).toBe(10);
    expect(await fps(undefined)).toBe(60);
    expect(await fps(144)).toBe(144);
  });

  it("maxFps 1–20 两遍，其余（缺省 60、不限）一遍", async () => {
    const passes = async (maxFps: number | undefined) => {
      const { renderer } = await start(maxFps);
      const value = particleDraw(renderer.currentScene!, 1).particles!.system.passes;
      renderer.destroy();
      return value;
    };
    expect(await passes(20)).toBe(2);
    expect(await passes(1)).toBe(2);
    expect(await passes(21)).toBe(1);
    expect(await passes(undefined)).toBe(1);
    expect(await passes(0)).toBe(1);
  });

  it("cursor（P4c 步骤 2）：没收到指针时是场景中心；setPointer 只记原始坐标，每帧按当前样式现算，改样式不经 setPointer 也变", async () => {
    let now = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const { renderer, frames } = await start(0);
    const update = vi.spyOn(renderer.currentScene!, "update");
    const step = vi.spyOn(renderer.currentScene!, "stepParticles");
    const next = () => {
      now += 20;
      frames.at(-1)!(now);
      const input = update.mock.lastCall![0];
      // 真正用它的是 stepParticles（P4c 步骤 4 起粒子在 update 之前步进）：同一帧交过去的是同一个值
      expect(step.mock.lastCall![3]).toEqual(input.cursor);
      return input;
    };
    expect(next().cursor).toEqual([0.5, 0.5]);
    // 画布 100×100、场景 1920×1080：fill 裁左右，画布最左边对着场景 u = (1 − 0.5625) / 2
    const expected = (style: "fill" | "fit" | "stretch" | "center" | "tile", x: number, y: number) =>
      sceneCursor(style, scenePlacement(style, 1920, 1080, 100, 100), 100, 100, x, y);
    renderer.setPointer(0, 0.1);
    const fill = next();
    expect(fill.pointer).toEqual([0, 0.1]);
    expect(fill.cursor).toEqual(expected("fill", 0, 0.1));
    expect(fill.cursor[0]).toBeCloseTo(0.21875, 12);
    // 改样式：不再收到指针，下一帧的 cursor 照新样式算
    renderer.setStyle("stretch");
    expect(next().cursor).toEqual([0, 0.1]);
    renderer.setStyle("fit");
    const fit = next().cursor;
    expect(fit).toEqual(expected("fit", 0, 0.1));
    expect(fit[1]).toBeLessThan(0);
    renderer.setStyle("tile");
    expect(next().cursor).toEqual(expected("tile", 0, 0.1));
    renderer.destroy();
  });

  it("加载时的控制点更新与预热用加载时刻的 cursor（P4c 步骤 2）：预热里出生的粒子在光标下的场景点", async () => {
    const build = vi.spyOn(GpuScene, "build");
    const json = {
      starttime: 0.5,
      controlpoint: [{ flags: 1, offset: "9 9 0" }],
    };
    const bundle = bundleOf([particleLayer(1, json, { origin: [960, 540, 0] })]);
    const { renderer } = await start(0, bundle, (r) => r.setPointer(0.25, 0.25));
    const cursor = sceneCursor("fill", scenePlacement("fill", 1920, 1080, 100, 100), 100, 100, 0.25, 0.25);
    expect(build.mock.lastCall![5]!.particles!.cursor).toEqual(cursor);
    const follow = pointerScenePoint(sceneViewProjection(GENERAL_1080), cursor);
    const system = particleDraw(renderer.currentScene!, 1).particles!.system;
    expect(system.alive).toBeGreaterThan(0);
    // 本地系统：inverse(W)·F + 发射器 origin (100, 200)
    for (let slot = 0; slot < system.highWater; slot++) {
      expect(system.columns.position[0][slot]).toBeCloseTo(follow[0] - 960 + 100, 3);
      expect(system.columns.position[1][slot]).toBeCloseTo(follow[1] - 540 + 200, 3);
    }
    renderer.destroy();
  });

  it("帧顺序（P4c 步骤 4）：sync → stepParticles → 脚本（beforeFrame）→ sync → update → encode；补画帧不跑脚本、照样先步进（帧时间 0 不动）", async () => {
    let now = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const script = vi.fn();
    const { renderer, frames } = await start(0, undefined, undefined, script);
    const scene = renderer.currentScene!;
    const spies = {
      sync: vi.spyOn(scene, "sync"),
      stepParticles: vi.spyOn(scene, "stepParticles"),
      update: vi.spyOn(scene, "update"),
      encode: vi.spyOn(scene, "encode"),
      script,
    };
    const order = () => {
      const calls = Object.entries(spies).flatMap(([name, spy]) =>
        spy.mock.invocationCallOrder.map((index) => [index, name] as const),
      );
      for (const spy of Object.values(spies)) spy.mockClear();
      return calls.sort((a, b) => a[0] - b[0]).map(([, name]) => name);
    };
    order();
    now += 20;
    frames.at(-1)!(now);
    expect(order()).toEqual(["sync", "stepParticles", "script", "sync", "update", "encode"]);
    renderer.setPaused(true);
    renderer.redraw();
    // 补画帧的帧时间是 0：stepParticles 只记下 cursor
    expect(spies.stepParticles.mock.lastCall![0]).toBe(0);
    expect(order()).toEqual(["sync", "stepParticles", "sync", "update", "encode"]);
    renderer.destroy();
  });

  it("帧顺序（P4c 步骤 4）：脚本在 beforeFrame 里改对象变换，这一帧模拟用的是改之前的 W，下一帧才用新的；已发出的世界空间粒子留在原地", async () => {
    let now = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    // 世界空间系统、出生距离 0、发射器 origin 0：出生点就是对象世界矩阵的平移（W·base.t + origin）
    const layer = particleLayer(
      1,
      { flags: 1, emitter: [{ name: "sphererandom", origin: "0 0 0", distancemax: 0, rate: 10 }] },
      { origin: [100, 200, 0] },
    );
    let move: string | null = null;
    const { renderer, frames } = await start(0, bundleOf([layer]), undefined, (r) => {
      if (move) r.sceneState!.write({ property: "p", target: { kind: "layer", object: 1, field: "origin" } }, move);
      move = null;
    });
    const system = particleDraw(renderer.currentScene!, 1).particles!.system;
    const at = (slot: number) => [0, 1, 2].map((axis) => system.columns.position[axis][slot]);
    const expectAt = (slot: number, expected: number[]) =>
      at(slot).forEach((value, axis) => expect(value, `槽 ${slot} 第 ${axis} 轴`).toBeCloseTo(expected[axis], 4));
    expect(system.highWater).toBe(0);
    // 第 1 帧（0.2 s、每秒 10 个 → 2 个）：脚本把对象挪到 (500, 600)，这一帧出生的仍在 (100, 200)
    move = "500 600 0";
    now += 200;
    frames.at(-1)!(now);
    expect(system.highWater).toBe(2);
    expectAt(0, [100, 200, 0]);
    expectAt(1, [100, 200, 0]);
    // 第 2 帧：用上一帧脚本写完的变换
    now += 200;
    frames.at(-1)!(now);
    expect(system.highWater).toBe(4);
    expectAt(2, [500, 600, 0]);
    expectAt(3, [500, 600, 0]);
    // 已发出的留在原地；绘制时模型矩阵是单位阵（MVP 就是视图投影），所以画面上也不随对象动
    expectAt(0, [100, 200, 0]);
    expect(floats(particleDraw(renderer.currentScene!, 1).uniformBuffer, 0, 16)).toEqual(
      Array.from(sceneViewProjection(GENERAL_1080)),
    );
    renderer.destroy();
  });

  it("帧顺序（P4c 步骤 4）：两帧之间写进状态的 instanceoverride 这一帧就进模拟器（步进之前先 sync）", async () => {
    let now = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const { renderer, frames } = await start(0, bundleOf([particleLayer(1)]));
    const system = particleDraw(renderer.currentScene!, 1).particles!.system;
    now += 200;
    frames.at(-1)!(now);
    expect(system.alive).toBe(2);
    // 帧间（宿主的属性面板、编辑器）写进状态：这一帧就按 count 2 发射（每秒 20 个 × 0.2 s）
    renderer.sceneState!.write(
      { property: "count", target: { kind: "particle-instance", object: 1, field: "count" } },
      2,
    );
    now += 200;
    frames.at(-1)!(now);
    expect(system.instanceValues.count).toBe(2);
    expect(system.alive).toBe(6);
    renderer.destroy();
  });

  it("g_Time 累加钳后的帧时间；脚本与粒子拿同一个值；暂停补画时间不动、粒子不步进", async () => {
    let now = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const { renderer, frames, dts } = await start(0);
    const scene = renderer.currentScene!;
    const update = vi.spyOn(scene, "update");
    const system = particleDraw(scene, 1).particles!.system;
    // load 画的第一帧：没有上一帧，钳成 0.0001
    expect(dts).toEqual([0.0001]);
    expect(renderer.runtimeSeconds).toBe(0.0001);

    now += 200; // 0.2 s → 2 个粒子
    frames.at(-1)!(now);
    now += 2000; // 卡 2 秒 → 只走 0.25
    frames.at(-1)!(now);
    expect(dts.slice(1).map((dt) => Math.round(dt * 1e9) / 1e9)).toEqual([0.2, 0.25]);
    const times = update.mock.calls.map(([input]) => input.time);
    expect(times[0]).toBeCloseTo(0.2001, 10);
    expect(times[1]).toBeCloseTo(0.4501, 10);
    expect(update.mock.calls.map(([input]) => input.frametime)).toEqual(dts.slice(1));
    expect(renderer.runtimeSeconds).toBeCloseTo(0.4501, 10);
    expect(renderer.frameSeconds).toBe(0.25);
    expect(system.alive).toBe(4); // 0.2 s 2 个，0.25 s 再 2 个（余 0.5 留到下次）

    renderer.setPaused(true);
    now += 1000;
    renderer.redraw();
    expect(update.mock.calls.at(-1)![0]).toMatchObject({ frametime: 0 });
    expect(update.mock.calls.at(-1)![0].time).toBeCloseTo(0.4501, 10);
    expect(dts).toHaveLength(3);
    expect(system.alive).toBe(4);
    renderer.destroy();
  });

  it("暂停：没有实时帧，粒子不步进；隐藏页面同样不步进；恢复后照常（P4a 步骤 5）", async () => {
    let now = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const { renderer, frames } = await start(0);
    const system = particleDraw(renderer.currentScene!, 1).particles!.system;
    // 帧时间上限 0.25 s：每次走 0.2 s
    now += 200;
    frames.at(-1)!(now);
    const alive = system.alive;
    expect(alive).toBe(2);
    renderer.setPaused(true);
    // 暂停后循环已停：残留的回调直接返回，补画帧时间为 0
    now += 500;
    frames.at(-1)!(now);
    renderer.redraw();
    expect(system.alive).toBe(alive);
    renderer.setPaused(false);
    now += 200;
    frames.at(-1)!(now);
    expect(system.alive).toBe(4);
    const resumed = system.alive;
    // 页面隐藏：shouldRun 为假，同样不步进
    (document as unknown as { hidden: boolean }).hidden = true;
    now += 500;
    frames.at(-1)!(now);
    expect(system.alive).toBe(resumed);
    renderer.destroy();
  });

  it("切换壁纸 / 重编译：旧场景的粒子缓冲随场景释放，新场景重新建系统并预热；销毁渲染器全部释放", async () => {
    const { renderer, gpu } = await start(0, bundleOf([particleLayer(1, { starttime: 1 })]));
    const particleBuffers = () => [...gpu.live].filter((buffer) => /particle/.test(buffer.label));
    const before = particleBuffers();
    // 顶点与 uniform 缓冲同名，外加全场一份索引缓冲
    expect(before.map((buffer) => buffer.label).sort()).toEqual([
      "layer 2 particles 1 particles",
      "layer 2 particles 1 particles",
      "particle indices",
    ]);
    const oldSystem = particleDraw(renderer.currentScene!, 1).particles!.system;
    expect(oldSystem.alive).toBe(10);
    // 重编译（同一份 bundle 重新加载）：粒子重来，含预热（决定 7）
    oldSystem.step(0.5);
    expect(oldSystem.alive).toBe(15);
    await renderer.load(bundleOf([particleLayer(1, { starttime: 1 })]));
    const newSystem = particleDraw(renderer.currentScene!, 1).particles!.system;
    expect(newSystem).not.toBe(oldSystem);
    expect(newSystem.alive).toBe(10);
    for (const buffer of before) expect(gpu.live.has(buffer), buffer.label).toBe(false);
    // 切到没有粒子的场景：粒子缓冲全部释放
    await renderer.load(bundleOf([imageLayer(0)]));
    expect(particleBuffers()).toEqual([]);
    await renderer.load(bundleOf([particleLayer(1)]));
    expect(particleBuffers()).toHaveLength(3);
    renderer.destroy();
    expect(particleBuffers()).toEqual([]);
  });
});

describe("GpuScene：粒子生命周期（P4a 步骤 5）", () => {
  const COUNT = { kind: "particle-instance", object: 1, field: "count" } as const;
  const VISIBLE = { kind: "layer", object: 1, field: "visible" } as const;

  it("instanceoverride 就地写：sync 交给模拟器，不重建缓冲、不清粒子，下一帧按新值发射（2026-11-07 实测，p4a-life）", async () => {
    const { gpu, state, scene } = await open(bundleOf([particleLayer(1)]));
    stepFrame(scene, frame(0.5), state); // 10/s → 5
    gpu.encode(scene, state);
    const system = particleDraw(scene, 1).particles!.system;
    const buffers = gpu.buffers.length;
    const born = Array.from(system.columns.size0.subarray(0, 5));
    expect(state.write({ property: "count", target: COUNT }, 2)).toBe("applied");
    state.write({ property: "size", target: { ...COUNT, field: "size" } }, 2);
    // 写进状态，sync 之前模拟器不变
    expect(system.instanceValues.count).toBe(1);
    scene.sync(state);
    expect(system.instanceValues).toMatchObject({ count: 2, size: 2 });
    expect(system.alive).toBe(5);
    stepFrame(scene, frame(0.5), state); // 20/s → +10
    expect(system.alive).toBe(15);
    expect(Array.from(system.columns.size0.subarray(0, 5))).toEqual(born);
    expect(system.columns.size0[5]).toBe(born[0] * 2);
    expect(gpu.buffers.length).toBe(buffers);
    expect(system.columns.capacity).toBe(16);
  });

  it("colorn 就地写（P4b 步骤 6）：sync 交给模拟器，存活粒子保留出生时的颜色，之后出生的按新值（没有颜色模块，0x200000）", async () => {
    const { gpu, state, scene } = await open(bundleOf([particleLayer(1)]));
    stepFrame(scene, frame(0.5), state); // 5 个白色
    gpu.encode(scene, state);
    const system = particleDraw(scene, 1).particles!.system;
    const buffers = gpu.buffers.length;
    const colorOf = (slot: number) => [0, 1, 2].map((i) => system.columns.color[i][slot]);
    expect(colorOf(0)).toEqual([1, 1, 1]);
    const COLORN = { ...COUNT, field: "colorn" } as const;
    expect(state.write({ property: "c", target: COLORN }, "0 1 0")).toBe("applied");
    expect(system.instanceValues.colorn).toBeNull();
    scene.sync(state);
    expect(system.instanceValues.colorn).toEqual([0, 1, 0]);
    stepFrame(scene, frame(0.5), state);
    expect(system.alive).toBe(10);
    expect(colorOf(4)).toEqual([1, 1, 1]);
    expect(colorOf(5)).toEqual([0, 1, 0]);
    // 改回未设：之后出生的又是白色
    state.write({ property: "c", target: COLORN }, "-1 -1 -1");
    scene.sync(state);
    stepFrame(scene, frame(0.1), state);
    expect(colorOf(10)).toEqual([1, 1, 1]);
    expect(gpu.buffers.length).toBe(buffers);
  });

  it("建模拟器时取状态里的当前值（单图层重建也用就地写过的值）", async () => {
    const bundle = bundleOf([particleLayer(1)]);
    const state = SceneState.fromBundle(bundle);
    state.write({ property: "count", target: COUNT }, 3);
    const scene = await GpuScene.build(new FakeGpu().device, bundle, state, new Set(), [], { particles: { seed: 1 } });
    expect(particleDraw(scene, 1).particles!.system.instanceValues.count).toBe(3);
    // 编译结果没被改
    expect(bundle.layers[0].particle!.instance.count).toBe(1);
  });

  it("不可见的帧要实时：暂停 / 补画（帧时间 0）时变不可见不清空，下一个实时帧才清", async () => {
    const { gpu, state, scene } = await open(bundleOf([particleLayer(1, {}, { visibleBound: true })]));
    stepFrame(scene, frame(0.5), state);
    gpu.encode(scene, state);
    const system = particleDraw(scene, 1).particles!.system;
    state.write({ property: "v", target: VISIBLE }, false);
    scene.sync(state);
    stepFrame(scene, frame(0), state);
    expect(system.alive).toBe(5);
    stepFrame(scene, frame(0.1), state);
    expect(system.alive).toBe(0);
  });

  it("不可见的帧把帧时间交给模拟器：系统时间复位后照常累加（P4d 收尾 A，st-hide 实测）", async () => {
    const { state, scene } = await open(bundleOf([particleLayer(1, {}, { visibleBound: true })]));
    stepFrame(scene, frame(0.5), state);
    const system = particleDraw(scene, 1).particles!.system;
    state.write({ property: "v", target: VISIBLE }, false);
    scene.sync(state);
    stepFrame(scene, frame(0.1), state);
    expect(system.alive).toBe(0);
    expect(system.systemTime).toBe(Math.fround(0.1));
    stepFrame(scene, frame(0.2), state);
    expect(system.systemTime).toBe(Math.fround(Math.fround(0.1) + Math.fround(0.2)));
    expect(system.layerTime).toBe(0);
  });

  it("清空后标 stale：暂停中重新可见（没有实时帧），画出来的是 0 个，不是清空前的顶点", async () => {
    const { gpu, state, scene } = await open(bundleOf([particleLayer(1, {}, { visibleBound: true })]));
    stepFrame(scene, frame(0.5), state);
    expect(draws(gpu.encode(scene, state)).at(-1)).toBe("drawIndexed 30");
    state.write({ property: "v", target: VISIBLE }, false);
    scene.sync(state);
    stepFrame(scene, frame(0.1), state);
    gpu.encode(scene, state);
    state.write({ property: "v", target: VISIBLE }, true);
    scene.sync(state);
    stepFrame(scene, frame(0), state);
    expect(draws(gpu.encode(scene, state))).toEqual([]);
  });

  it("祖先不可见（visible 沿父链）同样清空", async () => {
    const group = baseLayer(0, { name: "group", visibleBound: true });
    const { state, scene } = await open(bundleOf([group, particleLayer(1, {}, { parent: 0 })]));
    stepFrame(scene, frame(0.5), state);
    const system = particleDraw(scene, 1).particles!.system;
    expect(system.alive).toBe(5);
    state.write({ property: "v", target: { kind: "layer", object: 0, field: "visible" } }, false);
    scene.sync(state);
    stepFrame(scene, frame(0.5), state);
    expect(system.alive).toBe(0);
    state.write({ property: "v", target: { kind: "layer", object: 0, field: "visible" } }, true);
    scene.sync(state);
    stepFrame(scene, frame(0.5), state);
    expect(system.alive).toBe(5);
  });

  it("重新可见不重新预热（starttime 的系统，2026-11-07 实测，p4a-life）", async () => {
    const { state, scene } = await open(bundleOf([particleLayer(1, { starttime: 1 }, { visibleBound: true })]));
    const system = particleDraw(scene, 1).particles!.system;
    expect(system.alive).toBe(10);
    state.write({ property: "v", target: VISIBLE }, false);
    scene.sync(state);
    stepFrame(scene, frame(0.1), state);
    expect(system.alive).toBe(0);
    state.write({ property: "v", target: VISIBLE }, true);
    scene.sync(state);
    stepFrame(scene, frame(0.3), state);
    expect(system.alive).toBe(3);
  });

  it("dev 探针：particleStats(true) 给分布，profileParticles 记录模拟 / 写顶点 / 上传，关掉即清空", async () => {
    const { gpu, state, scene } = await open(bundleOf([particleLayer(1)]));
    expect(scene.particleProfile()).toEqual([]);
    scene.profileParticles(true);
    for (let i = 0; i < 3; i++) {
      stepFrame(scene, frame(0.2), state);
      gpu.encode(scene, state);
    }
    const [profile] = scene.particleProfile();
    expect(profile).toMatchObject({ object: 1, name: "particles 1", capacity: 16, frames: 3 });
    expect(profile.alive).toEqual({ mean: 4, p95: 6, max: 6 });
    for (const key of ["simulateMs", "verticesMs", "uploadMs"] as const) {
      expect(profile[key].max).toBeGreaterThanOrEqual(0);
      expect(profile[key].mean).toBeLessThanOrEqual(profile[key].max);
    }
    const [stats] = scene.particleStats(true);
    expect(stats.summary).toMatchObject({
      alive: 6,
      position: { min: [100, 200, 0], max: [100, 200, 0] },
      size: { min: 20, max: 20, mean: 20, p50: 20 },
      alpha: { min: 1, max: 1, mean: 1 },
    });
    expect(scene.particleStats()[0].summary).toBeUndefined();
    scene.profileParticles(false);
    expect(scene.particleProfile()).toEqual([]);
  });

  it("timingStats：均值、p95、最大值保留两位小数；没有样本时为 0", () => {
    expect(timingStats([])).toEqual({ mean: 0, p95: 0, max: 0 });
    expect(timingStats([3, 1, 2])).toEqual({ mean: 2, p95: 3, max: 3 });
    const many = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(timingStats(many)).toEqual({ mean: 50.5, p95: 96, max: 100 });
    expect(timingStats([1 / 3])).toEqual({ mean: 0.33, p95: 0.33, max: 0.33 });
  });
});

describe("GpuScene：static 子系统（P4e 步骤 1，rea-p4e-children 第 6 节）", () => {
  /** 粒子层 1（对象原点 (10, 0)）挂一个 static 子系统：条目 `origin "200 0 0"`，`childJson` 覆盖子系统的键。 */
  function treeLayer(childJson: JsonObject = {}): SceneLayer {
    const layer = particleLayer(1, {}, { origin: [10, 0, 0] });
    const child = parseParticle(
      {
        maxcount: 8,
        emitter: [{ name: "sphererandom", distancemax: 0, rate: 10 }],
        initializer: [{ name: "lifetimerandom", min: 100, max: 100 }],
        ...childJson,
      },
      { file: "particles/c.json", orthographic: true },
    );
    child.passes = [pass("objects/1/particle/children/0/passes/0", P.particle, { textures: { 0: 1 } })];
    layer.particle!.children.push({
      index: 0,
      type: "static",
      flags: 0,
      controlPointStartIndex: 0,
      probability: 1,
      maxcount: 10,
      local: childLocalMatrix([200, 0, 0], [0, 0, 0], [1, 1, 1]),
      system: child,
    });
    return layer;
  }
  const treeDraws = (scene: GpuScene) =>
    [...internals(scene).draws].filter((draw) => draw.object === 1 && draw.particles) as (DrawView & {
      step: { node: number[] };
    })[];

  it("一个粒子层按先序画两次：各自的顶点缓冲、标签带路径；子系统取根系统树里的节点；只步进根，两次绘制都重写", async () => {
    const { gpu, state, scene } = await open(bundleOf([treeLayer()]));
    const [root, child] = treeDraws(scene);
    expect([root.label, child.label]).toEqual(["layer 2 particles 1 particles", "layer 2 particles 1 particles 0"]);
    expect(child.step.node).toEqual([0]);
    expect(child.particles!.system).toBe(root.particles!.system.statics[0].system);
    // 子系统的顶点缓冲按它自己的 maxcount
    expect(gpu.buffer("layer 2 particles 1 particles 0").size).toBe(8 * 4 * 52);
    stepFrame(scene, frame(0.5), state);
    expect(draws(gpu.encode(scene, state))).toEqual([
      "vertex layer 2 particles 1 particles",
      "index particle indices uint16",
      "drawIndexed 30",
      "vertex layer 2 particles 1 particles 0",
      "index particle indices uint16",
      "drawIndexed 30",
    ]);
    // 子系统的 MVP = 视图投影 · W · L
    expect(floats(child.uniformBuffer, 0, 16)).toEqual(
      Array.from(multiply(sceneViewProjection(GENERAL_1080), translation(210, 0, 0))),
    );
    expect(floats(root.uniformBuffer, 0, 16)).toEqual(
      Array.from(multiply(sceneViewProjection(GENERAL_1080), translation(10, 0, 0))),
    );
    expect(scene.particleStats().map((stats) => [stats.node, stats.alive])).toEqual([
      [undefined, 5],
      [[0], 5],
    ]);
    expect(scene.particleProbe(1, [0])?.system).toBe(child.particles!.system);
    // 世界子系统：模型矩阵是单位阵
    const world = await open(bundleOf([treeLayer({ flags: 1 })]));
    expect(floats(treeDraws(world.scene)[1].uniformBuffer, 0, 16)).toEqual(
      Array.from(sceneViewProjection(GENERAL_1080)),
    );
  });

  it("不可见：顶层有存活粒子时子系统一起清空，之后不发射；两次绘制都写成 0 个、不画", async () => {
    const { gpu, state, scene } = await open(bundleOf([treeLayer()]));
    stepFrame(scene, frame(0.5), state);
    gpu.encode(scene, state);
    state.write({ property: "v", target: { kind: "layer", object: 1, field: "visible" } }, false);
    scene.sync(state);
    stepFrame(scene, frame(0.5), state);
    const [root, child] = treeDraws(scene);
    expect([root.particles!.system.alive, child.particles!.system.alive]).toEqual([0, 0]);
    state.write({ property: "v", target: { kind: "layer", object: 1, field: "visible" } }, true);
    scene.sync(state);
    expect(draws(gpu.encode(scene, state))).toEqual([]);
  });

  it("instanceoverride 改值只交给根，由它递归到子系统（count 2 → 子系统每秒 20 个）", async () => {
    const { state, scene } = await open(bundleOf([treeLayer({ maxcount: 32 })]));
    state.write({ property: "c", target: { kind: "particle-instance", object: 1, field: "count" } }, 2);
    scene.sync(state);
    stepFrame(scene, frame(0.5), state);
    const [root, child] = treeDraws(scene);
    expect([root.particles!.system.alive, child.particles!.system.alive]).toEqual([10, 10]);
  });

  it("uploadableTextures 与 SceneState 的材质常量含子系统的 pass", () => {
    const layer = treeLayer();
    layer.particle!.children[0].system.passes[0] = pass("objects/1/particle/children/0/passes/0", P.particle, {
      textures: { 0: 0 },
      uniforms: { g_Overbright: [3] },
    });
    const bundle = bundleOf([layer]);
    expect([...uploadableTextures(bundle)].sort()).toEqual([0, 1]);
    expect(SceneState.fromBundle(bundle).constants.get("objects/1/particle/children/0/passes/0")).toEqual({
      g_Overbright: [3],
    });
  });
});
