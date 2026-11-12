/**
 * P5b 步骤 3 的渲染侧单测（`.claude/plans/wpe-import/3-scene/phase5/phase-5b-modelflags.md`「步骤 3」）：`fullscreen` 模型。
 * - 渲染图（`planLayer`）：合成路径的基础 pass 换成 `snapshot` → `copy`（快照 → 合成 RT 0），上屏画 NDC 四边形；fullscreenlayer
 *   没有 effect 时整层不画；非组合层没有 effect 时直接上屏画 NDC 四边形；合成 RT 取 `fullscreenSize`；两种内缩都为 0；
 * - 矩阵：直接上屏照常（FSQ 的四角对上 WPE 的裁剪坐标），其余角色是单位阵加 NDC 正交（F1 的上屏对上 WPE），视差、抖动、缩放、
 *   透视都不改它；
 * - GpuScene 假设备：op 序列与编码轨迹（快照 → 拷进合成 RT，没有基础绘制）、顶点是 ±1、运行时开关 effect。
 *
 * 工程（`ignore/p5/b0/gen_b.py`），正交 1920×1080：
 * - `p5b-fs`（`p_fs`）：F1 是 fullscreenlayer（WPE 的 `models/util/fullscreenlayer.json`，材质 passthrough 着色器、槽 0
 *   `_rt_FullFrameBuffer`、translucent），origin (100, 50)、size 300×200、scale 0.5、angles z 0.7，挂 `kbfx`（一个 pass）；
 *   前面有一个半透明绿层。`p5b-fsnofx` 同上但 F1 没有 effect。
 * - `p5b-fsmvp`（`p_fsmvp`）：两个非组合层的 fullscreen 模型。FSBG 是 passthrough 着色器（不乘 MVP）+ `kbbg`（256×256）、blending
 *   normal，origin (300, 200)、size 100×100；FSQ 是 genericimage2（乘 MVP）+ `util/white`（32×32），origin (1500, 800)、
 *   size 300×300、scale 50、color (1, 0, 1)。
 *
 * 矩阵真值是 WPE 抓帧（`ignore/p5/b3/fs_fixture.json`，由 `fixture_fs.py` 从 `ignore/p5/b0/out/dump_b.json` 取出，float32 原值，
 * 16 个数按列主序、第 12、13 个是平移，和 `Mat4` 同一约定）。F1 上屏比 x、y 两行与平移（下标 0、1、4、5、12、13）；z 这里另比一次
 * （NDC 正交按 WPE 的 `ortho(−1, 1, −1, 1, −1, 1)` 建，z = 0 落在 0.5，和场景正交同一约定）。FSQ 比四角裁剪坐标的 x、y、w。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generalDefaults } from "../compile/bindings";
import {
  FRAMEBUFFER_RT,
  type SceneBundle,
  type SceneEffect,
  type SceneEffectStep,
  type SceneLayer,
  type ScenePass,
  type SceneTexture,
} from "../compile/bundle";
import { particleFov } from "../compile/particles";
import { BLOOM_DEFAULTS } from "../compile/postprocess";
import type { TranslateResult } from "../wpesl2wgsl";
import {
  compositeSize,
  planLayer,
  planSignature,
  variantPlans,
  type DrawStep,
  type LayerPlan,
  type LayerStep,
} from "./graph";
import { sceneViewProjection, worldMatrixOf } from "./layout";
import { transformPoint, type Mat4 } from "./math";
import { GpuScene } from "./scene";
import { SceneState } from "./state";
import { drawMatrices, type FrameInput } from "./uniforms";

vi.mock("./device", () => ({ acquireGpu: vi.fn() }));
vi.mock("../fileUrl", () => ({ fileToUrl: (path: string) => path }));

const W = 1920;
const H = 1080;

// ———— WPE 真值 ————

/** `p5b-fs` 事件 76：F1 的 `kbfx` 上屏（后备缓冲 1920×1080，槽 0 是 1920×1080 的合成 RT，输入顶点 ±1，裁剪坐标 ±1）。 */
const WPE_F1_FINAL = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0.5, 0, 0, 0, 0.5, 1] as const;
/** `p5b-fsmvp` 事件 55：FSQ 直接上屏（槽 0 是 32×32 的 `util/white`，输入顶点 ±1）。 */
const WPE_FSQ_MVP = [
  0.0520833358168602, 0, 0, 0, 0, 0.09259258955717087, 0, 0, 0, 0, 0.0002500000118743628, 0, 0.5625001192092896,
  0.4814814329147339, 0.5, 1,
] as const;
/** `p5b-fsmvp` 事件 55 的四角：输入顶点（模型空间）→ WPE 的裁剪坐标。 */
const WPE_FSQ_CORNERS: { position: [number, number]; clip: [number, number, number, number] }[] = [
  { position: [-1, 1], clip: [0.5104168057441711, 0.5740740299224854, 0.5, 1] },
  { position: [-1, -1], clip: [0.5104168057441711, 0.3888888359069824, 0.5, 1] },
  { position: [1, 1], clip: [0.614583432674408, 0.5740740299224854, 0.5, 1] },
  { position: [1, -1], clip: [0.614583432674408, 0.3888888359069824, 0.5, 1] },
];

