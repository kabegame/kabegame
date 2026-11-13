/**
 * P6b 1d 的渲染侧单测（`.claude/plans/wpe-import/3-scene/phase6/phase-6b-text.md`「1d」）：文本层成为图层的一种。
 * - 渲染图（`planLayer` 的文本分支）：直接上屏（有 / 没有背景、有 / 没有彩色字形）、合成的两种 RT 初值（`composelayer_clearalpha` /
 *   清成背景色）、colorBlendMode 31 与其它非 0、空排版与缺排版；
 * - 矩阵（`textMatrices`）：和 WPE 抓帧（`p6b-fx`，A:\p6b\p6b-fx\p6b-fx-frame181.rdc，`ignore/p6/b0/out/rd/dump.json`）的 MVP 比；
 * - GpuScene 假设备：每层的 op、管线（三角形列表）、编码轨迹（索引格式与个数、绑定的图集）、清屏色、uniform 里的矩阵、图集的上传与
 *   增量上传、背景色的就地写、文本层的 effect 开关走重编译；
 * - 有 wasm 与 `KABEGAME_WPE_ROOT` 时：用 1c 的基线（`text/fixtures/p6b.json`）把 p6b 六个工程整个排一遍，经图层世界矩阵（含对齐偏移）
 *   与 `textMatrices` 算出的排版原点、合成 RT 里的原点、合成四边形中心和 WPE 相同。
 *
 * 抓帧的真值（列主序 16 个 float32，第 12、13 个是平移）：f1–f3、f5 带一个 effect（`padding` 0、20、600、32），f4 开背景不带
 * effect，f5 开背景带 effect，f6 colorBlendMode 31。由抓帧反推的文字框（RobotoMono 32 号 `"Ag"`）：minX 0、minY −36、maxX 149、
 * maxY 140；f3（12 号）：minX 0、minY −13、maxX 56、maxY 53。
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generalDefaults } from "../compile/bindings";
import { FRAMEBUFFER_RT, type SceneBundle, type SceneEffect, type SceneLayer, type ScenePass } from "../compile/bundle";
import { particleFov } from "../compile/particles";
import { BLOOM_DEFAULTS } from "../compile/postprocess";
import type { SceneText } from "../compile/texts";
import { GlyphAtlas, TextAtlases, type AtlasGlyph } from "../text/atlas";
import { SYSTEM_FONT_PREFIX, TextFonts, type FontPath } from "../text/fonts";
import fixture from "../text/fixtures/p6b.json";
import {
  compositeTranslation,
  directTranslation,
  layoutText,
  TEXT_DEFAULTS,
  type TextFields,
  type TextLayout,
  type TextQuad,
} from "../text/layout";
import { textVertices } from "../text/mesh";
import { PIXEL_MODE_BGRA, PIXEL_MODE_GRAY, Wpefont } from "../wpefont";
import type { TranslateResult } from "../wpesl2wgsl";
import { planLayer, planSignature, textCompositeSize, variantPlans, type LayerPlan, type LayerStep } from "./graph";
import { drawMatrixOf, sceneViewProjection } from "./layout";
import { multiply, transformPoint, translation, type Mat4 } from "./math";
import { GpuScene } from "./scene";
import { SceneState } from "./state";
import { textIndexData } from "./text";
import { textMatrices, type FrameInput } from "./uniforms";

vi.mock("./device", () => ({ acquireGpu: vi.fn() }));
vi.mock("../fileUrl", () => ({ fileToUrl: (path: string) => path }));

const f = Math.fround;

// ———— WPE 真值（p6b-fx 第 181 帧）————

const WPE_MVP = {
  /** f1 事件 65：字形画进合成 RT 149×176（`padding` 0）。 */
  f1Glyphs: [
    0.01342281885445118, 0, 0, 0, 0, 0.011363636702299118, 0, 0, 0, 0, 0.0005000000237487257, 0, -1,
    -0.5909090638160706, 0.5, 1,
  ],
  /** f1 事件 47：`composelayer_clearalpha` 画进合成 RT（图层 MVP，图层四边形 ±74.5 × ±88）；事件 82 末 pass 上屏同值。 */
  f1Compose: [
    0.0010416667209938169, 0, 0, 0, 0, 0.0018518518190830946, 0, 0, 0, 0, 0.0002500000118743628, 0, -0.5833333134651184,
    0.5407407283782959, 0.5, 1,
  ],
  /** f2 事件 118：合成 RT 189×216（`padding` 20）。 */
  f2Glyphs: [
    0.010582010261714458, 0, 0, 0, 0, 0.009259259328246117, 0, 0, 0, 0, 0.0005000000237487257, 0, -0.7883597612380981,
    -0.48148149251937866, 0.5, 1,
  ],
  /** f3 事件 171：合成 RT 1080×1090（`padding` 600 钳到 512，12 号）。 */
  f3Glyphs: [
    0.0018518518190830946, 0, 0, 0, 0, 0.0018348623998463154, 0, 0, 0, 0, 0.0005000000237487257, 0,
    -0.051851868629455566, -0.03669726848602295, 0.5, 1,
  ],
  /** f4 事件 203：直接上屏的背景（`flat`，四边形 [0, 213] × [0, 240]）。 */
  f4Background: [
    0.0010416667209938169, 0, 0, 0, 0, 0.0018518518190830946, 0, 0, 0, 0, 0.0002500000118743628, 0, -0.6942708492279053,
    -0.5148148536682129, 0.5, 1,
  ],
  /** f4 事件 219：直接上屏的字形。 */
  f4Glyphs: [
    0.0010416667209938169, 0, 0, 0, 0, 0.0018518518190830946, 0, 0, 0, 0, 0.0002500000118743628, 0, -0.660937488079071,
    -0.3888888955116272, 0.5, 1,
  ],
  /** f5 事件 240：开背景、带 effect，字形画进合成 RT 213×240。 */
  f5Glyphs: [
    0.009389671497046947, 0, 0, 0, 0, 0.008333333767950535, 0, 0, 0, 0, 0.0005000000237487257, 0, -0.6995304822921753,
    -0.43333327770233154, 0.5, 1,
  ],
  /** f6 事件 275：colorBlendMode 31，直接上屏（SrcAlpha / One）。 */
  f6Glyphs: [
    0.0010416667209938169, 0, 0, 0, 0, 0.0018518518190830946, 0, 0, 0, 0, 0.0002500000118743628, 0, 0.5369791984558105,
    -0.3888888955116272, 0.5, 1,
  ],
} as const;

