/**
 * P5b 步骤 1 的渲染侧单测（`.claude/plans/wpe-import/3-scene/phase5/phase-5b-modelflags.md`「步骤 1」）：
 * - UV 内缩分两种（`planLayer`）：`noPadding` 只关直接上屏，末 pass 与 passthrough 上屏照旧内缩（p5-REPORT `p5b-nopad`）；
 * - 透视图层（`GpuScene.uniformValues`）：画到场景目标的绘制换透视粒子那一份视图投影，视差平移在投影之前（`p5b-persp*`）。
 *
 * 透视矩阵的期望值是 WPE 抓帧里各上屏绘制的裁剪坐标（`ignore/p5/b1/persp_fixture.json`，由 `fixture_persp.py` 从
 * `ignore/p5/b0/out/dump_b.json` 取出，float32 原值）。工程 `p5b-persp`（`ignore/p5/b0/gen_b.py` 的 `p_persp`）：正交 1920×1080；
 * P1 origin (700, 700, 0)、size 600×400、angles (−1.309, 0, 0)、perspective；P2 同 P1 但 origin (1300, 400, 0) 且挂一个 effect
 * （取末 pass）；P3 origin (1500, 850, 0)、size 300×200、angles (0, 0, 0.3)、perspective；Q 同 P1 的 x 轴转角但 origin (400, 250, 0)、
 * size 300×200、不是 perspective（正交对照）；全部 `parallaxDepth 1 1`、scale 1。四个变体：缺省（`perspectiveoverridefov` 95 度）、
 * `fov30`、`par`（`cameraparallax`，amount 0.5、delay 0、mouseinfluence 0，视差点 (960, 540)）、`zoom`（1.5）。
 * 比 x、y、w，相对误差 < 1e-4（z 不比：WPE 的深度范围另有约定，P5d 再核对）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generalDefaults, type GeneralValues } from "../compile/bindings";
import type { SceneBundle, SceneEffect, SceneEffectStep, SceneLayer, ScenePass, SceneTexture } from "../compile/bundle";
import { particleFov } from "../compile/particles";
import { BLOOM_DEFAULTS } from "../compile/postprocess";
import type { TranslateResult } from "../wpesl2wgsl";
import { planLayer, type DrawStep, type LayerPlan, type LayerStep } from "./graph";
import { particleViewProjection, sceneViewProjection, uvInset, worldMatrixOf } from "./layout";
import { multiply, transformPoint, translation, type Mat4 } from "./math";
import { parallaxOffset } from "./parallax";
import { GpuScene } from "./scene";
import { SceneState } from "./state";
import { drawMatrices, type FrameInput } from "./uniforms";

vi.mock("./device", () => ({ acquireGpu: vi.fn() }));
vi.mock("../fileUrl", () => ({ fileToUrl: (path: string) => path }));

const W = 1920;
const H = 1080;

function pass(key: string, extra: Partial<ScenePass> = {}): ScenePass {
  return {
    key,
    program: 0,
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

const texture = (width: number, height: number, textureWidth = width, textureHeight = height): SceneTexture => ({
  path: `t${width}x${height}`,
  source: "",
  format: 0,
  width,
  height,
  textureWidth,
  textureHeight,
  flags: 0,
  clampUVs: true,
  noInterpolation: false,
  mips: [{ width: textureWidth, height: textureHeight, bytes: new Uint8Array(textureWidth * textureHeight * 4) }],
});

function layer(object: number, extra: Partial<SceneLayer> = {}): SceneLayer {
  return {
    id: object + 1,
    object,
    parent: null,
    name: `layer ${object}`,
    origin: [960, 540, 0],
    scale: [1, 1, 1],
    angles: [0, 0, 0],
    size: [480, 270],
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
    group: null,
    subtree: [],
    groupUpload: null,
    copyBackground: true,
    fullscreen: false,
    fullscreenSize: null,
    passes: [pass(`objects/${object}/passes/0`, { textures: { 0: 0 } })],
    colorBlendMode: 0,
    effects: [],
    passthrough: null,
    particle: null,
    ...extra,
  };
}

const effectDraw = (scenePass: ScenePass, target: string | null = null): SceneEffectStep => ({
  kind: "draw",
  pass: scenePass,
  target,
  compose: false,
  binds: null,
});

/** 一个 effect：`passes` 为 2 时第一个 pass 画进 fbo（中间 pass），最后一个上屏。 */
function effect(object: number, passes = 1): SceneEffect {
  const steps = Array.from({ length: passes }, (_, i) =>
    effectDraw(pass(`objects/${object}/effects/0/passes/${i}`), i < passes - 1 ? "_rt_Half" : null),
  );
  return {
    source: 0,
    id: 100,
    name: "kbfx",
    file: "effects/kbfx/effect.json",
    fbos: passes > 1 ? [{ name: "_rt_Half", format: "rgba8888", scale: 2, unique: false, repeat: false }] : [],
    steps,
    enabled: true,
    visibleBound: false,
    unsupported: [],
  };
}

