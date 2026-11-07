/**
 * 网页与场景壁纸上的右键 → 父页面弹出预览的上下文菜单（`postMessage`）。
 *
 * iframe 里的右键事件到不了父页面（DOM 事件不跨 frame）。工具条靠父页面里的常驻热区唤出，右键菜单不能这样做：
 * 整块盖住页面，页面就收不到指针了。所以由 iframe 里的垫片 `wpe_shim.js` 在捕获阶段监听 `contextmenu`，发
 * `{ type: WPE_CONTEXT_MENU, x, y }`（iframe 视口里的 CSS 像素）。场景宿主也加载这份垫片，两种壁纸同一条路。
 * 页面自己取消右键或停止冒泡也照发：菜单是应用的功能，和工具条一样总能用；页面里再嵌的 iframe 没有垫片，管不到。
 *
 * 父页面（`WallpaperStage` 的 web 层、`WpeSceneView`）只认 `isTrusted` 且 `source` 是自己当前 iframe 的消息，按 iframe
 * 的显示矩形把坐标换算到自己的视口（预览画布带 CSS `scale`），再往上抛给预览弹窗。页面脚本自己也能发这条消息，最多就是
 * 弹出菜单，不能代用户点菜单项。
 *
 * 垫片是不经打包的纯脚本，不能 import 这里，按同样的字面量另写一份；`wpeWebVolume.test.ts` 读垫片源码核对。
 */

export const WPE_CONTEXT_MENU = "kabegame:wpe-contextmenu";

/** 父页面视口里的点（`clientX` / `clientY` 的坐标系）。 */
export interface ViewportPoint {
  x: number;
  y: number;
}

/**
 * 认出右键消息并换算成父页面视口坐标：iframe 内坐标 × 显示缩放（显示矩形 ÷ 布局尺寸）+ 显示矩形的左上角。
 * 不是这条消息、坐标不是有限数、iframe 没有布局时返回 null。
 */
export function wpeContextMenuPoint(data: unknown, frame: HTMLElement): ViewportPoint | null {
  if (!data || typeof data !== "object" || (data as { type?: unknown }).type !== WPE_CONTEXT_MENU) return null;
  const { x, y } = data as { x?: unknown; y?: unknown };
  if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  const { offsetWidth, offsetHeight } = frame;
  if (offsetWidth <= 0 || offsetHeight <= 0) return null;
  const rect = frame.getBoundingClientRect();
  return { x: rect.left + (x * rect.width) / offsetWidth, y: rect.top + (y * rect.height) / offsetHeight };
}
