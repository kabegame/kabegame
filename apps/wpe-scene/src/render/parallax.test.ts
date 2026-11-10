/**
 * P5a 步骤 2（视差）：`parallax.ts` 的公式、`GpuScene` 的绘制矩阵、编译与就地写、渲染器的帧循环。步骤 3（抖动）的 `GpuScene` 矩阵、
 * 眼位、指针反投影与渲染器帧顺序也在这里（「抖动」两处，共用假设备），公式在 `shake.test.ts`；步骤 4（缩放）同样（「缩放」两处），
 * 投影公式在 `zoom.test.ts`。
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
import { particleViewProjection, rootObject, sceneViewProjection, worldMatrixOf } from "./layout";
import { identity, invert, multiply, transformPoint, translation, type Mat4 } from "./math";
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
import { shakeOffset } from "./shake";
import { SceneState } from "./state";
import { drawMatrices, type FrameInput } from "./uniforms";

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

  it("replayParallax 收每帧的 eye（P5a 步骤 3 的抖动）：和逐帧带 eye 推进相同；和帧时间不等长时报错", () => {
    const f = fields({ cameraparallaxdelay: 2.7, cameraparallaxmouseinfluence: 1 });
    const frame = { pointer: [1, 0] as [number, number], width: W, height: H };
    const dts = [0.05, 0.05, 0.25];
    const eyes: [number, number][] = [
      [4.5, 5.9],
      [-3, 2],
      [0.25, -0.5],
    ];
    let manual = initialParallaxState(W, H);
    dts.forEach((frametime, i) => {
      manual = advanceParallax(manual, parallaxInput(f, { ...frame, frametime, eye: eyes[i] }));
    });
    const replayed = replayParallax(initialParallaxState(W, H), f, frame, dts, eyes);
    expect(replayed).toEqual(manual);
    expect(replayed).not.toEqual(replayParallax(initialParallaxState(W, H), f, frame, dts));
    expect(() => replayParallax(initialParallaxState(W, H), f, frame, dts, eyes.slice(1))).toThrow("应等长");
  });

  it("replayParallax 收每帧的指针（P5a 收尾：回放逐帧光标）：和逐帧换指针推进相同；不给时取 frame.pointer；不等长报错", () => {
    const f = fields({ cameraparallaxdelay: 2.7, cameraparallaxmouseinfluence: 1 });
    const frame = { pointer: [1, 0] as [number, number], width: W, height: H };
    const dts = [0.05, 0.05, 0.25];
    const pointers: [number, number][] = [
      [0.2, 0.9],
      [1.4, -0.3],
      [0.6, 0.5],
    ];
    let manual = initialParallaxState(W, H);
    dts.forEach((frametime, i) => {
      manual = advanceParallax(manual, parallaxInput(f, { ...frame, frametime, pointer: pointers[i] }));
    });
    const replayed = replayParallax(initialParallaxState(W, H), f, frame, dts, undefined, pointers);
    expect(replayed).toEqual(manual);
    expect(replayed).not.toEqual(replayParallax(initialParallaxState(W, H), f, frame, dts));
    // 每帧都是 frame.pointer 时和不给相同
    expect(
      replayParallax(initialParallaxState(W, H), f, frame, dts, undefined, [
        frame.pointer,
        frame.pointer,
        frame.pointer,
      ]),
    ).toEqual(replayParallax(initialParallaxState(W, H), f, frame, dts));
    expect(() => replayParallax(initialParallaxState(W, H), f, frame, dts, undefined, pointers.slice(1))).toThrow(
      "应等长",
    );
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

// ———— 抖动（P5a 步骤 3）————

/** `shake1` 的第一行实测（`shake.test.ts`）：speed 1、amplitude 1、roughness 1，g_Time 5.152159690856934。 */
const SHAKE_FIELDS = { camerashake: true, camerashakespeed: 1, camerashakeamplitude: 1, camerashakeroughness: 1 };
const SHAKE_TIME = 5.152159690856934;
const SHAKE = shakeOffset(SHAKE_FIELDS, SHAKE_TIME, H);

