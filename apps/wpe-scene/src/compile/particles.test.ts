import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { compileScene, particleWritesTex0Format } from "./bundle";
import { checkObjectFeatures, checkParticleFeatures, checkParticleProgram, checkSceneFeatures } from "./features";
import { SceneFs, type SceneReader } from "./fs";
import type { JsonObject, MaterialPass } from "./model";
import {
  controlPointOffset,
  isOrthographic,
  parseParticle,
  parseParticleInstance,
  particleFov,
  readControlPoints,
  readParticleSystem,
} from "./particles";
import { ShaderCompiler, shaderCacheKey, type ShaderTextureSlot } from "./shader";
import { PARTICLE_MODULES, readParticleModule, type ParticleCategory } from "../particles/modules";
import { Wpesl2wgsl, type TranslateRequest, type TranslateResult } from "../wpesl2wgsl";

vi.mock("../fileUrl", () => ({ fileToUrl: (path: string) => path }));

const ORTHO = { orthogonalprojection: { width: 1920, height: 1080 } };
const TWO_PI = 2 * Math.PI;

/** 按模块表读一个只写了名字的模块：全部字段都是缺省值。 */
const defaults = (category: ParticleCategory, name: string, orthographic: boolean) =>
  readParticleModule(category, { name }, orthographic).fields;

/** 一个粒子 JSON 的能力检查结果。 */
function particleKeys(system: JsonObject, orthographic = true): string[] {
  const keys = new Set<string>();
  checkParticleFeatures(system, orthographic, keys);
  return [...keys].sort();
}
/** 只有一个模块的系统。 */
const withModule = (category: ParticleCategory, module: JsonObject): JsonObject => ({
  maxcount: 10,
  [category]: [module],
});

describe("模块表", () => {
  it("档 1 的 12 项、P4b 步骤 3 的 8 项、步骤 4 的 3 项、P4c 步骤 3 的 1 项、P4d 步骤 3 的 2 项、步骤 4a 的 2 项、步骤 5 的 4 项，外加 renderer sprite、spritetrail（P4c 步骤 5）、rope（P4d 步骤 1）、ropetrail（P4d 步骤 2）；每项都有列和执行函数，renderer 由绘制负责", () => {
    expect(PARTICLE_MODULES.map((def) => `${def.category}:${def.name}`)).toEqual([
      "emitter:sphererandom",
      "emitter:boxrandom",
      "initializer:lifetimerandom",
      "initializer:sizerandom",
      "initializer:colorrandom",
      "initializer:velocityrandom",
      "initializer:rotationrandom",
      "initializer:angularvelocityrandom",
      "initializer:alpharandom",
      "initializer:turbulentvelocityrandom",
      "initializer:positionoffsetrandom",
      "initializer:mapsequencearoundcontrolpoint",
      "initializer:mapsequencebetweencontrolpoints",
      "initializer:remapinitialvalue",
      "operator:movement",
      "operator:angularmovement",
      "operator:alphafade",
      "operator:oscillateposition",
      "operator:oscillatealpha",
      "operator:sizechange",
      "operator:alphachange",
      "operator:colorchange",
      "operator:oscillatesize",
      "operator:vortex",
      "operator:controlpointattract",
      "operator:maintaindistancetocontrolpoint",
      "operator:maintaindistancebetweencontrolpoints",
      "operator:reducemovementnearcontrolpoint",
      "operator:vortex_v2",
      "operator:turbulence",
      "operator:capvelocity",
      "operator:remapvalue",
      "renderer:sprite",
      "renderer:spritetrail",
      "renderer:rope",
      "renderer:ropetrail",
    ]);
    for (const def of PARTICLE_MODULES) {
      expect(def.columns.length, def.name).toBeGreaterThan(0);
      if (def.category === "renderer") expect(def.run, def.name).toBeNull();
      else expect(def.run, def.name).toBeTypeOf("function");
    }
  });

  it("列标志按报告：旋转 yz、角速度、alpha 当前值", () => {
    const flags = Object.fromEntries(PARTICLE_MODULES.map((def) => [def.name, def.columnFlags]));
    expect(flags).toMatchObject({
      rotationrandom: 1,
      angularvelocityrandom: 2,
      angularmovement: 3,
      alphafade: 16,
      oscillatealpha: 16,
      movement: 0,
      sphererandom: 0,
      // P4b 步骤 3（rea-p4b-modules.md B9、rea-framework「标志位来源」）：只有 alphachange bit4、colorchange bit3
      boxrandom: 0,
      alpharandom: 0,
      sizechange: 0,
      alphachange: 16,
      colorchange: 8,
      oscillatesize: 0,
      vortex: 0,
      capvelocity: 0,
      // P4c 步骤 3：静态部分为 0，上一步位置列按 flags 算（columnFlagsOf，见 particles/attract.test.ts）
      controlpointattract: 0,
    });
    // 按字段算的列标志：controlpointattract，以及 P4d 步骤 4a 的 remapvalue（输出 opacity / color，见 particles/remap.test.ts）
    expect(PARTICLE_MODULES.filter((def) => def.columnFlagsOf).map((def) => def.name)).toEqual([
      "controlpointattract",
      "remapvalue",
    ]);
  });
});

describe("解析：档 1 模块的缺省值（rea-p4a.md B）", () => {
  const BLEND = { blendinstart: 0, blendinend: 0, blendoutstart: 1, blendoutend: 1 };
  /** 音频的五个键（P4e 步骤 1 登记进读它的模块，rea-p4e-audio.md 第 2 节的缺省值）。 */
  const AUDIO = {
    audioprocessingmode: 0,
    audioprocessingexponent: 2,
    audioprocessingbounds: "0.8 1.0",
    audioprocessingfrequencystart: 0,
    audioprocessingfrequencyend: 1,
  };
  const ortho: [ParticleCategory, string, Record<string, unknown>][] = [
    [
      "emitter",
      "sphererandom",
      {
        origin: [0, 0, 0],
        directions: [1, 1, 0],
        sign: [0, 0, 0],
        distancemin: 0,
        distancemax: 256,
        speedmin: 0,
        speedmax: 0,
        controlpoint: 0,
        cone: 0,
        rate: 10,
        duration: 0,
        delay: 0,
        instantaneous: 0,
        flags: 0,
        minperiodicduration: 2,
        maxperiodicduration: 3,
        minperiodicdelay: 1,
        maxperiodicdelay: 2,
        maxtoemitperperiod: 0,
        ...AUDIO,
      },
    ],
    ["initializer", "lifetimerandom", { min: 0, max: 1, exponent: 1 }],
    ["initializer", "sizerandom", { min: 5, max: 50, exponent: 1 }],
    ["initializer", "colorrandom", { min: [0, 0, 0], max: [1, 1, 1], exponent: 1 }],
    ["initializer", "velocityrandom", { min: [-32, -32, 0], max: [32, 32, 0], exponent: 1 }],
    ["initializer", "rotationrandom", { min: [0, 0, 0], max: [0, 0, 6.28318530717], exponent: 1 }],
    ["initializer", "angularvelocityrandom", { min: [0, 0, -5], max: [0, 0, 5], exponent: 1 }],
    ["operator", "movement", { gravity: [0, 0, 0], drag: 0, flags: 0 }],
    ["operator", "angularmovement", { force: [0, 0, 0], drag: 0, ...BLEND }],
    ["operator", "alphafade", { fadeintime: 0.5, fadeouttime: 0.5 }],
    [
      "operator",
      "oscillateposition",
      {
        mask: [1, 1, 0],
        frequencymin: 1,
        frequencymax: 5,
        scalemin: 0,
        scalemax: 10,
        phasemin: 0,
        phasemax: TWO_PI,
        ...BLEND,
      },
    ],
    [
      "operator",
      "oscillatealpha",
      { frequencymin: 1, frequencymax: 10, scalemin: 0, scalemax: 1, phasemin: 0, phasemax: TWO_PI, ...BLEND },
    ],
    ["renderer", "sprite", { orientation: "screen", axis: [0, 0, 0], flags: 0 }],
    // P4b 步骤 3（rea-p4b-modules.md A0、A4、B1、B4、B5、B7、B8）
    [
      "emitter",
      "boxrandom",
      {
        origin: [0, 0, 0],
        directions: [1, 1, 0],
        distancemin: [0, 0, 0],
        distancemax: [256, 256, 0],
        speedmin: 0,
        speedmax: 0,
        controlpoint: 0,
        rate: 10,
        duration: 0,
        delay: 0,
        instantaneous: 0,
        flags: 0,
        minperiodicduration: 2,
        maxperiodicduration: 3,
        minperiodicdelay: 1,
        maxperiodicdelay: 2,
        maxtoemitperperiod: 0,
        ...AUDIO,
      },
    ],
    ["initializer", "alpharandom", { min: 0.05, max: 1, exponent: 1 }],
    ["operator", "sizechange", { startvalue: 1, endvalue: 0, starttime: 0, endtime: 1 }],
    ["operator", "alphachange", { startvalue: 1, endvalue: 0, starttime: 0, endtime: 1 }],
    ["operator", "colorchange", { startvalue: [1, 1, 1], endvalue: [0, 0, 0], starttime: 0, endtime: 1 }],
    [
      "operator",
      "oscillatesize",
      { frequencymin: 1, frequencymax: 10, phasemin: 0, phasemax: TWO_PI, scalemin: 0.8, scalemax: 1.2, ...BLEND },
    ],
    [
      "operator",
      "vortex",
      {
        offset: [0, 0, 0],
        axis: [0, 0, 1],
        distanceinner: 500,
        distanceouter: 650,
        speedinner: 2500,
        speedouter: 0,
        flags: 0,
        controlpoint: 0,
        ...AUDIO,
      },
    ],
    ["operator", "capvelocity", { maxspeed: 100, ...BLEND }],
    // P4c 步骤 5（rea-p4c-render.md 6.1）：`FUN_1401c0af0` 只补 length、maxlength，正交透视一套；minlength 不补，读成 0
    [
      "renderer",
      "spritetrail",
      { length: 0.05, maxlength: 10, minlength: 0, orientation: "screen", axis: [0, 0, 0], flags: 0 },
    ],
  ];

  it.each(ortho)("正交：%s %s", (category, name, expected) => {
    expect(defaults(category, name, true)).toEqual(expected);
  });

  it("透视那一套只在 distancemax、sizerandom、velocityrandom、oscillateposition.scalemax 与步骤 3 的几项上不同", () => {
    for (const [category, name, expected] of ortho) {
      const perspective = defaults(category, name, false);
      const changed = Object.keys(expected).filter(
        (field) => JSON.stringify(perspective[field]) !== JSON.stringify(expected[field]),
      );
      const differs: Record<string, string[]> = {
        sphererandom: ["distancemax"],
        sizerandom: ["min", "max"],
        velocityrandom: ["min", "max"],
        oscillateposition: ["scalemax"],
        boxrandom: ["directions", "distancemax"],
        vortex: ["distanceinner", "distanceouter", "speedinner"],
        capvelocity: ["maxspeed"],
      };
      expect(changed, name).toEqual(differs[name] ?? []);
    }
    expect(defaults("emitter", "sphererandom", false).distancemax).toBe(1);
    expect(defaults("initializer", "sizerandom", false)).toMatchObject({ min: 0.001, max: 1 });
    expect(defaults("initializer", "velocityrandom", false)).toMatchObject({ min: [-1, -1, -1], max: [1, 1, 1] });
    expect(defaults("operator", "oscillateposition", false).scalemax).toBe(0.5);
    expect(defaults("emitter", "boxrandom", false)).toMatchObject({ directions: [1, 1, 1], distancemax: [1, 1, 1] });
    expect(defaults("operator", "vortex", false)).toMatchObject({ distanceinner: 1, distanceouter: 2, speedinner: 1 });
    expect(defaults("operator", "capvelocity", false).maxspeed).toBe(1);
  });

  it("alpharandom 的缺省 min 是 float 0x3d4ccccd；oscillatesize 的 phasemax 是 float 0x40c90fdb", () => {
    const bits = (value: number) => new Uint32Array(new Float32Array([value]).buffer)[0];
    expect(bits(defaults("initializer", "alpharandom", true).min as number)).toBe(0x3d4ccccd);
    expect(bits(defaults("operator", "oscillatesize", true).phasemax as number)).toBe(0x40c90fdb);
  });

  it("周期字段解析期 min = min(min, max)（A0）：只写 max 且小于缺省 min 时 min 跟着变小", () => {
    for (const name of ["sphererandom", "boxrandom"]) {
      const fields = readParticleModule(
        "emitter",
        { name, maxperiodicduration: 1, maxperiodicdelay: 0.5 },
        true,
      ).fields;
      expect(fields, name).toMatchObject({
        minperiodicduration: 1,
        maxperiodicduration: 1,
        minperiodicdelay: 0.5,
        maxperiodicdelay: 0.5,
      });
      expect(
        readParticleModule("emitter", { name, minperiodicduration: 0.2, maxperiodicduration: 4 }, true).fields,
      ).toMatchObject({ minperiodicduration: 0.2, maxperiodicduration: 4 });
    }
  });

  it("缺省值每次是新数组，改一份不影响下一次", () => {
    const first = defaults("emitter", "sphererandom", true);
    (first.directions as number[])[0] = 99;
    expect(defaults("emitter", "sphererandom", true).directions).toEqual([1, 1, 0]);
  });
});

