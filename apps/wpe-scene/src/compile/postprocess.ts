/**
 * 场景后处理档位（设置「场景后处理」`wpeScenePostprocess`，PLAN D9）与场景实际的泛光 / HDR 状态。
 *
 * 规则来自对 WPE 2.8.42 的只读逆向（`.claude/plans/wpe-import/3-scene/p2-REPORT.md` G1–G4）：
 * - WPE 的用户设置 `config.json` → `<用户>.general.user.postprocessing` 只认 `disabled` / `ultra` / `displayhdr`，
 *   其它非空值当「开启」；缺键时配置加载先补成 `disabled`。`displayhdr` 按「超高」处理（我们输出到普通画布）；读不到也按 `disabled`。
 * - 场景的 bloom 位 = `general.bloom` 的生效值（缺键即开：场景构造默认标志 0x26），不看档位。这是运行时状态，渲染每帧读（A1，
 *   `SceneState.bloomEnabled`），属性与脚本改的都是它。泛光实际开启 = 档位不是关闭且 bloom 位开着。
 *   WPE 的 setter 对 bool 或带 bool `value` 的对象都改位，别的值不改位；绑定用户属性时取属性当前值。
 * - HDR 实际开启 = 档位为超高，且 `general.bloom` 的文件值、`general.hdr` 的生效值都是 true（缺键不算）。
 *   `bloom` 读场景文件（K3 实测，`FUN_14010d850`）：bool 原样，对象取 `value`，不读属性当前值，也不看脚本写入。所以判定和开关可以不一致：
 *   JSON 为 true、属性为 false 是关着泛光的 HDR 场景，反过来是开着泛光的 LDR 场景。
 *   `hdr` 有意不跟：WPE 连加载时都只读 JSON，属性不起作用（K3 静态确认），用户判定这是 WPE 的 bug。我们读属性当前值与脚本覆盖，改值重编译生效（3c 已定 12）。
 *   只在加载时判定：运行中关掉 HDR 场景的泛光，目标格式保持 HDR；运行中打开泛光的 LDR 场景得到 LDR 泛光。
 *   G3 曾推断写成属性对象不算，工坊 3286859278 的超高档抓帧（`bloom` 为 `{user, value: true}`）证伪了这一点（J5）。
 * - 泛光参数（`bloom*`）缺键取 WPE 场景构造函数的默认值（A2 / PLAN P2b），写成属性对象时取生效值。渲染见 `render/bloom.ts`。
 */
import type { BindingCollector, BindingTarget } from "./bindings";
import type { SceneReader } from "./fs";
import { numbers, resolveValue, type SceneScalar, type SceneValue } from "./model";

/** 设置的取值；默认 `follow`。 */
export type ScenePostprocessSetting = "follow" | "disabled" | "enabled" | "ultra";
/** 解析后的档位。 */
export type PostprocessLevel = "disabled" | "enabled" | "ultra";

export const SCENE_POSTPROCESS_SETTINGS: readonly ScenePostprocessSetting[] = [
  "follow",
  "disabled",
  "enabled",
  "ultra",
];

export interface ScenePostprocessState {
  level: PostprocessLevel;
  /** 场景的 bloom 位：`general.bloom` 的生效值，缺键或不是 bool 时为 true，不看档位。 */
  bloomFlag: boolean;
  /** 场景的 hdr 位：`general.hdr` 的生效值，缺键或不是 bool 时为 false，不看档位。脚本读 `thisScene.hdr` 拿到的是它（K5）。 */
  hdrFlag: boolean;
  bloom: boolean;
  hdr: boolean;
}

/**
 * 从 WPE `config.json` 文本里取 `general.user.<键>`：顶层是 Steam 用户名（`?` 开头的键是安装信息），取第一个「有该键且
 * `accept` 认」的用户的值；文本不是 JSON 或没有这样的用户返回 undefined。
 */