/** `IMAGE_PROGRAM` 加 `g_EyePosition`（偏移 208）。 */
const EYE_PROGRAM = {
  ...IMAGE_PROGRAM,
  uniforms: [
    ...(IMAGE_PROGRAM as unknown as { uniforms: object[] }).uniforms,
    { name: "g_EyePosition", type: "vec3<f32>", declared: "vec3", offset: 208, size: 12 },
  ],
  uniformBlockSize: 224,
} as unknown as TranslateResult;
const vec3At = (draw: DrawView, offset: number) =>
  Array.from(new Float32Array(draw.uniformBuffer!.bytes.buffer.slice(offset, offset + 12)));

/** 逐元素按相对误差比（`(base · T(−s)) · T(o)` 与 `base · T(o − s)` 的 float32 舍入不同）。 */
function expectMatrixClose(actual: Mat4, expected: Mat4, label: string) {
  for (let i = 0; i < 16; i++)
    expect(Math.abs(actual[i] - expected[i]), `${label}[${i}]`).toBeLessThanOrEqual(
      1e-5 * Math.max(1, Math.abs(expected[i])),
    );
}

/** 一帧（同渲染器的调用顺序）：相机（抖动与缩放）、视差、同步、写每帧 uniform。 */
function shakeFrame(
  scene: GpuScene,
  state: SceneState,
  shake: [number, number],
  parallax: SceneParallax | null,
  zoom = 1,
) {
  scene.setCamera({ shake, zoom });
  scene.setParallax(parallax, state);
  scene.sync(state);
  scene.update(FRAME, state);
}

