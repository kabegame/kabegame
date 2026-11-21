/**
 * P5b 步骤 4 的渲染侧单测（`.claude/plans/wpe-import/3-scene/phase5/phase-5b-modelflags.md`「步骤 4」）：带子层的组合层（组）。
 * - 渲染图（`planLayer`）：基础 pass（compose / clear）之后紧跟 `subtree`；有 effect 照旧往下，没有时用 `groupUpload` 上屏（混合按
 *   `copyBackground`）；
 * - 矩阵（`groupViewProjection` + `drawMatrices`）：子层在组里的 MVP、组上屏、嵌套、组里的本地 / 世界空间粒子、视差只作用在组本身，
 *   和 WPE 抓帧比；
 * - GpuScene 假设备：顶层不画子孙、子树画进组的合成 RT、alpha MAX 与写掩码、嵌套组的合成 RT 池分开、组隐藏时整棵不画、组变换后子孙
 *   的 uniform 跟着重写。假设备模拟 WebGPU 会拒绝的情况（拷贝的用途位与 pass 内拷贝、render pass 嵌套、在已结束的 pass 上画、
 *   管线格式与目标不符、同一张纹理在一个 pass 里既是目标又被采样），任何一条都抛错。
 *
 * 工程（`ignore/p5/b0/gen_b.py`，正交 1920×1080）：
 * - `p5b-grp-*`（`p_grp`）：背景之后一个 composelayer GRP，origin (960, 540)、size 800×400、angles z 0.2，下挂子层 R (−120, 0) 300×300
 *   红 α0.5、B (60, 40) 300×300 蓝 α0.5、Y (380, 180) 200×200 黄；之后顶层 TOP (200, 900) 100×100。`cb1` 挂 kbfx，`cb0` 再加
 *   `copybackground: false`，`nofx` / `nofx0` 不挂 effect，`par` 是 cb1 加视差（amount 0.5，视差点 (960, 540)），组原点 (1260, 640)、
 *   R 的深度 2 2。
 * - `p5b-nest`（`p_nest`）：外组 O (960, 540) 1200×600 挂 kbfx，里面先是绿方块 S (100, 0) 200×200，再是内组 I (100, 0) 300×300 挂 kbfx，
 *   I 里蓝方块 T (−60, −60) 100×100。
 * - `p5b-grpptc`（`p_grpptc`）：组 GRP 同 `p5b-grp`、挂 kbfx，里面带 kbfx 的子层 C (−200, 0) 200×200、本地粒子系统 pl (150, 50)、
 *   世界空间系统 pw (250, −80)。
 *
 * 真值是 WPE 抓帧（`ignore/p5/b4/grp_fixture.json`，`fixture_grp.py` 从 RenderDoc 逐 action 取出；像素值与粒子四角是 MCP 补读的，
 * 见同目录 `grp_fixture_notes.md`）。MVP 是 16 个 float32、列主序（第 12、13 个是平移，和 `Mat4` 同一约定）。比 x、y 两行、平移与
 * z 项（下标 0、1、4、5、10、12、13、14：组里的局部正交 z 是 1/2000、深度 0.5，和我们的约定一致）。期望的绝对值 ≥ 1e-6 时比相对误差
 * < 1e-5；更小的（0 与 WPE 的 float32 噪声，如事件 78 平移 y 的 −1.5e-7）比绝对误差 < 1e-6。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generalDefaults } from "../compile/bindings";
import { FRAMEBUFFER_RT, type SceneBundle, type SceneEffect, type SceneLayer, type ScenePass } from "../compile/bundle";
import { childLocalMatrix, parseParticle, particleFov } from "../compile/particles";
import { BLOOM_DEFAULTS } from "../compile/postprocess";
import type { TranslateResult } from "../wpesl2wgsl";
import { planLayer, planSignature, variantPlans, type DrawStep, type LayerPlan, type LayerStep } from "./graph";
import { groupMvpParts, groupViewProjection, sceneViewProjection, worldMatrixOf } from "./layout";
import { mulAffine, multiply, transformPoint, translation, type Mat4 } from "./math";
import { parallaxOffset } from "./parallax";
import type { ParticleSystem } from "../particles/system";
import { uniformInverse } from "./inverseF32";
import { GpuScene, pipelineKey, stepPipeline } from "./scene";
import { SceneState } from "./state";
import { drawMatrices, type FrameInput } from "./uniforms";

vi.mock("./device", () => ({ acquireGpu: vi.fn() }));
vi.mock("../fileUrl", () => ({ fileToUrl: (path: string) => path }));

// ———— WPE 真值 ————

/** 组的 MVP（场景视图投影 · W_组）：`p5b-grp-cb1` 事件 62（compose）/ 125（上屏），cb0 事件 120、nofx 事件 125、nofx0 事件 120 同值。 */
const GROUP_MVP = [
  0.001020902767777443, 0.00036790614831261337, 0, 0, -0.00020694722479674965, 0.0018149381503462791, 0, 0, 0, 0,
  0.0002500000118743628, 0, 0, 0, 0.5, 1,
];
/** 组里 800×400 的局部正交（x、y、z 三项，平移另给）。 */
const local800 = (x: number, y: number) => [
  0.0024999999441206455,
  0,
  0,
  0,
  0,
  0.004999999888241291,
  0,
  0,
  0,
  0,
  0.0005000000237487257,
  0,
  x,
  y,
  0.5,
  1,
];
const WPE_MVP = {
  /** `p5b-grp-cb1` 事件 78 / 92 / 106：R、B、Y 画进组的合成 RT（cb0 事件 73 / 87 / 101 同值）。 */
  cb1R: local800(-0.29999998211860657, -1.5258788721439487e-7),
  cb1B: local800(0.14999999105930328, 0.1999998390674591),
  cb1Y: local800(0.949999988079071, 0.9000001549720764),
  group: GROUP_MVP,
  /** `p5b-grp-par` 事件 62 / 125：组的基础 pass 与上屏带视差偏移 (150, 50)。 */
  parGroup: [...GROUP_MVP.slice(0, 12), 0.46875011920928955, 0.2777777910232544, 0.5, 1],
  /** `p5b-grp-par` 事件 78 / 92 / 106：子层在组里不带视差（R 的深度 2 2 也一样）。 */
  parR: local800(-0.29999998211860657, 0),
  parB: local800(0.14999999105930328, 0.19999998807907104),
  parY: local800(0.9500002861022949, 0.900000274181366),
  /** `p5b-nest` 事件 62：外组 O 的基础 pass（合成 RT 1200×600），事件 148 外组上屏同值。 */
  nestO: [0.0010416667209938169, 0, 0, 0, 0, 0.0018518518190830946, 0, 0, 0, 0, 0.0002500000118743628, 0, 0, 0, 0.5, 1],
  /** `p5b-nest` 事件 78：S 画进外组的合成 RT（1200×600 的局部正交，本地 (100, 0)）；事件 129 内组 I 上屏画进外组同值。 */
  nestS: [
    0.0016666667070239782, 0, 0, 0, 0, 0.0033333334140479565, 0, 0, 0, 0, 0.0005000000237487257, 0, 0.1666666716337204,
    0, 0.5, 1,
  ],
  /** `p5b-nest` 事件 94：内组 I 的基础 pass 用场景视图投影 · W_I（世界 (1060, 540)），合成 RT 300×300。 */
  nestI: [
    0.0010416667209938169, 0, 0, 0, 0, 0.0018518518190830946, 0, 0, 0, 0, 0.0002500000118743628, 0, 0.10416674613952637,
    0, 0.5, 1,
  ],
  /** `p5b-nest` 事件 110：T 画进内组的合成 RT（300×300 的局部正交，本地 (−60, −60)）。 */
  nestT: [
    0.006666666828095913, 0, 0, 0, 0, 0.006666666828095913, 0, 0, 0, 0, 0.0005000000237487257, 0, -0.4000000059604645,
    -0.4000000059604645, 0.5, 1,
  ],
  /** `p5b-grpptc` 事件 102：带 kbfx 的子层 C 的末 pass 画进组的合成 RT（本地 (−200, 0)）。 */
  ptcC: local800(-0.5, -1.5258788721439487e-7),
} as const;

/** 比较的下标：x、y 两行、z 项与平移。 */
const COMPARED = [0, 1, 4, 5, 10, 12, 13, 14];
/** 期望的绝对值小于它时比绝对误差（0 与 float32 噪声）。 */
const TINY = 1e-6;

/** 比较元素里的最大相对误差与最大绝对误差（后者只算期望很小的元素）。 */
function matrixErrors(actual: ArrayLike<number>, expected: readonly number[]) {
  let relative = 0,
    absolute = 0;
  for (const i of COMPARED) {
    const diff = Math.abs(actual[i] - expected[i]);
    if (Math.abs(expected[i]) < TINY) absolute = Math.max(absolute, diff);
    else relative = Math.max(relative, diff / Math.abs(expected[i]));
  }
  return { relative, absolute };
}
/** 全部比较的最大误差（汇报用，`afterAll` 打印）。 */
const worst = { relative: 0, absolute: 0 };
function expectMvp(actual: ArrayLike<number>, expected: readonly number[], label: string) {
  const { relative, absolute } = matrixErrors(actual, expected);
  worst.relative = Math.max(worst.relative, relative);
  worst.absolute = Math.max(worst.absolute, absolute);
  expect(relative, `${label} 相对误差`).toBeLessThan(1e-5);
  expect(absolute, `${label} 绝对误差（期望很小的元素）`).toBeLessThan(TINY);
}

// ———— 图层 ————

