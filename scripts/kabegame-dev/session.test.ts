import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { DevError } from "./errors.ts";
import { devPaths } from "./paths.ts";
import { DevSession } from "./session.ts";
import type { CdpConnection, CdpEvent, TargetInfo } from "./cdp.ts";

const TARGETS: TargetInfo[] = [
  { targetId: "W", type: "page", title: "", url: "http://localhost:1420/index.html?window=wallpaper", attached: false },
  { targetId: "M", type: "page", title: "", url: "http://localhost:1420/gallery", attached: false },
  {
    targetId: "H",
    type: "iframe",
    title: "",
    url: "file:///D:/k/target/debug/resources/wpe-scene/index.html?kbScene=1&kbInstance=inst-1",
    attached: false,
    parentId: "M",
  },
  { targetId: "S", type: "page", title: "", url: "https://surf.example/", attached: false },
];

/** 假连接：只实现会用到的部分。 */
function fakeConnection(): CdpConnection & { fireClose: (reason: string) => void; attaches: string[] } {
  const closeHandlers = new Set<(reason: string) => void>();
  const handlers = new Set<(event: CdpEvent) => void>();
  let closed = false;
  const attaches: string[] = [];
  return {
    url: "ws://fake",
    get closed() {
      return closed;
    },
    attaches,
    send: async <T>() => ({}) as T,
    on: (handler) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    onClose: (handler) => {
      closeHandlers.add(handler);
      return () => closeHandlers.delete(handler);
    },
    targets: async () => TARGETS,
    attach: async (targetId) => {
      attaches.push(targetId);
      return `session-${targetId}`;
    },
    detach: async () => {},
    evaluate: async () => ({ value: null, type: "undefined" }),
    close: () => {
      closed = true;
    },
    fireClose(reason) {
      closed = true;
      for (const handler of closeHandlers) handler(reason);
    },
  };
}

function session(conn = fakeConnection()) {
  let connects = 0;
  const s = new DevSession({
    resolveEndpoint: async () => ({ kind: "desktop", port: 1, webSocketUrl: "ws://fake" }),
    connect: async () => {
      connects++;
      return conn;
    },
    vitePort: 1420,
    android: false,
    paths: devPaths("/repo", {}),
  });
  return { s, conn, connects: () => connects };
}

describe("目标解析", () => {
  test("main 不会选中排在前面的壁纸窗口", async () => {
    const { s } = session();
    assert.equal((await s.resolveTarget("main")).targetId, "M");
    assert.equal((await s.resolveTarget("wallpaper")).targetId, "W");
  });

  test("url: 子串优先 page", async () => {
    const { s } = session();
    assert.equal((await s.resolveTarget("url:surf")).targetId, "S");
    assert.equal((await s.resolveTarget("url:wpe-scene")).targetId, "H");
  });

  test("host: 按 kbInstance 找宿主", async () => {
    const { s } = session();
    const resolved = await s.resolveTarget("host:inst-1");
    assert.equal(resolved.targetId, "H");
    assert.equal(resolved.role, "scene-host");
    assert.deepEqual(resolved.host, { handle: null, instance: "inst-1", scene: "1" });
  });

  test("像句柄但不存在：404（vite 可能重启过）", async () => {
    const { s } = session();
    await assert.rejects(
      s.resolveTarget("host:h-0badf00d"),
      (error) => error instanceof DevError && error.status === 404 && error.layer === "handle",
    );
  });

  test("没有匹配的目标：422 并列出现有目标", async () => {
    const { s } = session();
    await assert.rejects(
      s.resolveTarget("url:nothing-here"),
      (error) => error instanceof DevError && error.status === 422 && /surf\.example/.test(error.message),
    );
  });

  test("写法不对：400", async () => {
    const { s } = session();
    await assert.rejects(s.resolveTarget("tab:1"), (error) => error instanceof DevError && error.status === 400);
  });
});

describe("连接", () => {
  test("找不到端点：503，带端点结论", async () => {
    const s = new DevSession({
      resolveEndpoint: async () => ({ layer: "registration", error: "vite 上没有 CDP 端口登记" }),
      vitePort: 1420,
      android: false,
      paths: devPaths("/repo", {}),
    });
    await assert.rejects(
      s.connection(),
      (error) =>
        error instanceof DevError &&
        error.status === 503 &&
        error.layer === "cdp" &&
        (error.extra.endpoint as { layer: string }).layer === "registration",
    );
  });

  test("连接复用；断开后句柄作废、下一次请求重连", async () => {
    const first = fakeConnection();
    const second = fakeConnection();
    let n = 0;
    const s = new DevSession({
      resolveEndpoint: async () => ({ kind: "desktop", port: 1, webSocketUrl: "ws://fake" }),
      connect: async () => (n++ === 0 ? first : second),
      vitePort: 1420,
      android: false,
      paths: devPaths("/repo", {}),
    });
    assert.equal(await s.connection(), await s.connection());
    assert.equal(await s.attached("M"), "session-M");
    assert.equal(await s.attached("M"), "session-M");
    assert.deepEqual(first.attaches, ["M"], "session 要缓存");
    s.hosts.set("h-12345678", {
      handle: "h-12345678",
      instance: "inst-1",
      scene: "1",
      targetId: "H",
      hidden: true,
      elementId: "x",
      entry: "index-a.js",
      build: { entry: "index-a.js", frameVisibility: "visible", corpusHead: "" },
      known: new Set(),
      before: { vis: "", route: "", preview: false, grid: "" },
      generation: s.generation,
    });
    assert.equal(s.host("h-12345678").instance, "inst-1");
    first.fireClose("测试");
    assert.equal(s.connected, false);
    assert.throws(
      () => s.host("h-12345678"),
      (error) => error instanceof DevError && error.status === 404,
    );
    assert.equal(await s.connection(), second);
    assert.equal(s.generation, 2);
    await s.attached("M");
    assert.deepEqual(second.attaches, ["M"], "新连接上重新 attach");
  });

  test("关闭后的请求回 503", async () => {
    const { s } = session();
    await s.connection();
    await s.close();
    await assert.rejects(s.connection(), (error) => error instanceof DevError && error.status === 503);
  });
});
