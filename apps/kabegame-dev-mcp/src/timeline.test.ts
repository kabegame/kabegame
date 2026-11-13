import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  TimelineError,
  alignSpectrum,
  buildTimeline,
  describeTimeline,
  frameRanges,
  parseKbpLog,
  parseSpectrumRecording,
  poolSpectrum,
  parseTrackJson,
  passesFromTag,
  pointerFromScreen,
  readKbpLog,
  timelineFrom,
  windowFromTag,
} from "./timeline.ts";
import type { TrackTiming } from "./timeline.ts";

/** WPE 日志：每行 `[kbp]` 后跟若干「帧号,帧时间,累计时间」（6 位小数），每行 `perLine` 条。 */
function kbpLog(runtimes: number[], perLine = 50, first = 1): string {
  const entries = runtimes.map((t, i) => {
    const prev = i === 0 ? 0 : runtimes[i - 1];
    return `${first + i},${(t - prev).toFixed(6)},${t.toFixed(6)}`;
  });
  const lines: string[] = [];
  for (let i = 0; i < entries.length; i += perLine) {
    lines.push(`2026-11-08T05:45:09Z, 327008: Error: [kbp] ${entries.slice(i, i + perLine).join(" ")}`);
  }
  return `${lines.join("\n")}\n`;
}

/** 五列日志（FR_CURSOR）：每帧 [累计时间, 屏幕x, 屏幕y]，光标列原样写（数或 "nan"），每行 `perLine` 条（FR_CURSOR 是 10）。 */
function kbpLog5(entries: [number, number | string, number | string][], perLine = 10, first = 1): string {
  const tokens = entries.map(([t, x, y], i) => {
    const prev = i === 0 ? 0 : entries[i - 1][0];
    return `${first + i},${(t - prev).toFixed(6)},${t.toFixed(6)},${String(x)},${String(y)}`;
  });
  const lines: string[] = [];
  for (let i = 0; i < tokens.length; i += perLine) {
    lines.push(`2026-11-10T16:33:36Z, 84904: Error: [kbp] ${tokens.slice(i, i + perLine).join(" ")}`);
  }
  return `${lines.join("\n")}\n`;
}

const throwsTimeline = (fn: () => unknown, message: RegExp) =>
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof TimelineError, String(error));
    assert.match(error.message, message);
    return true;
  });

describe("日志与轨迹解析", () => {
  test("[kbp] 条目：跨行、帧号 → 累计时间；忽略别的行", () => {
    const log = parseKbpLog(`${kbpLog([0.000376, 0.032246, 0.049569], 2)}别的日志行 1,2,3\n`);
    assert.deepEqual(
      [...log.entries()],
      [
        [1, 0.000376],
        [2, 0.032246],
        [3, 0.049569],
      ],
    );
  });

  test("截断的条目、重复或倒退的帧号、没有 [kbp] 报错", () => {
    throwsTimeline(() => parseKbpLog("x [kbp] 1,0.000376,0.000376 2,0.031870,0.03"), /第 1 行.*读不懂.*截断/);
    throwsTimeline(() => parseKbpLog(`${kbpLog([0.1, 0.2])}${kbpLog([0.1])}`), /第 1 帧重复.*两次运行/);
    throwsTimeline(() => parseKbpLog("[kbp] 2,0.100000,0.200000 1,0.100000,0.100000"), /帧号倒退/);
    throwsTimeline(() => parseKbpLog("nothing here\n"), /没有 \[kbp\]/);
  });

  test("轨迹：容忍 NaN / Infinity；校验 frame、dt、time；pointer 不合法当没有", () => {
    const track = parseTrackJson(
      '{"tag":"t","frames":[{"frame":3,"dt":0.5,"time":1.5,"pointer":[1.6,0.9],"corners":[NaN,-Infinity]},' +
        '{"frame":4,"dt":0.25,"pointer":null}]}',
    );
    assert.deepEqual(track, {
      tag: "t",
      frames: [
        { frame: 3, dt: 0.5, time: 1.5, pointer: [1.6, 0.9] },
        { frame: 4, dt: 0.25, pointer: null },
      ],
    });
    throwsTimeline(() => parseTrackJson('{"frames":[{"frame":0,"dt":1}]}'), /frame 要是正整数/);
    throwsTimeline(() => parseTrackJson('{"frames":[{"frame":1,"dt":0}]}'), /dt 要是有限正数/);
    throwsTimeline(() => parseTrackJson('{"frames":[{"frame":1,"dt":1},{"frame":1,"dt":1}]}'), /出现两次/);
    throwsTimeline(() => parseTrackJson("{"), /不是 JSON/);
  });

  test("passesFromTag：fps 1–20 两遍、其余一遍、推不出为 null", () => {
    assert.deepEqual(passesFromTag("p4b-fps10"), { passes: 2, tag: "p4b-fps10", fps: 10 });
    assert.equal(passesFromTag("p4c-cp-fps60")?.passes, 1);
    assert.equal(passesFromTag("2418800402-fps60-1024x575")?.passes, 1);
    assert.equal(passesFromTag("fps10")?.passes, 2);
    assert.equal(passesFromTag("fps20")?.passes, 2);
    assert.equal(passesFromTag("fps21")?.passes, 1);
    assert.equal(passesFromTag("fps0")?.passes, 1);
    assert.equal(passesFromTag("s15"), null);
    assert.equal(passesFromTag("p4b-colorp-a-base"), null);
    assert.equal(passesFromTag(null), null);
    assert.equal(frameRanges([1, 2, 3, 7, 9, 10]), "1–3、7、9–10");
  });
});

