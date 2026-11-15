// 材质对象键顺序（rea-p6d1-keyorder）：七组 WPE 实测（`ignore/p6/d0/out/p6d1-round2.log`）+ 4.3 的边角。
import { describe, expect, it } from "vitest";
import { materialObjectKeys } from "./materialKeyOrder";

const TAIL = ["depthwrite", "depthtest", "cullmode", "alphawriting", "blending", "getAnimation"];
const P = "ui_editor_properties_";

/** 键集合（顺序无关，这里故意打乱）→ 完整键列表，去掉尾部后与实测的常量部分比较。 */
function check(keys: string[], want: string[]): void {
  expect(materialObjectKeys(keys)).toEqual([...want, ...TAIL]);
  expect(materialObjectKeys([...keys].reverse())).toEqual([...want, ...TAIL]);
}

describe("materialObjectKeys 与 WPE 实测逐项相同", () => {
  it("tint", () => check(["alpha", "color"], ["color", "alpha"]));
  it("transform", () => check(["offset", "scale", "angle"], ["scale", "offset", "angle"]));
  it("chromaticaberration MODE 1", () =>
    check(
      [P + "direction", P + "strength", P + "center_falloff", P + "center"],
      [P + "center_falloff", P + "center", P + "direction", P + "strength"],
    ));
  it("chromaticaberration MODE 0", () =>
    check([P + "strength", P + "center_falloff", P + "center"], [P + "center_falloff", P + "center", P + "strength"]));
  it("fire（9 个键，触发扩容）", () => {
    const want = [
      "threshold",
      "scale",
      "feather",
      "smoothness",
      "speed",
      "distortion",
      "colorstart",
      "colorend",
      "alpha",
    ];
    check(want, want);
  });
  it("pulse", () => {
    const want = ["tintlow", "power", "noisespeed", "noiseamount", "bounds", "phase", "speed", "tinthigh", "amount"];
    check(want, want);
  });
  it("lightshafts（12 个键）", () => {
    const want = [
      "rayspeed",
      "rayscale",
      "rayfeather",
      "point1",
      "point0",
      "colorwintensity",
      "raysmoothness",
      "colorwexponent",
      "point3",
      "colorend",
      "point2",
      "colorastart",
    ];
    check(want, want);
  });
});

describe("materialObjectKeys 边角（rea-p6d1-keyorder 4.3，推断、WPE 未实测）", () => {
  it("没有常量时只有状态字段与 getAnimation", () => {
    expect(materialObjectKeys([])).toEqual(TAIL);
  });

  it("材质键与状态名同名：只留一个，位置在常量那一段（不在状态字段那一段）", () => {
    const keys = materialObjectKeys(["blending", "alpha"]);
    expect(keys.filter((k) => k === "blending")).toHaveLength(1);
    expect(keys.at(-1)).toBe("getAnimation");
    // 去重保留倒序里先出现的那条 = 实例（常量）那一条，所以它排在其余四个状态字段之前
    expect(keys.indexOf("blending")).toBeLessThan(keys.indexOf("depthwrite"));
    expect(keys).toHaveLength(7);
  });

  it("数字样的键：顺序由 JS 引擎决定（整数样式键排在所有字符串键之前），本模块只给出模拟顺序", () => {
    const keys = materialObjectKeys(["12", "0", "alpha"]);
    expect(new Set(keys)).toEqual(new Set(["12", "0", "alpha", ...TAIL]));
    const object: Record<string, number> = {};
    for (const k of keys) object[k] = 1;
    expect(Object.keys(object).slice(0, 2)).toEqual(["0", "12"]);
  });
});
