/**
 * P5d 步骤 1 的渲染侧单测（`.claude/plans/wpe-import/3-scene/phase5/phase-5d-camera-depth.md`「步骤 1」点 2–5），依据是 p5-REPORT
 * 「P5d 语义的实测核对」与步骤 0 的抓帧读数（`ignore/p5/d0/out/ana_depth.txt`、`ana_cull.txt`，工程由 `ignore/p5/d0/gen_d.py` 生成）：
 * - `rasterState`：`p5d-depth` 12 组（含组 4 的 C）每次绘制的深度与剔除状态逐个对上（材质 JSON → `normalizeDepthKeys` → 计划里的步骤）；
 *   上屏角色借基础 pass 的深度、剔除用自己（`p5d-depth-o` 的 L2、`p5d-cull` 的 C4 / C5），passthrough、无 effect 组的上屏同样；形状层
 *   两项都取自己；
 * - 绕序：图层四边形（直接上屏 / 末 pass、画进合成 RT 的 `fill`、组的局部正交）、全屏 / NDC 四边形、形状、粒子四角在各自的矩阵下投影后
 *   是逆时针（正面）；`scale` x 取负、挂在镜像父层下、绕 y 转 180° 后是顺时针（被剔）；
 * - 管线：`stepPipeline` 的 `cull` 推广到所有步骤，`depth` 只在场景有深度附件、画进场景目标、不在组里时出现，`pipelineKey` 只在出现时加
 *   后缀；`wantsDepth` 的判定；
 * - `GpuScene`（假设备，模拟 WebGPU「管线的深度格式要和 render pass 一致」的校验）：没有测深度步骤的场景不建深度、管线键与 render pass
 *   和改前逐字相同；有的场景建 `depth32float`、场景 pass 带深度附件（第一个清 0、之后 load，`clearenabled: false` 时不清）、组与合成 RT
 *   的 pass 不带、管线的 `depthStencil` 对上；只在预建变体里测深度的图层同样建深度。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generalDefaults } from "../compile/bindings";
import { FRAMEBUFFER_RT, type SceneBundle, type SceneEffect, type SceneLayer, type ScenePass } from "../compile/bundle";
import { normalizeDepthKeys } from "../compile/features";
import type { MaterialPass } from "../compile/model";
import { particleFov, type SceneParticle } from "../compile/particles";
import { BLOOM_DEFAULTS } from "../compile/postprocess";
import { CORNER_UVS, QUAD_INDICES } from "../particles/vertices";
import type { TranslateResult } from "../wpesl2wgsl";
import {
  planLayer,
  planModelLayer,
  planParticleLayer,
  planShapeLayer,
  rasterState,
  type DrawStep,
  type LayerStep,
  type RasterState,
} from "./graph";
import {
  groupViewProjection,
  layerLocalMatrix,
  layerQuad,
  particleViewProjection,
  sceneViewProjection,
  shapeQuad,
  worldMatrixOf,
  type LayerTransform,
} from "./layout";
import { identity, multiply, orthographic, transformPoint, type Mat4 } from "./math";
import { GpuScene, pipelineKey, stepPipeline, wantsDepth } from "./scene";
import { SceneState } from "./state";
import { drawMatrices, type FrameInput } from "./uniforms";

vi.mock("./device", () => ({ acquireGpu: vi.fn() }));
vi.mock("../fileUrl", () => ({ fileToUrl: (path: string) => path }));

// ———— 手写的图层 ————

/** 程序下标：composelayer、effect（tint 一类）、图像、组的上屏（effectpassthrough）、passthrough 混合上屏、粒子、网格。 */
const PROGRAM = { compose: 0, effect: 1, image: 2, upload: 3, passthrough: 4 } as const;

/** 编译期的 pass：材质 JSON 的三个键照 `compilePass` 规整（`normalizeDepthKeys`），混合缺键为 normal。 */
function compiled(key: string, material: Partial<MaterialPass> = {}, extra: Partial<ScenePass> = {}): ScenePass {
  return {
    key,
    program: PROGRAM.image,
    blending: material.blending ?? "normal",
    ...normalizeDepthKeys(material),
    textures: {},
    runtime: {},
    uniforms: {},
    framebuffer: false,
    ...extra,
  };
}
/** 编辑器写出的图像材质：translucent、nocull、两个深度键 disabled（语料里能渲染的正交场景几乎都是这样）。 */
const EDITOR: Partial<MaterialPass> = {
  blending: "translucent",
  cullmode: "nocull",
  depthtest: "disabled",
  depthwrite: "disabled",
};
/** WPE 的 `effects/tint` 材质（`assets/effects/tint/materials/effects/tint.json`）：normal、深度 disabled、nocull。 */
const TINT: Partial<MaterialPass> = {
  blending: "normal",
  cullmode: "nocull",
  depthtest: "disabled",
  depthwrite: "disabled",
};

function effectOf(object: number, material: Partial<MaterialPass>, extra: Partial<SceneEffect> = {}): SceneEffect {
  return {
    source: 0,
    id: 50,
    name: "fx",
    file: "effects/fx/effect.json",
    fbos: [],
    steps: [
      {
        kind: "draw",
        pass: compiled(`objects/${object}/effects/0/passes/0`, material, { program: PROGRAM.effect }),
        target: null,
        compose: false,
        binds: null,
      },
    ],
    enabled: true,
    visibleBound: false,
    unsupported: [],
    ...extra,
  };
}

