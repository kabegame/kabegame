/**
 * 壁纸 iframe（网页壁纸、场景宿主）的鼠标。
 *
 * Windows / macOS：iframe 里的垫片向 `tauri-plugin-cursor` 登记本 frame，Rust 轮询全局光标、经 CEF 补丁 11 把原生事件
 * 直接注入它（钳进 frame），父页面盖在上面的东西挡不住。iframe 元素在父页面里一律不收真实鼠标，预览画布盖一层只拦截、
 * 不转发的覆盖层。
 *
 * Linux 拿不到全局光标：插件模式的离屏壁纸窗口由 Plasma 壁纸插件把桌面上的鼠标发回 Rust（`wallpaper::pointer_socket`），
 * 照样登记注入；其余窗口（图库预览）登记返回 false，退回原来的做法：可交互的 iframe 直接收真实鼠标，预览不盖覆盖层。
 * 离屏 browser 本来就收不到真实鼠标，壁纸窗口里 iframe 的 `pointer-events` 不影响注入。
 */
import { IS_LINUX } from "@/env";

// TODO:[WPE_SCENE] Linux 预览未实测：退回 iframe 直接收真实鼠标，光标在 iframe 外不跟随
/** 图库预览的鼠标由 Rust 注入 iframe（不是 iframe 自己收真实鼠标）。 */
export const NATIVE_FRAME_POINTER = !IS_LINUX;

/**
 * 预览画布里要能点的元素（缩略图底部的「我就要看」）带这个属性：画布上盖着拦指针的覆盖层（`WallpaperPointerOverlay`），
 * 覆盖层按点击位置找到它就把左键点击转交过去。
 */
export const WALLPAPER_CLICKABLE_SELECTOR = "[data-wallpaper-clickable]";

/** iframe 元素在父页面里的 `pointer-events`：注入时一律 `none`，退回时可交互才 `auto`。 */
export function framePointerEvents(interactive: boolean): "auto" | "none" {
  return !NATIVE_FRAME_POINTER && interactive ? "auto" : "none";
}

/**
 * 真实左键松开后再等多久还焦点（毫秒）：插件每 16 ms 轮询一次，注入的抬起最晚一个周期后才到，要让它先到。
 */
export const FOCUS_RETURN_DELAY_MS = 100;

/**
 * 预览里不让壁纸 iframe 留住键盘焦点。
 *
 * 注入的按下照常走 Blink 的按下处理，会把焦点切进 iframe；键盘还不支持，焦点留在里面时父页面收不到按键（预览的 Esc、
 * 左右键翻页）。但不能一按下就还：iframe 失焦时页面会当成松开（场景宿主把 `blur` 当左键抬起），拖动就断了。
 * 预览里真实鼠标落在父页面上（覆盖层），所以：
 * - 父页面的真实左键按着时不动；
 * - 左键松开后等 {@link FOCUS_RETURN_DELAY_MS}（注入的抬起先到），父窗口失焦（焦点进了 iframe）时等这一轮事件处理完，
 *   再看 `document.activeElement`：是 `owns` 认的 iframe 就 `blur()` 它，焦点回到父页面。
 *
 * 只在注入时用（{@link NATIVE_FRAME_POINTER}）：Linux 上真实鼠标直接进 iframe，父页面看不到按下。桌面壁纸窗口不是前台窗口，
 * 不用管焦点。返回解除函数。
 */
export function keepFocusOutOfFrames(owns: (frame: HTMLIFrameElement) => boolean, win: Window = window): () => void {
  let pressed = false;
  let timer: number | undefined;
  const check = () => {
    timer = undefined;
    if (pressed) return;
    const active = win.document.activeElement;
    if (active?.tagName === "IFRAME" && owns(active as HTMLIFrameElement)) (active as HTMLIFrameElement).blur();
  };
  const schedule = (delay: number) => {
    win.clearTimeout(timer);
    timer = win.setTimeout(check, delay);
  };
  const onDown = (event: PointerEvent) => {
    if (event.button === 0) pressed = true;
  };
  const onUp = (event: PointerEvent) => {
    if (event.button !== 0 && event.type === "pointerup") return;
    pressed = false;
    schedule(FOCUS_RETURN_DELAY_MS);
  };
  const onBlur = () => schedule(0);
  win.addEventListener("pointerdown", onDown, true);
  win.addEventListener("pointerup", onUp, true);
  win.addEventListener("pointercancel", onUp, true);
  win.addEventListener("blur", onBlur);
  return () => {
    win.clearTimeout(timer);
    win.removeEventListener("pointerdown", onDown, true);
    win.removeEventListener("pointerup", onUp, true);
    win.removeEventListener("pointercancel", onUp, true);
    win.removeEventListener("blur", onBlur);
  };
}
