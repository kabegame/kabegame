/**
 * 宿主任务的取回与粒子接口的参数透传：用 `node:vm` 造一个真的执行表达式的假 CDP（主窗口与宿主各一个上下文），
 * 宿主里放假探针，主窗口里放假 `__TAURI_INTERNALS__.invoke`。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { Buffer } from "node:buffer";
import { DevError } from "./errors.ts";
import { devPaths } from "./paths.ts";
import { DevSession } from "./session.ts";
import { hostTaskJson, particleCorners, particleTrack, renderFrame } from "./scene.ts";
import type { CdpConnection, CdpEvent, TargetInfo } from "./cdp.ts";

const TARGETS: TargetInfo[] = [
  { targetId: "M", type: "page", title: "", url: "http://localhost:1420/gallery", attached: false },
  {
    targetId: "H",
    type: "iframe",
    title: "",
    url: "file:///D:/k/target/debug/resources/wpe-scene/index.html?kbScene=1&kbInstance=inst-1",
    attached: false,
    parentId: "M",
  },
];

/** 一个页面上下文：`window` 就是全局对象。 */
function pageContext(globals: Record<string, unknown>): vm.Context {
  const context = vm.createContext({ performance, Blob, ...globals });
  vm.runInContext("globalThis.window = globalThis", context);
  return context;
}

/** 按 session 把表达式交给对应的上下文执行；值按 returnByValue 的样子过一遍 JSON。 */
function vmConnection(contexts: Record<string, vm.Context>): CdpConnection & { evaluated: string[] } {
  const evaluated: string[] = [];
  const handlers = new Set<(event: CdpEvent) => void>();
  return {
    url: "ws://fake",
    closed: false,
    evaluated,
    send: async <T>() => ({}) as T,
    on: (handler) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    onClose: () => () => {},
    targets: async () => TARGETS,
    attach: async (targetId) => `session-${targetId}`,
    detach: async () => {},
    evaluate: async (sessionId, expression) => {
      const targetId = sessionId.replace(/^session-/, "");
      evaluated.push(`${targetId}: ${expression.slice(0, 80)}`);
      let value = vm.runInContext(expression, contexts[targetId]);
      if (value && typeof (value as { then?: unknown }).then === "function") value = await value;
      return { value: value === undefined ? null : JSON.parse(JSON.stringify(value)), type: typeof value };
    },
    close: () => {},
  };
}

interface Fixture {
  s: DevSession;
  conn: ReturnType<typeof vmConnection>;
  host: vm.Context;
  probeCalls: Array<{ name: string; args: unknown }>;
  invokes: Array<{ command: string; args: unknown }>;
}

/** 已开一个宿主句柄 h-1 的会话。`probe` 的每个方法收到参数后记下来，再交给给定的实现。 */
async function fixture(probe: Record<string, (args: unknown) => unknown>): Promise<Fixture> {
  const probeCalls: Fixture["probeCalls"] = [];
  const invokes: Fixture["invokes"] = [];
  const wrapped = Object.fromEntries(
    Object.entries(probe).map(([name, fn]) => [
      name,
      (args: unknown) => {
        // 参数是宿主上下文里的对象：转回外层 realm 再记，deepEqual 才认
        probeCalls.push({ name, args: args === undefined ? undefined : JSON.parse(JSON.stringify(args)) });
        return fn(args);
      },
    ]),
  );
  const host = pageContext({ __kabegameSceneProbe: wrapped });
  const main = pageContext({
    __TAURI_INTERNALS__: {
      invoke: async (command: string, args: unknown) => {
        invokes.push({ command, args: JSON.parse(JSON.stringify(args)) });
        if (command === "wpe_scene_target") return { path: "D:\\proj\\p4c-cp", sceneAssets: ["D:\\assets"] };
        if (command === "get_wpe_web_properties") {
          return {
            metadataId: 3,
            items: [
              { kind: "group", key: "g", value: null },
              { kind: "slider", key: "speed", value: 2 },
            ],
          };
        }
        throw new Error(`没有命令 ${command}`);
      },
    },
  });
  const conn = vmConnection({ M: main, H: host });
  const s = new DevSession({
    resolveEndpoint: async () => ({ kind: "desktop", port: 1, webSocketUrl: "ws://fake" }),
    connect: async () => conn,
    vitePort: 1420,
    android: false,
    paths: devPaths("/repo", {}),
  });
  await s.connection();
  s.hosts.set("h-1", {
    handle: "h-1",
    instance: "inst-1",
    scene: "1",
    targetId: "H",
    hidden: true,
    elementId: "kb-dev-host-h-1",
    entry: "index-A.js",
    build: { entry: "index-A.js", frameVisibility: "visible", corpusHead: "" },
    known: new Set(),
    before: { vis: "visible", route: "/gallery", preview: false, previewImageId: null, grid: "" },
    generation: s.generation,
  });
  return { s, conn, host, probeCalls, invokes };
}

