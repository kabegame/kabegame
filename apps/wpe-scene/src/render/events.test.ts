/**
 * P4e 步骤 2：粒子层每帧现排（`particle-tree` op，rea-p4e-children 第 6 节）。假设备（照 `render/particles.test.ts`）：事件实例的 draw 按需
 * 建与复用、绘制先序、快照每对象一次、存活数为 0 的实例不画、模型矩阵变了重写 uniform、实例化 draw 的顶点缓冲按需增长；没有事件条目时
 * 和 P4e 步骤 1 等价。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generalDefaults } from "../compile/bindings";
import { FRAMEBUFFER_RT, type SceneBundle, type SceneLayer, type ScenePass } from "../compile/bundle";
import type { JsonObject } from "../compile/model";
import { childLocalMatrix, parseParticle, particleFov, type SceneParticle } from "../compile/particles";
import { BLOOM_DEFAULTS } from "../compile/postprocess";
import type { ParticleSystem } from "../particles/system";
import type { TranslateResult } from "../wpesl2wgsl";
import { sceneViewProjection } from "./layout";
import { multiply, translation } from "./math";
import { GpuScene } from "./scene";
import { SceneState } from "./state";
import type { FrameInput } from "./uniforms";

interface FakeBuffer {
  label: string;
  size: number;
  usage: number;
  bytes: Uint8Array;
  writes: number[];
  destroy(): void;
}

/** 假设备：记录缓冲（标签、大小、写入）、编码轨迹（顶点缓冲、绘制、快照拷贝记 `copy`）。 */
class FakeGpu {
  readonly buffers: FakeBuffer[] = [];
  readonly live = new Set<FakeBuffer>();
  readonly trace: string[] = [];
  readonly device: GPUDevice;

