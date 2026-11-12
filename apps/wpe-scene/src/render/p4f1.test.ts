/**
 * P4f 步骤 1 的状态与同步单测：`SceneState.write` 写 `instanceoverride.rate` 不标脏、另记 `rates`（rea-p4f-script.md 5.4，用户属性与
 * 字段脚本同一条路），`GpuScene.sync` 先对它们 `setRate`、再对脏的 `setInstance`，重算里钳过的 `rate` 写回状态（5.2）；加载时钳一次
 * （6.1）。假设备照 `render/events.test.ts`。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generalDefaults, planApply, type SceneBinding } from "../compile/bindings";
import type { SceneBundle, SceneLayer, ScenePass } from "../compile/bundle";
import type { JsonObject } from "../compile/model";
import { parseParticle, particleFov, type SceneParticle } from "../compile/particles";
import { BLOOM_DEFAULTS } from "../compile/postprocess";
import type { ParticleFields } from "../particles/modules";
import type { ParticleSystem } from "../particles/system";
import type { TranslateResult } from "../wpesl2wgsl";
import { GpuScene } from "./scene";
import { SceneState } from "./state";

interface FakeBuffer {
  label: string;
  size: number;
  bytes: Uint8Array;
  destroy(): void;
}

/** 假设备：只要能建场景、编码一帧（照 `render/events.test.ts`，不记轨迹）。 */
function fakeDevice(): GPUDevice {
  const pass = () => ({
    setViewport() {},
    setPipeline() {},
    setBindGroup() {},
    setVertexBuffer() {},
    setIndexBuffer() {},
    draw() {},
    drawIndexed() {},
    end() {},
  });
  return {
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
    createBuffer: (descriptor: GPUBufferDescriptor): FakeBuffer => ({
      label: descriptor.label ?? "",
      size: descriptor.size,
      bytes: new Uint8Array(descriptor.size),
      destroy() {},
    }),
    createShaderModule: () => ({ getCompilationInfo: async () => ({ messages: [] }) }),
    createBindGroupLayout: () => ({}),
    createPipelineLayout: () => ({}),
    createRenderPipeline: () => ({ getBindGroupLayout: () => ({}) }),
    createRenderPipelineAsync: async () => ({}),
    createBindGroup: () => ({}),
    createCommandEncoder: () => ({
      beginRenderPass: () => pass(),
      copyTextureToTexture() {},
      copyTextureToBuffer() {},
      finish: () => ({}),
    }),
    queue: {
      writeBuffer: (buffer: FakeBuffer, offset: number, data: ArrayBuffer, dataOffset = 0, size?: number) =>
        buffer.bytes.set(new Uint8Array(data, dataOffset, size ?? data.byteLength - dataOffset), offset),
      writeTexture() {},
      submit() {},
      onSubmittedWorkDone: async () => {},
    },
    pushErrorScope() {},
    popErrorScope: async () => null,
  } as unknown as GPUDevice;
}

/** 翻译后 `genericparticle` 的反射（同 `render/events.test.ts`）。 */
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

function pass(key: string): ScenePass {
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
  };
}

/**
 * 粒子层 1：每秒 10 个、寿命 100、速度 (100, 0, 0) 匀速移动，带 `turbulentvelocityrandom`（`timescale 2`，乘 `rate`）；
 * `instanceoverride` 取 `instance`。
 */
function particle(instance: JsonObject = {}): SceneParticle {
  const result = parseParticle(
    {
      maxcount: 16,
      emitter: [{ name: "sphererandom", distancemin: 0, distancemax: 0, rate: 10 }],
      initializer: [
        { name: "lifetimerandom", min: 100, max: 100 },
        { name: "velocityrandom", min: "100 0 0", max: "100 0 0" },
        { name: "turbulentvelocityrandom", timescale: 2, speedmin: 0, speedmax: 0 },
      ],
      operator: [{ name: "movement" }],
    },
    { file: "particles/p.json", orthographic: true, instanceoverride: instance },
  );
  result.passes = [pass("objects/1/particle/passes/0")];
  return result;
}