/** x、y 两行与 z 的系数和平移（下标 0、1、4、5、10、12、13、14）：文本的正交矩阵和 WPE 的 z 映射相同（RT 的 1/2000、0.5）。 */
const COMPARED = [0, 1, 4, 5, 10, 12, 13, 14];
function expectMvp(actual: ArrayLike<number>, expected: readonly number[], label: string) {
  for (const i of COMPARED) {
    const diff = Math.abs(actual[i] - expected[i]);
    if (expected[i] === 0) expect(diff, `${label}[${i}]`).toBeLessThan(1e-7);
    else expect(diff / Math.abs(expected[i]), `${label}[${i}]`).toBeLessThan(1e-6);
  }
}

// ———— 合成的排版结果：真 GlyphAtlas，字形是假位图 ————

function glyphsIn(atlas: GlyphAtlas, count: number, first = 0): AtlasGlyph[] {
  const list: AtlasGlyph[] = [];
  for (let i = 0; i < count; i++) {
    const width = 6 + i;
    const rows = 8;
    const bytes = atlas.color ? 4 : 1;
    const glyph = atlas.insert(first + i, first + i, {
      width,
      rows,
      left: 0,
      top: rows,
      mode: atlas.color ? PIXEL_MODE_BGRA : PIXEL_MODE_GRAY,
      color: atlas.color,
      pixels: new Uint8Array(width * rows * bytes).fill(200),
    });
    if ("full" in glyph) throw new Error("图集满");
    list.push(glyph);
  }
  return list;
}

interface LayoutDef {
  glyphs: AtlasGlyph[];
  colorGlyphs?: AtlasGlyph[];
  box: { minX: number; minY: number; maxX: number; maxY: number };
  padding: [number, number];
  offset?: [number, number];
}

/** 一份排版结果：字形依次排在基线上；尺寸照 `finish` 的规则（float32）。 */
function layoutOf(def: LayoutDef): TextLayout {
  const quad = (glyph: AtlasGlyph, i: number): TextQuad => ({ x0: 10 * i, y0: 0, x1: 10 * i + 6, y1: 8, glyph });
  const { minX, minY, maxX, maxY } = def.box;
  const w = f(maxX - minX);
  const h = f(maxY - minY);
  const [px, py] = def.padding;
  const colorGlyphs = def.colorGlyphs ?? [];
  return {
    missingFonts: [],
    mesh: {
      key: "test_2048",
      glyphs: def.glyphs.map(quad),
      colorGlyphs: colorGlyphs.map(quad),
      atlas: def.glyphs[0]?.atlas ?? new GlyphAtlas(false),
      colorAtlas: colorGlyphs[0]?.atlas ?? null,
      box: def.box,
      lineHeight: 50,
      rows: 1,
      pointsize: 32,
      refs: [],
    },
    padding: [px, py],
    size: [f(f(w + px) + px), f(f(h + py) + py)],
    compositeSize: [Math.trunc(f(f(px + px) + w)), Math.trunc(f(f(py + py) + h))],
    offset: def.offset ?? [0, 0],
  };
}

/** RobotoMono 32 号 `"Ag"` 的文字框（由 p6b-fx 抓帧反推，见文件头）。 */
const AG_BOX = { minX: 0, minY: -36, maxX: 149, maxY: 140 };

// ———— 图层 ————

/** 程序下标：字形、彩色字形、背景（flat）、clearalpha（composelayer）、effect、passthrough。 */
const PROGRAM = { font: 0, color: 1, flat: 2, compose: 3, effect: 4, passthrough: 5 } as const;

