/**
 * WPE 设置字段组（`WpeSettingsFields.vue`）的规则：字段表、Kabegame 默认值、按壁纸类型选字段、「跟随 WPE」的取舍。
 *
 * 同一组字段有两个数据源：
 * - 桌面的「壁纸设置」：全局设置键（`WPE_SETTING_GLOBAL_KEYS`），所有壁纸共用，设置页显示全部字段；
 * - 预览的「预览设置」：每张壁纸一份，存在 metadata 的 `previewSettings`（后端 `kabegame_core::wpe::preview_settings`，
 *   字段与默认值的唯一实现在那里，这里是镜像，改一处要同步另一处），没设的项取 `WPE_SETTING_DEFAULTS`。
 *   预览的暂停不在其中：它是预览弹窗里的内存状态。
 *
 * 「跟随 WPE」只在能读到 WPE `config.json` 的环境里提供（`get_wpe_follow_available`，只有 Windows 可能为真）；
 * 不能跟随时选项里没有这一档，存着的 `follow` 按 Kabegame 默认值显示，交给场景宿主前也换成默认值。
 */
import type { AppSettingKey } from "@/stores/settings";
import { isWpeSceneType, isWpeVideoType, isWpeWebType } from "./mediaMime";

export type WpeSettingKey =
  "paused" | "volume" | "playbackRate" | "mediaIntegration" | "postprocess" | "reflection" | "shadows";

export interface WpeSettingValues {
  paused: boolean;
  volume: number;
  playbackRate: number;
  mediaIntegration: boolean;
  postprocess: string;
  reflection: string;
  shadows: string;
}

/** 字段的显示顺序 */
export const WPE_SETTING_KEYS: readonly WpeSettingKey[] = [
  "paused",
  "volume",
  "playbackRate",
  "mediaIntegration",
  "postprocess",
  "reflection",
  "shadows",
];

/** Kabegame 自己的默认值（与 WPE 出厂值一致）：预览设置没设的项、不能跟随时的 `follow` 都取它 */
export const WPE_SETTING_DEFAULTS: Readonly<WpeSettingValues> = {
  paused: false,
  volume: 1,
  playbackRate: 1,
  mediaIntegration: true,
  postprocess: "enabled",
  reflection: "enabled",
  shadows: "medium",
};

/** 桌面「壁纸设置」对应的全局设置键 */
export const WPE_SETTING_GLOBAL_KEYS: Readonly<Record<WpeSettingKey, AppSettingKey>> = {
  paused: "wallpaperPaused",
  volume: "wallpaperVolume",
  playbackRate: "wallpaperVideoPlaybackRate",
  mediaIntegration: "wpeMediaIntegration",
  postprocess: "wpeScenePostprocess",
  reflection: "wpeSceneReflection",
  shadows: "wpeSceneShadows",
};

/** 标签词条（说明是 `<词条>Desc`，选项文案是 `<词条><Follow|Disabled|…>`），沿用设置页原来的词条 */
export const WPE_SETTING_LABEL_KEYS: Readonly<Record<WpeSettingKey, string>> = {
  paused: "settings.wallpaperPaused",
  volume: "settings.wallpaperVolume",
  playbackRate: "settings.wallpaperVideoPlaybackRate",
  mediaIntegration: "settings.wpeMediaIntegration",
  postprocess: "settings.wpeScenePostprocess",
  reflection: "settings.wpeSceneReflection",
  shadows: "settings.wpeSceneShadows",
};

/** 三个场景选项的取值（含 `follow`），顺序即显示顺序 */
export const WPE_SETTING_CHOICES = {
  postprocess: ["follow", "disabled", "enabled", "ultra"],
  reflection: ["follow", "disabled", "enabled"],
  shadows: ["follow", "disabled", "low", "medium", "high", "ultra"],
} as const satisfies Partial<Record<WpeSettingKey, readonly string[]>>;

export type WpeChoiceKey = keyof typeof WPE_SETTING_CHOICES;

