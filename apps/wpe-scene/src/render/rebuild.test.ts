import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generalDefaults, type GeneralKey, type GeneralValues } from "../compile/bindings";
import {
  FRAMEBUFFER_RT,
  type SceneBundle,
  type SceneEffect,
  type SceneEffectStep,
  type SceneFbo,
  type SceneLayer,
  type ScenePass,
  type SceneTexture,
} from "../compile/bundle";
import type { SceneScalar } from "../compile/model";
import { BLOOM_DEFAULTS, type BloomParams } from "../compile/postprocess";
import { hostRenderFrame, hostStats } from "../dev/probe";
import type { SceneHost } from "../host";
import type { TranslateResult } from "../wpesl2wgsl";
import type { BloomStep } from "./bloom";
import { acquireGpu } from "./device";
import { SceneRenderError } from "./errors";
import type { FboBindings } from "./graph";
import { eyePosition } from "./layout";
import { SceneRenderer } from "./renderer";
import { GpuScene, visibleObjects } from "./scene";
import { SceneState } from "./state";
import type { FrameInput } from "./uniforms";

vi.mock("./device", () => ({ acquireGpu: vi.fn() }));

type Size = { width: number; height: number };
interface FakeTexture {
  label: string;
  format: GPUTextureFormat;
  width: number;
  height: number;
  createView(): { label: string };
  destroy(): void;
}
interface FakeBuffer {
  label: string;
  bytes: Uint8Array;
  destroy(): void;
}

/**
 * 假设备：记录创建次数、存活的缓冲、写进缓冲的字节与提交的清屏。错误作用域按 WebGPU 的规则成栈：
 * 校验错误落到最近的 validation 作用域，没有作用域时算未捕获（真机上走 `onuncapturederror`）。
 */
class FakeGpu {
  readonly counts = { buffers: 0, textures: 0, pipelines: 0, modules: 0 };
  readonly live = new Set<FakeBuffer>();
  readonly textures: FakeTexture[] = [];
  readonly trace: string[] = [];
  /** 已提交的清屏：`目标 清屏色`。 */
  readonly cleared: string[] = [];
  /** 已提交的纹理拷贝：`源 -> 目标`。 */
  readonly copied: string[] = [];
  readonly scopes: { filter: string; error: string | null }[] = [];
  /** 每条校验错误报出时的作用域栈（由外到内）。 */
  readonly errorStacks: string[][] = [];
  readonly uncaptured: string[] = [];
  encoders = 0;
  /** 让纹理建失败（报 out-of-memory）；参数是 label。 */
  failTexture: (label: string) => boolean = () => false;
  /** 让管线建失败；参数是「label + 写掩码」。 */
  failPipeline: (label: string) => boolean = () => false;
  readonly device: GPUDevice;

  private report(message: string, filter = "validation"): void {
    this.errorStacks.push(this.scopes.map((item) => item.filter));
    const scope = [...this.scopes].reverse().find((item) => item.filter === filter);
    if (scope) scope.error ??= message;
    else this.uncaptured.push(message);
  }

  constructor() {
    const pass = () => ({
      setViewport: () => {},
      setPipeline: (pipeline: { label: string }) => this.trace.push(`pipeline ${pipeline.label}`),
      setBindGroup: (_index: number, group: { key: string }) => this.trace.push(`bind ${group.key}`),
      setVertexBuffer() {},
      draw() {},
      end() {},
    });
    this.device = {
      limits: { maxTextureDimension2D: 8192 },
      lost: new Promise(() => {}),
      destroy() {},
      createTexture: (descriptor: GPUTextureDescriptor) => {
        if (this.failTexture(descriptor.label ?? "")) this.report("out of memory", "out-of-memory");
        this.counts.textures++;
        const { width, height } = descriptor.size as Size;
        const texture: FakeTexture = {
          label: descriptor.label ?? "",
          format: descriptor.format,
          width,
          height,
          createView: () => ({ label: descriptor.label ?? "" }),
          destroy() {},
        };
        this.textures.push(texture);
        return texture;
      },
      createSampler: (descriptor: GPUSamplerDescriptor = {}) => ({ key: JSON.stringify(descriptor) }),
      createBuffer: (descriptor: GPUBufferDescriptor) => {
        this.counts.buffers++;
        const buffer: FakeBuffer = {
          label: descriptor.label ?? "",
          bytes: new Uint8Array(descriptor.size),
          destroy: () => this.live.delete(buffer),
        };
        this.live.add(buffer);
        // 探针读回用的三个方法
        return Object.assign(buffer, {
          mapAsync: async () => {},
          getMappedRange: () => buffer.bytes.buffer,
          unmap() {},
        });
      },
      createShaderModule: (descriptor: GPUShaderModuleDescriptor) => {
        this.counts.modules++;
        const broken = descriptor.code.includes("BAD");
        // 同 WebGPU：坏 WGSL 照样返回模块，同时报一条校验错误。`SCOPE` 只报校验错误，编译消息干净
        if (broken || descriptor.code.includes("SCOPE")) this.report(`模块 ${descriptor.label} 无效`);
        return {
          getCompilationInfo: async () => ({
            messages: broken ? [{ type: "error", lineNum: 2, linePos: 1, message: "坏着色器" }] : [],
          }),
        };
      },
      createBindGroupLayout: () => ({}),
      createPipelineLayout: () => ({}),
      createRenderPipeline: () => {
        this.counts.pipelines++;
        return { getBindGroupLayout: () => ({}) };
      },
      createRenderPipelineAsync: async (descriptor: GPURenderPipelineDescriptor) => {
        this.counts.pipelines++;
        const label = `${descriptor.label} ${[...descriptor.fragment!.targets][0]?.writeMask}`;
        if (this.failPipeline(label)) throw new Error("管线建失败");
        return { label };
      },
      createBindGroup: (descriptor: GPUBindGroupDescriptor) => ({
        key: [...descriptor.entries]
          .map(({ binding, resource }) => {
            const item = resource as { label?: string; key?: string; buffer?: unknown };
            return `${binding}:${item.buffer ? "uniform" : (item.label ?? item.key)}`;
          })
          .join(","),
      }),
      createCommandEncoder: () => {
        this.encoders++;
        const clears: string[] = [];
        const copies: string[] = [];
        return {
          beginRenderPass: (descriptor: GPURenderPassDescriptor) => {
            const attachment = [...descriptor.colorAttachments][0]!;
            const { label } = attachment.view as unknown as { label: string };
            const clearValue = attachment.loadOp === "clear" ? ` ${JSON.stringify(attachment.clearValue)}` : "";
            this.trace.push(`pass ${label} ${attachment.loadOp}${clearValue}`);
            if (attachment.loadOp === "clear") clears.push(`${label} ${JSON.stringify(attachment.clearValue)}`);
            return pass();
          },
          copyTextureToTexture: (
            source: { texture: { label: string } },
            destination: { texture: { label: string } },
          ) => {
            const copy = `${source.texture.label} -> ${destination.texture.label}`;
            this.trace.push(`copy ${copy}`);
            copies.push(copy);
          },
          copyTextureToBuffer: (source: { texture: { label: string } }) =>
            this.trace.push(`readback ${source.texture.label}`),
          finish: () => ({ clears, copies }),
        };
      },
      queue: {
        writeBuffer: (buffer: FakeBuffer, _offset: number, data: ArrayBuffer) => {
          buffer.bytes = new Uint8Array(data.slice(0));
        },
        writeTexture() {},
        submit: (commands: { clears: string[]; copies: string[] }[]) => {
          for (const { clears, copies } of commands) {
            this.cleared.push(...clears);
            this.copied.push(...copies);
          }
        },
        onSubmittedWorkDone: async () => {},
      },
      pushErrorScope: (filter: string) => {
        this.scopes.push({ filter, error: null });
      },
      popErrorScope: async () => {
        const error = this.scopes.pop()?.error ?? null;
        return error === null ? null : { message: error };
      },
    } as unknown as GPUDevice;
  }
}

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

/** 程序下标：基础、三个 effect、passthrough。 */
const P = { base: 0, a: 1, b: 2, c: 3, passthrough: 4 };
const programs = (): TranslateResult[] => [
  program("base"),
  program("a"),
  program("b"),
  program("c"),
  program("passthrough"),
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
): SceneEffectStep => ({
  kind: "draw",
  pass: scenePass,
  target: null,
  compose: false,
  binds: null,
  ...extra,
});

const fbo = (name: string, extra: Partial<SceneFbo> = {}): SceneFbo => ({
  name,
  format: "rgba8888",
  scale: 2,
  unique: false,
  repeat: false,
  ...extra,
});

/** 一个可变 effect。`source` 是 JSON 下标，故意和 bundle 下标不同的用例要显式传。 */
function effect(
  source: number,
  enabled: boolean,
  steps: SceneEffectStep[],
  extra: Partial<SceneEffect> = {},
): SceneEffect {
  return {
    source,
    id: 100 + source,
    name: `effect ${source}`,
    file: `effects/${source}/effect.json`,
    fbos: [],
    steps,
    enabled,
    visibleBound: true,
    unsupported: [],
    ...extra,
  };
}

