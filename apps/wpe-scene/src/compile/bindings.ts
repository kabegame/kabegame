/**
 * 属性绑定表（P3a）：编译期每处解析 `{user}` 的地方登记一条「属性名（可带 condition）→ 目标」，
 * 宿主的应用函数按它把属性增量分成「就地写」与「重编译」两组
 * （`.claude/plans/wpe-import/3-scene/phase-3a-bindings.md` 点 1 / 点 5，依据 p3-script-REPORT I3）。
 *
 * 目标的键用 scene.json 的坐标（`objects/<i>`、`objects/<i>/effects/<j>/passes/<k>`、`general`），不用 bundle 下标：
 * 未启用的 effect 不进 bundle，下标会随属性值移位；3b 的脚本 realm 跨重编译保留，脚本手里的图层对象也要按这个键找回。
 *
 * **漏登记的后果是「改了没反应」**：既不就地写、也不重编译。新增读取用户属性的编译点时必须同时登记
 * （单测用 `Proxy` 记录编译期读过的属性名，断言都在绑定表里）。
 */
import { numbers, resolveValue, type SceneScalar, type SceneValue } from "./model";
import type { BloomParams } from "./postprocess";

/** 目标的稳定键：scene.json 里的坐标。 */
export type TargetKey = string;

/** 目标值的形状：决定字符串 / 数字 / 布尔怎么换成 uniform 分量（3b 的脚本取值、写回也按它换算）。 */
export type ValueType = "float" | "vec2" | "vec3" | "vec4" | "bool" | "angles";

export type LayerField = "origin" | "scale" | "angles" | "alpha" | "color" | "brightness" | "visible";

export type RecompileReason =
  | "effect-visible" // effect 可见性：未启用的不进 bundle（3c 改为单图层重算）
  | "postprocess" // general.bloom / general.hdr：泛光链有无、目标格式
  | "general" // clearcolor / ambientcolor / skylightcolor / camera.*
  | "layer-structure"; // colorBlendMode（passthrough 有无）、size（已定 5：重编译生效）

export type BindingTarget =
  | { kind: "script-property"; script: string; key: string }
  | { kind: "layer"; object: number; field: LayerField }
  | { kind: "constant"; pass: TargetKey; material: string; uniforms: string[]; type: ValueType }
  | { kind: "bloom"; field: keyof BloomParams }
  | { kind: "recompile"; reason: RecompileReason; path: string };

export interface SceneBinding {
  /** 用户属性名。 */
  property: string;
  /** `{user: {name, condition}}`：值换成 `String(当前值) === String(condition)`（I3）。 */
  condition?: string;
  target: BindingTarget;
}

/** 用户属性的形状（`host.ts` 的 `SceneProperty`）：全集只关心 `type` 与 `value`。 */
export interface UserProperty {
  type: string;
  value: unknown;
}

/** `value` 是不是 `{user: …}` 绑定（含 `{user: {name, condition}}`）。 */
export function isUserBinding(value: unknown): boolean {
  return userBindingOf(value as SceneValue | undefined) !== null;
}

/** `{user}` 里的属性名与条件；不是用户绑定返回 null。 */
function userBindingOf(value: SceneValue | undefined): { property: string; condition?: string } | null {
  if (!value || typeof value !== "object" || !("user" in value) || !value.user) return null;
  const user = value.user;
  if (typeof user === "string") return { property: user };
  if (typeof user !== "object") return null;
  const name = typeof user.name === "string" ? user.name : "";
  if (!name) return null;
  return user.condition === undefined ? { property: name } : { property: name, condition: String(user.condition) };
}

/**
 * 编译期登记：每处解析 `{user}` 的地方调一次，返回解析后的值（与 `resolveValue` 相同）。
 * 非用户绑定（常量、`{script}`）只返回解析值，不登记。
 */
export class BindingCollector {
  readonly list: SceneBinding[] = [];

  bind(
    value: SceneValue | undefined,
    properties: Record<string, SceneScalar>,
    target: BindingTarget,
  ): SceneScalar | undefined {
    const binding = userBindingOf(value);
    if (binding) this.list.push({ ...binding, target });
    return resolveValue(value, properties);
  }
}

/**
 * 属性值 → 目标分量（条件先换成布尔）；与编译期 `numbers(resolveValue(…))` 同一规则，单测核对两边一致。
 * 条件比较两边都转字符串：WPE 的 condition 写数字时也是按字符串比（I3）。
 */
export function bindingValue(
  raw: SceneScalar,
  condition: string | undefined,
  type: ValueType | LayerField,
): number[] | boolean {
  const value: SceneScalar = condition === undefined ? raw : String(raw) === condition;
  if (type === "bool" || type === "visible") return value !== false;
  return numbers(value);
}

