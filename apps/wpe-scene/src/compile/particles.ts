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
 * `instanceoverride` 的静态值（`rea-p4a.md` C5，基址 `obj+0x778`）。`{user}` / `{script}` 只取 JSON 里的 `value`，
 * 不读用户属性、不登记绑定：绑定与就地更新是步骤 5 的事，现在由 `object:instanceoverride` 整张退回。
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
  /** 系统 `flags`（整数）：bit2 透视覆盖、bit3–7 禁用对应的 `instanceoverride`（C3）；bit0、bit1 与更高位由能力表报。 */
  flags: number;
  /** `animationmode`：只有 `"randomframe"` 是 1，其余（含缺键、null、`"sequence"`）都是 0。帧表属 P4b。 */
  animationMode: "sequence" | "randomframe";
  /** 缺省 1。帧表属 P4b。 */
  sequenceMultiplier: number;
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
function instanceNumber(raw: unknown, fallback: number): number {
  const value = staticValue(raw);
  if (isNumeric(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}
function instanceVector(raw: unknown, scale = 1): number[] | null {
  const value = staticValue(raw);
  if (typeof value !== "string") return null;
  const parts = value.trim().split(/\s+/).filter(Boolean).map(Number);
  if (parts.length < 3 || !parts.slice(0, 3).every(Number.isFinite)) return null;
  return parts.slice(0, 3).map((part) => part * scale);
}

export function parseParticleInstance(raw: unknown): ParticleInstance {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return {
    alpha: instanceNumber(source.alpha, 1),
    size: instanceNumber(source.size, 1),
    count: instanceNumber(source.count, 1),
    speed: instanceNumber(source.speed, 1),
    lifetime: instanceNumber(source.lifetime, 1),
    rate: instanceNumber(source.rate, 1),
    brightness: instanceNumber(source.brightness, 1),
    colorn: instanceVector(source.color, 1 / 255) ?? instanceVector(source.colorn),
    controlpoints: Array.from({ length: 8 }, (_, i) => instanceVector(source[`controlpoint${i}`])),
    controlpointAngles: Array.from({ length: 8 }, (_, i) => instanceVector(source[`controlpointangle${i}`])),
  };
}

export interface ParseParticleOptions {
  file: string;
  orthographic: boolean;
  /** 对象上的 `instanceoverride`。 */
  instanceoverride?: unknown;
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
    emitters: modules("emitter"),
    initializers: modules("initializer"),
    operators: modules("operator"),
    renderers: modules("renderer"),
    orthographic: options.orthographic,
    instance: parseParticleInstance(options.instanceoverride),
    passes: [],
  };
}
