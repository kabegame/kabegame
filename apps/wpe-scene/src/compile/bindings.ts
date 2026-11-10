/**
 * 属性绑定表（P3a）：编译期每处解析 `{user}` 的地方登记一条「属性名（可带 condition）→ 目标」，
 * 宿主的应用函数按它把属性增量分成「就地写」与「重编译」两组
 * （`.claude/plans/wpe-import/3-scene/phase-3a-bindings.md` 点 1 / 点 5，依据 p3-script-REPORT I3）。
 *
 * 目标的键用 scene.json 的坐标（`objects/<i>`、`objects/<i>/effects/<j>/passes/<k>`、`general`），不用 bundle 下标：
 * 写死关闭的 effect 不进 bundle，下标与 JSON 坐标不一致；3b 的脚本 realm 跨重编译保留，脚本手里的图层对象也要按这个键找回。
 *
 * **漏登记的后果是「改了没反应」**：既不就地写、也不重编译。新增读取用户属性的编译点时必须同时登记
 * （单测用 `Proxy` 记录编译期读过的属性名，断言都在绑定表里）。
 */
import { numbers, resolveValue, type SceneScalar, type SceneValue } from "./model";
import type { MaterialMember } from "./materialValues";
import type { InstanceKey } from "./particles";
import type { BloomParams } from "./postprocess";

/** 目标的稳定键：scene.json 里的坐标。 */
export type TargetKey = string;

/** 目标值的形状：决定字符串 / 数字 / 布尔怎么换成 uniform 分量（3b 的脚本取值、写回也按它换算）。 */
export type ValueType = "float" | "vec2" | "vec3" | "vec4" | "bool" | "angles";

/** 图层的就地字段。`parallaxDepth`（P5a 步骤 2）只改字段、没有回调（p3-script-REPORT I3），视差每次绘制都重读。 */
export type LayerField = "origin" | "scale" | "angles" | "alpha" | "color" | "brightness" | "visible" | "parallaxDepth";

export type RecompileReason =
  | "postprocess-hdr" // general.hdr：目标格式（已定：保留重编译，WPE 运行中改不生效）
  // colorBlendMode（passthrough 有无）、size（已定 5：重编译生效）、灯对象字段（`lights.ts` 的编译期常量）、
  // HDR 下生效的粒子 `instanceoverride.brightness`（没实现，改成非默认值时重编译后由能力表报不支持）
  | "layer-structure";

type GeneralField =
  | { type: "vec3"; fallback: readonly [number, number, number] }
  | { type: "float"; fallback: number }
  | { type: "bool"; fallback: boolean };

/**
 * WPE 里只改字段的 general 属性（L1），不重编译。`fov` 起的项正交场景不读，只存值，脚本能读回（已定 13）；`cameraparallax*` 例外，
 * 渲染器每帧读（P5a 步骤 2，`render/parallax.ts`），属性与脚本写入就地生效；`camerashake*` 同样每帧读（P5a 步骤 3，`render/shake.ts`），
 * 在帧开头、脚本之前读，脚本写入下一帧生效。`zoom` 同样（P5a 步骤 4，`render/layout.ts` 的 `sceneViewProjection`）：只改字段
 * （p3-script-REPORT I3），正交投影每帧读，和抖动一起在帧开头、脚本之前取（L4），脚本写入下一帧生效；透视场景不读（rea-p5-camera.md 1.4）。
 * `fallback` 是缺键时的值（L1 的构造默认值、L14 的实测）。
 */
export const GENERAL_FIELDS = {
  clearcolor: { type: "vec3", fallback: [0, 0, 0] },
  clearenabled: { type: "bool", fallback: true },
  ambientcolor: { type: "vec3", fallback: [0, 0, 0] },
  skylightcolor: { type: "vec3", fallback: [0, 0, 0] },
  fov: { type: "float", fallback: 50 },
  nearz: { type: "float", fallback: 0.1 },
  farz: { type: "float", fallback: 10000 },
  camerafade: { type: "bool", fallback: true },
  camerashake: { type: "bool", fallback: false },
  camerashakespeed: { type: "float", fallback: 3 },
  camerashakeamplitude: { type: "float", fallback: 0.5 },
  camerashakeroughness: { type: "float", fallback: 1 },
  cameraparallax: { type: "bool", fallback: false },
  cameraparallaxamount: { type: "float", fallback: 0.5 },
  cameraparallaxdelay: { type: "float", fallback: 0.1 },
  cameraparallaxmouseinfluence: { type: "float", fallback: 0.5 },
  zoom: { type: "float", fallback: 1 },
} as const satisfies Record<string, GeneralField>;

export type GeneralKey = keyof typeof GENERAL_FIELDS;

