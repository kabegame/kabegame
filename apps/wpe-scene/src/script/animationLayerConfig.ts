/**
 * `createAnimationLayer` / `playSingleAnimation` 的参数整理（P12e，rea-p12e 第 1、2 节与末尾「实测」）：纯函数，写法同 `createConfig.ts`。
 * 流程照 WPE：dll 方法桩先按形参类型 `0x600` 转实参（`stubText`），exe 再解析 JSON、补 `blendin` / `blendout`、按名字或 id 找动画，
 * 最后经「建层函数」的 JSON setter（float 只收 JSON 数、bool 只收 JSON 布尔、`name` 只收 JSON 字符串）得到字段。
 * 依赖宿主的只有 realm 的 `JSON`（对象参数要在脚本自己的 realm 里 `stringify`，`toJSON` 等行为才和 WPE 的 V8 一致）。
 */

import { boolField, floatField } from "../compile/puppet";
import type { SceneScalar } from "../compile/model";
import type { AnimationLayerItem } from "../puppet/player";

/** realm 的 `JSON`（`stringify` 可能抛错或返回 `undefined`）。 */
export interface RealmJson {
  stringify(value: unknown): string | undefined;
  parse(text: string): unknown;
}

/** dll 方法桩形参 `0x600`（字符串 | 对象）转出来的文本，`kind` 记它是怎么来的。 */
export interface StubText {
  text: string;
  kind: "string" | "object" | "empty";
}

/** 按 C 串在第一个 NUL 处截断（exe 拿到的是 UTF-8 `char*`）。 */
function cString(text: string): string {
  const end = text.indexOf("\0");
  return end < 0 ? text : text.slice(0, end);
}

/**
 * dll 方法桩形参 0x600 的转换（rea-p12e 第 1 节）：字符串原样（C 串在第一个 NUL 处截断）；对象（含数组）经 realm 的 `JSON.stringify`，
 * 得到 `undefined` 或抛错（循环引用、BigInt）为空串；其余（数字、布尔、`null`、`undefined`、缺参数）为空串。
 */
export function stubText(value: unknown, json: RealmJson): StubText {
  if (typeof value === "string") return { text: cString(value), kind: "string" };
  if (typeof value === "object" && value !== null) {
    let text: string | undefined;
    try {
      text = json.stringify(value);
    } catch {
      return { text: "", kind: "empty" };
    }
    return typeof text === "string" ? { text: cString(text), kind: "object" } : { text: "", kind: "empty" };
  }
  return { text: "", kind: "empty" };
}

type Json = Record<string, unknown>;

const isPlain = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

/** 解析 JSON 文本；失败（含空串）是 `{ ok: false }`（jsoncpp 解析失败时值保持 null）。 */
function parse(text: string, json: RealmJson): { ok: true; value: unknown } | { ok: false } {
  if (text === "") return { ok: false };
  try {
    return { ok: true, value: json.parse(text) };
  } catch {
    return { ok: false };
  }
}

/** JSON setter 的取值：值是对象（`{user / script, value}`）时取它的 `value`；对象里带绑定键时返回需要提示的键名。 */
function settable(raw: unknown, bindings: Set<string>): SceneScalar | undefined {
  if (isPlain(raw)) {
    for (const key of ["user", "script", "animation"]) if (key in raw) bindings.add(key);
    return raw.value as SceneScalar | undefined;
  }
  return raw as SceneScalar | undefined;
}

