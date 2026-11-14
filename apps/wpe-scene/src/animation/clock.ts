/**
 * 场景属性关键帧动画的时钟（P10a 步骤 1）：一个 float32 时间，按模式推进、回绕或停下，并收集本帧越过的事件。纯 TS。
 *
 * 依据：`.claude/plans/wpe-import/3-scene/phase10/rea-p10-keyframes.md`（读码，第 1、3、4、8、11 节，第 14 节参考实现）与
 * `p10-REPORT.md`（实测）。字段照 WPE 时钟 K（`B+0x38`）：`spf`、`t`、`D`、`flags`、`length`、事件。
 * - 解析：`FUN_1401a96b0` → `FUN_1401a8c10`；推进：`FUN_1401a9f60`；控制：`IAnimation` 的方法（`0x1401707f0` 起）。
 * - 每帧加 `rate × dt`，`dt` 就是 `g_Frametime`，不读 `g_Time`（第 1 节）。全程 float32，`fmodf` 用 JS `%`（符号随被除数，同 CRT）。
 */
import type { AnimationClockParams, AnimationEventDef } from "./types";

const f = Math.fround;

/** 模式（`flags` 的低两位）：loop 0、mirror 1、single 2（读码第 3 节）。 */
export const LOOP = 0;
export const MIRROR = 1;
export const SINGLE = 2;

/** 运行时标志（读码第 3 节）：暂停（`startpaused`、`pause()`）、`single` 播完、`mirror` 正在反向。 */
export const PAUSED = 0x20000000;
export const DONE = 0x40000000;
export const BACK = 0x80000000;

export class AnimationClock {
  /** `1.0f / fps`。 */
  spf: number;
  /** 当前时间（秒），初值 0。 */
  t = 0;
  /** `(float)length / fps`：一轮的时长。 */
  D: number;
  /** 模式与运行时标志，无符号 32 位。 */
  flags: number;
  /** `asInt(length)`：帧号上限。 */
  length: number;
  /** 本时钟的事件，按 `options.events` 的数组顺序（收集顺序就是派发顺序）。 */
  events: readonly AnimationEventDef[];

  constructor(params: AnimationClockParams, events: readonly AnimationEventDef[] = []) {
    const fps = f(params.fps);
    this.length = Math.trunc(params.length);
    this.spf = f(1 / fps);
    this.D = f(f(this.length) / fps);
    this.flags = (params.mode | (params.startpaused ? PAUSED : 0)) >>> 0;
    this.events = events;
  }

  /**
   * 惰性时钟（P10b；`compile/animations.ts` 收进列表的丢弃动画，以及子动画用不到时的占位）：`spf` 1、`t` 0、`D` 0、`flags` 0、
   * `length` 照收、没有事件。`advance` 因 `D ≤ 0` 直接返回，`getFrame()` 恒为 0，`isPlaying()` 为真，`play()` / `setFrame()` 都改不出
   * 画面（P10 步骤 0 Q7：WPE 里 `fps` 读出 1、`duration` 0、`getFrame()` 一直 0）。
   */
  static inert(length: number): AnimationClock {
    const clock = new AnimationClock({ fps: 1, length, mode: LOOP, startpaused: false });
    clock.D = 0; // 构造会算出 length / 1，惰性时钟的一轮时长是 0（`advance` 据此不动）
    return clock;
  }

  /**
   * 推进 `d` 秒（`rate × dt`，float32；`FUN_1401a9f60`，读码第 3、8 节），本帧越过的事件追加到 `out`：
   * - 暂停、已结束、`single` 已到头、`D ≤ 0` 时什么都不做；`mirror` 反向段把 `d` 取负；
   * - 事件：`d > 0` 收 `[t0, t1)`，否则收 `(t1, t0]`；
   * - `single`：`t1 ≥ D` 时置结束位、`t = D`（事件用未钳的 `t1` 比较，正好等于 `t1` 的不收）；
   * - `loop`：越过 D 时取余（一帧跨多轮也只剩余数），再收 `[0, t)`；负向越过 0 时 `t = fmodf(t1 + D, D)`，再收 `(t, D]`；
   * - `mirror`：正向越过 D 置方向位、`t = D − fmodf(t1, D)`，反向越过 0 清位、`t = −fmodf(t1, D)`；反射回来的部分不收事件。
   */
  advance(d: number, out: AnimationEventDef[]): void {
    const flags = this.flags >>> 0;
    if (flags & (PAUSED | DONE)) return;
    if ((flags & SINGLE) !== 0 && this.t >= this.D) return;
    if (this.D <= 0) return;
    let delta = f(d);
    if (flags & BACK) delta = -delta;
    const t0 = this.t;
    const t1 = f(delta + t0);
    if (delta > 0) {
      for (const event of this.events) if (event.time >= t0 && event.time < t1) out.push(event);
    } else {
      for (const event of this.events) if (event.time > t1 && event.time <= t0) out.push(event);
    }
    this.t = t1;
    if (flags & SINGLE) {
      if (t1 >= this.D) {
        this.flags = (this.flags | DONE) >>> 0;
        this.t = this.D;
      }
      return;
    }
    if (!(flags & MIRROR)) {
      if (t1 < 0) {
        this.t = f(f(t1 + this.D) % this.D);
        if (this.t >= 0) {
          for (const event of this.events) if (event.time > this.t && event.time <= this.D) out.push(event);
        }
      }
      if (this.t >= this.D) {
        this.t = f(this.t % this.D);
        if (this.t < this.D) {
          for (const event of this.events) if (event.time >= 0 && event.time < this.t) out.push(event);
        }
      }
      return;
    }
    if (flags & BACK) {
      if (t1 <= 0) {
        this.t = -f(t1 % this.D);
        this.flags = (this.flags & ~BACK) >>> 0;
      }
    } else if (t1 >= this.D) {
      const r = f(t1 % this.D);
      this.flags = (this.flags | BACK) >>> 0;
      this.t = f(this.D - r);
    }
  }

  /** `play()`（`0x1401707f0`）：结束态时先把时间归零，再清暂停与结束位；从下一帧起推进。 */
  play(): void {
    if (this.flags & DONE) this.t = 0;
    this.flags = (this.flags & ~(PAUSED | DONE)) >>> 0;
  }

  /** `pause()`（`0x140170820`）：置暂停位。暂停的动画照样每帧写值（读码第 4 节）。 */
  pause(): void {
    this.flags = (this.flags | PAUSED) >>> 0;
  }

  /** `stop()`（`0x140170830`）：置暂停位，清结束位和 `mirror` 方向位，时间归零。 */
  stop(): void {
    this.flags = ((this.flags | PAUSED) & 0x3fffffff) >>> 0;
    this.t = 0;
  }

  /** `isPlaying()`（`0x140170860`）：暂停位与结束位都没置。 */
  isPlaying(): boolean {
    return (this.flags & (PAUSED | DONE)) === 0;
  }

  /** `getFrame()`（`0x1401708a0`）：`t / spf`，float32，带小数。 */
  getFrame(): number {
    return f(this.t / this.spf);
  }

  /** `setFrame(frame)`（`0x140170880`）：只改时间 `t = spf × frame`（float32），不钳制、不改任何位、不立即写值。 */
  setFrame(frame: number): void {
    this.t = f(this.spf * f(frame));
  }
}