/** 比较的下标：x、y 两行（第 0、1 列）与平移。 */
const COMPARED = [0, 1, 4, 5, 12, 13];
const ALL = Array.from({ length: 16 }, (_, i) => i);

/** 期望非 0 的元素比相对误差，期望为 0 的比绝对误差。 */
function matrixErrors(actual: ArrayLike<number>, expected: readonly number[], indices = COMPARED) {
  const relative: number[] = [];
  const absolute: number[] = [];
  for (const i of indices) {
    const diff = Math.abs(actual[i] - expected[i]);
    if (expected[i] === 0) absolute.push(diff);
    else relative.push(diff / Math.abs(expected[i]));
  }
  return { relative: Math.max(0, ...relative), absolute: Math.max(0, ...absolute) };
}
function expectMvp(actual: ArrayLike<number>, expected: readonly number[], label: string, indices = COMPARED) {
  const { relative, absolute } = matrixErrors(actual, expected, indices);
  expect(relative, `${label} 相对误差`).toBeLessThan(1e-5);
  expect(absolute, `${label} 绝对误差（期望为 0 的元素）`).toBeLessThan(1e-7);
}
/** 四角裁剪坐标的 x、y、w 相对误差（最大值）。 */
function cornerError(mvp: Mat4): number {
  let worst = 0;
  for (const { position, clip } of WPE_FSQ_CORNERS) {
    const actual = transformPoint(mvp, position[0], position[1], 0);
    for (const k of [0, 1, 3]) worst = Math.max(worst, Math.abs(actual[k] - clip[k]) / Math.abs(clip[k]));
  }
  return worst;
}

// ———— 图层 ————

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
/** bundle 纹理：`kbbg`（256×256）、`util/white`（32×32）。 */
const TEXTURE = { kbbg: 0, white: 1 } as const;
const TEXTURES = [texture(256, 256), texture(32, 32)];

/** 程序下标：passthrough 着色器（fullscreenlayer、FSBG）、genericimage2（FSQ、对照层）、kbfx、colorBlendMode 混合上屏。 */
const PROGRAM = { passthrough: 0, image: 1, kbfx: 2, blend: 3 } as const;

const effectDraw = (scenePass: ScenePass, target: string | null = null): SceneEffectStep => ({
  kind: "draw",
  pass: scenePass,
  target,
  compose: false,
  binds: null,
});

/** `kbfx`：`passes` 为 2 时第一个 pass 画进 fbo `_rt_Half`（中间 pass），最后一个上屏。 */
function kbfx(object: number, passes = 1, extra: Partial<SceneEffect> = {}): SceneEffect {
  const steps = Array.from({ length: passes }, (_, i) =>
    effectDraw(
      pass(`objects/${object}/effects/0/passes/${i}`, { program: PROGRAM.kbfx, blending: "normal" }),
      i < passes - 1 ? "_rt_Half" : null,
    ),
  );
  return {
    source: 0,
    id: 50,
    name: "kbfx",
    file: "effects/kbfx/effect.json",
    fbos: passes > 1 ? [{ name: "_rt_Half", format: "rgba8888", scale: 2, unique: false, repeat: false }] : [],
    steps,
    enabled: true,
    visibleBound: false,
    unsupported: [],
    ...extra,
  };
}

function layer(object: number, extra: Partial<SceneLayer> = {}): SceneLayer {
  return {
    id: object + 10,
    object,
    parent: null,
    name: `layer ${object}`,
    origin: [960, 540, 0],
    scale: [1, 1, 1],
    angles: [0, 0, 0],
    size: [1920, 1080],
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
    passes: [pass(`objects/${object}/passes/0`, { program: PROGRAM.image, textures: { 0: TEXTURE.kbbg } })],
    colorBlendMode: 0,
    effects: [],
    passthrough: null,
    particle: null,
    ...extra,
  };
}

/** colorBlendMode 混合的上屏材质（effectpassthrough）：槽 0 合成 RT（渲染图填）、槽 1 快照，g_Color4 置 1。 */
const blendPass = (object: number) =>
  pass(`objects/${object}/passthrough`, {
    program: PROGRAM.blend,
    runtime: { 1: FRAMEBUFFER_RT },
    framebuffer: true,
    uniforms: { g_Color4: [1, 1, 1, 1] },
  });