export function wpeUserValueOf(
  configText: string,
  name: string,
  accept: (value: unknown) => boolean = () => true,
): unknown {
  let config: unknown;
  try {
    config = JSON.parse(configText.replace(/^﻿/, ""));
  } catch {
    return undefined;
  }
  if (!config || typeof config !== "object") return undefined;
  for (const [key, user] of Object.entries(config)) {
    if (key.startsWith("?") || !user || typeof user !== "object") continue;
    const settings = (user as { general?: { user?: Record<string, unknown> } }).general?.user;
    if (!settings || typeof settings !== "object" || !Object.hasOwn(settings, name)) continue;
    if (accept(settings[name])) return settings[name];
  }
  return undefined;
}

/** 从 WPE `config.json` 文本里取 `postprocessing`（字符串）。 */
export function wpePostprocessingOf(configText: string): string | null {
  const value = wpeUserValueOf(configText, "postprocessing", (v) => typeof v === "string");
  return typeof value === "string" ? value : null;
}

/** 设置「场景反射」的取值；默认 `follow`。 */
export type SceneReflectionSetting = "follow" | "disabled" | "enabled";

export const SCENE_REFLECTION_SETTINGS: readonly SceneReflectionSetting[] = ["follow", "disabled", "enabled"];

/**
 * 反射开不开（rea-p13-passes 1.2）：WPE 的 `general.user.reflection` 是布尔，缺键补 true（`0x140047457`），
 * 读不到 `config.json` 也按 true，值不是布尔同样按 true。不认识的设置值按跟随处理。
 * `wpeValue` 是 `wpeUserValueOf(.., "reflection")` 的结果（读不到为 undefined / null）。
 */
export function resolveReflection(setting: string | null | undefined, wpeValue: unknown): boolean {
  if (setting === "disabled") return false;
  if (setting === "enabled") return true;
  return typeof wpeValue === "boolean" ? wpeValue : true;
}

/** WPE 自己的取值 → 档位（`FUN_14010df40`：`memcmp(v, "disabled", 8)`，再比 `ultra` / `displayhdr`）。 */
export function wpeLevelOf(value: string | null | undefined): PostprocessLevel {
  if (!value || value === "disabled") return "disabled";
  if (value === "ultra" || value === "displayhdr") return "ultra";
  return "enabled";
}

/** 设置 → 档位；跟随 WPE 时用 `wpeValue`（读不到为 null）。不认识的设置值按跟随处理。 */
export function resolvePostprocessLevel(
  setting: string | null | undefined,
  wpeValue: string | null | undefined,
): PostprocessLevel {
  if (setting === "disabled" || setting === "enabled" || setting === "ultra") return setting;
  return wpeLevelOf(wpeValue);
}

/**
 * 档位 + 场景 `general`（`properties` 为用户属性当前值）→ 场景实际的泛光 / HDR 状态。
 * `fileBloom` 是场景文件里的 `general.bloom`，HDR 判定读它；`general` 已套用脚本覆盖时调用方要另外传（`compileScene`）。
 */
export function scenePostprocessState(
  level: PostprocessLevel,
  general: Record<string, unknown> | undefined,
  properties: Record<string, SceneScalar> = {},
  bindings?: BindingCollector,
  fileBloom: unknown = general?.bloom,
): ScenePostprocessState {
  const bloomKey = flagValue(general?.bloom, properties, bindings, { kind: "bloom-enabled" });
  // hdr 与档位无关地求值：写成 `{user}` 时也要登记，档位改到超高时才用得上（P3a）
  const hdrKey = flagValue(general?.hdr, properties, bindings, {
    kind: "recompile",
    reason: "postprocess-hdr",
    path: "general.hdr",
  });
  const bloomFlag = bloomKey !== false;
  const hdrFlag = hdrKey === true;
  const bloom = level !== "disabled" && bloomFlag;
  // HDR 的判定缺键不算（G3）；`bloom` 只看场景文件（K3），`hdr` 读生效值（已定 12）
  const hdr = level === "ultra" && fileFlag(fileBloom) === true && hdrFlag;
  return { level, bloomFlag, hdrFlag, bloom, hdr };
}

/** 场景文件里一个开关的值（`FUN_14010d850`）：对象取 `value`，否则取本身，全程不碰属性；不是 bool 时返回 undefined。 */
function fileFlag(value: unknown): boolean | undefined {
  const raw = value && typeof value === "object" ? (value as { value?: unknown }).value : value;
  return typeof raw === "boolean" ? raw : undefined;
}

