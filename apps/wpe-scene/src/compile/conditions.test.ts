/**
 * P7d 步骤 3：effect 的 `conditions`、实例顶层 `combos`、`functions`、fbo `clear` 的分量数。
 * 规则来自 rea-p7d-fluid 第 1–3 节（`FUN_1401e63b0`、`FUN_1401e7170`）与 p7-REPORT「流体 effect 的条件」的实测。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { compileScene, type SceneBundle, type SceneEffectStep, type SceneLayer } from "./bundle";
import { conditionsHold, removedFbos } from "./conditions";
import { checkEffectFeatures } from "./features";
import type { SceneReader } from "./fs";
import type { EffectJson, JsonObject, SceneEffectInstance } from "./model";
import { planLayer, type DrawStep } from "../render/graph";
import { Wpesl2wgsl, type UniformLayout } from "../wpesl2wgsl";

vi.mock("../fileUrl", () => ({ fileToUrl: (path: string) => path }));

describe("conditionsHold：照 FUN_1401e63b0", () => {
  it("conditions 不是数组 → 恒真（对象、数字、字符串都不当单元素数组）", () => {
    for (const conditions of [undefined, null, { LIGHTING: 1 }, 5, "LIGHTING", true])
      expect(conditionsHold(conditions, {}), JSON.stringify(conditions)).toBe(true);
    expect(conditionsHold([{ LIGHTING: 1 }], {})).toBe(false);
    expect(conditionsHold([], {})).toBe(true);
  });
  it("数组元素不是对象就跳过；空对象为真", () => {
    expect(conditionsHold([1, "LIGHTING", null, true, [{ LIGHTING: 1 }]], {})).toBe(true);
    expect(conditionsHold([1, { LIGHTING: 1 }], {})).toBe(false);
    expect(conditionsHold([{}], {})).toBe(true);
  });
  it("右值是数：相等才过；小数截断", () => {
    expect(conditionsHold([{ LIGHTING: 1 }], { LIGHTING: 1 })).toBe(true);
    expect(conditionsHold([{ LIGHTING: 1 }], { LIGHTING: 2 })).toBe(false);
    expect(conditionsHold([{ RENDERING: 3.9 }], { RENDERING: 3 })).toBe(true);
    expect(conditionsHold([{ RENDERING: -1.5 }], { RENDERING: -1 })).toBe(true);
    expect(conditionsHold([{ RENDERING: 3.9 }], { RENDERING: 4 })).toBe(false);
  });
  it("对象内各键、数组之间都是「与」", () => {
    expect(conditionsHold([{ A: 1, B: 2 }], { A: 1, B: 2 })).toBe(true);
    expect(conditionsHold([{ A: 1, B: 2 }], { A: 1, B: 3 })).toBe(false);
    expect(conditionsHold([{ A: 1, B: 2 }], { A: 0, B: 2 })).toBe(false);
    expect(conditionsHold([{ A: 1 }, { B: 2 }], { A: 1, B: 2 })).toBe(true);
    expect(conditionsHold([{ A: 1 }, { B: 2 }], { A: 1 })).toBe(false);
    expect(conditionsHold([{ A: 1 }, { B: 2 }], { B: 2 })).toBe(false);
  });
  it("左值：缺失当 0；小数截断；bool / 字符串 / 对象（绑用户属性）当 0", () => {
    expect(conditionsHold([{ LIGHTING: 0 }], {})).toBe(true);
    expect(conditionsHold([{ LIGHTING: 1 }], { LIGHTING: 1.9 })).toBe(true);
    expect(conditionsHold([{ LIGHTING: -1 }], { LIGHTING: -1.9 })).toBe(true);
    // true 不是 1
    expect(conditionsHold([{ LIGHTING: 1 }], { LIGHTING: true })).toBe(false);
    expect(conditionsHold([{ LIGHTING: 0 }], { LIGHTING: true })).toBe(true);
    expect(conditionsHold([{ LIGHTING: 1 }], { LIGHTING: "1" })).toBe(false);
    expect(conditionsHold([{ LIGHTING: 0 }], { LIGHTING: "1" })).toBe(true);
    expect(conditionsHold([{ LIGHTING: 1 }], { LIGHTING: { user: "light", value: 1 } })).toBe(false);
    expect(conditionsHold([{ LIGHTING: 0 }], { LIGHTING: { user: "light", value: 1 } })).toBe(true);
    expect(conditionsHold([{ LIGHTING: 0 }], { LIGHTING: null })).toBe(true);
  });
  it("左值：combos 本身不是对象时全当 0；不读原型上的名字", () => {
    for (const combos of [undefined, null, [1], "LIGHTING", 1]) {
      expect(conditionsHold([{ LIGHTING: 0 }], combos), JSON.stringify(combos)).toBe(true);
      expect(conditionsHold([{ LIGHTING: 1 }], combos), JSON.stringify(combos)).toBe(false);
    }
    expect(conditionsHold([{ constructor: 0, toString: 0 }], {})).toBe(true);
  });
  it("名字区分大小写", () => {
    expect(conditionsHold([{ LIGHTING: 1 }], { lighting: 1 })).toBe(false);
    expect(conditionsHold([{ lighting: 1 }], { lighting: 1 })).toBe(true);
  });
  it("右值是 {value, op}：ge / gt / le / lt", () => {
    const hold = (op: string, value: number, combo: number) =>
      conditionsHold([{ POINTEMITTER: { op, value } }], { POINTEMITTER: combo });
    expect([hold("ge", 2, 1), hold("ge", 2, 2), hold("ge", 2, 3)]).toEqual([false, true, true]);
    expect([hold("gt", 2, 1), hold("gt", 2, 2), hold("gt", 2, 3)]).toEqual([false, false, true]);
    expect([hold("le", 2, 1), hold("le", 2, 2), hold("le", 2, 3)]).toEqual([true, true, false]);
    expect([hold("lt", 2, 1), hold("lt", 2, 2), hold("lt", 2, 3)]).toEqual([true, false, false]);
    // value 截断
    expect(hold("ge", 1.9, 1)).toBe(true);
    // 缺 combos 当 0
    expect(conditionsHold([{ POINTEMITTER: { op: "ge", value: 1 } }], {})).toBe(false);
    expect(conditionsHold([{ POINTEMITTER: { op: "le", value: 0 } }], {})).toBe(true);
  });
  it("右值是 {value, op}：认不出的 op 一律按相等；value 不是数当 0", () => {
    const hold = (right: JsonObject, combo: number) => conditionsHold([{ X: right }], { X: combo });
    for (const op of ["eq", "ne", "GE", "Gt", "g", "gee", 1, null, undefined]) {
      expect(hold({ op, value: 2 }, 2), String(op)).toBe(true);
      expect(hold({ op, value: 2 }, 3), String(op)).toBe(false);
    }
    expect(hold({ value: 2 }, 2)).toBe(true);
    expect(hold({ op: "ge", value: "5" }, 0)).toBe(true);
    expect(hold({ op: "ge", value: true }, 0)).toBe(true);
    expect(hold({ op: "gt", value: "5" }, 0)).toBe(false);
    expect(hold({ op: "ge" }, 0)).toBe(true);
    expect(hold({}, 0)).toBe(true);
    expect(hold({}, 1)).toBe(false);
  });
  it("右值是别的类型（字符串、bool、null、数组）：这个键不参与，同一对象里别的键照常", () => {
    for (const right of ["1", true, false, null, [1]])
      expect(conditionsHold([{ X: right }], { X: 7 }), JSON.stringify(right)).toBe(true);
    expect(conditionsHold([{ X: "1", Y: 1 }], { Y: 0 })).toBe(false);
    expect(conditionsHold([{ X: "1", Y: 1 }], { Y: 1 })).toBe(true);
  });
  it("removedFbos：只算被条件去掉、且没有同名留下的", () => {
    const effect: EffectJson = {
      fbos: [
        { name: "a" },
        { name: "b", conditions: [{ L: 1 }] },
        { name: "c", conditions: [{ L: 1 }] },
        { name: "c" },
        { conditions: [{ L: 1 }] },
      ],
    };
    const holds = (conditions: unknown) => conditionsHold(conditions, {});
    expect([...removedFbos(effect, holds)]).toEqual(["b"]);
    expect([...removedFbos(effect, (conditions) => conditionsHold(conditions, { L: 1 }))]).toEqual([]);
  });
});

/** 流体 effect 的结构（照 WPE 自带 `effects/fluidsimulation`，只留和条件有关的部分）。 */
const FLUID_LIKE: EffectJson = {
  passes: [
    { material: "m/a.json", target: "_rt_A", bind: [{ name: "_rt_V1", index: 0 }] },
    {
      material: "m/n.json",
      target: "_rt_N",
      bind: [{ name: "_rt_D", index: 0 }],
      conditions: [{ LIGHTING: 1 }],
    },
    {
      material: "m/c.json",
      bind: [
        { name: "_rt_D", index: 0 },
        { name: "previous", index: 1 },
        { name: "_rt_N", index: 2, conditions: [{ LIGHTING: 1 }] },
        { name: "_rt_V1", index: 4, conditions: [{ RENDERING: 3 }] },
      ],
    },
    { command: "swap", source: "_rt_V1", target: "_rt_A" },
  ],
  fbos: [
    { name: "_rt_V1", format: "rg1616f", clear: "0 0 0 0" },
    { name: "_rt_A", format: "r16f" },
    { name: "_rt_D", scale: 2, format: "rgba_backbuffer", clear: "0 0 0 0" },
    { name: "_rt_N", scale: 2, format: "rgba8888", conditions: [{ LIGHTING: 1 }] },
  ],
  functions: {
    clearVelocity: { action: "clear", fbos: ["_rt_V1"] },
    clearDye: { action: "clear", fbos: ["_rt_D"] },
  },
};

