/**
 * WPE 设置字段组（`WpeSettingsFields.vue`）的规则：字段表、Kabegame 默认值、按壁纸类型选字段、「跟随 WPE」的取舍。
 *
 * 同一组字段有两个数据源：
 * - 桌面的「壁纸设置」：全局设置键（`WPE_SETTING_GLOBAL_KEYS`），所有壁纸共用，设置页显示全部字段；
 * - 预览的「预览设置」：每张壁纸一份，存在 metadata 的 `previewSettings`（后端
 *   `src-tauri/kabegame-core/src/wpe/preview_settings.rs`，字段与默认值的唯一实现在那里，这里是镜像，改一处要同步另一处），
 *   没设的项取 `WPE_SETTING_DEFAULTS`。预览的暂停不在其中：它是预览弹窗里的内存状态。
 *
 * 「跟随 WPE」只在能读到 WPE `config.json` 的环境里提供（`get_wpe_follow_available`，只有 Windows 可能为真）；
 * 不能跟随时选项里没有这一档，存着的 `follow` 按 Kabegame 默认值显示，交给场景宿主前也换成默认值。
 *
 * 帧率（`fps`）是数值或 `follow`，不在选项表里：界面是「跟随 WPE」开关加滑条（`WpeSettingControl.vue`）。
 * 生效帧率（含 `follow` 的解析）只在 Rust 算，经垫片的 `applyGeneralProperties` 交给网页壁纸与场景宿主，
 * 前端只负责编辑设置，不往场景设置消息里放帧率。
 *
 * 强制渲染（`forceRender`）只对场景：有暂不支持的特性也照常渲染。打开一律先确认（`confirmWpeForceRender`，字段组与预览的
 * 「我就要看」共用），和四个场景选项一起经场景设置消息交给宿主，变了宿主整场重新加载。
 */
import type { AppSettingKey } from "@/stores/settings";
import { IS_MACOS, IS_WINDOWS } from "@/env";
import { isWpeSceneType, isWpeVideoType, isWpeWebType } from "./mediaMime";

export type WpeSettingKey =
  | "paused"
  | "volume"
  | "playbackRate"
  | "mediaIntegration"
  | "fps"
  | "postprocess"
  | "reflection"
  | "shadows"
  | "volumetrics"
  | "forceRender";

/** 帧率设置的取值：固定帧率，或跟随 WPE */
export type WpeFpsValue = number | "follow";

/** 本平台有没有系统媒体会话数据源（「媒体集成」）：Windows 是 SMTC，macOS 经 `tauri-plugin-sysmedia` 读 Now Playing。 */
export const WPE_MEDIA_AVAILABLE = IS_WINDOWS || IS_MACOS;

/** 帧率下限（同 WPE 设置界面的 floor）；上限是显示器的最高刷新率（`useDisplayMaxFps`） */
export const WPE_FPS_MIN = 10;
/** 帧率的 Kabegame 默认值 */
export const WPE_FPS_DEFAULT = 30;

/** 倍速的范围（用户定：视频、场景、壁纸设置统一 0.25–4；Rust 的设置与预览设置同样钳到这里，宿主是 `PLAYBACK_RATE_MIN` / `MAX`） */
export const WPE_PLAYBACK_RATE_MIN = 0.25;
export const WPE_PLAYBACK_RATE_MAX = 4;

/** 钳进倍速范围；不是有限数按 1 */
export function clampPlaybackRate(rate: unknown): number {
  const value = typeof rate === "number" && Number.isFinite(rate) ? rate : 1;
  return Math.min(WPE_PLAYBACK_RATE_MAX, Math.max(WPE_PLAYBACK_RATE_MIN, value));
}

export interface WpeSettingValues {
  paused: boolean;
  volume: number;
  playbackRate: number;
  mediaIntegration: boolean;
  fps: WpeFpsValue;
  postprocess: string;
  reflection: string;
  shadows: string;
  volumetrics: string;
  forceRender: boolean;
}

