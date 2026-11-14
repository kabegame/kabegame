import { WPE_BUILTIN_PROPERTIES } from "./builtinProperties";

export type SceneScalar = string | number | boolean | null;
export type SceneValue =
  | SceneScalar
  | { user: string | { name: string; condition?: string }; value: SceneScalar }
  | { script: string; value: SceneScalar };
export type JsonObject = Record<string, unknown>;
export interface ProjectJson extends JsonObject {
  file: string;
  /** `supportsaudioprocessing`：音频开关，只认 JSON `true`（P4e 步骤 4，rea-p4e-audio.md 4.1）。 */
  general?: { properties?: Record<string, { value: SceneScalar }>; supportsaudioprocessing?: unknown };
}
export interface SceneJson extends JsonObject {
  camera?: JsonObject;
  general?: JsonObject;
  objects: SceneObject[];
}
export interface SceneObject extends JsonObject {
  id?: number;
  name?: string;
  image?: string;
  model?: string;
  particle?: string;
  origin?: SceneValue;
  scale?: SceneValue;
  angles?: SceneValue;
  size?: SceneValue;
  alpha?: SceneValue;
  color?: SceneValue;
  visible?: SceneValue;
  /** 视差深度（P5a 步骤 2），缺键 (1, 1)。 */
  parallaxDepth?: SceneValue;
  effects?: unknown[];
}
export interface ModelJson extends JsonObject {
  material?: string;
  width?: number;
  height?: number;
  autosize?: unknown;
  puppet?: unknown;
  solidlayer?: unknown;
  instanced?: unknown;
}
export interface MaterialPass extends JsonObject {
  shader?: string;
  blending?: string;
  cullmode?: string;
  depthtest?: string;
  depthwrite?: string;
  textures?: unknown[];
  combos?: Record<string, number | boolean>;
  constantshadervalues?: Record<string, SceneValue>;
  usershadervalues?: Record<string, string>;
}
export interface MaterialJson extends JsonObject {
  passes: MaterialPass[];
}
/** effect.json 的 `fbos[]`。 */
export interface EffectFboJson extends JsonObject {
  name?: string;
  format?: string;
  scale?: number;
  width?: number;
  height?: number;
  fit?: number;
  unique?: boolean;
  clear?: string;
  uvs?: string;
}
/** effect.json 的 `passes[]`：有 `material` 是绘制 pass，有 `command` 是 `copy` / `swap`。 */
export interface EffectPassJson extends JsonObject {
  material?: string;
  command?: string;
  source?: string;
  target?: string;
  compose?: boolean;
  /** `conditions` 不满足的整条不绑（`conditions.ts`）。 */
  bind?: { name?: string; index?: number; conditions?: unknown }[];
}
export interface EffectJson extends JsonObject {
  passes?: EffectPassJson[];
  fbos?: EffectFboJson[];
}
/** scene.json 里图层 `effects[]` 的一项；`passes` 按顺序覆盖 effect.json 里各绘制 pass 的材质。 */
export interface SceneEffectInstance extends JsonObject {
  file?: string;
  id?: number;
  name?: string;
  visible?: SceneValue;
  passes?: {
    combos?: Record<string, number | boolean>;
    constantshadervalues?: Record<string, SceneValue>;
    textures?: unknown[];
    /** 用户纹理（P11b）：按槽合并进材质 pass 的同名键（`mergeUserTextures`）。 */
    usertextures?: unknown[];
    usershadervalues?: Record<string, string>;
  }[];
}

// 字符串（第一组）原样保留，其余匹配到的注释删掉
const JSON_COMMENT = /("(?:\\[\s\S]|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g;
// 字符串（第一组）原样保留，`]` / `}` 前的逗号删掉
const JSON_TRAILING_COMMA = /("(?:\\[\s\S]|[^"\\])*")|,(\s*[\]}])/g;

