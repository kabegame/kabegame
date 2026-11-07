/**
 * 场景时钟与帧节流。
 *
 * `g_Time` 用秒，只在渲染循环运行时前进：暂停、页面隐藏期间冻结，恢复后从冻结处接着走，不会跳变；
 * 换用户属性后重新编译、无缝替换场景时时钟不重置，动画也不会从头开始。
 */

export class PausableClock {
  private accumulated = 0;
  private startedAt: number | null = null;

  constructor(private readonly now: () => number = () => performance.now()) {}

  get running(): boolean {
    return this.startedAt !== null;
  }

  resume(): void {
    if (this.startedAt === null) this.startedAt = this.now();
  }

  pause(): void {
    if (this.startedAt === null) return;
    this.accumulated += this.now() - this.startedAt;
    this.startedAt = null;
  }

  /** 已运行的秒数（不含暂停时段）。 */
  seconds(): number {
    const live = this.startedAt === null ? 0 : this.now() - this.startedAt;
    return (this.accumulated + live) / 1000;
  }
}

/** WPE 的帧时间上下限（`p4-particles-REPORT.md` T2，实测）：`g_Frametime` 钳到这个区间，粒子路径不再钳。 */
export const FRAMETIME_MIN = 0.0001;
export const FRAMETIME_MAX = 0.25;

export function clampFrametime(seconds: number): number {
  return Math.min(FRAMETIME_MAX, Math.max(FRAMETIME_MIN, Number.isFinite(seconds) ? seconds : 0));
}

/**
 * 帧时钟（T2）：实时帧按 `PausableClock` 读数的差推进，差钳到 `[0.0001, 0.25]`，`time`（`g_Time`）累加钳后的值，
 * 所以一帧卡了 1 秒时 `g_Time` 只走 0.25（WPE 同样，实测 `fps=5` 启动时连续三帧恰好 0.25、`runtime` 严格加 0.25）。
 * 第一个实时帧没有上一帧，差按 0，钳成 0.0001。
 * 补画帧（暂停、页面隐藏时的 redraw、resize）画的是同一时刻：`time` 不动、`frametime` 为 0，粒子不步进。
 */
export class FrameClock {
  /** 累加的秒数（未回绕）。 */
  time = 0;
  /** 这一帧的帧时间（秒）。 */
  frametime = 0;
  private last: number | null = null;

  /** 一个实时帧：`seconds` 是 `PausableClock.seconds()`。 */
  advance(seconds: number): void {
    const raw = this.last === null ? 0 : seconds - this.last;
    this.last = seconds;
    this.frametime = clampFrametime(raw);
    this.time += this.frametime;
  }

  /** 补画帧：同一时刻再画一次。补画只发生在时钟冻结时，不记读数。 */
  hold(): void {
    this.frametime = 0;
  }
}

/**
 * 帧节流：rAF 的回调频率等于显示器刷新率（本机 144 Hz），壁纸没必要跟满。没到下一拍的回调直接跳过；
 * 节拍固定前进，长期平均频率贴近上限而不是被量化到刷新率的约数。`maxFps <= 0` 不节流。
 */
export class FrameThrottle {
  private last = -Infinity;

  constructor(private readonly maxFps: number) {}

  /** 本次回调是否应该渲染。 */
  ready(now: number): boolean {
    if (this.maxFps <= 0) return true;
    const interval = 1000 / this.maxFps;
    const elapsed = now - this.last;
    // 1 ms 容差：刷新间隔与上限接近时（如 60 Hz 屏 + 60 fps 上限）不至于因抖动隔帧跳过
    if (elapsed < interval - 1) return false;
    // 按固定节拍推进，长期平均正好是上限；落后超过一拍（卡顿、刷新率低于上限）就从当前时刻重新对齐
    this.last = Number.isFinite(this.last) ? Math.max(this.last + interval, now - interval) : now;
    return true;
  }

  reset(): void {
    this.last = -Infinity;
  }
}
