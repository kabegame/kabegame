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
import { hostTaskJson, MAX_TRACE_BYTES, particleCorners, particleTrack, renderFrame } from "./scene.ts";
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

  test("读回画布（第 5 批）：canvas 原样交给探针；不给时不带；和 window 冲突回 400 不碰页面；结果对不上回 409", async () => {
    const png = Buffer.from("iVBORw0KGgo=", "base64").toString("base64");
    const f = await fixture({
      renderFrame: (args: unknown) => {
        const canvas = (args as { canvas?: [number, number] }).canvas;
        // 新探针：给了 canvas 就按它读回；把 canvas 设成 [1, 1] 时模拟不认识这一项的旧探针（读回场景目标、结果里没有 canvas）
        if (canvas && canvas[0] === 1) return { width: 3840, height: 2160, sha256: "old", time: 1.5, frametime: 0 };
        return {
          width: canvas?.[0] ?? 3840,
          height: canvas?.[1] ?? 2160,
          canvas: canvas ?? null,
          sceneTarget: canvas ?? [3840, 2160],
          // 按指定尺寸画之后的新字段（模拟新探针）：给了 canvas 才有说明
          ...(canvas
            ? { render: { mode: "target", style: "fill", alignment: 0, edges: [0, 0, 0, 0], clear: null } }
            : {}),
          sha256: "x",
          time: 1.5,
          frametime: 0,
        };
      },
    });
    vm.runInContext(
      `window.__kabegameSceneProbe.chunk = (key, index) => (index === 0 ? ${JSON.stringify(png)} : null)`,
      f.host,
    );
    const calls = () =>
      f.probeCalls.filter((call) => call.name === "renderFrame").map((c) => c.args as Record<string, unknown>);
    const response = await renderFrame(f.s, "h-1", { imageId: "14312", canvas: [1920, 1080], userProperties: {} });
    assert.deepEqual(response.meta.canvas, [1920, 1080]);
    assert.deepEqual(response.meta.sceneTarget, [1920, 1080]);
    assert.deepEqual(calls()[0].canvas, [1920, 1080]);
    assert.equal(
      "style" in calls()[0] || "renderMode" in calls()[0],
      false,
      "不给 style / renderMode 时请求和以前一样",
    );
    assert.equal(calls()[0].time, 1.5);
    await renderFrame(f.s, "h-1", { imageId: "14312", userProperties: {} });
    assert.equal("canvas" in calls()[1], false, "不给 canvas 时请求和以前一样");
    // 和 window 相同照转；回放时也带上
    const particles = { dts: [0.1, 0.2] };
    const pointers: [number, number][] = [
      [0.1, 0.2],
      [0.3, 0.4],
    ];
    await renderFrame(f.s, "h-1", {
      imageId: "14312",
      particles,
      pointers,
      window: [1920, 1080],
      canvas: [1920, 1080],
      userProperties: {},
    });
    assert.deepEqual(calls()[2].canvas, [1920, 1080]);
    assert.deepEqual(calls()[2].window, [1920, 1080]);

    const before = f.conn.evaluated.length;
    for (const [request, field] of [
      [{ imageId: "14312", window: [1920, 1080], canvas: [1280, 720] }, "canvas"],
      [{ imageId: "14312", canvas: [0, 720] }, "canvas"],
      [{ imageId: "14312", canvas: [1280.5, 720] }, "canvas"],
      [{ imageId: "14312", canvas: [16385, 720] }, "canvas"],
    ] as const) {
      await assert.rejects(
        renderFrame(f.s, "h-1", request as never),
        (error: unknown) => error instanceof DevError && error.status === 400 && error.extra.field === field,
      );
    }
    assert.equal(f.conn.evaluated.length, before, "参数错时不发任何求值");

    // 旧探针不认识 canvas：静默读回了场景目标，报 409 而不是把场景目标当画布交回去
    await assert.rejects(
      renderFrame(f.s, "h-1", { imageId: "14312", canvas: [1, 1], userProperties: {} }),
      (error: unknown) =>
        error instanceof DevError &&
        error.status === 409 &&
        error.layer === "host" &&
        /探针不认识 canvas/.test(error.message),
    );
  });

  test("按指定尺寸画（phase-render-size）：style / renderMode 原样交给探针；形状与关系不合法回 400 不碰页面；旧宿主产物没有 render 回 409", async () => {
    const png = Buffer.from("iVBORw0KGgo=", "base64").toString("base64");
    const f = await fixture({
      renderFrame: (args: unknown) => {
        const { canvas, style, renderMode } = args as {
          canvas?: [number, number];
          style?: string;
          renderMode?: string;
        };
        // canvas 宽为 7 时模拟旧探针：认识 canvas（有 canvas 字段）、不认识 style / renderMode（没有 render）
        const old = canvas?.[0] === 7;
        return {
          width: canvas?.[0] ?? 3840,
          height: canvas?.[1] ?? 2160,
          canvas: canvas ?? null,
          sceneTarget: [3840, 2160],
          ...(old
            ? {}
            : {
                render: {
                  mode: renderMode === "scene" ? "scene" : "target",
                  style: style ?? "fill",
                  alignment: 0,
                  edges: null,
                  clear: null,
                },
              }),
          sha256: "x",
          time: 1.5,
          frametime: 0,
        };
      },
    });
    vm.runInContext(
      `window.__kabegameSceneProbe.chunk = (key, index) => (index === 0 ? ${JSON.stringify(png)} : null)`,
      f.host,
    );
    const calls = () =>
      f.probeCalls.filter((call) => call.name === "renderFrame").map((c) => c.args as Record<string, unknown>);
    const fit = await renderFrame(f.s, "h-1", {
      imageId: "14312",
      canvas: [1920, 800],
      style: "fit",
      userProperties: {},
    });
    assert.equal(fit.meta.render?.mode, "target");
    assert.equal(calls()[0].style, "fit");
    assert.equal("renderMode" in calls()[0], false);
    await renderFrame(f.s, "h-1", {
      imageId: "14312",
      canvas: [1920, 800],
      renderMode: "scene",
      userProperties: {},
    });
    assert.equal(calls()[1].renderMode, "scene");
    assert.equal("style" in calls()[1], false);

    const before = f.conn.evaluated.length;
    for (const [request, field] of [
      [{ imageId: "14312", canvas: [1920, 800], style: "tile" }, "style"],
      [{ imageId: "14312", canvas: [1920, 800], style: "cover" }, "style"],
      [{ imageId: "14312", style: "fit" }, "style"],
      [{ imageId: "14312", canvas: [1920, 800], renderMode: "both" }, "renderMode"],
      [{ imageId: "14312", renderMode: "target" }, "renderMode"],
      [{ imageId: "14312", canvas: [1920, 800], renderMode: "scene", style: "center" }, "renderMode"],
    ] as const) {
      await assert.rejects(
        renderFrame(f.s, "h-1", request as never),
        (error: unknown) => error instanceof DevError && error.status === 400 && error.extra.field === field,
        JSON.stringify(request),
      );
    }
    assert.equal(f.conn.evaluated.length, before, "参数错时不发任何求值");

    // 旧宿主产物：认识 canvas 但没有 render，静默按旧画法读回，不能当按指定尺寸画的结果交回去
    await assert.rejects(
      renderFrame(f.s, "h-1", { imageId: "14312", canvas: [7, 7], style: "fit", userProperties: {} }),
      (error: unknown) =>
        error instanceof DevError &&
        error.status === 409 &&
        error.layer === "host" &&
        /没有回 render/.test(error.message),
    );
  });

  test("脚本值（第 6 批）：scriptValues 原样交给探针；不给时不带；不合法回 400 不碰页面；结果没有逐项记录回 409", async () => {
    const png = Buffer.from("iVBORw0KGgo=", "base64").toString("base64");
    const f = await fixture({
      renderFrame: (args: unknown) => {
        const values = (args as { scriptValues?: Array<{ object: unknown; field: string; value: unknown }> })
          .scriptValues;
        // 新探针：逐项回 applied；第一项的 object 是 "old" 时模拟不认识这一项的旧探针（结果里没有 scriptValues）
        if (values?.[0]?.object === "old") return { width: 1, height: 1, sha256: "old", time: 0.3, frametime: 0.2 };
        return {
          width: 1,
          height: 1,
          sha256: "x",
          time: 0.3,
          frametime: 0.2,
          scriptValues: (values ?? []).map((v) => ({ ...v, object: 0, name: "FR", applied: true })),
        };
      },
    });
    vm.runInContext(
      `window.__kabegameSceneProbe.chunk = (key, index) => (index === 0 ? ${JSON.stringify(png)} : null)`,
      f.host,
    );
    const calls = () =>
      f.probeCalls.filter((call) => call.name === "renderFrame").map((c) => c.args as Record<string, unknown>);
    const particles = { dts: [0.1, 0.2] };
    const scriptValues = [{ object: "FR", field: "color" as const, value: [2 / 255, 0, 1], optional: true }];
    const response = await renderFrame(f.s, "h-1", { imageId: "14108", particles, scriptValues, userProperties: {} });
    assert.deepEqual(calls()[0].scriptValues, scriptValues);
    assert.deepEqual(calls()[0].particles, particles);
    assert.equal(response.meta.scriptValues?.[0].applied, true);
    // 不要求有 particles（固定时刻也能写）
    await renderFrame(f.s, "h-1", { imageId: "14108", scriptValues, userProperties: {} });
    assert.deepEqual(calls()[1].scriptValues, scriptValues);
    assert.equal(calls()[1].time, 1.5);
    await renderFrame(f.s, "h-1", { imageId: "14108", particles, userProperties: {} });
    assert.equal("scriptValues" in calls()[2], false, "不给 scriptValues 时请求和以前一样");

    const before = f.conn.evaluated.length;
    for (const [request, field] of [
      [{ imageId: "14108", scriptValues: [{ object: "FR", field: "size", value: [1] }] }, "scriptValues[0].field"],
      [{ imageId: "14108", scriptValues: [{ object: "FR", field: "color", value: [] }] }, "scriptValues[0].value"],
      [{ imageId: "14108", scriptValues: { object: "FR" } }, "scriptValues"],
    ] as const) {
      await assert.rejects(
        renderFrame(f.s, "h-1", request as never),
        (error: unknown) => error instanceof DevError && error.status === 400 && error.extra.field === field,
      );
    }
    assert.equal(f.conn.evaluated.length, before, "参数错时不发任何求值");

    // 旧探针不认识 scriptValues：静默没写，报 409 而不是把没涂的画面交回去
    await assert.rejects(
      renderFrame(f.s, "h-1", {
        imageId: "14108",
        scriptValues: [{ object: "old", field: "color", value: [1, 1, 1] }],
        userProperties: {},
      }),
      (error: unknown) =>
        error instanceof DevError &&
        error.status === 409 &&
        error.layer === "host" &&
        /探针不认识 scriptValues/.test(error.message),
    );
  });

  test("跑场景脚本（第 7 批）：scripts 原样交给探针；不给时不带；不合法或和 scriptValues 同给回 400 不碰页面；结果没有 scripts 回 409", async () => {
    const png = Buffer.from("iVBORw0KGgo=", "base64").toString("base64");
    const f = await fixture({
      renderFrame: (args: unknown) => {
        const scripts = (args as { scripts?: unknown }).scripts;
        const base = { width: 1, height: 1, sha256: "x", time: 0.3, frametime: 0.2 };
        // 新探针回 meta.scripts；seed 是 99 时模拟不认识这一项的旧探针（结果里没有 scripts）
        if ((scripts as { seed?: number } | undefined)?.seed === 99) return base;
        return scripts === undefined ? base : { ...base, scripts: { frames: 2, diagnostics: [] } };
      },
    });
    vm.runInContext(
      `window.__kabegameSceneProbe.chunk = (key, index) => (index === 0 ? ${JSON.stringify(png)} : null)`,
      f.host,
    );
    const calls = () =>
      f.probeCalls.filter((call) => call.name === "renderFrame").map((c) => c.args as Record<string, unknown>);
    const particles = { dts: [0.1, 0.2] };
    const response = await renderFrame(f.s, "h-1", { imageId: "14108", particles, scripts: true, userProperties: {} });
    assert.equal(calls()[0].scripts, true);
    assert.deepEqual(calls()[0].particles, particles);
    assert.equal(response.meta.scripts?.frames, 2);
    // 不要求有 particles；对象原样转
    await renderFrame(f.s, "h-1", { imageId: "14108", scripts: { clock: 5, seed: 3 }, userProperties: {} });
    assert.deepEqual(calls()[1].scripts, { clock: 5, seed: 3 });
    assert.equal(calls()[1].time, 1.5);
    await renderFrame(f.s, "h-1", { imageId: "14108", particles, userProperties: {} });
    assert.equal("scripts" in calls()[2], false, "不给 scripts 时请求和以前一样");

    const before = f.conn.evaluated.length;
    const fr = [{ object: "FR", field: "color" as const, value: [1, 0, 1], optional: true }];
    for (const [request, field] of [
      [{ imageId: "14108", scripts: true, scriptValues: fr }, "scripts"],
      [{ imageId: "14108", scripts: { seed: -1 } }, "scripts.seed"],
      [{ imageId: "14108", scripts: "yes" }, "scripts"],
    ] as const) {
      await assert.rejects(
        renderFrame(f.s, "h-1", request as never),
        (error: unknown) => error instanceof DevError && error.status === 400 && error.extra.field === field,
      );
    }
    assert.equal(f.conn.evaluated.length, before, "参数错时不发任何求值");

    // 旧探针不认识 scripts：脚本没跑，报 409 而不是把没跑脚本的画面交回去
    await assert.rejects(
      renderFrame(f.s, "h-1", { imageId: "14108", scripts: { seed: 99 }, userProperties: {} }),
      (error: unknown) =>
        error instanceof DevError &&
        error.status === 409 &&
        error.layer === "host" &&
        /探针不认识 scripts/.test(error.message),
    );
  });

  test("视频时刻（P9a 步骤 3）：videoTime 原样交给探针（0 也转）；不给时不带；不合法回 400 不碰页面；结果没有 videos 回 409", async () => {
    const png = Buffer.from("iVBORw0KGgo=", "base64").toString("base64");
    const f = await fixture({
      renderFrame: (args: unknown) => {
        const videoTime = (args as { videoTime?: unknown }).videoTime;
        // 新探针：回每段视频实际取的时刻；videoTime 是 99 时模拟不认识这一项的旧探针（结果里没有 videos）
        if (videoTime === 99) return { width: 1, height: 1, sha256: "old", time: 1.5, frametime: 0 };
        const time = typeof videoTime === "number" ? videoTime % 2.5 : 0;
        return {
          width: 1,
          height: 1,
          sha256: "x",
          time: 1.5,
          frametime: 0,
          videos: [{ path: "materials/v.tex", time, duration: 2.5, width: 1280, height: 720, failed: false }],
        };
      },
    });
    vm.runInContext(
      `window.__kabegameSceneProbe.chunk = (key, index) => (index === 0 ? ${JSON.stringify(png)} : null)`,
      f.host,
    );
    const calls = () =>
      f.probeCalls.filter((call) => call.name === "renderFrame").map((c) => c.args as Record<string, unknown>);
    const response = await renderFrame(f.s, "h-1", { imageId: "14501", videoTime: 3.5, userProperties: {} });
    assert.equal(calls()[0].videoTime, 3.5);
    assert.equal(calls()[0].time, 1.5, "videoTime 不影响 g_Time");
    assert.deepEqual(response.meta.videos, [
      { path: "materials/v.tex", time: 1, duration: 2.5, width: 1280, height: 720, failed: false },
    ]);
    // 0 是有效值，照转
    await renderFrame(f.s, "h-1", { imageId: "14501", videoTime: 0, userProperties: {} });
    assert.equal(calls()[1].videoTime, 0);
    // 按纹理路径分别给；回放时也带上
    const byPath = { "materials/v.tex": 2, "materials/w.tex": 0.25 };
    await renderFrame(f.s, "h-1", {
      imageId: "14501",
      particles: { dts: [0.1] },
      videoTime: byPath,
      userProperties: {},
    });
    assert.deepEqual(calls()[2].videoTime, byPath);
    await renderFrame(f.s, "h-1", { imageId: "14501", userProperties: {} });
    assert.equal("videoTime" in calls()[3], false, "不给 videoTime 时请求和以前一样");

    const before = f.conn.evaluated.length;
    for (const [videoTime, field] of [
      [-1, "videoTime"],
      [Number.NaN, "videoTime"],
      [Number.POSITIVE_INFINITY, "videoTime"],
      ["1.5", "videoTime"],
      [[1.5], "videoTime"],
      [null, "videoTime"],
      [{ "materials/v.tex": -0.5 }, "videoTime.materials/v.tex"],
      [{ "materials/v.tex": "2" }, "videoTime.materials/v.tex"],
      [{ "": 1 }, "videoTime"],
      [Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`v${i}.tex`, 0])), "videoTime"],
    ] as const) {
      await assert.rejects(
        renderFrame(f.s, "h-1", { imageId: "14501", videoTime: videoTime as never, userProperties: {} }),
        (error: unknown) => error instanceof DevError && error.status === 400 && error.extra.field === field,
        JSON.stringify(videoTime),
      );
    }
    assert.equal(f.conn.evaluated.length, before, "参数错时不发任何求值");

    // 旧探针不认识 videoTime：视频停在透明的初值，报 409 而不是把它交回去
    await assert.rejects(
      renderFrame(f.s, "h-1", { imageId: "14501", videoTime: 99, userProperties: {} }),
      (error: unknown) =>
        error instanceof DevError &&
        error.status === 409 &&
        error.layer === "host" &&
        /探针不认识 videoTime/.test(error.message),
    );
  });

  test("用户 GIF 逐帧时间：gifDts 原样交给探针（空数组也转）；不给时不带；不合法回 400 不碰页面；userTextures 的项没有 kind 回 409，没有 userTextures 不报", async () => {
    const png = Buffer.from("iVBORw0KGgo=", "base64").toString("base64");
    const f = await fixture({
      renderFrame: (args: unknown) => {
        const gifDts = (args as { gifDts?: number[] }).gifDts;
        // gifDts 含 99 时模拟 P11b 步骤 4 之前的探针：回 userTextures 但项里没有 kind
        if (gifDts?.includes(99))
          return {
            width: 1,
            height: 1,
            sha256: "old",
            time: 1.5,
            frametime: 0,
            userTextures: [{ name: "pic", value: "a.gif", status: "empty", keys: [] }],
          };
        // 含 98 时模拟没有属性来源的场景：探针不回 userTextures
        if (gifDts?.includes(98)) return { width: 1, height: 1, sha256: "none", time: 1.5, frametime: 0 };
        return {
          width: 1,
          height: 1,
          sha256: "x",
          time: 1.5,
          frametime: 0,
          userTextures: [
            {
              name: "pic",
              value: "a.gif",
              kind: "gif",
              status: "ready",
              keys: ["k"],
              gifs: [{ key: "k", frames: gifDts?.length ?? 0, lastFrame: (gifDts?.length ?? 0) - 1 }],
            },
          ],
        };
      },
    });
    vm.runInContext(
      `window.__kabegameSceneProbe.chunk = (key, index) => (index === 0 ? ${JSON.stringify(png)} : null)`,
      f.host,
    );
    const calls = () =>
      f.probeCalls.filter((call) => call.name === "renderFrame").map((c) => c.args as Record<string, unknown>);
    const response = await renderFrame(f.s, "h-1", { imageId: "14501", gifDts: [0.05, 0, 0.1], userProperties: {} });
    assert.deepEqual(calls()[0].gifDts, [0.05, 0, 0.1]);
    assert.equal(response.meta.userTextures?.[0].gifs?.[0].frames, 3);
    await renderFrame(f.s, "h-1", { imageId: "14501", gifDts: [], userProperties: {} });
    assert.deepEqual(calls()[1].gifDts, []);
    await renderFrame(f.s, "h-1", { imageId: "14501", userProperties: {} });
    assert.equal("gifDts" in calls()[2], false, "不给 gifDts 时请求和以前一样");

    const before = f.conn.evaluated.length;
    for (const [gifDts, field] of [
      [-1, "gifDts"],
      ["0.1", "gifDts"],
      [null, "gifDts"],
      [{ 0: 1 }, "gifDts"],
      [[0.1, -0.5], "gifDts[1]"],
      [[Number.NaN], "gifDts[0]"],
      [[Number.POSITIVE_INFINITY], "gifDts[0]"],
      [["1"], "gifDts[0]"],
      [new Array(10001).fill(0), "gifDts"],
    ] as const) {
      await assert.rejects(
        renderFrame(f.s, "h-1", { imageId: "14501", gifDts: gifDts as never, userProperties: {} }),
        (error: unknown) => error instanceof DevError && error.status === 400 && error.extra.field === field,
        JSON.stringify(gifDts).slice(0, 40),
      );
    }
    assert.equal(f.conn.evaluated.length, before, "参数错时不发任何求值");

    await assert.rejects(
      renderFrame(f.s, "h-1", { imageId: "14501", gifDts: [99], userProperties: {} }),
      (error: unknown) =>
        error instanceof DevError &&
        error.status === 409 &&
        error.layer === "host" &&
        /探针不认识 gifDts/.test(error.message),
    );
    // 没有属性来源的场景：不回 userTextures，gifDts 照转、不报 409
    const none = await renderFrame(f.s, "h-1", { imageId: "14501", gifDts: [98], userProperties: {} });
    assert.equal(none.meta.userTextures, undefined);
  });

  test("逐 draw 轨迹：trace 原样交给探针；取回轨迹 JSON 与读回图；没给不带；不合法 400；旧宿主 409；超过 64 MB 回 413 不取", async () => {
    const png = Buffer.from("iVBORw0KGgo=", "base64").toString("base64");
    const trace = {
      version: 1,
      resources: {},
      passes: [{ index: 0, label: "scene", draws: [{}, {}], readback: "k.pass0.png" }],
      copies: [],
    };
    const json = Buffer.from(JSON.stringify(trace));
    const pass0 = Buffer.from([1, 2, 3]);
    const pass2 = Buffer.from(new Float32Array([1, 0.5, -2, 1]).buffer);
    // 存放区：键 → base64；读回图都很小，`huge` 时报的大小超过上限
    const stored: Record<string, string> = {
      "kbdev-h-1.png": png,
      "kbdev-h-1.trace.json": json.toString("base64"),
      "kbdev-h-1.pass0.png": pass0.toString("base64"),
      "kbdev-h-1.pass2.f32": pass2.toString("base64"),
    };
    const f = await fixture({
      renderFrame: (args: unknown) => {
        const request = args as { trace?: unknown; time?: number };
        const meta = { width: 1, height: 1, sha256: "x", time: 1.5, frametime: 0, key: "kbdev-h-1" };
        // 旧探针：不认识 trace，结果里没有这一项（time 给 7 时模拟）
        if (!request.trace || request.time === 7) return meta;
        const huge = request.time === 9;
        return {
          ...meta,
          trace: {
            key: "kbdev-h-1.trace.json",
            bytes: json.length,
            passes: 3,
            draws: 2,
            errors: 0,
            readbacks: [
              { pass: 0, key: "kbdev-h-1.pass0.png", width: 1, height: 1, format: "rgba8unorm", bytes: 3 },
              {
                pass: 2,
                key: "kbdev-h-1.pass2.f32",
                width: 1,
                height: 1,
                format: "rgba16float",
                bytes: huge ? 64 * 1024 * 1024 : 16,
              },
            ],
            readbackErrors: [],
          },
        };
      },
    });
    vm.runInContext(
      `window.__kabegameSceneProbe.chunk = (key, index) => (index === 0 ? (${JSON.stringify(stored)})[key] ?? null : null)`,
      f.host,
    );
    const calls = () =>
      f.probeCalls.filter((call) => call.name === "renderFrame").map((c) => c.args as Record<string, unknown>);
    const chunkKeys = () =>
      f.conn.evaluated.filter((line) => line.includes(".chunk(")).map((line) => /chunk\("([^"]+)"/.exec(line)![1]);

    const request = { readback: [0, "bloom"], maxVertices: 16 };
    const response = await renderFrame(f.s, "h-1", { imageId: "14313", trace: request, userProperties: {} });
    assert.deepEqual(calls()[0].trace, request);
    assert.deepEqual(response.trace, trace);
    assert.deepEqual(response.traceImages, [
      { pass: 0, format: "rgba8unorm", kind: "png", width: 1, height: 1, bytes: 3, data: pass0.toString("base64") },
      { pass: 2, format: "rgba16float", kind: "f32", width: 1, height: 1, bytes: 16, data: pass2.toString("base64") },
    ]);
    assert.equal(response.meta.trace?.draws, 2);
    // true 也转；不给时请求与响应都没有这一项
    await renderFrame(f.s, "h-1", { imageId: "14313", trace: true, userProperties: {} });
    assert.equal(calls()[1].trace, true);
    const plain = await renderFrame(f.s, "h-1", { imageId: "14313", userProperties: {} });
    assert.equal("trace" in calls()[2], false, "不给 trace 时请求和以前一样");
    assert.equal("trace" in plain, false);
    assert.equal("traceImages" in plain, false);

    const before = f.conn.evaluated.length;
    for (const [bad, field] of [
      [false, "trace"],
      [{ readback: [-1] }, "trace.readback[0]"],
      [{ maxVertices: 0 }, "trace.maxVertices"],
      [{ save: "out" }, "trace.save"],
    ] as const) {
      await assert.rejects(
        renderFrame(f.s, "h-1", { imageId: "14313", trace: bad as never, userProperties: {} }),
        (error: unknown) => error instanceof DevError && error.status === 400 && error.extra.field === field,
        JSON.stringify(bad),
      );
    }
    assert.equal(f.conn.evaluated.length, before, "参数错时不发任何求值");

    // 旧探针不认识 trace：设备没包、什么都没记，报 409 而不是只回画面
    await assert.rejects(
      renderFrame(f.s, "h-1", { imageId: "14313", time: 7, trace: true, userProperties: {} }),
      (error: unknown) =>
        error instanceof DevError &&
        error.status === 409 &&
        error.layer === "host" &&
        /探针不认识 trace/.test(error.message),
    );
    // 报的大小合计超过 64 MB：413，不取轨迹与读回图
    const fetched = chunkKeys().length;
    await assert.rejects(
      renderFrame(f.s, "h-1", { imageId: "14313", time: 9, trace: true, userProperties: {} }),
      (error: unknown) =>
        error instanceof DevError &&
        error.status === 413 &&
        /超过上限 67108864/.test(error.message) &&
        error.extra.maxBytes === MAX_TRACE_BYTES,
    );
    assert.deepEqual([...new Set(chunkKeys().slice(fetched))], ["kbdev-h-1.png"], "超限时只取了画面 PNG");
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
