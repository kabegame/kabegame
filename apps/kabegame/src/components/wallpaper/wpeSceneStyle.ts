/**
 * 场景壁纸的父页面 ↔ 宿主消息协议（`postMessage`），父页面一侧是 `WpeSceneView`：宿主启动时发
 * `{ type: WPE_SCENE_STYLE_REQUEST }`，父页面回两条：
 * - `{ type: WPE_SCENE_STYLE, style }`：壁纸样式，变化时再主动推；
 * - `{ type: WPE_SCENE_DISPLAY, scale }`：显示缩放（`displayScaleOf`），量到变化时再主动推。宿主按它把画布缩到
 *   实际显示大小：预览画布按内容尺寸布局、再整体 `scale`，这个 transform 在 iframe 里量不到。
 *
 * 宿主 `apps/wpe-scene/src/sceneStyle.ts` 不能 import 这里，按同样的字面量另写一份；`wpeSceneStyle.test.ts` 读它的
 * 源码比对，两边不一致就失败。
 */
import type { Mode } from "./types";

export const WPE_SCENE_STYLE_REQUEST = "kabegame:wpe-scene-style-request";
export const WPE_SCENE_STYLE = "kabegame:wpe-scene-style";
export const WPE_SCENE_DISPLAY = "kabegame:wpe-scene-display";

export function isWpeSceneStyleRequest(data: unknown): boolean {
  return !!data && typeof data === "object" && (data as { type?: unknown }).type === WPE_SCENE_STYLE_REQUEST;
}

export function wpeSceneStyleMessage(style: Mode): { type: typeof WPE_SCENE_STYLE; style: Mode } {
  return { type: WPE_SCENE_STYLE, style };
}

export function wpeSceneDisplayMessage(scale: number): { type: typeof WPE_SCENE_DISPLAY; scale: number } {
  return { type: WPE_SCENE_DISPLAY, scale };
}

/**
 * 元素的显示缩放：`getBoundingClientRect`（含祖先 CSS transform）÷ 布局尺寸（`offsetWidth` / `offsetHeight`）。
 * 两个方向取大的：不等比缩放时画布宁可多画一点，不画糊。没有布局（未挂上、`display: none`）或量成 0
 * （预览画布量好容器之前 `scale(0)`）时为 null，调用方保持上次的值。
 */
export function displayScaleOf(element: HTMLElement): number | null {
  const { offsetWidth, offsetHeight } = element;
  if (offsetWidth <= 0 || offsetHeight <= 0) return null;
  const rect = element.getBoundingClientRect();
  const scale = Math.max(rect.width / offsetWidth, rect.height / offsetHeight);
  return Number.isFinite(scale) && scale > 0 ? scale : null;
}
