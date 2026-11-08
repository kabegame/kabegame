/**
 * 裸 CDP 连接：浏览器级 WebSocket、flatten session，只 attach 用到的目标。
 *
 * 移植自 `ignore/p3a/cdp.mjs`。和原来的 playwright 方案相比：
 * - 不发 `Browser.setDownloadBehavior`，不会劫持页面下载；
 * - 不开全局 auto-attach，别的窗口忙不会拖住握手；
 * - flatten session 能进跨进程的场景宿主 iframe。
 *
 * WebSocket 缺省用 `localHttp.ts` 的直连实现：Deno 的全局 WebSocket 会把发往 127.0.0.1 的连接交给 `HTTP_PROXY`。
 */
import { localWebSocket } from "./localHttp.ts";

export interface TargetInfo {
  targetId: string;
  type: string;
  title: string;
  url: string;
  attached: boolean;
  parentId?: string;
  [key: string]: unknown;
}

export interface CdpEvent {
  method: string;
  // deno-lint-ignore no-explicit-any
  params: any;
  sessionId?: string;
}

export type CdpErrorCode = "timeout" | "closed" | "protocol" | "exception";

export class CdpError extends Error {
  constructor(
    readonly code: CdpErrorCode,
    message: string,
    readonly method?: string,
  ) {
    super(message);
    this.name = "CdpError";
  }
}

export interface EvaluateResult {
  value: unknown;
  type: string;
}

export interface CdpConnection {
  readonly url: string;
  readonly closed: boolean;
  // deno-lint-ignore no-explicit-any
  send<T = any>(method: string, params?: Record<string, unknown>, options?: SendOptions): Promise<T>;
  on(handler: (event: CdpEvent) => void): () => void;
  onClose(handler: (reason: string) => void): () => void;
  targets(): Promise<TargetInfo[]>;
  attach(targetId: string): Promise<string>;
  detach(sessionId: string): Promise<void>;
  /** 在 session 里求值（`awaitPromise` + `returnByValue`）；页面抛错时抛 `CdpError("exception")`。 */
  evaluate(sessionId: string, expression: string, options?: { timeoutMs?: number }): Promise<EvaluateResult>;
  close(): void;
}

export interface SendOptions {
  sessionId?: string;
  timeoutMs?: number;
}

/** 测试里替换 WebSocket 用的最小接口。 */
export interface SocketLike {
  onopen: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  send(data: string): void;
  close(): void;
}

export interface ConnectOptions {
  connectTimeoutMs?: number;
  defaultTimeoutMs?: number;
  createSocket?: (url: string) => SocketLike;
}

export async function connectCdp(webSocketUrl: string, options: ConnectOptions = {}): Promise<CdpConnection> {
  const createSocket = options.createSocket ?? ((url: string) => localWebSocket(url));
  const defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000;
  const ws = createSocket(webSocketUrl);
  let nextId = 0;
  let closedReason: string | null = null;
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  const handlers = new Set<(event: CdpEvent) => void>();
  const closeHandlers = new Set<(reason: string) => void>();

  const shutdown = (reason: string) => {
    if (closedReason !== null) return;
    closedReason = reason;
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(new CdpError("closed", `CDP 连接已断开（${reason}）`));
      pending.delete(id);
    }
    for (const handler of closeHandlers) {
      try {
        handler(reason);
      } catch {
        // 关闭回调出错不影响别的回调
      }
    }
  };

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new CdpError("timeout", `CDP WebSocket ${options.connectTimeoutMs ?? 5000} ms 内没有握手成功`));
      try {
        ws.close();
      } catch {
        // 忽略
      }
    }, options.connectTimeoutMs ?? 5000);
    ws.onopen = () => {
      clearTimeout(timer);
      resolve();
    };
    ws.onerror = (event) => {
      clearTimeout(timer);
      const message = (event as { message?: string })?.message;
      reject(new CdpError("closed", `CDP WebSocket 连不上：${message ?? webSocketUrl}`));
    };
  });

  ws.onerror = () => shutdown("WebSocket 出错");
  ws.onclose = (event) => shutdown(`WebSocket 关闭 ${event?.code ?? ""} ${event?.reason ?? ""}`.trim());
  ws.onmessage = (event) => {
    let message: {
      id?: number;
      method?: string;
      params?: unknown;
      sessionId?: string;
      result?: unknown;
      error?: { message?: string; data?: string };
    };
    try {
      message = JSON.parse(String(event.data));
    } catch {
      return;
    }
    if (typeof message.id === "number") {
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) {
        const detail = message.error.data ? `：${message.error.data}` : "";
        entry.reject(new CdpError("protocol", `${message.error.message ?? "CDP 错误"}${detail}`));
      } else {
        entry.resolve(message.result ?? {});
      }
      return;
    }
    if (message.method) {
      const cdpEvent: CdpEvent = { method: message.method, params: message.params, sessionId: message.sessionId };
      for (const handler of handlers) {
        try {
          handler(cdpEvent);
        } catch {
          // 事件处理出错不影响连接
        }
      }
    }
  };

  // deno-lint-ignore no-explicit-any
  const send = <T = any>(method: string, params: Record<string, unknown> = {}, opts: SendOptions = {}) =>
    new Promise<T>((resolve, reject) => {
      if (closedReason !== null) {
        reject(new CdpError("closed", `CDP 连接已断开（${closedReason}）`, method));
        return;
      }
      const id = ++nextId;
      const timeoutMs = opts.timeoutMs ?? defaultTimeoutMs;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new CdpError("timeout", `${method} ${timeoutMs} ms 无应答`, method));
      }, timeoutMs);
      pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      try {
        ws.send(JSON.stringify({ id, method, params, ...(opts.sessionId ? { sessionId: opts.sessionId } : {}) }));
      } catch (error) {
        clearTimeout(timer);
        pending.delete(id);
        reject(new CdpError("closed", `发送 ${method} 失败：${String(error)}`, method));
      }
    });

  const connection: CdpConnection = {
    url: webSocketUrl,
    get closed() {
      return closedReason !== null;
    },
    send,
    on(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    onClose(handler) {
      closeHandlers.add(handler);
      return () => closeHandlers.delete(handler);
    },
    async targets() {
      const result = await send<{ targetInfos: TargetInfo[] }>("Target.getTargets");
      return result.targetInfos;
    },
    async attach(targetId) {
      const result = await send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
      return result.sessionId;
    },
    async detach(sessionId) {
      await send("Target.detachFromTarget", { sessionId });
    },
    async evaluate(sessionId, expression, opts = {}) {
      const timeoutMs = opts.timeoutMs ?? defaultTimeoutMs;
      const result = await send<{
        result: { type: string; value?: unknown; unserializableValue?: string; description?: string };
        exceptionDetails?: { text?: string; exception?: { description?: string; value?: unknown } };
      }>(
        "Runtime.evaluate",
        // 不传 Runtime.evaluate 的 timeout：它会 TerminateExecution，打断页面自己的代码
        { expression, awaitPromise: true, returnByValue: true },
        { sessionId, timeoutMs },
      );
      if (result.exceptionDetails) {
        const details = result.exceptionDetails;
        const description =
          details.exception?.description ??
          (details.exception?.value !== undefined ? String(details.exception.value) : undefined) ??
          details.text ??
          "页面里抛错";
        throw new CdpError("exception", description, "Runtime.evaluate");
      }
      const remote = result.result;
      if (remote.unserializableValue !== undefined) return { value: remote.unserializableValue, type: remote.type };
      return { value: remote.value === undefined ? null : remote.value, type: remote.type };
    },
    close() {
      try {
        ws.close();
      } catch {
        // 忽略
      }
      shutdown("主动关闭");
    },
  };
  return connection;
}

