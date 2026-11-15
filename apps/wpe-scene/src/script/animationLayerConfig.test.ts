/**
 * P12e-2：`createAnimationLayer` / `playSingleAnimation` 的参数规整（`script/animationLayerConfig.ts`，rea-p12e 第 1、2 节与「实测」2、3）。
 * 纯函数，`JSON` 用宿主的；逐行对应 p12-create 日志里 t2 / t3 / t4 的实参。
 */
import { describe, expect, it } from "vitest";
import { animationLayerItem, stubText } from "./animationLayerConfig";

/** 动画表（MDLA 顺序）：id 900 起，和 p12-create 的 mdl 同形：loopA、singleB、mirrorC、dup（两条同名）、id0（记录 id 为 0）、坏动画。 */
const ANIMATIONS = [
  { id: 900, name: "loopA" },
  { id: 901, name: "singleB" },
  { id: 902, name: "mirrorC" },
  { id: 903, name: "dup" },
  { id: 904, name: "dup" },
  { id: 0, name: "id0" },
  { id: 905, name: "broken", unsupported: ["mdl:animation:tracks", "puppet:alpha-track"] },
  { id: 900, name: "loopTwin" },
];

const item = (first: unknown, config?: unknown) => animationLayerItem(first, config, ANIMATIONS, JSON);

/** 缺省的字段（实测 1：名字空串、rate 1 …；`blendin` 缺省补的 true，`blendout` 缺省补的 true）。 */
const DEFAULTS = {
  name: "",
  rate: 1,
  blend: 1,
  visible: true,
  additive: false,
  blendin: true,
  blendout: true,
  blendtime: 0.5,
  autosort: false,
  index: null,
};

describe("stubText：dll 方法桩形参 0x600 的转换（rea-p12e 第 1 节）", () => {
  it("字符串原样，在第一个 NUL 处截断", () => {
    expect(stubText("loopA", JSON)).toEqual({ text: "loopA", kind: "string" });
    expect(stubText("a\0b", JSON)).toEqual({ text: "a", kind: "string" });
    expect(stubText("", JSON)).toEqual({ text: "", kind: "string" });
  });

  it("对象（含数组）经 JSON.stringify；得到 undefined 或抛错（循环引用、BigInt）为空串", () => {
    expect(stubText({ animation: 900 }, JSON)).toEqual({ text: '{"animation":900}', kind: "object" });
    expect(stubText([1, 2], JSON)).toEqual({ text: "[1,2]", kind: "object" });
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(stubText(cycle, JSON).kind).toBe("empty");
    expect(stubText({ big: 1n }, JSON).kind).toBe("empty");
    expect(stubText({ toJSON: () => undefined }, JSON).kind).toBe("empty");
  });

  it("数字、布尔、null、undefined、函数、缺参数都是空串", () => {
    for (const value of [5, 0, NaN, true, false, null, undefined, () => 1, Symbol("x")])
      expect(stubText(value, JSON), String(typeof value)).toEqual({ text: "", kind: "empty" });
  });
});

describe("animationLayerItem：查找（实测 2）", () => {
  it("字符串：按名字找 MDLA 顺序里第一条，区分大小写", () => {
    expect(item("loopA").item?.animation).toBe(0);
    expect(item("singleB").item?.animation).toBe(1);
    expect(item("loopa").item).toBeNull();
    expect(item("LOOPA").item).toBeNull();
    expect(item("nosuch").item).toBeNull();
  });

  it("同名取第一条（dup → 下标 3）；记录 id 为 0 的按名字建不了", () => {
    expect(item("dup").item?.animation).toBe(3);
    expect(item("id0").item).toBeNull();
  });

  it("名字找到后再按 id 找第一条（两条动画 id 相同时可能不是按名字找到的那条）", () => {
    // loopTwin 与 loopA 同 id 900：建层函数按 id 找，落到第一条（下标 0）
    expect(item("loopTwin").item?.animation).toBe(0);
  });

  it("5 / 0 / true / '' / null / undefined / 不带参数 都是 null（空串）", () => {
    for (const bad of [5, 0, true, "", null, undefined]) expect(item(bad).item, String(bad)).toBeNull();
    expect(animationLayerItem(undefined, undefined, ANIMATIONS, JSON).item).toBeNull();
  });

  it("对象第一参：animation 只认 JSON 数，取整；字符串、不存在、负数、过大都是 null", () => {
    expect(item({ animation: 900 }).item?.animation).toBe(0);
    expect(item({ animation: 900.5 }).item?.animation).toBe(0);
    expect(item({ animation: 901.99 }).item?.animation).toBe(1);
    for (const bad of [
      { animation: "900" },
      { animation: "loopA" },
      { animation: 12345 },
      { animation: -1 },
      { animation: 2 ** 64 },
      { animation: true },
      {},
    ])
      expect(item(bad).item, JSON.stringify(bad)).toBeNull();
  });

  it("对象第一参里的 name / rate 生效（实测 t2.obj.full）", () => {
    const { item: result } = item({ animation: 902, name: "objn", rate: 0.5 });
    expect(result).toEqual({ ...DEFAULTS, animation: 2, name: "objn", rate: 0.5 });
  });

  it("数组、非对象的第一参 null", () => {
    expect(item([900]).item).toBeNull();
  });
});