/**
 * `general.bloom` / `general.hdr` 的生效值（setter `FUN_14019b4e0` / `FUN_14019b6f0`）：bool 原样；对象先按自己的 `value`
 * 设位（是 bool 才用），带 `user` 时属性当前值（绑定解析结果）只在它是 bool 时才改位；属性值是数字（−0.22、0、0.5、1）、
 * 字符串（"1"）一律不改，退回对象的 `value`，加载与运行中相同。两处都不是 bool 时 WPE 不改位，返回 undefined（泛光保留默认开、
 * HDR 保留默认关）。带 `condition` 的绑定解析结果恒为 bool，不受影响。
 * 出处：WPE JSON 读取函数 `0x14019b4e0` 一族（JSON 布尔直接设位，对象先读 `value` 的布尔）；实测工程 `ignore/p5/pb/` E1–E6
 * （2026-11-14，P5a 补修）。
 * 带 `bindings` 时登记成 `target`：`bloom` 运行时就地改，`hdr` 决定目标格式，改值走整场重编译。
 * `GENERAL_FIELDS` 里的 bool 字段同样走这里（`compileScene`）。
 */
export function flagValue(
  value: unknown,
  properties: Record<string, SceneScalar>,
  bindings: BindingCollector | undefined,
  target: BindingTarget,
): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (!value || typeof value !== "object") return undefined;
  const own = (value as { value?: unknown }).value;
  if (!("user" in value)) return typeof own === "boolean" ? own : undefined;
  // bind 照旧调用（它登记绑定）；属性值非 bool 时退回对象自己的 value
  const resolved = bindings
    ? bindings.bind(value as SceneValue, properties, target)
    : resolveValue(value as SceneValue, properties);
  if (typeof resolved === "boolean") return resolved;
  return typeof own === "boolean" ? own : undefined;
}

/** 场景 `general` 里的泛光参数（已取生效值、缺键补默认值），原值，不做 HDR 换算（换算在 `render/bloom.ts`）。 */
export interface BloomParams {
  /** LDR：`bloomstrength` / `bloomthreshold`，原样写给 `downsample_quarter_bloom`。 */
  strength: number;
  threshold: number;
  /** `bloomtint`：LDR / HDR 的第一个下采样材质。 */
  tint: [number, number, number];
  /** HDR：`bloomhdrstrength` / `bloomhdrthreshold` / `bloomhdrfeather` / `bloomhdrscatter` / `bloomhdriterations`。 */
  hdrStrength: number;
  hdrThreshold: number;
  hdrFeather: number;
  hdrScatter: number;
  hdrIterations: number;
}

/** 缺键默认值：WPE 场景构造函数 `FUN_140186c90` 写死的值（A2，字节级核对）。 */
export const BLOOM_DEFAULTS: Readonly<BloomParams> = {
  strength: 2,
  threshold: 0.65,
  tint: [1, 1, 1],
  hdrStrength: 2,
  hdrThreshold: 1,
  hdrFeather: 0.1,
  hdrScatter: 1.619,
  hdrIterations: 8,
};

/** `general` 的泛光键 → `BloomParams` 字段，`{script}` 的写回目标（`scripts.ts`）与脚本 API（`script/api.ts`）共用。 */
export const BLOOM_FIELDS = {
  bloomstrength: "strength",
  bloomthreshold: "threshold",
  bloomtint: "tint",
  bloomhdrstrength: "hdrStrength",
  bloomhdrthreshold: "hdrThreshold",
  bloomhdrfeather: "hdrFeather",
  bloomhdrscatter: "hdrScatter",
  bloomhdriterations: "hdrIterations",
} as const satisfies Record<string, keyof BloomParams>;

/**
 * 读 `general` 的泛光参数：数字、`"r g b"` 字符串或属性对象（取生效值，同 `resolveValue`）都认；
 * 取不到合法数字的保留默认值。`bloomhdriterations` 是整数字段（场景 `+0x3d4`），截断小数。
 * 带 `bindings` 时每个参数登记成就地目标（渲染器改泛光链的常量，不重编译）。
 */
