#!/usr/bin/env -S deno run -A
// 插件链路探针：取页 / 选择器 / 内嵌 JSON / 媒体校验。
//
// DOM 解析用 deno-dom —— 与 V8 插件运行时里的 DOMParser 是同一实现
// （src-tauri/kabegame-core/src/plugin/v8/deno_dom_wasm_noinit.js），所以这里能选中的
// 选择器，插件里也能选中；这里选不中的（比如某些伪类），插件里也别指望。
//
//   probe.ts get   <url> [-o file] [--referer R] [--cookie C] [-H "K: V"]...
//   probe.ts sel   <file|url> <css> [attr|@text|@html] [--limit N]
//   probe.ts json  <file|url> [path]        # 文件是 JSON 或 HTML（自动找内嵌 state）
//   probe.ts media <url> [--referer R] [--cookie C] [-H "K: V"]...

import { DOMParser } from "jsr:@b-fuze/deno-dom@0.1.56";

// 与 Kabegame.cefUserAgent() 同形：站点按真浏览器对待，避免拿到降级页面。
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

type Opts = { out?: string; referer?: string; cookie?: string; headers: string[]; limit: number; rest: string[] };

function parseArgs(argv: string[]): Opts {
  const o: Opts = { headers: [], limit: 15, rest: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-o") o.out = argv[++i];
    else if (a === "--referer") o.referer = argv[++i];
    else if (a === "--cookie") o.cookie = argv[++i];
    else if (a === "-H") o.headers.push(argv[++i]);
    else if (a === "--limit") o.limit = Number(argv[++i]);
    else o.rest.push(a);
  }
  return o;
}

function buildHeaders(o: Opts, extra: Record<string, string> = {}): Headers {
  const h = new Headers({ "User-Agent": UA, "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8,ja;q=0.7", ...extra });
  if (o.referer) h.set("Referer", o.referer);
  if (o.cookie) h.set("Cookie", o.cookie);
  for (const line of o.headers) {
    const idx = line.indexOf(":");
    if (idx > 0) h.set(line.slice(0, idx).trim(), line.slice(idx + 1).trim());
  }
  return h;
}

async function loadText(src: string, o: Opts): Promise<string> {
  if (/^https?:\/\//.test(src)) {
    const r = await fetch(src, { headers: buildHeaders(o) });
    return await r.text();
  }
  return await Deno.readTextFile(src);
}

// 反爬 / 空壳信号：任何一条命中都说明 curl 这条路可能走不通，V8 插件大概率也拿不到。
function blockSignals(status: number, html: string, textLen: number): string[] {
  const s: string[] = [];
  if (status === 403 || status === 503 || status === 429) s.push(`HTTP ${status}`);
  if (/Just a moment|cf-browser-verification|challenge-platform|__cf_chl_/i.test(html)) s.push("Cloudflare 质询页");
  if (/captcha|recaptcha|hcaptcha|geetest/i.test(html)) s.push("出现验证码关键字");
  if (/<div id="(app|root|__next)"[^>]*>\s*<\/div>/i.test(html) && textLen < 200) s.push("SPA 空壳（正文由 JS 渲染）");
  if (/login|登录|ログイン/i.test(html) && textLen < 500) s.push("疑似登录墙");
  return s;
}

function embeddedStates(html: string): Record<string, unknown> {
  const found: Record<string, unknown> = {};
  const doc = new DOMParser().parseFromString(html, "text/html")!;
  for (const s of doc.querySelectorAll("script")) {
    const el = s as unknown as { getAttribute(n: string): string | null; textContent: string };
    const id = el.getAttribute("id") ?? "";
    const type = el.getAttribute("type") ?? "";
    const body = el.textContent.trim();
    if (!body) continue;
    try {
      if (id === "__NEXT_DATA__" || type === "application/json") {
        found[id || `json#${Object.keys(found).length}`] = JSON.parse(body);
        continue;
      }
      if (type === "application/ld+json") {
        found[`ld+json#${Object.keys(found).length}`] = JSON.parse(body);
        continue;
      }
      const m = body.match(/window\.(__[A-Z_]+__|__INITIAL_STATE__|__NUXT__|__APOLLO_STATE__)\s*=\s*([\s\S]+?);?\s*$/);
      if (m) {
        found[m[1]] = JSON.parse(m[2].replace(/;\s*$/, "").replace(/\bundefined\b/g, "null"));
      }
    } catch {
      // 不是纯 JSON 字面量（比如 __NUXT__ 是函数调用），交给人工看
      found[(id || "script") + "#unparsed"] = body.slice(0, 200) + "…";
    }
  }
  return found;
}

function getPath(v: unknown, path: string): unknown {
  if (!path) return v;
  let cur: unknown = v;
  for (const seg of path.split(".").filter(Boolean)) {
    if (cur == null) return undefined;
    cur = (cur as Record<string, unknown>)[/^\d+$/.test(seg) ? Number(seg) : seg];
  }
  return cur;
}