function layerOf(object: number, extra: Partial<SceneLayer> = {}): SceneLayer {
  return {
    id: object + 10,
    object,
    parent: null,
    name: `L${object}`,
    origin: [960, 540, 0],
    scale: [1, 1, 1],
    angles: [0, 0, 0],
    size: [100, 100],
    alpha: 1,
    color: [1, 1, 1],
    brightness: 1,
    visible: true,
    visibleBound: false,
    parallaxDepth: [1, 1],
    solidLayer: true,
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
    passes: [compiled(`objects/${object}/passes/0`, EDITOR)],
    colorBlendMode: 0,
    effects: [],
    passthrough: null,
    particle: null,
    ...extra,
  };
}
/** 图像层：基础材质 `material`，`effects` 是 effect 材质（各一个绘制 pass）。 */
function image(object: number, material: Partial<MaterialPass>, effects: Partial<MaterialPass>[] = []): SceneLayer {
  return layerOf(object, {
    passes: [compiled(`objects/${object}/passes/0`, material)],
    effects: effects.map((item) => effectOf(object, item)),
  });
}
/** 组（带子层的组合层）：基础材质是 composelayer（WPE 的 `composelayer.json`：深度 disabled、nocull），上屏是 effectpassthrough。 */
function group(object: number, subtree: number[], base: Partial<MaterialPass> = EDITOR): SceneLayer {
  return layerOf(object, {
    passthroughModel: true,
    subtree,
    passes: [
      compiled(`objects/${object}/passes/0`, base, {
        program: PROGRAM.compose,
        runtime: { 0: FRAMEBUFFER_RT },
        framebuffer: true,
      }),
    ],
    groupUpload: compiled(
      `objects/${object}/groupupload`,
      { blending: "normal", cullmode: "nocull", depthtest: "disabled", depthwrite: "disabled" },
      { program: PROGRAM.upload },
    ),
  });
}
const child = (object: number, parent: number, material: Partial<MaterialPass>): SceneLayer => ({
  ...image(object, material),
  parent,
  group: parent,
  origin: [0, 0, 0],
});

const draws = (steps: LayerStep[]) => steps.filter((step): step is DrawStep => step.kind === "draw");
const rasterOf = (step: { raster: RasterState }) => step.raster;
const R = (test: boolean, write: boolean, cull: boolean): RasterState => ({ test, write, cull });

// ———— rasterState ————

/** `p5d-depth` 一个方片的材质（`gen_d.py` 的 `color_mat` / `particle_mat`）、对象种类与 WPE 抓帧里那次绘制的状态。 */
interface DepthCase {
  name: string;
  kind: "model" | "image" | "particle";
  material: Partial<MaterialPass>;
  /** `ana_depth.txt` 的绘制号与状态：测 / 写 / 剔背面（WPE 不测时 DepthEnable 关，写掩码不起作用，记为不写）。 */
  wpe: [event: string, raster: RasterState];
}
const color = (extra: Partial<MaterialPass> = {}, cull: string | null = "nocull"): Partial<MaterialPass> => ({
  shader: "kbcolor",
  blending: "normal",
  ...(cull === null ? {} : { cullmode: cull }),
  ...extra,
});
const particleMaterial = (extra: Partial<MaterialPass>, cull: string | null = "nocull"): Partial<MaterialPass> => ({
  shader: "genericparticle",
  blending: "additive",
  ...(cull === null ? {} : { cullmode: cull }),
  ...extra,
});
const DEPTH_CASES: DepthCase[] = [
  { name: "0A 缺键", kind: "model", material: color({}, null), wpe: ["#2", R(true, true, true)] },
  { name: "0B 缺键", kind: "model", material: color({}, null), wpe: ["#3", R(true, true, true)] },
  {
    name: "1A depthwrite disabled",
    kind: "model",
    material: color({ depthwrite: "disabled" }),
    wpe: ["#4", R(true, false, false)],
  },
  { name: "1B", kind: "model", material: color(), wpe: ["#5", R(true, true, false)] },
  {
    name: "2A translucent + depthwrite enabled",
    kind: "model",
    material: color({ blending: "translucent", depthwrite: "enabled" }),
    wpe: ["#6", R(true, false, false)],
  },
  { name: "2B", kind: "model", material: color(), wpe: ["#7", R(true, true, false)] },
  {
    name: "3A alphatocoverage",
    kind: "model",
    material: color({ blending: "alphatocoverage" }),
    wpe: ["#8", R(true, true, false)],
  },
  { name: "3B", kind: "model", material: color(), wpe: ["#9", R(true, true, false)] },
  { name: "4A", kind: "model", material: color(), wpe: ["#10", R(true, true, false)] },
  {
    name: "4B depthtest disabled + depthwrite enabled",
    kind: "model",
    material: color({ depthtest: "disabled", depthwrite: "enabled" }),
    wpe: ["#11", R(false, false, false)],
  },
  { name: "4C", kind: "model", material: color(), wpe: ["#12", R(true, true, false)] },
  { name: "5A 共面", kind: "model", material: color(), wpe: ["#13", R(true, true, false)] },
  { name: "5B 共面", kind: "model", material: color(), wpe: ["#14", R(true, true, false)] },
  {
    name: '6A depthtest "yes"',
    kind: "model",
    material: color({ depthtest: "yes", depthwrite: "enabled" }),
    wpe: ["#15", R(false, false, false)],
  },
  { name: '6B cullmode "back"', kind: "model", material: color({}, "back"), wpe: ["#16", R(true, true, true)] },
  { name: "7A", kind: "model", material: color(), wpe: ["#17", R(true, true, false)] },
  {
    name: "7B 图像层 translucent、depthtest enabled",
    kind: "image",
    material: color({ blending: "translucent", depthtest: "enabled", depthwrite: "disabled" }),
    wpe: ["#18", R(true, false, false)],
  },
  {
    name: "8A 图像层 normal、测 / 写",
    kind: "image",
    material: color({ depthtest: "enabled", depthwrite: "enabled" }),
    wpe: ["#19", R(true, true, false)],
  },
  { name: "8B", kind: "model", material: color(), wpe: ["#20", R(true, true, false)] },
  { name: "9A", kind: "model", material: color(), wpe: ["#21", R(true, true, false)] },
  {
    name: "9B 粒子 additive、depthtest enabled",
    kind: "particle",
    material: particleMaterial({ depthtest: "enabled", depthwrite: "disabled" }),
    wpe: ["#22", R(true, false, false)],
  },
  { name: "10A", kind: "model", material: color(), wpe: ["#23", R(true, true, false)] },
  {
    name: "10B 粒子缺 depthtest 与 cullmode（demon_core）",
    kind: "particle",
    material: particleMaterial({ depthwrite: "disabled" }, null),
    wpe: ["#24", R(true, false, true)],
  },
  { name: "11A", kind: "model", material: color(), wpe: ["#25", R(true, true, false)] },
  { name: "11B 图像层缺全部深度键", kind: "image", material: color({}, null), wpe: ["#26", R(true, true, true)] },
];

