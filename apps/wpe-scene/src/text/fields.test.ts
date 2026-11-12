/**
 * P6b 1e-1：文本字段的两套取值规则（`.claude/plans/wpe-import/3-scene/phase6/phase-6b-text.md`「1e」点 1；WPE 语义见调研笔记
 * `ignore/p6/b1e/research.md` B 节第 4 条）。
 * - 属性 / JSON 侧（`textFieldFromJson`）：编译期与属性就地写共用，结果必须和 1d 的 `compileText` 逐项相同（下面用 1d 的原写法对拍）；
 * - 脚本侧（`textFieldFromScript`）：`text` 按 `ToString`、`null` / `undefined` 不写，枚举 `ToString` 后查表，布尔位只收布尔。
 */
import { describe, expect, it } from "vitest";
import { TEXT_RUNTIME_FIELDS } from "../compile/bindings";
import { numbers, type SceneScalar } from "../compile/model";
import {
  sameTextField,
  scriptToString,
  TEXT_DEFAULTS,
  textFieldFromJson,
  textFieldFromScript,
  type TextFieldKey,
} from "./fields";

// ———— 1d 的 `compileText` 原写法（HEAD `ff4ad0e3` 的 `compile/texts.ts`），只用来对拍 ————

function legacyFloat(value: unknown, fallback: number): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : fallback;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}
function legacyVec2(value: unknown, fallback: readonly [number, number]): [number, number] {
  const parsed = numbers(value as SceneScalar | undefined, []);
  if (parsed.length === 0) return [fallback[0], fallback[1]];
  return parsed.length === 1 ? [parsed[0], parsed[0]] : [parsed[0], parsed[1]];
}
function legacyEnum<T extends string>(value: unknown, table: readonly T[], fallback: T): T {
  if (value === undefined || value === null) return fallback;
  const text = typeof value === "string" ? value : "";
  return (table as readonly string[]).includes(text) ? (text as T) : table[0];
}
function legacy(field: TextFieldKey, raw: unknown): unknown {
  switch (field) {
    case "text":
      return typeof raw === "string" ? raw : "";
    case "font":
      return typeof raw === "string" ? raw : TEXT_DEFAULTS.font;
    case "pointsize":
    case "maxwidth":
      return legacyFloat(raw, TEXT_DEFAULTS[field]);
    case "maxrows":
      return Math.trunc(legacyFloat(raw, TEXT_DEFAULTS.maxrows));
    case "padding":
    case "spacing":
      return legacyVec2(raw, TEXT_DEFAULTS[field]);
    case "horizontalalign":
      return legacyEnum(raw, ["left", "center", "right"] as const, TEXT_DEFAULTS.horizontalalign);
    case "verticalalign":
      return legacyEnum(raw, ["center", "bottom", "top"] as const, TEXT_DEFAULTS.verticalalign);
    default:
      return raw === true;
  }
}

/** `read()` 交给取值规则的各种值（`{user}` / `{script}` 已解析成标量，对象的 `value` 已取出）。 */
const RAWS: unknown[] = [
  undefined,
  null,
  "",
  " ",
  "abc",
  "Song Title",
  "12",
  "12.5",
  " 7 ",
  "10 20",
  "1 2 3",
  "1e3",
  "NaN",
  "Infinity",
  0,
  -0,
  12,
  -3.7,
  2.9,
  NaN,
  Infinity,
  true,
  false,
  {},
  [],
  [1, 2],
  "left",
  "center",
  "right",
  "top",
  "bottom",
  "foo",
];

const ALL_FIELDS: TextFieldKey[] = [...TEXT_RUNTIME_FIELDS, "font", "opaquebackground"];

describe("textFieldFromJson：与 1d 的 compileText 逐项相同", () => {
  it.each(ALL_FIELDS)("%s：不写时取缺省 = 原写法", (field) => {
    for (const raw of RAWS) {
      const value = textFieldFromJson(field, raw);
      expect([raw, value ?? TEXT_DEFAULTS[field]]).toEqual([raw, legacy(field, raw)]);
    }
  });
});

describe("textFieldFromJson：属性侧规则", () => {
  it("text / font 只收字符串，数字、布尔、缺键不写", () => {
    expect(textFieldFromJson("text", "Hello")).toBe("Hello");
    expect(textFieldFromJson("text", "")).toBe("");
    for (const raw of [12, true, false, null, undefined, {}]) expect(textFieldFromJson("text", raw)).toBeUndefined();
    expect(textFieldFromJson("font", "fonts/a.ttf")).toBe("fonts/a.ttf");
    expect(textFieldFromJson("font", 3)).toBeUndefined();
  });

  it("float：数字、数字串、条件布尔；不合法不写；maxrows 截断取整", () => {
    expect(textFieldFromJson("pointsize", 40)).toBe(40);
    expect(textFieldFromJson("pointsize", "12.5")).toBe(12.5);
    expect(textFieldFromJson("pointsize", true)).toBe(1);
    expect(textFieldFromJson("pointsize", false)).toBe(0);
    for (const raw of ["abc", "", " ", NaN, Infinity, "10 20"])
      expect(textFieldFromJson("maxwidth", raw)).toBeUndefined();
    expect(textFieldFromJson("maxrows", 2.9)).toBe(2);
    expect(textFieldFromJson("maxrows", "3.7")).toBe(3);
    expect(textFieldFromJson("maxrows", -1.5)).toBe(-1);
  });

  it("vec2：单个数字铺满，两个分量原样，解析不出不写", () => {
    expect(textFieldFromJson("padding", 10)).toEqual([10, 10]);
    expect(textFieldFromJson("padding", "7")).toEqual([7, 7]);
    expect(textFieldFromJson("spacing", "10 20")).toEqual([10, 20]);
    expect(textFieldFromJson("spacing", "1 2 3")).toEqual([1, 2]);
    expect(textFieldFromJson("padding", "a b")).toBeUndefined();
    expect(textFieldFromJson("padding", null)).toBeUndefined();
  });

  it("布尔位 === true；枚举不是字符串按空串、查不到取表里第一项，缺键不写", () => {
    expect(textFieldFromJson("limitwidth", true)).toBe(true);
    expect(textFieldFromJson("limitwidth", false)).toBe(false);
    expect(textFieldFromJson("blockalign", 1)).toBe(false);
    expect(textFieldFromJson("blockalign", "true")).toBe(false);
    expect(textFieldFromJson("horizontalalign", "right")).toBe("right");
    expect(textFieldFromJson("horizontalalign", "foo")).toBe("left");
    expect(textFieldFromJson("horizontalalign", 12)).toBe("left");
    expect(textFieldFromJson("verticalalign", "foo")).toBe("center");
    expect(textFieldFromJson("verticalalign", "top")).toBe("top");
    expect(textFieldFromJson("verticalalign", null)).toBeUndefined();
  });
});

