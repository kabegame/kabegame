/**
 * P5a 步骤 1 的编译侧单测：前置的能力表修正（`.claude/plans/wpe-import/3-scene/phase5/phase-5a-parallax.md`「步骤 1」）。
 * 依据是 p5-REPORT「P5a 语义的实测核对」最后五行：JSON 注释、`cropoffset` 与对象 `config` 中性、不写深度的 pass 上
 * `depthwrite` 中性（P5d 步骤 1 起会写深度的也不报）、模型 JSON 的布尔键只认 `true`。
 */
import { describe, expect, it } from "vitest";
import { checkModelFeatures, checkObjectFeatures, checkPassFeatures, modelFlag } from "./features";
import { parseWpeJson, type MaterialPass, type ModelJson, type SceneObject } from "./model";

function modelKeys(model: ModelJson): string[] {
  const keys = new Set<string>();
  checkModelFeatures(model, keys);
  return [...keys].sort();
}
function objectKeys(object: SceneObject): string[] {
  const keys = new Set<string>();
  checkObjectFeatures(object, keys);
  return [...keys].sort();
}
function passKeys(pass: MaterialPass): string[] {
  const keys = new Set<string>();
  checkPassFeatures({ shader: "genericimage2", ...pass }, keys);
  return [...keys].sort();
}

describe("parseWpeJson 认注释", () => {
  it("`//` 行注释", () => {
    const text = '{\n  // 注释行\n  "a": 1, // 行尾注释\n  "b": [2, 3]\n}';
    expect(parseWpeJson(text)).toEqual({ a: 1, b: [2, 3] });
  });
  it("`/* */` 块注释，含跨行", () => {
    const text = '{ /* 头 */ "a": /* 中间 */ 1,\n /* 跨\n 行 */ "b": "x" }';
    expect(parseWpeJson(text)).toEqual({ a: 1, b: "x" });
  });
  it("字符串里的 `//`、`/*` 原样保留", () => {
    const text = '{ "url": "http://x/y", "c": "/* 不是注释 */", "d": "a\\"//b" } // 尾注释';
    expect(parseWpeJson(text)).toEqual({ url: "http://x/y", c: "/* 不是注释 */", d: 'a"//b' });
  });
  it("注释后紧跟尾逗号", () => {
    expect(parseWpeJson('{ "a": [1, 2, // 注释\n ], "b": 3, /* 注释 */ }')).toEqual({ a: [1, 2], b: 3 });
  });
  it("去掉注释后仍不合法：抛原错误", () => {
    expect(() => parseWpeJson('{ "a": // 注释\n }')).toThrow();
  });
});

describe("模型 JSON", () => {
  it("`cropoffset` 不报", () => {
    expect(modelKeys({ material: "materials/a.json", cropoffset: "100 100" })).toEqual([]);
  });
  it("布尔键只认 `true`：写成 1、字符串不报", () => {
    expect(modelKeys({ material: "materials/a.json", fullscreen: 1 })).toEqual([]);
    expect(modelKeys({ material: "materials/a.json", nopadding: "true" })).toEqual([]);
    expect(modelKeys({ material: "materials/a.json", instanced: 1, passthrough: "1" })).toEqual([]);
    // `fullscreen`（P5b 步骤 3）、`nopadding`（步骤 1）、`instanced`（步骤 5）都已实现，写成 true 也不再报；布尔键全部放行之后，
    // 「只认 true」由下面的 `modelFlag` 用例与 compile/p5b.test.ts（`instanced: 1` 不是 instanced 图层）核对
    expect(modelKeys({ material: "materials/a.json", fullscreen: true })).toEqual([]);
    expect(modelKeys({ material: "materials/a.json", instanced: true })).toEqual([]);
    expect(modelKeys({ material: "materials/a.json", nopadding: true, instanced: true })).toEqual([]);
  });
  it("非布尔键照旧按真值报；`puppet`（路径字符串）从 P12a 起放行，用法由 `buildPuppet` 报细分键", () => {
    expect(modelKeys({ material: "materials/a.json", puppet: "models/a.mdl" })).toEqual([]);
    expect(modelKeys({ material: "materials/a.json", bones: "models/a.mdl" })).toEqual(["model:bones"]);
    expect(modelKeys({ material: "materials/a.json", bones: "" })).toEqual([]);
    expect(modelKeys({ material: "materials/a.json", unknownkey: 1 })).toEqual(["model:unknownkey"]);
  });
  it("`modelFlag`：`solidlayer` 写成 1 不算", () => {
    expect(modelFlag({ solidlayer: true }, "solidlayer")).toBe(true);
    expect(modelFlag({ solidlayer: 1 }, "solidlayer")).toBe(false);
    expect(modelFlag({ solidlayer: "true" }, "solidlayer")).toBe(false);
    expect(modelFlag({}, "solidlayer")).toBe(false);
  });
});

describe("对象 `config`", () => {
  it("`config: {passthrough: true}` 不报", () => {
    expect(objectKeys({ id: 1, image: "models/a.json", config: { passthrough: true } })).toEqual([]);
  });
});

describe("`depthwrite: enabled` 不报（P5a 起不写深度的中性，P5d 步骤 1 接上深度附件后一律不报）", () => {
  it("translucent、additive、`depthtest: disabled` 不写深度，不报", () => {
    expect(passKeys({ blending: "translucent", depthwrite: "enabled" })).toEqual([]);
    expect(passKeys({ blending: "additive", depthwrite: "enabled" })).toEqual([]);
    expect(passKeys({ blending: "normal", depthtest: "disabled", depthwrite: "enabled" })).toEqual([]);
  });
  it("normal 加 `depthtest: enabled`、normal 缺 `depthtest`：会写深度，P5d 步骤 1 起同样不报", () => {
    expect(passKeys({ blending: "normal", depthtest: "enabled", depthwrite: "enabled" })).toEqual([]);
    expect(passKeys({ blending: "normal", depthwrite: "enabled" })).toEqual([]);
    expect(passKeys({ depthwrite: "enabled" })).toEqual([]);
  });
});