const texture = (width: number, height: number): SceneTexture => ({
  path: `t${width}x${height}`,
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

function layer(object: number, effects: SceneEffect[], extra: Partial<SceneLayer> = {}): SceneLayer {
  return {
    id: object + 1,
    object,
    parent: null,
    name: `layer ${object}`,
    origin: [10, 20, 0],
    scale: [1, 1, 1],
    angles: [0, 0, 0],
    size: [128, 64],
    alpha: 0.5,
    color: [0.2, 0.4, 0.6],
    brightness: 1,
    visible: true,
    visibleBound: false,
    solidLayer: false,
    passes: [pass(`objects/${object}/passes/0`, P.base, { textures: { 0: 0 } })],
    colorBlendMode: 0,
    effects,
    passthrough: null,
    particle: null,
    ...extra,
  };
}

function bundleOf(layers: SceneLayer[], overrides: Partial<SceneBundle> = {}): SceneBundle {
  return {
    general: {
      width: 256,
      height: 128,
      fields: { ...generalDefaults(), ambientcolor: [0.1, 0.1, 0.1], skylightcolor: [0.2, 0.2, 0.2] },
      clearVariable: false,
      perspectiveOverrideFov: (95 * Math.PI) / 180,
      postprocess: { level: "disabled", bloomFlag: false, hdrFlag: false, bloom: false, hdr: false },
      bloom: { ...BLOOM_DEFAULTS, tint: [1, 1, 1] },
    },
    layers,
    programs: programs(),
    textures: [texture(128, 64)],
    bloom: null,
    unsupported: [],
    bindings: [],
    scripts: { list: [] },
    ...overrides,
  };
}

const FEATURES = new Set<string>();
const FRAME: FrameInput = { time: 1.5, frametime: 1 / 60, daytime: 0.5, pointer: [0.25, 0.75], pointerLast: [0, 0] };

/** 一个跑起来的场景与它的假设备、状态、警告。`setup` 在建场景之前改假设备。 */
async function open(bundle: SceneBundle, setup?: (gpu: FakeGpu) => void) {
  const gpu = new FakeGpu();
  setup?.(gpu);
  const state = SceneState.fromBundle(bundle);
  const warnings: string[] = [];
  const scene = await GpuScene.build(gpu.device, bundle, state, FEATURES, warnings);
  return { gpu, state, scene, warnings };
}
type Live = Awaited<ReturnType<typeof open>>;

/** 用这份 bundle 整场建一次，作为「就地 = 重编译」的对照。 */
async function fresh(bundle: SceneBundle): Promise<Live> {
  const live = await open(bundle);
  live.scene.update(FRAME);
  return live;
}

/** 写 effect 开关：`source` 是 JSON 下标，同绑定目标。 */
const toggle = (state: SceneState, object: number, source: number, value: boolean) =>
  state.write({ property: "p", target: { kind: "effect", object, effect: source } }, value);

/** 下一帧：`sync` 同步换上，再写每帧内置量。 */
function advance({ scene, state }: Live): void {
  scene.sync(state);
  scene.update(FRAME);
}

interface DrawView {
  label: string;
  passKey: string;
  pipeline: { label: string };
  vertexBuffer: FakeBuffer;
  uniformBuffer: FakeBuffer;
  dirty: boolean;
}
interface RuntimeView {
  object: number;
  signature: string;
  ops: ({ kind: "draw"; draw: DrawView } | { kind: "snapshot" | "copy" | "swap"; effect?: number })[];
  draws: DrawView[];
  resources: { composites: { texture: FakeTexture }[]; fbos: FboBindings };
}
const internals = (scene: GpuScene) =>
  scene as unknown as {
    layers: RuntimeView[];
    owned: Set<unknown>;
    draws: Set<unknown>;
    drawsByPass: Map<string, unknown[]>;
    snapshot: unknown;
    readyPipelines: Map<string, unknown>;
  };

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

/** 逐图层的步骤序列与缓冲里的字节，外加一帧的编码轨迹（目标、管线、bind group、拷贝）。 */
function capture({ gpu, scene, state }: Live) {
  const layers = internals(scene).layers.map(({ object, signature, ops }) => ({
    object,
    signature,
    ops: ops.map((op) =>
      op.kind === "draw"
        ? {
            kind: op.kind,
            label: op.draw.label,
            pass: op.draw.passKey,
            pipeline: op.draw.pipeline.label,
            uniform: hex(op.draw.uniformBuffer.bytes),
            vertex: hex(op.draw.vertexBuffer.bytes),
          }
        : { kind: op.kind, effect: op.effect },
    ),
  }));
  gpu.trace.length = 0;
  scene.encode(gpu.device.createCommandEncoder(), state);
  return { layers, trace: [...gpu.trace] };
}

const PASSTHROUGH: Partial<SceneLayer> = {
  colorBlendMode: 5,
  passthrough: pass("objects/0/passthrough", P.passthrough, { uniforms: { g_Color4: [1, 1, 1, 1] } }),
};

/**
 * 两个可变 effect 的图层：第一个画进合成 RT；第二个先画进 fbo，再读 fbo 画一步。
 * JSON 下标是 0 与 2（中间那个写死关闭、不进 bundle），bundle 下标是 0 与 1，两套混了用例就不成立。
 */
function twoEffects(enabled: [boolean, boolean], extra: Partial<SceneLayer> = {}, tint = [1, 1, 1]): SceneBundle {
  return bundleOf([
    layer(
      0,
      [
        effect(0, enabled[0], [draw(pass("objects/0/effects/0/passes/0", P.a))]),
        effect(
          2,
          enabled[1],
          [
            draw(pass("objects/0/effects/2/passes/0", P.b), { target: "blur" }),
            draw(pass("objects/0/effects/2/passes/1", P.c, { runtime: { 1: "blur" }, uniforms: { g_Tint: tint } })),
          ],
          { fbos: [fbo("blur")] },
        ),
      ],
      extra,
    ),
  ]);
}

/** 打开时才需要程序 b、c，第二张合成 RT 与快照。 */
function lazyEffect(enabled: boolean): SceneBundle {
  return bundleOf([
    layer(0, [
      effect(0, enabled, [
        draw(pass("objects/0/effects/0/passes/0", P.b)),
        draw(pass("objects/0/effects/0/passes/1", P.c, { runtime: { 1: FRAMEBUFFER_RT }, framebuffer: true })),
      ]),
    ]),
  ]);
}

beforeEach(() => {
  vi.stubGlobal("GPUTextureUsage", { RENDER_ATTACHMENT: 1, TEXTURE_BINDING: 2, COPY_SRC: 4, COPY_DST: 8 });
  vi.stubGlobal("GPUBufferUsage", { VERTEX: 1, UNIFORM: 2, COPY_DST: 4, MAP_READ: 8 });
  vi.stubGlobal("GPUMapMode", { READ: 1 });
});
afterEach(() => vi.unstubAllGlobals());

describe("effect 切换", () => {
  describe("就地 = 重编译", () => {
    const cases: [string, [boolean, boolean], [boolean, boolean], Partial<SceneLayer>][] = [
      ["关后一个", [true, true], [true, false], {}],
      ["关前一个", [true, true], [false, true], {}],
      ["全关", [true, true], [false, false], {}],
      ["从全关打开", [false, false], [true, true], {}],
      ["passthrough：关后一个", [true, true], [true, false], PASSTHROUGH],
      ["passthrough：全关", [true, true], [false, false], PASSTHROUGH],
    ];
    it.each(cases)("%s，再回到原样", async (_name, from, to, extra) => {
      const live = await open(twoEffects(from, extra));
      toggle(live.state, 0, 0, to[0]);
      toggle(live.state, 0, 2, to[1]);
      advance(live);
      expect(capture(live)).toEqual(capture(await fresh(twoEffects(to, extra))));

      toggle(live.state, 0, 0, from[0]);
      toggle(live.state, 0, 2, from[1]);
      advance(live);
      expect(capture(live)).toEqual(capture(await fresh(twoEffects(from, extra))));
    });

    it("copy 与 swap 步骤照新计划排", async () => {
      const bundle = (enabled: boolean) =>
        bundleOf([
          layer(0, [
            effect(
              0,
              enabled,
              [
                draw(pass("objects/0/effects/0/passes/0", P.a), { target: "a" }),
                { kind: "copy", source: "a", target: "b" },
                { kind: "swap", source: "a", target: "b" },
                draw(pass("objects/0/effects/0/passes/1", P.b, { runtime: { 1: "b" } })),
              ],
              { fbos: [fbo("a"), fbo("b")] },
            ),
          ]),
        ]);
      const live = await open(bundle(false));
      toggle(live.state, 0, 0, true);
      advance(live);
      expect(capture(live)).toEqual(capture(await fresh(bundle(true))));
    });

    it("关着时改常量或图层字段，再打开，字节等于用新值整场编译", async () => {
      const live = await open(twoEffects([true, false]));
      const { state, scene } = live;
      state.write(
        {
          property: "c",
          target: {
            kind: "constant",
            pass: "objects/0/effects/2/passes/1",
            material: "tint",
            uniforms: ["g_Tint"],
            type: "vec3",
          },
        },
        "0 1 0",
      );
      state.write({ property: "a", target: { kind: "layer", object: 0, field: "alpha" } }, 0.25);
      state.write({ property: "o", target: { kind: "layer", object: 0, field: "origin" } }, "30 40 0");
      scene.sync(state);
      toggle(state, 0, 2, true);
      advance(live);
      expect(capture(live)).toEqual(
        capture(await fresh(twoEffects([true, true], { alpha: 0.25, origin: [30, 40, 0] }, [0, 1, 0]))),
      );
    });
  });

  describe("同步切换", () => {
    it("sync 返回时 op 已换上", async () => {
      const live = await open(twoEffects([true, true]));
      const { scene, state } = live;
      const before = internals(scene).layers[0].ops;
      toggle(state, 0, 2, false);
      scene.sync(state);
      // 同一个调用栈里就是新结构，中间没有 await
      const after = internals(scene).layers[0].ops;
      expect(after).not.toBe(before);
      expect(after.filter((op) => op.kind === "draw")).toHaveLength(2);
      scene.update(FRAME);
      expect(capture(live)).toEqual(capture(await fresh(twoEffects([true, false]))));
    });

    const sequence: [boolean, boolean][] = [
      [true, false],
      [false, true],
      [true, true],
      [false, false],
      [true, true],
      [false, true],
    ];
    it.each<[string, Partial<SceneLayer>]>([
      ["普通", {}],
      ["passthrough", PASSTHROUGH],
      ["colorBlendMode 31", { colorBlendMode: 31 }],
    ])("%s：任意组合之间切换都不建程序与管线", async (_name, extra) => {
      const live = await open(twoEffects([false, false], extra));
      const { gpu, scene, state } = live;
      const { modules, pipelines } = gpu.counts;
      for (const [a, b] of sequence) {
        toggle(state, 0, 0, a);
        toggle(state, 0, 2, b);
        scene.sync(state);
        expect(capture(live).layers[0].ops.length).toBeGreaterThan(0);
      }
      expect(gpu.counts.modules).toBe(modules);
      expect(gpu.counts.pipelines).toBe(pipelines);
      expect(gpu.uncaptured).toEqual([]);
    });

    it("同一次 sync 既切开关又改字段：刷新落在新 draw 上", async () => {
      const live = await open(twoEffects([true, true]));
      const { scene, state } = live;
      const old = internals(scene).layers[0].draws;
      toggle(state, 0, 2, false);
      state.write({ property: "a", target: { kind: "layer", object: 0, field: "alpha" } }, 0.25);
      scene.sync(state);
      expect(old.some((item) => item.dirty)).toBe(false);
      expect(internals(scene).layers[0].draws.every((item) => item.dirty)).toBe(true);
      scene.update(FRAME);
      expect(capture(live)).toEqual(capture(await fresh(twoEffects([true, false], { alpha: 0.25 }))));
    });

    it("重复开关 1000 次，存活的缓冲数不增长", async () => {
      const live = await open(twoEffects([true, true]));
      const { gpu, scene, state } = live;
      const { owned, draws, drawsByPass } = internals(scene);
      const counts = () => ({
        buffers: gpu.live.size,
        owned: owned.size,
        draws: draws.size,
        byPass: [...drawsByPass.values()].flat().length,
      });
      const before = counts();
      for (let i = 0; i < 1000; i++) {
        toggle(state, 0, 2, i % 2 === 1);
        advance(live);
      }
      expect(counts()).toEqual(before);
    });

    it("别的图层的 op 与缓冲不变", async () => {
      const bundle = twoEffects([true, true]);
      bundle.layers.push(layer(1, []));
      const live = await open(bundle);
      const { gpu, scene, state } = live;
      const { ops, draws } = internals(scene).layers[1];
      toggle(state, 0, 2, false);
      advance(live);
      const other = internals(scene).layers[1];
      expect(other.ops).toBe(ops);
      expect(other.draws).toBe(draws);
      expect(gpu.live.has(draws[0].uniformBuffer)).toBe(true);
    });

    it("计划没变（关掉没有步骤的 effect）：不重建", async () => {
      const bundle = bundleOf([
        layer(0, [effect(0, true, [draw(pass("objects/0/effects/0/passes/0", P.a))]), effect(1, true, [])]),
      ]);
      const live = await open(bundle);
      const { ops } = internals(live.scene).layers[0];
      toggle(live.state, 0, 1, false);
      advance(live);
      expect(internals(live.scene).layers[0].ops).toBe(ops);
    });

    it("没建 GPU 资源的图层（写死不可见）：开关什么都不做", async () => {
      const live = await open(twoEffects([true, true], { visible: false }));
      expect(internals(live.scene).layers).toEqual([]);
      toggle(live.state, 0, 2, false);
      expect(() => advance(live)).not.toThrow();
    });
  });

  describe("加载时备好", () => {
    it("打开时才用到的程序、管线、第二张合成 RT、快照都在加载时建好", async () => {
      const live = await open(lazyEffect(false));
      const { gpu, scene, state } = live;
      expect(gpu.counts.modules).toBe(6);
      expect(internals(scene).snapshot).not.toBeNull();
      expect(internals(scene).layers[0].resources.composites).toHaveLength(2);
      const counts = { ...gpu.counts };
      toggle(state, 0, 0, true);
      advance(live);
      const result = capture(live);
      expect(result.trace).toContain("copy scene target -> _rt_FullFrameBuffer");
      expect(result).toEqual(capture(await fresh(lazyEffect(true))));
      toggle(state, 0, 0, false);
      advance(live);
      toggle(state, 0, 0, true);
      advance(live);
      expect(gpu.counts.modules).toBe(counts.modules);
      expect(gpu.counts.textures).toBe(counts.textures);
      expect(gpu.counts.pipelines).toBe(counts.pipelines);
    });

    it("全部 effect 关着的图层，fbo 按真实合成尺寸建", async () => {
      const { gpu } = await open(twoEffects([false, false]));
      const target = gpu.textures.find((item) => item.label.startsWith("fbo "));
      expect(target).toMatchObject({ width: 64, height: 32 }); // 合成 128×64，scale 2
    });

    it("关着且带不支持项的 effect 不算可变：不碰它的程序，图层不冻结", async () => {
      const bundle = twoEffects([true, false]);
      bundle.layers[0].effects[1].unsupported = ["effect:custom:custom"];
      bundle.programs[P.b] = program("BAD");
      bundle.programs[P.c] = program("BAD");
      const live = await open(bundle);
      expect(live.warnings).toEqual([]);
      expect(live.gpu.counts.modules).toBe(4); // 基础 + a
      expect(toggle(live.state, 0, 0, false)).toBe("applied");
      advance(live);
      expect(capture(live).layers[0].ops.map((op) => op.kind)).toEqual(["draw"]);
    });
  });

  describe("预建失败", () => {
    const closed = () => twoEffects([true, false]);
    const cases: [string, (bundle: SceneBundle) => void, string][] = [
      [
        "Tint 失败",
        (bundle) => {
          bundle.programs[P.b] = program("BAD");
        },
        `webgpu:shader:${P.b}:`,
      ],
      [
        "只有校验错误、编译消息干净",
        (bundle) => {
          bundle.programs[P.b] = program("SCOPE");
        },
        `scene program ${P.b}`,
      ],
      [
        "程序缺失",
        (bundle) => {
          const step = bundle.layers[0].effects[1].steps[0];
          if (step.kind === "draw") step.pass.program = null;
        },
        "render:no-program",
      ],
    ];

    /** 加载没失败、错误没漏出去、当前画面不受影响，这一层切换都要整场重编译。 */
    async function expectFrozen(live: Live, source: string, message: string, baseline: SceneBundle) {
      const { gpu, scene, state, warnings } = live;
      expect(gpu.uncaptured).toEqual([]);
      expect(gpu.scopes).toEqual([]);
      expect(warnings).toEqual([expect.stringContaining(message)]);
      expect(warnings[0]).toContain("图层 0 的可变 effect 备不好");
      scene.update(FRAME);
      expect(capture(live)).toEqual(capture(await fresh(baseline)));
      const { ops } = internals(scene).layers[0];
      expect(toggle(state, 0, Number(source), !state.effectEnabled(0, Number(source)))).toBe("recompile");
      scene.sync(state);
      expect(internals(scene).layers[0].ops).toBe(ops);
    }

    it.each(cases)("关着的 effect %s：加载不失败，图层冻结", async (_name, breakIt, message) => {
      const bundle = closed();
      breakIt(bundle);
      const live = await open(bundle);
      await expectFrozen(live, "2", message, closed());
      // 同一层的失败不细分到 effect：切另一个也走重编译
      expect(toggle(live.state, 0, 0, false)).toBe("recompile");
      expect(live.state.effectEnabled(0, 0)).toBe(true);
    });

    it("预建在 populate 的错误作用域弹出之后：坏 WGSL 只落在图层自己的作用域里", async () => {
      const bundle = closed();
      bundle.programs[P.b] = program("BAD");
      const { gpu } = await open(bundle);
      // 顶点、片元各一条。里层有图层自己的作用域，所以校验错误本来也到不了 populate，这里钉住的是调用顺序
      expect(gpu.errorStacks).toEqual([
        ["out-of-memory", "validation"],
        ["out-of-memory", "validation"],
      ]);
    });

    it("预建时显存不足：加载不失败，图层冻结", async () => {
      // 当前计划只用一张合成 RT，第二张是预建才要的
      const live = await open(closed(), (gpu) => {
        gpu.failTexture = (label) => label.startsWith("composite") && label.endsWith("#1");
      });
      await expectFrozen(live, "2", "out of memory", closed());
    });

    it("全部开着的 effect 都没有绘制 pass：切换时报出来，和整场加载一样退回", async () => {
      const bundle = twoEffects([true, false]);
      bundle.layers[0].effects.splice(1, 0, effect(1, false, []));
      const { scene, state } = await open(bundle);
      expect(toggle(state, 0, 1, true)).toBe("applied");
      expect(toggle(state, 0, 0, false)).toBe("applied");
      expect(() => scene.sync(state)).toThrow(SceneRenderError);
    });

    it("dev 强制渲染：开着且带不支持项的 effect 能就地关掉，前面的 effect 接着上屏", async () => {
      const bundle = twoEffects([true, true]);
      bundle.layers[0].effects[1].unsupported = ["effect:x"];
      const { scene, state } = await open(bundle);
      expect(toggle(state, 0, 2, false)).toBe("applied");
      expect(() => scene.sync(state)).not.toThrow();
      expect(toggle(state, 0, 2, true)).toBe("recompile");
    });

    it("关着的 effect 管线失败：加载不失败，图层冻结", async () => {
      const live = await open(closed(), (gpu) => {
        gpu.failPipeline = (label) => label.startsWith(`scene program ${P.b} `);
      });
      await expectFrozen(live, "2", `webgpu:pipeline:${P.b}:`, closed());
    });

    it("开着的 effect 只在切换后才用的角色管线失败：加载不失败，图层冻结", async () => {
      const bundle = () => twoEffects([true, true]);
      // a 现在是普通角色（写掩码 15），关掉后一个才上屏（写掩码 7）
      const live = await open(bundle(), (gpu) => {
        gpu.failPipeline = (label) => label === `scene program ${P.a} translucent rgba8unorm 7`;
      });
      await expectFrozen(live, "2", `webgpu:pipeline:${P.a}:`, bundle());
    });

    it("关着的 effect swap 尺寸不符：加载不失败，图层冻结", async () => {
      const bundle = (enabled: boolean) =>
        bundleOf([
          layer(0, [
            effect(
              0,
              enabled,
              [{ kind: "swap", source: "a", target: "b" }, draw(pass("objects/0/effects/0/passes/0", P.a))],
              { fbos: [fbo("a"), fbo("b", { scale: 4 })] },
            ),
          ]),
        ]);
      await expectFrozen(await open(bundle(false)), "0", "render:swap-mismatch:a:b", bundle(false));
      await expect(open(bundle(true))).rejects.toMatchObject({ reasons: ["render:swap-mismatch:a:b"] });
    });

    it("冻结只影响这一层", async () => {
      const bundle = closed();
      bundle.programs[P.b] = program("BAD");
      bundle.layers.push(layer(1, [effect(0, true, [draw(pass("objects/1/effects/0/passes/0", P.a))])]));
      const live = await open(bundle);
      expect(toggle(live.state, 0, 2, true)).toBe("recompile");
      expect(toggle(live.state, 1, 0, false)).toBe("applied");
      advance(live);
      expect(capture(live).layers[1].ops.map((op) => op.kind)).toEqual(["draw"]);
    });

    it("启用的 effect 失败照旧让加载失败", async () => {
      const bad = twoEffects([true, true]);
      bad.programs[P.b] = program("BAD");
      await expect(open(bad)).rejects.toMatchObject({ reasons: [expect.stringContaining(`webgpu:shader:${P.b}:`)] });
      const invalid = twoEffects([true, true]);
      invalid.programs[P.b] = program("SCOPE");
      await expect(open(invalid)).rejects.toMatchObject({ reasons: [expect.stringContaining("webgpu:validation:")] });
      await expect(
        open(twoEffects([true, true]), (gpu) => {
          gpu.failPipeline = (label) => label.startsWith(`scene program ${P.a} `);
        }),
      ).rejects.toMatchObject({ reasons: [expect.stringContaining(`webgpu:pipeline:${P.a}:`)] });
    });

    it("就绪表缺东西：sync 抛 render:variant-missing，不是别的错", async () => {
      const live = await open(closed());
      internals(live.scene).readyPipelines.clear();
      toggle(live.state, 0, 2, true);
      expect(() => live.scene.sync(live.state)).toThrow(
        expect.objectContaining({ reasons: ["render:variant-missing"] }),
      );
    });
  });

  describe("clear", () => {
    const KEPT = [0.1, 0.2, 0.3, 1];
    /**
     * 图层 0：effect 0 开着、不切，带 `kept`（有 clear）与 `plain`（没有）；effect 1 是要切的；effect 2 关着，带 `closed`（有 clear）。
     * 图层 1 有自己的 `other`（有 clear）。
     */
    const scene = () =>
      bundleOf([
        layer(0, [
          effect(
            0,
            true,
            [
              draw(pass("objects/0/effects/0/passes/0", P.a), { target: "kept" }),
              draw(pass("objects/0/effects/0/passes/1", P.a, { runtime: { 1: "kept" } })),
            ],
            { fbos: [fbo("kept", { clear: KEPT }), fbo("plain")] },
          ),
          effect(1, true, [draw(pass("objects/0/effects/1/passes/0", P.b))]),
          effect(
            2,
            false,
            [
              draw(pass("objects/0/effects/2/passes/0", P.c), { target: "closed" }),
              draw(pass("objects/0/effects/2/passes/1", P.c, { runtime: { 1: "closed" } })),
            ],
            { fbos: [fbo("closed", { clear: [0, 0, 0, 0] })] },
          ),
        ]),
        layer(1, [
          effect(
            0,
            true,
            [
              draw(pass("objects/1/effects/0/passes/0", P.a), { target: "other" }),
              draw(pass("objects/1/effects/0/passes/1", P.a, { runtime: { 1: "other" } })),
            ],
            { fbos: [fbo("other", { clear: KEPT })] },
          ),
        ]),
      ]);

    /** 这次 `sync` 提交的清屏：fbo 名。 */
    function syncClears({ gpu, scene: gpuScene, state }: Live): string[] {
      gpu.cleared.length = 0;
      gpuScene.sync(state);
      return gpu.cleared.map((line) => /^fbo ([^|]+)\|/.exec(line)![1]);
    }

    it("创建时清一次", async () => {
      const { gpu } = await open(scene());
      expect(gpu.cleared.map((line) => line.split("|")[0])).toEqual(["fbo kept", "fbo closed", "fbo other"]);
    });

    it("切一个 effect：同图层全部带 clear 的都清，含没切的和关着的；不带的不清；别的图层不清", async () => {
      const live = await open(scene());
      toggle(live.state, 0, 1, false);
      expect(syncClears(live)).toEqual(["kept", "closed"]);
      expect(live.gpu.cleared[0]).toContain(JSON.stringify({ r: 0.1, g: 0.2, b: 0.3, a: 1 }));
      expect(live.gpu.cleared[1]).toContain(JSON.stringify({ r: 0, g: 0, b: 0, a: 0 }));
    });

    it("开和关两个方向都清", async () => {
      const live = await open(scene());
      toggle(live.state, 0, 2, true);
      expect(syncClears(live)).toEqual(["kept", "closed"]);
      toggle(live.state, 0, 2, false);
      expect(syncClears(live)).toEqual(["kept", "closed"]);
    });

    it("同值写不清", async () => {
      const live = await open(scene());
      toggle(live.state, 0, 1, true);
      toggle(live.state, 0, 2, false);
      expect(syncClears(live)).toEqual([]);
    });

    it("同一帧关了又开：计划没变也清（WPE 仍然重建）", async () => {
      const live = await open(scene());
      const { ops } = internals(live.scene).layers[0];
      toggle(live.state, 0, 1, false);
      toggle(live.state, 0, 1, true);
      expect(syncClears(live)).toEqual(["kept", "closed"]);
      expect(internals(live.scene).layers[0].ops).toBe(ops);
    });

    it("图层没有带 clear 的 fbo：不提交", async () => {
      const live = await open(twoEffects([true, true]));
      toggle(live.state, 0, 2, false);
      expect(syncClears(live)).toEqual([]);
    });

    it("swap 之后清的是初始实体，swap 状态保留", async () => {
      const bundle = bundleOf([
        layer(0, [
          effect(
            0,
            true,
            [
              draw(pass("objects/0/effects/0/passes/0", P.a), { target: "a" }),
              { kind: "swap", source: "a", target: "b" },
              draw(pass("objects/0/effects/0/passes/1", P.b, { runtime: { 1: "a" } })),
            ],
            { fbos: [fbo("a", { clear: KEPT }), fbo("b")] },
          ),
          effect(1, true, [draw(pass("objects/0/effects/1/passes/0", P.c))]),
        ]),
      ]);
      const live = await open(bundle);
      const { fbos } = internals(live.scene).layers[0].resources;
      capture(live); // 编码一帧：a、b 对调
      const swapped = fbos.resolve(0, "a");
      expect(swapped).not.toBe(fbos.initial(0, "a"));
      toggle(live.state, 0, 1, false);
      expect(syncClears(live)).toEqual(["a"]);
      expect(fbos.resolve(0, "a")).toBe(swapped);
    });
  });

  describe("渲染循环", () => {
    /** 跑起来的渲染器；`frames` 是排队的 rAF 回调。 */
    async function start(onError: (reasons: string[]) => void, bundle = twoEffects([true, true])) {
      const frames: FrameRequestCallback[] = [];
      const gpu = new FakeGpu();
      vi.mocked(acquireGpu).mockResolvedValue({
        device: gpu.device,
        features: FEATURES,
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
      const renderer = await SceneRenderer.create(canvas, { onError, maxFps: 0 });
      await renderer.load(bundle);
      return { renderer, frames, gpu };
    }

    it("rAF 回调里 sync 抛错：走 onError，不抛出去、不再排下一帧", async () => {
      const onError = vi.fn();
      const { renderer, frames } = await start(onError);
      internals(renderer.currentScene!).readyPipelines.clear();
      toggle(renderer.sceneState!, 0, 2, false);
      const cancel = vi.fn();
      vi.stubGlobal("cancelAnimationFrame", cancel);
      expect(() => frames.at(-1)!(1000)).not.toThrow();
      expect(onError).toHaveBeenCalledWith(["render:variant-missing"]);
      expect(cancel).toHaveBeenCalledOnce();
      renderer.destroy();
    });

    it("暂停时补画也接得住；其它异常归到 render:frame", async () => {
      const onError = vi.fn();
      const { renderer } = await start(onError);
      renderer.setPaused(true);
      vi.spyOn(renderer.currentScene!, "sync").mockImplementation(() => {
        throw new Error("坏");
      });
      expect(() => renderer.redraw()).not.toThrow();
      expect(onError).toHaveBeenCalledWith(["render:frame:坏"]);
      renderer.destroy();
    });

    it("encode 抛错同样走 onError，不再排下一帧", async () => {
      const onError = vi.fn();
      const { renderer, frames } = await start(onError);
      vi.spyOn(renderer.currentScene!, "encode").mockImplementation(() => {
        throw new SceneRenderError(["render:texture-kind:0:cube"]);
      });
      const cancel = vi.fn();
      vi.stubGlobal("cancelAnimationFrame", cancel);
      expect(() => frames.at(-1)!(1000)).not.toThrow();
      expect(onError).toHaveBeenCalledWith(["render:texture-kind:0:cube"]);
      expect(cancel).toHaveBeenCalledOnce();
      renderer.destroy();
    });

    it("切换后这一帧就画新结构", async () => {
      const onError = vi.fn();
      const { renderer, frames } = await start(onError);
      const scene = renderer.currentScene!;
      const before = internals(scene).layers[0].ops;
      toggle(renderer.sceneState!, 0, 2, false);
      frames.at(-1)!(1000);
      expect(internals(scene).layers[0].ops).not.toBe(before);
      expect(onError).not.toHaveBeenCalled();
      renderer.destroy();
    });

    it("两张目标：上屏用这一帧画的那张，每张一个 bind group，换场景时清空", async () => {
      const bundle = twoEffects([true, true]);
      bundle.general.clearVariable = true;
      const { renderer, frames, gpu } = await start(vi.fn(), bundle);
      const groups = (renderer as unknown as { blitBindGroups: Map<unknown, unknown> }).blitBindGroups;
      const shown = () =>
        gpu.trace
          .filter((line) => line.startsWith("bind 0:uniform,1:scene target"))
          .at(-1)!
          .split(",")[1];
      // `load` 画了第一帧：`encode` 开头已经换到第二张
      expect(shown()).toBe("1:scene target 2");
      frames.at(-1)!(1000);
      expect(shown()).toBe("1:scene target");
      frames.at(-1)!(1016);
      expect(shown()).toBe("1:scene target 2");
      expect(groups.size).toBe(2);
      await renderer.load(twoEffects([true, true]));
      expect(groups.size).toBe(1);
      expect(shown()).toBe("1:scene target");
      renderer.destroy();
    });
  });
});

describe("泛光开关与级数", () => {
  /** 泛光程序排在图层程序之后。 */
  const BLOOM_PROGRAM = programs().length;
  const bloomProgram = (name: string, slots: number[]): TranslateResult =>
    ({
      ...program(name, slots),
      uniforms: [
        { name: "g_RenderVar0", type: "vec4<f32>", declared: "vec4", offset: 0, size: 16 },
        {
          name: "g_Strength",
          type: "vec2<f32>",
          declared: "vec2",
          offset: 16,
          size: 8,
          meta: { material: "bloomstrength" },
        },
        {
          name: "g_Threshold",
          type: "f32",
          declared: "float",
          offset: 24,
          size: 4,
          meta: { material: "bloomthreshold" },
        },
        { name: "g_Blend", type: "vec4<f32>", declared: "vec4", offset: 32, size: 16, meta: { material: "blend" } },
        {
          name: "g_BloomTint",
          type: "vec3<f32>",
          declared: "vec3",
          offset: 48,
          size: 12,
          meta: { material: "bloomtint" },
        },
        { name: "g_Scatter", type: "f32", declared: "float", offset: 60, size: 4, meta: { material: "scatter" } },
      ],
      uniformBlockSize: 64,
    }) as unknown as TranslateResult;

  /** 512×256：可用级数 8。`hdr` 决定建哪条链，`flag` 是场景位。 */
  function bloomScene(
    hdr: boolean,
    flag: boolean,
    params: Partial<BloomParams> = {},
    extra: Partial<SceneLayer> = {},
  ): SceneBundle {
    const names = hdr
      ? ["downsampleBloom", "downsample", "upsample", "upsampleCubic", "combine"]
      : ["quarter", "eighth", "blur", "combine"];
    const bundle = bundleOf([layer(0, [], extra)]);
    bundle.programs.push(...names.map((name) => bloomProgram(name, name === "combine" ? [0, 1] : [0])));
    bundle.bloom = {
      hdr,
      passes: Object.fromEntries(
        names.map((name, index) => [
          name,
          pass(`bloom/${name}`, BLOOM_PROGRAM + index, { blending: "normal", uniforms: {} }),
        ]),
      ),
    };
    bundle.general = {
      ...bundle.general,
      width: 512,
      height: 256,
      postprocess: { level: hdr ? "ultra" : "enabled", bloomFlag: flag, hdrFlag: hdr, bloom: flag, hdr },
      bloom: { ...BLOOM_DEFAULTS, tint: [1, 1, 1], ...params },
    };
    return bundle;
  }

  /** 同一份图层，没有泛光链（档位关闭）。 */
  function noChain(): SceneBundle {
    const bundle = bloomScene(false, false);
    bundle.bloom = null;
    bundle.general.postprocess = { level: "disabled", bloomFlag: false, hdrFlag: false, bloom: false, hdr: false };
    return bundle;
  }

  const setBloom = (state: SceneState, value: boolean) =>
    state.write({ property: "b", target: { kind: "bloom-enabled" } }, value);
  const setParam = (state: SceneState, field: keyof BloomParams, value: number) =>
    state.write({ property: "p", target: { kind: "bloom", field } }, value);

  /** `capture` 加上泛光链当前要跑的步骤与 uniform 字节。 */
  function withChain(live: Live) {
    const chain = live.scene.bloomChain as unknown as {
      active: {
        step: BloomStep;
        draw: { label: string; pipeline: { label: string }; uniformBuffer: FakeBuffer };
      }[];
    };
    return {
      ...capture(live),
      chain: chain.active.map(({ step, draw }) => ({
        step,
        label: draw.label,
        pipeline: draw.pipeline.label,
        uniform: hex(draw.uniformBuffer.bytes),
      })),
    };
  }

  it("关着 = 没有链：编码轨迹逐项相同，不拷快照、不跑链", async () => {
    const live = await fresh(bloomScene(false, false));
    const result = capture(live);
    expect(result).toEqual(capture(await fresh(noChain())));
    expect(result.trace.some((line) => line.includes("FullFrameBuffer") || line.includes("_rt_"))).toBe(false);
  });

  it("就地开 / 关（LDR）= 整场编译的 uniform 字节与步骤序列", async () => {
    const live = await open(bloomScene(false, false));
    const { gpu, state } = live;
    const counts = { ...gpu.counts };
    expect(setBloom(state, true)).toBe("applied");
    advance(live);
    const opened = withChain(live);
    expect(opened).toEqual(withChain(await fresh(bloomScene(false, true))));
    expect(opened.trace).toContain("copy scene target -> _rt_FullFrameBuffer");
    expect(opened.trace).toContain("pass _rt_Bloom load");

    setBloom(state, false);
    advance(live);
    expect(withChain(live)).toEqual(withChain(await fresh(bloomScene(false, false))));
    expect(gpu.counts).toEqual(counts);
  });

  it("bloomhdriterations 8 → 5 → 8（HDR）= 整场编译的 uniform 字节与步骤序列，不建新资源", async () => {
    const live = await open(bloomScene(true, true));
    const { gpu, state } = live;
    const counts = { ...gpu.counts };
    setParam(state, "hdrIterations", 5);
    advance(live);
    const five = withChain(live);
    expect(five).toEqual(withChain(await fresh(bloomScene(true, true, { hdrIterations: 5 }))));
    expect(five.trace).not.toContain("pass _rt_64FrameBuffer load");

    setParam(state, "hdrIterations", 8);
    advance(live);
    expect(withChain(live)).toEqual(withChain(await fresh(bloomScene(true, true))));
    expect(gpu.counts).toEqual(counts);
  });

  it.each<[string, boolean, Partial<BloomParams>]>([
    ["LDR 强度", false, { strength: 0.5, threshold: 0.3 }],
    ["HDR 强度", true, { hdrStrength: 4 }],
    ["HDR 级数", true, { hdrIterations: 2 }],
  ])("关着时改参数，打开是新值：%s", async (_name, hdr, params) => {
    const live = await open(bloomScene(hdr, true));
    const { scene, state } = live;
    setBloom(state, false);
    for (const [field, value] of Object.entries(params)) setParam(state, field as keyof BloomParams, value as number);
    scene.sync(state);
    expect(capture(live).trace.some((line) => line.includes("_rt_"))).toBe(false);
    setBloom(state, true);
    advance(live);
    expect(withChain(live)).toEqual(withChain(await fresh(bloomScene(hdr, true, params))));
  });

  it("HDR 就地关泛光：目标格式保持 HDR，brightness 继续乘进颜色，combine 不跑", async () => {
    const live = await open(bloomScene(true, true));
    const { scene, state } = live;
    setBloom(state, false);
    state.write({ property: "l", target: { kind: "layer", object: 0, field: "brightness" } }, 2);
    advance(live);
    expect(scene.format).toBe("rgba16float");
    const { draws } = internals(scene).layers[0];
    const color = [...new Float32Array(draws[0].uniformBuffer.bytes.slice().buffer, 80, 4)];
    expect(color).toEqual([Math.fround(0.2) * 2, Math.fround(0.4) * 2, Math.fround(0.6) * 2, 0.5]);
    const { trace } = capture(live);
    expect(trace.some((line) => line.includes("_rt_"))).toBe(false);
    expect(trace.filter((line) => line.startsWith("pipeline"))).toEqual([expect.stringContaining("rgba16float")]);
  });

  it("HDR 场景加载时关着（JSON true、属性 false，K3）：运行中打开 = 开着整场加载", async () => {
    const live = await open(bloomScene(true, false));
    expect(capture(live).trace.some((line) => line.includes("_rt_"))).toBe(false);
    expect(live.scene.format).toBe("rgba16float");
    setBloom(live.state, true);
    advance(live);
    expect(withChain(live)).toEqual(withChain(await fresh(bloomScene(true, true))));
  });

  it("没有链的场景：位怎么变编码轨迹都不变", async () => {
    const live = await fresh(noChain());
    const before = capture(live);
    expect(setBloom(live.state, true)).toBe("applied");
    advance(live);
    expect(capture(live)).toEqual(before);
  });

  it("链的资源数：LDR 4 个绘制、3 张 RT 加快照，HDR 21 个绘制、8 张 RT 加快照", async () => {
    const without = (await open(noChain())).gpu.counts;
    const ldr = (await open(bloomScene(false, false))).gpu.counts;
    expect(ldr.buffers - without.buffers).toBe(8); // 每个绘制一个顶点缓冲、一个 uniform 缓冲
    expect(ldr.textures - without.textures).toBe(4);
    const hdr = (await open(bloomScene(true, true, { hdrIterations: 3 }))).gpu.counts;
    expect(hdr.buffers - without.buffers).toBe(42);
    expect(hdr.textures - without.textures).toBe(9);
  });

  it("两张目标：快照与 combine 落在当前这张，所以底图含泛光（L20）", async () => {
    const bundle = bloomScene(false, true);
    bundle.general.fields.clearenabled = false;
    bundle.general.clearVariable = true;
    const live = await open(bundle);
    const frame = () => capture(live).trace.filter((line) => line.includes("scene target"));
    const expected = (target: string) => [
      `pass ${target} load`, // 图层
      `copy ${target} -> _rt_FullFrameBuffer`,
      `pass ${target} load`, // combine
    ];
    expect(frame()).toEqual(expected("scene target 2"));
    expect(frame()).toEqual(expected("scene target"));
    expect(frame()).toEqual(expected("scene target 2"));
  });

  describe("HDR 不清屏：开画之前把底图过一次 lin（L21）", () => {
    const LINEAR = (target: string) => [`copy ${target} -> _rt_FullFrameBuffer`, `pass ${target} load`];
    const frame = (live: Live) => capture(live).trace.filter((line) => line.includes("scene target"));
    /** 同一份 HDR 图层，没有泛光链（场景位关着）：没有别的地方建快照。 */
    const hdrNoChain = () => {
      const bundle = bloomScene(true, false);
      bundle.bloom = null;
      bundle.general.fields.clearenabled = false;
      bundle.general.clearVariable = true;
      return bundle;
    };

    it("泛光开着：换底图、画图层、快照、combine，都在当前这张", async () => {
      const bundle = bloomScene(true, true);
      bundle.general.fields.clearenabled = false;
      bundle.general.clearVariable = true;
      const live = await open(bundle);
      for (const target of ["scene target 2", "scene target", "scene target 2"])
        expect(frame(live)).toEqual([
          ...LINEAR(target),
          `pass ${target} load`, // 图层
          `copy ${target} -> _rt_FullFrameBuffer`,
          `pass ${target} load`, // combine
        ]);
    });

    it("没有泛光链：第一次用时建快照当中转，只建一次", async () => {
      const live = await open(hdrNoChain());
      const textures = live.gpu.counts.textures;
      expect(frame(live)).toEqual([...LINEAR("scene target 2"), "pass scene target 2 load"]);
      expect(live.gpu.counts.textures).toBe(textures + 1);
      expect(frame(live)).toEqual([...LINEAR("scene target"), "pass scene target load"]);
      expect(live.gpu.counts.textures).toBe(textures + 1);
    });

    it("运行中切换：关着才走，切回 true 不再走", async () => {
      const bundle = bloomScene(true, false);
      bundle.bloom = null;
      bundle.general.clearVariable = true;
      const live = await open(bundle);
      const setClear = (value: boolean) =>
        live.state.write({ property: "c", target: { kind: "general", key: "clearenabled" } }, value);
      expect(frame(live).filter((line) => line.startsWith("copy"))).toEqual([]);
      setClear(false);
      expect(frame(live)).toEqual([...LINEAR("scene target"), "pass scene target load"]);
      setClear(true);
      expect(frame(live).filter((line) => line.startsWith("copy"))).toEqual([]);
    });

    it("LDR 不走这一步", async () => {
      const bundle = bloomScene(false, false);
      bundle.bloom = null;
      bundle.general.fields.clearenabled = false;
      bundle.general.clearVariable = true;
      const live = await open(bundle);
      expect(frame(live)).toEqual(["pass scene target 2 load"]);
    });
  });
});

/** 带环境光与 `g_EyePosition` 的程序：跟在 `program` 的成员后面。 */
const LIGHT_OFFSET = { ambient: 128, skylight: 144, eye: 160 };
function litProgram(name: string): TranslateResult {
  const base = program(name) as unknown as { uniforms: object[] };
  const vec3 = (uniform: string, offset: number) => ({
    name: uniform,
    type: "vec3<f32>",
    declared: "vec3",
    offset,
    size: 12,
  });
  return {
    ...base,
    uniforms: [
      ...base.uniforms,
      vec3("g_LightAmbientColor", LIGHT_OFFSET.ambient),
      vec3("g_LightSkylightColor", LIGHT_OFFSET.skylight),
      vec3("g_EyePosition", LIGHT_OFFSET.eye),
    ],
    uniformBlockSize: 176,
  } as unknown as TranslateResult;
}

describe("general 字段", () => {
  const setGeneral = (state: SceneState, key: GeneralKey, value: SceneScalar) =>
    state.write({ property: "g", target: { kind: "general", key } }, value);

  /** 两个 effect 的图层，程序都声明环境光；`fields` 覆盖缺省值。 */
  function lit(
    fields: Partial<GeneralValues> = {},
    clearVariable = false,
    enabled: [boolean, boolean] = [true, true],
  ): SceneBundle {
    const bundle = twoEffects(enabled);
    bundle.programs = bundle.programs.map((_, index) => litProgram(`lit ${index}`));
    bundle.general.fields = { ...bundle.general.fields, ...fields };
    bundle.general.clearVariable = clearVariable;
    return bundle;
  }

  /** 一帧里画到场景目标的 pass。 */
  const scenePasses = (live: Live) => capture(live).trace.filter((line) => line.startsWith("pass scene target"));
  /** 一帧画在哪张目标上。 */
  const targetOf = (live: Live) => /scene target( 2)?/.exec(scenePasses(live)[0])![0];
  const sceneTextures = (gpu: FakeGpu) =>
    gpu.textures.filter((item) => item.label.startsWith("scene target")).map((item) => item.label);
  const vec3At = (draw: DrawView, offset: number) => [
    ...new Float32Array(draw.uniformBuffer.bytes.slice().buffer, offset, 3),
  ];
  const fround3 = (values: number[]) => values.map(Math.fround);
  const clearOf = (r: number, g: number, b: number) => JSON.stringify({ r, g, b, a: 1 });

  describe("就地 = 重编译", () => {
    it.each<[string, GeneralKey, SceneScalar, Partial<GeneralValues>]>([
      ["clearcolor", "clearcolor", "0.25 0.5 0.75", { clearcolor: [0.25, 0.5, 0.75] }],
      ["clearcolor 单个数字", "clearcolor", 0.5, { clearcolor: [0.5, 0.5, 0.5] }],
      ["ambientcolor", "ambientcolor", "0.3 0.6 0.9", { ambientcolor: [0.3, 0.6, 0.9] }],
      ["ambientcolor 单个数字", "ambientcolor", 0.25, { ambientcolor: [0.25, 0.25, 0.25] }],
      ["skylightcolor", "skylightcolor", "0.9 0.6 0.3", { skylightcolor: [0.9, 0.6, 0.3] }],
    ])("%s，再写回原值", async (_name, key, value, fields) => {
      const live = await open(lit());
      setGeneral(live.state, key, value);
      advance(live);
      expect(capture(live)).toEqual(capture(await fresh(lit(fields))));
      const original = lit().general.fields[key] as number[];
      setGeneral(live.state, key, original.join(" "));
      advance(live);
      expect(capture(live)).toEqual(capture(await fresh(lit())));
    });

    it("clearenabled 关再开（声明了可变）", async () => {
      const live = await open(lit({ clearcolor: [0.1, 0.2, 0.3] }, true));
      setGeneral(live.state, "clearenabled", false);
      advance(live);
      expect(capture(live)).toEqual(
        capture(await fresh(lit({ clearcolor: [0.1, 0.2, 0.3], clearenabled: false }, true))),
      );
      // 比较的那边也先走一帧：两张目标的奇偶要对齐
      const on = await fresh(lit({ clearcolor: [0.1, 0.2, 0.3] }, true));
      capture(on);
      setGeneral(live.state, "clearenabled", true);
      advance(live);
      expect(capture(live)).toEqual(capture(on));
    });

    it("写过环境光之后切 effect，新 draw 拿到的是当前值", async () => {
      const live = await open(lit());
      setGeneral(live.state, "ambientcolor", "0.3 0.6 0.9");
      setGeneral(live.state, "skylightcolor", "0.9 0.6 0.3");
      live.scene.sync(live.state);
      toggle(live.state, 0, 2, false);
      advance(live);
      const fields = { ambientcolor: [0.3, 0.6, 0.9], skylightcolor: [0.9, 0.6, 0.3] };
      expect(capture(live)).toEqual(capture(await fresh(lit(fields, false, [true, false]))));
      for (const draw of internals(live.scene).layers[0].draws) {
        expect(vec3At(draw, LIGHT_OFFSET.ambient)).toEqual(fround3([0.3, 0.6, 0.9]));
        expect(vec3At(draw, LIGHT_OFFSET.skylight)).toEqual(fround3([0.9, 0.6, 0.3]));
      }
    });

    it("同一次 sync 既切 effect 又写环境光", async () => {
      const live = await open(lit());
      toggle(live.state, 0, 2, false);
      setGeneral(live.state, "ambientcolor", "0.3 0.6 0.9");
      advance(live);
      expect(capture(live)).toEqual(capture(await fresh(lit({ ambientcolor: [0.3, 0.6, 0.9] }, false, [true, false]))));
    });
  });

  describe("编码", () => {
    it("clearenabled 为 false 时第一个 pass 是 load，切回 true 是 clear；不经 sync 就进这一帧（L4）", async () => {
      const live = await open(lit({ clearcolor: [0.1, 0.2, 0.3] }, true));
      const clear = clearOf(0.1, 0.2, 0.3);
      expect(scenePasses(live)).toEqual([`pass scene target 2 clear ${clear}`]);
      setGeneral(live.state, "clearenabled", false);
      expect(scenePasses(live)).toEqual(["pass scene target load"]);
      setGeneral(live.state, "clearenabled", true);
      expect(scenePasses(live)).toEqual([`pass scene target 2 clear ${clear}`]);
    });

    it("clearcolor 不经 sync 就进这一帧", async () => {
      const live = await open(lit());
      setGeneral(live.state, "clearcolor", "1 0 0");
      expect(scenePasses(live)).toEqual([`pass scene target clear ${clearOf(1, 0, 0)}`]);
    });

    it("一帧没有绘制时也按这条走", async () => {
      const bundle = bundleOf([]);
      bundle.general.clearVariable = true;
      const live = await open(bundle);
      expect(scenePasses(live)).toEqual([`pass scene target 2 clear ${clearOf(0, 0, 0)}`]);
      setGeneral(live.state, "clearenabled", false);
      expect(scenePasses(live)).toEqual(["pass scene target load"]);
    });

    it("只有环境光和天光标 lights，不合法的值不标", async () => {
      const { state } = await open(lit());
      for (const [key, value] of [
        ["clearcolor", "1 0 0"],
        ["clearenabled", false],
        ["fov", 33],
        ["camerashake", true],
        ["ambientcolor", "a b c"],
      ] as [GeneralKey, SceneScalar][])
        setGeneral(state, key, value);
      expect(state.takeDirty().lights).toBe(false);
      setGeneral(state, "ambientcolor", "1 0 0");
      expect(state.takeDirty().lights).toBe(true);
      expect(state.takeDirty().lights).toBe(false);
      setGeneral(state, "skylightcolor", 0.5);
      expect(state.takeDirty().lights).toBe(true);
    });

    it("没有这两个 uniform 或被材质覆盖的 draw 不写、不标脏", async () => {
      const bundle = twoEffects([true, true]);
      bundle.programs[P.base] = litProgram("base");
      bundle.programs[P.a] = litProgram("a");
      const step = bundle.layers[0].effects[0].steps[0];
      if (step.kind === "draw")
        Object.assign(step.pass.uniforms, {
          g_LightAmbientColor: [0.9, 0.9, 0.9],
          g_LightSkylightColor: [0.8, 0.8, 0.8],
        });
      const live = await open(bundle);
      setGeneral(live.state, "ambientcolor", "0.3 0.6 0.9");
      live.scene.sync(live.state);
      const { draws } = internals(live.scene).layers[0];
      expect(Object.fromEntries(draws.map((draw) => [draw.passKey, draw.dirty]))).toEqual({
        "objects/0/passes/0": true,
        "objects/0/effects/0/passes/0": false,
        "objects/0/effects/2/passes/0": false,
        "objects/0/effects/2/passes/1": false,
      });
      live.scene.update(FRAME);
      const covered = draws.find((draw) => draw.passKey === "objects/0/effects/0/passes/0")!;
      expect(vec3At(covered, LIGHT_OFFSET.ambient)).toEqual(fround3([0.9, 0.9, 0.9]));
    });
  });

  describe("g_EyePosition", () => {
    it("等于 (W/2, H/2, 2000)（L13）", async () => {
      expect(eyePosition({ width: 1920, height: 1080 })).toEqual([960, 540, 2000]);
      expect(eyePosition({ width: 1280, height: 720 })).toEqual([640, 360, 2000]);
      const { scene } = await open(lit());
      for (const draw of internals(scene).layers[0].draws)
        expect(vec3At(draw, LIGHT_OFFSET.eye)).toEqual([128, 64, 2000]);
    });

    it("按投影尺寸算，不随渲染目标缩小", async () => {
      const bundle = lit();
      bundle.general.width = 16384;
      bundle.general.height = 1024;
      const { scene } = await open(bundle);
      expect(scene.width).toBe(8192);
      expect(vec3At(internals(scene).layers[0].draws[0], LIGHT_OFFSET.eye)).toEqual([8192, 512, 2000]);
    });
  });

  describe("第二张目标", () => {
    it("clearVariable 为 false 且 clearenabled 为 true：只有一张，每帧的编码轨迹相同", async () => {
      const live = await open(lit());
      expect(sceneTextures(live.gpu)).toEqual(["scene target"]);
      const first = capture(live);
      expect(capture(live)).toEqual(first);
      expect(first.trace.join("\n")).not.toContain("scene target 2");
      advance(live);
      expect(sceneTextures(live.gpu)).toEqual(["scene target"]);
    });

    it("clearVariable 为 true：只多这一张，显存估算算上它", async () => {
      const one = await open(lit());
      const two = await open(lit({}, true));
      expect(sceneTextures(two.gpu)).toEqual(["scene target", "scene target 2"]);
      expect(two.gpu.counts).toEqual({ ...one.gpu.counts, textures: one.gpu.counts.textures + 1 });
      expect(two.scene.targetBytes - one.scene.targetBytes).toBe(256 * 128 * 4);
    });

    it("逐帧交替，清屏开着也换；targetTexture 是这一帧画的那张", async () => {
      const live = await open(lit({}, true));
      const shown = () => (live.scene.targetTexture as unknown as FakeTexture).label;
      expect(targetOf(live)).toBe("scene target 2");
      expect(shown()).toBe("scene target 2");
      expect(targetOf(live)).toBe("scene target");
      expect(shown()).toBe("scene target");
      expect(targetOf(live)).toBe("scene target 2");
    });

    it("运行中关掉：当帧画在 N−2 那张上；一直关着时两条链互不相交", async () => {
      const live = await open(lit({}, true));
      expect(targetOf(live)).toBe("scene target 2"); // N−1
      expect(targetOf(live)).toBe("scene target"); // N
      setGeneral(live.state, "clearenabled", false);
      for (const target of ["scene target 2", "scene target", "scene target 2", "scene target"])
        expect(scenePasses(live)).toEqual([`pass ${target} load`]);
    });

    it("没有声明时脚本关掉清屏：当场建第二张并拷一次，只拷这一次", async () => {
      const live = await open(lit());
      const { gpu, scene, state } = live;
      capture(live);
      const { targetBytes } = scene;
      setGeneral(state, "clearenabled", false);
      gpu.trace.length = 0;
      scene.sync(state);
      // 要真的提交：这一帧的编码器是另一个，只编码不提交时第二张是空的
      expect(gpu.copied).toEqual(["scene target -> scene target 2"]);
      expect(gpu.trace).toEqual(["copy scene target -> scene target 2"]);
      expect(sceneTextures(gpu)).toEqual(["scene target", "scene target 2"]);
      expect(scene.targetBytes).toBe(targetBytes + 256 * 128 * 4);
      // 这一帧的底图是拷过去的 N−1，下一帧回到原来那张
      expect(scenePasses(live)).toEqual(["pass scene target 2 load"]);
      expect(scenePasses(live)).toEqual(["pass scene target load"]);
      gpu.trace.length = 0;
      scene.sync(state);
      setGeneral(state, "clearenabled", true);
      scene.sync(state);
      setGeneral(state, "clearenabled", false);
      scene.sync(state);
      expect(gpu.trace).toEqual([]);
      expect(sceneTextures(gpu)).toHaveLength(2);
    });

    it("重放的写入在第一帧之前：sync 建第二张，这一帧不清屏", async () => {
      const live = await open(lit());
      setGeneral(live.state, "clearenabled", false);
      advance(live);
      expect(scenePasses(live)).toEqual(["pass scene target 2 load"]);
    });

    it("探针 host.renderFrame 读回这一帧画的那张，两张目标时也是", async () => {
      const { gpu, scene, state } = await open(lit({}, true));
      const host = { devScene: { renderer: { currentScene: scene, sceneState: state, device: gpu.device } } };
      const readback = async () => {
        gpu.trace.length = 0;
        await hostRenderFrame(host as unknown as SceneHost, 1);
        return gpu.trace.filter((line) => line.startsWith("pass scene target ") || line.startsWith("readback"));
      };
      const clear = clearOf(0, 0, 0);
      expect(await readback()).toEqual([`pass scene target 2 clear ${clear}`, "readback scene target 2"]);
      expect(await readback()).toEqual([`pass scene target clear ${clear}`, "readback scene target"]);
    });

    it("销毁后目标都放掉", async () => {
      const { scene } = await open(lit({}, true));
      scene.destroy();
      expect(scene.targetTexture).toBeNull();
      expect(scene.targetView).toBeNull();
    });
  });
});

describe("重建统计", () => {
  const bundle = () =>
    bundleOf([
      layer(0, [effect(0, true, [draw(pass("objects/0/effects/0/passes/0", P.a))]), effect(1, true, [])]),
      layer(1, [
        effect(0, true, [draw(pass("objects/1/effects/0/passes/0", P.a))]),
        effect(1, true, [draw(pass("objects/1/effects/1/passes/0", P.b))]),
      ]),
    ]);

  it("rebuildStats 只数真正重建的次数", async () => {
    const live = await open(bundle());
    const { scene, state } = live;
    expect(scene.rebuildStats).toEqual({ count: 0, totalMs: 0, maxMs: 0 });
    // 关掉没有步骤的 effect：计划没变
    toggle(state, 0, 1, false);
    advance(live);
    expect(scene.rebuildStats.count).toBe(0);
    // 同一帧关了又开：计划没变
    toggle(state, 1, 1, false);
    toggle(state, 1, 1, true);
    advance(live);
    expect(scene.rebuildStats.count).toBe(0);
    toggle(state, 1, 1, false);
    advance(live);
    expect(scene.rebuildStats.count).toBe(1);
    toggle(state, 1, 1, true);
    advance(live);
    expect(scene.rebuildStats.count).toBe(2);
    expect(scene.rebuildStats.maxMs).toBeGreaterThanOrEqual(0);
    expect(scene.rebuildStats.totalMs).toBeGreaterThanOrEqual(scene.rebuildStats.maxMs);
  });

  it("探针 stats() 的 rebuilds：次数、均值、最大值，没有场景时为 0", async () => {
    const host = (renderer: unknown) =>
      ({ stats: { applied: 0, recompiled: [] }, devScene: { renderer } }) as unknown as SceneHost;
    expect(hostStats(host(null)).rebuilds).toEqual({ count: 0, meanMs: 0, maxMs: 0 });
    const { scene } = await open(bundle());
    Object.assign(scene.rebuildStats, { count: 4, totalMs: 10, maxMs: 4.126 });
    expect(hostStats(host({ currentScene: scene, frameCosts: [] })).rebuilds).toEqual({
      count: 4,
      meanMs: 2.5,
      maxMs: 4.13,
    });
  });
});

describe("没有可变 effect 的场景：资源数与改动前相同", () => {
  it("直接上屏、合成、passthrough 各一层", async () => {
    const fixed = (source: number, steps: SceneEffectStep[], extra: Partial<SceneEffect> = {}) =>
      effect(source, true, steps, { visibleBound: false, ...extra });
    const bundle = bundleOf([
      layer(0, []),
      layer(1, [
        fixed(0, [draw(pass("objects/1/effects/0/passes/0", P.a))]),
        fixed(
          1,
          [
            draw(pass("objects/1/effects/1/passes/0", P.b), { target: "a" }),
            draw(pass("objects/1/effects/1/passes/1", P.c)),
          ],
          { fbos: [fbo("a")] },
        ),
      ]),
      layer(2, [], { colorBlendMode: 5, passthrough: pass("objects/2/passthrough", P.passthrough) }),
    ]);
    const { gpu, scene, state, warnings } = await open(bundle);
    // 这组数字是把本用例放到改动前的 scene.ts 上实测的：7 个 draw 各两个缓冲；场景目标、纹理、4 张占位、快照、2 张合成 RT、1 张 fbo
    expect(gpu.counts).toEqual({ buffers: 14, textures: 10, pipelines: 6, modules: 10 });
    expect(warnings).toEqual([]);
    // 这条路径每帧都走：没有结构脏时不建 encoder
    const { encoders } = gpu;
    scene.sync(state);
    expect(gpu.encoders).toBe(encoders);
  });
});

describe("层级（P4a 步骤 1）", () => {
  /**
   * 0 图层 a（父 2，排在父前面）；1 分组 g（没有 pass）；2 图层 c（父 g，带一个 effect，走合成链）；3 图层 d（父 c）；4 根图层 e。
   * `group` 改分组的字段。
   */
  function tree(group: Partial<SceneLayer> = {}): SceneBundle {
    return bundleOf([
      layer(0, [], { parent: 2, origin: [-15, 5, 0] }),
      layer(1, [], { passes: [], origin: [100, 50, 0], angles: [0, 0, 0.5], scale: [2, 1, 1], ...group }),
      layer(2, [effect(0, true, [draw(pass("objects/2/effects/0/passes/0", P.a))])], {
        parent: 1,
        angles: [0, 0, 0.3],
      }),
      layer(3, [], { parent: 2, origin: [30, 0, 0], angles: [0.2, 0.3, 0.4] }),
      layer(4, []),
    ]);
  }
  const writeGroup = (state: SceneState, field: "origin" | "angles" | "scale" | "visible", value: SceneScalar) =>
    state.write({ property: "p", target: { kind: "layer", object: 1, field } }, value);
  const layerOf = (captured: ReturnType<typeof capture>, object: number) =>
    captured.layers.find((item) => item.object === object);

  it("就地改分组的 origin / angles / scale：子孙的字节等于用新值整场编译，无关图层不变", async () => {
    const live = await open(tree());
    // 先走一帧：对照的字节都写过每帧内置量
    advance(live);
    const before = capture(live);
    writeGroup(live.state, "origin", "220 -40 5");
    writeGroup(live.state, "angles", "0.1 0.2 1.1");
    writeGroup(live.state, "scale", "0.5 3 1");
    advance(live);
    const after = capture(live);
    expect(after).toEqual(
      capture(await fresh(tree({ origin: [220, -40, 5], angles: [0.1, 0.2, 1.1], scale: [0.5, 3, 1] }))),
    );
    for (const object of [0, 2, 3]) expect(layerOf(after, object)).not.toEqual(layerOf(before, object));
    expect(layerOf(after, 4)).toEqual(layerOf(before, 4));
  });

  it("分组写死不可见：子孙不建资源、不画", async () => {
    const live = await open(tree({ visible: false }));
    expect(internals(live.scene).layers.map((item) => item.object)).toEqual([4]);
    expect(visibleObjects(internals(live.scene).layers, live.state)).toEqual([4]);
  });

  it("分组的 visible 绑了属性：子孙建资源，可见性跟着分组变", async () => {
    const live = await open(tree({ visible: false, visibleBound: true }));
    const runtimes = internals(live.scene).layers;
    expect(runtimes.map((item) => item.object)).toEqual([0, 2, 3, 4]);
    expect(visibleObjects(runtimes, live.state)).toEqual([4]);
    writeGroup(live.state, "visible", true);
    advance(live);
    expect(visibleObjects(runtimes, live.state)).toEqual([0, 2, 3, 4]);
    // 子自己关掉：它的子孙一起不画
    live.state.write({ property: "p", target: { kind: "layer", object: 2, field: "visible" } }, false);
    advance(live);
    expect(visibleObjects(runtimes, live.state)).toEqual([4]);
  });
});
