/**
 * 把会话、任务表和各模块组装成 REST 背后的实现。`plugin.ts` 只负责把它挂到 vite 上；不经 vite 的脚本
 * （例如调试本模块）也能直接用 `createDevRuntime`。
 */
import { appState, invoke, openImagePreview, showWindow } from "./app.ts";
import { androidScreencap, resolveEndpoint } from "./endpoint.ts";
import type { CdpRegistrationLike, Exec } from "./endpoint.ts";
import { DevError, badRequest, wrongPlatform } from "./errors.ts";
import { hashBaseline } from "./hash.ts";
import { JobTable } from "./jobs.ts";
import { importProjects, removeProjects } from "./library.ts";
import { click, evaluate, listTargets, readConsole, screenshot, startConsole, stopConsole, text } from "./page.ts";
import type { DevPaths } from "./paths.ts";
import { createRestHandler } from "./rest.ts";
import type { DevBackend } from "./rest.ts";
import {
  closeAllHosts,
  closeHost,
  hostEval,
  hostTask,
  openHost,
  particleCorners,
  particleTrack,
  renderFrame,
  sceneHosts,
} from "./scene.ts";
import { DevSession } from "./session.ts";
import type { EndpointResult, HashBaselineParams, HostTaskParams, ProjectsImportParams } from "./types.ts";

export interface BackendOptions {
  session: DevSession;
  jobs: JobTable;
  /** 健康检查时现探端点。 */
  probe: () => Promise<EndpointResult>;
  exec?: Exec;
}

/** 用真的 CDP 组装 REST 背后的实现。 */
export function createBackend({ session: s, jobs, probe, exec }: BackendOptions): DevBackend {
  const desktopOnly = (what: string) => {
    if (s.android) throw wrongPlatform(what, true);
  };
  return {
    async health() {
      return { vite: true, android: s.android, cdp: await probe(), session: s.summary(jobs.counts()) };
    },
    targets: () => listTargets(s),
    evaluate: (target, expression, timeoutMs) => evaluate(s, target, expression, timeoutMs),
    screenshot: (request) => screenshot(s, request),
    click: (target, selector) => click(s, target, selector),
    text: (target, selector) => text(s, target, selector),
    invoke: (command, args) => invoke(s, command, args),
    consoleStart: (target) => startConsole(s, target),
    consoleRead: async (id, since) => readConsole(s, id, since),
    consoleStop: (id) => stopConsole(s, id),
    appState: () => appState(s),
    async showWindow() {
      desktopOnly("显示主窗口");
      return showWindow(s);
    },
    // 安卓也能用（重载主 WebView、按弹窗判断），只是不显示窗口；没在真机上验过
    openImagePreview: (request) => openImagePreview(s, s.android ? { ...request, show: false } : request),
    async androidScreen() {
      if (!s.android) throw wrongPlatform("adb 整屏截图", false);
      const result = await androidScreencap(exec);
      if (!(result instanceof Uint8Array)) throw new DevError(503, "cdp", result.error, { endpoint: result });
      return result;
    },
    async hosts() {
      desktopOnly("场景宿主");
      return sceneHosts(s);
    },
    async hostOpen(request) {
      desktopOnly("场景宿主");
      return openHost(s, request);
    },
    async hostClose(handle) {
      desktopOnly("场景宿主");
      return closeHost(s, handle);
    },
    async hostEval(handle, expression, timeoutMs) {
      desktopOnly("场景宿主");
      return hostEval(s, handle, expression, timeoutMs);
    },
    async hostRender(handle, request) {
      desktopOnly("场景宿主");
      return renderFrame(s, handle, request);
    },
    async hostParticleTrack(handle, request) {
      desktopOnly("场景宿主");
      return particleTrack(s, handle, request);
    },
    async hostParticleCorners(handle, request) {
      desktopOnly("场景宿主");
      return particleCorners(s, handle, request);
    },
    async projectsRemove(manifest, allowPrefix) {
      desktopOnly("测试工程");
      return removeProjects(s, manifest, allowPrefix);
    },
    async jobStart(kind, params) {
      desktopOnly("长任务（宿主任务 / 画面哈希 / 导入测试工程）");
      if (!params || typeof params !== "object" || Array.isArray(params)) throw badRequest("params 要是对象");
      if (kind === "host-task") {
        const p = params as HostTaskParams;
        if (typeof p.host !== "string" || typeof p.expression !== "string") {
          throw badRequest("host-task 要 { host, expression, limitMs? }");
        }
        s.host(p.host);
        return jobs.start(kind, params, ({ signal }) =>
          hostTask(s, p.host, p.expression, { limitMs: p.limitMs, signal }),
        );
      }
      if (kind === "hash-baseline") {
        const p = params as HashBaselineParams;
        if (p.host !== undefined) s.host(p.host);
        return jobs.start(kind, params, (ctx) => hashBaseline(s, p, ctx));
      }
      const p = params as ProjectsImportParams;
      return jobs.start(kind, params, (ctx) => importProjects(s, p.dirs, ctx));
    },
    jobList: async () => jobs.list(),
    jobGet: async (id) => jobs.get(id),
    jobCancel: (id) => jobs.cancel(id),
  };
}

export interface DevRuntimeOptions {
  paths: DevPaths;
  android: boolean;
  /** 应用页面所在的 vite 端口（判定主窗口用）。 */
  vitePort: number;
  /** 桌面：读 CDP 登记。 */
  readRegistration: () => Promise<CdpRegistrationLike | null>;
  exec?: Exec;
}

export interface DevRuntime {
  session: DevSession;
  jobs: JobTable;
  backend: DevBackend;
  handler: ReturnType<typeof createRestHandler>;
  /** 取消任务、关掉全部宿主句柄（移除屏外 iframe）、断开 CDP。可重复调用。 */
  shutdown: () => Promise<void>;
}

export function createDevRuntime(options: DevRuntimeOptions): DevRuntime {
  const resolve = () =>
    resolveEndpoint({ android: options.android, readRegistration: options.readRegistration, exec: options.exec });
  const session = new DevSession({
    resolveEndpoint: resolve,
    vitePort: options.vitePort,
    android: options.android,
    paths: options.paths,
  });
  const jobs = new JobTable();
  const backend = createBackend({ session, jobs, probe: resolve, exec: options.exec });
  let closing: Promise<void> | null = null;
  const shutdown = () =>
    (closing ??= (async () => {
      await jobs.cancelAll().catch(() => {});
      if (session.connected) await closeAllHosts(session).catch(() => {});
      await session.close().catch(() => {});
    })());
  return { session, jobs, backend, handler: createRestHandler(backend), shutdown };
}
