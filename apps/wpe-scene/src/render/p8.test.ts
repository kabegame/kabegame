/**
 * P8 步骤 1 的渲染侧单测（`.claude/plans/wpe-import/3-scene/phase8/phase-8-image-material.md`「步骤 1」）：合成 RT 的采样
 * （`compositeSampling`）。期望值是 p8-REPORT「合成 RT 与基础纹理的采样」的表（`p8-clamp`、`p8-clamp2`，RenderDoc 管线状态里槽 0 的
 * 采样器）：寻址只看对象的 `clampuvs`（缺省钳制），和基础纹理 `.tex` 的 ClampUVs 无关；过滤在对象 `nointerpolation` 或基础纹理
 * NoInterpolation 时 Point，否则 Linear（rea-p8-layer §3.2 `FUN_1401ea500`）。
 * 对象 JSON 到图层两个字段的取值由 `compile/p8.test.ts` 核对，这里的 `fields` 照同一规则写。
 *
 * P8 步骤 2（同计划「步骤 2 — 形状对象」，rea-p8-layer §1，p8-REPORT 结论 4、5）：
 * - `shapeQuad`：`p8-shape` 的 S1（1080×1080）、S10（300×200）四个顶点与 RenderDoc 的 `vs_in` 逐位相同，uv 是点本身；带的两个三角形与
 *   WPE 的索引 (0, 2, 1)、(0, 3, 2) 逐个相同；点为 null 时等于 `layerQuad(size, [1, 1])`；
 * - `planShapeLayer`：一步 `final`、additive、场景目标、几何 `shape`、没有合成 RT；最后一个 effect 关着也画、前面的不画；要快照时先拍；
 *   结构不对时 `render:shape`；`variantPlans` 为空；
 * - `drawMatrices` 的形状分支：MVP = VP · W（S1、S2、S10 的 MVP 与四角对上 WPE），三个效果矩阵与 `g_LayerModelMatrix` 是单位阵，纹理
 *   投影 `diag(Sx/2, Sy/2, 1, 1)`，逆矩阵跟着；
 * - `buildableLayers` 收形状层，写死不可见的祖先下面不收。
 *
 * P8 步骤 3（同计划「步骤 3 — 对齐」，rea-p8-layer 2.2–2.4，p8-REPORT 结论 6，补测 `p8-align2`）：
 * - `alignmentOffset`：`p8-align` 的 9 种 × 160×100 / 120×80，`p8-align2` 的 F1（101.7 × 50.5 → (50.5, −25)，按 `trunc(size)`）；
 * - `drawMatrixOf` 与 `worldMatrixOf`：偏移只在图层画自己时乘、在缩放与旋转之前（b 行），子层不带父层的偏移（d 行、文本的 Xc），
 *   缓存只存世界矩阵；组的局部正交按组画自己的矩阵（G、Gc 的 MVP 对上 WPE）；
 * - 四边形：图像层的几何 `layer` 按 `trunc(size)`（F1、F3 的 ±50.5 / ±25），文本层不截断、`fill` 不截断；效果矩阵仍按浮点 size（F2）；
 * - GpuScene 假设备：F1、F2、F3、G、Gc 的 uniform 与顶点对上 WPE；脚本 `thisLayer.alignment` 读名字、写字符串同帧改 MVP、写数字读回
 *   `center`、非图像层没有访问器、组改对齐时子层跟着重写；写回经运行时的重放表在新状态里恢复。
 *
 * P8 步骤 4（同计划「步骤 4 — 图层依赖」，rea-p8-render 第 1、2 节，p8-REPORT「图层依赖」与结论 7–9）：
 * - `planLayer`：0 / 1 / 2 个 effect 的写入顺序（`p8-dep` 的 A9 / A2 / A11，最后一次写入落在合成 RT 0）、最后一个 effect 不上屏、
 *   passthrough 上屏（内缩 0.15 / 64、混合 translucent / cbm 31 additive / cbm 7 基础材质的）、组合层没有 effect 也画、colorBlendMode 7
 *   + 被依赖（`2251857160` 的 356）、对调覆盖 copy 与 subtree；`swapCompositeIndices` 逐种步骤；引用方的 `{ kind: "layer" }` 在图像层、
 *   形状、粒子、模型的计划里都给出；
 * - 渲染器：`buildableLayers` 收写死隐藏、祖先隐藏的被依赖图层；`layerOpsToRun` 只跳过画到场景的绘制；GpuScene 假设备：独占 RT 建一张、
 *   是被依赖图层的合成 RT 0，两个引用方绑同一张（`g_Texture1Resolution` 是它的尺寸），不可见时画进 RT 不上屏、可见时多一次上屏，effect
 *   开关重建后还是同一张，组里的被依赖者按同一规则。
 *
 * P8 步骤 5（同计划「步骤 5 — 写入状态」，rea-p8-render 第 4、5 节，p8-REPORT 结论 10、11）：
 * - `writesAlpha` 逐行对 4.4 的表，`alphaToCoverage` 只认 `alphatocoverage`；
 * - `stepPipeline`：直接上屏、基础 pass、fbo pass、末 pass、passthrough、组里的 `alpha` 与 A2C（`p8-alpha` 13–16、`p8-misc` W1 / W2），
 *   粒子、网格、文本同一套；没有这两项的步骤管线键与改前逐字相同；
 * - `alphaToCoverageEntry`：导出的真实入口逐字比对、直接返回 `@location(0)`、多个 `return`、认不出时抛错；
 * - GpuScene 假设备：A2C 管线键、A2C 模块按程序建一次、入口与写掩码，没有 A2C 的场景不建模块，改写或 Tint 失败时的原因键。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ALIGNMENTS, alignmentIndex, type AlignmentName } from "../compile/alignment";
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
import { TEX_FLAGS } from "../compile/tex";
import { ScriptApi } from "../script/api";
import { ScriptRuntime, type ScriptRealm, type ScriptTarget, type ScriptValue } from "../script/runtime";
import type { TranslateResult } from "../wpesl2wgsl";
import { layerCompositeName } from "../compile/dependencies";
import { SceneRenderError } from "./errors";
import {
  compositeSampling,
  planLayer,
  planModelLayer,
  planParticleLayer,
  planShapeLayer,
  rasterState,
  swapCompositeIndices,
  variantPlans,
  type DrawStep,
  type LayerPlan,
  type LayerStep,
  type TargetRef,
  type TextStep,
  type TextureRef,
} from "./graph";
import {
  alignmentOffset,
  drawMatrixOf,
  groupViewProjection,
  layerLocalMatrix,
  layerQuad,
  sceneViewProjection,
  screenQuadSize,
  shapeQuad,
  uvInset,
  worldMatrixOf,
  type LayerTransform,
} from "./layout";
import { identity, multiply, scaling, transformPoint, translation, type Mat4 } from "./math";
import { alphaToCoverageEntry, WGSL_PRELUDE } from "./programs";
import { buildableLayers, GpuScene, layerOpsToRun, pipelineKey, stepPipeline } from "./scene";
import { SceneState, scriptWriteValue } from "./state";
import { drawMatrices, drawUniformValues, type FrameInput } from "./uniforms";
import { alphaToCoverage, writesAlpha, type AlphaWriting } from "./writeState";

vi.mock("./device", () => ({ acquireGpu: vi.fn() }));
vi.mock("../fileUrl", () => ({ fileToUrl: (path: string) => path }));

type ObjectFlags = { clampuvs?: boolean; nointerpolation?: boolean };

/** 对象 JSON → 图层字段（同 `compile/bundle.ts`：clampuvs 只有 false 才关，nointerpolation 只认 true）。 */
const fields = (object: ObjectFlags): Pick<SceneLayer, "clampUVs" | "noInterpolation"> => ({
  clampUVs: object.clampuvs !== false,
  noInterpolation: object.nointerpolation === true,
});
/** `.tex` 标志 → 纹理的两个字段（同 `compile/bundle.ts`）。ClampUVs 也带上，核对它不影响合成 RT 的寻址。 */
const texture = (flags: number): Pick<SceneTexture, "clampUVs" | "noInterpolation"> => ({
  clampUVs: !!(flags & TEX_FLAGS.clampUVs),
  noInterpolation: !!(flags & TEX_FLAGS.noInterpolation),
});

const CLAMP_LINEAR = { clamp: true, nearest: false };
const CLAMP_POINT = { clamp: true, nearest: true };
const WRAP_LINEAR = { clamp: false, nearest: false };
const WRAP_POINT = { clamp: false, nearest: true };

describe("compositeSampling：p8-REPORT 的表（p8-clamp、p8-clamp2）", () => {
  it.each<[string, ObjectFlags, { clamp: boolean; nearest: boolean }]>([
    ["不写", {}, CLAMP_LINEAR],
    ["clampuvs: true（和不写同一张池化 RT）", { clampuvs: true }, CLAMP_LINEAR],
    ["nointerpolation: true", { nointerpolation: true }, CLAMP_POINT],
    ["两者 true", { clampuvs: true, nointerpolation: true }, CLAMP_POINT],
    ["clampuvs: false", { clampuvs: false }, WRAP_LINEAR],
    ["nointerpolation: false", { nointerpolation: false }, CLAMP_LINEAR],
    ["两者 false", { clampuvs: false, nointerpolation: false }, WRAP_LINEAR],
  ])("纹理标志 0，对象 %s", (_name, object, expected) => {
    expect(compositeSampling(fields(object), texture(0))).toEqual(expected);
  });

  it.each<[string, ObjectFlags, { clamp: boolean; nearest: boolean }]>([
    ["不写", {}, CLAMP_POINT],
    ["clampuvs: true", { clampuvs: true }, CLAMP_POINT],
    ["nointerpolation: true", { nointerpolation: true }, CLAMP_POINT],
    ["两者 true", { clampuvs: true, nointerpolation: true }, CLAMP_POINT],
    ["clampuvs: false（纹理的 ClampUVs 不管合成 RT）", { clampuvs: false }, WRAP_POINT],
    ["nointerpolation: false（纹理的 NoInterpolation 照样 Point）", { nointerpolation: false }, CLAMP_POINT],
    ["两者 false", { clampuvs: false, nointerpolation: false }, WRAP_POINT],
  ])("纹理标志 3（NoInterpolation | ClampUVs），对象 %s", (_name, object, expected) => {
    expect(compositeSampling(fields(object), texture(TEX_FLAGS.noInterpolation | TEX_FLAGS.clampUVs))).toEqual(
      expected,
    );
  });

  it("纹理只带一位：NoInterpolation 决定过滤，ClampUVs 不起作用", () => {
    expect(compositeSampling(fields({}), texture(TEX_FLAGS.noInterpolation))).toEqual(CLAMP_POINT);
    expect(compositeSampling(fields({}), texture(TEX_FLAGS.clampUVs))).toEqual(CLAMP_LINEAR);
    expect(compositeSampling(fields({ clampuvs: false }), texture(TEX_FLAGS.clampUVs))).toEqual(WRAP_LINEAR);
  });

  it.each<[string, ObjectFlags, { clamp: boolean; nearest: boolean }]>([
    ["不写", {}, CLAMP_LINEAR],
    ["clampuvs: true", { clampuvs: true }, CLAMP_LINEAR],
    ["clampuvs: false", { clampuvs: false }, WRAP_LINEAR],
    // 下面两行没有实测：rea-p8-layer §3.3 读码（文本、形状的虚表 +0x128 给 0，点采样 ⇔ 对象 nointerpolation）
    ["nointerpolation: true", { nointerpolation: true }, CLAMP_POINT],
    ["clampuvs: false + nointerpolation: true", { clampuvs: false, nointerpolation: true }, WRAP_POINT],
  ])("没有基础纹理（组合层），对象 %s", (_name, object, expected) => {
    expect(compositeSampling(fields(object), undefined)).toEqual(expected);
  });
});

// ———— P8 步骤 2：形状对象 ————

/**
 * WPE 真值：`A:\p8\p8-shape-fps20\p8-shape-fps20-frame157.rdc`（`ignore/p8/out/dump.json`，`rdc_dump_p8.py` 导出）。场景 1920×1080 正交、
 * 视差关；点 p0–p3 是 `p8-shape` 共用的那组（`ignore/p8/gen_p8.py` 的 `p_shape`）。每次绘制是索引 (p0, p2, p1, p0, p3, p2)，这里按 p0–p3 列。
 * - S1（事件 67）：origin (480, 540)，缺省 1080×1080；
 * - S2（事件 87）：origin (1440, 540)、angles z 0.5、scale 0.5×0.8；
 * - S10（事件 227）：origin (1200, 700)、size 300×200。
 * MVP 是 16 个数按列主序（第 12、13 个是平移，同 `Mat4`），`clip` 是 `vs_out` 的 x、y（w 为 1）。
 */
const SHAPE_POINTS: [number, number][] = [
  [0.2456, 0.09457],
  [0.85704, 0.06238],
  [0.9469, 0.66185],
  [0.07415, 0.95],
];
const WPE_SHAPES = {
  S1: {
    origin: [480, 540, 0],
    angles: [0, 0, 0],
    scale: [1, 1, 1],
    size: [1080, 1080],
    vsIn: [
      [-274.75201416015625, 437.86444091796875],
      [385.60321044921875, 472.62957763671875],
      [482.65203857421875, -174.7979736328125],
      [-459.9179992675781, -486.0],
    ],
    mvp: [
      0.0010416667209938169, 0, 0, 0, 0, 0.0018518518190830946, 0, 0, 0, 0, 0.0002500000118743628, 0, -0.5, 0, 0.5, 1,
    ],
    clip: [
      [-0.7862000465393066, 0.8108600378036499],
      [-0.09832996129989624, 0.8752399682998657],
      [0.0027625560760498047, -0.323699951171875],
      [-0.9790812730789185, -0.8999999761581421],
    ],
  },
  S2: {
    origin: [1440, 540, 0],
    angles: [0, 0, 0.5],
    scale: [0.5, 0.8, 1],
    size: [1080, 1080],
    vsIn: null,
    mvp: [
      0.0004570742603391409, 0.00044391254778020084, 0, 0, -0.00039952131919562817, 0.001300122356042266, 0, 0, 0, 0,
      0.0002500000118743628, 0, 0.5000001192092896, 0, 0.5, 1,
    ],
    clip: [
      [0.19948187470436096, 0.44731149077415466],
      [0.487423837184906, 0.785650372505188],
      [0.7904434204101562, -0.013003449887037277],
      [0.48395079374313354, -0.8360228538513184],
    ],
  },
  S10: {
    origin: [1200, 700, 0],
    angles: [0, 0, 0],
    scale: [1, 1, 1],
    size: [300, 200],
    vsIn: [
      [-76.31999969482422, 81.08599853515625],
      [107.11199951171875, 87.52400207519531],
      [134.07000732421875, -32.3699951171875],
      [-127.75499725341797, -90.0],
    ],
    mvp: [
      0.0010416667209938169, 0, 0, 0, 0, 0.0018518518190830946, 0, 0, 0, 0, 0.0002500000118743628, 0,
      0.25000011920928955, 0.29629623889923096, 0.5, 1,
    ],
    clip: [
      [0.17050011456012726, 0.4464554786682129],
      [0.3615751266479492, 0.4583777189254761],
      [0.3896563649177551, 0.23635180294513702],
      [0.11692199110984802, 0.12962958216667175],
    ],
  },
} as const;
const GENERAL = { width: 1920, height: 1080 };
const SHAPE_STEP = { role: "final", geometry: "shape" } as const;

