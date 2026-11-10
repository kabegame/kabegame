import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { DevError, staleHandle } from "./errors.ts";
import { checkAccess, createRestHandler, pngSize } from "./rest.ts";
import { localFetch } from "./localHttp.ts";
import { decodePng, encodePng } from "./png.ts";
import { Buffer } from "node:buffer";
import type { DevBackend } from "./rest.ts";

// 1×1 的 PNG
const PNG = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="),
  (c) => c.charCodeAt(0),
);

/** 假后端：默认都成功，记录调用；测试里按需覆盖。 */
function fakeBackend(overrides: Partial<DevBackend> = {}): { backend: DevBackend; calls: unknown[][] } {
  const calls: unknown[][] = [];
  const record =
    <T>(name: string, value: T) =>
    async (...args: unknown[]) => {
      calls.push([name, ...args]);
      return value;
    };
  const backend: DevBackend = {
    health: record("health", {
      vite: true as const,
      android: false,
      cdp: { kind: "desktop" as const, port: 1, webSocketUrl: "ws://x" },
      session: {
        connected: false,
        generation: 0,
        endpoint: null,
        hosts: [],
        consoles: [],
        jobs: { running: 0, total: 0 },
      },
    }),
    targets: record("targets", []),
    evaluate: record("evaluate", { value: 2, type: "number" }),
    screenshot: record("screenshot", PNG),
    click: record("click", { clicked: true as const, x: 1, y: 2, tag: "div" }),
    text: record("text", "文本"),
    invoke: record("invoke", "window"),
    consoleStart: record("consoleStart", { id: "c-1", target: "main", targetId: "T", startedAt: "" }),
    consoleRead: record("consoleRead", { id: "c-1", entries: [], next: 0, ended: null, dropped: 0 }),
    consoleStop: record("consoleStop", { id: "c-1", stopped: true as const, total: 0 }),
    appState: record("appState", {} as never),
    showWindow: record("showWindow", {
      front: true,
      path: "focus" as const,
      before: { visibilityState: "hidden", hasFocus: false, minimized: false, visible: true },
      after: { visibilityState: "visible", hasFocus: true, minimized: false, visible: true },
      steps: ["plugin:window|set_focus：ok"],
    }),
    openImagePreview: record("openImagePreview", { imageId: "7" } as never),
    androidScreen: record("androidScreen", PNG),
    hosts: record("hosts", []),
    hostOpen: record("hostOpen", {} as never),
    hostClose: record("hostClose", {} as never),
    hostEval: record("hostEval", { value: 1, type: "number" }),
    hostRender: record("hostRender", {} as never),
    hostParticleTrack: record("hostParticleTrack", { source: "sim", project: "p", tag: "", frames: [], skipped: {} }),
    hostParticleCorners: record("hostParticleCorners", []),
    projectsRemove: record("projectsRemove", {} as never),
    jobStart: record("jobStart", {} as never),
    jobList: record("jobList", []),
    jobGet: record("jobGet", {} as never),
    jobCancel: record("jobCancel", {} as never),
    ...overrides,
  };
  return { backend, calls };
}