describe("checkEffectFeatures：conditions / combos / functions / bind", () => {
  const keys = (instance: SceneEffectInstance, effect: EffectJson) => {
    const set = new Set<string>();
    checkEffectFeatures(instance, effect, "x", set);
    return [...set].sort();
  };
  it("functions、conditions、实例顶层 combos 都不报（含绑用户属性的 combos）", () => {
    expect(keys({ file: "effects/x/effect.json" }, FLUID_LIKE)).toEqual([]);
    expect(keys({ file: "effects/x/effect.json", combos: { LIGHTING: 1, RENDERING: 3 } }, FLUID_LIKE)).toEqual([]);
    expect(
      keys({ file: "effects/x/effect.json", combos: { LIGHTING: { user: "l", value: 1 } } as never }, FLUID_LIKE),
    ).toEqual([]);
  });
  it("bind 逐项查键：name / index / conditions 之外的报；被条件去掉的 bind 不查", () => {
    const effect = (bind: JsonObject[]): EffectJson => ({ passes: [{ material: "m.json", bind: bind as never }] });
    expect(keys({}, effect([{ name: "previous", index: 0, conditions: [{ X: 0 }] }]))).toEqual([]);
    expect(keys({}, effect([{ name: "previous", index: 0, filter: "linear", mip: 0 }]))).toEqual([
      "effect:x:bind:filter",
    ]);
    expect(keys({}, effect([{ name: "previous", index: 0, filter: "linear", conditions: [{ X: 1 }] }]))).toEqual([]);
    expect(
      keys({ combos: { X: 1 } }, effect([{ name: "previous", index: 0, filter: "linear", conditions: [{ X: 1 }] }])),
    ).toEqual(["effect:x:bind:filter"]);
    // 不是对象的项不查
    expect(keys({}, effect([null as never, "a" as never]))).toEqual([]);
  });
  it("被条件去掉的 fbo、pass 不查；target 指向被去掉的 fbo 不报，指向没有的照报", () => {
    const effect: EffectJson = {
      passes: [
        { material: "m.json", target: "_rt_N" },
        { material: "m.json", target: "_rt_Missing", blend: "x", conditions: [{ L: 1 }] },
        { material: "m.json", target: "_rt_Missing" },
      ],
      fbos: [{ name: "_rt_N", fancy: true, conditions: [{ L: 1 }] }],
    };
    expect(keys({}, effect)).toEqual(["effect:x:target:_rt_Missing"]);
    expect(keys({ combos: { L: 1 } }, effect)).toEqual([
      "effect:x:fbo:fancy",
      "effect:x:pass:blend",
      "effect:x:target:_rt_Missing",
    ]);
  });
  it("swap 的一端被去掉不报；copy 的一端被去掉报 command-operands；命令 pass 也先过条件", () => {
    const effect = (passes: JsonObject[]): EffectJson => ({
      passes: passes as never,
      fbos: [{ name: "_rt_A" }, { name: "_rt_N", conditions: [{ L: 1 }] }],
    });
    expect(keys({}, effect([{ command: "swap", source: "_rt_A", target: "_rt_N" }]))).toEqual([]);
    expect(keys({}, effect([{ command: "swap", source: "_rt_N", target: "_rt_A" }]))).toEqual([]);
    // 没定义的名字照旧报
    expect(keys({}, effect([{ command: "swap", source: "_rt_A", target: "_rt_B" }]))).toEqual([
      "effect:x:swap-operands",
    ]);
    expect(keys({}, effect([{ command: "copy", source: "_rt_N", target: "_rt_A" }]))).toEqual([
      "effect:x:command-operands",
    ]);
    expect(keys({}, effect([{ command: "copy", source: "_rt_A", target: "_rt_N" }]))).toEqual([
      "effect:x:command-operands",
    ]);
    expect(keys({ combos: { L: 1 } }, effect([{ command: "copy", source: "_rt_A", target: "_rt_N" }]))).toEqual([]);
    expect(keys({}, effect([{ command: "copy", source: "_rt_A", target: "previous" }]))).toEqual([]);
    expect(keys({}, effect([{ command: "blit", source: "_rt_A", target: "_rt_A", conditions: [{ L: 1 }] }]))).toEqual(
      [],
    );
    expect(keys({}, effect([{ command: "blit", source: "_rt_A", target: "_rt_A" }]))).toEqual([
      "effect:x:command:blit",
    ]);
  });
  it("缺省按实例顶层 combos 求值；调用方给的求值函数优先", () => {
    const effect: EffectJson = { passes: [{ material: "m.json", odd: 1, conditions: [{ L: 1 }] }] };
    const set = new Set<string>();
    checkEffectFeatures({ combos: { L: 1 } }, effect, "x", set, () => false);
    expect([...set]).toEqual([]);
    checkEffectFeatures({}, effect, "x", set, () => true);
    expect([...set]).toEqual(["effect:x:pass:odd"]);
  });
});

