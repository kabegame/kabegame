/**
 * 批量渲染（renderFrames.ts，最终走查的工具 2）的单测：参数解析与每帧参数是纯函数；整条链路用进程内 MCP（`openSession`，
 * 同生产）连假的 REST，核对每帧发给 vite 的请求、落盘的 PNG 与 frames.json、vite 不在时跳过剩下的帧、共用宿主。不连真 app。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Buffer } from "node:buffer";
import { createClient } from "./client.ts";
import type { DevMcpDeps } from "./tools.ts";
import {
  ArgError,
  checkOutput,
  openSession,
  parseCli,
  parseFrames,
  renderArgs,
  renderFrames,
  splitRenderText,
} from "./renderFrames.ts";
import type { RenderFramesOptions } from "./renderFrames.ts";
import { PNG, fakeRest, sendJson } from "./testdata/fakeRest.ts";
import type { Handler } from "./testdata/fakeRest.ts";
import { deadPort } from "../../../scripts/kabegame-dev/testdata/fakes.ts";

/** WPE 日志：第 1..n 帧，每帧 0.05 s（6 位小数），标签带窗口尺寸。 */
const kbpLog = (n: number) =>
  `x: [kbp] ${Array.from({ length: n }, (_, i) => `${i + 1},0.050000,${((i + 1) * 0.05).toFixed(6)}`).join(" ")}\n`;

/** 假 REST：开宿主、渲染（回 1×1 PNG，给了 trace 时回轨迹）、关宿主。 */
const handler: Handler = (req, body, res) => {
  const url = req.url ?? "";
  if (req.method === "POST" && url.endsWith("/hosts")) {
    return sendJson(res, 200, { handle: "h-1", instance: "i", scene: "9", entry: "index-A.js", hidden: true });
  }
  if (req.method === "DELETE") return sendJson(res, 200, { handle: "h-1", previewHostsLeft: 0 });
  if (url.endsWith("/render")) {
    const b = body as {
      time?: number;
      particles?: { dts: number[] };
      canvas?: [number, number];
      trace?: unknown;
      scripts?: unknown;
    };
    const meta = {
      width: b.canvas?.[0] ?? 1,
      height: b.canvas?.[1] ?? 1,
      // 读回画布（第 5 批）：给了 canvas 时像新探针那样回 canvas 与场景目标
      ...(b.canvas ? { canvas: b.canvas, sceneTarget: [8, 4] } : {}),
      sha256: `pix-${b.particles?.dts.length ?? b.time}`,
      time: b.time ?? 0,
      frametime: 0.05,
      // 跑场景脚本（第 7 批）：给了 scripts 时像新探针那样回 meta.scripts（没有脚本的场景）
      ...(b.scripts !== undefined
        ? {
            scripts: {
              clock: 0,
              clockDefault: b.scripts === true,
              seed: 1,
              seedDefault: true,
              screenResolution: [1920, 1080],
              frames: b.particles?.dts.length ?? 1,
              diagnostics: [],
              recompile: [],
              unconnected: { sound: 0, video: 0, particles: 0 },
              audioResolutions: [],
              messages: [],
              console: { count: 0, tail: [] },
            },
          }
        : {}),
    };
    const extra =
      b.trace !== undefined
        ? {
            trace: {
              version: 1,
              resources: {},
              passes: [{ index: 0, label: "scene", draws: [{ index: 0 }] }],
              copies: [],
            },
            traceImages: [],
          }
        : {};
    return sendJson(res, 200, {
      meta,
      png: Buffer.from(PNG).toString("base64"),
      pngSha256: "file",
      pngBytes: PNG.length,
      ...extra,
    });
  }
  sendJson(res, 404, { error: "x", layer: "rest" });
};

async function withSession(
  port: number,
  run: (session: Awaited<ReturnType<typeof openSession>>, root: string) => Promise<void>,
) {
  const root = mkdtempSync(path.join(os.tmpdir(), "kbdev-frames-"));
  const deps: DevMcpDeps = {
    client: createClient({ port }),
    root,
    logDir: path.join(root, "logs"),
    log: () => {},
  };
  const session = await openSession(deps);
  try {
    await run(session, root);
  } finally {
    await session.close();
    rmSync(root, { recursive: true, force: true });
  }
}

const base = (out: string, extra: Partial<RenderFramesOptions> = {}): RenderFramesOptions => ({
  image: "9",
  frames: [2, 3],
  out,
  fps: 20,
  timeoutMs: 30_000,
  overwrite: false,
  ...extra,
});