describe("解析：字段形状", () => {
  it("字符串向量解析成数字数组，少写的分量补 0", () => {
    const fields = readParticleModule(
      "emitter",
      { name: "sphererandom", directions: "1.8 0.2 1", origin: " 3200   540 ", sign: "0 0 -1" },
      true,
    ).fields;
    expect(fields.directions).toEqual([1.8, 0.2, 1]);
    expect(fields.origin).toEqual([3200, 540, 0]);
    expect(fields.sign).toEqual([0, 0, -1]);
  });

  it("colorrandom 解析时 ÷255（缺省值同样换算）", () => {
    const fields = readParticleModule("initializer", { name: "colorrandom", min: "128 115 100" }, true).fields;
    expect(fields.min).toEqual([128 / 255, 115 / 255, 100 / 255]);
    expect(fields.max).toEqual([1, 1, 1]);
  });

  it("rotationrandom 的 min / max 写成数字时只作用于 z", () => {
    const numeric = readParticleModule("initializer", { name: "rotationrandom", min: 1, max: 3 }, true);
    expect(numeric.fields).toMatchObject({ min: [0, 0, 1], max: [0, 0, 3] });
    expect(numeric.issues).toEqual([]);
    const text = readParticleModule("initializer", { name: "rotationrandom", max: "6.283 6.283 6.283" }, true).fields;
    expect(text.max).toEqual([6.283, 6.283, 6.283]);
  });

  it("angularvelocityrandom 只接受字符串：数字保持缺省，不报", () => {
    const reading = readParticleModule("initializer", { name: "angularvelocityrandom", min: 1, max: "1 1 1" }, true);
    expect(reading.fields).toMatchObject({ min: [0, 0, -5], max: [1, 1, 1] });
    expect(reading.issues).toEqual([]);
  });

  it("sign 非零时 emitter flags 自动置 bit0（支持）", () => {
    const reading = readParticleModule("emitter", { name: "sphererandom", sign: "0 0 1" }, true);
    expect(reading.fields.flags).toBe(1);
    expect(reading.issues).toEqual([]);
  });

  it("controlpoint 下标（sphererandom、boxrandom、vortex）：取整后和 7 按无符号取小，负数得 7（P4c 步骤 1）", () => {
    for (const [category, name] of [
      ["emitter", "sphererandom"],
      ["emitter", "boxrandom"],
      ["operator", "vortex"],
    ] as const) {
      const index = (controlpoint: unknown) =>
        readParticleModule(category, { name, controlpoint }, true).fields.controlpoint;
      expect(index(undefined), name).toBe(0);
      expect(index(3), name).toBe(3);
      expect(index(2.9), name).toBe(2);
      expect(index(7), name).toBe(7);
      expect(index(8), name).toBe(7);
      expect(index(-1), name).toBe(7);
      expect(index(-0.5), name).toBe(0);
      expect(index(2 ** 32 + 1), name).toBe(1);
      expect(index(1e30), name).toBe(0);
    }
  });

  it("null 当缺键；id 记下来，name / id 不算字段", () => {
    const reading = readParticleModule("operator", { name: "movement", id: 7, drag: null }, true);
    expect(reading).toMatchObject({ name: "movement", id: 7, known: true, issues: [] });
    expect(reading.fields.drag).toBe(0);
  });
});

describe("解析：系统", () => {
  const system: JsonObject = {
    material: "materials/m.json",
    maxcount: 200,
    starttime: 50,
    flags: 4,
    emitter: [{ name: "sphererandom", rate: 3.5 }],
    initializer: [
      { name: "lifetimerandom", min: 1, max: 1 },
      { name: "boxrandom" },
      { name: "lifetimerandom", min: 2, max: 2 },
    ],
    operator: [{ name: "alphafade" }, { name: "movement" }, { name: "oscillatealpha" }, { name: "movement", drag: 1 }],
  };

  it("emitters / initializers / operators 按 JSON 顺序保留（不排序、不去重，表外模块也留位置）", () => {
    const particle = parseParticle(system, { file: "particles/p.json", orthographic: true });
    expect(particle.operators.map((module) => module.name)).toEqual([
      "alphafade",
      "movement",
      "oscillatealpha",
      "movement",
    ]);
    expect(particle.operators[3].fields.drag).toBe(1);
    expect(particle.initializers.map((module) => [module.name, module.fields.min])).toEqual([
      ["lifetimerandom", 1],
      ["boxrandom", undefined],
      ["lifetimerandom", 2],
    ]);
    expect(particle.emitters[0].fields.rate).toBe(3.5);
    expect(particle).toMatchObject({
      file: "particles/p.json",
      maxcount: 200,
      starttime: 50,
      flags: 4,
      animationMode: "sequence",
      sequenceMultiplier: 1,
      orthographic: true,
      passes: [],
    });
  });

  it("renderer 缺键或 null 时自动补一个 sprite；写成 [] 时不补（isArray 判断）", () => {
    for (const renderer of [undefined, null]) {
      const particle = parseParticle({ renderer }, { file: "p.json", orthographic: true });
      expect(particle.renderers).toEqual([
        { name: "sprite", id: null, fields: { orientation: "screen", axis: [0, 0, 0], flags: 0 } },
      ]);
    }
    expect(parseParticle({ renderer: [] }, { file: "p.json", orthographic: true }).renderers).toEqual([]);
    expect(
      parseParticle({ renderer: [{ id: 1, name: "sprite" }] }, { file: "p.json", orthographic: true }).renderers[0].id,
    ).toBe(1);
  });

  it("spritetrail（P4c 步骤 5，rea-p4c-render.md 6.1）：三个缺省值，minlength 不写为 0；负值与 minlength > maxlength 原样存", () => {
    const fields = (json: JsonObject) => readParticleModule("renderer", { name: "spritetrail", ...json }, true).fields;
    for (const orthographic of [true, false])
      expect(readParticleModule("renderer", { name: "spritetrail" }, orthographic).fields).toMatchObject({
        length: 0.05,
        maxlength: 10,
        minlength: 0,
      });
    expect(fields({ minlength: 12, maxlength: 10 })).toMatchObject({ length: 0.05, maxlength: 10, minlength: 12 });
    expect(fields({ length: -0.5, maxlength: -3, minlength: -1 })).toMatchObject({
      length: -0.5,
      maxlength: -3,
      minlength: -1,
    });
    // null 当缺键
    expect(fields({ minlength: null, length: null })).toMatchObject({ length: 0.05, minlength: 0 });
  });

  it("renderer 的 flags 只留低 8 位（FUN_140085f70 取无符号整数后存一个字节，0x1401c29b2）", () => {
    const flags = (value: unknown) =>
      readParticleModule("renderer", { name: "sprite", flags: value }, true).fields.flags;
    expect(flags(1)).toBe(1);
    expect(flags(255)).toBe(255);
    expect(flags(256)).toBe(0);
    expect(flags(257)).toBe(1);
    expect(flags(-1)).toBe(255);
    expect(flags(1.9)).toBe(1);
    expect(flags(2 ** 32 + 3)).toBe(3);
    expect(readParticleModule("renderer", { name: "spritetrail", flags: 0x1ff }, true).fields.flags).toBe(0xff);
  });

  it("particleRenderer：第一个表内的 renderer；拖尾的 g_RenderVar0 按 float32 原样存，sprite 为 null；没有 renderer 时是缺省的 sprite", () => {
    const parse = (renderer: unknown) => parseParticle({ renderer }, { file: "p.json", orthographic: true }).renderer;
    const trail = parse([{ name: "spritetrail", length: 0.08, maxlength: 7.3, minlength: 12, orientation: "fixed" }]);
    expect(trail.kind).toBe("spritetrail");
    expect(trail.trail).toEqual([Math.fround(0.08), Math.fround(7.3), 12]);
    expect(trail.orientation.mode).toBe(2);
    expect(parse([{ name: "spritetrail" }]).trail).toEqual([Math.fround(0.05), 10, 0]);
    const sprite = parse(undefined);
    expect(sprite).toEqual({
      kind: "sprite",
      trail: null,
      orientation: { mode: 0, axis: [0, 1, 0], t: [0, 0, -1], flags: 0 },
      rope: null,
      ropetrail: null,
    });
    expect(parse([])).toEqual(sprite);
    expect(parse([{ name: "sprite", orientation: "upright", flags: 3 }]).orientation).toMatchObject({
      mode: 1,
      flags: 3,
    });
    // 表外 renderer 不算（能力表报），多个时取第一个表内的（只在强制渲染时用）；rope 两类进表后算（P4d 步骤 1、2）
    expect(parse([{ name: "foo" }, { name: "spritetrail" }]).kind).toBe("spritetrail");
    expect(parse([{ name: "ropetrail" }, { name: "spritetrail" }]).kind).toBe("ropetrail");
    expect(parse([{ name: "rope" }, { name: "spritetrail" }]).kind).toBe("rope");
    expect(parse([{ name: "sprite" }, { name: "spritetrail" }]).kind).toBe("sprite");
  });

  it("maxcount、starttime、flags、animationmode、sequencemultiplier：缺键与 null 取缺省", () => {
    expect(readParticleSystem({})).toEqual({
      maxcount: 0,
      starttime: 0,
      flags: 0,
      animationMode: "sequence",
      sequenceMultiplier: 1,
    });
    expect(
      readParticleSystem({
        maxcount: null,
        starttime: null,
        flags: null,
        animationmode: null,
        sequencemultiplier: null,
      }),
    ).toEqual(readParticleSystem({}));
    expect(
      readParticleSystem({
        maxcount: 512,
        starttime: -2,
        flags: 6,
        animationmode: "randomframe",
        sequencemultiplier: 3,
      }),
    ).toEqual({ maxcount: 512, starttime: -2, flags: 6, animationMode: "randomframe", sequenceMultiplier: 3 });
    expect(readParticleSystem({ animationmode: "sequence" }).animationMode).toBe("sequence");
  });

  it("透视场景用另一套缺省值", () => {
    const particle = parseParticle(
      { emitter: [{ name: "sphererandom" }], initializer: [{ name: "sizerandom" }] },
      { file: "p.json", orthographic: false },
    );
    expect(particle.orthographic).toBe(false);
    expect(particle.emitters[0].fields.distancemax).toBe(1);
    expect(particle.initializers[0].fields).toMatchObject({ min: 0.001, max: 1 });
  });

  it("正交判定：orthogonalprojection 是对象，auto 为真或宽高都非 0", () => {
    expect(isOrthographic(ORTHO)).toBe(true);
    expect(isOrthographic({ orthogonalprojection: { auto: true } })).toBe(true);
    expect(isOrthographic({ orthogonalprojection: { width: 0, height: 1080 } })).toBe(false);
    expect(isOrthographic({ orthogonalprojection: null })).toBe(false);
    expect(isOrthographic({})).toBe(false);
    expect(isOrthographic(undefined)).toBe(false);
  });
});

