import * as tracing from "@fltsci/tauri-plugin-tracing";
import { IS_WEB } from "@/env";

/**
 * 前端应用日志：Tauri 下经 tauri-plugin-tracing 进入后端 tracing（落盘、可在「查看日志」里看到，
 * target 为 `webview:<窗口>`）；Web 版没有插件，回落到浏览器 console。
 * 见 cocs/debug/APP_LOGGING.md。
 */
type Level = "trace" | "debug" | "info" | "warn" | "error";

const consoleFns: Record<Level, (...args: unknown[]) => void> = {
  trace: console.debug,
  debug: console.debug,
  info: console.info,
  warn: console.warn,
  error: console.error,
};

/** 插件对非字符串参数只会得到 `[object Object]`，这里先转成可读文本。 */
function stringify(arg: unknown): string {
  if (typeof arg === "string") return arg;
  if (arg instanceof Error) return `${arg.message}\n${arg.stack ?? ""}`.trim();
  try {
    return JSON.stringify(arg) ?? String(arg);
  } catch {
    return String(arg);
  }
}

function emit(level: Level, args: unknown[]): void {
  if (IS_WEB) {
    consoleFns[level](...args);
    return;
  }
  tracing[level](...(args.map(stringify) as Parameters<typeof tracing.info>));
}

export const logger = {
  trace: (...args: unknown[]) => emit("trace", args),
  debug: (...args: unknown[]) => emit("debug", args),
  info: (...args: unknown[]) => emit("info", args),
  warn: (...args: unknown[]) => emit("warn", args),
  error: (...args: unknown[]) => emit("error", args),
};
