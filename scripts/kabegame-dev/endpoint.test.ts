import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { parseForwardList, probeCdp, resolveEndpoint } from "./endpoint.ts";
import type { Exec, ExecResult } from "./endpoint.ts";
import type { Endpoint, EndpointError } from "./types.ts";
import { fileURLToPath } from "node:url";
import { runWithProxy, startFakeCdp, startFakeProxy } from "./testdata/fakes.ts";

/** 假的 DevTools / vite：`mode` 决定 `/json/version` 回什么。 */
async function fakeServer(mode: "cdp" | "spa"): Promise<{ port: number; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    if (mode === "spa") {
      // vite 的 SPA 兜底：任意路径都回 200 text/html
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<!doctype html><html></html>");
      return;
    }
    if (req.url === "/json/version") {
      const port = (server.address() as AddressInfo).port;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({ Browser: "Chrome/149", webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/x` }),
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as AddressInfo).port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** 一个肯定没人监听的端口：先占后放。 */
async function deadPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

const ok = (stdout = ""): ExecResult => ({ code: 0, stdout: new TextEncoder().encode(stdout), stderr: "" });
const fail = (stderr: string, code = 1): ExecResult => ({ code, stdout: new Uint8Array(), stderr });

/** 假 adb：按参数前缀回答，记录调用。 */
function fakeAdb(answers: Record<string, ExecResult | (() => ExecResult)>): { exec: Exec; calls: string[] } {
  const calls: string[] = [];
  const exec: Exec = async (file, args) => {
    assert.equal(file, "adb");
    const line = args.join(" ");
    calls.push(line);
    const key = Object.keys(answers)
      .filter((prefix) => line === prefix || line.startsWith(prefix + " "))
      .sort((a, b) => b.length - a.length)[0];
    if (key === undefined) return ok();
    const answer = answers[key];
    return typeof answer === "function" ? answer() : answer;
  };
  return { exec, calls };
}

describe("桌面端点", () => {
  test("登记的端口应答 /json/version 就用它", async () => {
    const server = await fakeServer("cdp");
    try {
      const result = await resolveEndpoint({
        android: false,
        readRegistration: async () => ({ port: server.port, pid: 42 }),
      });
      assert.ok(!("error" in result), JSON.stringify(result));
      const endpoint = result as Endpoint;
      assert.equal(endpoint.kind, "desktop");
      assert.equal(endpoint.port, server.port);
      assert.equal(endpoint.pid, 42);
      assert.equal(endpoint.browser, "Chrome/149");
      assert.match(endpoint.webSocketUrl, /^ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\//);
    } finally {
      await server.close();
    }
  });

  test("没有登记：报 registration 层", async () => {
    const result = (await resolveEndpoint({ android: false, readRegistration: async () => null })) as EndpointError;
    assert.equal(result.layer, "registration");
    assert.match(result.error, /没有 CDP 端口登记/);
  });

  test("登记陈旧（端口没人听）：报 cdp 层并带端口", async () => {
    const port = await deadPort();
    const result = (await resolveEndpoint({
      android: false,
      readRegistration: async () => ({ port, pid: 7 }),
    })) as EndpointError;
    assert.equal(result.layer, "cdp");
    assert.equal(result.port, port);
    assert.match(result.hint ?? "", /热重启/);
  });

  test("vite 的 SPA 兜底回 200 HTML 不算 CDP", async () => {
    const server = await fakeServer("spa");
    try {
      const probe = await probeCdp(server.port);
      assert.ok("error" in probe);
      const result = (await resolveEndpoint({
        android: false,
        readRegistration: async () => ({ port: server.port, pid: null }),
      })) as EndpointError;
      assert.equal(result.layer, "cdp");
    } finally {
      await server.close();
    }
  });
});

describe("安卓端点", () => {
  const unix = (pid: number) =>
    [
      "Num       RefCount Protocol Flags    Type St Inode Path",
      "0000000000000000: 00000002 00000000 00010000 0001 01 123 @webview_devtools_remote_999",
      `0000000000000000: 00000002 00000000 00010000 0001 01 456 @webview_devtools_remote_${pid}`,
    ].join("\r\n");

  test("复用指向同一 socket 且应答的转发，清掉指向旧 socket 的转发", async () => {
    const server = await fakeServer("cdp");
    try {
      const { exec, calls } = fakeAdb({
        version: ok("Android Debug Bridge version 1.0.41"),
        "get-state": ok("device"),
        "get-serialno": ok("SER123\r\n"),
        "shell pidof app.kabegame.dev": ok("4321\r\n"),
        "shell cat /proc/net/unix": ok(unix(4321)),
        "forward --list": ok(
          [
            `SER123 tcp:${server.port} localabstract:webview_devtools_remote_4321`,
            "SER123 tcp:5555 localabstract:webview_devtools_remote_999",
            "OTHER tcp:6666 localabstract:webview_devtools_remote_1",
          ].join("\r\n"),
        ),
      });
      const result = await resolveEndpoint({ android: true, exec, androidPackage: "app.kabegame.dev" });
      assert.ok(!("error" in result), JSON.stringify(result));
      const endpoint = result as Endpoint;
      assert.equal(endpoint.kind, "android");
      assert.equal(endpoint.port, server.port);
      assert.equal(endpoint.pid, 4321);
      assert.equal(endpoint.serial, "SER123");
      assert.equal(endpoint.socket, "webview_devtools_remote_4321");
      assert.ok(calls.includes("forward --remove tcp:5555"), calls.join("\n"));
      // 别的设备的转发不动，也不新建转发
      assert.ok(!calls.includes("forward --remove tcp:6666"));
      assert.ok(!calls.some((c) => c.startsWith("forward tcp:0")));
    } finally {
      await server.close();
    }
  });

  test("没有可用转发时 tcp:0 新建，并移除指向本 socket 但不应答的旧转发", async () => {
    const server = await fakeServer("cdp");
    const stale = await deadPort();
    try {
      const { exec, calls } = fakeAdb({
        version: ok("adb"),
        "get-state": ok("device"),
        "get-serialno": ok("SER123"),
        "shell pidof app.kabegame.dev": ok("4321"),
        "shell cat /proc/net/unix": ok(unix(4321)),
        "forward --list": ok(`SER123 tcp:${stale} localabstract:webview_devtools_remote_4321`),
        "forward tcp:0 localabstract:webview_devtools_remote_4321": ok(`${server.port}\n`),
      });
      const result = (await resolveEndpoint({ android: true, exec, androidPackage: "app.kabegame.dev" })) as Endpoint;
      assert.equal(result.port, server.port);
      assert.ok(calls.includes(`forward --remove tcp:${stale}`), calls.join("\n"));
      assert.ok(calls.includes("forward tcp:0 localabstract:webview_devtools_remote_4321"));
    } finally {
      await server.close();
    }
  });

  test("找不到 adb", async () => {
    const { exec } = fakeAdb({
      version: { code: null, stdout: new Uint8Array(), stderr: "", spawnError: "ENOENT" },
    });
    const result = (await resolveEndpoint({ android: true, exec })) as EndpointError;
    assert.equal(result.layer, "adb");
    assert.match(result.error, /ENOENT/);
  });

  test("没设备", async () => {
    const { exec } = fakeAdb({ version: ok("adb"), "get-state": fail("error: no devices/emulators found") });
    const result = (await resolveEndpoint({ android: true, exec })) as EndpointError;
    assert.equal(result.layer, "device");
    assert.match(result.error, /no devices/);
  });

  test("app 没在跑", async () => {
    const { exec } = fakeAdb({
      version: ok("adb"),
      "get-state": ok("device"),
      "get-serialno": ok("SER123"),
      "shell pidof app.kabegame.dev": fail("", 1),
    });
    const result = (await resolveEndpoint({
      android: true,
      exec,
      androidPackage: "app.kabegame.dev",
    })) as EndpointError;
    assert.equal(result.layer, "app");
    assert.match(result.hint ?? "", /--mode android/);
  });

  test("没有调试 socket", async () => {
    const { exec, calls } = fakeAdb({
      version: ok("adb"),
      "get-state": ok("device"),
      "get-serialno": ok("SER123"),
      "shell pidof app.kabegame.dev": ok("4321"),
      "shell cat /proc/net/unix": ok(unix(1111)),
    });
    const result = (await resolveEndpoint({
      android: true,
      exec,
      androidPackage: "app.kabegame.dev",
    })) as EndpointError;
    assert.equal(result.layer, "socket");
    assert.equal(result.pid, 4321);
    assert.ok(!calls.some((c) => c.startsWith("forward")), "没有 socket 时不该动转发");
  });

  test("forward --list 解析", () => {
    assert.deepEqual(parseForwardList("A tcp:1 localabstract:x\n\nB tcp:2 localabstract:y\n"), [
      { serial: "A", local: "tcp:1", remote: "localabstract:x" },
      { serial: "B", local: "tcp:2", remote: "localabstract:y" },
    ]);
  });
});

describe("端点探测不经代理", () => {
  test("设了会回 502 的假代理（不设 NO_PROXY）：/json/version 与 CDP WebSocket 都直连", async () => {
    const proxy = await startFakeProxy();
    const cdp = await startFakeCdp();
    const dead = await deadPort();
    try {
      const out = (await runWithProxy(
        fileURLToPath(new URL("./testdata/endpointProxyChild.ts", import.meta.url)),
        [String(cdp.port), String(dead)],
        proxy.url,
      )) as {
        control: string;
        probeLive: { webSocketUrl?: string; error?: string };
        probeDead: { error?: string };
        desktopLive: Endpoint;
        desktopDead: EndpointError;
        ws: unknown;
      };
      // 对照组：子进程里的全局 fetch 确实被交给了假代理
      assert.match(out.control, /^502 fake proxy 502/);
      assert.equal(out.probeLive.webSocketUrl, `ws://127.0.0.1:${cdp.port}/devtools/browser/fake`);
      assert.ok(out.probeDead.error, JSON.stringify(out.probeDead));
      assert.doesNotMatch(out.probeDead.error!, /502|JSON/);
      assert.equal(out.desktopLive.kind, "desktop");
      assert.equal(out.desktopDead.layer, "cdp");
      // Windows 上连回环的空端口要约 2 s 才被拒，可能先撞上 2 s 的探活超时；两种都对，关键是没经代理（不是 502）
      assert.match(out.desktopDead.error, /连不上|timeout/);
      assert.doesNotMatch(out.desktopDead.error, /502|JSON/);
      assert.deepEqual(out.ws, { method: "Target.getTargets" });
      assert.deepEqual(proxy.hits, [`GET http://127.0.0.1:${cdp.port}/control`]);
    } finally {
      await cdp.close();
      await proxy.close();
    }
  });
});