describe("解析：控制点数组（P4c 步骤 1，rea-p4c-sim.md 1.2）", () => {
  it("只在是数组时读，按下标取前 8 项，不是对象的项取缺省；总是 8 项", () => {
    const empty = { flags: 0, offset: [0, 0, 0] };
    for (const raw of [undefined, null, {}, "0 0 0", 3])
      expect(readControlPoints({ controlpoint: raw as never })).toEqual(Array(8).fill(empty));
    const points = readControlPoints({
      controlpoint: [{ id: 0, flags: 2 }, null, [1, 2], "x", { offset: "1 2 3" }, {}, {}, {}, { offset: "9 9 9" }],
    });
    expect(points).toHaveLength(8);
    expect(points[0]).toEqual({ flags: 2, offset: [0, 0, 0] });
    expect(points[1]).toEqual(empty);
    expect(points[2]).toEqual(empty);
    expect(points[3]).toEqual(empty);
    expect(points[4]).toEqual({ flags: 0, offset: [1, 2, 3] });
  });

  it("offset：只在是字符串时解析，三段各自 atof（只认空格分隔），缺的分量 0，读不出数的分量 0", () => {
    const offset = (value: unknown) => readControlPoints({ controlpoint: [{ offset: value as never }] })[0].offset;
    expect(offset("100 50 0")).toEqual([100, 50, 0]);
    expect(offset("100.00000 -9999.5 3")).toEqual([100, -9999.5, 3]);
    // 不是字符串：保持 0 0 0（关键帧另由能力表报）
    expect(offset(5)).toEqual([0, 0, 0]);
    expect(offset({ value: "1 2 3" })).toEqual([0, 0, 0]);
    expect(offset(null)).toEqual([0, 0, 0]);
    // 分量不足、空串
    expect(offset("7")).toEqual([7, 0, 0]);
    expect(offset("7 8")).toEqual([7, 8, 0]);
    expect(offset("")).toEqual([0, 0, 0]);
    // 有非数字：atof 从能读的前缀取值，读不出取 0；多余的分量忽略
    expect(offset("abc 2 3")).toEqual([0, 2, 3]);
    expect(offset("1x 2y z")).toEqual([1, 2, 0]);
    expect(offset("1 2 3 4")).toEqual([1, 2, 3]);
    // 分隔只认空格：逗号分隔时第一段 atof 读到 1，后面找不到空格
    expect(controlPointOffset("1,2,3")).toEqual([1, 0, 0]);
    // 串首的空格：第一段 atof 自己跳过，第二段先跳过「非空格」（一个也没有）再跳空格，又落在第一个数上
    expect(controlPointOffset(" 5 6 7")).toEqual([5, 5, 6]);
    // 连续空格当一个
    expect(controlPointOffset("1   2  3")).toEqual([1, 2, 3]);
  });

  it("flags：数字取整后按无符号 32 位，布尔 1 / 0，其余 0；angles、locktopointer、id 不读；parentcontrolpoint 写了才带（P4e 步骤 1）", () => {
    const flags = (value: unknown) => readControlPoints({ controlpoint: [{ flags: value as never }] })[0].flags;
    expect(flags(2)).toBe(2);
    expect(flags(1.9)).toBe(1);
    expect(flags(-1)).toBe(0xffffffff);
    expect(flags(true)).toBe(1);
    expect(flags(false)).toBe(0);
    expect(flags("1")).toBe(0);
    expect(flags(null)).toBe(0);
    expect(
      readControlPoints({
        controlpoint: [{ id: 3, angles: "0 0 1.5708", locktopointer: true, foo: 1 }],
      })[0],
    ).toEqual({ flags: 0, offset: [0, 0, 0] });
    // `parentcontrolpoint`（rea-p4c-sim.md 1.2）：`asInt`、存 u32（负数当很大的无符号数），null 当缺键
    const parent = (value: unknown) =>
      readControlPoints({ controlpoint: [{ parentcontrolpoint: value as never }] })[0].parent;
    expect(parent(2)).toBe(2);
    expect(parent(-1)).toBe(0xffffffff);
    expect(parent(null)).toBeUndefined();
    expect(parent(undefined)).toBeUndefined();
  });

  it("parseParticle 填 controlpoints", () => {
    const particle = parseParticle(
      { controlpoint: [{ id: 0 }, { id: 1, offset: "100 0 0", flags: 4 }] },
      { file: "p.json", orthographic: true },
    );
    expect(particle.controlpoints[1]).toEqual({ flags: 4, offset: [100, 0, 0] });
    expect(particle.controlpoints).toHaveLength(8);
  });
});

describe("解析：instanceoverride 的静态值", () => {
  it("缺省全为 1，colorn 与控制点未设为 null", () => {
    for (const raw of [undefined, null, {}]) {
      const instance = parseParticleInstance(raw);
      expect(instance).toMatchObject({
        alpha: 1,
        size: 1,
        count: 1,
        speed: 1,
        lifetime: 1,
        rate: 1,
        brightness: 1,
        colorn: null,
      });
      expect(instance.controlpoints).toEqual(Array(8).fill(null));
      expect(instance.controlpointAngles).toEqual(Array(8).fill(null));
    }
  });

  it("{user} / {script} 只取 JSON 里的 value，不读用户属性", () => {
    const instance = parseParticleInstance({
      alpha: 10,
      count: { user: "count", value: 2 },
      rate: { script: "export function update(v) { return v; }", scriptproperties: {}, value: 0.5 },
      size: "1.5",
      id: 33,
    });
    expect(instance).toMatchObject({ alpha: 10, count: 2, rate: 0.5, size: 1.5 });
  });

  it("colorn 直接用；color（0–255）÷255 后 %.5f 往返转成 colorn（float32）；控制点按下标", () => {
    expect(parseParticleInstance({ colorn: "1.00000 0.50000 0.00000" }).colorn).toEqual([1, 0.5, 0]);
    expect(parseParticleInstance({ color: "255 0 51" }).colorn).toEqual([1, 0, Math.fround(0.2)]);
    const instance = parseParticleInstance({ controlpoint1: "10 20 0", controlpointangle3: "0 0 1" });
    expect(instance.controlpoints[1]).toEqual([10, 20, 0]);
    expect(instance.controlpointAngles[3]).toEqual([0, 0, 1]);
    expect(instance.controlpoints[0]).toBeNull();
  });
});

