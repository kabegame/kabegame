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
import { frLine, frScriptValue, readbackLines, summarizeCorners, videoLine } from "./tools.ts";
import { frColor } from "./timeline.ts";
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
    // 读回画布（第 5 批）：给了 canvas 时像新探针那样按它回尺寸
    const { canvas, scriptValues, imageId, videoTime } = body as {
      canvas?: [number, number];
      scriptValues?: Array<Record<string, unknown>>;
      imageId?: string;
      videoTime?: number | Record<string, number>;
    };
    let meta: Record<string, unknown> = canvas
      ? { ...META, width: canvas[0], height: canvas[1], canvas, sceneTarget: [3840, 2160] }
      : META;
    // 脚本值（第 6 批）：像新探针那样逐项回结果；图片 8 当作不是 kbp 工程（没有 FR，optional 跳过）
    if (scriptValues) {
      meta = {
        ...meta,
        scriptValues: scriptValues.map((v) =>
          imageId === "8"
            ? { ...v, object: null, name: null, applied: false, reason: '没有叫 "FR" 的图层' }
            : { ...v, object: 0, name: "FR", applied: true },
        ),
      };
    }
    // 视频时刻（P9a 步骤 3）：给了 videoTime 时像新探针那样回每段视频实际取的时刻（时长 2.5 s 循环）；图片 7 当作一段解码失败
    if (videoTime !== undefined) {
      const at = (path: string) => (typeof videoTime === "number" ? videoTime : (videoTime[path] ?? 0)) % 2.5;
      meta = {
        ...meta,
        videos:
          imageId === "7"
            ? [
                {
                  path: "materials/v.tex",
                  time: at("materials/v.tex"),
                  duration: null,
                  width: 0,
                  height: 0,
                  failed: true,
                  error: "解码失败：MediaError 4",
                },
              ]
            : ["materials/v.tex", "materials/w.tex"].map((path) => ({
                path,
                time: at(path),
                duration: 2.5,
                width: 1280,
                height: 720,
                failed: false,
              })),
      };
    }
    return sendJson(res, 200, { meta, png: Buffer.from(PNG).toString("base64"), pngSha256: "file", pngBytes: 1 });
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
  test("replay 与 time 互斥；pointer 与时间线的逐帧光标互斥；window 要跟着光标；都在发请求之前报 [local]", async () => {
    await withMcp(async (call, _root, rest) => {
      const both = await call("render_scene", { imageId: "9", time: 1.5, replay: { timeline: TIMELINE } });
      assert.equal(both.isError, true);
      assert.match(textOf(both), /^\[local\].*\n.*replay 与 time 不能同时给/);
      for (const timeline of [
        { ...TIMELINE, cursors: "track" },
        { ...TIMELINE, cursor: [0.5, 0.5] },
      ]) {
        const clash = await call("render_scene", { imageId: "9", pointer: [0.25, 0.75], replay: { timeline } });
        assert.equal(clash.isError, true);
        assert.match(textOf(clash), /^\[local\][\s\S]*pointer 与时间线的逐帧光标.*不能同时给/);
      }
      const lonely = await call("particle_corners", {
        imageId: "9",
        replay: { timeline: { ...TIMELINE, window: [1920, 800] } },
        out: "c.json",
      });
      assert.match(textOf(lonely), /^\[local\][\s\S]*timeline\.window 要和逐帧光标（cursors 或 cursor）一起给/);
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
      // 没给逐帧光标：请求体不带 pointers / window；回放缺省涂 FR（第 6 批）
      assert.deepEqual(Object.keys(body).sort(), ["imageId", "particles", "scriptValues"]);
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
      assert.deepEqual(bodiesOf(rest, "/hosts/h-7/render"), [
        {
          imageId: "9",
          particles,
          scriptValues: [{ object: "FR", field: "color", value: [2 / 255, 0, 1], optional: true }],
        },
      ]);
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

describe("读回画布（第 5 批）", () => {
  /** 三列日志，标签末尾带窗口 1920×800：时间线推得出窗口。 */
  const WINDOW_LOG = "out/c5-fps20-1920x800-log.txt";
  const cursors = Array.from({ length: 4 }, (_, i) => [0.1 * (i + 1), 0.5]);

  test("canvas 原样转给 REST；结果写明读回的是画布还是场景目标；host_render 同样转", async () => {
    await withMcp(async (call, _root, rest) => {
      const result = await call("render_scene", { imageId: "9", canvas: [1920, 1080] });
      assert.notEqual(result.isError, true, textOf(result));
      assert.deepEqual(bodiesOf(rest, "/render"), [{ imageId: "9", canvas: [1920, 1080] }]);
      assert.match(
        textOf(result),
        /读回：画布 1920×1080，场景目标 3840×2160 按 fill（居中盖满裁切）铺进去，同产品上屏/,
      );
      assert.doesNotMatch(textOf(result), /提示：/);

      const plain = await call("render_scene", { imageId: "9" });
      assert.deepEqual(bodiesOf(rest, "/render")[1], { imageId: "9" }, "不给 canvas 时请求和以前一样");
      assert.match(textOf(plain), /读回：场景目标 1×1（没给 canvas，不经过上屏）/);

      const host = await call("host_render", { handle: "h-7", imageId: "9", canvas: [1080, 1080], time: 2 });
      assert.notEqual(host.isError, true, textOf(host));
      assert.deepEqual(bodiesOf(rest, "/hosts/h-7/render"), [{ imageId: "9", canvas: [1080, 1080], time: 2 }]);
      assert.match(textOf(host), /读回：画布 1080×1080，场景目标 3840×2160/);
    });
  });

  test("和时间线交给探针的窗口不同报 [local]、不开宿主；相同时 window 与 canvas 一起转", async () => {
    await withMcp(async (call, root, rest) => {
      writeFileSync(path.join(root, WINDOW_LOG), kbpLog(4));
      const timeline = { log: WINDOW_LOG, frame: 4, cursors };
      const clash = await call("render_scene", { imageId: "9", canvas: [1280, 720], replay: { timeline } });
      assert.equal(clash.isError, true);
      assert.match(
        textOf(clash),
        /^\[local\][\s\S]*canvas 1280×720 和时间线交给探针的窗口 1920×800 不同[\s\S]*传 canvas: \[1920, 800\]/,
      );
      const hostClash = await call("host_render", {
        handle: "h-7",
        imageId: "9",
        canvas: [1920, 801],
        replay: { timeline: { ...timeline, window: [1920, 800] } },
      });
      assert.match(textOf(hostClash), /^\[local\][\s\S]*canvas 1920×801 和时间线交给探针的窗口 1920×800 不同/);
      assert.deepEqual(rest.seen, [], "冲突时不开宿主、不发请求");

      const same = await call("render_scene", { imageId: "9", canvas: [1920, 800], replay: { timeline } });
      assert.notEqual(same.isError, true, textOf(same));
      const [body] = bodiesOf(rest, "/render");
      assert.deepEqual(body.canvas, [1920, 800]);
      assert.deepEqual(body.window, [1920, 800]);
      assert.deepEqual(body.pointers, cursors);
      assert.doesNotMatch(textOf(same), /提示：/);

      // 没给逐帧光标：窗口不交给探针（同第 4 批），canvas 和推出来的窗口不同也不报错
      const noCursor = await call("render_scene", {
        imageId: "9",
        canvas: [1280, 720],
        replay: { timeline: { log: WINDOW_LOG, frame: 4 } },
      });
      assert.notEqual(noCursor.isError, true, textOf(noCursor));
      const last = bodiesOf(rest, "/render").at(-1)!;
      assert.deepEqual(last.canvas, [1280, 720]);
      assert.equal("window" in last, false);
    });
  });

  test("没给 canvas、时间线推得出窗口而读回尺寸不同：提示该传的 canvas", async () => {
    await withMcp(async (call, root) => {
      writeFileSync(path.join(root, WINDOW_LOG), kbpLog(4));
      const result = await call("render_scene", { imageId: "9", replay: { timeline: { log: WINDOW_LOG, frame: 4 } } });
      assert.notEqual(result.isError, true, textOf(result));
      assert.match(
        textOf(result),
        /提示：时间线的窗口是 1920×800，读回的是 1×1；要和这次 WPE 抓帧逐像素比、不用再缩放，传 canvas: \[1920, 800\]/,
      );
      // 推不出窗口（标签里没有尺寸）：不提示
      const unknown = await call("render_scene", { imageId: "9", replay: { timeline: TIMELINE } });
      assert.doesNotMatch(textOf(unknown), /提示：/);
    });
  });

  test("canvas 的形状由 SDK 参数校验拒绝：非整数、0、超过 16384、长度不对", async () => {
    await withMcp(async (call, _root, rest) => {
      for (const canvas of [[1920.5, 1080], [0, 1080], [16385, 1080], [1920], "1920x1080"]) {
        const bad = await call("render_scene", { imageId: "9", canvas });
        assert.equal(bad.isError, true, JSON.stringify(canvas));
      }
      assert.deepEqual(rest.seen, [], "参数错时不发请求");
    });
  });

  test("readbackLines：旧宿主产物没有 canvas / sceneTarget 时按场景目标；读回尺寸等于窗口时不提示", () => {
    assert.deepEqual(readbackLines({ width: 3840, height: 2160 }, undefined, null), [
      "读回：场景目标 3840×2160（没给 canvas，不经过上屏）",
    ]);
    assert.deepEqual(
      readbackLines({ width: 1920, height: 1080, canvas: null, sceneTarget: [1920, 1080] }, undefined, [1920, 1080]),
      ["读回：场景目标 1920×1080（没给 canvas，不经过上屏）"],
    );
    const hint = readbackLines(
      { width: 3840, height: 2160, canvas: null, sceneTarget: [3840, 2160] },
      undefined,
      [1920, 1080],
    );
    assert.equal(hint.length, 2);
    assert.match(hint[1], /传 canvas: \[1920, 1080\]/);
    // 给了 canvas 就不提示（哪怕和窗口不同：冲突在发请求前已经拦下）
    assert.equal(
      readbackLines(
        { width: 1280, height: 720, canvas: [1280, 720], sceneTarget: [3840, 2160] },
        [1280, 720],
        [1920, 1080],
      ).length,
      1,
    );
  });
});

describe("FR 帧号块（第 6 批）", () => {
  const fr = (frame: number) => ({ object: "FR", field: "color", value: frColor(frame), optional: true });

  test("frColor：同 gen.py 的 FR_COLOR（N = 1、255、256、941、65535、65536），8 位值就是 (N % 256, ⌊N / 256⌋ % 256, 255)", () => {
    assert.deepEqual(frColor(1), [1 / 255, 0, 1]);
    assert.deepEqual(frColor(255), [1, 0, 1]);
    assert.deepEqual(frColor(256), [0, 1 / 255, 1]);
    assert.deepEqual(frColor(941), [173 / 255, 3 / 255, 1]);
    for (const [n, rgb] of [
      [1, [1, 0, 255]],
      [255, [255, 0, 255]],
      [256, [0, 1, 255]],
      [941, [173, 3, 255]],
      [65535, [255, 255, 255]],
      [65536, [0, 0, 255]],
    ] as const) {
      assert.deepEqual(
        frColor(n).map((v) => Math.round(Math.fround(v) * 255)),
        rgb,
        `第 ${n} 帧`,
      );
    }
  });

  test("回放缺省涂 FR：两种回放写法都发，N = 回放的帧数；结果写一行涂成什么", async () => {
    await withMcp(async (call, _root, rest) => {
      const timeline = await call("render_scene", { imageId: "9", replay: { timeline: TIMELINE } });
      assert.notEqual(timeline.isError, true, textOf(timeline));
      assert.deepEqual(bodiesOf(rest, "/render")[0].scriptValues, [fr(5)]);
      assert.match(textOf(timeline), /FR 涂成第 5 帧的颜色 \(5, 0, 255\) \/ 255（objects\[0\]）/);

      const dts = Array(941).fill(1 / 60);
      const direct = await call("host_render", { handle: "h-7", imageId: "9", replay: { particles: { dts } } });
      assert.notEqual(direct.isError, true, textOf(direct));
      assert.deepEqual(bodiesOf(rest, "/hosts/h-7/render")[0].scriptValues, [fr(941)]);
      assert.match(textOf(direct), /FR 涂成第 941 帧的颜色 \(173, 3, 255\) \/ 255（objects\[0\]）/);

      // fr: true 同缺省；时间线回放到第 3 帧（frame 截短）
      await call("render_scene", { imageId: "9", replay: { timeline: { ...TIMELINE, frame: 3 }, fr: true } });
      assert.deepEqual(bodiesOf(rest, "/render").at(-1)!.scriptValues, [fr(3)]);
    });
  });

  test("replay.fr: false 不发、结果写明没涂；不给 replay 时不发、不写这一行", async () => {
    await withMcp(async (call, _root, rest) => {
      const off = await call("render_scene", { imageId: "9", replay: { timeline: TIMELINE, fr: false } });
      assert.notEqual(off.isError, true, textOf(off));
      assert.equal("scriptValues" in bodiesOf(rest, "/render")[0], false);
      assert.match(textOf(off), /FR：没涂（replay\.fr: false）/);
      const offDirect = await call("host_render", {
        handle: "h-7",
        imageId: "9",
        replay: { particles: { dts: [0.1] }, fr: false },
      });
      assert.equal("scriptValues" in bodiesOf(rest, "/hosts/h-7/render")[0], false);
      assert.match(textOf(offDirect), /FR：没涂/);

      const plain = await call("render_scene", { imageId: "9", time: 2 });
      assert.deepEqual(bodiesOf(rest, "/render").at(-1), { imageId: "9", time: 2 });
      assert.doesNotMatch(textOf(plain), /FR/);
    });
  });

  test("不是 kbp 工程：探针跳过，结果写明没涂；particle_corners 不收 fr", async () => {
    await withMcp(async (call, _root, rest) => {
      const skipped = await call("render_scene", { imageId: "8", replay: { timeline: TIMELINE } });
      assert.notEqual(skipped.isError, true, textOf(skipped));
      assert.match(textOf(skipped), /FR：场景里没有挂颜色脚本的 FR，没涂（没有叫 "FR" 的图层）/);
      const before = rest.seen.length;
      const corners = await call("particle_corners", {
        imageId: "9",
        replay: { timeline: TIMELINE, fr: false },
        out: "c.json",
      });
      assert.equal(corners.isError, true, "四角不渲染，replay 里没有 fr，SDK 参数校验拒绝");
      assert.equal(rest.seen.length, before);
    });
  });

  test("frScriptValue / frLine：fr 为 false 时不发；宿主没回 scriptValues 时说明", () => {
    assert.equal(frScriptValue(false, 9), null);
    assert.deepEqual(frScriptValue(undefined, 9), fr(9));
    assert.deepEqual(frScriptValue(true, 256), fr(256));
    assert.equal(frLine(null, {}), null);
    assert.equal(frLine(false, {}), "FR：没涂（replay.fr: false）");
    assert.match(frLine({ frame: 4 }, {})!, /宿主没回 scriptValues/);
    assert.equal(
      frLine(
        { frame: 941 },
        { scriptValues: [{ object: 0, name: "FR", field: "color", value: frColor(941), applied: true }] },
      ),
      "FR 涂成第 941 帧的颜色 (173, 3, 255) / 255（objects[0]）",
    );
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

  test("逐帧光标（P5a 收尾）：时间线的光标作 pointers / cursors 连同 window 交给后端", async () => {
    await withMcp(async (call, root, rest) => {
      // 五列日志：第 1..6 帧，每帧 0.1 s，屏幕光标逐帧不同（第 3 帧读失败写 nan）；窗口从标签读 1920×800
      const screens: [number | string, number | string][] = [
        [960, 400],
        [192, 80],
        ["nan", "nan"],
        [1920, 800],
        [-96, 1000],
        [480, 200],
      ];
      writeFileSync(
        path.join(root, "out", "p5a-cur-fps20-1920x800-log.txt"),
        `x: [kbp] ${screens.map(([sx, sy], i) => `${i + 1},0.100000,${((i + 1) * 0.1).toFixed(6)},${sx},${sy}`).join(" ")}\n`,
      );
      const W: [number, number] = [1920, 800];
      const at = (i: number) => [Math.fround(Number(screens[i][0]) / W[0]), Math.fround(Number(screens[i][1]) / W[1])];
      writeFileSync(
        path.join(root, "tracks", "rd-p5a-cur-fps20-1920x800.json"),
        JSON.stringify({
          tag: "p5a-cur-fps20-1920x800",
          frames: [
            { frame: 4, dt: 0.25, time: 0.45, pointer: at(3), systems: {} },
            // 和日志对不上：照给，结果里写警告
            { frame: 5, dt: 0.25, time: 0.55, pointer: [0.5, 0.5], systems: {} },
          ],
        }),
      );
      const timeline = {
        log: "out/p5a-cur-fps20-1920x800-log.txt",
        track: "tracks/rd-p5a-cur-fps20-1920x800.json",
        cursors: "log",
      };
      const expected = [at(0), at(1), at(1), at(3), at(4)];

      const render = await call("render_scene", { imageId: 9, replay: { timeline } });
      assert.notEqual(render.isError, true, textOf(render));
      const [body] = bodiesOf(rest, "/render");
      assert.deepEqual(body.pointers, expected);
      assert.deepEqual(body.window, [1920, 800]);
      assert.equal("pointer" in body, false);
      assert.equal((body.particles as { passes: number }).passes, 2);
      const text = textOf(render);
      assert.match(
        text,
        /逐帧光标：取日志（屏幕光标 ÷ 窗口 1920×800（轨迹标签），float32），日志缺光标、沿用相邻帧的 3/,
      );
      assert.match(text, /核对 2 帧，最大差 [\d.]+\n警告：第 5 帧日志光标和轨迹 pointer 不同/);

      const corners = await call("particle_corners", {
        imageId: 9,
        replay: { timeline: { ...timeline, cursors: "track", window: [1440, 1080] } },
        out: "c.json",
      });
      assert.notEqual(corners.isError, true, textOf(corners));
      const [cornersBody] = bodiesOf(rest, "/particle-corners");
      assert.deepEqual(cornersBody.pointers, [[0.5, 0.5], [0.5, 0.5], [0.5, 0.5], at(3), [0.5, 0.5]]);
      assert.deepEqual(cornersBody.window, [1440, 1080]);
      assert.match(textOf(corners), /窗口 1440×1080（参数给的），探针按 fill 换到场景上/);

      const track = await call("particle_track", { imageId: 9, timeline, out: "sim/cur.json" });
      assert.notEqual(track.isError, true, textOf(track));
      const [trackBody] = bodiesOf(rest, "/particle-track");
      assert.deepEqual(trackBody.cursors, expected);
      assert.deepEqual(trackBody.window, [1920, 800]);
      assert.equal("pointers" in trackBody, false);

      // 日志带光标列、没要逐帧光标：请求不带光标与窗口，结果里提示一句
      const plain = await call("particle_track", {
        imageId: 9,
        timeline: { log: timeline.log, track: timeline.track },
        out: "sim/plain.json",
      });
      assert.notEqual(plain.isError, true, textOf(plain));
      const plainBody = bodiesOf(rest, "/particle-track").at(-1)!;
      assert.equal("cursors" in plainBody, false);
      assert.equal("window" in plainBody, false);
      assert.match(textOf(plain), /日志带光标列，要按每一帧的光标回放传 cursors: "log"/);

      // 只给 cursor：每帧都是它；标签里没有窗口尺寸时不带 window
      const fixed = await call("host_render", {
        handle: "h-7",
        imageId: 9,
        replay: { timeline: { ...TIMELINE, cursor: [0.2, 0.3] } },
      });
      assert.notEqual(fixed.isError, true, textOf(fixed));
      const [fixedBody] = bodiesOf(rest, "/hosts/h-7/render");
      assert.deepEqual(
        fixedBody.pointers,
        Array.from({ length: 5 }, () => [0.2, 0.3]),
      );
      assert.equal("window" in fixedBody, false);

      // "log" 要五列日志：三列报 [timeline]，不发请求
      const before = rest.seen.length;
      const three = await call("render_scene", { imageId: 9, replay: { timeline: { ...TIMELINE, cursors: "log" } } });
      assert.match(textOf(three), /^\[timeline\][\s\S]*这份日志是三列/);
      assert.equal(rest.seen.length, before);
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

describe("视频时刻（P9a 步骤 3）", () => {
  test("videoTime 原样转给 REST（0 也转）；结果写一行每段实际取的时刻；host_render 同样转、回放时也带", async () => {
    await withMcp(async (call, _root, rest) => {
      const result = await call("render_scene", { imageId: "9", videoTime: 3.5 });
      assert.notEqual(result.isError, true, textOf(result));
      assert.deepEqual(bodiesOf(rest, "/render"), [{ imageId: "9", videoTime: 3.5 }]);
      assert.match(
        textOf(result),
        /视频纹理：materials\/v\.tex 取 1 s（时长 2\.5 s，1280×720）；materials\/w\.tex 取 1 s（时长 2\.5 s，1280×720）/,
      );

      const zero = await call("render_scene", { imageId: "9", videoTime: 0 });
      assert.notEqual(zero.isError, true, textOf(zero));
      assert.deepEqual(bodiesOf(rest, "/render")[1], { imageId: "9", videoTime: 0 });

      const plain = await call("render_scene", { imageId: "9" });
      assert.deepEqual(bodiesOf(rest, "/render")[2], { imageId: "9" }, "不给 videoTime 时请求和以前一样");
      assert.doesNotMatch(textOf(plain), /视频纹理/);

      const byPath = { "materials/v.tex": 2, "materials/w.tex": 3 };
      const host = await call("host_render", {
        handle: "h-7",
        imageId: "9",
        videoTime: byPath,
        replay: { particles: { dts: [0.1, 0.1] }, fr: false },
      });
      assert.notEqual(host.isError, true, textOf(host));
      const [body] = bodiesOf(rest, "/hosts/h-7/render");
      assert.deepEqual(body.videoTime, byPath);
      assert.deepEqual(body.particles, { dts: [0.1, 0.1] });
      assert.match(textOf(host), /materials\/v\.tex 取 2 s.*materials\/w\.tex 取 0\.5 s/);
    });
  });

  test("解码失败的视频：结果写明保持透明与原因", async () => {
    await withMcp(async (call) => {
      const result = await call("render_scene", { imageId: "7", videoTime: 1 });
      assert.notEqual(result.isError, true, textOf(result));
      assert.match(textOf(result), /视频纹理：materials\/v\.tex 读 \/ 解码失败、保持透明（解码失败：MediaError 4）/);
    });
  });

  test("videoTime 的形状由 SDK 参数校验拒绝：负数、字符串、数组、对象里的负数、空键", async () => {
    await withMcp(async (call, _root, rest) => {
      for (const videoTime of [-1, "1.5", [1.5], { "materials/v.tex": -0.5 }, { "materials/v.tex": "2" }, { "": 1 }]) {
        const bad = await call("render_scene", { imageId: "9", videoTime });
        assert.equal(bad.isError, true, JSON.stringify(videoTime));
      }
      assert.equal(bodiesOf(rest, "/render").length, 0, "参数错时不发请求");
    });
  });

  test("videoLine：没有视频纹理或宿主产物没回 videos 时不写", () => {
    assert.equal(videoLine({}), null);
    assert.equal(videoLine({ videos: [] }), null);
    assert.equal(
      videoLine({
        videos: [{ path: "materials/v.tex", time: 0.75, duration: null, width: 640, height: 360, failed: false }],
      }),
      "视频纹理：materials/v.tex 取 0.75 s（时长 ? s，640×360）",
    );
  });
});
