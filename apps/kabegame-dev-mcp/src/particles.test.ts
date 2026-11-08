/**
 * 粒子回放、轨迹与四角（第 4 批）的协议层单测：SDK 的 Client + InMemoryTransport 连 `createDevMcpServer`，背后是假的 REST。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Buffer } from "node:buffer";
import { createClient } from "./client.ts";
import { createDevMcpServer } from "./main.ts";
import { summarizeCorners } from "./tools.ts";
import type { DevMcpDeps } from "./tools.ts";
import { Client, InMemoryTransport } from "./testdata/sdkClient.ts";
import { PNG, fakeRest, sendJson } from "./testdata/fakeRest.ts";
import type { Handler } from "./testdata/fakeRest.ts";

type ToolResult = {
  isError?: boolean;
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
};

const textOf = (result: ToolResult) =>
  result.content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");

/** WPE 日志：第 1..n 帧，每帧 0.1 s（6 位小数）。 */
const kbpLog = (n: number) =>
  `x: [kbp] ${Array.from({ length: n }, (_, i) => `${i + 1},0.100000,${((i + 1) * 0.1).toFixed(6)}`).join(" ")}\n`;

/** RenderDoc 轨迹（带 Python 写出的 NaN）。 */
const trackJson = (tag: string, frames: number[]) =>
  JSON.stringify({
    source: "renderdoc",
    tag,
    frames: frames.map((frame) => ({
      frame,
      dt: 0.25,
      time: frame * 0.1 + 0.05,
      pointer: [1.5, 0.25],
      systems: {},
      corners: [null],
    })),
  }).replace(/null/g, "NaN");

const META = { width: 1, height: 1, sha256: "pix", time: 0.4, frametime: 0.25, particles: [{ name: "P", alive: 3 }] };

/** 假 REST：开宿主、渲染、轨迹、四角、关宿主。 */
const handler: Handler = (req, body, res) => {
  const url = req.url ?? "";
  if (req.method === "POST" && url.endsWith("/hosts")) {
    return sendJson(res, 200, { handle: "h-1", instance: "i", scene: "9", entry: "index-A.js", hidden: true });
  }
  if (req.method === "DELETE") return sendJson(res, 200, { handle: "h-1", previewHostsLeft: 0 });
  if (url.endsWith("/render")) {
    return sendJson(res, 200, { meta: META, png: Buffer.from(PNG).toString("base64"), pngSha256: "file", pngBytes: 1 });
  }
  if (url.endsWith("/particle-track")) {
    const request = body as { frames: number[]; tag?: string };
    return sendJson(res, 200, {
      source: "sim",
      project: "p4c-cp",
      tag: request.tag ?? "",
      frames: request.frames.map((frame) => ({
        frame,
        dt: 0.25,
        systems: { "cp-angles": [{ pos: [99.5, 0, 0] }, { pos: [100.25, -2, 0] }], empty: [] },
      })),
      skipped: {},
    });
  }
  if (url.endsWith("/particle-corners")) {
    return sendJson(res, 200, [
      {
        object: 10,
        name: "persp",
        perspective: true,
        drawn: true,
        count: 5,
        uv: [
          [0, 0],
          [0, 1],
          [1, 1],
          [1, 0],
        ],
        corners: [[[0, 0, 0, 1]]],
        pixels: Array.from({ length: 4 }, (_, i) => [
          [950 + i, 530],
          [950 + i, 550],
          [970 + i, 550],
          [970 + i, 530],
        ]),
        particles: [],
      },
    ]);
  }
  sendJson(res, 404, { error: "x", layer: "rest" });
};

type Rest = Awaited<ReturnType<typeof fakeRest>>;

