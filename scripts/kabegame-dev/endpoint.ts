/**
 * 找 CDP 端点。只在 vite 里做：桌面读 app 向 debug server 的登记，安卓按 adb 现找（移植 `driver.sh` 的
 * `resolve_android_port`）。不再扫描本机端口：vite 是唯一来源。
 */
import { execFile } from "node:child_process";
import process from "node:process";
import { localFetch } from "./localHttp.ts";
import type { FetchLike } from "./localHttp.ts";
import type { Endpoint, EndpointError, EndpointResult } from "./types.ts";

/** app 登记的 CDP 端口（`vite-debug-server.ts` 的 `currentCdpRegistration`）。 */
export interface CdpRegistrationLike {
  port: number;
  pid: number | null;
}

export interface ExecResult {
  /** 进程退出码；没能启动时为 null。 */
  code: number | null;
  stdout: Uint8Array;
  stderr: string;
  /** 没能启动的原因，例如 `ENOENT`（找不到命令）。 */
  spawnError?: string;
}

export type Exec = (file: string, args: string[], options?: { timeoutMs?: number }) => Promise<ExecResult>;

export interface ResolveEndpointOptions {
  android: boolean;
  /** 桌面：读登记（内存优先，再读落盘）。 */
  readRegistration?: () => Promise<CdpRegistrationLike | null>;
  /** 安卓包名，缺省 `KABEGAME_ANDROID_PACKAGE` 或 `app.kabegame.dev`。 */
  androidPackage?: string;
  /** 缺省 `localFetch`（直连、不经代理）。 */
  fetch?: FetchLike;
  exec?: Exec;
  probeTimeoutMs?: number;
}

const DEV_CMD = "deno task dev -c kabegame";
const ANDROID_DEV_CMD = "deno task dev -c kabegame --mode android";

export async function resolveEndpoint(options: ResolveEndpointOptions): Promise<EndpointResult> {
  return options.android ? resolveAndroid(options) : resolveDesktop(options);
}

/**
 * `/json/version` 探活：vite 的 SPA 兜底对任意路径回 200，必须认响应里的 `webSocketDebuggerUrl`。
 * 缺省用 `localFetch` 直连：vite 跑在 Deno 下，全局 fetch 会把本机请求交给 `HTTP_PROXY`。
 */
