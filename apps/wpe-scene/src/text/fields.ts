/**
 * 文本对象的排版字段与 WPE 的缺省值（P6b 1c 定义，1d 从 `layout.ts` 拆出）：编译 Worker 只要这两样（`compile/texts.ts` 把
 * scene.json 的字段规整成 `TextFields`），不必连带图集、wpefont 的包装一起进 Worker。`layout.ts` 原样再导出。
 *
 * 取值规则（P6b 1e）只写在这里一份：编译期（`compileText`）、属性就地写（`SceneState.write` 的文本分支）与脚本写回（宿主
 * `writeScript` → `SceneState.writeText`）都经下面两个函数，这是「就地 = 重编译」的保证。两侧只差字符串类字段：
 * - 属性 / JSON 侧（`FUN_1401a4bc0`，rea-p6b-layout 1.3）：`text`、`font` 只收字符串（或对象里的字符串 `value`，调用方先取出），
 *   数字、布尔不写；
 * - 脚本侧（类型 5，dll `FUN_181620e10`，rea-p6b-layout 6.2，0c 实测）：`null` / `undefined` 不写，字符串原样，其余按 V8 `ToString`
 *   （`12` → `"12"`），枚举再查表、查不到取表里第一项。
 * 数字、向量两侧相同；布尔位脚本侧只收布尔（类型 6），属性侧照编译期的 `=== true`。
 */
import type { TextRuntimeField } from "../compile/bindings";
import { numbers, type SceneScalar } from "../compile/model";

/** 排版用到的文本对象字段（rea-p6b-layout 1.2），外加决定 `padding` 的两项图层状态。 */
export interface TextFields {
  text: string;
  font: string;
  pointsize: number;
  padding: readonly [number, number];
  spacing: readonly [number, number];
  maxwidth: number;
  maxrows: number;
  limitwidth: boolean;
  limitrows: boolean;
  limituseellipsis: boolean;
  blockalign: boolean;
  opaquebackground: boolean;
  horizontalalign: "left" | "center" | "right";
  verticalalign: "top" | "center" | "bottom";
  /** 可见的 effect 个数（WPE `+0x320`）：大于 0 时文字画进合成 RT、加 `padding`。 */
  visibleEffects: number;
  /** `colorBlendMode`：0、31 以外的值也走合成（WPE `+0x304 & 0x10`）。 */
  colorBlendMode: number;
}

/** WPE 的缺省值（构造 `FUN_140256ae0`）。 */
export const TEXT_DEFAULTS: TextFields = {
  text: "",
  font: "systemfont_arial",
  pointsize: 32,
  padding: [32, 32],
  spacing: [0, 0],
  maxwidth: 500,
  maxrows: 1,
  limitwidth: false,
  limitrows: false,
  limituseellipsis: false,
  blockalign: false,
  opaquebackground: false,
  horizontalalign: "center",
  verticalalign: "center",
  visibleEffects: 0,
  colorBlendMode: 0,
};

/** 对象自己的文本字段（`visibleEffects` / `colorBlendMode` 是图层状态，不由这两个函数写）。 */
export type TextFieldKey = Exclude<keyof TextFields, "visibleEffects" | "colorBlendMode">;

/** 枚举的取值表：查不到取 WPE 表里的第一项（rea-p6b-layout 1.2：`horizontalalign` → left、`verticalalign` → center）。 */
export const TEXT_HORIZONTAL = ["left", "center", "right"] as const;
export const TEXT_VERTICAL = ["center", "bottom", "top"] as const;

