/**
 * 粒子 JSON → 纯数据（P4a 步骤 2）。不碰 GPU：bundle 里只放解析后的值，模拟在 `src/particles/`（步骤 3），绘制在渲染层（步骤 4）。
 *
 * 模块的字段、缺省值都从模块表（`particles/modules.ts`）读，这里只管系统级的键、`instanceoverride` 与 renderer 的补全。
 * 能力检查在 `features.ts` 的 `checkParticleFeatures`，与这里读同一张表。
 *
 * 依据：`.claude/plans/wpe-import/3-scene/phase4/rea-p4a.md`（「基础」、B、C1 / C3 / C5），顶层键的读取顺序与缺省值按
 * `ignore/p4/rea/parser.asm`（`FUN_1401c5490`，`0x1401c5543` 起）核对：数值键用 `isNumeric`（`0x140088880`：int / uint / real，
 * null 为假）取值，否则取缺省；`animationmode` 用 `isString`（`0x140088890`）后与 `"randomframe"` 比。
 */
import type { ScenePass } from "./bundle";
import type { JsonObject, SceneScalar } from "./model";
import { readParticleModule, type ParticleCategory, type ParticleModule } from "../particles/modules";

/**
 * `instanceoverride` 里就地更新的标量键（P4a 步骤 5，`rea-p4a.md` C5）：编译期每处 `{user}` 登记成 `particle-instance`
 * 绑定，运行时改值由 `ParticleSystem.setInstance` 从基值重新乘。`brightness` 只在场景 HDR 且系统 `flags` 没有 bit3 时生效，
 * 这时它改走重编译（`bundle.ts`），取非默认值由能力表报。
 */
export const INSTANCE_FIELDS = ["alpha", "size", "count", "speed", "lifetime", "rate", "brightness"] as const;
export type InstanceField = (typeof INSTANCE_FIELDS)[number];
/** `instanceoverride` 的标量部分（`SceneState` 存的就是这一份）。 */
export type ParticleInstanceValues = Record<InstanceField, number>;

/**
 * 一个标量键的取值，编译与就地写共用（「就地 = 重编译」靠它）：数字原样；非空字符串整串解析成有限数；布尔按 1 / 0
 * （条件绑定 `{user: {name, condition}}` 的值是布尔，同图层字段的 `asNumber`）；其余（含解析不出来）取缺省 1。
 */
export function instanceScalar(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 1;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 1;
}

/**
 * `instanceoverride` 的值（`rea-p4a.md` C5，基址 `obj+0x778`）。标量键经 `InstanceResolver` 取值（编译期登记绑定、读用户属性，
 * `bundle.ts`）；`colorn`、控制点只取静态值，用到时能力表报不支持（`checkParticleInstance`）。
 * `rate` 的下限 0.01 只在脏时钳（C5），这里存原值。
 */
export interface ParticleInstance {
  /** 新粒子的 `a0`。 */
  alpha: number;
  /** 乘 `sizerandom`、`sizechange` 的 min / max。 */
  size: number;
  /** 乘各 emitter 的 `rate`、`maxtoemitperperiod`，不改 `maxcount`。 */
  count: number;
  /** 乘发射速度、`velocityrandom`、`movement.gravity`、`angularmovement.force`、`angularvelocityrandom`、`oscillateposition` 频率等。 */
  speed: number;
  /** 乘 `lifetimerandom` 的 min / max。 */
  lifetime: number;
  /** 整个模拟的时间缩放：`dt' = dt·rate`。 */
  rate: number;
  /** 仅 HDR 且系统 `flags` 没有 bit3 时乘实例颜色。 */
  brightness: number;
  /** 未设为 null（WPE 的 −1 −1 −1）。`color`（0–255）加载时 ÷255 转成它（C5；两者都写时取 `color` 是推断）。 */
  colorn: number[] | null;
  /** `controlpoint0..7`；未设为 null（WPE 的 FLT_MAX）。属 P4c。 */
  controlpoints: (number[] | null)[];
  /** `controlpointangle0..7`；未设为 null。属 P4c。 */
  controlpointAngles: (number[] | null)[];
}

