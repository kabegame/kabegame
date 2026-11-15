/**
 * P6d1b 点 1：材质状态字段的取值表与规整（`compile/passState.ts`，`rea-p6d1-matstate.md` 第 1、2 节，`p6d1-mat8` 实测）。
 * 编译期的 `normalizeDepthKeys` 与运行中的脚本写入共用这一张表。
 */
import { describe, expect, it } from "vitest";
import { normalizeDepthKeys, SUPPORTED } from "./features";
import { isPassStateField, normalizeJsonPassState, normalizePassState, PASS_STATE_TABLES } from "./passState";

type Field = keyof typeof PASS_STATE_TABLES;
const FIELDS = Object.keys(PASS_STATE_TABLES) as Field[];

describe("normalizePassState：照 WPE 的字符串表（p6d1-mat8）", () => {
  it("每个字段只认自己表里的名字，全等、区分大小写、空白也算字符", () => {
    for (const field of FIELDS)
      for (const name of PASS_STATE_TABLES[field]) {
        const first = PASS_STATE_TABLES[field][0];
        expect(normalizePassState(field, name)).toBe(name);
        expect(normalizePassState(field, name.toUpperCase())).toBe(first);
        expect(normalizePassState(field, ` ${name}`)).toBe(first);
        expect(normalizePassState(field, `${name} `)).toBe(first);
      }
  });

  it("blending：normal / translucent / additive / alphatocoverage；bogus / Additive / disabled / 3 → normal", () => {
    expect(PASS_STATE_TABLES.blending).toEqual(["normal", "translucent", "additive", "alphatocoverage"]);
    for (const raw of ["bogus", "Additive", "disabled", 3, true, {}, ""])
      expect(normalizePassState("blending", raw), String(raw)).toBe("normal");
  });

  it("alphawriting：default / disabled / enabled；非法（bogus、Enabled、true）→ default", () => {
    expect(PASS_STATE_TABLES.alphawriting).toEqual(["default", "disabled", "enabled"]);
    for (const raw of ["bogus", "Enabled", true, 1]) expect(normalizePassState("alphawriting", raw)).toBe("default");
  });

  it("depthtest / depthwrite：表的第一项是 disabled，非法（bogus、less、Disabled）→ disabled", () => {
    for (const field of ["depthtest", "depthwrite"] as const) {
      expect(PASS_STATE_TABLES[field]).toEqual(["disabled", "enabled"]);
      for (const raw of ["bogus", "less", "Disabled", "ENABLED", 1, true])
        expect(normalizePassState(field, raw), `${field} ${String(raw)}`).toBe("disabled");
    }
  });

  it("cullmode：normal / nocull；非法（back / front / none / Normal）→ normal", () => {
    expect(PASS_STATE_TABLES.cullmode).toEqual(["normal", "nocull"]);
    for (const raw of ["bogus", "back", "front", "none", "Normal"])
      expect(normalizePassState("cullmode", raw)).toBe("normal");
  });

  it("null / undefined 不写；数字、布尔、对象先 ToString；转换抛错也不写", () => {
    for (const field of FIELDS) {
      expect(normalizePassState(field, null)).toBeUndefined();
      expect(normalizePassState(field, undefined)).toBeUndefined();
    }
    expect(normalizePassState("blending", { toString: () => "additive" })).toBe("additive");
    expect(normalizePassState("blending", Symbol("x"))).toBeUndefined();
    expect(
      normalizePassState("blending", {
        toString: () => {
          throw new Error("x");
        },
      }),
    ).toBeUndefined();
  });

  it("isPassStateField 只认这五个", () => {
    for (const name of FIELDS) expect(isPassStateField(name)).toBe(true);
    for (const name of ["constructor", "toString", "alphaWriting", "depth", ""])
      expect(isPassStateField(name)).toBe(false);
  });
});

describe("编译期共用同一张表", () => {
  it("normalizeJsonPassState：非字符串（含 null）落到第一项；normalizeDepthKeys 缺键为开、写错取第一项", () => {
    expect(normalizeJsonPassState("depthtest", null)).toBe("disabled");
    expect(normalizeJsonPassState("cullmode", 7)).toBe("normal");
    expect(normalizeDepthKeys({})).toEqual({ cullmode: "normal", depthtest: "enabled", depthwrite: "enabled" });
    expect(normalizeDepthKeys({ cullmode: "back", depthtest: "less", depthwrite: "Enabled" })).toEqual({
      cullmode: "normal",
      depthtest: "disabled",
      depthwrite: "disabled",
    });
    expect(SUPPORTED.blending).toBe(PASS_STATE_TABLES.blending);
  });
});