/** float 键：数字原样，数字串整串解析，布尔（条件绑定）按 1 / 0；不合法时返回 undefined（WPE 的 float 解析器不收时不写字段）。 */
function parseTextFloat(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/** vec2 键（`padding`、`spacing`）：`"x y"` 两个分量，单个数字（或只有一个分量的串）铺满（rea-p6b-layout 1.2、6.2）。 */
function parseVec2(value: unknown): [number, number] | undefined {
  const parsed = numbers(value as SceneScalar | undefined, []);
  if (parsed.length === 0) return undefined;
  return parsed.length === 1 ? [parsed[0], parsed[0]] : [parsed[0], parsed[1]];
}

/** float 键，不合法时取缺省。 */
export function textFloat(value: unknown, fallback: number): number {
  return parseTextFloat(value) ?? fallback;
}

/** vec2 键，解析不出分量时取缺省（新数组）。 */
export function textVec2(value: unknown, fallback: readonly [number, number]): [number, number] {
  return parseVec2(value) ?? [fallback[0], fallback[1]];
}

/** 枚举键：不是字符串时按空串处理，查不到取表里的第一项；缺键（undefined / null）取缺省。 */
export function textEnum<T extends string>(value: unknown, table: readonly T[], fallback: T): T {
  if (value === undefined || value === null) return fallback;
  const text = typeof value === "string" ? value : "";
  return (table as readonly string[]).includes(text) ? (text as T) : table[0];
}

/**
 * 脚本侧字符串字段（WPE 类型 5：`text`、`font`、枚举）的取值：`null` / `undefined` 不写，字符串原样，其余按 V8 `ToString`
 * （`12` → `"12"`、`true` → `"true"`、`{}` → `"[object Object]"`）。`ToString` 抛错（Symbol、没有原型的对象、`toString` 自己抛错）
 * 时不写。脚本运行时的写回（`writeReturn`）与 API 的写入在交给宿主之前都经它。
 */
export function scriptToString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  try {
    // 模板字符串走抽象 ToString（Symbol 抛错，同 V8 的 `ToString`）；`String(symbol)` 是特例，不抛
    return `${value as string}`;
  } catch {
    return undefined;
  }
}

/**
 * 属性 / JSON 侧（编译期与用户属性的就地写共用，同 `compileText` 的 setter）：返回 undefined 表示不写（保持原值）。
 * 缺键（undefined / null）一律不写；`text` / `font` 只收字符串；float 键不合法不写，`maxrows` 截断取整；vec2 键单个数字铺满；
 * 布尔位 `=== true`；枚举不是字符串按空串、查不到取表里第一项。
 */
export function textFieldFromJson<F extends TextFieldKey>(field: F, raw: unknown): TextFields[F] | undefined {
  if (raw === undefined || raw === null) return undefined;
  return jsonValue(field, raw) as TextFields[F] | undefined;
}

function jsonValue(field: TextFieldKey, raw: unknown): TextFields[TextFieldKey] | undefined {
  switch (field) {
    case "text":
    case "font":
      return typeof raw === "string" ? raw : undefined;
    case "pointsize":
    case "maxwidth":
      return parseTextFloat(raw);
    case "maxrows": {
      const value = parseTextFloat(raw);
      return value === undefined ? undefined : Math.trunc(value);
    }
    case "padding":
    case "spacing":
      return parseVec2(raw);
    case "limitwidth":
    case "limitrows":
    case "limituseellipsis":
    case "blockalign":
    case "opaquebackground":
      return raw === true;
    case "horizontalalign":
      return textEnum(raw, TEXT_HORIZONTAL, TEXT_DEFAULTS.horizontalalign);
    case "verticalalign":
      return textEnum(raw, TEXT_VERTICAL, TEXT_DEFAULTS.verticalalign);
  }
}

/**
 * 脚本侧（字段脚本的返回值、API 写入，宿主 `writeScript` 调）：返回 undefined 表示不写。`value` 是写回链交来的值（`scriptWriteValue`
 * 之后：数字、空格分隔的向量串、布尔、字符串），也接受任意 JS 值。字符串类字段先 `scriptToString`（枚举再按属性侧查表）；布尔位只收布尔
 * （类型 6）；数字、向量同属性侧。
 */
export function textFieldFromScript<F extends TextFieldKey>(field: F, value: unknown): TextFields[F] | undefined {
  if (value === undefined || value === null) return undefined;
  switch (field) {
    case "text":
    case "font":
      return scriptToString(value) as TextFields[F] | undefined;
    case "horizontalalign":
    case "verticalalign": {
      const text = scriptToString(value);
      return text === undefined ? undefined : textFieldFromJson(field, text);
    }
    case "limitwidth":
    case "limitrows":
    case "limituseellipsis":
    case "blockalign":
    case "opaquebackground":
      return (typeof value === "boolean" ? value : undefined) as TextFields[F] | undefined;
    default:
      return textFieldFromJson(field, value);
  }
}

/** 两个字段值是否相同（WPE 逐项比较：浮点按 `==`，向量逐分量）。值没变不重排。 */
export function sameTextField(a: TextFields[TextFieldKey], b: TextFields[TextFieldKey]): boolean {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((part, i) => part === b[i]);
  return a === b;
}

/** 运行中改得了的字段的类型索引（`TextRuntimeField` 的值）。 */
export type TextRuntimeValue = TextFields[TextRuntimeField];
