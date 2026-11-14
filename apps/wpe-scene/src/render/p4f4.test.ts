/**
 * P4f 步骤 4（一个系统多个 renderer，rea-p4f-script.md 8.3、8.4）：计划与渲染（假设备，照 `render/particles.test.ts`、
 * `render/events.test.ts`）。一个系统每条 renderer 一个步骤、一个 draw：按数组顺序连着画、都在子系统之前；实例化模板整组复用、整组换实例；
 * 朝向与 `g_RenderVar0` 各按各的 renderer；拖尾那次跳过退化粒子、sprite 那次照写；朝向 NaN 只跳过那一次；单 renderer 的 draw 不受影响。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generalDefaults, type SceneBinding } from "../compile/bindings";
import { FRAMEBUFFER_RT, type SceneBundle, type SceneLayer, type ScenePass } from "../compile/bundle";
import { constantTargetFields, materialSlots } from "../compile/materialValues";
import type { JsonObject } from "../compile/model";
import {
  childLocalMatrix,
  hasSpriteTrail,
  parseParticle,
  particleFov,
  type ParticleRenderer,
  type SceneParticle,
} from "../compile/particles";
import { BLOOM_DEFAULTS } from "../compile/postprocess";
import type { ParticleSystem } from "../particles/system";
import type { Mat4 } from "./math";
import type { TranslateResult } from "../wpesl2wgsl";
import { planParticleLayer, type ParticleStep } from "./graph";
import { checkRenderable, GpuScene } from "./scene";
import { SceneState } from "./state";
import { particleBuiltins, type FrameInput } from "./uniforms";

interface FakeBuffer {
  label: string;
  size: number;
  usage: number;
  bytes: Uint8Array;
  writes: number[];
  destroy(): void;
}

/** 假设备（同 `render/particles.test.ts`）：记录缓冲、管线与编码轨迹（顶点缓冲、索引缓冲、绘制次数、快照拷贝记 `copy`）。 */
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
      setIndexBuffer: (buffer: FakeBuffer, format: string) => this.trace.push(`index ${buffer.label} ${format}`),
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

  /** 编码一帧，返回这一帧的轨迹。 */
  encode(scene: GpuScene, state: SceneState): string[] {
    this.trace.length = 0;
    scene.encode(this.device.createCommandEncoder(), state);
    return [...this.trace];
  }
}

