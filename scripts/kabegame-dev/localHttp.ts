/**
 * 发往本机的 HTTP 与 WebSocket：用 `node:http` 直连，不经代理。
 *
 * 实测（2026-11-08，Deno 2.9、Node 26）：设了 `HTTP_PROXY` 时，Deno 的 `fetch` 和 `WebSocket` 发往 127.0.0.1 也交给代理，
 * 代理连不上目标时回 502，于是「vite 不在」会被误报成「vite 在但回 502」；而且 Deno 的 fetch 在第一次请求后就缓存了代理设置，
 * 进程里再改环境变量不起作用。`node:http` 在 Node 与 Deno 下都不读代理环境变量；再加 `agent: false`，也避开 Node 的
 * `NODE_USE_ENV_PROXY`（它只作用于全局 agent）。
 *
 * vite 插件（Deno）与 `apps/kabegame-dev-mcp/src/client.ts`（Deno 与 Node 脚本）共用本文件，只依赖 `node:*`。
 */
import { Buffer } from "node:buffer";
import { createHash, randomBytes } from "node:crypto";
import { request } from "node:http";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

/** 与 `fetch` 兼容的最小签名：脚本和单测可以注入别的实现（包括全局 `fetch`）。 */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const NULL_BODY_STATUS = new Set([101, 103, 204, 205, 304]);

/** 去掉 IPv6 字面量的方括号（`[::1]` → `::1`），node:http 的 hostname 不认方括号。 */
function hostnameOf(url: URL): string {
  return url.hostname.replace(/^\[(.*)\]$/, "$1");
}

function connectError(url: URL, error: unknown): TypeError {
  const code = (error as { code?: string })?.code;
  const message = error instanceof Error ? error.message : String(error);
  const wrapped = new TypeError(`连不上 ${url.host}：${code ?? message}`);
  (wrapped as { cause?: unknown }).cause = error;
  return wrapped;
}

function toBodyBytes(body: unknown): Uint8Array | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") return new Uint8Array(Buffer.from(body, "utf8"));
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  throw new TypeError("localFetch 只支持字符串、Uint8Array 或 ArrayBuffer 请求体");
}

/**
 * 直连的 `fetch`：只支持 `http:`，整段读完响应体后回标准 `Response`。连不上时和 `fetch` 一样抛 `TypeError`；
 * `signal` 中止时抛 `signal.reason`（`AbortSignal.timeout` 是 `TimeoutError`）。
 */
export function localFetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
  let url: URL;
  let body: Uint8Array | undefined;
  try {
    url = new URL(String(input));
    if (url.protocol !== "http:") throw new TypeError(`localFetch 只支持 http:，收到 ${url.protocol}`);
    body = toBodyBytes(init.body);
  } catch (error) {
    return Promise.reject(error);
  }
  const signal = init.signal ?? undefined;
  if (signal?.aborted) return Promise.reject(signal.reason);
  const headers: Record<string, string> = {};
  new Headers(init.headers).forEach((value, key) => (headers[key] = value));
  if (body) headers["content-length"] = String(body.length);

  return new Promise<Response>((resolve, reject) => {
    let settled = false;
    const finish = (error: unknown, response?: Response) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      if (error !== null) reject(error);
      else resolve(response!);
    };
    const req = request({
      hostname: hostnameOf(url),
      port: url.port || 80,
      path: `${url.pathname}${url.search}`,
      method: init.method ?? "GET",
      headers,
      agent: false,
    });
    const onAbort = () => {
      finish(signal!.reason);
      req.destroy();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    req.on("error", (error) => finish(signal?.aborted ? signal.reason : connectError(url, error)));
    req.on("response", (res: IncomingMessage) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("error", (error) => finish(signal?.aborted ? signal.reason : connectError(url, error)));
      res.on("end", () => {
        const responseHeaders = new Headers();
        for (let i = 0; i + 1 < res.rawHeaders.length; i += 2) {
          try {
            responseHeaders.append(res.rawHeaders[i], res.rawHeaders[i + 1]);
          } catch {
            // 非法头名 / 值：跳过
          }
        }
        const status = res.statusCode ?? 0;
        const bytes = new Uint8Array(Buffer.concat(chunks));
        try {
          finish(
            null,
            new Response(NULL_BODY_STATUS.has(status) ? null : bytes, {
              status,
              statusText: res.statusMessage ?? "",
              headers: responseHeaders,
            }),
          );
        } catch (error) {
          finish(error);
        }
      });
    });
    req.end(body);
  });
}

