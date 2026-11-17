/**
 * P6e 点 2：图像层帧表的共享计时器（`render/sheets.ts`）。
 *
 * 期望值取自 WPE 实测（`ignore/p6/e0/out/rate-log.txt`、`shared-log.txt`，工程 `p6e-rate`、`p6e-shared`，fps 20、逐帧 `engine.frametime`）：
 * 日志第 f 行 `update` 里读到的共享帧号 = 第 f−1 帧渲染推进后的格（脚本在渲染之前）。日志不在本机时对应用例跳过。
 */
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { SceneSheetFrames } from "../compile/bundle";
import { advanceSheet, newSheetClock, sheetFrameFor, type SheetClock } from "./sheets";

const f32 = Math.fround;

/** n 格、每格同一帧时长的帧表（只有推进用得到的字段有意义）。 */
function strip(n: number, frametime: number): SceneSheetFrames {
  const frames = Array.from({ length: n }, (_, i) => ({
    frametime: f32(frametime),
    image: 0,
    rotation: [f32(1 / n), 0, 0, 1] as [number, number, number, number],
    translation: [f32(i / n), 0] as [number, number],
  }));
  return { version: 3, cell: [64, 64], total: f32(n * frametime), frames };
}

/** 一帧一帧调：第 k 帧（从 1 起）、dt = dts[k − 1]，返回每帧画的格。 */
function run(sheet: SceneSheetFrames, dts: readonly number[], clock: SheetClock = newSheetClock()): number[] {
  return dts.map((dt, i) => sheetFrameFor(clock, sheet, i + 1, dt, -1));
}

describe("advanceSheet：每次最多一格", () => {
  it("dt 远大于帧时长也只前进一格，余量被 min 截到新格的时长", () => {
    const sheet = strip(4, 0.02);
    const state = { frame: 0, time: 0 };
    advanceSheet(state, sheet.frames, 0.5);
    expect(state.frame).toBe(1);
    expect(state.time).toBe(f32(0.02));
  });

  it("time 不足时只累加、不进格；够了进格并扣掉旧格时长（余数累积）", () => {
    const sheet = strip(4, 0.1);
    const state = { frame: 0, time: 0 };
    advanceSheet(state, sheet.frames, 0.06);
    expect(state).toEqual({ frame: 0, time: f32(0.06) });
    advanceSheet(state, sheet.frames, 0.06);
    expect(state.frame).toBe(1);
    expect(state.time).toBe(f32(f32(0.06 + 0.06) - f32(0.1)));
  });

  it("末格之后回 0（总是循环）", () => {
    const sheet = strip(3, 0);
    const state = { frame: 2, time: 0 };
    advanceSheet(state, sheet.frames, 0.05);
    expect(state.frame).toBe(0);
  });

  it("帧时长 0 的格：每次推进都过一格", () => {
    expect(run(strip(4, 0), [0.05, 0.05, 0.05, 0.05, 0.05])).toEqual([1, 2, 3, 0, 1]);
  });

  it("dt = 0、NaN：什么都不做；time 是 NaN（NaN 不进）", () => {
    const sheet = strip(4, 0.1);
    const state = { frame: 1, time: 0.03 };
    advanceSheet(state, sheet.frames, 0);
    advanceSheet(state, sheet.frames, Number.NaN);
    expect(state).toEqual({ frame: 1, time: 0.03 });
    const nan = { frame: 1, time: Number.NaN };
    advanceSheet(nan, sheet.frames, 0.05);
    expect(nan.frame).toBe(1);
  });

  it("dt < 0（脚本 rate 为负）：time ≤ 0 才后退一格、回绕到末格，time = max(time + 新格时长, 0)", () => {
    const sheet = strip(4, 0.1);
    const state = { frame: 0, time: 0.04 };
    advanceSheet(state, sheet.frames, -0.03);
    expect(state.frame).toBe(0);
    expect(state.time).toBe(f32(f32(0.04) + f32(-0.03)));
    advanceSheet(state, sheet.frames, -0.03);
    // 0.04 − 0.03 − 0.03 = −0.02 → 退到末格，time = −0.02 + 0.1
    expect(state.frame).toBe(3);
    expect(state.time).toBeCloseTo(0.08, 6);
  });

  it("帧号越界（setFrame(99)）：前进时按第 0 格的时长判断，满了回到 0", () => {
    const sheet = strip(4, 0.1);
    const state = { frame: 99, time: 0 };
    advanceSheet(state, sheet.frames, 0.06);
    expect(state.frame).toBe(99);
    advanceSheet(state, sheet.frames, 0.06);
    expect(state.frame).toBe(0);
  });

  it("越界帧号倒着走：帧时长按 0，每帧退一格（p6e-api 实测，WPE 读越界内存的未定义行为，有意照实测）", () => {
    const sheet = strip(4, 0.1);
    const state = { frame: 99, time: 0 };
    const seen: number[] = [];
    for (let i = 0; i < 3; i++) {
      advanceSheet(state, sheet.frames, -0.05);
      seen.push(state.frame);
    }
    expect(seen).toEqual([98, 97, 96]);
  });
});

