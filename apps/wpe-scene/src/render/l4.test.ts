/**
 * 活的场景图 L4（`.claude/plans/wpe-import/3-scene/live/phase-l4-gpu-objects.md`「验收 → 假设备单测」）：`GpuScene` 按对象装卸。
 * - 整场 `build` 与「空场景逐个 `prepareObject` + `installObject`」建出的东西相同：每个 draw 的对象、pass 键、管线键、顶点 / uniform 字节，
 *   每层的 op 种类序列、合成 RT 数、fbo 池键，fbo 池的引用，编码轨迹，粒子的种子（步进后的存活数与位置）；
 * - 同一对象 `removeObject` 再装回，draw 相同、池化 fbo 的引用回到原值；
 * - 建删 100 次之后 `owned`、`targets`、fbo 池、投射者、粒子序号等全部回到基线；
 * - 粒子索引缓冲：先装小 `maxcount` 再装大的，缓冲重建、旧 draw 编码时用新缓冲；
 * - `prepareObjectSync`：管线就绪时不建新管线；缺管线时同步建；缺程序时返回 null、什么都不建；
 * - `installObject` 中途失败（`createTarget` 抛）回滚：运行时、索引、draw 都不含它，fbo 引用不涨。
 * 搭法同 `p6d3.test.ts` / `rebuild.test.ts`。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generalDefaults } from "../compile/bindings";
import type {
  SceneBundle,
  SceneEffect,
  SceneEffectStep,
  SceneFbo,
  SceneLayer,
  SceneMesh,
  ScenePass,
  SceneTexture,
} from "../compile/bundle";
import type { JsonObject } from "../compile/model";
import { mdlStride } from "../compile/mdl";
import { parseParticle, particleFov } from "../compile/particles";
import { BLOOM_DEFAULTS } from "../compile/postprocess";
import type { ParticleSystem } from "../particles/system";
import type { TranslateResult } from "../wpesl2wgsl";
import { SceneRenderError } from "./errors";
import { buildableLayers, GpuScene, pipelineKey, type PipelineSpec, type PreparedObject } from "./scene";
import { SceneState } from "./state";
import type { FrameInput } from "./uniforms";

vi.mock("../fileUrl", () => ({ fileToUrl: (path: string) => path }));

// ———— 假设备 ————

interface FakeTexture {
  label: string;
  destroyed: boolean;
  createView(): { label: string };
  destroy(): void;
}
interface FakeBuffer {
  label: string;
  usage: number;
  bytes: Uint8Array;
  destroyed: boolean;
  destroy(): void;
}

class FakeGpu {
  readonly counts = { pipelinesAsync: 0, pipelinesSync: 0, modules: 0 };
  readonly buffers: FakeBuffer[] = [];
  readonly textures: FakeTexture[] = [];
  /** 编码轨迹：`pipeline <label>`、`vertex <label>`、`index <label>`。 */
  readonly trace: string[] = [];
  /** 每次 `setIndexBuffer` 的缓冲对象（核对编码时用的是哪一个）。 */
  readonly indexBuffers: FakeBuffer[] = [];
  readonly device: GPUDevice;

  constructor() {
    const pass = () => ({
      setViewport() {},
      setPipeline: (pipeline: { label: string }) => this.trace.push(`pipeline ${pipeline.label}`),
      setBindGroup() {},
      setVertexBuffer: (_slot: number, buffer: FakeBuffer) => this.trace.push(`vertex ${buffer.label}`),
      setIndexBuffer: (buffer: FakeBuffer) => {
        this.indexBuffers.push(buffer);
        this.trace.push(`index ${buffer.label}`);
      },
      draw() {},
      drawIndexed() {},
      end() {},
    });
    const pipeline = (descriptor: GPURenderPipelineDescriptor) => ({
      label: `${descriptor.label} ${[...(descriptor.fragment?.targets ?? [])][0]?.writeMask ?? "-"}`,
      getBindGroupLayout: () => ({}),
    });
    this.device = {
      limits: { maxTextureDimension2D: 8192 },
      lost: new Promise(() => {}),
      destroy() {},
      createTexture: (descriptor: GPUTextureDescriptor) => {
        const texture: FakeTexture = {
          label: descriptor.label ?? "",
          destroyed: false,
          createView: () => ({ label: descriptor.label ?? "" }),
          destroy() {
            texture.destroyed = true;
          },
        };
        this.textures.push(texture);
        return texture;
      },
      createSampler: () => ({}),
      createBuffer: (descriptor: GPUBufferDescriptor) => {
        const buffer: FakeBuffer = {
          label: descriptor.label ?? "",
          usage: descriptor.usage,
          bytes: new Uint8Array(descriptor.size),
          destroyed: false,
          destroy() {
            buffer.destroyed = true;
          },
        };
        this.buffers.push(buffer);
        return buffer;
      },
      createShaderModule: () => {
        this.counts.modules++;
        return { getCompilationInfo: async () => ({ messages: [] }) };
      },
      createBindGroupLayout: () => ({}),
      createPipelineLayout: () => ({}),
      createRenderPipeline: (descriptor: GPURenderPipelineDescriptor) => {
        this.counts.pipelinesSync++;
        return pipeline(descriptor);
      },
      createRenderPipelineAsync: async (descriptor: GPURenderPipelineDescriptor) => {
        this.counts.pipelinesAsync++;
        return pipeline(descriptor);
      },
      createBindGroup: () => ({}),
      createCommandEncoder: () => ({
        beginRenderPass: () => pass(),
        copyTextureToTexture() {},
        copyTextureToBuffer() {},
        finish: () => ({}),
      }),
      queue: {
        writeBuffer: (buffer: FakeBuffer, offset: number, data: ArrayBufferLike, dataOffset = 0, size?: number) => {
          const bytes = new Uint8Array(data, dataOffset, size ?? data.byteLength - dataOffset);
          buffer.bytes.set(bytes, offset);
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
  vi.stubGlobal("GPUTextureUsage", { RENDER_ATTACHMENT: 1, TEXTURE_BINDING: 2, COPY_SRC: 4, COPY_DST: 8 });
  vi.stubGlobal("GPUBufferUsage", { VERTEX: 1, UNIFORM: 2, COPY_DST: 4, MAP_READ: 8, INDEX: 16, STORAGE: 32 });
  vi.stubGlobal("GPUMapMode", { READ: 1 });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ———— 夹具 ————

function program(name: string, slots: number[] = [0, 1]): TranslateResult {
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
      { name: "g_Time", type: "f32", declared: "float", offset: 64, size: 4 },
      { name: "g_Alpha", type: "f32", declared: "float", offset: 68, size: 4 },
      { name: "g_Color4", type: "vec4<f32>", declared: "vec4", offset: 80, size: 16 },
      { name: "g_Tint", type: "vec3<f32>", declared: "vec3", offset: 96, size: 12, meta: { material: "tint" } },
      { name: "g_Texture0Resolution", type: "vec4<f32>", declared: "vec4", offset: 112, size: 16 },
    ],
    uniformBlockSize: 128,
    textures: slots.map((slot) => ({ slot, binding: 1 + 2 * slot, samplerBinding: 2 + 2 * slot, kind: "2d" })),
  } as unknown as TranslateResult;
}

/** 翻译后 `genericparticle` 的反射（同 `particles.test.ts`）。 */
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

/** 网格程序（同 `p5c-mesh.test.ts` 的 plain）：属性 a_Position、a_TexCoord，uniform 有材质常量 g_Tint。 */
const MESH_PROGRAM = {
  ok: true,
  vertex: { wgsl: "// mesh v", entryPoint: "main" },
  fragment: { wgsl: "// mesh f", entryPoint: "main" },
  attributes: [
    { name: "a_Position", type: "vec3", location: 0 },
    { name: "a_TexCoord", type: "vec2", location: 1 },
  ],
  uniforms: [
    { name: "g_ModelViewProjectionMatrix", type: "mat4x4<f32>", declared: "mat4", offset: 0, size: 64 },
    { name: "g_Color4", type: "vec4<f32>", declared: "vec4", offset: 64, size: 16 },
    { name: "g_Tint", type: "vec3<f32>", declared: "vec3", offset: 80, size: 12, meta: { material: "tint" } },
  ],
  uniformBlockSize: 96,
  textures: [],
} as unknown as TranslateResult;

/** 程序下标：基础、两个 effect、passthrough、粒子、网格；`alt` 加载时没人用（`prepareObjectSync` 缺程序的用例）。 */
const P = { base: 0, a: 1, b: 2, passthrough: 3, particle: 4, mesh: 5, alt: 6 };
const programs = (): TranslateResult[] => [
  program("base"),
  program("a"),
  program("b"),
  program("passthrough"),
  PARTICLE_PROGRAM,
  MESH_PROGRAM,
  program("alt"),
];

function pass(key: string, index: number, extra: Partial<ScenePass> = {}): ScenePass {
  return {
    key,
    program: index,
    blending: "translucent",
    cullmode: "nocull",
    depthtest: "disabled",
    depthwrite: "disabled",
    textures: {},
    runtime: {},
    uniforms: { g_Tint: [1, 1, 1] },
    framebuffer: false,
    ...extra,
  };
}

const draw = (
  scenePass: ScenePass,
  extra: Partial<Extract<SceneEffectStep, { kind: "draw" }>> = {},
): SceneEffectStep => ({ kind: "draw", pass: scenePass, target: null, compose: false, binds: null, ...extra });

const fbo = (name: string, extra: Partial<SceneFbo> = {}): SceneFbo => ({
  name,
  format: "rgba8888",
  scale: 2,
  unique: false,
  repeat: false,
  ...extra,
});

/** 一个带 fbo 的 effect：先画进 `blur`，再读它上屏（或画进下一个合成 RT）。 */
function blurEffect(object: number, source: number, extra: Partial<SceneEffect> = {}): SceneEffect {
  const key = `objects/${object}/effects/${source}/passes`;
  return {
    source,
    id: 100 + source,
    name: `effect ${source}`,
    file: `effects/${source}/effect.json`,
    fbos: [fbo("blur")],
    steps: [draw(pass(`${key}/0`, P.a), { target: "blur" }), draw(pass(`${key}/1`, P.b, { runtime: { 1: "blur" } }))],
    enabled: true,
    visibleBound: true,
    unsupported: [],
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
/** 0：图像 128×64，1：`util/white`，2：图像 96×48（新尺寸的合成 RT）。 */
const TEXTURES = () => [
  texture("image", 128, 64),
  texture("materials/util/white.tex", 32, 32),
  texture("image96", 96, 48),
];

function baseLayer(object: number, extra: Partial<SceneLayer> = {}): SceneLayer {
  return {
    id: object + 1,
    object,
    parent: null,
    name: `layer ${object}`,
    origin: [10 + object, 20, 0],
    scale: [1, 1, 1],
    angles: [0, 0, 0],
    size: [128, 64],
    alpha: 0.5,
    color: [0.2, 0.4, 0.6],
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
    ...extra,
  };
}

function imageLayer(object: number, extra: Partial<SceneLayer> = {}, base: Partial<ScenePass> = {}): SceneLayer {
  return baseLayer(object, {
    passes: [pass(`objects/${object}/passes/0`, P.base, { textures: { 0: 0 }, ...base })],
    ...extra,
  });
}

/** 被依赖的图像层（同 `p8.test.ts` 的 depLayer）：合成 RT 0 是它的独占 RT，passthrough 上屏。 */
function dependedLayer(object: number): SceneLayer {
  return imageLayer(object, {
    dependedOn: true,
    passthrough: pass(`objects/${object}/passthrough`, P.passthrough, {
      blending: "normal",
      uniforms: { g_Color4: [1, 1, 1, 1] },
    }),
  });
}

/** 粒子层：发射器不动、每秒 10 个、寿命 100 秒（同 `particles.test.ts`）；`json` 覆盖系统级键。 */
function particleLayer(object: number, json: JsonObject = {}): SceneLayer {
  const particle = parseParticle(
    {
      maxcount: 16,
      emitter: [{ name: "sphererandom", origin: "100 200 0", distancemax: 30, rate: 10 }],
      initializer: [
        { name: "lifetimerandom", min: 100, max: 100 },
        { name: "sizerandom", min: 20, max: 40 },
        { name: "velocityrandom", min: "-20 -20 0", max: "20 20 0" },
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
  return baseLayer(object, { name: `particles ${object}`, size: [], particle });
}

/** 一个网格（同 `p5c-mesh.test.ts` 的 meshOf）：格式 0x9、4 个顶点、一个三角形。 */
function meshOf(object: number, buffer: ArrayBuffer): SceneMesh {
  const stride = mdlStride(0x9);
  const vertices = new Uint8Array(buffer, 0, stride * 4);
  vertices.forEach((_, i) => (vertices[i] = i & 0xff));
  const indices = new Uint8Array(buffer, vertices.byteLength, 6);
  const view = new DataView(buffer);
  [0, 1, 2].forEach((value, i) => view.setUint16(indices.byteOffset + 2 * i, value, true));
  return {
    format: 0x9,
    stride,
    vertices,
    indices,
    vertexCount: 4,
    indexFormat: "uint16",
    indexCount: 3,
    material: "materials/m.json",
    passes: [pass(`objects/${object}/meshes/0/passes/0`, P.mesh)],
    shadow: pass(`objects/${object}/meshes/0/shadow`, P.mesh),
  };
}

/** 投射阴影的模型（P13d）：一个网格、带投射变体。 */
function modelLayer(object: number, buffer: ArrayBuffer): SceneLayer {
  return baseLayer(object, {
    name: `model ${object}`,
    origin: [960, 540, 0],
    size: [0, 0],
    model: {
      path: `models/m${object}.mdl`,
      version: 23,
      meshes: [meshOf(object, buffer)],
      order: [0],
      bounds: [-131072, -131072, -131072, 131072, 131072, 131072],
      castShadow: true,
    },
  });
}

const MESH_BUFFER = new ArrayBuffer(4096);

function bundleOf(layers: SceneLayer[], extra: Partial<SceneBundle> = {}): SceneBundle {
  return {
    general: {
      width: 1920,
      height: 1080,
      fields: { ...generalDefaults(), ambientcolor: [0.1, 0.1, 0.1], skylightcolor: [0.2, 0.2, 0.2] },
      clearVariable: false,
      perspectiveOverrideFov: particleFov(95),
      postprocess: { level: "disabled", bloomFlag: false, hdrFlag: false, bloom: false, hdr: false },
      bloom: { ...BLOOM_DEFAULTS, tint: [1, 1, 1] },
    },
    layers,
    programs: programs(),
    textures: TEXTURES(),
    bloom: null,
    unsupported: [],
    bindings: [],
    scripts: { list: [] },
    lights: {
      counts: {
        point: 1,
        spot: 0,
        tube: 0,
        directional: 0,
        pointShadow: 1,
        directionalShadow: 0,
        spotShadow: 0,
        spotCookie: 0,
        spotShadowCookie: 0,
      },
      quality: 1,
    },
    ...extra,
  };
}

/**
 * 混合场景：0、1 两个带 effect 的图像层共用池化 fbo（1 还有一个关着的、带 unique fbo 的 effect）；2、5 粒子层（maxcount 16 / 40）；
 * 3 被依赖的图像层，4 引用它；6 投射阴影的模型。
 */
function mixed(): SceneBundle {
  return bundleOf([
    imageLayer(0, { effects: [blurEffect(0, 0)] }),
    imageLayer(1, {
      effects: [
        blurEffect(1, 0),
        blurEffect(1, 1, { enabled: false, fbos: [fbo("blur"), fbo("u", { unique: true })] }),
      ],
    }),
    particleLayer(2),
    dependedLayer(3),
    imageLayer(4, {}, { layerComposites: { 1: 3 } }),
    particleLayer(5, { maxcount: 40 }),
    modelLayer(6, MESH_BUFFER),
  ]);
}

const FEATURES = new Set<string>();
const FRAME: FrameInput = {
  time: 1.5,
  frametime: 1 / 60,
  daytime: 0.5,
  pointer: [0.25, 0.75],
  pointerLast: [0, 0],
  cursor: [0.25, 0.75],
};

// ———— 内部视图 ————

interface DrawView {
  label: string;
  object: number;
  passKey: string;
  step: unknown;
  layer: SceneLayer;
  resources: unknown;
  pipeline: { label: string };
  vertexBuffer: FakeBuffer;
  uniformBuffer: FakeBuffer | null;
}
interface RuntimeView {
  object: number;
  signature: string;
  ops: { kind: string }[];
  draws: DrawView[];
  resources: { composites: unknown[] };
  fboKeys: string[];
}
interface Internals {
  owned: Set<unknown>;
  layers: RuntimeView[];
  draws: Set<DrawView>;
  runtimeByObject: Map<number, RuntimeView>;
  drawsByLayer: Map<number, DrawView[]>;
  drawsByPass: Map<string, DrawView[]>;
  targets: unknown[];
  fboPool: Map<string, { id: number; refs: number }>;
  shadowCasters: { prepare(entry: number, views: readonly unknown[]): void }[];
  shadowCasterRecords: Map<unknown, unknown>;
  particleOrdinals: Map<number, number>;
  particleIndices: { buffer: FakeBuffer; particles: number } | null;
  trees: Map<number, { system: ParticleSystem }>;
  layerTargets: Map<number, unknown>;
  morphTargets: Map<string, unknown>;
  textFbos: Map<number, unknown>;
  attachments: Map<number, unknown>;
  layerByObject: Map<number, unknown>;
  readyPipelines: Map<string, unknown>;
  pipelineOf(step: unknown, runtime: { layer: SceneLayer; resources: unknown }): PipelineSpec;
  createTarget(...args: unknown[]): unknown;
}
const internals = (scene: GpuScene) => scene as unknown as Internals;

const hex = (bytes: Uint8Array | undefined) => (bytes ? Buffer.from(bytes).toString("hex") : null);

/** 一个场景建出来的全部东西（不看对象之间的先后：装的顺序不同，`layers` 与 `draws` 的插入顺序可以不同）。 */
function snapshot(scene: GpuScene) {
  const s = internals(scene);
  const byObject = <T extends { object: number }>(list: T[]) => [...list].sort((a, b) => a.object - b.object);
  return {
    layers: byObject(s.layers).map((runtime) => ({
      object: runtime.object,
      signature: runtime.signature,
      ops: runtime.ops.map((op) => op.kind),
      composites: runtime.resources.composites.length,
      fboKeys: [...runtime.fboKeys].sort(),
    })),
    draws: [...s.draws]
      .map((item) => ({
        object: item.object,
        label: item.label,
        passKey: item.passKey,
        pipeline: pipelineKey(s.pipelineOf(item.step, item)),
        pipelineLabel: item.pipeline.label,
        vertexBytes: item.vertexBuffer.bytes.byteLength,
        vertex: hex(item.vertexBuffer.bytes),
        uniform: hex(item.uniformBuffer?.bytes),
      }))
      .sort((a, b) => a.object - b.object || a.passKey.localeCompare(b.passKey) || a.label.localeCompare(b.label)),
    fboPool: [...s.fboPool].map(([key, entry]) => [key, entry.refs]).sort(),
    shadowCasters: s.shadowCasters.length,
    particleOrdinals: [...s.particleOrdinals].sort((a, b) => a[0] - b[0]),
    layerTargets: [...s.layerTargets.keys()].sort(),
  };
}

/** 一帧（同渲染器的顺序），返回编码轨迹。 */
function frame(gpu: FakeGpu, scene: GpuScene, state: SceneState): string[] {
  scene.sync(state);
  scene.stepParticles(0.5, FRAME.time, state, FRAME.cursor);
  scene.update(FRAME, state);
  gpu.trace.length = 0;
  scene.encode(gpu.device.createCommandEncoder(), state);
  return [...gpu.trace];
}

/** 粒子的全部列（种子定的，同种子同序号的系统逐位相同）。 */
function particleColumns(scene: GpuScene): [number, number, string | null][] {
  return [...internals(scene).trees]
    .sort((a, b) => a[0] - b[0])
    .map(([object, tree]) => {
      const { buffer } = tree.system.columns;
      return [object, tree.system.alive, hex(new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength))];
    });
}

async function full(bundle: SceneBundle) {
  const gpu = new FakeGpu();
  const state = SceneState.fromBundle(bundle);
  const warnings: string[] = [];
  const scene = await GpuScene.build(gpu.device, bundle, state, FEATURES, warnings, { particles: { seed: 7 } });
  return { gpu, state, scene, bundle, warnings };
}
type Live = Awaited<ReturnType<typeof full>>;

/** 空场景（同一份状态，`bundle.layers` 起步为空）逐个 `prepareObject` + `installObject`，`bundle.layers` 随装随加（同登记表）。 */
async function oneByOne(source: SceneBundle) {
  const gpu = new FakeGpu();
  const state = SceneState.fromBundle(source);
  const bundle: SceneBundle = { ...source, layers: [] };
  const warnings: string[] = [];
  const scene = await GpuScene.build(gpu.device, bundle, state, FEATURES, warnings, { particles: { seed: 7 } });
  for (const layer of buildableLayers(source)) {
    bundle.layers.push(layer);
    scene.installObject(await scene.prepareObject(layer, state), state);
  }
  return { gpu, state, scene, bundle, warnings };
}

/** 运行中加一个对象：进 bundle 与状态，再备好、装上。 */
async function addObject(live: Live, layer: SceneLayer): Promise<void> {
  live.bundle.layers.push(layer);
  live.state.addObject({ layer });
  live.scene.installObject(await live.scene.prepareObject(layer, live.state), live.state);
}

/** 运行中删一个对象：走删除生效的路（状态 → 登记表摘掉 → 下一次 `sync` 的 `releaseRemoved`）。 */
function destroyObject(live: Live, object: number): void {
  live.state.markDestroy(object);
  live.state.flushDestroy();
  live.state.dropObject(object);
  const at = live.bundle.layers.findIndex((layer) => layer.object === object);
  if (at >= 0) live.bundle.layers.splice(at, 1);
  live.scene.sync(live.state);
}

/** 资源计数：回到基线就说明删干净了。 */
function counts(scene: GpuScene) {
  const s = internals(scene);
  return {
    owned: s.owned.size,
    targets: s.targets.filter(Boolean).length,
    fboPool: [...s.fboPool].map(([key, entry]) => `${key}=${entry.refs}`).sort(),
    shadowCasters: s.shadowCasters.length,
    shadowCasterRecords: s.shadowCasterRecords.size,
    particleOrdinals: s.particleOrdinals.size,
    layers: s.layers.length,
    runtimeByObject: s.runtimeByObject.size,
    draws: s.draws.size,
    drawsByLayer: s.drawsByLayer.size,
    drawsByPass: [...s.drawsByPass.values()].reduce((sum, list) => sum + list.length, 0),
    trees: s.trees.size,
    layerTargets: s.layerTargets.size,
    morphTargets: s.morphTargets.size,
    textFbos: s.textFbos.size,
    attachments: s.attachments.size,
    layerByObject: s.layerByObject.size,
  };
}

// ———— 用例 ————

describe("整场 build = 空场景逐个装（L4）", () => {
  it("draw、op、合成 RT、fbo 池、投射者、粒子序号与种子、编码轨迹都相同", async () => {
    const a = await full(mixed());
    const b = await oneByOne(mixed());
    const left = snapshot(a.scene);
    const right = snapshot(b.scene);
    // 夹具确实覆盖到：池化 fbo 两层共用、unique fbo、合成 RT、投射者、两个粒子层、被依赖层的独占 RT
    // blur：0 层一份、1 层两个 effect 各一份
    expect(left.fboPool).toContainEqual(["blur|64x32|rgba8unorm|false", 3]);
    expect(left.fboPool.some(([key]) => String(key).startsWith("unique|2|101|u"))).toBe(true);
    expect(left.layers.find((layer) => layer.object === 0)!.composites).toBeGreaterThan(0);
    expect(left.shadowCasters).toBe(1);
    expect(left.particleOrdinals).toEqual([
      [2, 0],
      [5, 1],
    ]);
    expect(left.layerTargets).toEqual([3]);
    expect(right).toEqual(left);
    expect(b.warnings).toEqual(a.warnings);
    // 预热同种子：位置逐位相同；之后同样步进、编码
    expect(particleColumns(b.scene)).toEqual(particleColumns(a.scene));
    const traceA = frame(a.gpu, a.scene, a.state);
    const traceB = frame(b.gpu, b.scene, b.state);
    expect(traceA.length).toBeGreaterThan(10);
    expect(traceB).toEqual(traceA);
    expect(particleColumns(b.scene)).toEqual(particleColumns(a.scene));
    expect(snapshot(b.scene)).toEqual(snapshot(a.scene));
  });

  it("整场加载时粒子种子由 particleOrdinal 给（宿主传登记表的）；缺省按 bundle 顺序数", async () => {
    const bundle = mixed();
    const gpu = new FakeGpu();
    const state = SceneState.fromBundle(bundle);
    const scene = await GpuScene.build(gpu.device, bundle, state, FEATURES, [], {
      particles: { seed: 7 },
      particleOrdinal: (object) => (object === 2 ? 1 : 0),
    });
    expect(snapshot(scene).particleOrdinals).toEqual([
      [2, 1],
      [5, 0],
    ]);
  });
});

describe("removeObject 再装回（L4）", () => {
  it("draw 相同；池化 fbo 的引用先减后回到原值，unique fbo 归零释放", async () => {
    const live = await full(mixed());
    const before = snapshot(live.scene);
    const blur = "blur|64x32|rgba8unorm|false";
    const pool = () => new Map([...internals(live.scene).fboPool].map(([key, entry]) => [key, entry.refs]));
    expect(pool().get(blur)).toBe(3);
    const unique = [...pool().keys()].find((key) => key.startsWith("unique|2|"))!;
    const uniqueTarget = internals(live.scene).targets[internals(live.scene).fboPool.get(unique)!.id];
    const layer = live.bundle.layers[1];
    live.scene.removeObject(1);
    expect(pool().get(blur)).toBe(1);
    expect(pool().has(unique)).toBe(false);
    expect((uniqueTarget as { texture: FakeTexture }).texture.destroyed).toBe(true);
    expect(internals(live.scene).runtimeByObject.has(1)).toBe(false);
    expect([...internals(live.scene).draws].some((item) => item.object === 1)).toBe(false);
    live.scene.installObject(await live.scene.prepareObject(layer, live.state), live.state);
    expect(pool().get(blur)).toBe(3);
    expect(snapshot(live.scene)).toEqual(before);
  });

  it("粒子层、被依赖层、投射阴影的模型删了再装回同样相同（粒子序号同一个、独占 RT 与投射者回来）", async () => {
    const live = await full(mixed());
    const before = snapshot(live.scene);
    for (const object of [2, 3, 6]) {
      const layer = live.bundle.layers[object];
      live.scene.removeObject(object);
      expect(internals(live.scene).particleOrdinals.has(object)).toBe(false);
      live.scene.installObject(await live.scene.prepareObject(layer, live.state), live.state);
    }
    expect(snapshot(live.scene)).toEqual(before);
  });
});

describe("建删 100 次（L4）", () => {
  it("owned、targets、fbo 池、投射者、粒子序号、各索引都回到基线", async () => {
    const live = await full(mixed());
    frame(live.gpu, live.scene, live.state);
    let next = 100;
    const cycle = async () => {
      const objects = [next, next + 1, next + 2, next + 3];
      next += 4;
      const [image, depended, particles, model] = objects;
      await addObject(
        live,
        imageLayer(image, {
          effects: [
            blurEffect(image, 0),
            blurEffect(image, 1, { enabled: false, fbos: [fbo("blur"), fbo("u", { unique: true })] }),
          ],
        }),
      );
      await addObject(live, dependedLayer(depended));
      await addObject(live, particleLayer(particles));
      await addObject(live, modelLayer(model, MESH_BUFFER));
      frame(live.gpu, live.scene, live.state);
      // 投射者的逐条目副本（阴影 pass 编码时建）：手动建一份，删的时候要一起释放
      for (const caster of internals(live.scene).shadowCasters) caster.prepare(0, []);
      for (const object of objects) destroyObject(live, object);
    };
    // 预热一轮：池化合成 RT 只增不减（共享池），按需长到够用为止
    await cycle();
    const baseline = counts(live.scene);
    for (let i = 0; i < 100; i++) await cycle();
    expect(counts(live.scene)).toEqual(baseline);
    // 原有的图层照常画
    expect(frame(live.gpu, live.scene, live.state).length).toBeGreaterThan(10);
  });
});

describe("粒子索引缓冲（L4）", () => {
  it("先装小 maxcount 再装大的：缓冲重建、旧的释放，旧 draw 编码时用新缓冲", async () => {
    const live = await full(bundleOf([particleLayer(0, { maxcount: 16 })], { lights: undefined }));
    const s = internals(live.scene);
    const first = s.particleIndices!.buffer;
    expect(s.particleIndices!.particles).toBe(16);
    await addObject(live, particleLayer(1, { maxcount: 40 }));
    const second = s.particleIndices!.buffer;
    expect(second).not.toBe(first);
    expect(first.destroyed).toBe(true);
    expect(s.particleIndices!.particles).toBe(40);
    expect(second.bytes.byteLength).toBe(40 * 6 * 2);
    // 小的再装进来：够用，不动
    await addObject(live, particleLayer(2, { maxcount: 8 }));
    expect(s.particleIndices!.buffer).toBe(second);
    live.gpu.indexBuffers.length = 0;
    frame(live.gpu, live.scene, live.state);
    // 三个粒子层都画了，用的都是现在这一个
    expect(live.gpu.indexBuffers.length).toBe(3);
    expect(live.gpu.indexBuffers.every((buffer) => buffer === second)).toBe(true);
  });
});

describe("prepareObjectSync（L4）", () => {
  it("管线都已就绪：同步备好、不建新管线，装上后和异步备的一样", async () => {
    const live = await full(mixed());
    const before = { ...live.gpu.counts };
    const layer = imageLayer(10, {
      effects: [
        blurEffect(10, 0),
        blurEffect(10, 1, { enabled: false, fbos: [fbo("blur"), fbo("u", { unique: true })] }),
      ],
    });
    live.bundle.layers.push(layer);
    live.state.addObject({ layer });
    const prepared = live.scene.prepareObjectSync(layer, live.state);
    expect(prepared).not.toBeNull();
    expect(live.gpu.counts).toEqual(before);
    live.scene.installObject(prepared!, live.state);
    const synced = snapshot(live.scene).draws.filter((item) => item.object === 10);
    // 同一个对象换成异步备的再装一次：draw 一样
    live.scene.removeObject(10);
    live.scene.installObject(await live.scene.prepareObject(layer, live.state), live.state);
    expect(snapshot(live.scene).draws.filter((item) => item.object === 10)).toEqual(synced);
    expect(synced.length).toBeGreaterThan(0);
  });

  it("缺管线：同步建（createRenderPipeline），readyPipelines 多一项，不走异步", async () => {
    const live = await full(mixed());
    const ready = internals(live.scene).readyPipelines.size;
    const before = { ...live.gpu.counts };
    const layer = imageLayer(11, {}, { blending: "additive" });
    live.bundle.layers.push(layer);
    live.state.addObject({ layer });
    const prepared = live.scene.prepareObjectSync(layer, live.state);
    expect(prepared).not.toBeNull();
    expect(live.gpu.counts.pipelinesSync).toBe(before.pipelinesSync + 1);
    expect(live.gpu.counts.pipelinesAsync).toBe(before.pipelinesAsync);
    expect(internals(live.scene).readyPipelines.size).toBe(ready + 1);
    live.scene.installObject(prepared!, live.state);
    const drawn = [...internals(live.scene).draws].find((item) => item.object === 11)!;
    expect(drawn.pipeline.label).toBe(`scene program ${P.base} additive rgba8unorm 7`);
  });

  it("缺程序：返回 null，什么都不建（fbo 池、owned 不变）", async () => {
    const live = await full(mixed());
    const before = counts(live.scene);
    const layer = imageLayer(12, { effects: [blurEffect(12, 0)] }, {});
    layer.passes[0].program = P.alt;
    live.bundle.layers.push(layer);
    live.state.addObject({ layer });
    expect(live.scene.prepareObjectSync(layer, live.state)).toBeNull();
    expect(counts(live.scene)).toEqual(before);
  });
});

describe("installObject 中途失败回滚（L4）", () => {
  it("createTarget 抛：layers / runtimeByObject / draws 不含它，fbo 引用不涨，抛 SceneRenderError；之后照常画", async () => {
    const live = await full(mixed());
    const before = counts(live.scene);
    // 新尺寸（96×48）的合成 RT 池里没有，装的时候 `ensureComposites` 要建；effect 不可变，备的时候不借
    const layer = imageLayer(
      20,
      { size: [96, 48], effects: [blurEffect(20, 0, { visibleBound: false })] },
      { textures: { 0: 2 } },
    );
    live.bundle.layers.push(layer);
    live.state.addObject({ layer });
    const prepared: PreparedObject = await live.scene.prepareObject(layer, live.state);
    // 备好时取过引用（新尺寸的 fbo）
    expect(prepared.fboKeys).toEqual(["blur|48x24|rgba8unorm|false"]);
    vi.spyOn(internals(live.scene), "createTarget").mockImplementation(() => {
      throw new Error("建不了");
    });
    expect(() => live.scene.installObject(prepared, live.state)).toThrow(SceneRenderError);
    vi.restoreAllMocks();
    const s = internals(live.scene);
    expect(s.layers.some((runtime) => runtime.object === 20)).toBe(false);
    expect(s.runtimeByObject.has(20)).toBe(false);
    expect([...s.draws].some((item) => item.object === 20)).toBe(false);
    expect(s.drawsByLayer.has(20)).toBe(false);
    expect(counts(live.scene).fboPool).toEqual(before.fboPool);
    // 已认领的不能再装、放弃也不再动它
    expect(() => live.scene.installObject(prepared, live.state)).toThrow(SceneRenderError);
    live.scene.discardPrepared(prepared);
    expect(counts(live.scene).fboPool).toEqual(before.fboPool);
    expect(frame(live.gpu, live.scene, live.state).length).toBeGreaterThan(10);
  });

  it("discardPrepared：备好不装，引用还回去；别的场景备的不能装", async () => {
    const live = await full(mixed());
    const other = await full(mixed());
    const before = counts(live.scene);
    const layer = dependedLayer(21);
    live.bundle.layers.push(layer);
    live.state.addObject({ layer });
    const prepared = await live.scene.prepareObject(layer, live.state);
    expect(() => other.scene.installObject(prepared, other.state)).toThrow(SceneRenderError);
    live.scene.discardPrepared(prepared);
    expect(counts(live.scene)).toEqual(before);
  });
});