describe("能力表：粒子", () => {
  it("粒子对象不报 object:particle，也不再报临时键 particle:pending（P4a 步骤 5 删掉）", () => {
    const keys = new Set<string>();
    checkObjectFeatures({ id: 1, particle: "particles/p.json", origin: "1 2 3", visible: true }, keys);
    expect([...keys]).toEqual([]);
  });

  it("粒子对象带 effects 报 particle:effects；空数组不报", () => {
    const keys = new Set<string>();
    checkObjectFeatures({ id: 1, particle: "p.json", effects: [] }, keys);
    expect([...keys]).toEqual([]);
    checkObjectFeatures({ id: 1, particle: "p.json", effects: [{ file: "effects/tint/effect.json" }] }, keys);
    expect([...keys].sort()).toEqual(["particle:effects"]);
  });

  it("粒子对象的 instanceoverride 不按对象规则报（由 checkParticleInstance 按键检查）；其它对象上照未知键报", () => {
    const keys = new Set<string>();
    checkObjectFeatures(
      {
        id: 1,
        particle: "p.json",
        angles: "0 0.4 0.1",
        scale: "1 1 1",
        visible: { user: { name: "style", condition: "1" }, value: false },
        parallaxDepth: "1 1",
        locktransforms: false,
        instanceoverride: { id: 12, count: 2, colorn: "1 0 0" },
      },
      keys,
    );
    expect([...keys]).toEqual([]);
    // 图像对象上 WPE 不读 instanceoverride，照未知键报（语料 0 个）
    const image = new Set<string>();
    checkObjectFeatures({ id: 2, image: "models/a.json", instanceoverride: { count: 2 } }, image);
    expect([...image]).toEqual(["object:instanceoverride"]);
  });

  it("粒子对象的 alpha、color、brightness 取非默认值或绑了属性 / 脚本时报 particle:object:<键>（P4a 步骤 4）", () => {
    const keysOf = (extra: Record<string, unknown>) => {
      const keys = new Set<string>();
      checkObjectFeatures({ id: 1, particle: "p.json", ...extra }, keys);
      return [...keys].sort();
    };
    // 默认值（编辑器照写的那几种写法）与缺键都不报
    expect(keysOf({ alpha: 1, color: "1 1 1", brightness: 1 })).toEqual([]);
    expect(keysOf({ alpha: "1", color: "1.0 1 1", brightness: null })).toEqual([]);
    expect(keysOf({})).toEqual([]);
    // 解析不出数字时编译按默认值处理，也不报
    expect(keysOf({ color: "abc" })).toEqual([]);
    expect(keysOf({ alpha: 0.5 })).toEqual(["particle:object:alpha"]);
    expect(keysOf({ color: "1 0.5 1" })).toEqual(["particle:object:color"]);
    expect(keysOf({ brightness: 2 })).toEqual(["particle:object:brightness"]);
    expect(keysOf({ alpha: { user: "a", value: 1 } })).toEqual(["particle:object:alpha"]);
    expect(keysOf({ color: { script: "export function update(v) { return v; }", value: "1 1 1" } })).toEqual([
      "particle:object:color",
    ]);
    // 图像对象不受影响
    const image = new Set<string>();
    checkObjectFeatures({ id: 2, image: "models/a.json", alpha: 0.5, color: "1 0 0", brightness: 2 }, image);
    expect([...image]).toEqual([]);
  });

  it("表外模块：particle:<类别>:<名字>", () => {
    expect(
      particleKeys({
        emitter: [{ name: "layerimage" }],
        initializer: [{ name: "remapinitialvalue" }],
        operator: [{ name: "boids" }],
        renderer: [{ name: "foo" }],
      }),
    ).toEqual([
      // remapinitialvalue 从 P4d 步骤 4a 起在表里，只写名字时没有键
      "particle:emitter:layerimage",
      "particle:operator:boids",
      "particle:renderer:foo",
    ]);
    // 步骤 3 的 8 个模块进了表
    expect(
      particleKeys({
        emitter: [{ name: "boxrandom" }],
        initializer: [{ name: "alpharandom" }],
        operator: ["sizechange", "alphachange", "colorchange", "oscillatesize", "vortex", "capvelocity"].map(
          (name) => ({ name }),
        ),
      }),
    ).toEqual([]);
    // 步骤 4 的 3 个噪声类模块进了表
    expect(
      particleKeys({
        initializer: [{ name: "turbulentvelocityrandom" }, { name: "positionoffsetrandom" }],
        operator: [{ name: "turbulence" }],
      }),
    ).toEqual([]);
    expect(particleKeys({ operator: [{ id: 3 }] })).toEqual(["particle:operator:unnamed"]);
  });

  it("档 1 的典型写法不报（shimmering_particles 的 small_motes）", () => {
    expect(
      particleKeys({
        children: null,
        controlpoint: Array.from({ length: 8 }, (_, id) => ({ flags: 0, id, offset: "0 0 0" })),
        emitter: [
          { directions: "1.8 0.3 1", distancemax: 500, distancemin: 0, id: 8, name: "sphererandom", rate: 3.5 },
        ],
        flags: 4,
        initializer: [
          { id: 2, max: 70, min: 48, name: "lifetimerandom" },
          { exponent: 2, id: 3, max: 60, min: 20, name: "sizerandom" },
          { id: 4, max: "-17 3 0", min: "-3 -3 0", name: "velocityrandom" },
          { id: 5, name: "colorrandom" },
          { exponent: 6, id: 6, max: "1 1 1", min: "0 0 0", name: "angularvelocityrandom" },
          { id: 7, max: "6.283 6.283 6.283", name: "rotationrandom" },
        ],
        material: "materials/particle/dustmote_1.json",
        maxcount: 400,
        operator: [
          { id: 9, name: "movement" },
          { frequencymax: 0.6, frequencymin: 0.1, id: 10, mask: "0.3 0.5 0", name: "oscillateposition" },
          { fadeintime: 0.1, id: 11, name: "alphafade" },
          { frequencymax: 6, id: 12, name: "oscillatealpha", phasemax: 1, scalemin: 0.1 },
          { id: 13, name: "angularmovement" },
        ],
        renderer: [{ id: 1, name: "sprite" }],
        starttime: 200,
        animationmode: null,
        sequencemultiplier: null,
      }),
    ).toEqual([]);
  });

  it("表内模块的未知字段：particle:<类别>:<名字>:<字段>（不带 blend 的模块写 blend、不读音频的模块写 audioprocessing*）", () => {
    // 音频的五个键只在读它的六个模块里登记（P4e 步骤 1）：mode 非 0 只报 mode，其余键形状对就不报
    expect(
      particleKeys(
        withModule("emitter", { name: "sphererandom", audioprocessingmode: 3, audioprocessingbounds: "0 1" }),
      ),
    ).toEqual(["particle:emitter:sphererandom:audioprocessingmode"]);
    expect(particleKeys(withModule("operator", { name: "movement", audioprocessingmode: 0 }))).toEqual([
      "particle:operator:movement:audioprocessingmode",
    ]);
    expect(particleKeys(withModule("operator", { name: "movement", blendinstart: 0.2 }))).toEqual([
      "particle:operator:movement:blendinstart",
    ]);
    // 带 blend 的模块写 blend 不报
    expect(
      particleKeys(withModule("operator", { name: "oscillatealpha", blendinstart: 0.2, blendoutend: 0.9 })),
    ).toEqual([]);
  });

  it("字段形状不对：同样报 particle:<类别>:<名字>:<字段>", () => {
    expect(particleKeys(withModule("emitter", { name: "sphererandom", rate: "10", origin: 5 }))).toEqual([
      "particle:emitter:sphererandom:origin",
      "particle:emitter:sphererandom:rate",
    ]);
  });

  it("本节不支持的取值：emitter flags 带 bit3 以上，movement flags 带 bit0 以外的位；delay、duration、controlpoint 任意值都支持", () => {
    for (const name of ["sphererandom", "boxrandom"]) {
      const emitter = (fields: JsonObject) => particleKeys(withModule("emitter", { name, ...fields }));
      expect(emitter({ controlpoint: 0, delay: 0.5, duration: 2, flags: 7 }), name).toEqual([]);
      expect(emitter({ duration: -1, delay: -2 }), name).toEqual([]);
      // 控制点下标（P4c 步骤 1）：任意数字都支持，写成字符串照报形状问题
      for (const controlpoint of [1, 7, 9, -1])
        expect(emitter({ controlpoint }), `${name} ${controlpoint}`).toEqual([]);
      expect(emitter({ controlpoint: "1" })).toEqual([`particle:emitter:${name}:controlpoint`]);
      expect(emitter({ flags: 8 })).toEqual([`particle:emitter:${name}:flags`]);
      expect(emitter({ flags: 0x80000000 })).toEqual([`particle:emitter:${name}:flags`]);
    }
    // movement 的 flags（P4c 步骤 4）：bit0（本地系统重力按 Mᵀ 变换）支持，其余位没找到读者，保守报
    const movement = (flags: unknown) => particleKeys(withModule("operator", { name: "movement", flags }));
    expect(movement(0)).toEqual([]);
    expect(movement(1)).toEqual([]);
    for (const flags of [2, 3, 4, -1])
      expect(movement(flags), String(flags)).toEqual(["particle:operator:movement:flags"]);
    // 世界空间系统里写 flags 1 同样不报（WPE 照常解析，执行时不变换）
    expect(particleKeys({ flags: 1, operator: [{ name: "movement", flags: 1 }] })).toEqual([]);
  });

  it("周期发射的字段有没有 bit2 都支持（P4b 步骤 3）", () => {
    const periodic = {
      minperiodicduration: 0.5,
      maxperiodicduration: 0.5,
      minperiodicdelay: 0.5,
      maxperiodicdelay: 1,
      maxtoemitperperiod: 3,
      instantaneous: 3,
    };
    for (const name of ["sphererandom", "boxrandom"]) {
      expect(particleKeys(withModule("emitter", { name, ...periodic }))).toEqual([]);
      expect(particleKeys(withModule("emitter", { name, flags: 4, ...periodic }))).toEqual([]);
      expect(particleKeys(withModule("emitter", { name, flags: 6, ...periodic }))).toEqual([]);
    }
  });

  it("boxrandom：距离是向量、只接受字符串，写成数字报；没有 sign、cone；audioprocessing* 照报（P4e）", () => {
    const box = (fields: JsonObject) => particleKeys(withModule("emitter", { name: "boxrandom", ...fields }));
    expect(box({ distancemin: "50 50 0", distancemax: "100 100 0", directions: "1 1 0", speedmax: 5 })).toEqual([]);
    expect(box({ distancemin: 0, distancemax: 100 })).toEqual([
      "particle:emitter:boxrandom:distancemax",
      "particle:emitter:boxrandom:distancemin",
    ]);
    expect(box({ sign: "0 1 0", cone: 0.5 })).toEqual([
      "particle:emitter:boxrandom:cone",
      "particle:emitter:boxrandom:sign",
    ]);
    expect(box({ audioprocessingmode: 1 })).toEqual(["particle:emitter:boxrandom:audioprocessingmode"]);
    expect(readParticleModule("emitter", { name: "boxrandom", distancemax: "7 8" }, true).fields.distancemax).toEqual([
      7, 8, 0,
    ]);
  });

  it("vortex：flags 只认 bit0，controlpoint 任意值都支持（P4c 步骤 1），audioprocessingmode 非 0 照报（P4e 步骤 4）", () => {
    const vortex = (fields: JsonObject) => particleKeys(withModule("operator", { name: "vortex", ...fields }));
    expect(vortex({ flags: 1, offset: "100 0 0", axis: "0 1 0", controlpoint: 0 })).toEqual([]);
    expect(vortex({ flags: 2 })).toEqual(["particle:operator:vortex:flags"]);
    expect(vortex({ controlpoint: 2 })).toEqual([]);
    expect(vortex({ audioprocessingmode: 1, audioprocessingbounds: "0 1" })).toEqual([
      "particle:operator:vortex:audioprocessingmode",
    ]);
  });

  it("mode 0 的音频字段中性（P4e 步骤 1）：读音频的六个模块都登记了五个键，mode 非 0 只报 mode", () => {
    const audio = {
      audioprocessingmode: 0,
      audioprocessingexponent: 1.5,
      audioprocessingbounds: "0.5 1",
      audioprocessingfrequencystart: 2,
      audioprocessingfrequencyend: 16,
    };
    const modules: [ParticleCategory, string][] = [
      ["emitter", "sphererandom"],
      ["emitter", "boxrandom"],
      ["initializer", "turbulentvelocityrandom"],
      ["operator", "turbulence"],
      ["operator", "vortex"],
      ["operator", "vortex_v2"],
    ];
    for (const [category, name] of modules) {
      expect(particleKeys(withModule(category, { name, ...audio })), name).toEqual([]);
      expect(particleKeys(withModule(category, { name, ...audio, audioprocessingmode: 3 })), name).toEqual([
        `particle:${category}:${name}:audioprocessingmode`,
      ]);
      // 缺省值（rea-p4e-audio.md 第 2 节）
      expect(defaults(category, name, true), name).toMatchObject({
        audioprocessingmode: 0,
        audioprocessingexponent: 2,
        audioprocessingbounds: "0.8 1.0",
        audioprocessingfrequencystart: 0,
        audioprocessingfrequencyend: 1,
      });
    }
  });

  it("步骤 3 的其余模块：blend 只在 oscillatesize、capvelocity 上有；colorchange 的颜色只接受字符串", () => {
    expect(
      particleKeys({
        initializer: [{ name: "alpharandom", min: 0.2, max: 0.8, exponent: 2 }],
        operator: [
          { name: "sizechange", startvalue: 1, endvalue: 3, starttime: 0.2, endtime: 0.8 },
          { name: "alphachange", startvalue: 1, endvalue: 0, starttime: 0.5 },
          { name: "colorchange", startvalue: "1 0.5 0", endvalue: "0 1 1" },
          { name: "oscillatesize", frequencymax: 4, blendinstart: 0, blendinend: 0.5 },
          { name: "capvelocity", maxspeed: 50, blendoutstart: 0.5 },
        ],
      }),
    ).toEqual([]);
    expect(particleKeys(withModule("operator", { name: "sizechange", blendinend: 0.5 }))).toEqual([
      "particle:operator:sizechange:blendinend",
    ]);
    expect(particleKeys(withModule("operator", { name: "colorchange", startvalue: 1 }))).toEqual([
      "particle:operator:colorchange:startvalue",
    ]);
  });

  it("支持的取值：instantaneous、rate、sign、cone、exponent、drag、gravity", () => {
    expect(
      particleKeys({
        emitter: [{ name: "sphererandom", instantaneous: 50, rate: 0, sign: "0 0 1", cone: 0.5, speedmax: 3 }],
        initializer: [{ name: "lifetimerandom", exponent: 3 }],
        operator: [{ name: "movement", drag: 0.5, gravity: "0 -100 0" }],
      }),
    ).toEqual([]);
  });

  it("模块字段写成 {user} / {script}：particle:binding:<类别>:<名字>:<字段>", () => {
    expect(
      particleKeys({
        emitter: [{ name: "sphererandom", rate: { user: "count", value: 10 } }],
        operator: [{ name: "alphafade", fadeintime: { script: "export function update(v) { return v; }", value: 1 } }],
      }),
    ).toEqual(["particle:binding:emitter:sphererandom:rate", "particle:binding:operator:alphafade:fadeintime"]);
    // 静态值照常解析
    expect(
      readParticleModule("emitter", { name: "sphererandom", rate: { user: "count", value: 7 } }, true).fields.rate,
    ).toBe(7);
  });

  it("系统 flags：bit0–7 支持（bit0 世界空间 P4c 步骤 4，bit1 只关混帧 P4b 步骤 2）；更高位逐位报十进制位值", () => {
    for (const flags of [0, 1, 2, 4, 5, 6, 7, 8, 16, 32, 64, 128, 252, 254, 255])
      expect(particleKeys({ flags }), String(flags)).toEqual([]);
    expect(particleKeys({ flags: 256 + 1024 + 5 })).toEqual(["particle:flags:1024", "particle:flags:256"]);
  });

  it("children（P4e 步骤 1–3）：static 与三种事件类型都不报，不认识的类型中性；条目形状问题", () => {
    expect(particleKeys({ children: null })).toEqual([]);
    expect(particleKeys({ children: [] })).toEqual([]);
    expect(particleKeys({ children: { name: "particles/c.json" } })).toEqual([]);
    expect(
      particleKeys({
        children: [
          { name: "particles/c.json" },
          { name: "particles/c.json", type: "static", origin: "60 0 0", angles: "0 0 -50", scale: "2" },
          // 大小写不同的类型整条忽略（实测 st-type）
          { name: "particles/c.json", type: "Static" },
          { name: "particles/c.json", type: "Eventfollow" },
        ],
      }),
    ).toEqual([]);
    // eventfollow（P4e 步骤 2）、eventspawn / eventdeath（步骤 3）都已实现
    for (const type of ["eventfollow", "eventspawn", "eventdeath"])
      expect(
        particleKeys({ children: [{ name: "particles/c.json", type, maxcount: 2, probability: 0.5 }] }),
        type,
      ).toEqual([]);
    expect(particleKeys({ children: [{ type: "static" }, 5, { name: "" }] })).toEqual(["particle:child:name"]);
    expect(particleKeys({ children: [{ name: "c.json", origin: 5, scale: { user: "s", value: "1 1 1" } }] })).toEqual([
      "particle:binding:child:scale",
      "particle:child:origin",
      "particle:child:scale",
    ]);
    // 负的 controlpointstartindex 只在条目 flags bit0 时报（WPE 从负下标写，越界）
    expect(particleKeys({ children: [{ name: "c.json", controlpointstartindex: -1 }] })).toEqual([]);
    expect(particleKeys({ children: [{ name: "c.json", flags: 1, controlpointstartindex: -1 }] })).toEqual([
      "particle:child:controlpointstartindex",
    ]);
  });

  it("控制点（P4c 步骤 1、2）：全部支持或中性；flags bit0（指针）不再报，n 之内之外都一样", () => {
    const emitter = (controlpoint?: number) => ({
      name: "sphererandom",
      ...(controlpoint === undefined ? {} : { controlpoint }),
    });
    const neutral = [
      { id: 0, offset: "0 -9999 0", angles: "0 0 1", flags: 2 },
      { id: 1, flags: 4, parentcontrolpoint: 1, locktopointer: true, worldspace: true },
      { id: 2, flags: 8 + 16, offset: "1 2 3" },
      { id: 3, angles: "1 2 3", flags: 0x10001 },
    ];
    // 中性：offset、angles、flags 2 / 4 / 8 / 16、parentcontrolpoint、locktopointer、别的键
    expect(particleKeys({ emitter: [emitter(3)], controlpoint: neutral })).toEqual([]);
    // 指针（步骤 2 已实现）：被引用的点（缺省读控制点 0、读控制点 2、vortex 读控制点 1、钳成 7）和 n 之外的点都不报
    expect(particleKeys({ emitter: [emitter()], controlpoint: [{ id: 0, flags: 1 }] })).toEqual([]);
    expect(particleKeys({ emitter: [emitter(2)], controlpoint: [{}, {}, { flags: 3 }] })).toEqual([]);
    expect(particleKeys({ emitter: [emitter()], controlpoint: [{}, { flags: 1 }] })).toEqual([]);
    expect(
      particleKeys({
        emitter: [emitter()],
        operator: [{ name: "vortex", controlpoint: 1 }],
        controlpoint: [{}, { flags: 5 }],
      }),
    ).toEqual([]);
    const pointerAt7 = [...Array.from({ length: 7 }, (_, id) => ({ id })), { id: 7, flags: 1 }];
    expect(particleKeys({ emitter: [emitter(-1)], controlpoint: pointerAt7 })).toEqual([]);
    // 表外模块照旧自己报（P4d）
    expect(
      particleKeys({
        emitter: [emitter()],
        operator: [{ name: "boids", controlpoint: 1 }],
        controlpoint: [{}, { flags: 1 }],
      }),
    ).toEqual(["particle:operator:boids"]);
    // controlpointattract（P4c 步骤 3）在表里：它引用的指针点不报
    expect(
      particleKeys({
        emitter: [emitter()],
        operator: [{ name: "controlpointattract", controlpoint: 1 }],
        controlpoint: [{}, { flags: 1 }],
      }),
    ).toEqual([]);
    // 关键帧照报（整段 scanValue）
    expect(
      particleKeys({
        emitter: [emitter()],
        controlpoint: [{ flags: 1, offset: { animation: { c0: [] }, value: "0 0 0" } }],
      }),
    ).toEqual(["value:animation"]);
  });

  it("1838478131（步骤 2 解锁）：唯一的粒子系统控制点 0 跟随指针，没有不支持项", () => {
    // 照抄 scene.pkg 里的 particles/new_particle_system.json（键序、取值原样；null 当缺键）
    const system: JsonObject = {
      children: null,
      controlpoint: [
        { flags: 1, id: 0, offset: "0 0 0" },
        { flags: 0, id: 1, offset: "0 0 0" },
        { flags: 0, id: 2, offset: "0 0 0" },
        { flags: 0, id: 3, offset: "0 0 0" },
        { flags: 0, id: 4, offset: "0 0 0" },
        { flags: 0, id: 5, offset: "0 0 0" },
        { flags: 0, id: 6, offset: "0 0 0" },
        { flags: 0, id: 7, offset: "0 0 0" },
      ],
      emitter: [
        {
          directions: "1 1 0",
          distancemax: 32,
          distancemin: 0,
          id: 6,
          name: "sphererandom",
          origin: "0 0 0",
          rate: 150,
        },
      ],
      flags: null,
      initializer: [
        { exponent: 2, id: 2, max: 4, min: 2, name: "lifetimerandom" },
        { id: 3, max: 200, min: 50, name: "sizerandom" },
        { id: 4, max: "50 50 0", min: "-50 -50 0", name: "velocityrandom" },
        { id: 5, max: "134 132 255", min: "255 130 130", name: "colorrandom" },
      ],
      material: "materials/particle/halo_1.json",
      maxcount: 500,
      operator: [
        { drag: 0.4, gravity: "0 0 0", id: 7, name: "movement" },
        { fadeintime: 0.1, fadeouttime: 0.1, id: 8, name: "alphafade" },
        { id: 9, name: "sizechange" },
      ],
      renderer: [{ id: 1, name: "sprite" }],
      starttime: 0,
    };
    expect(particleKeys(system)).toEqual([]);
    expect(readControlPoints(system)[0]).toEqual({ flags: 1, offset: [0, 0, 0] });
  });

  it("animationmode、sequencemultiplier 任意取值都不报（P4b 步骤 2）；写成绑定或关键帧照报", () => {
    expect(particleKeys({ animationmode: "sequence", sequencemultiplier: 1 })).toEqual([]);
    expect(particleKeys({ animationmode: null, sequencemultiplier: null })).toEqual([]);
    expect(particleKeys({ animationmode: "randomframe" })).toEqual([]);
    expect(particleKeys({ sequencemultiplier: 3 })).toEqual([]);
    expect(particleKeys({ animationmode: "randomframe", sequencemultiplier: 0.5, flags: 2 })).toEqual([]);
    expect(particleKeys({ sequencemultiplier: { user: "m", value: 2 } })).toEqual([
      "particle:binding:system:sequencemultiplier",
    ]);
    expect(particleKeys({ animationmode: { script: "export function update(v) { return v; }", value: "x" } })).toEqual([
      "particle:binding:system:animationmode",
    ]);
    expect(
      particleKeys({ sequencemultiplier: { animation: { c0: [], options: { fps: 30, length: 30 } }, value: 2 } }),
    ).toEqual(["value:animation"]);
  });

  it("其它顶层键报 particle:system:<键>；顶层键绑定报 particle:binding:system:<键>；模块数组不是数组也报", () => {
    expect(particleKeys({ foo: 1, bar: null })).toEqual(["particle:system:foo"]);
    expect(particleKeys({ maxcount: { user: "n", value: 10 } })).toEqual(["particle:binding:system:maxcount"]);
    expect(particleKeys({ operator: { name: "movement" } })).toEqual(["particle:system:operator"]);
  });

  it("renderer（P4c 步骤 5）：sprite 的 orientation、axis、flags 各种取值不报；spritetrail 不报；两个 renderer 仍报 particle:renderers；rope 两类不报（P4d 步骤 1、2）", () => {
    for (const name of ["sprite", "spritetrail"]) {
      const renderer = (fields: JsonObject) => particleKeys({ renderer: [{ name, ...fields }] });
      expect(renderer({}), name).toEqual([]);
      for (const orientation of ["screen", "upright", "fixed", "Upright", "foo", ""])
        expect(renderer({ orientation }), `${name} ${orientation}`).toEqual([]);
      for (const axis of ["0 0 0", "0 1 0", "1 0 0", "0 0 1", "1 1 0", "0 0 0.000001", "0 -1 0", "-0 0 0"])
        expect(renderer({ axis }), `${name} ${axis}`).toEqual([]);
      for (const flags of [0, 1, 2, 3, 255, 256, -1, 1.5]) expect(renderer({ flags }), `${name} ${flags}`).toEqual([]);
      expect(renderer({ orientation: "fixed", axis: "1 0 1", flags: 1 }), name).toEqual([]);
    }
    expect(particleKeys({ renderer: [{ name: "spritetrail", length: 0.08, maxlength: 10, minlength: 12 }] })).toEqual(
      [],
    );
    // 形状不对照报（模块表的统一规则，比 WPE 严：WPE 的 axis 写成数字会把数字当指针读）
    expect(particleKeys({ renderer: [{ name: "sprite", axis: 1 }] })).toEqual(["particle:renderer:sprite:axis"]);
    expect(particleKeys({ renderer: [{ name: "spritetrail", length: "x" }] })).toEqual([
      "particle:renderer:spritetrail:length",
    ]);
    // 一个系统多个 renderer（WPE 各画一次、共用顶点缓冲，rea-p4c-render.md 6.3）：没做，照报
    expect(particleKeys({ renderer: [{ name: "sprite" }, { name: "sprite" }] })).toEqual(["particle:renderers"]);
    expect(particleKeys({ renderer: [{ name: "sprite" }, { name: "spritetrail" }] })).toEqual(["particle:renderers"]);
    expect(particleKeys({ renderer: [{ name: "spritetrail" }, { name: "sprite" }] })).toEqual(["particle:renderers"]);
    // rope 进表（P4d 步骤 1）：字段的各种取值都不报
    expect(particleKeys({ renderer: [{ name: "rope" }] })).toEqual([]);
    expect(
      particleKeys({
        renderer: [
          { name: "rope", subdivision: 40, uvscale: 0, uvscrolling: true, uvsmoothing: false, orientation: "fixed" },
        ],
      }),
    ).toEqual([]);
    expect(particleKeys({ renderer: [{ name: "rope", uvsmoothing: 0, uvscrolling: 1, subdivision: -3 }] })).toEqual([]);
    // 形状不对照报（模块表的统一规则）；绑定照报
    expect(particleKeys({ renderer: [{ name: "rope", uvscrolling: "yes" }] })).toEqual([
      "particle:renderer:rope:uvscrolling",
    ]);
    expect(particleKeys({ renderer: [{ name: "rope", subdivision: { user: "s", value: 3 } }] })).toEqual([
      "particle:binding:renderer:rope:subdivision",
    ]);
    // ropetrail 进表（P4d 步骤 2）：字段的各种取值都不报（钳制见 particles/ropetrail.test.ts）；形状不对、绑定照报
    expect(particleKeys({ renderer: [{ name: "ropetrail" }] })).toEqual([]);
    expect(
      particleKeys({
        renderer: [
          {
            name: "ropetrail",
            length: 0,
            segments: 40,
            subdivision: -1,
            fadealpha: true,
            fadesize: 1,
            uvscale: 0,
            uvscrolling: true,
            orientation: "upright",
          },
        ],
      }),
    ).toEqual([]);
    expect(particleKeys({ renderer: [{ name: "ropetrail", segments: "4" }] })).toEqual([
      "particle:renderer:ropetrail:segments",
    ]);
    expect(particleKeys({ renderer: [{ name: "ropetrail", length: { user: "l", value: 3 } }] })).toEqual([
      "particle:binding:renderer:ropetrail:length",
    ]);
    // 绳和别的 renderer 一起仍报多 renderer
    expect(particleKeys({ renderer: [{ name: "rope" }, { name: "sprite" }] })).toEqual(["particle:renderers"]);
    expect(particleKeys({ renderer: [{ name: "ropetrail" }, { name: "rope" }] })).toEqual(["particle:renderers"]);
  });

  it("风、重力键不报；perspectiveoverridefov 不报", () => {
    const keys = new Set<string>();
    checkSceneFeatures(
      {
        general: {
          ...ORTHO,
          gravitydirection: "0.34637 -0.93810 0.00000",
          gravitystrength: 50,
          windenabled: true,
          winddirection: "0.90523 -0.42492 0.00000",
          windstrength: 1000,
          perspectiveoverridefov: 30,
        },
        objects: [],
      },
      keys,
    );
    expect([...keys]).toEqual([]);
  });
});