describe("sheetFrameFor：按渲染帧号去重、脱离覆盖", () => {
  it("同一渲染帧再绑定 dt 为 0，画同一格；换帧号再推进", () => {
    const sheet = strip(4, 0.02);
    const clock = newSheetClock();
    expect(sheetFrameFor(clock, sheet, 1, 0.05, -1)).toBe(1);
    expect(sheetFrameFor(clock, sheet, 1, 0.05, -1)).toBe(1);
    expect(sheetFrameFor(clock, sheet, 2, 0.05, -1)).toBe(2);
    expect(clock.lastFrame).toBe(2);
  });

  it("override ≥ 0：画那一格、越界取 0，不推进也不写 lastFrame；< 0 走共享计时器", () => {
    const sheet = strip(4, 0.02);
    const clock = newSheetClock();
    expect(sheetFrameFor(clock, sheet, 1, 0.05, 2)).toBe(2);
    expect(sheetFrameFor(clock, sheet, 1, 0.05, 99)).toBe(0);
    expect(clock).toEqual({ frame: 0, time: 0, lastFrame: 0 });
    expect(sheetFrameFor(clock, sheet, 1, 0.05, -1)).toBe(1);
  });

  it("共享帧号越界时画第 0 格", () => {
    const sheet = strip(4, 0.1);
    const clock: SheetClock = { frame: 99, time: 0, lastFrame: 5 };
    expect(sheetFrameFor(clock, sheet, 5, 0.05, -1)).toBe(0);
  });
});

const rateLog = "D:/Codes/kabegame/ignore/p6/e0/out/rate-log.txt";
const sharedLog = "D:/Codes/kabegame/ignore/p6/e0/out/shared-log.txt";

/** `[kbp] p6e f <帧号> <dt> …列` → { 帧号, dt, 列 }。 */
function rows(path: string): { f: number; dt: number; columns: string[] }[] {
  const out: { f: number; dt: number; columns: string[] }[] = [];
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const at = line.indexOf("[kbp] p6e f ");
    if (at < 0) continue;
    const [f, dt, ...columns] = line
      .slice(at + "[kbp] p6e f ".length)
      .trim()
      .split(/\s+/);
    out.push({ f: Number(f), dt: f32(Number(dt)), columns });
  }
  return out;
}

describe.skipIf(!existsSync(rateLog))("WPE 实测：p6e-rate（帧时长 0.1 / 0.02 / 0）逐帧对 getFrame", () => {
  it("前 150 帧：R100、R020、R000 三列与日志逐帧相同（日志第 f+1 行 = 第 f 帧渲染推进后的格）", () => {
    const data = rows(rateLog).filter((row) => row.f <= 151);
    const dts = data.map((row) => row.dt);
    const sheets = [strip(4, 0.1), strip(4, 0.02), strip(4, 0)];
    const clocks = sheets.map(() => newSheetClock());
    for (let k = 1; k < data.length; k++) {
      sheets.forEach((sheet, column) => {
        const cell = sheetFrameFor(clocks[column], sheet, k, dts[k - 1], -1);
        expect(Number(data[k].columns[column]), `帧 ${k} 列 ${column}`).toBe(cell);
      });
    }
    expect(data.length).toBeGreaterThan(100);
  });
});

describe.skipIf(!existsSync(sharedLog))("WPE 实测：p6e-shared（同一纹理的两个图层一隐一显、两个都隐）", () => {
  it("t1（A 一直可见）每帧推进，B 读到同一格；t2（E、F 同隐）隐藏的 15–29 帧不推进、回来也不补", () => {
    const data = rows(sharedLog).filter((row) => row.f <= 200);
    const t1 = strip(6, 0.1);
    const t2 = strip(6, 0.1);
    const c1 = newSheetClock();
    const c2 = newSheetClock();
    let hiddenFrames = 0;
    for (let k = 1; k < data.length; k++) {
      const dt = data[k - 1].dt;
      const hidden = k % 40 >= 15 && k % 40 < 30;
      const cell1 = sheetFrameFor(c1, t1, k, dt, -1);
      // 两个图层都隐藏：这张纹理没有 draw 绑到它，计时器不碰
      let cell2: number;
      if (hidden) {
        hiddenFrames++;
        cell2 = c2.frame;
      } else cell2 = sheetFrameFor(c2, t2, k, dt, -1);
      // 列：state, A B C D E F（C、D 是脚本脱离的，不比）
      const [, a, b, , , e, f] = data[k].columns;
      expect(Number(a), `帧 ${k} A`).toBe(cell1);
      expect(Number(b), `帧 ${k} B`).toBe(cell1);
      expect(Number(e), `帧 ${k} E`).toBe(cell2);
      expect(Number(f), `帧 ${k} F`).toBe(cell2);
    }
    expect(hiddenFrames).toBeGreaterThan(20);
  });
});
