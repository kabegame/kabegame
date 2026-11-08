/**
 * kabegame-dev REST（vite 插件 `scripts/kabegame-dev/`）的 typed 客户端。不依赖 MCP SDK：MCP 用它，验收脚本
 * （Deno 或 Node）也能直接 import。
 *
 * 请求缺省走 `localFetch`（`node:http` 直连）而不是全局 `fetch`：Deno 的 fetch 会把发往 127.0.0.1 的请求交给
 * `HTTP_PROXY`，代理连不上空端口时回 502，「vite 不在」就被误报成「vite 在但回 502」。单测可注入别的 fetch。
 *
 * ```ts
 * import { createClient } from "../../apps/kabegame-dev-mcp/src/client.ts";
 * const dev = createClient();
 * const mode = await dev.invoke("get_wallpaper_mode");
 * ```
 *
 * 出错统一抛 `KabegameDevError`，`layer` 说明是哪一层：`vite`（vite 不在，或在但没有本插件）、`cdp`（vite 在、CDP 不在，
 * `endpoint` 带原因）、`timeout`，其余是 REST 回的层（`rest` / `handle` / `page` / `app` / `host` / `guard` …）。
 */
import process from "node:process";
import { localFetch } from "../../../scripts/kabegame-dev/localHttp.ts";
import type { FetchLike } from "../../../scripts/kabegame-dev/localHttp.ts";
import type {
  AppState,
  ClickResponse,
  ClipRect,
  ConsoleBatch,
  ConsoleStartResponse,
  ConsoleStopResponse,
  EndpointError,
  ErrorBody,
  EvalResponse,
  HashBaselineParams,
  HealthInfo,
  HostCloseResult,
  HostOpenRequest,
  HostSummary,
  HostTaskParams,
  JobKind,
  JobRecord,
  OpenImagePreviewResult,
  OpenedHost,
  ParticleCornersLayer,
  ParticleCornersRequest,
  ParticleTrackRequest,
  ParticleTrackResult,
  ProjectManifest,
  ProjectsImportParams,
  ProjectsRemoveResult,
  RenderBody,
  ResizeRequest,
  ShowWindowResult,
  RenderResponse,
  TargetSpec,
  TargetSummary,
} from "../../../scripts/kabegame-dev/types.ts";

export type * from "../../../scripts/kabegame-dev/types.ts";

export class KabegameDevError extends Error {
  /** `vite` / `cdp` / `timeout`，或 REST 回的 `layer`。 */
  readonly layer: string;
  /** HTTP 状态；没连上 vite 时为 null。 */
  readonly status: number | null;
  /** REST 回的错误体。 */
  readonly body: ErrorBody | null;
  /** CDP 不在时的端点结论。 */
  readonly endpoint: EndpointError | null;
  /**
   * 底层错误（连不上 vite 时的连接异常等）。用 `declare`：根 tsconfig 的 lib 是 ES2020，`Error` 上没有 `cause`；
   * 根 tsconfig 之外（如 `.claude/skills/` 下 import 本文件的脚本）按 Deno 缺省选项检查，`Error` 上有 `cause`，
   * 普通字段会触发 `noImplicitOverride`。`declare` 两边都过。
   */
  declare readonly cause: unknown;

  constructor(
    layer: string,
    message: string,
    options: { status?: number | null; body?: ErrorBody | null; cause?: unknown } = {},
  ) {
    super(message);
    this.name = "KabegameDevError";
    this.cause = options.cause;
    this.layer = layer;
    this.status = options.status ?? null;
    this.body = options.body ?? null;
    const endpoint = options.body?.endpoint;
    this.endpoint = endpoint && typeof endpoint === "object" ? (endpoint as EndpointError) : null;
  }
}

export interface ClientOptions {
  /** vite 端口，缺省 `KABEGAME_DEV_SERVER_PORT` 或 1420。 */
  port?: number;
  host?: string;
  /** 缺省 `localFetch`（直连、不经代理）。 */
  fetch?: FetchLike;
  /** 单次请求超时（毫秒），缺省 120 s（渲染一帧可能要几十秒）。 */
  timeoutMs?: number;
}

export interface WaitJobOptions {
  onProgress?: (progress: unknown, record: JobRecord) => void;
  intervalMs?: number;
  /** 总等待上限，缺省不限。 */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** vite 暂时连不上（热重载）时继续重试多久，缺省 15 s。 */
  viteGraceMs?: number;
}

export const DEV_COMMAND = "deno task dev -c kabegame";

export function defaultVitePort(env: Record<string, string | undefined> = process.env): number {
  const port = Number.parseInt(env.KABEGAME_DEV_SERVER_PORT ?? "", 10);
  return Number.isInteger(port) && port > 0 ? port : 1420;
}