/** 按对象种类把一个 pass 排进计划，取它的绘制步骤（图像层直接上屏、网格、粒子）。 */
function stepOf(kind: DepthCase["kind"], pass: ScenePass): { raster: RasterState } {
  if (kind === "image") return draws(planLayer(layerOf(0, { passes: [pass] }), []).steps)[0];
  if (kind === "model") {
    const model = { path: "m.mdl", version: 23, meshes: [{ passes: [pass] }], order: [0], bounds: [] };
    return planModelLayer({ model: model as unknown as SceneLayer["model"] }).steps[0] as { raster: RasterState };
  }
  const particle = { passes: [pass], renderers: [{ kind: "sprite" }], flags: 0, children: [] };
  return planParticleLayer({ particle: particle as unknown as SceneParticle }).steps[0] as { raster: RasterState };
}

describe("rasterState：p5d-depth 每次绘制的深度与剔除（ana_depth.txt）", () => {
  it.each(DEPTH_CASES)("$name（WPE $wpe.0）", ({ kind, material, wpe: [, expected] }) => {
    expect(rasterOf(stepOf(kind, compiled("objects/0/passes/0", material)))).toEqual(expected);
  });

  it("规则表：测 = depthtest 不是 disabled；写 = 测 ∧ depthwrite 不是 disabled ∧ 混合 ∈ {normal, alphatocoverage}；null 混合按 normal", () => {
    const on = { depthtest: "enabled", depthwrite: "enabled", cullmode: "normal" };
    for (const blending of ["normal", "alphatocoverage", null])
      expect(rasterState(on, on, blending)).toEqual(R(true, true, true));
    for (const blending of ["translucent", "additive"])
      expect(rasterState(on, on, blending)).toEqual(R(true, false, true));
    expect(rasterState({ ...on, depthtest: "disabled" }, on, "normal")).toEqual(R(false, false, true));
    expect(rasterState({ ...on, depthwrite: "disabled" }, on, "normal")).toEqual(R(true, false, true));
    // 深度与剔除各看各的 pass
    expect(rasterState(on, { cullmode: "nocull" }, "normal")).toEqual(R(true, true, false));
    expect(rasterState({ depthtest: "disabled", depthwrite: "disabled" }, on, "normal")).toEqual(R(false, false, true));
  });
});

describe("rasterState：上屏角色借基础 pass 的深度、剔除用自己", () => {
  it("p5d-depth-o 的 L2（translucent、depthtest enabled 的图层带 tint）：基础 pass 画进合成 RT，末 pass 测、不写、不剔", () => {
    const layer = image(
      2,
      { blending: "translucent", depthtest: "enabled", depthwrite: "disabled", cullmode: "nocull" },
      [TINT],
    );
    const [base, final] = draws(planLayer(layer, []).steps);
    expect([base.role, base.target.kind, final.role, final.target.kind]).toEqual([
      "base",
      "composite",
      "final",
      "scene",
    ]);
    // tint 自己的深度是 disabled，末 pass 照样测：借的是基础材质的键
    expect(final.raster).toEqual(R(true, false, false));
    expect(final.blending).toBe("translucent");
  });

  it("p5d-cull 的 C4 / C5（剔背面的图层带 tint）：基础 pass 剔背面（ana_cull #6 / #8 Back），末 pass 用 tint 的 nocull（#7 / #9 NoCull）", () => {
    const layer = image(
      4,
      { blending: "translucent", cullmode: "normal", depthtest: "disabled", depthwrite: "disabled" },
      [TINT],
    );
    const [base, final] = draws(planLayer(layer, []).steps);
    expect(base.raster).toEqual(R(false, false, true));
    expect(final.raster).toEqual(R(false, false, false));
  });

  it("末 pass：深度与写入看基础材质和借来的混合（cbm 31 改 additive 后不写），剔除看 effect 材质", () => {
    const fx = { blending: "normal", cullmode: "normal", depthtest: "disabled", depthwrite: "disabled" };
    const layer = image(1, { blending: "normal" }, [fx]);
    expect(draws(planLayer(layer, []).steps).at(-1)!.raster).toEqual(R(true, true, true));
    const additive = { ...layer, colorBlendMode: 31 };
    expect(draws(planLayer(additive, []).steps).at(-1)!.raster).toEqual(R(true, false, true));
    // 不经过上屏的 effect 中间 pass：两项都是自己的
    const two = image(1, { blending: "normal" }, [fx, TINT]);
    const [, middle, final] = draws(planLayer(two, []).steps);
    expect([middle.role, middle.raster]).toEqual(["effect", R(false, false, true)]);
    expect([final.role, final.raster]).toEqual(["final", R(true, true, false)]);
  });

  it("passthrough 上屏（colorBlendMode 混合）：深度借基础 pass，剔除用 passthrough 材质", () => {
    const layer = {
      ...image(1, { blending: "normal", cullmode: "nocull" }),
      colorBlendMode: 12,
      passthrough: compiled("objects/1/passthrough", { blending: "normal" }, { program: PROGRAM.passthrough }),
    };
    const upload = draws(planLayer(layer, []).steps).at(-1)!;
    expect(upload.role).toBe("passthrough");
    expect(upload.raster).toEqual(R(true, true, true));
  });

  it("无 effect 组的上屏：深度借组的基础 pass（composelayer），剔除用 effectpassthrough", () => {
    const upload = (base: Partial<MaterialPass>) =>
      draws(planLayer(group(1, [2], base), []).steps).find((step) => step.role === "final")!;
    expect(upload(EDITOR).raster).toEqual(R(false, false, false));
    // 假想的会测深度的组合层材质：上屏照样测（混合是 effectpassthrough 的 normal，所以也写）
    expect(upload({ ...EDITOR, depthtest: "enabled", depthwrite: "enabled" }).raster).toEqual(R(true, true, false));
  });

  it("形状层（P8）没有基础 pass：两项都取自己的 pass，混合强制 additive 所以只测不写", () => {
    const shape = layerOf(1, {
      passes: [],
      effects: [effectOf(1, { blending: "normal", cullmode: "normal" })],
      shape: { points: null },
    });
    const [step] = draws(planShapeLayer(shape).steps);
    expect(step.raster).toEqual(R(true, false, true));
  });
});

// ———— 绕序 ————

/**
 * 三角形在 NDC（y 向上）里的有向面积：正为逆时针。WebGPU 的 `frontFace: "ccw"` 与 D3D11 的 `FrontCounterClockwise`（WPE）指的都是这个
 * 朝向，P5c 的 `p5c-cull` 已在真机上和 WPE 对上。
 */
