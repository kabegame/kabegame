/**
 * P5a 步骤 2（视差）：`parallax.ts` 的公式、`GpuScene` 的绘制矩阵、编译与就地写、渲染器的帧循环。
 * 期望值取 WPE 实测（p5-REPORT「P5a 语义的实测核对」，逐帧数据在 `ignore/p5/a0/out/ana_a.txt`）；矩阵乘反（`T(o)·VP`）时平移落在
 * NDC 单位里，偏移差上百倍，下面按像素断言的用例都会失败。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generalDefaults, type GeneralValues } from "../compile/bindings";
import {
  compileScene,
  type SceneBundle,
  type SceneEffect,
  type SceneEffectStep,
  type SceneLayer,
  type ScenePass,
  type SceneTexture,
} from "../compile/bundle";
import type { SceneReader } from "../compile/fs";
import type { JsonObject, SceneObject, SceneScalar } from "../compile/model";
import { parseParticle, particleFov } from "../compile/particles";
import { BLOOM_DEFAULTS } from "../compile/postprocess";
import { pointerScenePoint } from "../particles/controlpoints";
import type { TranslateResult } from "../wpesl2wgsl";
import { acquireGpu } from "./device";
import { rootObject, sceneViewProjection } from "./layout";
import { transformPoint, type Mat4 } from "./math";
import {
  advanceParallax,
  drawParallax,
  initialParallaxPoint,
  initialParallaxState,
  parallaxInput,
  parallaxOffset,
  parallaxSmoothing,
  parallaxTarget,
  parallaxUniform,
  replayParallax,
  stepParallaxPoint,
  type ParallaxFields,
  type ParallaxState,
  type SceneParallax,
} from "./parallax";
import { SceneRenderer } from "./renderer";
import { GpuScene } from "./scene";
import { SceneState } from "./state";
import type { FrameInput } from "./uniforms";

vi.mock("./device", () => ({ acquireGpu: vi.fn() }));
vi.mock("../fileUrl", () => ({ fileToUrl: (path: string) => path }));

const W = 1920;
const H = 1080;

function fields(extra: Partial<ParallaxFields> = {}): ParallaxFields {
  return {
    cameraparallax: true,
    cameraparallaxamount: 0.5,
    cameraparallaxdelay: 0,
    cameraparallaxmouseinfluence: 0,
    ...extra,
  };
}
const input = (extra: Partial<ParallaxFields>, pointer: [number, number], frametime = 0.05) =>
  parallaxInput(fields(extra), { pointer, frametime, width: W, height: H });

/** p5a 工程的根对象（`ignore/p5/proj/p5a-static`）：A–E 是根图层，K、K2 的根是分组 G、G2。E 不写 `parallaxDepth`。 */
const ROOTS: Record<string, { origin: [number, number]; depth: number[] }> = {
  A: { origin: [960, 540], depth: [1, 1] },
  B: { origin: [1460, 540], depth: [1, 1] },
  C: { origin: [460, 540], depth: [-0.7, -0.7] },
  D: { origin: [960, 840], depth: [0, 1] },
  E: { origin: [1460, 840], depth: [1, 1] },
  K: { origin: [400, 250], depth: [1, 1] },
  K2: { origin: [1500, 250], depth: [0, 0] },
};

/** WPE 实测各方块的偏移（`ana_a.txt` 的 `o`），指针取抓帧时 CLK 层读到的 `g_PointerPosition`。 */
const MEASURED: {
  tag: string;
  mouseInfluence: number;
  pointer: [number, number];
  point: [number, number];
  position: [number, number];
  offsets: Record<string, [number, number]>;
}[] = [
  {
    tag: "static",
    mouseInfluence: 0,
    pointer: [2.0499, 1.5622],
    point: [960, 540],
    position: [0.5, 0.5],
    offsets: { A: [0, 0], B: [250, 0], C: [175, 0], D: [0, 150], E: [250, 150], K: [-280, -145], K2: [0, 0] },
  },
  {
    tag: "ptr1",
    mouseInfluence: 1,
    pointer: [1.9382, 1.7249],
    point: [1920, 0],
    position: [1, 0],
    offsets: {
      A: [-480, 270],
      B: [-230, 270],
      C: [511, -189],
      D: [0, 420],
      E: [-230, 420],
      K: [-760, 125],
      K2: [0, 0],
    },
  },
  {
    tag: "ptr05",
    mouseInfluence: 0.5,
    pointer: [2.2567, 1.791],
    point: [1440, 270],
    position: [0.75, 0.25],
    offsets: { A: [-240, 135], B: [10, 135], C: [343, -94.5], D: [0, 285], E: [10, 285], K: [-520, -10], K2: [0, 0] },
  },
  {
    // mouseinfluence 不钳制：P 在场景外，只有 uniform 钳制
    tag: "ptrm2",
    mouseInfluence: -2,
    pointer: [2.2001, 1.6905],
    point: [-960, 1620],
    position: [0, 1],
    offsets: {
      A: [960, -540],
      B: [1210, -540],
      C: [-497, 378],
      D: [0, -390],
      E: [1210, -390],
      K: [680, -685],
      K2: [0, 0],
    },
  },
];

