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
 * 另有一条不经请求、父页面主动发的：
 * - `{ type: SCENE_POINTER_MESSAGE, x, y }`：开场指针（P5a 收尾），光标在 iframe 里的归一化坐标（0…1 为 iframe 内，
 *   不钳制，可越界）。父页面只在 `interactive` 时、宿主 iframe 建好与报 ready 时各发一次（问 Rust 光标在窗口里的位置，
 *   按 iframe 的显示矩形换算），宿主开场就用真实光标，不必等第一个 `pointermove`。只作初值，见 `scenePointerFeed`。
 *
 * 宿主不能 import 应用的代码，字面量另写一份在 `apps/kabegame/.../wpeSceneStyle.ts`，那边的测试读这个文件比对。
 */
export const SCENE_STYLE_REQUEST = "kabegame:wpe-scene-style-request";
export const SCENE_STYLE_MESSAGE = "kabegame:wpe-scene-style";
export const SCENE_DISPLAY_MESSAGE = "kabegame:wpe-scene-display";
export const SCENE_POINTER_MESSAGE = "kabegame:wpe-scene-pointer";

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
  /** 开场指针：两个有限数，iframe 里的归一化坐标（不钳制）。 */
  pointer(x: number, y: number): void;
}

/** 收父页面的样式、显示缩放与开场指针消息，然后请求一次样式与显示缩放的当前值。只认父窗口发来的可信消息。 */
export function listenSceneParent(handlers: SceneParentHandlers): void {
  window.addEventListener("message", (event) => {
    if (!event.isTrusted || event.source !== window.parent) return;
    const data = event.data as { type?: unknown; style?: unknown; scale?: unknown; x?: unknown; y?: unknown } | null;
    if (data?.type === SCENE_STYLE_MESSAGE) {
      if (typeof data.style === "string" && SCENE_STYLES.includes(data.style)) handlers.style(data.style as SceneStyle);
    } else if (data?.type === SCENE_DISPLAY_MESSAGE) {
      const scale = data.scale;
      if (typeof scale === "number" && Number.isFinite(scale) && scale > 0) handlers.displayScale(scale);
    } else if (data?.type === SCENE_POINTER_MESSAGE) {
      const { x, y } = data;
      if (typeof x === "number" && typeof y === "number" && Number.isFinite(x) && Number.isFinite(y))
        handlers.pointer(x, y);
    }
  });
  window.parent.postMessage({ type: SCENE_STYLE_REQUEST }, "*");
}

/**
 * 指针的两个来源（P5a 收尾）：父页面交来的开场初值（`SCENE_POINTER_MESSAGE`）与宿主自己收到的真实 `pointermove`。
 * 初值是父页面某一刻问到的光标，可能比真实事件晚到，所以一旦收到过真实事件，之后的初值一律忽略。
 */
export function scenePointerFeed(setPointer: (x: number, y: number) => void): {
  /** 父页面交来的初值：还没收到过真实事件才生效。 */
  initial(x: number, y: number): void;
  /** 真实 `pointermove`：总是生效，之后初值作废。 */
  move(x: number, y: number): void;
} {
  let moved = false;
  return {
    initial(x, y) {
      if (!moved) setPointer(x, y);
    },
    move(x, y) {
      moved = true;
      setPointer(x, y);
    },
  };
}