function ndcArea(mvp: Mat4, a: readonly number[], b: readonly number[], c: readonly number[]): number {
  const [ax, ay, , aw] = transformPoint(mvp, a[0], a[1], a[2] ?? 0);
  const [bx, by, , bw] = transformPoint(mvp, b[0], b[1], b[2] ?? 0);
  const [cx, cy, , cw] = transformPoint(mvp, c[0], c[1], c[2] ?? 0);
  const [x0, y0, x1, y1, x2, y2] = [ax / aw, ay / aw, bx / bw, by / bw, cx / cw, cy / cw];
  return (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
}
/** 三角形带的三角形（第 i 个奇数三角形是 (v[i+1], v[i], v[i+2])，各 API 相同）。 */
function stripTriangles<T>(vertices: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i + 2 < vertices.length; i++)
    out.push(i % 2 ? [vertices[i + 1], vertices[i], vertices[i + 2]] : [vertices[i], vertices[i + 1], vertices[i + 2]]);
  return out;
}
/** 每个三角形的朝向：`"ccw"` 正面、`"cw"` 背面。 */
const windings = (mvp: Mat4, triangles: (readonly number[])[][]) =>
  triangles.map(([a, b, c]) => (ndcArea(mvp, a, b, c) > 0 ? "ccw" : "cw"));
const quadWindings = (mvp: Mat4, quad: { position: readonly number[] }[]) =>
  windings(mvp, stripTriangles(quad.map((vertex) => vertex.position)));

const GENERAL = { width: 1920, height: 1080, perspectiveOverrideFov: particleFov(undefined) };
const VP = sceneViewProjection(GENERAL);
const CCW = ["ccw", "ccw"];
const CW = ["cw", "cw"];
/** 一个图层的世界矩阵（`layers` 里按 `objects` 下标查父链）。 */
function worldOf(object: number, layers: Record<number, Partial<LayerTransform>>): Mat4 {
  const map = new Map<number, LayerTransform>(
    Object.entries(layers).map(([key, value]) => [
      Number(key),
      { origin: [0, 0, 0], angles: [0, 0, 0], scale: [1, 1, 1], visible: true, parent: null, ...value },
    ]),
  );
  return worldMatrixOf(object, map, new Map());
}

describe("绕序：未镜像时投影后逆时针（正面），镜像后顺时针（p5d-cull）", () => {
  const quad = layerQuad([150, 150], [1, 1]);

  it("图层四边形（直接上屏、末 pass、passthrough、compose：场景视图投影 · W）：C0 正面；C1 自身 x 镜像、C2 挂在镜像父层下、C3 绕 y 转 180° 都是背面", () => {
    const mvp = (world: Mat4) => drawMatrices({ role: "direct" }, world, [150, 150], VP).modelViewProjection;
    expect(quadWindings(mvp(worldOf(0, { 0: { origin: [300, 800, 0] } })), quad)).toEqual(CCW);
    expect(quadWindings(mvp(worldOf(0, { 0: { origin: [600, 800, 0], scale: [-1, 1, 1] } })), quad)).toEqual(CW);
    const mirroredParent = worldOf(1, { 0: { origin: [900, 800, 0], scale: [-1, 1, 1] }, 1: { parent: 0 } });
    expect(quadWindings(mvp(mirroredParent), quad)).toEqual(CW);
    expect(quadWindings(mvp(worldOf(0, { 0: { origin: [1200, 800, 0], angles: [0, Math.PI, 0] } })), quad)).toEqual(CW);
    // 上屏的几个角色用同一个 MVP
    for (const role of ["final", "passthrough", "compose"] as const)
      expect(
        quadWindings(
          drawMatrices(
            { role },
            layerLocalMatrix({ origin: [1500, 800, 0], angles: [0, 0, 0], scale: [-1, 1, 1] }),
            [150, 150],
            VP,
          ).modelViewProjection,
          quad,
        ),
      ).toEqual(CW);
  });

  it("画进合成 RT 的基础 pass（fill）：不经过图层的世界矩阵，镜像的图层也是正面（p5d-cull C4 的基础 pass 剔背面照常画）", () => {
    const mirrored = layerLocalMatrix({ origin: [1500, 800, 0], angles: [0, 0, 0], scale: [-1, 1, 1] });
    const { modelViewProjection } = drawMatrices({ role: "base" }, mirrored, [150, 150], VP);
    expect(quadWindings(modelViewProjection, quad)).toEqual(CCW);
  });

  it("全屏 / NDC 四边形：effect 中间 pass（单位阵）与 fullscreen 图层的上屏（NDC 正交 `ortho(−1, 1, −1, 1, −1, 1)`）都是正面", () => {
    const ndc = layerQuad([2, 2], [1, 1]);
    expect(quadWindings(drawMatrices({ role: "effect" }, identity(), [2, 2], VP).modelViewProjection, ndc)).toEqual(
      CCW,
    );
    const fullscreen = orthographic(-1, 1, -1, 1, 1, -1);
    expect(
      quadWindings(drawMatrices({ role: "final" }, identity(), [2, 2], fullscreen).modelViewProjection, ndc),
    ).toEqual(CCW);
  });

  it("组的局部正交（组里的子层画进组的合成 RT）：子层相对组未镜像是正面，相对组镜像是背面；组自身镜像不影响组里的朝向", () => {
    for (const groupScale of [1, -1]) {
      const layers = {
        0: { origin: [960, 540, 0], scale: [groupScale, 1, 1], angles: [0, 0, 0.2] },
        1: { origin: [-120, 0, 0], parent: 0 },
        2: { origin: [60, 40, 0], parent: 0, scale: [-1, 1, 1] },
      };
      const vp = groupViewProjection([800, 400], worldOf(0, layers));
      expect(quadWindings(multiply(vp, worldOf(1, layers)), quad), `组 scale ${groupScale}`).toEqual(CCW);
      expect(quadWindings(multiply(vp, worldOf(2, layers)), quad), `组 scale ${groupScale}`).toEqual(CW);
    }
  });

  it("形状（P8，带的顺序 [p1, p0, p2, p3]）：p8-shape 的点是正面，镜像后是背面", () => {
    const points: [number, number][] = [
      [0.2456, 0.09457],
      [0.85704, 0.06238],
      [0.9469, 0.66185],
      [0.07415, 0.95],
    ];
    const shape = shapeQuad([1080, 1080], points);
    const world = (sx: number) => layerLocalMatrix({ origin: [480, 540, 0], angles: [0, 0, 0], scale: [sx, 1, 1] });
    expect(quadWindings(multiply(VP, world(1)), shape)).toEqual(CCW);
    expect(quadWindings(multiply(VP, world(-1)), shape)).toEqual(CW);
  });

  it("粒子四角（`CORNER_UVS` + `QUAD_INDICES`，位置照 `genericparticle.vert` 的 `ComputeParticlePosition`）：正交与透视粒子都是正面，系统镜像后是背面", () => {
    // right = (1, 0, 0)、up = (0, 1, 0)（没有旋转）、size 1、textureRatio 1：p + right·(u − 0.5) − up·(v − 0.5)
    const corners = CORNER_UVS.map(([u, v]) => [u - 0.5, -(v - 0.5), 0]);
    const triangles = [0, 3].map((i) => QUAD_INDICES.slice(i, i + 3).map((index) => corners[index]));
    const world = (sx: number) =>
      layerLocalMatrix({ origin: [300, 400, 0], angles: [0, 0, 0], scale: [150 * sx, 150, 1] });
    expect(windings(multiply(VP, world(1)), triangles)).toEqual(CCW);
    expect(windings(multiply(VP, world(-1)), triangles)).toEqual(CW);
    const perspective = particleViewProjection(GENERAL);
    expect(windings(multiply(perspective, world(1)), triangles)).toEqual(CCW);
    expect(windings(multiply(perspective, world(-1)), triangles)).toEqual(CW);
  });

  it("粒子四角和 WPE 的几何着色器（`genericparticle.geom`：带 (0,0)、(0,1)、(1,0)、(1,1)）在任意 right / up 下朝向相同（旋转、拖尾的切向）", () => {
    // 拖尾的 right = cross(视线, 速度)、up ∥ 速度，朝向随速度变；两条路径对同一组 right / up 必须同号，剔除才和 WPE 一致
    const position = (right: number[], up: number[], [u, v]: readonly number[]) =>
      [0, 1, 2].map((i) => right[i] * (u - 0.5) - up[i] * (v - 0.5));
    const ours = (right: number[], up: number[]) =>
      [0, 3].map((i) => QUAD_INDICES.slice(i, i + 3).map((index) => position(right, up, CORNER_UVS[index])));
    const wpe = (right: number[], up: number[]) =>
      stripTriangles(
        [
          [0, 0],
          [0, 1],
          [1, 0],
          [1, 1],
        ].map((uv) => position(right, up, uv)),
      );
    const bases: [number[], number[]][] = [
      [
        [1, 0, 0],
        [0, 1, 0],
      ],
      [
        [0.3, 0.8, 0.1],
        [-0.9, 0.2, 0.4],
      ],
      [
        [0.6, -0.7, 0.2],
        [0.5, 0.4, -0.3],
      ],
      [
        [-1, 0, 0],
        [0, 1, 0],
      ],
    ];
    const mvp = multiply(VP, layerLocalMatrix({ origin: [960, 540, 0], angles: [0, 0, 0], scale: [100, 100, 100] }));
    for (const [right, up] of bases) {
      const expected = windings(mvp, wpe(right, up));
      expect(new Set(expected).size, `${right} / ${up}`).toBe(1);
      expect(windings(mvp, ours(right, up)), `${right} / ${up}`).toEqual(expected);
    }
  });
});

