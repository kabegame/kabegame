/**
 * `/__kabegame_dev/*` 的 REST 路由。JSON 进出，截图回 `image/png`；出错回 `{ error, layer, ...}`：
 * CDP 不可用 503（带端点结论）、参数错 400、句柄或任务不存在 404（提示 vite 可能重启过）。
 *
 * 只接受本机访问：来源地址必须是回环（同 debug server 的判断）；带 `Origin` 时只认 localhost / 127.0.0.1 / [::1]，
 * `Host` 也只认这几个（防 DNS 重绑定：同源 GET 不带 Origin）。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { Buffer } from "node:buffer";
import { DevError, badRequest } from "./errors.ts";
import type {
  AppState,
  ClickResponse,
  ConsoleBatch,
  ConsoleStartResponse,
  ConsoleStopResponse,
  EvalResponse,
  HealthInfo,
  HostCloseResult,
  HostOpenRequest,
  HostSummary,
  JobKind,
  JobRecord,
  OpenedHost,
  ProjectsRemoveResult,
  RenderRequest,
  RenderResponse,
  ScreenshotRequest,
  TargetSummary,
} from "./types.ts";

export const PREFIX = "/__kabegame_dev";
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const JOB_KINDS: JobKind[] = ["host-task", "hash-baseline", "projects-import"];

/** REST 背后的实现；`plugin.ts` 用真的 CDP 组装，单测换成假的。 */
export interface DevBackend {
  health(): Promise<HealthInfo>;
  targets(): Promise<TargetSummary[]>;
  evaluate(target: string, expression: string, timeoutMs?: number): Promise<EvalResponse>;
  screenshot(request: ScreenshotRequest): Promise<Uint8Array>;
  click(target: string, selector: string): Promise<ClickResponse>;
  text(target: string, selector: string): Promise<string>;
  invoke(command: string, args: Record<string, unknown>): Promise<unknown>;
  consoleStart(target: string): Promise<ConsoleStartResponse>;
  consoleRead(id: string, since: number): Promise<ConsoleBatch>;
  consoleStop(id: string): Promise<ConsoleStopResponse>;
  appState(): Promise<AppState>;
  androidScreen(): Promise<Uint8Array>;
  hosts(): Promise<HostSummary[]>;
  hostOpen(request: HostOpenRequest): Promise<OpenedHost>;
  hostClose(handle: string): Promise<HostCloseResult>;
  hostEval(handle: string, expression: string, timeoutMs?: number): Promise<EvalResponse>;
  hostRender(handle: string, request: RenderRequest): Promise<RenderResponse>;
  projectsRemove(manifest: unknown, allowPrefix?: string): Promise<ProjectsRemoveResult>;
  jobStart(kind: JobKind, params: unknown): Promise<JobRecord>;
  jobList(): Promise<JobRecord[]>;
  jobGet(id: string): Promise<JobRecord>;
  jobCancel(id: string): Promise<JobRecord>;
}

/** 回环地址（同 `vite-debug-server.ts` 的 `isLoopback`）。 */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return true;
  if (address === "::1" || address === "localhost") return true;
  if (address.startsWith("127.")) return true;
  if (address.startsWith("::ffff:127.")) return true;
  return false;
}

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** `Origin` 只认本机主机名（任意端口、http / https）。 */
export function isLocalOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return (url.protocol === "http:" || url.protocol === "https:") && LOCAL_HOSTNAMES.has(url.hostname);
  } catch {
    return false;
  }
}

/** `Host` 头只认本机主机名（防 DNS 重绑定）。 */
export function isLocalHostHeader(host: string | undefined): boolean {
  if (!host) return true;
  try {
    return LOCAL_HOSTNAMES.has(new URL(`http://${host}`).hostname);
  } catch {
    return false;
  }
}

/** 本机访问校验：不通过时返回原因。 */
export function checkAccess(remoteAddress: string | undefined, headers: IncomingMessage["headers"]): string | null {
  if (!isLoopbackAddress(remoteAddress)) return `只接受回环地址的请求（来源 ${remoteAddress}）`;
  const origin = headers.origin;
  if (origin !== undefined && !isLocalOrigin(String(origin))) return `不接受来源 Origin: ${origin}`;
  if (!isLocalHostHeader(headers.host)) return `不接受 Host: ${headers.host}`;
  return null;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = Buffer.from(JSON.stringify(body));
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Length", String(data.length));
  res.setHeader("Cache-Control", "no-store");
  res.end(data);
}

