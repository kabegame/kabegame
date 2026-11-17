/**
 * 图像层 / effect 上的帧表（sprite sheet）动画：每张帧表纹理一份共享计时器（P6e 点 2，`rea-p6e-sheet.md` 第 2 节）。
 *
 * WPE 的帧表是**纹理的动画**，不是图层的：纹理对象自带 `{frame, time, lastFrame}`（`tex+0x9c / +0xa0 / +0xa4`），同一张 `.tex` 的所有材质共用；
 * 只在绑定时推进——每个渲染帧里第一次有 draw 绑到这张纹理时用本帧的 `g_Frametime` 推进一次，同帧再绑定 dt 为 0；没有 draw 画到它的帧（图层不可见等）
 * 既不推进也不补时间。本文件是纯函数与小状态，Node 里可测；谁在什么时候调（只在真正画的 draw 上）见 `GpuScene` 的 `bindSheets`。
 *
 * 全部按 float32 算（WPE 的 `addss` / `subss` / `minss` / `maxss`），每一步 `Math.fround`。
 */
import type { SceneSheetFrames } from "../compile/bundle";

/** 共享计时器（WPE 纹理对象的 `+0x9c / +0xa0 / +0xa4`）。`frame` 是当前帧号（可越界，见 `advanceSheet`），`lastFrame` 是上次推进时的渲染帧号。 */
export interface SheetClock {
  frame: number;
  time: number;
  lastFrame: number;
}

/** 新计时器：纹理基类构造把这几个字段清 0（rea-p6e-sheet 2.2）。 */
export function newSheetClock(): SheetClock {
  return { frame: 0, time: 0, lastFrame: 0 };
}

const f32 = Math.fround;

/**
 * 推进一次（rea-p6e-sheet 2.4，`FUN_14015fdd0` 与 `FUN_14015f0d0` 内联的同一份）：**每次最多前进一格**，没有循环——帧时长小于渲染帧间隔
 * 时动画被卡在「每个渲染帧一格」，多出的时间由 `min` 截掉；总是循环。
 * - `dt > 0`：`time += dt`；`time >= 当前格 frametime`（NaN 不进，`comiss; jb`）才进格：`frame += 1`、`time -= 旧格 frametime`、越界回 0，
 *   最后 `time = min(time, 新格 frametime)`；
 * - `dt < 0`（只有脚本 `rate` 为负时出现）：`time += dt`；`time <= 0`（含 NaN）才退格：`frame -= 1`、负了回末格，
 *   `time = max(time + 新格 frametime, 0)`；
 * - `dt = 0` 或 NaN：什么都不做。
 * 当前帧号越界（脚本 `setFrame` 写进来的）时，判断用的是第 0 格的帧时长；前进时 `(u64)f >= N` 回 0。
 * **越界帧号倒着走**：WPE 退格后若帧号仍越界会读 `frames[f−1]` 的越界内存（未定义）。`p6e-api` 实测每帧减 1，这里按「越界格的帧时长取 0」实现——
 * 退格后 `time = max(time + 0, 0) = 0`，下一帧 `time += dt < 0` 又 ≤ 0，于是每帧退一格，和实测相同（语料不用，有意的选择）。
 */
export function advanceSheet(
  state: { frame: number; time: number },
  frames: SceneSheetFrames["frames"],
  dt: number,
): void {
  const count = frames.length;
  if (!count) return;
  const inRange = (index: number) => index >= 0 && index < count;
  const durationOf = (index: number) => (inRange(index) ? frames[index].frametime : 0);
  if (dt > 0) {
    const current = inRange(state.frame) ? frames[state.frame] : frames[0];
    state.time = f32(state.time + dt);
    if (state.time >= current.frametime) {
      state.frame += 1;
      state.time = f32(state.time - current.frametime);
      if (!inRange(state.frame)) state.frame = 0;
      const limit = frames[state.frame].frametime;
      // `minss`：t < ft ? t : ft
      state.time = state.time < limit ? state.time : limit;
    }
  } else if (dt < 0) {
    state.time = f32(state.time + dt);
    if (!(state.time > 0)) {
      state.frame -= 1;
      if (state.frame < 0) state.frame = count - 1;
      const next = f32(state.time + durationOf(state.frame));
      // `maxss`：t > 0 ? t : 0
      state.time = next > 0 ? next : 0;
    }
  }
}

/**
 * 一次绑定选哪一格（`FUN_14015f0d0`，rea-p6e-sheet 2.2）。
 * - `override >= 0`（脚本脱离的图层，`ITextureAnimation`；本步调用方一律给 −1）：这次绘制里所有帧表纹理都画这一格，`>= 帧数` 取第 0 格，
 *   **不推进**共享计时器、不写 `lastFrame`；`< 0` 走共享计时器；
 * - 否则本渲染帧第一次绑定（`lastFrame !== frameNo`）用 `dt` 推进，同帧再绑定 dt 为 0；然后记下 `lastFrame = frameNo`；
 * 返回推进后的格（共享帧号越界时取第 0 格）。
 */
export function sheetFrameFor(
  clock: SheetClock,
  sheet: Pick<SceneSheetFrames, "frames">,
  frameNo: number,
  dt: number,
  override: number,
): number {
  const count = sheet.frames.length;
  if (override >= 0) return override >= count ? 0 : override;
  advanceSheet(clock, sheet.frames, clock.lastFrame !== frameNo ? dt : 0);
  clock.lastFrame = frameNo;
  return clock.frame >= 0 && clock.frame < count ? clock.frame : 0;
}