function layerOf(value: SceneParticle): SceneLayer {
  return {
    id: 2,
    object: 1,
    parent: null,
    name: "p",
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
    particle: value,
  };
}

function bundleOf(value: SceneParticle, bindings: SceneBinding[] = []): SceneBundle {
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
    layers: [layerOf(value)],
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
    bindings,
    scripts: { list: [] },
  };
}

/** 属性 `r` 绑 `rate`、`n` 绑 `count`（同编译期登记的形状）。 */
const RATE = { property: "r", target: { kind: "particle-instance", object: 1, field: "rate" } } as const;
const COUNT = { property: "n", target: { kind: "particle-instance", object: 1, field: "count" } } as const;

async function open(instance: JsonObject = {}, prepare?: (state: SceneState) => void) {
  const bundle = bundleOf(particle(instance), [RATE, COUNT]);
  const state = SceneState.fromBundle(bundle);
  prepare?.(state);
  const scene = await GpuScene.build(fakeDevice(), bundle, state, new Set(), [], { particles: { seed: 1 } });
  const system = (scene as unknown as { trees: Map<number, { system: ParticleSystem }> }).trees.get(1)!.system;
  let time = 0;
  /** 一帧，顺序同渲染器：sync → 步进粒子（脚本与第二次 sync 由各用例自己做）。 */
  const step = (frametime = 0.1) => {
    time += frametime;
    scene.sync(state);
    scene.stepParticles(frametime, time, state, [0.5, 0.5]);
  };
  return { bundle, state, scene, system, step };
}

/** 模拟器内部：步进率与 initializer 字段（私有字段）。 */
const internals = (system: ParticleSystem) =>
  system as unknown as { rate: number; initializers: { name: string; fields: ParticleFields }[] };
const timescaleOf = (system: ParticleSystem) =>
  internals(system).initializers.find((module) => module.name === "turbulentvelocityrandom")!.fields.timescale;

