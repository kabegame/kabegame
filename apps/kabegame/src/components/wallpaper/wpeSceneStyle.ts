/**
 * 场景壁纸的父页面 ↔ 宿主消息协议（`postMessage`），父页面一侧是 `WpeSceneView`：宿主启动时发
 * `{ type: WPE_SCENE_STYLE_REQUEST }`，父页面回两条：
 * - `{ type: WPE_SCENE_STYLE, style }`：壁纸样式，变化时再主动推；
 * - `{ type: WPE_SCENE_DISPLAY, scale }`：显示缩放（`displayScaleOf`），量到变化时再主动推。宿主按它把画布缩到
 *   实际显示大小：预览画布按内容尺寸布局、再整体 `scale`，这个 transform 在 iframe 里量不到。
 *
 * 另有一条不经请求、父页面主动发的：
 * - `{ type: WPE_SCENE_POINTER, x, y }`：开场指针（P5a 收尾），光标在 iframe 里的归一化坐标（`scenePointerIn`，不钳制）。
 *   只在 `interactive` 时、iframe 建好与宿主报 ready 时各发一次；宿主只当初值，收到过真实 `pointermove` 后忽略。
 *
 * 宿主 `apps/wpe-scene/src/sceneStyle.ts` 不能 import 这里，按同样的字面量另写一份；`wpeSceneStyle.test.ts` 读它的
 * 源码比对，两边不一致就失败。
 */
import type { Mode } from "./types";

export const WPE_SCENE_STYLE_REQUEST = "kabegame:wpe-scene-style-request";
export const WPE_SCENE_STYLE = "kabegame:wpe-scene-style";
export const WPE_SCENE_DISPLAY = "kabegame:wpe-scene-display";
export const WPE_SCENE_POINTER = "kabegame:wpe-scene-pointer";

export function isWpeSceneStyleRequest(data: unknown): boolean {
  return !!data && typeof data === "object" && (data as { type?: unknown }).type === WPE_SCENE_STYLE_REQUEST;
}

export function wpeSceneStyleMessage(style: Mode): { type: typeof WPE_SCENE_STYLE; style: Mode } {
  return { type: WPE_SCENE_STYLE, style };
}

export function wpeSceneDisplayMessage(scale: number): { type: typeof WPE_SCENE_DISPLAY; scale: number } {
  return { type: WPE_SCENE_DISPLAY, scale };
}

export function wpeScenePointerMessage(x: number, y: number): { type: typeof WPE_SCENE_POINTER; x: number; y: number } {
  return { type: WPE_SCENE_POINTER, x, y };
}

/**
 * 本页面视口（客户区 CSS 像素）里的一点在元素里的归一化坐标：按显示矩形（`getBoundingClientRect`，含祖先 transform）
 * 换算，`(0, 0)` 是左上角、`(1, 1)` 是右下角，不钳制（光标在 iframe 外时越界）。显示矩形为空时为 null。
 */
export function scenePointerIn(element: HTMLElement, point: { x: number; y: number }): [number, number] | null {
  const rect = element.getBoundingClientRect();
  if (!(rect.width > 0 && rect.height > 0)) return null;
  const x = (point.x - rect.left) / rect.width;
  const y = (point.y - rect.top) / rect.height;
  return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null;
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