// ———— 管线 ————

describe("stepPipeline / pipelineKey / wantsDepth（P5d 步骤 1 点 3、点 4）", () => {
  const fbo = () => "rgba8unorm" as const;
  const testing = image(1, { blending: "normal" });
  const plain = image(0, EDITOR);

  it("没有深度附件：编辑器材质的键与改前逐字相同；剔除推广到图像层（`|cull:back`）", () => {
    const [direct] = draws(planLayer(plain, []).steps);
    expect(pipelineKey(stepPipeline(direct, "rgba8unorm", fbo))).toBe(`${PROGRAM.image}|translucent|rgba8unorm|false`);
    const [cull] = draws(planLayer(testing, []).steps);
    const spec = stepPipeline(cull, "rgba8unorm", fbo);
    expect(spec).toEqual({
      program: PROGRAM.image,
      blending: "normal",
      format: "rgba8unorm",
      alpha: false,
      topology: "triangle-strip",
      cull: "back",
    });
    expect(pipelineKey(spec)).toBe(`${PROGRAM.image}|normal|rgba8unorm|false|cull:back`);
  });

  it("有深度附件：画进场景目标的步骤带深度（测 t、写 w），不测的 `--`；画进合成 RT、组里的步骤不带", () => {
    const [direct] = draws(planLayer(testing, []).steps);
    expect(stepPipeline(direct, "rgba8unorm", fbo, false, null, undefined, true).depth).toEqual({
      test: true,
      write: true,
    });
    expect(pipelineKey(stepPipeline(direct, "rgba8unorm", fbo, false, null, undefined, true))).toBe(
      `${PROGRAM.image}|normal|rgba8unorm|false|cull:back|depth:tw`,
    );
    const [none] = draws(planLayer(plain, []).steps);
    expect(pipelineKey(stepPipeline(none, "rgba8unorm", fbo, false, null, undefined, true))).toBe(
      `${PROGRAM.image}|translucent|rgba8unorm|false|depth:--`,
    );
    const [base, final] = draws(
      planLayer(image(2, { blending: "translucent", depthtest: "enabled" }, [TINT]), []).steps,
    );
    expect(stepPipeline(base, "rgba8unorm", fbo, false, null, undefined, true).depth).toBeUndefined();
    expect(pipelineKey(stepPipeline(final, "rgba8unorm", fbo, false, null, undefined, true))).toBe(
      `${PROGRAM.effect}|translucent|rgba8unorm|false|depth:t-`,
    );
    // 组里画到「场景」的（落在组的合成 RT 上）：剔除照常，没有深度
    const inGroup = stepPipeline(direct, "rgba8unorm", fbo, false, { copyBackground: true }, undefined, true);
    expect(inGroup.depth).toBeUndefined();
    expect(inGroup.cull).toBe("back");
  });

  it("wantsDepth：有画进场景目标、不在组里且测深度的步骤才要；组的子孙、只画进合成 RT 的不算；按全部计划取并集", () => {
    const entry = (layer: SceneLayer) => ({ layer, plans: [planLayer(layer, [])] });
    expect(wantsDepth([entry(plain)])).toBe(false);
    expect(wantsDepth([entry(plain), entry(testing)])).toBe(true);
    // 组的子孙测深度：画进组的合成 RT，不要
    expect(wantsDepth([entry(group(1, [2])), entry(child(2, 1, { blending: "normal" }))])).toBe(false);
    // 测深度的基础 pass 只画进合成 RT、上屏借来的深度也测：要（上屏测）；基础材质不测：不要（effect 自己测也不算）
    const fxTest = { ...TINT, depthtest: "enabled" };
    expect(wantsDepth([entry(image(1, EDITOR, [fxTest]))])).toBe(false);
    expect(wantsDepth([entry(image(1, { ...EDITOR, depthtest: "enabled" }, [TINT]))])).toBe(true);
    // 当前计划是空的组合层，打开 effect 后上屏测深度：只有算上变体才要
    const variable = layerOf(3, {
      passthroughModel: true,
      passes: [compiled("objects/3/passes/0", { ...EDITOR, depthtest: "enabled" }, { program: PROGRAM.compose })],
      effects: [effectOf(3, TINT, { enabled: false, visibleBound: true })],
    });
    const current = planLayer(variable, []);
    expect(current.steps).toEqual([]);
    expect(wantsDepth([{ layer: variable, plans: [current] }])).toBe(false);
    expect(wantsDepth([{ layer: variable, plans: [planLayer(variable, [], () => true)] }])).toBe(true);
  });
});

