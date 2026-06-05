import type { IncomingMessage, ServerResponse } from "node:http";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Plugin } from "vite";

const DEBUG_PREFIX = "/__kabegame_debug";
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

export interface KabegameDebugServerOptions {
  workspaceRoot: string;
  enabled?: boolean;
  allowRemote?: boolean;
  logToConsole?: boolean;
  maxBodyBytes?: number;
}

type DebugEvent = Record<string, unknown>;

export function kabegameDebugServer(options: KabegameDebugServerOptions): Plugin {
  const enabled = options.enabled ?? true;
  const allowRemote = options.allowRemote ?? process.env.KABEGAME_DEBUG_ALLOW_REMOTE === "true";
  const logToConsole = options.logToConsole ?? process.env.KABEGAME_DEBUG_TEE_CONSOLE === "true";
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const debugDir = path.resolve(options.workspaceRoot, ".kabegame", "debug");

  return {
    name: "kabegame-debug-server",
    apply: "serve",
    configureServer(server) {
      if (!enabled) return;

      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url ?? "/", "http://kabegame.local");
        if (url.pathname !== DEBUG_PREFIX && !url.pathname.startsWith(`${DEBUG_PREFIX}/`)) {
          next();
          return;
        }

        if (!allowRemote && !isLoopback(req.socket.remoteAddress)) {
          sendJson(res, 403, { ok: false, error: "remote debug ingest is disabled" });
          return;
        }

        try {
          if (req.method === "GET" && url.pathname === `${DEBUG_PREFIX}/health`) {
            sendJson(res, 200, { ok: true, debugDir });
            return;
          }

          if (req.method === "GET" && url.pathname === `${DEBUG_PREFIX}/sessions`) {
            const sessions = await listSessions(debugDir);
            sendJson(res, 200, { ok: true, sessions });
            return;
          }

          if (req.method === "GET" && url.pathname.startsWith(`${DEBUG_PREFIX}/sessions/`)) {
            const sessionId = sanitizeSessionId(
              decodeURIComponent(url.pathname.slice(`${DEBUG_PREFIX}/sessions/`.length)),
            );
            const lines = Number.parseInt(url.searchParams.get("lines") ?? "200", 10);
            const content = await readSessionTail(debugDir, sessionId, Number.isFinite(lines) ? lines : 200);
            res.statusCode = 200;
            res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
            res.end(content);
            return;
          }

          if (req.method === "POST" && url.pathname === `${DEBUG_PREFIX}/ingest`) {
            const body = await readBody(req, maxBodyBytes);
            const requestSessionId = sanitizeSessionId(
              url.searchParams.get("session_id") ??
                url.searchParams.get("sessionId") ??
                getHeader(req, "x-kabegame-debug-session") ??
                process.env.KABEGAME_DEBUG_SESSION_ID ??
                "default",
            );
            const events = parseEvents(body).map((event) => normalizeEvent(event, requestSessionId));
            await appendEvents(debugDir, events, logToConsole);
            res.statusCode = 204;
            res.end();
            return;
          }

          sendJson(res, 404, { ok: false, error: "unknown debug endpoint" });
        } catch (error) {
          sendJson(res, 500, {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      });
    },
  };
}

function isLoopback(address: string | undefined): boolean {
  if (!address) return true;
  if (address === "::1" || address === "localhost") return true;
  if (address.startsWith("127.")) return true;
  if (address.startsWith("::ffff:127.")) return true;
  return false;
}

function getHeader(req: IncomingMessage, name: string): string | null {
  const value = req.headers[name];
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function sendJson(res: ServerResponse, statusCode: number, data: unknown): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(data));
}

async function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) {
      throw new Error(`debug ingest body exceeds ${maxBytes} bytes`);
    }
    chunks.push(buffer);
  }

  return Buffer.concat(chunks).toString("utf8");
}

function parseEvents(body: string): unknown[] {
  const trimmed = body.trim();
  if (!trimmed) return [{}];

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch (error) {
      if (!trimmed.includes("\n")) throw error;
    }
  }

  return trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function normalizeEvent(raw: unknown, fallbackSessionId: string): DebugEvent {
  const now = new Date().toISOString();
  const event: DebugEvent =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? { ...(raw as Record<string, unknown>) }
      : { payload: raw };

  const sessionId = sanitizeSessionId(
    getString(event.session_id) ?? getString(event.sessionId) ?? fallbackSessionId,
  );
  event.session_id = sessionId;
  delete event.sessionId;

  if (!event.ts) event.ts = now;
  if (!event.received_at) event.received_at = now;
  if (!event.source) event.source = "unknown";

  return event;
}

function getString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function sanitizeSessionId(raw: string | null | undefined): string {
  const value = (raw ?? "default").trim() || "default";
  const sanitized = value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 96);
  if (sanitized) return sanitized;

  return crypto.createHash("sha1").update(value).digest("hex").slice(0, 16);
}

async function appendEvents(debugDir: string, events: DebugEvent[], logToConsole: boolean): Promise<void> {
  await fs.mkdir(debugDir, { recursive: true });

  const bySession = new Map<string, string[]>();
  for (const event of events) {
    const sessionId = sanitizeSessionId(getString(event.session_id) ?? "default");
    const line = JSON.stringify(event);
    const lines = bySession.get(sessionId) ?? [];
    lines.push(line);
    bySession.set(sessionId, lines);

    if (logToConsole) {
      console.debug(`[kabegame-debug:${sessionId}] ${line}`);
    }
  }

  await Promise.all(
    [...bySession.entries()].map(([sessionId, lines]) =>
      fs.appendFile(sessionFile(debugDir, sessionId), `${lines.join("\n")}\n`, "utf8"),
    ),
  );
}

async function listSessions(debugDir: string): Promise<Array<{ session_id: string; file: string; size: number; updated_at: string }>> {
  let entries: string[];
  try {
    entries = await fs.readdir(debugDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const sessions = await Promise.all(
    entries
      .filter((entry) => entry.startsWith("debug-") && entry.endsWith(".ndjson"))
      .map(async (entry) => {
        const fullPath = path.join(debugDir, entry);
        const stat = await fs.stat(fullPath);
        return {
          session_id: entry.slice("debug-".length, -".ndjson".length),
          file: fullPath,
          size: stat.size,
          updated_at: stat.mtime.toISOString(),
        };
      }),
  );

  return sessions.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

async function readSessionTail(debugDir: string, sessionId: string, lineCount: number): Promise<string> {
  const file = sessionFile(debugDir, sessionId);
  let content: string;
  try {
    content = await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }

  const lines = content.trimEnd().split(/\r?\n/);
  return `${lines.slice(-Math.max(1, Math.min(lineCount, 5000))).join("\n")}\n`;
}

function sessionFile(debugDir: string, sessionId: string): string {
  return path.join(debugDir, `debug-${sanitizeSessionId(sessionId)}.ndjson`);
}