function sendPng(res: ServerResponse, png: Uint8Array): void {
  res.statusCode = 200;
  res.setHeader("Content-Type", "image/png");
  res.setHeader("Content-Length", String(png.length));
  res.setHeader("Cache-Control", "no-store");
  const size = pngSize(png);
  if (size) {
    res.setHeader("X-Png-Width", String(size.width));
    res.setHeader("X-Png-Height", String(size.height));
  }
  res.end(Buffer.from(png));
}

/** PNG 头里的宽高（IHDR）。 */
export function pngSize(png: Uint8Array): { width: number; height: number } | null {
  if (png.length < 24 || png[0] !== 0x89 || png[1] !== 0x50 || png[2] !== 0x4e || png[3] !== 0x47) return null;
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_BODY_BYTES) throw new DevError(413, "rest", `请求体超过 ${MAX_BODY_BYTES} 字节`);
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw badRequest("请求体不是 JSON");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw badRequest("请求体要是 JSON 对象");
  return body as Record<string, unknown>;
}

const str = (body: Record<string, unknown>, key: string, required = true): string | undefined => {
  const value = body[key];
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || !value) throw badRequest(`缺 ${key}（字符串）`);
  return value;
};

const optNumber = (body: Record<string, unknown>, key: string): number | undefined => {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw badRequest(`${key} 要是正数`);
  return value;
};

type Route = {
  method: string;
  pattern: RegExp;
  handle: (match: RegExpMatchArray, req: IncomingMessage, res: ServerResponse, url: URL) => Promise<void>;
};

