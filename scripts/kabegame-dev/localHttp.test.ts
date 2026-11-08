import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { connectCdp } from "./cdp.ts";
import { encodeClientFrame, localFetch, localWebSocket } from "./localHttp.ts";
import { deadPort, decodeClientFrame, encodeServerFrame, startFakeCdp } from "./testdata/fakes.ts";

async function echoServer() {
  const server = createServer(async (req, res) => {
    if (req.url === "/hang") return; // 永不回应
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    if (req.url === "/empty") {
      res.writeHead(204, { "X-Test": "a" });
      res.end();
      return;
    }
    res.writeHead(201, { "Content-Type": "application/json", "X-Multi": ["1", "2"] });
    res.end(
      JSON.stringify({
        method: req.method,
        url: req.url,
        body: Buffer.concat(chunks).toString("utf8"),
        origin: req.headers.origin ?? null,
        host: req.headers.host,
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as AddressInfo).port,
    close: () => {
      server.closeAllConnections?.();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe("localFetch", () => {
  test("方法、请求头、请求体、状态与响应头", async () => {
    const server = await echoServer();
    try {
      const res = await localFetch(`http://127.0.0.1:${server.port}/a?b=1`, {
        method: "POST",
        headers: { Origin: "http://evil.example", "Content-Type": "application/json" },
        body: JSON.stringify({ 中文: 1 }),
      });
      assert.equal(res.status, 201);
      assert.equal(res.headers.get("content-type"), "application/json");
      assert.equal(res.headers.get("x-multi"), "1, 2");
      assert.deepEqual(await res.json(), {
        method: "POST",
        url: "/a?b=1",
        body: '{"中文":1}',
        origin: "http://evil.example",
        host: `127.0.0.1:${server.port}`,
      });
      const empty = await localFetch(`http://127.0.0.1:${server.port}/empty`);
      assert.equal(empty.status, 204);
      assert.equal(empty.headers.get("x-test"), "a");
      assert.equal(empty.body, null);
    } finally {
      await server.close();
    }
  });

  test("连不上：TypeError（同 fetch）", async () => {
    const port = await deadPort();
    await assert.rejects(localFetch(`http://127.0.0.1:${port}/`), (error) => error instanceof TypeError);
  });

  test("超时：抛 signal.reason（TimeoutError）", async () => {
    const server = await echoServer();
    try {
      await assert.rejects(
        localFetch(`http://127.0.0.1:${server.port}/hang`, { signal: AbortSignal.timeout(100) }),
        (error) => error instanceof DOMException && error.name === "TimeoutError",
      );
    } finally {
      await server.close();
    }
  });

  test("只支持 http:", async () => {
    await assert.rejects(localFetch("https://127.0.0.1/"), (error) => error instanceof TypeError);
  });
});

describe("localWebSocket", () => {
  test("帧编码：7 位、16 位、64 位长度都能被解回", () => {
    for (const size of [0, 125, 126, 65535, 65536, 70000]) {
      const payload = Buffer.alloc(size, 7);
      const frame = encodeClientFrame(0x1, payload);
      const decoded = decodeClientFrame(frame)!;
      assert.equal(decoded.opcode, 0x1);
      assert.equal(decoded.size, frame.length);
      assert.deepEqual(decoded.payload, payload);
    }
  });

  test("经 connectCdp 收发；大消息、分片消息、ping、服务端关闭", async () => {
    const big = "x".repeat(3 * 1024 * 1024);
    const cdp = await startFakeCdp((message, peer) => {
      if (message.method === "Test.big") {
        peer.sendText(JSON.stringify({ id: message.id, result: { big } }));
      } else if (message.method === "Test.fragmented") {
        const text = Buffer.from(JSON.stringify({ id: message.id, result: { parts: 2 } }));
        const half = Math.floor(text.length / 2);
        peer.sendFrame(
          Buffer.concat([
            encodeServerFrame(0x1, text.subarray(0, half), false),
            encodeServerFrame(0x9, Buffer.from("ping!")),
          ]),
        );
        peer.sendFrame(encodeServerFrame(0x0, text.subarray(half)));
      } else if (message.method === "Test.close") {
        peer.close(1001);
      } else {
        peer.sendText(JSON.stringify({ id: message.id, result: { method: message.method } }));
      }
    });
    try {
      const conn = await connectCdp(`ws://127.0.0.1:${cdp.port}/devtools/browser/fake`, {
        createSocket: (url) => localWebSocket(url),
      });
      assert.deepEqual(await conn.send("Target.getTargets"), { method: "Target.getTargets" });
      const result = await conn.send<{ big: string }>("Test.big");
      assert.equal(result.big.length, big.length);
      assert.deepEqual(await conn.send("Test.fragmented"), { parts: 2 });
      // pong 是客户端收到 ping 时回的，到服务端可能比分片消息的回包晚一点
      for (let i = 0; i < 50 && !cdp.pongs.length; i++) await new Promise((r) => setTimeout(r, 20));
      assert.deepEqual(cdp.pongs, ["ping!"]);
      const reasons: string[] = [];
      conn.onClose((reason) => reasons.push(reason));
      void conn.send("Test.close").catch(() => {});
      for (let i = 0; i < 50 && !conn.closed; i++) await new Promise((r) => setTimeout(r, 20));
      assert.equal(conn.closed, true);
      assert.match(reasons[0], /1001/);
    } finally {
      await cdp.close();
    }
  });

  test("连不上：onerror 后 onclose", async () => {
    const port = await deadPort();
    const events: string[] = [];
    await new Promise<void>((resolve) => {
      const ws = localWebSocket(`ws://127.0.0.1:${port}/`);
      ws.onerror = () => events.push("error");
      ws.onclose = () => {
        events.push("close");
        resolve();
      };
    });
    assert.deepEqual(events, ["error", "close"]);
  });
});
