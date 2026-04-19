/**
 * Web mode Phase 3 smoke test
 * Usage: bun scripts/test-web-api.ts
 */

const BASE = "http://127.0.0.1:7490";

let pass = 0;
let fail = 0;

function ok(label: string, value: unknown) {
  console.log(`  ✓ ${label}:`, JSON.stringify(value));
  pass++;
}

function err(label: string, reason: unknown) {
  console.error(`  ✗ ${label}:`, reason);
  fail++;
}

async function rpc(method: string, params: unknown = {}, superMode = false) {
  const url = superMode ? `${BASE}/rpc?super=1` : `${BASE}/rpc`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return res.json() as Promise<any>;
}

// ── ping ─────────────────────────────────────────────────────────────────────
console.log("\n[1] /__ping");
{
  const res = await fetch(`${BASE}/__ping`);
  const text = await res.text();
  text === "ok" ? ok("ping", text) : err("ping", text);
}

// ── read commands (no super) ─────────────────────────────────────────────────
console.log("\n[2] read RPC methods");
{
  const r = await rpc("get_build_mode");
  typeof r.result === "string"
    ? ok("get_build_mode", r.result)
    : err("get_build_mode", r);
}
{
  const r = await rpc("get_albums");
  Array.isArray(r.result)
    ? ok("get_albums", `${r.result.length} albums`)
    : err("get_albums", r);
}
{
  const r = await rpc("get_album_counts");
  r.result !== undefined
    ? ok("get_album_counts", r.result)
    : err("get_album_counts", r);
}
{
  const r = await rpc("get_tasks_page", { limit: 5, offset: 0 });
  r.result?.tasks !== undefined
    ? ok("get_tasks_page", `total=${r.result.total}`)
    : err("get_tasks_page", r);
}
{
  const r = await rpc("get_images_range", { offset: 0, limit: 3 });
  Array.isArray(r.result?.images)
    ? ok("get_images_range", `${r.result.images.length}/${r.result.total} images`)
    : err("get_images_range", r);
}
{
  const r = await rpc("get_supported_image_types");
  Array.isArray(r.result?.extensions)
    ? ok("get_supported_image_types", `${r.result.extensions.length} exts`)
    : err("get_supported_image_types", r);
}

// ── super gate ───────────────────────────────────────────────────────────────
console.log("\n[3] super gate");
{
  // write without super → forbidden
  const r = await rpc("rename_album", { album_id: "x", new_name: "y" }, false);
  r.error?.code === -32001
    ? ok("rename_album (no super) → forbidden", r.error.code)
    : err("rename_album (no super) should be -32001", r);
}
{
  // write with super → internal (album not found) is fine, not forbidden
  const r = await rpc("rename_album", { album_id: "__nonexistent__", new_name: "y" }, true);
  r.error?.code === -32001
    ? err("rename_album (super) should not be -32001", r)
    : ok("rename_album (super) not forbidden", r.error?.message ?? "ok");
}

// ── error paths ──────────────────────────────────────────────────────────────
console.log("\n[4] error paths");
{
  const r = await rpc("no_such_method");
  r.error?.code === -32601
    ? ok("unknown method → -32601", r.error.message)
    : err("unknown method should be -32601", r);
}
{
  // bad params
  const r = await rpc("get_images_range", { offset: "bad" }, false);
  r.error?.code === -32602
    ? ok("bad params → -32602", r.error.message)
    : err("bad params should be -32602", r);
}

// ── SSE ──────────────────────────────────────────────────────────────────────
console.log("\n[5] SSE /events (read first frame)");
{
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 3000);
  try {
    const res = await fetch(`${BASE}/events`, { signal: ctrl.signal });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let found = false;
    while (!found) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      if (buf.includes("event: connected")) {
        ok("SSE connected frame received", buf.slice(0, 80).replace(/\n/g, "\\n"));
        found = true;
      }
    }
    if (!found) err("SSE connected frame", "not received within 3s");
  } catch (e: any) {
    if (e.name === "AbortError") err("SSE", "timeout - no connected frame in 3s");
    else err("SSE", e.message);
  } finally {
    clearTimeout(timeout);
  }
}

// ── summary ──────────────────────────────────────────────────────────────────
console.log(`\n${"─".repeat(40)}`);
console.log(`PASS ${pass}  FAIL ${fail}`);
if (fail > 0) process.exit(1);
