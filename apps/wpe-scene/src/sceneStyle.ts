import type { UserProperty } from "./compile/bindings";
import type { SceneStyle } from "./render/layout";

/**
 * 场景宿主与父页面（`WpeSceneView`）的 postMessage 协议：宿主启动时发 `{ type: SCENE_STYLE_REQUEST }`，
 * 父页面回两条：
 * - `{ type: SCENE_STYLE_MESSAGE, style }`：壁纸样式，变化时再主动推；
 * - `{ type: SCENE_DISPLAY_MESSAGE, scale }`：显示缩放，iframe 在父页面里实际显示的大小 ÷ 布局大小（预览画布按内容尺寸
 *   布局、再整体 `scale`，这个 transform 在 iframe 里量不到）。父页面量到变化时再主动推，桌面等不缩放的地方是 1。
 *   宿主按它把画布缩到实际显示大小（`canvasSize`）。
 *
 * 宿主不能 import 应用的代码，字面量另写一份在 `apps/kabegame/.../wpeSceneStyle.ts`，那边的测试读这个文件比对。
 */
export const SCENE_STYLE_REQUEST = "kabegame:wpe-scene-style-request";
export const SCENE_STYLE_MESSAGE = "kabegame:wpe-scene-style";
export const SCENE_DISPLAY_MESSAGE = "kabegame:wpe-scene-display";

const SCENE_STYLES: readonly string[] = ["fill", "fit", "stretch", "center", "tile"] satisfies SceneStyle[];

/** 工程没声明 `schemecolor` 时 WPE 用这个灰色，不是黑色。 */
const SCHEME_COLOR_FALLBACK: [number, number, number] = [0.5, 0.5, 0.5];

/** 留白的颜色：WPE 用 `schemecolor`，用户改的值已并进属性全集。`"r g b"` 原样当 0…1 的 RGB，不做颜色空间转换。 */
export function schemeColor(properties: ReadonlyMap<string, UserProperty>): [number, number, number] {
  const parts = String(properties.get("schemecolor")?.value ?? "")
    .trim()
    .split(/\s+/)
    .map(Number);
  const [r, g, b] = parts;
  return parts.length >= 3 && [r, g, b].every(Number.isFinite) ? [r, g, b] : SCHEME_COLOR_FALLBACK;
}

/** 父页面消息的落点。 */
export interface SceneParentHandlers {
  style(style: SceneStyle): void;
  /** 显示缩放：有限正数。 */
  displayScale(scale: number): void;
}

/** 收父页面的样式与显示缩放消息，然后请求一次当前值。只认父窗口发来的可信消息。 */
export function listenSceneParent(handlers: SceneParentHandlers): void {
  window.addEventListener("message", (event) => {
    if (!event.isTrusted || event.source !== window.parent) return;
    const data = event.data as { type?: unknown; style?: unknown; scale?: unknown } | null;
    if (data?.type === SCENE_STYLE_MESSAGE) {
      if (typeof data.style === "string" && SCENE_STYLES.includes(data.style)) handlers.style(data.style as SceneStyle);
    } else if (data?.type === SCENE_DISPLAY_MESSAGE) {
      const scale = data.scale;
      if (typeof scale === "number" && Number.isFinite(scale) && scale > 0) handlers.displayScale(scale);
    }
  });
  window.parent.postMessage({ type: SCENE_STYLE_REQUEST }, "*");
}