/** 三角形带 [v0, v1, v2, v3] 的两个三角形（WebGPU 的带：奇数个三角形按 (v2, v1, v3) 算绕向）。 */
const stripTriangles = <T>([v0, v1, v2, v3]: readonly T[]): T[][] => [
  [v0, v1, v2],
  [v2, v1, v3],
];
/** 把三角形轮换到以 `first` 开头（同一个三角形、同一绕向）。 */
const rotateTo = <T>(triangle: readonly T[], first: T): T[] => {
  const i = triangle.indexOf(first);
  return [...triangle.slice(i), ...triangle.slice(0, i)];
};

describe("shapeQuad：形状的四边形（p8-shape 的 S1、S10）", () => {
  it.each(["S1", "S10"] as const)("%s：四个顶点与 RenderDoc 的 vs_in 逐位相同，uv 是点本身（float32）", (name) => {
    const { size, vsIn } = WPE_SHAPES[name];
    const quad = shapeQuad(size, SHAPE_POINTS);
    // 带的顺序是 [p1, p0, p2, p3]
    const order = [1, 0, 2, 3];
    expect(quad.map((vertex) => vertex.position)).toEqual(order.map((p) => [vsIn[p][0], vsIn[p][1], 0]));
    expect(quad.map((vertex) => vertex.texCoord)).toEqual(
      order.map((p) => [Math.fround(SHAPE_POINTS[p][0]), Math.fround(SHAPE_POINTS[p][1])]),
    );
  });

  it("带的两个三角形与 WPE 的索引 (0, 2, 1)、(0, 3, 2) 逐个相同（轮换后相同即同一绕向），先后也相同", () => {
    const quad = shapeQuad([1080, 1080], SHAPE_POINTS);
    const key = (vertex: (typeof quad)[number]) => vertex.texCoord.join(",");
    const point = (p: number) => SHAPE_POINTS[p].map(Math.fround).join(",");
    const triangles = stripTriangles(quad.map(key));
    const wpe = [
      [0, 2, 1],
      [0, 3, 2],
    ].map((triangle) => triangle.map(point));
    expect(triangles.map((triangle) => rotateTo(triangle, point(0)))).toEqual(wpe);
  });

  it("点为 null 或不足四个：退回 layerQuad(size, [1, 1])（以原点为中心的方块、uv 0–1、不内缩）", () => {
    expect(shapeQuad([300, 200], null)).toEqual(layerQuad([300, 200], [1, 1]));
    expect(shapeQuad([1080, 1080], SHAPE_POINTS.slice(0, 3))).toEqual(layerQuad([1080, 1080], [1, 1]));
  });

  it("点超出 0–1 照算（语料 3409595232 的 (−0.80924, −0.18247)），四边形落在方块外", () => {
    // 带的第二个顶点是 p0
    const [, p0] = shapeQuad(
      [1080, 1080],
      [
        [-0.80924, -0.18247],
        [1, 0],
        [1, 1],
        [0, 1],
      ],
    );
    expect(p0.position[0]).toBeCloseTo(-0.80924 * 1080 - 540, 3);
    expect(p0.position[1]).toBeCloseTo(1.18247 * 1080 - 540, 3);
  });
});

// ———— 形状层的渲染图 ————

function shapePass(key: string, extra: Partial<ScenePass> = {}): ScenePass {
  return {
    key,
    program: 0,
    blending: "normal",
    cullmode: "nocull",
    depthtest: "disabled",
    depthwrite: "disabled",
    textures: { 1: 0 },
    runtime: {},
    uniforms: {},
    framebuffer: false,
    ...extra,
  };
}
const draw = (pass: ScenePass, binds: { name: string; index: number }[] | null = null): SceneEffectStep => ({
  kind: "draw",
  pass,
  target: null,
  compose: false,
  binds,
});
/** lightshafts 那样的 effect：一个绘制 pass，槽 1 是 `util/noise`。 */
function shafts(object: number, source: number, extra: Partial<SceneEffect> = {}): SceneEffect {
  return {
    source,
    id: 100 + source,
    name: "",
    file: "effects/lightshafts/effect.json",
    fbos: [],
    steps: [draw(shapePass(`objects/${object}/effects/${source}/passes/0`))],
    enabled: true,
    visibleBound: false,
    unsupported: [],
    ...extra,
  };
}
function shapeLayer(object: number, extra: Partial<SceneLayer> = {}): SceneLayer {
  return {
    id: object + 10,
    object,
    parent: null,
    name: `S${object}`,
    origin: [480, 540, 0],
    scale: [1, 1, 1],
    angles: [0, 0, 0],
    size: [1080, 1080],
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
    effects: [shafts(object, 0)],
    passthrough: null,
    particle: null,
    shape: { points: SHAPE_POINTS },
    ...extra,
  };
}
const finalStep = (layer: SceneLayer, effect: number, extra: Partial<DrawStep> = {}): DrawStep => {
  const step = layer.effects[effect].steps[0];
  if (step.kind !== "draw") throw new Error("不是绘制步骤");
  return {
    kind: "draw",
    role: "final",
    pass: step.pass,
    effect,
    target: { kind: "scene" },
    inputs: { 1: { kind: "texture", index: 0 } },
    geometry: "shape",
    uv: [1, 1],
    inset: [0, 0],
    blending: "additive",
    // 形状的 pass 是 nocull、深度 disabled（P5d 步骤 1：两项都取这个 pass 自己的）
    raster: { test: false, write: false, cull: false },
    ...extra,
  };
};

describe("planShapeLayer：只画最后一个 effect（rea-p8-layer 1.4、1.8，p8-REPORT 结论 5）", () => {
  it("一步 final：场景目标、几何 shape、强制 additive（材质是 normal）、没有合成 RT；planLayer 分流到这里", () => {
    const layer = shapeLayer(3);
    const plan = { composite: null, steps: [finalStep(layer, 0)], reasons: [] };
    expect(planShapeLayer(layer)).toEqual(plan);
    expect(planLayer(layer, [])).toEqual(plan);
  });

  it("多个 effect：画最后一个、前面的不画；不看开关（最后一个关着、全关也照画，p8-shape2 的 SB、SC）", () => {
    const layer = shapeLayer(4, { effects: [shafts(4, 0), shafts(4, 1, { enabled: false, visibleBound: true })] });
    const plan = { composite: null, steps: [finalStep(layer, 1)], reasons: [] };
    expect(planLayer(layer, [])).toEqual(plan);
    expect(planLayer(layer, [], () => false)).toEqual(plan);
    expect(planLayer(layer, [], (e) => e === 0)).toEqual(plan);
  });

  it("effect 开关对形状中性：variantPlans 为空（不预备变体）", () => {
    const layer = shapeLayer(4, {
      effects: [shafts(4, 0, { visibleBound: true }), shafts(4, 1, { enabled: false, visibleBound: true })],
    });
    expect(variantPlans(layer, [])).toEqual([]);
  });

  it("槽 0 不填：没有 bind 时不给合成 RT，bind 里的 previous 跳过（保留材质的纹理）", () => {
    const pass = shapePass("objects/5/effects/0/passes/0", { textures: { 0: 1, 1: 0 } });
    const layer = shapeLayer(5, { effects: [shafts(5, 0, { steps: [draw(pass, [{ name: "previous", index: 0 }])] })] });
    const [step] = planShapeLayer(layer).steps;
    expect(step).toMatchObject({ inputs: { 0: { kind: "texture", index: 1 }, 1: { kind: "texture", index: 0 } } });
    const bare = shapeLayer(6);
    expect((planShapeLayer(bare).steps[0] as DrawStep).inputs[0]).toBeUndefined();
  });

  it("材质要快照时先拍（规则 3），快照进槽位", () => {
    const pass = shapePass("objects/7/effects/0/passes/0", {
      runtime: { 2: "_rt_FullFrameBuffer" },
      framebuffer: true,
    });
    const layer = shapeLayer(7, { effects: [shafts(7, 0, { steps: [draw(pass)] })] });
    expect(planShapeLayer(layer)).toEqual({
      composite: null,
      steps: [
        { kind: "snapshot" },
        finalStep(layer, 0, { inputs: { 1: { kind: "texture", index: 0 }, 2: { kind: "framebuffer" } } }),
      ],
      reasons: [],
    });
  });

  it("结构不对（编译期已报 shape:*）：render:shape、不画", () => {
    const broken = (effects: SceneEffect[]) => planShapeLayer(shapeLayer(8, { effects }));
    const expected = { composite: null, steps: [], reasons: ["render:shape"] };
    expect(broken([])).toEqual(expected);
    const pass = shapePass("objects/8/effects/0/passes/0");
    expect(broken([shafts(8, 0, { steps: [draw(pass), draw(pass)] })])).toEqual(expected);
    expect(broken([shafts(8, 0, { steps: [{ kind: "copy", source: "a", target: "b" }] })])).toEqual(expected);
    expect(
      broken([shafts(8, 0, { fbos: [{ name: "_rt_x", format: "rgba8888", scale: 1, unique: false, repeat: false }] })]),
    ).toEqual(expected);
    // 只看最后一个：前面的结构不对不影响
    expect(broken([shafts(8, 0, { steps: [] }), shafts(8, 1)]).reasons).toEqual([]);
  });

  it("运行时纹理不是快照（没有 fbo 时解析不了）：render:texture-rt", () => {
    const pass = shapePass("objects/9/effects/0/passes/0", { runtime: { 3: "_rt_Other" } });
    const plan = planShapeLayer(shapeLayer(9, { effects: [shafts(9, 0, { steps: [draw(pass)] })] }));
    expect(plan.reasons).toEqual(["render:texture-rt:_rt_Other"]);
  });
});

// ———— 形状层的矩阵 ————

/** 期望非 0 的元素比相对误差，期望为 0 的比绝对误差（同 `p5b-fullscreen.test.ts`）。 */
function expectMatrix(actual: ArrayLike<number>, expected: readonly number[], label: string) {
  for (let i = 0; i < 16; i++) {
    const diff = Math.abs(actual[i] - expected[i]);
    if (expected[i] === 0) expect(diff, `${label}[${i}]`).toBeLessThan(1e-7);
    else expect(diff / Math.abs(expected[i]), `${label}[${i}]`).toBeLessThan(1e-5);
  }
}
const IDENTITY = Array.from(identity());

describe("drawMatrices 的形状分支（rea-p8-layer 1.5）", () => {
  it.each(["S1", "S2", "S10"] as const)("%s：MVP = VP · W 对上 WPE，四角裁剪坐标差 < 0.01 像素", (name) => {
    const shape = WPE_SHAPES[name];
    const world = layerLocalMatrix(shape);
    const vp = sceneViewProjection(GENERAL);
    const matrices = drawMatrices(SHAPE_STEP, world, shape.size, vp);
    expectMatrix(matrices.modelViewProjection, shape.mvp, `${name} MVP`);
    expect(matrices.model).toBe(world);
    expect(matrices.viewProjection).toBe(vp);
    const [v1, v0, v2, v3] = shapeQuad(shape.size, SHAPE_POINTS);
    [v0, v1, v2, v3].forEach((vertex, p) => {
      const clip = transformPoint(matrices.modelViewProjection, ...vertex.position);
      expect(Math.abs(clip[0] - shape.clip[p][0]) * (GENERAL.width / 2), `${name} p${p}.x`).toBeLessThan(0.01);
      expect(Math.abs(clip[1] - shape.clip[p][1]) * (GENERAL.height / 2), `${name} p${p}.y`).toBeLessThan(0.01);
      expect(clip[3]).toBe(1);
    });
  });

  it("效果矩阵与 g_LayerModelMatrix 是单位阵（形状不写 +0x344 / +0x384），纹理投影 diag(Sx/2, Sy/2, 1, 1)", () => {
    const shape = WPE_SHAPES.S10;
    const world = layerLocalMatrix(shape);
    const matrices = drawMatrices(SHAPE_STEP, world, shape.size, sceneViewProjection(GENERAL));
    expect(Array.from(matrices.effectModel!)).toEqual(IDENTITY);
    expect(Array.from(matrices.effectModelViewProjection!)).toEqual(IDENTITY);
    expect(Array.from(matrices.layerModel!)).toEqual(IDENTITY);
    expect(Array.from(matrices.effectTextureProjection!)).toEqual(Array.from(scaling(150, 100, 1)));
    // 不带 geometry 的 final（普通图层的上屏）不受影响：效果矩阵仍按图层
    const layerFinal = drawMatrices({ role: "final" }, world, shape.size, sceneViewProjection(GENERAL));
    expect(layerFinal.effectModel).toBe(world);
    expect(layerFinal.layerModel).toBe(world);
  });

  it("drawUniformValues：逆矩阵跟着（效果矩阵的逆是单位阵，纹理投影的逆是 diag(2/Sx, 2/Sy, 1, 1)），MVP 与 g_ModelMatrix 照上屏", () => {
    const shape = WPE_SHAPES.S1;
    const world: Mat4 = layerLocalMatrix(shape);
    const values = drawUniformValues({
      step: { role: "final", inputs: {}, geometry: "shape" },
      layer: {
        origin: [...shape.origin],
        scale: [...shape.scale],
        angles: [...shape.angles],
        alpha: 0.5,
        color: [1, 0, 0],
        brightness: 2,
        visible: true,
        parallaxDepth: [1, 1],
        parent: null,
        size: [...shape.size],
      },
      world,
      constants: {},
      viewProjection: sceneViewProjection(GENERAL),
      colorScale: 1,
      screenSize: [1920, 1080],
      textures: [],
      eye: [960, 540, 2000],
    });
    expectMatrix(values.g_ModelViewProjectionMatrix, shape.mvp, "g_ModelViewProjectionMatrix");
    expect(values.g_ModelMatrix).toEqual(Array.from(world));
    for (const name of [
      "g_EffectModelMatrix",
      "g_EffectModelMatrixInverse",
      "g_EffectModelViewProjectionMatrix",
      "g_EffectModelViewProjectionMatrixInverse",
      "g_LayerModelMatrix",
    ])
      expect(values[name], name).toEqual(IDENTITY);
    expect(values.g_EffectTextureProjectionMatrix).toEqual(Array.from(scaling(540, 540, 1)));
    expectMatrix(
      values.g_EffectTextureProjectionMatrixInverse,
      Array.from(scaling(2 / 1080, 2 / 1080, 1)),
      "纹理投影的逆",
    );
  });
});