async function withMcp(
  run: (
    call: (name: string, args?: Record<string, unknown>) => Promise<ToolResult>,
    root: string,
    rest: Rest,
  ) => Promise<void>,
) {
  const rest = await fakeRest(handler);
  const root = mkdtempSync(path.join(os.tmpdir(), "kbdev-particles-"));
  const deps: DevMcpDeps = {
    client: createClient({ port: rest.port }),
    root,
    logDir: path.join(root, "logs"),
    log: () => {},
  };
  const server = createDevMcpServer(deps);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "kbdev-test", version: "0" });
  await client.connect(clientTransport);
  mkdirSync(path.join(root, "out"), { recursive: true });
  mkdirSync(path.join(root, "tracks"), { recursive: true });
  writeFileSync(path.join(root, "out", "p4b-fps10-log.txt"), kbpLog(6));
  writeFileSync(path.join(root, "out", "p4c-cp-fps60-log.txt"), kbpLog(6));
  writeFileSync(path.join(root, "out", "s15-log.txt"), kbpLog(6));
  writeFileSync(path.join(root, "out", "short-log.txt"), kbpLog(2));
  writeFileSync(path.join(root, "tracks", "rd-p4c-cp-fps60.json"), trackJson("p4c-cp-fps60", [4, 5]));
  // 日志只到第 2 帧（g_Time 0.2）、轨迹第 4 帧 g_Time 0.45、dt 0.2：第 3 帧缺，结束时刻 0.25，平分 0.05
  writeFileSync(
    path.join(root, "tracks", "rd-short.json"),
    JSON.stringify({ tag: "short", frames: [{ frame: 4, dt: 0.2, time: 0.45, systems: {} }] }),
  );
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    (await client.callTool({ name, arguments: args })) as ToolResult;
  try {
    await run(call, root, rest);
  } finally {
    await client.close();
    await server.close();
    await rest.close();
    rmSync(root, { recursive: true, force: true });
  }
}

const bodiesOf = (rest: Rest, suffix: string) =>
  rest.seen.filter((r) => r.path.endsWith(suffix)).map((r) => r.body as Record<string, unknown>);

const TIMELINE = { log: "out/p4c-cp-fps60-log.txt", track: "tracks/rd-p4c-cp-fps60.json" };