/** 应用自身页面：桌面 dev 是 vite 端口，打包后是 `tauri:`，安卓 WebView 是 `http://tauri.localhost`。 */
export function isAppOrigin(rawUrl: string, vitePort = 1420): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  return url.port === String(vitePort) || url.protocol === "tauri:" || url.hostname === "tauri.localhost";
}

/**
 * 主窗口：应用自身页面且路径不以 `.html` 结尾（壁纸窗口是 `index.html?window=wallpaper`，畅游导航栏是
 * `surf-navbar.html`）。规则同原 `cdp.mjs` 的 `isMainWindow`。
 */
export function isMain(target: Pick<TargetInfo, "type" | "url">, vitePort = 1420): boolean {
  if (target.type !== "page" || !isAppOrigin(target.url, vitePort)) return false;
  return !new URL(target.url).pathname.endsWith(".html");
}

export function isWallpaper(target: Pick<TargetInfo, "type" | "url">, vitePort = 1420): boolean {
  if (target.type !== "page" || !isAppOrigin(target.url, vitePort)) return false;
  const url = new URL(target.url);
  return url.pathname.endsWith("/index.html") && url.searchParams.get("window") === "wallpaper";
}

/** 场景宿主：`file:` 加载的 `wpe-scene/index.html` iframe。 */
export function isSceneHost(target: Pick<TargetInfo, "type" | "url">): boolean {
  return target.type === "iframe" && target.url.startsWith("file:") && target.url.includes("/wpe-scene/index.html");
}

export function hostParams(url: string): { scene: string; instance: string } {
  try {
    const parsed = new URL(url);
    return { scene: parsed.searchParams.get("kbScene") ?? "", instance: parsed.searchParams.get("kbInstance") ?? "" };
  } catch {
    return { scene: "", instance: "" };
  }
}

/**
 * 把一段 JS 包成 Runtime.evaluate 的表达式：先当表达式（`(async () => (…))()`），语法不通再当语句块
 * （`(async () => { … })()`，可写 `return`）。语法检查在 vite 进程里只编译、不执行，所以不会像原 `cdp.mjs`
 * 那样在 SyntaxError 后把同一段代码跑第二遍。
 */
export function wrapExpression(source: string): string {
  const asExpression = `(async () => (\n${source}\n))()`;
  if (compiles(`return (async () => (\n${source}\n));`)) return asExpression;
  return `(async () => {\n${source}\n})()`;
}

function compiles(body: string): boolean {
  try {
    // 只编译不调用：检查语法，不执行任何页面代码
    new Function(body);
    return true;
  } catch {
    return false;
  }
}
