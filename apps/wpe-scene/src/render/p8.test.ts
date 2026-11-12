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
 */
import { describe, expect, it, vi } from "vitest";
import type { SceneEffect, SceneEffectStep, SceneLayer, ScenePass, SceneTexture } from "../compile/bundle";
import { TEX_FLAGS } from "../compile/tex";
import { compositeSampling, planLayer, planShapeLayer, variantPlans, type DrawStep } from "./graph";
import { layerLocalMatrix, layerQuad, sceneViewProjection, shapeQuad } from "./layout";
import { identity, scaling, transformPoint, type Mat4 } from "./math";
import { buildableLayers } from "./scene";
import { drawMatrices, drawUniformValues } from "./uniforms";

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
