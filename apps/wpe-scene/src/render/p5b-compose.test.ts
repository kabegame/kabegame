/**
 * P5b 步骤 2 的渲染侧单测（`.claude/plans/wpe-import/3-scene/phase5/phase-5b-modelflags.md`「步骤 2」）：不带子层的组合层。
 * - 渲染图（`planLayer`）：`copyBackground` 两种基础 pass（`compose` 绘制 / `clear` 步骤）、不画的情况、colorBlendMode 混合上屏、
 *   合成 RT 按 size、上屏不内缩、快照照规则 1（composelayer 材质的槽 0 是 `_rt_FullFrameBuffer`）；
 * - 矩阵（`drawMatrices` 的 `compose` 角色）：和 WPE 抓帧的基础 pass 常量比；
 * - GpuScene 假设备：compose 绘制的 uniform、`clear` op 与编码轨迹、不画的层没有 op、运行时开关 effect 切到空计划。
 *
 * 工程 `p5b-cl`（`ignore/p5/b0/gen_b.py` 的 `p_cl`）：正交 1920×1080，五个 composelayer，size 600×300、angles z 0.4（CL5 除外）：
 * CL1 origin (500, 300)，`copybackground` 缺省，挂 `kbfx`（一个 pass）；CL2 (1400, 300)，`copybackground: false`，挂 `kbfx`；
 * CL3 (500, 800)，没有 effect；CL4 (1400, 800)，挂 `kbfx`，colorBlendMode 2；CL5 (960, 540)、200×200、`copybackground: true`、没有 effect。
 * `p5b-proj` / `p5b-proj-720`（`p_proj`）：projectlayer 放在场景中心，挂 `kbfx`，正交 1920×1080 / 1280×720，尺寸取正交投影。
 * `p5b-grp-par`：带视差的组（amount 0.5、delay 0、mouseinfluence 0，视差点 (960, 540)），组原点 (1260, 640)、深度 1 1、
 * angles z 0.2、size 800×400；它在 WPE 里带子层，这里只取组自己的基础 pass（视差只作用在组本身，p5-REPORT `p5b-grp-par`）。
 *
 * 矩阵真值是 WPE 抓帧（`ignore/p5/b2/compose_fixture.json`，由 `fixture_compose.py` 从 `ignore/p5/b0/out/dump_b.json` 取出，
 * float32 原值，16 个数按列主序、第 12、13 个是平移，和 `Mat4` 同一约定）。只比 x、y 两行与平移（下标 0、1、4、5、12、13）：
 * z 的映射两边不同（WPE 的深度范围另有约定，P5d 再核对）。期望非 0 的元素比相对误差 < 1e-5，期望为 0 的比绝对误差 < 1e-7。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generalDefaults } from "../compile/bindings";
import { FRAMEBUFFER_RT, type SceneBundle, type SceneEffect, type SceneLayer, type ScenePass } from "../compile/bundle";
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
import { multiply, translation, type Mat4 } from "./math";
import { parallaxOffset } from "./parallax";
import { GpuScene } from "./scene";
import { SceneState } from "./state";
import { drawMatrices, type FrameInput } from "./uniforms";

vi.mock("./device", () => ({ acquireGpu: vi.fn() }));
vi.mock("../fileUrl", () => ({ fileToUrl: (path: string) => path }));

// ———— WPE 真值 ————

/** WPE 抓帧里的 `g_ModelViewProjectionMatrix`（`compose_fixture.json`，16 个 float32，列主序）。 */
const WPE_MVP = {
  /** `p5b-cl` 事件 62：CL1 的 composelayer 基础 pass（合成 RT 600×300，关混合、写掩码 RGBA）；事件 82 CL1 上屏同值。 */
  cl1: [
    0.0009594385628588498, 0.0007211450720205903, 0, 0, -0.0004056441248394549, 0.0017056684009730816, 0, 0, 0, 0,
    0.0002500000118743628, 0, -0.4791666269302368, -0.444444477558136, 0.5, 1,
  ],
  /** `p5b-cl` 事件 113：CL2（`copybackground: false`）上屏；它没有基础 draw，事件 94 是一次 Clear。 */
  cl2Final: [
    0.0009594385628588498, 0.0007211450720205903, 0, 0, -0.0004056441248394549, 0.0017056684009730816, 0, 0, 0, 0,
    0.0002500000118743628, 0, 0.4583333730697632, -0.444444477558136, 0.5, 1,
  ],
  /** `p5b-cl` 事件 132：CL4（colorBlendMode 2）的 composelayer 基础 pass；事件 174 是它的 passthrough 上屏，同值。 */
  cl4: [
    0.0009594385628588498, 0.0007211450720205903, 0, 0, -0.0004056441248394549, 0.0017056684009730816, 0, 0, 0, 0,
    0.0002500000118743628, 0, 0.4583333730697632, 0.4814814329147339, 0.5, 1,
  ],
  /** `p5b-grp-par` 事件 62：带视差的组的基础 pass（合成 RT 800×400），视差偏移 (150, 50)。 */
  grpPar: [
    0.001020902767777443, 0.00036790614831261337, 0, 0, -0.00020694722479674965, 0.0018149381503462791, 0, 0, 0, 0,
    0.0002500000118743628, 0, 0.46875011920928955, 0.2777777910232544, 0.5, 1,
  ],
  /** `p5b-proj` 事件 62：projectlayer 的基础 pass（合成 RT 1920×1080）；事件 82 上屏同值。 */
  proj: [0.0010416667209938169, 0, 0, 0, 0, 0.0018518518190830946, 0, 0, 0, 0, 0.0002500000118743628, 0, 0, 0, 0.5, 1],
  /** `p5b-proj-720` 事件 62：正交 1280×720 的 projectlayer（合成 RT 1280×720）；事件 82 上屏同值。 */
  proj720: [
    0.0015625000232830644, 0, 0, 0, 0, 0.0027777778450399637, 0, 0, 0, 0, 0.0002500000118743628, 0, 0, 0, 0.5, 1,
  ],
} as const;