describe("GpuScene：抖动（P5a 步骤 3）", () => {
  it.each([
    { tag: "不开视差", parallax: null },
    { tag: "带视差", parallax: { point: [700, 300], amount: 0.5 } as SceneParallax },
  ])(
    "$tag：图层（直接上屏、effect 各 pass）与正交 / 透视 / 世界空间粒子的矩阵都是 base · T(o − s)",
    async ({ parallax }) => {
      const bundle = bundleOf([
        layer(0, { origin: [1460, 540, 0] }),
        effectLayer(1, { origin: [460, 840, 0] }),
        particleLayer(2, {}, { origin: [1460, 300, 0] }),
        particleLayer(3, { flags: 4 }, { origin: [460, 840, 0] }),
        particleLayer(4, { flags: 1 }, { origin: [300, 200, 0] }),
      ]);
      const { scene, state } = await open(bundle);
      shakeFrame(scene, state, SHAKE, parallax);
      const ortho = sceneViewProjection(bundle.general);
      const perspective = particleViewProjection(bundle.general);
      let checked = 0;
      for (const draw of drawsOf(scene)) {
        const layerState = state.layers.get(draw.object)!;
        const [ox, oy] = parallax
          ? parallaxOffset(parallax.amount, layerState.parallaxDepth, layerState.origin, parallax.point)
          : [0, 0];
        const shift = translation(ox - SHAKE[0], oy - SHAKE[1], 0);
        const world = worldMatrixOf(draw.object, state.layers, new Map());
        const sceneLayer = bundle.layers.find((item) => item.object === draw.object)!;
        const label = `${draw.object} ${roleOf(draw)}`;
        if (draw.step.kind === "particles") {
          const flags = sceneLayer.particle!.flags;
          const vp = multiply(flags & 4 ? perspective : ortho, shift);
          expectMatrixClose(matrixAt(draw, 0), multiply(vp, flags & 1 ? identity() : world), label);
        } else {
          const vp = multiply(ortho, shift);
          const matrices = drawMatrices(draw.step as Parameters<typeof drawMatrices>[0], world, sceneLayer.size, vp);
          if (draw.step.role === "effect") {
            // 中间 pass 读的效果纹理投影的逆
            expectMatrixClose(matrixAt(draw, 64), invert(matrices.effectTextureProjection!)!, label);
          } else {
            // 基础 pass 用自己的整面矩阵，不读 VP：和抖动无关
            expectMatrixClose(matrixAt(draw, 0), matrices.modelViewProjection, label);
            if (draw.step.role !== "base") expectMatrixClose(matrixAt(draw, 128), vp, `${label} VP`);
          }
        }
        checked++;
      }
      expect(checked).toBe(7);
      // 本地系统的原点落在 (1460, 300) + o − s
      const local = drawsOf(scene).find((draw) => draw.object === 2)!;
      const [ox, oy] = parallax ? parallaxOffset(0.5, [1, 1], [1460, 300], parallax.point) : [0, 0];
      const [x, y] = projectedOrigin(matrixAt(local, 0));
      expect(x).toBeCloseTo(1460 + ox - SHAKE[0], 2);
      expect(y).toBeCloseTo(300 + oy - SHAKE[1], 2);
    },
  );

  it("g_EyePosition 与拖尾的眼位带 s，视差不改眼位", async () => {
    const bundle = bundleOf([
      layer(0, { origin: [1460, 540, 0] }),
      particleLayer(1, { flags: 1, renderer: [{ name: "spritetrail" }] }),
    ]);
    bundle.programs = [EYE_PROGRAM, PARTICLE_PROGRAM];
    const { scene, state } = await open(bundle);
    const image = drawsOf(scene).find((draw) => draw.object === 0)!;
    expect(vec3At(image, 208)).toEqual([960, 540, 2000]);
    expect(scene.particleProbe(1)!.trailEye).toEqual([960, 540, 2000]);
    shakeFrame(scene, state, SHAKE, { point: [700, 300], amount: 0.5 });
    const eye = [Math.fround(960 + SHAKE[0]), Math.fround(540 + SHAKE[1]), 2000];
    expect(vec3At(image, 208)).toEqual(eye);
    // 世界空间系统的模型矩阵是单位阵：拖尾的眼位就是 g_EyePosition
    expect(scene.particleProbe(1)!.trailEye).toEqual(eye);
    // WPE 实测：g_EyePosition − (W/2, H/2) 就是表里的 s（shake1 第一行）
    expect(eye[0] - 960).toBeCloseTo(4.597900390625, 3);
    expect(eye[1] - 540).toBeCloseTo(5.96051025390625, 3);
  });

  it("关着时逐字节不变；s 回到 (0, 0) 时恢复原字节；s 与视差都没变时不重写，变了一帧只刷一次", async () => {
    const bundle = bundleOf([layer(0, { origin: [1460, 540, 0] }), effectLayer(1, { origin: [460, 840, 0] })]);
    bundle.programs = [EYE_PROGRAM, PARTICLE_PROGRAM];
    const { scene, state } = await open(bundle);
    scene.sync(state);
    scene.update(FRAME, state);
    const snapshot = () => drawsOf(scene).map((draw) => Buffer.from(draw.uniformBuffer!.bytes).toString("hex"));
    const plain = snapshot();
    const refresh = vi.spyOn(scene as unknown as { refreshLayer: () => void }, "refreshLayer");
    shakeFrame(scene, state, [0, 0], null);
    expect(refresh).not.toHaveBeenCalled();
    expect(snapshot()).toEqual(plain);
    shakeFrame(scene, state, SHAKE, null);
    expect(refresh).toHaveBeenCalledTimes(drawsOf(scene).length);
    expect(snapshot()).not.toEqual(plain);
    // 同一个 s 再交一次：不刷
    refresh.mockClear();
    shakeFrame(scene, state, SHAKE, null);
    expect(refresh).not.toHaveBeenCalled();
    // s 与视差同一帧都变：只刷一遍
    shakeFrame(scene, state, [1, 2], { point: [0, 0], amount: 0.5 });
    expect(refresh).toHaveBeenCalledTimes(drawsOf(scene).length);
    refresh.mockClear();
    shakeFrame(scene, state, [0, 0], null);
    expect(refresh).toHaveBeenCalledTimes(drawsOf(scene).length);
    expect(snapshot()).toEqual(plain);
  });

  it("粒子模拟的指针反投影带最近一次 setCamera 的 s、不带视差：跟随点整体平移 s", async () => {
    const bundle = bundleOf([particleLayer(0, {}, { origin: [1460, 300, 0] })]);
    const { scene, state } = await open(bundle);
    const draw = drawsOf(scene)[0];
    const step = vi.spyOn(draw.particles!.system, "step");
    const pointerOf = () => (step.mock.lastCall![2] as { pointer: [number, number] }).pointer;
    const ortho = sceneViewProjection(bundle.general);
    scene.stepParticles(0.05, 1, state, [0.25, 0.75]);
    const still = pointerOf();
    expect(still).toEqual(pointerScenePoint(ortho, [0.25, 0.75]));
    scene.setCamera({ shake: SHAKE, zoom: 1 });
    scene.setParallax({ point: [0, 0], amount: 0.5 }, state);
    scene.stepParticles(0.05, 1, state, [0.25, 0.75]);
    const shaken = pointerOf();
    expect(shaken).toEqual(pointerScenePoint(multiply(ortho, translation(-SHAKE[0], -SHAKE[1], 0)), [0.25, 0.75]));
    expect(shaken[0] - still[0]).toBeCloseTo(SHAKE[0], 2);
    expect(shaken[1] - still[1]).toBeCloseTo(SHAKE[1], 2);
  });

  it.each([
    // p5a-shakepar（speed 1 / amplitude 1 / roughness 1，视差开、mouseinfluence 1、delay 0）：控制点 0 跟随指针，速度 0
    {
      frame: 119,
      pointer: [0.8807291388511658, 0.8916666507720947],
      time: 6.000349998474121,
      previous: 5.913329601287842,
      born: [1701.07, 127.796],
    },
    {
      frame: 120,
      pointer: [0.8947916626930237, 0.979629635810852],
      time: 6.115821838378906,
      previous: 6.000349998474121,
      born: [1728.371, 32.687],
    },
  ])(
    "WPE 实测（p5a-shakepar 第 $frame 帧）：新生粒子出生在「当帧指针 + 上一帧 s」的反投影点，按当帧 s 对不上",
    async ({ pointer, time, previous, born }) => {
      const bundle = bundleOf([particleLayer(0, {}, { origin: [960, 540, 0] })], {
        ...SHAKE_FIELDS,
        cameraparallaxmouseinfluence: 1,
      });
      const { scene, state } = await open(bundle);
      const step = vi.spyOn(drawsOf(scene)[0].particles!.system, "step");
      const cursor = pointer as [number, number];
      // 渲染器的一帧：上一帧末尾交过上一帧的 s，这一帧先步进（用它），之后才交这一帧的 s
      scene.setCamera({ shake: shakeOffset(SHAKE_FIELDS, previous, H), zoom: 1 });
      scene.stepParticles(1 / 60, time, state, cursor);
      scene.setCamera({ shake: shakeOffset(SHAKE_FIELDS, time, H), zoom: 1 });
      const point = (step.mock.lastCall![2] as { pointer: [number, number] }).pointer;
      expect(Math.abs(point[0] - born[0])).toBeLessThan(1e-2);
      expect(Math.abs(point[1] - born[1])).toBeLessThan(1e-2);
      // 对照：按当帧的 s 反投影差 0.3 像素左右
      const current = shakeOffset(SHAKE_FIELDS, time, H);
      const wrong = pointerScenePoint(
        multiply(sceneViewProjection(bundle.general), translation(-current[0], -current[1], 0)),
        cursor,
      );
      expect(Math.hypot(wrong[0] - born[0], wrong[1] - born[1])).toBeGreaterThan(0.1);
    },
  );
});