/**
 * WPE 的 JSON 读取比 `JSON.parse` 宽松（jsoncpp，缺省允许注释）：
 * - 注释：`//` 行注释已实测（fantasticcar 的 `materials/car/glass.json` 带注释行，WPE 照常加载，P5a 步骤 0）；
 *   `/*` 开头的块注释是 jsoncpp 同一个开关，推断，语料 0 处。
 * - 尾逗号：工坊 3286859278 自带的 `effects/fluidsimulation/effect.json` 在 `]` 前有尾逗号，WPE 照常加载。
 * 严格解析失败时先去注释、再去对象 / 数组结尾的逗号（字符串内的都不动）再试一次，仍失败就抛原错误。
 */
export function parseWpeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    const relaxed = text
      .replace(JSON_COMMENT, (_match, string: string | undefined) => string ?? "")
      .replace(
        JSON_TRAILING_COMMA,
        (_match, string: string | undefined, end: string | undefined) => string ?? end ?? "",
      );
    if (relaxed === text) throw error;
    try {
      return JSON.parse(relaxed);
    } catch {
      throw error;
    }
  }
}

export function parseProject(text: string): ProjectJson {
  return parseWpeJson(text) as ProjectJson;
}
export function parseScene(text: string): SceneJson {
  const scene = parseWpeJson(text) as SceneJson;
  scene.objects ??= [];
  return scene;
}
export function parseModel(text: string): ModelJson {
  return parseWpeJson(text) as ModelJson;
}
export function parseMaterial(text: string): MaterialJson {
  const material = parseWpeJson(text) as MaterialJson;
  material.passes ??= [];
  return material;
}
export function parseEffect(text: string): EffectJson {
  const effect = parseWpeJson(text) as EffectJson;
  effect.passes ??= [];
  effect.fbos ??= [];
  return effect;
}

/** 材质 `textures[]` 的一项：字符串、`{ name }` 或 null（null = 由运行时填）。 */
export function textureName(raw: unknown): string | null {
  if (typeof raw === "string") return raw || null;
  if (raw && typeof raw === "object" && "name" in raw && typeof raw.name === "string") return raw.name || null;
  return null;
}

/**
 * 编译期属性表读取的观察者：单测（`p3a.test.ts` 的完整性检查）用它记下编译期读过的属性名，
 * 断言每个都登记进了绑定表；生产恒为 null。
 */
let propertyReadObserver: ((name: string) => void) | null = null;

export function observePropertyReads(observer: ((name: string) => void) | null): void {
  propertyReadObserver = observer;
}

export function currentProperties(
  project: ProjectJson,
  overrides: Record<string, unknown>,
): Record<string, SceneScalar> {
  const result: Record<string, SceneScalar> = {};
  // WPE 注入的 14 个内置属性打底（P3a 修复）：工程声明的同名属性、再是用户值（宿主的全集已带内置项与按样式取的 `alignment`）依次覆盖
  for (const [name, prop] of Object.entries(WPE_BUILTIN_PROPERTIES)) result[name] = prop.value;
  for (const [name, prop] of Object.entries(project.general?.properties ?? {})) result[name] = prop.value;
  for (const [name, value] of Object.entries(overrides))
    result[name] = (
      value && typeof value === "object" && "value" in value ? (value as { value: SceneScalar }).value : value
    ) as SceneScalar;
  // 每次返回一份可观察的视图：漏登记（读了属性却没进绑定表）的后果是「改了没反应」，
  // 完整性单测靠这里发现（P3a 点 1 / 验收 2）
  return new Proxy(result, {
    get(target, key, receiver) {
      if (typeof key === "string" && propertyReadObserver) propertyReadObserver(key);
      return Reflect.get(target, key, receiver);
    },
  });
}

/**
 * `value` 是不是属性关键帧动画 `{animation: {c0…, options}, value}`（`sample-gaps.md` §3）：`animation` 必须是对象，
 * puppet 的 `animationlayers[i].animation` 是整数 id，不算。同时挂了 `user` / `script` 也算：三种绑定在 WPE 里并存
 * （§3.4，`FUN_1401a4db0`；一帧里谁最后写见 rea-p10-keyframes 第 9 节）。`scene.json` 里的由 `collectAnimations` 编成动画（P10a），
 * 材质、模型、effect.json、粒子 JSON 里的能力表照报 `value:animation`（WPE 的这些 JSON 不经属性框架）。
 */