/** `p5b-fs` 的 F1：fullscreenlayer（编译期已定 size 2×2、合成 RT 取场景尺寸）。`effects` 缺省挂一个 `kbfx`。 */
function f1(object: number, extra: Partial<SceneLayer> = {}): SceneLayer {
  return layer(object, {
    name: "F1",
    origin: [100, 50, 0],
    scale: [0.5, 0.5, 1],
    angles: [0, 0, 0.7],
    size: [2, 2],
    passthroughModel: true,
    fullscreen: true,
    fullscreenSize: [W, H],
    passes: [
      pass(`objects/${object}/passes/0`, {
        program: PROGRAM.passthrough,
        runtime: { 0: FRAMEBUFFER_RT },
        framebuffer: true,
      }),
    ],
    effects: [kbfx(object)],
    ...extra,
  });
}
/** `p5b-fsmvp` 的 FSBG：非组合层，passthrough 着色器 + `kbbg`，normal。 */
const fsbg = (object: number, extra: Partial<SceneLayer> = {}) =>
  layer(object, {
    name: "FSBG",
    origin: [300, 200, 0],
    size: [2, 2],
    fullscreen: true,
    fullscreenSize: [256, 256],
    passes: [
      pass(`objects/${object}/passes/0`, {
        program: PROGRAM.passthrough,
        textures: { 0: TEXTURE.kbbg },
        blending: "normal",
      }),
    ],
    ...extra,
  });
/** `p5b-fsmvp` 的 FSQ：非组合层，genericimage2 + `util/white`，translucent，scale 50。 */
const fsq = (object: number, extra: Partial<SceneLayer> = {}) =>
  layer(object, {
    name: "FSQ",
    origin: [1500, 800, 0],
    scale: [50, 50, 1],
    color: [1, 0, 1],
    size: [2, 2],
    fullscreen: true,
    fullscreenSize: [32, 32],
    passes: [pass(`objects/${object}/passes/0`, { program: PROGRAM.image, textures: { 0: TEXTURE.white } })],
    ...extra,
  });

const draws = (steps: LayerStep[]) => steps.filter((step): step is DrawStep => step.kind === "draw");
const targetName = (target: { kind: string; index?: number; name?: string }) =>
  target.kind === "composite" ? `c${target.index}` : target.kind === "fbo" ? target.name : "scene";
const kinds = (steps: LayerStep[]) =>
  steps.map((step) =>
    step.kind === "draw"
      ? `${step.role}→${targetName(step.target)}`
      : step.kind === "copy" || step.kind === "clear"
        ? `${step.kind}→${targetName(step.target)}`
        : step.kind,
  );
const stepOf = (plan: LayerPlan, role: string) => draws(plan.steps).find((step) => step.role === role)!;