// ———— 缩放（P5a 步骤 4）————

/**
 * WPE 抓帧（`p5a-zoomx15` 第 116 帧、`zoomx08` 第 117 帧，1920×1080，读数 `ignore/p5/s4/out/dump.json`，核对脚本
 * `ignore/p5/s4/ana_zoomx.py`）：抖动 speed 1 / amplitude 1 / roughness 1，视差 amount 0.5、delay 0、mouseinfluence 1；方块 A 在
 * (960, 540)，透视粒子 pz（flags 4）在 (1700, 600)，深度都是 (1, 1)。指针在窗口外，钳制后视差点是 s + (1920, 0)。MVP 都是 float32 原值。
 */
const ZOOM_MEASURED = [
  {
    tag: "zoomx15",
    zoom: 1.5,
    time: 5.870555877685547,
    pointer: [1.1276041269302368, 1.1129629611968994] as [number, number],
    eye: [969.8935546875, 550.7955932617188, 2000],
    parallax: [1, 0.009995929896831512],
    a: [
      0.0015625001396983862, 0, 0, 0, 0, 0.00277777761220932, 0, 0, 0, 0, 0.0002500000118743628, 0, -0.7731879949569702,
      0.7050182819366455, 0.5, 1,
    ],
    pz: [
      0.5154362320899963, 0, 0, 0, 0, 0.9163311123847961, 0, 0, 0, 0, 0.00033344447729177773, -1, 317.0755615234375,
      315.0406494140625, 4.8916707038879395, 329.8792724609375,
    ],
  },
  {
    tag: "zoomx08",
    zoom: 0.8,
    time: 5.914529800415039,
    pointer: [1.0906250476837158, 1.0361111164093018] as [number, number],
    eye: [970.0744018554688, 550.7951049804688, 2000],
    parallax: [1, 0.009995474480092525],
    a: [
      0.00083333341171965, 0, 0, 0, 0, 0.00148148147854954, 0, 0, 0, 0, 0.0002500000118743628, 0, -0.4125930070877075,
      0.37601086497306824, 0.5, 1,
    ],
    pz: [
      0.5154362320899963, 0, 0, 0, 0, 0.9163311123847961, 0, 0, 0, 0, 0.00033344447729177773, -1, 316.93572998046875,
      315.04132080078125, 4.795423984527588, 618.5235595703125,
    ],
  },
];