// ———— GpuScene：假设备 ————

interface FakeTexture {
  label: string;
  format: string;
  usage: number;
  size: GPUExtent3DDict;
  destroy(): void;
}
interface FakeView {
  label: string;
  texture: FakeTexture;
}
interface FakePipeline {
  label: string;
  descriptor: GPURenderPipelineDescriptor;
}

/**
 * 假设备：记建的纹理、管线描述与一帧的 render pass，并模拟 WebGPU 对深度的校验（不符就抛错）：管线有没有 `depthStencil`、格式是什么，要和
 * 当前 render pass 的深度附件一致；深度附件要有 RENDER_ATTACHMENT、尺寸同颜色附件。
 */
class FakeGpu {
  readonly trace: string[] = [];
  readonly textures: FakeTexture[] = [];
  readonly pipelines: FakePipeline[] = [];
  readonly passes: GPURenderPassDescriptor[] = [];
  readonly device: GPUDevice;

  constructor() {
    const trace = this.trace;
    const fail = (message: string): never => {
      throw new Error(`WebGPU 校验：${message}`);
    };
    const renderPass = (label: string, depth: FakeTexture | null) => ({
      setViewport() {},
      setPipeline(pipeline: FakePipeline) {
        const stencil = pipeline.descriptor.depthStencil;
        if (!!stencil !== !!depth || (stencil && stencil.format !== depth!.format))
          fail(
            `管线 ${pipeline.label} 的深度（${stencil?.format ?? "无"}）和 pass ${label} 的（${depth?.format ?? "无"}）不符`,
          );
        trace.push(`  pipeline ${pipeline.label}`);
      },
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
      createTexture: (descriptor: GPUTextureDescriptor) => {
        const texture: FakeTexture = {
          label: descriptor.label ?? "",
          format: descriptor.format,
          usage: descriptor.usage,
          size: descriptor.size as GPUExtent3DDict,
          destroy() {},
        };
        this.textures.push(texture);
        return { ...texture, createView: (): FakeView => ({ label: texture.label, texture }) };
      },
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
      createRenderPipelineAsync: async (descriptor: GPURenderPipelineDescriptor) => {
        const pipeline = { label: descriptor.label ?? "", descriptor };
        this.pipelines.push(pipeline);
        return pipeline;
      },
      createBindGroup: () => ({}),
      createCommandEncoder: () => ({
        beginRenderPass: (descriptor: GPURenderPassDescriptor) => {
          this.passes.push(descriptor);
          const color = [...descriptor.colorAttachments][0]!;
          const view = color.view as unknown as FakeView;
          const depth = descriptor.depthStencilAttachment;
          const depthView = depth ? (depth.view as unknown as FakeView) : null;
          if (depthView) {
            if (!(depthView.texture.usage & GPUTextureUsage.RENDER_ATTACHMENT)) fail("深度附件没有 RENDER_ATTACHMENT");
            const a = depthView.texture.size,
              b = view.texture.size;
            if (a.width !== b.width || a.height !== b.height) fail("深度附件尺寸和颜色附件不同");
          }
          const depthText = depth
            ? ` | depth ${depth.depthLoadOp}${depth.depthLoadOp === "clear" ? ` ${depth.depthClearValue}` : ""} ${depth.depthStoreOp}`
            : "";
          trace.push(`pass ${view.label} ${color.loadOp}${depthText}`);
          return renderPass(view.label, depthView?.texture ?? null);
        },
        copyTextureToTexture: (source: { texture: FakeTexture }, target: { texture: FakeTexture }) => {
          trace.push(`copy ${source.texture.label} -> ${target.texture.label}`);
        },
        copyTextureToBuffer() {},
        finish: () => ({}),
      }),
      queue: {
        writeBuffer() {},
        writeTexture() {},
        submit() {},
        onSubmittedWorkDone: async () => {},
      },
      pushErrorScope() {},
      popErrorScope: async () => null,
    } as unknown as GPUDevice;
  }

  encode(scene: GpuScene, state: SceneState): string[] {
    this.trace.length = 0;
    this.passes.length = 0;
    scene.encode(this.device.createCommandEncoder(), state);
    return [...this.trace];
  }
}

/** 一个程序：MVP（偏移 0），声明 `slots` 这些纹理槽。 */
function program(name: string, slots: number[]): TranslateResult {
  return {
    ok: true,
    vertex: { wgsl: `// ${name} v`, entryPoint: "main" },
    fragment: { wgsl: `// ${name} f`, entryPoint: "main" },
    attributes: [
      { name: "a_Position", type: "vec3", location: 0 },
      { name: "a_TexCoord", type: "vec2", location: 1 },
    ],
    uniforms: [{ name: "g_ModelViewProjectionMatrix", type: "mat4x4<f32>", declared: "mat4", offset: 0, size: 64 }],
    uniformBlockSize: 64,
    textures: slots.map((slot) => ({ slot, binding: 1 + 2 * slot, samplerBinding: 2 + 2 * slot, kind: "2d" })),
  } as unknown as TranslateResult;
}

function bundleOf(layers: SceneLayer[]): SceneBundle {
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
    layers,
    programs: [
      program("composelayer", [0]),
      program("effect", [0]),
      program("image", [0]),
      program("effectpassthrough", [0]),
      program("passthrough", [0, 1]),
    ],
    textures: [],
    bloom: null,
    unsupported: [],
    bindings: [],
    scripts: { list: [] },
  };
}

