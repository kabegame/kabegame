/**
 * vite 进程里唯一的 CDP 连接，以及挂在它上面的状态：attach 过的 session、场景宿主句柄、控制台流。
 *
 * 连接懒建立；断开后清掉全部 session 与句柄（它们只在原连接上有效），下一次请求经 `resolveEndpoint` 重连。
 */
import { CdpError, connectCdp, hostParams, isMain, isSceneHost, isWallpaper } from "./cdp.ts";
import type { CdpConnection, TargetInfo } from "./cdp.ts";
import { DevError, badRequest, staleHandle } from "./errors.ts";
import { describeEndpointError } from "./endpoint.ts";
import type { DevPaths } from "./paths.ts";
import type { Endpoint, EndpointResult, HostBuild, MainState, SessionSummary, TargetRole } from "./types.ts";
import { isEndpointError } from "./types.ts";

export interface HostHandle {
  handle: string;
  instance: string;
  scene: string;
  targetId: string;
  hidden: boolean;
  /** 屏外 iframe 的元素 id（`hidden` 时）。 */
  elementId: string | null;
  entry: string;
  /** 宿主自检（格式同旧 `hash-*.json` 的 `hostBuild`）。 */
  build: HostBuild;
  /** 开宿主之前主窗口里已有的宿主 instance，关的时候据此数残留。 */
  known: Set<string>;
  before: MainState;
  generation: number;
}

export interface ConsoleStreamState {
  id: string;
  target: string;
  targetId: string;
  sessionId: string;
  startedAt: number;
  generation: number;
  entries: Array<{ seq: number; ts: number; type: string; text: string; url?: string; line?: number }>;
  seq: number;
  dropped: number;
  ended: string | null;
  off: () => void;
}

export interface ResolvedTarget {
  spec: string;
  targetId: string;
  info: TargetInfo;
  role: TargetRole | null;
  /** 场景宿主才有：句柄（vite 开的）与 instance。 */
  host?: { handle: string | null; instance: string; scene: string };
}

export interface DevSessionOptions {
  resolveEndpoint: () => Promise<EndpointResult>;
  connect?: (webSocketUrl: string) => Promise<CdpConnection>;
  vitePort: number;
  android: boolean;
  paths: DevPaths;
}

export class DevSession {
  readonly hosts = new Map<string, HostHandle>();
  readonly consoles = new Map<string, ConsoleStreamState>();
  generation = 0;
  #conn: CdpConnection | null = null;
  #connecting: Promise<CdpConnection> | null = null;
  #endpoint: Endpoint | null = null;
  /** targetId → sessionId，只在当前连接上有效。 */
  #sessions = new Map<string, string>();
  #attaching = new Map<string, Promise<string>>();
  #closed = false;

  constructor(readonly options: DevSessionOptions) {}

  get vitePort(): number {
    return this.options.vitePort;
  }

  get android(): boolean {
    return this.options.android;
  }

  get paths(): DevPaths {
    return this.options.paths;
  }

  get connected(): boolean {
    return this.#conn !== null && !this.#conn.closed;
  }

  summary(jobs: { running: number; total: number }): SessionSummary {
    return {
      connected: this.connected,
      generation: this.generation,
      endpoint: this.connected ? this.#endpoint : null,
      hosts: [...this.hosts.keys()],
      consoles: [...this.consoles.keys()],
      jobs,
    };
  }

  /** 当前连接；没有就找端点、连上。找不到端点或连不上时抛 503。 */
  async connection(): Promise<CdpConnection> {
    if (this.#closed) throw new DevError(503, "cdp", "kabegame-dev 插件已关闭（vite 正在重启）");
    if (this.#conn && !this.#conn.closed) return this.#conn;
    this.#connecting ??= this.#connect().finally(() => {
      this.#connecting = null;
    });
    return this.#connecting;
  }