describe("能力表：粒子材质的 COMBO 与光照", () => {
  const result = (combos: TranslateResult["combos"]): TranslateResult => ({ ok: true, combos });
  const check = (pass: MaterialPass, translated: TranslateResult | null = null) => {
    const keys = new Set<string>();
    checkParticleProgram(pass, translated, keys);
    return [...keys].sort();
  };

  it("非 0 的 COMBO 只允许 WORLDBLUR、USERCOLORBLEND、REFRACT、CUTOUT、NORMALMAP（后三个是 P4b 步骤 5）", () => {
    expect(check({ combos: { USERCOLORBLEND: 1, WORLDBLUR: 1, REFRACT: 1, CUTOUT: 1, NORMALMAP: 1 } })).toEqual([]);
    expect(check({ combos: { refract: true, cutout: true } })).toEqual([]);
    expect(check({ combos: { DOUBLESIDEDLIGHTING: 1 } })).toEqual(["particle:combo:DOUBLESIDEDLIGHTING"]);
  });

  it("LIGHTING 非 0 报 particle:lighting（材质写的或着色器缺省值）", () => {
    expect(check({ combos: { LIGHTING: 1 } })).toEqual(["particle:lighting"]);
    expect(check({}, result([{ name: "LIGHTING", value: 1, source: "default" }]))).toEqual(["particle:lighting"]);
  });

  it("着色器注解缺省值不算（genericparticle 的 FOG 缺省为 1）；纹理槽带出的算", () => {
    expect(check({}, result([{ name: "FOG", value: 1, source: "default" }]))).toEqual([]);
    // NORMALMAP 是槽 1 绑了纹理带出的（步骤 5 放行）；别的纹理槽 COMBO 照报
    expect(check({}, result([{ name: "NORMALMAP", value: 1, source: "texture" }]))).toEqual([]);
    expect(check({}, result([{ name: "SPECULARMAP", value: 1, source: "texture" }]))).toEqual([
      "particle:combo:SPECULARMAP",
    ]);
  });
});

