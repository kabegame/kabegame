/**
 * 两层探活：第 1 层 vite（`/__kabegame_dev/health`）在不在；第 2 层经 vite 问 CDP 在不在。
 * CDP 预期在（app 起来后向 vite 登记端口，登记有落盘、跨得过 vite 重启），不在时报可能原因与下一步。
 * 不代起 dev：dev 由用户在自己的终端里启动。
 */
import { DEV_COMMAND, KabegameDevError } from "./client.ts";
import type { Endpoint, EndpointError, KabegameDevClient, SessionSummary } from "./client.ts";

export interface StatusReport {
  /** 两层都在。 */
  ok: boolean;
  vite: { ok: boolean; url: string; error?: string };
  /** vite 不在时为 null（无从知道）。 */
  cdp:
    | { ok: true; endpoint: Endpoint }
    | { ok: false; layer: EndpointError["layer"]; error: string; hint?: string }
    | null;
  android: boolean | null;
  session: SessionSummary | null;
  /** 一句话结论。 */
  conclusion: string;
  /** 可能原因（不在时）。 */
  reasons: string[];
  /** 下一步。 */
  next: string;
}

const DESKTOP_REASONS = [
  "vite 刚热重载重启：登记有落盘，等几秒再试",
  "app 还在编译或刚启动，还没向 vite 登记 CDP 端口",
  "app 已退出（登记不会撤销，所以会看到旧端口不应答）",
];
const ANDROID_REASONS = [
  "没有设备：未连接、未授权，或多台设备没设 ANDROID_SERIAL（adb devices 看）",
  "app 没在跑：设备上没有 app.kabegame.dev 的进程",
  "没有调试 socket：装的是 prod 包，或 WebView 还没建好",
];

export async function probeStatus(client: KabegameDevClient, viteUrl: string): Promise<StatusReport> {
  const base = { android: null, session: null } as const;
  let health;
  try {
    health = await client.health();
  } catch (error) {
    const dev = error instanceof KabegameDevError ? error : null;
    const message = error instanceof Error ? error.message : String(error);
    if (dev?.layer === "vite" && dev.status !== null) {
      return {
        ...base,
        ok: false,
        vite: { ok: false, url: viteUrl, error: message },
        cdp: null,
        conclusion: "第 1 层：vite 在，但没有 kabegame-dev 插件",
        reasons: ["这个 dev 的 vite 早于 kabegame-dev 插件，或 vite.config.pub.ts 没接上 kabegameDev"],
        next: "请用户重启 dev（只重启 vite 也行），不代起",
      };
    }
    const timeout = dev?.layer === "timeout";
    return {
      ...base,
      ok: false,
      vite: { ok: false, url: viteUrl, error: message },
      cdp: null,
      conclusion: timeout ? "第 1 层：vite 没有回应（超时）" : "第 1 层：vite 不在",
      reasons: timeout
        ? ["vite 进程卡住，或正在重启"]
        : ["dev 没跑", "vite 正在热重载重启（改了 vite 配置或它引用的文件），几秒后就回来"],
      next: `dev 没跑就请用户在自己的终端启动 ${DEV_COMMAND}（安卓加 --mode android），不代起；在跑就等几秒再调 status`,
    };
  }
  const cdp = health.cdp;
  if ("error" in cdp) {
    return {
      ok: false,
      vite: { ok: true, url: viteUrl },
      cdp: { ok: false, layer: cdp.layer, error: cdp.error, ...(cdp.hint ? { hint: cdp.hint } : {}) },
      android: health.android,
      session: health.session,
      conclusion: `第 2 层：vite 在，CDP 不在（${cdp.layer}：${cdp.error}）`,
      reasons: health.android ? ANDROID_REASONS : DESKTOP_REASONS,
      next:
        cdp.hint ??
        (health.android
          ? `请用户启动 ${DEV_COMMAND} --mode android 或在手机上打开 dev 包`
          : "等 app 编译完、起来后再调 status"),
    };
  }
  return {
    ok: true,
    vite: { ok: true, url: viteUrl },
    cdp: { ok: true, endpoint: cdp },
    android: health.android,
    session: health.session,
    conclusion:
      `就绪：vite 在，CDP 在（${cdp.kind} 端口 ${cdp.port}` +
      (cdp.pid ? `，pid ${cdp.pid}` : "") +
      (cdp.serial ? `，设备 ${cdp.serial}` : "") +
      "）",
    reasons: [],
    next: "可以调其它工具",
  };
}

export function formatStatus(report: StatusReport): string {
  const lines = [report.conclusion];
  lines.push(`第 1 层 vite（${report.vite.url}）：${report.vite.ok ? "在" : "不在"}`);
  if (report.cdp === null) {
    lines.push("第 2 层 CDP：未知（vite 不在，无从探）");
  } else if (report.cdp.ok) {
    const e = report.cdp.endpoint;
    lines.push(`第 2 层 CDP：在（${e.kind}，端口 ${e.port}${e.browser ? `，${e.browser}` : ""}）`);
  } else {
    lines.push(`第 2 层 CDP：不在（${report.cdp.layer}）${report.cdp.error}`);
    if (report.cdp.hint) lines.push(`提示：${report.cdp.hint}`);
  }
  if (report.session) {
    const s = report.session;
    lines.push(
      `vite 会话：${s.connected ? "已连" : "未连"}（第 ${s.generation} 条连接），宿主句柄 ${s.hosts.length}，` +
        `控制台流 ${s.consoles.length}，任务 ${s.jobs.running} 在跑 / 共 ${s.jobs.total}`,
    );
  }
  if (report.reasons.length) lines.push("可能原因：", ...report.reasons.map((r) => `- ${r}`));
  lines.push(`下一步：${report.next}`);
  return lines.join("\n");
}