function pass(key: string, extra: Partial<ScenePass> = {}): ScenePass {
  return {
    key,
    program: PROGRAM.image,
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

/** 程序下标：composelayer、effect（kbfx）、图像（genericimage2）、组的上屏（effectpassthrough）、粒子、passthrough 混合上屏。 */
const PROGRAM = { compose: 0, effect: 1, image: 2, upload: 3, particle: 4, passthrough: 5 } as const;

/** `kbfx`：一个绘制 pass，槽 0 = 上一步输出。 */
function kbfx(object: number, extra: Partial<SceneEffect> = {}): SceneEffect {
  return {
    source: 0,
    id: 50,
    name: "kbfx",
    file: "effects/kbfx/effect.json",
    fbos: [],
    steps: [
      {
        kind: "draw",
        pass: pass(`objects/${object}/effects/0/passes/0`, { program: PROGRAM.effect, blending: "normal" }),
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

function baseLayer(object: number, extra: Partial<SceneLayer>): SceneLayer {
  return {
    id: object + 10,
    object,
    parent: null,
    name: `L${object}`,
    origin: [0, 0, 0],
    scale: [1, 1, 1],
    angles: [0, 0, 0],
    size: [100, 100],
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
    passes: [pass(`objects/${object}/passes/0`)],
    colorBlendMode: 0,
    effects: [],
    passthrough: null,
    particle: null,
    ...extra,
  };
}

/** 普通图像层（`solidlayer`，合成 RT 按 size）：`parent` / `group` 由调用方给。 */
const image = (object: number, name: string, origin: number[], size: number[], extra: Partial<SceneLayer> = {}) =>
  baseLayer(object, { name, origin, size, solidLayer: true, ...extra });

interface GroupDef {
  origin: number[];
  size: number[];
  angles?: number[];
  copyBackground?: boolean;
  effect?: boolean;
  colorBlendMode?: number;
  subtree: number[];
}
/** 组：基础材质是 composelayer（槽 0 `_rt_FullFrameBuffer`），带 `groupUpload`（effectpassthrough，normal，g_Color4 = 1）。 */
function group(object: number, name: string, def: GroupDef, extra: Partial<SceneLayer> = {}): SceneLayer {
  const colorBlendMode = def.colorBlendMode ?? 0;
  return baseLayer(object, {
    name,
    origin: def.origin,
    size: def.size,
    angles: def.angles ?? [0, 0, 0],
    passthroughModel: true,
    copyBackground: def.copyBackground ?? true,
    subtree: def.subtree,
    passes: [
      pass(`objects/${object}/passes/0`, {
        program: PROGRAM.compose,
        runtime: { 0: FRAMEBUFFER_RT },
        framebuffer: true,
      }),
    ],
    groupUpload: pass(`objects/${object}/groupupload`, {
      program: PROGRAM.upload,
      blending: "normal",
      uniforms: { g_Color4: [1, 1, 1, 1] },
    }),
    colorBlendMode,
    passthrough:
      colorBlendMode !== 0 && colorBlendMode !== 31
        ? pass(`objects/${object}/passthrough`, {
            program: PROGRAM.passthrough,
            runtime: { 1: FRAMEBUFFER_RT },
            framebuffer: true,
            uniforms: { g_Color4: [1, 1, 1, 1] },
          })
        : null,
    effects: def.effect ? [kbfx(object)] : [],
    ...extra,
  });
}

/** `p5b-grp-*`：0 背景、1 组 GRP、2–4 子层 R / B / Y、5 顶层 TOP。 */
function grpLayers(tag: "cb1" | "cb0" | "nofx" | "nofx0" | "par"): SceneLayer[] {
  const child = (object: number, name: string, origin: number[], size: number[], color: number[], alpha: number) =>
    image(object, name, origin, size, { parent: 1, group: 1, color, alpha });
  const kids = [
    child(2, "R", [-120, 0, 0], [300, 300], [1, 0, 0], 0.5),
    child(3, "B", [60, 40, 0], [300, 300], [0, 0, 1], 0.5),
    child(4, "Y", [380, 180, 0], [200, 200], [1, 1, 0], 1),
  ];
  if (tag === "par") kids[0].parallaxDepth = [2, 2];
  return [
    image(0, "BG", [960, 540, 0], [1920, 1080]),
    group(1, "GRP", {
      origin: tag === "par" ? [1260, 640, 0] : [960, 540, 0],
      size: [800, 400],
      angles: [0, 0, 0.2],
      copyBackground: tag !== "cb0" && tag !== "nofx0",
      effect: tag === "cb1" || tag === "cb0" || tag === "par",
      subtree: [2, 3, 4],
    }),
    ...kids,
    image(5, "TOP", [200, 900, 0], [100, 100], { color: [0, 1, 1] }),
  ];
}

/** `p5b-nest`：0 背景、1 外组 O、2 绿方块 S、3 内组 I、4 蓝方块 T。 */
function nestLayers(): SceneLayer[] {
  return [
    image(0, "BG", [960, 540, 0], [1920, 1080]),
    group(1, "O", { origin: [960, 540, 0], size: [1200, 600], effect: true, subtree: [2, 3] }),
    image(2, "S", [100, 0, 0], [200, 200], { parent: 1, group: 1, color: [0, 1, 0] }),
    group(3, "I", { origin: [100, 0, 0], size: [300, 300], effect: true, subtree: [4] }, { parent: 1, group: 1 }),
    image(4, "T", [-60, -60, 0], [100, 100], { parent: 3, group: 3, color: [0, 0, 1] }),
  ];
}

const draws = (steps: LayerStep[]) => steps.filter((step): step is DrawStep => step.kind === "draw");
const targetName = (target: { kind: string; index?: number; name?: string }) =>
  target.kind === "composite" ? `c${target.index}` : target.kind === "fbo" ? target.name : "scene";
const kinds = (steps: LayerStep[]) =>
  steps.map((step) =>
    step.kind === "draw"
      ? `${step.role}→${targetName(step.target)}`
      : step.kind === "clear" || step.kind === "subtree"
        ? `${step.kind}→${targetName(step.target)}`
        : step.kind,
  );
const stepOf = (plan: LayerPlan, role: string) => draws(plan.steps).find((step) => step.role === role)!;

describe("planLayer：组（p5b-grp-*、p5b-nest）", () => {
  it("cb1（kbfx）：快照 → compose → 子树画进合成 RT 0 → effect 末 pass 上屏；子树不占合成链", () => {
    const plan = planLayer(grpLayers("cb1")[1], []);
    expect(kinds(plan.steps)).toEqual(["snapshot", "compose→c0", "subtree→c0", "final→scene"]);
    expect(plan.composite).toEqual({ count: 1, width: 800, height: 400 });
    expect(stepOf(plan, "final")).toMatchObject({
      pass: { key: "objects/1/effects/0/passes/0" },
      inputs: { 0: { kind: "composite", index: 0 } },
      blending: "translucent",
    });
  });

  it("cb0（kbfx）：快照 → 合成 RT 0 清成透明 → 子树 → 上屏", () => {
    expect(kinds(planLayer(grpLayers("cb0")[1], []).steps)).toEqual([
      "snapshot",
      "clear→c0",
      "subtree→c0",
      "final→scene",
    ]);
  });

  it("nofx（copybackground 缺省）：不是空计划，compose → 子树 → groupUpload 上屏（effectpassthrough、关混合，事件 125）", () => {
    const plan = planLayer(grpLayers("nofx")[1], []);
    expect(kinds(plan.steps)).toEqual(["snapshot", "compose→c0", "subtree→c0", "final→scene"]);
    expect(plan.composite).toEqual({ count: 1, width: 800, height: 400 });
    expect(plan.reasons).toEqual([]);
    expect(stepOf(plan, "final")).toMatchObject({
      pass: { key: "objects/1/groupupload" },
      effect: null,
      inputs: { 0: { kind: "composite", index: 0 } },
      geometry: "layer",
      uv: [1, 1],
      inset: [0, 0],
      blending: "normal",
    });
  });

  it("nofx0（copybackground: false）：clear → 子树 → groupUpload 上屏，强制 translucent（事件 120）", () => {
    const plan = planLayer(grpLayers("nofx0")[1], []);
    expect(kinds(plan.steps)).toEqual(["snapshot", "clear→c0", "subtree→c0", "final→scene"]);
    expect(stepOf(plan, "final")).toMatchObject({ pass: { key: "objects/1/groupupload" }, blending: "translucent" });
  });

  it("没有 effect：colorBlendMode 31 上屏改 additive；colorBlendMode 2 走 passthrough 混合上屏（compose → 子树 → passthrough）", () => {
    const additive = group(1, "G", { origin: [960, 540, 0], size: [800, 400], colorBlendMode: 31, subtree: [2] });
    expect(stepOf(planLayer(additive, []), "final").blending).toBe("additive");
    const blended = group(1, "G", { origin: [960, 540, 0], size: [800, 400], colorBlendMode: 2, subtree: [2] });
    expect(kinds(planLayer(blended, []).steps)).toEqual(["snapshot", "compose→c0", "subtree→c0", "passthrough→scene"]);
  });

  it("带两个 pass 的 effect：子树之后 effect 读合成 RT 0、写合成 RT 1，末 pass 读 1", () => {
    const layer = grpLayers("cb1")[1];
    const step = layer.effects[0].steps[0];
    if (step.kind !== "draw") throw new Error("kbfx 的第一步是绘制");
    layer.effects[0].steps = [step, { ...step, pass: { ...step.pass, key: "p1" } }];
    const plan = planLayer(layer, []);
    expect(kinds(plan.steps)).toEqual(["snapshot", "compose→c0", "subtree→c0", "effect→c1", "final→scene"]);
    expect(plan.composite).toMatchObject({ count: 2 });
    expect(stepOf(plan, "effect").inputs[0]).toEqual({ kind: "composite", index: 0 });
    expect(stepOf(plan, "final").inputs[0]).toEqual({ kind: "composite", index: 1 });
  });

  it("没有子层的组合层照旧（步骤 2 的空计划）；组没有 groupUpload 时报 render:no-group-upload", () => {
    const plain = group(1, "G", { origin: [960, 540, 0], size: [800, 400], subtree: [] });
    expect(planLayer(plain, [])).toEqual({ composite: null, steps: [], reasons: [] });
    const missing = group(1, "G", { origin: [960, 540, 0], size: [800, 400], subtree: [2] }, { groupUpload: null });
    expect(planLayer(missing, []).reasons).toEqual(["render:no-group-upload"]);
  });

  it("p5b-nest：外组与内组都是 compose → 子树 → 上屏；外组层首拷快照，内组直接父是组、不拷（P5f）；子层的计划不变（直接上屏，画到「场景」）", () => {
    const [, outer, s, inner, t] = nestLayers();
    expect(kinds(planLayer(outer, []).steps)).toEqual(["snapshot", "compose→c0", "subtree→c0", "final→scene"]);
    expect(kinds(planLayer(inner, []).steps)).toEqual(["compose→c0", "subtree→c0", "final→scene"]);
    expect(planLayer(inner, []).composite).toEqual({ count: 1, width: 300, height: 300 });
    for (const layer of [s, t]) expect(kinds(planLayer(layer, []).steps)).toEqual(["direct→scene"]);
  });

  it("签名带 subtree；variantPlans：可变 effect 全关时是 compose → 子树 → groupUpload，不是空计划", () => {
    const layer = grpLayers("cb1")[1];
    expect(planSignature(planLayer(layer, []))).toContain('"kind":"subtree"');
    layer.effects = [kbfx(1, { visibleBound: true })];
    const plans = variantPlans(layer, []);
    expect(plans.map((plan) => kinds(plan.steps))).toEqual([
      ["snapshot", "compose→c0", "subtree→c0", "final→scene"],
      ["snapshot", "compose→c0", "subtree→c0", "final→scene"],
      ["snapshot", "compose→c0", "subtree→c0", "final→scene"],
    ]);
    expect(stepOf(plans[1], "final").pass.key).toBe("objects/1/groupupload");
    expect(stepOf(plans[0], "final").pass.key).toBe("objects/1/effects/0/passes/0");
  });
});

describe("planLayer：组里读快照的拷贝点（P5f，p5f-a / p5f-e）", () => {
  const fbPass = (object: number) => pass(`objects/${object}/passes/0`, { framebuffer: true });
  const snapshots = (layer: SceneLayer) =>
    kinds(planLayer(layer, []).steps).filter((kind) => kind === "snapshot").length;

  it("直接父是组：基础材质读快照时层首不拷；顶层、隔着分组节点的孙子照拷", () => {
    const direct = image(2, "FB", [0, 0, 0], [100, 100], { parent: 1, group: 1, passes: [fbPass(2)] });
    expect(kinds(planLayer(direct, []).steps)).toEqual(["direct→scene"]);
    const grandchild = image(3, "FBg", [0, 0, 0], [100, 100], { parent: 2, group: 1, passes: [fbPass(3)] });
    expect(kinds(planLayer(grandchild, []).steps)).toEqual(["snapshot", "direct→scene"]);
    const top = image(4, "TF", [0, 0, 0], [100, 100], { passes: [fbPass(4)] });
    expect(kinds(planLayer(top, []).steps)).toEqual(["snapshot", "direct→scene"]);
  });

  it("effect 前的拷贝不看父：直接父是组也拷（每层至多一次）", () => {
    const fx = kbfx(2);
    (fx.steps[0] as { pass: ScenePass }).pass.framebuffer = true;
    const direct = image(2, "FX", [0, 0, 0], [100, 100], { parent: 1, group: 1, effects: [fx] });
    expect(snapshots(direct)).toBe(1);
    const steps = kinds(planLayer(direct, []).steps);
    expect(steps).toEqual(["base→c0", "snapshot", "final→scene"]);
  });

  it("colorBlendMode 混合：直接父是组时层首与 passthrough 上屏都不拷；顶层照拷", () => {
    const passthrough = pass("objects/2/passthrough", { program: PROGRAM.passthrough, framebuffer: true });
    const inGroup = image(2, "CB", [0, 0, 0], [100, 100], { parent: 1, group: 1, colorBlendMode: 2, passthrough });
    expect(snapshots(inGroup)).toBe(0);
    // 隔着分组节点：层首照拷，上屏仍不拷（每层一次）
    expect(snapshots({ ...inGroup, parent: 9 })).toBe(1);
    expect(snapshots({ ...inGroup, parent: null, group: null })).toBe(1);
  });

  it("组的上屏（groupUpload）在组里不拷，顶层照旧", () => {
    const upload = pass("objects/2/groupupload", { program: PROGRAM.upload, blending: "normal", framebuffer: true });
    const inner = group(
      2,
      "I",
      { origin: [0, 0, 0], size: [300, 300], subtree: [3] },
      { parent: 1, group: 1, groupUpload: upload },
    );
    inner.passes[0].framebuffer = false;
    expect(snapshots(inner)).toBe(0);
    expect(snapshots({ ...inner, parent: null, group: null })).toBe(1);
  });
});

describe("stepPipeline：组里画到「场景」的绘制", () => {
  const spec = (layer: SceneLayer, role: string, groupLayer: SceneLayer | null) => {
    const step = draws(planLayer(layer, []).steps).find((item) => item.role === role)!;
    return stepPipeline(step, "rgba8unorm", () => "rgba8unorm", false, groupLayer);
  };
  it("顶层：不写 alpha、没有 alphaMax，键和以前逐字相同", () => {
    const top = grpLayers("cb1")[5];
    expect(spec(top, "direct", null)).toEqual({
      program: PROGRAM.image,
      blending: "translucent",
      format: "rgba8unorm",
      alpha: false,
      topology: "triangle-strip",
    });
    expect(pipelineKey(spec(top, "direct", null))).toBe(`${PROGRAM.image}|translucent|rgba8unorm|false`);
  });
  it("cb1 组：子层写 RGBA（事件 78）；带 effect 的子层、嵌套组的上屏只写 RGB（grpptc 事件 102、nest 事件 129）", () => {
    const layers = grpLayers("cb1");
    expect(spec(layers[2], "direct", layers[1])).toMatchObject({ alpha: true });
    expect(spec(layers[2], "direct", layers[1]).alphaMax).toBeUndefined();
    const withFx = image(2, "C", [-200, 0, 0], [200, 200], { parent: 1, group: 1, effects: [kbfx(2)] });
    expect(spec(withFx, "final", layers[1])).toMatchObject({ alpha: false });
    expect(spec(withFx, "base", layers[1])).toMatchObject({ alpha: true });
    const [, outer, , inner] = nestLayers();
    expect(spec(inner, "final", outer)).toMatchObject({ alpha: false });
    expect(spec(inner, "compose", outer)).toMatchObject({ alpha: true });
  });
  it("cb0 组：子层与上屏都写 RGBA、alpha 取 MAX（事件 73），键多 `|max`；画进自己合成 RT 的 pass 不受影响", () => {
    const layers = grpLayers("cb0");
    expect(spec(layers[2], "direct", layers[1])).toMatchObject({ alpha: true, alphaMax: true });
    expect(pipelineKey(spec(layers[2], "direct", layers[1]))).toBe(`${PROGRAM.image}|translucent|rgba8unorm|true|max`);
    const withFx = image(2, "C", [-200, 0, 0], [200, 200], { parent: 1, group: 1, effects: [kbfx(2)] });
    expect(spec(withFx, "final", layers[1])).toMatchObject({ alpha: true, alphaMax: true });
    expect(spec(withFx, "base", layers[1]).alphaMax).toBeUndefined();
  });
});

// ———— 矩阵：组的局部正交（groupViewProjection）对上 WPE ————

const SCENE_VP = sceneViewProjection({ width: 1920, height: 1080 });
/** 一组图层的世界矩阵（沿父链）。 */
function worldsOf(layers: SceneLayer[]) {
  const map = new Map(layers.map((layer) => [layer.object, layer]));
  const cache = new Map<number, Mat4>();
  return (object: number) => worldMatrixOf(object, map, cache);
}
/** 组里图层的 MVP：`groupViewProjection(组) · W`（`drawMatrices` 的 `direct` / `final`）。 */
function groupMvp(layers: SceneLayer[], object: number, role: "direct" | "final" = "direct"): Mat4 {
  const world = worldsOf(layers);
  const layer = layers.find((item) => item.object === object)!;
  const owner = layers.find((item) => item.object === layer.group)!;
  return drawMatrices({ role }, world(object), layer.size, groupViewProjection(owner.size, world(owner.object)))
    .modelViewProjection;
}

describe("矩阵：子层在组里（ortho(±w/2, ±h/2, ±1000) · inverse(W_组) · W）", () => {
  it("p5b-grp-cb1 事件 78 / 92 / 106：R、B、Y（cb0 事件 73 / 87 / 101 同值）", () => {
    for (const tag of ["cb1", "cb0", "nofx", "nofx0"] as const) {
      const layers = grpLayers(tag);
      expectMvp(groupMvp(layers, 2), WPE_MVP.cb1R, `${tag} R`);
      expectMvp(groupMvp(layers, 3), WPE_MVP.cb1B, `${tag} B`);
      expectMvp(groupMvp(layers, 4), WPE_MVP.cb1Y, `${tag} Y`);
    }
  });

  it("组的 compose 与上屏是场景视图投影 · W_组（事件 62 / 125，nofx 的 groupUpload 事件 125、nofx0 事件 120 同值）", () => {
    const layers = grpLayers("cb1");
    const world = worldsOf(layers)(1);
    for (const role of ["compose", "final"] as const)
      expectMvp(drawMatrices({ role }, world, [800, 400], SCENE_VP).modelViewProjection, WPE_MVP.group, role);
  });

  it("组里的 x、y 落在组的本地坐标：R 的四角在 RT 里是 x −0.675…0.075、y −0.75…0.75（事件 78 的 clip）", () => {
    const mvp = groupMvp(grpLayers("cb1"), 2);
    const corners = [
      [-150, -150],
      [150, 150],
    ].map(([x, y]) => transformPoint(mvp, x, y, 0));
    expect(corners[0][0]).toBeCloseTo(-0.675, 6);
    expect(corners[1][0]).toBeCloseTo(0.075, 6);
    expect(corners[0][1]).toBeCloseTo(-0.75, 6);
    expect(corners[1][1]).toBeCloseTo(0.75, 6);
    // 深度：z = 0 落在 0.5（和场景正交一致）
    expect(corners[0][2]).toBeCloseTo(0.5, 6);
  });

  it("p5b-grp-par：组的 compose / 上屏带视差偏移 (150, 50)（事件 62 / 125），子层不带（事件 78 / 92 / 106，R 的深度 2 2 也一样）", () => {
    const layers = grpLayers("par");
    const [ox, oy] = parallaxOffset(0.5, layers[1].parallaxDepth, layers[1].origin, [960, 540]);
    expect([ox, oy]).toEqual([150, 50]);
    const vp = multiply(SCENE_VP, translation(ox, oy, 0));
    const world = worldsOf(layers)(1);
    expectMvp(
      drawMatrices({ role: "compose" }, world, [800, 400], vp).modelViewProjection,
      WPE_MVP.parGroup,
      "par compose",
    );
    expectMvp(
      drawMatrices({ role: "final" }, world, [800, 400], vp).modelViewProjection,
      WPE_MVP.parGroup,
      "par final",
    );
    expectMvp(groupMvp(layers, 2), WPE_MVP.parR, "par R");
    expectMvp(groupMvp(layers, 3), WPE_MVP.parB, "par B");
    expectMvp(groupMvp(layers, 4), WPE_MVP.parY, "par Y");
  });

  it("p5b-nest：外组 compose / 上屏（事件 62 / 148）；S 在外组里（事件 78）；内组 compose 用场景视图投影（事件 94）；T 在内组里（事件 110）；内组上屏画进外组（事件 129）", () => {
    const layers = nestLayers();
    const world = worldsOf(layers);
    expectMvp(
      drawMatrices({ role: "compose" }, world(1), [1200, 600], SCENE_VP).modelViewProjection,
      WPE_MVP.nestO,
      "O",
    );
    expectMvp(
      drawMatrices({ role: "final" }, world(1), [1200, 600], SCENE_VP).modelViewProjection,
      WPE_MVP.nestO,
      "O 上屏",
    );
    expectMvp(groupMvp(layers, 2), WPE_MVP.nestS, "S");
    expectMvp(
      drawMatrices({ role: "compose" }, world(3), [300, 300], SCENE_VP).modelViewProjection,
      WPE_MVP.nestI,
      "I compose",
    );
    expectMvp(groupMvp(layers, 4), WPE_MVP.nestT, "T");
    expectMvp(groupMvp(layers, 3, "final"), WPE_MVP.nestS, "I 上屏");
  });

  it("p5b-grpptc：带 kbfx 的子层 C 的末 pass 画进组里（事件 102）", () => {
    const layers = [...grpLayers("cb1").slice(0, 2), image(2, "C", [-200, 0, 0], [200, 200], { parent: 1, group: 1 })];
    expectMvp(groupMvp(layers, 2, "final"), WPE_MVP.ptcC, "C final");
  });

  it("p5b-grpptc 的粒子：本地系统 pl 的中心落在本地 (150, 50)（事件 116：NDC 0.375, 0.25）；世界空间系统 pw 的顶点 (1220.91, 511.26) 经单位模型矩阵回到本地 (250, −80)（事件 129）", () => {
    const layers = [
      ...grpLayers("cb1").slice(0, 2),
      baseLayer(3, { name: "pl", origin: [150, 50, 0], parent: 1, group: 1, passes: [] }),
      baseLayer(4, { name: "pw", origin: [250, -80, 0], parent: 1, group: 1, passes: [] }),
    ];
    const world = worldsOf(layers);
    const vp = groupViewProjection([800, 400], world(1));
    // 本地系统：模型矩阵是对象的世界矩阵，粒子在系统原点
    const local = transformPoint(multiply(vp, world(3)), 0, 0, 0);
    expect(local[0]).toBeCloseTo(0.375, 6);
    expect(local[1]).toBeCloseTo(0.25, 6);
    // 世界空间系统：粒子存世界坐标，等于对象世界矩阵作用在原点；模型矩阵是单位阵
    const stored = transformPoint(world(4), 0, 0, 0);
    expect(stored[0]).toBeCloseTo(1220.91, 1);
    expect(stored[1]).toBeCloseTo(511.26, 1);
    const ndc = transformPoint(vp, stored[0], stored[1], 0);
    expect(ndc[0]).toBeCloseTo(0.625, 6);
    expect(ndc[1]).toBeCloseTo(-0.4, 6);
  });
});

// ———— GpuScene 假设备 ————

interface FakeTexture {
  width: number;
  height: number;
  label: string;
  format: string;
  usage: number;
  destroy(): void;
}
interface FakeView {
  label: string;
  texture: FakeTexture;
}
interface FakeBuffer {
  label: string;
  bytes: Uint8Array;
  destroy(): void;
}
interface FakePipeline {
  label: string;
  format: string;
  blend: GPUBlendState | undefined;
  writeMask: number | undefined;
}

/**
 * 假设备：记缓冲字节（uniform 读回）与一帧的编码轨迹，并模拟 WebGPU 会拒绝的情况（任何一条都抛错）：
 * - 拷贝：源要 COPY_SRC、目标要 COPY_DST，源和目标不能是同一张，render pass 开着时不能拷；
 * - render pass：开着时不能再开；目标要有 RENDER_ATTACHMENT；在已结束的 pass 上设管线、绑定或绘制；
 * - 管线的目标格式要和 pass 的目标一致；
 * - 同一张纹理在一个 pass 里既是目标又被 bind group 采样（写与读的用途冲突）。
 */
class FakeGpu {
  readonly trace: string[] = [];
  /** 一帧里的拷贝（P5f）：源与目标的标签、目标原点、尺寸 */
  readonly copies: {
    source: string;
    target: string;
    origin: { x: number; y: number } | undefined;
    size: GPUExtent3DDictStrict;
  }[] = [];
  readonly pipelines: FakePipeline[] = [];
  readonly device: GPUDevice;

  constructor() {
    const trace = this.trace;
    const copies = this.copies;
    const fail = (message: string): never => {
      throw new Error(`WebGPU 校验：${message}`);
    };
    let open: { ended: boolean } | null = null;
    const renderPass = (attachment: FakeTexture) => {
      const state = { ended: false };
      const live = () => {
        if (state.ended) fail(`在已结束的 pass（${attachment.label}）上编码`);
      };
      open = state;
      return {
        setViewport: live,
        setPipeline(pipeline: FakePipeline) {
          live();
          if (pipeline.format !== attachment.format)
            fail(`管线格式 ${pipeline.format} 和目标 ${attachment.label}（${attachment.format}）不符`);
          trace.push(`  pipeline ${pipeline.label}`);
        },
        setBindGroup(_index: number, group: { views: FakeView[] }) {
          live();
          for (const view of group.views)
            if (view.texture === attachment) fail(`${attachment.label} 在同一个 pass 里既是目标又被采样`);
        },
        setVertexBuffer(_slot: number, buffer: FakeBuffer) {
          live();
          trace.push(`  draw ${buffer.label}`);
        },
        setIndexBuffer: live,
        draw: live,
        drawIndexed: live,
        end() {
          live();
          state.ended = true;
          open = null;
        },
      };
    };
    this.device = {
      limits: { maxTextureDimension2D: 8192 },
      lost: new Promise(() => {}),
      destroy() {},
      createTexture: (descriptor: GPUTextureDescriptor) => {
        const extent = descriptor.size as { width: number; height: number } | number[];
        const texture = {
          width: Array.isArray(extent) ? extent[0] : extent.width,
          height: Array.isArray(extent) ? extent[1] : extent.height,
          label: descriptor.label ?? "",
          format: descriptor.format,
          usage: descriptor.usage,
          destroy() {},
          createView: (): FakeView => ({ label: texture.label, texture }),
        };
        return texture;
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
        const target = [...descriptor.fragment!.targets][0]!;
        const pipeline: FakePipeline = {
          label: `${descriptor.label} mask ${target.writeMask}`,
          format: target.format,
          blend: target.blend,
          writeMask: target.writeMask,
        };
        this.pipelines.push(pipeline);
        return pipeline;
      },
      createBindGroup: (descriptor: GPUBindGroupDescriptor) => ({
        views: [...descriptor.entries]
          .map((entry) => entry.resource as unknown as Partial<FakeView>)
          .filter((resource): resource is FakeView => !!resource && "texture" in resource),
      }),
      createCommandEncoder: () => ({
        beginRenderPass: (descriptor: GPURenderPassDescriptor) => {
          if (open) fail("上一个 render pass 还没结束");
          const attachment = [...descriptor.colorAttachments][0]!;
          const view = attachment.view as unknown as FakeView;
          if (!(view.texture.usage & GPUTextureUsage.RENDER_ATTACHMENT)) fail(`${view.label} 没有 RENDER_ATTACHMENT`);
          const clear = attachment.loadOp === "clear" ? ` ${JSON.stringify(attachment.clearValue)}` : "";
          trace.push(`pass ${view.label} ${attachment.loadOp}${clear}`);
          return renderPass(view.texture);
        },
        copyTextureToTexture: (
          source: { texture: FakeTexture },
          target: { texture: FakeTexture; origin?: { x: number; y: number } },
          size: GPUExtent3DDictStrict,
        ) => {
          if (open) fail("render pass 开着时拷贝");
          if (!(source.texture.usage & GPUTextureUsage.COPY_SRC)) fail(`${source.texture.label} 没有 COPY_SRC`);
          if (!(target.texture.usage & GPUTextureUsage.COPY_DST)) fail(`${target.texture.label} 没有 COPY_DST`);
          if (source.texture === target.texture) fail(`${source.texture.label} 拷给自己`);
          // 拷贝范围不能超出两边（WebGPU 会拒绝）
          if (size.width > source.texture.width || size.height! > source.texture.height)
            fail(`拷贝 ${size.width}x${size.height} 超出源 ${source.texture.label}`);
          if (size.width > target.texture.width || size.height! > target.texture.height)
            fail(`拷贝 ${size.width}x${size.height} 超出目标 ${target.texture.label}`);
          copies.push({ source: source.texture.label, target: target.texture.label, origin: target.origin, size });
          trace.push(`copy ${source.texture.label} -> ${target.texture.label}`);
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

  /** 编码一帧，返回这一帧的轨迹。 */
  encode(scene: GpuScene, state: SceneState): string[] {
    this.trace.length = 0;
    this.copies.length = 0;
    scene.encode(this.device.createCommandEncoder(), state);
    return [...this.trace];
  }
}

/** 一个程序：MVP（偏移 0）与视图投影（偏移 64），声明 `slots` 这些纹理槽。 */
function program(name: string, slots: number[]): TranslateResult {
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
      { name: "g_ViewProjectionMatrix", type: "mat4x4<f32>", declared: "mat4", offset: 64, size: 64 },
    ],
    uniformBlockSize: 128,
    textures: slots.map((slot) => ({ slot, binding: 1 + 2 * slot, samplerBinding: 2 + 2 * slot, kind: "2d" })),
  } as unknown as TranslateResult;
}
/** 翻译后 `genericparticle` 的反射（同 `render/particles.test.ts`）：MVP 在偏移 0。 */
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
  ],
  uniformBlockSize: 128,
  textures: [{ slot: 0, binding: 1, samplerBinding: 2, kind: "2d" }],
} as unknown as TranslateResult;

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
      program("kbfx", [0]),
      program("image", [0]),
      program("effectpassthrough", [0]),
      PARTICLE_PROGRAM,
      program("passthrough", [0, 1]),
    ],
    textures: [],
    bloom: null,
    unsupported: [],
    bindings: [],
    scripts: { list: [] },
  };
}

interface DrawView {
  object: number;
  label: string;
  step: { role?: string; kind: string };
  pipeline: FakePipeline;
  uniformBuffer: FakeBuffer | null;
  particles: { system: { columns: { position: Float32Array[] }; alive: number } } | null;
}
interface RuntimeView {
  object: number;
  ops: { kind: string; draw?: DrawView }[];
}
const internals = (scene: GpuScene) => scene as unknown as { layers: RuntimeView[]; draws: Set<DrawView> };
const opKinds = (scene: GpuScene, object: number) =>
  internals(scene)
    .layers.find((item) => item.object === object)
    ?.ops.map((op) => (op.kind === "draw" ? `draw ${op.draw!.step.role ?? op.draw!.step.kind}` : op.kind)) ?? null;
const matrixAt = (draw: DrawView, offset: number): Float32Array =>
  new Float32Array(draw.uniformBuffer!.bytes.buffer.slice(offset, offset + 64));
function drawOf(scene: GpuScene, object: number, role: string): DrawView {
  const draw = [...internals(scene).draws].find(
    (item) => item.object === object && (item.step.role ?? item.step.kind) === role,
  );
  if (!draw) throw new Error(`图层 ${object} 没有 ${role} 的 draw`);
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

async function open(layers: SceneLayer[]) {
  const gpu = new FakeGpu();
  const bundle = bundleOf(layers);
  const state = SceneState.fromBundle(bundle);
  const scene = await GpuScene.build(gpu.device, bundle, state, new Set(), [], { particles: { seed: 1 } });
  scene.update(FRAME, state);
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

const CLEAR_SCENE = 'pass scene target clear {"r":0,"g":0,"b":0,"a":1}';
const SNAPSHOT = "copy scene target -> _rt_FullFrameBuffer";
const GRP_RT = "composite 800x400|true|false #0";
const IMAGE_SCENE = "  pipeline scene program 2 translucent rgba8unorm mask 7";
const IMAGE_GROUP = "  pipeline scene program 2 translucent rgba8unorm mask 15";
const COMPOSE = "  pipeline scene program 0 opaque rgba8unorm mask 15";
const KBFX_FINAL = "  pipeline scene program 1 translucent rgba8unorm mask 7";

describe("GpuScene：p5b-grp 的组", () => {
  it("cb1：子层的 op 照旧，但顶层不画；组的 subtree 把 R、B、Y 画进组的合成 RT（一个 pass、写 RGBA），之后组上屏、TOP 照常", async () => {
    const { gpu, scene, state } = await open(grpLayers("cb1"));
    expect(opKinds(scene, 1)).toEqual(["snapshot", "draw compose", "subtree", "draw final"]);
    expect(opKinds(scene, 2)).toEqual(["draw direct"]);
    expect(gpu.encode(scene, state)).toEqual([
      CLEAR_SCENE,
      IMAGE_SCENE,
      "  draw layer 10 BG direct",
      SNAPSHOT,
      `pass ${GRP_RT} load`,
      COMPOSE,
      "  draw layer 11 GRP compose",
      `pass ${GRP_RT} load`,
      IMAGE_GROUP,
      "  draw layer 12 R direct",
      IMAGE_GROUP,
      "  draw layer 13 B direct",
      IMAGE_GROUP,
      "  draw layer 14 Y direct",
      "pass scene target load",
      KBFX_FINAL,
      "  draw layer 11 GRP final",
      IMAGE_SCENE,
      "  draw layer 15 TOP direct",
    ]);
  });

  it("cb0：合成 RT 清成透明，子层的管线 alpha 是 One / One / Max、写掩码 15，颜色照 translucent", async () => {
    const { gpu, scene, state } = await open(grpLayers("cb0"));
    const trace = gpu.encode(scene, state);
    const max = "  pipeline scene program 2 translucent rgba8unorm max mask 15";
    expect(trace.slice(3, 13)).toEqual([
      SNAPSHOT,
      `pass ${GRP_RT} clear {"r":0,"g":0,"b":0,"a":0}`,
      `pass ${GRP_RT} load`,
      max,
      "  draw layer 12 R direct",
      max,
      "  draw layer 13 B direct",
      max,
      "  draw layer 14 Y direct",
      "pass scene target load",
    ]);
    const child = drawOf(scene, 2, "direct").pipeline;
    expect(child.writeMask).toBe(0xf);
    expect(child.blend).toEqual({
      color: { operation: "add", srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha" },
      alpha: { operation: "max", srcFactor: "one", dstFactor: "one" },
    });
    // 组自己的上屏不在组里：照旧 translucent、写 RGB
    expect(drawOf(scene, 1, "final").pipeline.label).toBe("scene program 1 translucent rgba8unorm mask 7");
  });

  it("cb0 里不混合的子层：颜色 One / Zero、alpha 仍取 MAX", async () => {
    const layers = grpLayers("cb0");
    layers[4].passes = [pass("objects/4/passes/0", { blending: "none" })];
    const { scene } = await open(layers);
    expect(drawOf(scene, 4, "direct").pipeline.blend).toEqual({
      color: { operation: "add", srcFactor: "one", dstFactor: "zero" },
      alpha: { operation: "max", srcFactor: "one", dstFactor: "one" },
    });
  });

  it("nofx：groupUpload 上屏（effectpassthrough、normal = 不混合、写 RGB，事件 125）；nofx0 是 translucent（事件 120）", async () => {
    for (const [tag, blending] of [
      ["nofx", "normal"],
      ["nofx0", "translucent"],
    ] as const) {
      const { gpu, scene, state } = await open(grpLayers(tag));
      expect(opKinds(scene, 1)).toEqual([
        "snapshot",
        tag === "nofx" ? "draw compose" : "clear",
        "subtree",
        "draw final",
      ]);
      expect(drawOf(scene, 1, "final").pipeline.label).toBe(`scene program 3 ${blending} rgba8unorm mask 7`);
      expect(gpu.encode(scene, state).slice(-5)).toEqual([
        "pass scene target load",
        `  pipeline scene program 3 ${blending} rgba8unorm mask 7`,
        "  draw layer 11 GRP final",
        IMAGE_SCENE,
        "  draw layer 15 TOP direct",
      ]);
    }
  });

  it("uniform：R、B、Y 的 MVP 对上事件 78 / 92 / 106，组的 compose / 上屏对上事件 62 / 125；子层的视图投影是组的局部正交 P 本身（P14c）", async () => {
    for (const tag of ["cb1", "cb0", "nofx"] as const) {
      const { scene } = await open(grpLayers(tag));
      expectMvp(matrixAt(drawOf(scene, 2, "direct"), 0), WPE_MVP.cb1R, `${tag} R`);
      expectMvp(matrixAt(drawOf(scene, 3, "direct"), 0), WPE_MVP.cb1B, `${tag} B`);
      expectMvp(matrixAt(drawOf(scene, 4, "direct"), 0), WPE_MVP.cb1Y, `${tag} Y`);
      expectMvp(matrixAt(drawOf(scene, 1, "final"), 0), WPE_MVP.group, `${tag} 上屏`);
      if (tag !== "cb0") expectMvp(matrixAt(drawOf(scene, 1, "compose"), 0), WPE_MVP.group, `${tag} compose`);
      const layers = grpLayers(tag);
      const expected = groupMvpParts([800, 400], worldsOf(layers)(1))!.projection;
      expect([...matrixAt(drawOf(scene, 2, "direct"), 64)]).toEqual([...expected]);
    }
  });

  it("p5b-grp-par：开着视差时组的 compose / 上屏带偏移 (150, 50)（事件 62 / 125），子层不带（事件 78 / 92 / 106）", async () => {
    const { scene, state } = await open(grpLayers("par"));
    scene.setParallax({ point: [960, 540], amount: 0.5 }, state);
    scene.update(FRAME, state);
    expectMvp(matrixAt(drawOf(scene, 1, "compose"), 0), WPE_MVP.parGroup, "par compose");
    expectMvp(matrixAt(drawOf(scene, 1, "final"), 0), WPE_MVP.parGroup, "par final");
    expectMvp(matrixAt(drawOf(scene, 2, "direct"), 0), WPE_MVP.parR, "par R");
    expectMvp(matrixAt(drawOf(scene, 3, "direct"), 0), WPE_MVP.parB, "par B");
    expectMvp(matrixAt(drawOf(scene, 4, "direct"), 0), WPE_MVP.parY, "par Y");
  });

  it("组隐藏时整棵不画（组的快照、compose、子树、上屏都没有）；只藏一个子层时其余照画", async () => {
    const { gpu, scene, state } = await open(grpLayers("cb1"));
    state.write({ property: "p", target: { kind: "layer", object: 1, field: "visible" } }, false);
    scene.sync(state);
    expect(gpu.encode(scene, state)).toEqual([
      CLEAR_SCENE,
      IMAGE_SCENE,
      "  draw layer 10 BG direct",
      IMAGE_SCENE,
      "  draw layer 15 TOP direct",
    ]);
    state.write({ property: "p", target: { kind: "layer", object: 1, field: "visible" } }, true);
    state.write({ property: "p", target: { kind: "layer", object: 3, field: "visible" } }, false);
    scene.sync(state);
    const trace = gpu.encode(scene, state);
    expect(trace.filter((line) => /draw layer/.test(line))).toEqual([
      "  draw layer 10 BG direct",
      "  draw layer 11 GRP compose",
      "  draw layer 12 R direct",
      "  draw layer 14 Y direct",
      "  draw layer 11 GRP final",
      "  draw layer 15 TOP direct",
    ]);
  });

  it("组的变换改了：子孙的矩阵都是组内局部的，视图投影仍是 P、MVP 仍是本地的（事件 78）", async () => {
    const { scene, state } = await open(grpLayers("cb1"));
    state.write({ property: "p", target: { kind: "layer", object: 1, field: "origin" } }, "600 300 0");
    scene.sync(state);
    scene.update(FRAME, state);
    const layers = grpLayers("cb1");
    layers[1].origin = [600, 300, 0];
    expect([...matrixAt(drawOf(scene, 2, "direct"), 64)]).toEqual([
      ...groupMvpParts([800, 400], worldsOf(layers)(1))!.projection,
    ]);
    expectMvp(matrixAt(drawOf(scene, 2, "direct"), 0), WPE_MVP.cb1R, "移动后的 R");
  });
});

describe("GpuScene：嵌套组（p5b-nest）", () => {
  it("内组直接父是组、层首不拷快照（P5f）；内组画进按层数分开的合成 RT（k1）；内组上屏画回外组的合成 RT、只写 RGB（事件 129）", async () => {
    const { gpu, scene, state } = await open(nestLayers());
    const outer = "composite 1200x600|true|false #0";
    const inner = "composite 300x300|true|false|k1 #0";
    expect(opKinds(scene, 3)).toEqual(["draw compose", "subtree", "draw final"]);
    expect(gpu.encode(scene, state)).toEqual([
      CLEAR_SCENE,
      IMAGE_SCENE,
      "  draw layer 10 BG direct",
      SNAPSHOT,
      `pass ${outer} load`,
      COMPOSE,
      "  draw layer 11 O compose",
      `pass ${outer} load`,
      IMAGE_GROUP,
      "  draw layer 12 S direct",
      `pass ${inner} load`,
      COMPOSE,
      "  draw layer 13 I compose",
      `pass ${inner} load`,
      IMAGE_GROUP,
      "  draw layer 14 T direct",
      `pass ${outer} load`,
      KBFX_FINAL,
      "  draw layer 13 I final",
      "pass scene target load",
      KBFX_FINAL,
      "  draw layer 11 O final",
    ]);
  });

  it("uniform：O 的 compose / 上屏（事件 62 / 148）、S（事件 78）、I 的 compose 用场景视图投影（事件 94）、T（事件 110）、I 上屏（事件 129）", async () => {
    const { scene } = await open(nestLayers());
    expectMvp(matrixAt(drawOf(scene, 1, "compose"), 0), WPE_MVP.nestO, "O compose");
    expectMvp(matrixAt(drawOf(scene, 1, "final"), 0), WPE_MVP.nestO, "O 上屏");
    expectMvp(matrixAt(drawOf(scene, 2, "direct"), 0), WPE_MVP.nestS, "S");
    expectMvp(matrixAt(drawOf(scene, 3, "compose"), 0), WPE_MVP.nestI, "I compose");
    expectMvp(matrixAt(drawOf(scene, 4, "direct"), 0), WPE_MVP.nestT, "T");
    expectMvp(matrixAt(drawOf(scene, 3, "final"), 0), WPE_MVP.nestS, "I 上屏");
    // I 的 compose 的视图投影就是场景的（采快照按屏幕坐标）
    expect([...matrixAt(drawOf(scene, 3, "compose"), 64)]).toEqual([...SCENE_VP]);
  });

  it("外组隐藏：内组与它的子孙一起不画", async () => {
    const { gpu, scene, state } = await open(nestLayers());
    state.write({ property: "p", target: { kind: "layer", object: 1, field: "visible" } }, false);
    scene.sync(state);
    expect(gpu.encode(scene, state).filter((line) => /draw layer/.test(line))).toEqual(["  draw layer 10 BG direct"]);
  });
});

/** 粒子层：发射器在系统原点、不散开、不动，每秒 100 个，寿命 100 秒；`flags` 1 是世界空间。 */
function particleLayer(object: number, name: string, origin: number[], flags: number): SceneLayer {
  const particle = parseParticle(
    {
      maxcount: 16,
      flags,
      emitter: [{ name: "sphererandom", origin: "0 0 0", distancemax: 0, rate: 100 }],
      initializer: [
        { name: "lifetimerandom", min: 100, max: 100 },
        { name: "sizerandom", min: 20, max: 20 },
      ],
    },
    { file: `particles/${name}.json`, orthographic: true },
  );
  particle.passes = [pass(`objects/${object}/particle/passes/0`, { program: PROGRAM.particle, blending: "additive" })];
  return baseLayer(object, { name, origin, passes: [], particle, parent: 1, group: 1 });
}

/** `p5b-grpptc`：0 背景、1 组 GRP（kbfx）、2 带 kbfx 的子层 C、3 本地系统 pl、4 世界空间系统 pw。`size` 是 C 的尺寸。 */
function grpptcLayers(size = [200, 200]): SceneLayer[] {
  return [
    ...grpLayers("cb1")
      .slice(0, 2)
      .map((layer) => (layer.object === 1 ? { ...layer, subtree: [2, 3, 4] } : layer)),
    image(2, "C", [-200, 0, 0], size, { parent: 1, group: 1, color: [1, 0, 1], effects: [kbfx(2)] }),
    particleLayer(3, "pl", [150, 50, 0], 0),
    particleLayer(4, "pw", [250, -80, 0], 1),
  ];
}

describe("GpuScene：组里的粒子与带 effect 的子层（p5b-grpptc）", () => {
  it("C 的合成链用 k1 的合成 RT，末 pass 画进组的合成 RT（只写 RGB，事件 102）；粒子画进组的合成 RT（写 RGBA）", async () => {
    const { gpu, scene, state } = await open(grpptcLayers());
    scene.stepParticles(0.2, 1, state);
    scene.update(FRAME, state);
    const trace = gpu.encode(scene, state);
    expect(trace.slice(3)).toEqual([
      SNAPSHOT,
      `pass ${GRP_RT} load`,
      COMPOSE,
      "  draw layer 11 GRP compose",
      "pass composite 200x200|true|false|k1 #0 load",
      "  pipeline scene program 2 opaque rgba8unorm mask 15",
      "  draw layer 12 C base",
      `pass ${GRP_RT} load`,
      KBFX_FINAL,
      "  draw layer 12 C final",
      "  pipeline scene program 4 additive rgba8unorm list mask 15",
      "  draw layer 13 pl particles",
      "  pipeline scene program 4 additive rgba8unorm list mask 15",
      "  draw layer 14 pw particles",
      "pass scene target load",
      KBFX_FINAL,
      "  draw layer 11 GRP final",
    ]);
    expectMvp(matrixAt(drawOf(scene, 2, "final"), 0), WPE_MVP.ptcC, "C final");
  });

  it("粒子位置：本地系统 pl 落在本地 (150, 50)（事件 116，NDC 0.375, 0.25）；世界空间系统 pw 存世界坐标 (1220.91, 511.26)，经组的视图投影回到本地 (250, −80)（事件 129）", async () => {
    const { scene, state } = await open(grpptcLayers());
    scene.stepParticles(0.2, 1, state);
    scene.update(FRAME, state);
    const ndcOf = (object: number) => {
      const draw = drawOf(scene, object, "particles");
      const { position } = draw.particles!.system.columns;
      expect(draw.particles!.system.alive).toBeGreaterThan(0);
      return transformPoint(matrixAt(draw, 0), position[0][0], position[1][0], position[2][0]);
    };
    const local = ndcOf(3);
    expect(local[0]).toBeCloseTo(0.375, 5);
    expect(local[1]).toBeCloseTo(0.25, 5);
    const pw = drawOf(scene, 4, "particles").particles!.system.columns.position;
    expect(pw[0][0]).toBeCloseTo(1220.91, 1);
    expect(pw[1][0]).toBeCloseTo(511.26, 1);
    const world = ndcOf(4);
    expect(world[0]).toBeCloseTo(0.625, 5);
    expect(world[1]).toBeCloseTo(-0.4, 5);
    // 世界空间系统（P14d，p14d-gp 实测）：模型矩阵是 inverse(W_组)、视图投影是组的局部正交 P，MVP = P ⊗ inverse(W_组)
    const parts = groupMvpParts([800, 400], worldsOf(grpptcLayers())(1))!;
    expect([...matrixAt(drawOf(scene, 4, "particles"), 0)]).toEqual([...mulAffine(parts.projection, parts.inverse)]);
  });

  it("子层的合成 RT 和组同尺寸时也不共用同一张（按层数分池）：C 的末 pass 采自己的 RT、画进组的 RT，假设备的读写冲突检查不报", async () => {
    const { gpu, scene, state } = await open(grpptcLayers([800, 400]));
    const trace = gpu.encode(scene, state);
    expect(trace).toContain("pass composite 800x400|true|false|k1 #0 load");
    expect(trace.filter((line) => line === `pass ${GRP_RT} load`).length).toBe(2);
  });
});

describe("GpuScene：组里的粒子用组内局部的绘制矩阵（P14d，p14d-gp）", () => {
  /** 这次绘制的 `g_ModelMatrixInverse`（`PARTICLE_PROGRAM` 偏移 64）：模型矩阵的单精度逆。 */
  const inverseOf = (draw: DrawView) => Array.from(matrixAt(draw, 64));
  const expectedInverse = (model: Mat4) => Array.from(uniformInverse(model)!);

  it("本地系统 pl 的模型矩阵是 inverse(W_组) · W，世界空间系统 pw 是 inverse(W_组)，MVP = P ⊗ M", async () => {
    const layers = grpptcLayers();
    const { scene, state } = await open(layers);
    scene.stepParticles(0.2, 1, state);
    scene.update(FRAME, state);
    const world = worldsOf(layers);
    const parts = groupMvpParts([800, 400], world(1))!;
    const local = multiply(parts.inverse, world(3));
    expect(inverseOf(drawOf(scene, 3, "particles"))).toEqual(expectedInverse(local));
    expect([...matrixAt(drawOf(scene, 3, "particles"), 0)]).toEqual([...mulAffine(parts.projection, local)]);
    expect(inverseOf(drawOf(scene, 4, "particles"))).toEqual(expectedInverse(parts.inverse));
  });

  it("全屏组（P5j）的子孙不换：模型矩阵仍是世界矩阵", async () => {
    const layers = fsGroupLayers();
    layers[1] = { ...layers[1], subtree: [...layers[1].subtree!, 12] };
    layers.push(particleLayer(12, "fp", [40, -30, 0], 0));
    const { scene, state } = await open(layers);
    scene.stepParticles(0.2, 1, state);
    scene.update(FRAME, state);
    expect(inverseOf(drawOf(scene, 12, "particles"))).toEqual(expectedInverse(worldsOf(layers)(12)));
  });

  it("组里的事件实例（每帧现排、池化的 draw）：模型矩阵同样从 inverse(W_组) 起，世界空间的实例是 inverse(W_组)；不动时不再刷新", async () => {
    const layers = grpptcLayers();
    const pl = layers.find((layer) => layer.object === 3)!;
    // 条目 0 本地 eventfollow、条目 1 世界空间 eventfollow；父粒子不动，实例的 X 每帧相同
    for (const flags of [0, 1]) {
      const child = parseParticle(
        {
          maxcount: 4,
          flags,
          emitter: [{ name: "sphererandom", origin: "0 0 0", distancemax: 0, rate: 10 }],
          initializer: [{ name: "lifetimerandom", min: 100, max: 100 }],
        },
        { file: `particles/ple${flags}.json`, orthographic: true },
      );
      const index = pl.particle!.children.length;
      child.passes = [
        pass(`objects/3/particle/children/${index}/passes/0`, { program: PROGRAM.particle, blending: "additive" }),
      ];
      pl.particle!.children.push({
        index,
        type: "eventfollow",
        flags: 0,
        controlPointStartIndex: 0,
        probability: 1,
        maxcount: 10,
        local: childLocalMatrix([0, 0, 0], [0, 0, 0], [1, 1, 1]),
        system: child,
      });
    }
    const { gpu, scene, state } = await open(layers);
    const frame = () => {
      scene.stepParticles(0.2, 1, state);
      scene.update(FRAME, state);
      gpu.encode(scene, state);
    };
    for (let i = 0; i < 3; i++) frame();
    const instanceOf = (template: string) =>
      [...internals(scene).draws].find((draw) => draw.object === 3 && draw.label.endsWith(`particles ${template}`));
    const world = worldsOf(layers);
    const parts = groupMvpParts([800, 400], world(1))!;
    const local = instanceOf("0");
    expect(local).toBeDefined();
    const system = local!.particles!.system as unknown as ParticleSystem;
    const model = system.drawTransform(world(3), parts.inverse).model;
    expect(Array.from(model)).not.toEqual(Array.from(system.drawTransform(world(3)).model));
    expect(inverseOf(local!)).toEqual(expectedInverse(model));
    expect([...matrixAt(local!, 0)]).toEqual([...mulAffine(parts.projection, model)]);
    expect(inverseOf(instanceOf("1")!)).toEqual(expectedInverse(parts.inverse));
    // 每帧现排给的模型矩阵和上次写进 uniform 的同一个起点：没变就不刷新（`assignParticles` 逐位比）
    const refresh = vi.spyOn(scene as unknown as { refreshLayer: () => void }, "refreshLayer");
    frame();
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe("GpuScene：组里执行快照拷当前目标（P5f，p5f-a / p5f-e）", () => {
  /** 组 `GRP`（size 给定）里一个读快照的 effect 子层 FX；组外有一个读快照的顶层 TF */
  function layersOf(size: number[]): SceneLayer[] {
    const fx = kbfx(2);
    (fx.steps[0] as { pass: ScenePass }).pass.framebuffer = true;
    return [
      image(0, "BG", [960, 540, 0], [1920, 1080]),
      group(1, "GRP", { origin: [960, 540, 0], size, subtree: [2] }),
      image(2, "FX", [0, 0, 0], [100, 100], { parent: 1, group: 1, effects: [fx] }),
    ];
  }
  const fromTexture = (gpu: FakeGpu, source: string) => gpu.copies.filter((copy) => copy.source === source);

  it("组比屏幕窄：effect 前的拷贝源是组的合成 RT、落在快照 (0, 0)、尺寸取组的大小；组自己的层首拷贝仍是场景目标整张", async () => {
    const { gpu, scene, state } = await open(layersOf([800, 400]));
    gpu.encode(scene, state);
    expect(fromTexture(gpu, "scene target")).toEqual([
      {
        source: "scene target",
        target: "_rt_FullFrameBuffer",
        origin: { x: 0, y: 0 },
        size: { width: 1920, height: 1080 },
      },
    ]);
    expect(fromTexture(gpu, "composite 800x400|true|false #0")).toEqual([
      {
        source: "composite 800x400|true|false #0",
        target: "_rt_FullFrameBuffer",
        origin: { x: 0, y: 0 },
        size: { width: 800, height: 400 },
      },
    ]);
  });

  it("组比屏幕宽：宽取屏幕、高取组（2400×600 → 1920×600）", async () => {
    const { gpu, scene, state } = await open(layersOf([2400, 600]));
    gpu.encode(scene, state);
    const [copy] = fromTexture(gpu, "composite 2400x600|true|false #0");
    expect(copy.target).toBe("_rt_FullFrameBuffer");
    expect(copy.origin).toEqual({ x: 0, y: 0 });
    expect(copy.size).toEqual({ width: 1920, height: 600 });
  });

  it("顶层的快照仍是场景目标整张（组外的读快照图层）", async () => {
    const top = image(3, "TF", [0, 0, 0], [100, 100], { passes: [pass("objects/3/passes/0", { framebuffer: true })] });
    const { gpu, scene, state } = await open([image(0, "BG", [960, 540, 0], [1920, 1080]), top]);
    gpu.encode(scene, state);
    expect(gpu.copies).toEqual([
      {
        source: "scene target",
        target: "_rt_FullFrameBuffer",
        origin: { x: 0, y: 0 },
        size: { width: 1920, height: 1080 },
      },
    ]);
  });
});

// ———— P5j：带子层的 fullscreenlayer（全屏组）与组里组合层 compose 的视差 ————

/**
 * `p5j-a` / `p5j-cam`：0 背景、1 全屏组 F（fullscreenlayer，基础材质是 `passthrough` 着色器，这里用图像程序顶替，槽 0 换成合成 RT）、
 * 2 F 的子层 A、3 F 里的组合层 N（带 kbfx）、4 N 的子层 NC；5 顶层对照图像 R（与 F 同原点，视差按根对象的原点）、6 顶层组合层 CLP（带 kbfx、子层 7）、
 * 8 顶层普通组 G（偏离中心）、9 G 里的组合层 M（带 kbfx）、10 M 的子层 MC、11 G 的子层 GC。视差深度都是 8 8（F 的 1 1 以外）。
 */
function fsGroupLayers(
  extra: { copyBackground?: boolean; colorBlendMode?: number; effect?: boolean } = {},
): SceneLayer[] {
  const depth = { parallaxDepth: [8, 8] };
  const fs = baseLayer(1, {
    name: "F",
    size: [2, 2],
    passthroughModel: true,
    fullscreen: true,
    fullscreenSize: "scene",
    copyBackground: extra.copyBackground ?? true,
    subtree: [2, 3, 4],
    colorBlendMode: extra.colorBlendMode ?? 0,
    origin: [1060, 590, 0],
    angles: [0, 0, 0.2],
    scale: [0.8, 0.8, 1],
    passes: [
      pass("objects/1/passes/0", {
        program: PROGRAM.image,
        blending: "translucent",
        runtime: { 0: FRAMEBUFFER_RT },
        framebuffer: true,
      }),
    ],
    effects: extra.effect ? [kbfx(1)] : [],
    ...depth,
  });
  return [
    image(0, "BG", [960, 540, 0], [1920, 1080]),
    fs,
    image(2, "A", [0, 0, 0], [100, 100], { parent: 1, group: 1, ...depth }),
    group(
      3,
      "N",
      { origin: [10, 10, 0], size: [400, 300], effect: true, subtree: [4] },
      { parent: 1, group: 1, ...depth },
    ),
    image(4, "NC", [0, 0, 0], [100, 100], { parent: 3, group: 3, ...depth }),
    image(5, "R", [1060, 590, 0], [100, 100], depth),
    group(6, "CLP", { origin: [1160, 640, 0], size: [400, 300], effect: true, subtree: [7] }, depth),
    image(7, "CC", [0, 0, 0], [100, 100], { parent: 6, group: 6, ...depth }),
    group(8, "G", { origin: [1260, 640, 0], size: [800, 400], effect: true, subtree: [9, 11] }, depth),
    group(
      9,
      "M",
      { origin: [10, 10, 0], size: [300, 300], effect: true, subtree: [10] },
      { parent: 8, group: 8, ...depth },
    ),
    image(10, "MC", [0, 0, 0], [100, 100], { parent: 9, group: 9, ...depth }),
    image(11, "GC", [50, 50, 0], [100, 100], { parent: 8, group: 8, ...depth }),
  ];
}

describe("planLayer：全屏组（p5j-a）", () => {
  it("没有 effect：快照 → 拷贝进合成 RT 0 → 子树 → 基础材质上屏（fullscreen 几何、槽 0 合成 RT、translucent、不内缩）", () => {
    const plan = planLayer(fsGroupLayers()[1], []);
    expect(kinds(plan.steps)).toEqual(["snapshot", "copy", "subtree→c0", "final→scene"]);
    expect(plan.reasons).toEqual([]);
    expect(stepOf(plan, "final")).toMatchObject({
      pass: { key: "objects/1/passes/0" },
      effect: null,
      inputs: { 0: { kind: "composite", index: 0 } },
      geometry: "fullscreen",
      uv: [1, 1],
      inset: [0, 0],
      blending: "translucent",
    });
  });

  it("copybackground: false 的计划相同（不看 copybackground）；colorBlendMode 31 改 additive", () => {
    const a = planLayer(fsGroupLayers()[1], []);
    const b = planLayer(fsGroupLayers({ copyBackground: false })[1], []);
    expect(kinds(b.steps)).toEqual(kinds(a.steps));
    expect(stepOf(b, "final")).toMatchObject({ pass: { key: "objects/1/passes/0" }, blending: "translucent" });
    const add = planLayer(fsGroupLayers({ colorBlendMode: 31 })[1], []);
    expect(stepOf(add, "final").blending).toBe("additive");
  });

  it("有 effect：照现有 fullscreen 的 effect 链上屏（不画基础材质）", () => {
    const plan = planLayer(fsGroupLayers({ effect: true })[1], []);
    expect(kinds(plan.steps)).toEqual(["snapshot", "copy", "subtree→c0", "final→scene"]);
    expect(stepOf(plan, "final").pass.key).toBe("objects/1/effects/0/passes/0");
  });
});

describe("GpuScene：全屏组的视图投影（p5j-cam）", () => {
  async function opened() {
    const opened = await open(fsGroupLayers());
    opened.scene.setParallax({ point: [960, 540], amount: 0.5 }, opened.state);
    opened.scene.update(FRAME, opened.state);
    return opened;
  }
  const vpOf = (scene: GpuScene, object: number, role: string) => [...matrixAt(drawOf(scene, object, role), 64)];

  it("全屏组子孙：视图投影与顶层同写法（带视差，不是局部正交）", async () => {
    const { scene } = await opened();
    const top = vpOf(scene, 5, "direct");
    expect(vpOf(scene, 2, "direct")).toEqual(top);
    expect(top).not.toEqual([...SCENE_VP]);
    const local = [...groupViewProjection([2, 2], worldsOf(fsGroupLayers())(1))];
    expect(vpOf(scene, 2, "direct")).not.toEqual(local);
  });

  it("全屏组里的组合层：compose 不带视差（= 场景视图投影），它的子层仍是局部正交，上屏画回全屏 RT", async () => {
    const { scene } = await opened();
    expect(vpOf(scene, 3, "compose")).toEqual([...SCENE_VP]);
    const layers = fsGroupLayers();
    expect(vpOf(scene, 4, "direct")).toEqual([...groupMvpParts([400, 300], worldsOf(layers)(3))!.projection]);
  });

  it("普通组里的组合层：compose 同样不带视差；普通组的子孙仍是局部正交", async () => {
    const { scene } = await opened();
    expect(vpOf(scene, 9, "compose")).toEqual([...SCENE_VP]);
    const layers = fsGroupLayers();
    expect(vpOf(scene, 11, "direct")).toEqual([...groupMvpParts([800, 400], worldsOf(layers)(8))!.projection]);
  });

  it("顶层组合层的 compose 仍带视差", async () => {
    const { scene } = await opened();
    expect(vpOf(scene, 6, "compose")).not.toEqual([...SCENE_VP]);
    expect(vpOf(scene, 8, "compose")).not.toEqual([...SCENE_VP]);
  });

  it("全屏组的上屏是基础 pass（程序 2、translucent），不是 groupUpload（程序 3）", async () => {
    const { scene } = await opened();
    expect(opKinds(scene, 1)).toEqual(["snapshot", "copy", "subtree", "draw final"]);
    expect(drawOf(scene, 1, "final").pipeline.label).toContain("program 2 translucent");
  });
});

describe("GpuScene：组里的网格（P14b，p14b-gm-basic 抓帧 A:\p14b\gm-basic\gm-basic-frame222.rdc 事件 97）", () => {
  // 组 G（copybackground false）：中心 (900, 560)、缩放 1.25×0.8、转 0.35 rad，800×600；里面的模型层 T1 局部 (−120, 20) 转 0.2 rad。
  // 期望值是 WPE 抓帧里 T1 的 g_ModelMatrix、g_ModelViewProjectionMatrix、g_ViewProjectionMatrix（逐位）
  const T1_MODEL = [
    0.9800665378570557, 0.19866934418678284, 0, 0, -0.19866934418678284, 0.9800665974617004, 0, 0, 0, 0, 1, 0, -120,
    19.999969482421875, 0, 1,
  ];
  const T1_MVP = [
    0.002450166270136833, 0.0006622311775572598, 0, 0, -0.0004966733395121992, 0.0032668886706233025, 0, 0, 0, 0,
    0.0005000000237487257, 0, -0.29999998211860657, 0.06666656583547592, 0.5, 1,
  ];
  const GROUP_P = [
    0.0024999999441206455, 0, 0, 0, 0, 0.0033333334140479565, 0, 0, 0, 0, 0.0005000000237487257, 0, 0, 0, 0.5, 1,
  ];
  /** 网格程序：MVP（0）、视图投影（64）、模型矩阵（128）。 */
  const MESH_PROGRAM = {
    ...program("kbgm", []),
    uniforms: [
      { name: "g_ModelViewProjectionMatrix", type: "mat4x4<f32>", declared: "mat4", offset: 0, size: 64 },
      { name: "g_ViewProjectionMatrix", type: "mat4x4<f32>", declared: "mat4", offset: 64, size: 64 },
      { name: "g_ModelMatrix", type: "mat4x4<f32>", declared: "mat4", offset: 128, size: 64 },
    ],
    uniformBlockSize: 192,
  } as unknown as TranslateResult;
  const MESH = 6;

  function layers(
    groupOrigin = [900, 560, 0],
    bounds = [-131072, -131072, -131072, 131072, 131072, 131072],
  ): SceneLayer[] {
    // 一个四边形网格（格式 0x9：位置 + uv，stride 20），索引 0 1 2 0 2 3
    const vertices = new Uint8Array(4 * 20);
    const indices = new Uint8Array(new Uint16Array([0, 1, 2, 0, 2, 3]).buffer);
    const mesh = {
      format: 0x9,
      stride: 20,
      vertices,
      indices,
      vertexCount: 4,
      indexFormat: "uint16" as const,
      indexCount: 6,
      material: "materials/kbgm_t1.json",
      passes: [pass("objects/2/meshes/0/passes/0", { program: MESH })],
    };
    return [
      image(0, "BG", [960, 540, 0], [1920, 1080]),
      group(
        1,
        "G",
        { origin: groupOrigin, size: [800, 600], angles: [0, 0, 0.35], copyBackground: false, subtree: [2] },
        { scale: [1.25, 0.8, 1] },
      ),
      baseLayer(2, {
        name: "T1",
        parent: 1,
        group: 1,
        origin: [-120, 20, 0],
        angles: [0, 0, 0.2],
        size: [0, 0],
        passes: [],
        model: {
          path: "models/t1.mdl",
          version: 23,
          meshes: [mesh],
          order: [0],
          bounds,
        },
      }),
    ];
  }

  async function opened(sceneLayers = layers()) {
    const gpu = new FakeGpu();
    const bundle = bundleOf(sceneLayers);
    bundle.programs.push(MESH_PROGRAM);
    const state = SceneState.fromBundle(bundle);
    const scene = await GpuScene.build(gpu.device, bundle, state, new Set(), [], { particles: { seed: 1 } });
    scene.update(FRAME, state);
    return { gpu, scene, state };
  }

  it("g_ModelMatrix = inverse(W_组) ⊗ W、g_ViewProjectionMatrix = 组的局部正交、MVP = P ⊗ (inverse(W_组) ⊗ W)，和 WPE 逐位相同", async () => {
    const { scene } = await opened();
    const draw = drawOf(scene, 2, "mesh");
    expect([...matrixAt(draw, 128)]).toEqual(T1_MODEL);
    expect([...matrixAt(draw, 0)]).toEqual(T1_MVP);
    // 局部正交的平移我们是 −0、WPE 是 0，数值相同
    expect([...matrixAt(draw, 64)].map((v) => v + 0)).toEqual(GROUP_P);
  });

  it("组与子层带 x / y 旋转（p14b-gm-rot3d 事件 83 的 R1）：g_ModelMatrix 用 glm 的完整乘法，和 WPE 逐位相同", async () => {
    const R1_MODEL = [
      1.0445585250854492, 0.2117425501346588, 0.2721443772315979, 0, -0.24966877698898315, 0.7952044606208801,
      0.3395810127258301, 0, -0.18975624442100525, -0.555005669593811, 1.1601557731628418, 0, -119.99993896484375,
      20.000030517578125, 15.000015258789062, 1,
    ];
    const R1_MVP = [
      0.0026113963685929775, 0.0007058085175231099, 0.00013607219443656504, 0, -0.0006241719238460064,
      0.0026506816502660513, 0.00016979050997179002, 0, -0.0004743906029034406, -0.0018500189762562513,
      0.0005800779326818883, 0, -0.29999983310699463, 0.06666676700115204, 0.5074999928474426, 1,
    ];
    const rot3d = layers([900, 560, 30]);
    Object.assign(rot3d[1], { angles: [0.3, 0.2, 0.35], scale: [1.25, 0.8, 1.1] });
    Object.assign(rot3d[2], { origin: [-120, 20, 15], angles: [0.4, -0.25, 0.2], scale: [1.1, 0.9, 1.3] });
    const { scene } = await opened(rot3d);
    const draw = drawOf(scene, 2, "mesh");
    expect([...matrixAt(draw, 128)]).toEqual(R1_MODEL);
    expect([...matrixAt(draw, 0)]).toEqual(R1_MVP);
  });

  it("顶层不画、由组的子树画进组的合成 RT（copybackground false：alpha 取 MAX、写 RGBA）", async () => {
    const { gpu, scene, state } = await opened();
    expect(opKinds(scene, 1)).toEqual(["snapshot", "clear", "subtree", "draw final"]);
    const trace = gpu.encode(scene, state);
    const group = trace.indexOf('pass composite 800x600|true|false #0 clear {"r":0,"g":0,"b":0,"a":0}');
    expect(group).toBeGreaterThan(0);
    expect(trace.slice(group + 1, group + 3)).toEqual([
      "pass composite 800x600|true|false #0 load",
      "  pipeline scene program 6 translucent rgba8unorm list max mesh mask 15",
    ]);
    expect(trace.filter((line) => line.includes("program 6"))).toHaveLength(1);
  });

  it("组在画面外、模型的场景空间外接球在场景视锥外：照画进组 RT，不按场景相机剔除（D1，和 WPE 有意不同）", async () => {
    // 组中心 (−3000, 560)：T1 的世界位置在场景左边很远，包围盒 ±50
    const { gpu, scene, state } = await opened(layers([-3000, 560, 0], [-50, -50, -1, 50, 50, 1]));
    const trace = gpu.encode(scene, state);
    expect(trace.filter((line) => line.includes("program 6"))).toHaveLength(1);
  });
});