const FRAME: FrameInput = {
  time: 1,
  frametime: 0.05,
  daytime: 0.5,
  pointer: [0.5, 0.5],
  pointerLast: [0.5, 0.5],
  cursor: [0.5, 0.5],
};

async function open(layers: SceneLayer[], setup: (bundle: SceneBundle) => void = () => {}) {
  const gpu = new FakeGpu();
  const bundle = bundleOf(layers);
  setup(bundle);
  const state = SceneState.fromBundle(bundle);
  const scene = await GpuScene.build(gpu.device, bundle, state, new Set(), [], { particles: { seed: 1 } });
  scene.update(FRAME, state);
  return { gpu, scene, state };
}
/** 场景目标的深度附件（`GpuScene.createDepthTarget` 的标签）。 */
const sceneDepths = (gpu: FakeGpu) => gpu.textures.filter((texture) => texture.label === "scene depth");
const pipelineKeys = (scene: GpuScene) =>
  [...(scene as unknown as { pipelines: Map<string, unknown> }).pipelines.keys()].sort();

/**
 * 没有测深度的场景（语料里能渲染的正交场景几乎都是这样）：0 背景、1 剔背面但不测深度的图层、2 带 tint 的图层、3 组（子层 4 测深度，但画进组的
 * 合成 RT）。
 */
const flatLayers = () => [
  image(0, EDITOR),
  image(1, { ...EDITOR, cullmode: "normal" }),
  image(2, EDITOR, [TINT]),
  group(3, [4]),
  child(4, 3, { blending: "normal" }),
];
/**
 * 测深度的场景：0 背景（不测）、1 缺深度键的 normal 图层（测、写、剔背面）、2 translucent 只测、3 带 tint 且基础材质测深度（末 pass 借来测、
 * 不写）、4 组（子层 5 测深度）、6 顶层（不测）。
 */
const depthLayers = () => [
  image(0, EDITOR),
  image(1, { blending: "normal" }),
  image(2, { ...EDITOR, depthtest: "enabled" }),
  image(3, { ...EDITOR, depthtest: "enabled" }, [TINT]),
  group(4, [5]),
  child(5, 4, { blending: "normal" }),
  image(6, EDITOR),
];

