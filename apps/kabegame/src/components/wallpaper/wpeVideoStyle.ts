/**
 * WPE 视频壁纸（`x-wpe/video`）的作者播放属性落到 `<video>` 上的样式（壁纸显示重构步骤 4）：规则原样搬自 `WallpaperStage` 的
 * `getVideoStyle` / `applyWpeStageStyles` / `wpeVideoFilter`，现在由 `ImageContent` 用在自己的 `<video>` 上，桌面、图库预览、
 * 应用背景都生效（用户定）。
 *
 * - 铺放看 Kabegame 的样式（`fit`），作者的 `alignment` 不看（同 Stage：壁纸样式覆盖作者对齐）。`fit` 与 WPE 对齐的对应：
 *   cover = 盖满、contain = WPE 的 fill（等比放进）、fill = 拉伸、none = 居中。
 * - `position`（−1…1）：盖满、放进时沿溢出轴的位置（0 居中），其余居中。
 * - `flipH` → `scaleX(-1)`；居中（none）时 `offsetX` / `offsetY`（−1…1）整体位移（按元素自身尺寸的百分比，元素铺满父元素，
 *   等于 Stage 按整屏位移）。WPE 的 free（自由缩放）Stage 本来就走不到，不做。
 * - `color`（−1…1）→ CSS filter（量纲待真机对比校准，同 Stage）；`background` → 留边颜色（父元素背景）。
 */
import type { WpeVideoProps } from "./types";

export type MediaFit = "contain" | "cover" | "fill" | "none";

export interface WpeVideoPresentation {
  objectFit: MediaFit;
  objectPosition: string;
  transform: string;
  filter: string;
  /** 留边颜色（`rgb(…)`）；没有时空串 */
  background: string;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : 0));
}

/** WPE 颜色调整（−1…1）→ CSS filter。 */
export function wpeVideoFilter(wpe: WpeVideoProps | null | undefined): string {
  const color = wpe?.color;
  if (!color) return "";
  const brightness = 1 + clamp(color.brightness, -1, 1);
  const contrast = 1 + clamp(color.contrast, -1, 1);
  const saturation = 1 + clamp(color.saturation, -1, 1);
  const hue = clamp(color.hue, -1, 1) * 180;
  return `brightness(${brightness}) contrast(${contrast}) saturate(${saturation}) hue-rotate(${hue}deg)`;
}

/** 视频元素的样式；`wpe` 为空（普通视频、没有作者属性）时只有铺放。 */
export function wpeVideoPresentation(wpe: WpeVideoProps | null | undefined, fit: MediaFit): WpeVideoPresentation {
  if (!wpe) return { objectFit: fit, objectPosition: "center", transform: "", filter: "", background: "" };
  const percent = `${50 + clamp(wpe.position ?? 0, -1, 1) * 50}%`;
  const objectPosition = fit === "cover" || fit === "contain" ? `${percent} ${percent}` : "center";
  const transforms: string[] = [];
  if (wpe.flipH) transforms.push("scaleX(-1)");
  if (fit === "none")
    transforms.push(`translate(${clamp(wpe.offsetX, -1, 1) * 100}%, ${clamp(wpe.offsetY, -1, 1) * 100}%)`);
  const background = wpe.background ? `rgb(${wpe.background[0]}, ${wpe.background[1]}, ${wpe.background[2]})` : "";
  return { objectFit: fit, objectPosition, transform: transforms.join(" "), filter: wpeVideoFilter(wpe), background };
}
