import { IS_ANDROID, IS_DEV } from "./env";

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

export async function sendDebugEvent(
  name: string,
  payload: unknown = null,
  options: DebugIngestOptions = {},
): Promise<void> {
  if (!IS_DEV) return;

  try {
    const body = JSON.stringify(buildDebugEvent(name, payload, options));
    // Android WebView 的请求经 shouldInterceptRequest 代理，POST body 到不了 dev server，改走查询参数
    const endpoint = IS_ANDROID ? `${DEBUG_INGEST_ENDPOINT}?event=${encodeURIComponent(body)}` : DEBUG_INGEST_ENDPOINT;
    await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: IS_ANDROID ? undefined : body,
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