  async #connect(): Promise<CdpConnection> {
    const endpoint = await this.options.resolveEndpoint();
    if (isEndpointError(endpoint)) {
      throw new DevError(503, "cdp", `CDP 不可用：${describeEndpointError(endpoint)}`, { endpoint });
    }
    let conn: CdpConnection;
    try {
      conn = await (this.options.connect ?? ((url: string) => connectCdp(url)))(endpoint.webSocketUrl);
    } catch (error) {
      throw new DevError(503, "cdp", `CDP 端点在但 WebSocket 连不上：${String(error)}`, { endpoint });
    }
    this.generation++;
    this.#conn = conn;
    this.#endpoint = endpoint;
    conn.on((event) => {
      if (event.method === "Target.detachedFromTarget") {
        const sessionId = event.params?.sessionId as string | undefined;
        for (const [targetId, id] of this.#sessions) if (id === sessionId) this.#sessions.delete(targetId);
        for (const stream of this.consoles.values()) {
          if (stream.sessionId === sessionId && !stream.ended) stream.ended = "目标已分离（窗口关闭或页面销毁）";
        }
      }
    });
    conn.onClose((reason) => this.#dropConnection(conn, reason));
    return conn;
  }

  /** 连接断了：它上面的 session、句柄、控制台流全部作废。 */
  #dropConnection(conn: CdpConnection, reason: string): void {
    if (this.#conn !== conn) return;
    this.#conn = null;
    this.#sessions.clear();
    this.#attaching.clear();
    this.hosts.clear();
    for (const stream of this.consoles.values()) {
      stream.off();
      stream.ended ??= `CDP 连接断开（${reason}）`;
    }
  }

  /** attach 到目标并缓存 session。 */
  async attached(targetId: string): Promise<string> {
    const conn = await this.connection();
    const cached = this.#sessions.get(targetId);
    if (cached) return cached;
    let attaching = this.#attaching.get(targetId);
    if (!attaching) {
      attaching = conn.attach(targetId).finally(() => this.#attaching.delete(targetId));
      this.#attaching.set(targetId, attaching);
    }
    const sessionId = await attaching;
    this.#sessions.set(targetId, sessionId);
    return sessionId;
  }

  forget(targetId: string): void {
    this.#sessions.delete(targetId);
  }

  async detach(targetId: string): Promise<void> {
    const sessionId = this.#sessions.get(targetId);
    this.#sessions.delete(targetId);
    if (sessionId && this.connected) await this.#conn!.detach(sessionId).catch(() => {});
  }

  /** 在目标里求值；session 失效（目标导航 / 重建）时重新 attach 一次。 */
  async evaluateIn(targetId: string, expression: string, timeoutMs?: number) {
    const conn = await this.connection();
    for (let attempt = 0; ; attempt++) {
      const sessionId = await this.attached(targetId);
      try {
        return await conn.evaluate(sessionId, expression, { timeoutMs });
      } catch (error) {
        if (attempt === 0 && isStaleSession(error)) {
          this.forget(targetId);
          continue;
        }
        throw error;
      }
    }
  }

  /** 在目标的 session 上发命令；session 失效时重新 attach 一次。 */
  // deno-lint-ignore no-explicit-any
  async sendTo<T = any>(
    targetId: string,
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs?: number,
  ): Promise<T> {
    const conn = await this.connection();
    for (let attempt = 0; ; attempt++) {
      const sessionId = await this.attached(targetId);
      try {
        return await conn.send<T>(method, params, { sessionId, timeoutMs });
      } catch (error) {
        if (attempt === 0 && isStaleSession(error)) {
          this.forget(targetId);
          continue;
        }
        throw error;
      }
    }
  }

  async targets(): Promise<TargetInfo[]> {
    return (await this.connection()).targets();
  }

  role(info: TargetInfo): TargetRole | null {
    if (isMain(info, this.vitePort)) return "main";
    if (isWallpaper(info, this.vitePort)) return "wallpaper";
    if (isSceneHost(info)) return "scene-host";
    return null;
  }

  handleForInstance(instance: string): string | null {
    for (const host of this.hosts.values()) if (host.instance === instance) return host.handle;
    return null;
  }

  /** 取 vite 开的宿主句柄；不存在（或连接换过）抛 404。 */
  host(handle: string): HostHandle {
    const host = this.hosts.get(handle);
    if (!host || host.generation !== this.generation || !this.connected) throw staleHandle("宿主句柄", handle);
    return host;
  }

  /** 解析目标写法：`main` / `wallpaper` / `url:<子串>` / `host:<句柄或 instance>`。 */
  async resolveTarget(spec: string): Promise<ResolvedTarget> {
    if (typeof spec !== "string" || !spec) throw badRequest("缺 target（main / wallpaper / url:<子串> / host:<句柄>）");
    const targets = await this.targets();
    const list = () =>
      targets
        .filter((t) => t.type === "page" || t.type === "iframe")
        .map((t) => `${t.type} ${t.url}`)
        .join("\n");
    const pick = (info: TargetInfo | undefined, what: string): ResolvedTarget => {
      if (!info) {
        throw new DevError(422, "target", `没有${what}。现有目标：\n${list() || "（无）"}`, { target: spec });
      }
      const role = this.role(info);
      const resolved: ResolvedTarget = { spec, targetId: info.targetId, info, role };
      if (role === "scene-host") {
        const { scene, instance } = hostParams(info.url);
        resolved.host = { handle: this.handleForInstance(instance), instance, scene };
      }
      return resolved;
    };
    if (spec === "main")
      return pick(
        targets.find((t) => isMain(t, this.vitePort)),
        "主窗口",
      );
    if (spec === "wallpaper")
      return pick(
        targets.find((t) => isWallpaper(t, this.vitePort)),
        "壁纸窗口",
      );
    if (spec.startsWith("url:")) {
      const needle = spec.slice(4);
      if (!needle) throw badRequest("url: 后面要跟 URL 子串");
      const matches = targets.filter((t) => (t.type === "page" || t.type === "iframe") && t.url.includes(needle));
      matches.sort((a, b) => Number(b.type === "page") - Number(a.type === "page"));
      return pick(matches[0], ` URL 含 "${needle}" 的目标`);
    }
    if (spec.startsWith("host:")) {
      const key = spec.slice(5);
      if (!key) throw badRequest("host: 后面要跟宿主句柄或 kbInstance");
      const own = this.hosts.get(key);
      if (own) {
        this.host(key);
        return pick(
          targets.find((t) => t.targetId === own.targetId),
          `宿主 ${key}（句柄还在但 iframe 已不在）`,
        );
      }
      const found = targets.find((t) => isSceneHost(t) && (hostParams(t.url).instance === key || t.targetId === key));
      if (!found && /^h-[0-9a-f]{8}$/.test(key)) throw staleHandle("宿主句柄", key);
      return pick(found, `kbInstance 为 ${key} 的场景宿主`);
    }
    throw badRequest(
      `target 只能是 main / wallpaper / url:<子串> / host:<句柄或 instance>，收到 ${JSON.stringify(spec)}`,
    );
  }

  /** 插件关闭：断开连接，之后的请求都回 503。 */
  async close(): Promise<void> {
    this.#closed = true;
    const conn = this.#conn;
    if (conn && !conn.closed) {
      for (const sessionId of this.#sessions.values()) await conn.detach(sessionId).catch(() => {});
      conn.close();
    }
  }
}

export function isStaleSession(error: unknown): boolean {
  return (
    error instanceof CdpError &&
    error.code === "protocol" &&
    /session with given id not found|no session with given id|target closed/i.test(error.message)
  );
}