describe("解析：perspectiveoverridefov", () => {
  it("缺省 95 度，按度钳到 [0.1, 179.9]，存弧度", () => {
    expect(particleFov(undefined)).toBeCloseTo((95 * Math.PI) / 180, 12);
    expect(particleFov(null)).toBeCloseTo((95 * Math.PI) / 180, 12);
    expect(particleFov(30)).toBeCloseTo(Math.PI / 6, 12);
    expect(particleFov(200)).toBeCloseTo((179.9 * Math.PI) / 180, 12);
    expect(particleFov(0)).toBeCloseTo((0.1 * Math.PI) / 180, 12);
    expect(particleFov("90")).toBeCloseTo(Math.PI / 2, 12);
  });
});

/** 内存文件：字符串原样，其它按 JSON。 */
function memoryReader(files: Record<string, unknown>): SceneReader {
  const reader: SceneReader = {
    async readWhole(path) {
      const value = files[path.replace(/\\/g, "/")];
      if (value === undefined) throw new TypeError("Failed to fetch");
      if (value instanceof Uint8Array) return value;
      return new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value));
    },
    async readRange(path, start, end) {
      return (await reader.readWhole(path)).slice(start, end);
    },
  };
  return reader;
}

/** 一级 mip、4×4 的原始 `.tex`（TEXB0002，不压缩）；解析不核对数据长度，只关心格式号。 */
function rawTex(format: number): Uint8Array {
  const magic = (text: string) => [...new TextEncoder().encode(text), 0];
  const word = (value: number) => [value & 255, (value >> 8) & 255, (value >> 16) & 255, (value >>> 24) & 255];
  return new Uint8Array([
    ...magic("TEXV0005"),
    ...magic("TEXI0001"),
    ...[format, 2, 4, 4, 4, 4, 0].flatMap(word),
    ...magic("TEXB0002"),
    // 图像数、mip 数；mip：宽、高、压缩、原始长度、存储长度
    ...[1, 1, 4, 4, 0, 64, 64].flatMap(word),
    ...new Array(64).fill(7),
  ]);
}

/** 记下每次翻译请求的假翻译器。 */
function fakeTranslator(reply: (request: TranslateRequest) => TranslateResult = () => ({ ok: true })) {
  const requests: TranslateRequest[] = [];
  const translator = {
    async translate(request: TranslateRequest): Promise<TranslateResult> {
      requests.push(request);
      return reply(request);
    },
  } as unknown as Wpesl2wgsl;
  return { translator, requests };
}

describe("ShaderCompiler：粒子的 TEX0FORMAT", () => {
  const fs = () =>
    new SceneFs(
      "P:/p",
      ["A:/assets"],
      memoryReader({
        "P:/p/shaders/genericparticle.vert": "void main(){}",
        "P:/p/shaders/genericparticle.frag": "void main(){}",
      }),
    );

  it("经 defines 传、进缓存键：两个格式各翻译一次，同一格式命中缓存", async () => {
    const { translator, requests } = fakeTranslator();
    const compiler = new ShaderCompiler(fs(), translator, new Set(), {}, { HDR: "1" });
    const textures: ShaderTextureSlot[] = [{ slot: 0, format: 9 }];
    await compiler.compile("genericparticle", {}, textures, null, undefined, { TEX0FORMAT: "8" });
    await compiler.compile("genericparticle", {}, textures, null, undefined, { TEX0FORMAT: "9" });
    await compiler.compile("genericparticle", {}, textures, null, undefined, { TEX0FORMAT: "9" });
    expect(requests.map((request) => request.defines)).toEqual([
      { HDR: "1", TEX0FORMAT: "8" },
      { HDR: "1", TEX0FORMAT: "9" },
    ]);
    // 不带宏（图层材质、槽 0 不是 8–11 的粒子材质）是另一条
    await compiler.compile("genericparticle", {}, textures, null);
    expect(requests.at(-1)!.defines).toEqual({ HDR: "1" });
    expect(requests).toHaveLength(3);
  });

  it("不带宏时缓存键与加宏之前逐字相同（图层材质不变）", () => {
    const combos = { b: 1, A: true };
    const textures: ShaderTextureSlot[] = [{ slot: 2, format: 8 }, { slot: 0, format: 4 }, { slot: 1 }];
    const scope = { dir: "effects/tint", first: true };
    const legacy = JSON.stringify([
      "genericimage2",
      scope.dir,
      scope.first,
      Object.entries(combos)
        .map(([name, value]) => [name.toUpperCase(), Number(value)])
        .sort(),
      textures.map((t) => [t.slot, t.format]).sort((a, b) => Number(a[0]) - Number(b[0])),
    ]);
    expect(shaderCacheKey("genericimage2", combos, textures, scope)).toBe(legacy);
    expect(shaderCacheKey("genericimage2", combos, textures, scope, {})).toBe(legacy);
    expect(shaderCacheKey("genericimage2", combos, textures, scope, { TEX0FORMAT: "9" })).not.toBe(legacy);
  });

  it("geometry（P4d 步骤 1）：读 .geom 放进请求、进缓存键；不带时缓存键与之前逐字相同", async () => {
    const { translator, requests } = fakeTranslator();
    const reader = memoryReader({
      "P:/p/shaders/genericropeparticle.vert": "v",
      "P:/p/shaders/genericropeparticle.frag": "f",
      "P:/p/shaders/genericropeparticle.geom": "g",
    });
    const compiler = new ShaderCompiler(new SceneFs("P:/p", ["A:/assets"], reader), translator, new Set());
    await compiler.compile("genericropeparticle", {}, [], null, undefined, {}, true);
    await compiler.compile("genericropeparticle", {}, [], null, undefined, {}, true);
    await compiler.compile("genericropeparticle", {}, [], null, undefined, {});
    expect(requests.map((request) => request.geometry)).toEqual(["g", undefined]);
    const textures: ShaderTextureSlot[] = [{ slot: 0, format: 0 }];
    const legacy = shaderCacheKey("genericparticle", {}, textures, null, { TEX0FORMAT: "9" });
    expect(shaderCacheKey("genericparticle", {}, textures, null, { TEX0FORMAT: "9" }, false)).toBe(legacy);
    expect(shaderCacheKey("genericparticle", {}, textures, null, { TEX0FORMAT: "9" }, true)).not.toBe(legacy);
  });

  it("WPE 的条件是槽 0 格式 ∈ 8–11（`(fmt - 8) <= 3` 无符号比较）", () => {
    expect([0, 4, 6, 7, 8, 9, 10, 11, 12, 13].filter(particleWritesTex0Format)).toEqual([8, 9, 10, 11]);
  });
});