describe("planLayer：fullscreen（p5b-fs、p5b-fsnofx、p5b-fsmvp）", () => {
  it("F1（fullscreenlayer + kbfx）：快照 → 快照拷进合成 RT 0 → effect 末 pass 画 NDC 四边形上屏，没有 compose / base", () => {
    const plan = planLayer(f1(0), TEXTURES);
    expect(kinds(plan.steps)).toEqual(["snapshot", "copy→c0", "final→scene"]);
    expect(plan.composite).toEqual({ count: 1, width: W, height: H });
    expect(plan.reasons).toEqual([]);
    expect(plan.steps[1]).toEqual({
      kind: "copy",
      effect: null,
      source: { kind: "framebuffer" },
      target: { kind: "composite", index: 0 },
    });
    expect(draws(plan.steps).map((step) => step.role)).toEqual(["final"]);
    expect(stepOf(plan, "final")).toMatchObject({
      geometry: "fullscreen",
      uv: [1, 1],
      inset: [0, 0],
      blending: "translucent",
      inputs: { 0: { kind: "composite", index: 0 } },
    });
  });

  it("fsnofx（fullscreenlayer 没有 effect）：空计划；colorBlendMode 31 同样不画", () => {
    expect(planLayer(f1(0, { effects: [] }), TEXTURES)).toEqual({ composite: null, steps: [], reasons: [] });
    expect(planLayer(f1(0, { effects: [], colorBlendMode: 31 }), TEXTURES).steps).toEqual([]);
  });

  it("FSBG（非组合层、passthrough 着色器、normal）：直接上屏，NDC 四边形，UV 取纹理上界、不内缩", () => {
    const plan = planLayer(fsbg(0), TEXTURES);
    expect(kinds(plan.steps)).toEqual(["direct→scene"]);
    expect(plan.composite).toBeNull();
    expect(stepOf(plan, "direct")).toMatchObject({
      geometry: "fullscreen",
      uv: [1, 1],
      inset: [0, 0],
      blending: "normal",
      inputs: { 0: { kind: "texture", index: TEXTURE.kbbg } },
    });
  });

  it("FSQ（genericimage2 + util/white）：直接上屏，NDC 四边形、不内缩（非 fullscreen 时会内缩 0.15 / 32）", () => {
    const plan = planLayer(fsq(0), TEXTURES);
    expect(kinds(plan.steps)).toEqual(["direct→scene"]);
    expect(stepOf(plan, "direct")).toMatchObject({ geometry: "fullscreen", uv: [1, 1], inset: [0, 0] });
    // 对照：同一个图层去掉 fullscreen 就是图层四边形、内缩
    const plain = stepOf(planLayer(fsq(0, { fullscreen: false, fullscreenSize: null }), TEXTURES), "direct");
    expect(plain.geometry).toBe("layer");
    expect(plain.inset[0]).toBeGreaterThan(0);
  });

  it("直接上屏的 UV 取纹理上界：补边的 NPOT 纹理（100×50 放在 128×64 里）", () => {
    // FSQ 的槽 0 是 bundle 纹理 1（`TEXTURE.white`），换成补边的那张
    const textures = [TEXTURES[TEXTURE.kbbg], texture(100, 50, 128, 64)];
    const step = stepOf(planLayer(fsq(0, { fullscreenSize: [100, 50] }), textures), "direct");
    expect(step).toMatchObject({ geometry: "fullscreen", uv: [100 / 128, 50 / 64], inset: [0, 0] });
  });

  it("非组合层的 fullscreen 带 effect：同样走拷贝（快照之前没有规则 1），合成 RT = fullscreenSize（32×32）", () => {
    const plan = planLayer(fsq(0, { effects: [kbfx(0)] }), TEXTURES);
    expect(kinds(plan.steps)).toEqual(["snapshot", "copy→c0", "final→scene"]);
    expect(plan.composite).toEqual({ count: 1, width: 32, height: 32 });
    expect(stepOf(plan, "final")).toMatchObject({ geometry: "fullscreen", inset: [0, 0] });
  });

  it("拷贝排在组合层的 compose / clear 之前：copybackground: false 的 fullscreenlayer 照样拷", () => {
    const plan = planLayer(f1(0, { copyBackground: false }), TEXTURES);
    expect(kinds(plan.steps)).toEqual(["snapshot", "copy→c0", "final→scene"]);
  });

  it("两个 pass 的 effect：中间 pass 画进 fbo（NDC 四边形），末 pass 上屏；快照只拷一次", () => {
    const plan = planLayer(f1(0, { effects: [kbfx(0, 2)] }), TEXTURES);
    expect(kinds(plan.steps)).toEqual(["snapshot", "copy→c0", "effect→_rt_Half", "final→scene"]);
    expect(stepOf(plan, "effect")).toMatchObject({ geometry: "fullscreen", uv: [1, 1], inset: [0, 0] });
  });

  it("effect 的 pass 也要帧缓冲（规则 2）、末 pass 也要（规则 3）：快照仍只在开头拷一次", () => {
    const fx = kbfx(0, 2);
    for (const step of fx.steps) if (step.kind === "draw") step.pass.framebuffer = true;
    const plan = planLayer(f1(0, { effects: [fx] }), TEXTURES);
    expect(plan.steps.filter((step) => step.kind === "snapshot")).toHaveLength(1);
    expect(kinds(plan.steps)[0]).toBe("snapshot");
  });

  it("colorBlendMode 2：拷贝 → effect 留在合成 RT 1 → passthrough 上屏，也画 NDC 四边形、不内缩", () => {
    const plan = planLayer(f1(0, { colorBlendMode: 2, passthrough: blendPass(0) }), TEXTURES);
    expect(kinds(plan.steps)).toEqual(["snapshot", "copy→c0", "effect→c1", "passthrough→scene"]);
    expect(plan.composite).toEqual({ count: 2, width: W, height: H });
    expect(stepOf(plan, "passthrough")).toMatchObject({
      geometry: "fullscreen",
      uv: [1, 1],
      inset: [0, 0],
      inputs: { 0: { kind: "composite", index: 1 }, 1: { kind: "framebuffer" } },
    });
  });

  it("variantPlans：可变 effect 全关时那一份是空计划，开着时是拷贝 → 上屏", () => {
    const plans = variantPlans(f1(0, { effects: [kbfx(0, 1, { visibleBound: true })] }), TEXTURES);
    expect(plans.map((plan) => kinds(plan.steps))).toEqual([
      ["snapshot", "copy→c0", "final→scene"],
      [],
      ["snapshot", "copy→c0", "final→scene"],
    ]);
    // 非组合层：全关时直接上屏，仍是 NDC 四边形
    const direct = variantPlans(fsq(0, { effects: [kbfx(0, 1, { visibleBound: true })] }), TEXTURES)[1];
    expect(kinds(direct.steps)).toEqual(["direct→scene"]);
    expect(stepOf(direct, "direct").geometry).toBe("fullscreen");
  });

  it("签名：拷贝步骤进签名（effect 为 null），和组合层的 compose 签名不同", () => {
    const signature = planSignature(planLayer(f1(0), TEXTURES));
    expect(signature).toContain('{"kind":"copy","effect":null,"source":{"kind":"framebuffer"}');
    expect(signature).not.toBe(planSignature(planLayer(f1(0, { fullscreen: false, fullscreenSize: null }), TEXTURES)));
  });
});