interface RequestOptions {
  body?: unknown;
  binary?: boolean;
  timeoutMs?: number;
}

export function createClient(options: ClientOptions = {}) {
  const port = options.port ?? defaultVitePort();
  const origin = `http://${options.host ?? "127.0.0.1"}:${port}`;
  const baseUrl = `${origin}/__kabegame_dev`;
  const fetchImpl = options.fetch ?? localFetch;
  const defaultTimeout = options.timeoutMs ?? 120_000;

  async function request(method: string, path: string, opts: RequestOptions = {}): Promise<unknown> {
    const timeoutMs = opts.timeoutMs ?? defaultTimeout;
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: opts.body !== undefined ? { "Content-Type": "application/json" } : undefined,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError")) {
        throw new KabegameDevError("timeout", `${method} ${path} ${timeoutMs} ms 没有回应`, { cause: error });
      }
      throw new KabegameDevError(
        "vite",
        `vite 不在：${origin} 无应答（${error instanceof Error ? error.message : String(error)}）。` +
          `dev 没跑，或 vite 正在热重载重启；没跑就请用户在自己的终端启动 ${DEV_COMMAND}（安卓加 --mode android）。`,
        { cause: error },
      );
    }
    const type = response.headers.get("content-type") ?? "";
    if (!type.includes("application/json") && !(opts.binary && type.startsWith("image/png") && response.ok)) {
      await response.body?.cancel();
      throw new KabegameDevError(
        "vite",
        `vite 在，但 ${path} 回的是 ${type || "未知类型"}（HTTP ${response.status}）：这个 vite 没有 kabegame-dev 插件，重启 dev 的 vite`,
        { status: response.status },
      );
    }
    if (opts.binary && response.ok) return new Uint8Array(await response.arrayBuffer());
    const body = (await response.json()) as unknown;
    if (!response.ok) {
      const error = body as ErrorBody;
      const layer = typeof error?.layer === "string" ? error.layer : "rest";
      const text = typeof error?.error === "string" ? error.error : JSON.stringify(body);
      const message = layer === "cdp" ? `vite 在，CDP 不在：${text}` : text;
      throw new KabegameDevError(layer, message, { status: response.status, body: error });
    }
    return body;
  }

  const get = <T>(path: string, opts?: RequestOptions) => request("GET", path, opts) as Promise<T>;
  const post = <T>(path: string, body: unknown, opts?: RequestOptions) =>
    request("POST", path, { ...opts, body }) as Promise<T>;
  const del = <T>(path: string) => request("DELETE", path) as Promise<T>;
  const seg = encodeURIComponent;

  const client = {
    baseUrl,
    /** 探活：vite 不在时抛 `layer: "vite"`；在时回 CDP 结论（`cdp` 里有 `error` 就是 CDP 不在）。 */
    health: () => get<HealthInfo>("/health", { timeoutMs: 15_000 }),
    targets: () => get<TargetSummary[]>("/targets"),
    evaluate: (target: TargetSpec, expression: string, timeoutMs?: number) =>
      post<EvalResponse>("/eval", { target, expression, timeoutMs }),
    /**
     * 截图（PNG 字节）。`selector` / `clip` / `fullPage` 三选一；`resize` 在 vite 里等比缩小后再回（不给回原图，
     * 原尺寸也在响应头 `X-Png-Original-Width` / `-Height`）。
     */
    screenshot: (
      target: TargetSpec,
      shot: { selector?: string; clip?: ClipRect; fullPage?: boolean; resize?: ResizeRequest } = {},
    ) => post<Uint8Array>("/screenshot", { target, ...shot }, { binary: true }),
    click: (target: TargetSpec, selector: string) => post<ClickResponse>("/click", { target, selector }),
    text: async (target: TargetSpec, selector: string) =>
      (await post<{ text: string }>("/text", { target, selector })).text,
    /** 调应用命令（主窗口里的 `__TAURI_INTERNALS__.invoke`）；命令 reject 时抛 `layer: "app"`。 */
    invoke: async <T = unknown>(command: string, args: Record<string, unknown> = {}) =>
      (await post<{ value: T }>("/invoke", { command, args })).value,
    consoleStart: (target: TargetSpec) => post<ConsoleStartResponse>("/console", { target }),
    consoleRead: (id: string, since = 0) => get<ConsoleBatch>(`/console/${seg(id)}?since=${since}`),
    consoleStop: (id: string) => del<ConsoleStopResponse>(`/console/${seg(id)}`),
    appState: () => get<AppState>("/app/state"),
    /** 桌面：把主窗口带到前台（unminimize / show / set_focus，不行再临时置顶），回前后的可见性与焦点。 */
    showWindow: () => post<ShowWindowResult>("/app/show-window", {}, { timeoutMs: 60_000 }),
    /**
     * 主窗口导航到 `/gallery?…&pvwimgid=<id>` 并重载，等预览弹窗打开到这张图，再显示主窗口（`show: false` 不显示）。
     * 会改变用户正在看的界面。
     */
    openImagePreview: (imageId: string | number, options: { timeoutMs?: number; show?: boolean } = {}) =>
      post<OpenImagePreviewResult>(
        "/app/open-preview",
        { imageId: String(imageId), ...options },
        { timeoutMs: (options.timeoutMs ?? 45_000) + 60_000 },
      ),
    /** 安卓：adb 整屏截图（PNG 字节）。 */
    androidScreen: (resize?: ResizeRequest) => {
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries(resize ?? {})) if (value !== undefined) query.set(key, String(value));
      const qs = query.toString();
      return get<Uint8Array>(`/android/screen${qs ? `?${qs}` : ""}`, { binary: true });
    },
    hosts: () => get<HostSummary[]>("/hosts"),
    hostOpen: (open: HostOpenRequest = {}) => post<OpenedHost>("/hosts", open, { timeoutMs: 60_000 }),
    hostClose: (handle: string) => del<HostCloseResult>(`/hosts/${seg(handle)}`),
    hostEval: (handle: string, expression: string, timeoutMs?: number) =>
      post<EvalResponse>(`/hosts/${seg(handle)}/eval`, { expression, timeoutMs }),
    /**
     * 宿主里渲染一帧；`resize` 时 `png` 是缩小后的，`pngSha256` / `pngBytes` 仍是原图的，`size` 报两者尺寸。
     * 带 `particles`（`{ dts, times?, seed?, passes?, random? }`）时做确定性粒子回放，此时不收 `time`。
     */
    hostRender: (handle: string, render: RenderBody) =>
      post<RenderResponse>(`/hosts/${seg(handle)}/render`, render, { timeoutMs: 10 * 60_000 }),
    /** 宿主里跑粒子轨迹（探针 `particleTrack`），回和 RenderDoc 轨迹同格式的 JSON；超过 32 MB 回 413。 */
    hostParticleTrack: (handle: string, request: ParticleTrackRequest) =>
      post<ParticleTrackResult>(`/hosts/${seg(handle)}/particle-track`, request, { timeoutMs: 10 * 60_000 }),
    /** 宿主里读粒子四角（探针 `particleCorners`）：每层每粒子四角的裁剪坐标与像素坐标；超过 32 MB 回 413。 */
    hostParticleCorners: (handle: string, request: ParticleCornersRequest) =>
      post<ParticleCornersLayer[]>(`/hosts/${seg(handle)}/particle-corners`, request, { timeoutMs: 10 * 60_000 }),
    projectsRemove: (manifest: ProjectManifest, allowPrefix?: string) =>
      post<ProjectsRemoveResult>("/projects/remove", { manifest, allowPrefix }),
    jobStart: (kind: JobKind, params: HostTaskParams | HashBaselineParams | ProjectsImportParams) =>
      post<JobRecord>("/jobs", { kind, params }),
    jobs: () => get<JobRecord[]>("/jobs"),
    job: (id: string) => get<JobRecord>(`/jobs/${seg(id)}`),
    jobCancel: (id: string) => del<JobRecord>(`/jobs/${seg(id)}`),

    /** 轮询任务直到结束，返回最终记录（`status` 是 done / failed / canceled）。任务丢了（vite 重启）抛 `layer: "handle"`。 */
    async waitJob(id: string, wait: WaitJobOptions = {}): Promise<JobRecord> {
      const interval = wait.intervalMs ?? 1000;
      const started = Date.now();
      let lastProgress = "";
      let unreachableSince: number | null = null;
      while (true) {
        if (wait.signal?.aborted) throw new KabegameDevError("timeout", `等任务 ${id} 被取消`);
        let record: JobRecord;
        try {
          record = await client.job(id);
          unreachableSince = null;
        } catch (error) {
          if (error instanceof KabegameDevError && error.layer === "vite" && error.status === null) {
            unreachableSince ??= Date.now();
            if (Date.now() - unreachableSince > (wait.viteGraceMs ?? 15_000)) throw error;
            await sleep(interval);
            continue;
          }
          throw error;
        }
        const progress = JSON.stringify(record.progress ?? null);
        if (progress !== lastProgress) {
          lastProgress = progress;
          wait.onProgress?.(record.progress, record);
        }
        if (record.status !== "running") return record;
        if (wait.timeoutMs !== undefined && Date.now() - started > wait.timeoutMs) {
          throw new KabegameDevError("timeout", `任务 ${id} ${wait.timeoutMs} ms 没结束（仍在 vite 里跑）`);
        }
        await sleep(interval);
      }
    },
  };
  return client;
}

export type KabegameDevClient = ReturnType<typeof createClient>;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