describe("textFieldFromScript：脚本侧规则（WPE 类型 5 / 6）", () => {
  it("text：null / undefined 不写，字符串原样，其余 ToString", () => {
    expect(textFieldFromScript("text", null)).toBeUndefined();
    expect(textFieldFromScript("text", undefined)).toBeUndefined();
    expect(textFieldFromScript("text", "F183")).toBe("F183");
    expect(textFieldFromScript("text", "")).toBe("");
    expect(textFieldFromScript("text", "\0")).toBe("\0");
    // 0c 实测：`t.text = 12` 读回 "12"
    expect(textFieldFromScript("text", 12)).toBe("12");
    expect(textFieldFromScript("text", 1.5)).toBe("1.5");
    expect(textFieldFromScript("text", true)).toBe("true");
    expect(textFieldFromScript("text", false)).toBe("false");
    expect(textFieldFromScript("text", {})).toBe("[object Object]");
    expect(textFieldFromScript("text", { toString: () => "x" })).toBe("x");
    expect(textFieldFromScript("text", [1, 2])).toBe("1,2");
  });

  it("ToString 抛错的不写：Symbol、没有原型的对象、toString 自己抛错", () => {
    expect(textFieldFromScript("text", Symbol("s"))).toBeUndefined();
    expect(textFieldFromScript("text", Object.create(null))).toBeUndefined();
    const bad = {
      toString() {
        throw new Error("bad");
      },
    };
    expect(textFieldFromScript("text", bad)).toBeUndefined();
    expect(scriptToString(Symbol("s"))).toBeUndefined();
  });

  it("枚举：ToString 后查表（`horizontalalign = 'foo'` → left），标量与属性侧相同", () => {
    expect(textFieldFromScript("horizontalalign", "foo")).toBe("left");
    expect(textFieldFromScript("horizontalalign", "right")).toBe("right");
    expect(textFieldFromScript("verticalalign", "foo")).toBe("center");
    expect(textFieldFromScript("verticalalign", null)).toBeUndefined();
    for (const field of ["horizontalalign", "verticalalign"] as const)
      for (const raw of RAWS)
        if (raw !== null && raw !== undefined && typeof raw !== "object")
          expect([raw, textFieldFromScript(field, raw)]).toEqual([raw, textFieldFromJson(field, raw)]);
    // 只有数组 / 自带 toString 的对象不同：WPE 按 ToString
    expect(textFieldFromScript("horizontalalign", ["right"])).toBe("right");
  });

  it("数字、向量与属性侧相同（写回链交来的是 `scriptWriteValue` 之后的标量）", () => {
    for (const field of ["pointsize", "maxwidth", "maxrows", "padding", "spacing"] as const)
      for (const raw of RAWS)
        if (raw !== null && raw !== undefined)
          expect([field, raw, textFieldFromScript(field, raw)]).toEqual([field, raw, textFieldFromJson(field, raw)]);
    // 0c 实测：`t.padding = 10` → (10, 10)
    expect(textFieldFromScript("padding", 10)).toEqual([10, 10]);
    expect(textFieldFromScript("padding", "10 20")).toEqual([10, 20]);
    expect(textFieldFromScript("maxrows", 2.9)).toBe(2);
    expect(textFieldFromScript("maxwidth", null)).toBeUndefined();
  });

  it("布尔位只收布尔（类型 6）", () => {
    expect(textFieldFromScript("limitrows", true)).toBe(true);
    expect(textFieldFromScript("limitrows", false)).toBe(false);
    for (const raw of [1, 0, "true", null, undefined]) expect(textFieldFromScript("limitrows", raw)).toBeUndefined();
  });
});

describe("sameTextField：逐项比较", () => {
  it("向量逐分量、标量按 ===（0 与 −0 相同）", () => {
    expect(sameTextField([10, 20], [10, 20])).toBe(true);
    expect(sameTextField([10, 20], [10, 21])).toBe(false);
    expect(sameTextField("a", "a")).toBe(true);
    expect(sameTextField("a", "b")).toBe(false);
    expect(sameTextField(0, -0)).toBe(true);
    expect(sameTextField(true, false)).toBe(false);
  });
});