const leftovers = (host: vm.Context) => vm.runInContext("Object.keys(window.__kbTask ?? {}).length", host) as number;

describe("宿主任务的 JSON 结果", () => {
  test("分块取回、在 vite 里解析；取完槽位删掉", async () => {
    const big = { frames: Array.from({ length: 400 }, (_, i) => ({ frame: i + 1, name: `系统-${i}`, pos: [i, 0.5] })) };
    const f = await fixture({ make: () => Promise.resolve(big) });
    const result = await hostTaskJson<typeof big>(f.s, "h-1", "__kabegameSceneProbe.make()", {
      chunkChars: 1000,
      pollMs: 10,
    });
    assert.equal(result.status, "done", result.error);
    assert.deepEqual(result.value, big);
    assert.equal(result.bytes, Buffer.byteLength(JSON.stringify(big)));
    const slices = f.conn.evaluated.filter((line) => line.includes(".text.slice("));
    assert.equal(slices.length, Math.ceil(JSON.stringify(big).length / 1000));
    assert.equal(leftovers(f.host), 0);
  });

  test("超过上限回 413、不取；宿主里抛错回 rejected；槽位都删掉", async () => {
    const f = await fixture({
      make: () => ({ text: "粒".repeat(100) }),
      boom: () => Promise.reject(new Error("炸了")),
    });
    await assert.rejects(
      hostTaskJson(f.s, "h-1", "__kabegameSceneProbe.make()", { maxBytes: 200, pollMs: 10, what: "粒子轨迹" }),
      (error: unknown) =>
        error instanceof DevError &&
        error.status === 413 &&
        /粒子轨迹有 3\d\d 字节，超过上限 200/.test(error.message) &&
        /frames \/ limit/.test(error.message),
    );
    assert.equal(f.conn.evaluated.filter((line) => line.includes(".text.slice(")).length, 0);
    const rejected = await hostTaskJson(f.s, "h-1", "__kabegameSceneProbe.boom()", { pollMs: 10 });
    assert.equal(rejected.status, "rejected");
    assert.match(rejected.error ?? "", /炸了/);
    assert.equal(leftovers(f.host), 0);
  });
});