describe("视差公式（p5-REPORT 实测）", () => {
  it("初值是场景中心；g_ParallaxPosition 初值 (0.5, 0.5)", () => {
    expect(initialParallaxPoint(W, H)).toEqual([960, 540]);
    expect(initialParallaxPoint(W, H, [8, -4])).toEqual([968, 536]);
    expect(initialParallaxState(W, H)).toEqual({ point: [960, 540], position: [0.5, 0.5] });
  });

  it.each(MEASURED)("$tag：指针先钳到 0…1、y 翻成向上，再按 mouseinfluence 插值；uniform 钳制", (item) => {
    const target = parallaxTarget(input({ cameraparallaxmouseinfluence: item.mouseInfluence }, item.pointer));
    expect(target[0]).toBeCloseTo(item.point[0], 9);
    expect(target[1]).toBeCloseTo(item.point[1], 9);
    expect(parallaxUniform(target, W, H)).toEqual(item.position);
    for (const [name, expected] of Object.entries(item.offsets)) {
      const root = ROOTS[name];
      const [x, y] = parallaxOffset(0.5, root.depth, root.origin, target);
      expect(x, `${item.tag} ${name}.x`).toBeCloseTo(expected[0], 9);
      expect(y, `${item.tag} ${name}.y`).toBeCloseTo(expected[1], 9);
    }
  });

  it("eye.xy 加在目标上（步骤 3 的抖动走这里）", () => {
    const base = parallaxTarget({ mouseInfluence: 0.5, pointer: [1, 0], eye: [0, 0], width: W, height: H });
    const shaken = parallaxTarget({ mouseInfluence: 0.5, pointer: [1, 0], eye: [3, -2], width: W, height: H });
    expect([shaken[0] - base[0], shaken[1] - base[1]]).toEqual([3, -2]);
  });

  it("3818481122 的 depthparallax：mouseinfluence 0.5、钳制后的指针 (1, 0) 读到 (0.75, 0.25)", () => {
    const target = parallaxTarget(input({ cameraparallaxmouseinfluence: 0.5 }, [1.3, 1.8]));
    expect(parallaxUniform(target, W, H)).toEqual([0.75, 0.25]);
  });

  it("平滑系数：k = min(1, (1 − delay/3)·10·dt)，用本帧 dt；delay ≤ 0 为 null（直接取目标）", () => {
    // delay27 f89：实测 k = 0.055100（本帧 dt 0.05510，上一帧 0.04947 时对不上）
    expect(parallaxSmoothing(2.7, 0.0551)).toBeCloseTo(0.0551, 6);
    // delay29 f83：实测 k = 0.018353
    expect(parallaxSmoothing(2.9, 0.05506)).toBeCloseTo(0.018353, 6);
    // 3830255100 第 253 帧：被抓的长帧 dt 0.25，k 取到 1
    expect(parallaxSmoothing(0.1, 0.25)).toBe(1);
    expect(parallaxSmoothing(0, 0.05)).toBeNull();
    expect(parallaxSmoothing(-1, 0.05)).toBeNull();
    // 补画帧：dt 0，k 0
    expect(parallaxSmoothing(2.7, 0)).toBe(0);
  });

  /** 逐帧实测（`ana_a.txt`）：g_ParallaxPosition 五位小数，从第一帧换回 P 起推，后面每帧和实测差不超过取整误差。 */
  const chains = [
    {
      tag: "delay27",
      delay: 2.7,
      dts: [0.0551, 0.05512, 0.05443, 0.05116, 0.0548],
      positions: [
        [0.99482, 0.00521],
        [0.9951, 0.00493],
        [0.99537, 0.00465],
        [0.99562, 0.0044],
        [0.99585, 0.00418],
        [0.99608, 0.00395],
      ],
    },
    {
      tag: "delay29",
      delay: 2.9,
      dts: [0.05506, 0.07111, 0.05175, 0.0577, 0.05449],
      positions: [
        [0.8764, 0.12431],
        [0.87867, 0.12203],
        [0.88155, 0.11914],
        [0.88359, 0.11709],
        [0.88583, 0.11483],
        [0.8879, 0.11275],
      ],
    },
  ];
  it.each(chains)("$tag：P ← P + (目标 − P)·k，逐帧和 WPE 的 g_ParallaxPosition 一致", ({ delay, dts, positions }) => {
    let state: ParallaxState = {
      point: [positions[0][0] * W, positions[0][1] * H],
      position: [positions[0][0], positions[0][1]],
    };
    // 光标在窗口右下方外面：钳制后 (1, 0)，mouseinfluence 1 的目标是 (1920, 0)
    dts.forEach((dt, i) => {
      state = advanceParallax(
        state,
        input({ cameraparallaxdelay: delay, cameraparallaxmouseinfluence: 1 }, [2.1, 1.6], dt),
      );
      expect(state.position[0]).toBeCloseTo(positions[i + 1][0], 4);
      expect(state.position[1]).toBeCloseTo(positions[i + 1][1], 4);
      expect(Math.abs(state.position[0] - positions[i + 1][0])).toBeLessThan(1.5e-5);
      expect(Math.abs(state.position[1] - positions[i + 1][1])).toBeLessThan(1.5e-5);
    });
  });

  it("delay ≤ 0 时 P 直接取目标，补画帧（dt 0）也是；delay > 0 的补画帧 P 不动", () => {
    const start: [number, number] = [100, 100];
    expect(stepParallaxPoint(start, input({ cameraparallaxmouseinfluence: 1 }, [1, 0], 0))).toEqual([1920, 1080]);
    expect(
      stepParallaxPoint(start, input({ cameraparallaxdelay: -1, cameraparallaxmouseinfluence: 1 }, [0, 1])),
    ).toEqual([0, 0]);
    expect(
      stepParallaxPoint(start, input({ cameraparallaxdelay: 0.5, cameraparallaxmouseinfluence: 1 }, [1, 0], 0)),
    ).toEqual(start);
  });

  it("开关关着：P 与 g_ParallaxPosition 都不动（保留上一次的值），不加平移", () => {
    const moved = advanceParallax(initialParallaxState(W, H), input({ cameraparallaxmouseinfluence: 1 }, [1, 0]));
    expect(moved).toEqual({ point: [1920, 1080], position: [1, 1] });
    const off = fields({ cameraparallax: false, cameraparallaxmouseinfluence: 1 });
    const held = advanceParallax(moved, parallaxInput(off, { pointer: [0, 1], frametime: 0.05, width: W, height: H }));
    expect(held).toBe(moved);
    expect(drawParallax(held, off)).toBeNull();
    expect(drawParallax(held, fields({ cameraparallaxamount: 0.3 }))).toEqual({ point: [1920, 1080], amount: 0.3 });
  });

  it("parallaxDepth 只有一个分量时铺满两个；uniform 遇到 NaN（W = 0）取 0", () => {
    expect(parallaxOffset(0.5, [0.01], [1460, 840], [960, 540])).toEqual([0.5 * 0.01 * 500, 0.5 * 0.01 * 300]);
    expect(parallaxUniform([0, 10], 0, 0)).toEqual([0, 1]);
  });

  it("replayParallax：从加载时的状态起逐帧推进，和逐帧调 advanceParallax 相同", () => {
    const f = fields({ cameraparallaxdelay: 2.7, cameraparallaxmouseinfluence: 1 });
    const frame = { pointer: [1, 0] as [number, number], width: W, height: H };
    const dts = [0.0001, 0.05, 0.05, 0.25, 0];
    let manual = initialParallaxState(W, H);
    for (const frametime of dts) manual = advanceParallax(manual, parallaxInput(f, { ...frame, frametime }));
    expect(replayParallax(initialParallaxState(W, H), f, frame, dts)).toEqual(manual);
  });
});

