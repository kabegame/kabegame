/**
 * dev 探针的脚本值（kabegame-chromium 第 6 批）：探针回放为了确定性不跑场景脚本，字段脚本挂的字段一直是编译期的初值。调用方知道某段
 * 字段脚本在读回那一帧会返回什么时（例如 kbp 测试工程的 FR 帧号块，颜色只取决于帧号），把值交给 `renderFrame` 的 `scriptValues`，
 * 这里找到 bundle 里挂在这个对象这个字段上的字段脚本，用它的绑定目标写进 `SceneState`。写法同宿主的脚本写回（`host.ts` 的
 * `writeScript`）。探针不知道 FR 是什么，只认对象与字段。
 *
 * 两种字段：
 * - 图层字段（`target.kind === "layer"`，`SCRIPT_VALUE_FIELDS`）：值是 1–4 个数或布尔，`state.write({ property: "", target },
 *   scriptWriteValue(value))`；
 * - 文本层的运行中字段（P6b 1e-3，`target.kind === "text"`，`TEXT_RUNTIME_FIELDS`）：值还可以是字符串（时钟画的「12:34」、
 *   `p6b-script` 的「F183」），按宿主同一条写回规整（`textFieldFromScript(字段, scriptWriteValue(值))`，`text` 收数时 ToString、
 *   `pointsize` 收数），再 `state.writeText`。写进去只是标脏，重排在 `sync` 里；缺字体时要等读完，由 `renderFrame` 回放前结清
 *   （`probeTexts.ts` 的 `settle`）。按宿主规则不会写的值（`pointsize` 给了不是数的串、布尔位给了数）直接抛错，不静默跳过。
 *
 * 对象按 `objects` 下标或名字找（名字在 `bundle.layers` 里找，重名抛错；文本层也在 `bundle.layers` 里）；找不到对象、或这个字段没有挂
 * 字段脚本时，`optional` 的跳过（结果里 `applied: false` 并写明原因），否则抛错。
 */
import {
  isTextRuntimeField,
  TEXT_RUNTIME_FIELDS,
  type BindingTarget,
  type LayerField,
  type TextRuntimeField,
} from "../compile/bindings";
import type { SceneBundle } from "../compile/bundle";
import type { SceneState } from "../render/state";
import { scriptWriteValue } from "../render/state";
import { textFieldFromScript, type TextRuntimeValue } from "../text/fields";

export const SCRIPT_VALUE_FIELDS: readonly LayerField[] = [
  "origin",
  "scale",
  "angles",
  "alpha",
  "color",
  "brightness",
  "visible",
  "parallaxDepth",
];

/**
 * 文本字段的字符串值最长这么多个 UTF-16 单元（P6b 1e-3）：探针按给定的文字渲染一帧和 WPE 比，时钟、计数一类不过十几个字；上限只为挡住
 * 误传的大串（64 项都取满也只有 256 K 个单元，远小于 vite 请求体的 8 MB）。vite 的校验（`scripts/kabegame-dev/replay.ts` 的
 * `MAX_SCRIPT_TEXT`）是抄本，改了两边一起改。
 */
export const MAX_SCRIPT_TEXT = 4096;

/** 脚本值能写的字段：图层字段，或文本层的运行中字段（P6b 1e-3）。 */
export type ScriptValueField = LayerField | TextRuntimeField;

export interface ScriptValue {
  /** `objects` 下标，或对象名（在 `bundle.layers` 里找，重名抛错）。 */
  object: number | string;
  /** 图层字段，或文本层的运行中字段（P6b 1e-3，`TEXT_RUNTIME_FIELDS`）。 */
  field: ScriptValueField;
  /**
   * 脚本这一帧返回的值。图层字段：1–4 个数（同宿主脚本写回铺满后的分量），或布尔。文本字段：字段脚本这一帧的返回值——字符串（最长
   * `MAX_SCRIPT_TEXT` 个 UTF-16 单元）、1–4 个有限数或布尔，按宿主同一规则规整（`textFieldFromScript`，如 `pointsize` 收数，`text`
   * 收数时 ToString）。
   */
  value: number[] | boolean | string;
  /** 找不到对象、或这个字段没挂字段脚本时跳过（结果里记 `applied: false`），不抛错。 */
  optional?: boolean;
}