function memoryReader(
  files: Record<string, Uint8Array | string>,
  fallback?: (path: string) => Uint8Array,
): SceneReader {
  const bytes = (raw: string) => {
    const path = raw.replace(/\\/g, "/");
    const value = files[path];
    if (value !== undefined) return typeof value === "string" ? new TextEncoder().encode(value) : value;
    if (fallback && !path.startsWith("P:/")) return fallback(path);
    throw new TypeError("Failed to fetch");
  };
  return {
    async readWhole(path) {
      return bytes(path);
    },
    async readRange(path, start, end) {
      const all = bytes(path);
      if (start >= all.length) throw new TypeError("Failed to fetch");
      return all.slice(start, end);
    },
  };
}

const drawSteps = (layer: SceneLayer, effect = 0) =>
  layer.effects[effect].steps.filter(
    (step): step is Extract<SceneEffectStep, { kind: "draw" }> => step.kind === "draw",
  );

describe("compileScene：effect 的条件（内存数据，照流体的结构）", () => {
  /** 记下每个着色器收到的 COMBO（着色器源码第一行是名字）；每个着色器给一个材质常量 `feather` → `u_Feather`。 */
  async function compileFluidLike(instance: JsonObject, effect: EffectJson = FLUID_LIKE) {
    const calls: { shader: string; combos: Record<string, unknown> }[] = [];
    const translator = {
      async translate(input: { fragment: string; combos: Record<string, unknown> }) {
        calls.push({ shader: input.fragment.split("\n")[0], combos: input.combos });
        const feather: UniformLayout = {
          name: "u_Feather",
          type: "f32",
          declared: "float",
          offset: 0,
          size: 4,
          meta: { material: "feather", default: 1 },
        };
        return { ok: true, uniforms: [feather], textures: [], combos: [] };
      },
    } as unknown as Wpesl2wgsl;
    const shader = (name: string) => ({
      [`P:/p/shaders/${name}.vert`]: `// ${name}`,
      [`P:/p/shaders/${name}.frag`]: `// ${name}`,
    });
    const bundle = await compileScene({
      projectDir: "P:/p",
      sceneAssets: ["A:/assets"],
      reader: memoryReader({
        "P:/p/project.json": JSON.stringify({ file: "scene.json" }),
        "P:/p/scene.json": JSON.stringify({
          general: { orthogonalprojection: { width: 256, height: 256 } },
          objects: [
            {
              id: 1,
              image: "models/a.json",
              origin: "128 128 0",
              size: "256 256",
              effects: [{ file: "effects/x/effect.json", ...instance }],
            },
          ],
        }),
        "P:/p/models/a.json": JSON.stringify({ material: "materials/a.json" }),
        "P:/p/materials/a.json": JSON.stringify({ passes: [{ shader: "base" }] }),
        "P:/p/effects/x/effect.json": JSON.stringify(effect),
        "P:/p/m/a.json": JSON.stringify({ passes: [{ shader: "fa" }] }),
        "P:/p/m/n.json": JSON.stringify({ passes: [{ shader: "fn" }] }),
        "P:/p/m/c.json": JSON.stringify({ passes: [{ shader: "fc" }] }),
        ...shader("base"),
        ...shader("fa"),
        ...shader("fn"),
        ...shader("fc"),
      }),
      translator,
      postprocess: "disabled",
      exhaustive: true,
    });
    const combosOf = (name: string) => calls.filter((call) => call.shader === `// ${name}`).map((call) => call.combos);
    return { bundle, combosOf };
  }
  const overrides = [
    { constantshadervalues: { feather: 0.1 } },
    { combos: { NORMAL_ONLY: 1 }, constantshadervalues: { feather: 0.2 } },
    { combos: { BLENDMODE: 0 }, constantshadervalues: { feather: 0.68 } },
  ];

  it("没有顶层 combos：去掉 normal pass 与 _rt_N；combine 拿第 3 项覆盖；bind 条件不满足的不绑", async () => {
    const { bundle, combosOf } = await compileFluidLike({ passes: overrides });
    expect(bundle.unsupported).toEqual([]);
    const effect = bundle.layers[0].effects[0];
    expect(effect.fbos.map((fbo) => fbo.name)).toEqual(["_rt_V1", "_rt_A", "_rt_D"]);
    const draws = drawSteps(bundle.layers[0]);
    expect(draws.map((step) => step.target)).toEqual(["_rt_A", null]);
    // 被去掉的 normal 仍占覆盖的第 2 项：combine 拿到第 3 项（feather 0.68、BLENDMODE 0）
    expect(draws.map((step) => step.pass.uniforms.u_Feather)).toEqual([[0.1], [0.68]]);
    expect(combosOf("fc")).toEqual([{ BLENDMODE: 0 }]);
    expect(combosOf("fn")).toEqual([]);
    expect(draws[1].binds).toEqual([
      { name: "_rt_D", index: 0 },
      { name: "previous", index: 1 },
    ]);
    // 稳定键是 scene.json 坐标：被去掉的 normal 也留出序号，combine 仍是实例的 passes/2
    expect(draws.map((step) => step.pass.key)).toEqual([
      "objects/0/effects/0/passes/0",
      "objects/0/effects/0/passes/2",
    ]);
    expect(effect.steps.filter((step) => step.kind === "swap")).toEqual([
      { kind: "swap", source: "_rt_V1", target: "_rt_A" },
    ]);
  });

  it("顶层 LIGHTING 1：normal pass、_rt_N、槽 2 的 bind 都在；顶层 combos 不并进任何 pass 的 COMBO", async () => {
    const { bundle, combosOf } = await compileFluidLike({ combos: { LIGHTING: 1 }, passes: overrides });
    expect(bundle.unsupported).toEqual([]);
    const effect = bundle.layers[0].effects[0];
    expect(effect.fbos.map((fbo) => fbo.name)).toEqual(["_rt_V1", "_rt_A", "_rt_D", "_rt_N"]);
    const draws = drawSteps(bundle.layers[0]);
    expect(draws.map((step) => step.target)).toEqual(["_rt_A", "_rt_N", null]);
    expect(draws.map((step) => step.pass.uniforms.u_Feather)).toEqual([[0.1], [0.2], [0.68]]);
    expect(combosOf("fc")).toEqual([{ BLENDMODE: 0 }]);
    expect(combosOf("fn")).toEqual([{ NORMAL_ONLY: 1 }]);
    expect(combosOf("fa")).toEqual([{}]);
    expect(draws[2].binds).toEqual([
      { name: "_rt_D", index: 0 },
      { name: "previous", index: 1 },
      { name: "_rt_N", index: 2 },
    ]);
  });

  it("被去掉的 pass 之后，挂在实例覆盖上的脚本仍找到自己的 pass（稳定键是 scene.json 坐标）", async () => {
    const script = (value: number) => ({ script: "export function update(value) { return value; }", value });
    const { bundle } = await compileFluidLike({
      passes: [
        {},
        { constantshadervalues: { feather: script(0.2) } },
        { constantshadervalues: { feather: script(0.68) } },
      ],
    });
    const targets = bundle.scripts.list.map((item) => item.target);
    expect(targets.map((target) => (target.kind === "constant" ? [target.pass, target.uniforms] : target))).toEqual([
      // normal 被去掉：它覆盖上的脚本没有 pass 可写
      ["objects/0/effects/0/passes/1", []],
      ["objects/0/effects/0/passes/2", ["u_Feather"]],
    ]);
    expect(drawSteps(bundle.layers[0]).at(-1)!.pass.key).toBe("objects/0/effects/0/passes/2");
  });

  it("RENDERING 1 / 3 只看顶层：pass 覆盖里的 RENDERING 改着色器、不改条件", async () => {
    const binds = async (instance: JsonObject) =>
      drawSteps((await compileFluidLike(instance)).bundle.layers[0])
        .at(-1)!
        .binds!.map((bind) => bind.index);
    expect(await binds({ combos: { RENDERING: 1 } })).toEqual([0, 1]);
    expect(await binds({ combos: { RENDERING: 3 } })).toEqual([0, 1, 4]);
    expect(await binds({ passes: [{}, {}, { combos: { RENDERING: 3 } }] })).toEqual([0, 1]);
    const both = await compileFluidLike({ combos: { RENDERING: 3 }, passes: [{}, {}, { combos: { RENDERING: 3 } }] });
    expect(
      drawSteps(both.bundle.layers[0])
        .at(-1)!
        .binds!.map((bind) => bind.index),
    ).toEqual([0, 1, 4]);
    expect(both.combosOf("fc")).toEqual([{ RENDERING: 3 }]);
    // 顶层写成绑用户属性的对象：条件里当 0，不报
    const bound = await compileFluidLike({ combos: { LIGHTING: { user: "l", value: 1 } } });
    expect(bound.bundle.unsupported).toEqual([]);
    expect(drawSteps(bound.bundle.layers[0]).map((step) => step.target)).toEqual(["_rt_A", null]);
  });

  it("target / bind 指向被去掉的 fbo：target 画回合成链，bind 保留名字、渲染图解析成当前合成 RT", async () => {
    const effect: EffectJson = {
      passes: [
        { material: "m/a.json", target: "_rt_N" },
        {
          material: "m/c.json",
          bind: [
            { name: "_rt_N", index: 0 },
            { name: "_rt_D", index: 1 },
          ],
        },
      ],
      fbos: [{ name: "_rt_D" }, { name: "_rt_N", conditions: [{ LIGHTING: 1 }] }],
    };
    const { bundle } = await compileFluidLike({}, effect);
    expect(bundle.unsupported).toEqual([]);
    const layer = bundle.layers[0];
    const draws = drawSteps(layer);
    expect(draws.map((step) => step.target)).toEqual([null, null]);
    expect(draws[1].binds).toEqual([
      { name: "_rt_N", index: 0 },
      { name: "_rt_D", index: 1 },
    ]);
    const plan = planLayer(layer, bundle.textures);
    const effectDraws = plan.steps.filter((step): step is DrawStep => step.kind === "draw" && step.effect === 0);
    // 第一个 effect pass 写合成链（基础 pass 写 0，它写 1）；上屏 pass 的槽 0 读它，槽 1 是本 effect 的 fbo
    expect(effectDraws[0].target).toEqual({ kind: "composite", index: 1 });
    expect(effectDraws[1].inputs[0]).toEqual({ kind: "composite", index: 1 });
    expect(effectDraws[1].inputs[1]).toEqual({ kind: "fbo", effect: 0, name: "_rt_D" });
    // 打开条件后 _rt_N 是 fbo
    const lit = (await compileFluidLike({ combos: { LIGHTING: 1 } }, effect)).bundle;
    const litDraws = planLayer(lit.layers[0], lit.textures).steps.filter(
      (step): step is DrawStep => step.kind === "draw" && step.effect === 0,
    );
    expect(litDraws[0].target).toEqual({ kind: "fbo", effect: 0, name: "_rt_N" });
    expect(litDraws[1].inputs[0]).toEqual({ kind: "fbo", effect: 0, name: "_rt_N" });
  });

  it("swap 的一端被去掉：不收这条命令；命令 pass 也先过条件；copy 的一端被去掉报 command-operands", async () => {
    const base = (passes: JsonObject[]): EffectJson => ({
      passes: [{ material: "m/a.json" }, ...(passes as never[])],
      fbos: [{ name: "_rt_A" }, { name: "_rt_B" }, { name: "_rt_N", conditions: [{ LIGHTING: 1 }] }],
    });
    const commands = async (passes: JsonObject[], instance: JsonObject = {}) => {
      const { bundle } = await compileFluidLike(instance, base(passes));
      return {
        unsupported: bundle.unsupported,
        steps: bundle.layers[0].effects[0].steps.filter((step) => step.kind !== "draw"),
      };
    };
    expect(await commands([{ command: "swap", source: "_rt_A", target: "_rt_N" }])).toEqual({
      unsupported: [],
      steps: [],
    });
    expect(
      (await commands([{ command: "swap", source: "_rt_A", target: "_rt_N" }], { combos: { LIGHTING: 1 } })).steps,
    ).toEqual([{ kind: "swap", source: "_rt_A", target: "_rt_N" }]);
    expect(
      (await commands([{ command: "swap", source: "_rt_A", target: "_rt_B", conditions: [{ LIGHTING: 1 }] }])).steps,
    ).toEqual([]);
    expect((await commands([{ command: "copy", source: "_rt_N", target: "_rt_A" }])).unsupported).toEqual([
      "effect:x:command-operands",
    ]);
  });

  it("fbo 的 clear 要解析出 4 个数才生效（只写 3 个不清，不补 alpha）", async () => {
    const effect: EffectJson = {
      passes: [{ material: "m/a.json" }],
      fbos: [
        { name: "_rt_4", clear: "0.1 0.2 0.3 0.4" },
        { name: "_rt_3", clear: "0.1 0.2 0.3" },
        { name: "_rt_5", clear: "0.1 0.2 0.3 0.4 0.5" },
        { name: "_rt_0" },
      ],
    };
    const { bundle } = await compileFluidLike({}, effect);
    expect(bundle.layers[0].effects[0].fbos.map((fbo) => [fbo.name, fbo.clear])).toEqual([
      ["_rt_4", [0.1, 0.2, 0.3, 0.4]],
      ["_rt_3", undefined],
      ["_rt_5", [0.1, 0.2, 0.3, 0.4]],
      ["_rt_0", undefined],
    ]);
  });
});