const draws = (steps: LayerStep[]) => steps.filter((step): step is DrawStep => step.kind === "draw");
const insets = (plan: LayerPlan) => Object.fromEntries(draws(plan.steps).map((step) => [step.role, [...step.inset]]));

describe("UV 内缩分两种（p5b-nopad）", () => {
  // 编辑器不补边的 NPOT 纹理（写 nopadding 的纹理图像尺寸等于纹理尺寸）
  const textures = [texture(480, 270)];
  const e = uvInset([480, 270], textures[0]);

  it("内缩量就是 WPE 读到的 0.15 / 纹理尺寸（0.0003、0.00056）", () => {
    expect(e[0]).toBeCloseTo(0.15 / 480, 9);
    expect(e[1]).toBeCloseTo(0.15 / 270, 9);
  });
  it("noPadding：直接上屏不内缩", () => {
    expect(insets(planLayer(layer(0, { noPadding: true }), textures))).toEqual({ direct: [0, 0] });
  });
  it("noPadding：带 effect 时末 pass 照旧内缩，中间 pass、基础 pass 不内缩", () => {
    expect(insets(planLayer(layer(0, { noPadding: true, effects: [effect(0)] }), textures))).toEqual({
      base: [0, 0],
      final: e,
    });
    expect(insets(planLayer(layer(0, { noPadding: true, effects: [effect(0, 2)] }), textures))).toEqual({
      base: [0, 0],
      effect: [0, 0],
      final: e,
    });
  });
  it("noPadding：colorBlendMode 混合的 passthrough 上屏照旧内缩", () => {
    const plan = planLayer(layer(0, { noPadding: true, colorBlendMode: 12, passthrough: pass("pt") }), textures);
    expect(insets(plan)).toEqual({ base: [0, 0], passthrough: e });
  });
  it("solidLayer：两种都不内缩，带不带 noPadding 一样", () => {
    for (const noPadding of [false, true]) {
      expect(insets(planLayer(layer(0, { solidLayer: true, noPadding }), textures))).toEqual({ direct: [0, 0] });
      expect(insets(planLayer(layer(0, { solidLayer: true, noPadding, effects: [effect(0)] }), textures))).toEqual({
        base: [0, 0],
        final: [0, 0],
      });
    }
  });
  it("不带标志：两种都内缩", () => {
    expect(insets(planLayer(layer(0), textures))).toEqual({ direct: e });
    expect(insets(planLayer(layer(0, { effects: [effect(0)] }), textures))).toEqual({ base: [0, 0], final: e });
  });
});

// ———— 透视图层：和 WPE 抓帧比裁剪坐标 ————

/** 一个角：模型空间 (x, y)（z 为 0），WPE 的裁剪坐标 x、y、w。 */
type Corner = readonly [x: number, y: number, clipX: number, clipY: number, clipW: number];
type LayerName = "P1" | "P2" | "P3" | "Q";

