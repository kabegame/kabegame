import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { CdpError, connectCdp, hostParams, isMain, isSceneHost, isWallpaper, wrapExpression } from "./cdp.ts";
import type { SocketLike } from "./cdp.ts";

/** 假 WebSocket：记下发出的消息，测试里手动回包。 */
class FakeSocket implements SocketLike {
  onopen: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  sent: Array<{ id: number; method: string; params: unknown; sessionId?: string }> = [];
  constructor() {
    setTimeout(() => this.onopen?.({}), 0);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.onclose?.({ code: 1000, reason: "closed" });
  }
  reply(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

describe("目标判定", () => {
  const page = (url: string) => ({ type: "page", url });
  test("主窗口：应用自身页面且路径不以 .html 结尾", () => {
    assert.ok(isMain(page("http://localhost:1420/gallery?pvwimgid=1")));
    assert.ok(isMain(page("http://localhost:1420/")));
    assert.ok(isMain(page("tauri://localhost/albums")));
    assert.ok(isMain(page("http://tauri.localhost/gallery")));
    assert.ok(!isMain(page("http://localhost:1420/index.html?window=wallpaper")));
    assert.ok(!isMain(page("http://localhost:1420/surf-navbar.html")));
    assert.ok(!isMain(page("https://www.pixiv.net/")));
    assert.ok(!isMain({ type: "iframe", url: "http://localhost:1420/" }));
  });
  test("壁纸窗口", () => {
    assert.ok(isWallpaper(page("http://localhost:1420/index.html?window=wallpaper")));
    assert.ok(!isWallpaper(page("http://localhost:1420/gallery")));
  });
  test("场景宿主", () => {
    const url = "file:///D:/x/target/debug/resources/wpe-scene/index.html?kbScene=13531&kbInstance=abc";
    assert.ok(isSceneHost({ type: "iframe", url }));
    assert.ok(!isSceneHost({ type: "page", url }));
    assert.deepEqual(hostParams(url), { scene: "13531", instance: "abc" });
  });
});

describe("表达式包装", () => {
  test("表达式按表达式包", () => {
    assert.equal(wrapExpression("document.title"), "(async () => (\ndocument.title\n))()");
    assert.equal(wrapExpression("{ a: 1 }"), "(async () => (\n{ a: 1 }\n))()");
    assert.equal(wrapExpression("await fetch('x')"), "(async () => (\nawait fetch('x')\n))()");
  });
  test("语句按语句块包（可 return）", () => {
    assert.equal(wrapExpression("const x = 1; return x"), "(async () => {\nconst x = 1; return x\n})()");
    assert.equal(wrapExpression("a(); b()"), "(async () => {\na(); b()\n})()");
  });
  test("行尾注释不吞掉右括号", () => {
    assert.equal(wrapExpression("1 + 1 // 注释"), "(async () => (\n1 + 1 // 注释\n))()");
  });
});

describe("连接", () => {
  test("请求与回包按 id 对上，事件分发给订阅者", async () => {
    let socket!: FakeSocket;
    const conn = await connectCdp("ws://fake", { createSocket: () => (socket = new FakeSocket()) });
    const events: string[] = [];
    conn.on((event) => events.push(`${event.method}@${event.sessionId}`));
    const pending = conn.send("Target.getTargets");
    const sent = socket.sent.at(-1)!;
    assert.equal(sent.method, "Target.getTargets");
    socket.reply({ method: "Target.detachedFromTarget", params: { sessionId: "S" }, sessionId: undefined });
    socket.reply({ id: sent.id, result: { targetInfos: [] } });
    assert.deepEqual(await pending, { targetInfos: [] });
    assert.deepEqual(events, ["Target.detachedFromTarget@undefined"]);
    conn.close();
  });

  test("协议错误转成 CdpError(protocol)", async () => {
    let socket!: FakeSocket;
    const conn = await connectCdp("ws://fake", { createSocket: () => (socket = new FakeSocket()) });
    const pending = conn.send("Runtime.evaluate", {}, { sessionId: "S1" });
    const sent = socket.sent.at(-1)!;
    assert.equal(sent.sessionId, "S1");
    socket.reply({ id: sent.id, error: { message: "Session with given id not found." } });
    await assert.rejects(pending, (error) => error instanceof CdpError && error.code === "protocol");
    conn.close();
  });

  test("页面异常转成 CdpError(exception)", async () => {
    let socket!: FakeSocket;
    const conn = await connectCdp("ws://fake", { createSocket: () => (socket = new FakeSocket()) });
    const pending = conn.evaluate("S1", "boom()");
    const sent = socket.sent.at(-1)!;
    socket.reply({
      id: sent.id,
      result: {
        result: { type: "object" },
        exceptionDetails: { text: "Uncaught", exception: { description: "ReferenceError: boom is not defined" } },
      },
    });
    await assert.rejects(pending, (error) => error instanceof CdpError && /boom is not defined/.test(error.message));
    conn.close();
  });

  test("求值结果：undefined 记为 null", async () => {
    let socket!: FakeSocket;
    const conn = await connectCdp("ws://fake", { createSocket: () => (socket = new FakeSocket()) });
    const pending = conn.evaluate("S1", "void 0");
    socket.reply({ id: socket.sent.at(-1)!.id, result: { result: { type: "undefined" } } });
    assert.deepEqual(await pending, { value: null, type: "undefined" });
    conn.close();
  });

  test("超时拒绝", async () => {
    const conn = await connectCdp("ws://fake", { createSocket: () => new FakeSocket() });
    await assert.rejects(
      conn.send("Page.captureScreenshot", {}, { timeoutMs: 20 }),
      (error) => error instanceof CdpError && error.code === "timeout",
    );
    conn.close();
  });

  test("连接断开时拒绝全部待回请求，之后的请求直接拒绝", async () => {
    let socket!: FakeSocket;
    const conn = await connectCdp("ws://fake", { createSocket: () => (socket = new FakeSocket()) });
    const reasons: string[] = [];
    conn.onClose((reason) => reasons.push(reason));
    const a = conn.send("A");
    const b = conn.send("B");
    socket.close();
    await assert.rejects(a, (error) => error instanceof CdpError && error.code === "closed");
    await assert.rejects(b, (error) => error instanceof CdpError && error.code === "closed");
    assert.equal(conn.closed, true);
    assert.equal(reasons.length, 1);
    await assert.rejects(conn.send("C"), (error) => error instanceof CdpError && error.code === "closed");
  });
});
