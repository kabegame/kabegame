/**
 * 场景后处理档位（设置「场景后处理」`wpeScenePostprocess`，PLAN D9）与场景实际的泛光 / HDR 状态。
 *
 * 规则来自对 WPE 2.8.42 的只读逆向（`.claude/plans/wpe-import/3-scene/p2-REPORT.md` G1–G4）：
 * - WPE 的用户设置 `config.json` → `<用户>.general.user.postprocessing` 只认 `disabled` / `ultra` / `displayhdr`，
 *   其它非空值当「开启」；缺键时配置加载先补成 `disabled`。`displayhdr` 按「超高」处理（我们输出到普通画布）；读不到也按 `disabled`。
 * - 泛光实际开启 = 档位不是关闭，且 `general.bloom` 的生效值不是 false（缺键即开：场景构造默认标志 0x26）。
 *   WPE 的 setter 对 bool 或带 bool `value` 的对象都改位；绑定用户属性时取属性当前值（运行时随属性变是推断）。
 * - HDR 实际开启 = 档位为超高，且 `general.bloom`、`general.hdr` 都显式是 bool `true`（缺键或写成属性对象都不算）。
 *
 * P2a 只实现两者都关的情况；实际开启时编译期记 `postprocess:bloom` / `postprocess:hdr`（P2b 去掉）。
 */
import type { SceneReader } from "./fs";
import { resolveValue, type SceneScalar, type SceneValue } from "./model";

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
  bloom: boolean;
  hdr: boolean;
}

/** 从 WPE `config.json` 文本里取 `postprocessing`：顶层是 Steam 用户名（`?` 开头的键是安装信息），取第一个有该键的用户。 */
export function wpePostprocessingOf(configText: string): string | null {
  let config: unknown;
  try {
    config = JSON.parse(configText.replace(/^﻿/, ""));
  } catch {
    return null;
  }
  if (!config || typeof config !== "object") return null;
  for (const [key, user] of Object.entries(config)) {
    if (key.startsWith("?") || !user || typeof user !== "object") continue;
    const value = (user as { general?: { user?: { postprocessing?: unknown } } }).general?.user?.postprocessing;
    if (typeof value === "string") return value;
  }
  return null;
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

/** 档位 + 场景 `general`（`properties` 为用户属性当前值）→ 场景实际的泛光 / HDR 状态。 */
export function scenePostprocessState(
  level: PostprocessLevel,
  general: Record<string, unknown> | undefined,
  properties: Record<string, SceneScalar> = {},
): ScenePostprocessState {
  const bloomKey = general?.bloom;
  const bloom = level !== "disabled" && bloomFlag(bloomKey, properties) !== false;
  const hdr = level === "ultra" && bloomKey === true && general?.hdr === true;
  return { level, bloom, hdr };
}

/**
 * `general.bloom` 的生效值（setter `FUN_14019b4e0`）：bool 原样；带 `user` 的对象取属性当前值，否则取对象的 `value`；
 * 结果不是 bool 时 WPE 不改位，返回 undefined（保留默认开）。
 */
function bloomFlag(value: unknown, properties: Record<string, SceneScalar>): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (!value || typeof value !== "object") return undefined;
  const resolved =
    "user" in value ? resolveValue(value as SceneValue, properties) : (value as { value?: unknown }).value;
  return typeof resolved === "boolean" ? resolved : undefined;
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
 * 同一套安装目录定位，Rust `wpe::discover::engine_dirs`），第一个读到的为准；都读不到返回 null。只读。
 */
export async function readWpePostprocessing(
  reader: SceneReader,
  sceneAssets: readonly string[],
): Promise<string | null> {
  for (const assets of sceneAssets) {
    try {
      const value = wpePostprocessingOf(new TextDecoder().decode(await reader.readWhole(wpeConfigPath(assets))));
      if (value !== null) return value;
    } catch {
      // 没有这个文件或读不到：查下一个安装目录
    }
  }
  return null;
}