/** 字段的显示顺序 */
export const WPE_SETTING_KEYS: readonly WpeSettingKey[] = [
  "paused",
  "volume",
  "playbackRate",
  "mediaIntegration",
  "fps",
  "postprocess",
  "reflection",
  "shadows",
  "volumetrics",
  "forceRender",
];

/** Kabegame 自己的默认值（与 WPE 出厂值一致）：预览设置没设的项、不能跟随时的 `follow` 都取它 */
export const WPE_SETTING_DEFAULTS: Readonly<WpeSettingValues> = {
  paused: false,
  volume: 1,
  playbackRate: 1,
  mediaIntegration: true,
  fps: WPE_FPS_DEFAULT,
  postprocess: "enabled",
  reflection: "enabled",
  shadows: "medium",
  volumetrics: "medium",
  forceRender: false,
};

/** 桌面「壁纸设置」对应的全局设置键 */
export const WPE_SETTING_GLOBAL_KEYS: Readonly<Record<WpeSettingKey, AppSettingKey>> = {
  paused: "wallpaperPaused",
  volume: "wallpaperVolume",
  playbackRate: "wallpaperVideoPlaybackRate",
  mediaIntegration: "wpeMediaIntegration",
  fps: "wpeFps",
  postprocess: "wpeScenePostprocess",
  reflection: "wpeSceneReflection",
  shadows: "wpeSceneShadows",
  volumetrics: "wpeSceneVolumetrics",
  forceRender: "wpeSceneForceRender",
};

/** 标签词条（说明是 `<词条>Desc`，选项文案是 `<词条><Follow|Disabled|…>`），沿用设置页原来的词条 */
export const WPE_SETTING_LABEL_KEYS: Readonly<Record<WpeSettingKey, string>> = {
  paused: "settings.wallpaperPaused",
  volume: "settings.wallpaperVolume",
  playbackRate: "settings.wallpaperVideoPlaybackRate",
  mediaIntegration: "settings.wpeMediaIntegration",
  fps: "settings.wpeFps",
  postprocess: "settings.wpeScenePostprocess",
  reflection: "settings.wpeSceneReflection",
  shadows: "settings.wpeSceneShadows",
  volumetrics: "settings.wpeSceneVolumetrics",
  forceRender: "settings.wpeSceneForceRender",
};

