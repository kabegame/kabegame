import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  formatMark,
  listLogDates,
  logFileFor,
  markNow,
  parseMark,
  readSince,
  readTail,
  readTailLines,
} from "./appLog.ts";

const line = (time: string, level: string, message: string) =>
  `2026-11-08 ${time}.000 ${level.padStart(5)} kabegame_core::x: ${message}\n`;

function withDir(run: (dir: string) => void) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "kbdev-log-"));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("app_log：mark / since 跨日期", () => {
  test("从标记读到最新，跨过 UTC 日期换文件；续行跟着条目；最后半行留到下次", () =>
    withDir((dir) => {
      const day1 = logFileFor(dir, "2026-11-07");
      const day2 = logFileFor(dir, "2026-11-08");
      writeFileSync(day1, line("08:00:00", "INFO", "旧的一条"));
      writeFileSync(path.join(dir, "other.txt"), "不是日志");
      const mark = markNow(dir, new Date("2026-11-07T12:00:00Z"));
      assert.equal(mark.date, "2026-11-07");
      assert.equal(formatMark(mark), `2026-11-07@${Buffer.byteLength(line("08:00:00", "INFO", "旧的一条"))}`);
      appendFileSync(day1, line("09:00:00", "WARN", "第一天 警告") + "  续行 A\n");
      writeFileSync(day2, line("10:00:00", "DEBUG", "第二天 调试") + line("10:00:01", "ERROR", "第二天 错误") + "半行");
      assert.deepEqual(listLogDates(dir), ["2026-11-07", "2026-11-08"]);

      const read = readSince(dir, parseMark(formatMark(mark)));
      assert.equal(read.total, 3);
      assert.match(read.entries[0], /第一天 警告\n {2}续行 A$/);
      assert.match(read.entries[2], /第二天 错误$/);
      assert.deepEqual(
        read.files.map((f) => f.date),
        ["2026-11-07", "2026-11-08"],
      );
      // 半行不算：下次从它开头读
      const before = line("10:00:00", "DEBUG", "第二天 调试") + line("10:00:01", "ERROR", "第二天 错误");
      assert.deepEqual(read.next, { date: "2026-11-08", offset: Buffer.byteLength(before) });

      appendFileSync(day2, "也写完了\n");
      const again = readSince(dir, read.next);
      assert.equal(again.total, 1);
      assert.match(again.entries[0], /^半行也写完了$/);
    }));

  test("level 与 grep 按整条筛；maxEntries 取最后的", () =>
    withDir((dir) => {
      writeFileSync(
        logFileFor(dir, "2026-11-08"),
        line("01:00:00", "DEBUG", "a") +
          line("01:00:01", "WARN", "b") +
          "  续行里有 needle\n" +
          line("01:00:02", "ERROR", "c") +
          line("01:00:03", "INFO", "needle d"),
      );
      const mark = { date: "2026-11-08", offset: 0 };
      assert.equal(readSince(dir, mark, { level: "warn" }).matched, 2);
      const grep = readSince(dir, mark, { grep: "NEEDLE" });
      assert.equal(grep.matched, 2);
      assert.match(grep.entries[0], /b\n {2}续行里有 needle/);
      const capped = readSince(dir, mark, { maxEntries: 1 });
      assert.equal(capped.dropped, 3);
      assert.match(capped.entries[0], /needle d$/);
      assert.throws(() => readSince(dir, mark, { grep: "(" }), /grep 不是合法的正则/);
    }));

  test("标记偏移超过文件大小（文件换过）时从头读", () =>
    withDir((dir) => {
      writeFileSync(logFileFor(dir, "2026-11-08"), line("01:00:00", "INFO", "x"));
      const read = readSince(dir, { date: "2026-11-08", offset: 99_999 });
      assert.equal(read.total, 1);
      assert.equal(read.files[0].reset, true);
    }));

  test("标记之后没有文件：next 不变；标记格式不对就报错", () =>
    withDir((dir) => {
      const read = readSince(dir, { date: "2026-11-08", offset: 5 });
      assert.equal(read.total, 0);
      assert.deepEqual(read.next, { date: "2026-11-08", offset: 5 });
      assert.throws(() => parseMark("2026-11-08"), /标记要写成/);
    }));
});

describe("app_log：tail", () => {
  test("从尾部按块往前读，只回最后 n 行（跨过块边界）", () =>
    withDir((dir) => {
      const file = logFileFor(dir, "2026-11-08");
      const lines = Array.from({ length: 40_000 }, (_, i) => `2026-11-08 01:00:00.000  INFO t: 第 ${i} 行 ✓`);
      writeFileSync(file, lines.join("\n") + "\n");
      assert.deepEqual(readTailLines(file, 3), lines.slice(-3));
      assert.deepEqual(readTailLines(file, 30_000), lines.slice(-30_000));
      assert.deepEqual(readTailLines(file, 50_000), lines);
      const tail = readTail(dir, { date: "2026-11-08", lines: 2 });
      assert.deepEqual(tail.entries, lines.slice(-2));
      const grep = readTail(dir, { date: "2026-11-08", lines: 5, grep: "第 1234\\d 行" });
      assert.equal(grep.matched, 10);
      assert.equal(grep.entries.length, 5);
      assert.throws(() => readTail(dir, { date: "2026-11-09" }), /没有这天的日志/);
      assert.throws(() => readTail(dir, { date: "11-09" }), /YYYY-MM-DD/);
    }));
});
