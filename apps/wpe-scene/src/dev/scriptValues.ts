/**
 * dev 探针的脚本值（kabegame-chromium 第 6 批）：探针回放为了确定性不跑场景脚本，字段脚本挂的字段一直是编译期的初值。调用方知道某段
 * 字段脚本在读回那一帧会返回什么时（例如 kbp 测试工程的 FR 帧号块，颜色只取决于帧号），把值交给 `renderFrame` 的 `scriptValues`，
 * 这里找到 bundle 里挂在这个对象这个字段上的字段脚本，用它的绑定目标写进 `SceneState`。写法同宿主的脚本写回（`host.ts` 的
 * `writeScript`：`state.write({ property: "", target }, scriptWriteValue(value))`）。探针不知道 FR 是什么，只认对象与字段。
 *
 * 只认图层字段（`target.kind === "layer"`）。对象按 `objects` 下标或名字找（名字在 `bundle.layers` 里找，重名抛错）；找不到对象、或这个
 * 字段没有挂字段脚本时，`optional` 的跳过（结果里 `applied: false` 并写明原因），否则抛错。
 */
import type { BindingTarget, LayerField } from "../compile/bindings";
import type { SceneBundle } from "../compile/bundle";
import type { SceneState } from "../render/state";
import { scriptWriteValue } from "../render/state";

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

export interface ScriptValue {
  /** `objects` 下标，或对象名（在 `bundle.layers` 里找，重名抛错）。 */
  object: number | string;
  field: LayerField;
  /** 脚本这一帧返回的值：1–4 个数（同宿主脚本写回铺满后的分量），或布尔。 */
  value: number[] | boolean;
  /** 找不到对象、或这个字段没挂字段脚本时跳过（结果里记 `applied: false`），不抛错。 */
  optional?: boolean;
}

export interface ScriptValueResult {
  /** 解析出的 `objects` 下标；按名字没找到时为 null。 */
  object: number | null;
  /** 解析出的对象名；按下标没找到时为 null。 */
  name: string | null;
  field: LayerField;
  value: number[] | boolean;
  /** 写进了状态；`optional` 跳过时为 false，`reason` 写明原因。 */
  applied: boolean;
  reason?: string;
}

type LayerTarget = Extract<BindingTarget, { kind: "layer" }>;

export interface ResolvedScriptValue {
  result: ScriptValueResult;
  /** 字段脚本的绑定目标；跳过时为 null。 */
  target: LayerTarget | null;
}

const shown = (value: unknown) => JSON.stringify(value) ?? String(value);

/** 值的形状：1–4 个有限数或布尔（同 vite 的校验；探针被直接调用时再查一次）。 */
function checkValue(item: ScriptValue, index: number): void {
  const { value } = item;
  const ok =
    typeof value === "boolean" ||
    (Array.isArray(value) &&
      value.length >= 1 &&
      value.length <= 4 &&
      value.every((x) => typeof x === "number" && Number.isFinite(x)));
  if (!ok) throw new Error(`scriptValues[${index}].value 要是 1–4 个有限数或布尔，收到 ${shown(value)}`);
  if (!SCRIPT_VALUE_FIELDS.includes(item.field)) {
    throw new Error(
      `scriptValues[${index}].field 要是图层字段（${SCRIPT_VALUE_FIELDS.join(" / ")}），收到 ${shown(item.field)}`,
    );
  }
  const object = item.object;
  const objectOk =
    (typeof object === "number" && Number.isInteger(object) && object >= 0) ||
    (typeof object === "string" && object.length > 0);
  if (!objectOk) throw new Error(`scriptValues[${index}].object 要是 objects 下标或对象名，收到 ${shown(object)}`);
}

/**
 * 解析每一项的绑定目标（纯函数，不写状态）。对象：下标在 `bundle.layers` 里按 `object` 找，名字按 `name` 找（重名抛错，不论
 * `optional`：那是有歧义，不是缺）；字段脚本：`bundle.scripts.list` 里 `target.kind === "layer"`、同 `object`、同 `field` 的那一段。
 */
export function resolveScriptValues(
  bundle: Pick<SceneBundle, "layers" | "scripts">,
  values: readonly ScriptValue[],
): ResolvedScriptValue[] {
  return values.map((item, index) => {
    checkValue(item, index);
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
    let target: LayerTarget | null = null;
    if (object !== null) {
      const script = bundle.scripts.list.find(
        (s) => s.target.kind === "layer" && s.target.object === object && s.target.field === item.field,
      );
      if (script) target = script.target as LayerTarget;
      else reason = `objects[${object}]（${name}）的 ${item.field} 没有挂字段脚本`;
    }
    if (!target && !item.optional) throw new Error(`scriptValues[${index}]：${reason}`);
    return {
      result: {
        object,
        name,
        field: item.field,
        value: item.value,
        applied: !!target,
        ...(target ? {} : { reason }),
      },
      target,
    };
  });
}

/**
 * 解析并写进状态：每一项经字段脚本的绑定目标 `state.write({ property: "", target }, scriptWriteValue(value))`，同宿主脚本写回。
 * 先全部解析再写：有一项要抛错时状态不动。返回每一项的结果（没给时空数组）。
 */
export function applyScriptValues(
  state: Pick<SceneState, "write">,
  bundle: Pick<SceneBundle, "layers" | "scripts">,
  values: readonly ScriptValue[] | undefined,
): ScriptValueResult[] {
  if (!values?.length) return [];
  const resolved = resolveScriptValues(bundle, values);
  for (const { result, target } of resolved) {
    if (target) state.write({ property: "", target }, scriptWriteValue(result.value));
  }
  return resolved.map(({ result }) => result);
}
