import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  TimelineError,
  buildTimeline,
  describeTimeline,
  frameRanges,
  parseKbpLog,
  parseTrackJson,
  passesFromTag,
  timelineFrom,
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