describe("animationLayerItem：config（实测 3）", () => {
  it("缺 blendin / blendout 键补 true；值是 false / null 也算「有这个键」不补", () => {
    expect(item("loopA").item).toMatchObject({ blendin: true, blendout: true });
    expect(item("loopA", { blendin: false, blendout: false }).item).toMatchObject({ blendin: false, blendout: false });
    // null 不是 JSON 布尔：键在、不补，也不写，取缺省 false
    expect(item("loopA", { blendin: null }).item).toMatchObject({ blendin: false, blendout: true });
  });

  it("config 的键覆盖第一参对象的同名键：第一参里的 blendin: false 总被补的 true 盖掉，config 里的才生效", () => {
    expect(item({ animation: 900, blendin: false, blendout: false }).item).toMatchObject({
      blendin: true,
      blendout: true,
    });
    expect(item({ animation: 900 }, { blendin: false }).item).toMatchObject({ blendin: false, blendout: true });
    expect(item({ animation: 900, rate: 3 }, { rate: 2 }).item?.rate).toBe(2);
  });

  it("字符串路径：config 里的 animation 被名字找到的 id 覆盖（实测 t3.cfgAnim：loopA 加 animation 902 仍是 loopA）", () => {
    expect(item("loopA", { animation: 902, name: "cfgAnim" }).item).toMatchObject({ animation: 0, name: "cfgAnim" });
  });

  it("字符串 config 按 JSON 文本解析；解析失败、空串、数字、布尔、null 同缺省", () => {
    expect(item("loopA", '{"rate":2,"name":"x"}').item).toMatchObject({ rate: 2, name: "x" });
    for (const same of ['{"rate":2, x', "", 5, true, null, undefined, "null"])
      expect(item("loopA", same), String(same)).toEqual({ item: { ...DEFAULTS, animation: 0 } });
  });

  it("config 解析成非对象（数、字符串、数组）：WPE 行为未定义，返回 null 并 warn（有意不同）", () => {
    for (const bad of ["5", '"s"', "[1]", "true", [1, 2]]) {
      const result = item("loopA", bad);
      expect(result.item, String(bad)).toBeNull();
      expect(result.warn).toContain("config");
    }
  });

  it("float 只收 JSON 数（转 f32），bool 只收 JSON 布尔，name 只收 JSON 字符串（实测 t3.nan / name5 / badTypes）", () => {
    expect(item("loopA", { rate: NaN }).item?.rate).toBe(1);
    expect(item("loopA", { rate: Infinity }).item?.rate).toBe(1);
    expect(item("loopA", { name: 5 }).item?.name).toBe("");
    expect(item("loopA", { rate: "3", blend: true, visible: 0, additive: "yes" }).item).toMatchObject({
      rate: 1,
      blend: 1,
      visible: true,
      additive: false,
    });
    expect(item("loopA", { rate: 0.1 }).item?.rate).toBe(Math.fround(0.1));
    // 布尔换成 0 / 1 也不收（false → 0、true → 1 都会和缺省 1 / 0.5 不同，用来杀「float 收布尔」）
    expect(item("loopA", { rate: false, blend: false, blendtime: true }).item).toMatchObject({
      rate: 1,
      blend: 1,
      blendtime: 0.5,
    });
    // 数字换成布尔也不收（非 0 为真、0 为假都不行）
    expect(item("loopA", { visible: 0, additive: 1, blendin: 1, blendout: 0 }).item).toMatchObject({
      visible: true,
      additive: false,
      blendin: false,
      blendout: false,
    });
  });

  it("t3.full：visible: false、additive: true、blend 0.5、blendtime 2 生效", () => {
    expect(item("loopA", { visible: false, additive: true, blend: 0.5, blendtime: 2 }).item).toMatchObject({
      visible: false,
      additive: true,
      blend: 0.5,
      blendtime: 2,
    });
  });

  it("值是对象时取它的 value；带 user / script / animation 键时不登记绑定，warn", () => {
    const result = item("loopA", { rate: { user: "speed", value: 4 }, visible: { value: false } });
    expect(result.item).toMatchObject({ rate: 4, visible: false });
    expect(result.warn).toContain("user");
    expect(item("loopA", { visible: { value: false } }).warn).toBeUndefined();
    // 对象没有 value：不写，取缺省
    expect(item("loopA", { rate: { user: "speed" } }).item?.rate).toBe(1);
  });

  it("id 键忽略；autosort 只认 JSON true；index 取整（向零），不是数为 null", () => {
    expect(item("loopA", { id: 7777, name: "id7777" }).item).toMatchObject({ name: "id7777" });
    expect(item("loopA", { autosort: true }).item?.autosort).toBe(true);
    for (const bad of [1, "true", null, false])
      expect(item("loopA", { autosort: bad }).item?.autosort, String(bad)).toBe(false);
    expect(item("loopA", { index: 2 }).item?.index).toBe(2);
    expect(item("loopA", { index: -3 }).item?.index).toBe(-3);
    expect(item("loopA", { index: 2.9 }).item?.index).toBe(2);
    expect(item("loopA", { index: -2.9 }).item?.index).toBe(-2);
    for (const bad of ["2", true, null]) expect(item("loopA", { index: bad }).item?.index, String(bad)).toBeNull();
    expect(item("loopA").item?.index).toBeNull();
  });
});

describe("animationLayerItem：不支持的动画（P12e，没被引用又用了不支持特性的）", () => {
  it("按名字、按 id 都返回 null 并 warn，日志带动画名与键", () => {
    for (const first of ["broken", { animation: 905 }]) {
      const result = item(first);
      expect(result.item).toBeNull();
      expect(result.warn).toContain("broken");
      expect(result.warn).toContain("mdl:animation:tracks");
    }
  });

  it("空数组的 unsupported 不算", () => {
    const result = animationLayerItem("a", undefined, [{ id: 1, name: "a", unsupported: [] }], JSON);
    expect(result.item?.animation).toBe(0);
  });
});