  constructor() {
    const pass = () => ({
      setViewport() {},
      setPipeline() {},
      setBindGroup() {},
      setVertexBuffer: (_slot: number, buffer: FakeBuffer) => this.trace.push(`vertex ${buffer.label}`),
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
      createRenderPipelineAsync: async () => ({}),
      createBindGroup: () => ({}),
      createCommandEncoder: () => ({
        beginRenderPass: () => pass(),
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

  /** 编码一帧，返回顶点缓冲、绘制与快照拷贝这几行。 */
  encode(scene: GpuScene, state: SceneState): string[] {
    this.trace.length = 0;
    scene.encode(this.device.createCommandEncoder(), state);
    return [...this.trace];
  }
}

/** 翻译后 `genericparticle` 的反射（同 `render/particles.test.ts`）。 */
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
    { name: "g_Time", type: "f32", declared: "float", offset: 176, size: 4 },
  ],
  uniformBlockSize: 192,
  textures: [{ slot: 0, binding: 1, samplerBinding: 2, kind: "2d" }],
} as unknown as TranslateResult;

/** 每粒子 4 个顶点，每个顶点 13 个 float（位置 3 + a_TexCoordVec4 4 + 颜色 4 + a_TexCoordC2 2）。 */
const STRIDE_BYTES = 52;

function pass(key: string, extra: Partial<ScenePass> = {}): ScenePass {
  return {
    key,
    program: 0,
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

/** 要帧缓冲的材质（`REFRACT` 的槽 3）。 */
const REFRACT: Partial<ScenePass> = { framebuffer: true, runtime: { 3: FRAMEBUFFER_RT } };

/** 不动、寿命 100 秒的系统：`emitters` 是发射器列表，`json` 覆盖其余键；材质 pass 的稳定键是 `key`。 */
function system(
  key: string,
  emitters: JsonObject[],
  json: JsonObject = {},
  extra: Partial<ScenePass> = {},
): SceneParticle {
  const particle = parseParticle(
    {
      maxcount: 8,
      emitter: emitters.map((emitter) => ({ name: "sphererandom", distancemax: 0, rate: 10, ...emitter })),
      initializer: [{ name: "lifetimerandom", min: 100, max: 100 }],
      ...json,
    },
    { file: `particles/${key}.json`, orthographic: true },
  );
  particle.passes = [pass(key, extra)];
  return particle;
}

/** 给 `parent` 挂一个子系统条目（缺省 eventfollow）。 */
function attach(
  parent: SceneParticle,
  child: SceneParticle,
  type: "static" | "eventfollow" = "eventfollow",
  origin: number[] = [0, 0, 0],
): SceneParticle {
  parent.children.push({
    index: parent.children.length,
    type,
    flags: 0,
    controlPointStartIndex: 0,
    probability: 1,
    maxcount: 10,
    local: childLocalMatrix(origin, [0, 0, 0], [1, 1, 1]),
    system: child,
  });
  return child;
}

/** 粒子层 1（对象原点 (10, 0)，名字 `p`，标签 `layer 2 p particles…`）。 */
function layerOf(particle: SceneParticle): SceneLayer {
  return {
    id: 2,
    object: 1,
    parent: null,
    name: "p",
    origin: [10, 0, 0],
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
    noPadding: false,
    perspective: false,
    passthroughModel: false,
    copyBackground: true,
    fullscreen: false,
    fullscreenSize: null,
    passes: [],
    colorBlendMode: 0,
    effects: [],
    passthrough: null,
    particle,
  };
}

function bundleOf(particle: SceneParticle): SceneBundle {
  const width = 32;
  return {
    general: {
      width: 1920,
      height: 1080,
      fields: generalDefaults(),
      clearVariable: false,
      perspectiveOverrideFov: particleFov(95),
      postprocess: { level: "disabled", bloomFlag: false, hdrFlag: false, bloom: false, hdr: false },
      bloom: { ...BLOOM_DEFAULTS, tint: [1, 1, 1] },
    },
    layers: [layerOf(particle)],
    programs: [PARTICLE_PROGRAM],
    textures: [
      {
        path: "materials/util/white.tex",
        source: "",
        format: 0,
        width,
        height: width,
        textureWidth: width,
        textureHeight: width,
        flags: 0,
        clampUVs: true,
        noInterpolation: false,
        mips: [{ width, height: width, bytes: new Uint8Array(width * width * 4) }],
      },
    ],
    bloom: null,
    unsupported: [],
    bindings: [],
    scripts: { list: [] },
  };
}

const frame = (frametime: number, time: number): FrameInput => ({
  time,
  frametime,
  daytime: 0.5,
  pointer: [0.5, 0.5],
  pointerLast: [0.5, 0.5],
  cursor: [0.5, 0.5],
});

async function open(particle: SceneParticle) {
  const gpu = new FakeGpu();
  const bundle = bundleOf(particle);
  const state = SceneState.fromBundle(bundle);
  const scene = await GpuScene.build(gpu.device, bundle, state, new Set(), [], { particles: { seed: 1 } });
  let time = 0;
  /** 一帧，顺序同渲染器：先步进粒子，再写每帧 uniform，再编码。 */
  const step = (frametime = 0.1): string[] => {
    time += frametime;
    scene.stepParticles(frametime, time, state, [0.5, 0.5]);
    scene.update(frame(frametime, time), state);
    return gpu.encode(scene, state);
  };
  return { gpu, state, scene, step };
}

interface DrawView {
  label: string;
  particles: { system: ParticleSystem; count: number } | null;
  uniformBuffer: FakeBuffer;
  vertexBuffer: FakeBuffer;
}
/** 模板（`step.node.join("/")`）的 draw 池（私有字段）。 */
const pool = (scene: GpuScene, template: string): DrawView[] =>
  (scene as unknown as { trees: Map<number, { templates: Map<string, { pool: DrawView[] }> }> }).trees
    .get(1)!
    .templates.get(template)!.pool;
const floats = (buffer: FakeBuffer, offset: number, count: number) =>
  Array.from(new Float32Array(buffer.bytes.buffer, offset, count));
/** 一帧轨迹里的顶点缓冲标签与快照拷贝（去掉绘制次数）。 */
const order = (trace: string[]) =>
  trace.filter((line) => line === "copy" || line.startsWith("vertex ")).map((line) => line.replace("vertex ", ""));
/** `VP · T(x, y, 0)` 的 16 个数（MVP 的期望值）。 */
const mvp = (x: number, y: number) =>
  Array.from(multiply(sceneViewProjection({ width: 1920, height: 1080 }), translation(x, y, 0)));

beforeEach(() => {
  vi.stubGlobal("GPUTextureUsage", { RENDER_ATTACHMENT: 1, TEXTURE_BINDING: 2, COPY_SRC: 4, COPY_DST: 8 });
  vi.stubGlobal("GPUBufferUsage", { VERTEX: 1, UNIFORM: 2, COPY_DST: 4, MAP_READ: 8, INDEX: 16 });
  vi.stubGlobal("GPUMapMode", { READ: 1 });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("粒子层每帧现排：事件实例（P4e 步骤 2，rea-p4e-children 第 6 节）", () => {
  /** 父在 (100, 200)、(300, 200) 各发一个不动的粒子；条目 0 是 eventfollow（带 static 孙辈），条目 1 是 static。 */
  function tree(child: JsonObject[] = [{}], childJson: JsonObject = {}, childPass: Partial<ScenePass> = {}) {
    const root = system("r", [
      { rate: 0, instantaneous: 1, origin: "100 200 0" },
      { rate: 0, instantaneous: 1, origin: "300 200 0" },
    ]);
    const event = attach(root, system("e", child, childJson, childPass));
    attach(event, system("g", [{}]), "static");
    attach(root, system("s", [{}]), "static");
    return root;
  }

  it("draw 池按需建、之后复用：先序是 父 → static → 实例 1 → 它的 static 孙辈 → 实例 2 → 它的孙辈；第 k 个 draw 的标签带 #k", async () => {
    const { gpu, scene, step } = await open(tree());
    // 建场景时只建顶层与 static 的 draw，事件实例下的模板池是空的
    expect([
      pool(scene, "").length,
      pool(scene, "1").length,
      pool(scene, "0").length,
      pool(scene, "0/0").length,
    ]).toEqual([1, 1, 0, 0]);
    const built = gpu.buffers.length;
    const expected = [
      "layer 2 p particles",
      "layer 2 p particles 1",
      "layer 2 p particles 0",
      "layer 2 p particles 0/0",
      "layer 2 p particles 0#2",
      "layer 2 p particles 0/0#2",
    ];
    expect(order(step())).toEqual(expected);
    expect(gpu.buffers.length).toBeGreaterThan(built);
    const created = gpu.buffers.length;
    // 第二帧：同样的顺序，不再建缓冲
    expect(order(step())).toEqual(expected);
    expect(gpu.buffers.length).toBe(created);
    expect([pool(scene, "0").length, pool(scene, "0/0").length]).toEqual([2, 2]);
    // 实例的模型矩阵：W · X，X = T(父粒子)（条目 L 是单位阵）；孙辈 W · X · L₂ 相同
    const [first, second] = pool(scene, "0");
    expect(floats(first.uniformBuffer, 0, 16)).toEqual(mvp(110, 200));
    expect(floats(second.uniformBuffer, 0, 16)).toEqual(mvp(310, 200));
    expect(floats(pool(scene, "0/0")[1].uniformBuffer, 0, 16)).toEqual(mvp(310, 200));
    // 编码时才建的 draw 也带着这一帧的每帧量（`update` 已经过去）
    expect(floats(second.uniformBuffer, 176, 1)).toEqual([Math.fround(0.2)]);
    // dev 探针：先序、第 2 次出现带 occurrence；particleProbe 按池里的序号取
    expect(scene.particleStats().map((stats) => [stats.node ?? [], stats.occurrence ?? 1, stats.alive])).toEqual([
      [[], 1, 2],
      [[1], 1, 2],
      [[0], 1, 2],
      [[0, 0], 1, 2],
      [[0], 2, 2],
      [[0, 0], 2, 2],
    ]);
    expect(scene.particleProbe(1, [0], 1)?.system).toBe(second.particles!.system);
    expect(scene.particleProbe(1, [0], 2)).toBeNull();
  });

  it("存活数为 0 的实例不画、不占 draw，照常递归它的子孙（第 6 节）", async () => {
    const { scene, step } = await open(tree([{ delay: 1 }]));
    expect(order(step())).toEqual([
      "layer 2 p particles",
      "layer 2 p particles 1",
      "layer 2 p particles 0/0",
      "layer 2 p particles 0/0#2",
    ]);
    expect([pool(scene, "0").length, pool(scene, "0/0").length]).toEqual([0, 2]);
  });

  it("快照每对象至多一次，插在本帧先序里第一个需要帧缓冲的系统之前；没有实例时不拷", async () => {
    const { gpu, state, scene, step } = await open(tree([{}], {}, REFRACT));
    // 还没步进：没有粒子可画、也没有实例，不拷
    expect(order(gpu.encode(scene, state))).toEqual([]);
    expect(order(step())).toEqual([
      "layer 2 p particles",
      "layer 2 p particles 1",
      "copy",
      "layer 2 p particles 0",
      "layer 2 p particles 0/0",
      "layer 2 p particles 0#2",
      "layer 2 p particles 0/0#2",
    ]);
  });
});

describe("实例化 draw 的 uniform 与顶点缓冲（P4e 步骤 2）", () => {
  it("eventfollow 的 X 每帧在变，uniform 跟着重写；实例回收后池里的 draw 指派给下一个出现的实例", async () => {
    // 父：A 第 1 帧出生、第 4 帧死；B 第 3 帧出生（delay 0.15）；速度 (100, 0)。子：每秒 10 个、寿命 0.05
    const root = system(
      "r",
      [
        { rate: 0, instantaneous: 1, origin: "100 200 0" },
        { rate: 0, instantaneous: 1, origin: "300 200 0", delay: 0.15 },
      ],
      {
        initializer: [
          { name: "lifetimerandom", min: 0.25, max: 0.25 },
          { name: "velocityrandom", min: "100 0 0", max: "100 0 0" },
        ],
        operator: [{ name: "movement" }],
      },
    );
    attach(root, system("e", [{}], { initializer: [{ name: "lifetimerandom", min: 0.05, max: 0.05 }] }));
    const { gpu, scene, step } = await open(root);
    step();
    const first = pool(scene, "0")[0];
    // W = T(10, 0)；父粒子 operator 之后在 x = 110
    expect(floats(first.uniformBuffer, 0, 16)).toEqual(mvp(120, 200));
    step();
    expect(floats(first.uniformBuffer, 0, 16)).toEqual(mvp(130, 200));
    expect(order(step())).toEqual(["layer 2 p particles", "layer 2 p particles 0", "layer 2 p particles 0#2"]);
    const [a, b] = pool(scene, "0");
    expect(floats(a.uniformBuffer, 0, 16)).toEqual(mvp(140, 200));
    expect(floats(b.uniformBuffer, 0, 16)).toEqual(mvp(320, 200));
    const instanceB = b.particles!.system;
    const buffers = gpu.buffers.length;
    // 第 4 帧：A 的父粒子死、A 的粒子死光后回收；B 成了第一次出现，用池里第 1 个 draw，uniform 换成 B 的
    expect(order(step())).toEqual(["layer 2 p particles", "layer 2 p particles 0"]);
    expect(a.particles!.system).toBe(instanceB);
    expect(floats(a.uniformBuffer, 0, 16)).toEqual(mvp(330, 200));
    expect(pool(scene, "0")).toHaveLength(2);
    expect(gpu.buffers.length).toBe(buffers);
  });

  it("实例化 draw 的顶点缓冲按存活数分配（至少 64 个）、不够时翻倍增长到容量为止；顶层与 static 仍按容量", async () => {
    const root = system("r", [{ rate: 0, instantaneous: 1 }]);
    attach(root, system("e", [{ rate: 300 }], { maxcount: 200 }));
    const { gpu, scene, step } = await open(root);
    expect(pool(scene, "")[0].vertexBuffer.size).toBe(8 * 4 * STRIDE_BYTES);
    step();
    // 顶点缓冲与 uniform 缓冲同标签，按 draw 取
    const draw = pool(scene, "0")[0];
    const small = draw.vertexBuffer;
    expect(small.size).toBe(64 * 4 * STRIDE_BYTES);
    step();
    expect(draw.vertexBuffer).toBe(small);
    // 第 3 帧 90 个：重建成 max(90, 128) = 128 个，旧缓冲释放
    expect(step()).toContain("drawIndexed 540");
    const grown = draw.vertexBuffer;
    expect(grown).not.toBe(small);
    expect(grown.label).toBe("layer 2 p particles 0");
    expect(grown.size).toBe(128 * 4 * STRIDE_BYTES);
    expect(gpu.live.has(small)).toBe(false);
    expect(grown.writes).toEqual([90 * 4 * STRIDE_BYTES]);
    // 第 7 帧 200 个：到容量为止
    for (let i = 0; i < 4; i++) step();
    expect(draw.vertexBuffer.size).toBe(200 * 4 * STRIDE_BYTES);
  });
});

describe("没有事件条目时和 P4e 步骤 1 等价", () => {
  it("每个模板一个 draw、建场景时建好，之后不再建；快照在先序里第一个要帧缓冲的系统之前、只拷一次（实测 dr-refract）", async () => {
    const root = system("r", [{}]);
    const a = attach(root, system("a", [{}], {}, REFRACT), "static");
    attach(a, system("a0", [{}]), "static");
    attach(root, system("b", [{}], {}, REFRACT), "static");
    const { gpu, scene, step } = await open(root);
    const built = gpu.buffers.length;
    for (const template of ["", "0", "0/0", "1"]) expect(pool(scene, template), template).toHaveLength(1);
    const expected = [
      "layer 2 p particles",
      "copy",
      "layer 2 p particles 0",
      "layer 2 p particles 0/0",
      "layer 2 p particles 1",
    ];
    for (let i = 0; i < 3; i++) expect(order(step())).toEqual(expected);
    expect(gpu.buffers.length).toBe(built);
    for (const template of ["", "0", "0/0", "1"]) expect(pool(scene, template), template).toHaveLength(1);
    // static 的 draw 每帧只在 update 里写一次 uniform（模型矩阵不变，编码时不重写）
    expect(pool(scene, "0")[0].uniformBuffer.writes).toHaveLength(1 + 3);
  });
});