describe("compileScene：粒子对象", () => {
  const scene = (objects: JsonObject[], general: JsonObject = ORTHO) => ({ general, objects });
  const files = (extra: Record<string, unknown> = {}) => ({
    "P:/p/project.json": { file: "scene.json" },
    "P:/p/particles/p.json": {
      material: "materials/pm.json",
      maxcount: 20,
      starttime: 2,
      emitter: [{ name: "sphererandom", rate: 5 }],
      initializer: [{ name: "sizerandom" }],
      operator: [{ name: "movement" }],
    },
    "P:/p/materials/pm.json": {
      passes: [{ shader: "genericparticle", blending: "additive", textures: ["_rt_FullFrameBuffer"] }],
    },
    "P:/p/models/a.json": { material: "materials/a.json", width: 40, height: 60 },
    "P:/p/materials/a.json": { passes: [{ shader: "genericimage2", textures: ["_rt_FullFrameBuffer"] }] },
    "P:/p/shaders/genericparticle.vert": "void main(){}",
    "P:/p/shaders/genericparticle.frag": "void main(){}",
    "P:/p/shaders/genericimage2.vert": "void main(){}",
    "P:/p/shaders/genericimage2.frag": "void main(){}",
    ...extra,
  });
  const compile = (reader: SceneReader, translator: Wpesl2wgsl | null = null) =>
    compileScene({
      projectDir: "P:/p",
      sceneAssets: ["A:/assets"],
      reader,
      translator,
      postprocess: "disabled",
      exhaustive: true,
    });

  it("粒子 JSON 解析进 layer.particle，材质 pass 放在 particle.passes、不进 layer.passes", async () => {
    const { translator, requests } = fakeTranslator(() => ({
      ok: true,
      // 粒子路径的引擎 uniform 在粒子 pass 里不报，在图层材质里照报
      uniforms: [{ name: "g_OrientationUp", type: "vec3<f32>", offset: 0, size: 12 }],
    }));
    const bundle = await compile(
      memoryReader(
        files({
          "P:/p/scene.json": scene([
            { id: 1, particle: "particles/p.json", instanceoverride: { count: { user: "count", value: 2 } } },
            { id: 2, image: "models/a.json" },
          ]),
        }),
      ),
      translator,
    );
    const [particleLayer, imageLayer] = bundle.layers;
    expect(particleLayer.passes).toEqual([]);
    expect(particleLayer.particle).toMatchObject({
      file: "particles/p.json",
      maxcount: 20,
      starttime: 2,
      orthographic: true,
      instance: { count: 2 },
    });
    expect(particleLayer.particle!.emitters[0].fields.rate).toBe(5);
    expect(particleLayer.particle!.passes.map((pass) => [pass.key, pass.program, pass.blending])).toEqual([
      ["objects/0/particle/passes/0", 0, "additive"],
    ]);
    expect(imageLayer.particle).toBeNull();
    // 粒子 pass 的槽 0 是 `_rt_FullFrameBuffer`（格式 0），不在 8–11，不写 TEX0FORMAT；图层材质也不写
    expect(requests.map((request) => request.defines?.TEX0FORMAT)).toEqual([undefined, undefined]);
    // g_OrientationUp 只在图层材质里报；instanceoverride 的 count 已实现，不报（P4a 步骤 5）
    expect(bundle.unsupported).toEqual(["uniform:g_OrientationUp"]);
    // instanceoverride 的 {user} 登记成就地目标（步骤 5）
    expect(bundle.bindings).toEqual([
      { property: "count", target: { kind: "particle-instance", object: 0, field: "count" } },
    ]);
    expect(bundle.general.perspectiveOverrideFov).toBeCloseTo((95 * Math.PI) / 180, 12);
  });

  it.each([
    [0, undefined],
    [4, undefined],
    [6, undefined],
    [7, undefined],
    [8, "8"],
    [9, "9"],
    [10, "10"],
    [11, "11"],
    [12, undefined],
  ])("槽 0 是格式 %i 的纹理：TEX0FORMAT = %s（WPE 只对 8–11 写）", async (format, expected) => {
    const { translator, requests } = fakeTranslator();
    const bundle = await compile(
      memoryReader(
        files({
          "P:/p/scene.json": scene([{ id: 1, particle: "particles/p.json" }]),
          "P:/p/materials/pm.json": { passes: [{ shader: "genericparticle", textures: ["kbt/t"] }] },
          "P:/p/materials/kbt/t.tex": rawTex(format),
        }),
      ),
      translator,
    );
    expect(requests.map((request) => request.defines?.TEX0FORMAT)).toEqual([expected]);
    expect(bundle.textures.map((texture) => texture.format)).toEqual([format]);
    // 格式 10 起不在格式表里，纹理照报；宏照 WPE 的条件写
    expect(bundle.unsupported).toEqual(format >= 10 ? [`tex:format:${format}`] : []);
  });

  it("拖尾的宏（P4c 步骤 5，rea-p4c-render.md 6.2）：THICKFORMAT、TRAILRENDERER；TEX0FORMAT 只在 8–11 写；sprite 不变", async () => {
    const defines = async (renderer: JsonObject[], format = 0) => {
      const { translator, requests } = fakeTranslator();
      const bundle = await compile(
        memoryReader(
          files({
            "P:/p/scene.json": scene([{ id: 1, particle: "particles/p.json" }]),
            "P:/p/particles/p.json": { material: "materials/pm.json", maxcount: 2, renderer },
            "P:/p/materials/pm.json": { passes: [{ shader: "genericparticle", textures: ["kbt/t"] }] },
            "P:/p/materials/kbt/t.tex": rawTex(format),
          }),
        ),
        translator,
      );
      expect(bundle.unsupported).toEqual([]);
      return requests.map((request) => request.defines);
    };
    expect(await defines([{ name: "spritetrail" }])).toEqual([
      { SCENE_ORTHO: "1", THICKFORMAT: "1", TRAILRENDERER: "1" },
    ]);
    // 拖尾走厚格式：朝向不进宏，TEX0FORMAT 仍只看 8–11
    expect(await defines([{ name: "spritetrail", orientation: "fixed", axis: "1 0 0", flags: 1 }])).toEqual([
      { SCENE_ORTHO: "1", THICKFORMAT: "1", TRAILRENDERER: "1" },
    ]);
    expect(await defines([{ name: "spritetrail" }], 9)).toEqual([
      { SCENE_ORTHO: "1", THICKFORMAT: "1", TRAILRENDERER: "1", TEX0FORMAT: "9" },
    ]);
    expect(await defines([{ name: "sprite" }])).toEqual([{ SCENE_ORTHO: "1" }]);
    expect(await defines([{ name: "sprite", flags: 1 }])).toEqual([{ SCENE_ORTHO: "1" }]);
  });

  describe("rope（P4d 步骤 1，rea-p4d-rope.md 3.4、第 6 节）", () => {
    const ropeFiles = (renderer: JsonObject, format = 0, extra: Record<string, unknown> = {}) =>
      files({
        "P:/p/scene.json": scene([{ id: 1, particle: "particles/p.json" }]),
        "P:/p/particles/p.json": {
          material: "materials/pm.json",
          maxcount: 8,
          emitter: [{ name: "sphererandom", rate: 4 }],
          renderer: [{ name: "rope", ...renderer }],
        },
        "P:/p/materials/pm.json": {
          passes: [{ shader: "genericparticle", blending: "additive", combos: { REFRACT: 1 }, textures: ["kbt/t"] }],
        },
        "P:/p/materials/kbt/t.tex": rawTex(format),
        "P:/p/shaders/genericropeparticle.vert": "rope vert",
        "P:/p/shaders/genericropeparticle.frag": "rope frag",
        "P:/p/shaders/genericropeparticle.geom": "rope geom",
        ...extra,
      });
    const compileRope = async (renderer: JsonObject, format = 0, extra: Record<string, unknown> = {}) => {
      const { translator, requests } = fakeTranslator(() => ({ ok: true, geometry: { maxVertices: 4 } }));
      const bundle = await compile(memoryReader(ropeFiles(renderer, format, extra)), translator);
      return { bundle, requests };
    };

    it("着色器无条件换成 genericropeparticle、带 .geom 翻译；blending、COMBO、纹理照旧取材质", async () => {
      const { bundle, requests } = await compileRope({});
      expect(bundle.unsupported).toEqual([]);
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        vertex: "rope vert",
        fragment: "rope frag",
        geometry: "rope geom",
        combos: { REFRACT: 1 },
        textures: [{ slot: 0, format: 0 }],
      });
      const pass = bundle.layers[0].particle!.passes[0];
      expect(pass).toMatchObject({ blending: "additive", textures: { 0: 0 }, program: 0 });
      expect(bundle.layers[0].particle!.renderer.kind).toBe("rope");
    });

    it("宏：THICKFORMAT、TRAILSUBDIVISION、ORIENTATION（值为 0 也写）；不写 TRAILRENDERER、SPRITESHEET*", async () => {
      expect((await compileRope({})).requests[0].defines).toEqual({
        SCENE_ORTHO: "1",
        THICKFORMAT: "1",
        TRAILSUBDIVISION: "4",
        ORIENTATION: "0",
      });
      expect((await compileRope({ subdivision: 40, orientation: "upright" })).requests[0].defines).toEqual({
        SCENE_ORTHO: "1",
        THICKFORMAT: "1",
        TRAILSUBDIVISION: "32",
        ORIENTATION: "1",
      });
      expect((await compileRope({ subdivision: 0, orientation: "fixed" })).requests[0].defines).toMatchObject({
        TRAILSUBDIVISION: "0",
        ORIENTATION: "2",
      });
    });

    it.each([
      [0, "screen", undefined],
      [4, "fixed", undefined],
      [7, "upright", undefined],
      [8, "screen", "8"],
      [9, "fixed", "9"],
      [11, "screen", "11"],
      [12, "upright", undefined],
    ] as const)(
      "槽 0 格式 %i、朝向 %s：TEX0FORMAT = %s（只看 8–11，不像非厚格式 sprite 那样看朝向）",
      async (format, orientation, expected) => {
        const { requests } = await compileRope({ orientation }, format);
        expect(requests.map((request) => request.defines?.TEX0FORMAT)).toEqual([expected]);
      },
    );

    it("缺 .geom：shader:genericropeparticle:missing；材质没写着色器也换（不报 shader:missing）", async () => {
      const missing = await compileRope({}, 0, { "P:/p/shaders/genericropeparticle.geom": undefined });
      expect(missing.bundle.unsupported).toEqual(["shader:genericropeparticle:missing"]);
      expect(missing.requests).toHaveLength(0);
      const unnamed = await compileRope({}, 0, {
        "P:/p/materials/pm.json": { passes: [{ textures: ["kbt/t"] }] },
      });
      expect(unnamed.bundle.unsupported).toEqual([]);
      expect(unnamed.requests.map((request) => request.geometry)).toEqual(["rope geom"]);
    });

    it("sprite 与 rope 同场：各翻译各的，sprite 的请求不带 geometry", async () => {
      const { translator, requests } = fakeTranslator();
      const reader = memoryReader(
        ropeFiles({}, 0, {
          "P:/p/scene.json": scene([
            { id: 1, particle: "particles/p.json" },
            { id: 2, particle: "particles/s.json" },
          ]),
          "P:/p/particles/s.json": { material: "materials/pm.json", maxcount: 2 },
        }),
      );
      const bundle = await compile(reader, translator);
      expect(bundle.unsupported).toEqual([]);
      expect(requests.map((request) => [request.vertex, request.geometry])).toEqual([
        ["rope vert", "rope geom"],
        ["void main(){}", undefined],
      ]);
    });

    describe("ropetrail（P4d 步骤 2，rea-p4d-rope.md 3.4、第 6 节）", () => {
      const compileTrail = async (renderer: JsonObject, format = 0) => {
        const { translator, requests } = fakeTranslator(() => ({ ok: true, geometry: { maxVertices: 6 } }));
        const reader = memoryReader(
          ropeFiles({}, format, {
            "P:/p/particles/p.json": {
              material: "materials/pm.json",
              maxcount: 8,
              emitter: [{ name: "sphererandom", rate: 4 }],
              renderer: [{ name: "ropetrail", ...renderer }],
            },
          }),
        );
        const bundle = await compile(reader, translator);
        return { bundle, requests };
      };

      it("同 rope 换成 genericropeparticle、带 .geom；不报不支持项", async () => {
        const { bundle, requests } = await compileTrail({});
        expect(bundle.unsupported).toEqual([]);
        expect(requests).toHaveLength(1);
        expect(requests[0]).toMatchObject({ vertex: "rope vert", geometry: "rope geom", combos: { REFRACT: 1 } });
        expect(bundle.layers[0].particle!.renderer.kind).toBe("ropetrail");
      });

      it("宏：TRAILSUBDIVISION、ORIENTATION、TRAILRENDERER；不写 THICKFORMAT、SPRITESHEET*；三个开关各自只在为真时写", async () => {
        expect((await compileTrail({})).requests[0].defines).toEqual({
          SCENE_ORTHO: "1",
          TRAILSUBDIVISION: "1",
          ORIENTATION: "0",
          TRAILRENDERER: "1",
        });
        expect(
          (
            await compileTrail({
              subdivision: 40,
              orientation: "fixed",
              uvscrolling: true,
              fadealpha: true,
              fadesize: 1,
            })
          ).requests[0].defines,
        ).toEqual({
          SCENE_ORTHO: "1",
          TRAILSUBDIVISION: "32",
          ORIENTATION: "2",
          TRAILRENDERER: "1",
          TRAILSCROLLALPHA: "1",
          TRAILFADEALPHA: "1",
          TRAILFADESIZE: "1",
        });
        // 渐隐不看 uvscrolling（WPE 照写，着色器只在滚动分支读，实测 T3）
        expect((await compileTrail({ fadealpha: true })).requests[0].defines).toEqual({
          SCENE_ORTHO: "1",
          TRAILSUBDIVISION: "1",
          ORIENTATION: "0",
          TRAILRENDERER: "1",
          TRAILFADEALPHA: "1",
        });
        expect((await compileTrail({ uvscrolling: true })).requests[0].defines).not.toHaveProperty("TRAILFADEALPHA");
      });

      it.each([
        [0, "upright", undefined],
        [7, "fixed", undefined],
        [8, "screen", "8"],
        [11, "upright", "11"],
      ] as const)(
        "槽 0 格式 %i、朝向 %s：TEX0FORMAT = %s（同 rope 只看 8–11）",
        async (format, orientation, expected) => {
          const { requests } = await compileTrail({ orientation }, format);
          expect(requests.map((request) => request.defines?.TEX0FORMAT)).toEqual([expected]);
        },
      );
    });
  });

  it.each([
    ["screen", 0, undefined],
    ["upright", 0, "0"],
    ["fixed", 4, "4"],
    ["fixed", 7, "7"],
    ["upright", 9, "9"],
    ["screen", 9, "9"],
  ] as const)(
    "非厚格式 sprite 朝向 %s、槽 0 格式 %i：TEX0FORMAT = %s（非 screen 朝向对任何格式都写，0x1401d3189）",
    async (orientation, format, expected) => {
      const { translator, requests } = fakeTranslator();
      await compile(
        memoryReader(
          files({
            "P:/p/scene.json": scene([{ id: 1, particle: "particles/p.json" }]),
            "P:/p/particles/p.json": {
              material: "materials/pm.json",
              maxcount: 2,
              renderer: [{ name: "sprite", orientation }],
            },
            "P:/p/materials/pm.json": { passes: [{ shader: "genericparticle", textures: ["kbt/t"] }] },
            "P:/p/materials/kbt/t.tex": rawTex(format),
          }),
        ),
        translator,
      );
      expect(requests.map((request) => request.defines?.TEX0FORMAT)).toEqual([expected]);
      expect(requests.map((request) => request.defines?.TRAILRENDERER)).toEqual([undefined]);
    },
  );

  it("槽 0 没按名字写时取着色器注解的 default 定 TEX0FORMAT", async () => {
    const annotated = (fallback: string) =>
      fakeTranslator(() => ({
        ok: true,
        textures: [
          { slot: 0, name: "g_Texture0", kind: "2d", binding: 1, samplerBinding: 2, meta: { default: fallback } },
        ],
      }));
    const reader = memoryReader(
      files({
        "P:/p/scene.json": scene([{ id: 1, particle: "particles/p.json" }]),
        "P:/p/materials/pm.json": { passes: [{ shader: "genericparticle" }] },
        "P:/p/materials/kbt/r8.tex": rawTex(9),
      }),
    );
    // 注解指向 R8 纹理：先不带宏读注解，再带宏正式翻译
    const r8 = annotated("kbt/r8");
    const r8Bundle = await compile(reader, r8.translator);
    expect(r8.requests.map((request) => request.defines?.TEX0FORMAT)).toEqual([undefined, "9"]);
    expect(r8Bundle.layers[0].particle!.passes[0].textures).toEqual({ 0: 0 });
    // 注解是 `_rt_FullFrameBuffer`（格式 0）：不写宏，正式翻译与读注解同一条缓存键，只翻译一次
    const framebuffer = annotated("_rt_FullFrameBuffer");
    const bundle = await compile(reader, framebuffer.translator);
    expect(framebuffer.requests.map((request) => request.defines?.TEX0FORMAT)).toEqual([undefined]);
    expect(bundle.layers[0].particle!.passes[0].runtime).toEqual({ 0: "_rt_FullFrameBuffer" });
  });

  it("读不到粒子 JSON 报 particle:missing:<路径>；不是 JSON 报 particle:parse:<路径>", async () => {
    const missing = await compile(
      memoryReader(files({ "P:/p/scene.json": scene([{ id: 1, particle: "particles/none.json" }]) })),
    );
    expect(missing.unsupported).toEqual(["particle:missing:particles/none.json"]);
    expect(missing.layers[0].particle).toBeNull();
    const broken = await compile(
      memoryReader(
        files({ "P:/p/scene.json": scene([{ id: 1, particle: "particles/p.json" }]), "P:/p/particles/p.json": "{" }),
      ),
    );
    expect(broken.unsupported).toEqual(["particle:parse:particles/p.json"]);
  });

  it("perspectiveoverridefov 解析进 SceneGeneral（弧度，钳制）；透视场景用透视缺省值", async () => {
    const wide = await compile(
      memoryReader(files({ "P:/p/scene.json": scene([], { ...ORTHO, perspectiveoverridefov: 200 }) })),
    );
    expect(wide.unsupported).toEqual([]);
    expect(wide.general.perspectiveOverrideFov).toBeCloseTo((179.9 * Math.PI) / 180, 12);
    const perspective = await compile(
      memoryReader(files({ "P:/p/scene.json": scene([{ id: 1, particle: "particles/p.json" }], {}) })),
    );
    expect(perspective.layers[0].particle!.orthographic).toBe(false);
    expect(perspective.layers[0].particle!.emitters[0].fields.distancemax).toBe(1);
    expect(perspective.unsupported).toContain("camera:perspective");
  });
});

