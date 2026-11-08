import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { JobTable } from "./jobs.ts";
import { DevError } from "./errors.ts";
import { comparablePath, devPaths, isWithin } from "./paths.ts";

describe("任务表", () => {
  test("完成后记录结果与进度", async () => {
    const jobs = new JobTable();
    const started = jobs.start("hash-baseline", { ids: ["1"] }, async ({ progress }) => {
      progress({ done: 1, total: 1 });
      return { ok: true };
    });
    assert.equal(started.status, "running");
    const done = await jobs.settled(started.id);
    assert.equal(done.status, "done");
    assert.deepEqual(done.result, { ok: true });
    assert.deepEqual(done.progress, { done: 1, total: 1 });
    assert.ok(done.endedAt);
  });

  test("失败记录错误", async () => {
    const jobs = new JobTable();
    const started = jobs.start("projects-import", {}, async () => {
      throw new Error("坏了");
    });
    const done = await jobs.settled(started.id);
    assert.equal(done.status, "failed");
    assert.equal(done.error, "坏了");
  });

  test("协作式取消", async () => {
    const jobs = new JobTable();
    let running = false;
    const started = jobs.start("host-task", {}, ({ signal }) => {
      running = true;
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")));
      });
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(running);
    const canceled = await jobs.cancel(started.id);
    assert.equal(canceled.status, "canceled");
    assert.equal(jobs.counts().running, 0);
  });

  test("开始前就取消：不启动任务函数", async () => {
    const jobs = new JobTable();
    let ran = false;
    const started = jobs.start("host-task", {}, async () => {
      ran = true;
    });
    const canceled = await jobs.cancel(started.id);
    assert.equal(canceled.status, "canceled");
    assert.equal(ran, false);
  });

  test("不存在的任务回 404（提示 vite 可能重启过）", () => {
    const jobs = new JobTable();
    assert.throws(
      () => jobs.get("j-deadbeef"),
      (error) => error instanceof DevError && error.status === 404 && /vite 重启/.test(error.message),
    );
  });

  test("结束的任务只留最近 20 个", async () => {
    const jobs = new JobTable();
    const ids: string[] = [];
    for (let i = 0; i < 25; i++) {
      const job = jobs.start("host-task", { i }, async () => i);
      ids.push(job.id);
      await jobs.settled(job.id);
    }
    assert.equal(jobs.list().length, 20);
    assert.throws(() => jobs.get(ids[0]));
    assert.equal(jobs.get(ids[24]).result, 24);
  });
});

describe("路径", () => {
  test("isWithin 按路径段判断（Windows 不分大小写）", () => {
    assert.ok(isWithin("D:\\Codes\\kabegame\\ignore\\p4\\proj\\x", "D:\\Codes\\kabegame\\ignore", "win32"));
    assert.ok(isWithin("d:/codes/KABEGAME/ignore/p4", "D:\\Codes\\kabegame\\ignore\\", "win32"));
    assert.ok(isWithin("D:\\Codes\\kabegame\\ignore", "D:\\Codes\\kabegame\\ignore", "win32"));
    assert.ok(!isWithin("D:\\Codes\\kabegame\\ignore2\\x", "D:\\Codes\\kabegame\\ignore", "win32"));
    assert.ok(!isWithin("D:\\Codes\\kabegame\\ignore\\..\\src", "D:\\Codes\\kabegame\\ignore", "win32"));
    assert.ok(!isWithin("D:\\Applications\\Steam\\x", "D:\\Codes\\kabegame\\ignore", "win32"));
    assert.ok(isWithin("/repo/ignore/a", "/repo/ignore", "linux"));
    assert.ok(!isWithin("/repo/Ignore/a", "/repo/ignore", "linux"));
  });

  test("comparablePath 去掉尾分隔符", () => {
    assert.equal(comparablePath("D:\\A\\B\\", "win32"), "d:\\a\\b");
  });

  test("CARGO_TARGET_DIR 决定场景宿主产物位置", () => {
    const withEnv = devPaths("/repo", { CARGO_TARGET_DIR: "/tmp/t" });
    assert.ok(withEnv.sceneIndex.replace(/\\/g, "/").endsWith("/tmp/t/debug/resources/wpe-scene/index.html"));
    const without = devPaths("/repo", {});
    assert.ok(without.sceneIndex.replace(/\\/g, "/").endsWith("/repo/target/debug/resources/wpe-scene/index.html"));
    assert.ok(without.devData.replace(/\\/g, "/").endsWith("/repo/.kabegame/debug/data"));
  });
});
