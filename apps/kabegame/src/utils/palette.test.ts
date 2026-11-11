import { describe, expect, it } from "vitest";
import { parsePalette, rgbToHex } from "./palette";

describe("parsePalette", () => {
  it("正常解析并补出六位 hex，保持原顺序", () => {
    expect(parsePalette("[[16711680,62],[16777215,33]]")).toEqual([
      { rgb: 0xff0000, hex: "ff0000", percent: 62 },
      { rgb: 0xffffff, hex: "ffffff", percent: 33 },
    ]);
  });

  it("黑色与前导零补满六位", () => {
    expect(parsePalette("[[0,100]]")).toEqual([{ rgb: 0, hex: "000000", percent: 100 }]);
    expect(parsePalette("[[255,60],[2560,40]]").map((color) => color.hex)).toEqual(["0000ff", "000a00"]);
    expect(rgbToHex(0x00ff00)).toBe("00ff00");
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["空串", ""],
    ["坏 JSON", "[[16711680,62"],
    ["不是 JSON", "ff0000"],
  ])("%s → 空数组", (_name, text) => {
    expect(parsePalette(text)).toEqual([]);
  });

  it.each([
    ["不是数组", '{"rgb":16711680}'],
    ["数字", "16711680"],
    ["JSON null", "null"],
    ["项不是数组", "[16711680,62]"],
    ["项长度不对", "[[16711680]]"],
    ["项多了一个元素", "[[16711680,62,1]]"],
    ["rgb 是字符串", '[["ff0000",62]]'],
    ["rgb 超出范围", "[[16777216,62]]"],
    ["rgb 为负", "[[-1,62]]"],
    ["rgb 不是整数", "[[1.5,62]]"],
    ["百分比是字符串", '[[16711680,"62"]]'],
    ["百分比为负", "[[16711680,-1]]"],
    ["百分比为 null", "[[16711680,null]]"],
    ["其中一项不合法则整份作废", "[[16711680,62],[16777215]]"],
  ])("形状不对（%s）→ 空数组", (_name, text) => {
    expect(parsePalette(text)).toEqual([]);
  });

  it("空数组仍是空数组", () => {
    expect(parsePalette("[]")).toEqual([]);
  });
});