describe("参数", () => {
  test("帧列表：逗号、区间、去重保序；非法写法报错", () => {
    assert.deepEqual(parseFrames("241,242,250-252,241"), [241, 242, 250, 251, 252]);
    assert.throws(() => parseFrames("5-3"), ArgError);
    assert.throws(() => parseFrames("a"), ArgError);
    assert.throws(() => parseFrames("0"), ArgError);
  });

  test("命令行：回放与时刻模式互斥、回放专用参数只在回放时收、路径按 cwd 变绝对、trace 帧要在 frames 里", () => {
    const cwd = path.resolve("/repo");
    const replay = parseCli(
      [
        "--image",
        "13",
        "--frames",
        "4-5",
        "--out",
        "o",
        "--timeline-log",
        "l.txt",
        "--cursors",
        "log",
        "--canvas",
        "1920x1080",
        "--trace-frames",
        "5",
        "--trace-readback",
        "0,text glyphs",
        "--no-fr",
      ],
      cwd,
    );
    assert.equal(replay.out, path.join(cwd, "o"));
    assert.deepEqual(replay.timeline, { log: path.join(cwd, "l.txt"), cursors: "log" });
    assert.deepEqual(replay.canvas, [1920, 1080]);
    assert.deepEqual(replay.trace, { frames: [5], readback: [0, "text glyphs"] });
    assert.equal(replay.fr, false);
    assert.equal(replay.timeoutMs, 600_000);

    const timed = parseCli(["--image", "13", "--frames", "1", "--out", "o", "--fps", "20", "--video-time", "1.5"], cwd);
    assert.equal(timed.fps, 20);
    assert.equal(timed.videoTime, 1.5);
    assert.equal(timed.gifDts, undefined);
    const gif = (v: string) =>
      parseCli(["--image", "13", "--frames", "1", "--out", "o", "--fps", "20", "--gif-dts", v], cwd).gifDts;
    assert.deepEqual(gif("0.05,0.1"), [0.05, 0.1]);
    assert.deepEqual(gif("[0.05, 0]"), [0.05, 0]);
    assert.deepEqual(gif(""), []);
    assert.throws(
      () => parseCli(["--image", "13", "--frames", "1", "--out", "o", "--fps", "20", "--gif-dts", "-1"], cwd),
      /--gif-dts/,
    );
    assert.equal(timed.timeline, undefined);

    const bad = (args: string[], re: RegExp) => assert.throws(() => parseCli(args, cwd), re);
    const head = ["--image", "13", "--frames", "1", "--out", "o"];
    bad(head, /--fps.*--time/);
    bad([...head, "--fps", "20", "--time", "1"], /--fps.*--time/);
    bad([...head, "--timeline-log", "l", "--fps", "20"], /不能同给/);
    bad([...head, "--fps", "20", "--cursors", "log"], /只在回放/);
    bad([...head, "--fps", "20", "--trace-frames", "2"], /要在 --frames 里/);
    bad([...head, "--fps", "20", "--trace-readback", "0"], /要和 --trace-frames 一起给/);
    bad([...head, "--fps", "20", "--canvas", "19x"], /<宽>x<高>/);
    bad([...head, "--fps", "20", "--bogus"], /bogus/);
    bad(["--frames", "1", "--out", "o", "--fps", "20"], /--image/);
  });

  test("跑场景脚本（第 7 批）：--scripts 两种模式都收；--clock / --script-seed 只跟着 --scripts、范围不对报错", () => {
    const cwd = path.resolve("/repo");
    const head = ["--image", "13", "--frames", "1", "--out", "o"];
    assert.equal(parseCli([...head, "--fps", "20", "--scripts"], cwd).scripts, true);
    assert.deepEqual(
      parseCli([...head, "--timeline-log", "l.txt", "--scripts", "--clock", "1767268800000", "--script-seed", "7"], cwd)
        .scripts,
      { clock: 1767268800000, seed: 7 },
    );
    assert.deepEqual(parseCli([...head, "--fps", "20", "--scripts", "--script-seed", "0"], cwd).scripts, { seed: 0 });
    assert.equal(parseCli([...head, "--fps", "20"], cwd).scripts, undefined);
    const bad = (args: string[], re: RegExp) =>
      assert.throws(() => parseCli([...head, "--fps", "20", ...args], cwd), re);
    bad(["--clock", "5"], /要和 --scripts 一起给/);
    bad(["--script-seed", "5"], /要和 --scripts 一起给/);
    for (const seed of ["-1", "1.5", "4294967296", "x"]) bad(["--scripts", "--script-seed", seed], /--script-seed/);
    for (const clock of ["x", "9e15", ""]) bad(["--scripts", "--clock", clock], /--clock/);
  });

  test("每帧参数：回放模式填 timeline.frame、时刻模式 time = 帧号 / fps；save 到 ours-f<帧>.png、inline false；trace 只给指定帧", () => {
    const out = path.resolve("/o");
    const replay: RenderFramesOptions = {
      ...base(out),
      fps: undefined,
      timeline: { log: "/l.txt", cursors: "log" },
      seed: 3,
      canvas: [1920, 1080],
      trace: { frames: [3], maxVertices: 8 },
    };
    assert.deepEqual(renderArgs(replay, 2), {
      imageId: "9",
      replay: { timeline: { log: "/l.txt", cursors: "log", frame: 2 }, seed: 3 },
      canvas: [1920, 1080],
      save: path.join(out, "ours-f2.png"),
      inline: false,
    });
    assert.deepEqual(renderArgs(replay, 3, "h-7").trace, { save: path.join(out, "trace-f3"), maxVertices: 8 });
    assert.equal(renderArgs(replay, 3, "h-7").host, "h-7");
    assert.equal(renderArgs(base(out), 3).time, 3 / 20);
    assert.equal(renderArgs(base(out, { fps: undefined, time: 1.5 }), 3).time, 1.5);
    // 跑场景脚本（第 7 批）：原样交给每一帧；不给时没有这一项
    assert.equal("scripts" in renderArgs(base(out), 2), false);
    assert.equal(renderArgs(base(out, { scripts: true }), 2).scripts, true);
    assert.deepEqual(renderArgs({ ...replay, scripts: { clock: 5, seed: 3 } }, 2).scripts, { clock: 5, seed: 3 });
  });

  test("render_scene 的结果文本：元数据从独占一行的 { 起", () => {
    const meta = { width: 2, nested: { a: [1, { b: 2 }] } };
    const text = ["宿主产物 x", "读回：场景目标 2×1", JSON.stringify(meta, null, 2)].join("\n");
    assert.deepEqual(splitRenderText(text), { lines: ["宿主产物 x", "读回：场景目标 2×1"], meta });
    assert.deepEqual(splitRenderText("[vite] 不在").meta, null);
  });

  test("已有输出时拒绝（frames.json、要写的 PNG、轨迹目录），--overwrite 放行", () => {
    const out = mkdtempSync(path.join(os.tmpdir(), "kbdev-frames-out-"));
    try {
      checkOutput(base(out));
      writeFileSync(path.join(out, "ours-f3.png"), "x");
      assert.throws(() => checkOutput(base(out)), /ours-f3\.png/);
      checkOutput(base(out, { overwrite: true }));
      checkOutput(base(out, { frames: [2] }));
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});

describe("整条链路（进程内 MCP + 假 REST）", () => {
  test("时刻模式：每帧开关一次宿主、time = 帧号 / fps，PNG 落盘、frames.json 记元数据与文件 sha256", async () => {
    const rest = await fakeRest(handler);
    try {
      await withSession(rest.port, async (session, root) => {
        const out = path.join(root, "out");
        const summary = await renderFrames(base(out, { canvas: [4, 2] }), session);
        assert.equal(summary.ok, true);
        assert.equal(summary.rendered, 2);
        const renders = rest.seen
          .filter((r) => r.path.endsWith("/render"))
          .map((r) => r.body as Record<string, unknown>);
        assert.deepEqual(
          renders.map((b) => b.time),
          [0.1, 0.15],
        );
        assert.deepEqual(renders[0].canvas, [4, 2]);
        assert.equal(rest.seen.filter((r) => r.method === "POST" && r.path.endsWith("/hosts")).length, 2);
        assert.equal(rest.seen.filter((r) => r.method === "DELETE").length, 2);
        const png = path.join(out, "ours-f2.png");
        assert.deepEqual(new Uint8Array(readFileSync(png)), PNG);
        const record = JSON.parse(readFileSync(path.join(out, "frames.json"), "utf8"));
        assert.equal(record.ok, true);
        assert.equal(record.frames[0].frame, 2);
        assert.equal(record.frames[0].pngSha256, createHash("sha256").update(PNG).digest("hex"));
        assert.equal(record.frames[0].meta.sha256, "pix-0.1");
        assert.ok(record.frames[0].lines.some((l: string) => l.startsWith("原图已保存：")));
        assert.ok(record.notes.some((l: string) => /读回：画布 4×2/.test(l)));
      });
    } finally {
      await rest.close();
    }
  });

  test("回放模式：时间线由工具组（dts 长度 = 帧号）、FR 涂成那一帧；trace 帧写轨迹目录；共用宿主只开关一次", async () => {
    const rest = await fakeRest(handler);
    try {
      await withSession(rest.port, async (session, root) => {
        mkdirSync(path.join(root, "logs-in"));
        const log = path.join(root, "logs-in", "iso-fps20-1920x1080-log.txt");
        writeFileSync(log, kbpLog(6));
        const out = path.join(root, "out");
        const summary = await renderFrames(
          {
            ...base(out, { frames: [4, 6], fps: undefined, reuseHost: true }),
            timeline: { log },
            trace: { frames: [6] },
          },
          session,
        );
        assert.equal(summary.ok, true, JSON.stringify(summary));
        const renders = rest.seen.filter((r) => r.path.endsWith("/render"));
        assert.ok(renders.every((r) => r.path.includes("/hosts/h-1/render")));
        const bodies = renders.map((r) => r.body as { particles: { dts: number[] }; scriptValues?: unknown[] });
        assert.deepEqual(
          bodies.map((b) => b.particles.dts.length),
          [4, 6],
        );
        assert.equal(bodies[0].scriptValues?.length, 1); // FR 缺省涂
        assert.equal(rest.seen.filter((r) => r.method === "POST" && r.path.endsWith("/hosts")).length, 1);
        assert.equal(rest.seen.filter((r) => r.method === "DELETE").length, 1);
        assert.ok(existsSync(path.join(out, "trace-f6", "trace.json")));
        assert.ok(!existsSync(path.join(out, "trace-f4")));
        const record = JSON.parse(readFileSync(summary.framesJson, "utf8"));
        assert.equal(record.frames[1].trace, path.join(out, "trace-f6"));
        assert.match(record.host, /已关宿主 h-1/);
      });
    } finally {
      await rest.close();
    }
  });

  test("跑场景脚本（第 7 批）：每一帧的请求都带 scripts、回放时不发 FR 的 scriptValues，结果说明里有脚本行", async () => {
    const rest = await fakeRest(handler);
    try {
      await withSession(rest.port, async (session, root) => {
        const log = path.join(root, "iso-fps20-1920x1080-log.txt");
        writeFileSync(log, kbpLog(6));
        const out = path.join(root, "out");
        const summary = await renderFrames(
          { ...base(out, { frames: [4, 6], fps: undefined, scripts: { clock: 5, seed: 3 } }), timeline: { log } },
          session,
        );
        assert.equal(summary.ok, true, JSON.stringify(summary));
        const bodies = rest.seen
          .filter((r) => r.path.endsWith("/render"))
          .map((r) => r.body as { scripts?: unknown; scriptValues?: unknown });
        assert.deepEqual(
          bodies.map((b) => b.scripts),
          [
            { clock: 5, seed: 3 },
            { clock: 5, seed: 3 },
          ],
        );
        assert.ok(
          bodies.every((b) => b.scriptValues === undefined),
          "跑脚本时 FR 由脚本自己画，不塞值",
        );
        const record = JSON.parse(readFileSync(summary.framesJson, "utf8"));
        assert.ok(record.notes.some((l: string) => /FR 由脚本自己画（scripts，回放到第 4 帧）/.test(l)));
        assert.ok(record.notes.some((l: string) => /^场景脚本：/.test(l)));

        // 时刻模式同样转
        const timed = await renderFrames(base(path.join(root, "out2"), { frames: [2], scripts: true }), session);
        assert.equal(timed.ok, true, JSON.stringify(timed));
        const last = rest.seen.filter((r) => r.path.endsWith("/render")).at(-1)!.body as Record<string, unknown>;
        assert.equal(last.scripts, true);
        assert.equal(last.time, 0.1);
      });
    } finally {
      await rest.close();
    }
  });

  test("时间线组不出来的帧记 [timeline] 错误、不影响别的帧", async () => {
    const rest = await fakeRest(handler);
    try {
      await withSession(rest.port, async (session, root) => {
        const log = path.join(root, "short-log.txt");
        writeFileSync(log, kbpLog(3));
        const out = path.join(root, "out");
        const summary = await renderFrames(
          { ...base(out, { frames: [2, 9], fps: undefined }), timeline: { log } },
          session,
        );
        assert.equal(summary.ok, false);
        assert.deepEqual(summary.failed, [9]);
        assert.deepEqual(summary.skipped, []);
        const record = JSON.parse(readFileSync(summary.framesJson, "utf8"));
        assert.match(record.frames[1].error, /^\[timeline\]/);
        assert.ok(existsSync(path.join(out, "ours-f2.png")));
      });
    } finally {
      await rest.close();
    }
  });

  test("vite 不在：第一帧报 [vite]，剩下的帧不再试", async () => {
    await withSession(await deadPort(), async (session, root) => {
      const out = path.join(root, "out");
      const summary = await renderFrames(base(out, { frames: [1, 2, 3] }), session);
      assert.equal(summary.ok, false);
      assert.deepEqual(summary.failed, [1]);
      assert.deepEqual(summary.skipped, [2, 3]);
      const record = JSON.parse(readFileSync(summary.framesJson, "utf8"));
      assert.match(record.frames[0].error, /^\[vite\]/);
      assert.match(record.frames[1].error, /没试/);
    });
  });
});
