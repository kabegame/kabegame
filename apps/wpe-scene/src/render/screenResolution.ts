/**
 * 脚本的屏幕分辨率（`engine.screenResolution`，显示缩放为 1 的画布像素）与 `resizeScreen` 的触发。宿主建一份，跨渲染器共用。
 *
 * WPE：窗口收到 `WM_SIZE` 就进 resize（`FUN_14017f1b0`），改 `g_Screen` 尺寸（`engine.screenResolution` 读的就是它）、重建 RT，再把新尺寸交给
 * 导出了 `resizeScreen` 的脚本（rea-render-size 第 7 节，派发在 wp.asm `0x14017f700`–`0x14017f7c8`）；加载时那次 resize 早于脚本 `init`，
 * 所以 `init` 里读到的就是窗口尺寸，首次创建不调 `resizeScreen`。
 *
 * 这里：首次加载的 `init` 早于建渲染器，宿主在脚本第一次读的时候按渲染器的同一规则量一次（`seed`）；渲染器建好后每次量画布（构造时、
 * `ResizeObserver`、帧循环里的定期核对）都交给 `measure`，和之前的值不同才通知，所以 `init` 之后到渲染器建好之间变了的尺寸也会补一次
 * `resizeScreen`。和 WPE 有意不同：WPE 不比较新旧（窗口还原、设备重建时同尺寸也会再调一次）；我们的量是定期的，不比较就会一直调。
 */
export class ScreenResolution {
  private value: [number, number] = [1, 1];
  private measured = false;

  constructor(private readonly onChange?: (width: number, height: number) => void) {}

  /** 当前值（`engine.screenResolution`）；还没量过时是 1×1。 */
  get current(): [number, number] {
    return this.value;
  }

  /** 渲染器建好之前的量（宿主在脚本读时调）：没量过才记下、不通知；量过就不动（别在脚本的调用里触发回调）。 */
  seed(width: number, height: number): void {
    if (this.measured) return;
    this.value = [width, height];
    this.measured = true;
  }

  /** 渲染器量到的尺寸：先换上新值，再在不是第一次量、而且变了时通知（回调里读 `current` 已经是新值，同 WPE）。 */
  measure(width: number, height: number): void {
    const changed = width !== this.value[0] || height !== this.value[1];
    this.value = [width, height];
    const first = !this.measured;
    this.measured = true;
    if (changed && !first) this.onChange?.(width, height);
  }
}
