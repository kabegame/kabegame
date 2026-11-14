/**
 * 重建 dev 场景宿主产物（buildSceneHost.ts）的单测：只测换入与列文件这些纯文件操作，不跑真正的 vite 构建。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { indexScripts, listFiles, swapInto, targetRoot } from "./buildSceneHost.ts";

function tree(root: string, files: Record<string, string>): void {
  for (const [rel, text] of Object.entries(files)) {
    const file = path.join(root, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
}

describe("buildSceneHost", () => {
  test("换入：新文件拷进去、index.html 换成新的、旧的哈希文件删掉，别的不动", () => {
    const base = mkdtempSync(path.join(os.tmpdir(), "kb-scene-host-"));
    try {
      const staging = path.join(base, "staging");
      const out = path.join(base, "out");
      tree(staging, {
        "index.html": "new",
        "assets/index-NEW.js": "n",
        "assets/worker-NEW.js": "w",
        "assets/wpefont-A.wasm": "same",
      });
      tree(out, {
        "index.html": "old",
        "assets/index-OLD.js": "o",
        "assets/worker-OLD.js": "w0",
        "assets/wpefont-A.wasm": "same",
      });
      assert.deepEqual(indexScripts(out), ["assets/index-OLD.js"]);
      const result = swapInto(staging, out);
      assert.equal(result.copied, 4);
      assert.deepEqual(result.removed, ["assets/index-OLD.js", "assets/worker-OLD.js"]);
      assert.deepEqual(listFiles(out), listFiles(staging));
      assert.equal(readFileSync(path.join(out, "index.html"), "utf8"), "new");
      assert.deepEqual(indexScripts(out), ["assets/index-NEW.js"]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("暂存里没有 index.html 时拒绝，输出目录不动", () => {
    const base = mkdtempSync(path.join(os.tmpdir(), "kb-scene-host-"));
    try {
      const staging = path.join(base, "staging");
      const out = path.join(base, "out");
      tree(staging, { "assets/index-NEW.js": "n" });
      tree(out, { "index.html": "old", "assets/index-OLD.js": "o" });
      assert.throws(() => swapInto(staging, out), /没有 index\.html/);
      assert.deepEqual(listFiles(out), ["assets/index-OLD.js", "index.html"]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("target 目录：CARGO_TARGET_DIR 优先（相对仓库根），否则仓库下的 target", () => {
    assert.ok(targetRoot({}).endsWith(`${path.sep}target`));
    assert.ok(targetRoot({ CARGO_TARGET_DIR: "build/t" }).endsWith(path.join("build", "t")));
    assert.equal(listFiles(path.join(os.tmpdir(), "kb-no-such-dir-xyz")).length, 0);
  });
});