/** WPE 抓帧（`persp_fixture.json`）：各变体、各图层上屏绘制的四个角。 */
const MEASURED: Record<string, Record<LayerName, Corner[]>> = {
  "p5b-persp": {
    P1: [
      [-300, 200, -288.644287109375, 194.0452117919922, 688.004150390625],
      [-300, -200, -288.644287109375, 99.18074035644531, 301.6335144042969],
      [300, 200, 20.617446899414062, 194.0452117919922, 688.004150390625],
      [300, -200, 20.617446899414062, 99.18074035644531, 301.6335144042969],
    ],
    P2: [
      [-300, 200, 20.617416381835938, -80.85411071777344, 688.004150390625],
      [-300, -200, 20.617416381835938, -175.7185821533203, 301.6335144042969],
      [300, 200, 329.879150390625, -80.85411071777344, 688.004150390625],
      [300, -200, 329.879150390625, -175.7185821533203, 301.6335144042969],
    ],
    P3: [
      [-150, 100, 189.24111938476562, 330.9839782714844, 494.81884765625],
      [-150, -100, 219.7054901123047, 155.90306091308594, 494.81884765625],
      [150, 100, 336.96563720703125, 412.2222900390625, 494.81884765625],
      [150, -100, 367.4300231933594, 237.14138793945312, 494.81884765625],
    ],
    Q: [
      [-150, 100, -0.7395833134651184, -0.4891081154346466, 1],
      [-150, -100, -0.7395833134651184, -0.5849659442901611, 1],
      [150, 100, -0.4270833134651184, -0.4891081154346466, 1],
      [150, -100, -0.4270833134651184, -0.5849659442901611, 1],
    ],
  },
  "p5b-persp-fov30": {
    P1: [
      [-300, 200, -1175.595947265625, 790.3110961914062, 2208.492919921875],
      [-300, -200, -1175.595947265625, 403.94525146484375, 1822.1221923828125],
      [300, 200, 83.97100830078125, 790.3110961914062, 2208.492919921875],
      [300, -200, 83.97100830078125, 403.94525146484375, 1822.1221923828125],
    ],
    P2: [
      [-300, 200, 83.97113037109375, -329.30413818359375, 2208.492919921875],
      [-300, -200, 83.97113037109375, -715.6699829101562, 1822.1221923828125],
      [300, 200, 1343.5380859375, -329.30413818359375, 2208.492919921875],
      [300, -200, 1343.5380859375, -715.6699829101562, 1822.1221923828125],
    ],
    P3: [
      [-150, 100, 770.744873046875, 1348.0377197265625, 2015.3074951171875],
      [-150, -100, 894.8206787109375, 634.9649047851562, 2015.3074951171875],
      [150, 100, 1372.4000244140625, 1678.90673828125, 2015.3074951171875],
      [150, -100, 1496.475830078125, 965.8338012695312, 2015.3074951171875],
    ],
    Q: [
      [-150, 100, -0.7395833134651184, -0.4891081154346466, 1],
      [-150, -100, -0.7395833134651184, -0.5849659442901611, 1],
      [150, 100, -0.4270833134651184, -0.4891081154346466, 1],
      [150, -100, -0.4270833134651184, -0.5849659442901611, 1],
    ],
  },
  "p5b-persp-par": {
    P1: [
      [-300, 200, -355.6510009765625, 267.3517150878906, 688.004150390625],
      [-300, -200, -355.6510009765625, 172.4872283935547, 301.6335144042969],
      [300, 200, -46.38926696777344, 267.3517150878906, 688.004150390625],
      [300, -200, -46.38926696777344, 172.4872283935547, 301.6335144042969],
    ],
    P2: [
      [-300, 200, 108.24159240722656, -144.99729919433594, 688.004150390625],
      [-300, -200, 108.24159240722656, -239.8617706298828, 301.6335144042969],
      [300, 200, 417.50335693359375, -144.99729919433594, 688.004150390625],
      [300, -200, 417.50335693359375, -239.8617706298828, 301.6335144042969],
    ],
    P3: [
      [-150, 100, 328.4089050292969, 473.0152893066406, 494.81884765625],
      [-150, -100, 358.873291015625, 297.93438720703125, 494.81884765625],
      [150, 100, 476.1334228515625, 554.2536010742188, 494.81884765625],
      [150, -100, 506.5978088378906, 379.1726989746094, 494.81884765625],
    ],
    Q: [
      [-150, 100, -1.0312501192092896, -0.7576265335083008, 1],
      [-150, -100, -1.0312501192092896, -0.8534843921661377, 1],
      [150, 100, -0.7187500596046448, -0.7576265335083008, 1],
      [150, -100, -0.7187500596046448, -0.8534843921661377, 1],
    ],
  },
  "p5b-persp-zoom": {
    P1: [
      [-300, 200, -288.644287109375, 194.0452117919922, 523.0645751953125],
      [-300, -200, -288.644287109375, 99.18074035644531, 136.69393920898438],
      [300, 200, 20.617446899414062, 194.0452117919922, 523.0645751953125],
      [300, -200, 20.617446899414062, 99.18074035644531, 136.69393920898438],
    ],
    P2: [
      [-300, 200, 20.617416381835938, -80.85411071777344, 523.0645751953125],
      [-300, -200, 20.617416381835938, -175.7185821533203, 136.69393920898438],
      [300, 200, 329.879150390625, -80.85411071777344, 523.0645751953125],
      [300, -200, 329.879150390625, -175.7185821533203, 136.69393920898438],
    ],
    P3: [
      [-150, 100, 189.24111938476562, 330.9839782714844, 329.8792724609375],
      [-150, -100, 219.7054901123047, 155.90306091308594, 329.8792724609375],
      [150, 100, 336.96563720703125, 412.2222900390625, 329.8792724609375],
      [150, -100, 367.4300231933594, 237.14138793945312, 329.8792724609375],
    ],
    Q: [
      [-150, 100, -1.1093751192092896, -0.7336621284484863, 1],
      [-150, -100, -1.1093751192092896, -0.8774487972259521, 1],
      [150, 100, -0.6406250596046448, -0.7336621284484863, 1],
      [150, -100, -0.6406250596046448, -0.8774487972259521, 1],
    ],
  },
};