describe("粒子回放", () => {
  test("replay 与 time 互斥；渲染与四角不收逐帧光标；都在发请求之前报 [local]", async () => {
    await withMcp(async (call, _root, rest) => {
      const both = await call("render_scene", { imageId: "9", time: 1.5, replay: { timeline: TIMELINE } });
      assert.equal(both.isError, true);
      assert.match(textOf(both), /^\[local\].*\n.*replay 与 time 不能同时给/);
      const cursors = await call("render_scene", {
        imageId: "9",
        replay: { timeline: { ...TIMELINE, cursors: "track" } },
      });
      assert.match(textOf(cursors), /render_scene 不收逐帧光标.*pointer/);
      const corners = await call("particle_corners", {
        imageId: "9",
        replay: { timeline: { ...TIMELINE, cursor: [0.5, 0.5] } },
        out: "c.json",
      });
      assert.match(textOf(corners), /particle_corners 不收逐帧光标.*场景中心/);
      const host = await call("host_render", {
        handle: "h-1",
        imageId: "9",
        time: 1,
        replay: { particles: { dts: [0.1] } },
      });
      assert.match(textOf(host), /replay 与 time 不能同时给/);
      const bad = await call("render_scene", { imageId: "9", replay: { particles: { dts: [] } } });
      assert.equal(bad.isError, true, "SDK 参数校验拒绝空 dts");
      assert.deepEqual(rest.seen, [], "参数错时不发请求");
    });
  });

  test("render_scene 带 timeline：REST 收到时间线的 dts / times；passes 从标签推，参数给的优先", async () => {
    await withMcp(async (call, _root, rest) => {
      const result = await call("render_scene", { imageId: 9, replay: { timeline: TIMELINE, seed: 3 } });
      assert.notEqual(result.isError, true, textOf(result));
      const [body] = bodiesOf(rest, "/render");
      assert.equal(body.imageId, "9");
      assert.equal("time" in body, false);
      assert.deepEqual(body.particles, {
        dts: [0.1, 0.1, 0.1, 0.25, 0.25],
        times: [0.1, 0.2, 0.3, 0.45, 0.55],
        passes: 1,
        seed: 3,
      });
      const text = textOf(result);
      assert.match(text, /时间线：回放 5 帧（第 1–5 帧）；抓到的帧 4–5（dt、g_Time 取轨迹的）；没有平分的帧/);
      assert.match(text, /passes 1（标签 p4c-cp-fps60 的 fps60/);
      assert.match(text, /读回那一帧 g_Time 0\.4，g_Frametime 0\.25/);
      assert.match(text, /粒子层存活数：P 3/);
      assert.match(text, /已关宿主 h-1/);

      await call("render_scene", { imageId: 9, replay: { timeline: { log: "out/p4b-fps10-log.txt", frame: 3 } } });
      assert.equal((bodiesOf(rest, "/render")[1].particles as { passes: number }).passes, 2);
      const unknown = await call("render_scene", {
        imageId: 9,
        replay: { timeline: { log: "out/s15-log.txt", frame: 3 } },
      });
      assert.match(textOf(unknown), /passes 1（标签 s15 里推不出 fps/);
      assert.equal((bodiesOf(rest, "/render")[2].particles as { passes: number }).passes, 1);
      await call("render_scene", {
        imageId: 9,
        replay: { timeline: { log: "out/p4b-fps10-log.txt", frame: 3 }, passes: 1 },
      });
      assert.equal((bodiesOf(rest, "/render")[3].particles as { passes: number }).passes, 1);

      // 直接给 particles：原样转给 REST；host_render 不开也不关宿主
      const particles = { dts: [0.1, 0.2], times: [0.1, 0.3], seed: 2, passes: 2, random: { "3": [0.5] } };
      const direct = await call("host_render", { handle: "h-7", imageId: "9", replay: { particles } });
      assert.notEqual(direct.isError, true, textOf(direct));
      assert.deepEqual(bodiesOf(rest, "/hosts/h-7/render"), [{ imageId: "9", particles }]);
      assert.match(textOf(direct), /回放：直接给的 2 帧 dt（带 times）；seed 2；passes 2；random 顶替 3 号对象的 R/);
      assert.equal(rest.seen.filter((r) => r.method === "POST" && r.path.endsWith("/hosts")).length, 4);
    });
  });

  test("时间线出错报 [timeline]：缺帧（split 后可用）、frame 超出、文件不在", async () => {
    await withMcp(async (call, _root, rest) => {
      const missing = await call("render_scene", {
        imageId: 9,
        replay: { timeline: { log: "out/short-log.txt", track: "tracks/rd-short.json" } },
      });
      assert.match(textOf(missing), /^\[timeline\] 时间线.*\n.*第 3 帧日志与轨迹都没有.*gap: "split"/);
      const split = await call("render_scene", {
        imageId: 9,
        replay: { timeline: { log: "out/short-log.txt", track: "tracks/rd-short.json", gap: "split" } },
      });
      assert.notEqual(split.isError, true, textOf(split));
      assert.match(textOf(split), /平分的帧 3（合计 0\.050000 s，每帧 0\.05）/);
      const particles = bodiesOf(rest, "/render")[0].particles as { dts: number[]; times: number[] };
      assert.deepEqual(particles.dts, [0.1, 0.1, 0.05, 0.2]);
      assert.ok(Math.abs(particles.times[2] - 0.25) < 1e-12);
      assert.equal(particles.times[3], 0.45);
      // 时钟对不上（平分的时长不是正数）也报 [timeline]
      const clash = await call("render_scene", {
        imageId: 9,
        replay: { timeline: { log: "out/short-log.txt", track: TIMELINE.track, gap: "split" } },
      });
      assert.match(textOf(clash), /^\[timeline\][\s\S]*第 3 帧要平分的时长不是正数/);
      const beyond = await call("render_scene", {
        imageId: 9,
        replay: { timeline: { log: "out/short-log.txt", frame: 9 } },
      });
      assert.match(textOf(beyond), /^\[timeline\][\s\S]*frame 9 超出日志与轨迹/);
      const nofile = await call("render_scene", {
        imageId: 9,
        replay: { timeline: { log: "out/none.txt", frame: 1 } },
      });
      assert.match(textOf(nofile), /^\[timeline\][\s\S]*读不了日志/);
      assert.equal(bodiesOf(rest, "/render").length, 1, "出错的调用不发渲染请求");
      assert.equal(rest.seen.filter((r) => r.method === "POST" && r.path.endsWith("/hosts")).length, 1, "也不开宿主");
    });
  });
});

