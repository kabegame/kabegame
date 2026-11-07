import type { UserProperty } from "./compile/bindings";
import type { SceneStyle } from "./render/layout";

/**
 * 场景宿主与父页面（`WpeSceneView`）的 postMessage 协议：宿主启动时发 `{ type: SCENE_STYLE_REQUEST }`，
 * 父页面回 `{ type: SCENE_STYLE_MESSAGE, style }`，样式变化时再主动推。
 *
 * 宿主不能 import 应用的代码，字面量另写一份在 `apps/kabegame/.../wpeSceneStyle.ts`，那边的测试读这个文件比对。
 */
export const SCENE_STYLE_REQUEST = "kabegame:wpe-scene-style-request";
export const SCENE_STYLE_MESSAGE = "kabegame:wpe-scene-style";

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

/** 收父页面的样式消息，然后请求一次当前样式。只认父窗口发来的可信消息。 */
export function listenSceneStyle(apply: (style: SceneStyle) => void): void {
  window.addEventListener("message", (event) => {
    if (!event.isTrusted || event.source !== window.parent) return;
    const data = event.data as { type?: unknown; style?: unknown } | null;
    if (data?.type !== SCENE_STYLE_MESSAGE || typeof data.style !== "string") return;
    if (SCENE_STYLES.includes(data.style)) apply(data.style as SceneStyle);
  });
  window.parent.postMessage({ type: SCENE_STYLE_REQUEST }, "*");
}
