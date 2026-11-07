/**
 * 场景壁纸的父页面 ↔ 宿主消息协议（`postMessage`），父页面一侧是 `WpeSceneView`：
 * - 宿主启动时发 `{ type: WPE_SCENE_STYLE_REQUEST }`，父页面回 `{ type: WPE_SCENE_STYLE, style }`，样式变化时再主动推；
 * - 出首帧时宿主发 `{ type: WPE_SCENE_SIZE, width, height }`（场景分辨率），预览按它定比例。
 *
 * 宿主 `apps/wpe-scene/src/sceneStyle.ts` 不能 import 这里，按同样的字面量另写一份；`wpeSceneStyle.test.ts` 读它的
 * 源码比对，两边不一致就失败。
 */
import type { Mode, WallpaperContentSize } from "./types";

export const WPE_SCENE_STYLE_REQUEST = "kabegame:wpe-scene-style-request";
export const WPE_SCENE_STYLE = "kabegame:wpe-scene-style";
export const WPE_SCENE_SIZE = "kabegame:wpe-scene-size";

export function isWpeSceneStyleRequest(data: unknown): boolean {
  return !!data && typeof data === "object" && (data as { type?: unknown }).type === WPE_SCENE_STYLE_REQUEST;
}

export function wpeSceneStyleMessage(style: Mode): { type: typeof WPE_SCENE_STYLE; style: Mode } {
  return { type: WPE_SCENE_STYLE, style };
}

/** 宿主报的场景分辨率；不是这条消息或尺寸无效时为 null。 */
export function wpeSceneSizeOf(data: unknown): WallpaperContentSize | null {
  if (!data || typeof data !== "object") return null;
  const { type, width, height } = data as { type?: unknown; width?: unknown; height?: unknown };
  if (type !== WPE_SCENE_SIZE || typeof width !== "number" || typeof height !== "number") return null;
  return width > 0 && height > 0 ? { width, height } : null;
}
