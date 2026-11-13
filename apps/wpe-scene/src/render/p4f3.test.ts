/**
 * P4f 步骤 3 的渲染器接线单测（假设备照 `render/p4f1.test.ts`）：`GpuScene.particleScript` 把粒子层的脚本方法接到根系统、`emitParticles`
 * 带这一层最近一次交给根系统的控制点输入（`ParticleTree.inputs`）、`stop` / `emitParticles` 标 `stale`；重编译换上新场景时沿用旧场景的
 * 暂停 / 停止（`adoptParticleScripts`）；`sync` 把实例覆盖的控制点交给模拟器（`setInstance` → `applyOverrides`）；同一段脚本里先写的
 * 系数对随后 `emitParticles` 的这批不生效（脏位下一帧才消费，实测 b-emit-alpha）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generalDefaults, type SceneBinding } from "../compile/bindings";
import type { SceneBundle, SceneLayer, ScenePass } from "../compile/bundle";
import type { JsonObject } from "../compile/model";
import { parseParticle, particleFov, type SceneParticle } from "../compile/particles";
import { BLOOM_DEFAULTS } from "../compile/postprocess";
import type { ParticleSystem } from "../particles/system";
import type { TranslateResult } from "../wpesl2wgsl";
import { worldMatrixOf } from "./layout";
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

/** 粒子层 1：每秒 10 个、寿命 100、速度 (100, 0, 0) 匀速移动；`extra` 覆盖系统级键，`instance` 是 `instanceoverride`。 */
function particle(instance: JsonObject = {}, extra: JsonObject = {}): SceneParticle {
  const result = parseParticle(
    {
      maxcount: 16,
      emitter: [{ name: "sphererandom", distancemin: 0, distancemax: 0, rate: 10 }],
      initializer: [
        { name: "lifetimerandom", min: 100, max: 100 },
        { name: "velocityrandom", min: "100 0 0", max: "100 0 0" },
      ],
      operator: [{ name: "movement" }],
      ...extra,
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

const CP1 = { property: "p", target: { kind: "particle-instance", object: 1, field: "controlpoint0" } } as const;
const ALPHA = { property: "a", target: { kind: "particle-instance", object: 1, field: "alpha" } } as const;

interface Internals {
  trees: Map<number, { system: ParticleSystem; inputs: { world: Float32Array; pointer: readonly [number, number] } }>;
  drawsByLayer: Map<number, { particles?: { stale: boolean } }[]>;
}
const internals = (scene: GpuScene) => scene as unknown as Internals;

async function open(instance: JsonObject = {}, extra: JsonObject = {}, origin: number[] = [0, 0, 0]) {
  const bundle = bundleOf(particle(instance, extra), [CP1, ALPHA]);
  bundle.layers[0].origin = origin;
  const state = SceneState.fromBundle(bundle);
  const scene = await GpuScene.build(fakeDevice(), bundle, state, new Set(), [], { particles: { seed: 1 } });
  const system = internals(scene).trees.get(1)!.system;
  let time = 0;
  /** 一帧的前半（同渲染器）：sync → 步进粒子；脚本阶段与第二次 sync 由各用例自己做。 */
  const step = (frametime = 0.1) => {
    time += frametime;
    scene.sync(state);
    scene.stepParticles(frametime, time, state, [0.5, 0.5]);
  };
  const stale = () =>
    internals(scene)
      .drawsByLayer.get(1)!
      .map((draw) => draw.particles?.stale);
  const clearStale = () => {
    for (const draw of internals(scene).drawsByLayer.get(1)!) if (draw.particles) draw.particles.stale = false;
  };
  return { bundle, state, scene, system, step, stale, clearStale };
}

beforeEach(() => {
  vi.stubGlobal("GPUTextureUsage", { RENDER_ATTACHMENT: 1, TEXTURE_BINDING: 2, COPY_SRC: 4, COPY_DST: 8 });
  vi.stubGlobal("GPUBufferUsage", { VERTEX: 1, UNIFORM: 2, COPY_DST: 4, MAP_READ: 8, INDEX: 16 });
  vi.stubGlobal("GPUMapMode", { READ: 1 });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("GpuScene.particleScript", () => {
  it("粒子层接到根系统，不是粒子层的对象为 null；五个方法各落到 script* / emitParticles", async () => {
    const { scene, system, step } = await open();
    expect(scene.particleScript(0)).toBeNull();
    const target = scene.particleScript(1)!;
    step();
    step();
    target.pause();
    expect(system.scriptPaused).toBe(true);
    expect(target.isPlaying()).toBe(false);
    target.play();
    expect(target.isPlaying()).toBe(true);
    target.emitParticles(3);
    expect(system.alive).toBe(5);
    target.stop();
    expect([system.alive, system.scriptStopped, target.isPlaying()]).toEqual([0, true, false]);
  });

  it("stop 与 emitParticles 标 stale（暂停中补画的帧也重写顶点）；play / pause 不标", async () => {
    const { scene, step, stale, clearStale } = await open();
    step();
    clearStale();
    const target = scene.particleScript(1)!;
    target.pause();
    target.play();
    expect(stale()).toEqual([false]);
    target.emitParticles(1);
    expect(stale()).toEqual([true]);
    clearStale();
    target.stop();
    expect(stale()).toEqual([true]);
  });

  it("emitParticles 带这一层最近一次交给根系统的控制点输入（stepParticles 记下，可见与不可见都记）", async () => {
    const { scene, state, step, system } = await open({}, {}, [100, 50, 0]);
    const tree = internals(scene).trees.get(1)!;
    step();
    const world = worldMatrixOf(1, state.layers, new Map());
    expect(Array.from(tree.inputs.world)).toEqual(Array.from(world));
    const emit = vi.spyOn(system, "emitParticles");
    scene.particleScript(1)!.emitParticles(2);
    expect(emit).toHaveBeenCalledWith(2, tree.inputs);
    // 不可见时同样换成这一帧的
    state.layers.get(1)!.origin = [10, 0, 0];
    state.layers.get(1)!.visible = false;
    step();
    expect(Array.from(tree.inputs.world)).toEqual(Array.from(worldMatrixOf(1, state.layers, new Map())));
  });

  it("同一段脚本里先写的系数对这一批不生效：写进状态、下一次 sync 才重算（实测 b-emit-alpha）", async () => {
    const { scene, state, step, system } = await open();
    step();
    state.write(ALPHA, 0.3);
    scene.particleScript(1)!.emitParticles(1);
    expect(system.columns.alpha0[system.highWater - 1]).toBe(1);
    step();
    scene.particleScript(1)!.emitParticles(1);
    expect(system.columns.alpha0[system.highWater - 1]).toBe(Math.fround(0.3));
  });
});

describe("GpuScene：实例覆盖的控制点经 sync 进模拟器（rea-p4f-script.md 5.5）", () => {
  it("属性改 controlpoint0：下一次 sync 写进根系统控制点的 base，之后出生的粒子从新位置出", async () => {
    const { state, step, system } = await open();
    step();
    state.write(CP1, "30 40 0");
    step();
    expect(Array.from(system.controlPoints.current(0).translation)).toEqual([30, 40, 0]);
    const slot = system.highWater - 1;
    // 本帧新粒子：出生在 (30, 40)，operator 走了一步（速度 100，h = 0.1）
    expect([system.columns.position[0][slot], system.columns.position[1][slot]]).toEqual([40, 40]);
  });
});

describe("重编译：新场景沿用旧场景的脚本暂停 / 停止（adoptParticleScripts）", () => {
  it("旧树被 stop 停下：新树照样停下（预热出来的粒子清掉、发射器结束）；暂停位照抄", async () => {
    const old = await open({}, { starttime: 1 });
    old.step();
    old.scene.particleScript(1)!.stop();
    old.scene.particleScript(1)!.pause();
    const fresh = await open({}, { starttime: 1 });
    expect(fresh.system.alive).toBeGreaterThan(0);
    fresh.scene.adoptParticleScripts(old.scene);
    expect([fresh.system.alive, fresh.system.scriptStopped, fresh.system.scriptPaused]).toEqual([0, true, true]);
    fresh.step();
    expect(fresh.system.alive).toBe(0);
  });

  it("旧树只暂停：新树带着暂停位，不发射", async () => {
    const old = await open();
    old.scene.particleScript(1)!.pause();
    const fresh = await open();
    fresh.scene.adoptParticleScripts(old.scene);
    fresh.step();
    expect([fresh.system.alive, fresh.system.scriptPaused, fresh.system.scriptStopped]).toEqual([0, true, false]);
  });
});