describe("buildableLayers 收形状层（passes 为空）", () => {
  it("可见的、visible 绑属性的形状建资源；自身写死不可见、写死不可见的祖先下面的不建", () => {
    const group = { ...shapeLayer(0, { name: "group", visible: false }), shape: null, effects: [] };
    const layers = [
      group,
      shapeLayer(1, { parent: 0 }),
      shapeLayer(2),
      shapeLayer(3, { visible: false }),
      shapeLayer(4, { visible: false, visibleBound: true }),
    ];
    expect(buildableLayers({ layers, scripts: { list: [] } }).map((layer) => layer.object)).toEqual([2, 4]);
  });
});

// ———— P8 步骤 3：对齐 ————

/** `p8-align` 的表（p8-REPORT「对齐」，ana_align）：普通 / 带 effect 的行，160×100，上屏中心 − origin。 */
const ALIGN_PLAIN: Record<AlignmentName, [number, number]> = {
  center: [0, 0],
  top: [0, -50],
  topright: [-80, -50],
  right: [-80, 0],
  bottomright: [-80, 50],
  bottom: [0, 50],
  bottomleft: [80, 50],
  left: [80, 0],
  topleft: [80, -50],
};
/** 同一张表的 b 行：旋转 0.5、缩放 1.5 × 0.75（WPE 四角换回场景坐标，3 位小数）。 */
const ALIGN_ROTATED: Record<AlignmentName, [number, number]> = {
  center: [0, 0],
  top: [17.978, -32.909],
  topright: [-87.332, -90.44],
  right: [-105.31, -57.531],
  bottomright: [-123.289, -24.621],
  bottom: [-17.979, 32.909],
  bottomleft: [87.332, 90.44],
  left: [105.31, 57.531],
  topleft: [123.289, 24.621],
};

/** `p8-align2` 的 WPE 真值（`ignore/p8/s2/dump-align2.json`，`A:\p8\p8-align2-fps20` 第 181 帧；float32、列主序，平移在 12、13）。 */
const WPE_ALIGN2 = {
  /** F1（origin 300 850、101.7 × 50.5、topleft）直接上屏，事件 48：平移是 origin + (50.5, −25)。 */
  f1: [
    0.0010416667209938169, 0, 0, 0, 0, 0.0018518518190830946, 0, 0, 0, 0, 0.0002500000118743628, 0, -0.6348958015441895,
    0.5277777910232544, 0.5, 1,
  ],
  /** F2（origin 700 850、同上、带 kbfxm）末 pass，事件 83。 */
  f2: {
    mvp: [
      0.0010416667209938169, 0, 0, 0, 0, 0.0018518518190830946, 0, 0, 0, 0, 0.0002500000118743628, 0,
      -0.21822911500930786, 0.5277777910232544, 0.5, 1,
    ],
    /** x 缩放 0.05296875 = 50.85 / 960：效果矩阵按浮点 `size / 2`，不是上屏四边形的 `trunc`。 */
    textureProjection: [
      0.05296875163912773, 0, 0, 0, 0, 0.04675925895571709, 0, 0, 0, 0, 0.0002500000118743628, 0, -0.21822911500930786,
      0.5277777910232544, 0.5, 1,
    ],
    /** `g_EffectModelMatrix` 与 `g_LayerModelMatrix` 相同：平移 = origin + 偏移。 */
    model: [1, 0, -0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 750.5, 825, 0, 1],
  },
  /** Xc：文本 X（origin 500 500、左上对齐，排版偏移不为 0）下的 20×20 子层，事件 150：平移就是 X 的 origin。 */
  xc: [
    0.0010416667209938169, 0, 0, 0, 0, 0.0018518518190830946, 0, 0, 0, 0, 0.0002500000118743628, 0, -0.4791666269302368,
    -0.07407408952713013, 0.5, 1,
  ],
  /** 组 G（composelayer、origin 1400 300、300 × 200、topleft）的 compose（事件 199）与上屏（事件 234）：平移 = origin + (150, −100)。 */
  g: [
    0.0010416667209938169, 0, 0, 0, 0, 0.0018518518190830946, 0, 0, 0, 0, 0.0002500000118743628, 0, 0.6145833730697632,
    -0.6296296119689941, 0.5, 1,
  ],
  /** Gc（G 下 100 × 100、origin 0 0 0）在组 RT 里，事件 215：组的局部正交按带偏移的矩阵，Gc 落在左上角 (−1, 1)。 */
  gc: [0.006666666828095913, 0, 0, 0, 0, 0.009999999776482582, 0, 0, 0, 0, 0.0005000000237487257, 0, -1, 1, 0.5, 1],
} as const;

const ALIGN_VP = sceneViewProjection(GENERAL);
/** 层级表里的一项（`LayerTransform`）。 */
const alignTransform = (origin: number[], extra: Partial<LayerTransform> = {}): LayerTransform => ({
  origin,
  angles: [0, 0, 0],
  scale: [1, 1, 1],
  visible: true,
  parent: null,
  ...extra,
});
const centerOf = (matrix: Mat4): [number, number] => {
  const [x, y] = transformPoint(matrix, 0, 0, 0);
  return [x, y];
};

describe("alignmentOffset（P8 步骤 3，rea-p8-layer 2.2）", () => {
  it("p8-align 的 a / c 行（160 × 100）与 d 行（120 × 80）：left +、right −、top −、bottom +，角向两个分量都有", () => {
    for (const name of ALIGNMENTS) {
      const [x, y] = ALIGN_PLAIN[name];
      expect(alignmentOffset(alignmentIndex(name), [160, 100]), name).toEqual([x, y]);
      expect(alignmentOffset(alignmentIndex(name), [120, 80]), `${name} d`).toEqual([
        Math.sign(x) * 60,
        Math.sign(y) * 40,
      ]);
    }
  });

  it("p8-align2 的 F1：101.7 × 50.5 按 trunc(size)，topleft 是 (50.5, −25)（不是 (50.85, −25.25)）；只看前两个分量", () => {
    expect(alignmentOffset(alignmentIndex("topleft"), [101.7, 50.5])).toEqual([50.5, -25]);
    expect(alignmentOffset(alignmentIndex("bottomright"), [101.7, 50.5, 7])).toEqual([-50.5, 25]);
    expect(alignmentOffset(alignmentIndex("top"), [101.7, 51.9])).toEqual([0, -25.5]);
  });

  it("center 与表外的下标为 (0, 0)", () => {
    for (const index of [0, 9, -1, 1.5]) expect(alignmentOffset(index, [160, 100]), String(index)).toEqual([0, 0]);
  });
});

describe("drawMatrixOf 与 worldMatrixOf（P8 步骤 3，rea-p8-layer 2.3）", () => {
  it("p8-align 的 a 行：画自己的矩阵 = 世界矩阵 · T(偏移)，中心 − origin 对上表；世界矩阵不带偏移", () => {
    ALIGNMENTS.forEach((name, i) => {
      const origin = [100 + i * 200, 900, 0];
      const offset = alignmentOffset(alignmentIndex(name), [160, 100]);
      const layers = new Map([[0, alignTransform(origin, { offset })]]);
      const [x, y] = centerOf(drawMatrixOf(0, layers, new Map()));
      expect([x - origin[0], y - origin[1]], name).toEqual(ALIGN_PLAIN[name]);
      expect(centerOf(worldMatrixOf(0, layers, new Map())), name).toEqual([origin[0], origin[1]]);
    });
  });

  it("p8-align 的 b 行：偏移在模型空间、缩放与旋转之前（旋转 0.5、缩放 1.5 × 0.75），中心 − origin 对上表", () => {
    ALIGNMENTS.forEach((name, i) => {
      const origin = [100 + i * 200, 660, 0];
      const offset = alignmentOffset(alignmentIndex(name), [160, 100]);
      const layers = new Map([[0, alignTransform(origin, { offset, angles: [0, 0, 0.5], scale: [1.5, 0.75, 1] })]]);
      const [x, y] = centerOf(drawMatrixOf(0, layers, new Map()));
      expect(x - origin[0], `${name} x`).toBeCloseTo(ALIGN_ROTATED[name][0], 2);
      expect(y - origin[1], `${name} y`).toBeCloseTo(ALIGN_ROTATED[name][1], 2);
    });
  });

  it("p8-align 的 d 行：子层（origin 0 0 0）的中心落在父层的 origin，不随父层的对齐；父层自己按偏移画", () => {
    ALIGNMENTS.forEach((name, i) => {
      const origin = [100 + i * 200, 190, 0];
      const offset = alignmentOffset(alignmentIndex(name), [120, 80]);
      const layers = new Map([
        [0, alignTransform(origin, { offset })],
        [1, alignTransform([0, 0, 0], { parent: 0 })],
      ]);
      // 子层先算（缓存里还没有父层）
      expect(centerOf(worldMatrixOf(1, layers, new Map())), name).toEqual([origin[0], origin[1]]);
      const cache = new Map<number, Mat4>();
      expect(centerOf(drawMatrixOf(0, layers, cache)), name).toEqual([origin[0] + offset[0], origin[1] + offset[1]]);
      // 先算父层画自己的矩阵、共用缓存：缓存里只有世界矩阵，子层仍不带父层的偏移
      expect(centerOf(cache.get(0)!), name).toEqual([origin[0], origin[1]]);
      expect(centerOf(worldMatrixOf(1, layers, cache)), name).toEqual([origin[0], origin[1]]);
      expect(centerOf(drawMatrixOf(1, layers, cache)), name).toEqual([origin[0], origin[1]]);
    });
  });

  it("p8-align2 的 Xc：文本层（origin 500 500）的子层不带排版偏移，MVP 对上事件 150；文本层画自己仍带偏移", () => {
    // 排版偏移的数值不影响结论（P6b 1d 原来让子层跟着它，画在 (574, 668) 一带）
    const layers = new Map([
      [0, alignTransform([500, 500, 0], { offset: [74, 168] })],
      [1, alignTransform([0, 0, 0], { parent: 0 })],
    ]);
    const cache = new Map<number, Mat4>();
    expect(centerOf(drawMatrixOf(0, layers, cache))).toEqual([574, 668]);
    expectMatrix(multiply(ALIGN_VP, drawMatrixOf(1, layers, cache)), WPE_ALIGN2.xc, "Xc");
  });

  it("没有偏移或偏移为 0：画自己的矩阵就是世界矩阵（字节不变）", () => {
    const cache = new Map<number, Mat4>();
    const plain = new Map([[0, alignTransform([1, 2, 0])]]);
    expect(drawMatrixOf(0, plain, cache)).toBe(worldMatrixOf(0, plain, cache));
    const zero = new Map([[0, alignTransform([1, 2, 0], { offset: [0, 0] })]]);
    expect(drawMatrixOf(0, zero, new Map())).toEqual(worldMatrixOf(0, zero, new Map()));
  });
});

describe("组的局部正交（P8 步骤 3，p8-align2 的 G、Gc）", () => {
  it("组画自己的矩阵带对齐偏移：compose / 上屏的 MVP 对上事件 199 / 234；子层 Gc 在组 RT 里的 MVP 对上事件 215", () => {
    const offset = alignmentOffset(alignmentIndex("topleft"), [300, 200]);
    expect(offset).toEqual([150, -100]);
    const layers = new Map([
      [0, alignTransform([1400, 300, 0], { offset })],
      [1, alignTransform([0, 0, 0], { parent: 0 })],
    ]);
    const cache = new Map<number, Mat4>();
    const group = drawMatrixOf(0, layers, cache);
    expectMatrix(multiply(ALIGN_VP, group), WPE_ALIGN2.g, "G");
    expectMatrix(
      multiply(groupViewProjection([300, 200], group), worldMatrixOf(1, layers, cache)),
      WPE_ALIGN2.gc,
      "Gc",
    );
    // 局部正交按不带偏移的世界矩阵时 Gc 在组 RT 正中（WPE 不是这样；逆矩阵有 float32 噪声）
    const centered = multiply(
      groupViewProjection([300, 200], worldMatrixOf(0, layers, cache)),
      worldMatrixOf(1, layers, cache),
    );
    expect(Math.abs(centered[12])).toBeLessThan(1e-6);
    expect(Math.abs(centered[13])).toBeLessThan(1e-6);
  });
});

describe("四边形与效果矩阵（P8 步骤 3，p8-align2 的 F1–F3）", () => {
  it("screenQuadSize：图像层按 trunc(size)；文本层（尺寸来自排版）原样", () => {
    expect(screenQuadSize({}, [101.7, 50.5])).toEqual([101, 50]);
    expect(screenQuadSize({ text: null }, [101.7, 50.5])).toEqual([101, 50]);
    expect(screenQuadSize({ text: {} as SceneLayer["text"] }, [213.5, 240])).toEqual([213.5, 240]);
    // F1、F3 的 vs_in：±50.5 / ±25（不是 ±50.85 / ±25.25）
    // 顶点顺序：左上、左下、右上、右下（rea-matrix-order 5.1，改顺序前是左下、右下、左上、右上）
    expect(layerQuad(screenQuadSize({}, [101.7, 50.5]), [1, 1]).map((vertex) => vertex.position)).toEqual([
      [-50.5, 25, 0],
      [-50.5, -25, 0],
      [50.5, 25, 0],
      [50.5, -25, 0],
    ]);
  });

  it("F2 末 pass：MVP、g_EffectModelMatrix、g_LayerModelMatrix 的平移是 origin + 偏移；纹理投影按浮点 size / 2（50.85），对上事件 83", () => {
    const layers = new Map([[0, alignTransform([700, 850, 0], { offset: alignmentOffset(8, [101.7, 50.5]) })]]);
    const matrices = drawMatrices({ role: "final" }, drawMatrixOf(0, layers, new Map()), [101.7, 50.5], ALIGN_VP);
    expectMatrix(matrices.modelViewProjection, WPE_ALIGN2.f2.mvp, "MVP");
    expectMatrix(matrices.effectTextureProjection!, WPE_ALIGN2.f2.textureProjection, "纹理投影");
    expectMatrix(matrices.effectModel!, WPE_ALIGN2.f2.model, "g_EffectModelMatrix");
    expectMatrix(matrices.layerModel!, WPE_ALIGN2.f2.model, "g_LayerModelMatrix");
  });
});

// ———— 步骤 3：GpuScene 与脚本 ————

