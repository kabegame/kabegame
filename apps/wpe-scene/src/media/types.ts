/**
 * 场景的系统媒体集成（P11c）：后端场景投影的 Channel 消息、合并后的事件、事件里的数据形状。
 * 规则出处：rea-p11-media 第 1.5 节（合并与刷新）、第 2 节（场景队列与派发）、第 3 节（事件对象），实测 p11-REPORT「媒体回调与封面」。
 */
import type { UserTextureImage } from "../usertex/sources";

/** 一个颜色：0–255 的整数 r、g、b。 */
export type Rgb = readonly [number, number, number];
/** 封面的五个颜色，依次是 primary、secondary、tertiary、text、highContrast（消息的 `colors` 顺序，也是 `mediaThumbnailChanged` 事件的字段顺序）。 */
export type MediaColors = readonly [Rgb, Rgb, Rgb, Rgb, Rgb];

export const NO_COLORS: MediaColors = [
  [0, 0, 0],
  [0, 0, 0],
  [0, 0, 0],
  [0, 0, 0],
  [0, 0, 0],
];

/** 七个字符串（`mediaPropertiesChanged` 的内容）。 */
export interface MediaProps {
  title: string;
  artist: string;
  albumArtist: string;
  albumTitle: string;
  subTitle: string;
  genres: string;
  contentType: string;
}

export const EMPTY_PROPS: MediaProps = {
  title: "",
  artist: "",
  albumArtist: "",
  albumTitle: "",
  subTitle: "",
  genres: "",
  contentType: "",
};

/**
 * 后端场景投影在 Channel 上发的消息（`type` 区分；约定见子计划「约定」一节）。网页投影的 `thumbnail` 等不会发给场景订阅，
 * 万一收到别的 `type` 一律忽略。
 */
export type SceneMediaMessage =
  | { type: "status"; enabled: boolean }
  | ({ type: "properties" } & MediaProps)
  /** `png` 是原尺寸 PNG 的 base64（不带 `data:` 前缀），`""` 表示没有封面；`colors` 五个 0–255 整数颜色，没有封面时全 0。 */
  | { type: "sceneThumbnail"; png: string; colors: number[][] }
  | { type: "playback"; state: number }
  /** `position`、`duration` 各自截断到整秒；不外推。 */
  | { type: "timeline"; position: number; duration: number };

/** 事件 flags 的位（WPE `E.flags`）。 */
export const FLAG_PROPERTIES = 1;
export const FLAG_THUMBNAIL = 2;
export const FLAG_PLAYBACK = 4;
export const FLAG_TIMELINE = 8;
export const FLAG_STATUS = 0x10;
/** 一次刷新里合成的第一个事件的位（状态 / 播放 / 属性 / 时间轴，封面单独一个）。 */
export const FLAGS_MAIN = 0x1d;

/** 一张封面：解码后的图（`null` = 没有封面，或解码失败）与五个颜色。 */
export interface CoverData {
  image: UserTextureImage | null;
  colors: MediaColors;
}

/**
 * 一个媒体事件（WPE 的 `MediaIntegration::Event`）：`flags` 说明哪些部分有效，值是产生这个事件那一刻的全部当前值。
 * 封面事件（`flags === 2`）的 `cover` 带图，位图的所有权随事件交给消费方（场景队列 → 来源表）。
 */
export interface MediaEvent {
  flags: number;
  enabled: boolean;
  state: number;
  props: MediaProps;
  position: number;
  duration: number;
  cover: CoverData | null;
}

/** 关掉封面位图（`ImageBitmap.close`）；测试里的假位图没有 `close` 也行。 */
export function closeCover(cover: CoverData | null): void {
  (cover?.image?.source as { close?: () => void } | undefined)?.close?.();
}