describe("轨迹与四角", () => {
  test("particle_track：开宿主、转参数、关宿主、写 out、回摘要；frames 缺省为抓到的帧", async () => {
    await withMcp(async (call, root, rest) => {
      const result = await call("particle_track", {
        imageId: "9",
        timeline: { ...TIMELINE, cursors: "track" },
        out: "sim/sim-cp.json",
      });
      assert.notEqual(result.isError, true, textOf(result));
      assert.deepEqual(bodiesOf(rest, "/hosts/h-1/particle-track"), [
        {
          imageId: "9",
          dts: [0.1, 0.1, 0.1, 0.25, 0.25],
          times: [0.1, 0.2, 0.3, 0.45, 0.55],
          frames: [4, 5],
          passes: 1,
          cursors: [
            [0.5, 0.5],
            [0.5, 0.5],
            [0.5, 0.5],
            [1.5, 0.25],
            [1.5, 0.25],
          ],
          tag: "p4c-cp-fps60",
        },
      ]);
      assert.deepEqual(
        rest.seen.map((r) => `${r.method} ${r.path.replace(/^\/__kabegame_dev/, "")}`),
        ["POST /hosts", "POST /hosts/h-1/particle-track", "DELETE /hosts/h-1"],
      );
      const written = JSON.parse(readFileSync(path.join(root, "sim/sim-cp.json"), "utf8"));
      assert.equal(written.source, "sim");
      assert.deepEqual(
        written.frames.map((f: { frame: number }) => f.frame),
        [4, 5],
      );
      const text = textOf(result);
      assert.match(text, /^轨迹：p4c-cp（图片 9，标签 p4c-cp-fps60），2 帧（4–5）× 2 个系统/);
      assert.match(text, /逐帧光标：2 帧取轨迹 pointer，其余 \[0\.5,0\.5\]/);
      assert.match(text, /第 4 帧（dt 0\.25）：2 个系统有粒子，共 2 个/);
      assert.match(text, /cp-angles：2 个，x \[99\.5, 100\.25\] y \[-2, 0\] z 0/);
      assert.match(text, /empty：0 个，（空）/);

      const again = await call("particle_track", { imageId: "9", timeline: TIMELINE, out: "sim/sim-cp.json" });
      assert.match(textOf(again), /已存在/);
      const beyond = await call("particle_track", {
        imageId: "9",
        timeline: TIMELINE,
        frames: [5, 6],
        out: "sim/x.json",
      });
      assert.match(textOf(beyond), /^\[local\][\s\S]*第 6 帧超过时间线回放到的第 5 帧/);
      // 没有轨迹：frames 缺省为最后一帧；passes 从日志文件名推
      const plain = await call("particle_track", {
        imageId: "9",
        timeline: { log: "out/p4b-fps10-log.txt", frame: 6 },
        out: "sim/fps10.json",
      });
      assert.notEqual(plain.isError, true, textOf(plain));
      const last = bodiesOf(rest, "/particle-track").at(-1)!;
      assert.deepEqual(last.frames, [6]);
      assert.equal(last.passes, 2);
      assert.equal(last.tag, "p4b-fps10");
    });
  });

  test("particle_corners：转参数、写 out、摘要列前 3 个粒子的像素角；不给 replay 时是预热后的状态", async () => {
    await withMcp(async (call, root, rest) => {
      const dts = Array(720).fill(1 / 60);
      const result = await call("particle_corners", {
        imageId: "13815",
        replay: { particles: { dts, seed: 1, passes: 1 } },
        limit: 64,
        layer: "persp",
        out: "corners.json",
      });
      assert.notEqual(result.isError, true, textOf(result));
      assert.deepEqual(bodiesOf(rest, "/particle-corners"), [
        { imageId: "13815", particles: { dts, seed: 1, passes: 1 }, layer: "persp", limit: 64 },
      ]);
      const text = textOf(result);
      assert.match(text, /^四角：图片 13815，1 个粒子层/);
      assert.match(text, /层 10 persp（透视）：写进顶点 5 个，取了 1 个$/m);
      assert.match(text, /#0 像素角 \(950, 530\) \(950, 550\) \(970, 550\) \(970, 530\)/);
      assert.match(text, /#2 像素角 \(952, 530\)/);
      assert.doesNotMatch(text, /#3 像素角/);
      assert.equal(JSON.parse(readFileSync(path.join(root, "corners.json"), "utf8"))[0].name, "persp");
      const plain = await call("particle_corners", { imageId: "13815", out: "corners2.json" });
      assert.match(textOf(plain), /没有回放：预热后的状态/);
      assert.deepEqual(bodiesOf(rest, "/particle-corners").at(-1), { imageId: "13815" });
    });
  });

  test("四角摘要：drawn 为 false 的层标明渲染时不画（P4c 步骤 5，朝向是 NaN）", () => {
    const layer = {
      object: 3,
      name: "upright",
      perspective: false,
      drawn: false,
      count: 2,
      uv: [[0, 0]] as [number, number][],
      // 朝向是 NaN 时四角也是 NaN，经 JSON 传回成了 null
      corners: [[[null, null, null, null]]] as unknown as number[][][],
      pixels: [Array.from({ length: 4 }, () => [null, null])] as unknown as number[][][],
      particles: [],
    };
    const lines = summarizeCorners([layer, { ...layer, object: 4, name: "screen", drawn: true }]);
    assert.equal(lines[0], "层 3 upright（正交）：写进顶点 2 个，取了 1 个；这一层渲染时不画（朝向是 NaN），四角照算");
    assert.equal(lines[1], "  #0 像素角 (NaN, NaN) (NaN, NaN) (NaN, NaN) (NaN, NaN)");
    assert.equal(lines[2], "层 4 screen（正交）：写进顶点 2 个，取了 1 个");
  });
});
