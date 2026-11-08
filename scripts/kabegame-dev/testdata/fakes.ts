/**
 * 单测用的假服务：会回 502 的假代理、带 WebSocket 的假 CDP，以及「带假代理环境变量跑子进程」。
 * 代理相关的单测必须在子进程里跑：Deno 的 fetch 第一次请求后就缓存了代理设置，进程内改环境变量不起作用。
 */
import { Buffer } from "node:buffer";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import process from "node:process";

const listen = async (server: Server) => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
};
const closeServer = (server: Server) => {
  server.closeAllConnections?.();
  return new Promise<void>((resolve) => server.close(() => resolve()));
};

/** 假代理：任何请求（含 CONNECT、Upgrade）都记下来并回 502。 */
export async function startFakeProxy() {
  const hits: string[] = [];
  const server = createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    res.writeHead(502, { "Content-Type": "text/plain" });
    res.end("fake proxy 502");
  });
  server.on("connect", (req, socket: Duplex) => {
    hits.push(`CONNECT ${req.url}`);
    socket.on("error", () => {});
    socket.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n");
  });
  server.on("upgrade", (req, socket: Duplex) => {
    hits.push(`UPGRADE ${req.url}`);
    socket.on("error", () => {});
    socket.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n");
  });
  const port = await listen(server);
  return { port, url: `http://127.0.0.1:${port}`, hits, close: () => closeServer(server) };
}

/** 服务端帧（不加掩码）。 */
export function encodeServerFrame(opcode: number, payload: Uint8Array, fin = true): Buffer {
  const length = payload.length;
  const header = length < 126 ? 2 : length < 65536 ? 4 : 10;
  const frame = Buffer.alloc(header + length);
  frame[0] = (fin ? 0x80 : 0) | opcode;
  if (length < 126) frame[1] = length;
  else if (length < 65536) {
    frame[1] = 126;
    frame.writeUInt16BE(length, 2);
  } else {
    frame[1] = 127;
    frame.writeBigUInt64BE(BigInt(length), 2);
  }
  Buffer.from(payload).copy(frame, header);
  return frame;
}

/** 解出客户端发来的完整帧（带掩码）；不够一帧时返回 null。 */
export function decodeClientFrame(buffer: Buffer): { opcode: number; payload: Buffer; size: number } | null {
  if (buffer.length < 2) return null;
  let length = buffer[1] & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < 4) return null;
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buffer.length < 10) return null;
    length = Number(buffer.readBigUInt64BE(2));
    offset = 10;
  }
  const masked = (buffer[1] & 0x80) !== 0;
  const mask = masked ? buffer.subarray(offset, offset + 4) : null;
  if (masked) offset += 4;
  if (buffer.length < offset + length) return null;
  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
  return { opcode: buffer[0] & 0x0f, payload, size: offset + length };
}

export interface FakeWsPeer {
  sendText(text: string): void;
  sendFrame(frame: Buffer): void;
  close(code?: number): void;
}

/**
 * 假 CDP：`/json/version` 回 `webSocketDebuggerUrl`；WebSocket 上按 `onMessage` 回包（缺省：每个请求回
 * `{ id, result: { method } }`）。记录收到的消息与 pong。
 */
export async function startFakeCdp(
  onMessage?: (message: { id: number; method: string; params?: unknown }, peer: FakeWsPeer) => void,
) {
  const received: Array<{ id: number; method: string }> = [];
  const pongs: string[] = [];
  const sockets = new Set<Duplex>();
  const server = createServer((req, res) => {
    if (req.url === "/json/version") {
      const port = (server.address() as AddressInfo).port;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({ Browser: "Fake/1", webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/fake` }),
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.on("upgrade", (req, socket: Duplex) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    const accept = createHash("sha1")
      .update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
      .digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    const peer: FakeWsPeer = {
      sendText: (text) => socket.write(encodeServerFrame(0x1, Buffer.from(text))),
      sendFrame: (frame) => socket.write(frame),
      close: (code = 1000) => {
        const payload = Buffer.alloc(2);
        payload.writeUInt16BE(code, 0);
        socket.write(encodeServerFrame(0x8, payload));
      },
    };
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (let frame = decodeClientFrame(buffer); frame; frame = decodeClientFrame(buffer)) {
        buffer = buffer.subarray(frame.size);
        if (frame.opcode === 0x1) {
          const message = JSON.parse(frame.payload.toString("utf8"));
          received.push(message);
          if (onMessage) onMessage(message, peer);
          else peer.sendText(JSON.stringify({ id: message.id, result: { method: message.method } }));
        } else if (frame.opcode === 0xa) {
          pongs.push(frame.payload.toString("utf8"));
        } else if (frame.opcode === 0x8) {
          socket.end(encodeServerFrame(0x8, frame.payload.subarray(0, 2)));
        }
      }
    });
  });
  const port = await listen(server);
  return {
    port,
    received,
    pongs,
    close: () => {
      for (const socket of sockets) socket.destroy();
      return closeServer(server);
    },
  };
}

/** 一个肯定没人监听的端口：先占后放。 */
export async function deadPort(): Promise<number> {
  const server = createServer();
  const port = await listen(server);
  await closeServer(server);
  return port;
}

/**
 * 带假代理的环境变量（HTTP_PROXY / HTTPS_PROXY / ALL_PROXY 大小写各一份，去掉 NO_PROXY）跑 `deno run` 子进程，
 * 子进程把结果以一行 JSON 打到 stdout。
 */
export function runWithProxy(fixture: string, args: string[], proxyUrl: string): Promise<Record<string, unknown>> {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"]) {
    env[name] = proxyUrl;
    env[name.toLowerCase()] = proxyUrl;
  }
  delete env.NO_PROXY;
  delete env.no_proxy;
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ["run", "-A", fixture, ...args],
      { env, encoding: "utf8", timeout: 60_000, windowsHide: true },
      (error, stdout, stderr) => {
        const line = stdout.trim().split("\n").at(-1) ?? "";
        try {
          resolve(JSON.parse(line));
        } catch {
          reject(new Error(`子进程没有输出 JSON（${error?.message ?? ""}）：\n${stdout}\n${stderr}`));
        }
      },
    );
  });
}
