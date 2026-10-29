import { trace } from "@fltsci/tauri-plugin-tracing";
import { IS_DEV, IS_WEB } from "./env";

export interface DebugIngestOptions {
  sessionId?: string;
  source?: string;
  level?: "debug" | "info" | "warn" | "error";
}

export interface DebugIngestEvent {
  session_id: string;
  source: string;
  level: string;
  name: string;
  ts: number;
  payload: unknown;
}

const DEBUG_INGEST_ENDPOINT = "/__kabegame_debug/ingest";

/** 与后端 `debug_ingest.rs` 的 `FRONTEND_PREFIX` 一致。 */
const DEBUG_TRACE_PREFIX = "kb-debug ";

export function buildDebugEvent(
  name: string,
  payload: unknown = null,
  options: DebugIngestOptions = {},
): DebugIngestEvent {
  return {
    session_id: options.sessionId ?? getDebugSessionId(),
    source: options.source ?? "frontend",
    level: options.level ?? "debug",
    name,
    ts: Date.now(),
    payload,
  };
}

/**
 * 开发期插桩。Tauri 下是一条 trace 日志（经 tauri-plugin-tracing），由后端的 debug ingest
 * 订阅层转发到 dev server；Web dev 没有插件，直接 POST 给 Vite 中间件。见 cocs/debug/DEBUG_INGEST.md。
 */
export async function sendDebugEvent(
  name: string,
  payload: unknown = null,
  options: DebugIngestOptions = {},
): Promise<void> {
  if (!IS_DEV) return;

  try {
    const body = JSON.stringify(buildDebugEvent(name, payload, options));
    if (!IS_WEB) {
      trace(`${DEBUG_TRACE_PREFIX}${body}`);
      return;
    }
    await fetch(DEBUG_INGEST_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body,
      keepalive: true,
    });
  } catch {
    // Debug ingest must never affect app behavior.
  }
}

export function getDebugSessionId(): string {
  const fromUrl = new URLSearchParams(window.location.search).get("debug_session");
  if (fromUrl?.trim()) return fromUrl.trim();

  const stored = window.sessionStorage.getItem("kabegame-debug-session");
  if (stored?.trim()) return stored.trim();

  const generated = `frontend-${Date.now().toString(36)}`;
  window.sessionStorage.setItem("kabegame-debug-session", generated);
  return generated;
}