function pass(key: string, extra: Partial<ScenePass> = {}): ScenePass {
  return {
    key,
    program: PROGRAM.font,
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

interface TextLayerDef {
  origin?: number[];
  opaquebackground?: boolean;
  background?: [number, number, number];
  effect?: boolean;
  colorBlendMode?: number;
  alpha?: number;
}

/** 一个文本图层：文本表照 `compile/texts.ts` 的写法（背景 pass 只在开背景时有，clearalpha 只在可能合成且没开背景时有）。 */
function textLayer(object: number, name: string, def: TextLayerDef = {}): SceneLayer {
  const colorBlendMode = def.colorBlendMode ?? 0;
  const opaque = def.opaquebackground ?? false;
  const mayComposite = !!def.effect || (colorBlendMode !== 0 && colorBlendMode !== 31);
  const color = def.background ?? [0, 0, 0];
  const backgroundKey = `objects/${object}/text/background`;
  const text: SceneText = {
    fields: { ...TEXT_DEFAULTS, opaquebackground: opaque, visibleEffects: def.effect ? 1 : 0, colorBlendMode },
    font: { path: "fonts/RobotoMono-Regular.ttf", location: null, size: null },
    glyphPass: pass(`objects/${object}/text/glyphs`),
    colorPass: pass(`objects/${object}/text/color`, { program: PROGRAM.color }),
    backgroundPass: opaque ? pass(backgroundKey, { program: PROGRAM.flat, uniforms: { g_Color: [...color] } }) : null,
    clearAlphaPass:
      !opaque && mayComposite
        ? pass(`objects/${object}/text/clearalpha`, {
            program: PROGRAM.compose,
            blending: "normal",
            runtime: { 0: FRAMEBUFFER_RT },
            framebuffer: true,
          })
        : null,
    background: { key: backgroundKey, color },
  };
  return {
    id: object + 10,
    object,
    parent: null,
    name,
    origin: def.origin ?? [400, 400, 0],
    scale: [1, 1, 1],
    angles: [0, 0, 0],
    // JSON 的 size：渲染器不用（取排版的文字框）
    size: [7, 7],
    alpha: def.alpha ?? 1,
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
    colorBlendMode,
    effects: def.effect ? [kbfx(object)] : [],
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
    text,
  };
}

const targetName = (target: { kind: string; index?: number }) =>
  target.kind === "composite" ? `c${target.index}` : target.kind;
const kinds = (steps: LayerStep[]) =>
  steps.map((step) =>
    step.kind === "draw"
      ? `${step.role}→${targetName(step.target)}`
      : step.kind === "text"
        ? `text ${step.part} ${step.space}→${targetName(step.target)}`
        : step.kind === "clear"
          ? `clear${step.color ? ` ${step.color}` : ""}→${targetName(step.target)}`
          : step.kind,
  );
const textSteps = (plan: LayerPlan) => plan.steps.filter((step) => step.kind === "text");

describe("planLayer：文本层", () => {
  const atlas = new GlyphAtlas(false);
  const colorAtlas = new GlyphAtlas(true);
  const plain = layoutOf({ glyphs: glyphsIn(atlas, 3), box: AG_BOX, padding: [0, 0] });
  const withColor = layoutOf({
    glyphs: glyphsIn(atlas, 2, 10),
    colorGlyphs: glyphsIn(colorAtlas, 1, 20),
    box: AG_BOX,
    padding: [0, 0],
  });

  it("直接上屏、没开背景、没有彩色字形：只有一次普通字形，画到场景、translucent，槽 0 是主图集", () => {
    const plan = planLayer(textLayer(0, "t"), [], undefined, plain);
    expect(plan).toMatchObject({ composite: null, reasons: [] });
    expect(kinds(plan.steps)).toEqual(["text glyphs direct→scene"]);
    expect(plan.steps[0]).toMatchObject({
      pass: { key: "objects/0/text/glyphs" },
      blending: "translucent",
      inputs: { 0: { kind: "atlas", color: false } },
    });
  });

  it("直接上屏、开背景、有彩色字形：背景 → 普通字形 → 彩色字形（彩色的槽 0 是彩色图集）", () => {
    const plan = planLayer(textLayer(0, "t", { opaquebackground: true }), [], undefined, withColor);
    expect(kinds(plan.steps)).toEqual([
      "text background direct→scene",
      "text glyphs direct→scene",
      "text color direct→scene",
    ]);
    const [background, , color] = textSteps(plan);
    expect(background).toMatchObject({ pass: { key: "objects/0/text/background" }, inputs: {} });
    expect(color).toMatchObject({
      pass: { key: "objects/0/text/color" },
      inputs: { 0: { kind: "atlas", color: true } },
    });
  });

  it("colorBlendMode 31：直接上屏，背景与字形都 additive（p6b-fx f6 的 SrcAlpha / One）", () => {
    const plan = planLayer(textLayer(0, "t", { opaquebackground: true, colorBlendMode: 31 }), [], undefined, withColor);
    expect(textSteps(plan).map((step) => step.blending)).toEqual(["additive", "additive", "additive"]);
  });

  it("合成、没开背景（f1）：快照 → clearalpha 画进合成 RT 0 → 字形画进同一张 → effect 末 pass 上屏", () => {
    const plan = planLayer(textLayer(0, "t", { effect: true }), [], undefined, plain);
    expect(kinds(plan.steps)).toEqual(["snapshot", "compose→c0", "text glyphs composite→c0", "final→scene"]);
    // 合成 RT 取排版的尺寸（149×176，不套 max(4, ·)），基础 pass 与字形共占一次写入
    expect(plan.composite).toEqual({ count: 1, width: 149, height: 176 });
    expect(plan.steps[1]).toMatchObject({
      kind: "draw",
      pass: { key: "objects/0/text/clearalpha" },
      geometry: "layer",
      uv: [1, 1],
      inset: [0, 0],
      blending: null,
      inputs: { 0: { kind: "framebuffer" } },
    });
    // 字形用材质自己的 translucent；末 pass 借它（f1 事件 82），UV 内缩 0.15 / 149、0.15 / 176
    expect(plan.steps[2]).toMatchObject({ blending: "translucent" });
    expect(plan.steps[3]).toMatchObject({
      blending: "translucent",
      inset: [f(f(0.15) / 149), f(f(0.15) / 176)],
      inputs: { 0: { kind: "composite", index: 0 } },
    });
  });

  it("合成、开背景（f5）：不拍快照，RT 0 清成背景色 → 字形 → 彩色字形 → 上屏", () => {
    const plan = planLayer(textLayer(0, "t", { effect: true, opaquebackground: true }), [], undefined, withColor);
    expect(kinds(plan.steps)).toEqual([
      "clear text-background→c0",
      "text glyphs composite→c0",
      "text color composite→c0",
      "final→scene",
    ]);
  });

  it("colorBlendMode 2、没有 effect：照样走合成，passthrough 上屏（快照照规则 1 在开头）", () => {
    const plan = planLayer(textLayer(0, "t", { colorBlendMode: 2 }), [], undefined, plain);
    expect(kinds(plan.steps)).toEqual(["snapshot", "compose→c0", "text glyphs composite→c0", "passthrough→scene"]);
  });

  it("空排版（mesh 为 null）整层不画；没给排版结果报 render:text-layout", () => {
    const empty: TextLayout = { ...plain, mesh: null };
    expect(planLayer(textLayer(0, "t", { effect: true }), [], undefined, empty)).toEqual({
      composite: null,
      steps: [],
      reasons: [],
    });
    expect(planLayer(textLayer(0, "t"), []).reasons).toEqual(["render:text-layout"]);
  });

  it("合成 RT 取排版的尺寸，不套 max(4, ·)（WPE `FUN_140258ab0` 只截断取整）", () => {
    const tiny = layoutOf({
      glyphs: glyphsIn(atlas, 1, 30),
      box: { minX: 0, minY: 0, maxX: 3, maxY: 2 },
      padding: [0, 0],
    });
    expect(tiny.compositeSize).toEqual([3, 2]);
    expect(planLayer(textLayer(0, "t", { effect: true }), [], undefined, tiny).composite).toEqual({
      count: 1,
      width: 3,
      height: 2,
    });
  });

  it("签名带上有没有彩色字形；文本层不预备 effect 变体（开关走重编译）", () => {
    const layer = textLayer(0, "t");
    expect(planSignature(planLayer(layer, [], undefined, plain))).not.toBe(
      planSignature(planLayer(layer, [], undefined, withColor)),
    );
    const bound = textLayer(0, "t", { effect: true });
    bound.effects[0].visibleBound = true;
    expect(variantPlans(bound, [])).toEqual([]);
  });
});

// ———— 矩阵：textMatrices 对上 WPE ————

describe("textMatrices：和 p6b-fx 抓帧的 MVP 相同", () => {
  const atlas = new GlyphAtlas(false);
  const glyphs = glyphsIn(atlas, 2);
  const vp = sceneViewProjection({ width: 1920, height: 1080 });
  /** 图层画自己的矩阵（含对齐偏移，`drawMatrixOf`，P8 步骤 3 起世界矩阵不带它）。 */
  const worldOf = (origin: number[], offset: [number, number]) =>
    drawMatrixOf(0, new Map([[0, { origin, angles: [0, 0, 0], scale: [1, 1, 1], offset, parent: null }]]), new Map());

  it("画进合成 RT：RT 像素的正交 × compositeTranslation（f1、f2、f3、f5）", () => {
    const cases: [string, LayoutDef, readonly number[]][] = [
      ["f1", { glyphs, box: AG_BOX, padding: [0, 0] }, WPE_MVP.f1Glyphs],
      ["f2", { glyphs, box: AG_BOX, padding: [20, 20] }, WPE_MVP.f2Glyphs],
      ["f3", { glyphs, box: { minX: 0, minY: -13, maxX: 56, maxY: 53 }, padding: [512, 512] }, WPE_MVP.f3Glyphs],
      ["f5", { glyphs, box: AG_BOX, padding: [32, 32] }, WPE_MVP.f5Glyphs],
    ];
    for (const [name, def, expected] of cases) {
      const layout = layoutOf(def);
      const { modelViewProjection } = textMatrices(
        { part: "glyphs", space: "composite" },
        worldOf([0, 0, 0], [0, 0]),
        vp,
        layout,
      );
      expectMvp(modelViewProjection, expected, name);
      // 彩色字形同一份
      const color = textMatrices({ part: "color", space: "composite" }, worldOf([0, 0, 0], [0, 0]), vp, layout);
      expect([...color.modelViewProjection]).toEqual([...modelViewProjection]);
    }
  });

  it("直接上屏：图层 MVP（世界矩阵含对齐偏移）× directTranslation；背景平移 (−w/2 − pad.x, −h/2 − pad.y)（f4、f6）", () => {
    // f4：原点 (400, 400)、纵向居中的偏移 (0, −18)，开背景（padding 32 才加上）
    const f4 = layoutOf({ glyphs, box: AG_BOX, padding: [32, 32], offset: [0, -18] });
    const world = worldOf([400, 400, 0], [0, -18]);
    expectMvp(
      textMatrices({ part: "glyphs", space: "direct" }, world, vp, f4).modelViewProjection,
      WPE_MVP.f4Glyphs,
      "f4 字形",
    );
    expectMvp(
      textMatrices({ part: "background", space: "direct" }, world, vp, f4).modelViewProjection,
      WPE_MVP.f4Background,
      "f4 背景",
    );
    // 世界矩阵里的偏移就是 `T(offset)`：和直接把偏移加进原点相同
    expect([...world]).toEqual([...multiply(translation(400, 400, 0), translation(0, -18, 0))]);
    // f6：不加 padding（没有 effect、没有背景、cbm 31）
    const f6 = layoutOf({ glyphs, box: AG_BOX, padding: [0, 0], offset: [0, -18] });
    expectMvp(
      textMatrices({ part: "glyphs", space: "direct" }, worldOf([1550, 400, 0], [0, -18]), vp, f6).modelViewProjection,
      WPE_MVP.f6Glyphs,
      "f6 字形",
    );
  });

  it("clearalpha 与上屏用图层 MVP：f1 的中心 (400, 832) = 原点 (400, 850) + 偏移 (0, −18)", () => {
    const world = worldOf([400, 850, 0], [0, -18]);
    expectMvp(multiply(vp, world), WPE_MVP.f1Compose, "f1 compose");
  });
});

// ———— GpuScene：假设备 ————

interface FakeBuffer {
  label: string;
  bytes: Uint8Array;
  destroy(): void;
}

/** 假设备：缓冲字节、纹理写入、bind group 绑的纹理，以及一帧的编码轨迹（目标、清屏值、管线、索引、绘制）。 */
class FakeGpu {
  readonly trace: string[] = [];
  readonly writes: { texture: string; origin: number[]; size: number[] }[] = [];
  readonly bindings = new Map<object, string[]>();
  readonly device: GPUDevice;

  constructor() {
    const trace = this.trace;
    const renderPass = () => ({
      setViewport() {},
      setPipeline(pipeline: { label: string }) {
        trace.push(`  pipeline ${pipeline.label}`);
      },
      setBindGroup: (_index: number, group: object) => {
        const textures = this.bindings.get(group) ?? [];
        if (textures.length) trace.push(`  bind ${textures.join(", ")}`);
      },
      setVertexBuffer(_slot: number, buffer: FakeBuffer) {
        trace.push(`  vertices ${buffer.label} ${buffer.bytes.byteLength}`);
      },
      setIndexBuffer(buffer: FakeBuffer, format: string) {
        trace.push(`  indices ${format} ${buffer.bytes.byteLength}`);
      },
      draw(count: number) {
        trace.push(`  draw ${count}`);
      },
      drawIndexed(count: number) {
        trace.push(`  drawIndexed ${count}`);
      },
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
      createBindGroup: (descriptor: GPUBindGroupDescriptor) => {
        const group = {};
        const textures = [...descriptor.entries]
          .map((entry) => (entry.resource as { label?: string }).label)
          .filter((label): label is string => typeof label === "string" && label.length > 0);
        this.bindings.set(group, textures);
        return group;
      },
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
        writeBuffer: (
          buffer: FakeBuffer,
          offset: number,
          data: ArrayBuffer | ArrayBufferView,
          dataOffset = 0,
          size?: number,
        ) => {
          const bytes = ArrayBuffer.isView(data)
            ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
            : new Uint8Array(data);
          buffer.bytes.set(bytes.subarray(dataOffset, size === undefined ? undefined : dataOffset + size), offset);
        },
        writeTexture: (
          destination: GPUTexelCopyTextureInfo,
          _data: unknown,
          _layout: unknown,
          size: { width: number; height: number },
        ) => {
          const origin = destination.origin as { x?: number; y?: number } | undefined;
          this.writes.push({
            texture: (destination.texture as unknown as { label: string }).label,
            origin: [origin?.x ?? 0, origin?.y ?? 0],
            size: [size.width, size.height],
          });
        },
        submit() {},
        onSubmittedWorkDone: async () => {},
      },
      pushErrorScope() {},
      popErrorScope: async () => null,
    } as unknown as GPUDevice;
  }
}

/** 一个程序：MVP（偏移 0）加 `extra` 里的 uniform，`slots` 这些纹理槽；属性照字体着色器（`flat` 多一个 `a_Color`）。 */
function program(
  name: string,
  slots: number[],
  extra: { name: string; type: string; offset: number; size: number }[] = [],
  color = false,
): TranslateResult {
  return {
    ok: true,
    vertex: { wgsl: `// ${name} v`, entryPoint: "main" },
    fragment: { wgsl: `// ${name} f`, entryPoint: "main" },
    attributes: [
      { name: "a_Position", type: "vec3", location: 0 },
      color ? { name: "a_Color", type: "vec4", location: 1 } : { name: "a_TexCoord", type: "vec2", location: 1 },
    ],
    uniforms: [
      { name: "g_ModelViewProjectionMatrix", type: "mat4x4<f32>", declared: "mat4", offset: 0, size: 64 },
      ...extra,
    ],
    uniformBlockSize: 96,
    textures: slots.map((slot) => ({ slot, binding: 1 + 2 * slot, samplerBinding: 2 + 2 * slot, kind: "2d" })),
  } as unknown as TranslateResult;
}

function bundleOf(layers: SceneLayer[]): SceneBundle {
  const color4 = { name: "g_Color4", type: "vec4<f32>", offset: 64, size: 16 };
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
      program("font", [0], [color4]),
      program("fontrgba", [0], [color4]),
      program(
        "flat",
        [],
        [
          { name: "g_Color", type: "vec3<f32>", offset: 64, size: 12 },
          { name: "g_Alpha", type: "f32", offset: 76, size: 4 },
        ],
        true,
      ),
      program("composelayer", [0]),
      program("kbfx", [0]),
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
  step: { kind: string; part?: string; role?: string };
  vertexBuffer: FakeBuffer;
  uniformBuffer: FakeBuffer | null;
  pipeline: { label: string };
}
interface RuntimeView {
  object: number;
  ops: { kind: string; draw?: DrawView; color?: string }[];
}
const internals = (scene: GpuScene) => scene as unknown as { layers: RuntimeView[]; draws: Set<DrawView> };
const opKinds = (scene: GpuScene, object: number) =>
  internals(scene)
    .layers.find((item) => item.object === object)
    ?.ops.map((op) =>
      op.kind === "draw"
        ? `draw ${op.draw!.step.kind === "text" ? `text ${op.draw!.step.part}` : op.draw!.step.role}`
        : op.kind === "clear" && op.color
          ? `clear ${op.color}`
          : op.kind,
    ) ?? null;
function drawOf(scene: GpuScene, object: number, name: string): DrawView {
  const draw = [...internals(scene).draws].find(
    (item) => item.object === object && (item.step.kind === "text" ? item.step.part : item.step.role) === name,
  );
  if (!draw) throw new Error(`图层 ${object} 没有 ${name} 的 draw`);
  return draw;
}
const floatsOf = (draw: DrawView, offset: number, count: number) =>
  Array.from(new Float32Array(draw.uniformBuffer!.bytes.buffer.slice(offset, offset + 4 * count)));

const FRAME: FrameInput = {
  time: 1,
  frametime: 0.05,
  daytime: 0.5,
  pointer: [0.5, 0.5],
  pointerLast: [0.5, 0.5],
  cursor: [0.5, 0.5],
};

beforeEach(() => {
  vi.stubGlobal("GPUTextureUsage", { RENDER_ATTACHMENT: 1, TEXTURE_BINDING: 2, COPY_SRC: 4, COPY_DST: 8 });
  vi.stubGlobal("GPUBufferUsage", { VERTEX: 1, UNIFORM: 2, COPY_DST: 4, MAP_READ: 8, INDEX: 16 });
  vi.stubGlobal("GPUMapMode", { READ: 1 });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("GpuScene：文本层", () => {
  /**
   * 四层：P（直接上屏，3 个普通字形 + 1 个彩色字形）、B（直接上屏、开背景、cbm 31）、F（合成、没开背景）、FB（合成、开背景，alpha 0.5）。
   * P 与 F 用同一张主图集（同一「字体 + 字号」），B、FB 各一张。
   */
  function scene4() {
    const shared = new GlyphAtlas(false);
    const colorAtlas = new GlyphAtlas(true);
    const other = new GlyphAtlas(false);
    const third = new GlyphAtlas(false);
    const layouts = new Map<number, TextLayout>([
      [
        0,
        layoutOf({
          glyphs: glyphsIn(shared, 3),
          colorGlyphs: glyphsIn(colorAtlas, 1, 5),
          box: AG_BOX,
          padding: [0, 0],
        }),
      ],
      // B 的文字框宽带小数（149.5）：图层尺寸 213.5，背景四边形取截断后的合成尺寸 213（`compositeSize`），两者不同才测得出取错
      [
        1,
        layoutOf({ glyphs: glyphsIn(other, 2), box: { ...AG_BOX, maxX: 149.5 }, padding: [32, 32], offset: [0, -18] }),
      ],
      [2, layoutOf({ glyphs: glyphsIn(shared, 2, 10), box: AG_BOX, padding: [0, 0], offset: [0, -18] })],
      [3, layoutOf({ glyphs: glyphsIn(third, 2), box: AG_BOX, padding: [32, 32], offset: [0, -18] })],
    ]);
    const layers = [
      textLayer(0, "P"),
      textLayer(1, "B", { opaquebackground: true, background: [1, 0, 0], colorBlendMode: 31 }),
      textLayer(2, "F", { effect: true, origin: [400, 850, 0] }),
      textLayer(3, "FB", { effect: true, opaquebackground: true, background: [0, 0.5, 1], alpha: 0.5 }),
    ];
    return { bundle: bundleOf(layers), layouts, atlases: { shared, colorAtlas, other, third } };
  }

  async function open() {
    const { bundle, layouts, atlases } = scene4();
    const gpu = new FakeGpu();
    const state = SceneState.fromBundle(bundle);
    const scene = await GpuScene.build(gpu.device, bundle, state, new Set(), [], {
      ignoreUnsupported: true,
      particles: { seed: 1 },
      texts: layouts,
    });
    return { gpu, scene, state, layouts, atlases };
  }

  it("没给排版结果：整场画不了（render:text-layout）", async () => {
    const { bundle } = scene4();
    const gpu = new FakeGpu();
    await expect(
      GpuScene.build(gpu.device, bundle, SceneState.fromBundle(bundle), new Set(), [], { ignoreUnsupported: true }),
    ).rejects.toMatchObject({ reasons: ["render:text-layout"] });
  });

  it("每层的 op：P 字形 → 彩色字形；B 背景 → 字形；F 快照 → clearalpha → 字形 → 上屏；FB 清成背景色 → 字形 → 上屏", async () => {
    const { scene } = await open();
    expect(opKinds(scene, 0)).toEqual(["draw text glyphs", "draw text color"]);
    expect(opKinds(scene, 1)).toEqual(["draw text background", "draw text glyphs"]);
    expect(opKinds(scene, 2)).toEqual(["snapshot", "draw compose", "draw text glyphs", "draw final"]);
    expect(opKinds(scene, 3)).toEqual(["clear text-background", "draw text glyphs", "draw final"]);
  });

  it("管线：文本是三角形列表；画到场景写 RGB、画进合成 RT 写 RGBA；cbm 31 的背景与字形 additive", async () => {
    const { scene } = await open();
    expect(drawOf(scene, 0, "glyphs").pipeline.label).toBe("scene program 0 translucent rgba8unorm list mask 7");
    expect(drawOf(scene, 0, "color").pipeline.label).toBe("scene program 1 translucent rgba8unorm list mask 7");
    expect(drawOf(scene, 1, "background").pipeline.label).toBe("scene program 2 additive rgba8unorm list mask 7");
    expect(drawOf(scene, 1, "glyphs").pipeline.label).toBe("scene program 0 additive rgba8unorm list mask 7");
    expect(drawOf(scene, 2, "glyphs").pipeline.label).toBe("scene program 0 translucent rgba8unorm list mask 15");
    // clearalpha 同组合层的 compose：关混合、写 RGBA、三角形带
    expect(drawOf(scene, 2, "compose").pipeline.label).toBe("scene program 3 opaque rgba8unorm mask 15");
  });

  it("图集：每个图集对象一张纹理（P 与 F 共用），建场景时整张上传；字形 draw 的槽 0 绑本层的图集", async () => {
    const { gpu, scene, state } = await open();
    expect(gpu.writes).toEqual([
      { texture: "text atlas #0", origin: [0, 0], size: [512, 512] },
      { texture: "text atlas color #1", origin: [0, 0], size: [512, 512] },
      { texture: "text atlas #2", origin: [0, 0], size: [512, 512] },
      { texture: "text atlas #3", origin: [0, 0], size: [512, 512] },
    ]);
    scene.update(FRAME, state);
    gpu.trace.length = 0;
    scene.encode(gpu.device.createCommandEncoder(), state);
    const binds = gpu.trace.filter((line) => line.startsWith("  bind"));
    // 每次绘制绑的纹理视图（B 的背景没有纹理，不出现）
    expect(binds).toEqual([
      "  bind text atlas #0", // P 字形
      "  bind text atlas color #1", // P 彩色字形
      "  bind text atlas #2", // B 字形
      "  bind _rt_FullFrameBuffer", // F 的 clearalpha 读快照
      "  bind text atlas #0", // F 与 P 共用主图集
      "  bind composite 149x176|true|false #0", // F 上屏
      "  bind text atlas #3", // FB 字形
      "  bind composite 213x240|true|false #0", // FB 上屏
    ]);
  });

  it("一帧的编码：索引 uint16、每字形 6 个；FB 先把合成 RT 清成 (背景色, alpha)，再画字形、上屏", async () => {
    const { gpu, scene, state } = await open();
    scene.update(FRAME, state);
    gpu.trace.length = 0;
    scene.encode(gpu.device.createCommandEncoder(), state);
    const lines = gpu.trace.filter((line) => !line.startsWith("  bind") && !line.startsWith("  pipeline"));
    expect(lines).toEqual([
      'pass scene target clear {"r":0,"g":0,"b":0,"a":1}',
      // P：3 个字形 × 4 个顶点 × 20 字节；彩色 1 个
      "  vertices layer 10 P text glyphs 240",
      "  indices uint16 36",
      "  drawIndexed 18",
      "  vertices layer 10 P text color 80",
      "  indices uint16 12",
      "  drawIndexed 6",
      // B：背景一个四边形（flat 的顶点是 a_Position + a_Color，28 字节）
      "  vertices layer 11 B text background 112",
      "  indices uint16 12",
      "  drawIndexed 6",
      "  vertices layer 11 B text glyphs 160",
      "  indices uint16 24",
      "  drawIndexed 12",
      // F：快照 → clearalpha（图层四边形、三角形带）→ 字形 → 上屏
      "copy scene target -> _rt_FullFrameBuffer",
      "pass composite 149x176|true|false #0 load",
      "  vertices layer 12 F compose 80",
      "  draw 4",
      "pass composite 149x176|true|false #0 load",
      "  vertices layer 12 F text glyphs 160",
      "  indices uint16 24",
      "  drawIndexed 12",
      "pass scene target load",
      "  vertices layer 12 F final 80",
      "  draw 4",
      // FB：清成 (0, 0.5, 1, 0.5)，没有快照
      'pass composite 213x240|true|false #0 clear {"r":0,"g":0.5,"b":1,"a":0.5}',
      "pass composite 213x240|true|false #0 load",
      "  vertices layer 13 FB text glyphs 160",
      "  indices uint16 24",
      "  drawIndexed 12",
      "pass scene target load",
      "  vertices layer 13 FB final 80",
      "  draw 4",
    ]);
  });

  it("uniform：MVP 与 textMatrices 逐字节相同；字形的 g_Color4 = (color, alpha)，背景的 g_Color 是背景色、g_Alpha 是图层 alpha", async () => {
    const { scene, state, layouts } = await open();
    scene.update(FRAME, state);
    const vp = sceneViewProjection({ width: 1920, height: 1080 });
    const worlds = new Map<number, Mat4>();
    for (const [object, part, space] of [
      [0, "glyphs", "direct"],
      [1, "background", "direct"],
      [2, "glyphs", "composite"],
      [3, "glyphs", "composite"],
    ] as const) {
      // 文本层画自己的矩阵带排版偏移（`drawMatrixOf`，P8 步骤 3）
      const world = drawMatrixOf(object, state.layers, worlds);
      const expected = textMatrices({ part, space }, world, vp, layouts.get(object)!).modelViewProjection;
      expect(floatsOf(drawOf(scene, object, part), 0, 16), `${object} ${part}`).toEqual(Array.from(expected));
    }
    expect(floatsOf(drawOf(scene, 0, "glyphs"), 64, 4)).toEqual([1, 1, 1, 1]);
    expect(floatsOf(drawOf(scene, 3, "glyphs"), 64, 4)).toEqual([1, 1, 1, 0.5]);
    expect(floatsOf(drawOf(scene, 1, "background"), 64, 4)).toEqual([1, 0, 0, 1]);
  });

  it("顶点：字形四边形照 WPE 的布局（同 `text/mesh.ts` 的 `textVertices`，UV 从图集字形读）；背景是整数文字框", async () => {
    const { scene, layouts } = await open();
    const floats = (draw: DrawView) => Array.from(new Float32Array(draw.vertexBuffer.bytes.buffer.slice(0)));
    const mesh = layouts.get(0)!.mesh!;
    expect(floats(drawOf(scene, 0, "glyphs"))).toEqual(Array.from(textVertices(mesh.glyphs)));
    expect(floats(drawOf(scene, 0, "color"))).toEqual(Array.from(textVertices(mesh.colorGlyphs)));
    // 背景（flat：a_Position + a_Color，a_Color 补 1）：v0 (0, 240)、v1 (213, 240)、v2 (0, 0)、v3 (213, 0)。图层尺寸是 213.5，
    // 四边形取截断后的合成尺寸
    expect(layouts.get(1)!.size[0]).toBe(213.5);
    const background = floats(drawOf(scene, 1, "background"));
    const positions = [0, 1, 2, 3].map((v) => background.slice(v * 7, v * 7 + 3));
    expect(positions).toEqual([
      [0, 240, 0],
      [213, 240, 0],
      [0, 0, 0],
      [213, 0, 0],
    ]);
  });

  it("对齐偏移进世界矩阵：F 的 clearalpha 与上屏的 MVP 是图层 MVP，中心 (400, 832)（f1 事件 47 / 82）", async () => {
    const { scene, state } = await open();
    scene.update(FRAME, state);
    expectMvp(floatsOf(drawOf(scene, 2, "compose"), 0, 16), WPE_MVP.f1Compose, "F compose");
    expectMvp(floatsOf(drawOf(scene, 2, "final"), 0, 16), WPE_MVP.f1Compose, "F final");
    expect(state.layers.get(2)!.offset).toEqual([0, -18]);
  });

  it("背景色就地写：constant 目标改 g_Color，背景 draw 与合成路径的清屏色都跟着变；alpha 变了清屏色也变", async () => {
    const { gpu, scene, state } = await open();
    const write = (object: number, value: string) =>
      state.write(
        {
          property: "bg",
          target: {
            kind: "constant",
            pass: `objects/${object}/text/background`,
            material: "backgroundcolor",
            uniforms: ["g_Color"],
            type: "vec3",
          },
        },
        value,
      );
    expect(write(1, "0 1 0")).toBe("applied");
    expect(write(3, "1 1 0")).toBe("applied");
    state.write({ property: "a", target: { kind: "layer", object: 3, field: "alpha" } }, 0.25);
    scene.sync(state);
    scene.update(FRAME, state);
    expect(floatsOf(drawOf(scene, 1, "background"), 64, 3)).toEqual([0, 1, 0]);
    gpu.trace.length = 0;
    scene.encode(gpu.device.createCommandEncoder(), state);
    expect(gpu.trace).toContain('pass composite 213x240|true|false #0 clear {"r":1,"g":1,"b":0,"a":0.25}');
  });

  it("文本层的 effect 开关走整场重编译（改 padding 与文字框，1d 没有就地重排）", async () => {
    const { state } = await open();
    expect(state.write({ property: "v", target: { kind: "effect", object: 2, effect: 0 } }, false)).toBe("recompile");
    expect(state.effectEnabled(2, 0)).toBe(true);
  });

  it("图集的脏区在 sync 里增量上传（机制给 1e；1d 加载之后不再排版）", async () => {
    const { gpu, scene, state, atlases } = await open();
    gpu.writes.length = 0;
    glyphsIn(atlases.other, 1, 40);
    scene.sync(state);
    expect(gpu.writes.length).toBeGreaterThan(0);
    expect(gpu.writes.every((item) => item.texture === "text atlas #2")).toBe(true);
    gpu.writes.length = 0;
    scene.sync(state);
    expect(gpu.writes).toEqual([]);
  });
});

// ———— 有 wasm 与 WPE：p6b 六个工程的排版 → 图层矩阵 ————

const WASM = fileURLToPath(new URL("../wpefont/wpefont.wasm", import.meta.url));
const root = process.env.KABEGAME_WPE_ROOT;
const fontsDir = join(process.env.WINDIR ?? "C:\\Windows", "Fonts");
const round3 = (v: number) => Math.round(v * 1000) / 1000;

type FixtureObject = (typeof fixture.projects)["p6b-geom"]["objects"][number] & {
  origin?: number[];
  background?: number[];
  rt?: number[];
  rtOrigin?: number[];
  center?: number[];
  size?: number[];
};

function fieldsOf(object: FixtureObject): TextFields {
  const { origin: _origin, padding, spacing, horizontalalign, verticalalign, ...rest } = object.fields;
  return {
    ...TEXT_DEFAULTS,
    ...rest,
    padding: [padding[0], padding[1]],
    spacing: [spacing[0], spacing[1]],
    horizontalalign: horizontalalign as TextFields["horizontalalign"],
    verticalalign: verticalalign as TextFields["verticalalign"],
  };
}

describe.skipIf(!existsSync(WASM) || !root)("p6b 排版 → 图层矩阵（fixtures/p6b.json）", () => {
  let module: Promise<WebAssembly.Module> | null = null;
  const engine = async () => Wpefont.fromModule(await (module ??= WebAssembly.compile(readFileSync(WASM))));
  const expected = fixture.systemFonts as Record<string, string | null>;
  const reader = (mismatched: Set<string>) => async (path: FontPath) => {
    if (path.startsWith(SYSTEM_FONT_PREFIX)) {
      const file = path.slice(SYSTEM_FONT_PREFIX.length);
      const full = join(fontsDir, file);
      const data = existsSync(full) ? readFileSync(full) : null;
      const hash = data ? createHash("sha256").update(data).digest("hex").slice(0, 16) : null;
      if ((expected[file] ?? null) !== hash) mismatched.add(file);
      return data;
    }
    const full = join(root!, "assets", path);
    return existsSync(full) ? readFileSync(full) : null;
  };

  for (const [name, project] of Object.entries(fixture.projects)) {
    it(name, async (ctx) => {
      const mismatched = new Set<string>();
      const fonts = new TextFonts(await engine(), reader(mismatched));
      const atlases = new TextAtlases();
      const vp = sceneViewProjection({ width: 1920, height: 1080 });
      const layouts: TextLayout[] = [];
      for (const raw of project.objects) {
        const fields = fieldsOf(raw as FixtureObject);
        let layout = layoutText(fields, fonts, atlases);
        for (let round = 0; layout.missingFonts.length && round < 16; round++) {
          await fonts.load(layout.missingFonts);
          layout = layoutText(fields, fonts, atlases);
        }
        layouts.push(layout);
      }
      if (mismatched.size) ctx.skip(`系统字体和抓帧机器上的不同：${[...mismatched].join(", ")}`);
      project.objects.forEach((raw, i) => {
        const object = raw as FixtureObject;
        const layout = layouts[i];
        const what = `${name}/${object.name}`;
        const [ox, oy] = object.fields.origin;
        // 对齐偏移经 `setTexts` 写进图层状态，图层画自己的矩阵（`drawMatrixOf`）在世界矩阵后右乘它
        const state = new Map([
          [0, { origin: [ox, oy, 0], angles: [0, 0, 0], scale: [1, 1, 1], offset: layout.offset, parent: null }],
        ]);
        const world = drawMatrixOf(0, state, new Map());
        if (object.rt) {
          const composite = textMatrices({ part: "glyphs", space: "composite" }, world, vp, layout);
          // RT 里的原点 = 模型矩阵把排版原点送到的 RT 像素
          expect([composite.model[12], composite.model[13]].map(round3), `${what} RT 里的原点`).toEqual(
            object.rtOrigin,
          );
          expect(compositeTranslation(layout).map(round3)).toEqual(object.rtOrigin);
          // 合成四边形（clearalpha 与上屏）的中心 = 世界矩阵的平移
          const center = transformPoint(world, 0, 0, 0);
          expect([center[0], center[1]].map(round3), `${what} 合成四边形中心`).toEqual(object.center);
          // 渲染图：合成 RT = 抓帧的 RT 尺寸；图层 size = 文字框；上屏的 UV 内缩按图层 size 的整数部分
          const fields = object.fields;
          const plan = planLayer(
            textLayer(0, object.name, {
              effect: fields.visibleEffects > 0,
              opaquebackground: fields.opaquebackground,
              colorBlendMode: fields.colorBlendMode,
            }),
            [],
            undefined,
            layout,
          );
          expect(plan.composite, `${what} 合成 RT`).toMatchObject({ width: object.rt[0], height: object.rt[1] });
          expect(layout.size, `${what} 图层 size`).toEqual(object.size);
          const final = plan.steps.find((step) => step.kind === "draw" && step.role === "final");
          expect(final, `${what} 上屏`).toMatchObject({ inset: object.size!.map((v) => f(f(0.15) / Math.trunc(v))) });
        } else {
          const direct = textMatrices({ part: "glyphs", space: "direct" }, world, vp, layout);
          const at = transformPoint(direct.model, 0, 0, 0);
          expect([at[0], at[1]].map(round3), `${what} 排版原点`).toEqual(object.origin);
          // 和「原点 + 偏移 + directTranslation」逐项相同（float32）
          const [tx, ty] = directTranslation(layout.mesh!);
          expect([f(f(ox + layout.offset[0]) + tx), f(f(oy + layout.offset[1]) + ty)].map(round3)).toEqual(
            object.origin,
          );
          // 直接上屏的背景四边形是整数文字框（f4 事件 203 的 213×240）
          if (object.background) expect(textCompositeSize(layout), `${what} 背景`).toEqual(object.background);
        }
      });
      fonts.dispose();
    });
  }
});

describe("textIndexData：uint16 装得下才用 uint16", () => {
  it("16384 个字形（65536 个顶点）是 uint16；多一个换 uint32，顺序不变", () => {
    const small = textIndexData(16384);
    expect(small).toBeInstanceOf(Uint16Array);
    expect(Array.from(small.subarray(-6))).toEqual([65532, 65534, 65533, 65533, 65534, 65535]);
    const large = textIndexData(16385);
    expect(large).toBeInstanceOf(Uint32Array);
    expect(Array.from(large.subarray(-6))).toEqual([65536, 65538, 65537, 65537, 65538, 65539]);
    expect(Array.from(large.subarray(0, 6))).toEqual([0, 2, 1, 1, 2, 3]);
  });
});
