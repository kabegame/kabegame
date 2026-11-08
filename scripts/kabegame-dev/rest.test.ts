import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { DevError, staleHandle } from "./errors.ts";
import { checkAccess, createRestHandler, pngSize } from "./rest.ts";
import { localFetch } from "./localHttp.ts";
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
    androidScreen: record("androidScreen", PNG),
    hosts: record("hosts", []),
    hostOpen: record("hostOpen", {} as never),
    hostClose: record("hostClose", {} as never),
    hostEval: record("hostEval", { value: 1, type: "number" }),
    hostRender: record("hostRender", {} as never),
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