/** `GENERAL_FIELDS` 的一份取值：vec3 是三个分量。 */
export type GeneralValues = {
  [K in GeneralKey]: (typeof GENERAL_FIELDS)[K]["type"] extends "vec3"
    ? number[]
    : (typeof GENERAL_FIELDS)[K]["type"] extends "float"
      ? number
      : boolean;
};

/** 全部字段的缺省值：每次一份新的，vec3 不共用数组。 */
export function generalDefaults(): GeneralValues {
  const entries = Object.entries(GENERAL_FIELDS).map(([key, { fallback }]) => [
    key,
    typeof fallback === "object" ? [...fallback] : fallback,
  ]);
  return Object.fromEntries(entries) as GeneralValues;
}

/**
 * 一个字段的取值规则，编译与就地写共用，这是「就地 = 重编译」的保证。
 * 单个数字铺满三个分量（`FUN_1401a4230`）；bool setter 只认 bool（G4）。不合法时返回 undefined：WPE 不改字段。
 */
export function generalValue(key: GeneralKey, value: SceneScalar | undefined): number[] | number | boolean | undefined {
  const { type } = GENERAL_FIELDS[key];
  if (type === "bool") return typeof value === "boolean" ? value : undefined;
  // `numbers` 把布尔换成 0 / 1，这里不算数字
  if (typeof value === "boolean") return undefined;
  const parts = numbers(value);
  if (!parts.length || !parts.every(Number.isFinite)) return undefined;
  if (type === "float") return parts.length === 1 ? parts[0] : undefined;
  if (parts.length === 1) return [parts[0], parts[0], parts[0]];
  return parts.length >= 3 ? parts.slice(0, 3) : undefined;
}

export type BindingTarget =
  | { kind: "script-property"; script: string; key: string }
  | { kind: "layer"; object: number; field: LayerField }
  /** effect 可见性：`effect` 是 `effects[]` 的 JSON 下标（`SceneEffect.source`），开关后只重建该图层（3c）。 */
  | { kind: "effect"; object: number; effect: number }
  /**
   * 材质常量：`uniforms` 是同一个键的整组名字，`members` 是各格的取值方式（`materialValues.ts`），就地写按它整体重写；
   * 手写的目标没有 `members` 时每格按 `type` 取满。
   */
  | {
      kind: "constant";
      pass: TargetKey;
      material: string;
      uniforms: string[];
      type: ValueType;
      members?: MaterialMember[];
    }
  | { kind: "bloom"; field: keyof BloomParams }
  /** `general.bloom`：每帧读（A1），写的是场景位。 */
  | { kind: "bloom-enabled" }
  /** `GENERAL_FIELDS` 的字段：只改 `SceneState.general`，不重编译。 */
  | { kind: "general"; key: GeneralKey }
  /**
   * 粒子对象 `instanceoverride` 的标量键与 `colorn`（P4a 步骤 5，`rea-p4a.md` C5；P4b 步骤 6）：就地写，`GpuScene.sync` 交给
   * 模拟器从基值重新乘、重算颜色平移，存活粒子保留出生时的颜色（`colorchange` 每帧读字段，存活粒子下一帧就跟着变）。
   * `object` 是 `objects` 下标。
   */
  | { kind: "particle-instance"; object: number; field: InstanceKey }
  /**
   * 声音对象的 `volume`（P6a 步骤 1，rea-p6a-sound.md 5.2）：WPE 改值经回调 `V` 立即生效、没有渐变。就地写进
   * `SceneState.sounds`，不标脏，宿主的排期器每帧读（`audio/scheduler.ts`）。`object` 是 `objects` 下标。
   */
  | { kind: "sound"; object: number; field: "volume" }
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

/** `value` 是不是挂了脚本：判断与 `collectScripts` 相同（`script` 是字符串）。 */
export function isScriptValue(value: unknown): boolean {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as { script?: unknown }).script === "string"
  );
}

/**
 * `value` 是不是属性关键帧动画 `{animation: {c0…, options}, value}`（`sample-gaps.md` §3）：`animation` 必须是对象，
 * puppet 的 `animationlayers[i].animation` 是整数 id，不算。同时挂了 `user` / `script` 也算：三种绑定在 WPE 里并存
 * （§3.4，`FUN_1401a4db0`），每帧谁生效没查清。关键帧还没实现，`resolveValue` 把它解析成 `undefined`、属性静默退回缺省值，
 * 所以能力表一律报 `value:animation`。
 */
export function isKeyframedValue(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const animation = (value as { animation?: unknown }).animation;
  return !!animation && typeof animation === "object" && !Array.isArray(animation);
}

/** `{user}` 里的属性名与条件；不是用户绑定返回 null。 */
export function userBindingOf(value: SceneValue | undefined): { property: string; condition?: string } | null {
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