export interface ScriptValueResult {
  /** 解析出的 `objects` 下标；按名字没找到时为 null。 */
  object: number | null;
  /** 解析出的对象名；按下标没找到时为 null。 */
  name: string | null;
  field: ScriptValueField;
  value: number[] | boolean | string;
  /** 写进了状态；`optional` 跳过时为 false，`reason` 写明原因。 */
  applied: boolean;
  reason?: string;
}

type LayerTarget = Extract<BindingTarget, { kind: "layer" }>;
type TextTarget = Extract<BindingTarget, { kind: "text" }>;

export type ResolvedScriptValue =
  | { result: ScriptValueResult; target: LayerTarget }
  /** 文本目标（P6b 1e-3）：`text` 是按宿主脚本写回规整好的字段值，`applyScriptValues` 原样交给 `writeText`。 */
  | { result: ScriptValueResult; target: TextTarget; text: TextRuntimeValue }
  /** 跳过（`optional`）时没有目标。 */
  | { result: ScriptValueResult; target: null };

const shown = (value: unknown) => JSON.stringify(value) ?? String(value);

/** 文本层的运行中字段（P6b 1e-3）：`field` 可能是调用方传来的任意值，先确认是字符串。 */
const isTextField = (field: unknown): field is TextRuntimeField =>
  typeof field === "string" && isTextRuntimeField(field);

/**
 * 字段与值的形状（同 vite 的校验；探针被直接调用时再查一次）。先认字段：字符串只给文本字段。文本字段另按宿主的脚本写回规整一次，
 * 规整不出值（宿主不会写）时抛错。返回文本字段规整后的值（图层字段为 undefined）。
 */
function checkValue(item: ScriptValue, index: number): TextRuntimeValue | undefined {
  const at = `scriptValues[${index}]`;
  const text = isTextField(item.field);
  if (!text && !SCRIPT_VALUE_FIELDS.includes(item.field as LayerField)) {
    throw new Error(
      `${at}.field 要是图层字段（${SCRIPT_VALUE_FIELDS.join(" / ")}）或文本字段（${TEXT_RUNTIME_FIELDS.join(" / ")}），` +
        `收到 ${shown(item.field)}`,
    );
  }
  const { value } = item;
  const shaped =
    typeof value === "boolean" ||
    (Array.isArray(value) &&
      value.length >= 1 &&
      value.length <= 4 &&
      value.every((x) => typeof x === "number" && Number.isFinite(x)));
  if (text) {
    if (typeof value === "string") {
      if (value.length > MAX_SCRIPT_TEXT) {
        throw new Error(`${at}.value 长 ${value.length} 个 UTF-16 单元，最长 ${MAX_SCRIPT_TEXT}`);
      }
    } else if (!shaped) {
      throw new Error(
        `${at}.value 要是字符串（最长 ${MAX_SCRIPT_TEXT} 个 UTF-16 单元）、1–4 个有限数或布尔，收到 ${shown(value)}`,
      );
    }
  } else if (!shaped) {
    const hint = typeof value === "string" ? `（${item.field} 是图层字段，字符串只给文本字段）` : "";
    throw new Error(`${at}.value 要是 1–4 个有限数或布尔${hint}，收到 ${shown(value)}`);
  }
  const object = item.object;
  const objectOk =
    (typeof object === "number" && Number.isInteger(object) && object >= 0) ||
    (typeof object === "string" && object.length > 0);
  if (!objectOk) throw new Error(`${at}.object 要是 objects 下标或对象名，收到 ${shown(object)}`);
  if (!text) return undefined;
  // 同宿主 `writeScript` 的文本分支：先 `scriptWriteValue`（多分量拼成空格分隔、单分量传数），再按脚本侧规则规整
  const field = item.field as TextRuntimeField;
  const normalized = textFieldFromScript(field, scriptWriteValue(value));
  if (normalized === undefined) {
    throw new Error(
      `${at}.value 按宿主的脚本写回规则不会写进 ${field}（字段脚本这样返回时宿主保持原值），收到 ${shown(value)}`,
    );
  }
  return normalized;
}