interface AlignBuffer {
  label: string;
  bytes: Uint8Array;
  destroy(): void;
}
/** 假设备：只记缓冲字节（uniform 与顶点读回），其余调用照收。 */
function alignDevice(): GPUDevice {
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
      destroy() {},
      createView: () => ({ label: descriptor.label ?? "" }),
    }),
    createSampler: () => ({}),
    createBuffer: (descriptor: GPUBufferDescriptor): AlignBuffer => ({
      label: descriptor.label ?? "",
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
      writeBuffer: (buffer: AlignBuffer, offset: number, data: ArrayBuffer, dataOffset = 0, size?: number) => {
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

/** 程序：a_Position + a_TexCoord，`uniforms` 依次排在 0、64、128…（都是 mat4），槽 0 一张纹理。 */
function alignProgram(name: string, uniforms: string[]): TranslateResult {
  return {
    ok: true,
    vertex: { wgsl: `// ${name} v`, entryPoint: "main" },
    fragment: { wgsl: `// ${name} f`, entryPoint: "main" },
    attributes: [
      { name: "a_Position", type: "vec3", location: 0 },
      { name: "a_TexCoord", type: "vec2", location: 1 },
    ],
    uniforms: uniforms.map((uniform, i) => ({
      name: uniform,
      type: "mat4x4<f32>",
      declared: "mat4",
      offset: 64 * i,
      size: 64,
    })),
    uniformBlockSize: 64 * uniforms.length,
    textures: [{ slot: 0, binding: 1, samplerBinding: 2, kind: "2d" }],
  } as unknown as TranslateResult;
}
/** 程序下标：0 图像、1 kbfxm（读四个矩阵）、2 composelayer、3 组的上屏（effectpassthrough）。 */
const ALIGN_PROGRAMS = [
  alignProgram("image", ["g_ModelViewProjectionMatrix"]),
  alignProgram("kbfxm", [
    "g_ModelViewProjectionMatrix",
    "g_EffectTextureProjectionMatrix",
    "g_EffectModelMatrix",
    "g_LayerModelMatrix",
  ]),
  alignProgram("composelayer", ["g_ModelViewProjectionMatrix"]),
  alignProgram("effectpassthrough", ["g_ModelViewProjectionMatrix"]),
];

function alignPass(key: string, program: number, extra: Partial<ScenePass> = {}): ScenePass {
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
function alignLayer(object: number, name: string, extra: Partial<SceneLayer> = {}): SceneLayer {
  return {
    id: object + 10,
    object,
    parent: null,
    name,
    origin: [0, 0, 0],
    scale: [1, 1, 1],
    angles: [0, 0, 0],
    size: [101.7, 50.5],
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
    group: null,
    subtree: [],
    groupUpload: null,
    copyBackground: true,
    clampUVs: true,
    noInterpolation: false,
    fullscreen: false,
    fullscreenSize: null,
    passes: [alignPass(`objects/${object}/passes/0`, 0)],
    colorBlendMode: 0,
    effects: [],
    passthrough: null,
    particle: null,
    alignment: 0,
    ...extra,
  };
}

/**
 * `p8-align2` 的图像部分（文本另在上面的纯函数里核对）：0 F1、1 F2（带 kbfxm）、2 F3（不对齐）、3 组 G（topleft）、4 Gc（G 的子层）、
 * 5 分组节点（不是图像层，没有 `alignment`）。
 */
function align2Bundle(): SceneBundle {
  const kbfxm: SceneEffect = {
    source: 0,
    id: 700,
    name: "kbfxm",
    file: "effects/kbfxm/effect.json",
    fbos: [],
    steps: [draw(alignPass("objects/1/effects/0/passes/0", 1, { blending: "normal" }))],
    enabled: true,
    visibleBound: false,
    unsupported: [],
  };
  const node = alignLayer(5, "node", { passes: [] });
  delete node.alignment;
  return {
    general: {
      width: 1920,
      height: 1080,
      fields: generalDefaults(),
      clearVariable: false,
      perspectiveOverrideFov: particleFov(undefined),
      postprocess: { level: "disabled", bloomFlag: false, hdrFlag: false, bloom: false, hdr: false },
      bloom: { ...BLOOM_DEFAULTS, tint: [1, 1, 1] },
    },
    layers: [
      alignLayer(0, "F1", { origin: [300, 850, 0], alignment: 8 }),
      alignLayer(1, "F2", { origin: [700, 850, 0], alignment: 8, effects: [kbfxm] }),
      alignLayer(2, "F3", { origin: [1100, 850, 0] }),
      alignLayer(3, "G", {
        origin: [1400, 300, 0],
        size: [300, 200],
        alignment: 8,
        passthroughModel: true,
        subtree: [4],
        passes: [alignPass("objects/3/passes/0", 2, { runtime: { 0: FRAMEBUFFER_RT }, framebuffer: true })],
        groupUpload: alignPass("objects/3/groupupload", 3, {
          blending: "normal",
          uniforms: { g_Color4: [1, 1, 1, 1] },
        }),
      }),
      alignLayer(4, "Gc", { size: [100, 100], parent: 3, group: 3 }),
      node,
    ],
    programs: ALIGN_PROGRAMS,
    textures: [],
    bloom: null,
    unsupported: [],
    bindings: [],
    scripts: { list: [] },
  };
}

interface AlignDraw {
  object: number;
  step: { role?: string; kind: string };
  uniformBuffer: AlignBuffer | null;
  vertexBuffer: AlignBuffer;
}
const ALIGN_FRAME: FrameInput = {
  time: 1,
  frametime: 0.05,
  daytime: 0.5,
  pointer: [0.5, 0.5],
  pointerLast: [0.5, 0.5],
  cursor: [0.5, 0.5],
};
function alignDraw(scene: GpuScene, object: number, role: string): AlignDraw {
  const draws = (scene as unknown as { draws: Set<AlignDraw> }).draws;
  const found = [...draws].find((item) => item.object === object && (item.step.role ?? item.step.kind) === role);
  if (!found) throw new Error(`图层 ${object} 没有 ${role} 的 draw`);
  return found;
}
/** uniform 里第 `index` 个 mat4（程序按 64 字节排）。 */
const alignMatrix = (item: AlignDraw, index = 0) =>
  new Float32Array(item.uniformBuffer!.bytes.buffer.slice(64 * index, 64 * index + 64));
/** 四个顶点的位置（a_Position + a_TexCoord，每个顶点 5 个 float）。 */
const alignQuad = (item: AlignDraw) => {
  const floats = new Float32Array(item.vertexBuffer.bytes.buffer.slice(0));
  return [0, 1, 2, 3].map((v) => Array.from(floats.slice(v * 5, v * 5 + 3)));
};
const QUAD_101 = [
  [-50.5, 25, 0],
  [-50.5, -25, 0],
  [50.5, 25, 0],
  [50.5, -25, 0],
];

async function openAlign2() {
  const bundle = align2Bundle();
  const state = SceneState.fromBundle(bundle);
  const scene = await GpuScene.build(alignDevice(), bundle, state, new Set(), [], { particles: { seed: 1 } });
  scene.update(ALIGN_FRAME, state);
  return { bundle, state, scene };
}

class AlignVec {
  constructor(...values: number[]) {
    Object.assign(this, { x: values[0], y: values[1], z: values[2], w: values[3] });
  }
}
/** 最小的脚本 realm（同 `script/api.test.ts` 的 FakeRealm，只留 `ScriptApi` 用到的）。 */
function alignRealm(): ScriptRealm {
  return {
    global: { Object, Array, JSON, Float32Array },
    prototypes: { Vec2: AlignVec.prototype, Vec3: AlignVec.prototype, Vec4: AlignVec.prototype, Mat3: {}, Mat4: {} },
    internal: { updateScriptProperties() {}, convertUserProperties: () => ({}) },
    importModule: async () => ({}),
    dispose() {},
  };
}
/** 图层的脚本 API：写回照宿主（`host.ts` 的 `writeScript`），并记下交给宿主的值（重放表存的就是它）。 */
function alignApi(bundle: SceneBundle, state: () => SceneState) {
  const writes: { target: ScriptTarget; value: ScriptValue }[] = [];
  const api = new ScriptApi(alignRealm(), {
    bundle: () => bundle,
    state,
    screenResolution: () => [1920, 1080],
    frametime: () => 0.05,
    runtime: () => 1,
    timeOfDay: () => 0.5,
    write(target, value) {
      if (target.kind === "unsupported" || target.kind === "script-property" || target.kind === "recompile")
        return false;
      writes.push({ target, value });
      state().write({ property: "", target }, scriptWriteValue(value));
      return true;
    },
  });
  return { api, writes };
}

describe("GpuScene：对齐接到绘制上（P8 步骤 3，p8-align2）", () => {
  beforeEach(() => {
    vi.stubGlobal("GPUTextureUsage", { RENDER_ATTACHMENT: 1, TEXTURE_BINDING: 2, COPY_SRC: 4, COPY_DST: 8 });
    vi.stubGlobal("GPUBufferUsage", { VERTEX: 1, UNIFORM: 2, COPY_DST: 4, MAP_READ: 8, INDEX: 16 });
    vi.stubGlobal("GPUMapMode", { READ: 1 });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("SceneState：图像层按 alignment 与 trunc(size) 写 offset，偏移为 0 不写；没有 alignment 的图层两项都没有", () => {
    const state = SceneState.fromBundle(align2Bundle());
    expect(state.layers.get(0)).toMatchObject({ alignment: 8, offset: [50.5, -25] });
    expect(state.layers.get(3)).toMatchObject({ alignment: 8, offset: [150, -100] });
    expect(state.layers.get(2)!.alignment).toBe(0);
    expect("offset" in state.layers.get(2)!).toBe(false);
    expect("alignment" in state.layers.get(5)!).toBe(false);
    expect("offset" in state.layers.get(5)!).toBe(false);
  });

  it("F1 直接上屏：MVP 对上事件 48（origin + (50.5, −25)），四边形 ±50.5 / ±25；F3 不对齐也截断，MVP 平移是 origin", async () => {
    const { scene } = await openAlign2();
    const f1 = alignDraw(scene, 0, "direct");
    expectMatrix(alignMatrix(f1), WPE_ALIGN2.f1, "F1");
    expect(alignQuad(f1)).toEqual(QUAD_101);
    const f3 = alignDraw(scene, 2, "direct");
    expectMatrix(alignMatrix(f3), Array.from(multiply(ALIGN_VP, translation(1100, 850, 0))), "F3");
    expect(alignQuad(f3)).toEqual(QUAD_101);
  });

  it("F2：末 pass 的四边形 ±50.5 / ±25；MVP、纹理投影（浮点 size）、g_EffectModelMatrix、g_LayerModelMatrix 对上事件 83", async () => {
    const { scene } = await openAlign2();
    const final = alignDraw(scene, 1, "final");
    expect(alignQuad(final)).toEqual(QUAD_101);
    expectMatrix(alignMatrix(final, 0), WPE_ALIGN2.f2.mvp, "MVP");
    expectMatrix(alignMatrix(final, 1), WPE_ALIGN2.f2.textureProjection, "纹理投影");
    expectMatrix(alignMatrix(final, 2), WPE_ALIGN2.f2.model, "g_EffectModelMatrix");
    expectMatrix(alignMatrix(final, 3), WPE_ALIGN2.f2.model, "g_LayerModelMatrix");
    // 画进合成 RT 的基础 pass（几何 fill）不截断：四边形按浮点 size，和它的整面正交一致。取右上角顶点：顶点顺序改成
    // 左上、左下、右上、右下后是第 3 个（下标 2，原来是下标 3，rea-matrix-order 5.1）
    expect(alignQuad(alignDraw(scene, 1, "base"))[2]).toEqual([Math.fround(50.85), Math.fround(25.25), 0]);
  });

  it("组 G：compose 与上屏的 MVP 对上事件 199 / 234、四边形 ±150 / ±100；子层 Gc 在组 RT 里的 MVP 对上事件 215", async () => {
    const { scene } = await openAlign2();
    expectMatrix(alignMatrix(alignDraw(scene, 3, "compose")), WPE_ALIGN2.g, "G compose");
    expectMatrix(alignMatrix(alignDraw(scene, 3, "final")), WPE_ALIGN2.g, "G 上屏");
    expect(alignQuad(alignDraw(scene, 3, "compose"))[2]).toEqual([150, 100, 0]);
    expectMatrix(alignMatrix(alignDraw(scene, 4, "direct")), WPE_ALIGN2.gc, "Gc");
  });

  it("脚本：读名字；写字符串同帧改 MVP（sync 之后）；写数字、查不到的名字读回 center；组改对齐时子层的局部正交跟着重写", async () => {
    const { bundle, state, scene } = await openAlign2();
    const { api } = alignApi(bundle, () => state);
    const f1 = api.layer(0)!;
    expect(f1.alignment).toBe("topleft");
    expect(api.layer(2)!.alignment).toBe("center");
    // p8-par 的 T：写 bottomright 立即读回
    f1.alignment = "bottomright";
    expect(f1.alignment).toBe("bottomright");
    expect(state.layers.get(0)).toMatchObject({ alignment: 4, offset: [-50.5, 25] });
    scene.sync(state);
    scene.update(ALIGN_FRAME, state);
    expectMatrix(
      alignMatrix(alignDraw(scene, 0, "direct")),
      Array.from(multiply(ALIGN_VP, translation(249.5, 875, 0))),
      "F1 bottomright",
    );
    // p8-par 的 T：写数字 2 读回 center；大小写不对同样
    f1.alignment = 2;
    expect(f1.alignment).toBe("center");
    expect("offset" in state.layers.get(0)!).toBe(false);
    f1.alignment = "TopLeft";
    expect(f1.alignment).toBe("center");
    // 同一个值再写一次不标脏
    state.takeDirty();
    f1.alignment = "center";
    expect(state.takeDirty().layers).toEqual(new Set());
    // 组改成 center：G 与子孙一起标脏，Gc 的局部正交按新的组矩阵重写，落回组 RT 正中
    api.layer(3)!.alignment = "center";
    expect(state.takeDirty().layers).toEqual(new Set([3, 4]));
    api.layer(3)!.alignment = "topleft";
    api.layer(3)!.alignment = "center";
    scene.sync(state);
    scene.update(ALIGN_FRAME, state);
    expectMatrix(
      alignMatrix(alignDraw(scene, 3, "compose")),
      Array.from(multiply(ALIGN_VP, translation(1400, 300, 0))),
      "G center",
    );
    // Gc 回到组 RT 正中（平移 0，逆矩阵有 float32 噪声）
    const gc = alignMatrix(alignDraw(scene, 4, "direct"));
    expect(Math.abs(gc[12])).toBeLessThan(1e-6);
    expect(Math.abs(gc[13])).toBeLessThan(1e-6);
  });

  it("脚本：非图像层（没有 alignment）没有访问器，写入照旧是普通属性、不碰状态", async () => {
    const { bundle, state } = await openAlign2();
    const { api, writes } = alignApi(bundle, () => state);
    const node = api.layer(5)!;
    expect("alignment" in node).toBe(false);
    node.alignment = "topleft";
    expect(node.alignment).toBe("topleft");
    expect(writes).toEqual([]);
    // 状态侧同样只认图像层：直接写也不做事
    state.write({ property: "", target: { kind: "layer", object: 5, field: "alignment" } }, 8);
    expect("offset" in state.layers.get(5)!).toBe(false);
  });

  it("重编译后重放：交给宿主的值是 [下标]，运行时的重放表按 objects/<i>/alignment 记、和别的字段分开，新状态里恢复", async () => {
    const { bundle, state } = await openAlign2();
    const { api, writes } = alignApi(bundle, () => state);
    api.layer(0)!.alignment = "bottom";
    api.layer(0)!.origin = new AlignVec(310, 860, 0);
    expect(writes.map((item) => item.value)).toEqual([[5], [310, 860, 0]]);
    // 重编译：新 bundle 的新状态（宿主 `replayWrites` 把记下的写入按目标路径重放一遍）
    const fresh = SceneState.fromBundle(align2Bundle());
    const runtime = new ScriptRuntime(alignRealm(), {
      report: { ready() {}, fallback() {}, info() {}, warn() {}, error() {}, debug() {} },
      write: (target, value) => {
        if (target.kind === "unsupported" || target.kind === "script-property" || target.kind === "recompile")
          return false;
        fresh.write({ property: "", target }, scriptWriteValue(value));
        return true;
      },
      read: () => null,
    });
    for (const { target, value } of writes) runtime.rememberWrite(target, value);
    runtime.replayWrites();
    expect(fresh.layers.get(0)).toMatchObject({ alignment: 5, offset: [0, 25], origin: [310, 860, 0] });
  });
});

// ———— P8 步骤 4：图层依赖 ————

/** `p8-dep` 的 kbmark：64×64 RGBA8、标志 0。被依赖图层 200×200、基础纹理 64×64，A2 的上屏内缩是 0.15 / 64。 */
const KBMARK: SceneTexture = {
  path: "materials/kbmark.tex",
  source: "project",
  format: 0,
  width: 64,
  height: 64,
  textureWidth: 64,
  textureHeight: 64,
  flags: 0,
  clampUVs: false,
  noInterpolation: false,
  mips: [{ width: 64, height: 64, bytes: new Uint8Array(64 * 64 * 4) }],
};
const DEP_TEXTURES = [KBMARK];

/** 一个单绘制 pass 的 effect（`p8-dep` 的 kbtime / kbinv / kbref），程序 1。 */
function depEffect(object: number, source: number, name: string, extra: Partial<SceneEffect> = {}): SceneEffect {
  return {
    source,
    id: 600 + source,
    name,
    file: `effects/${name}/effect.json`,
    fbos: [],
    steps: [draw(alignPass(`objects/${object}/effects/${source}/passes/0`, 1, { blending: "normal" }))],
    enabled: true,
    visibleBound: false,
    unsupported: [],
    ...extra,
  };
}
/**
 * 被依赖的图像层（`p8-dep` 的 A）：200×200、基础材质 translucent（程序 0，槽 0 是 kbmark）、`dependedOn`；passthrough 是编译期按
 * `BLENDMODE` 0 编好的 `effectpassthrough`（程序 2，normal、`g_Color4` = 1）。
 */
function depLayer(object: number, name: string, extra: Partial<SceneLayer> = {}): SceneLayer {
  return alignLayer(object, name, {
    origin: [480, 540, 0],
    size: [200, 200],
    passes: [alignPass(`objects/${object}/passes/0`, 0, { textures: { 0: 0 } })],
    passthrough: alignPass(`objects/${object}/passthrough`, 2, {
      blending: "normal",
      uniforms: { g_Color4: [1, 1, 1, 1] },
    }),
    dependedOn: true,
    ...extra,
  });
}
/** 组合层的基础 pass（composelayer：槽 0 是快照）。 */
const composePass = (object: number) =>
  alignPass(`objects/${object}/passes/0`, 0, { runtime: { 0: FRAMEBUFFER_RT }, framebuffer: true });

const refLabel = (ref: TextureRef | TargetRef): string =>
  ref.kind === "composite"
    ? `c${ref.index}`
    : ref.kind === "fbo"
      ? `fbo:${ref.name}`
      : ref.kind === "layer"
        ? `layer:${ref.object}`
        : ref.kind;
/** 计划的骨架：绘制写成 `角色 槽0的来源 → 目标`，copy 带两端，其余只写种类。 */
const skeleton = (plan: LayerPlan): string[] =>
  plan.steps.map((step) => {
    if (step.kind === "draw")
      return `${step.role}${step.inputs[0] ? ` ${refLabel(step.inputs[0])}` : ""} → ${refLabel(step.target)}`;
    if (step.kind === "copy") return `copy ${refLabel(step.source)} → ${refLabel(step.target)}`;
    if (step.kind === "subtree" || step.kind === "clear") return `${step.kind} → ${refLabel(step.target)}`;
    return step.kind;
  });
const lastDraw = (plan: LayerPlan) => plan.steps.at(-1) as DrawStep;

describe("planLayer：被依赖的图层（P8 步骤 4，rea-p8-render 2.3、2.4，p8-REPORT「图层依赖」）", () => {
  it("0 / 1 / 2 个 effect 的写入顺序（A9 / A2 / A11）：最后一次写入落在合成 RT 0；最后一个 effect 不上屏，passthrough 读 0 上屏", () => {
    const a9 = planLayer(depLayer(0, "A9"), DEP_TEXTURES);
    expect(skeleton(a9)).toEqual(["base texture → c0", "passthrough c0 → scene"]);
    expect(a9.composite).toEqual({ count: 1, width: 64, height: 64 });
    const a2 = planLayer(depLayer(0, "A2", { effects: [depEffect(0, 0, "kbtime")] }), DEP_TEXTURES);
    expect(skeleton(a2)).toEqual(["base texture → c1", "effect c1 → c0", "passthrough c0 → scene"]);
    expect(a2.composite).toEqual({ count: 2, width: 64, height: 64 });
    const a11 = planLayer(
      depLayer(0, "A11", { effects: [depEffect(0, 0, "kbinv"), depEffect(0, 1, "kbtime")] }),
      DEP_TEXTURES,
    );
    expect(skeleton(a11)).toEqual(["base texture → c0", "effect c0 → c1", "effect c1 → c0", "passthrough c0 → scene"]);
    // 关着的 effect 不算写入（A2 的 kbtime 关掉 = A9）
    const off = depLayer(0, "A2", { effects: [depEffect(0, 0, "kbtime", { enabled: false })] });
    expect(skeleton(planLayer(off, DEP_TEXTURES))).toEqual(skeleton(a9));
    // 不被依赖时照旧：最后一个 effect 上屏，没有 passthrough
    const plain = depLayer(0, "plain", { dependedOn: false, effects: [depEffect(0, 0, "kbtime")] });
    expect(skeleton(planLayer(plain, DEP_TEXTURES))).toEqual(["base texture → c0", "final c0 → scene"]);
    expect(skeleton(planLayer(depLayer(0, "plain", { dependedOn: false }), DEP_TEXTURES))).toEqual([
      "direct texture → scene",
    ]);
  });

  it("上屏（A2、A9）：passthrough 材质、图层四边形、UV 0–1 内缩 0.15 / 64（同末 pass）、混合取基础材质的 translucent，深度借基础 pass", () => {
    const layer = depLayer(0, "A9");
    expect(lastDraw(planLayer(layer, DEP_TEXTURES))).toEqual({
      kind: "draw",
      role: "passthrough",
      pass: layer.passthrough,
      effect: null,
      target: { kind: "scene" },
      inputs: { 0: { kind: "composite", index: 0 } },
      geometry: "layer",
      uv: [1, 1],
      inset: uvInset([200, 200], KBMARK),
      blending: "translucent",
      raster: { test: false, write: false, cull: false },
    });
    expect(uvInset([200, 200], KBMARK)[0]).toBeCloseTo(0.00234375, 9);
  });

  it("混合：colorBlendMode 31 时 additive（快照规则 1 不看 0x10，不拍）；colorBlendMode 7 + 被依赖（2251857160 的 356）时基础材质的、先拍快照", () => {
    const additive = planLayer(depLayer(0, "A", { colorBlendMode: 31 }), DEP_TEXTURES);
    expect(skeleton(additive)).toEqual(["base texture → c0", "passthrough c0 → scene"]);
    expect(lastDraw(additive).blending).toBe("additive");
    expect(lastDraw(additive).raster).toEqual({ test: false, write: false, cull: false });
    const frost = depEffect(0, 0, "frost");
    const blended = planLayer(depLayer(0, "356", { colorBlendMode: 7, effects: [frost] }), DEP_TEXTURES);
    expect(skeleton(blended)).toEqual(["snapshot", "base texture → c1", "effect c1 → c0", "passthrough c0 → scene"]);
    expect(lastDraw(blended).blending).toBe("translucent");
    // 只是 colorBlendMode 混合（没被依赖）：步骤相同、不对调（没有独占 RT，写在哪张都一样）
    const unlisted = depLayer(0, "356", { colorBlendMode: 7, dependedOn: false, effects: [frost] });
    expect(skeleton(planLayer(unlisted, DEP_TEXTURES))).toEqual([
      "snapshot",
      "base texture → c0",
      "effect c0 → c1",
      "passthrough c1 → scene",
    ]);
  });

  it("组合层没有 effect 也画（p8-dep 的 7、p8-misc 的 A13）：compose → 0 → 上屏，UV 0–1 不内缩，合成 RT 按 size；没被依赖时整层不画", () => {
    const cl = (dependedOn: boolean) =>
      depLayer(0, "A7", { passthroughModel: true, dependedOn, passes: [composePass(0)] });
    const plan = planLayer(cl(true), DEP_TEXTURES);
    expect(skeleton(plan)).toEqual(["snapshot", "compose framebuffer → c0", "passthrough c0 → scene"]);
    expect(lastDraw(plan).inset).toEqual([0, 0]);
    expect(plan.composite).toEqual({ count: 1, width: 200, height: 200 });
    expect(planLayer(cl(false), DEP_TEXTURES)).toEqual({ composite: null, steps: [], reasons: [] });
  });

  it("对调覆盖 copy 与 subtree：effect 的 copy 读的当前合成 RT、组画子树的目标都跟着换", () => {
    const kbcopy = depEffect(0, 0, "kbcopy", {
      fbos: [{ name: "_rt_x", format: "rgba8888", scale: 1, unique: false, repeat: false }],
      steps: [
        { kind: "copy", source: "previous", target: "_rt_x" },
        draw(alignPass("objects/0/effects/0/passes/0", 1, { blending: "normal" })),
      ],
    });
    expect(skeleton(planLayer(depLayer(0, "A", { effects: [kbcopy] }), DEP_TEXTURES))).toEqual([
      "base texture → c1",
      "copy c1 → fbo:_rt_x",
      "effect c1 → c0",
      "passthrough c0 → scene",
    ]);
    // 组（编译期照报 dependency:group，渲染图照规则排）：compose → 子树 → effect → 上屏
    const group = depLayer(0, "G", {
      passthroughModel: true,
      subtree: [1],
      passes: [composePass(0)],
      effects: [depEffect(0, 0, "kbtime")],
    });
    expect(skeleton(planLayer(group, DEP_TEXTURES))).toEqual([
      "snapshot",
      "compose framebuffer → c1",
      "subtree → c1",
      "effect c1 → c0",
      "passthrough c0 → scene",
    ]);
  });

  it("swapCompositeIndices：只换合成 RT 的 0 ↔ 1（绘制的目标与输入、copy 两端、clear、subtree、文本），别的引用与步骤不动、原计划不改", () => {
    const pass = alignPass("objects/0/passes/0", 0);
    const raster = { test: false, write: false, cull: false };
    const composite = (index: number) => ({ kind: "composite", index }) as const;
    const others = {
      1: { kind: "fbo", effect: 0, name: "_rt_x" },
      2: { kind: "framebuffer" },
      3: { kind: "layer", object: 4 },
      4: { kind: "texture", index: 0 },
    } as const;
    const drawStep = (target: TargetRef, input: TextureRef): DrawStep => ({
      kind: "draw",
      role: "effect",
      pass,
      effect: 0,
      target,
      inputs: { 0: input, ...others },
      geometry: "fullscreen",
      uv: [1, 1],
      inset: [0, 0],
      blending: null,
      raster,
    });
    const steps: LayerStep[] = [
      { kind: "snapshot" },
      drawStep(composite(0), composite(1)),
      drawStep({ kind: "scene" }, composite(0)),
      drawStep({ kind: "fbo", effect: 0, name: "_rt_x" }, composite(1)),
      { kind: "copy", effect: 0, source: composite(0), target: { kind: "fbo", effect: 0, name: "_rt_x" } },
      { kind: "copy", effect: null, source: { kind: "framebuffer" }, target: composite(1) },
      { kind: "clear", target: composite(1) },
      { kind: "subtree", target: composite(0) },
      {
        kind: "text",
        part: "glyphs",
        pass,
        space: "composite",
        target: composite(1),
        inputs: { 0: { kind: "atlas", color: false } },
        blending: "translucent",
        raster,
      },
      { kind: "swap", effect: 0, source: "_rt_x", target: "_rt_y" },
    ];
    const before = JSON.stringify(steps);
    expect(swapCompositeIndices(steps)).toEqual([
      { kind: "snapshot" },
      drawStep(composite(1), composite(0)),
      drawStep({ kind: "scene" }, composite(1)),
      drawStep({ kind: "fbo", effect: 0, name: "_rt_x" }, composite(0)),
      { kind: "copy", effect: 0, source: composite(1), target: { kind: "fbo", effect: 0, name: "_rt_x" } },
      { kind: "copy", effect: null, source: { kind: "framebuffer" }, target: composite(0) },
      { kind: "clear", target: composite(0) },
      { kind: "subtree", target: composite(1) },
      {
        kind: "text",
        part: "glyphs",
        pass,
        space: "composite",
        target: composite(0),
        inputs: { 0: { kind: "atlas", color: false } },
        blending: "translucent",
        raster,
      },
      { kind: "swap", effect: 0, source: "_rt_x", target: "_rt_y" },
    ]);
    expect(JSON.stringify(steps)).toBe(before);
  });

  it('引用方：pass.layerComposites 在各种计划里都给出 { kind: "layer" }（图像层直接上屏与 effect、形状、粒子、模型）', () => {
    const LAYER_5 = { kind: "layer", object: 5 } as const;
    const inputsOf = (plan: LayerPlan, index = 0) =>
      (plan.steps[index] as { inputs: Record<number, TextureRef> }).inputs;
    const ref = (key: string, program: number, extra: Partial<ScenePass> = {}) =>
      alignPass(key, program, { textures: { 0: 0 }, layerComposites: { 1: 5 }, ...extra });
    const direct = depLayer(0, "B", { dependedOn: false, passes: [ref("objects/0/passes/0", 0)] });
    expect(inputsOf(planLayer(direct, DEP_TEXTURES))).toEqual({ 0: { kind: "texture", index: 0 }, 1: LAYER_5 });
    const kbref = depEffect(0, 0, "kbref", {
      steps: [draw(ref("objects/0/effects/0/passes/0", 1, { textures: {} }))],
    });
    const effect = planLayer(depLayer(0, "B", { dependedOn: false, effects: [kbref] }), DEP_TEXTURES);
    expect(inputsOf(effect, 1)).toEqual({ 0: { kind: "composite", index: 0 }, 1: LAYER_5 });
    const shape = shapeLayer(3, {
      effects: [
        shafts(3, 0, { steps: [draw(shapePass("objects/3/effects/0/passes/0", { layerComposites: { 2: 5 } }))] }),
      ],
    });
    expect(inputsOf(planShapeLayer(shape))).toEqual({ 1: { kind: "texture", index: 0 }, 2: LAYER_5 });
    const particlePass = ref("objects/0/particle/passes/0", 0);
    const particle = { passes: [particlePass], children: [], renderers: [{ kind: "sprite" }], flags: 0 };
    expect(
      inputsOf(planParticleLayer({ particle: particle as unknown as NonNullable<SceneLayer["particle"]> })),
    ).toEqual({ 0: { kind: "texture", index: 0 }, 1: LAYER_5 });
    const model = { meshes: [{ passes: [particlePass] }], order: [0] };
    expect(inputsOf(planModelLayer({ model: model as unknown as NonNullable<SceneLayer["model"]> }))).toEqual({
      0: { kind: "texture", index: 0 },
      1: LAYER_5,
    });
  });
});

describe("buildableLayers 与 layerOpsToRun：被依赖的图层不可见也画（P8 步骤 4，WPE 0x1000）", () => {
  it("buildableLayers：被依赖的不看自身与祖先的可见性（写死隐藏、祖先写死隐藏都建）；没被依赖的照旧不建", () => {
    const layers = [
      depLayer(0, "hiddenGroup", { passes: [], passthrough: null, dependedOn: undefined, visible: false }),
      depLayer(1, "A", { visible: false }),
      depLayer(2, "B", { parent: 0 }),
      depLayer(3, "C", { visible: false, dependedOn: false }),
      depLayer(4, "D", { parent: 0, dependedOn: false }),
      depLayer(5, "E", { dependedOn: false }),
    ];
    expect(buildableLayers({ layers, scripts: { list: [] } }).map((layer) => layer.object)).toEqual([1, 2, 5]);
  });

  it("layerOpsToRun：可见时全部；不可见时一般整段跳过；被依赖的照跑，只去掉画到「场景」的绘制（粒子树、模型同样算画到场景）", () => {
    const opDraw = (kind: string) => ({ kind: "draw", draw: { step: { target: { kind } } } });
    const ops = [
      { kind: "snapshot" },
      opDraw("composite"),
      opDraw("fbo"),
      { kind: "copy" },
      { kind: "clear" },
      { kind: "subtree" },
      { kind: "swap" },
      opDraw("scene"),
      { kind: "particle-tree" },
      { kind: "model" },
    ];
    expect(layerOpsToRun(ops, { dependedOn: true }, true)).toBe(ops);
    expect(layerOpsToRun(ops, { dependedOn: false }, true)).toBe(ops);
    expect(layerOpsToRun(ops, {}, false)).toEqual([]);
    expect(layerOpsToRun(ops, { dependedOn: false }, false)).toEqual([]);
    expect(layerOpsToRun(ops, { dependedOn: true }, false)).toEqual(ops.slice(0, 7));
  });
});

interface DepBuffer {
  label: string;
  bytes: Uint8Array;
  destroy(): void;
}
/** 假设备：记纹理（标签、尺寸）、bind group 的条目、缓冲字节，以及一帧的编码轨迹（目标与 loadOp、绘制、拷贝）。 */
class DepGpu {
  readonly trace: string[] = [];
  readonly textures: { label: string; width: number; height: number; format: string }[] = [];
  readonly bindGroups: { label: string; entries: GPUBindGroupEntry[] }[] = [];
  readonly device: GPUDevice;

  constructor() {
    const { trace, textures, bindGroups } = this;
    const renderPass = () => ({
      setViewport() {},
      setPipeline() {},
      setBindGroup() {},
      setVertexBuffer(_slot: number, buffer: DepBuffer) {
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
      createTexture: (descriptor: GPUTextureDescriptor) => {
        const size = descriptor.size as { width: number; height?: number } | number[];
        const [width, height] = Array.isArray(size) ? size : [size.width, size.height ?? 1];
        const record = { label: descriptor.label ?? "", width, height, format: descriptor.format };
        textures.push(record);
        const view = { label: record.label };
        return { ...record, createView: () => view, destroy() {} };
      },
      createSampler: (descriptor: GPUSamplerDescriptor = {}) => ({ descriptor }),
      createBuffer: (descriptor: GPUBufferDescriptor): DepBuffer => ({
        label: descriptor.label ?? "",
        bytes: new Uint8Array(descriptor.size),
        destroy() {},
      }),
      createShaderModule: () => ({ getCompilationInfo: async () => ({ messages: [] }) }),
      createBindGroupLayout: () => ({}),
      createPipelineLayout: () => ({}),
      createRenderPipeline: () => ({ getBindGroupLayout: () => ({}) }),
      createRenderPipelineAsync: async (descriptor: GPURenderPipelineDescriptor) => ({ label: descriptor.label }),
      createBindGroup: (descriptor: GPUBindGroupDescriptor) => {
        bindGroups.push({ label: descriptor.label ?? "", entries: [...descriptor.entries] });
        return {};
      },
      createCommandEncoder: () => ({
        beginRenderPass: (descriptor: GPURenderPassDescriptor) => {
          const attachment = [...descriptor.colorAttachments][0]!;
          const { label } = attachment.view as unknown as { label: string };
          trace.push(`pass ${label} ${attachment.loadOp}`);
          return renderPass();
        },
        copyTextureToTexture: (source: { texture: { label: string } }, target: { texture: { label: string } }) => {
          trace.push(`copy ${source.texture.label} -> ${target.texture.label}`);
        },
        copyTextureToBuffer() {},
        finish: () => ({}),
      }),
      queue: {
        writeBuffer: (buffer: DepBuffer, offset: number, data: ArrayBuffer, dataOffset = 0, size?: number) => {
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

/** 程序：MVP（偏移 0），`resolution` 时另有 `g_Texture1Resolution`（偏移 64），声明 `slots` 这些纹理槽（绑定号 `1 + 2n`）。 */
function depProgram(name: string, slots: number[], resolution = false): TranslateResult {
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
      ...(resolution
        ? [{ name: "g_Texture1Resolution", type: "vec4<f32>", declared: "vec4", offset: 64, size: 16 }]
        : []),
    ],
    uniformBlockSize: resolution ? 80 : 64,
    textures: slots.map((slot) => ({ slot, binding: 1 + 2 * slot, samplerBinding: 2 + 2 * slot, kind: "2d" })),
  } as unknown as TranslateResult;
}
/** 程序下标：0 图像（槽 0、1）、1 effect（槽 0、1）、2 passthrough（槽 0）。 */
const DEP_PROGRAMS = [
  depProgram("image", [0, 1], true),
  depProgram("effect", [0, 1], true),
  depProgram("passthrough", [0]),
];

function depBundleOf(layers: SceneLayer[]): SceneBundle {
  return { ...align2Bundle(), layers, programs: DEP_PROGRAMS, textures: DEP_TEXTURES };
}
/**
 * `p8-dep` 的结构：0 B1（引用方，直接上屏，槽 1 读 A，排在 A 前面）、1 B2（引用方，kbref 的槽 1 读 A）、2 A（被依赖、写死隐藏，带一个
 * visible 绑属性的 kbtime）、3 N（没被依赖的写死隐藏图层，不建资源）。
 */
function depBundle(): SceneBundle {
  const ref = (key: string, program: number, extra: Partial<ScenePass> = {}) =>
    alignPass(key, program, { textures: { 0: 0 }, layerComposites: { 1: 2 }, ...extra });
  return depBundleOf([
    depLayer(0, "B1", { dependedOn: false, passes: [ref("objects/0/passes/0", 0)] }),
    depLayer(1, "B2", {
      dependedOn: false,
      origin: [1440, 540, 0],
      effects: [depEffect(1, 0, "kbref", { steps: [draw(ref("objects/1/effects/0/passes/0", 1, { textures: {} }))] })],
    }),
    depLayer(2, "A", { visible: false, effects: [depEffect(2, 0, "kbtime", { visibleBound: true })] }),
    depLayer(3, "N", { visible: false, dependedOn: false }),
  ]);
}

interface DepRuntime {
  object: number;
  resources: { composites: { view: unknown; width: number; height: number; texture: { label: string } }[] };
}
const depRuntime = (scene: GpuScene, object: number) =>
  (scene as unknown as { layers: DepRuntime[] }).layers.find((runtime) => runtime.object === object);
/** 一个 draw 的 bind group 在槽位 `slot` 上绑的视图（绑定号 `1 + 2·slot`）。 */
const boundView = (gpu: DepGpu, label: string, slot: number) =>
  gpu.bindGroups.find((group) => group.label === label)?.entries.find((entry) => entry.binding === 1 + 2 * slot)
    ?.resource;

async function openDep(bundle: SceneBundle) {
  const gpu = new DepGpu();
  const state = SceneState.fromBundle(bundle);
  const scene = await GpuScene.build(gpu.device, bundle, state, new Set(), [], { particles: { seed: 1 } });
  scene.update(ALIGN_FRAME, state);
  return { gpu, state, scene };
}
/** 编码一帧，返回轨迹（第一行是清场景目标）。 */
function encodeDep(gpu: DepGpu, scene: GpuScene, state: SceneState): string[] {
  gpu.trace.length = 0;
  scene.encode(gpu.device.createCommandEncoder(), state);
  return [...gpu.trace];
}

describe("GpuScene：被依赖图层的独占 RT 与编码（P8 步骤 4，p8-dep）", () => {
  beforeEach(() => {
    vi.stubGlobal("GPUTextureUsage", { RENDER_ATTACHMENT: 1, TEXTURE_BINDING: 2, COPY_SRC: 4, COPY_DST: 8 });
    vi.stubGlobal("GPUBufferUsage", { VERTEX: 1, UNIFORM: 2, COPY_DST: 4, MAP_READ: 8, INDEX: 16 });
    vi.stubGlobal("GPUMapMode", { READ: 1 });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  const NAME = layerCompositeName(12);

  it("独占 RT：建场景时建一张（标签 _rt_imageLayerComposite_12_a、64×64 同合成 RT、场景格式），是 A 的合成 RT 0；隐藏的 N 不建资源", async () => {
    const { gpu, scene } = await openDep(depBundle());
    expect(gpu.textures.filter((texture) => texture.label === NAME)).toEqual([
      { label: NAME, width: 64, height: 64, format: "rgba8unorm" },
    ]);
    const composites = depRuntime(scene, 2)!.resources.composites;
    expect(composites.map((target) => target.texture.label)).toEqual([NAME, "composite 64x64|true|false #0"]);
    expect(depRuntime(scene, 3)).toBeUndefined();
  });

  it("引用：两个引用方的槽 1 绑同一张独占 RT（A 排在 B1 后面，B1 读到的是上一帧）；g_Texture1Resolution 是它的尺寸", async () => {
    const { gpu, scene } = await openDep(depBundle());
    const own = depRuntime(scene, 2)!.resources.composites[0];
    expect(boundView(gpu, "layer 10 B1 direct", 1)).toBe(own.view);
    expect(boundView(gpu, "layer 11 B2 final", 1)).toBe(own.view);
    // 槽 0 照常：B1 是 kbmark，B2 是自己的合成 RT
    expect(boundView(gpu, "layer 10 B1 direct", 0)).not.toBe(own.view);
    const draws = (scene as unknown as { draws: Set<{ label: string; uniformBuffer: DepBuffer | null }> }).draws;
    const b1 = [...draws].find((item) => item.label === "layer 10 B1 direct")!;
    expect(Array.from(new Float32Array(b1.uniformBuffer!.bytes.buffer.slice(64, 80)))).toEqual([64, 64, 64, 64]);
  });

  it("编码：A 写死隐藏——基础 pass 画进池化 RT、kbtime 画进独占 RT，没有上屏；可见时多一次 passthrough 上屏", async () => {
    const { gpu, scene, state } = await openDep(depBundle());
    const hidden = encodeDep(gpu, scene, state);
    expect(hidden[0]).toMatch(/^pass scene target clear/);
    expect(hidden.slice(1)).toEqual([
      "  draw layer 10 B1 direct",
      "pass composite 64x64|true|false #0 load",
      "  draw layer 11 B2 base",
      "pass scene target load",
      "  draw layer 11 B2 final",
      "pass composite 64x64|true|false #0 load",
      "  draw layer 12 A base",
      `pass ${NAME} load`,
      "  draw layer 12 A effect",
    ]);
    state.write({ property: "p", target: { kind: "layer", object: 2, field: "visible" } }, true);
    scene.sync(state);
    scene.update(ALIGN_FRAME, state);
    expect(encodeDep(gpu, scene, state).slice(-6)).toEqual([
      "pass composite 64x64|true|false #0 load",
      "  draw layer 12 A base",
      `pass ${NAME} load`,
      "  draw layer 12 A effect",
      "pass scene target load",
      "  draw layer 12 A passthrough",
    ]);
  });

  it("effect 开关重建后还是同一张：kbtime 关掉时基础 pass 直接画进独占 RT，再打开回到池化 → 独占；引用方的绑定不变", async () => {
    const { gpu, scene, state } = await openDep(depBundle());
    const own = depRuntime(scene, 2)!.resources.composites[0];
    const toggle = (value: boolean) => {
      state.write({ property: "p", target: { kind: "effect", object: 2, effect: 0 } }, value);
      scene.sync(state);
      scene.update(ALIGN_FRAME, state);
    };
    toggle(false);
    expect(depRuntime(scene, 2)!.resources.composites[0]).toBe(own);
    expect(encodeDep(gpu, scene, state).slice(-2)).toEqual([`pass ${NAME} load`, "  draw layer 12 A base"]);
    toggle(true);
    expect(depRuntime(scene, 2)!.resources.composites[0]).toBe(own);
    expect(encodeDep(gpu, scene, state).slice(-4)).toEqual([
      "pass composite 64x64|true|false #0 load",
      "  draw layer 12 A base",
      `pass ${NAME} load`,
      "  draw layer 12 A effect",
    ]);
    expect(gpu.textures.filter((texture) => texture.label === NAME)).toHaveLength(1);
  });

  it("组里的被依赖者（3554161528 的 411）：组画子树时按同一规则——不可见时画进自己的 RT、不画进组的 RT，可见时上屏画进组的 RT", async () => {
    const bundle = depBundleOf([
      depLayer(0, "G", {
        dependedOn: false,
        passthroughModel: true,
        subtree: [1],
        passes: [composePass(0)],
        passthrough: null,
        groupUpload: alignPass("objects/0/groupupload", 2, {
          blending: "normal",
          uniforms: { g_Color4: [1, 1, 1, 1] },
        }),
      }),
      depLayer(1, "C", { parent: 0, group: 0, visible: false }),
    ]);
    const { gpu, scene, state } = await openDep(bundle);
    const own = layerCompositeName(11);
    const group = "composite 200x200|true|false #0";
    const hidden = encodeDep(gpu, scene, state);
    expect(hidden.slice(1)).toEqual([
      "copy scene target -> _rt_FullFrameBuffer",
      `pass ${group} load`,
      "  draw layer 10 G compose",
      `pass ${own} load`,
      "  draw layer 11 C base",
      "pass scene target load",
      "  draw layer 10 G final",
    ]);
    state.write({ property: "p", target: { kind: "layer", object: 1, field: "visible" } }, true);
    scene.sync(state);
    scene.update(ALIGN_FRAME, state);
    expect(encodeDep(gpu, scene, state).slice(4, 8)).toEqual([
      `pass ${own} load`,
      "  draw layer 11 C base",
      `pass ${group} load`,
      "  draw layer 11 C passthrough",
    ]);
  });
});

// ———— P8 步骤 5：写入状态 ————

describe("writesAlpha：rea-p8-render 4.4 的表（p8-alpha、p8-misc W1）", () => {
  // 每行：绘制、base（stepPipeline 按目标 / 组 / 上屏角色算的缺省）、upload、alphaMax、期望（缺省、enabled、disabled）
  it.each<[string, boolean, boolean, boolean, [boolean, boolean, boolean]]>([
    ["场景目标直接上屏（7 / 0xF / 7）", false, false, false, [false, true, false]],
    ["最后一个 effect 的上屏 pass（7，绑定后被强制改回）", false, true, false, [false, false, false]],
    ["passthrough 上屏（7，材质不起作用）", false, true, false, [false, false, false]],
    ["合成 RT 的基础 pass（0xF / 0xF / 7）", true, false, false, [true, true, false]],
    ["effect fbo / 合成 RT 的中间 pass（0xF / 0xF / 7）", true, false, false, [true, true, false]],
    ["copybackground: false 的组里画子层（0x10 强制 0xF）", true, false, true, [true, true, true]],
    ["copybackground: false 的组里上屏（0x10 强制 0xF）", true, true, true, [true, true, true]],
    ["copybackground: true 的组里画子层（同合成路径）", true, false, false, [true, true, false]],
    ["copybackground: true 的组里上屏（WPE 关掉 alpha 写入）", false, true, false, [false, false, false]],
  ])("%s", (_name, base, upload, alphaMax, expected) => {
    const values: (AlphaWriting | undefined)[] = [undefined, "enabled", "disabled"];
    expect(values.map((alphaWriting) => writesAlpha(base, { upload, alphaMax, alphaWriting }))).toEqual(expected);
  });

  it("alphaToCoverage：只认 alphatocoverage（大小写不同不算）；null（画进合成 RT 的基础 pass）不开", () => {
    expect(alphaToCoverage("alphatocoverage")).toBe(true);
    for (const blending of [null, "normal", "translucent", "additive", "AlphaToCoverage", ""])
      expect(alphaToCoverage(blending), String(blending)).toBe(false);
  });
});

/** 写入状态用的 pass：槽 0 是 kbmark（程序 0 图像、1 effect、2 passthrough，同 `DEP_PROGRAMS` 的下标）。 */
const writePass = (key: string, program: number, extra: Partial<ScenePass> = {}) =>
  alignPass(key, program, { textures: { 0: 0 }, ...extra });
/** 两个 pass 的 effect（`p8-alpha` 的 14）：第 1 个画进 fbo `_rt_half`，第 2 个上屏读它；两个 pass 都是程序 1、normal。 */
function fboEffect(object: number, first: Partial<ScenePass> = {}, last: Partial<ScenePass> = {}): SceneEffect {
  return {
    source: 0,
    id: 700,
    name: "kbfbo",
    file: "effects/kbfbo/effect.json",
    fbos: [{ name: "_rt_half", format: "rgba8888", scale: 1, unique: false, repeat: false }],
    steps: [
      {
        kind: "draw",
        pass: alignPass(`objects/${object}/effects/0/passes/0`, 1, { blending: "normal", ...first }),
        target: "_rt_half",
        compose: false,
        binds: null,
      },
      draw(alignPass(`objects/${object}/effects/0/passes/1`, 1, { blending: "normal", ...last }), [
        { name: "_rt_half", index: 0 },
      ]),
    ],
    enabled: true,
    visibleBound: false,
    unsupported: [],
  };
}
type StepLike = Parameters<typeof stepPipeline>[0];
const specOf = (step: LayerStep, group: Pick<SceneLayer, "copyBackground"> | null = null, mesh?: string) =>
  stepPipeline(step as StepLike, "rgba8unorm", () => "rgba8unorm", false, group, mesh);
/** 一个图层计划里每个绘制步骤的 `角色 目标 alpha [a2c]` 与管线键。 */
const writeRows = (layer: SceneLayer, group: Pick<SceneLayer, "copyBackground"> | null = null) =>
  planLayer(layer, DEP_TEXTURES)
    .steps.filter((step): step is DrawStep => step.kind === "draw")
    .map((step) => {
      const spec = specOf(step, group);
      return [`${step.role} ${step.target.kind} ${spec.alpha}${spec.alphaToCoverage ? " a2c" : ""}`, pipelineKey(spec)];
    });

describe("stepPipeline：alpha 叠材质的 alphawriting（P8 步骤 5 点 3）", () => {
  it("直接上屏（p8-alpha 的 13）：缺省 / disabled 不写，enabled 写；管线键只差 alpha 一项", () => {
    const rows = (alphaWriting?: AlphaWriting) =>
      writeRows(
        alignLayer(0, "D", { passes: [writePass("objects/0/passes/0", 0, alphaWriting ? { alphaWriting } : {})] }),
      );
    expect(rows()).toEqual([["direct scene false", "0|translucent|rgba8unorm|false"]]);
    expect(rows("enabled")).toEqual([["direct scene true", "0|translucent|rgba8unorm|true"]]);
    expect(rows("disabled")).toEqual([["direct scene false", "0|translucent|rgba8unorm|false"]]);
  });

  it("基础 pass、fbo pass、末 pass（p8-alpha 的 14–16、p8-misc W1）：disabled 在合成 RT 与 fbo 上不写，上屏的末 pass 不看材质", () => {
    const layer = (base: Partial<ScenePass>, first: Partial<ScenePass>, last: Partial<ScenePass>) =>
      alignLayer(0, "F", {
        passes: [writePass("objects/0/passes/0", 0, base)],
        effects: [fboEffect(0, first, last)],
      });
    // 缺省：改前的键
    expect(writeRows(layer({}, {}, {}))).toEqual([
      ["base composite true", "0|null|rgba8unorm|true"],
      ["effect fbo true", "1|normal|rgba8unorm|true"],
      ["final scene false", "1|translucent|rgba8unorm|false"],
    ]);
    const enabled = { alphaWriting: "enabled" as const };
    const disabled = { alphaWriting: "disabled" as const };
    expect(writeRows(layer(disabled, disabled, enabled)).map(([row]) => row)).toEqual([
      "base composite false",
      "effect fbo false",
      "final scene false",
    ]);
    expect(writeRows(layer(enabled, enabled, disabled)).map(([row]) => row)).toEqual([
      "base composite true",
      "effect fbo true",
      "final scene false",
    ]);
  });

  it("passthrough 上屏（被依赖的图层）：材质写 enabled 也不写 alpha", () => {
    const rows = writeRows(
      depLayer(0, "A", {
        passthrough: alignPass("objects/0/passthrough", 2, { blending: "normal", alphaWriting: "enabled" }),
      }),
    );
    expect(rows).toEqual([
      ["base composite true", "0|null|rgba8unorm|true"],
      ["passthrough scene false", "2|translucent|rgba8unorm|false"],
    ]);
  });

  it("组里（copybackground false 强制写、true 照规则）：disabled 在 alpha MAX 的组里照写", () => {
    const child = (alphaWriting?: AlphaWriting) =>
      alignLayer(1, "C", {
        parent: 0,
        group: 0,
        passes: [writePass("objects/1/passes/0", 0, alphaWriting ? { alphaWriting } : {})],
      });
    expect(writeRows(child("disabled"), { copyBackground: false })).toEqual([
      ["direct scene true", "0|translucent|rgba8unorm|true|max"],
    ]);
    expect(writeRows(child("disabled"), { copyBackground: true })).toEqual([
      ["direct scene false", "0|translucent|rgba8unorm|false"],
    ]);
    expect(writeRows(child(), { copyBackground: true })).toEqual([
      ["direct scene true", "0|translucent|rgba8unorm|true"],
    ]);
  });
});

describe("stepPipeline：A2C 按步骤的实际混合开（P8 步骤 5 点 3，rea-p8-render 第 5 节）", () => {
  const a2c = { blending: "alphatocoverage" };

  it("直接上屏：开 A2C、写掩码同 normal（RGB），键多 |a2c；对象 alpha 不参与", () => {
    expect(writeRows(alignLayer(0, "A", { passes: [writePass("objects/0/passes/0", 0, a2c)] }))).toEqual([
      ["direct scene false a2c", "0|alphatocoverage|rgba8unorm|false|a2c"],
    ]);
  });

  it("带 effect（p8-misc W2）：基础 pass 画进合成 RT（混合 null）不开、写 RGBA；借了基础材质混合的上屏 pass 开", () => {
    const layer = alignLayer(0, "W2", {
      passes: [writePass("objects/0/passes/0", 0, a2c)],
      effects: [depEffect(0, 0, "kbcopy")],
    });
    expect(writeRows(layer)).toEqual([
      ["base composite true", "0|null|rgba8unorm|true"],
      ["final scene false a2c", "1|alphatocoverage|rgba8unorm|false|a2c"],
    ]);
    // effect 自己的中间 pass 是 alphatocoverage 时同样开（画进 fbo，写 RGBA）
    const fx = alignLayer(0, "F", { passes: [writePass("objects/0/passes/0", 0)], effects: [fboEffect(0, a2c)] });
    expect(writeRows(fx).map(([row]) => row)).toEqual([
      "base composite true",
      "effect fbo true a2c",
      "final scene false",
    ]);
  });

  it("passthrough 上屏借基础材质的混合：开；组的 alpha MAX 与 A2C 并存", () => {
    expect(writeRows(depLayer(0, "A", { passes: [writePass("objects/0/passes/0", 0, a2c)] }))).toEqual([
      ["base composite true", "0|null|rgba8unorm|true"],
      ["passthrough scene false a2c", "2|alphatocoverage|rgba8unorm|false|a2c"],
    ]);
    const child = alignLayer(1, "C", { parent: 0, group: 0, passes: [writePass("objects/1/passes/0", 0, a2c)] });
    expect(writeRows(child, { copyBackground: false })).toEqual([
      ["direct scene true a2c", "0|alphatocoverage|rgba8unorm|true|max|a2c"],
    ]);
  });

  it("粒子、网格、文本同一套：A2C 看步骤的混合，alpha 看材质的 alphawriting；都没有时键与改前相同", () => {
    const particleStep = (pass: ScenePass) => {
      const particle = { passes: [pass], renderers: [{ kind: "sprite" }], flags: 0, children: [] };
      return planParticleLayer({ particle: particle as unknown as SceneLayer["particle"] }).steps[0];
    };
    const meshStep = (pass: ScenePass) => {
      const model = { path: "m.mdl", version: 23, meshes: [{ passes: [pass] }], order: [0], bounds: [] };
      return planModelLayer({ model: model as unknown as SceneLayer["model"] }).steps[0];
    };
    const key = "objects/0/passes/0";
    const particle = (extra: Partial<ScenePass>) => pipelineKey(specOf(particleStep(alignPass(key, 0, extra))));
    expect(particle({})).toBe("0|translucent|rgba8unorm|false|list");
    expect(particle(a2c)).toBe("0|alphatocoverage|rgba8unorm|false|list|a2c");
    expect(particle({ alphaWriting: "enabled" })).toBe("0|translucent|rgba8unorm|true|list");
    const mesh = (extra: Partial<ScenePass>) => pipelineKey(specOf(meshStep(alignPass(key, 0, extra)), null, "20:0@0"));
    expect(mesh({})).toBe("0|translucent|rgba8unorm|false|list|mesh:20:0@0");
    expect(mesh(a2c)).toBe("0|alphatocoverage|rgba8unorm|false|list|mesh:20:0@0|a2c");
    expect(mesh({ alphaWriting: "enabled" })).toBe("0|translucent|rgba8unorm|true|list|mesh:20:0@0");
    // 文本：WPE 的文本材质没有 alphawriting，规则照样适用（直接上屏不写、画进合成 RT 写）
    const text = (space: TextStep["space"], extra: Partial<ScenePass> = {}): TextStep => {
      const pass = alignPass(key, 0, extra);
      return {
        kind: "text",
        part: "glyphs",
        pass,
        space,
        target: space === "direct" ? { kind: "scene" } : { kind: "composite", index: 0 },
        inputs: {},
        blending: "translucent",
        raster: rasterState(pass, pass, "translucent"),
      };
    };
    expect(pipelineKey(specOf(text("direct")))).toBe("0|translucent|rgba8unorm|false|list");
    expect(pipelineKey(specOf(text("composite")))).toBe("0|translucent|rgba8unorm|true|list");
    expect(pipelineKey(specOf(text("direct", { alphaWriting: "enabled" })))).toBe("0|translucent|rgba8unorm|true|list");
    expect(pipelineKey(specOf(text("composite", { alphaWriting: "disabled" })))).toBe(
      "0|translucent|rgba8unorm|false|list",
    );
    // 没有这两项的步骤：规格里没有 alphaToCoverage 这个键
    expect("alphaToCoverage" in specOf(particleStep(alignPass(key, 0)))).toBe(false);
    expect("alphaToCoverage" in specOf(text("direct"))).toBe(false);
  });
});

/**
 * 翻译器的片元 WGSL（`ignore/p8/s5/dump-entry.txt`：`p8-a2c` 的 genericimage4，naga GLSL 前端生成的入口与返回结构）。主体 `main_1` 里的
 * `return;` 不是入口的，不改。按行写出，naga 在属性行末留的空格（`@fragment `）照原样保留。
 */
const A2C_FRAGMENT = [
  "struct FragmentOutput {",
  "    @location(0) kb_FragColor: vec4<f32>,",
  "}",
  "",
  "@group(0) @binding(1) ",
  "var g_Texture0_: texture_2d<f32>;",
  "@group(0) @binding(2) ",
  "var kb_sampler_g_Texture0_: sampler;",
  "var<private> v_TexCoord_1: vec2<f32>;",
  "var<private> kb_FragColor: vec4<f32>;",
  "",
  "fn main_1() {",
  "    var color_10: vec4<f32>;",
  "",
  "    let _e18 = v_TexCoord_1;",
  "    let _e20 = textureSample(g_Texture0_, kb_sampler_g_Texture0_, _e18.xy);",
  "    color_10 = _e20;",
  "    let _e24 = color_10;",
  "    kb_FragColor = _e24;",
  "    return;",
  "}",
  "",
  "@fragment ",
  "fn main(@location(0) v_TexCoord: vec2<f32>) -> FragmentOutput {",
  "    v_TexCoord_1 = v_TexCoord;",
  "    main_1();",
  "    let _e25 = kb_FragColor;",
  "    return FragmentOutput(_e25);",
  "}",
  "",
].join("\n");

describe("alphaToCoverageEntry（P8 步骤 5 点 4，p8-REPORT 结论 11）", () => {
  it("导出的真实入口：原文不动，追加逐字副本 kb_a2c_main，return 换成「alpha 不大于 0.5 就 discard」", () => {
    const { code, entryPoint } = alphaToCoverageEntry(A2C_FRAGMENT, "main");
    expect(entryPoint).toBe("kb_a2c_main");
    expect(code.slice(0, A2C_FRAGMENT.length)).toBe(A2C_FRAGMENT);
    expect(code.slice(A2C_FRAGMENT.length)).toBe(
      [
        "",
        "@fragment ",
        "fn kb_a2c_main(@location(0) v_TexCoord: vec2<f32>) -> FragmentOutput {",
        "    v_TexCoord_1 = v_TexCoord;",
        "    main_1();",
        "    let _e25 = kb_FragColor;",
        "    { let kb_a2c_out = FragmentOutput(_e25); if !(kb_a2c_out.kb_FragColor.a > 0.5) { discard; } return kb_a2c_out; }",
        "}",
        "",
      ].join("\n"),
    );
  });

  it("直接返回 @location(0) vec4<f32>：判断返回值自己的 .a", () => {
    const wgsl =
      "@fragment\nfn fs(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {\n    return vec4<f32>(uv, 0.0, 0.25);\n}\n";
    const { code, entryPoint } = alphaToCoverageEntry(wgsl, "fs");
    expect(entryPoint).toBe("kb_a2c_fs");
    expect(code).toBe(
      `${wgsl}\n@fragment\nfn kb_a2c_fs(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {\n` +
        "    { let kb_a2c_out = vec4<f32>(uv, 0.0, 0.25); if !(kb_a2c_out.a > 0.5) { discard; } return kb_a2c_out; }\n}\n",
    );
  });

  it("多个 return 各自改写；结构里跳过 @builtin、取 @location(0) 的成员；参数的 IO 属性照抄", () => {
    const wgsl = [
      "struct Out {",
      "    @builtin(frag_depth) depth: f32,",
      "    @location(0) color: vec4<f32>,",
      "}",
      "@fragment @early_depth_test(force)",
      "fn main(@builtin(position) p: vec4<f32>, @location(1) @interpolate(flat) id: u32) -> Out {",
      "    if (id == 0u) {",
      "        return Out(0.5, vec4<f32>(1.0, 0.0, 0.0, 1.0));",
      "    }",
      "    return Out(p.z, vec4<f32>(p.xy, 0.0, f(p, id)));",
      "}",
      "",
    ].join("\n");
    const { code } = alphaToCoverageEntry(wgsl, "main");
    const added = code.slice(wgsl.length);
    expect(added).toBe(
      [
        "",
        "@fragment @early_depth_test(force)",
        "fn kb_a2c_main(@builtin(position) p: vec4<f32>, @location(1) @interpolate(flat) id: u32) -> Out {",
        "    if (id == 0u) {",
        "        { let kb_a2c_out = Out(0.5, vec4<f32>(1.0, 0.0, 0.0, 1.0)); if !(kb_a2c_out.color.a > 0.5) { discard; } return kb_a2c_out; }",
        "    }",
        "    { let kb_a2c_out = Out(p.z, vec4<f32>(p.xy, 0.0, f(p, id))); if !(kb_a2c_out.color.a > 0.5) { discard; } return kb_a2c_out; }",
        "}",
        "",
      ].join("\n"),
    );
  });

  it("认不出就抛错：找不到入口、只有顶点入口、结构里没有位置 0、位置 0 不是 vec4、已有 kb_a2c_ 名字、return 不带值", () => {
    expect(() => alphaToCoverageEntry(A2C_FRAGMENT, "other")).toThrow(/找不到片元入口/);
    expect(() => alphaToCoverageEntry(A2C_FRAGMENT.replace("@fragment", "@vertex"), "main")).toThrow(/找不到片元入口/);
    expect(() =>
      alphaToCoverageEntry(A2C_FRAGMENT.replace("@location(0) kb_FragColor", "@location(1) kb_FragColor"), "main"),
    ).toThrow(/没有位置 0/);
    expect(() =>
      alphaToCoverageEntry(
        A2C_FRAGMENT.replace("@location(0) kb_FragColor", "@builtin(frag_depth) kb_FragColor"),
        "main",
      ),
    ).toThrow(/没有位置 0/);
    expect(() =>
      alphaToCoverageEntry("@fragment\nfn main() -> @location(0) vec3<f32> {\n    return vec3<f32>(1.0);\n}\n", "main"),
    ).toThrow(/不是位置 0 的 vec4/);
    expect(() => alphaToCoverageEntry(`${A2C_FRAGMENT}var<private> kb_a2c_x: f32;\n`, "main")).toThrow(/kb_a2c_/);
    // 改写两次（第二次源码里已经有 kb_a2c_main）
    expect(() => alphaToCoverageEntry(alphaToCoverageEntry(A2C_FRAGMENT, "main").code, "main")).toThrow(/kb_a2c_/);
    expect(() =>
      alphaToCoverageEntry("@fragment\nfn main() -> @location(0) vec4<f32> {\n    return;\n}\n", "main"),
    ).toThrow(/没有值/);
  });
});

/** A2C 用的程序：绑定同 `depProgram`（槽 0），片元换成翻译器的真实形状（`A2C_FRAGMENT`）。 */
function a2cProgram(name: string): TranslateResult {
  return { ...depProgram(name, [0]), fragment: { wgsl: A2C_FRAGMENT, entryPoint: "main" } };
}
/** 在 `DepGpu` 上换两个方法：记下着色器模块（标签、源码）与管线描述；源码含 `errorIn` 时 Tint 报一条 error（第 3 行）。 */
function a2cGpu(errorIn?: string) {
  const gpu = new DepGpu();
  const modules: { label: string; code: string }[] = [];
  const pipelines: GPURenderPipelineDescriptor[] = [];
  Object.assign(gpu.device, {
    createShaderModule: (descriptor: GPUShaderModuleDescriptor) => {
      const failed = errorIn !== undefined && descriptor.code.includes(errorIn);
      const module = {
        label: descriptor.label ?? "",
        code: descriptor.code,
        getCompilationInfo: async () => ({
          messages: failed ? [{ type: "error", lineNum: 3, linePos: 1, message: "bad a2c" }] : [],
        }),
      };
      modules.push(module);
      return module;
    },
    createRenderPipelineAsync: async (descriptor: GPURenderPipelineDescriptor) => {
      pipelines.push(descriptor);
      return { label: descriptor.label };
    },
  });
  return { gpu, modules, pipelines };
}
/** 0 D（A2C 直接上屏）、1 E（A2C 带 kbcopy，程序 1 上屏）、2 W（translucent + enabled）、3 DW（A2C + enabled）、4 N（什么都没有）。 */
function a2cLayers(): SceneLayer[] {
  const pass = (object: number, extra: Partial<ScenePass> = {}) => writePass(`objects/${object}/passes/0`, 0, extra);
  const a2c = { blending: "alphatocoverage" };
  return [
    alignLayer(0, "D", { passes: [pass(0, a2c)] }),
    alignLayer(1, "E", { passes: [pass(1, a2c)], effects: [depEffect(1, 0, "kbcopy")] }),
    alignLayer(2, "W", { passes: [pass(2, { alphaWriting: "enabled" })] }),
    alignLayer(3, "DW", { passes: [pass(3, { ...a2c, alphaWriting: "enabled" })] }),
    alignLayer(4, "N", { passes: [pass(4)] }),
  ];
}
function a2cBundle(layers: SceneLayer[], programs: TranslateResult[] = [a2cProgram("image"), a2cProgram("effect")]) {
  return { ...align2Bundle(), layers, programs, textures: DEP_TEXTURES };
}
async function openA2c(bundle: SceneBundle, errorIn?: string, warnings: string[] = []) {
  const { gpu, modules, pipelines } = a2cGpu(errorIn);
  const state = SceneState.fromBundle(bundle);
  const scene = await GpuScene.build(gpu.device, bundle, state, new Set(), warnings, { particles: { seed: 1 } });
  scene.update(ALIGN_FRAME, state);
  return { gpu, scene, state, modules, pipelines };
}
const moduleLabel = (module: GPUShaderModule) => (module as unknown as { label: string }).label;

describe("GpuScene：A2C 管线与写掩码（P8 步骤 5 点 3、点 4）", () => {
  beforeEach(() => {
    vi.stubGlobal("GPUTextureUsage", { RENDER_ATTACHMENT: 1, TEXTURE_BINDING: 2, COPY_SRC: 4, COPY_DST: 8 });
    vi.stubGlobal("GPUBufferUsage", { VERTEX: 1, UNIFORM: 2, COPY_DST: 4, MAP_READ: 8, INDEX: 16 });
    vi.stubGlobal("GPUMapMode", { READ: 1 });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("管线键：A2C 的步骤多 |a2c，基础 pass 画进合成 RT 不带；enabled 的直接上屏写 alpha；其余键与改前相同", async () => {
    const { scene } = await openA2c(a2cBundle(a2cLayers()));
    expect([...(scene as unknown as { pipelines: Map<string, unknown> }).pipelines.keys()].sort()).toEqual(
      [
        "0|alphatocoverage|rgba8unorm|false|a2c",
        "0|null|rgba8unorm|true",
        "1|alphatocoverage|rgba8unorm|false|a2c",
        "0|translucent|rgba8unorm|true",
        "0|alphatocoverage|rgba8unorm|true|a2c",
        "0|translucent|rgba8unorm|false",
      ].sort(),
    );
  });

  it("A2C 模块按程序建一次（两条 A2C 管线共用），代码是前言 + 原片元 + 新入口；A2C 管线用它与 kb_a2c_main，别的管线照旧", async () => {
    const { modules, pipelines, gpu, scene, state } = await openA2c(a2cBundle(a2cLayers()));
    expect(modules.map((module) => module.label).sort()).toEqual(
      [
        "scene program 0 vertex",
        "scene program 0 fragment",
        "scene program 0 fragment a2c",
        "scene program 1 vertex",
        "scene program 1 fragment",
        "scene program 1 fragment a2c",
      ].sort(),
    );
    const a2cCode = WGSL_PRELUDE + alphaToCoverageEntry(A2C_FRAGMENT, "main").code;
    for (const module of modules.filter((item) => item.label.endsWith(" a2c"))) expect(module.code).toBe(a2cCode);
    expect(modules.find((module) => module.label === "scene program 0 fragment")!.code).toBe(
      WGSL_PRELUDE + A2C_FRAGMENT,
    );
    const byLabel = (label: string) => {
      const found = pipelines.filter((descriptor) => descriptor.label === label);
      expect(found, label).toHaveLength(1);
      const { fragment } = found[0];
      return {
        module: moduleLabel(fragment!.module),
        entryPoint: fragment!.entryPoint,
        target: [...fragment!.targets][0],
      };
    };
    // 程序 0 的两条 A2C 管线（D 写 RGB、DW 写 RGBA；标签不含写掩码）：A2C 模块与入口、关混合，用同一个模块对象
    const dw = pipelines.filter((descriptor) => descriptor.label === "scene program 0 alphatocoverage rgba8unorm a2c");
    expect(
      dw
        .map((descriptor) => ({
          module: moduleLabel(descriptor.fragment!.module),
          entryPoint: descriptor.fragment!.entryPoint,
          target: [...descriptor.fragment!.targets][0],
        }))
        .sort((a, b) => a.target!.writeMask! - b.target!.writeMask!),
    ).toEqual(
      [0x7, 0xf].map((writeMask) => ({
        module: "scene program 0 fragment a2c",
        entryPoint: "kb_a2c_main",
        target: { format: "rgba8unorm", blend: undefined, writeMask },
      })),
    );
    expect(dw[0].fragment!.module).toBe(dw[1].fragment!.module);
    expect(byLabel("scene program 1 alphatocoverage rgba8unorm a2c")).toMatchObject({
      module: "scene program 1 fragment a2c",
      entryPoint: "kb_a2c_main",
    });
    // 基础 pass 画进合成 RT：原模块、原入口、关混合、写 RGBA
    expect(byLabel("scene program 0 opaque rgba8unorm")).toEqual({
      module: "scene program 0 fragment",
      entryPoint: "main",
      target: { format: "rgba8unorm", blend: undefined, writeMask: 0xf },
    });
    const translucent = pipelines.filter((descriptor) => descriptor.label === "scene program 0 translucent rgba8unorm");
    expect(
      translucent.map((descriptor) => [
        moduleLabel(descriptor.fragment!.module),
        descriptor.fragment!.entryPoint,
        [...descriptor.fragment!.targets][0]!.writeMask,
      ]),
    ).toEqual(
      expect.arrayContaining([
        ["scene program 0 fragment", "main", 0x7],
        ["scene program 0 fragment", "main", 0xf],
      ]),
    );
    // 编码一帧：A2C 的绘制照常画
    gpu.trace.length = 0;
    scene.encode(gpu.device.createCommandEncoder(), state);
    expect(gpu.trace).toEqual(expect.arrayContaining(["  draw layer 10 D direct", "  draw layer 11 E final"]));
  });

  it("没有 A2C 的场景一次都不建 A2C 模块，管线描述与标签没有 a2c", async () => {
    const [, , w, , n] = a2cLayers();
    const { modules, pipelines } = await openA2c(a2cBundle([w, n]));
    expect(modules.some((module) => module.label.includes("a2c"))).toBe(false);
    for (const descriptor of pipelines) {
      expect(descriptor.label).not.toContain("a2c");
      expect(descriptor.fragment!.entryPoint).toBe("main");
    }
  });

  it("改写认不出：整张退回 render:program:<下标>:a2c，原因细节进 warnings；Tint 报 error：webgpu:shader:<下标>:fragment-a2c:…", async () => {
    const [d] = a2cLayers();
    const bad = { ...a2cProgram("image"), fragment: { wgsl: "// image f", entryPoint: "main" } };
    const warnings: string[] = [];
    await expect(openA2c(a2cBundle([d], [bad, a2cProgram("effect")]), undefined, warnings)).rejects.toMatchObject({
      reasons: ["render:program:0:a2c"],
    });
    expect(warnings.some((warning) => warning.includes("A2C 入口改写失败"))).toBe(true);
    const error = await openA2c(a2cBundle([d]), "kb_a2c_").catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(SceneRenderError);
    expect((error as SceneRenderError).reasons).toEqual(["webgpu:shader:0:fragment-a2c:2:bad a2c"]);
  });
});