async function withServer(
  backend: DevBackend,
  fn: (base: string, nextCalls: string[]) => Promise<void>,
): Promise<void> {
  const handler = createRestHandler(backend);
  const nextCalls: string[] = [];
  const server = createServer((req, res) => {
    void handler(req, res, () => {
      nextCalls.push(req.url ?? "");
      res.statusCode = 200;
      res.end("spa");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await fn(base, nextCalls);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  localFetch(url, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), headers });

describe("来源校验", () => {
  test("回环地址、本机 Origin / Host 通过", () => {
    assert.equal(checkAccess("127.0.0.1", { host: "127.0.0.1:1420" }), null);
    assert.equal(checkAccess("::1", { host: "localhost:1420", origin: "http://localhost:1420" }), null);
    assert.equal(checkAccess("::ffff:127.0.0.1", { host: "[::1]:1420", origin: "http://127.0.0.1:5173" }), null);
  });
  test("非回环地址拒绝", () => {
    assert.match(checkAccess("192.168.1.5", { host: "localhost:1420" }) ?? "", /回环/);
  });
  test("外站 Origin、DNS 重绑定的 Host 拒绝", () => {
    assert.match(checkAccess("127.0.0.1", { origin: "http://evil.example" }) ?? "", /Origin/);
    assert.match(checkAccess("127.0.0.1", { origin: "null" }) ?? "", /Origin/);
    assert.match(checkAccess("127.0.0.1", { origin: "http://tauri.localhost" }) ?? "", /Origin/);
    assert.match(checkAccess("127.0.0.1", { host: "evil.example:1420" }) ?? "", /Host/);
  });
});

describe("REST 路由", () => {
  test("不在前缀下的请求交给下一个中间件", async () => {
    const { backend } = fakeBackend();
    await withServer(backend, async (base, nextCalls) => {
      const res = await localFetch(`${base}/gallery`);
      assert.equal(await res.text(), "spa");
      assert.deepEqual(nextCalls, ["/gallery"]);
    });
  });

  test("Origin: http://evil.example 被拒（403 access）", async () => {
    const { backend, calls } = fakeBackend();
    await withServer(backend, async (base) => {
      const res = await post(
        `${base}/__kabegame_dev/eval`,
        { target: "main", expression: "1" },
        {
          Origin: "http://evil.example",
        },
      );
      assert.equal(res.status, 403);
      assert.equal((await res.json()).layer, "access");
      assert.equal(calls.length, 0, "被拒的请求不该碰后端");
    });
  });

  test("health 回 JSON", async () => {
    const { backend } = fakeBackend();
    await withServer(backend, async (base) => {
      const res = await localFetch(`${base}/__kabegame_dev/health`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("content-type"), "application/json; charset=utf-8");
      const body = await res.json();
      assert.equal(body.vite, true);
    });
  });

  test("eval 把参数交给后端", async () => {
    const { backend, calls } = fakeBackend();
    await withServer(backend, async (base) => {
      const res = await post(`${base}/__kabegame_dev/eval`, {
        target: "url:wallpaper",
        expression: "1+1",
        timeoutMs: 5,
      });
      assert.deepEqual(await res.json(), { value: 2, type: "number" });
      assert.deepEqual(calls, [["evaluate", "url:wallpaper", "1+1", 5]]);
    });
  });

  test("参数错回 400（rest 层）", async () => {
    const { backend } = fakeBackend();
    await withServer(backend, async (base) => {
      let res = await post(`${base}/__kabegame_dev/eval`, { target: "main" });
      assert.equal(res.status, 400);
      let body = await res.json();
      assert.equal(body.layer, "rest");
      assert.match(body.error, /expression/);
      res = await post(`${base}/__kabegame_dev/eval`, "{坏的");
      assert.equal(res.status, 400);
      body = await res.json();
      assert.match(body.error, /JSON/);
      res = await post(`${base}/__kabegame_dev/jobs`, { kind: "rm-rf" });
      assert.equal(res.status, 400);
      res = await post(`${base}/__kabegame_dev/screenshot`, { target: "main", fullPage: "yes" });
      assert.equal(res.status, 400);
    });
  });

  test("未知接口 404、方法不对 405", async () => {
    const { backend } = fakeBackend();
    await withServer(backend, async (base) => {
      let res = await localFetch(`${base}/__kabegame_dev/nope`);
      assert.equal(res.status, 404);
      assert.equal((await res.json()).layer, "rest");
      res = await localFetch(`${base}/__kabegame_dev/eval`);
      assert.equal(res.status, 405);
      assert.equal(res.headers.get("allow"), "POST");
      await res.body?.cancel();
    });
  });

  test("句柄不存在回 404（handle 层，提示 vite 可能重启过）", async () => {
    const { backend } = fakeBackend({
      hostClose: async (handle) => {
        throw staleHandle("宿主句柄", handle);
      },
    });
    await withServer(backend, async (base) => {
      const res = await localFetch(`${base}/__kabegame_dev/hosts/h-12345678`, { method: "DELETE" });
      assert.equal(res.status, 404);
      const body = await res.json();
      assert.equal(body.layer, "handle");
      assert.equal(body.id, "h-12345678");
      assert.match(body.error, /vite 重启/);
    });
  });

  test("CDP 不可用回 503 并带端点结论", async () => {
    const endpoint = { layer: "registration", error: "vite 上没有 CDP 端口登记" };
    const { backend } = fakeBackend({
      targets: async () => {
        throw new DevError(503, "cdp", "CDP 不可用：vite 上没有 CDP 端口登记", { endpoint });
      },
    });
    await withServer(backend, async (base) => {
      const res = await localFetch(`${base}/__kabegame_dev/targets`);
      assert.equal(res.status, 503);
      const body = await res.json();
      assert.equal(body.layer, "cdp");
      assert.deepEqual(body.endpoint, endpoint);
    });
  });

  test("后端未知异常回 500（vite 层）", async () => {
    const { backend } = fakeBackend({
      appState: async () => {
        throw new Error("意外");
      },
    });
    await withServer(backend, async (base) => {
      const res = await localFetch(`${base}/__kabegame_dev/app/state`);
      assert.equal(res.status, 500);
      assert.deepEqual(await res.json(), { error: "意外", layer: "vite" });
    });
  });

  test("截图回 image/png，带宽高头", async () => {
    const { backend, calls } = fakeBackend();
    await withServer(backend, async (base) => {
      const res = await post(`${base}/__kabegame_dev/screenshot`, {
        target: "main",
        clip: { x: 1, y: 2, width: 3, height: 4 },
      });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("content-type"), "image/png");
      assert.equal(res.headers.get("x-png-width"), "1");
      assert.equal(res.headers.get("x-png-height"), "1");
      assert.deepEqual(new Uint8Array(await res.arrayBuffer()), PNG);
      assert.deepEqual(calls, [["screenshot", { target: "main", clip: { x: 1, y: 2, width: 3, height: 4 } }]]);
    });
  });

  test("render 的 imageId 数字也转成字符串；console 的 since 解析", async () => {
    const { backend, calls } = fakeBackend();
    await withServer(backend, async (base) => {
      await (await post(`${base}/__kabegame_dev/hosts/h-1/render`, { imageId: 13515, time: 1.5 })).json();
      await (await localFetch(`${base}/__kabegame_dev/console/c-1?since=7`)).json();
      const bad = await localFetch(`${base}/__kabegame_dev/console/c-1?since=-1`);
      assert.equal(bad.status, 400);
      await bad.body?.cancel();
      assert.deepEqual(calls, [
        ["hostRender", "h-1", { imageId: "13515", time: 1.5 }],
        ["consoleRead", "c-1", 7],
      ]);
    });
  });

  test("pngSize 读 IHDR", () => {
    assert.deepEqual(pngSize(PNG), { width: 1, height: 1 });
    assert.equal(pngSize(new Uint8Array([1, 2, 3])), null);
  });
});

/** 40×20 的不透明 RGBA，像素按坐标算。 */
function bigPng(width = 40, height = 20): Uint8Array {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set([(i * 7) & 255, (i * 3) & 255, i & 255, 255], i * 4);
  return encodePng({ width, height, channels: 4, data });
}

describe("显示窗口与打开预览", () => {
  test("show-window 回后端结果；open-preview 校验 imageId、转数字、带 timeoutMs 与 show", async () => {
    const { backend, calls } = fakeBackend();
    await withServer(backend, async (base) => {
      const shown = await (await post(`${base}/__kabegame_dev/app/show-window`, {})).json();
      assert.equal(shown.front, true);
      assert.equal(shown.path, "focus");
      assert.equal(shown.after.visibilityState, "visible");

      const opened = await post(`${base}/__kabegame_dev/app/open-preview`, {
        imageId: 13515,
        timeoutMs: 5000,
        show: false,
      });
      assert.equal(opened.status, 200);
      assert.deepEqual(await opened.json(), { imageId: "7" });
      for (const body of [{}, { imageId: "abc" }, { imageId: "1", show: "yes" }, { imageId: "1", timeoutMs: -1 }]) {
        const bad = await post(`${base}/__kabegame_dev/app/open-preview`, body);
        assert.equal(bad.status, 400, JSON.stringify(body));
        assert.equal((await bad.json()).layer, "rest");
      }
      const get = await localFetch(`${base}/__kabegame_dev/app/open-preview`);
      assert.equal(get.status, 405);
      await get.body?.cancel();
      assert.deepEqual(calls, [
        ["showWindow"],
        ["openImagePreview", { imageId: "13515", timeoutMs: 5000, show: false }],
      ]);
    });
  });
});

describe("resize", () => {
  test("截图：不带时回原图（两组尺寸头相同）；带时缩小，头里有原尺寸", async () => {
    const png = bigPng();
    const { backend, calls } = fakeBackend({ screenshot: async () => png });
    await withServer(backend, async (base) => {
      let res = await post(`${base}/__kabegame_dev/screenshot`, { target: "main" });
      assert.deepEqual(new Uint8Array(await res.arrayBuffer()), png);
      assert.equal(res.headers.get("x-png-width"), "40");
      assert.equal(res.headers.get("x-png-original-width"), "40");

      res = await post(`${base}/__kabegame_dev/screenshot`, { target: "main", resize: { maxWidth: 10 } });
      assert.equal(res.status, 200);
      const small = new Uint8Array(await res.arrayBuffer());
      assert.deepEqual(pngSize(small), { width: 10, height: 5 });
      assert.equal(res.headers.get("x-png-width"), "10");
      assert.equal(res.headers.get("x-png-height"), "5");
      assert.equal(res.headers.get("x-png-original-width"), "40");
      assert.equal(res.headers.get("x-png-original-height"), "20");
      assert.equal(decodePng(small).channels, 4);
      // resize 不传给后端
      assert.deepEqual(calls, []);
    });
  });

  test("resize 不合法回 400；格式不支持缩小回 422（png 层）", async () => {
    const palette = Uint8Array.from(PNG);
    palette[25] = 3; // 颜色类型改成调色板（CRC 随之不对，也会报错，同样不回错图）
    const { backend } = fakeBackend({ screenshot: async () => palette });
    await withServer(backend, async (base) => {
      let res = await post(`${base}/__kabegame_dev/screenshot`, { target: "main", resize: { scale: 0 } });
      assert.equal(res.status, 400);
      assert.match((await res.json()).error, /resize 不合法/);
      res = await post(`${base}/__kabegame_dev/screenshot`, { target: "main", resize: { width: 3 } });
      assert.equal(res.status, 400);
      await res.body?.cancel();
      // 1×1 不用缩小：原样回，不解码
      res = await post(`${base}/__kabegame_dev/screenshot`, { target: "main", resize: { maxWidth: 10 } });
      assert.equal(res.status, 200);
      await res.body?.cancel();
    });
    const big = bigPng();
    const broken = Uint8Array.from(big);
    broken[25] = 3;
    const { backend: backend2 } = fakeBackend({ screenshot: async () => broken });
    await withServer(backend2, async (base) => {
      const res = await post(`${base}/__kabegame_dev/screenshot`, { target: "main", resize: { maxWidth: 10 } });
      assert.equal(res.status, 422);
      const body = await res.json();
      assert.equal(body.layer, "png");
      assert.match(body.error, /缩小失败/);
    });
  });

  test("安卓整屏：GET 的 query 带尺寸约束", async () => {
    const png = bigPng();
    const { backend } = fakeBackend({ androidScreen: async () => png });
    await withServer(backend, async (base) => {
      let res = await localFetch(`${base}/__kabegame_dev/android/screen?maxHeight=4`);
      assert.deepEqual(pngSize(new Uint8Array(await res.arrayBuffer())), { width: 8, height: 4 });
      assert.equal(res.headers.get("x-png-original-height"), "20");
      res = await localFetch(`${base}/__kabegame_dev/android/screen?scale=abc`);
      assert.equal(res.status, 400);
      await res.body?.cancel();
    });
  });

  test("渲染：不带 resize 时补 size、png 不变；带时换掉 png，pngSha256 仍是原图的", async () => {
    const png = bigPng();
    const base64 = Buffer.from(png).toString("base64");
    const response = { meta: { width: 40, height: 20 }, png: base64, pngSha256: "orig", pngBytes: png.length };
    const { backend, calls } = fakeBackend({
      hostRender: async (...args) => (calls.push(["hostRender", ...args]), response as never),
    });
    await withServer(backend, async (base) => {
      let body = await (await post(`${base}/__kabegame_dev/hosts/h-1/render`, { imageId: "9" })).json();
      assert.equal(body.png, base64);
      assert.deepEqual(body.size, {
        original: { width: 40, height: 20 },
        returned: { width: 40, height: 20 },
        resized: false,
      });
      body = await (
        await post(`${base}/__kabegame_dev/hosts/h-1/render`, { imageId: "9", resize: { scale: 0.25 } })
      ).json();
      assert.deepEqual(body.size, {
        original: { width: 40, height: 20 },
        returned: { width: 10, height: 5 },
        resized: true,
      });
      assert.deepEqual(pngSize(new Uint8Array(Buffer.from(body.png, "base64"))), { width: 10, height: 5 });
      assert.equal(body.pngSha256, "orig");
      assert.equal(body.pngBytes, png.length);
      // resize 不传给后端
      assert.deepEqual(calls, [
        ["hostRender", "h-1", { imageId: "9" }],
        ["hostRender", "h-1", { imageId: "9" }],
      ]);
    });
  });
});

describe("粒子回放、轨迹与四角", () => {
  test("render 带 particles 原样转给后端；particles 不合法或同时给 time 回 400，field 指到那一项", async () => {
    const { backend, calls } = fakeBackend();
    await withServer(backend, async (base) => {
      const particles = { dts: [0.1, 0.2], times: [0.1, 0.3], seed: 1, passes: 2, random: { "3": [0.5] } };
      const ok = await post(`${base}/__kabegame_dev/hosts/h-1/render`, { imageId: "14108", particles });
      assert.equal(ok.status, 200);
      await ok.body?.cancel();
      assert.deepEqual(calls, [["hostRender", "h-1", { imageId: "14108", particles }]]);
      for (const [body, field] of [
        [{ imageId: "1", particles: { dts: [0.1, 0] } }, "particles.dts[1]"],
        [{ imageId: "1", particles: { dts: [0.1], passes: 3 } }, "particles.passes"],
        [{ imageId: "1", particles: { dts: [0.1], cursors: [[0.5, 0.5]] } }, "particles.cursors"],
        [{ imageId: "1", particles: { dts: [0.1] }, time: 1.5 }, "time"],
      ] as const) {
        const res = await post(`${base}/__kabegame_dev/hosts/h-1/render`, body);
        assert.equal(res.status, 400, JSON.stringify(body));
        const error = await res.json();
        assert.equal(error.layer, "rest");
        assert.equal(error.field, field);
        assert.ok(error.error.startsWith(`${field} `), error.error);
      }
      assert.equal(calls.length, 1, "参数错时不调后端");
    });
  });

  test("particle-track：校验后转给后端（imageId 转字符串），400 的形状", async () => {
    const { backend, calls } = fakeBackend();
    await withServer(backend, async (base) => {
      const body = {
        imageId: 14176,
        dts: [0.1, 0.1],
        frames: [2],
        passes: 1,
        cursors: [
          [0.5, 0.5],
          [1, 1],
        ],
      };
      const res = await post(`${base}/__kabegame_dev/hosts/h-1/particle-track`, body);
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { source: "sim", project: "p", tag: "", frames: [], skipped: {} });
      assert.deepEqual(calls, [["hostParticleTrack", "h-1", { ...body, imageId: "14176" }]]);
      for (const [bad, field] of [
        [{ ...body, frames: [3] }, "frames[0]"],
        [{ ...body, passes: undefined }, "passes"],
        [{ ...body, cursors: [[0.5, 0.5]] }, "cursors"],
        [{ ...body, imageId: "x" }, "imageId"],
        [{ ...body, extra: 1 }, "extra"],
      ] as const) {
        const r = await post(`${base}/__kabegame_dev/hosts/h-1/particle-track`, bad);
        assert.equal(r.status, 400, JSON.stringify(bad));
        const error = await r.json();
        assert.deepEqual(Object.keys(error).sort(), ["error", "field", "layer"]);
        assert.equal(error.layer, "rest");
        assert.equal(error.field, field);
      }
      assert.equal(calls.length, 1);
    });
  });

  test("particle-corners：校验后转给后端；413、404 原样带出", async () => {
    const { backend, calls } = fakeBackend({
      hostParticleCorners: async (handle, request) => {
        calls.push(["hostParticleCorners", handle, request]);
        if (handle === "h-big") throw new DevError(413, "host", "粒子四角有 40000000 字节，超过上限", { bytes: 4e7 });
        if (handle === "h-gone") throw staleHandle("宿主句柄", handle);
        return [];
      },
    });
    await withServer(backend, async (base) => {
      const body = { imageId: "13815", particles: { dts: [1 / 60] }, layer: "persp", limit: 64 };
      const res = await post(`${base}/__kabegame_dev/hosts/h-1/particle-corners`, body);
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), []);
      assert.deepEqual(calls, [["hostParticleCorners", "h-1", body]]);
      const bad = await post(`${base}/__kabegame_dev/hosts/h-1/particle-corners`, { ...body, limit: -1 });
      assert.equal(bad.status, 400);
      assert.equal((await bad.json()).field, "limit");
      const big = await post(`${base}/__kabegame_dev/hosts/h-big/particle-corners`, body);
      assert.equal(big.status, 413);
      assert.deepEqual(await big.json(), { error: "粒子四角有 40000000 字节，超过上限", layer: "host", bytes: 4e7 });
      const gone = await post(`${base}/__kabegame_dev/hosts/h-gone/particle-corners`, body);
      assert.equal(gone.status, 404);
      assert.equal((await gone.json()).layer, "handle");
      const method = await localFetch(`${base}/__kabegame_dev/hosts/h-1/particle-corners`);
      assert.equal(method.status, 405);
      await method.body?.cancel();
    });
  });

  test("逐帧光标（P5a 收尾）：render / particle-track / particle-corners 收 pointers、cursors 与 window；不对时 400 带 field", async () => {
    const { backend, calls } = fakeBackend({
      hostParticleCorners: async (handle, request) => {
        calls.push(["hostParticleCorners", handle, request]);
        return [];
      },
    });
    await withServer(backend, async (base) => {
      const particles = { dts: [0.1, 0.2] };
      const pointers = [
        [0.1, 0.2],
        [1.4, -0.3],
      ];
      const window = [1920, 800];
      const render = await post(`${base}/__kabegame_dev/hosts/h-1/render`, { imageId: 9, particles, pointers, window });
      assert.equal(render.status, 200);
      await render.body?.cancel();
      const track = await post(`${base}/__kabegame_dev/hosts/h-1/particle-track`, {
        imageId: "9",
        dts: [0.1, 0.2],
        frames: [2],
        passes: 1,
        cursors: pointers,
        window,
      });
      assert.equal(track.status, 200);
      await track.body?.cancel();
      const corners = await post(`${base}/__kabegame_dev/hosts/h-1/particle-corners`, {
        imageId: "9",
        particles,
        pointers,
        window,
      });
      assert.equal(corners.status, 200);
      await corners.body?.cancel();
      assert.deepEqual(calls, [
        ["hostRender", "h-1", { imageId: "9", particles, pointers, window }],
        [
          "hostParticleTrack",
          "h-1",
          { imageId: "9", dts: [0.1, 0.2], frames: [2], passes: 1, cursors: pointers, window },
        ],
        ["hostParticleCorners", "h-1", { imageId: "9", particles, pointers, window }],
      ]);
      for (const [path, bad, field] of [
        ["render", { imageId: "9", pointers }, "pointers"],
        ["render", { imageId: "9", particles, pointers: pointers.slice(1) }, "pointers"],
        ["render", { imageId: "9", particles, pointers, pointer: [0.5, 0.5] }, "pointer"],
        ["render", { imageId: "9", window: [1920] }, "window"],
        ["particle-track", { imageId: "9", dts: [0.1], frames: [1], passes: 1, window }, "window"],
        ["particle-corners", { imageId: "9", particles: { dts: [0.1] }, pointers }, "pointers"],
      ] as const) {
        const r = await post(`${base}/__kabegame_dev/hosts/h-1/${path}`, bad);
        assert.equal(r.status, 400, JSON.stringify(bad));
        const error = await r.json();
        assert.equal(error.layer, "rest");
        assert.equal(error.field, field, error.error);
      }
      assert.equal(calls.length, 3, "参数错时不调后端");
    });
  });
});