// ---------------------------------------------------------------- WebSocket

/** `cdp.ts` 用到的 WebSocket 子集（同 `SocketLike`）。 */
export interface LocalWebSocket {
  onopen: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  send(data: string): void;
  close(): void;
}

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** 客户端帧（必须加掩码）。 */
export function encodeClientFrame(opcode: number, payload: Uint8Array, mask = randomBytes(4)): Buffer {
  const length = payload.length;
  const header = length < 126 ? 2 : length < 65536 ? 4 : 10;
  const frame = Buffer.alloc(header + 4 + length);
  frame[0] = 0x80 | opcode;
  if (length < 126) {
    frame[1] = 0x80 | length;
  } else if (length < 65536) {
    frame[1] = 0x80 | 126;
    frame.writeUInt16BE(length, 2);
  } else {
    frame[1] = 0x80 | 127;
    frame.writeBigUInt64BE(BigInt(length), 2);
  }
  mask.copy(frame, header);
  for (let i = 0; i < length; i++) frame[header + 4 + i] = payload[i] ^ mask[i & 3];
  return frame;
}

/**
 * 直连的 WebSocket 客户端（RFC 6455 的最小实现：文本 / 二进制消息、分片、ping / pong、关闭）。只支持 `ws:`。
 * 事件回调和浏览器 WebSocket 同名，`cdp.ts` 的 `connectCdp` 缺省用它。
 */
