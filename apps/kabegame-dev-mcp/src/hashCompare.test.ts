import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { compareBaselines, formatCompare, loadBaseline } from "./hashCompare.ts";

const level = (sha256: string, extra: Record<string, unknown> = {}) => ({
  stable: true,
  sha256,
  postprocess: { level: "disabled" },
  bloomLevels: null,
  targetBytes: 100,
  unsupported: ["a", "b"],
  width: 1920,
  height: 1080,
  format: "rgba8unorm",
  mean: [1, 2, 3],
  ...extra,
});

const scene = (dir: string, metadataId: number, levels: Record<string, ReturnType<typeof level>>) => ({
  input: {
    path: dir,
    sceneAssets: ["D:\\wpe\\assets"],
    metadataId,
    userProperties: { schemecolor: "1 0 0" },
    projectFiles: { "project.json": "p", "scene.json": "s" },
  },
  levels,
});

type Baseline = Parameters<typeof compareBaselines>[0];

const baseline = (scenes: Record<string, unknown>, entry = "index-A.js"): Baseline =>
  ({
    recordedAt: "2026-11-08T00:00:00Z",
    time: 1.5,
    levels: ["disabled", "ultra"],
    hostBuild: { entry, frameVisibility: "visible", corpusHead: "" },
    scenes,
    closed: null,
  }) as unknown as Baseline;

const DIR_A = "D:\\Codes\\kabegame\\ignore\\p4\\proj\\a";
const DIR_B = "D:\\Codes\\kabegame\\ignore\\p4\\proj\\b";

describe("hash_compare：按 input.path 对应", () => {
  test("图片 id 变了（重新导入）、目录大小写 / 分隔符不同、unsupported 顺序不同：仍算相同", () => {
    const a = baseline({
      "100": scene(DIR_A, 1, { disabled: level("x1"), ultra: level("x2") }),
      "101": scene(DIR_B, 2, { disabled: level("y1"), ultra: level("y2") }),
    });
    const b = baseline({
      "205": scene(DIR_B.toLowerCase(), 2, { disabled: level("y1"), ultra: level("y2") }),
      "204": scene(DIR_A.replace(/\\/g, "/"), 9, {
        disabled: level("x1", { unsupported: ["b", "a"], targetBytes: 200 }),
        ultra: level("x2"),
      }),
    });
    const result = compareBaselines(a, b);
    assert.equal(result.same, true, formatCompare(result));
    assert.equal(result.cells, 4);
    assert.deepEqual(
      result.pairs.map((p) => [p.a, p.b]),
      [
        ["100", "204"],
        ["101", "205"],
      ],
    );
    // 不算差异、单独列
    assert.equal(result.metadataMoved.length, 1);
    assert.equal(result.targetBytes.length, 1);
    assert.equal(result.hostBuild.sameEntry, true);
    assert.match(formatCompare(result), /^相同：2 张场景、4 组/);
    assert.match(formatCompare(result), /同一份宿主产物/);
  });

  test("哈希、unsupported、输入、缺档、缺场景都报差异", () => {
    const a = baseline({
      "1": scene(DIR_A, 1, { disabled: level("x1"), ultra: level("x2") }),
      "2": scene(DIR_B, 2, { disabled: level("y1") }),
    });
    const changed = scene(DIR_A, 1, {
      disabled: level("CHANGED"),
      ultra: level("x2", { unsupported: ["a"] }),
    });
    changed.input.userProperties = { schemecolor: "0 1 0" };
    const b = baseline({ "1": changed, "3": scene("D:\\elsewhere", 3, { disabled: level("z") }) }, "index-B.js");
    const result = compareBaselines(a, b);
    assert.equal(result.same, false);
    const fields = result.diffs.map((d) => `${d.where.split("\\").pop()} ${d.field}`);
    assert.ok(fields.includes("a 输入 userProperties"), fields.join(" | "));
    assert.ok(fields.includes("a disabled sha256"), fields.join(" | "));
    assert.ok(fields.includes("a ultra unsupported"), fields.join(" | "));
    assert.deepEqual(result.onlyInA, [{ id: "2", path: DIR_B }]);
    assert.deepEqual(result.onlyInB, [{ id: "3", path: "D:\\elsewhere" }]);
    assert.equal(result.hostBuild.sameEntry, false);
    assert.match(formatCompare(result), /^有差异：5 处/);
  });

  test("time 不同算差异；比了 0 组不算相同", () => {
    const a = baseline({ "1": scene(DIR_A, 1, { disabled: level("x") }) });
    const b = { ...baseline({ "1": scene(DIR_A, 1, { disabled: level("x") }) }), time: 2 };
    assert.equal(compareBaselines(a, b).diffs[0].field, "time");
    assert.equal(compareBaselines(baseline({}), baseline({})).same, false);
  });

  test("文件：原始基线与任务结果 { ok, baseline } 都认，不是基线就报错", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "kbdev-hash-"));
    try {
      const raw = path.join(dir, "raw.json");
      const wrapped = path.join(dir, "wrapped.json");
      const bad = path.join(dir, "bad.json");
      const data = baseline({ "1": scene(DIR_A, 1, { disabled: level("x") }) });
      writeFileSync(raw, JSON.stringify(data));
      writeFileSync(wrapped, JSON.stringify({ ok: true, unstable: null, baseline: data }));
      writeFileSync(bad, JSON.stringify({ hello: 1 }));
      assert.equal(compareBaselines(loadBaseline(raw), loadBaseline(wrapped)).same, true);
      assert.throws(() => loadBaseline(bad), /不是画面哈希基线/);
      assert.throws(() => loadBaseline(path.join(dir, "none.json")), /读不了基线/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