/**
 * 解析每一项的绑定目标（纯函数，不写状态）。对象：下标在 `bundle.layers` 里按 `object` 找，名字按 `name` 找（重名抛错，不论
 * `optional`：那是有歧义，不是缺）；字段脚本：`bundle.scripts.list` 里同 `object`、同 `field` 的那一段，图层字段要
 * `target.kind === "layer"`，文本字段要 `target.kind === "text"`（P6b 1e-3）。
 */
export function resolveScriptValues(
  bundle: Pick<SceneBundle, "layers" | "scripts">,
  values: readonly ScriptValue[],
): ResolvedScriptValue[] {
  return values.map((item, index): ResolvedScriptValue => {
    const text = checkValue(item, index);
    const kind = text === undefined ? "layer" : "text";
    let object: number | null = null;
    let name: string | null = null;
    let reason: string | undefined;
    if (typeof item.object === "number") {
      const layer = bundle.layers.find((l) => l.object === item.object);
      if (layer) {
        object = layer.object;
        name = layer.name;
      } else reason = `objects[${item.object}] 不在 bundle 的图层里（下标越界或对象被跳过）`;
    } else {
      const matches = bundle.layers.filter((l) => l.name === item.object);
      if (matches.length > 1) {
        throw new Error(
          `scriptValues[${index}]：叫 ${shown(item.object)} 的图层有 ${matches.length} 个（objects[${matches.map((l) => l.object).join("]、objects[")}]），按名字认不出是哪个，改用 objects 下标`,
        );
      }
      if (matches.length === 1) {
        object = matches[0].object;
        name = matches[0].name;
      } else reason = `没有叫 ${shown(item.object)} 的图层`;
    }
    let target: LayerTarget | TextTarget | null = null;
    if (object !== null) {
      const script = bundle.scripts.list.find(
        (s) => s.target.kind === kind && s.target.object === object && s.target.field === item.field,
      );
      if (script) target = script.target as LayerTarget | TextTarget;
      else reason = `objects[${object}]（${name}）的 ${item.field} 没有挂字段脚本`;
    }
    if (!target && !item.optional) throw new Error(`scriptValues[${index}]：${reason}`);
    const result: ScriptValueResult = {
      object,
      name,
      field: item.field,
      value: item.value,
      applied: !!target,
      ...(target ? {} : { reason }),
    };
    if (!target) return { result, target: null };
    if (target.kind === "text") return { result, target, text: text! };
    return { result, target };
  });
}

/**
 * 解析并写进状态，同宿主脚本写回（`host.ts` 的 `writeScript`）：图层目标 `state.write({ property: "", target },
 * scriptWriteValue(value))`；文本目标（P6b 1e-3）`state.writeText(对象, 字段, 规整后的值)`，不走 `write` 的属性侧规则（`text` 收数时
 * 属性侧不写、脚本侧 ToString）。先全部解析再写：有一项要抛错时状态不动。返回每一项的结果（没给时空数组）。
 */
export function applyScriptValues(
  state: Pick<SceneState, "write" | "writeText">,
  bundle: Pick<SceneBundle, "layers" | "scripts">,
  values: readonly ScriptValue[] | undefined,
): ScriptValueResult[] {
  if (!values?.length) return [];
  const resolved = resolveScriptValues(bundle, values);
  for (const item of resolved) {
    if ("text" in item) state.writeText(item.target.object, item.target.field, item.text);
    else if (item.target) state.write({ property: "", target: item.target }, scriptWriteValue(item.result.value));
  }
  return resolved.map(({ result }) => result);
}

/**
 * 有没有文本字段的值写进了状态（P6b 1e-3）：`renderFrame` 据此决定回放前要不要结清重排。只有跳过的、或全是图层字段时为 false，
 * 这时不多调 `sync`，逐字节同以前。
 */
export function wroteTextValues(results: readonly ScriptValueResult[]): boolean {
  return results.some((result) => result.applied && isTextField(result.field));
}