/** `p5b-persp` 的四个图层（`gen_b.py` 的 `p_persp`）：`object` 是 bundle 里的下标。 */
const LAYERS: Record<
  LayerName,
  { object: number; origin: number[]; size: number[]; angles: number[]; perspective: boolean; effect: boolean }
> = {
  P1: { object: 0, origin: [700, 700, 0], size: [600, 400], angles: [-1.309, 0, 0], perspective: true, effect: false },
  P2: { object: 1, origin: [1300, 400, 0], size: [600, 400], angles: [-1.309, 0, 0], perspective: true, effect: true },
  P3: { object: 2, origin: [1500, 850, 0], size: [300, 200], angles: [0, 0, 0.3], perspective: true, effect: false },
  Q: { object: 3, origin: [400, 250, 0], size: [300, 200], angles: [-1.309, 0, 0], perspective: false, effect: false },
};
const NAMES = Object.keys(LAYERS) as LayerName[];

/** 四个变体：fov（度）、zoom、视差（视差点与 amount；关着为 null）。 */
const VARIANTS: {
  tag: string;
  fov: number;
  zoom: number;
  parallax: { point: [number, number]; amount: number } | null;
}[] = [
  { tag: "p5b-persp", fov: 95, zoom: 1, parallax: null },
  { tag: "p5b-persp-fov30", fov: 30, zoom: 1, parallax: null },
  { tag: "p5b-persp-par", fov: 95, zoom: 1, parallax: { point: [W / 2, H / 2], amount: 0.5 } },
  { tag: "p5b-persp-zoom", fov: 95, zoom: 1.5, parallax: null },
];

/** MVP 作用在每个角上，和 WPE 的裁剪坐标 x、y、w 的相对误差。 */
function relativeErrors(mvp: Mat4, corners: readonly Corner[]): number[] {
  return corners.flatMap(([x, y, ...expected]) => {
    const [cx, cy, , cw] = transformPoint(mvp, x, y, 0);
    return [cx, cy, cw].map((value, i) => Math.abs(value - expected[i]) / Math.abs(expected[i]));
  });
}