export function createRestHandler(backend: DevBackend) {
  const json = (res: ServerResponse, value: unknown) => sendJson(res, 200, value);
  const routes: Route[] = [
    { method: "GET", pattern: /^\/health$/, handle: async (_m, _q, res) => json(res, await backend.health()) },
    { method: "GET", pattern: /^\/targets$/, handle: async (_m, _q, res) => json(res, await backend.targets()) },
    {
      method: "POST",
      pattern: /^\/eval$/,
      handle: async (_m, req, res) => {
        const body = await readJson(req);
        json(res, await backend.evaluate(str(body, "target")!, str(body, "expression")!, optNumber(body, "timeoutMs")));
      },
    },
    {
      method: "POST",
      pattern: /^\/screenshot$/,
      handle: async (_m, req, res) => {
        const body = await readJson(req);
        const request: ScreenshotRequest = { target: str(body, "target")! };
        if (body.selector !== undefined) request.selector = str(body, "selector");
        if (body.clip !== undefined) request.clip = body.clip as ScreenshotRequest["clip"];
        if (body.fullPage !== undefined) {
          if (typeof body.fullPage !== "boolean") throw badRequest("fullPage 要是布尔值");
          request.fullPage = body.fullPage;
        }
        sendPng(res, await backend.screenshot(request));
      },
    },
    {
      method: "POST",
      pattern: /^\/click$/,
      handle: async (_m, req, res) => {
        const body = await readJson(req);
        json(res, await backend.click(str(body, "target")!, str(body, "selector")!));
      },
    },
    {
      method: "POST",
      pattern: /^\/text$/,
      handle: async (_m, req, res) => {
        const body = await readJson(req);
        json(res, { text: await backend.text(str(body, "target")!, str(body, "selector")!) });
      },
    },
    {
      method: "POST",
      pattern: /^\/invoke$/,
      handle: async (_m, req, res) => {
        const body = await readJson(req);
        const args = body.args ?? {};
        if (!args || typeof args !== "object" || Array.isArray(args)) throw badRequest("args 要是对象");
        json(res, { value: await backend.invoke(str(body, "command")!, args as Record<string, unknown>) });
      },
    },
    {
      method: "POST",
      pattern: /^\/console$/,
      handle: async (_m, req, res) => {
        const body = await readJson(req);
        json(res, await backend.consoleStart(str(body, "target")!));
      },
    },
    {
      method: "GET",
      pattern: /^\/console\/([\w-]+)$/,
      handle: async (m, _q, res, url) => {
        const since = Number.parseInt(url.searchParams.get("since") ?? "0", 10);
        if (!Number.isInteger(since) || since < 0) throw badRequest("since 要是非负整数");
        json(res, await backend.consoleRead(m[1], since));
      },
    },
    {
      method: "DELETE",
      pattern: /^\/console\/([\w-]+)$/,
      handle: async (m, _q, res) => json(res, await backend.consoleStop(m[1])),
    },
    { method: "GET", pattern: /^\/app\/state$/, handle: async (_m, _q, res) => json(res, await backend.appState()) },
    {
      method: "GET",
      pattern: /^\/android\/screen$/,
      handle: async (_m, _q, res) => sendPng(res, await backend.androidScreen()),
    },
    { method: "GET", pattern: /^\/hosts$/, handle: async (_m, _q, res) => json(res, await backend.hosts()) },
    {
      method: "POST",
      pattern: /^\/hosts$/,
      handle: async (_m, req, res) => {
        const body = await readJson(req);
        if (body.hidden !== undefined && typeof body.hidden !== "boolean") throw badRequest("hidden 要是布尔值");
        if (body.scene !== undefined && typeof body.scene !== "string") throw badRequest("scene 要是图片 id 字符串");
        json(res, await backend.hostOpen({ hidden: body.hidden as boolean | undefined, scene: body.scene as string }));
      },
    },
    {
      method: "DELETE",
      pattern: /^\/hosts\/([\w-]+)$/,
      handle: async (m, _q, res) => json(res, await backend.hostClose(m[1])),
    },
    {
      method: "POST",
      pattern: /^\/hosts\/([\w-]+)\/eval$/,
      handle: async (m, req, res) => {
        const body = await readJson(req);
        json(res, await backend.hostEval(m[1], str(body, "expression")!, optNumber(body, "timeoutMs")));
      },
    },
    {
      method: "POST",
      pattern: /^\/hosts\/([\w-]+)\/render$/,
      handle: async (m, req, res) => {
        const body = await readJson(req);
        const imageId = body.imageId;
        if (typeof imageId !== "string" && typeof imageId !== "number") throw badRequest("缺 imageId");
        json(res, await backend.hostRender(m[1], { ...(body as Partial<RenderRequest>), imageId: String(imageId) }));
      },
    },
    {
      method: "POST",
      pattern: /^\/projects\/remove$/,
      handle: async (_m, req, res) => {
        const body = await readJson(req);
        json(res, await backend.projectsRemove(body.manifest, str(body, "allowPrefix", false)));
      },
    },
    {
      method: "POST",
      pattern: /^\/jobs$/,
      handle: async (_m, req, res) => {
        const body = await readJson(req);
        const kind = body.kind as JobKind;
        if (!JOB_KINDS.includes(kind)) throw badRequest(`kind 只能是 ${JOB_KINDS.join(" / ")}`);
        json(res, await backend.jobStart(kind, body.params ?? {}));
      },
    },
    { method: "GET", pattern: /^\/jobs$/, handle: async (_m, _q, res) => json(res, await backend.jobList()) },
    {
      method: "GET",
      pattern: /^\/jobs\/([\w-]+)$/,
      handle: async (m, _q, res) => json(res, await backend.jobGet(m[1])),
    },
    {
      method: "DELETE",
      pattern: /^\/jobs\/([\w-]+)$/,
      handle: async (m, _q, res) => json(res, await backend.jobCancel(m[1])),
    },
  ];

  return async (req: IncomingMessage, res: ServerResponse, next?: (error?: unknown) => void): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://kabegame.local");
    if (url.pathname !== PREFIX && !url.pathname.startsWith(`${PREFIX}/`)) {
      next?.();
      return;
    }
    const denied = checkAccess(req.socket?.remoteAddress, req.headers);
    if (denied) {
      sendJson(res, 403, { error: denied, layer: "access" });
      return;
    }
    const subPath = url.pathname.slice(PREFIX.length) || "/";
    const candidates = routes.filter((route) => route.pattern.test(subPath));
    const route = candidates.find((candidate) => candidate.method === req.method);
    try {
      if (!route) {
        if (candidates.length) {
          res.setHeader("Allow", candidates.map((candidate) => candidate.method).join(", "));
          throw new DevError(405, "rest", `${subPath} 不接受 ${req.method}`);
        }
        throw new DevError(404, "rest", `未知接口 ${req.method} ${subPath}`);
      }
      await route.handle(subPath.match(route.pattern)!, req, res, url);
    } catch (error) {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (error instanceof DevError) {
        sendJson(res, error.status, { error: error.message, layer: error.layer, ...error.extra });
      } else {
        sendJson(res, 500, { error: error instanceof Error ? error.message : String(error), layer: "vite" });
      }
    }
  };
}