/** 翻译后 `genericparticle` 的反射（同 `render/particles.test.ts`），外加一个材质常量。 */
const SPRITE_PROGRAM = {
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

/** 厚格式的变体（`THICKFORMAT`）：多一个 `a_TexCoordVec4C1`（速度与 frame），每顶点 17 个 float。 */
const thickProgram = (label: string): TranslateResult =>
  ({
    ...SPRITE_PROGRAM,
    vertex: { wgsl: `// ${label} v`, entryPoint: "main" },
    attributes: [...(SPRITE_PROGRAM.attributes ?? []), { name: "a_TexCoordVec4C1", location: 4, type: "vec4" }],
  }) as TranslateResult;

/** 程序：0 薄格式 sprite，1 厚格式 sprite（同系统有拖尾），2 拖尾。 */
const P = { sprite: 0, thickSprite: 1, trail: 2 };
const PROGRAMS = [SPRITE_PROGRAM, thickProgram("thick sprite"), thickProgram("trail")];
/** 每顶点的字节数：薄格式 13 个 float，厚格式 17 个。 */
const STRIDE = { thin: 52, thick: 68 };

/** uniform 偏移见 `SPRITE_PROGRAM`。 */
const OFFSET = { up: 128, right: 144, forward: 160, renderVar0: 224, overbright: 272 };

function pass(key: string, program: number, extra: Partial<ScenePass> = {}): ScenePass {
  return {
    key,
    program,
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

/** 速度定值的 initializer（拖尾那次才画得出来）。 */
const velocity = (value = "100 0 0"): JsonObject => ({ name: "velocityrandom", min: value, max: value });

/**
 * 不散开、寿命 100 秒、尺寸 40 的系统；`json` 覆盖其余键（`renderer`、`emitter`、`initializer`……）。每条 renderer 一个 pass，稳定键
 * `<key>/passes/0`、`<key>/renderers/<r>/passes/0`（同编译期），程序按种类与系统有没有拖尾选（`P`）；`renderer: []` 的系统照编译期给一份
 * 基础 pass。第 0 条的 pass 推进 `passes`（和 `draws[0].passes` 是同一个数组）。
 */
function system(key: string, json: JsonObject = {}, extra: Partial<ScenePass> = {}): SceneParticle {
  const particle = parseParticle(
    {
      maxcount: 8,
      emitter: [{ name: "sphererandom", distancemax: 0, rate: 10 }],
      initializer: [
        { name: "lifetimerandom", min: 100, max: 100 },
        { name: "sizerandom", min: 40, max: 40 },
      ],
      ...json,
    },
    { file: `particles/${key}.json`, orthographic: true },
  );
  const thick = hasSpriteTrail(particle);
  const programOf = (kind: ParticleRenderer["kind"]) =>
    kind === "spritetrail" ? P.trail : thick ? P.thickSprite : P.sprite;
  particle.draws.forEach((draw, r) =>
    draw.passes.push(
      pass(r ? `${key}/renderers/${r}/passes/0` : `${key}/passes/0`, programOf(draw.renderer.kind), extra),
    ),
  );
  if (!particle.draws.length) particle.passes.push(pass(`${key}/passes/0`, P.sprite, extra));
  return particle;
}

/** 给 `parent` 挂一个子系统条目。 */
function attach(parent: SceneParticle, child: SceneParticle, type: "static" | "eventfollow" = "static"): SceneParticle {
  parent.children.push({
    index: parent.children.length,
    type,
    flags: 0,
    controlPointStartIndex: 0,
    probability: 1,
    maxcount: 10,
    local: childLocalMatrix([0, 0, 0], [0, 0, 0], [1, 1, 1]),
    system: child,
  });
  return child;
}

/** 粒子层（`objects` 下标 `object`，id = object + 1，名字 `name`）。 */
function layerOf(object: number, particle: SceneParticle, name = "p", extra: Partial<SceneLayer> = {}): SceneLayer {
  return {
    id: object + 1,
    object,
    parent: null,
    name,
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
    copyBackground: true,
    clampUVs: true,
    noInterpolation: false,
    fullscreen: false,
    fullscreenSize: null,
    group: null,
    subtree: [],
    groupUpload: null,
    passes: [],
    colorBlendMode: 0,
    effects: [],
    passthrough: null,
    particle,
    ...extra,
  };
}

function bundleOf(layers: SceneLayer[]): SceneBundle {
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
    layers,
    programs: PROGRAMS,
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

async function open(layers: SceneLayer[]) {
  const gpu = new FakeGpu();
  const bundle = bundleOf(layers);
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
  return { gpu, bundle, state, scene, step };
}

interface DrawView {
  label: string;
  step: ParticleStep;
  particles: {
    system: ParticleSystem;
    renderer: ParticleRenderer | undefined;
    count: number;
    hidden: boolean;
    model: Mat4;
    stale: boolean;
  } | null;
  uniformBuffer: FakeBuffer;
  vertexBuffer: FakeBuffer;
}
const internals = (scene: GpuScene) =>
  scene as unknown as {
    draws: Set<DrawView>;
    trees: Map<number, { templates: Map<string, { renderers: unknown[]; pool: DrawView[][] }> }>;
  };
/** 一个对象的全部粒子 draw（建的顺序）。 */
const drawsOf = (scene: GpuScene, object = 1): DrawView[] =>
  [...internals(scene).draws].filter(
    (draw) => draw.particles && (draw as unknown as { object: number }).object === object,
  );
/** 模板（`step.node.join("/")`）的池：每次出现一组。 */
const pool = (scene: GpuScene, template: string, object = 1): DrawView[][] =>
  internals(scene).trees.get(object)!.templates.get(template)!.pool;
const floats = (buffer: FakeBuffer, offset: number, count: number) =>
  Array.from(new Float32Array(buffer.bytes.buffer, offset, count));
/** 一帧轨迹里的顶点缓冲标签与快照拷贝。 */
const order = (trace: string[]) =>
  trace.filter((line) => line === "copy" || line.startsWith("vertex ")).map((line) => line.replace("vertex ", ""));
/** 一帧轨迹里的绘制相关行。 */
const drawLines = (trace: string[]) => trace.filter((line) => /^(vertex|index|draw)/.test(line));
const near = (actual: number[], expected: number[]) =>
  expected.forEach((value, i) => expect(actual[i], `${actual} vs ${expected}`).toBeCloseTo(value, 6));

beforeEach(() => {
  vi.stubGlobal("GPUTextureUsage", { RENDER_ATTACHMENT: 1, TEXTURE_BINDING: 2, COPY_SRC: 4, COPY_DST: 8 });
  vi.stubGlobal("GPUBufferUsage", { VERTEX: 1, UNIFORM: 2, COPY_DST: 4, MAP_READ: 8, INDEX: 16 });
  vi.stubGlobal("GPUMapMode", { READ: 1 });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("计划：一个系统几条 renderer 就几个步骤（rea-p4f-script.md 8.3）", () => {
  const steps = (particle: SceneParticle) =>
    planParticleLayer({ particle }).steps.map((step) =>
      step.kind === "particles" ? [step.pass.key, step.node, step.renderer, step.instanced] : step.kind,
    );

  it("步骤按 draws 顺序、各用自己那条的变体 pass；父的各 renderer 在子系统之前；单 renderer 的 renderer 是 0", () => {
    const root = system("r", { renderer: [{ name: "sprite" }, { name: "spritetrail" }] });
    attach(root, system("e", { renderer: [{ name: "spritetrail" }, { name: "sprite" }] }), "eventfollow");
    attach(root, system("s", { renderer: [{ name: "sprite" }, { name: "sprite", orientation: "upright" }] }));
    attach(root, system("t"));
    expect(steps(root)).toEqual([
      ["r/passes/0", [], 0, false],
      ["r/renderers/1/passes/0", [], 1, false],
      ["s/passes/0", [1], 0, false],
      ["s/renderers/1/passes/0", [1], 1, false],
      ["t/passes/0", [2], 0, false],
      ["e/passes/0", [0], 0, true],
      ["e/renderers/1/passes/0", [0], 1, true],
    ]);
    // 每步的 pass 是那一条的变体（程序不同），混合、光栅照变体取
    const plan = planParticleLayer({ particle: root });
    expect(plan.steps.slice(0, 2).map((step) => step.kind === "particles" && step.pass.program)).toEqual([
      P.thickSprite,
      P.trail,
    ]);
    expect(plan.reasons).toEqual([]);
  });

  it("renderer: [] 的系统不出步骤、照常列子系统；子系统的多条 renderer 照样连着", () => {
    const root = system("r", { renderer: [] });
    attach(root, system("c", { renderer: [{ name: "sprite" }, { name: "spritetrail" }] }));
    expect(steps(root)).toEqual([
      ["c/passes/0", [0], 0, false],
      ["c/renderers/1/passes/0", [0], 1, false],
    ]);
  });

  it("强制渲染 rope 类混挂：只出模拟跟着建的那条 rope 类（第一个），别的 rope 类跳过，sprite 类照出", () => {
    const keys = (renderer: JsonObject[]) =>
      planParticleLayer({ particle: system("r", { renderer }) }).steps.map((step) =>
        step.kind === "particles" ? [step.renderer, step.pass.key] : step.kind,
      );
    expect(keys([{ name: "sprite" }, { name: "ropetrail" }, { name: "rope" }])).toEqual([
      [0, "r/passes/0"],
      [1, "r/renderers/1/passes/0"],
    ]);
    expect(keys([{ name: "rope" }, { name: "spritetrail" }, { name: "ropetrail" }])).toEqual([
      [0, "r/passes/0"],
      [1, "r/renderers/1/passes/0"],
    ]);
    expect(keys([{ name: "spritetrail" }, { name: "sprite" }])).toHaveLength(2);
  });

  it("渲染器自查对每条 renderer 的变体各查一次（第 2 条的程序缺了照报）", () => {
    const root = system("r", { renderer: [{ name: "sprite" }, { name: "spritetrail" }] });
    expect(checkRenderable(bundleOf([layerOf(1, root)]), new Set())).toEqual([]);
    root.draws[1].passes[0] = { ...root.draws[1].passes[0], program: null };
    expect(checkRenderable(bundleOf([layerOf(1, root)]), new Set())).toEqual(["render:no-program"]);
  });

  it("运行时纹理按基础材质报一次；快照输入每步都有", () => {
    const root = system(
      "r",
      { renderer: [{ name: "sprite" }, { name: "spritetrail" }] },
      {
        framebuffer: true,
        runtime: { 3: FRAMEBUFFER_RT, 4: "_rt_Other" },
      },
    );
    const plan = planParticleLayer({ particle: root });
    expect(plan.reasons).toEqual(["render:texture-rt:_rt_Other"]);
    for (const step of plan.steps) expect(step).toMatchObject({ inputs: { 3: { kind: "framebuffer" } } });
  });
});

describe("GpuScene：一个系统多次绘制（P4f 步骤 4）", () => {
  /** 父在 (100, 200)、(300, 200) 各发一个粒子（速度 (100, 0)）；`renderer` 给父、static 子系统与 eventfollow 子系统。 */
  function tree(renderer: JsonObject[]) {
    const root = system("r", {
      emitter: [
        { name: "sphererandom", distancemax: 0, rate: 0, instantaneous: 1, origin: "100 200 0" },
        { name: "sphererandom", distancemax: 0, rate: 0, instantaneous: 1, origin: "300 200 0" },
      ],
      initializer: [{ name: "lifetimerandom", min: 100, max: 100 }, velocity()],
      renderer,
    });
    attach(
      root,
      system("e", { initializer: [{ name: "lifetimerandom", min: 100, max: 100 }, velocity()], renderer }),
      "eventfollow",
    );
    attach(root, system("s", { initializer: [{ name: "lifetimerandom", min: 100, max: 100 }, velocity()], renderer }));
    return root;
  }

  it("每帧的绘制序列：父 r0、父 r1、static 子 r0、r1、实例 1 r0、r1、实例 2……；标签第 r 条带 r<r>；第二帧不再建缓冲", async () => {
    const { gpu, scene, step } = await open([layerOf(1, tree([{ name: "sprite" }, { name: "spritetrail" }]))]);
    // 建场景时建顶层与 static 的第 0 组，事件实例下的池是空的
    expect([pool(scene, "").length, pool(scene, "1").length, pool(scene, "0").length]).toEqual([1, 1, 0]);
    expect(pool(scene, "").map((group) => group.map((draw) => draw.label))).toEqual([
      ["layer 2 p particles", "layer 2 p particles r1"],
    ]);
    const expected = [
      "layer 2 p particles",
      "layer 2 p particles r1",
      "layer 2 p particles 1",
      "layer 2 p particles 1 r1",
      "layer 2 p particles 0",
      "layer 2 p particles 0 r1",
      "layer 2 p particles 0#2",
      "layer 2 p particles 0#2 r1",
    ];
    expect(order(step())).toEqual(expected);
    const created = gpu.buffers.length;
    expect(order(step())).toEqual(expected);
    expect(gpu.buffers.length).toBe(created);
    // 实例化模板整组复用：两组、每组两个 draw，同一组画同一个实例
    const groups = pool(scene, "0");
    expect(groups.map((group) => group.map((draw) => draw.label))).toEqual([
      ["layer 2 p particles 0", "layer 2 p particles 0 r1"],
      ["layer 2 p particles 0#2", "layer 2 p particles 0#2 r1"],
    ]);
    for (const group of groups) expect(group[1].particles!.system).toBe(group[0].particles!.system);
    expect(groups[0][0].particles!.system).not.toBe(groups[1][0].particles!.system);
    // 每个 draw 各写各的顶点：sprite 那次厚格式（同系统有拖尾）、拖尾那次也是，各自一个缓冲
    expect(groups[0][0].vertexBuffer).not.toBe(groups[0][1].vertexBuffer);
    expect(pool(scene, "")[0][0].vertexBuffer.size).toBe(8 * 4 * STRIDE.thick);
    // dev 探针按 renderer 取：第 2 次出现的拖尾那次
    expect(scene.particleProbe(1, [0], 1, 1)?.system).toBe(groups[1][1].particles!.system);
    expect(scene.particleProbe(1, [0], 1, 1)?.trailEye).not.toBeNull();
    expect(scene.particleProbe(1, [0], 1, 0)?.trailEye).toBeNull();
    expect(scene.particleProbe(1, [0], 1, 2)).toBeNull();
    expect(scene.particleProbe(1, [0], 2, 0)).toBeNull();
  });

  it("实例回收后整组换到下一个出现的实例：两条 renderer 的 draw 一起换", async () => {
    // 父：A 第 1 帧出生、第 4 帧死；B 第 3 帧出生；子：寿命 0.05、有速度
    const renderer = [{ name: "sprite" }, { name: "spritetrail" }];
    const root = system("r", {
      emitter: [
        { name: "sphererandom", distancemax: 0, rate: 0, instantaneous: 1, origin: "100 200 0" },
        { name: "sphererandom", distancemax: 0, rate: 0, instantaneous: 1, origin: "300 200 0", delay: 0.15 },
      ],
      initializer: [{ name: "lifetimerandom", min: 0.25, max: 0.25 }, velocity()],
      operator: [{ name: "movement" }],
      renderer,
    });
    attach(
      root,
      system("e", { initializer: [{ name: "lifetimerandom", min: 0.05, max: 0.05 }, velocity()], renderer }),
      "eventfollow",
    );
    const { scene, step } = await open([layerOf(1, root)]);
    step();
    step();
    expect(order(step())).toEqual([
      "layer 2 p particles",
      "layer 2 p particles r1",
      "layer 2 p particles 0",
      "layer 2 p particles 0 r1",
      "layer 2 p particles 0#2",
      "layer 2 p particles 0#2 r1",
    ]);
    const [first, second] = pool(scene, "0");
    const instanceB = second[0].particles!.system;
    expect(order(step())).toEqual([
      "layer 2 p particles",
      "layer 2 p particles r1",
      "layer 2 p particles 0",
      "layer 2 p particles 0 r1",
    ]);
    expect(first.map((draw) => draw.particles!.system)).toEqual([instanceB, instanceB]);
    expect(pool(scene, "0")).toHaveLength(2);
  });

  it("g_Orientation* 各按各的 renderer 与这次绘制的模型矩阵（8.3：每条用自己的 rec+4）", async () => {
    const root = system("r", {
      renderer: [
        { name: "sprite", orientation: "upright", axis: "1 0 0" },
        { name: "sprite", flags: 1 },
        { name: "spritetrail", orientation: "fixed" },
      ],
    });
    const { scene } = await open([layerOf(1, root, "p", { angles: [0, 0, 0.5] })]);
    const draws = pool(scene, "")[0];
    expect(draws).toHaveLength(3);
    const orientation = (draw: DrawView) => ({
      up: floats(draw.uniformBuffer, OFFSET.up, 3),
      right: floats(draw.uniformBuffer, OFFSET.right, 3),
      forward: floats(draw.uniformBuffer, OFFSET.forward, 3),
    });
    draws.forEach((draw, r) => {
      const expected = particleBuiltins(undefined, root.draws[r].renderer, draw.particles!.model);
      const actual = orientation(draw);
      near(actual.up, expected.g_OrientationUp);
      near(actual.right, expected.g_OrientationRight);
      near(actual.forward, expected.g_OrientationForward);
    });
    // 两个 sprite 的朝向确实不同（不是都用了第一条的）
    expect(orientation(draws[0]).right).not.toEqual(orientation(draws[1]).right);
  });

  it("拖尾那次 g_RenderVar0.xyz 是自己的参数，sprite 那次是 0；每帧 update 之后不变", async () => {
    const { scene, step } = await open([
      layerOf(
        1,
        system("r", {
          renderer: [{ name: "sprite" }, { name: "spritetrail", length: 0.08, maxlength: 7, minlength: 12 }],
        }),
      ),
    ]);
    const [sprite, trail] = pool(scene, "")[0];
    expect(floats(sprite.uniformBuffer, OFFSET.renderVar0, 4)).toEqual([0, 0, 0, 0]);
    expect(floats(trail.uniformBuffer, OFFSET.renderVar0, 4)).toEqual([Math.fround(0.08), 7, 12, 0]);
    step();
    step();
    expect(floats(sprite.uniformBuffer, OFFSET.renderVar0, 4)).toEqual([0, 0, 0, 0]);
    expect(floats(trail.uniformBuffer, OFFSET.renderVar0, 4)).toEqual([Math.fround(0.08), 7, 12, 0]);
  });

  it("速度为 0 的粒子：sprite 那次照写、照画，拖尾那次不写（8.3 `m-st-zero`）；有速度的拖尾照写", async () => {
    const { gpu, state, scene, step } = await open([
      layerOf(1, system("r", { renderer: [{ name: "sprite" }, { name: "spritetrail" }] })),
    ]);
    // 5 个粒子都静止：只有 sprite 那次画
    expect(drawLines(step(0.5))).toEqual([
      "vertex layer 2 p particles",
      "index particle indices uint16",
      "drawIndexed 30",
    ]);
    const [sprite, trail] = pool(scene, "")[0];
    expect([sprite.particles!.count, trail.particles!.count]).toEqual([5, 0]);
    expect(trail.vertexBuffer.writes).toEqual([]);
    // 给前 3 个粒子速度：拖尾那次写 3 个，sprite 那次仍写 5 个（两次读的是同一批粒子）
    const columns = sprite.particles!.system.columns;
    for (let slot = 0; slot < 3; slot++) columns.velocity[0][slot] = 50;
    sprite.particles!.stale = true;
    trail.particles!.stale = true;
    expect(drawLines(gpu.encode(scene, state))).toEqual([
      "vertex layer 2 p particles",
      "index particle indices uint16",
      "drawIndexed 30",
      "vertex layer 2 p particles r1",
      "index particle indices uint16",
      "drawIndexed 18",
    ]);
    expect([sprite.particles!.count, trail.particles!.count]).toEqual([5, 3]);
    // 拖尾那次写的是有速度的 3 个，速度列（厚格式的 a_TexCoordVec4C1，float 13–15）就是写进去的值
    const velocityOf = (draw: DrawView) => floats(draw.vertexBuffer, 13 * 4, 3).map((value) => value + 0);
    expect(velocityOf(trail)).toEqual([50, 0, 0]);
    expect(velocityOf(sprite)).toEqual([50, 0, 0]);
    expect(trail.vertexBuffer.writes.at(-1)).toBe(3 * 4 * STRIDE.thick);
    expect(sprite.vertexBuffer.writes.at(-1)).toBe(5 * 4 * STRIDE.thick);
  });

  it("朝向是 NaN 只跳过算出 NaN 的那一次绘制，同系统的另一条照画", async () => {
    const { gpu, state, scene, step } = await open([
      layerOf(
        1,
        system("r", {
          initializer: [{ name: "lifetimerandom", min: 100, max: 100 }, velocity()],
          renderer: [
            { name: "sprite", orientation: "upright", axis: "0 0 1" },
            { name: "sprite" },
            { name: "spritetrail" },
          ],
        }),
      ),
    ]);
    expect(order(step(0.5))).toEqual(["layer 2 p particles r1", "layer 2 p particles r2"]);
    const [upright, screen, trail] = pool(scene, "")[0];
    expect([upright.particles!.hidden, screen.particles!.hidden, trail.particles!.hidden]).toEqual([
      true,
      false,
      false,
    ]);
    expect(scene.particleProbe(1, [], 0, 0)!.hidden).toBe(true);
    expect(scene.particleProbe(1, [], 0, 1)!.hidden).toBe(false);
    // 第一条的 uniform 照写（NaN），另两条不是
    expect(floats(upright.uniformBuffer, OFFSET.right, 3).every(Number.isNaN)).toBe(true);
    expect(floats(screen.uniformBuffer, OFFSET.right, 3).some(Number.isNaN)).toBe(false);
    expect(order(gpu.encode(scene, state))).toEqual(["layer 2 p particles r1", "layer 2 p particles r2"]);
  });

  it("快照每对象至多一次，在这个系统第一条 renderer 之前（同一个基础材质，各变体的 framebuffer 相同）", async () => {
    const { step } = await open([
      layerOf(1, system("r", { renderer: [{ name: "sprite" }, { name: "sprite", flags: 1 }] }, REFRACT)),
    ]);
    expect(order(step())).toEqual(["copy", "layer 2 p particles", "layer 2 p particles r1"]);
  });

  it("材质常量的属性写进两个变体的键，两次绘制的 uniform 都改", async () => {
    const root = system(
      "r",
      { renderer: [{ name: "sprite" }, { name: "spritetrail" }] },
      {
        uniforms: { g_Overbright: [2] },
      },
    );
    const { state, scene, step } = await open([layerOf(1, root)]);
    const [sprite, trail] = pool(scene, "")[0];
    expect(floats(sprite.uniformBuffer, OFFSET.overbright, 1)).toEqual([2]);
    expect(floats(trail.uniformBuffer, OFFSET.overbright, 1)).toEqual([2]);
    const slot = materialSlots(SPRITE_PROGRAM.uniforms ?? [])[0];
    for (const key of ["r/passes/0", "r/renderers/1/passes/0"]) {
      const binding: SceneBinding = {
        property: "ob",
        target: { kind: "constant", pass: key, material: "overbright", ...constantTargetFields(slot) },
      };
      expect(state.write(binding, 5)).toBe("applied");
    }
    scene.sync(state);
    step();
    expect(floats(sprite.uniformBuffer, OFFSET.overbright, 1)).toEqual([5]);
    expect(floats(trail.uniformBuffer, OFFSET.overbright, 1)).toEqual([5]);
  });

  it("单 renderer 的层：一个 draw、标签不带 r，顶点与 uniform 字节和同样的系统多加一条 renderer 时的第 0 次绘制相同", async () => {
    const one = system("a", { renderer: [{ name: "sprite" }] });
    const two = system("b", { renderer: [{ name: "sprite" }, { name: "sprite", orientation: "upright" }] });
    const { scene, step } = await open([layerOf(1, one, "one"), layerOf(2, two, "two")]);
    step(0.5);
    const single = drawsOf(scene, 1);
    expect(single.map((draw) => [draw.label, draw.step.renderer])).toEqual([["layer 2 one particles", 0]]);
    expect(drawsOf(scene, 2).map((draw) => draw.label)).toEqual(["layer 3 two particles", "layer 3 two particles r1"]);
    const first = drawsOf(scene, 2)[0];
    expect(single[0].vertexBuffer.size).toBe(8 * 4 * STRIDE.thin);
    expect(Array.from(single[0].uniformBuffer.bytes)).toEqual(Array.from(first.uniformBuffer.bytes));
    expect(Array.from(single[0].vertexBuffer.bytes)).toEqual(Array.from(first.vertexBuffer.bytes));
    // 单 renderer 的那次绘制用的 renderer 就是系统的 renderer（同以前读 `def.renderer`）
    expect(single[0].particles!.renderer).toBe(one.renderer);
  });
});