describe("透视图层的矩阵：P_persp · T(o) · W 对上 WPE（纯函数）", () => {
  it.each(VARIANTS)("$tag：P1、P2（末 pass）、P3 用透视粒子的视图投影，Q 用正交，相对误差 < 1e-4", (variant) => {
    const general = { width: W, height: H, perspectiveOverrideFov: particleFov(variant.fov) };
    for (const name of NAMES) {
      const def = LAYERS[name];
      const base = def.perspective
        ? particleViewProjection(general, variant.zoom)
        : sceneViewProjection(general, variant.zoom);
      const [ox, oy] = variant.parallax
        ? parallaxOffset(variant.parallax.amount, [1, 1], def.origin, variant.parallax.point)
        : [0, 0];
      // 视差平移右乘：先在世界坐标里平移 o，再投影
      const viewProjection = ox === 0 && oy === 0 ? base : multiply(base, translation(ox, oy, 0));
      const world = worldMatrixOf(
        0,
        new Map([[0, { origin: def.origin, angles: def.angles, scale: [1, 1, 1], parent: null }]]),
        new Map(),
      );
      const { modelViewProjection } = drawMatrices(
        { role: def.effect ? "final" : "direct" },
        world,
        def.size,
        viewProjection,
      );
      const errors = relativeErrors(modelViewProjection, MEASURED[variant.tag][name]);
      expect(Math.max(...errors), `${variant.tag} ${name}`).toBeLessThan(1e-4);
    }
  });
});

// ———— GpuScene：透视只换画到场景目标的绘制 ————

interface FakeBuffer {
  label: string;
  bytes: Uint8Array;
  writes: number;
  destroy(): void;
}

/** 假设备（同 `parallax.test.ts`）：只记缓冲的字节（uniform 读回用），其余调用都是空操作。 */
class FakeGpu {
  readonly buffers: FakeBuffer[] = [];
  readonly device: GPUDevice;

