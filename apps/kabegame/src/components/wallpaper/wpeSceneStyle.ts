/**
 * 场景壁纸的父页面 ↔ 宿主消息协议（`postMessage`），父页面一侧是 `WpeSceneView`：宿主启动时发
 * `{ type: WPE_SCENE_STYLE_REQUEST }`，父页面回 `{ type: WPE_SCENE_STYLE, style }`，样式变化时再主动推。
 *
 * 宿主 `apps/wpe-scene/src/sceneStyle.ts` 不能 import 这里，按同样的字面量另写一份；`wpeSceneStyle.test.ts` 读它的
 * 源码比对，两边不一致就失败。
 */
import type { Mode } from "./types";

export const WPE_SCENE_STYLE_REQUEST = "kabegame:wpe-scene-style-request";
export const WPE_SCENE_STYLE = "kabegame:wpe-scene-style";

export function isWpeSceneStyleRequest(data: unknown): boolean {
  return !!data && typeof data === "object" && (data as { type?: unknown }).type === WPE_SCENE_STYLE_REQUEST;
}

export function wpeSceneStyleMessage(style: Mode): { type: typeof WPE_SCENE_STYLE; style: Mode } {
  return { type: WPE_SCENE_STYLE, style };
}