describe("时间线", () => {
  const runtimes = [0.000376, 0.032246, 0.049569, 0.066851, 0.083619, 0.100916];

  test("差分：第 1 帧是它自己的累计时间，其余是相邻差，舍入到 6 位小数；g_Time 取累计时间", () => {
    const t = timelineFrom({ log: kbpLog(runtimes) }, { frame: 4 });
    assert.deepEqual(t.dts, [0.000376, 0.03187, 0.017323, 0.017282]);
    assert.deepEqual(t.times, runtimes.slice(0, 4));
    assert.deepEqual(t.captured, []);
    assert.deepEqual(t.split, []);
    assert.equal(t.cursors, undefined);
    assert.equal(t.frame, 4);
    // 没舍入的差分带浮点尾巴
    assert.notEqual(0.032246 - 0.000376, 0.03187);
  });

  test("轨迹覆盖抓到的帧的 dt 与 g_Time；frame 缺省为轨迹最后一帧", () => {
    const track: TrackTiming = {
      tag: "p4c-cp-fps60",
      frames: [
        { frame: 4, dt: 0.01728200074, time: 0.06685100495, pointer: [1.6, 0.9] },
        { frame: 5, dt: 0.0421282984316349, time: 0.10894400626, pointer: null },
      ],
    };
    const t = timelineFrom({ log: kbpLog(runtimes), track, logTag: "p4c-cp-fps60" });
    assert.equal(t.frame, 5);
    assert.deepEqual(t.captured, [4, 5]);
    assert.deepEqual(t.dts.slice(3), [0.01728200074, 0.0421282984316349]);
    assert.deepEqual(t.times.slice(3), [0.06685100495, 0.10894400626]);
    // 抓到的帧的后一帧 dt 仍按日志差分
    const longer = timelineFrom({ log: kbpLog(runtimes), track }, { frame: 6 });
    assert.equal(longer.dts[5], 0.017297);
    assert.equal(longer.times[5], 0.100916);
    assert.deepEqual(longer.captured, [4, 5]);
    assert.deepEqual(t.passes, { passes: 1, tag: "p4c-cp-fps60", fps: 60 });
  });

  test("日志与轨迹都缺的帧：缺省报错并列出；split 按后一个已知帧平分（b3 的 p4b-fps10 数）", () => {
    // 日志到第 150 帧（累计 15.005633），轨迹从第 153 帧开始（同 rd-p4b-fps10.json）
    const log = new Map(Array.from({ length: 150 }, (_, i) => [i + 1, i === 149 ? 15.005633 : (i + 1) * 0.1]));
    const track: TrackTiming = {
      tag: "p4b-fps10",
      frames: [
        { frame: 153, dt: 0.10078240185976028, time: 15.305279731750488 },
        { frame: 154, dt: 0.09010759741067886, time: 15.395387649536133 },
      ],
    };
    throwsTimeline(
      () => timelineFrom({ log, track }),
      /第 151–152 帧日志与轨迹都没有（日志第 1–150 帧，轨迹第 153–154 帧.*gap: "split"/,
    );
    const t = timelineFrom({ log, track }, { gap: "split" });
    assert.deepEqual(t.split, [151, 152]);
    assert.equal(t.gaps.length, 1);
    assert.equal(t.gaps[0].total.toFixed(6), "0.198864");
    assert.equal(t.gaps[0].dt, 0.099432);
    assert.deepEqual(t.dts.slice(150, 152), [0.099432, 0.099432]);
    assert.ok(Math.abs(t.times[151] - (15.005633 + 2 * 0.099432)) < 1e-12);
    assert.deepEqual(t.dts.slice(152), [0.10078240185976028, 0.09010759741067886]);
    assert.deepEqual(t.passes?.passes, 2);
    assert.match(describeTimeline(t), /平分的帧 151–152（合计 0\.198864 s，每帧 0\.099432）/);
  });

  test("尾巴缺帧、后面没有已知帧：split 也报错；frame 超出日志与轨迹报错；没轨迹要给 frame", () => {
    const track: TrackTiming = { frames: [{ frame: 9, dt: 0.1, time: 0.9 }] };
    throwsTimeline(
      () => timelineFrom({ log: kbpLog(runtimes), track }, { frame: 8, gap: "split" }),
      /第 7–8 帧.*后面也没有已知的帧/,
    );
    throwsTimeline(
      () => timelineFrom({ log: kbpLog(runtimes), track }, { frame: 10 }),
      /frame 10 超出日志与轨迹：日志到第 6 帧，轨迹到第 9 帧/,
    );
    throwsTimeline(() => timelineFrom({ log: kbpLog(runtimes) }, { frame: 7 }), /frame 7 超出.*轨迹没给/);
    throwsTimeline(() => timelineFrom({ log: kbpLog(runtimes) }), /没有轨迹时要给 frame/);
    throwsTimeline(() => timelineFrom({ log: kbpLog(runtimes) }, { frame: 0 }), /frame 要是正整数/);
    // 中间缺的一段可以平分：日志缺第 3、4 帧，第 5 帧没有前一帧也算缺；结束时刻 = 第 6 帧的 g_Time − 它的 dt ≈ 第 5 帧的累计时间
    const holed = new Map([...parseKbpLog(kbpLog(runtimes))].filter(([f]) => f !== 3 && f !== 4));
    const t = timelineFrom({ log: holed }, { frame: 6, gap: "split" });
    assert.deepEqual(t.split, [3, 4, 5]);
    assert.ok(Math.abs(t.gaps[0].total - (runtimes[4] - runtimes[1])) < 1e-9);
    assert.equal(t.gaps[0].dt, Number(((runtimes[4] - runtimes[1]) / 3).toFixed(6)));
    assert.equal(t.dts[5], 0.017297);
  });

  test("cursors：track（抓到的帧取 pointer，没有就退回 cursor）、整串、只给 cursor", () => {
    const track: TrackTiming = {
      frames: [
        { frame: 2, dt: 0.03187, time: 0.032246, pointer: [1.6, 0.9] },
        { frame: 3, dt: 0.017323, time: 0.049569, pointer: null },
      ],
    };
    const a = timelineFrom({ log: kbpLog(runtimes), track }, { cursors: "track" });
    assert.deepEqual(a.cursors, [
      [0.5, 0.5],
      [1.6, 0.9],
      [0.5, 0.5],
    ]);
    assert.deepEqual(a.cursorsFromTrack, [2]);
    const b = timelineFrom({ log: kbpLog(runtimes), track }, { cursors: "track", cursor: [0.25, 0.75] });
    assert.deepEqual(b.cursors, [
      [0.25, 0.75],
      [1.6, 0.9],
      [0.25, 0.75],
    ]);
    const whole: [number, number][] = [
      [0, 0],
      [0.1, 0.2],
      [1, 1],
    ];
    assert.deepEqual(timelineFrom({ log: kbpLog(runtimes), track }, { cursors: whole }).cursors, whole);
    throwsTimeline(
      () => timelineFrom({ log: kbpLog(runtimes), track }, { cursors: whole.slice(1) }),
      /cursors 有 2 项，应和回放的帧数相同（3）/,
    );
    throwsTimeline(
      () => timelineFrom({ log: kbpLog(runtimes), track }, { cursors: whole, cursor: [0, 0] }),
      /整串时不收 cursor/,
    );
    throwsTimeline(
      () =>
        timelineFrom(
          { log: kbpLog(runtimes), track },
          {
            cursors: [
              [0, 0],
              [0, Number.NaN],
              [1, 1],
            ],
          },
        ),
      /cursors\[1\]/,
    );
    assert.deepEqual(timelineFrom({ log: kbpLog(runtimes), track }, { cursor: [0.2, 0.3] }).cursors, [
      [0.2, 0.3],
      [0.2, 0.3],
      [0.2, 0.3],
    ]);
  });

  test("读文件：相对路径按 root；标签取轨迹 tag，没有轨迹时取日志文件名", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "kbdev-timeline-"));
    try {
      writeFileSync(path.join(root, "p4b-fps10-log.txt"), kbpLog(runtimes));
      writeFileSync(
        path.join(root, "rd.json"),
        JSON.stringify({ tag: "p4b-colorp-a-base", frames: [{ frame: 6, dt: 0.017297, time: 0.100916 }] }),
      );
      const fromLog = buildTimeline({ log: "p4b-fps10-log.txt", frame: 3 }, { root });
      assert.equal(fromLog.tag, "p4b-fps10");
      assert.equal(fromLog.passes?.passes, 2);
      assert.equal(fromLog.log.file, path.join(root, "p4b-fps10-log.txt"));
      // 轨迹的 tag 推不出 fps 时，退回日志文件名
      const both = buildTimeline({ log: "p4b-fps10-log.txt", track: "rd.json" }, { root });
      assert.equal(both.tag, "p4b-colorp-a-base");
      assert.deepEqual(both.passes, { passes: 2, tag: "p4b-fps10", fps: 10 });
      assert.deepEqual(both.captured, [6]);
      throwsTimeline(() => buildTimeline({ log: "nope.txt", frame: 1 }, { root }), /读不了日志/);
      throwsTimeline(() => buildTimeline({ log: "p4b-fps10-log.txt", track: "nope.json" }, { root }), /读不了轨迹/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("五列日志（FR_CURSOR）", () => {
  const W: [number, number] = [1920, 1080];
  const runtimes = [0.00068, 0.049093, 0.103004, 0.155745, 0.208563, 0.262631];
  // 屏幕光标原样（String() 写出的）：负数、float32 误差的小数、读失败的 nan、指数
  const screens: [number | string, number | string][] = [
    [1382, -179],
    [1312, -159],
    ["nan", "nan"],
    [1007.9999389648438, -27.999998092651367],
    [2187, 825],
    ["1e-7", 540],
  ];
  const log5 = kbpLog5(runtimes.map((t, i) => [t, ...screens[i]] as [number, number | string, number | string]));
  const screen = (i: number) => screens[i].map(Number) as [number, number];

  test("五列：帧号 → 累计时间同三列，另回帧号 → 屏幕光标（nan 为 null）；三列时没有光标", () => {
    const read = readKbpLog(log5);
    assert.equal(read.columns, 5);
    assert.deepEqual([...read.runtime.values()], runtimes);
    assert.deepEqual([...parseKbpLog(log5).entries()], [...read.runtime.entries()]);
    assert.deepEqual(
      [...read.cursors!.entries()],
      [
        [1, [1382, -179]],
        [2, [1312, -159]],
        [3, null],
        [4, [1007.9999389648438, -27.999998092651367]],
        [5, [2187, 825]],
        [6, [1e-7, 540]],
      ],
    );
    // String(NaN) 写出的 NaN 同样当缺；只有一列是 nan 也当这一帧缺
    assert.deepEqual(
      [...readKbpLog("[kbp] 1,0.100000,0.100000,NaN,3 2,0.100000,0.200000,4,nan").cursors!.values()],
      [null, null],
    );
    const three = readKbpLog(kbpLog([0.1, 0.2]));
    assert.equal(three.columns, 3);
    assert.equal(three.cursors, null);
  });

  test("三列与五列混用报错（两个方向）；五列截断按五列说，三列照旧文案", () => {
    throwsTimeline(
      () => readKbpLog(`${kbpLog([0.1, 0.2])}${kbpLog5([[0.3, 1, 2]], 10, 3)}`),
      /第 2 行第 3 帧是五列，前面的条目是三列：同一个文件里三列和五列不能混用/,
    );
    throwsTimeline(
      () => readKbpLog(`${kbpLog5([[0.1, 1, 2]])}${kbpLog([0.2], 50, 2)}`),
      /第 2 帧是三列，前面的条目是五列/,
    );
    throwsTimeline(
      () => readKbpLog("x [kbp] 1,0.000680,0.000680,1382,-179 2,0.048413,0.049093,13"),
      /第 1 行有读不懂的条目 "2,0\.048413,0\.049093,13"：应为「帧号,帧时间,累计时间,屏幕x,屏幕y」.*截断/,
    );
    throwsTimeline(() => readKbpLog("[kbp] 1,0.000680,0.000680,13"), /应为「帧号,帧时间,累计时间,屏幕x,屏幕y」/);
    throwsTimeline(() => readKbpLog("[kbp] 1,0.000680,0.000680,Infinity,3"), /读不懂的条目/);
    // 三列的截断：文案和以前逐字相同
    throwsTimeline(
      () => parseKbpLog("x [kbp] 1,0.000376,0.000376 2,0.031870,0.03"),
      /^日志第 1 行有读不懂的条目 "2,0\.031870,0\.03"：应为「帧号,帧时间,累计时间」，两列都是 6 位小数（少了多半是行被截断）$/,
    );
  });

  test("窗口尺寸：标签末尾的 -<宽>x<高>；屏幕光标 ÷ 窗口取 float32", () => {
    assert.deepEqual(windowFromTag("p5a-cur3-fps20-1920x1080"), [1920, 1080]);
    assert.deepEqual(windowFromTag("2418800402-fps60-1024x575"), [1024, 575]);
    assert.equal(windowFromTag("p4c-cp-fps60"), null);
    assert.equal(windowFromTag("p4c-ptr-fps60-1920x800-b"), null);
    assert.equal(windowFromTag("x-0x10"), null);
    assert.equal(windowFromTag(null), null);
    // p5a-cur3 第 491 帧：屏幕 (1115, 679) 在 1920×1080 窗口里，轨迹的 g_PointerPosition 逐位等于它
    assert.deepEqual(pointerFromScreen([1115, 679], W), [0.5807291865348816, 0.6287037134170532]);
  });

  test('cursors: "log"：第 f 帧取日志第 f 帧；缺的帧沿用前一帧；抓到的帧和轨迹 pointer 核对', () => {
    const track: TrackTiming = {
      tag: "p5a-cur3-fps20-1920x1080",
      frames: [
        // 日志这一帧是 nan：不核对
        { frame: 3, dt: 0.053911, time: 0.103004, pointer: [0.6, 0.6] },
        { frame: 5, dt: 0.052818, time: 0.208563, pointer: pointerFromScreen([2187, 825], W) },
        // 日志没刷到第 7 帧：沿用第 6 帧，不核对
        { frame: 7, dt: 0.05, time: 0.312631, pointer: [0.3, 0.3] },
      ],
    };
    const t = timelineFrom({ log: log5, track }, { cursors: "log" });
    assert.equal(t.frame, 7);
    assert.deepEqual(t.cursors, [
      pointerFromScreen(screen(0), W),
      pointerFromScreen(screen(1), W),
      pointerFromScreen(screen(1), W),
      pointerFromScreen(screen(3), W),
      pointerFromScreen(screen(4), W),
      pointerFromScreen(screen(5), W),
      pointerFromScreen(screen(5), W),
    ]);
    // 逐项都是 float32（屏幕光标 / 窗口）
    assert.deepEqual(t.cursors![3], [Math.fround(1007.9999389648438 / 1920), Math.fround(-27.999998092651367 / 1080)]);
    assert.notEqual(t.cursors![3][0], 1007.9999389648438 / 1920);
    assert.deepEqual(t.cursorsFilled, [3, 7]);
    assert.equal(t.cursorsFrom, "log");
    assert.deepEqual(t.cursorsFromTrack, []);
    assert.deepEqual(t.cursorCheck, { frames: [5], maxDiff: 0, mismatched: [] });
    assert.deepEqual(t.window, [1920, 1080]);
    assert.equal(t.windowFrom, "track");
    assert.equal(t.logCursors, true);
    const line = describeTimeline(t);
    assert.match(
      line,
      /逐帧光标：取日志（屏幕光标 ÷ 窗口 1920×1080（轨迹标签），float32），日志缺光标、沿用相邻帧的 3、7；抓到的帧上和轨迹 pointer 核对 1 帧，最大差 0$/,
    );
    assert.doesNotMatch(line, /警告/);

    // 抓到的帧上和轨迹不同：结果照给，另起一行警告
    const off: TrackTiming = {
      ...track,
      frames: [...track.frames, { frame: 6, dt: 0.05, time: 0.262631, pointer: [0.1, 0.2] }],
    };
    const warned = timelineFrom({ log: log5, track: off }, { cursors: "log" });
    assert.deepEqual(warned.cursorCheck, { frames: [5, 6], maxDiff: 0.3, mismatched: [6] });
    assert.deepEqual(warned.cursors, t.cursors);
    assert.match(
      describeTimeline(warned),
      /最大差 0\.3\n警告：第 6 帧日志光标和轨迹 pointer 不同（最大差 0\.3）：窗口尺寸不对，或日志和轨迹不是同一次运行$/,
    );
  });

  test('cursors: "log"：开头缺用后一个已知帧；窗口从日志标签读、参数优先；没有可核对的帧', () => {
    const log = kbpLog5([
      [0.1, "nan", "nan"],
      [0.2, 960, 400],
      [0.3, 0, 0],
    ]);
    const t = timelineFrom({ log, logTag: "p5a-cur-fps20-1920x800" }, { cursors: "log", frame: 3 });
    assert.deepEqual(t.cursors, [
      [0.5, 0.5],
      [0.5, 0.5],
      [0, 0],
    ]);
    assert.deepEqual(t.cursorsFilled, [1]);
    assert.deepEqual(t.window, [1920, 800]);
    assert.equal(t.windowFrom, "log");
    assert.deepEqual(t.cursorCheck, { frames: [], maxDiff: 0, mismatched: [] });
    assert.match(describeTimeline(t), /窗口 1920×800（日志标签）.*沿用相邻帧的 1；抓到的帧上没有可核对的 pointer/);
    // 轨迹 tag 推不出时退回日志标签；参数给的优先
    const fromLog = timelineFrom(
      { log, track: { tag: "p5a-cur", frames: [{ frame: 3, dt: 0.1, time: 0.3 }] }, logTag: "p5a-cur-fps20-1920x800" },
      { cursors: "log" },
    );
    assert.equal(fromLog.windowFrom, "log");
    const given = timelineFrom(
      { log, logTag: "p5a-cur-fps20-1920x800" },
      { cursors: "log", frame: 3, window: [960, 400] },
    );
    assert.deepEqual(given.cursors![1], [1, 1]);
    assert.equal(given.windowFrom, "param");
    assert.match(describeTimeline(given), /窗口 960×400（参数给的）/);
  });

  test('cursors: "log" 的错误：三列日志、推不出窗口、和 cursor 同给、全是 nan、window 不合法', () => {
    throwsTimeline(
      () => timelineFrom({ log: kbpLog([0.1, 0.2]), logTag: "x-1920x1080" }, { cursors: "log", frame: 2 }),
      /cursors: "log" 要日志带光标列.*这份日志是三列：生成工程时用 write_project\(…, cursor=True\)/,
    );
    throwsTimeline(
      () => timelineFrom({ log: log5, logTag: "p5a-cur-fps20" }, { cursors: "log", frame: 2 }),
      /要知道抓帧窗口尺寸：标签（轨迹 null、日志 "p5a-cur-fps20"）末尾没有 -<宽>x<高>，传 window: \[宽, 高\]/,
    );
    throwsTimeline(
      () => timelineFrom({ log: log5 }, { cursors: "log", frame: 2, window: W, cursor: [0.5, 0.5] }),
      /cursors 为 "log" 时不收 cursor/,
    );
    throwsTimeline(
      () => timelineFrom({ log: kbpLog5([[0.1, "nan", "nan"]]) }, { cursors: "log", frame: 1, window: W }),
      /光标全是 nan/,
    );
    throwsTimeline(
      () => timelineFrom({ log: log5 }, { frame: 2, window: [0, 1080] }),
      /window 要是 \[宽, 高\]（两个正数，像素）/,
    );
    // 不是 "log" 时推不出窗口不报错，window 为 null
    const plain = timelineFrom({ log: log5 }, { frame: 2, cursor: [0.5, 0.5] });
    assert.equal(plain.window, null);
    assert.equal(plain.windowFrom, null);
  });

  test("日志带光标列、没传 cursors 时提示；track / 整串的光标说明带上窗口", () => {
    const plain = timelineFrom({ log: log5 }, { frame: 6 });
    assert.equal(plain.cursors, undefined);
    assert.equal(plain.cursorCheck, null);
    assert.match(describeTimeline(plain), /日志带光标列，要按每一帧的光标回放传 cursors: "log"$/);
    assert.doesNotMatch(describeTimeline(timelineFrom({ log: kbpLog(runtimes) }, { frame: 6 })), /cursors/);
    const track: TrackTiming = {
      tag: "p4c-ptr-fps60-1920x800",
      frames: [{ frame: 6, dt: 0.054068, time: 0.262631, pointer: [1.6, 0.9] }],
    };
    const t = timelineFrom({ log: kbpLog(runtimes), track }, { cursors: "track" });
    assert.equal(t.cursorsFrom, "track");
    assert.match(
      describeTimeline(t),
      /逐帧光标：1 帧取轨迹 pointer，其余 \[0\.5,0\.5\]；窗口 1920×800（轨迹标签），探针按 fill 换到场景上$/,
    );
  });
});

/** 仓库根下的 `ignore/p5/cur/`（快照里往上找）：P5a 收尾实验的真实日志与轨迹，没有就跳过。 */
function curData(): string | null {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    const candidate = path.join(dir, "ignore", "p5", "cur");
    if (existsSync(path.join(candidate, "out", "p5a-cur3-fps20-1920x1080-log.txt"))) return candidate;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

describe("真实数据：p5a-cur3（用户在测试窗口上晃过鼠标）", () => {
  const data = curData();
  test("七列实验日志转成五列：抓到的 491–494 帧日志光标和轨迹 pointer 逐位相同", { skip: !data }, () => {
    const tag = "p5a-cur3-fps20-1920x1080";
    const root = mkdtempSync(path.join(os.tmpdir(), "kbdev-timeline-cur-"));
    try {
      // 实验日志第 6、7 列是 cursorWorldPosition，协议里没有：只留前五列（不改原文件）
      const text = readFileSync(path.join(data!, "out", `${tag}-log.txt`), "utf8")
        .split(/\r?\n/)
        .map((line) => {
          const at = line.indexOf("[kbp]");
          if (at < 0) return line;
          const tokens = line
            .slice(at + 5)
            .trim()
            .split(/\s+/)
            .map((t) => t.split(",").slice(0, 5).join(","));
          return `${line.slice(0, at)}[kbp] ${tokens.join(" ")}`;
        })
        .join("\n");
      writeFileSync(path.join(root, `${tag}-log.txt`), text);
      copyFileSync(path.join(data!, "tracks", `rd-${tag}.json`), path.join(root, `rd-${tag}.json`));
      const t = buildTimeline({ log: `${tag}-log.txt`, track: `rd-${tag}.json`, cursors: "log" }, { root });
      assert.equal(t.frame, 494);
      assert.deepEqual(t.captured, [491, 492, 493, 494]);
      assert.deepEqual(t.window, [1920, 1080]);
      assert.deepEqual(t.cursorsFilled, []);
      assert.deepEqual(t.cursorCheck, { frames: [491, 492, 493, 494], maxDiff: 0, mismatched: [] });
      assert.deepEqual(t.cursors![490], [0.5807291865348816, 0.6287037134170532]);
      // 第 25 帧的屏幕 y 是 -27.999998092651367（float32 误差），照原值除
      assert.equal(t.cursors![24][1], Math.fround(-27.999998092651367 / 1080));
      // 光标逐帧在变
      assert.notDeepEqual(t.cursors![1], t.cursors![2]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("频谱录制（P11a，timeline.audio）", () => {
  const ramp = (n: number, k: number) => Array.from({ length: n }, (_, i) => Math.fround(((i * 7 + k) % 11) / 10));
  /** kbp rdc consts 的一行：draws 里放若干次绘制读到的常量。 */
  const constsRow = (frame: number, draws: Record<string, number[]>[]) => ({
    frame,
    rdc_frame: frame - 1,
    draws: draws.map((ps, i) => ({ event: 10 + i, ps: { g_Other: [1, 2], ...ps } })),
  });

  test("两两取大", () => {
    assert.deepEqual(poolSpectrum([0.1, 0.5, 0.7, 0.2]), [0.5, 0.7]);
  });

  test("consts：只读了 64 段时往下推 32、16；只读了 32 段时推 16、64 段没有；同一帧多次绘制同值；没读频谱的帧不收", () => {
    const L64 = ramp(64, 1);
    const R64 = ramp(64, 4);
    const L32 = ramp(32, 2);
    const R32 = ramp(32, 3);
    const recorded = parseSpectrumRecording(
      JSON.stringify([
        constsRow(5, [{ g_AudioSpectrum64Left: L64, g_AudioSpectrum64Right: R64 }, {}]),
        constsRow(6, [
          { g_AudioSpectrum32Left: L32, g_AudioSpectrum32Right: R32 },
          { g_AudioSpectrum32Left: L32, g_AudioSpectrum32Right: R32 },
        ]),
        constsRow(7, [{}]),
      ]),
    );
    assert.deepEqual([...recorded.keys()], [5, 6]);
    assert.deepEqual(recorded.get(5)!.sources, { "64": "recorded", "32": "derived", "16": "derived" });
    assert.deepEqual(recorded.get(5)!.arrays["32Left"], poolSpectrum(L64));
    assert.deepEqual(recorded.get(5)!.arrays["16Right"], poolSpectrum(poolSpectrum(R64)));
    assert.deepEqual(recorded.get(6)!.sources, { "64": "missing", "32": "recorded", "16": "derived" });

    const audio = alignSpectrum(recorded, 6, "x.json");
    assert.equal(audio.frames.length, 6);
    assert.deepEqual(audio.frames.slice(0, 4), [null, null, null, null]);
    assert.deepEqual(audio.frames[4], {
      left: poolSpectrum(poolSpectrum(L64)),
      right: poolSpectrum(poolSpectrum(R64)),
      left32: poolSpectrum(L64),
      right32: poolSpectrum(R64),
      left64: L64,
      right64: R64,
    });
    // 64 段没有：不给（探针写 0）
    assert.deepEqual(Object.keys(audio.frames[5]!).sort(), ["left", "left32", "right", "right32"]);
    assert.deepEqual(audio.recorded, [5, 6]);
    assert.deepEqual(audio.readback, { "64": "missing", "32": "recorded", "16": "derived" });
  });

  test("轨迹（frames[].audio，生成工程的 CLK）也收", () => {
    const L16 = ramp(16, 5);
    const R16 = ramp(16, 6);
    const recorded = parseSpectrumRecording(
      JSON.stringify({
        tag: "x",
        frames: [{ frame: 3, dt: 0.05, audio: { g_AudioSpectrum16Left: L16, g_AudioSpectrum16Right: R16 } }],
      }),
    );
    assert.deepEqual(recorded.get(3)!.sources, { "64": "missing", "32": "missing", "16": "recorded" });
    assert.deepEqual(alignSpectrum(recorded, 3).frames[2], { left: L16, right: R16 });
  });

  test("报错：同一帧两次绘制不同、个数不对、只有一边、帧号重复、读回帧没录到、不是录制", () => {
    const L = ramp(16, 1);
    const R = ramp(16, 2);
    const parse = (rows: unknown) => () => parseSpectrumRecording(JSON.stringify(rows));
    throwsTimeline(
      parse([constsRow(2, [{ g_AudioSpectrum16Left: L, g_AudioSpectrum16Right: R }, { g_AudioSpectrum16Left: R }])]),
      /第 2 帧的 g_AudioSpectrum16Left 在两次绘制里不同/,
    );
    throwsTimeline(
      parse([constsRow(2, [{ g_AudioSpectrum32Left: L, g_AudioSpectrum32Right: L }])]),
      /要是 32 个有限数/,
    );
    throwsTimeline(parse([constsRow(2, [{ g_AudioSpectrum16Left: L }])]), /只读到 g_AudioSpectrum16 的一边/);
    const row = constsRow(2, [{ g_AudioSpectrum16Left: L, g_AudioSpectrum16Right: R }]);
    throwsTimeline(parse([row, row]), /第 2 帧出现两次/);
    throwsTimeline(parse({ nothing: true }), /里面没有帧/);
    const recorded = parseSpectrumRecording(JSON.stringify([row]));
    throwsTimeline(() => alignSpectrum(recorded, 3), /读回的第 3 帧没录到频谱（录到的帧 2）/);
  });

  test("buildTimeline：audio 按帧号对齐到时间线，摘要写来源；读回帧没录到报错带文件名", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "kbp-audio-"));
    try {
      writeFileSync(path.join(root, "a-fps20-1920x1080-log.txt"), kbpLog([0.05, 0.1, 0.15, 0.2]));
      const L64 = ramp(64, 3);
      writeFileSync(
        path.join(root, "consts.json"),
        JSON.stringify([
          constsRow(3, [{ g_AudioSpectrum64Left: L64, g_AudioSpectrum64Right: L64 }]),
          constsRow(4, [{ g_AudioSpectrum64Left: L64, g_AudioSpectrum64Right: L64 }]),
        ]),
      );
      const t = buildTimeline({ log: "a-fps20-1920x1080-log.txt", audio: "consts.json", frame: 4 }, { root });
      assert.equal(t.frame, 4);
      assert.deepEqual(t.audio!.recorded, [3, 4]);
      assert.deepEqual(
        t.audio!.frames.map((f) => (f ? f.left64!.length : null)),
        [null, null, 64, 64],
      );
      assert.match(describeTimeline(t), /频谱：录到的帧 3–4，其余帧沿用前一帧；读回帧 16 段推出、32 段推出、64 段录到/);
      assert.equal(buildTimeline({ log: "a-fps20-1920x1080-log.txt", frame: 4 }, { root }).audio, undefined);
      throwsTimeline(
        () => buildTimeline({ log: "a-fps20-1920x1080-log.txt", audio: "consts.json", frame: 2 }, { root }),
        /consts\.json：读回的第 2 帧没录到频谱/,
      );
      throwsTimeline(
        () => buildTimeline({ log: "a-fps20-1920x1080-log.txt", audio: "none.json", frame: 4 }, { root }),
        /读不了频谱录制/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