export function isWpeChoiceKey(key: WpeSettingKey): key is WpeChoiceKey {
  return key in WPE_SETTING_CHOICES;
}

/** 一个选项能选哪些值：不能跟随时去掉 `follow` */
export function wpeChoiceValues(key: WpeChoiceKey, followAvailable: boolean): string[] {
  return WPE_SETTING_CHOICES[key].filter((value) => followAvailable || value !== "follow");
}

/** 选项的显示值：取值不认识、或是 `follow` 但不能跟随时，显示 Kabegame 默认值 */
export function wpeChoiceDisplay(key: WpeChoiceKey, value: unknown, followAvailable: boolean): string {
  const values = wpeChoiceValues(key, followAvailable);
  return typeof value === "string" && values.includes(value) ? value : WPE_SETTING_DEFAULTS[key];
}

/**
 * 某类壁纸用得上的字段；`type` 为空时给全部字段（设置页）。媒体集成只有 Windows 有数据源；
 * 倍速只作用于视频层（网页、场景收不到）；后处理 / 反射 / 阴影只有场景。
 */
export function wpeSettingFieldsFor(type: string | null | undefined, windows: boolean): WpeSettingKey[] {
  const media = windows ? (["mediaIntegration"] as const) : [];
  if (!type) return WPE_SETTING_KEYS.filter((key) => windows || key !== "mediaIntegration");
  if (isWpeVideoType(type)) return ["paused", "volume", "playbackRate"];
  if (isWpeWebType(type)) return ["paused", "volume", ...media];
  if (isWpeSceneType(type)) return ["paused", "volume", ...media, "postprocess", "reflection", "shadows"];
  return [];
}

/**
 * 预览右栏的字段：同 `wpeSettingFieldsFor`，只是 `x-wpe/video` 只有倍速——预览里视频壁纸按普通视频播放，暂停与音量
 * 由视频控制条管（音量是全部视频共用的 `kabegame-video-volume`），字段组再给一份会两头抢同一个值。
 */
export function wpePreviewFieldsFor(type: string | null | undefined, windows: boolean): WpeSettingKey[] {
  if (type && isWpeVideoType(type)) return ["playbackRate"];
  return type ? wpeSettingFieldsFor(type, windows) : [];
}

/** 预览设置：存了的键（后端规整过）叠在默认值上；暂停不在其中，由调用方另给 */
export function wpePreviewSettingValues(stored: Record<string, unknown> | null | undefined): WpeSettingValues {
  const values: WpeSettingValues = { ...WPE_SETTING_DEFAULTS };
  if (!stored) return values;
  if (typeof stored.volume === "number") values.volume = stored.volume;
  if (typeof stored.playbackRate === "number") values.playbackRate = stored.playbackRate;
  if (typeof stored.mediaIntegration === "boolean") values.mediaIntegration = stored.mediaIntegration;
  for (const key of Object.keys(WPE_SETTING_CHOICES) as WpeChoiceKey[]) {
    if (typeof stored[key] === "string") values[key] = stored[key] as string;
  }
  return values;
}

/** 推给场景宿主的三项（`kabegame:wpe-scene-settings`）：不能跟随时 `follow` 换成默认值，宿主只在能跟随时才解析 `follow` */
export interface WpeSceneSettings {
  postprocess: string;
  reflection: string;
  shadows: string;
}

/** 没有给场景设置的地方（缺省值）：都跟随 WPE，同宿主收不到父页面设置时的处理 */
export const WPE_FOLLOW_SCENE_SETTINGS: Readonly<WpeSceneSettings> = {
  postprocess: "follow",
  reflection: "follow",
  shadows: "follow",
};

export function wpeSceneSettingsOf(
  values: Pick<WpeSettingValues, WpeChoiceKey>,
  followAvailable: boolean,
): WpeSceneSettings {
  return {
    postprocess: wpeChoiceDisplay("postprocess", values.postprocess, followAvailable),
    reflection: wpeChoiceDisplay("reflection", values.reflection, followAvailable),
    shadows: wpeChoiceDisplay("shadows", values.shadows, followAvailable),
  };
}