export function bloomParams(
  general: Record<string, unknown> | undefined,
  properties: Record<string, SceneScalar> = {},
  bindings?: BindingCollector,
): BloomParams {
  const read = (key: string, field: keyof BloomParams, fallback: number): number => {
    const source = general?.[key] as SceneValue | undefined;
    const raw = bindings
      ? bindings.bind(source, properties, { kind: "bloom", field })
      : resolveValue(source, properties);
    const value = numbers(raw)[0];
    return value !== undefined && Number.isFinite(value) ? value : fallback;
  };
  const tintSource = general?.bloomtint as SceneValue | undefined;
  const tint = numbers(
    bindings
      ? bindings.bind(tintSource, properties, { kind: "bloom", field: "tint" })
      : resolveValue(tintSource, properties),
  );
  return {
    strength: read("bloomstrength", "strength", BLOOM_DEFAULTS.strength),
    threshold: read("bloomthreshold", "threshold", BLOOM_DEFAULTS.threshold),
    tint:
      tint.length >= 3 && tint.slice(0, 3).every(Number.isFinite)
        ? [tint[0], tint[1], tint[2]]
        : [...BLOOM_DEFAULTS.tint],
    hdrStrength: read("bloomhdrstrength", "hdrStrength", BLOOM_DEFAULTS.hdrStrength),
    hdrThreshold: read("bloomhdrthreshold", "hdrThreshold", BLOOM_DEFAULTS.hdrThreshold),
    hdrFeather: read("bloomhdrfeather", "hdrFeather", BLOOM_DEFAULTS.hdrFeather),
    hdrScatter: read("bloomhdrscatter", "hdrScatter", BLOOM_DEFAULTS.hdrScatter),
    hdrIterations: Math.trunc(read("bloomhdriterations", "hdrIterations", BLOOM_DEFAULTS.hdrIterations)),
  };
}

/** `<WPE 安装目录>/assets` → `<WPE 安装目录>/config.json`。 */
export function wpeConfigPath(assetsDir: string): string {
  const trimmed = assetsDir.replace(/[\\/]+$/, "");
  const separator = /^[a-z]:/i.test(trimmed) || trimmed.includes("\\") ? "\\" : "/";
  const parent = trimmed.replace(/[\\/][^\\/]*$/, "");
  return `${parent}${separator}config.json`;
}

/**
 * 读 WPE 用户设置里的 `postprocessing`：依次查各个 `sceneAssets` 所在安装目录的 `config.json`（与 `ui_` 词条、assets
 * 同一套安装目录定位，Rust `wpe::discover::engine_dir`），第一个读到的为准；都读不到返回 null。只读。
 */
export async function readWpePostprocessing(
  reader: SceneReader,
  sceneAssets: readonly string[],
): Promise<string | null> {
  return readWpeUserValue(reader, sceneAssets, "postprocessing", (v) => typeof v === "string") as Promise<
    string | null
  >;
}

/** 读 WPE 用户设置里的 `reflection`（同上的查找方式）；读不到返回 undefined。只读。 */
export async function readWpeReflection(reader: SceneReader, sceneAssets: readonly string[]): Promise<unknown> {
  return (await readWpeUserValue(reader, sceneAssets, "reflection", () => true)) ?? undefined;
}

/** 依次查各安装目录的 `config.json`，第一个取到 `general.user.<键>` 的为准；postprocessing 取不到为 null。 */
async function readWpeUserValue(
  reader: SceneReader,
  sceneAssets: readonly string[],
  name: string,
  accept: (value: unknown) => boolean,
): Promise<unknown> {
  for (const assets of sceneAssets) {
    try {
      const value = wpeUserValueOf(
        new TextDecoder().decode(await reader.readWhole(wpeConfigPath(assets))),
        name,
        accept,
      );
      if (value !== undefined) return value;
    } catch {
      // 没有这个文件或读不到：查下一个安装目录
    }
  }
  return name === "postprocessing" ? null : undefined;
}