/** 由 uniform 的 WGSL 类型（或 WPESL 声明类型）推出绑定目标的形状：材质常量绑定与 3b 的脚本写回共用。 */
export function valueTypeOf(uniform: { type?: string; declared?: string }): ValueType {
  const declared = (uniform.declared ?? "").trim();
  // 标量 / 向量数组按元素类型算（WPE 把材质常量按分量写）；矩阵没有对应的属性形状，退回 float
  const array = /^array<\s*([^,]+)\s*,/.exec((uniform.type ?? "").trim());
  const wgsl = (array ? array[1] : (uniform.type ?? "")).trim();
  const read = (text: string): ValueType | null => {
    const m = /^(?:[biu]?vec(\d)|(?:float|int|uint|bool)|f16)$/.exec(text);
    if (!m) return null;
    if (!m[1]) return /bool$/.test(text) ? "bool" : "float";
    const n = Number(m[1]);
    return n === 2 ? "vec2" : n === 3 ? "vec3" : n === 4 ? "vec4" : "float";
  };
  return read(declared) ?? read(wgsl.replace(/<[^>]*>/g, "")) ?? "float";
}

/**
 * 把一个属性增量并进累计全集（I1 的 `+0x1728`），返回真正变了的键 → 新值。
 * 跳过 `group` / `text` 与空值；不比较 `type`（类型变了值没变对绑定没有影响），也不因增量没给而丢掉已有键（I4）。
 */
export function mergeProperties(
  properties: Map<string, UserProperty>,
  delta: Record<string, UserProperty>,
): Map<string, SceneScalar> {
  const changes = new Map<string, SceneScalar>();
  for (const [key, property] of Object.entries(delta)) {
    if (!property || property.type === "group" || property.type === "text") continue;
    if (property.value === undefined || property.value === null) continue;
    const previous = properties.get(key);
    properties.set(key, { type: property.type, value: property.value });
    if (!previous || !Object.is(previous.value, property.value)) changes.set(key, property.value as SceneScalar);
  }
  return changes;
}

/**
 * 加载期间到达的增量：编译用的裸值快照（`compiledWith`）与当前全集的差异。场景换上后补一次应用（P3a 点 5）。
 */
export function pendingChanges(
  properties: ReadonlyMap<string, UserProperty>,
  compiledWith: Record<string, unknown>,
): Map<string, SceneScalar> {
  const pending = new Map<string, SceneScalar>();
  for (const [key, property] of properties)
    if (!Object.is(compiledWith[key], property.value)) pending.set(key, property.value as SceneScalar);
  return pending;
}

export interface RecompileEntry {
  /** 触发重编译的属性名。 */
  key: string;
  reason: RecompileReason;
  /** 目标在 scene.json 里的路径。 */
  path: string;
}

export interface ApplyPlan {
  /** 就地写：目标在当前 bundle 里，`SceneState.write` 处理。 */
  writes: { binding: SceneBinding; value: SceneScalar }[];
  /** 需要整场重编译的目标；非空时整场重编译（带全集）。 */
  recompile: RecompileEntry[];
}

/** 把一批变化键按绑定表分成就地写与重编译；没有任何绑定引用的属性（只给脚本用）两边都不进。 */
export function planApply(bindings: readonly SceneBinding[], changes: ReadonlyMap<string, SceneScalar>): ApplyPlan {
  const writes: ApplyPlan["writes"] = [];
  const recompile: RecompileEntry[] = [];
  const byProperty = new Map<string, SceneBinding[]>();
  for (const binding of bindings) {
    const list = byProperty.get(binding.property);
    if (list) list.push(binding);
    else byProperty.set(binding.property, [binding]);
  }
  for (const [property, value] of changes) {
    for (const binding of byProperty.get(property) ?? []) {
      if (binding.target.kind === "recompile")
        recompile.push({ key: property, reason: binding.target.reason, path: binding.target.path });
      else if (binding.target.kind !== "script-property") writes.push({ binding, value });
    }
  }
  return { writes, recompile };
}

/** 重编译原因的简短描述（宿主 debug 日志用）：按原因列出目标路径。 */
export function describeApply(plan: ApplyPlan): string {
  if (!plan.recompile.length) return `${plan.writes.length} 项就地写`;
  const byReason = new Map<string, string[]>();
  for (const item of plan.recompile) {
    const paths = byReason.get(item.reason);
    if (paths) paths.push(item.path);
    else byReason.set(item.reason, [item.path]);
  }
  return [...byReason].map(([reason, paths]) => `${reason}（${[...new Set(paths)].join("、")}）`).join("；");
}