// 只打印「形状」：键名 + 类型 + 截断的样值，避免一次把几 MB 的 state 倒进上下文。
function shape(v: unknown, depth = 0, maxDepth = 2): string {
  const pad = "  ".repeat(depth);
  if (Array.isArray(v)) {
    if (v.length === 0) return "[]";
    if (depth >= maxDepth) return `Array(${v.length})`;
    return `Array(${v.length}) of\n${pad}  ${shape(v[0], depth + 1, maxDepth)}`;
  }
  if (v && typeof v === "object") {
    const keys = Object.keys(v);
    if (depth >= maxDepth) return `{${keys.slice(0, 12).join(", ")}${keys.length > 12 ? ", …" : ""}}`;
    return "{\n" +
      keys.slice(0, 40).map((k) => `${pad}  ${k}: ${shape((v as Record<string, unknown>)[k], depth + 1, maxDepth)}`)
        .join("\n") + (keys.length > 40 ? `\n${pad}  …(${keys.length} keys)` : "") + `\n${pad}}`;
  }
  if (typeof v === "string") return JSON.stringify(v.length > 100 ? v.slice(0, 100) + "…" : v);
  return String(v);
}

function sniff(b: Uint8Array): string {
  const hex = [...b.slice(0, 12)].map((x) => x.toString(16).padStart(2, "0")).join("");
  const ascii = new TextDecoder().decode(b.slice(0, 12));
  if (hex.startsWith("ffd8ff")) return "jpeg";
  if (hex.startsWith("89504e47")) return "png";
  if (ascii.startsWith("GIF8")) return "gif";
  if (ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WEBP") return "webp";
  if (ascii.slice(4, 8) === "ftyp") return `mp4/heif/avif(${ascii.slice(8, 12)})`;
  if (hex.startsWith("1a45dfa3")) return "webm/mkv";
  if (/^\s*</.test(ascii)) return "HTML（多半是错误页/防盗链页）";
  if (/^\s*[{[]/.test(ascii)) return "JSON（多半是错误响应）";
  return `unknown(${hex})`;
}

const [cmd, ...argv] = Deno.args;
const o = parseArgs(argv);

if (cmd === "get") {
  const url = o.rest[0];
  const r = await fetch(url, { headers: buildHeaders(o), redirect: "follow" });
  const html = await r.text();
  if (o.out) await Deno.writeTextFile(o.out, html);
  const doc = new DOMParser().parseFromString(html, "text/html")!;
  const text = (doc.body?.textContent ?? "").replace(/\s+/g, " ").trim();
  console.log(`status    ${r.status}`);
  console.log(`final     ${r.url}`);
  console.log(`type      ${r.headers.get("content-type")}`);
  console.log(`bytes     ${html.length}  正文文字 ${text.length}`);
  console.log(`title     ${doc.querySelector("title")?.textContent?.trim() ?? ""}`);
  console.log(`set-cookie ${r.headers.get("set-cookie") ? "有" : "无"}`);
  const states = Object.keys(embeddedStates(html));
  console.log(`内嵌state ${states.length ? states.join(", ") : "无"}`);
  const sig = blockSignals(r.status, html, text.length);
  console.log(sig.length ? `⚠ 拦截信号：${sig.join("；")}` : "✓ 未见拦截信号");
  if (o.out) console.log(`saved     ${o.out}`);
} else if (cmd === "sel") {
  const [src, css, what] = o.rest;
  const doc = new DOMParser().parseFromString(await loadText(src, o), "text/html")!;
  const els = [...doc.querySelectorAll(css)] as unknown as Array<
    { getAttribute(n: string): string | null; textContent: string; outerHTML: string }
  >;
  console.log(`# ${els.length} matches for ${css}`);
  for (const e of els.slice(0, o.limit)) {
    if (!what || what === "@text") console.log(e.textContent.replace(/\s+/g, " ").trim().slice(0, 160));
    else if (what === "@html") console.log(e.outerHTML.slice(0, 300));
    else console.log(e.getAttribute(what));
  }
} else if (cmd === "json") {
  const [src, path = ""] = o.rest;
  const raw = await loadText(src, o);
  let root: unknown;
  try {
    root = JSON.parse(raw);
  } catch {
    root = embeddedStates(raw);
  }
  console.log(shape(getPath(root, path), 0, path ? 3 : 2));
} else if (cmd === "media") {
  const url = o.rest[0];
  const r = await fetch(url, { headers: buildHeaders(o, { Range: "bytes=0-63" }) });
  const buf = new Uint8Array(await r.arrayBuffer());
  const total = r.headers.get("content-range")?.split("/")[1] ?? r.headers.get("content-length");
  const kind = sniff(buf);
  console.log(`status    ${r.status}`);
  console.log(`type      ${r.headers.get("content-type")}`);
  console.log(`size      ${total ?? "?"}`);
  console.log(`magic     ${kind}`);
  const ok = (r.status === 200 || r.status === 206) && !/HTML|JSON|unknown/.test(kind);
  console.log(ok ? "✓ 媒体可直接拉取" : "✗ 拉取失败：试 --referer <详情页URL> / --cookie / 换原图 URL");
  if (!ok) Deno.exit(1);
} else {
  console.error("用法: probe.ts get|sel|json|media … （见文件头注释）");
  Deno.exit(2);
}