describe("compositeSize：fullscreenSize 排在最前", () => {
  const padded = { width: 48, height: 40, textureWidth: 64, textureHeight: 64 };
  it("非空时用它，不看纹理、solidLayer、组合层 size", () => {
    expect(
      compositeSize({ size: [2, 2], solidLayer: false, passthroughModel: true, fullscreenSize: [W, H] }, undefined),
    ).toEqual([W, H]);
    expect(
      compositeSize({ size: [2, 2], solidLayer: false, passthroughModel: false, fullscreenSize: [32, 32] }, padded),
    ).toEqual([32, 32]);
    expect(
      compositeSize(
        { size: [600, 300], solidLayer: true, passthroughModel: false, fullscreenSize: [1280, 720] },
        padded,
      ),
    ).toEqual([1280, 720]);
  });
  it("同样取整、至少 4", () => {
    expect(
      compositeSize(
        { size: [2, 2], solidLayer: false, passthroughModel: true, fullscreenSize: [1919.6, 2] },
        undefined,
      ),
    ).toEqual([1920, 4]);
  });
  it("为 null 时照旧规则", () => {
    expect(
      compositeSize({ size: [600, 300], solidLayer: false, passthroughModel: false, fullscreenSize: null }, padded),
    ).toEqual([48, 40]);
  });
});

// ———— 矩阵：FSQ 直接上屏照常（纯函数） ————

const worldOf = (item: SceneLayer): Mat4 =>
  worldMatrixOf(
    0,
    new Map([[0, { origin: item.origin, angles: item.angles, scale: item.scale, parent: null }]]),
    new Map(),
  );

describe("FSQ 直接上屏：MVP = 场景视图投影 · W，2×2 四边形被 W 变换（p5b-fsmvp 事件 55）", () => {
  it("drawMatrices 的 direct 角色：MVP 对上 WPE，四角裁剪坐标的 x、y、w 相对误差 < 1e-5", () => {
    const item = fsq(0);
    const { modelViewProjection } = drawMatrices(
      { role: "direct" },
      worldOf(item),
      item.size,
      sceneViewProjection({ width: W, height: H }),
    );
    expectMvp(modelViewProjection, WPE_FSQ_MVP, "FSQ direct");
    expect(cornerError(modelViewProjection)).toBeLessThan(1e-5);
  });
});

// ———— GpuScene ————

interface FakeBuffer {
  label: string;
  bytes: Uint8Array;
  destroy(): void;
}

/** 假设备：记缓冲字节（uniform 与顶点读回）与一帧的编码轨迹（目标与清屏值、管线、绘制、拷贝）。 */
class FakeGpu {
  readonly trace: string[] = [];
  readonly device: GPUDevice;