export interface SceneParticle {
  /** 粒子 JSON 的路径（对象的 `particle`）。 */
  file: string;
  /** 容量；缺省 0（不分配）。不受 `instanceoverride.count` 影响（C2）。 */
  maxcount: number;
  /** 预热时长（秒）：加载时一次跑完，步长按 `maxcount` 取 0.05 或 0.2（C1，实测核对过）。 */
  starttime: number;
  /**
   * 系统 `flags`（整数）：bit1 关混帧（`SPRITESHEETBLEND = 0`，唯一的读取点，rea-p4b-render.md 2.3），bit2 透视覆盖、
   * bit3–7 禁用对应的 `instanceoverride`（C3）；bit0 与更高位由能力表报。
   */
  flags: number;
  /**
   * `animationmode`：只有 `"randomframe"` 是 1，其余（含缺键、null、`"sequence"`）都是 0。`randomframe` 时出生写 `R`、
   * 之后不更新，混帧关（rea-p4b-render.md 2.5）；只在帧表系统（`spriteSheet`）里有作用。
   */
  animationMode: "sequence" | "randomframe";
  /** 缺省 1。帧表系统的 `sequence` 模式下 frame = age / life · 它（可以大于 1，着色器取小数）。 */
  sequenceMultiplier: number;
  /**
   * 粒子材质槽 0 的纹理带帧表（WPE 的系统标志 `0x1000000`，rea-p4b-render.md 2.3）：编完材质后由 `compileScene` 填，
   * `parseParticle` 给 false。模拟器据此每帧算 frame（`ParticleSystem.sequenceFrames`），顶点写 `a_TexCoordVec4C1`。
   */
  spriteSheet: boolean;
  /** JSON 顺序，不排序（O2，实测）。 */
  emitters: ParticleModule[];
  initializers: ParticleModule[];
  operators: ParticleModule[];
  /**
   * JSON 顺序。`renderer` 缺键或不是数组时补一个 `sprite`（`0x1401c58a2` 用 `isArray` 判断，`0x1401c58af` 补）；
   * 写成 `[]` 时 WPE 不补，系统不画（语料里都是只靠子系统出图的发射器）。
   */
  renderers: ParticleModule[];
  /** 缺省值按正交还是透视那一套选（`isOrthographic`）。 */
  orthographic: boolean;
  instance: ParticleInstance;
  /**
   * 粒子材质的 pass（稳定键 `objects/<i>/particle/passes/<n>`）。步骤 4 才画：不放进 `layer.passes`，图像层的渲染图、
   * `buildableLayers`、`checkRenderable` 都按 `passes` 判断。
   */
  passes: ScenePass[];
}

/** 粒子 JSON 的顶层键（`FUN_1401c5490` 读的全部键）；其余报 `particle:system:<键>`。 */
export const PARTICLE_SYSTEM_KEYS: ReadonlySet<string> = new Set([
  "material",
  "starttime",
  "animationmode",
  "sequencemultiplier",
  "flags",
  "maxcount",
  "emitter",
  "initializer",
  "operator",
  "renderer",
  "controlpoint",
  "children",
]);

/**
 * 场景是否正交（`rea-p4a.md`「基础」【确】）：`general.orthogonalprojection` 是对象，且 `auto: true` 或 `width`、`height`
 * 都非 0。粒子字段的缺省值按它选两套之一。
 */
export function isOrthographic(general: Record<string, unknown> | undefined): boolean {
  const projection = general?.orthogonalprojection;
  if (!projection || typeof projection !== "object" || Array.isArray(projection)) return false;
  const { auto, width, height } = projection as { auto?: unknown; width?: unknown; height?: unknown };
  return auto === true || (!!Number(width) && !!Number(height));
}

/** `perspectiveoverridefov`（度）→ 透视粒子的 fov（弧度）：缺省 95，钳到 [0.1, 179.9] 度（C4【确】，实测核对过 `d`）。 */
export function particleFov(value: SceneScalar | undefined): number {
  const degrees = typeof value === "number" || typeof value === "string" ? Number(value) : Number.NaN;
  const clamped = Math.min(179.9, Math.max(0.1, Number.isFinite(degrees) ? degrees : 95));
  return (clamped * Math.PI) / 180;
}

const isNumeric = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

export interface ParticleSystemValues {
  maxcount: number;
  starttime: number;
  flags: number;
  animationMode: "sequence" | "randomframe";
  sequenceMultiplier: number;
}