describe("rootObject", () => {
  const layers = new Map<number, { parent: number | null }>([
    [0, { parent: null }],
    [1, { parent: 0 }],
    [2, { parent: 1 }],
    [3, { parent: 99 }],
    [4, { parent: 5 }],
    [5, { parent: 4 }],
  ]);
  it("沿父链走到顶；父不在表里时当根；环兜底；不在表里的返回自己", () => {
    expect(rootObject(2, layers)).toBe(0);
    expect(rootObject(1, layers)).toBe(0);
    expect(rootObject(0, layers)).toBe(0);
    expect(rootObject(3, layers)).toBe(3);
    expect([4, 5]).toContain(rootObject(4, layers));
    expect(rootObject(42, layers)).toBe(42);
  });
});

// ———— 假设备 ————

interface FakeBuffer {
  label: string;
  bytes: Uint8Array;
  writes: number;
  destroy(): void;
}

/** 假设备：只记缓冲的字节（uniform 读回用），其余调用都是空操作。 */
class FakeGpu {
  readonly buffers: FakeBuffer[] = [];
  readonly device: GPUDevice;

  constructor() {
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
          bytes: new Uint8Array(descriptor.size),
          writes: 0,
          destroy() {},
        };
        this.buffers.push(buffer);
        return buffer;
      },
      createShaderModule: () => ({ getCompilationInfo: async () => ({ messages: [] }) }),
      createBindGroupLayout: () => ({}),
      createPipelineLayout: () => ({}),
      createRenderPipeline: () => ({ getBindGroupLayout: () => ({}) }),
      createRenderPipelineAsync: async (descriptor: GPURenderPipelineDescriptor) => ({ label: descriptor.label }),
      createBindGroup: () => ({}),
      createCommandEncoder: () => ({
        beginRenderPass: () => pass(),
        copyTextureToTexture() {},
        copyTextureToBuffer() {},
        finish: () => ({}),
      }),
      queue: {
        writeBuffer: (buffer: FakeBuffer, offset: number, data: ArrayBuffer, dataOffset = 0, size?: number) => {
          buffer.bytes.set(new Uint8Array(data, dataOffset, size ?? data.byteLength - dataOffset), offset);
          buffer.writes++;
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

/** 图像 / effect 程序：MVP、效果纹理投影的逆、视图投影与 `g_ParallaxPosition`。 */
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
    {
      name: "g_EffectTextureProjectionMatrixInverse",
      type: "mat4x4<f32>",
      declared: "mat4",
      offset: 64,
      size: 64,
    },
    { name: "g_ViewProjectionMatrix", type: "mat4x4<f32>", declared: "mat4", offset: 128, size: 64 },
    { name: "g_ParallaxPosition", type: "vec2<f32>", declared: "vec2", offset: 192, size: 8 },
    { name: "g_Time", type: "f32", declared: "float", offset: 200, size: 4 },
  ],
  uniformBlockSize: 208,
  textures: [{ slot: 0, binding: 1, samplerBinding: 2, kind: "2d" }],
} as unknown as TranslateResult;

/** 翻译后 `genericparticle` 的输入（同 `particles.test.ts`），uniform 只留 MVP。 */
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