export function isKeyframedValue(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const animation = (value as { animation?: unknown }).animation;
  return !!animation && typeof animation === "object" && !Array.isArray(animation);
}

export function resolveValue(
  value: SceneValue | undefined,
  properties: Record<string, SceneScalar>,
): SceneScalar | undefined {
  if (value && typeof value === "object") {
    // 脚本求值前的编译期初值；运行时写回会覆盖它。
    if ("script" in value) return value.value;
    // 关键帧动画（P10a）：WPE 加载时把 `value` 写进字段，第一帧起由动画每帧覆盖（rea-p10-keyframes 第 4 节）；动画不写
    // （通道数不对、布尔等类型，第 5、10 节）时字段一直是它。同时绑了用户属性的走下面：属性在加载后套用（第 5 节第 3 条）
    if (!("user" in value) || !value.user)
      return isKeyframedValue(value) ? (value as { value?: SceneScalar }).value : undefined;
    const name = typeof value.user === "string" ? value.user : value.user.name;
    // 经 `properties[name]` 读（编译期是 `currentProperties` 的 Proxy，完整性检查的读取观察要记到这次读）
    const current = properties[name];
    // 属性不存在（`project.json` 没声明、也不是 WPE 的内置项）时 WPE 一律保持 `value`、不比 condition：可见性、数值字段、脚本属性都实测过
    // （phase-3a「补测：绑定的属性不存在时」）。绑定照样由 `BindingCollector.bind` 登记
    if (current === undefined || current === null) return value.value;
    // condition 按字符串比（WPE 的值换字符串再与 condition 比；condition 写成数字时同样成立），见 `bindings.ts`
    const condition = userCondition(value.user);
    if (condition !== undefined) return String(current) === condition;
    return current;
  }
  return value;
}

/**
 * `{user}` 的 condition：没写、或写成空串时都算没有条件（WPE 把空串当成没写，phase-3a「补测」的 `p3am-empty` W2 / W3），
 * 其余换成字符串。编译期取值、绑定登记（`bindings.ts` 的 `userBindingOf`、脚本属性）都经这里，运行时拿到的绑定已是规整过的。
 */
export function userCondition(user: unknown): string | undefined {
  if (!user || typeof user !== "object") return undefined;
  const condition = (user as { condition?: unknown }).condition;
  return condition === undefined || condition === "" ? undefined : String(condition);
}

/**
 * 布尔字段（图层与 effect 的 `visible`）照 WPE 的 bool setter：解析值不是布尔（数字、字符串属性）时写不进，保持 JSON 的 `value`；
 * `value` 也不是布尔时按缺省显示。带条件的绑定解析出来本就是布尔。依据 phase-3a「补测」的 `p3am-empty` W5 与 `p3am-num`。
 */
export function boolFieldValue(value: SceneValue | undefined, resolved: SceneScalar | undefined): boolean {
  if (typeof resolved === "boolean") return resolved;
  const own = value && typeof value === "object" ? (value as { value?: unknown }).value : value;
  return own !== false;
}

/**
 * 只保留数值 / 布尔的 COMBO：WPE 的 COMBO 只按整数读，写成 `{user, value}` 会断言中止（I3）；
 * 这类绑定由能力表报 `combo:user-binding`、整张退回，绝不把对象交给翻译器。
 */
export function staticCombos<T extends Record<string, number | boolean>>(
  combos: T | undefined,
): Record<string, number | boolean> {
  const out: Record<string, number | boolean> = {};
  for (const [name, value] of Object.entries(combos ?? {}))
    if (typeof value === "number" || typeof value === "boolean") out[name] = value;
  return out;
}

export function numbers(value: SceneScalar | undefined, fallback: number[] = []): number[] {
  if (typeof value === "number") return [value];
  if (typeof value === "boolean") return [value ? 1 : 0];
  if (typeof value === "string") {
    const parsed = value.trim().split(/\s+/).map(Number);
    if (parsed.length && parsed.every(Number.isFinite)) return parsed;
  }
  return fallback;
}
