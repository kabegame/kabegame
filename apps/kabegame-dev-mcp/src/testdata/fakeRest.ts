/**
 * 单测用的假 kabegame-dev REST（按 handler 回包，记录每个请求）与共用的期望值。
 */
import { Buffer } from "node:buffer";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export type Handler = (req: IncomingMessage, body: unknown, res: ServerResponse) => void;

export async function fakeRest(handler: Handler) {
  const seen: Array<{ method: string; path: string; body: unknown }> = [];
  const server = createServer(async (req, res) => {
    const chunks: Uint8Array[] = [];
    for await (const chunk of req) chunks.push(chunk as Uint8Array);
    const text = Buffer.concat(chunks).toString("utf8");
    const body = text ? JSON.parse(text) : undefined;
    seen.push({ method: req.method ?? "", path: req.url ?? "", body });
    handler(req, body, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    seen,
    close: () => {
      server.closeAllConnections?.();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export const sendJson = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
};

export const SESSION = {
  connected: true,
  generation: 1,
  endpoint: null,
  hosts: [],
  consoles: [],
  jobs: { running: 0, total: 0 },
};

/** 1×1 的 PNG。 */
export const PNG = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="),
  (c) => c.charCodeAt(0),
);

/** 期望的工具表（静态，顺序即注册顺序）。 */
export const TOOLS = [
  "status",
  "targets",
  "eval",
  "screenshot",
  "click",
  "text",
  "invoke",
  "console",
  "app_state",
  "show_window",
  "open_image_preview",
  "android_screen",
  "hosts",
  "host_open",
  "host_close",
  "host_eval",
  "host_render",
  "projects_remove",
  "job",
  "render_scene",
  "particle_track",
  "particle_corners",
  "hash_baseline",
  "projects_import",
  "hash_compare",
  "app_log",
];