/**
 * createAnimationLayer / playSingleAnimation 的参数规整（rea-p12e 第 2 节，实测 2、3）。`item` 为 null 时 JS 得到 null；`warn` 是要记的一条日志。
 * 1. 第一参转换后为空串 → null；
 * 2. config：字符串按 JSON 文本解析、对象 stringify 后解析；空串、解析失败或解析成 `null` → `{}`；解析成非对象（数、串、数组：WPE 未定义行为，语料 0）
 *    → null + warn（有意不同）；
 * 3. 缺 `blendin` 键补 true、缺 `blendout` 键补 true（只看键在不在，值是 false / null 也不补）；
 * 4. 字符串第一参：在 `animations`（MDLA 顺序）里找第一个同名（区分大小写），找不到或它的 id 为 0 → null；`animation` 取它的 id（覆盖 config 里的），
 *    之后按 id 再找第一条（同建层函数，两条动画 id 相同时可能不是按名字找到的那条）；
 * 5. 对象第一参：解析成非对象 → null；config 的键覆盖第一参的同名键；`animation` 不是 JSON 数、为负、≥ 2⁶⁴ → null，否则向零取整按 id 找第一条，找不到 → null；
 * 6. 找到的动画带 `unsupported` → null + warn（没被引用的动画用了不支持的特性）；
 * 7. 字段按 JSON setter：float（rate / blend / blendtime）只收 JSON 数（转 f32），bool（visible / additive / blendin / blendout）只收 JSON 布尔，
 *    name 只收 JSON 字符串；值是对象时取它的 `value` 按同样规则（带 `user` / `script` / `animation` 键时不登记绑定，warn）；
 *    缺省 rate 1、blend 1、visible true、additive false、blendin false、blendout false、blendtime 0.5、name ""；
 * 8. autosort（JSON 布尔 true）/ index（JSON 数，向零取整）照 `AnimationLayerItem` 的注释取；`id` 键忽略（WPE 只影响它的对象 id 计数器，已知差异）。
 */
export function animationLayerItem(
  first: unknown,
  config: unknown,
  animations: readonly { id: number; name: string; unsupported?: string[] }[],
  json: RealmJson,
): { item: AnimationLayerItem | null; warn?: string } {
  const head = stubText(first, json);
  if (head.text === "") return { item: null };

  // config：不看实参类型，只看转出来的文本（数字、布尔、缺参数都是空串，同缺省）
  let cfg: Json = {};
  const cfgText = stubText(config, json).text;
  const parsedConfig = parse(cfgText, json);
  if (parsedConfig.ok && parsedConfig.value !== null) {
    if (!isPlain(parsedConfig.value))
      return {
        item: null,
        warn: "createAnimationLayer：config 解析成非对象（数、字符串、数组），WPE 行为未定义，已按失败处理",
      };
    cfg = { ...parsedConfig.value };
  }
  if (!("blendin" in cfg)) cfg.blendin = true;
  if (!("blendout" in cfg)) cfg.blendout = true;

  // 合并成建层函数看到的那一项 JSON
  let raw: Json;
  if (head.kind === "string") {
    const named = animations.find((animation) => animation.name === head.text);
    if (!named || named.id === 0) return { item: null };
    raw = { ...cfg, animation: named.id };
  } else {
    const parsed = parse(head.text, json);
    if (!parsed.ok || !isPlain(parsed.value)) return { item: null };
    raw = { ...parsed.value, ...cfg };
  }

  // 建层函数：`animation` 必须是 JSON 数，取整后按 id 找第一条
  const id = raw.animation;
  if (typeof id !== "number" || !Number.isFinite(id) || id < 0 || id >= 2 ** 64) return { item: null };
  const wanted = Math.trunc(id);
  const index = animations.findIndex((animation) => animation.id === wanted);
  if (index < 0) return { item: null };
  const target = animations[index];
  if (target.unsupported?.length)
    return {
      item: null,
      warn: `createAnimationLayer：动画「${target.name}」用到不支持的特性（${target.unsupported.join("、")}），不建层`,
    };

  const bindings = new Set<string>();
  const name = settable(raw.name, bindings);
  const item: AnimationLayerItem = {
    animation: index,
    name: typeof name === "string" ? name : "",
    rate: floatField(settable(raw.rate, bindings), 1),
    blend: floatField(settable(raw.blend, bindings), 1),
    visible: boolField(settable(raw.visible, bindings), true),
    additive: boolField(settable(raw.additive, bindings), false),
    blendin: boolField(settable(raw.blendin, bindings), false),
    blendout: boolField(settable(raw.blendout, bindings), false),
    blendtime: floatField(settable(raw.blendtime, bindings), 0.5),
    autosort: raw.autosort === true,
    index: typeof raw.index === "number" && Number.isFinite(raw.index) ? Math.trunc(raw.index) : null,
  };
  return bindings.size
    ? { item, warn: `createAnimationLayer：config 里的 ${[...bindings].join(" / ")} 键不登记绑定，只取 value` }
    : { item };
}