/** 系统级的标量键（解析与能力表共用）。 */
export function readParticleSystem(json: JsonObject): ParticleSystemValues {
  return {
    maxcount: isNumeric(json.maxcount) ? Math.max(0, Math.trunc(json.maxcount)) : 0,
    starttime: isNumeric(json.starttime) ? json.starttime : 0,
    flags: isNumeric(json.flags) ? Math.trunc(json.flags) : 0,
    animationMode: json.animationmode === "randomframe" ? "randomframe" : "sequence",
    sequenceMultiplier: isNumeric(json.sequencemultiplier) ? json.sequencemultiplier : 1,
  };
}

/**
 * 一个类别的模块项。`emitter` / `initializer` / `operator` 缺键或 null 时为空，不是数组时返回 null（能力表报
 * `particle:system:<键>`）。`renderer` 不是数组时补一个 `sprite`，见 `SceneParticle.renderers`。
 */
export function particleModuleEntries(json: JsonObject, category: ParticleCategory): unknown[] | null {
  const raw = json[category];
  if (Array.isArray(raw)) return raw;
  if (category === "renderer") return [{ name: "sprite" }];
  return raw === undefined || raw === null ? [] : null;
}

/** 绑定只取 JSON 里的静态 `value`，不读用户属性。 */
function staticValue(raw: unknown): unknown {
  return raw && typeof raw === "object" && !Array.isArray(raw) && "value" in raw
    ? (raw as { value: unknown }).value
    : raw;
}
/** `"r g b"` 的前三个分量（乘 `scale`）；不是字符串、不足三个或有不是数字的分量时为 null。 */
export function instanceVector(raw: unknown, scale = 1): number[] | null {
  const value = staticValue(raw);
  if (typeof value !== "string") return null;
  const parts = value.trim().split(/\s+/).filter(Boolean).map(Number);
  if (parts.length < 3 || !parts.slice(0, 3).every(Number.isFinite)) return null;
  return parts.slice(0, 3).map((part) => part * scale);
}

/**
 * 标量键的取值方式：参数是键名与 JSON 里的原值（可能是 `{user}` / `{script}`），返回解析后的值。缺省只取静态 `value`、
 * 不读用户属性；`bundle.ts` 传 `BindingCollector.bind`，同时登记绑定。
 */
export type InstanceResolver = (field: InstanceField, raw: unknown) => SceneScalar | undefined;
const staticResolver: InstanceResolver = (_, raw) => staticValue(raw) as SceneScalar | undefined;

export function parseParticleInstance(raw: unknown, resolve: InstanceResolver = staticResolver): ParticleInstance {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const scalars = Object.fromEntries(
    INSTANCE_FIELDS.map((field) => [field, instanceScalar(resolve(field, source[field]))]),
  ) as ParticleInstanceValues;
  return {
    ...scalars,
    colorn: instanceVector(source.color, 1 / 255) ?? instanceVector(source.colorn),
    controlpoints: Array.from({ length: 8 }, (_, i) => instanceVector(source[`controlpoint${i}`])),
    controlpointAngles: Array.from({ length: 8 }, (_, i) => instanceVector(source[`controlpointangle${i}`])),
  };
}

/** `ParticleInstance` 的标量部分（一份新对象）。 */
export function instanceValues(instance: ParticleInstanceValues): ParticleInstanceValues {
  return Object.fromEntries(INSTANCE_FIELDS.map((field) => [field, instance[field]])) as ParticleInstanceValues;
}

export interface ParseParticleOptions {
  file: string;
  orthographic: boolean;
  /** 对象上的 `instanceoverride`。 */
  instanceoverride?: unknown;
  /** 标量键的取值方式；缺省只取静态值（见 `InstanceResolver`）。 */
  resolveInstance?: InstanceResolver;
}

/** 解析一个粒子 JSON（能力检查另由 `checkParticleFeatures` 做）。`passes` 由 `compileScene` 编材质后填。 */
export function parseParticle(json: JsonObject, options: ParseParticleOptions): SceneParticle {
  const modules = (category: ParticleCategory): ParticleModule[] =>
    (particleModuleEntries(json, category) ?? []).map((entry) => {
      const { name, id, fields } = readParticleModule(category, entry, options.orthographic);
      return { name, id, fields };
    });
  return {
    file: options.file,
    ...readParticleSystem(json),
    spriteSheet: false,
    emitters: modules("emitter"),
    initializers: modules("initializer"),
    operators: modules("operator"),
    renderers: modules("renderer"),
    orthographic: options.orthographic,
    instance: parseParticleInstance(options.instanceoverride, options.resolveInstance),
    passes: [],
  };
}