function pass(key: string, program: number, extra: Partial<ScenePass> = {}): ScenePass {
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

function layer(object: number, extra: Partial<SceneLayer> = {}): SceneLayer {
  return {
    id: object + 1,
    object,
    parent: null,
    name: `layer ${object}`,
    origin: [0, 0, 0],
    scale: [1, 1, 1],
    angles: [0, 0, 0],
    size: [60, 60],
    alpha: 1,
    color: [1, 1, 1],
    brightness: 1,
    visible: true,
    visibleBound: false,
    parallaxDepth: [1, 1],
    solidLayer: false,
    passes: [pass(`objects/${object}/passes/0`, 0, { textures: { 0: 0 } })],
    colorBlendMode: 0,
    effects: [],
    passthrough: null,
    particle: null,
    ...extra,
  };
}

const effectDraw = (scenePass: ScenePass): SceneEffectStep => ({
  kind: "draw",
  pass: scenePass,
  target: null,
  compose: false,
  binds: null,
});

/** 两个绘制 pass 的 effect：第一个画进 fbo（中间 pass，读效果矩阵），第二个上屏。 */
function effectLayer(object: number, extra: Partial<SceneLayer> = {}): SceneLayer {
  const effect: SceneEffect = {
    source: 0,
    id: 100,
    name: "cursorripple",
    file: "effects/cursorripple/effect.json",
    fbos: [{ name: "_rt_EightBuffer1", format: "rgba8888", scale: 8, unique: false, repeat: false }],
    steps: [
      { ...effectDraw(pass(`objects/${object}/effects/0/passes/0`, 0)), target: "_rt_EightBuffer1" },
      effectDraw(pass(`objects/${object}/effects/0/passes/1`, 0)),
    ],
    enabled: true,
    visibleBound: false,
    unsupported: [],
  };
  return layer(object, { effects: [effect], ...extra });
}

function particleLayer(object: number, json: JsonObject, extra: Partial<SceneLayer> = {}): SceneLayer {
  const particle = parseParticle(
    {
      maxcount: 4,
      emitter: [{ name: "sphererandom", origin: "0 0 0", distancemax: 0, rate: 1 }],
      initializer: [{ name: "lifetimerandom", min: 100, max: 100 }],
      ...json,
    },
    { file: `particles/${object}.json`, orthographic: true },
  );
  particle.passes = [pass(`objects/${object}/particle/passes/0`, 1, { blending: "additive" })];
  return layer(object, { name: `particles ${object}`, passes: [], size: [], particle, ...extra });
}

function generalFields(extra: Partial<GeneralValues> = {}): GeneralValues {
  return {
    ...generalDefaults(),
    cameraparallax: true,
    cameraparallaxamount: 0.5,
    cameraparallaxdelay: 0,
    cameraparallaxmouseinfluence: 0,
    ...extra,
  };
}

function bundleOf(layers: SceneLayer[], extra: Partial<GeneralValues> = {}): SceneBundle {
  return {
    general: {
      width: W,
      height: H,
      fields: generalFields(extra),
      clearVariable: false,
      perspectiveOverrideFov: particleFov(95),
      postprocess: { level: "disabled", bloomFlag: false, hdrFlag: false, bloom: false, hdr: false },
      bloom: { ...BLOOM_DEFAULTS, tint: [1, 1, 1] },
    },
    layers,
    programs: [IMAGE_PROGRAM, PARTICLE_PROGRAM],
    textures: [texture(64, 64)],
    bloom: null,
    unsupported: [],
    bindings: [],
    scripts: { list: [] },
  };
}

interface DrawView {
  object: number;
  step: { kind: string; role?: string };
  uniformBuffer: FakeBuffer | null;
  particles: { system: { step: (...args: unknown[]) => void } } | null;
}
const drawsOf = (scene: GpuScene): DrawView[] => [...(scene as unknown as { draws: Set<DrawView> }).draws];
const roleOf = (draw: DrawView) => (draw.step.kind === "particles" ? "particles" : draw.step.role);
const matrixAt = (draw: DrawView, offset: number): Mat4 =>
  new Float32Array(draw.uniformBuffer!.bytes.buffer.slice(offset, offset + 64));
const vec2At = (draw: DrawView, offset: number) =>
  Array.from(new Float32Array(draw.uniformBuffer!.bytes.buffer.slice(offset, offset + 8)));
/** 模型空间原点经 MVP 落到的场景像素（y 向上）。 */
function projectedOrigin(mvp: Mat4): [number, number] {
  const [x, y, , w] = transformPoint(mvp, 0, 0, 0);
  return [((x / w + 1) / 2) * W, ((y / w + 1) / 2) * H];
}

async function open(bundle: SceneBundle) {
  const gpu = new FakeGpu();
  const state = SceneState.fromBundle(bundle);
  const scene = await GpuScene.build(gpu.device, bundle, state, new Set(), [], {
    ignoreUnsupported: true,
    particles: { seed: 1 },
  });
  return { gpu, state, scene };
}

const FRAME: FrameInput = {
  time: 1,
  frametime: 0.05,
  daytime: 0.5,
  pointer: [0.5, 0.5],
  pointerLast: [0.5, 0.5],
  cursor: [0.5, 0.5],
};

/** 一帧（同渲染器）：推进视差点、交给场景、同步、写每帧 uniform。 */
function frame(
  scene: GpuScene,
  state: SceneState,
  parallax: ParallaxState,
  pointer: [number, number],
  frametime = 0.05,
): ParallaxState {
  const next = advanceParallax(parallax, parallaxInput(state.general, { pointer, frametime, width: W, height: H }));
  scene.setParallax(drawParallax(next, state.general), state);
  scene.sync(state);
  scene.update({ ...FRAME, frametime, pointer, parallax: next.position }, state);
  return next;
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

// ———— 内存里的 p5a-static ————

function memory(files: Record<string, unknown>): SceneReader {
  const reader: SceneReader = {
    async readWhole(path) {
      const value = files[path.replace(/\\/g, "/")];
      if (value === undefined) throw new TypeError("Failed to fetch");
      return new TextEncoder().encode(JSON.stringify(value));
    },
    async readRange(path, start, end) {
      return (await reader.readWhole(path)).slice(start, end);
    },
  };
  return reader;
}

const image = (id: number, name: string, origin: string, extra: Partial<SceneObject> = {}): SceneObject => ({
  id,
  name,
  image: "models/a.json",
  origin,
  size: "60 60",
  ...extra,
});

/** `p5a-static` 的对象（去掉 FR、CLK）：E 不写 `parallaxDepth`，K、K2 自己的深度不参与。 */
function staticObjects(overrides: Record<string, Partial<SceneObject>> = {}): SceneObject[] {
  const objects: SceneObject[] = [
    image(10, "A", "960 540 0", { parallaxDepth: "1 1" }),
    image(11, "B", "1460 540 0", { parallaxDepth: "1 1" }),
    image(12, "C", "460 540 0", { parallaxDepth: "-0.7 -0.7" }),
    image(13, "D", "960 840 0", { parallaxDepth: "0 1" }),
    image(14, "E", "1460 840 0"),
    { id: 15, name: "G", origin: "400 250 0", parallaxDepth: "1 1" },
    image(16, "K", "100 0 0", { parallaxDepth: "0 0", parent: 15 }),
    { id: 17, name: "G2", origin: "1500 250 0", parallaxDepth: "0 0" },
    image(18, "K2", "0 0 0", { parallaxDepth: "1 1", parent: 17 }),
  ];
  return objects.map((object) => ({ ...object, ...overrides[object.name ?? ""] }));
}

async function compileStatic(
  objects: SceneObject[],
  general: Record<string, unknown> = {},
  userProperties: Record<string, SceneScalar> = {},
): Promise<SceneBundle> {
  const bundle = await compileScene({
    projectDir: "P:/p",
    sceneAssets: ["A:/assets"],
    reader: memory({
      "P:/p/project.json": { file: "scene.json" },
      "P:/p/scene.json": {
        general: {
          orthogonalprojection: { width: W, height: H },
          cameraparallax: true,
          cameraparallaxamount: 0.5,
          cameraparallaxdelay: 0,
          cameraparallaxmouseinfluence: { user: "mi", value: 0 },
          ...general,
        },
        objects,
      },
      "P:/p/models/a.json": { material: "materials/a.json", width: 60, height: 60 },
      "P:/p/materials/a.json": { passes: [{ shader: "simple" }] },
    }),
    translator: null,
    postprocess: "disabled",
    exhaustive: true,
    userProperties,
  });
  bundle.programs = [IMAGE_PROGRAM];
  for (const item of bundle.layers) for (const scenePass of item.passes) scenePass.program = 0;
  return bundle;
}

/** 各方块（按名字）的 MVP 把模型原点投到哪里，减去它的世界原点，就是这次绘制的视差偏移。 */
function offsetsByName(bundle: SceneBundle, scene: GpuScene): Record<string, [number, number]> {
  const worlds: Record<string, [number, number]> = {
    A: [960, 540],
    B: [1460, 540],
    C: [460, 540],
    D: [960, 840],
    E: [1460, 840],
    K: [500, 250],
    K2: [1500, 250],
  };
  const out: Record<string, [number, number]> = {};
  for (const draw of drawsOf(scene)) {
    const name = bundle.layers.find((item) => item.object === draw.object)!.name;
    const [x, y] = projectedOrigin(matrixAt(draw, 0));
    out[name] = [x - worlds[name][0], y - worlds[name][1]];
  }
  return out;
}

function expectOffsets(actual: Record<string, [number, number]>, expected: Record<string, [number, number]>) {
  expect(Object.keys(actual).sort()).toEqual(Object.keys(expected).sort());
  for (const [name, [x, y]] of Object.entries(expected)) {
    expect(actual[name][0], `${name}.x`).toBeCloseTo(x, 2);
    expect(actual[name][1], `${name}.y`).toBeCloseTo(y, 2);
  }
}

describe("编译：parallaxDepth 字段与 cameraparallax", () => {
  it("缺键 (1, 1)，写了的按空格切；cameraparallax 不进 unsupported", async () => {
    const bundle = await compileStatic(staticObjects());
    const depth = Object.fromEntries(bundle.layers.map((item) => [item.name, item.parallaxDepth]));
    expect(depth).toEqual({
      A: [1, 1],
      B: [1, 1],
      C: [-0.7, -0.7],
      D: [0, 1],
      E: [1, 1],
      G: [1, 1],
      K: [0, 0],
      G2: [0, 0],
      K2: [1, 1],
    });
    expect(bundle.unsupported).not.toContain("general:cameraparallax");
    expect(bundle.general.fields).toMatchObject({ cameraparallax: true, cameraparallaxdelay: 0 });
    expect(SceneState.fromBundle(bundle).layers.get(3)?.parallaxDepth).toEqual([0, 1]);
  });

  it("绑用户属性登记成图层目标；就地写与用新值整场编译的状态相同，整棵子树标脏", async () => {
    const objects = staticObjects({ G: { parallaxDepth: { user: "depth", value: "1 1" } } });
    const before = await compileStatic(objects);
    expect(before.bindings).toContainEqual({
      property: "depth",
      target: { kind: "layer", object: 5, field: "parallaxDepth" },
    });
    const state = SceneState.fromBundle(before);
    state.takeDirty();
    for (const binding of before.bindings.filter((item) => item.property === "depth")) state.write(binding, "0.5 2");
    expect(state.layers.get(5)?.parallaxDepth).toEqual([0.5, 2]);
    expect([...state.takeDirty().layers].sort()).toEqual([5, 6]);
    const after = SceneState.fromBundle(await compileStatic(objects, {}, { depth: "0.5 2" }));
    expect(state.layers).toEqual(after.layers);
  });
});

describe("GpuScene：绘制矩阵带视差（p5a-static，WPE 实测偏移）", () => {
  it.each(MEASURED)(
    "$tag：每个方块的 MVP 把原点挪了 o（根对象的原点与深度），g_ParallaxPosition 进 uniform",
    async (item) => {
      const bundle = await compileStatic(staticObjects());
      const { scene, state } = await open(bundle);
      const binding = bundle.bindings.find((entry) => entry.property === "mi")!;
      state.write(binding, item.mouseInfluence);
      const next = frame(scene, state, initialParallaxState(W, H), item.pointer);
      expect(next.point[0]).toBeCloseTo(item.point[0], 6);
      expect(next.point[1]).toBeCloseTo(item.point[1], 6);
      expectOffsets(offsetsByName(bundle, scene), item.offsets);
      for (const draw of drawsOf(scene)) expect(vec2At(draw, 192)).toEqual(item.position);
    },
  );

  it("就地改根的 parallaxDepth（属性）：子孙跟着变，字节等于用新值整场编译", async () => {
    const objects = staticObjects({ G: { parallaxDepth: { user: "depth", value: "1 1" } } });
    const compiled = await compileStatic(objects);
    const live = await open(compiled);
    const binding = compiled.bindings.find((item) => item.property === "depth")!;
    let parallax = frame(live.scene, live.state, initialParallaxState(W, H), [0.5, 0.5]);
    live.state.write(binding, "0.5 2");
    parallax = frame(live.scene, live.state, parallax, [0.5, 0.5]);
    const fresh = await open(await compileStatic(objects, {}, { depth: "0.5 2" }));
    frame(fresh.scene, fresh.state, initialParallaxState(W, H), [0.5, 0.5]);
    const bytes = (scene: GpuScene) =>
      Object.fromEntries(
        drawsOf(scene).map((draw) => [draw.object, Buffer.from(draw.uniformBuffer!.bytes).toString("hex")]),
      );
    expect(bytes(live.scene)).toEqual(bytes(fresh.scene));
    // K 的根是 G：0.5 · (0.5, 2) ⊙ (400 − 960, 250 − 540)
    const k = drawsOf(live.scene).find((draw) => draw.object === 6)!;
    const [x, y] = projectedOrigin(matrixAt(k, 0));
    expect(x - 500).toBeCloseTo(-140, 2);
    expect(y - 250).toBeCloseTo(-290, 2);
  });

  it("关着、amount 为 0、深度为 0 时逐字节不变；关掉后恢复原字节；相同视差不重写", async () => {
    const bundle = await compileStatic(staticObjects());
    const { scene, state } = await open(bundle);
    scene.update(FRAME, state);
    const snapshot = () =>
      drawsOf(scene).map((draw) => Buffer.from(draw.uniformBuffer!.bytes.slice(0, 192)).toString("hex"));
    const plain = snapshot();
    // amount 0：每层的 o 都是 0，矩阵原样
    scene.setParallax({ point: [123, 456], amount: 0 }, state);
    scene.update(FRAME, state);
    expect(snapshot()).toEqual(plain);
    scene.setParallax({ point: [0, 0], amount: 0.5 }, state);
    scene.update(FRAME, state);
    const shifted = snapshot();
    expect(shifted).not.toEqual(plain);
    // K2 的根 G2 深度为 0：字节不变
    const index = drawsOf(scene).findIndex((draw) => draw.object === 8);
    expect(shifted[index]).toEqual(plain[index]);
    // 同一个视差再交一次：不刷新
    const refresh = vi.spyOn(scene as unknown as { refreshLayer: () => void }, "refreshLayer");
    scene.setParallax({ point: [0, 0], amount: 0.5 }, state);
    expect(refresh).not.toHaveBeenCalled();
    scene.setParallax({ point: [0, 0], amount: 0.25 }, state);
    expect(refresh).toHaveBeenCalledTimes(drawsOf(scene).length);
    scene.setParallax({ point: [0, 0], amount: 0.5 }, state);
    scene.setParallax(null, state);
    scene.update(FRAME, state);
    expect(snapshot()).toEqual(plain);
  });

  it("根的 origin 由脚本 / 属性改：下一次 sync 按新原点算偏移（只看根的 origin 字段）", async () => {
    const bundle = await compileStatic(staticObjects());
    const { scene, state } = await open(bundle);
    let parallax = frame(scene, state, initialParallaxState(W, H), [0.5, 0.5]);
    state.write({ property: "", target: { kind: "layer", object: 5, field: "origin" } }, "600 250 0");
    parallax = frame(scene, state, parallax, [0.5, 0.5]);
    const k = drawsOf(scene).find((draw) => draw.object === 6)!;
    const [x] = projectedOrigin(matrixAt(k, 0));
    // K 的世界原点 700，偏移 0.5 · (600 − 960) = −180
    expect(x - 700).toBeCloseTo(-180, 2);
  });
});

describe("GpuScene：effect 各 pass 与粒子（p5a-fx、p5a-kinds）", () => {
  it("effect 的中间 pass 读的 g_EffectTextureProjectionMatrixInverse 平移 −25（不带视差是 −16.67）；上屏带偏移；基础 pass 不变", async () => {
    const bundle = bundleOf([effectLayer(0, { origin: [1460, 540, 0] })]);
    const { scene, state } = await open(bundle);
    scene.update(FRAME, state);
    const byRole = () => Object.fromEntries(drawsOf(scene).map((draw) => [roleOf(draw), draw]));
    const effectBefore = matrixAt(byRole().effect, 64);
    expect(effectBefore[12]).toBeCloseTo(-50 / 3, 3);
    const baseBefore = Buffer.from(byRole().base.uniformBuffer!.bytes.slice(0, 192)).toString("hex");
    frame(scene, state, initialParallaxState(W, H), [0.5, 0.5]);
    const draws = byRole();
    expect(Object.keys(draws).sort()).toEqual(["base", "effect", "final"]);
    expect(matrixAt(draws.effect, 64)[12]).toBeCloseTo(-25, 3);
    expect(matrixAt(draws.effect, 64)[13]).toBeCloseTo(0, 4);
    // 上屏：原点投到 1460 + 250
    expect(projectedOrigin(matrixAt(draws.final, 0))[0]).toBeCloseTo(1710, 2);
    // g_ViewProjectionMatrix 同样带视差：场景原点投到 (250, 0)
    expect(projectedOrigin(matrixAt(draws.final, 128))[0]).toBeCloseTo(250, 2);
    expect(Buffer.from(draws.base.uniformBuffer!.bytes.slice(0, 192)).toString("hex")).toEqual(baseBefore);
  });

  it("正交与透视粒子都带偏移：本地系统 (1460, 300) 偏 (250, −120)，透视 (460, 840) 投到 (210, 990)，世界空间系统用场景点", async () => {
    const bundle = bundleOf([
      particleLayer(0, {}, { origin: [1460, 300, 0] }),
      particleLayer(1, { flags: 4 }, { origin: [460, 840, 0] }),
      particleLayer(2, { flags: 1 }, { origin: [0, 0, 0] }),
    ]);
    const { scene, state } = await open(bundle);
    frame(scene, state, initialParallaxState(W, H), [0.5, 0.5]);
    const byObject = Object.fromEntries(drawsOf(scene).map((draw) => [draw.object, draw]));
    const local = projectedOrigin(matrixAt(byObject[0], 0));
    expect(local[0]).toBeCloseTo(1710, 2);
    expect(local[1]).toBeCloseTo(180, 2);
    const perspective = projectedOrigin(matrixAt(byObject[1], 0));
    expect(perspective[0]).toBeCloseTo(210, 1);
    expect(perspective[1]).toBeCloseTo(990, 1);
    // 世界空间系统：模型矩阵是单位阵，场景原点平移 0.5 · (0 − 960, 0 − 540)
    const world = projectedOrigin(matrixAt(byObject[2], 0));
    expect(world[0]).toBeCloseTo(-480, 2);
    expect(world[1]).toBeCloseTo(-270, 2);
  });

  it("粒子模拟的指针点不含视差：stepParticles 仍按不带视差的场景视图投影反投影", async () => {
    const bundle = bundleOf([particleLayer(0, {}, { origin: [1460, 300, 0] })]);
    const { scene, state } = await open(bundle);
    scene.setParallax({ point: [0, 0], amount: 0.5 }, state);
    const draw = drawsOf(scene)[0];
    const step = vi.spyOn(draw.particles!.system, "step");
    scene.stepParticles(0.05, 1, state, [0.25, 0.75]);
    const pointer = (step.mock.lastCall![2] as { pointer: [number, number] }).pointer;
    expect(pointer).toEqual(pointerScenePoint(sceneViewProjection({ width: W, height: H }), [0.25, 0.75]));
  });
});

// ———— 渲染器 ————

describe("渲染器：视差点的推进、重置与帧顺序", () => {
  async function start(bundle: SceneBundle, onFrame?: (renderer: SceneRenderer) => void) {
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
    const renderer: SceneRenderer = await SceneRenderer.create(canvas, {
      maxFps: 0,
      beforeFrame: () => onFrame?.(renderer),
    });
    return { renderer, frames };
  }
  const parallaxOf = (renderer: SceneRenderer) => (renderer as unknown as { parallax: ParallaxState }).parallax;
  const sceneParallax = (renderer: SceneRenderer) =>
    (renderer.currentScene as unknown as { parallax: SceneParallax | null }).parallax;

  it("新场景从场景中心开始，重编译（同一渲染器上再次 load）保留 P；新渲染器回到中心", async () => {
    let now = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const bundle = () =>
      bundleOf([layer(0, { origin: [1460, 540, 0] })], { cameraparallaxdelay: 2.7, cameraparallaxmouseinfluence: 1 });
    const { renderer, frames } = await start(bundle());
    const loaded: [number, number][] = [];
    const load = (target: SceneRenderer) =>
      target.load(bundle(), { beforeFirstFrame: () => loaded.push([...parallaxOf(target).point]) });
    await load(renderer);
    expect(loaded.at(-1)).toEqual([960, 540]);
    // fill：g_PointerPosition 就是画布坐标；钳制后 (1, 1)，目标 (1920, 1080)
    renderer.setPointer(1, 0);
    for (let i = 0; i < 5; i++) {
      now += 50;
      frames.at(-1)!(now);
    }
    const moved = parallaxOf(renderer).point;
    expect(moved[0]).toBeGreaterThan(960);
    expect(moved[1]).toBeGreaterThan(540);
    // 重编译：新 bundle 换上之前 P 不动
    await load(renderer);
    expect(loaded.at(-1)).toEqual(moved);
    renderer.destroy();
    const second = await start(bundle());
    await load(second.renderer);
    expect(loaded.at(-1)).toEqual([960, 540]);
    second.renderer.destroy();
  });

  it("每帧：用本帧帧时间平滑、g_ParallaxPosition 进帧输入、P 交给场景；补画帧（dt 0）P 不动", async () => {
    let now = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const { renderer, frames } = await start(
      bundleOf([layer(0)], { cameraparallaxdelay: 2.7, cameraparallaxmouseinfluence: 1 }),
    );
    await renderer.load(bundleOf([layer(0)], { cameraparallaxdelay: 2.7, cameraparallaxmouseinfluence: 1 }));
    const update = vi.spyOn(renderer.currentScene!, "update");
    renderer.setPointer(1, 0);
    const before = parallaxOf(renderer).point;
    now += 50;
    frames.at(-1)!(now);
    // k = (1 − 0.9) · 10 · 0.05 = 0.05
    const after = parallaxOf(renderer);
    expect(after.point[0]).toBeCloseTo(before[0] + (1920 - before[0]) * 0.05, 9);
    expect(after.point[1]).toBeCloseTo(before[1] + (1080 - before[1]) * 0.05, 9);
    expect(update.mock.lastCall![0].parallax).toEqual(parallaxUniform(after.point, W, H));
    expect(sceneParallax(renderer)).toEqual({ point: after.point, amount: 0.5 });
    renderer.setPaused(true);
    renderer.redraw();
    expect(parallaxOf(renderer).point).toEqual(after.point);
    renderer.destroy();
  });

  it("开关关着：P 与 g_ParallaxPosition 不动、不加平移；就地打开后推进，再关掉时 g_ParallaxPosition 保留最后的值", async () => {
    let now = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const bundle = bundleOf([layer(0, { origin: [1460, 540, 0] })], {
      cameraparallax: false,
      cameraparallaxmouseinfluence: 1,
    });
    const { renderer, frames } = await start(bundle);
    await renderer.load(bundle);
    const update = vi.spyOn(renderer.currentScene!, "update");
    const next = () => {
      now += 50;
      frames.at(-1)!(now);
      return update.mock.lastCall![0].parallax;
    };
    renderer.setPointer(1, 0);
    expect(next()).toEqual([0.5, 0.5]);
    expect(parallaxOf(renderer).point).toEqual([960, 540]);
    expect(sceneParallax(renderer)).toBeNull();
    const toggle = (value: boolean) =>
      renderer.sceneState!.write({ property: "", target: { kind: "general", key: "cameraparallax" } }, value);
    toggle(true);
    // delay 0：一帧到位
    expect(next()).toEqual([1, 1]);
    expect(sceneParallax(renderer)).toEqual({ point: [1920, 1080], amount: 0.5 });
    toggle(false);
    renderer.setPointer(0, 1);
    expect(next()).toEqual([1, 1]);
    expect(parallaxOf(renderer).point).toEqual([1920, 1080]);
    expect(sceneParallax(renderer)).toBeNull();
    renderer.destroy();
  });

  it("脚本（beforeFrame）写 cameraparallax* 同帧生效：P 在脚本之前推进，绘制用脚本之后的开关与 amount", async () => {
    let now = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const bundle = bundleOf([layer(0)], { cameraparallax: false, cameraparallaxmouseinfluence: 1 });
    let script: ((renderer: SceneRenderer) => void) | null = null;
    const { renderer, frames } = await start(bundle, (r) => script?.(r));
    await renderer.load(bundle);
    const scene = renderer.currentScene!;
    const spies = {
      sync: vi.spyOn(scene, "sync"),
      stepParticles: vi.spyOn(scene, "stepParticles"),
      setParallax: vi.spyOn(scene, "setParallax"),
      update: vi.spyOn(scene, "update"),
      encode: vi.spyOn(scene, "encode"),
    };
    const calls: string[] = [];
    script = (r) => {
      calls.push("script");
      const write = (key: "cameraparallax" | "cameraparallaxamount", value: SceneScalar) =>
        r.sceneState!.write({ property: "", target: { kind: "general", key } }, value);
      write("cameraparallax", true);
      write("cameraparallaxamount", 0.25);
    };
    renderer.setPointer(1, 0);
    now += 50;
    frames.at(-1)!(now);
    const order = Object.entries(spies)
      .flatMap(([name, spy]) => spy.mock.invocationCallOrder.map((index) => [index, name] as const))
      .sort((a, b) => a[0] - b[0])
      .map(([, name]) => name);
    expect(order).toEqual(["sync", "stepParticles", "setParallax", "sync", "update", "encode"]);
    expect(calls).toEqual(["script"]);
    // 这一帧推进 P 时开关还关着：P 仍在中心，g_ParallaxPosition 仍是 (0.5, 0.5)；绘制已经按脚本写的值加平移
    expect(spies.setParallax.mock.lastCall![0]).toEqual({ point: [960, 540], amount: 0.25 });
    expect(spies.update.mock.lastCall![0].parallax).toEqual([0.5, 0.5]);
    script = null;
    now += 50;
    frames.at(-1)!(now);
    expect(spies.setParallax.mock.lastCall![0]).toEqual({ point: [1920, 1080], amount: 0.25 });
    expect(spies.update.mock.lastCall![0].parallax).toEqual([1, 1]);
    renderer.destroy();
  });
});