  constructor() {
    const renderPass = () => ({
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
        beginRenderPass: () => renderPass(),
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

/** 图像 / effect 程序：MVP（偏移 0）与视图投影（偏移 64）。 */
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
    { name: "g_ViewProjectionMatrix", type: "mat4x4<f32>", declared: "mat4", offset: 64, size: 64 },
  ],
  uniformBlockSize: 128,
  textures: [{ slot: 0, binding: 1, samplerBinding: 2, kind: "2d" }],
} as unknown as TranslateResult;

function generalFields(extra: Partial<GeneralValues> = {}): GeneralValues {
  return { ...generalDefaults(), ...extra };
}

/** `p5b-persp` 的四个图层；`effectPasses` 是 P2 的 effect 的绘制 pass 数（WPE 工程是 1，2 时多一个画进 fbo 的中间 pass）。 */
function perspBundle(fov: number, zoom: number, effectPasses = 1): SceneBundle {
  const layers = NAMES.map((name) => {
    const def = LAYERS[name];
    return layer(def.object, {
      name,
      origin: def.origin,
      angles: def.angles,
      size: def.size,
      perspective: def.perspective,
      effects: def.effect ? [effect(def.object, effectPasses)] : [],
    });
  });
  return {
    general: {
      width: W,
      height: H,
      fields: generalFields({ zoom }),
      clearVariable: false,
      perspectiveOverrideFov: particleFov(fov),
      postprocess: { level: "disabled", bloomFlag: false, hdrFlag: false, bloom: false, hdr: false },
      bloom: { ...BLOOM_DEFAULTS, tint: [1, 1, 1] },
    },
    layers,
    programs: [IMAGE_PROGRAM],
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
}
const drawsOf = (scene: GpuScene): DrawView[] => [...(scene as unknown as { draws: Set<DrawView> }).draws];
const matrixAt = (draw: DrawView, offset: number): Mat4 =>
  new Float32Array(draw.uniformBuffer!.bytes.buffer.slice(offset, offset + 64));
const bytes = (m: Mat4) => Buffer.from(m.buffer, m.byteOffset, m.byteLength).toString("hex");
/** 某图层某角色的 draw。 */
function drawOf(scene: GpuScene, name: LayerName, role: string): DrawView {
  const draw = drawsOf(scene).find((item) => item.object === LAYERS[name].object && item.step.role === role);
  if (!draw) throw new Error(`${name} 没有 ${role} 的 draw`);
  return draw;
}

const FRAME: FrameInput = {
  time: 1,
  frametime: 0.05,
  daytime: 0.5,
  pointer: [0.5, 0.5],
  pointerLast: [0.5, 0.5],
  cursor: [0.5, 0.5],
};

async function open(bundle: SceneBundle) {
  const gpu = new FakeGpu();
  const state = SceneState.fromBundle(bundle);
  const scene = await GpuScene.build(gpu.device, bundle, state, new Set(), [], {
    ignoreUnsupported: true,
    particles: { seed: 1 },
  });
  return { scene, state };
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

describe("GpuScene：透视图层的上屏矩阵（p5b-persp，WPE 实测）", () => {
  it.each(VARIANTS)(
    "$tag：直接上屏与末 pass 的 MVP 把四个角投到 WPE 的裁剪坐标（x、y、w 相对误差 < 1e-4）",
    async (variant) => {
      const { scene, state } = await open(perspBundle(variant.fov, variant.zoom));
      if (variant.parallax) scene.setParallax(variant.parallax, state);
      scene.update(FRAME, state);
      for (const name of NAMES) {
        const mvp = matrixAt(drawOf(scene, name, LAYERS[name].effect ? "final" : "direct"), 0);
        const errors = relativeErrors(mvp, MEASURED[variant.tag][name]);
        expect(Math.max(...errors), `${variant.tag} ${name}`).toBeLessThan(1e-4);
      }
    },
  );

  it("画进合成 RT / fbo 的 pass 不换：基础 pass 是整面正交，中间 pass 的视图投影是场景正交，末 pass 是透视", async () => {
    const bundle = perspBundle(95, 1, 2);
    const { scene, state } = await open(bundle);
    scene.update(FRAME, state);
    const ortho = sceneViewProjection(bundle.general);
    const perspective = particleViewProjection(bundle.general);
    const world = worldMatrixOf(
      0,
      new Map([[0, { origin: LAYERS.P2.origin, angles: LAYERS.P2.angles, scale: [1, 1, 1], parent: null }]]),
      new Map(),
    );
    const base = drawMatrices({ role: "base" }, world, LAYERS.P2.size, perspective);
    expect(bytes(matrixAt(drawOf(scene, "P2", "base"), 0))).toBe(bytes(base.modelViewProjection));
    expect(bytes(matrixAt(drawOf(scene, "P2", "effect"), 64))).toBe(bytes(ortho));
    expect(bytes(matrixAt(drawOf(scene, "P2", "final"), 64))).toBe(bytes(perspective));
    // 正交对照层不受影响
    expect(bytes(matrixAt(drawOf(scene, "Q", "direct"), 64))).toBe(bytes(ortho));
    expect(bytes(matrixAt(drawOf(scene, "P1", "direct"), 64))).toBe(bytes(perspective));
  });

  it("抖动：透视图层和透视粒子一样右乘 T(−s)", async () => {
    const bundle = perspBundle(95, 1);
    const { scene, state } = await open(bundle);
    scene.setCamera({ shake: [10, -5], zoom: 1 });
    // setCamera 只改场景级的值，draw 的重写和视差共用一次
    scene.setParallax(null, state);
    scene.update(FRAME, state);
    const shaken = multiply(particleViewProjection(bundle.general), translation(-10, 5, 0));
    expect(bytes(matrixAt(drawOf(scene, "P1", "direct"), 64))).toBe(bytes(shaken));
  });
});
