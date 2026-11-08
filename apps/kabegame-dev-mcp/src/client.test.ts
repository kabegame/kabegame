import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { KabegameDevError, createClient, defaultVitePort } from "./client.ts";
import type { JobRecord } from "./client.ts";
import { fileURLToPath } from "node:url";
import { deadPort, runWithProxy, startFakeProxy } from "../../../scripts/kabegame-dev/testdata/fakes.ts";

const PNG = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="),
  (c) => c.charCodeAt(0),
);

type Handler = (req: IncomingMessage, body: unknown, res: ServerResponse) => void;

/** 假的 REST 服务：记录每个请求（方法、路径、请求体），按 handler 回包。 */
async function fakeRest(handler: Handler) {
  const seen: Array<{ method: string; path: string; body: unknown }> = [];
  const server = createServer(async (req, res) => {
    const chunks: Uint8Array[] = [];
    for await (const chunk of req) chunks.push(chunk as Uint8Array);
    const text = Buffer.concat(chunks).toString("utf8");
    const body = text ? JSON.parse(text) : undefined;
    seen.push({ method: req.method ?? "", path: req.url ?? "", body });
    handler(req, body, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    seen,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
};

describe("客户端：每个接口一个函数", () => {
  test("路径、方法、请求体与 REST 表一致", async () => {
    const rest = await fakeRest((req, _body, res) => {
      if (req.url?.endsWith("/screenshot") || req.url?.endsWith("/android/screen")) {
        res.writeHead(200, { "Content-Type": "image/png" });
        res.end(PNG);
        return;
      }
      if (req.url?.endsWith("/text")) return json(res, 200, { text: "T" });
      if (req.url?.endsWith("/invoke")) return json(res, 200, { value: "window" });
      json(res, 200, { ok: true });
    });
    try {
      const dev = createClient({ port: rest.port });
      assert.equal(dev.baseUrl, `http://127.0.0.1:${rest.port}/__kabegame_dev`);
      await dev.health();
      await dev.targets();
      await dev.evaluate("main", "document.title", 5000);
      assert.deepEqual(await dev.screenshot("main", { clip: { x: 0, y: 0, width: 10, height: 10 } }), PNG);
      await dev.click("main", ".a");
      assert.equal(await dev.text("main", ".a"), "T");
      assert.equal(await dev.invoke("get_wallpaper_mode"), "window");
      await dev.consoleStart("main");
      await dev.consoleRead("c-1", 3);
      await dev.consoleStop("c-1");
      await dev.appState();
      assert.deepEqual(await dev.androidScreen(), PNG);
      await dev.hosts();
      await dev.hostOpen({ hidden: true });
      await dev.hostEval("h-1", "1");
      await dev.hostRender("h-1", { imageId: "13515", time: 1.5, postprocess: "ultra" });
      await dev.hostClose("h-1");
      await dev.projectsRemove({ "D:\\x": { image: "1", task: "t" } });
      await dev.jobStart("hash-baseline", { ids: ["1"] });
      await dev.jobs();
      await dev.job("j-1");
      await dev.jobCancel("j-1");
      const p = "/__kabegame_dev";
      assert.deepEqual(
        rest.seen.map((r) => [r.method, r.path, r.body]),
        [
          ["GET", `${p}/health`, undefined],
          ["GET", `${p}/targets`, undefined],
          ["POST", `${p}/eval`, { target: "main", expression: "document.title", timeoutMs: 5000 }],
          ["POST", `${p}/screenshot`, { target: "main", clip: { x: 0, y: 0, width: 10, height: 10 } }],
          ["POST", `${p}/click`, { target: "main", selector: ".a" }],
          ["POST", `${p}/text`, { target: "main", selector: ".a" }],
          ["POST", `${p}/invoke`, { command: "get_wallpaper_mode", args: {} }],
          ["POST", `${p}/console`, { target: "main" }],
          ["GET", `${p}/console/c-1?since=3`, undefined],
          ["DELETE", `${p}/console/c-1`, undefined],
          ["GET", `${p}/app/state`, undefined],
          ["GET", `${p}/android/screen`, undefined],
          ["GET", `${p}/hosts`, undefined],
          ["POST", `${p}/hosts`, { hidden: true }],
          ["POST", `${p}/hosts/h-1/eval`, { expression: "1" }],
          ["POST", `${p}/hosts/h-1/render`, { imageId: "13515", time: 1.5, postprocess: "ultra" }],
          ["DELETE", `${p}/hosts/h-1`, undefined],
          ["POST", `${p}/projects/remove`, { manifest: { "D:\\x": { image: "1", task: "t" } } }],
          ["POST", `${p}/jobs`, { kind: "hash-baseline", params: { ids: ["1"] } }],
          ["GET", `${p}/jobs`, undefined],
          ["GET", `${p}/jobs/j-1`, undefined],
          ["DELETE", `${p}/jobs/j-1`, undefined],
        ],
      );
    } finally {
      await rest.close();
    }
  });
});

describe("客户端：错误带层级", () => {
  test("vite 不在：layer vite、status null，提示启动 dev", async () => {
    const rest = await fakeRest(() => {});
    const port = rest.port;
    await rest.close();
    const dev = createClient({ port });
    await assert.rejects(
      dev.health(),
      (error) =>
        error instanceof KabegameDevError &&
        error.layer === "vite" &&
        error.status === null &&
        /vite 不在/.test(error.message) &&
        /deno task dev -c kabegame/.test(error.message),
    );
  });

  test("vite 在但没有插件（SPA 兜底回 HTML）：layer vite", async () => {
    const rest = await fakeRest((_req, _body, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<!doctype html>");
    });
    try {
      const dev = createClient({ port: rest.port });
      await assert.rejects(
        dev.health(),
        (error) =>
          error instanceof KabegameDevError && error.layer === "vite" && /没有 kabegame-dev 插件/.test(error.message),
      );
    } finally {
      await rest.close();
    }
  });

  test("CDP 不在：layer cdp，带端点结论", async () => {
    const endpoint = { layer: "cdp", error: "登记的 CDP 端口 1 不应答", port: 1 };
    const rest = await fakeRest((_req, _body, res) =>
      json(res, 503, { error: "CDP 不可用：登记的 CDP 端口 1 不应答", layer: "cdp", endpoint }),
    );
    try {
      const dev = createClient({ port: rest.port });
      await assert.rejects(
        dev.targets(),
        (error) =>
          error instanceof KabegameDevError &&
          error.layer === "cdp" &&
          error.status === 503 &&
          /CDP 不在/.test(error.message) &&
          error.endpoint?.port === 1,
      );
    } finally {
      await rest.close();
    }
  });

  test("REST 回的其它层原样带出（例如句柄 404）", async () => {
    const rest = await fakeRest((_req, _body, res) =>
      json(res, 404, { error: "宿主句柄 h-1 不存在：vite 重启过", layer: "handle", id: "h-1" }),
    );
    try {
      const dev = createClient({ port: rest.port });
      await assert.rejects(
        dev.hostClose("h-1"),
        (error) => error instanceof KabegameDevError && error.layer === "handle" && error.status === 404,
      );
    } finally {
      await rest.close();
    }
  });

  test("端口取 KABEGAME_DEV_SERVER_PORT，缺省 1420", () => {
    assert.equal(defaultVitePort({}), 1420);
    assert.equal(defaultVitePort({ KABEGAME_DEV_SERVER_PORT: "5173" }), 5173);
    assert.equal(defaultVitePort({ KABEGAME_DEV_SERVER_PORT: "x" }), 1420);
  });
});

describe("waitJob", () => {
  test("轮询到结束，进度变化时回调", async () => {
    let polls = 0;
    const rest = await fakeRest((_req, _body, res) => {
      polls++;
      const record: Partial<JobRecord> = {
        id: "j-1",
        kind: "hash-baseline",
        status: polls < 3 ? "running" : "done",
        progress: { done: Math.min(polls, 2), total: 2 },
        result: polls < 3 ? undefined : { ok: true },
      };
      json(res, 200, record);
    });
    try {
      const dev = createClient({ port: rest.port });
      const progress: unknown[] = [];
      const record = await dev.waitJob("j-1", { intervalMs: 5, onProgress: (p) => progress.push(p) });
      assert.equal(record.status, "done");
      assert.deepEqual(record.result, { ok: true });
      assert.deepEqual(progress, [
        { done: 1, total: 2 },
        { done: 2, total: 2 },
      ]);
    } finally {
      await rest.close();
    }
  });

  test("任务丢了（vite 重启）：抛 handle 层", async () => {
    const rest = await fakeRest((_req, _body, res) =>
      json(res, 404, { error: "任务 j-1 不存在：vite 重启过", layer: "handle", id: "j-1" }),
    );
    try {
      const dev = createClient({ port: rest.port });
      await assert.rejects(
        dev.waitJob("j-1", { intervalMs: 5 }),
        (error) => error instanceof KabegameDevError && error.layer === "handle",
      );
    } finally {
      await rest.close();
    }
  });
});

describe("客户端：不经代理", () => {
  test("设了会回 502 的假代理（不设 NO_PROXY）：vite 不在仍判成 vite 层，正常请求直达", async () => {
    const proxy = await startFakeProxy();
    const rest = await fakeRest((_req, _body, res) =>
      json(res, 200, {
        vite: true,
        android: false,
        cdp: { kind: "desktop", port: 1, webSocketUrl: "ws://x" },
        session: {
          connected: false,
          generation: 0,
          endpoint: null,
          hosts: [],
          consoles: [],
          jobs: { running: 0, total: 0 },
        },
      }),
    );
    const dead = await deadPort();
    try {
      const out = (await runWithProxy(
        fileURLToPath(new URL("./testdata/clientProxyChild.ts", import.meta.url)),
        [String(rest.port), String(dead)],
        proxy.url,
      )) as {
        control: string;
        dead: { layer?: string; status?: number | null; message?: string };
        live: { ok: boolean; value?: { vite: boolean } };
      };
      // 对照组：子进程里的全局 fetch 确实被交给了假代理
      assert.match(out.control, /^502 fake proxy 502/);
      assert.equal(out.dead.layer, "vite", JSON.stringify(out.dead));
      assert.equal(out.dead.status, null);
      assert.match(out.dead.message ?? "", /vite 不在/);
      assert.equal(out.live.ok, true, JSON.stringify(out.live));
      assert.equal(out.live.value?.vite, true);
      // 代理只见过对照组那一个请求；健康检查直达假 REST
      assert.deepEqual(proxy.hits, [`GET http://127.0.0.1:${rest.port}/control`]);
      assert.deepEqual(
        rest.seen.map((r) => r.path),
        ["/__kabegame_dev/health"],
      );
    } finally {
      await rest.close();
      await proxy.close();
    }
  });
});