  constructor() {
    const trace = this.trace;
    const renderPass = () => ({
      setViewport() {},
      setPipeline(pipeline: { label: string }) {
        trace.push(`  pipeline ${pipeline.label}`);
      },
      setBindGroup() {},
      setVertexBuffer(_slot: number, buffer: FakeBuffer) {
        trace.push(`  draw ${buffer.label}`);
      },
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
        usage: descriptor.usage,
        createView: () => ({ label: descriptor.label ?? "" }),
        destroy() {},
      }),
      createSampler: () => ({}),
      createBuffer: (descriptor: GPUBufferDescriptor) => ({
        label: descriptor.label ?? "",
        bytes: new Uint8Array(descriptor.size),
        destroy() {},
      }),
      createShaderModule: () => ({ getCompilationInfo: async () => ({ messages: [] }) }),
      createBindGroupLayout: () => ({}),
      createPipelineLayout: () => ({}),
      createRenderPipeline: () => ({ getBindGroupLayout: () => ({}) }),
      createRenderPipelineAsync: async (descriptor: GPURenderPipelineDescriptor) => ({
        label: `${descriptor.label} mask ${[...descriptor.fragment!.targets][0]?.writeMask}`,
      }),
      createBindGroup: () => ({}),
      createCommandEncoder: () => ({
        beginRenderPass: (descriptor: GPURenderPassDescriptor) => {
          const attachment = [...descriptor.colorAttachments][0]!;
          const { label } = attachment.view as unknown as { label: string };
          const clear = attachment.loadOp === "clear" ? ` ${JSON.stringify(attachment.clearValue)}` : "";
          trace.push(`pass ${label} ${attachment.loadOp}${clear}`);
          return renderPass();
        },
        copyTextureToTexture: (
          source: { texture: { label: string; usage: number } },
          target: { texture: { label: string; usage: number } },
          size: { width: number; height: number },
        ) => {
          // 模拟 WebGPU 的用途校验：源要 COPY_SRC、目标要 COPY_DST（步骤 3 验收时快照缺 COPY_SRC，真机整帧全黑，假设备没查出来）
          if (!(source.texture.usage & GPUTextureUsage.COPY_SRC))
            throw new Error(`${source.texture.label} 没有 COPY_SRC`);
          if (!(target.texture.usage & GPUTextureUsage.COPY_DST))
            throw new Error(`${target.texture.label} 没有 COPY_DST`);
          trace.push(`copy ${source.texture.label} -> ${target.texture.label} ${size.width}x${size.height}`);
        },
        copyTextureToBuffer() {},
        finish: () => ({}),
      }),
      queue: {
        writeBuffer: (buffer: FakeBuffer, offset: number, data: ArrayBuffer, dataOffset = 0, size?: number) => {
          buffer.bytes.set(new Uint8Array(data, dataOffset, size ?? data.byteLength - dataOffset), offset);
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

/** uniform 偏移：MVP 0、视图投影 64、效果 MVP 128（只 kbfx 声明）、`g_Texture0Resolution` 192（只 kbfx 声明）。 */
const OFFSET = { mvp: 0, viewProjection: 64, effectMvp: 128, resolution0: 192 } as const;

function program(name: string, slots: number[], effect = false): TranslateResult {
  const mat4 = (uniform: string, offset: number) => ({
    name: uniform,
    type: "mat4x4<f32>",
    declared: "mat4",
    offset,
    size: 64,
  });
  const uniforms = [mat4("g_ModelViewProjectionMatrix", 0), mat4("g_ViewProjectionMatrix", 64)];
  if (effect)
    uniforms.push(mat4("g_EffectModelViewProjectionMatrix", 128), {
      name: "g_Texture0Resolution",
      type: "vec4<f32>",
      declared: "vec4",
      offset: 192,
      size: 16,
    });
  return {
    ok: true,
    vertex: { wgsl: `// ${name} v`, entryPoint: "main" },
    fragment: { wgsl: `// ${name} f`, entryPoint: "main" },
    attributes: [
      { name: "a_Position", type: "vec3", location: 0 },
      { name: "a_TexCoord", type: "vec2", location: 1 },
    ],
    uniforms,
    uniformBlockSize: effect ? 208 : 128,
    textures: slots.map((slot) => ({ slot, binding: 1 + 2 * slot, samplerBinding: 2 + 2 * slot, kind: "2d" })),
  } as unknown as TranslateResult;
}

function bundleOf(layers: SceneLayer[]): SceneBundle {
  return {
    general: {
      width: W,
      height: H,
      fields: generalDefaults(),
      clearVariable: false,
      perspectiveOverrideFov: particleFov(undefined),
      postprocess: { level: "disabled", bloomFlag: false, hdrFlag: false, bloom: false, hdr: false },
      bloom: { ...BLOOM_DEFAULTS, tint: [1, 1, 1] },
    },
    layers,
    programs: [
      program("passthrough", [0]),
      program("genericimage2", [0]),
      program("kbfx", [0], true),
      program("effectpassthrough", [0, 1]),
    ],
    textures: TEXTURES,
    bloom: null,
    unsupported: [],
    bindings: [],
    scripts: { list: [] },
  };
}

interface DrawView {
  object: number;
  label: string;
  step: DrawStep;
  pipeline: { label: string };
  vertexBuffer: FakeBuffer;
  uniformBuffer: FakeBuffer | null;
}
interface RuntimeView {
  object: number;
  ops: { kind: string; draw?: DrawView; effect?: number | null; source?: unknown; target?: unknown }[];
  draws: DrawView[];
}
const internals = (scene: GpuScene) => scene as unknown as { layers: RuntimeView[]; draws: Set<DrawView> };
const runtimeOf = (scene: GpuScene, object: number) => internals(scene).layers.find((item) => item.object === object);
const opKinds = (runtime: RuntimeView | undefined) =>
  runtime?.ops.map((op) => (op.kind === "draw" ? `draw ${op.draw!.step.role}` : op.kind)) ?? null;
const matrixAt = (draw: DrawView, offset: number): Mat4 =>
  new Float32Array(draw.uniformBuffer!.bytes.buffer.slice(offset, offset + 64));
const vec4At = (draw: DrawView, offset: number) => [
  ...new Float32Array(draw.uniformBuffer!.bytes.buffer.slice(offset, offset + 16)),
];
const hex = (m: Mat4) => Buffer.from(m.buffer, m.byteOffset, m.byteLength).toString("hex");
function drawOf(scene: GpuScene, object: number, role: string): DrawView {
  const draw = [...internals(scene).draws].find((item) => item.object === object && item.step.role === role);
  if (!draw) throw new Error(`图层 ${object} 没有 ${role} 的 draw`);
  return draw;
}
/** 顶点缓冲读回：`a_Position`（vec3）+ `a_TexCoord`（vec2），步长 20 字节，三角形带四个顶点。 */
function quadOf(draw: DrawView) {
  const view = new DataView(draw.vertexBuffer.bytes.buffer);
  return Array.from({ length: 4 }, (_, i) => ({
    position: [0, 1, 2].map((k) => view.getFloat32(i * 20 + k * 4, true)),
    texCoord: [0, 1].map((k) => view.getFloat32(i * 20 + 12 + k * 4, true)),
  }));
}
/** ±1 的 NDC 四边形（`layerQuad` 的顺序：左下、右下、左上、右上），UV 上界 1、不内缩。 */
const NDC_QUAD = [
  { position: [-1, -1, 0], texCoord: [0, 1] },
  { position: [1, -1, 0], texCoord: [1, 1] },
  { position: [-1, 1, 0], texCoord: [0, 0] },
  { position: [1, 1, 0], texCoord: [1, 0] },
];

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
  return { gpu, scene, state };
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

/** `p5b-fs` 的骨架：对照层（普通图像层铺满，`objects` 下标 0）、F1（下标 1）。 */
const fsBundle = (extra: Partial<SceneLayer> = {}) => bundleOf([layer(0, { name: "BG" }), f1(1, extra)]);

describe("GpuScene：p5b-fs 的 F1（fullscreenlayer + kbfx）", () => {
  it("op：快照 → 拷贝（快照 → 合成 RT 0）→ 上屏，没有基础绘制", async () => {
    const { scene } = await open(fsBundle());
    expect(opKinds(runtimeOf(scene, 1))).toEqual(["snapshot", "copy", "draw final"]);
    expect(runtimeOf(scene, 1)!.ops[1]).toMatchObject({
      effect: null,
      source: { kind: "framebuffer" },
      target: { kind: "composite", index: 0 },
    });
    expect(runtimeOf(scene, 1)!.draws.map((draw) => draw.step.role)).toEqual(["final"]);
  });

  it("一帧的编码：拍快照、把快照整张拷进 1920×1080 的合成 RT 0，再接着场景 pass 上屏", async () => {
    const { gpu, scene, state } = await open(fsBundle());
    scene.update(FRAME, state);
    gpu.trace.length = 0;
    scene.encode(gpu.device.createCommandEncoder(), state);
    expect(gpu.trace).toEqual([
      'pass scene target clear {"r":0,"g":0,"b":0,"a":1}',
      "  pipeline scene program 1 translucent rgba8unorm mask 7",
      "  draw layer 10 BG direct",
      "copy scene target -> _rt_FullFrameBuffer 1920x1080",
      "copy _rt_FullFrameBuffer -> composite 1920x1080|true|false #0 1920x1080",
      "pass scene target load",
      "  pipeline scene program 2 translucent rgba8unorm mask 7",
      "  draw layer 11 F1 final",
    ]);
  });

  it("上屏：顶点是 ±1，MVP 是 NDC 正交，对上 WPE 事件 76；视图投影同值；槽 0 的分辨率是合成 RT 的 1920×1080", async () => {
    const { scene, state } = await open(fsBundle());
    scene.update(FRAME, state);
    const final = drawOf(scene, 1, "final");
    expect(quadOf(final)).toEqual(NDC_QUAD);
    const mvp = matrixAt(final, OFFSET.mvp);
    expectMvp(mvp, WPE_F1_FINAL, "F1 final");
    // z 也对上：按 WPE 的 ortho(−1, 1, −1, 1, −1, 1) 建，z = 0 → 0.5
    expectMvp(mvp, WPE_F1_FINAL, "F1 final（16 个元素）", ALL);
    // 视图投影就是这份 NDC 正交（模型是单位阵）；按值比：`orthographic` 的平移项在这里是 −0，乘过单位阵后是 +0
    expectMvp(matrixAt(final, OFFSET.viewProjection), WPE_F1_FINAL, "F1 final 视图投影", ALL);
    // 效果 MVP（上屏不缩放）同样是 NDC 正交
    expectMvp(matrixAt(final, OFFSET.effectMvp), WPE_F1_FINAL, "F1 final 效果 MVP", ALL);
    expect(vec4At(final, OFFSET.resolution0)).toEqual([W, H, W, H]);
    // 裁剪坐标正好是 ±1：铺满全屏
    for (const { position } of quadOf(final)) {
      const clip = transformPoint(mvp, position[0], position[1], position[2]);
      expect([clip[0], clip[1], clip[3]]).toEqual([position[0], position[1], 1]);
    }
  });

  it("视差、抖动、缩放、透视都不改 F1 的上屏矩阵（对照层的变了）", async () => {
    const { scene, state } = await open(fsBundle({ perspective: true }));
    scene.update(FRAME, state);
    const final = () => drawOf(scene, 1, "final");
    const control = () => drawOf(scene, 0, "direct");
    // 透视：一开始就是 perspective: true，仍是 NDC 正交
    expectMvp(matrixAt(final(), OFFSET.mvp), WPE_F1_FINAL, "F1 final（perspective）", ALL);
    const before = [hex(matrixAt(final(), OFFSET.mvp)), hex(matrixAt(final(), OFFSET.viewProjection))];
    const controlBefore = hex(matrixAt(control(), OFFSET.mvp));
    scene.setCamera({ shake: [10, -5], zoom: 1.5 });
    scene.setParallax({ point: [300, 200], amount: 0.5 }, state);
    scene.update(FRAME, state);
    expect([hex(matrixAt(final(), OFFSET.mvp)), hex(matrixAt(final(), OFFSET.viewProjection))]).toEqual(before);
    expect(hex(matrixAt(control(), OFFSET.mvp))).not.toBe(controlBefore);
  });

  it("两个 pass 的 effect：中间 pass 的 MVP 是单位阵、效果 MVP 是 NDC 正交，开视差时也不变", async () => {
    const { scene, state } = await open(fsBundle({ effects: [kbfx(1, 2)] }));
    scene.update(FRAME, state);
    expect(opKinds(runtimeOf(scene, 1))).toEqual(["snapshot", "copy", "draw effect", "draw final"]);
    const effect = () => drawOf(scene, 1, "effect");
    expect(quadOf(effect())).toEqual(NDC_QUAD);
    expectMvp(matrixAt(effect(), OFFSET.mvp), [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], "effect MVP", ALL);
    expectMvp(matrixAt(effect(), OFFSET.effectMvp), WPE_F1_FINAL, "effect 效果 MVP", ALL);
    const before = hex(matrixAt(effect(), OFFSET.effectMvp));
    scene.setParallax({ point: [300, 200], amount: 0.5 }, state);
    scene.update(FRAME, state);
    expect(hex(matrixAt(effect(), OFFSET.effectMvp))).toBe(before);
  });

  it("运行时把 effect 关掉：图层重建成空计划，再打开回到拷贝 → 上屏", async () => {
    const { gpu, scene, state } = await open(fsBundle({ effects: [kbfx(1, 1, { visibleBound: true })] }));
    const toggle = (value: boolean) =>
      state.write({ property: "p", target: { kind: "effect", object: 1, effect: 0 } }, value);
    toggle(false);
    scene.sync(state);
    scene.update(FRAME, state);
    expect(opKinds(runtimeOf(scene, 1))).toEqual([]);
    gpu.trace.length = 0;
    scene.encode(gpu.device.createCommandEncoder(), state);
    expect(gpu.trace.filter((line) => /F1|_rt_FullFrameBuffer/.test(line))).toEqual([]);
    toggle(true);
    scene.sync(state);
    scene.update(FRAME, state);
    expect(opKinds(runtimeOf(scene, 1))).toEqual(["snapshot", "copy", "draw final"]);
    expectMvp(matrixAt(drawOf(scene, 1, "final"), OFFSET.mvp), WPE_F1_FINAL, "F1 final（重建后）");
  });
});

describe("GpuScene：p5b-fsmvp 的 FSBG、FSQ（非组合层，直接上屏）", () => {
  it("FSQ：顶点 ±1、UV 0–1；MVP 对上 WPE 事件 55，四角裁剪坐标的 x、y、w 相对误差 < 1e-5", async () => {
    const { scene, state } = await open(bundleOf([fsbg(0), fsq(1)]));
    scene.update(FRAME, state);
    const direct = drawOf(scene, 1, "direct");
    expect(quadOf(direct)).toEqual(NDC_QUAD);
    const mvp = matrixAt(direct, OFFSET.mvp);
    expectMvp(mvp, WPE_FSQ_MVP, "FSQ direct");
    expect(cornerError(mvp)).toBeLessThan(1e-5);
    // 和纯函数逐字节相同：直接上屏照常，不走 NDC 正交
    const item = fsq(1);
    const expected = drawMatrices(
      { role: "direct" },
      worldOf(item),
      item.size,
      sceneViewProjection({ width: W, height: H }),
    ).modelViewProjection;
    expect(hex(mvp)).toBe(hex(expected));
  });

  it("FSBG：顶点 ±1、UV 0–1（passthrough 着色器不乘 MVP，铺满全屏）；op 只有一次直接上屏", async () => {
    const { scene, state } = await open(bundleOf([fsbg(0), fsq(1)]));
    scene.update(FRAME, state);
    expect(opKinds(runtimeOf(scene, 0))).toEqual(["draw direct"]);
    expect(quadOf(drawOf(scene, 0, "direct"))).toEqual(NDC_QUAD);
  });

  it("FSQ 开视差：直接上屏照常带视差（和非 fullscreen 的图层一样）", async () => {
    const { scene, state } = await open(bundleOf([fsq(0)]));
    scene.update(FRAME, state);
    const before = hex(matrixAt(drawOf(scene, 0, "direct"), OFFSET.mvp));
    scene.setParallax({ point: [300, 200], amount: 0.5 }, state);
    scene.update(FRAME, state);
    expect(hex(matrixAt(drawOf(scene, 0, "direct"), OFFSET.mvp))).not.toBe(before);
  });
});