describe("GpuScene：缩放（P5a 步骤 4）", () => {
  /** 方块 A（图层，读 `g_EyePosition`）与透视粒子 pz：同 `zoomx*` 工程，编译期的 zoom 是 `zoom`。 */
  async function openZoom(zoom: number) {
    const bundle = bundleOf(
      [layer(0, { origin: [960, 540, 0] }), particleLayer(1, { flags: 4 }, { origin: [1700, 600, 0] })],
      { ...SHAKE_FIELDS, cameraparallaxmouseinfluence: 1, zoom },
    );
    bundle.programs = [EYE_PROGRAM, PARTICLE_PROGRAM];
    return { bundle, ...(await open(bundle)) };
  }
  const byObject = (scene: GpuScene) => Object.fromEntries(drawsOf(scene).map((draw) => [draw.object, draw]));

  it.each(ZOOM_MEASURED)(
    "WPE 实测（$tag）：方块 A 与透视粒子的 MVP 逐项对上（VP(zoom) · T(o − s)，透视的 d 按缩放后的可见高）；眼位只带抖动，g_ParallaxPosition 不随缩放变",
    async (item) => {
      const { scene, state, bundle } = await openZoom(item.zoom);
      // 渲染器的一帧：帧开头取 s 与 zoom，视差点带 s 推进（delay 0 一步到位），相机与视差交给场景
      const shake = shakeOffset(SHAKE_FIELDS, item.time, H);
      const parallax = advanceParallax(
        initialParallaxState(W, H),
        parallaxInput(state.general, { pointer: item.pointer, frametime: 0.05, width: W, height: H, eye: shake }),
      );
      scene.setCamera({ shake, zoom: state.general.zoom });
      scene.setParallax(drawParallax(parallax, state.general), state);
      scene.sync(state);
      scene.update({ ...FRAME, time: item.time, pointer: item.pointer, parallax: parallax.position }, state);
      const draws = byObject(scene);
      expectMatrixClose(matrixAt(draws[0], 0), new Float32Array(item.a), "A");
      expectMatrixClose(matrixAt(draws[1], 0), new Float32Array(item.pz), "pz");
      vec3At(draws[0], 208).forEach((value, i) =>
        expect(Math.abs(value - item.eye[i]), `eye[${i}]`).toBeLessThan(2e-3),
      );
      vec2At(draws[0], 192).forEach((value, i) =>
        expect(Math.abs(value - item.parallax[i]), `parallax[${i}]`).toBeLessThan(1e-6),
      );
      // 对照：透视粒子按不缩放的 d 算，m33（相机距离）差上百
      expect(Math.abs(particleViewProjection(bundle.general)[15] - item.pz[15])).toBeGreaterThan(100);
    },
  );

  it("建场景时的基准就带编译期的 zoom；setCamera 换 zoom 时重算两份基准、一帧只刷一次，回到原值恢复原字节；眼位不随 zoom 变", async () => {
    const { scene, state, bundle } = await openZoom(1.5);
    scene.sync(state);
    scene.update(FRAME, state);
    const world = (object: number) => worldMatrixOf(object, state.layers, new Map());
    /** 全部 draw 的 MVP 都是 `base(zoom) · T(−s) · W`（这里不开视差）。 */
    const expectCamera = (zoom: number, s: readonly [number, number], label: string) => {
      const shift = translation(-s[0], -s[1], 0);
      const draws = byObject(scene);
      expectMatrixClose(
        matrixAt(draws[0], 0),
        multiply(multiply(sceneViewProjection(bundle.general, zoom), shift), world(0)),
        `${label} A`,
      );
      expectMatrixClose(
        matrixAt(draws[1], 0),
        multiply(multiply(particleViewProjection(bundle.general, zoom), shift), world(1)),
        `${label} pz`,
      );
    };
    expectCamera(1.5, [0, 0], "建场景");
    const snapshot = () => drawsOf(scene).map((draw) => Buffer.from(draw.uniformBuffer!.bytes).toString("hex"));
    const plain = snapshot();
    const refresh = vi.spyOn(scene as unknown as { refreshLayer: () => void }, "refreshLayer");
    // 同一个相机：不刷
    shakeFrame(scene, state, [0, 0], null, 1.5);
    expect(refresh).not.toHaveBeenCalled();
    // 只换 zoom：整体刷一遍，眼位不变
    shakeFrame(scene, state, [0, 0], null, 2);
    expect(refresh).toHaveBeenCalledTimes(drawsOf(scene).length);
    expectCamera(2, [0, 0], "zoom 2");
    expect(vec3At(byObject(scene)[0], 208)).toEqual([960, 540, 2000]);
    // zoom 与 s 同一帧都变：只刷一遍；眼位只带 s
    refresh.mockClear();
    shakeFrame(scene, state, SHAKE, null, 0.8);
    expect(refresh).toHaveBeenCalledTimes(drawsOf(scene).length);
    expectCamera(0.8, SHAKE, "zoom 0.8 + s");
    expect(vec3At(byObject(scene)[0], 208)).toEqual([Math.fround(960 + SHAKE[0]), Math.fround(540 + SHAKE[1]), 2000]);
    // 回到编译期的值、s 为 0：字节同建场景时
    refresh.mockClear();
    shakeFrame(scene, state, [0, 0], null, 1.5);
    expect(refresh).toHaveBeenCalledTimes(drawsOf(scene).length);
    expect(snapshot()).toEqual(plain);
  });

  it.each([
    // 计划「步骤 4」补测（`ignore/p5/s4/fixtures.py`）：抖动 speed 1 / amplitude 1 / roughness 1，系统 pf 的控制点 0 跟随指针、速度 0
    {
      tag: "zoomx15 第 118 帧",
      zoom: 1.5,
      pointer: [1.1276041269302368, 1.1129629611968994],
      previous: 5.870555877685547,
      time: 5.948989391326904,
      born: [1773.226806640625, 109.46224975585938],
    },
    {
      tag: "zoomx08 第 119 帧",
      zoom: 0.8,
      pointer: [1.0906250476837158, 1.0361111164093018],
      previous: 5.914529800415039,
      time: 5.995542049407959,
      born: [2387.57421875, -172.95489501953125],
    },
  ])(
    "WPE 实测（$tag）：跟随指针的新生粒子出生在「带缩放的投影 + 上一帧 s」的反投影点（差 < 1e-2），按不缩放的投影差上百",
    async ({ zoom, pointer, previous, time, born }) => {
      const bundle = bundleOf([particleLayer(0, {}, { origin: [960, 540, 0] })], {
        ...SHAKE_FIELDS,
        cameraparallaxmouseinfluence: 1,
        zoom,
      });
      const { scene, state } = await open(bundle);
      const step = vi.spyOn(drawsOf(scene)[0].particles!.system, "step");
      const cursor = pointer as [number, number];
      // 渲染器的一帧：上一帧末尾交过上一帧的相机，这一帧先步进（用它），之后才交这一帧的
      scene.setCamera({ shake: shakeOffset(SHAKE_FIELDS, previous, H), zoom: state.general.zoom });
      scene.stepParticles(1 / 20, time, state, cursor);
      scene.setCamera({ shake: shakeOffset(SHAKE_FIELDS, time, H), zoom: state.general.zoom });
      const point = (step.mock.lastCall![2] as { pointer: [number, number] }).pointer;
      expect(Math.abs(point[0] - born[0])).toBeLessThan(1e-2);
      expect(Math.abs(point[1] - born[1])).toBeLessThan(1e-2);
      const s = shakeOffset(SHAKE_FIELDS, previous, H);
      const plain = pointerScenePoint(
        multiply(sceneViewProjection(bundle.general), translation(-s[0], -s[1], 0)),
        cursor,
      );
      expect(Math.hypot(plain[0] - born[0], plain[1] - born[1])).toBeGreaterThan(100);
    },
  );

  it("zoom 绑用户属性：登记成 general 目标、不报不支持；就地写之后下一次 setCamera 生效，字节等于用新值整场编译", async () => {
    const general = { zoom: { user: "z", value: 1.5 } };
    const compiled = await compileStatic(staticObjects(), general);
    expect(compiled.bindings).toContainEqual({ property: "z", target: { kind: "general", key: "zoom" } });
    expect(compiled.unsupported).not.toContain("general:zoom");
    expect(compiled.general.fields.zoom).toBe(1.5);
    const live = await open(compiled);
    live.state.write(
      compiled.bindings.find((item) => item.property === "z")!,
      2,
    );
    expect(live.state.general.zoom).toBe(2);
    // 渲染器的一帧：帧开头取状态里的 zoom，交给场景，再视差、同步、写每帧 uniform
    const run = ({ scene, state }: { scene: GpuScene; state: SceneState }) => {
      scene.setCamera({ shake: [0, 0], zoom: state.general.zoom });
      frame(scene, state, initialParallaxState(W, H), [0.5, 0.5]);
    };
    run(live);
    const fresh = await open(await compileStatic(staticObjects(), general, { z: 2 }));
    expect(fresh.state.general.zoom).toBe(2);
    run(fresh);
    const bytes = (scene: GpuScene) =>
      Object.fromEntries(
        drawsOf(scene).map((draw) => [draw.object, Buffer.from(draw.uniformBuffer!.bytes).toString("hex")]),
      );
    expect(bytes(live.scene)).toEqual(bytes(fresh.scene));
    // 方块 B（1460, 540）：视差偏移 250 是场景单位，缩放之后在 NDC 里是 2·(1460 + 250 − 960)/W 再乘 2
    const b = drawsOf(live.scene).find((draw) => draw.object === 1)!;
    expect(transformPoint(matrixAt(b, 0), 0, 0, 0)[0]).toBeCloseTo((2 * (1460 + 250 - 960) * 2) / W, 5);
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

  it("抖动（P5a 步骤 3）：帧开头按本帧 g_Time 与脚本之前的字段算 s，粒子步进之后、脚本之前交给场景；视差点的 eye 是 s；脚本写的下一帧生效", async () => {
    let now = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const bundle = bundleOf([layer(0)], { ...SHAKE_FIELDS, cameraparallaxmouseinfluence: 0 });
    let script: ((renderer: SceneRenderer) => void) | null = null;
    const { renderer, frames } = await start(bundle, (r) => script?.(r));
    await renderer.load(bundle);
    const scene = renderer.currentScene!;
    const spies = {
      setCamera: vi.spyOn(scene, "setCamera"),
      sync: vi.spyOn(scene, "sync"),
      stepParticles: vi.spyOn(scene, "stepParticles"),
      setParallax: vi.spyOn(scene, "setParallax"),
      update: vi.spyOn(scene, "update"),
      encode: vi.spyOn(scene, "encode"),
    };
    const write = (r: SceneRenderer, value: boolean) =>
      r.sceneState!.write({ property: "", target: { kind: "general", key: "camerashake" } }, value);
    script = (r) => write(r, false);
    now += 50;
    frames.at(-1)!(now);
    const order = Object.entries(spies)
      .flatMap(([name, spy]) => spy.mock.invocationCallOrder.map((index) => [index, name] as const))
      .sort((a, b) => a[0] - b[0])
      .map(([, name]) => name);
    expect(order).toEqual(["sync", "stepParticles", "setCamera", "setParallax", "sync", "update", "encode"]);
    // 脚本这一帧关掉了抖动，s 仍按脚本之前的字段算：本帧的 g_Time（已回绕，同 update 的帧输入）
    const time = spies.update.mock.lastCall![0].time;
    const shake = shakeOffset(SHAKE_FIELDS, time, H);
    expect(shake[0]).not.toBe(0);
    expect(spies.setCamera.mock.lastCall![0]).toEqual({ shake, zoom: 1 });
    // delay 0、mouseinfluence 0：P = eye.xy + 场景中心
    expect(sceneParallax(renderer)).toEqual({ point: [960 + shake[0], 540 + shake[1]], amount: 0.5 });
    script = null;
    now += 50;
    frames.at(-1)!(now);
    expect(spies.setCamera.mock.lastCall![0]).toEqual({ shake: [0, 0], zoom: 1 });
    expect(sceneParallax(renderer)).toEqual({ point: [960, 540], amount: 0.5 });
    renderer.destroy();
  });

  it("抖动（P5a 步骤 3）：第 n 帧粒子用第 n − 1 帧的 s、绘制用第 n 帧的 s；加载后第一帧的粒子用 s = 0", async () => {
    let now = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const shakeOf = (scene: GpuScene) => [...(scene as unknown as { shake: [number, number] }).shake];
    const steps: { shake: number[]; time: number }[] = [];
    const draws: { shake: number[]; time: number }[] = [];
    const stepParticles = GpuScene.prototype.stepParticles;
    vi.spyOn(GpuScene.prototype, "stepParticles").mockImplementation(function (
      this: GpuScene,
      ...args: Parameters<GpuScene["stepParticles"]>
    ) {
      steps.push({ shake: shakeOf(this), time: args[1] });
      return stepParticles.apply(this, args);
    });
    const update = GpuScene.prototype.update;
    vi.spyOn(GpuScene.prototype, "update").mockImplementation(function (
      this: GpuScene,
      ...args: Parameters<GpuScene["update"]>
    ) {
      draws.push({ shake: shakeOf(this), time: args[0].time });
      return update.apply(this, args);
    });
    const bundle = bundleOf([layer(0)], SHAKE_FIELDS);
    const { renderer, frames } = await start(bundle);
    // load 里画第一帧
    await renderer.load(bundle);
    for (let i = 0; i < 3; i++) {
      now += 50;
      frames.at(-1)!(now);
    }
    expect(steps.length).toBe(4);
    expect(draws.map((item) => item.time)).toEqual(steps.map((item) => item.time));
    const s = (time: number) => shakeOffset(SHAKE_FIELDS, time, H);
    expect(steps[0].shake).toEqual([0, 0]);
    for (let n = 0; n < steps.length; n++) {
      expect(draws[n].shake).toEqual(s(draws[n].time));
      if (n > 0) expect(steps[n].shake).toEqual(s(steps[n - 1].time));
    }
    // 各帧的 s 互不相同，上面的断言能区分「上一帧」与「当帧」
    expect(new Set(draws.map((item) => item.shake.join(","))).size).toBe(4);
    renderer.destroy();
  });

  it("缩放（P5a 步骤 4）：帧开头随 s 取脚本之前的 zoom、粒子步进之后交给场景；脚本写的 zoom 下一帧绘制生效，粒子再晚一帧", async () => {
    let now = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const zoomOf = (scene: GpuScene) => (scene as unknown as { zoom: number }).zoom;
    const steps: number[] = [];
    const draws: number[] = [];
    const stepParticles = GpuScene.prototype.stepParticles;
    vi.spyOn(GpuScene.prototype, "stepParticles").mockImplementation(function (
      this: GpuScene,
      ...args: Parameters<GpuScene["stepParticles"]>
    ) {
      steps.push(zoomOf(this));
      return stepParticles.apply(this, args);
    });
    const update = GpuScene.prototype.update;
    vi.spyOn(GpuScene.prototype, "update").mockImplementation(function (
      this: GpuScene,
      ...args: Parameters<GpuScene["update"]>
    ) {
      draws.push(zoomOf(this));
      return update.apply(this, args);
    });
    const bundle = bundleOf([layer(0)], { zoom: 1.5 });
    let script: ((renderer: SceneRenderer) => void) | null = null;
    const { renderer, frames } = await start(bundle, (r) => script?.(r));
    // load 里画第一帧
    await renderer.load(bundle);
    const setCamera = vi.spyOn(renderer.currentScene!, "setCamera");
    // 第 1 帧的脚本把 zoom 写成 2：这一帧交给场景的仍是脚本之前的 1.5
    script = (r) => r.sceneState!.write({ property: "", target: { kind: "general", key: "zoom" } }, 2);
    now += 50;
    frames.at(-1)!(now);
    expect(setCamera.mock.lastCall![0].zoom).toBe(1.5);
    script = null;
    for (let i = 0; i < 2; i++) {
      now += 50;
      frames.at(-1)!(now);
    }
    expect(setCamera.mock.calls.map(([camera]) => camera.zoom)).toEqual([1.5, 2, 2]);
    // 绘制：加载帧、第 1 帧 1.5，第 2 帧起 2；粒子模拟用上一帧的相机，第 3 帧才是 2
    expect(draws).toEqual([1.5, 1.5, 2, 2]);
    expect(steps).toEqual([1.5, 1.5, 1.5, 2]);
    renderer.destroy();
  });
});