/** 比较的下标：x、y 两行（第 0、1 列）与平移。 */
const COMPARED = [0, 1, 4, 5, 12, 13];

/** 每个比较元素的误差：期望非 0 时是相对误差，期望为 0 时是绝对误差（单独判）。 */
function matrixErrors(actual: ArrayLike<number>, expected: readonly number[]) {
  const relative: number[] = [];
  const absolute: number[] = [];
  for (const i of COMPARED) {
    const diff = Math.abs(actual[i] - expected[i]);
    if (expected[i] === 0) absolute.push(diff);
    else relative.push(diff / Math.abs(expected[i]));
  }
  return { relative: Math.max(0, ...relative), absolute: Math.max(0, ...absolute) };
}
function expectMvp(actual: ArrayLike<number>, expected: readonly number[], label: string) {
  const { relative, absolute } = matrixErrors(actual, expected);
  expect(relative, `${label} 相对误差`).toBeLessThan(1e-5);
  expect(absolute, `${label} 绝对误差（期望为 0 的元素）`).toBeLessThan(1e-7);
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

/** 程序下标：composelayer、effect（kbfx）、passthrough（colorBlendMode 混合上屏）。 */
const PROGRAM = { compose: 0, effect: 1, passthrough: 2 } as const;

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

interface ComposeDef {
  origin: number[];
  size: number[];
  angles?: number[];
  copyBackground?: boolean;
  effect?: boolean;
  colorBlendMode?: number;
}

/** 一个组合层：基础材质是 WPE 的 `materials/util/composelayer.json`（槽 0 `_rt_FullFrameBuffer`、translucent）。 */
function composeLayer(object: number, name: string, def: ComposeDef, extra: Partial<SceneLayer> = {}): SceneLayer {
  const colorBlendMode = def.colorBlendMode ?? 0;
  return {
    id: object + 10,
    object,
    parent: null,
    name,
    origin: def.origin,
    scale: [1, 1, 1],
    angles: def.angles ?? [0, 0, 0],
    size: def.size,
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
    passthroughModel: true,
    group: null,
    subtree: [],
    groupUpload: null,
    copyBackground: def.copyBackground ?? true,
    fullscreen: false,
    fullscreenSize: null,
    passes: [
      pass(`objects/${object}/passes/0`, {
        program: PROGRAM.compose,
        runtime: { 0: FRAMEBUFFER_RT },
        framebuffer: true,
      }),
    ],
    colorBlendMode,
    effects: def.effect ? [kbfx(object)] : [],
    // colorBlendMode 混合的上屏材质（effectpassthrough）：槽 0 合成 RT（渲染图填）、槽 1 快照，g_Color4 置 1
    passthrough:
      colorBlendMode !== 0 && colorBlendMode !== 31
        ? pass(`objects/${object}/passthrough`, {
            program: PROGRAM.passthrough,
            runtime: { 1: FRAMEBUFFER_RT },
            framebuffer: true,
            uniforms: { g_Color4: [1, 1, 1, 1] },
          })
        : null,
    particle: null,
    ...extra,
  };
}

/** `p5b-cl` 的五层（`objects` 下标 0–4）。 */
const CL: Record<"CL1" | "CL2" | "CL3" | "CL4" | "CL5", ComposeDef> = {
  CL1: { origin: [500, 300, 0], size: [600, 300], angles: [0, 0, 0.4], effect: true },
  CL2: { origin: [1400, 300, 0], size: [600, 300], angles: [0, 0, 0.4], effect: true, copyBackground: false },
  CL3: { origin: [500, 800, 0], size: [600, 300], angles: [0, 0, 0.4] },
  CL4: { origin: [1400, 800, 0], size: [600, 300], angles: [0, 0, 0.4], effect: true, colorBlendMode: 2 },
  CL5: { origin: [960, 540, 0], size: [200, 200], copyBackground: true },
};
const CL_NAMES = Object.keys(CL) as (keyof typeof CL)[];
const clLayer = (name: keyof typeof CL) => composeLayer(CL_NAMES.indexOf(name), name, CL[name]);
/** `p5b-proj`：projectlayer（尺寸已由编译期取成正交投影宽高）。 */
const projLayer = (width: number, height: number) =>
  composeLayer(0, "PL", { origin: [width / 2, height / 2, 0], size: [width, height], effect: true });
/** `p5b-grp-par` 的组（只取组本身，带一个 effect）。 */
const grpLayer = () =>
  composeLayer(0, "GRP", { origin: [1260, 640, 0], size: [800, 400], angles: [0, 0, 0.2], effect: true });

const draws = (steps: LayerStep[]) => steps.filter((step): step is DrawStep => step.kind === "draw");
const targetName = (target: { kind: string; index?: number; name?: string }) =>
  target.kind === "composite" ? `c${target.index}` : target.kind === "fbo" ? target.name : "scene";
const kinds = (steps: LayerStep[]) =>
  steps.map((step) =>
    step.kind === "draw"
      ? `${step.role}→${targetName(step.target)}`
      : step.kind === "clear"
        ? `clear→${targetName(step.target)}`
        : step.kind,
  );
const stepOf = (plan: LayerPlan, role: string) => draws(plan.steps).find((step) => step.role === role)!;

describe("planLayer：不带子层的组合层（p5b-cl、p5b-proj）", () => {
  it("CL1（copybackground 缺省 + kbfx）：快照 → compose 画进合成 RT 0 → effect 末 pass 上屏", () => {
    const plan = planLayer(clLayer("CL1"), []);
    expect(kinds(plan.steps)).toEqual(["snapshot", "compose→c0", "final→scene"]);
    expect(plan.composite).toEqual({ count: 1, width: 600, height: 300 });
    expect(plan.reasons).toEqual([]);
    // 基础 pass：基础材质本身、图层四边形、UV 0–1 不内缩、关混合；槽 0 读快照
    expect(stepOf(plan, "compose")).toMatchObject({
      pass: { key: "objects/0/passes/0" },
      effect: null,
      geometry: "layer",
      uv: [1, 1],
      inset: [0, 0],
      blending: null,
      inputs: { 0: { kind: "framebuffer" } },
    });
    // 上屏：图层四边形、不内缩、借基础材质的 translucent，槽 0 读合成 RT 0
    expect(stepOf(plan, "final")).toMatchObject({
      geometry: "layer",
      uv: [1, 1],
      inset: [0, 0],
      blending: "translucent",
      inputs: { 0: { kind: "composite", index: 0 } },
    });
  });

  it("CL2（copybackground: false + kbfx）：快照照拷 → 合成 RT 0 清成透明 → effect 末 pass 上屏，没有基础绘制", () => {
    const plan = planLayer(clLayer("CL2"), []);
    expect(kinds(plan.steps)).toEqual(["snapshot", "clear→c0", "final→scene"]);
    expect(plan.composite).toEqual({ count: 1, width: 600, height: 300 });
    expect(draws(plan.steps).map((step) => step.role)).toEqual(["final"]);
    expect(stepOf(plan, "final")).toMatchObject({ inset: [0, 0], inputs: { 0: { kind: "composite", index: 0 } } });
  });

  it("CL3、CL5（没有 effect、colorBlendMode 0）：空计划，不拷快照、不分配合成 RT", () => {
    for (const name of ["CL3", "CL5"] as const) {
      const plan = planLayer(clLayer(name), []);
      expect(plan, name).toEqual({ composite: null, steps: [], reasons: [] });
    }
    // colorBlendMode 31 同样不画；copybackground: false 也一样
    expect(planLayer(composeLayer(0, "a", { ...CL.CL3, colorBlendMode: 31 }), []).steps).toEqual([]);
    expect(planLayer(composeLayer(0, "b", { ...CL.CL3, copyBackground: false }), []).steps).toEqual([]);
  });

  it("CL4（kbfx + colorBlendMode 2）：compose → effect 留在合成 RT 1 → passthrough 上屏，不内缩", () => {
    const plan = planLayer(clLayer("CL4"), []);
    expect(kinds(plan.steps)).toEqual(["snapshot", "compose→c0", "effect→c1", "passthrough→scene"]);
    expect(plan.composite).toEqual({ count: 2, width: 600, height: 300 });
    expect(stepOf(plan, "effect")).toMatchObject({
      geometry: "fullscreen",
      inputs: { 0: { kind: "composite", index: 0 } },
    });
    expect(stepOf(plan, "passthrough")).toMatchObject({
      geometry: "layer",
      inset: [0, 0],
      blending: "translucent",
      inputs: { 0: { kind: "composite", index: 1 }, 1: { kind: "framebuffer" } },
    });
  });

  it("colorBlendMode 2、没有 effect：照样走合成（compose → passthrough）", () => {
    const plan = planLayer(composeLayer(0, "cbm", { ...CL.CL3, colorBlendMode: 2 }), []);
    expect(kinds(plan.steps)).toEqual(["snapshot", "compose→c0", "passthrough→scene"]);
    expect(plan.composite).toEqual({ count: 1, width: 600, height: 300 });
  });

  it("PL（projectlayer + kbfx）：同 CL1，合成 RT = size（1920×1080、1280×720）", () => {
    for (const [w, h] of [
      [1920, 1080],
      [1280, 720],
    ]) {
      const plan = planLayer(projLayer(w, h), []);
      expect(kinds(plan.steps)).toEqual(["snapshot", "compose→c0", "final→scene"]);
      expect(plan.composite).toEqual({ count: 1, width: w, height: h });
      expect(stepOf(plan, "final").inset).toEqual([0, 0]);
    }
  });

  it("合成 RT 按 size、不看纹理：基础材质槽 0 有静态纹理时也一样", () => {
    const texture = { width: 48, height: 40, textureWidth: 64, textureHeight: 64 };
    expect(
      compositeSize(
        { size: [600, 300], solidLayer: false, instanced: false, passthroughModel: true, fullscreenSize: null },
        texture,
      ),
    ).toEqual([600, 300]);
    expect(
      compositeSize(
        { size: [600, 300], solidLayer: false, instanced: false, passthroughModel: false, fullscreenSize: null },
        texture,
      ),
    ).toEqual([48, 40]);
    // 有静态纹理的自写组合层：compose 的 UV 仍是 0–1（着色器按它铺满合成 RT），上屏仍不内缩
    const layer = clLayer("CL1");
    layer.passes[0] = { ...layer.passes[0], textures: { 1: 0 } };
    const plan = planLayer(layer, [texture]);
    expect(plan.composite).toMatchObject({ width: 600, height: 300 });
    expect(stepOf(plan, "compose")).toMatchObject({ uv: [1, 1], inset: [0, 0] });
  });

  it("签名：clear 进签名，copybackground 两种的签名不同", () => {
    const one = planSignature(planLayer(clLayer("CL1"), []));
    const off = planSignature(planLayer(composeLayer(0, "CL1", { ...CL.CL1, copyBackground: false }), []));
    expect(off).toContain('"kind":"clear"');
    expect(off).not.toBe(one);
  });

  it("variantPlans：可变 effect 全关时那一份是空计划，开着时是 compose → 上屏", () => {
    const layer = composeLayer(0, "CL1", CL.CL1, { effects: [kbfx(0, { visibleBound: true })] });
    const plans = variantPlans(layer, []);
    expect(plans.map((plan) => kinds(plan.steps))).toEqual([
      ["snapshot", "compose→c0", "final→scene"],
      [],
      ["snapshot", "compose→c0", "final→scene"],
    ]);
    expect(plans[1].composite).toBeNull();
    // copybackground: false 的一样：全关是空计划
    const cleared = composeLayer(0, "CL2", CL.CL2, { effects: [kbfx(0, { visibleBound: true })] });
    expect(variantPlans(cleared, []).map((plan) => kinds(plan.steps))).toEqual([
      ["snapshot", "clear→c0", "final→scene"],
      [],
      ["snapshot", "clear→c0", "final→scene"],
    ]);
  });
});

// ———— 矩阵：compose 角色对上 WPE 的基础 pass ————

const general = (width: number, height: number) => ({ width, height });
/** 图层的世界矩阵（没有父层）。 */
const worldOf = (layer: SceneLayer): Mat4 =>
  worldMatrixOf(
    0,
    new Map([[0, { origin: layer.origin, angles: layer.angles, scale: layer.scale, parent: null }]]),
    new Map(),
  );

describe("drawMatrices 的 compose 角色：图层 MVP = 场景视图投影 · 视差 · W（WPE 抓帧）", () => {
  it.each<[string, () => SceneLayer, [number, number], readonly number[]]>([
    ["p5b-cl CL1（事件 62）", () => clLayer("CL1"), [1920, 1080], WPE_MVP.cl1],
    ["p5b-cl CL4（事件 132）", () => clLayer("CL4"), [1920, 1080], WPE_MVP.cl4],
    ["p5b-proj（事件 62）", () => projLayer(1920, 1080), [1920, 1080], WPE_MVP.proj],
    ["p5b-proj-720（事件 62）", () => projLayer(1280, 720), [1280, 720], WPE_MVP.proj720],
  ])("%s", (_name, make, [w, h], expected) => {
    const layer = make();
    const { modelViewProjection, model, viewProjection } = drawMatrices(
      { role: "compose" },
      worldOf(layer),
      layer.size,
      sceneViewProjection(general(w, h)),
    );
    expectMvp(modelViewProjection, expected, _name);
    expect([...model]).toEqual([...worldOf(layer)]);
    expect([...viewProjection]).toEqual([...sceneViewProjection(general(w, h))]);
  });

  it("p5b-grp-par（事件 62）：视差平移 (150, 50) 右乘在视图投影里", () => {
    const layer = grpLayer();
    const [ox, oy] = parallaxOffset(0.5, layer.parallaxDepth, layer.origin, [960, 540]);
    expect([ox, oy]).toEqual([150, 50]);
    const viewProjection = multiply(sceneViewProjection(general(1920, 1080)), translation(ox, oy, 0));
    const { modelViewProjection } = drawMatrices({ role: "compose" }, worldOf(layer), layer.size, viewProjection);
    expectMvp(modelViewProjection, WPE_MVP.grpPar, "p5b-grp-par");
  });

  it("compose 与上屏（final / passthrough）的 MVP 相同：p5b-cl 事件 82 / 113 / 174", () => {
    const vp = sceneViewProjection(general(1920, 1080));
    for (const [name, role, expected] of [
      ["CL1", "final", WPE_MVP.cl1],
      ["CL2", "final", WPE_MVP.cl2Final],
      ["CL4", "passthrough", WPE_MVP.cl4],
    ] as const) {
      const layer = clLayer(name);
      const world = worldOf(layer);
      const compose = drawMatrices({ role: "compose" }, world, layer.size, vp).modelViewProjection;
      expect([...drawMatrices({ role }, world, layer.size, vp).modelViewProjection]).toEqual([...compose]);
      expectMvp(compose, expected, `${name} ${role}`);
    }
  });

  it("和普通基础 pass 不同：base 是铺满合成 RT 的整面正交，compose 跟着图层走", () => {
    const layer = clLayer("CL1");
    const vp = sceneViewProjection(general(1920, 1080));
    const base = drawMatrices({ role: "base" }, worldOf(layer), layer.size, vp).modelViewProjection;
    expect(matrixErrors(base, WPE_MVP.cl1).relative).toBeGreaterThan(0.1);
  });
});

// ———— GpuScene：compose 的 uniform、clear 的 op 与编码 ————

interface FakeBuffer {
  label: string;
  bytes: Uint8Array;
  destroy(): void;
}

/** 假设备：记缓冲字节（uniform 读回）与一帧的编码轨迹（目标与清屏值、管线、绘制、拷贝）。 */
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
        copyTextureToTexture: (source: { texture: { label: string } }, target: { texture: { label: string } }) => {
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

function bundleOf(layers: SceneLayer[], width = 1920, height = 1080): SceneBundle {
  return {
    general: {
      width,
      height,
      fields: generalDefaults(),
      clearVariable: false,
      perspectiveOverrideFov: particleFov(undefined),
      postprocess: { level: "disabled", bloomFlag: false, hdrFlag: false, bloom: false, hdr: false },
      bloom: { ...BLOOM_DEFAULTS, tint: [1, 1, 1] },
    },
    layers,
    programs: [program("composelayer", [0]), program("kbfx", [0]), program("passthrough", [0, 1])],
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
  step: DrawStep;
  pipeline: { label: string };
  uniformBuffer: FakeBuffer | null;
}
interface RuntimeView {
  object: number;
  ops: { kind: string; draw?: DrawView; target?: { kind: string; index?: number } }[];
  draws: DrawView[];
}
const internals = (scene: GpuScene) => scene as unknown as { layers: RuntimeView[]; draws: Set<DrawView> };
const runtimeOf = (scene: GpuScene, object: number) => internals(scene).layers.find((item) => item.object === object);
const opKinds = (runtime: RuntimeView | undefined) =>
  runtime?.ops.map((op) => (op.kind === "draw" ? `draw ${op.draw!.step.role}` : op.kind)) ?? null;
const mvpOf = (draw: DrawView): Float32Array => new Float32Array(draw.uniformBuffer!.bytes.buffer.slice(0, 64));
function drawOf(scene: GpuScene, object: number, role: string): DrawView {
  const draw = [...internals(scene).draws].find((item) => item.object === object && item.step.role === role);
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

describe("GpuScene：p5b-cl 五个组合层", () => {
  const clBundle = () => bundleOf(CL_NAMES.map(clLayer));

  it("每层的 op：CL1 compose → 上屏，CL2 clear → 上屏（没有基础绘制），CL3 / CL5 没有 op，CL4 compose → effect → passthrough", async () => {
    const { scene } = await open(clBundle());
    expect(opKinds(runtimeOf(scene, 0))).toEqual(["snapshot", "draw compose", "draw final"]);
    expect(opKinds(runtimeOf(scene, 1))).toEqual(["snapshot", "clear", "draw final"]);
    expect(runtimeOf(scene, 1)!.ops[1].target).toEqual({ kind: "composite", index: 0 });
    expect(runtimeOf(scene, 1)!.draws.map((draw) => draw.step.role)).toEqual(["final"]);
    expect(opKinds(runtimeOf(scene, 2))).toEqual([]);
    expect(runtimeOf(scene, 2)!.draws).toEqual([]);
    expect(opKinds(runtimeOf(scene, 3))).toEqual(["snapshot", "draw compose", "draw effect", "draw passthrough"]);
    expect(opKinds(runtimeOf(scene, 4))).toEqual([]);
    expect(runtimeOf(scene, 4)!.draws).toEqual([]);
  });

  it("CL1 的 compose 绘制：uniform 里的 MVP 对上 WPE 事件 62，上屏同值（事件 82）；CL4 的 compose 对上事件 132", async () => {
    const { scene, state } = await open(clBundle());
    scene.update(FRAME, state);
    expectMvp(mvpOf(drawOf(scene, 0, "compose")), WPE_MVP.cl1, "CL1 compose");
    expectMvp(mvpOf(drawOf(scene, 0, "final")), WPE_MVP.cl1, "CL1 final");
    expectMvp(mvpOf(drawOf(scene, 1, "final")), WPE_MVP.cl2Final, "CL2 final");
    expectMvp(mvpOf(drawOf(scene, 3, "compose")), WPE_MVP.cl4, "CL4 compose");
    expectMvp(mvpOf(drawOf(scene, 3, "passthrough")), WPE_MVP.cl4, "CL4 passthrough");
    // 和纯函数逐字节相同
    const layer = clLayer("CL1");
    const expected = drawMatrices(
      { role: "compose" },
      worldOf(layer),
      layer.size,
      sceneViewProjection(general(1920, 1080)),
    ).modelViewProjection;
    expect(Buffer.from(mvpOf(drawOf(scene, 0, "compose")).buffer).toString("hex")).toBe(
      Buffer.from(expected.buffer, expected.byteOffset, expected.byteLength).toString("hex"),
    );
  });

  it("管线：compose 关混合、写 RGBA（同 WPE 事件 62 的写掩码 15）；上屏 translucent、写 RGB", async () => {
    const { scene } = await open(clBundle());
    expect(drawOf(scene, 0, "compose").pipeline.label).toBe("scene program 0 opaque rgba8unorm mask 15");
    expect(drawOf(scene, 0, "final").pipeline.label).toBe("scene program 1 translucent rgba8unorm mask 7");
  });

  it("一帧的编码：CL2 先结束场景 pass，再把合成 RT 0 清成 (0, 0, 0, 0)；CL3、CL5 不出现", async () => {
    const { gpu, scene, state } = await open(clBundle());
    scene.update(FRAME, state);
    gpu.trace.length = 0;
    scene.encode(gpu.device.createCommandEncoder(), state);
    const composite0 = "composite 600x300|true|false #0";
    const composite1 = "composite 600x300|true|false #1";
    const snapshot = "copy scene target -> _rt_FullFrameBuffer";
    const opaque = "  pipeline scene program 0 opaque rgba8unorm mask 15";
    const final = "  pipeline scene program 1 translucent rgba8unorm mask 7";
    expect(gpu.trace).toEqual([
      // CL1：快照之前先清一次场景目标
      'pass scene target clear {"r":0,"g":0,"b":0,"a":1}',
      snapshot,
      `pass ${composite0} load`,
      opaque,
      "  draw layer 10 CL1 compose",
      "pass scene target load",
      final,
      "  draw layer 10 CL1 final",
      // CL2：没有基础绘制，合成 RT 0 清成透明
      snapshot,
      `pass ${composite0} clear {"r":0,"g":0,"b":0,"a":0}`,
      "pass scene target load",
      final,
      "  draw layer 11 CL2 final",
      // CL4：compose → effect（合成 RT 1）→ passthrough 上屏
      snapshot,
      `pass ${composite0} load`,
      opaque,
      "  draw layer 13 CL4 compose",
      `pass ${composite1} load`,
      "  pipeline scene program 1 normal rgba8unorm mask 15",
      "  draw layer 13 CL4 effect",
      "pass scene target load",
      "  pipeline scene program 2 translucent rgba8unorm mask 7",
      "  draw layer 13 CL4 passthrough",
    ]);
  });

  it("运行时把 effect 全关：图层重建成空计划（没有 op、没有 draw），再打开回到 compose → 上屏", async () => {
    const layers = CL_NAMES.map(clLayer);
    layers[0].effects = [kbfx(0, { visibleBound: true })];
    layers[1].effects = [kbfx(1, { visibleBound: true })];
    const { gpu, scene, state } = await open(bundleOf(layers));
    const toggle = (object: number, value: boolean) =>
      state.write({ property: "p", target: { kind: "effect", object, effect: 0 } }, value);
    toggle(0, false);
    toggle(1, false);
    scene.sync(state);
    scene.update(FRAME, state);
    expect(opKinds(runtimeOf(scene, 0))).toEqual([]);
    expect(runtimeOf(scene, 0)!.draws).toEqual([]);
    expect(opKinds(runtimeOf(scene, 1))).toEqual([]);
    gpu.trace.length = 0;
    scene.encode(gpu.device.createCommandEncoder(), state);
    expect(gpu.trace.filter((line) => /CL1|CL2|clear \{"r":0,"g":0,"b":0,"a":0\}/.test(line))).toEqual([]);
    toggle(0, true);
    toggle(1, true);
    scene.sync(state);
    scene.update(FRAME, state);
    expect(opKinds(runtimeOf(scene, 0))).toEqual(["snapshot", "draw compose", "draw final"]);
    expect(opKinds(runtimeOf(scene, 1))).toEqual(["snapshot", "clear", "draw final"]);
    expectMvp(mvpOf(drawOf(scene, 0, "compose")), WPE_MVP.cl1, "CL1 compose（重建后）");
  });
});

describe("GpuScene：projectlayer 与带视差的组", () => {
  it("p5b-proj / p5b-proj-720：compose 的 MVP 对上 WPE 事件 62，合成 RT = 正交投影尺寸", async () => {
    for (const [w, h, expected] of [
      [1920, 1080, WPE_MVP.proj],
      [1280, 720, WPE_MVP.proj720],
    ] as const) {
      const { gpu, scene, state } = await open(bundleOf([projLayer(w, h)], w, h));
      scene.update(FRAME, state);
      expectMvp(mvpOf(drawOf(scene, 0, "compose")), expected, `proj ${w}×${h}`);
      gpu.trace.length = 0;
      scene.encode(gpu.device.createCommandEncoder(), state);
      expect(gpu.trace).toContain(`pass composite ${w}x${h}|true|false #0 load`);
    }
  });

  it("p5b-grp-par：开着视差时 compose 的 MVP 带组自己的偏移 (150, 50)，对上 WPE 事件 62", async () => {
    const { scene, state } = await open(bundleOf([grpLayer()]));
    scene.setParallax({ point: [960, 540], amount: 0.5 }, state);
    scene.update(FRAME, state);
    expectMvp(mvpOf(drawOf(scene, 0, "compose")), WPE_MVP.grpPar, "grp-par compose");
    // 上屏同一份（WPE 实测组的基础 pass 与上屏都带偏移）
    expectMvp(mvpOf(drawOf(scene, 0, "final")), WPE_MVP.grpPar, "grp-par final");
  });
});