beforeEach(() => {
  vi.stubGlobal("GPUTextureUsage", { RENDER_ATTACHMENT: 1, TEXTURE_BINDING: 2, COPY_SRC: 4, COPY_DST: 8 });
  vi.stubGlobal("GPUBufferUsage", { VERTEX: 1, UNIFORM: 2, COPY_DST: 4, MAP_READ: 8, INDEX: 16 });
  vi.stubGlobal("GPUMapMode", { READ: 1 });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("SceneState：rate 不标脏，另记 rates（rea-p4f-script.md 5.4）", () => {
  it("写 rate 只进 rates、保留原值（不钳制）；写别的系数进 particles；同一帧两边都写时两边都有", () => {
    const state = SceneState.fromBundle(bundleOf(particle()));
    state.takeDirty();
    expect(state.write(RATE, 0)).toBe("applied");
    expect(state.particleInstances.get(1)!.rate).toBe(0);
    let dirty = state.takeDirty();
    expect([[...dirty.rates], [...dirty.particles]]).toEqual([[1], []]);
    state.write(RATE, -2);
    expect(state.particleInstances.get(1)!.rate).toBe(-2);
    state.write(COUNT, 2);
    dirty = state.takeDirty();
    expect([[...dirty.rates], [...dirty.particles]]).toEqual([[1], [1]]);
    state.write(COUNT, 3);
    dirty = state.takeDirty();
    expect([[...dirty.rates], [...dirty.particles]]).toEqual([[], [1]]);
    // 取走即清空
    expect(state.takeDirty().rates.size).toBe(0);
  });

  it("用户属性改 rate 走同一条路：planApply 分到就地一侧，写入只进 rates", () => {
    const bundle = bundleOf(particle(), [RATE, COUNT]);
    const state = SceneState.fromBundle(bundle);
    const plan = planApply(bundle.bindings, new Map([["r", 0]]));
    expect(plan.recompile).toEqual([]);
    for (const write of plan.writes) state.write(write.binding, write.value);
    const dirty = state.takeDirty();
    expect([[...dirty.rates], [...dirty.particles]]).toEqual([[1], []]);
    expect(state.particleInstances.get(1)!.rate).toBe(0);
  });

  it("加载时 rate 钳到 0.01（6.1）：fromBundle 的起始值是钳过的", () => {
    expect(SceneState.fromBundle(bundleOf(particle({ rate: 0 }))).particleInstances.get(1)!.rate).toBe(0.01);
    expect(SceneState.fromBundle(bundleOf(particle({ rate: 0.25 }))).particleInstances.get(1)!.rate).toBe(0.25);
  });
});

describe("GpuScene.sync：先 setRate、再 setInstance，钳过的 rate 写回状态", () => {
  it("只写 rate 0：步进率 0、整棵树冻结，状态保留原值，timescale 不跟", async () => {
    const { state, system, step } = await open();
    step();
    step();
    expect(system.alive).toBe(2);
    const x = system.columns.position[0][0];
    state.write(RATE, 0);
    step();
    step();
    expect(internals(system).rate).toBe(0);
    expect([system.alive, system.columns.position[0][0]]).toEqual([2, x]);
    expect(state.particleInstances.get(1)!.rate).toBe(0);
    expect(timescaleOf(system)).toBe(2);
    // 解冻
    state.write(RATE, 1);
    step();
    expect(system.alive).toBe(3);
  });

  it("只写 rate 3：timescale 仍是上一次重算的值；之后写 count（置脏重算）才跟上", async () => {
    const { state, system, step } = await open();
    state.write(RATE, 3);
    step();
    expect(internals(system).rate).toBe(3);
    expect(timescaleOf(system)).toBe(2);
    state.write(COUNT, 1);
    step();
    expect(timescaleOf(system)).toBe(6);
    expect(state.particleInstances.get(1)!.rate).toBe(3);
  });

  it("同一帧写 rate 0 与 count：结果是钳过的 0.01（不冻结），并写回状态", async () => {
    const { state, system, step } = await open();
    state.write(RATE, 0);
    state.write(COUNT, 2);
    step();
    expect(internals(system).rate).toBe(Math.fround(0.01));
    expect(system.instanceScalar("rate")).toBe(0.01);
    expect(state.particleInstances.get(1)!.rate).toBe(0.01);
    expect(timescaleOf(system)).toBe(Math.fround(2 * Math.fround(0.01)));
  });

  it("每帧写同一个 count（字段脚本每帧都写）：每帧都重算，rate 每帧都钳；单写 rate 不触发重算", async () => {
    const { state, system, step } = await open();
    const setInstance = vi.spyOn(system, "setInstance");
    const setRate = vi.spyOn(system, "setRate");
    for (let i = 0; i < 3; i++) {
      state.write(COUNT, 1);
      step();
    }
    expect([setInstance.mock.calls.length, setRate.mock.calls.length]).toEqual([3, 0]);
    state.write(RATE, 0.005);
    step();
    expect([setInstance.mock.calls.length, setRate.mock.calls.length]).toEqual([3, 1]);
    expect(internals(system).rate).toBe(Math.fround(0.005));
    state.write(COUNT, 1);
    step();
    expect(state.particleInstances.get(1)!.rate).toBe(0.01);
    // sync 里的顺序：setRate 在 setInstance 之前
    state.write(RATE, 0);
    state.write(COUNT, 1);
    step();
    expect(setRate.mock.invocationCallOrder.at(-1)!).toBeLessThan(setInstance.mock.invocationCallOrder.at(-1)!);
  });

  it("建树时的钳制写回状态（单图层重建时状态里可能是 setRate 单写的 0）", async () => {
    const { state, system } = await open({}, (value) => (value.particleInstances.get(1)!.rate = 0));
    expect(system.instanceScalar("rate")).toBe(0.01);
    expect(state.particleInstances.get(1)!.rate).toBe(0.01);
  });
});
