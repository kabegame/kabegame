import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { compileScene } from "./bundle";
import { checkObjectFeatures, checkParticleFeatures, checkParticleProgram, checkSceneFeatures } from "./features";
import { SceneFs, type SceneReader } from "./fs";
import type { JsonObject, MaterialPass } from "./model";
import { isOrthographic, parseParticle, parseParticleInstance, particleFov, readParticleSystem } from "./particles";
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
  it("档 1 共 12 项，外加 renderer sprite；每项都有列，档 1 都有执行函数，sprite 由绘制负责", () => {
    expect(PARTICLE_MODULES.map((def) => `${def.category}:${def.name}`)).toEqual([
      "emitter:sphererandom",
      "initializer:lifetimerandom",
      "initializer:sizerandom",
      "initializer:colorrandom",
      "initializer:velocityrandom",
      "initializer:rotationrandom",
      "initializer:angularvelocityrandom",
      "operator:movement",
      "operator:angularmovement",
      "operator:alphafade",
      "operator:oscillateposition",
      "operator:oscillatealpha",
      "renderer:sprite",
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
    });
  });
});

describe("解析：档 1 模块的缺省值（rea-p4a.md B）", () => {
  const BLEND = { blendinstart: 0, blendinend: 0, blendoutstart: 1, blendoutend: 1 };
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
  ];

  it.each(ortho)("正交：%s %s", (category, name, expected) => {
    expect(defaults(category, name, true)).toEqual(expected);
  });

  it("透视那一套只在 distancemax、sizerandom、velocityrandom、oscillateposition.scalemax 上不同", () => {
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
      };
      expect(changed, name).toEqual(differs[name] ?? []);
    }
    expect(defaults("emitter", "sphererandom", false).distancemax).toBe(1);
    expect(defaults("initializer", "sizerandom", false)).toMatchObject({ min: 0.001, max: 1 });
    expect(defaults("initializer", "velocityrandom", false)).toMatchObject({ min: [-1, -1, -1], max: [1, 1, 1] });
    expect(defaults("operator", "oscillateposition", false).scalemax).toBe(0.5);
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

  it("colorn 直接用；color（0–255）÷255 转成 colorn；控制点按下标", () => {
    expect(parseParticleInstance({ colorn: "1.00000 0.50000 0.00000" }).colorn).toEqual([1, 0.5, 0]);
    expect(parseParticleInstance({ color: "255 0 51" }).colorn).toEqual([1, 0, 0.2]);
    const instance = parseParticleInstance({ controlpoint1: "10 20 0", controlpointangle3: "0 0 1" });
    expect(instance.controlpoints[1]).toEqual([10, 20, 0]);
    expect(instance.controlpointAngles[3]).toEqual([0, 0, 1]);
    expect(instance.controlpoints[0]).toBeNull();
  });
});

