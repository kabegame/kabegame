/**
 * 壁纸 iframe（网页壁纸、场景宿主）的鼠标：iframe 元素在父页面里一律不收真实鼠标（`pointer-events: none`），iframe 里的垫片向
 * `tauri-plugin-cursor` 登记本 frame，Rust 拿到光标后经 CEF 补丁 11 把原生事件直接注入它（钳进 frame），父页面盖在上面的东西
 * 挡不住；预览画布盖一层只拦截、不转发的覆盖层（`WallpaperPointerOverlay`）。三个桌面平台同一套。
 *
 * 光标从哪来：Windows / macOS 由 Rust 轮询全局光标。Linux 读不到全局光标：桌面上的光标由 Plasma 壁纸插件发回
 * （`wallpaper::manager::pointer_socket`），主窗口里的光标由主窗口的页面交给应用（{@link startWindowPointerFeed}），应用照同一个协议发进
 * 那个 socket。
 */

/**
 * 预览画布里要能点的元素（缩略图底部的「我就要看」）带这个属性：画布上盖着拦指针的覆盖层（`WallpaperPointerOverlay`），
 * 覆盖层按点击位置找到它就把左键点击转交过去。
 */
export const WALLPAPER_CLICKABLE_SELECTOR = "[data-wallpaper-clickable]";

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
 * 桌面壁纸窗口不是前台窗口，不用管焦点。返回解除函数。
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

/** 窗口里的一次指针状态（{@link startWindowPointerFeed} 交给应用的，字段同命令 `push_window_pointer`）。 */
export interface WindowPointer {
  /** 视口的 CSS 像素（按住拖出窗口时可越界） */
  x: number;
  y: number;
  /** 视口宽高 */
  width: number;
  height: number;
  leftDown: boolean;
  /** 假：光标离开了窗口 */
  present: boolean;
}

/**
 * Linux：页面把自己收到的鼠标交给应用（Windows / macOS 由 Rust 轮询全局光标，不用这个）。主窗口的由应用照壁纸鼠标回传的协议
 * 发进那个 socket，`tauri-plugin-cursor` 再注入预览里的壁纸 iframe；GNOME 下壁纸窗口是普通窗口，它的直接推给
 * `tauri-plugin-cursor`，注入桌面上的壁纸 iframe。
 * - 移动按帧合并（`requestAnimationFrame`），按下 / 抬起左键当场发（先补上还没发的移动），左键状态取 `buttons`；
 * - 光标离开窗口（`mouseout` 且没有 `relatedTarget`）时发一次离开；
 * - 光标不在窗口里时，启动与窗口变大小时也以一次离开报上视口宽高：桌面上的光标换算到窗口里要用它（运行时给的窗口尺寸在
 *   Wayland 下客户端自绘标题栏时含标题栏与阴影，对不上）；光标在窗口里时移动消息自己带着；
 * - 都在捕获阶段听，页面里取消事件、停止冒泡、指针捕获都拦不住。
 * 返回停止函数。
 */
export function startWindowPointerFeed(send: (pointer: WindowPointer) => void, win: Window = window): () => void {
  let pending: WindowPointer | null = null;
  let frame = 0;
  let last: WindowPointer | null = null;
  const pointerOf = (event: MouseEvent): WindowPointer => ({
    x: event.clientX,
    y: event.clientY,
    width: win.innerWidth,
    height: win.innerHeight,
    leftDown: (event.buttons & 1) !== 0,
    present: true,
  });
  const emit = (pointer: WindowPointer) => {
    last = pointer;
    send(pointer);
  };
  const flush = () => {
    if (frame) win.cancelAnimationFrame(frame);
    frame = 0;
    if (pending) emit(pending);
    pending = null;
  };
  const onMove = (event: MouseEvent) => {
    pending = pointerOf(event);
    if (!frame) frame = win.requestAnimationFrame(flush);
  };
  const onButton = (event: MouseEvent) => {
    if (event.button !== 0) return;
    flush();
    emit(pointerOf(event));
  };
  const onOut = (event: MouseEvent) => {
    if (event.relatedTarget) return;
    flush();
    if (last?.present) emit({ ...last, leftDown: false, present: false });
  };
  const reportViewport = () => {
    if (last?.present) return;
    send({
      x: last?.x ?? 0,
      y: last?.y ?? 0,
      width: win.innerWidth,
      height: win.innerHeight,
      leftDown: false,
      present: false,
    });
  };
  const options = { capture: true, passive: true } as const;
  reportViewport();
  win.addEventListener("resize", reportViewport, options);
  win.addEventListener("pointermove", onMove, options);
  win.addEventListener("pointerdown", onButton, options);
  win.addEventListener("pointerup", onButton, options);
  win.addEventListener("mouseout", onOut, options);
  return () => {
    if (frame) win.cancelAnimationFrame(frame);
    frame = 0;
    pending = null;
    win.removeEventListener("resize", reportViewport, options);
    win.removeEventListener("pointermove", onMove, options);
    win.removeEventListener("pointerdown", onButton, options);
    win.removeEventListener("pointerup", onButton, options);
    win.removeEventListener("mouseout", onOut, options);
  };
}