/** 场景选项的取值（含 `follow`），顺序即显示顺序；体积光与阴影是 WPE 的同一个档位枚举 */
export const WPE_SETTING_CHOICES = {
  postprocess: ["follow", "disabled", "enabled", "ultra"],
  reflection: ["follow", "disabled", "enabled"],
  shadows: ["follow", "disabled", "low", "medium", "high", "ultra"],
  volumetrics: ["follow", "disabled", "low", "medium", "high", "ultra"],
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

/** 存着的帧率值：有限数值或 `follow`，其余（缺失、类型不对）取默认值；数值不在这里钳制，显示时再钳 */
export function wpeFpsValueOf(value: unknown): WpeFpsValue {
  if (value === "follow") return "follow";
  return typeof value === "number" && Number.isFinite(value) ? value : WPE_FPS_DEFAULT;
}

/**
 * 帧率的显示值：`follow` 但不能跟随时显示默认值 30；数值取整钳到 [10, 显示器最高刷新率]
 * （存的值高于当前上限时按上限显示，实际帧率本来也被刷新率封顶）。
 */
export function wpeFpsDisplay(value: unknown, followAvailable: boolean, max: number): WpeFpsValue {
  const parsed = wpeFpsValueOf(value);
  if (parsed === "follow") {
    if (followAvailable) return "follow";
    return clampWpeFps(WPE_FPS_DEFAULT, max);
  }
  return clampWpeFps(parsed, max);
}

/** 取整钳到 [10, max]；max 低于下限（取不到刷新率之类）时按下限 */
export function clampWpeFps(value: number, max: number): number {
  const upper = Number.isFinite(max) ? Math.max(WPE_FPS_MIN, Math.round(max)) : WPE_FPS_MIN;
  return Math.min(upper, Math.max(WPE_FPS_MIN, Math.round(value)));
}

/**
 * 某类壁纸用得上的字段；`type` 为空时给全部字段（设置页）。媒体集成要本平台有数据源（`hasMedia`，即 `WPE_MEDIA_AVAILABLE`）；
 * 倍速作用于视频与场景（同一个值，用户定；网页收不到）；帧率作用于网页（经 `applyGeneralProperties` 推给页面）与场景（限帧）；
 * 后处理 / 反射 / 阴影 / 体积光 / 强制渲染只有场景。
 */
export function wpeSettingFieldsFor(type: string | null | undefined, hasMedia: boolean): WpeSettingKey[] {
  const media = hasMedia ? (["mediaIntegration"] as const) : [];
  if (!type) return WPE_SETTING_KEYS.filter((key) => hasMedia || key !== "mediaIntegration");
  if (isWpeVideoType(type)) return ["paused", "volume", "playbackRate"];
  if (isWpeWebType(type)) return ["paused", "volume", ...media, "fps"];
  if (isWpeSceneType(type))
    return [
      "paused",
      "volume",
      "playbackRate",
      ...media,
      "fps",
      "postprocess",
      "reflection",
      "shadows",
      "volumetrics",
      "forceRender",
    ];
  return [];
}

/**
 * 预览右栏的字段：同 `wpeSettingFieldsFor`，只是 `x-wpe/video` 只有倍速——预览里视频壁纸按普通视频播放，暂停与音量
 * 由视频控制条管（音量是全部视频共用的 `kabegame-video-volume`），字段组再给一份会两头抢同一个值。
 */
export function wpePreviewFieldsFor(type: string | null | undefined, hasMedia: boolean): WpeSettingKey[] {
  if (type && isWpeVideoType(type)) return ["playbackRate"];
  return type ? wpeSettingFieldsFor(type, hasMedia) : [];
}

/** 预览设置：存了的键（后端规整过）叠在默认值上；暂停不在其中，由调用方另给 */
export function wpePreviewSettingValues(stored: Record<string, unknown> | null | undefined): WpeSettingValues {
  const values: WpeSettingValues = { ...WPE_SETTING_DEFAULTS };
  if (!stored) return values;
  if (typeof stored.volume === "number") values.volume = stored.volume;
  if (typeof stored.playbackRate === "number") values.playbackRate = stored.playbackRate;
  if (typeof stored.mediaIntegration === "boolean") values.mediaIntegration = stored.mediaIntegration;
  if (typeof stored.forceRender === "boolean") values.forceRender = stored.forceRender;
  values.fps = wpeFpsValueOf(stored.fps);
  for (const key of Object.keys(WPE_SETTING_CHOICES) as WpeChoiceKey[]) {
    if (typeof stored[key] === "string") values[key] = stored[key] as string;
  }
  return values;
}

/**
 * 推给场景宿主的五项（`kabegame:wpe-scene-settings`）：四个选项不能跟随时 `follow` 换成默认值，宿主只在能跟随时才解析
 * `follow`；强制渲染原样。五项都是编译输入，变了宿主整场重新加载。
 */
export interface WpeSceneSettings {
  postprocess: string;
  reflection: string;
  shadows: string;
  volumetrics: string;
  /** 有暂不支持的特性也照常渲染 */
  forceRender: boolean;
}

/** 没有给场景设置的地方（缺省值）：都跟随 WPE，同宿主收不到父页面设置时的处理 */
export const WPE_FOLLOW_SCENE_SETTINGS: Readonly<WpeSceneSettings> = {
  postprocess: "follow",
  reflection: "follow",
  shadows: "follow",
  volumetrics: "follow",
  forceRender: false,
};

export function wpeSceneSettingsOf(
  values: Pick<WpeSettingValues, WpeChoiceKey | "forceRender">,
  followAvailable: boolean,
): WpeSceneSettings {
  return {
    postprocess: wpeChoiceDisplay("postprocess", values.postprocess, followAvailable),
    reflection: wpeChoiceDisplay("reflection", values.reflection, followAvailable),
    shadows: wpeChoiceDisplay("shadows", values.shadows, followAvailable),
    volumetrics: wpeChoiceDisplay("volumetrics", values.volumetrics, followAvailable),
    forceRender: values.forceRender === true,
  };
}