const root = process.env.KABEGAME_WPE_ROOT;
const wasm = join(__dirname, "..", "wpesl2wgsl", "wpesl2wgsl.wasm");

const diskReader: SceneReader = {
  async readWhole(path) {
    try {
      return new Uint8Array(readFileSync(path));
    } catch {
      throw new TypeError("Failed to fetch");
    }
  },
  async readRange(path, start, end) {
    let bytes: Buffer;
    try {
      bytes = readFileSync(path);
    } catch {
      throw new TypeError("Failed to fetch");
    }
    if (start >= bytes.length) throw new TypeError("Failed to fetch");
    return new Uint8Array(bytes.subarray(start, end));
  },
};

describe.skipIf(!root || !existsSync(wasm))("本机样本：shimmering_particles", () => {
  it("粒子层都有 particle、pass 编译成功；没有不支持项（P4a 步骤 5 解锁）", async () => {
    const bundle = await compileScene({
      projectDir: join(root!, "projects", "defaultprojects", "shimmering_particles"),
      sceneAssets: [join(root!, "assets")],
      reader: diskReader,
      translator: await Wpesl2wgsl.fromBytes(readFileSync(wasm)),
      postprocess: "enabled",
      exhaustive: true,
    });
    const particles = bundle.layers.filter((layer) => layer.particle);
    // dust motes 与三个 small_motes_copy1
    expect(particles.map((layer) => [layer.object, layer.particle!.file])).toEqual([
      [0, "particles/dustmotes.json"],
      [2, "particles/small_motes_copy1.json"],
      [3, "particles/small_motes_copy1.json"],
      [4, "particles/small_motes_copy1.json"],
    ]);
    for (const layer of particles) {
      expect(layer.passes).toEqual([]);
      expect(layer.particle!.passes).toHaveLength(1);
      expect(layer.particle!.passes[0].key).toBe(`objects/${layer.object}/particle/passes/0`);
      expect(layer.particle!.passes[0].program).not.toBeNull();
    }
    expect(bundle.unsupported).toEqual([]);
    const dust = particles[0].particle!;
    expect(dust).toMatchObject({ maxcount: 200, starttime: 50, flags: 0, orthographic: true });
    expect(dust.renderers.map((module) => module.name)).toEqual(["sprite"]);
    expect(dust.operators.map((module) => module.name)).toEqual([
      "movement",
      "oscillateposition",
      "alphafade",
      "oscillatealpha",
    ]);
    const motes = particles[1].particle!;
    expect(motes).toMatchObject({ maxcount: 400, starttime: 200, flags: 4, instance: { alpha: 10, count: 1 } });
    // 两种材质 COMBO 不同，各是一个程序
    expect(new Set(particles.map((layer) => layer.particle!.passes[0].program)).size).toBe(2);
  }, 60000);

  it("instanceoverride 的 count 登记成就地目标；超高档（HDR 判定）下同样没有不支持项（P4a 步骤 5）", async () => {
    const bundle = await compileScene({
      projectDir: join(root!, "projects", "defaultprojects", "shimmering_particles"),
      sceneAssets: [join(root!, "assets")],
      reader: diskReader,
      translator: await Wpesl2wgsl.fromBytes(readFileSync(wasm)),
      postprocess: "ultra",
      exhaustive: true,
    });
    expect(bundle.unsupported).toEqual([]);
    expect(
      bundle.bindings.filter((binding) => binding.target.kind === "particle-instance").map((binding) => binding.target),
    ).toEqual([
      { kind: "particle-instance", object: 2, field: "count" },
      { kind: "particle-instance", object: 3, field: "count" },
    ]);
  }, 60000);
});

const workshopSample = root ? join(root, "..", "..", "workshop", "content", "431960", "3062029089") : "";

describe.skipIf(!root || !existsSync(wasm) || !existsSync(workshopSample))("本机样本：3062029089", () => {
  it("透视粒子（flags 4）的雪：编译后没有不支持项（P4a 步骤 5 解锁），关闭与超高两档相同", async () => {
    for (const postprocess of ["disabled", "ultra"] as const) {
      const bundle = await compileScene({
        projectDir: workshopSample,
        sceneAssets: [join(root!, "assets")],
        reader: diskReader,
        translator: await Wpesl2wgsl.fromBytes(readFileSync(wasm)),
        postprocess,
        exhaustive: true,
      });
      expect(bundle.unsupported, postprocess).toEqual([]);
      const particles = bundle.layers.filter((layer) => layer.particle);
      expect(particles.map((layer) => [layer.object, layer.particle!.file])).toEqual([
        [1, "particles/presets/snowperspective.json"],
      ]);
      expect(particles[0].particle).toMatchObject({ maxcount: 360, starttime: 15, flags: 4 });
      expect(particles[0].particle!.passes[0].program).not.toBeNull();
    }
  }, 60000);
});