// 本机 WPE 自带的流体 effect（`assets/effects/fluidsimulation`）：实例取它的预览工程，场景与 p7d 的测试工程相同（256×256）
const root = process.env.KABEGAME_WPE_ROOT;
const wasm = join(__dirname, "..", "wpesl2wgsl", "wpesl2wgsl.wasm");
const fluidDir = root ? join(root, "assets", "effects", "fluidsimulation") : "";

describe.skipIf(!root || !existsSync(wasm) || !existsSync(join(fluidDir, "effect.json")))(
  "本机 WPE 流体 effect 的条件",
  () => {
    // 拷成独立的 Uint8Array：Buffer 的 slice 是视图，`.tex` 解析按 `bytes.buffer` 读会错位
    const preview = (path: string) => new Uint8Array(readFileSync(join(fluidDir, "preview", path)));
    const disk = (path: string) => {
      try {
        return new Uint8Array(readFileSync(path));
      } catch {
        throw new TypeError("Failed to fetch");
      }
    };
    let translator: Wpesl2wgsl | null = null;
    /** p7d 的测试工程（`ignore/p7d/mk_fluid.py`）：预览工程的实例，`cursorinfluence` 改 0；`top` 是实例顶层 combos，`pass` 并进 combine 的覆盖。 */
    async function compileFluid(top?: JsonObject, pass?: JsonObject): Promise<SceneBundle> {
      translator ??= await Wpesl2wgsl.fromBytes(readFileSync(wasm));
      const scene = JSON.parse(readFileSync(join(fluidDir, "preview", "scene.json"), "utf8"));
      const instance = scene.objects[0].effects[0];
      instance.passes[1].constantshadervalues.cursorinfluence = 0;
      if (top) instance.combos = top;
      if (pass) instance.passes[17].combos = { ...instance.passes[17].combos, ...pass };
      return compileScene({
        projectDir: "P:/p",
        sceneAssets: [join(root!, "assets")],
        reader: memoryReader(
          {
            "P:/p/project.json": JSON.stringify({ file: "scene.json" }),
            "P:/p/scene.json": JSON.stringify({
              general: { ...scene.general, orthogonalprojection: { width: 256, height: 256 } },
              objects: [
                {
                  id: 1,
                  image: "models/effectpreview.json",
                  origin: "128 128 0",
                  size: "256 256",
                  effects: [instance],
                },
              ],
            }),
            "P:/p/models/effectpreview.json": preview("models/effectpreview.json"),
            "P:/p/materials/effectpreview.json": preview("materials/effectpreview.json"),
            "P:/p/materials/effectpreview.tex": preview("materials/effectpreview.tex"),
          },
          disk,
        ),
        translator,
        postprocess: "disabled",
        exhaustive: true,
      });
    }
    const comboOf = (bundle: SceneBundle, step: Extract<SceneEffectStep, { kind: "draw" }>, name: string) =>
      bundle.programs[step.pass.program!].combos?.find((combo) => combo.name === name)?.value;
    const plannedDraws = (bundle: SceneBundle) =>
      planLayer(bundle.layers[0], bundle.textures).steps.filter((step): step is DrawStep => step.kind === "draw");

    it("没有顶层 combos（p7d-fluid）：18 次绘制、没有 normal 与 _rt_SmokeNormal；combine 拿第 18 项覆盖", async () => {
      const bundle = await compileFluid();
      expect(bundle.unsupported).toEqual([]);
      const effect = bundle.layers[0].effects[0];
      expect(effect.fbos.map((fbo) => fbo.name)).toEqual([
        "_rt_SmokeVelocity1",
        "_rt_SmokeVelocity2",
        "_rt_SmokePressure1",
        "_rt_SmokePressure2",
        "_rt_SmokeDivergence",
        "_rt_SmokeCurl",
        "_rt_SmokeDye1",
        "_rt_SmokeDye2",
      ]);
      // 6 张写了 4 个分量的 clear；每帧不清（渲染图里没有清 fbo 的步骤）
      expect(effect.fbos.filter((fbo) => fbo.clear).map((fbo) => fbo.clear)).toEqual(Array(6).fill([0, 0, 0, 0]));
      const draws = drawSteps(bundle.layers[0]);
      expect(draws).toHaveLength(17);
      expect(draws.map((step) => step.target)).toEqual([
        "_rt_SmokeCurl",
        "_rt_SmokeVelocity2",
        "_rt_SmokeDivergence",
        "_rt_SmokePressure2",
        ...Array.from({ length: 9 }, (_, i) => (i % 2 === 0 ? "_rt_SmokePressure1" : "_rt_SmokePressure2")),
        "_rt_SmokeVelocity1",
        "_rt_SmokeVelocity2",
        "_rt_SmokeDye2",
        null,
      ]);
      const combine = draws[16];
      expect(combine.binds).toEqual([
        { name: "_rt_SmokeDye2", index: 0 },
        { name: "previous", index: 1 },
      ]);
      // 被去掉的 normal（第 17 个绘制 pass）仍占覆盖的位置：combine 拿到第 18 项（feather 0.68、BLENDMODE 0）
      expect(combine.pass.uniforms.u_Feather).toEqual([0.68]);
      expect([comboOf(bundle, combine, "BLENDMODE"), comboOf(bundle, combine, "LIGHTING")]).toEqual([0, 0]);
      expect(combine.pass.key).toBe("objects/0/effects/0/passes/17");
      expect(effect.steps.filter((step) => step.kind === "swap")).toHaveLength(2);
      const plan = plannedDraws(bundle);
      expect(plan).toHaveLength(18);
      expect(plan.map((step) => step.role)).toEqual(["base", ...Array<string>(16).fill("effect"), "final"]);
    }, 120000);

    it("顶层 LIGHTING 1（ltop）：19 次绘制，多出 normal；combine 着色器没有光照、槽 2 绑 _rt_SmokeNormal", async () => {
      const bundle = await compileFluid({ LIGHTING: 1 });
      expect(bundle.unsupported).toEqual([]);
      const effect = bundle.layers[0].effects[0];
      expect(effect.fbos.map((fbo) => fbo.name).at(-1)).toBe("_rt_SmokeNormal");
      const draws = drawSteps(bundle.layers[0]);
      expect(draws).toHaveLength(18);
      expect(draws[16].target).toBe("_rt_SmokeNormal");
      const combine = draws[17];
      expect(combine.binds?.map((bind) => [bind.name, bind.index])).toEqual([
        ["_rt_SmokeDye2", 0],
        ["previous", 1],
        ["_rt_SmokeNormal", 2],
      ]);
      expect(combine.pass.uniforms.u_Feather).toEqual([0.68]);
      expect(comboOf(bundle, combine, "LIGHTING")).toBe(0);
      expect(plannedDraws(bundle)).toHaveLength(19);
    }, 120000);

    it("只在 combine 覆盖里 LIGHTING 1（lpass）：18 次绘制，combine 带光照（照报 lighting:effect）", async () => {
      const bundle = await compileFluid(undefined, { LIGHTING: 1 });
      expect(bundle.unsupported).toEqual(["lighting:effect"]);
      const draws = drawSteps(bundle.layers[0]);
      expect(draws).toHaveLength(17);
      expect(comboOf(bundle, draws[16], "LIGHTING")).toBe(1);
      expect(draws[16].binds?.map((bind) => bind.index)).toEqual([0, 1]);
    }, 120000);

    it("RENDERING：顶层 1 不绑槽 4；顶层 3 绑 _rt_SmokeVelocity2（rg16float、256×256），pass 覆盖才改着色器", async () => {
      const slots = (bundle: SceneBundle) =>
        drawSteps(bundle.layers[0])
          .at(-1)!
          .binds!.map((bind) => bind.index);
      expect(slots(await compileFluid({ RENDERING: 1 }))).toEqual([0, 1]);
      expect(slots(await compileFluid(undefined, { RENDERING: 3 }))).toEqual([0, 1]);
      const top = await compileFluid({ RENDERING: 3 });
      expect(slots(top)).toEqual([0, 1, 4]);
      expect(comboOf(top, drawSteps(top.layers[0]).at(-1)!, "RENDERING")).toBe(0);
      const both = await compileFluid({ RENDERING: 3 }, { RENDERING: 3 });
      expect(both.unsupported).toEqual([]);
      const combine = plannedDraws(both).at(-1)!;
      expect(combine.role).toBe("final");
      expect(combine.inputs[4]).toEqual({ kind: "fbo", effect: 0, name: "_rt_SmokeVelocity2" });
      expect(both.layers[0].effects[0].fbos.find((fbo) => fbo.name === "_rt_SmokeVelocity2")?.format).toBe("rg1616f");
      expect(comboOf(both, drawSteps(both.layers[0]).at(-1)!, "RENDERING")).toBe(3);
    }, 120000);
  },
);