export async function probeCdp(
  port: number,
  fetchImpl: FetchLike = localFetch,
  timeoutMs = 2000,
): Promise<{ webSocketUrl: string; browser?: string } | { error: string }> {
  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    if (!response.ok) return { error: `HTTP ${response.status}` };
    let body: { webSocketDebuggerUrl?: unknown; Browser?: unknown };
    try {
      body = JSON.parse(text);
    } catch {
      return { error: "回的不是 JSON（不是 DevTools 端点）" };
    }
    if (typeof body.webSocketDebuggerUrl !== "string" || !body.webSocketDebuggerUrl) {
      return { error: "响应里没有 webSocketDebuggerUrl" };
    }
    return {
      webSocketUrl: body.webSocketDebuggerUrl,
      browser: typeof body.Browser === "string" ? body.Browser : undefined,
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

async function resolveDesktop(options: ResolveEndpointOptions): Promise<EndpointResult> {
  const registration = options.readRegistration ? await options.readRegistration() : null;
  if (!registration) {
    return {
      layer: "registration",
      error: "vite 上没有 CDP 端口登记",
      hint:
        "app 还在编译或还没起到 setup（等一会儿再试）；或这个 dev 实例早于端口登记功能（重启 dev）；" +
        "或显式设了 KABEGAME_CEF_DEBUG_PORT=0。",
    };
  }
  const probe = await probeCdp(registration.port, options.fetch, options.probeTimeoutMs);
  if ("error" in probe) {
    return {
      layer: "cdp",
      error: `登记的 CDP 端口 ${registration.port} 不应答：${probe.error}`,
      hint: "登记不会自动撤销：多半是 app 已退出或正在热重启，等它起来再试；app 没在跑就请用户启动 " + DEV_CMD + "。",
      port: registration.port,
      pid: registration.pid,
    };
  }
  const endpoint: Endpoint = {
    kind: "desktop",
    port: registration.port,
    webSocketUrl: probe.webSocketUrl,
    pid: registration.pid,
  };
  if (probe.browser) endpoint.browser = probe.browser;
  return endpoint;
}

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes).replace(/\r/g, "");

async function resolveAndroid(options: ResolveEndpointOptions): Promise<EndpointResult> {
  const exec = options.exec ?? defaultExec;
  const pkg = options.androidPackage ?? process.env.KABEGAME_ANDROID_PACKAGE ?? "app.kabegame.dev";
  const adb = (args: string[]) => exec("adb", args, { timeoutMs: 10_000 });

  const version = await adb(["version"]);
  if (version.code === null) {
    return {
      layer: "adb",
      error: `找不到 adb（${version.spawnError ?? "无法启动"}）`,
      hint: "Android SDK platform-tools 没装或不在 vite 进程的 PATH 里。",
    };
  }
  const state = await adb(["get-state"]);
  if (state.code !== 0) {
    return {
      layer: "device",
      error: `adb 没有可用设备：${state.stderr.trim() || text(state.stdout).trim()}`,
      hint: "未连接 / 未授权 / 多台设备未设 ANDROID_SERIAL，用 `adb devices` 确认。",
    };
  }
  const serial = text((await adb(["get-serialno"])).stdout).trim() || undefined;

  const pidOut = text((await adb(["shell", "pidof", pkg])).stdout).trim();
  const pid = Number.parseInt(pidOut.split(/\s+/)[0] ?? "", 10);
  if (!Number.isInteger(pid)) {
    return {
      layer: "app",
      error: `设备上没有在跑的 ${pkg}`,
      hint: `请用户在自己的终端里启动 ${ANDROID_DEV_CMD}，或在手机上打开已装的 dev 包；包名不同就设 KABEGAME_ANDROID_PACKAGE。`,
      serial,
    };
  }

  const socket = `webview_devtools_remote_${pid}`;
  const unix = text((await adb(["shell", "cat", "/proc/net/unix"])).stdout);
  const hasSocket = unix.split("\n").some((line) => line.trimEnd().endsWith(`@${socket}`));
  if (!hasSocket) {
    return {
      layer: "socket",
      error: `${pkg}（pid ${pid}）没有 WebView 调试 socket`,
      hint: "只有 devtools=true 的构建（dev）才开 WebView 调试，prod 包不行；也可能 WebView 还没建好，等界面出来再试。",
      pid,
      serial,
    };
  }

  const fetchImpl = options.fetch ?? localFetch;
  // 现有转发：复用指向这个 socket 且应答的；清掉指向别的 webview_devtools_remote_* 的陈旧条目（pid 每次启动都变）
  let reusable: number | null = null;
  for (const forward of parseForwardList(text((await adb(["forward", "--list"])).stdout))) {
    if (serial && forward.serial !== serial) continue;
    if (forward.remote === `localabstract:${socket}`) {
      const port = Number.parseInt(forward.local.replace(/^tcp:/, ""), 10);
      if (reusable === null && Number.isInteger(port) && !("error" in (await probeCdp(port, fetchImpl)))) {
        reusable = port;
        continue;
      }
      await adb(["forward", "--remove", forward.local]);
    } else if (forward.remote.startsWith("localabstract:webview_devtools_remote_")) {
      await adb(["forward", "--remove", forward.local]);
    }
  }

  let port = reusable;
  if (port === null) {
    const created = await adb(["forward", "tcp:0", `localabstract:${socket}`]);
    port = Number.parseInt(text(created.stdout).trim(), 10);
    if (created.code !== 0 || !Number.isInteger(port)) {
      return {
        layer: "forward",
        error: `adb forward 到 ${socket} 失败：${created.stderr.trim() || text(created.stdout).trim()}`,
        pid,
        serial,
      };
    }
  }

  const probe = await probeCdp(port, fetchImpl, options.probeTimeoutMs);
  if ("error" in probe) {
    return { layer: "forward", error: `转发端口 ${port} 不应答：${probe.error}`, port, pid, serial };
  }
  const endpoint: Endpoint = { kind: "android", port, webSocketUrl: probe.webSocketUrl, pid, socket };
  if (serial) endpoint.serial = serial;
  if (probe.browser) endpoint.browser = probe.browser;
  return endpoint;
}

/** `adb forward --list` 的每行：`<serial> <local> <remote>`。 */
export function parseForwardList(output: string): Array<{ serial: string; local: string; remote: string }> {
  return output
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts.length >= 3)
    .map(([serial, local, remote]) => ({ serial, local, remote }));
}

/** adb 整屏截图（含系统栏、原生对话框）。 */
export async function androidScreencap(exec: Exec = defaultExec): Promise<Uint8Array | EndpointError> {
  const result = await exec("adb", ["exec-out", "screencap", "-p"], { timeoutMs: 20_000 });
  if (result.code === null) return { layer: "adb", error: `找不到 adb（${result.spawnError ?? "无法启动"}）` };
  if (result.code !== 0 || result.stdout.length < 8) {
    return { layer: "device", error: `adb screencap 失败：${result.stderr.trim() || "没有输出"}` };
  }
  return result.stdout;
}

export const defaultExec: Exec = (file, args, options = {}) =>
  new Promise((resolve) => {
    execFile(
      file,
      args,
      { encoding: "buffer", timeout: options.timeoutMs ?? 10_000, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        const code = (error as NodeJS.ErrnoException | null)?.code;
        if (error && typeof code === "string") {
          resolve({ code: null, stdout: new Uint8Array(), stderr: String(stderr ?? ""), spawnError: code });
          return;
        }
        const exitCode = error ? ((error as { code?: number }).code ?? 1) : 0;
        resolve({
          code: typeof exitCode === "number" ? exitCode : 1,
          stdout: new Uint8Array(stdout),
          stderr: new TextDecoder().decode(stderr),
        });
      },
    );
  });

export function describeEndpointError(error: EndpointError): string {
  return error.hint ? `${error.error}。${error.hint}` : error.error;
}