describe("粒子接口的参数透传", () => {
  const track = { source: "sim", project: "p4c-cp", tag: "t", frames: [], skipped: {} };

  test("轨迹：场景目录按图片 id 取，参数原样交给探针（不带 imageId）；参数错 400、不碰页面", async () => {
    const f = await fixture({ particleTrack: () => track });
    const request = {
      imageId: "14176",
      dts: [0.1, 0.2],
      times: [0.1, 0.3],
      frames: [2],
      passes: 2 as const,
      seed: 4,
      random: { "1": [0.5] },
      cursors: [
        [0.5, 0.5],
        [1.6, 0.9],
      ] as [number, number][],
      tag: "p4c-cp-fps60",
    };
    assert.deepEqual(await particleTrack(f.s, "h-1", request), track);
    const { imageId: _, ...rest } = request;
    assert.deepEqual(f.probeCalls, [
      { name: "particleTrack", args: { projectDir: "D:\\proj\\p4c-cp", sceneAssets: ["D:\\assets"], ...rest } },
    ]);
    assert.deepEqual(f.invokes, [{ command: "wpe_scene_target", args: { imageId: "14176" } }]);

    const before = f.conn.evaluated.length;
    await assert.rejects(
      particleTrack(f.s, "h-1", { ...request, frames: [3] }),
      (error: unknown) => error instanceof DevError && error.status === 400 && error.extra.field === "frames[0]",
    );
    assert.equal(f.conn.evaluated.length, before, "参数错时不发任何求值");
  });

  test("轨迹：探针抛错回 422（host 层）", async () => {
    const f = await fixture({ particleTrack: () => Promise.reject(new Error("dt 序列只有 2 帧")) });
    await assert.rejects(
      particleTrack(f.s, "h-1", { imageId: "1", dts: [0.1], frames: [1], passes: 1 }),
      (error: unknown) =>
        error instanceof DevError &&
        error.status === 422 &&
        error.layer === "host" &&
        /dt 序列只有 2 帧/.test(error.message),
    );
  });

  test("四角：userProperties 缺省取库里的值，layer / limit / particles / wgsl 原样交给探针", async () => {
    const layers = [{ object: 10, name: "persp", count: 1 }];
    const f = await fixture({ particleCorners: () => layers });
    const particles = { dts: [1 / 60, 1 / 60], seed: 1, passes: 1 as const };
    assert.deepEqual(
      await particleCorners(f.s, "h-1", { imageId: "13815", particles, layer: "persp", limit: 64, wgsl: true }),
      layers,
    );
    assert.deepEqual(f.probeCalls[0], {
      name: "particleCorners",
      args: {
        projectDir: "D:\\proj\\p4c-cp",
        sceneAssets: ["D:\\assets"],
        postprocess: "disabled",
        userProperties: { speed: 2 },
        particles,
        layer: "persp",
        limit: 64,
        wgsl: true,
      },
    });
    await particleCorners(f.s, "h-1", { imageId: "13815", userProperties: { speed: 5 }, postprocess: "ultra" });
    assert.deepEqual(f.probeCalls[1].args, {
      projectDir: "D:\\proj\\p4c-cp",
      sceneAssets: ["D:\\assets"],
      postprocess: "ultra",
      userProperties: { speed: 5 },
    });
  });

  test("渲染：给了 particles 时交给探针、不带 time；同时给 time 回 400", async () => {
    const png = Buffer.from("iVBORw0KGgo=", "base64").toString("base64");
    const f = await fixture({
      renderFrame: () => ({ width: 1, height: 1, sha256: "x", time: 0.3, frametime: 0.2 }),
      chunk: (index: unknown) => (index === 0 ? png : null),
    });
    // chunk 是两个参数：(key, index)，假探针包装只记第一个；这里直接换成两参的实现
    vm.runInContext(
      `window.__kabegameSceneProbe.chunk = (key, index) => (index === 0 ? ${JSON.stringify(png)} : null)`,
      f.host,
    );
    const particles = { dts: [0.1, 0.2], times: [0.1, 0.3] };
    const response = await renderFrame(f.s, "h-1", { imageId: "14108", particles, userProperties: {} });
    assert.equal(response.meta.time, 0.3);
    const args = f.probeCalls.find((call) => call.name === "renderFrame")!.args as Record<string, unknown>;
    assert.deepEqual(args.particles, particles);
    assert.equal("time" in args, false);
    await assert.rejects(
      renderFrame(f.s, "h-1", { imageId: "14108", particles, time: 1.5 }),
      (error: unknown) => error instanceof DevError && error.status === 400 && error.extra.field === "time",
    );
    await renderFrame(f.s, "h-1", { imageId: "14108", userProperties: {} });
    const plain = f.probeCalls.filter((call) => call.name === "renderFrame")[1].args as Record<string, unknown>;
    assert.equal(plain.time, 1.5);
    assert.equal("particles" in plain, false);
    assert.equal("pointers" in plain, false);
    assert.equal("window" in plain, false);

    // 逐帧光标（P5a 收尾）：pointers、window 原样交给探针；和 pointer 同给回 400、不碰页面
    const pointers: [number, number][] = [
      [0.1, 0.2],
      [0.3, 0.4],
    ];
    await renderFrame(f.s, "h-1", { imageId: "14108", particles, pointers, window: [1920, 800], userProperties: {} });
    const perFrame = f.probeCalls.filter((call) => call.name === "renderFrame")[2].args as Record<string, unknown>;
    assert.deepEqual(perFrame.pointers, pointers);
    assert.deepEqual(perFrame.window, [1920, 800]);
    assert.equal("pointer" in perFrame, false);
    const before = f.conn.evaluated.length;
    await assert.rejects(
      renderFrame(f.s, "h-1", { imageId: "14108", particles, pointers, pointer: [0.5, 0.5] }),
      (error: unknown) => error instanceof DevError && error.status === 400 && error.extra.field === "pointer",
    );
    assert.equal(f.conn.evaluated.length, before, "参数错时不发任何求值");
  });

  test("逐帧光标：轨迹的 window、四角的 pointers / window 原样交给探针", async () => {
    const f = await fixture({ particleTrack: () => track, particleCorners: () => [] });
    const cursors: [number, number][] = [
      [0.5, 0.5],
      [1.6, 0.9],
    ];
    await particleTrack(f.s, "h-1", {
      imageId: "1",
      dts: [0.1, 0.1],
      frames: [2],
      passes: 1,
      cursors,
      window: [1920, 800],
    });
    assert.deepEqual(f.probeCalls[0].args, {
      projectDir: "D:\\proj\\p4c-cp",
      sceneAssets: ["D:\\assets"],
      dts: [0.1, 0.1],
      frames: [2],
      passes: 1,
      cursors,
      window: [1920, 800],
    });
    const particles = { dts: [0.1, 0.1] };
    await particleCorners(f.s, "h-1", {
      imageId: "1",
      particles,
      pointers: cursors,
      window: [1440, 1080],
      userProperties: {},
    });
    assert.deepEqual(f.probeCalls[1].args, {
      projectDir: "D:\\proj\\p4c-cp",
      sceneAssets: ["D:\\assets"],
      postprocess: "disabled",
      userProperties: {},
      particles,
      pointers: cursors,
      window: [1440, 1080],
    });
  });
});