describe("能力表：粒子", () => {
  it("粒子对象报 particle:pending，不再报 object:particle", () => {
    const keys = new Set<string>();
    checkObjectFeatures({ id: 1, particle: "particles/p.json", origin: "1 2 3", visible: true }, keys);
    expect([...keys]).toEqual(["particle:pending"]);
  });

  it("粒子对象带 effects 报 particle:effects；空数组不报", () => {
    const keys = new Set<string>();
    checkObjectFeatures({ id: 1, particle: "p.json", effects: [] }, keys);
    expect([...keys]).toEqual(["particle:pending"]);
    checkObjectFeatures({ id: 1, particle: "p.json", effects: [{ file: "effects/tint/effect.json" }] }, keys);
    expect([...keys].sort()).toEqual(["particle:effects", "particle:pending"]);
  });

  it("粒子对象的 instanceoverride 照对象规则报，其它对象键不额外报", () => {
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
        instanceoverride: { id: 12 },
      },
      keys,
    );
    expect([...keys].sort()).toEqual(["object:instanceoverride", "particle:pending"]);
  });

  it("表外模块：particle:<类别>:<名字>", () => {
    expect(
      particleKeys({
        emitter: [{ name: "boxrandom" }],
        initializer: [{ name: "alpharandom" }],
        operator: [{ name: "turbulence" }],
        renderer: [{ name: "spritetrail" }],
      }),
    ).toEqual([
      "particle:emitter:boxrandom",
      "particle:initializer:alpharandom",
      "particle:operator:turbulence",
      "particle:renderer:spritetrail",
    ]);
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

  it("表内模块的未知字段：particle:<类别>:<名字>:<字段>（含 audioprocessing*、不带 blend 的模块写 blend）", () => {
    expect(
      particleKeys(
        withModule("emitter", { name: "sphererandom", audioprocessingmode: 3, audioprocessingbounds: "0 1" }),
      ),
    ).toEqual([
      "particle:emitter:sphererandom:audioprocessingbounds",
      "particle:emitter:sphererandom:audioprocessingmode",
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

  it("本节不支持的取值：controlpoint、delay、duration 非 0，emitter flags 带 bit1 / bit2，movement flags 非 0", () => {
    const emitter = (fields: JsonObject) => particleKeys(withModule("emitter", { name: "sphererandom", ...fields }));
    expect(emitter({ controlpoint: 0, delay: 0, duration: 0, flags: 0 })).toEqual([]);
    expect(emitter({ controlpoint: 1 })).toEqual(["particle:emitter:sphererandom:controlpoint"]);
    expect(emitter({ delay: 0.5 })).toEqual(["particle:emitter:sphererandom:delay"]);
    expect(emitter({ duration: 2 })).toEqual(["particle:emitter:sphererandom:duration"]);
    expect(emitter({ flags: 1 })).toEqual([]);
    expect(emitter({ flags: 2 })).toEqual(["particle:emitter:sphererandom:flags"]);
    expect(emitter({ flags: 8 })).toEqual(["particle:emitter:sphererandom:flags"]);
    expect(particleKeys(withModule("operator", { name: "movement", flags: 1 }))).toEqual([
      "particle:operator:movement:flags",
    ]);
  });

  it("周期发射的字段：没有 bit2 时中性，有 bit2 时连同 flags 一起报", () => {
    const periodic = { minperiodicdelay: 0.5, maxperiodicdelay: 1, maxtoemitperperiod: 3 };
    expect(particleKeys(withModule("emitter", { name: "sphererandom", ...periodic }))).toEqual([]);
    expect(particleKeys(withModule("emitter", { name: "sphererandom", flags: 4, ...periodic }))).toEqual([
      "particle:emitter:sphererandom:flags",
      "particle:emitter:sphererandom:maxperiodicdelay",
      "particle:emitter:sphererandom:maxtoemitperperiod",
      "particle:emitter:sphererandom:minperiodicdelay",
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

  it("系统 flags：bit2–7 支持；bit0 报 world，bit1 报 2，更高位逐位报十进制位值", () => {
    for (const flags of [0, 4, 8, 16, 32, 64, 128, 252]) expect(particleKeys({ flags }), String(flags)).toEqual([]);
    expect(particleKeys({ flags: 1 })).toEqual(["particle:flags:world"]);
    expect(particleKeys({ flags: 2 })).toEqual(["particle:flags:2"]);
    expect(particleKeys({ flags: 7 })).toEqual(["particle:flags:2", "particle:flags:world"]);
    expect(particleKeys({ flags: 256 + 1024 + 4 })).toEqual(["particle:flags:1024", "particle:flags:256"]);
  });

  it("children 非空报 particle:children；null、[] 不报", () => {
    expect(particleKeys({ children: null })).toEqual([]);
    expect(particleKeys({ children: [] })).toEqual([]);
    expect(particleKeys({ children: [{ name: "particles/c.json", type: "eventfollow" }] })).toEqual([
      "particle:children",
    ]);
  });

  it("controlpoint 有实际内容才报：offset / angles 非零、flags / parentcontrolpoint 非 0、locktopointer、其它键", () => {
    const defaultsOnly = [
      { id: 0 },
      { id: 1, flags: 0, offset: "0 0 0" },
      { id: 2, offset: "0.00000 0.00000 0.00000", angles: "0 0 0", parentcontrolpoint: 0, locktopointer: false },
      { id: 3, offset: null },
    ];
    expect(particleKeys({ controlpoint: defaultsOnly })).toEqual([]);
    for (const extra of [
      { offset: "0 -9999 0" },
      { angles: "0 0 1" },
      { flags: 1 },
      { parentcontrolpoint: 1 },
      { locktopointer: true },
      { worldspace: true },
    ])
      expect(particleKeys({ controlpoint: [...defaultsOnly, { id: 4, ...extra }] }), JSON.stringify(extra)).toEqual([
        "particle:controlpoint",
      ]);
    // 只按数组下标读前 8 项
    const late = [...Array.from({ length: 8 }, (_, id) => ({ id })), { id: 8, offset: "1 0 0" }];
    expect(particleKeys({ controlpoint: late })).toEqual([]);
  });

  it("animationmode 为 randomframe、sequencemultiplier 不为 1 时报", () => {
    expect(particleKeys({ animationmode: "sequence", sequencemultiplier: 1 })).toEqual([]);
    expect(particleKeys({ animationmode: null, sequencemultiplier: null })).toEqual([]);
    expect(particleKeys({ animationmode: "randomframe" })).toEqual(["particle:animationmode"]);
    expect(particleKeys({ sequencemultiplier: 3 })).toEqual(["particle:sequencemultiplier"]);
  });

  it("其它顶层键报 particle:system:<键>；顶层键绑定报 particle:binding:system:<键>；模块数组不是数组也报", () => {
    expect(particleKeys({ foo: 1, bar: null })).toEqual(["particle:system:foo"]);
    expect(particleKeys({ maxcount: { user: "n", value: 10 } })).toEqual(["particle:binding:system:maxcount"]);
    expect(particleKeys({ operator: { name: "movement" } })).toEqual(["particle:system:operator"]);
  });

  it("sprite：orientation 不是 screen、axis 非零、flags 非 0 报；多个 renderer 报", () => {
    const sprite = (fields: JsonObject) => particleKeys({ renderer: [{ name: "sprite", ...fields }] });
    expect(sprite({ orientation: "screen", axis: "0 0 0", flags: 0 })).toEqual([]);
    expect(sprite({ orientation: "upright" })).toEqual(["particle:renderer:sprite:orientation"]);
    expect(sprite({ orientation: "fixed" })).toEqual(["particle:renderer:sprite:orientation"]);
    expect(sprite({ axis: "0 1 0" })).toEqual(["particle:renderer:sprite:axis"]);
    expect(sprite({ flags: 1 })).toEqual(["particle:renderer:sprite:flags"]);
    expect(particleKeys({ renderer: [{ name: "sprite" }, { name: "sprite" }] })).toEqual(["particle:renderers"]);
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

  it("非 0 的 COMBO 只允许 WORLDBLUR、USERCOLORBLEND", () => {
    expect(check({ combos: { USERCOLORBLEND: 1, WORLDBLUR: 1, REFRACT: 0, CUTOUT: 0 } })).toEqual([]);
    expect(check({ combos: { REFRACT: 1 } })).toEqual(["particle:combo:REFRACT"]);
    expect(check({ combos: { cutout: true } })).toEqual(["particle:combo:CUTOUT"]);
  });

  it("LIGHTING 非 0 报 particle:lighting（材质写的或着色器缺省值）", () => {
    expect(check({ combos: { LIGHTING: 1 } })).toEqual(["particle:lighting"]);
    expect(check({}, result([{ name: "LIGHTING", value: 1, source: "default" }]))).toEqual(["particle:lighting"]);
  });

  it("着色器注解缺省值不算（genericparticle 的 FOG 缺省为 1）；纹理槽带出的算", () => {
    expect(check({}, result([{ name: "FOG", value: 1, source: "default" }]))).toEqual([]);
    expect(check({}, result([{ name: "NORMALMAP", value: 1, source: "texture" }]))).toEqual([
      "particle:combo:NORMALMAP",
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
      return new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value));
    },
    async readRange(path, start, end) {
      return (await reader.readWhole(path)).slice(start, end);
    },
  };
  return reader;
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
    const textures: ShaderTextureSlot[] = [{ slot: 0, format: 4 }];
    await compiler.compile("genericparticle", {}, textures, null, undefined, { TEX0FORMAT: "0" });
    await compiler.compile("genericparticle", {}, textures, null, undefined, { TEX0FORMAT: "4" });
    await compiler.compile("genericparticle", {}, textures, null, undefined, { TEX0FORMAT: "4" });
    expect(requests.map((request) => request.defines)).toEqual([
      { HDR: "1", TEX0FORMAT: "0" },
      { HDR: "1", TEX0FORMAT: "4" },
    ]);
    // 不带宏（图层材质）是另一条
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
    expect(shaderCacheKey("genericimage2", combos, textures, scope, { TEX0FORMAT: "0" })).not.toBe(legacy);
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
    // 粒子 pass 无条件写 TEX0FORMAT（槽 0 是 `_rt_FullFrameBuffer`，格式 0）；图层材质不写
    expect(requests.map((request) => request.defines?.TEX0FORMAT)).toEqual(["0", undefined]);
    // object:instanceoverride 仍由对象规则报（步骤 5 去掉）；g_OrientationUp 只在图层材质里报
    expect(bundle.unsupported).toEqual(["object:instanceoverride", "particle:pending", "uniform:g_OrientationUp"]);
    // instanceoverride 的绑定不读用户属性、不登记（步骤 5）
    expect(bundle.bindings).toEqual([]);
    expect(bundle.general.perspectiveOverrideFov).toBeCloseTo((95 * Math.PI) / 180, 12);
  });

  it("槽 0 没按名字写时取着色器注解的 default 定 TEX0FORMAT", async () => {
    const { translator, requests } = fakeTranslator(() => ({
      ok: true,
      textures: [
        {
          slot: 0,
          name: "g_Texture0",
          kind: "2d",
          binding: 1,
          samplerBinding: 2,
          meta: { default: "_rt_FullFrameBuffer" },
        },
      ],
    }));
    const bundle = await compile(
      memoryReader(
        files({
          "P:/p/scene.json": scene([{ id: 1, particle: "particles/p.json" }]),
          "P:/p/materials/pm.json": { passes: [{ shader: "genericparticle" }] },
        }),
      ),
      translator,
    );
    // 先不带宏读注解，再带宏正式翻译
    expect(requests.map((request) => request.defines?.TEX0FORMAT)).toEqual([undefined, "0"]);
    expect(bundle.layers[0].particle!.passes[0].runtime).toEqual({ 0: "_rt_FullFrameBuffer" });
  });

  it("读不到粒子 JSON 报 particle:missing:<路径>；不是 JSON 报 particle:parse:<路径>", async () => {
    const missing = await compile(
      memoryReader(files({ "P:/p/scene.json": scene([{ id: 1, particle: "particles/none.json" }]) })),
    );
    expect(missing.unsupported).toEqual(["particle:missing:particles/none.json", "particle:pending"]);
    expect(missing.layers[0].particle).toBeNull();
    const broken = await compile(
      memoryReader(
        files({ "P:/p/scene.json": scene([{ id: 1, particle: "particles/p.json" }]), "P:/p/particles/p.json": "{" }),
      ),
    );
    expect(broken.unsupported).toEqual(["particle:parse:particles/p.json", "particle:pending"]);
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
  it("粒子层都有 particle、pass 编译成功；粒子相关的不支持项只剩 particle:pending 与 object:instanceoverride", async () => {
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
    expect(bundle.unsupported).toEqual(["object:instanceoverride", "particle:pending"]);
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
    // 两种材质 COMBO 不同，各是一个程序；TEX0FORMAT 走了缓存键，不会和图层材质混用
    expect(new Set(particles.map((layer) => layer.particle!.passes[0].program)).size).toBe(2);
  }, 60000);
});