beforeEach(() => {
  vi.stubGlobal("GPUTextureUsage", { RENDER_ATTACHMENT: 1, TEXTURE_BINDING: 2, COPY_SRC: 4, COPY_DST: 8 });
  vi.stubGlobal("GPUBufferUsage", { VERTEX: 1, UNIFORM: 2, COPY_DST: 4, MAP_READ: 8, INDEX: 16 });
  vi.stubGlobal("GPUMapMode", { READ: 1 });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("GpuScene：没有测深度的步骤时不建深度，管线与 render pass 和改前逐字相同（P5d 步骤 1 点 4）", () => {
  it("不建深度纹理；管线键没有深度后缀、描述里没有 depthStencil；render pass 没有深度附件", async () => {
    const { gpu, scene, state } = await open(flatLayers());
    // 占位纹理里本来有一张 `dummy depth`（比较采样器的槽），这里只看场景目标的深度附件
    expect(sceneDepths(gpu)).toEqual([]);
    // 改前的键（组里测深度的子层 4 照旧只有组里的写 alpha，层 1 的剔除是 P5d 步骤 1 推广的，不是深度）
    expect(pipelineKeys(scene)).toEqual(
      [
        `${PROGRAM.image}|translucent|rgba8unorm|false`,
        `${PROGRAM.image}|translucent|rgba8unorm|false|cull:back`,
        `${PROGRAM.image}|null|rgba8unorm|true`,
        `${PROGRAM.effect}|translucent|rgba8unorm|false`,
        `${PROGRAM.compose}|null|rgba8unorm|true`,
        `${PROGRAM.upload}|normal|rgba8unorm|false`,
        `${PROGRAM.image}|normal|rgba8unorm|true|cull:back`,
      ].sort(),
    );
    for (const { descriptor } of gpu.pipelines) expect("depthStencil" in descriptor, descriptor.label).toBe(false);
    gpu.encode(scene, state);
    expect(gpu.passes.length).toBeGreaterThan(0);
    for (const pass of gpu.passes) expect("depthStencilAttachment" in pass).toBe(false);
    // 场景 pass 的描述与改前同形：只有标签与一个颜色附件，附件的四项同序
    const [first] = gpu.passes;
    expect(Object.keys(first)).toEqual(["label", "colorAttachments"]);
    expect(Object.keys([...first.colorAttachments][0]!)).toEqual(["view", "clearValue", "loadOp", "storeOp"]);
  });
});

describe("GpuScene：有测深度的步骤时建深度附件（P5d 步骤 1 点 3、点 4）", () => {
  it("深度纹理：场景目标尺寸、depth32float、只作附件，计进显存估算（多 1920 × 1080 × 4 字节）", async () => {
    const { gpu, scene } = await open(depthLayers());
    const depth = sceneDepths(gpu);
    expect(depth).toHaveLength(1);
    expect(depth[0]).toMatchObject({ format: "depth32float", usage: GPUTextureUsage.RENDER_ATTACHMENT });
    expect(depth[0].size).toEqual({ width: 1920, height: 1080 });
    // 同一组图层、深度全关：少的正好是深度纹理
    const flat = depthLayers().map((layer) => ({
      ...layer,
      passes: layer.passes.map((pass) => ({ ...pass, depthtest: "disabled" })),
    }));
    const { scene: without } = await open(flat);
    expect(scene.targetBytes - without.targetBytes).toBe(1920 * 1080 * 4);
  });

  it("管线：画进场景目标的都带 depthStencil（测 greater、不测 always，写看 raster.write），合成 RT 与组里的不带", async () => {
    const { gpu, scene } = await open(depthLayers());
    expect(pipelineKeys(scene)).toEqual(
      [
        `${PROGRAM.image}|translucent|rgba8unorm|false|depth:--`,
        `${PROGRAM.image}|normal|rgba8unorm|false|cull:back|depth:tw`,
        `${PROGRAM.image}|translucent|rgba8unorm|false|depth:t-`,
        `${PROGRAM.image}|null|rgba8unorm|true`,
        `${PROGRAM.effect}|translucent|rgba8unorm|false|depth:t-`,
        `${PROGRAM.compose}|null|rgba8unorm|true`,
        `${PROGRAM.upload}|normal|rgba8unorm|false|depth:--`,
        `${PROGRAM.image}|normal|rgba8unorm|true|cull:back`,
      ].sort(),
    );
    const stencilOf = (label: string) => gpu.pipelines.find((item) => item.label === label)?.descriptor.depthStencil;
    expect(stencilOf("scene program 2 normal rgba8unorm cull depth:tw")).toEqual({
      format: "depth32float",
      depthCompare: "greater",
      depthWriteEnabled: true,
    });
    expect(stencilOf("scene program 2 translucent rgba8unorm depth:t-")).toEqual({
      format: "depth32float",
      depthCompare: "greater",
      depthWriteEnabled: false,
    });
    expect(stencilOf("scene program 2 translucent rgba8unorm depth:--")).toEqual({
      format: "depth32float",
      depthCompare: "always",
      depthWriteEnabled: false,
    });
    expect(stencilOf("scene program 1 translucent rgba8unorm depth:t-")).toMatchObject({ depthCompare: "greater" });
    expect(stencilOf("scene program 2 opaque rgba8unorm")).toBeUndefined();
    expect(stencilOf("scene program 2 normal rgba8unorm cull")).toBeUndefined();
    expect(
      gpu.pipelines.find((item) => item.label === "scene program 2 normal rgba8unorm cull depth:tw")!.descriptor
        .primitive,
    ).toEqual({
      topology: "triangle-strip",
      cullMode: "back",
      frontFace: "ccw",
    });
  });

  it("编码：第一个场景 pass 颜色与深度一起清（深度清 0），之后的场景 pass 都 load；合成 RT 与组的 pass 不带深度（假设备校验管线与 pass 一致）", async () => {
    const { gpu, scene, state } = await open(depthLayers());
    const passes = gpu.encode(scene, state).filter((line) => line.startsWith("pass") || line.startsWith("copy"));
    expect(passes).toEqual([
      "pass scene target clear | depth clear 0 store",
      // 层 3 的基础 pass 画进合成 RT，末 pass 回到场景
      "pass composite 100x100|true|false #0 load",
      "pass scene target load | depth load store",
      // 组：拍快照、compose 画进组的合成 RT，子层画进同一张（组的 pass），之后上屏回到场景
      "copy scene target -> _rt_FullFrameBuffer",
      "pass composite 100x100|true|false #0 load",
      "pass composite 100x100|true|false #0 load",
      "pass scene target load | depth load store",
    ]);
    // 组的 pass 的标签是 "group"
    expect(gpu.passes.map((pass) => pass.label)).toEqual([
      "scene",
      "layer 13 L3 base",
      "scene",
      "layer 14 L4 compose",
      "group",
      "scene",
    ]);
  });

  it("clearenabled false：颜色与深度都不清（p5d-noclear），整帧都是 load", async () => {
    const { gpu, scene, state } = await open(depthLayers(), (bundle) => (bundle.general.fields.clearenabled = false));
    const passes = gpu.encode(scene, state).filter((line) => line.startsWith("pass scene"));
    expect(passes).toEqual([
      "pass scene target load | depth load store",
      "pass scene target load | depth load store",
      "pass scene target load | depth load store",
    ]);
  });

  it("全部图层不可见、只清屏的分支：同样清深度", async () => {
    const { gpu, scene, state } = await open(depthLayers());
    for (const layer of state.layers.values()) layer.visible = false;
    expect(gpu.encode(scene, state)).toEqual(["pass scene target clear | depth clear 0 store"]);
  });

  it("只在预建变体里测深度（组合层的 effect 当前关着，计划为空）：照样建深度，变体的上屏管线带深度", async () => {
    const variable = layerOf(1, {
      passthroughModel: true,
      passes: [
        compiled(
          "objects/1/passes/0",
          { ...EDITOR, depthtest: "enabled" },
          {
            program: PROGRAM.compose,
            runtime: { 0: FRAMEBUFFER_RT },
            framebuffer: true,
          },
        ),
      ],
      effects: [effectOf(1, TINT, { enabled: false, visibleBound: true })],
    });
    const { gpu, scene, state } = await open([image(0, EDITOR), variable]);
    expect(sceneDepths(gpu)).toHaveLength(1);
    expect(pipelineKeys(scene)).toContain(`${PROGRAM.effect}|translucent|rgba8unorm|false|depth:t-`);
    // 当前这帧：只有背景画进场景，带深度附件、清 0
    expect(gpu.encode(scene, state).filter((line) => line.startsWith("pass"))).toEqual([
      "pass scene target clear | depth clear 0 store",
    ]);
    // 运行中打开 effect：当场换上预建的计划，上屏画回带深度附件的场景 pass（假设备校验管线的深度和 pass 一致）
    state.write({ property: "p", target: { kind: "effect", object: 1, effect: 0 } }, true);
    scene.sync(state);
    scene.update(FRAME, state);
    expect(gpu.encode(scene, state).filter((line) => !line.startsWith("  pipeline scene program 2"))).toEqual([
      "pass scene target clear | depth clear 0 store",
      "copy scene target -> _rt_FullFrameBuffer",
      "pass composite 100x100|true|false #0 load",
      "  pipeline scene program 0 opaque rgba8unorm",
      "pass scene target load | depth load store",
      "  pipeline scene program 1 translucent rgba8unorm depth:t-",
    ]);
  });
});