export function localWebSocket(rawUrl: string, options: { maxMessageBytes?: number } = {}): LocalWebSocket {
  const maxMessageBytes = options.maxMessageBytes ?? 512 * 1024 * 1024;
  const url = new URL(rawUrl);
  const ws: LocalWebSocket = {
    onopen: null,
    onerror: null,
    onclose: null,
    onmessage: null,
    send: () => {
      throw new Error("WebSocket 还没连上");
    },
    close: () => {},
  };
  let socket: Duplex | null = null;
  let closed = false;
  let closeSent = false;
  let closeInfo: { code?: number; reason?: string } = { code: 1006, reason: "连接中断" };
  const emitClose = () => {
    if (closed) return;
    closed = true;
    ws.onclose?.(closeInfo);
  };
  const fail = (message: string) => {
    if (closed) return;
    ws.onerror?.({ message });
    closeInfo = { code: 1006, reason: message };
    socket?.destroy();
    emitClose();
  };

  if (url.protocol !== "ws:") {
    queueMicrotask(() => fail(`localWebSocket 只支持 ws:，收到 ${url.protocol}`));
    return ws;
  }

  const key = randomBytes(16).toString("base64");
  const req = request({
    hostname: hostnameOf(url),
    port: url.port || 80,
    path: `${url.pathname}${url.search}`,
    agent: false,
    headers: {
      Connection: "Upgrade",
      Upgrade: "websocket",
      "Sec-WebSocket-Key": key,
      "Sec-WebSocket-Version": "13",
    },
  });
  ws.close = () => {
    if (!socket) {
      closeInfo = { code: 1000, reason: "主动关闭" };
      req.destroy();
      emitClose();
      return;
    }
    if (!closeSent && !closed) {
      closeSent = true;
      const payload = Buffer.alloc(2);
      payload.writeUInt16BE(1000, 0);
      socket.write(encodeClientFrame(0x8, payload));
      closeInfo = { code: 1000, reason: "主动关闭" };
      socket.end();
      setTimeout(() => socket?.destroy(), 1000).unref?.();
    }
  };
  req.on("error", (error) => fail(connectError(url, error).message));
  req.on("response", (res: IncomingMessage) => {
    res.resume();
    fail(`WebSocket 握手失败：HTTP ${res.statusCode}`);
  });
  req.on("upgrade", (res: IncomingMessage, upgraded: Duplex, head: Buffer) => {
    const expected = createHash("sha1")
      .update(key + WS_GUID)
      .digest("base64");
    if (res.headers["sec-websocket-accept"] !== expected) {
      socket = upgraded;
      fail("WebSocket 握手失败：Sec-WebSocket-Accept 不对");
      return;
    }
    socket = upgraded;
    (upgraded as { setNoDelay?: (on: boolean) => void }).setNoDelay?.(true);
    ws.send = (data: string) => {
      if (closed || closeSent) throw new Error("WebSocket 已关闭");
      socket!.write(encodeClientFrame(0x1, Buffer.from(data, "utf8")));
    };

    // 收帧：攒到一整帧再解析，大消息只在数据到齐时拼一次
    const chunks: Buffer[] = [];
    let buffered = 0;
    let fragments: Buffer[] = [];
    let fragmentBytes = 0;
    let fragmentOpcode = 0;
    const peek = (n: number): Buffer | null => {
      if (buffered < n) return null;
      if (chunks[0].length < n) {
        const all = Buffer.concat(chunks, buffered);
        chunks.length = 0;
        chunks.push(all);
      }
      return chunks[0];
    };
    const consume = (n: number) => {
      const first = chunks[0];
      if (first.length === n) chunks.shift();
      else chunks[0] = first.subarray(n);
      buffered -= n;
    };
    const control = (opcode: number, payload: Buffer) => {
      if (opcode === 0x9) {
        if (!closeSent) socket!.write(encodeClientFrame(0xa, payload));
      } else if (opcode === 0x8) {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
        closeInfo = { code, reason: payload.subarray(2).toString("utf8") };
        if (!closeSent) {
          closeSent = true;
          socket!.write(encodeClientFrame(0x8, payload.subarray(0, 2)));
        }
        socket!.end();
      }
    };
    const drain = () => {
      while (!closed) {
        const head2 = peek(2);
        if (!head2) return;
        const fin = (head2[0] & 0x80) !== 0;
        const opcode = head2[0] & 0x0f;
        const masked = (head2[1] & 0x80) !== 0;
        let length = head2[1] & 0x7f;
        let offset = 2;
        if (length === 126) {
          const h = peek(4);
          if (!h) return;
          length = h.readUInt16BE(2);
          offset = 4;
        } else if (length === 127) {
          const h = peek(10);
          if (!h) return;
          const big = h.readBigUInt64BE(2);
          if (big > BigInt(maxMessageBytes)) return fail(`WebSocket 帧过大（${big} 字节）`);
          length = Number(big);
          offset = 10;
        }
        const maskOffset = offset;
        if (masked) offset += 4;
        const frame = peek(offset + length);
        if (!frame) return;
        let payload: Buffer = Buffer.from(frame.subarray(offset, offset + length));
        if (masked) {
          const mask = frame.subarray(maskOffset, maskOffset + 4);
          for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
        }
        consume(offset + length);
        if (opcode >= 0x8) {
          control(opcode, payload);
          continue;
        }
        if (opcode !== 0x0) {
          fragments = [];
          fragmentBytes = 0;
          fragmentOpcode = opcode;
        }
        fragments.push(payload);
        fragmentBytes += payload.length;
        if (fragmentBytes > maxMessageBytes) return fail(`WebSocket 消息过大（${fragmentBytes} 字节）`);
        if (!fin) continue;
        payload = fragments.length === 1 ? fragments[0] : Buffer.concat(fragments, fragmentBytes);
        fragments = [];
        fragmentBytes = 0;
        ws.onmessage?.({ data: fragmentOpcode === 0x1 ? payload.toString("utf8") : new Uint8Array(payload) });
      }
    };
    upgraded.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      buffered += chunk.length;
      drain();
    });
    upgraded.on("error", (error) => {
      if (!closed) ws.onerror?.({ message: error.message });
    });
    upgraded.on("close", emitClose);
    if (head?.length) {
      chunks.push(head);
      buffered += head.length;
    }
    ws.onopen?.({});
    // 握手时捎带的数据留到下一轮再解析：调用方在 onopen 之后才挂 onmessage
    if (buffered) setTimeout(drain, 0);
  });
  req.end();
  return ws;
}
