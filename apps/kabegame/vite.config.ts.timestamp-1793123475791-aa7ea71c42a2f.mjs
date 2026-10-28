var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// ../../scripts/paths.ts
import path from "node:path";
import { fileURLToPath } from "node:url";
function repoBuildDir(repo, opts) {
  const platform = opts?.platform ?? BUILD_PLATFORM;
  const arch = opts?.arch ?? HOST_ARCH;
  return path.join(ROOT, "bin", platform, arch, `${repo}-build`);
}
var __vite_injected_original_import_meta_url, __filename, __dirname2, ROOT, THIRD_DIR, HOST_ARCH, BUILD_PLATFORM, CHROMIUM_DIR, TARGET_DIR;
var init_paths = __esm({
  "../../scripts/paths.ts"() {
    "use strict";
    __vite_injected_original_import_meta_url = "file:///D:/Codes/kabegame/scripts/paths.ts";
    __filename = fileURLToPath(__vite_injected_original_import_meta_url);
    __dirname2 = path.dirname(__filename);
    ROOT = path.resolve(__dirname2, "..");
    THIRD_DIR = path.join(ROOT, "third");
    HOST_ARCH = process.arch === "arm64" ? "arm64" : "x86_64";
    BUILD_PLATFORM = (() => {
      switch (process.platform) {
        case "darwin":
          return "macos";
        case "linux":
          return "linux";
        case "win32":
          return "windows";
        default:
          throw new Error(`\u4E0D\u652F\u6301\u7684\u6784\u5EFA\u5E73\u53F0: ${process.platform}`);
      }
    })();
    CHROMIUM_DIR = path.join(THIRD_DIR, "chromium");
    TARGET_DIR = (() => {
      const env = process.env.CARGO_TARGET_DIR;
      const dir = env ? path.isAbsolute(env) ? env : path.join(ROOT, env) : path.join(ROOT, "target");
      if (env) process.env.CARGO_TARGET_DIR = dir;
      return dir;
    })();
  }
});

// ../../scripts/utils.ts
import path2 from "path";
import os from "os";
import chalk from "file:///D:/Codes/kabegame/node_modules/chalk/source/index.js";
function getDevServerHost() {
  const override = process.env.TAURI_DEV_HOST ?? process.env.VITE_DEV_SERVER_HOST;
  if (override) return override;
  const ifaces = os.networkInterfaces();
  const all = [];
  for (const name of Object.keys(ifaces || {})) {
    for (const iface of ifaces[name]) {
      if (iface.family !== "IPv4" || iface.internal) continue;
      all.push(iface.address);
    }
  }
  const rfc1918 = all.find((ip) => {
    const [a, b] = ip.split(".").map(Number);
    return a === 10 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168;
  });
  return rfc1918 ?? all[0] ?? "localhost";
}
var CRAWLER_PLUGINS_DIR, RELEASE_DIR, RELEASE_PLUGINS_DIR, FFMPEG_BUILD_DIR, X264_BUILD_DIR, FFMPEG_INSTALL_DIR, DATA_PLUGINS_DIR, RESOURCES_DIR, RESOURCES_PLUGINS_DIR, RESOURCES_BIN_DIR, SRC_TAURI_DIR, TAURI_KABEGAME_DIR;
var init_utils = __esm({
  "../../scripts/utils.ts"() {
    "use strict";
    init_paths();
    init_paths();
    CRAWLER_PLUGINS_DIR = path2.join(ROOT, "src-crawler-plugins");
    RELEASE_DIR = path2.join(ROOT, ".kabegame", "release");
    RELEASE_PLUGINS_DIR = path2.join(RELEASE_DIR, "plugins");
    FFMPEG_BUILD_DIR = repoBuildDir("FFmpeg");
    X264_BUILD_DIR = repoBuildDir("x264");
    FFMPEG_INSTALL_DIR = path2.join(FFMPEG_BUILD_DIR, "install");
    DATA_PLUGINS_DIR = path2.join(
      ROOT,
      ".kabegame",
      "debug",
      "data",
      "plugins-directory"
    );
    RESOURCES_DIR = path2.join(
      ROOT,
      "src-tauri",
      "kabegame",
      "resources"
    );
    RESOURCES_PLUGINS_DIR = path2.join(RESOURCES_DIR, "plugins");
    RESOURCES_BIN_DIR = path2.join(RESOURCES_DIR, "bin");
    SRC_TAURI_DIR = path2.join(ROOT, "src-tauri");
    TAURI_KABEGAME_DIR = path2.join(SRC_TAURI_DIR, "kabegame");
  }
});

// ../../scripts/vite-debug-server.ts
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path3 from "node:path";
async function readCdpFile(debugDir) {
  try {
    const raw = await fs.readFile(path3.join(debugDir, CDP_PORT_FILE), "utf8");
    const parsed = JSON.parse(raw);
    const port = Number(parsed.port);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
    return {
      port,
      pid: Number.isInteger(Number(parsed.pid)) ? Number(parsed.pid) : null,
      registeredAt: typeof parsed.registeredAt === "string" ? parsed.registeredAt : ""
    };
  } catch {
    return null;
  }
}
async function writeCdpFile(debugDir, registration) {
  try {
    await fs.mkdir(debugDir, { recursive: true });
    await fs.writeFile(
      path3.join(debugDir, CDP_PORT_FILE),
      `${JSON.stringify(registration, null, 2)}
`,
      "utf8"
    );
  } catch (error) {
    console.warn(`[kabegame-cdp] \u65E0\u6CD5\u5199\u5165 ${CDP_PORT_FILE}: ${String(error)}`);
  }
}
function kabegameDebugServer(options) {
  const enabled = options.enabled ?? true;
  const allowRemote = options.allowRemote ?? process.env.KABEGAME_DEBUG_ALLOW_REMOTE === "true";
  const logToConsole = options.logToConsole ?? process.env.KABEGAME_DEBUG_TEE_CONSOLE === "true";
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const debugDir = path3.resolve(options.workspaceRoot, ".kabegame", "debug");
  let cdp = null;
  return {
    name: "kabegame-debug-server",
    apply: "serve",
    configureServer(server) {
      if (!enabled) return;
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url ?? "/", "http://kabegame.local");
        const isDebug = url.pathname === DEBUG_PREFIX || url.pathname.startsWith(`${DEBUG_PREFIX}/`);
        const isCdp = url.pathname === CDP_PREFIX || url.pathname.startsWith(`${CDP_PREFIX}/`);
        if (!isDebug && !isCdp) {
          next();
          return;
        }
        if (!allowRemote && !isLoopback(req.socket.remoteAddress)) {
          sendJson(res, 403, { ok: false, error: "remote debug ingest is disabled" });
          return;
        }
        try {
          if (isCdp) {
            if (req.method === "POST" && url.pathname === `${CDP_PREFIX}/register`) {
              const body = await readBody(req, maxBodyBytes);
              const parsed = JSON.parse(body || "{}");
              const port = Number(parsed.port);
              if (!Number.isInteger(port) || port <= 0 || port > 65535) {
                sendJson(res, 400, { ok: false, error: `invalid port: ${String(parsed.port)}` });
                return;
              }
              const pid = Number.isInteger(Number(parsed.pid)) ? Number(parsed.pid) : null;
              cdp = { port, pid, registeredAt: (/* @__PURE__ */ new Date()).toISOString() };
              await writeCdpFile(debugDir, cdp);
              console.log(`[kabegame-cdp] registered CDP port ${port}${pid ? ` (pid ${pid})` : ""}`);
              sendJson(res, 200, { ok: true, ...cdp });
              return;
            }
            if (req.method === "GET" && (url.pathname === CDP_PREFIX || url.pathname === `${CDP_PREFIX}/`)) {
              cdp ??= await readCdpFile(debugDir);
              if (!cdp) {
                sendJson(res, 404, { ok: false, error: "no CDP port registered" });
                return;
              }
              sendJson(res, 200, { ok: true, ...cdp });
              return;
            }
            sendJson(res, 404, { ok: false, error: "unknown cdp endpoint" });
            return;
          }
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
              decodeURIComponent(url.pathname.slice(`${DEBUG_PREFIX}/sessions/`.length))
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
              url.searchParams.get("session_id") ?? url.searchParams.get("sessionId") ?? getHeader(req, "x-kabegame-debug-session") ?? process.env.KABEGAME_DEBUG_SESSION_ID ?? "default"
            );
            const events = parseEvents(body.trim() ? body : url.searchParams.get("event") ?? "").map(
              (event) => normalizeEvent(event, requestSessionId)
            );
            await appendEvents(debugDir, events, logToConsole);
            res.statusCode = 204;
            res.end();
            return;
          }
          sendJson(res, 404, { ok: false, error: "unknown debug endpoint" });
        } catch (error) {
          sendJson(res, 500, {
            ok: false,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      });
    }
  };
}
function isLoopback(address) {
  if (!address) return true;
  if (address === "::1" || address === "localhost") return true;
  if (address.startsWith("127.")) return true;
  if (address.startsWith("::ffff:127.")) return true;
  return false;
}
function getHeader(req, name) {
  const value = req.headers[name];
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}
function sendJson(res, statusCode, data) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(data));
}
async function readBody(req, maxBytes) {
  const chunks = [];
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
function parseEvents(body) {
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
  return trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => JSON.parse(line));
}
function normalizeEvent(raw, fallbackSessionId) {
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const event = raw && typeof raw === "object" && !Array.isArray(raw) ? { ...raw } : { payload: raw };
  const sessionId = sanitizeSessionId(
    getString(event.session_id) ?? getString(event.sessionId) ?? fallbackSessionId
  );
  event.session_id = sessionId;
  delete event.sessionId;
  if (!event.ts) event.ts = now;
  if (!event.received_at) event.received_at = now;
  if (!event.source) event.source = "unknown";
  return event;
}
function getString(value) {
  return typeof value === "string" && value.trim() ? value : null;
}
function sanitizeSessionId(raw) {
  const value = (raw ?? "default").trim() || "default";
  const sanitized = value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 96);
  if (sanitized) return sanitized;
  return crypto.createHash("sha1").update(value).digest("hex").slice(0, 16);
}
async function appendEvents(debugDir, events, logToConsole) {
  await fs.mkdir(debugDir, { recursive: true });
  const bySession = /* @__PURE__ */ new Map();
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
    [...bySession.entries()].map(
      ([sessionId, lines]) => fs.appendFile(sessionFile(debugDir, sessionId), `${lines.join("\n")}
`, "utf8")
    )
  );
}
async function listSessions(debugDir) {
  let entries;
  try {
    entries = await fs.readdir(debugDir);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const sessions = await Promise.all(
    entries.filter((entry) => entry.startsWith("debug-") && entry.endsWith(".ndjson")).map(async (entry) => {
      const fullPath = path3.join(debugDir, entry);
      const stat = await fs.stat(fullPath);
      return {
        session_id: entry.slice("debug-".length, -".ndjson".length),
        file: fullPath,
        size: stat.size,
        updated_at: stat.mtime.toISOString()
      };
    })
  );
  return sessions.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}
async function readSessionTail(debugDir, sessionId, lineCount) {
  const file = sessionFile(debugDir, sessionId);
  let content;
  try {
    content = await fs.readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
  const lines = content.trimEnd().split(/\r?\n/);
  return `${lines.slice(-Math.max(1, Math.min(lineCount, 5e3))).join("\n")}
`;
}
function sessionFile(debugDir, sessionId) {
  return path3.join(debugDir, `debug-${sanitizeSessionId(sessionId)}.ndjson`);
}
var DEBUG_PREFIX, CDP_PREFIX, DEFAULT_MAX_BODY_BYTES, CDP_PORT_FILE;
var init_vite_debug_server = __esm({
  "../../scripts/vite-debug-server.ts"() {
    "use strict";
    DEBUG_PREFIX = "/__kabegame_debug";
    CDP_PREFIX = "/__kabegame_cdp";
    DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
    CDP_PORT_FILE = "cdp-port.json";
  }
});

// ../../vite.config.pub.ts
var vite_config_pub_exports = {};
__export(vite_config_pub_exports, {
  default: () => vite_config_pub_default,
  isAndroid: () => isAndroid,
  isDebugIngestEnabled: () => isDebugIngestEnabled,
  isLinux: () => isLinux,
  isMacOS: () => isMacOS,
  isWeb: () => isWeb,
  isWindows: () => isWindows,
  root: () => root
});
import vue from "file:///D:/Codes/kabegame/node_modules/@vitejs/plugin-vue/dist/index.mjs";
import vueJsx from "file:///D:/Codes/kabegame/node_modules/@vitejs/plugin-vue-jsx/dist/index.mjs";
import path4 from "path";
import UnoCSS from "file:///D:/Codes/kabegame/node_modules/unocss/dist/vite.mjs";
var __vite_injected_original_dirname, root, isWindows, isLinux, isMacOS, isAndroid, isWeb, isDebugIngestEnabled, vite_config_pub_default;
var init_vite_config_pub = __esm({
  "../../vite.config.pub.ts"() {
    "use strict";
    init_utils();
    init_vite_debug_server();
    __vite_injected_original_dirname = "D:\\Codes\\kabegame";
    root = __vite_injected_original_dirname;
    isWindows = process.platform === "win32";
    isLinux = process.platform === "linux";
    isMacOS = process.platform === "darwin";
    isAndroid = process.env.TAURI_PLATFORM === "android" || process.env.VITE_ANDROID === "true";
    isWeb = process.env.KABEGAME_MODE === "web";
    isDebugIngestEnabled = process.env.KABEGAME_DEBUG_INGEST !== "false";
    vite_config_pub_default = {
      plugins: [
        vue(),
        vueJsx(),
        UnoCSS(),
        kabegameDebugServer({
          workspaceRoot: root,
          enabled: isDebugIngestEnabled,
          allowRemote: isAndroid || isWeb
        })
      ],
      define: {
        __DEV__: process.env.NODE_ENV === "development",
        __WINDOWS__: !isAndroid && !isWeb && isWindows,
        __LINUX__: !isAndroid && !isWeb && isLinux,
        __MACOS__: !isAndroid && !isWeb && isMacOS,
        __ANDROID__: isAndroid,
        __WEB__: isWeb,
        __LIGHT_MODE__: isAndroid,
        // 切换此开关来强制重启vite服务器
        __REBOOT__: true
      },
      // 使用 apps/kabegame/public 作为 public 目录（main app 专用）
      // 根目录 static 的共享资源通过插件复制（见下方插件）
      publicDir: path4.resolve(root, "static"),
      clearScreen: false,
      server: {
        port: 1420,
        strictPort: true,
        // 桌面端仅监听 localhost；Android 真机或 web 模式需监听所有网卡以便设备连接
        host: isAndroid || isWeb,
        // web：origin 指向开发机 IP，使浏览器设备正确解析 script/source map 等请求。
        // Android 真机/模拟器：devUrl = http://localhost:1420，fork 的 cargo-tauri 不再把
        // 真机 devUrl 改写成局域网 IP（patch 5），stock android-studio-script 的 localhost
        // 分支自动 `adb reverse tcp:1420 tcp:1420`——页面 HTTP 经 USB 回环直达开发机。
        // 但 tauri v2 移动端 dev 构建有 PROXY_DEV_SERVER（third/tauri
        // crates/tauri/src/manager/webview.rs），页面实际由 http://tauri.localhost 自定义协议
        // 代理加载，该代理只转发 HTTP、不转发 WebSocket upgrade，location 派生的
        // ws://tauri.localhost 必然失败。故按官方模板显式指定 HMR 直连地址（优先
        // TAURI_DEV_HOST——CLI 公网 IP 模式下注入；否则 localhost 走 adb reverse）：
        // 全双工，且不经设备侧代理（Clash 等会破坏 LAN 的 WS Upgrade）。
        ...isWeb ? { origin: `http://${getDevServerHost()}:1420` } : {},
        ...isAndroid ? {
          hmr: {
            protocol: "ws",
            host: process.env.TAURI_DEV_HOST || "localhost",
            port: 1420
          }
        } : {},
        watch: {
          ignored: [
            "**/src-tauri/**",
            "**/third/**",
            "**/src-crawler-plugins/**",
            "**/target/**",
            "**/node_modules/**",
            "**/bin/**"
          ]
        }
      },
      resolve: {
        alias: {
          "@": path4.resolve(process.cwd(), "src"),
          // vendored element-plus：单包平铺（deno 不认嵌套子 workspace），源码直接消费，
          // alias 指向 src/，无构建产物。
          "@kabegame/element-plus-icons": path4.resolve(
            root,
            "packages",
            "kabegame-element-plus-icons",
            "src"
          ),
          "@kabegame/element-plus": path4.resolve(
            root,
            "packages",
            "kabegame-element-plus",
            "src"
          ),
          // pathql 生成客户端:index.ts 为生成物不入库(外壳 package.json 入库,包为
          // workspace 成员),由 `deno task pathql:generate` 生成;缺文件时前端构建/
          // 类型检查会明确报错,先跑 generate。
          "@kabegame/pathql-client": path4.resolve(
            root,
            "packages",
            "kabegame-pathql-client",
            "index.ts"
          )
        }
      },
      css: {
        preprocessorOptions: {
          scss: {
            api: "modern-compiler"
          }
        }
      },
      envPrefix: ["VITE_", "TAURI_"],
      optimizeDeps: {
        entries: [path4.resolve(process.cwd(), "index.html")],
        // 不预构建本地 photoswipe-vue，始终从源码编译，改包内代码立即生效
        exclude: ["photoswipe", "photoswipe/lightbox"]
      },
      build: {
        outDir: path4.resolve(root, `dist-${process.env.KABEGAME_COMPONENT}`),
        emptyOutDir: true,
        reportCompressedSize: false,
        target: ["es2021", "chrome100", "safari13"],
        minify: !process.env.TAURI_DEBUG ? "esbuild" : false,
        sourcemap: !!process.env.TAURI_DEBUG,
        chunkSizeWarningLimit: 1e7,
        rollupOptions: {
          input: {
            index: path4.resolve(process.cwd(), "index.html")
          },
          output: {
            inlineDynamicImports: true,
            manualChunks: void 0
          }
        }
      }
    };
  }
});

// vite.config.ts
import { defineConfig } from "file:///D:/Codes/kabegame/node_modules/vite/dist/node/index.js";
import path5 from "path";
import { merge } from "file:///D:/Codes/kabegame/node_modules/lodash-es/lodash.js";
var webDevApiTarget = "http://127.0.0.1:7490";
var webDevApiProxyPaths = [
  "/rpc",
  "/events",
  "/api",
  "/file",
  "/thumbnail",
  "/plugin_file",
  "/proxy",
  "/mcp",
  "/__ping"
];
function ensureWebEnv(mode) {
  if (mode !== "web") return;
  process.env.KABEGAME_MODE ??= "web";
  process.env.VITE_KABEGAME_MODE ??= "web";
}
var vite_config_default = defineConfig(async ({ mode }) => {
  ensureWebEnv(mode);
  const { default: pubConfig, root: root2 } = await Promise.resolve().then(() => (init_vite_config_pub(), vite_config_pub_exports));
  const isWeb2 = process.env.KABEGAME_MODE === "web" || mode === "web";
  const hasSurfNavbar = !isWeb2;
  const rollupInput = {
    ...hasSurfNavbar && { "surf-navbar": "./surf-navbar.html" }
  };
  const webDevApiProxy = isWeb2 ? Object.fromEntries(
    webDevApiProxyPaths.map((p) => [
      p,
      {
        target: webDevApiTarget,
        changeOrigin: true,
        ws: false
      }
    ])
  ) : void 0;
  return merge(pubConfig, {
    server: {
      allowedHosts: true,
      port: 1420,
      ...webDevApiProxy && { proxy: webDevApiProxy }
    },
    build: {
      // 桌面/Android 与 web 的产物目录必须分开：两者的平台 define（__WEB__ /
      // __MACOS__ 等）、rollup input（surf-navbar）、chunking 策略完全
      // 不同，共用一个目录时后跑的构建会静默覆盖前者。build-web.ts 是「宿主出
      // 前端 → 容器编 Rust 嵌入」两段式，中间若插入一次桌面构建，web 二进制就
      // 会嵌到桌面 bundle（invoke 走 __TAURI_INTERNALS__，浏览器里全挂）。
      outDir: path5.resolve(root2, isWeb2 ? "dist-kabegame-web" : "dist-kabegame"),
      assetsInlineLimit: (filePath) => {
        if (filePath.includes("icon-small.png")) {
          return true;
        }
        return false;
      },
      rollupOptions: {
        input: rollupInput,
        output: {
          inlineDynamicImports: !hasSurfNavbar && !isWeb2,
          ...isWeb2 && {
            manualChunks(id) {
              if (id.includes("packages/kabegame-element-plus-icons")) return "vendor-ep-icons";
              if (id.includes("packages/kabegame-element-plus")) return "vendor-element-plus";
              if (!id.includes("node_modules")) return void 0;
              if (id.includes("vant")) return "vendor-vant";
              if (id.includes("pinia") || id.includes("vue-router")) return "vendor-vue-router";
              if (id.includes("@vue") || id.includes("/vue/")) return "vendor-vue";
              if (id.includes("photoswipe")) return "vendor-photoswipe";
              return "vendor";
            }
          }
        }
      }
    },
    publicDir: "./public"
  });
});
export {
  vite_config_default as default
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vc2NyaXB0cy9wYXRocy50cyIsICIuLi8uLi9zY3JpcHRzL3V0aWxzLnRzIiwgIi4uLy4uL3NjcmlwdHMvdml0ZS1kZWJ1Zy1zZXJ2ZXIudHMiLCAiLi4vLi4vdml0ZS5jb25maWcucHViLnRzIiwgInZpdGUuY29uZmlnLnRzIl0sCiAgInNvdXJjZVJvb3QiOiAiRDpcXENvZGVzXFxrYWJlZ2FtZVxcYXBwc1xca2FiZWdhbWVcXCIsCiAgInNvdXJjZXNDb250ZW50IjogWyJjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfZGlybmFtZSA9IFwiRDpcXFxcQ29kZXNcXFxca2FiZWdhbWVcXFxcc2NyaXB0c1wiO2NvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9maWxlbmFtZSA9IFwiRDpcXFxcQ29kZXNcXFxca2FiZWdhbWVcXFxcc2NyaXB0c1xcXFxwYXRocy50c1wiO2NvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9pbXBvcnRfbWV0YV91cmwgPSBcImZpbGU6Ly8vRDovQ29kZXMva2FiZWdhbWUvc2NyaXB0cy9wYXRocy50c1wiOy8qKlxuICogXHU2Nzg0XHU1RUZBXHU4REVGXHU1Rjg0XHUzMDAxXHU1RTczXHU1M0YwXHU0RTBFXHU1QkJGXHU0RTNCXHU2N0I2XHU2Nzg0XHU4OUUzXHU2NzkwXHUzMDAyXG4gKlxuICogXHU2NzJDXHU2NTg3XHU0RUY2XHU1M0VBXHU0RjlEXHU4RDU2IE5vZGUgXHU1MTg1XHU1RUZBXHU2QTIxXHU1NzU3XHVGRjBDXHU3ODZFXHU0RkREXHU2Q0ExXHU2NzA5IG5vZGVfbW9kdWxlcyBcdTc2ODRcdTY3ODRcdTVFRkFcdTk2MzZcdTZCQjVcdTRFNUZcdTgwRkRcdTc2RjRcdTYzQTVcdTVGMTVcdTc1MjhcdTMwMDJcbiAqL1xuXG5pbXBvcnQgZnMgZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCBwYXRoIGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IGZpbGVVUkxUb1BhdGggfSBmcm9tIFwibm9kZTp1cmxcIjtcblxuY29uc3QgX19maWxlbmFtZSA9IGZpbGVVUkxUb1BhdGgoaW1wb3J0Lm1ldGEudXJsKTtcbmNvbnN0IF9fZGlybmFtZSA9IHBhdGguZGlybmFtZShfX2ZpbGVuYW1lKTtcblxuZXhwb3J0IGNvbnN0IFJPT1QgPSBwYXRoLnJlc29sdmUoX19kaXJuYW1lLCBcIi4uXCIpO1xuZXhwb3J0IGNvbnN0IFRISVJEX0RJUiA9IHBhdGguam9pbihST09ULCBcInRoaXJkXCIpO1xuXG4vKiogXHU1QkJGXHU0RTNCXHU2N0I2XHU2Nzg0XHVGRjBDXHU3NTI4XHU0RThFXHU3QjJDXHU0RTA5XHU2NUI5XHU2Nzg0XHU1RUZBXHU0RUE3XHU3MjY5XHU3Njg0XHU3NkVFXHU1RjU1XHU1NDdEXHU1NDBEXHUzMDAyICovXG5leHBvcnQgdHlwZSBCdWlsZEFyY2ggPSBcIng4Nl82NFwiIHwgXCJhcm02NFwiO1xuXG5leHBvcnQgY29uc3QgSE9TVF9BUkNIOiBCdWlsZEFyY2ggPSBwcm9jZXNzLmFyY2ggPT09IFwiYXJtNjRcIlxuICA/IFwiYXJtNjRcIlxuICA6IFwieDg2XzY0XCI7XG5cbi8qKiBwcm9jZXNzLnBsYXRmb3JtIFx1MjE5MiBcdTc2RUVcdTVGNTVcdTU0N0RcdTU0MEQgdG9rZW5cdTMwMDIgKi9cbmV4cG9ydCBjb25zdCBCVUlMRF9QTEFURk9STTogc3RyaW5nID0gKCgpID0+IHtcbiAgc3dpdGNoIChwcm9jZXNzLnBsYXRmb3JtKSB7XG4gICAgY2FzZSBcImRhcndpblwiOlxuICAgICAgcmV0dXJuIFwibWFjb3NcIjtcbiAgICBjYXNlIFwibGludXhcIjpcbiAgICAgIHJldHVybiBcImxpbnV4XCI7XG4gICAgY2FzZSBcIndpbjMyXCI6XG4gICAgICByZXR1cm4gXCJ3aW5kb3dzXCI7XG4gICAgZGVmYXVsdDpcbiAgICAgIHRocm93IG5ldyBFcnJvcihgXHU0RTBEXHU2NTJGXHU2MzAxXHU3Njg0XHU2Nzg0XHU1RUZBXHU1RTczXHU1M0YwOiAke3Byb2Nlc3MucGxhdGZvcm19YCk7XG4gIH1cbn0pKCk7XG5cbi8qKlxuICogXHU3QjJDXHU0RTA5XHU2NUI5XHU0RUQzXHU1RTkzXHU3RjE2XHU4QkQxXHU0RUE3XHU3MjY5XHU3NkVFXHU1RjU1XHVGRjA4XHU1NTJGXHU0RTAwXHU1NDdEXHU1NDBEXHU1MTZDXHU1RjBGXHVGRjA5XHVGRjFBYmluL3twbGF0Zm9ybX0ve2FyY2h9L3tyZXBvfS1idWlsZFxuICogXHU0RTBEXHU0RjIwIHBsYXRmb3JtL2FyY2ggXHU2NUY2XHU1M0Q2XHU1RjUzXHU1MjREXHU1QkJGXHU0RTNCXHU2N0I2XHU2Nzg0XHUzMDAyXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZXBvQnVpbGREaXIoXG4gIHJlcG86IHN0cmluZyxcbiAgb3B0cz86IHsgcGxhdGZvcm0/OiBzdHJpbmc7IGFyY2g/OiBCdWlsZEFyY2ggfSxcbik6IHN0cmluZyB7XG4gIGNvbnN0IHBsYXRmb3JtID0gb3B0cz8ucGxhdGZvcm0gPz8gQlVJTERfUExBVEZPUk07XG4gIGNvbnN0IGFyY2ggPSBvcHRzPy5hcmNoID8/IEhPU1RfQVJDSDtcbiAgcmV0dXJuIHBhdGguam9pbihST09ULCBcImJpblwiLCBwbGF0Zm9ybSwgYXJjaCwgYCR7cmVwb30tYnVpbGRgKTtcbn1cblxuLyoqXG4gKiBgYmluL3twbGF0Zm9ybX0vYCBcdTRFMEJcdTc2ODRcdTY3QjZcdTY3ODRcdTVCNTBcdTc2RUVcdTVGNTVcdTU0MERcdTMwMDJcbiAqXG4gKiBcdThGRDlcdTRFMDBcdTVDNDJcdTg4QzVcdTc2ODRcdTY2MkZcdTdCMkNcdTRFMDlcdTY1QjlcdTRFRDNcdTVFOTNcdTc2ODRcdTdGMTZcdThCRDFcdTRFQTdcdTcyNjlcdUZGMDhge3JlcG99LWJ1aWxkYFx1RkYwOVx1RkYwQyoqXHU0RTBEXHU2NjJGKipcdThGRDBcdTg4NENcdTY1RjZcdTY2ODJcdTVCNThcdTUxODVcdTVCQjlcdUZGMUFcbiAqIG9zLXBsdWdpbiBcdTZFMDVcdTdBN0FcdTVFNzNcdTUzRjBcdTY2ODJcdTVCNThcdTc2RUVcdTVGNTVcdTY1RjZcdTg5ODFcdThERjNcdThGQzdcdTVCODNcdTRFRUNcdUZGMENjb21wb25lbnQtcGx1Z2luIFx1OTAxMlx1NUY1Mlx1NjUzNlx1OTZDNiBkZWIgZmlsZXNcbiAqIFx1NjVGNlx1NEU1Rlx1NUZDNVx1OTg3Qlx1NjM5Mlx1OTY2NFx1MjAxNFx1MjAxNFx1NTQyNlx1NTIxOVx1NjU3MCBHQiBcdTc2ODRcdTY3ODRcdTVFRkFcdTY4MTFcdTRGMUFcdTg4QUJcdTYyNTNcdThGREJcdTVCODlcdTg4QzVcdTUzMDVcdTMwMDJcbiAqL1xuZXhwb3J0IGNvbnN0IEFSQ0hfRElSX05BTUVTOiByZWFkb25seSBzdHJpbmdbXSA9IFtcImFybTY0XCIsIFwieDg2XzY0XCJdO1xuXG4vKiogXHU2NjJGXHU1NDI2XHU0RTNBIGBiaW4ve3BsYXRmb3JtfS9gIFx1NEUwQlx1NzY4NFx1NjdCNlx1Njc4NFx1NUI1MFx1NzZFRVx1NUY1NVx1RkYwOFx1N0IyQ1x1NEUwOVx1NjVCOVx1N0YxNlx1OEJEMVx1NEVBN1x1NzI2OVx1NjI0MFx1NTcyOFx1NUM0Mlx1RkYwOVx1MzAwMiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGlzQXJjaERpck5hbWUobmFtZTogc3RyaW5nKTogYm9vbGVhbiB7XG4gIHJldHVybiBBUkNIX0RJUl9OQU1FUy5pbmNsdWRlcyhuYW1lKTtcbn1cblxuLyoqIGNocm9taXVtIGNoZWNrb3V0IFx1NURFNVx1NEY1Q1x1NTMzQVx1RkYwOGJ1aWxkLWNocm9taXVtIFx1NzY4NFx1Njc4NFx1NUVGQVx1NjgzOVx1RkYwQ1x1NTM5Rlx1NEVEM1x1NUU5M1x1NTkxNiBjZWZidWlsZFx1RkYwOVx1MzAwMiAqL1xuZXhwb3J0IGNvbnN0IENIUk9NSVVNX0RJUjogc3RyaW5nID0gcGF0aC5qb2luKFRISVJEX0RJUiwgXCJjaHJvbWl1bVwiKTtcblxuLyoqXG4gKiBcdTY3ODRcdTVFRkFcdTVDNUVcdTU3MzBcdTVCODhcdTUzNkJcdUZGMUFcdTY3RDBcdTRFOUJcdTY3ODRcdTVFRkFcdTUzRUFcdTUxNDFcdThCQjhcdTU3MjggVWJ1bnR1IDIyLjA0IGd1ZXN0IFx1NTE4NVx1NjI2N1x1ODg0Q1x1RkYwOGdsaWJjIDIuMzUgXHU1NzMwXHU2NzdGXHVGRjA5XHUzMDAyXG4gKiBcdTk3NUUgTGludXggXHU3NkY0XHU2M0E1XHU2NTNFXHU4ODRDXHVGRjFCTGludXggXHU0RTBBXHU4QkZCIC9ldGMvb3MtcmVsZWFzZSBcdTUyMjRcdTVCOUFcdUZGMENcdTRFMERcdTZFRTFcdThEQjNcdTUyMTlcdTYyOUJcdTk1MTlcdTMwMDJcbiAqIFx1OTAwM1x1NzUxRlx1OTYwMFx1RkYxQVx1NzNBRlx1NTg4M1x1NTNEOFx1OTFDRiBLQl9BTExPV19IT1NUX0JVSUxEPTFcdTMwMDJcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlcXVpcmVVYnVudHUyMjA0KHdoYXQ6IHN0cmluZyk6IHZvaWQge1xuICBpZiAocHJvY2Vzcy5wbGF0Zm9ybSAhPT0gXCJsaW51eFwiIHx8IHByb2Nlc3MuZW52LktCX0FMTE9XX0hPU1RfQlVJTEQgPT09IFwiMVwiKSB7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgbGV0IHJlbGVhc2UgPSBcIlwiO1xuICB0cnkge1xuICAgIHJlbGVhc2UgPSBmcy5yZWFkRmlsZVN5bmMoXCIvZXRjL29zLXJlbGVhc2VcIiwgXCJ1dGY4XCIpO1xuICB9IGNhdGNoIHtcbiAgICAvLyBcdTdFREZcdTRFMDBcdThENzBcdTRFMEJcdTY1QjlcdTc2ODRcdTY3ODRcdTVFRkFcdTVDNUVcdTU3MzBcdTk1MTlcdThCRUZcdUZGMENcdTkwN0ZcdTUxNERcdTVCQkZcdTRFM0JcdTczQUZcdTU4ODNcdTdFQzZcdTgyODJcdTYzQTlcdTc2RDYgZ2xpYmMgXHU5OENFXHU5NjY5XHUzMDAyXG4gIH1cbiAgY29uc3QgZmllbGRzID0gbmV3IE1hcDxzdHJpbmcsIHN0cmluZz4oKTtcbiAgZm9yIChjb25zdCBsaW5lIG9mIHJlbGVhc2Uuc3BsaXQoXCJcXG5cIikpIHtcbiAgICBjb25zdCBtYXRjaCA9IC9eKFtBLVpfXSspPSguKikkLy5leGVjKGxpbmUpO1xuICAgIGlmICghbWF0Y2gpIGNvbnRpbnVlO1xuICAgIGZpZWxkcy5zZXQobWF0Y2hbMV0sIG1hdGNoWzJdLnJlcGxhY2UoL14oW1wiJ10pKC4qKVxcMSQvLCBcIiQyXCIpKTtcbiAgfVxuICBpZiAoZmllbGRzLmdldChcIklEXCIpID09PSBcInVidW50dVwiICYmIGZpZWxkcy5nZXQoXCJWRVJTSU9OX0lEXCIpID09PSBcIjIyLjA0XCIpIHtcbiAgICByZXR1cm47XG4gIH1cblxuICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgYCR7d2hhdH0gXHU1M0VBXHU1MTQxXHU4QkI4XHU1NzI4IFVidW50dSAyMi4wNCBndWVzdCBcdTUxODVcdTYyNjdcdTg4NENcdUZGMDhcdTVCOENcdTY1NzRcdTYzMDJcdThGN0RcdTU0MENcdThERUZcdTVGODRcdTRFRDNcdTVFOTNcdUZGMDlcdUZGMENgICtcbiAgICAgIFwiXHU1NDI2XHU1MjE5XHU0RUE3XHU3MjY5XHU0RjFBXHU1RTI2XHU0RTBBXHU1QkJGXHU0RTNCXHU3Njg0XHU5QUQ4XHU3MjQ4XHU2NzJDIGdsaWJjIFx1N0IyNlx1NTNGN1x1RkYxQlx1Nzg2RVx1OTcwMFx1NTcyOFx1NUJCRlx1NEUzQlx1OEREMVx1OEJGN1x1OEJCRSBLQl9BTExPV19IT1NUX0JVSUxEPTFcdTMwMDJcIixcbiAgKTtcbn1cblxuLyoqXG4gKiBDYXJnbyBcdTRFQTdcdTcyNjlcdTc2RUVcdTVGNTUoXHU1MzU1XHU0RTAwXHU2NzY1XHU2RTkwKVx1MzAwMlx1OUVEOFx1OEJBNCBgPHdvcmtzcGFjZT4vdGFyZ2V0YCxcdTVERTVcdTRGNUNcdTUzM0FcdTY4MzlcdTUzNzMgUk9PVFx1MzAwMlxuICogXHU4MkU1XHU4QkJFXHU0RTg2IGBDQVJHT19UQVJHRVRfRElSYChcdTU5ODIgYENBUkdPX1RBUkdFVF9ESVI9dGFyZ2V0LTIyYCxcdTc1MjhcdTRFOEVcdTU3MjggVWJ1bnR1IDIyLjA0XG4gKiBcdTk2OTRcdTc5QkJcdTczQUZcdTU4ODNcdTUwNUFcdTRGNEUgZ2xpYmMgXHU1NzMwXHU2NzdGXHU3Njg0IGNsZWFuIGJ1aWxkKSxcdTUyMTlcdTRFRTVcdTVCODNcdTRFM0FcdTUxQzY6XG4gKiAgLSBcdTc2RjhcdTVCRjlcdTUwM0NcdTYzMDkgUk9PVCBcdTg5RTNcdTY3OTAoXHU4MDBDXHU5NzVFXHU1NDA0XHU4MUVBIGN3ZCksXHU5MDdGXHU1MTREXHU3NkY4XHU1QkY5IGBDQVJHT19UQVJHRVRfRElSYCBcdTU3MjhcdTRFMERcdTU0MEMgY3dkIFx1NEUwQlx1NkI2N1x1NEU0OVxuICogICAgKFx1NEUzQlx1Njc4NFx1NUVGQSBzcGF3biBjYXJnbyBcdTY1RjYgY3dkPXNyYy10YXVyaSx0YXVyaS1jbGkvXHU1MTc2XHU1QjgzIGN3ZD1ST09UKTtcbiAqICAtIFx1NUY1Mlx1NEUwMFx1NTMxNlx1NjIxMFx1N0VERFx1NUJGOVx1OERFRlx1NUY4NFx1NTQwRSoqXHU1NkRFXHU1MTk5KiogYHByb2Nlc3MuZW52LkNBUkdPX1RBUkdFVF9ESVJgLFx1NEZERFx1OEJDMVx1NjI0MFx1NjcwOVx1NEVFNSBgZW52OiBwcm9jZXNzLmVudmBcbiAqICAgIFx1NkQzRVx1NzUxRlx1NzY4NCBjYXJnby90YXVyaSBcdTg0M0RcdTcwQjlcdTRFMEVcdTY3MkNcdTUzRDhcdTkxQ0ZcdTRFMDBcdTgxRjRcdTMwMDJcbiAqIFx1Njc4NFx1NUVGQVx1N0NGQlx1N0VERlx1NEUwMFx1NTIwN1x1MzAwQ1x1NjI3RS9cdTY0MkNcdTRFQTdcdTcyNjlcdTMwMERcdTc2ODRcdThERUZcdTVGODRcdTkwRkRcdTVFOTRcdTRFQ0VcdThGRDlcdTkxQ0NcdTUzRDYsXHU0RTBEXHU4OTgxXHU1MThEXHU3ODZDXHU3RjE2XHU3ODAxIGBwYXRoLmpvaW4oUk9PVCwgXCJ0YXJnZXRcIilgXHUzMDAyXG4gKi9cbmV4cG9ydCBjb25zdCBUQVJHRVRfRElSID0gKCgpID0+IHtcbiAgY29uc3QgZW52ID0gcHJvY2Vzcy5lbnYuQ0FSR09fVEFSR0VUX0RJUjtcbiAgY29uc3QgZGlyID0gZW52XG4gICAgPyBwYXRoLmlzQWJzb2x1dGUoZW52KSA/IGVudiA6IHBhdGguam9pbihST09ULCBlbnYpXG4gICAgOiBwYXRoLmpvaW4oUk9PVCwgXCJ0YXJnZXRcIik7XG4gIGlmIChlbnYpIHByb2Nlc3MuZW52LkNBUkdPX1RBUkdFVF9ESVIgPSBkaXI7IC8vIFx1NUY1Mlx1NEUwMFx1NTMxNlx1NTZERVx1NTE5OSxcdTdFREZcdTRFMDBcdTYyNDBcdTY3MDkgY2FyZ28gXHU2RDNFXHU3NTFGXHU4RkRCXHU3QTBCXG4gIHJldHVybiBkaXI7XG59KSgpO1xuXG4vKiogXHU2NzJDXHU2QjIxXHU1MzlGXHU3NTFGXHU2Nzg0XHU1RUZBXHU3Njg0XHU0RUE3XHU3MjY5XHU3NkVFXHU1RjU1XHUzMDAyICovXG5leHBvcnQgY29uc3QgQVJUSUZBQ1RfRElSID0gVEFSR0VUX0RJUjtcbiIsICJjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfZGlybmFtZSA9IFwiRDpcXFxcQ29kZXNcXFxca2FiZWdhbWVcXFxcc2NyaXB0c1wiO2NvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9maWxlbmFtZSA9IFwiRDpcXFxcQ29kZXNcXFxca2FiZWdhbWVcXFxcc2NyaXB0c1xcXFx1dGlscy50c1wiO2NvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9pbXBvcnRfbWV0YV91cmwgPSBcImZpbGU6Ly8vRDovQ29kZXMva2FiZWdhbWUvc2NyaXB0cy91dGlscy50c1wiOy8qKlxuICogXHU1REU1XHU1MTc3XHU1MUZEXHU2NTcwXG4gKi9cblxuaW1wb3J0IHsgc3Bhd24sIHNwYXduU3luYyB9IGZyb20gXCJjaGlsZF9wcm9jZXNzXCI7XG5pbXBvcnQgcGF0aCBmcm9tIFwicGF0aFwiO1xuaW1wb3J0IG9zIGZyb20gXCJvc1wiO1xuaW1wb3J0IGZzIGZyb20gXCJmc1wiO1xuaW1wb3J0IGNoYWxrIGZyb20gXCJjaGFsa1wiO1xuaW1wb3J0IHsgQVJUSUZBQ1RfRElSLCByZXBvQnVpbGREaXIsIFJPT1QgfSBmcm9tIFwiLi9wYXRocy50c1wiO1xuZXhwb3J0ICogZnJvbSBcIi4vcGF0aHMudHNcIjtcbi8vIFx1NkNFOFx1NjEwRjpcdTY3MkNcdTY1ODdcdTRFRjZcdTRFMERcdTUzRUYgaW1wb3J0IE9TUGx1Z2luLFx1NTQyNlx1NTIxOVx1NEUwRSBvcy1wbHVnaW4udHMgXHU1RjYyXHU2MjEwXHU1RkFBXHU3M0FGXHU0RjlEXHU4RDU2XG4vLyAob3MtcGx1Z2luLnRzIFx1NTcyOCB0b3AtbGV2ZWwgXHU4QkZCXHU1M0Q2IFJPT1QgXHU3QjQ5XHU2NzJDXHU2NTg3XHU0RUY2XHU1QkZDXHU1MUZBKVx1MzAwMlxuLy8gXHU3NTI4IHByb2Nlc3MucGxhdGZvcm0gXHU3NkY0XHU2M0E1XHU1MjI0XHU2NUFEXHU1MzczXHU1M0VGXHUzMDAyXG5cbmV4cG9ydCBjb25zdCBDUkFXTEVSX1BMVUdJTlNfRElSID0gcGF0aC5qb2luKFJPT1QsIFwic3JjLWNyYXdsZXItcGx1Z2luc1wiKTtcblxuLyoqXG4gKiBcdTUzRDFcdTVFMDNcdTRFQTdcdTcyNjlcdTZDNDdcdTk2QzZcdTc2RUVcdTVGNTVcdUZGMDhnaXRpZ25vcmVkXHVGRjBDYC5rYWJlZ2FtZS9gIFx1NEUwQlx1NEUwRSBkZWJ1Zy8gXHU3QjQ5XHU4RkQwXHU4ODRDXHU2NzFGXHU3NkVFXHU1RjU1XHU1NDBDXHU3RUE3XHVGRjA5XHUzMDAyXG4gKlxuICogXHU1MzU1XHU0RTAwXHU2NzY1XHU2RTkwXHVGRjFBYGRlbm8gdGFzayBiIC0tcmVsZWFzZWAgXHU3Njg0XHU2ODRDXHU5NzYyXHU1Qjg5XHU4OEM1XHU1MzA1L0NMSVx1RkYwOFJlbGVhc2VQbHVnaW5cdUZGMDlcdTMwMDF3ZWIgXHU0RThDXHU4RkRCXHU1MjM2XG4gKiBcdUZGMDhkb2NrZXItY29tcG9zZS53ZWItcmVsZWFzZS55bWwgXHU3Njg0IC9kaXN0IFx1NjMwMlx1OEY3RFx1RkYwOVx1MzAwMVx1NEVFNVx1NTNDQSB3ZWIgXHU2QTIxXHU1RjBGXHU3Njg0XHU3MjJDXHU4NjZCXHU2M0QyXHU0RUY2XG4gKiBcdUZGMDhSRUxFQVNFX1BMVUdJTlNfRElSXHVGRjA5XHU3RURGXHU0RTAwXHU4NDNEXHU1NzI4XHU4RkQ5XHU5MUNDXHVGRjBDXHU0RjlCIHNjcmlwdHMvZGVwbG95LXdlYi5zaCBcdTRFMEUgQ0kgXHU0RTBBXHU0RjIwXHUzMDAyXG4gKiBcdTUyNERcdTdBRUZcdTRFQTdcdTcyNjlcdTRFMERcdTU3MjhcdTZCNjRcdTUyMTdcdTIwMTRcdTIwMTRcdTRFQ0RcdTY2MkZcdTRFRDNcdTVFOTNcdTY4MzlcdTc2ODQgZGlzdC1rYWJlZ2FtZS13ZWIvXHVGRjA4XHU3RjE2XHU4QkQxXHU2NzFGXHU3NTMxIGluY2x1ZGVfZGlyISBcdTVENENcdTUxNjVcdUZGMUJcbiAqIFx1Njg0Q1x1OTc2Mi9BbmRyb2lkIFx1NzY4NFx1NTI0RFx1N0FFRlx1NTIxOVx1NTFGQVx1NTIzMCBkaXN0LWthYmVnYW1lL1x1RkYwQ1x1NEUyNFx1ODAwNVx1NEUyNVx1NjgzQ1x1NTIwNlx1NUYwMFx1NEU5Mlx1NEUwRFx1ODk4Nlx1NzZENlx1RkYwOVx1MzAwMlxuICovXG5leHBvcnQgY29uc3QgUkVMRUFTRV9ESVIgPSBwYXRoLmpvaW4oUk9PVCwgXCIua2FiZWdhbWVcIiwgXCJyZWxlYXNlXCIpO1xuXG4vKipcbiAqIHdlYiBcdTUzRDFcdTVFMDNcdTc1MjhcdTc2ODRcdTcyMkNcdTg2NkJcdTYzRDJcdTRFRjZcdTc2RUVcdTVGNTVcdUZGMUFgLmthYmVnYW1lL3JlbGVhc2UvcGx1Z2luc2BcdTMwMDJcbiAqXG4gKiBcdTY4NENcdTk3NjJcdTY3ODRcdTVFRkFcdTc2ODRcdTYzRDJcdTRFRjZcdTRFQ0RcdTUxOTkgYHNyYy10YXVyaS9rYWJlZ2FtZS9yZXNvdXJjZXMvcGx1Z2luc2BcdUZGMDhcdTg5ODFcdTk2OEYgdGF1cmlcbiAqIGJ1bmRsZS5yZXNvdXJjZXMgXHU2MjUzXHU4RkRCXHU1Qjg5XHU4OEM1XHU1MzA1XHVGRjA5XHVGRjFCd2ViIFx1NEU4Q1x1OEZEQlx1NTIzNlx1NEUwRFx1NUQ0Q1x1NTE2NVx1NjNEMlx1NEVGNlx1RkYwQ1x1NjcwRFx1NTJBMVx1NTY2OFx1NjUzOVx1NzUzMVx1NzUyOFx1NjIzN1x1NjU3MFx1NjM2RVx1NzZFRVx1NUY1NVxuICogYH4vLmxvY2FsL3NoYXJlL0thYmVnYW1lL3BsdWdpbnMtZGlyZWN0b3J5L2AgXHU1MkEwXHU4RjdEXHVGRjBDXHU2NTQ1XHU1MzU1XHU3MkVDXHU0RUE3XHU1MUZBXHU1MjMwXHU4RkQ5XHU5MUNDXHU1MThEXHU0RTBBXHU0RjIwXHUzMDAyXG4gKi9cbmV4cG9ydCBjb25zdCBSRUxFQVNFX1BMVUdJTlNfRElSID0gcGF0aC5qb2luKFJFTEVBU0VfRElSLCBcInBsdWdpbnNcIik7XG5cbmV4cG9ydCBjb25zdCBGRk1QRUdfQlVJTERfRElSID0gcmVwb0J1aWxkRGlyKFwiRkZtcGVnXCIpO1xuZXhwb3J0IGNvbnN0IFgyNjRfQlVJTERfRElSID0gcmVwb0J1aWxkRGlyKFwieDI2NFwiKTtcblxuLyoqXG4gKiBcdTY4NENcdTk3NjIgRkZtcGVnIFx1NUI4OVx1ODhDNVx1NTI0RFx1N0YwMFx1RkYxQWJpbi97cGxhdGZvcm19L3thcmNofS9GRm1wZWctYnVpbGQvaW5zdGFsbFx1MzAwMlxuICogQW5kcm9pZCBcdTc1MzEgbW9kZS1wbHVnaW4gXHU0RjdGXHU3NTI4XHU1NDBDXHU0RTAwIHJlcG9CdWlsZERpciBcdTUxNkNcdTVGMEZcdTVCOUFcdTRGNERcdTMwMDJcbiAqL1xuZXhwb3J0IGNvbnN0IEZGTVBFR19JTlNUQUxMX0RJUiA9IHBhdGguam9pbihGRk1QRUdfQlVJTERfRElSLCBcImluc3RhbGxcIik7XG5cbmV4cG9ydCBjb25zdCBEQVRBX1BMVUdJTlNfRElSID0gcGF0aC5qb2luKFxuICBST09ULFxuICBcIi5rYWJlZ2FtZVwiLFxuICBcImRlYnVnXCIsXG4gIFwiZGF0YVwiLFxuICBcInBsdWdpbnMtZGlyZWN0b3J5XCIsXG4pO1xuXG5leHBvcnQgY29uc3QgUkVTT1VSQ0VTX0RJUiA9IHBhdGguam9pbihcbiAgUk9PVCxcbiAgXCJzcmMtdGF1cmlcIixcbiAgXCJrYWJlZ2FtZVwiLFxuICBcInJlc291cmNlc1wiLFxuKTtcblxuLy8gV2luZG93cy9MaW51eC9tYWNPUyBcdThGRDBcdTg4NENcdTY1RjZcdTVFOTNcdTc2ODRcdTY1MzZcdTk2QzZcdTRFMEVcdTU5MERcdTUyMzZcdTk2QzZcdTRFMkRcdTU3Mjggc2NyaXB0cy9wbHVnaW5zL29zLXBsdWdpbi50cyhPU1BsdWdpbilcdTMwMDJcbi8vIFx1NEVEM1x1NUU5M1x1NjgzOSBiaW4ve3dpbmRvd3MsbGludXgsbWFjb3N9LyBcdTRFM0FcdTU0MDRcdTVFNzNcdTUzRjBcdTY2ODJcdTVCNThcdTc2RUVcdTVGNTUsXHU4QkU2XHU4OUMxIGNvY3MvYnVpbGQvUExBVEZPUk1fU0hBUkVEX0xJQlMubWRcdTMwMDJcblxuZXhwb3J0IGNvbnN0IFJFU09VUkNFU19QTFVHSU5TX0RJUiA9IHBhdGguam9pbihSRVNPVVJDRVNfRElSLCBcInBsdWdpbnNcIik7XG5leHBvcnQgY29uc3QgUkVTT1VSQ0VTX0JJTl9ESVIgPSBwYXRoLmpvaW4oUkVTT1VSQ0VTX0RJUiwgXCJiaW5cIik7XG5leHBvcnQgY29uc3QgU1JDX1RBVVJJX0RJUiA9IHBhdGguam9pbihST09ULCBcInNyYy10YXVyaVwiKTtcbmV4cG9ydCBjb25zdCBUQVVSSV9LQUJFR0FNRV9ESVIgPSBwYXRoLmpvaW4oU1JDX1RBVVJJX0RJUiwgXCJrYWJlZ2FtZVwiKTtcblxuLyoqIFx1NUYwMFx1NTNEMVx1NjcwRFx1NTJBMVx1NTY2OCBob3N0XHVGRjFBXHU0RjlCIHRhdXJpLmNvbmYgXHU3Njg0IGRldlVybCAvIENTUCBcdTdCNDlcdTRGN0ZcdTc1MjhcdUZGMUJcdTUzRUZcdTg4QUIgVEFVUklfREVWX0hPU1QgLyBWSVRFX0RFVl9TRVJWRVJfSE9TVCBcdTg5ODZcdTc2RDYgKi9cbmV4cG9ydCBmdW5jdGlvbiBnZXREZXZTZXJ2ZXJIb3N0KCk6IHN0cmluZyB7XG4gIGNvbnN0IG92ZXJyaWRlID0gcHJvY2Vzcy5lbnYuVEFVUklfREVWX0hPU1QgPz9cbiAgICBwcm9jZXNzLmVudi5WSVRFX0RFVl9TRVJWRVJfSE9TVDtcbiAgaWYgKG92ZXJyaWRlKSByZXR1cm4gb3ZlcnJpZGU7XG5cbiAgY29uc3QgaWZhY2VzID0gb3MubmV0d29ya0ludGVyZmFjZXMoKTtcbiAgY29uc3QgYWxsOiBzdHJpbmdbXSA9IFtdO1xuICBmb3IgKGNvbnN0IG5hbWUgb2YgT2JqZWN0LmtleXMoaWZhY2VzIHx8IHt9KSkge1xuICAgIGZvciAoY29uc3QgaWZhY2Ugb2YgaWZhY2VzIVtuYW1lXSEpIHtcbiAgICAgIGlmIChpZmFjZS5mYW1pbHkgIT09IFwiSVB2NFwiIHx8IGlmYWNlLmludGVybmFsKSBjb250aW51ZTtcbiAgICAgIGFsbC5wdXNoKGlmYWNlLmFkZHJlc3MpO1xuICAgIH1cbiAgfVxuICAvLyBcdTRGMThcdTUxNDhcdThGRDRcdTU2REUgUkZDIDE5MTggXHU3OUMxXHU2NzA5XHU1NzMwXHU1NzQwXHVGRjBDXHU4RkM3XHU2RUU0IFZQTi9UVU4gXHU4NjVBXHU2MkRGXHU3RjUxXHU1MzYxXHVGRjA4XHU1OTgyIENsYXNoIDE5OC4xOC54LnhcdUZGMDlcbiAgY29uc3QgcmZjMTkxOCA9IGFsbC5maW5kKChpcCkgPT4ge1xuICAgIGNvbnN0IFthLCBiXSA9IGlwLnNwbGl0KFwiLlwiKS5tYXAoTnVtYmVyKTtcbiAgICByZXR1cm4gYSA9PT0gMTAgfHwgKGEgPT09IDE3MiAmJiBiID49IDE2ICYmIGIgPD0gMzEpIHx8XG4gICAgICAoYSA9PT0gMTkyICYmIGIgPT09IDE2OCk7XG4gIH0pO1xuICByZXR1cm4gcmZjMTkxOCA/PyBhbGxbMF0gPz8gXCJsb2NhbGhvc3RcIjtcbn1cblxuaW50ZXJmYWNlIFJ1bk9wdGlvbnMge1xuICBiaW4/OiBzdHJpbmc7XG4gIGN3ZD86IHN0cmluZztcbiAgW2tleTogc3RyaW5nXTogYW55O1xufVxuXG4vLyBcdTRGMjBcdTUxNjUgb3B0LmJpbiBcdTRFM0FcdThGRDBcdTg4NENcdTVERTVcdTUxNzdcdUZGMENcdTUzRUZcdTRFRTVcdTRFM0EgZGVuby10YXNrXHUzMDAxY2FyZ29cdTMwMDJcdTU5ODJcdTY3OUNcdTRFMERcdTRGMjBcdTUyMTlcdTRFM0FcdTRFOENcdThGREJcdTUyMzZcbmV4cG9ydCBmdW5jdGlvbiBydW4oY21kOiBzdHJpbmcsIGFyZ3M6IHN0cmluZ1tdLCBvcHRzOiBSdW5PcHRpb25zID0ge30pOiB2b2lkIHtcbiAgLy8gY29uc29sZS5sb2coJ3J1bm9wdHM6ICcsIGNtZCwgYXJncywgb3B0cylcbiAgc3dpdGNoIChvcHRzLmJpbikge1xuICAgIGNhc2UgXCJkZW5vLXRhc2tcIjoge1xuICAgICAgLy8gYGRlbm8gdGFzayA8c2NyaXB0PiA8YXJncy4uLj5gXHVGRjFBYXJncyBcdTc1MzEgZGVub190YXNrX3NoZWxsIFx1NTM5Rlx1NjgzN1x1OEZGRFx1NTJBMFx1OEZEQlx1ODExQVx1NjcyQ1x1NTQ3RFx1NEVFNFx1RkYwQ1xuICAgICAgLy8gXHU4MTFBXHU2NzJDXHU1NzI4IG9wdHMuY3dkXHVGRjA4XHU2MjE2IFJPT1RcdUZGMDlcdTc2ODQgcGFja2FnZS5qc29uIFx1NEUyRFx1ODlFM1x1Njc5MFx1MzAwMlxuICAgICAgYXJncyA9IFtcInRhc2tcIiwgY21kLCAuLi5hcmdzXTtcbiAgICAgIGNtZCA9IFwiZGVub1wiO1xuICAgICAgYnJlYWs7XG4gICAgfVxuICAgIGNhc2UgXCJjYXJnb1wiOiB7XG4gICAgICBhcmdzID0gW2NtZCwgLi4uYXJnc107XG4gICAgICBjbWQgPSBcImNhcmdvXCI7XG4gICAgICBicmVhaztcbiAgICB9XG4gIH1cbiAgZGVsZXRlIG9wdHMuYmluO1xuICBjb25zb2xlLmxvZyhcbiAgICBjaGFsay55ZWxsb3coXCJSVU5cIiksXG4gICAgSlNPTi5zdHJpbmdpZnkob3B0cyksXG4gICAgXCI9PlxcblxcdFwiLFxuICAgIGNoYWxrLmJvbGQuaXRhbGljLnJlZEJyaWdodChjbWQsIGFyZ3Muam9pbihcIiBcIikpLFxuICApO1xuICBjb25zdCByZXMgPSBzcGF3blN5bmMoY21kLCBhcmdzLCB7XG4gICAgc3RkaW86IFwiaW5oZXJpdFwiLFxuICAgIGN3ZDogUk9PVCxcbiAgICBzaGVsbDogcHJvY2Vzcy5wbGF0Zm9ybSA9PT0gXCJ3aW4zMlwiLFxuICAgIGVudjogcHJvY2Vzcy5lbnYsXG4gICAgLi4ub3B0cyxcbiAgfSk7XG4gIGlmIChyZXMuc3RhdHVzICE9PSAwKSB7XG4gICAgcHJvY2Vzcy5leGl0KHJlcy5zdGF0dXMgPz8gMSk7XG4gIH1cbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHBsYXRmb3JtRXhlRXh0KCk6IHN0cmluZyB7XG4gIHJldHVybiBwcm9jZXNzLnBsYXRmb3JtID09PSBcIndpbjMyXCIgPyBcIi5leGVcIiA6IFwiXCI7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBlbnN1cmVEaXIocDogc3RyaW5nKTogdm9pZCB7XG4gIGZzLm1rZGlyU3luYyhwLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGV4aXN0c0ZpbGUocDogc3RyaW5nKTogYm9vbGVhbiB7XG4gIHRyeSB7XG4gICAgcmV0dXJuIGZzLmV4aXN0c1N5bmMocCkgJiYgZnMuc3RhdFN5bmMocCkuaXNGaWxlKCk7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBmYWxzZTtcbiAgfVxufVxuXG5leHBvcnQgZnVuY3Rpb24gZmluZEZpcnN0RXhpc3RpbmcoXG4gIHBhdGhzOiAoc3RyaW5nIHwgbnVsbCB8IHVuZGVmaW5lZClbXSxcbik6IHN0cmluZyB8IG51bGwge1xuICBmb3IgKGNvbnN0IHAgb2YgcGF0aHMpIHtcbiAgICBpZiAocCAmJiBleGlzdHNGaWxlKHApKSByZXR1cm4gcDtcbiAgfVxuICByZXR1cm4gbnVsbDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHN0YWdlUmVzb3VyY2VGaWxlKHNyYzogc3RyaW5nLCBkc3RGaWxlTmFtZTogc3RyaW5nKTogdm9pZCB7XG4gIGlmICghZnMuZXhpc3RzU3luYyhzcmMpKSB7XG4gICAgY29uc29sZS5lcnJvcihjaGFsay5yZWQoYFx1Mjc0QyBcdTYyN0VcdTRFMERcdTUyMzBcdThENDRcdTZFOTBcdTY1ODdcdTRFRjY6ICR7c3JjfWApKTtcbiAgICBwcm9jZXNzLmV4aXQoMSk7XG4gIH1cbiAgZW5zdXJlRGlyKFJFU09VUkNFU19CSU5fRElSKTtcbiAgY29uc3QgZHN0ID0gcGF0aC5qb2luKFJFU09VUkNFU19CSU5fRElSLCBkc3RGaWxlTmFtZSk7XG4gIGZzLmNvcHlGaWxlU3luYyhzcmMsIGRzdCk7XG4gIGNvbnNvbGUubG9nKFxuICAgIGNoYWxrLmN5YW4oYFtidWlsZF0gU3RhZ2VkIHJlc291cmNlIGZpbGU6ICR7cGF0aC5yZWxhdGl2ZShST09ULCBkc3QpfWApLFxuICApO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gc3RhZ2VSZXNvdXJjZUJpbmFyeShiaW5OYW1lOiBzdHJpbmcpOiB2b2lkIHtcbiAgY29uc3QgZXh0ID0gcGxhdGZvcm1FeGVFeHQoKTtcbiAgY29uc3Qgc3JjID0gcGF0aC5qb2luKEFSVElGQUNUX0RJUiwgXCJyZWxlYXNlXCIsIGAke2Jpbk5hbWV9JHtleHR9YCk7XG4gIGNvbnN0IGRzdCA9IHBhdGguam9pbihSRVNPVVJDRVNfQklOX0RJUiwgYCR7YmluTmFtZX0ke2V4dH1gKTtcbiAgaWYgKCFmcy5leGlzdHNTeW5jKHNyYykpIHtcbiAgICBjb25zb2xlLmVycm9yKFxuICAgICAgY2hhbGsucmVkKFxuICAgICAgICBgXHUyNzRDIFx1NjI3RVx1NEUwRFx1NTIzMCBzaWRlY2FyIFx1NkU5MFx1NEU4Q1x1OEZEQlx1NTIzNjogJHtzcmN9XFxuYCArXG4gICAgICAgICAgYFx1OEJGN1x1Nzg2RVx1OEJBNFx1NURGMlx1NjIxMFx1NTI5Rlx1Njc4NFx1NUVGQTogY2FyZ28gYnVpbGQgLS1yZWxlYXNlIC1wIDxjcmF0ZT5gLFxuICAgICAgKSxcbiAgICApO1xuICAgIHByb2Nlc3MuZXhpdCgxKTtcbiAgfVxuICBlbnN1cmVEaXIoUkVTT1VSQ0VTX0JJTl9ESVIpO1xuICBmcy5jb3B5RmlsZVN5bmMoc3JjLCBkc3QpO1xuICBjb25zb2xlLmxvZyhcbiAgICBjaGFsay5jeWFuKGBbYnVpbGRdIFN0YWdlZCBleGUgcmVzb3VyY2U6ICR7cGF0aC5yZWxhdGl2ZShST09ULCBkc3QpfWApLFxuICApO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gcmVzb3VyY2VCaW5hcnlFeGlzdHMoYmluTmFtZTogc3RyaW5nKTogYm9vbGVhbiB7XG4gIGNvbnN0IGV4dCA9IHBsYXRmb3JtRXhlRXh0KCk7XG4gIGNvbnN0IHAgPSBwYXRoLmpvaW4oUkVTT1VSQ0VTX0JJTl9ESVIsIGAke2Jpbk5hbWV9JHtleHR9YCk7XG4gIHJldHVybiBmcy5leGlzdHNTeW5jKHApO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gc2NhblJlc291cmNlUGx1Z2lucygpOiBzdHJpbmdbXSB7XG4gIC8vIFx1NTlDQlx1N0VDOFx1NjI2Qlx1NjNDRiBSRVNPVVJDRVNfUExVR0lOU19ESVJcdUZGMDhcdTk4ODRcdTdGNkVcdTYzRDJcdTRFRjZcdTU5Q0JcdTdFQzhcdTU3MjggcmVzb3VyY2VzIFx1NzZFRVx1NUY1NVx1RkYwOVxuICBjb25zdCBwbHVnaW5EaXIgPSBSRVNPVVJDRVNfUExVR0lOU19ESVI7XG4gIGlmICghZnMuZXhpc3RzU3luYyhwbHVnaW5EaXIpKSB7XG4gICAgcmV0dXJuIFtdO1xuICB9XG4gIGNvbnN0IGZpbGVzID0gZnMucmVhZGRpclN5bmMocGx1Z2luRGlyKTtcbiAgcmV0dXJuIGZpbGVzXG4gICAgLmZpbHRlcigoZjogc3RyaW5nKSA9PiBmLmVuZHNXaXRoKFwiLmtncGdcIikpXG4gICAgLm1hcCgoZjogc3RyaW5nKSA9PiBwYXRoLmJhc2VuYW1lKGYsIFwiLmtncGdcIikpXG4gICAgLmZpbHRlcihCb29sZWFuKVxuICAgIC5zb3J0KChhOiBzdHJpbmcsIGI6IHN0cmluZykgPT5cbiAgICAgIGEubG9jYWxlQ29tcGFyZShiLCB1bmRlZmluZWQsIHsgc2Vuc2l0aXZpdHk6IFwiYmFzZVwiIH0pXG4gICAgKTtcbn1cblxuLy8gXHU4QkZCXHU1M0Q2L1x1NjZGNFx1NjVCMCBDYXJnby50b21sIChXb3Jrc3BhY2UgUm9vdClcbmV4cG9ydCBmdW5jdGlvbiByZWFkQ2FyZ29Ub21sVmVyc2lvbigpOiBzdHJpbmcge1xuICBjb25zdCBjYXJnb1RvbWxQYXRoID0gcGF0aC5qb2luKFJPT1QsIFwiQ2FyZ28udG9tbFwiKTtcbiAgaWYgKCFmcy5leGlzdHNTeW5jKGNhcmdvVG9tbFBhdGgpKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwiQ2FyZ28udG9tbCBub3QgZm91bmRcIik7XG4gIH1cblxuICBjb25zdCBjYXJnb1RvbWwgPSBmcy5yZWFkRmlsZVN5bmMoY2FyZ29Ub21sUGF0aCwgXCJ1dGY4XCIpO1xuICBjb25zdCB3b3Jrc3BhY2VQYWNrYWdlUmVnZXggPVxuICAgIC8oXFxbd29ya3NwYWNlXFwucGFja2FnZVxcXVteXFxbXSo/dmVyc2lvblxccyo9XFxzKlwiKShbXlwiXSspKFwiKS9zO1xuICBjb25zdCBtYXRjaCA9IGNhcmdvVG9tbC5tYXRjaCh3b3Jrc3BhY2VQYWNrYWdlUmVnZXgpO1xuXG4gIGlmICghbWF0Y2gpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJDb3VsZCBub3QgZmluZCBbd29ya3NwYWNlLnBhY2thZ2VdIHZlcnNpb24gaW4gQ2FyZ28udG9tbFwiKTtcbiAgfVxuXG4gIHJldHVybiBtYXRjaFsyXTtcbn1cbiIsICJjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfZGlybmFtZSA9IFwiRDpcXFxcQ29kZXNcXFxca2FiZWdhbWVcXFxcc2NyaXB0c1wiO2NvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9maWxlbmFtZSA9IFwiRDpcXFxcQ29kZXNcXFxca2FiZWdhbWVcXFxcc2NyaXB0c1xcXFx2aXRlLWRlYnVnLXNlcnZlci50c1wiO2NvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9pbXBvcnRfbWV0YV91cmwgPSBcImZpbGU6Ly8vRDovQ29kZXMva2FiZWdhbWUvc2NyaXB0cy92aXRlLWRlYnVnLXNlcnZlci50c1wiO2ltcG9ydCB0eXBlIHsgSW5jb21pbmdNZXNzYWdlLCBTZXJ2ZXJSZXNwb25zZSB9IGZyb20gXCJub2RlOmh0dHBcIjtcbmltcG9ydCBjcnlwdG8gZnJvbSBcIm5vZGU6Y3J5cHRvXCI7XG5pbXBvcnQgZnMgZnJvbSBcIm5vZGU6ZnMvcHJvbWlzZXNcIjtcbmltcG9ydCBwYXRoIGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB0eXBlIHsgUGx1Z2luIH0gZnJvbSBcInZpdGVcIjtcblxuY29uc3QgREVCVUdfUFJFRklYID0gXCIvX19rYWJlZ2FtZV9kZWJ1Z1wiO1xuY29uc3QgQ0RQX1BSRUZJWCA9IFwiL19fa2FiZWdhbWVfY2RwXCI7XG5jb25zdCBERUZBVUxUX01BWF9CT0RZX0JZVEVTID0gMTAyNCAqIDEwMjQ7XG5cbi8qKlxuICogYXBwIFx1NEUwQVx1NjJBNVx1NzY4NCBDRUYgQ0RQIFx1N0FFRlx1NTNFM1x1MzAwMlxuICpcbiAqIGRldiBcdTRFMEIgQ0RQIFx1N0FFRlx1NTNFM1x1NjYyRlx1OTY4Rlx1NjczQVx1NzY4NFx1RkYwOGBLQUJFR0FNRV9DRUZfREVCVUdfUE9SVD1yYW5kb21gXHVGRjA5XHVGRjBDXHU4MDBDIHZpdGUgXHU3Njg0IDE0MjAgXHU2NjJGXG4gKiBcdTZCN0JcdTdBRUZcdTUzRTNcdUZGMENcdTYyNDBcdTRFRTVcdThCQTkgYXBwIFx1NjI4QVx1NTNGN1x1NUJDNFx1NUI1OFx1NTcyOFx1OEZEOVx1OTFDQ1x1NUY1M1x1OTZDNlx1NTQwOFx1NzBCOVx1RkYxQWAuY2xhdWRlL3NraWxscy9rYWJlZ2FtZS1jaHJvbWl1bS9gXG4gKiBcdTUzRUFcdTYzQTIgMTQyMCBcdTVDMzFcdTgwRkRcdTYyRkZcdTUyMzBcdTdBRUZcdTUzRTNcdTMwMDJcbiAqXG4gKiBcdTc2N0JcdThCQjAqKlx1NTQwQ1x1NjVGNlx1NTE5OVx1NzZEOCoqXHVGRjA4YC5rYWJlZ2FtZS9kZWJ1Zy9jZHAtcG9ydC5qc29uYFx1RkYwOVx1RkYwQ3ZpdGUgXHU1NDJGXHU1MkE4XHU2NUY2XHU4QkZCXHU1NkRFXHVGRjFBXG4gKiBcdTY1MzkgYHZpdGUuY29uZmlnLnRzYCBcdTRGMUFcdThCQTkgdml0ZSByZXN0YXJ0XHVGRjBDXHU4MDBDIHJlc3RhcnQgXHU5MUNEXHU1RUZBIHBsdWdpbiBcdTVCOUVcdTRGOEJcdTMwMDFcdTZFMDVcdTdBN0FcdTk1RURcdTUzMDVcdTkxQ0NcdTc2ODRcbiAqIFx1NTE4NVx1NUI1OFx1NjAwMVx1RkYxQmFwcCBcdTRGQTdcdTUzRUFcdTU3MjhcdTU0MkZcdTUyQThcdTY1RjZcdTRFMEFcdTYyQTVcdTRFMDBcdTZCMjFcdTRFMTRcdTU5MzFcdThEMjVcdTUzNzNcdTY1M0VcdTVGMDNcdUZGMENcdTRFOEVcdTY2MkYgYXBwIFx1OEZEOFx1NkQzQlx1Nzc0MFx1NTM3NFx1NkMzOFx1OEZEQ1x1NjdFNVx1NEUwRFx1NTIzMFx1N0FFRlx1NTNFM1x1MzAwMlxuICogXHU1QjlFXHU2RDRCXHVGRjFBUE9TVCBcdTc2N0JcdThCQjAgXHUyMTkyIHRvdWNoIHZpdGUuY29uZmlnLnRzIFx1MjE5MiBHRVQgXHU1M0Q4IDQwNFx1MzAwMlx1ODQzRFx1NzZEOFx1NjYyRlx1OEZEOVx1Njc2MVx1OTRGRVx1OERFRlx1NTUyRlx1NEUwMFx1NzY4NFx1NjMwMVx1NEU0NVx1NzNBRlx1ODI4Mlx1MzAwMlxuICpcbiAqIFx1NjU4N1x1NEVGNlx1NTNFRlx1ODBGRFx1NjYyRlx1OTY0OFx1NjVFN1x1NzY4NFx1RkYwOGFwcCBcdTkwMDBcdTUxRkFcdTRFMERcdTRGMUFcdTY0QTRcdTk1MDBcdTc2N0JcdThCQjBcdUZGMDlcdUZGMENcdTYyNDBcdTRFRTVcdThCRkJcdTU2REVcdTY3NjVcdTc2ODRcdTUzRjdcdTcxNjdcdTY1RTdcdTg5ODFcdTYzQTJcdTZEM0JcdTIwMTRcdTIwMTRza2lsbCBcdTRFMEVcbiAqIFx1NjcyQ1x1NjU4N1x1NEVGNlx1NzY4NCBHRVQgXHU1MjA2XHU2NTJGXHU5MEZEXHU0RTBEXHU1MDQ3XHU4QkJFXHU1QjgzXHU0RTAwXHU1QjlBXHU4RkQ4XHU2RDNCXHU3NzQwXHUzMDAyXG4gKi9cbmludGVyZmFjZSBDZHBSZWdpc3RyYXRpb24ge1xuICBwb3J0OiBudW1iZXI7XG4gIHBpZDogbnVtYmVyIHwgbnVsbDtcbiAgcmVnaXN0ZXJlZEF0OiBzdHJpbmc7XG59XG5cbmNvbnN0IENEUF9QT1JUX0ZJTEUgPSBcImNkcC1wb3J0Lmpzb25cIjtcblxuYXN5bmMgZnVuY3Rpb24gcmVhZENkcEZpbGUoZGVidWdEaXI6IHN0cmluZyk6IFByb21pc2U8Q2RwUmVnaXN0cmF0aW9uIHwgbnVsbD4ge1xuICB0cnkge1xuICAgIGNvbnN0IHJhdyA9IGF3YWl0IGZzLnJlYWRGaWxlKHBhdGguam9pbihkZWJ1Z0RpciwgQ0RQX1BPUlRfRklMRSksIFwidXRmOFwiKTtcbiAgICBjb25zdCBwYXJzZWQgPSBKU09OLnBhcnNlKHJhdykgYXMgUGFydGlhbDxDZHBSZWdpc3RyYXRpb24+O1xuICAgIGNvbnN0IHBvcnQgPSBOdW1iZXIocGFyc2VkLnBvcnQpO1xuICAgIGlmICghTnVtYmVyLmlzSW50ZWdlcihwb3J0KSB8fCBwb3J0IDw9IDAgfHwgcG9ydCA+IDY1NTM1KSByZXR1cm4gbnVsbDtcbiAgICByZXR1cm4ge1xuICAgICAgcG9ydCxcbiAgICAgIHBpZDogTnVtYmVyLmlzSW50ZWdlcihOdW1iZXIocGFyc2VkLnBpZCkpID8gTnVtYmVyKHBhcnNlZC5waWQpIDogbnVsbCxcbiAgICAgIHJlZ2lzdGVyZWRBdDogdHlwZW9mIHBhcnNlZC5yZWdpc3RlcmVkQXQgPT09IFwic3RyaW5nXCIgPyBwYXJzZWQucmVnaXN0ZXJlZEF0IDogXCJcIixcbiAgICB9O1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxufVxuXG5hc3luYyBmdW5jdGlvbiB3cml0ZUNkcEZpbGUoZGVidWdEaXI6IHN0cmluZywgcmVnaXN0cmF0aW9uOiBDZHBSZWdpc3RyYXRpb24pOiBQcm9taXNlPHZvaWQ+IHtcbiAgdHJ5IHtcbiAgICBhd2FpdCBmcy5ta2RpcihkZWJ1Z0RpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgYXdhaXQgZnMud3JpdGVGaWxlKFxuICAgICAgcGF0aC5qb2luKGRlYnVnRGlyLCBDRFBfUE9SVF9GSUxFKSxcbiAgICAgIGAke0pTT04uc3RyaW5naWZ5KHJlZ2lzdHJhdGlvbiwgbnVsbCwgMil9XFxuYCxcbiAgICAgIFwidXRmOFwiLFxuICAgICk7XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgY29uc29sZS53YXJuKGBba2FiZWdhbWUtY2RwXSBcdTY1RTBcdTZDRDVcdTUxOTlcdTUxNjUgJHtDRFBfUE9SVF9GSUxFfTogJHtTdHJpbmcoZXJyb3IpfWApO1xuICB9XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgS2FiZWdhbWVEZWJ1Z1NlcnZlck9wdGlvbnMge1xuICB3b3Jrc3BhY2VSb290OiBzdHJpbmc7XG4gIGVuYWJsZWQ/OiBib29sZWFuO1xuICBhbGxvd1JlbW90ZT86IGJvb2xlYW47XG4gIGxvZ1RvQ29uc29sZT86IGJvb2xlYW47XG4gIG1heEJvZHlCeXRlcz86IG51bWJlcjtcbn1cblxudHlwZSBEZWJ1Z0V2ZW50ID0gUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG5cbmV4cG9ydCBmdW5jdGlvbiBrYWJlZ2FtZURlYnVnU2VydmVyKG9wdGlvbnM6IEthYmVnYW1lRGVidWdTZXJ2ZXJPcHRpb25zKTogUGx1Z2luIHtcbiAgY29uc3QgZW5hYmxlZCA9IG9wdGlvbnMuZW5hYmxlZCA/PyB0cnVlO1xuICBjb25zdCBhbGxvd1JlbW90ZSA9IG9wdGlvbnMuYWxsb3dSZW1vdGUgPz8gcHJvY2Vzcy5lbnYuS0FCRUdBTUVfREVCVUdfQUxMT1dfUkVNT1RFID09PSBcInRydWVcIjtcbiAgY29uc3QgbG9nVG9Db25zb2xlID0gb3B0aW9ucy5sb2dUb0NvbnNvbGUgPz8gcHJvY2Vzcy5lbnYuS0FCRUdBTUVfREVCVUdfVEVFX0NPTlNPTEUgPT09IFwidHJ1ZVwiO1xuICBjb25zdCBtYXhCb2R5Qnl0ZXMgPSBvcHRpb25zLm1heEJvZHlCeXRlcyA/PyBERUZBVUxUX01BWF9CT0RZX0JZVEVTO1xuICBjb25zdCBkZWJ1Z0RpciA9IHBhdGgucmVzb2x2ZShvcHRpb25zLndvcmtzcGFjZVJvb3QsIFwiLmthYmVnYW1lXCIsIFwiZGVidWdcIik7XG4gIGxldCBjZHA6IENkcFJlZ2lzdHJhdGlvbiB8IG51bGwgPSBudWxsO1xuXG4gIHJldHVybiB7XG4gICAgbmFtZTogXCJrYWJlZ2FtZS1kZWJ1Zy1zZXJ2ZXJcIixcbiAgICBhcHBseTogXCJzZXJ2ZVwiLFxuICAgIGNvbmZpZ3VyZVNlcnZlcihzZXJ2ZXIpIHtcbiAgICAgIGlmICghZW5hYmxlZCkgcmV0dXJuO1xuXG4gICAgICBzZXJ2ZXIubWlkZGxld2FyZXMudXNlKGFzeW5jIChyZXEsIHJlcywgbmV4dCkgPT4ge1xuICAgICAgICBjb25zdCB1cmwgPSBuZXcgVVJMKHJlcS51cmwgPz8gXCIvXCIsIFwiaHR0cDovL2thYmVnYW1lLmxvY2FsXCIpO1xuICAgICAgICBjb25zdCBpc0RlYnVnID1cbiAgICAgICAgICB1cmwucGF0aG5hbWUgPT09IERFQlVHX1BSRUZJWCB8fCB1cmwucGF0aG5hbWUuc3RhcnRzV2l0aChgJHtERUJVR19QUkVGSVh9L2ApO1xuICAgICAgICBjb25zdCBpc0NkcCA9IHVybC5wYXRobmFtZSA9PT0gQ0RQX1BSRUZJWCB8fCB1cmwucGF0aG5hbWUuc3RhcnRzV2l0aChgJHtDRFBfUFJFRklYfS9gKTtcbiAgICAgICAgaWYgKCFpc0RlYnVnICYmICFpc0NkcCkge1xuICAgICAgICAgIG5leHQoKTtcbiAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoIWFsbG93UmVtb3RlICYmICFpc0xvb3BiYWNrKHJlcS5zb2NrZXQucmVtb3RlQWRkcmVzcykpIHtcbiAgICAgICAgICBzZW5kSnNvbihyZXMsIDQwMywgeyBvazogZmFsc2UsIGVycm9yOiBcInJlbW90ZSBkZWJ1ZyBpbmdlc3QgaXMgZGlzYWJsZWRcIiB9KTtcbiAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cblxuICAgICAgICB0cnkge1xuICAgICAgICAgIC8vIC0tLS0gQ0RQIFx1N0FFRlx1NTNFM1x1OTZDNlx1NTQwOFx1NzBCOVx1RkYxQWFwcCBcdTRFMEFcdTYyQTUgLyBza2lsbCBcdTY3RTVcdThCRTIgLS0tLVxuICAgICAgICAgIGlmIChpc0NkcCkge1xuICAgICAgICAgICAgaWYgKHJlcS5tZXRob2QgPT09IFwiUE9TVFwiICYmIHVybC5wYXRobmFtZSA9PT0gYCR7Q0RQX1BSRUZJWH0vcmVnaXN0ZXJgKSB7XG4gICAgICAgICAgICAgIGNvbnN0IGJvZHkgPSBhd2FpdCByZWFkQm9keShyZXEsIG1heEJvZHlCeXRlcyk7XG4gICAgICAgICAgICAgIGNvbnN0IHBhcnNlZCA9IEpTT04ucGFyc2UoYm9keSB8fCBcInt9XCIpIGFzIHsgcG9ydD86IHVua25vd247IHBpZD86IHVua25vd24gfTtcbiAgICAgICAgICAgICAgY29uc3QgcG9ydCA9IE51bWJlcihwYXJzZWQucG9ydCk7XG4gICAgICAgICAgICAgIGlmICghTnVtYmVyLmlzSW50ZWdlcihwb3J0KSB8fCBwb3J0IDw9IDAgfHwgcG9ydCA+IDY1NTM1KSB7XG4gICAgICAgICAgICAgICAgc2VuZEpzb24ocmVzLCA0MDAsIHsgb2s6IGZhbHNlLCBlcnJvcjogYGludmFsaWQgcG9ydDogJHtTdHJpbmcocGFyc2VkLnBvcnQpfWAgfSk7XG4gICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgIGNvbnN0IHBpZCA9IE51bWJlci5pc0ludGVnZXIoTnVtYmVyKHBhcnNlZC5waWQpKSA/IE51bWJlcihwYXJzZWQucGlkKSA6IG51bGw7XG4gICAgICAgICAgICAgIGNkcCA9IHsgcG9ydCwgcGlkLCByZWdpc3RlcmVkQXQ6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSB9O1xuICAgICAgICAgICAgICBhd2FpdCB3cml0ZUNkcEZpbGUoZGVidWdEaXIsIGNkcCk7XG4gICAgICAgICAgICAgIGNvbnNvbGUubG9nKGBba2FiZWdhbWUtY2RwXSByZWdpc3RlcmVkIENEUCBwb3J0ICR7cG9ydH0ke3BpZCA/IGAgKHBpZCAke3BpZH0pYCA6IFwiXCJ9YCk7XG4gICAgICAgICAgICAgIHNlbmRKc29uKHJlcywgMjAwLCB7IG9rOiB0cnVlLCAuLi5jZHAgfSk7XG4gICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKHJlcS5tZXRob2QgPT09IFwiR0VUXCIgJiYgKHVybC5wYXRobmFtZSA9PT0gQ0RQX1BSRUZJWCB8fCB1cmwucGF0aG5hbWUgPT09IGAke0NEUF9QUkVGSVh9L2ApKSB7XG4gICAgICAgICAgICAgIC8vIHZpdGUgcmVzdGFydCBcdTRGMUFcdTZFMDVcdTdBN0FcdTUxODVcdTVCNThcdTYwMDFcdUZGMENcdTg0M0RcdTc2RDhcdTc2ODRcdTc2N0JcdThCQjBcdTY2MkZcdTU1MkZcdTRFMDBcdTgwRkRcdThERThcdTkxQ0RcdTU0MkZcdTZEM0JcdTRFMEJcdTY3NjVcdTc2ODRcdTUyNkZcdTY3MkNcbiAgICAgICAgICAgICAgY2RwID8/PSBhd2FpdCByZWFkQ2RwRmlsZShkZWJ1Z0Rpcik7XG4gICAgICAgICAgICAgIGlmICghY2RwKSB7XG4gICAgICAgICAgICAgICAgc2VuZEpzb24ocmVzLCA0MDQsIHsgb2s6IGZhbHNlLCBlcnJvcjogXCJubyBDRFAgcG9ydCByZWdpc3RlcmVkXCIgfSk7XG4gICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgIHNlbmRKc29uKHJlcywgMjAwLCB7IG9rOiB0cnVlLCAuLi5jZHAgfSk7XG4gICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgc2VuZEpzb24ocmVzLCA0MDQsIHsgb2s6IGZhbHNlLCBlcnJvcjogXCJ1bmtub3duIGNkcCBlbmRwb2ludFwiIH0pO1xuICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgIH1cblxuICAgICAgICAgIGlmIChyZXEubWV0aG9kID09PSBcIkdFVFwiICYmIHVybC5wYXRobmFtZSA9PT0gYCR7REVCVUdfUFJFRklYfS9oZWFsdGhgKSB7XG4gICAgICAgICAgICBzZW5kSnNvbihyZXMsIDIwMCwgeyBvazogdHJ1ZSwgZGVidWdEaXIgfSk7XG4gICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgfVxuXG4gICAgICAgICAgaWYgKHJlcS5tZXRob2QgPT09IFwiR0VUXCIgJiYgdXJsLnBhdGhuYW1lID09PSBgJHtERUJVR19QUkVGSVh9L3Nlc3Npb25zYCkge1xuICAgICAgICAgICAgY29uc3Qgc2Vzc2lvbnMgPSBhd2FpdCBsaXN0U2Vzc2lvbnMoZGVidWdEaXIpO1xuICAgICAgICAgICAgc2VuZEpzb24ocmVzLCAyMDAsIHsgb2s6IHRydWUsIHNlc3Npb25zIH0pO1xuICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgIH1cblxuICAgICAgICAgIGlmIChyZXEubWV0aG9kID09PSBcIkdFVFwiICYmIHVybC5wYXRobmFtZS5zdGFydHNXaXRoKGAke0RFQlVHX1BSRUZJWH0vc2Vzc2lvbnMvYCkpIHtcbiAgICAgICAgICAgIGNvbnN0IHNlc3Npb25JZCA9IHNhbml0aXplU2Vzc2lvbklkKFxuICAgICAgICAgICAgICBkZWNvZGVVUklDb21wb25lbnQodXJsLnBhdGhuYW1lLnNsaWNlKGAke0RFQlVHX1BSRUZJWH0vc2Vzc2lvbnMvYC5sZW5ndGgpKSxcbiAgICAgICAgICAgICk7XG4gICAgICAgICAgICBjb25zdCBsaW5lcyA9IE51bWJlci5wYXJzZUludCh1cmwuc2VhcmNoUGFyYW1zLmdldChcImxpbmVzXCIpID8/IFwiMjAwXCIsIDEwKTtcbiAgICAgICAgICAgIGNvbnN0IGNvbnRlbnQgPSBhd2FpdCByZWFkU2Vzc2lvblRhaWwoZGVidWdEaXIsIHNlc3Npb25JZCwgTnVtYmVyLmlzRmluaXRlKGxpbmVzKSA/IGxpbmVzIDogMjAwKTtcbiAgICAgICAgICAgIHJlcy5zdGF0dXNDb2RlID0gMjAwO1xuICAgICAgICAgICAgcmVzLnNldEhlYWRlcihcIkNvbnRlbnQtVHlwZVwiLCBcImFwcGxpY2F0aW9uL3gtbmRqc29uOyBjaGFyc2V0PXV0Zi04XCIpO1xuICAgICAgICAgICAgcmVzLmVuZChjb250ZW50KTtcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICB9XG5cbiAgICAgICAgICBpZiAocmVxLm1ldGhvZCA9PT0gXCJQT1NUXCIgJiYgdXJsLnBhdGhuYW1lID09PSBgJHtERUJVR19QUkVGSVh9L2luZ2VzdGApIHtcbiAgICAgICAgICAgIGNvbnN0IGJvZHkgPSBhd2FpdCByZWFkQm9keShyZXEsIG1heEJvZHlCeXRlcyk7XG4gICAgICAgICAgICBjb25zdCByZXF1ZXN0U2Vzc2lvbklkID0gc2FuaXRpemVTZXNzaW9uSWQoXG4gICAgICAgICAgICAgIHVybC5zZWFyY2hQYXJhbXMuZ2V0KFwic2Vzc2lvbl9pZFwiKSA/P1xuICAgICAgICAgICAgICAgIHVybC5zZWFyY2hQYXJhbXMuZ2V0KFwic2Vzc2lvbklkXCIpID8/XG4gICAgICAgICAgICAgICAgZ2V0SGVhZGVyKHJlcSwgXCJ4LWthYmVnYW1lLWRlYnVnLXNlc3Npb25cIikgPz9cbiAgICAgICAgICAgICAgICBwcm9jZXNzLmVudi5LQUJFR0FNRV9ERUJVR19TRVNTSU9OX0lEID8/XG4gICAgICAgICAgICAgICAgXCJkZWZhdWx0XCIsXG4gICAgICAgICAgICApO1xuICAgICAgICAgICAgLy8gQW5kcm9pZCBXZWJWaWV3IFx1N0VDRiBzaG91bGRJbnRlcmNlcHRSZXF1ZXN0IFx1NEVFM1x1NzQwNlx1NjVGNiBQT1NUIGJvZHkgXHU0RjFBXHU0RTIyXHVGRjBDXHU1QkEyXHU2MjM3XHU3QUVGXHU2NTM5XHU2MjhBXHU0RThCXHU0RUY2XHU2NTNFXHU4RkRCIGBldmVudGAgXHU2N0U1XHU4QkUyXHU1M0MyXHU2NTcwXG4gICAgICAgICAgICBjb25zdCBldmVudHMgPSBwYXJzZUV2ZW50cyhib2R5LnRyaW0oKSA/IGJvZHkgOiAodXJsLnNlYXJjaFBhcmFtcy5nZXQoXCJldmVudFwiKSA/PyBcIlwiKSkubWFwKChldmVudCkgPT5cbiAgICAgICAgICAgICAgbm9ybWFsaXplRXZlbnQoZXZlbnQsIHJlcXVlc3RTZXNzaW9uSWQpLFxuICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIGF3YWl0IGFwcGVuZEV2ZW50cyhkZWJ1Z0RpciwgZXZlbnRzLCBsb2dUb0NvbnNvbGUpO1xuICAgICAgICAgICAgcmVzLnN0YXR1c0NvZGUgPSAyMDQ7XG4gICAgICAgICAgICByZXMuZW5kKCk7XG4gICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgfVxuXG4gICAgICAgICAgc2VuZEpzb24ocmVzLCA0MDQsIHsgb2s6IGZhbHNlLCBlcnJvcjogXCJ1bmtub3duIGRlYnVnIGVuZHBvaW50XCIgfSk7XG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgICAgc2VuZEpzb24ocmVzLCA1MDAsIHtcbiAgICAgICAgICAgIG9rOiBmYWxzZSxcbiAgICAgICAgICAgIGVycm9yOiBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6IFN0cmluZyhlcnJvciksXG4gICAgICAgICAgfSk7XG4gICAgICAgIH1cbiAgICAgIH0pO1xuICAgIH0sXG4gIH07XG59XG5cbmZ1bmN0aW9uIGlzTG9vcGJhY2soYWRkcmVzczogc3RyaW5nIHwgdW5kZWZpbmVkKTogYm9vbGVhbiB7XG4gIGlmICghYWRkcmVzcykgcmV0dXJuIHRydWU7XG4gIGlmIChhZGRyZXNzID09PSBcIjo6MVwiIHx8IGFkZHJlc3MgPT09IFwibG9jYWxob3N0XCIpIHJldHVybiB0cnVlO1xuICBpZiAoYWRkcmVzcy5zdGFydHNXaXRoKFwiMTI3LlwiKSkgcmV0dXJuIHRydWU7XG4gIGlmIChhZGRyZXNzLnN0YXJ0c1dpdGgoXCI6OmZmZmY6MTI3LlwiKSkgcmV0dXJuIHRydWU7XG4gIHJldHVybiBmYWxzZTtcbn1cblxuZnVuY3Rpb24gZ2V0SGVhZGVyKHJlcTogSW5jb21pbmdNZXNzYWdlLCBuYW1lOiBzdHJpbmcpOiBzdHJpbmcgfCBudWxsIHtcbiAgY29uc3QgdmFsdWUgPSByZXEuaGVhZGVyc1tuYW1lXTtcbiAgaWYgKEFycmF5LmlzQXJyYXkodmFsdWUpKSByZXR1cm4gdmFsdWVbMF0gPz8gbnVsbDtcbiAgcmV0dXJuIHZhbHVlID8/IG51bGw7XG59XG5cbmZ1bmN0aW9uIHNlbmRKc29uKHJlczogU2VydmVyUmVzcG9uc2UsIHN0YXR1c0NvZGU6IG51bWJlciwgZGF0YTogdW5rbm93bik6IHZvaWQge1xuICByZXMuc3RhdHVzQ29kZSA9IHN0YXR1c0NvZGU7XG4gIHJlcy5zZXRIZWFkZXIoXCJDb250ZW50LVR5cGVcIiwgXCJhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04XCIpO1xuICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KGRhdGEpKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gcmVhZEJvZHkocmVxOiBJbmNvbWluZ01lc3NhZ2UsIG1heEJ5dGVzOiBudW1iZXIpOiBQcm9taXNlPHN0cmluZz4ge1xuICBjb25zdCBjaHVua3M6IEJ1ZmZlcltdID0gW107XG4gIGxldCB0b3RhbCA9IDA7XG5cbiAgZm9yIGF3YWl0IChjb25zdCBjaHVuayBvZiByZXEpIHtcbiAgICBjb25zdCBidWZmZXIgPSBCdWZmZXIuaXNCdWZmZXIoY2h1bmspID8gY2h1bmsgOiBCdWZmZXIuZnJvbShjaHVuayk7XG4gICAgdG90YWwgKz0gYnVmZmVyLmxlbmd0aDtcbiAgICBpZiAodG90YWwgPiBtYXhCeXRlcykge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKGBkZWJ1ZyBpbmdlc3QgYm9keSBleGNlZWRzICR7bWF4Qnl0ZXN9IGJ5dGVzYCk7XG4gICAgfVxuICAgIGNodW5rcy5wdXNoKGJ1ZmZlcik7XG4gIH1cblxuICByZXR1cm4gQnVmZmVyLmNvbmNhdChjaHVua3MpLnRvU3RyaW5nKFwidXRmOFwiKTtcbn1cblxuZnVuY3Rpb24gcGFyc2VFdmVudHMoYm9keTogc3RyaW5nKTogdW5rbm93bltdIHtcbiAgY29uc3QgdHJpbW1lZCA9IGJvZHkudHJpbSgpO1xuICBpZiAoIXRyaW1tZWQpIHJldHVybiBbe31dO1xuXG4gIGlmICh0cmltbWVkLnN0YXJ0c1dpdGgoXCJ7XCIpIHx8IHRyaW1tZWQuc3RhcnRzV2l0aChcIltcIikpIHtcbiAgICB0cnkge1xuICAgICAgY29uc3QgcGFyc2VkID0gSlNPTi5wYXJzZSh0cmltbWVkKTtcbiAgICAgIHJldHVybiBBcnJheS5pc0FycmF5KHBhcnNlZCkgPyBwYXJzZWQgOiBbcGFyc2VkXTtcbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgaWYgKCF0cmltbWVkLmluY2x1ZGVzKFwiXFxuXCIpKSB0aHJvdyBlcnJvcjtcbiAgICB9XG4gIH1cblxuICByZXR1cm4gdHJpbW1lZFxuICAgIC5zcGxpdCgvXFxyP1xcbi8pXG4gICAgLm1hcCgobGluZSkgPT4gbGluZS50cmltKCkpXG4gICAgLmZpbHRlcihCb29sZWFuKVxuICAgIC5tYXAoKGxpbmUpID0+IEpTT04ucGFyc2UobGluZSkpO1xufVxuXG5mdW5jdGlvbiBub3JtYWxpemVFdmVudChyYXc6IHVua25vd24sIGZhbGxiYWNrU2Vzc2lvbklkOiBzdHJpbmcpOiBEZWJ1Z0V2ZW50IHtcbiAgY29uc3Qgbm93ID0gbmV3IERhdGUoKS50b0lTT1N0cmluZygpO1xuICBjb25zdCBldmVudDogRGVidWdFdmVudCA9XG4gICAgcmF3ICYmIHR5cGVvZiByYXcgPT09IFwib2JqZWN0XCIgJiYgIUFycmF5LmlzQXJyYXkocmF3KVxuICAgICAgPyB7IC4uLihyYXcgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4pIH1cbiAgICAgIDogeyBwYXlsb2FkOiByYXcgfTtcblxuICBjb25zdCBzZXNzaW9uSWQgPSBzYW5pdGl6ZVNlc3Npb25JZChcbiAgICBnZXRTdHJpbmcoZXZlbnQuc2Vzc2lvbl9pZCkgPz8gZ2V0U3RyaW5nKGV2ZW50LnNlc3Npb25JZCkgPz8gZmFsbGJhY2tTZXNzaW9uSWQsXG4gICk7XG4gIGV2ZW50LnNlc3Npb25faWQgPSBzZXNzaW9uSWQ7XG4gIGRlbGV0ZSBldmVudC5zZXNzaW9uSWQ7XG5cbiAgaWYgKCFldmVudC50cykgZXZlbnQudHMgPSBub3c7XG4gIGlmICghZXZlbnQucmVjZWl2ZWRfYXQpIGV2ZW50LnJlY2VpdmVkX2F0ID0gbm93O1xuICBpZiAoIWV2ZW50LnNvdXJjZSkgZXZlbnQuc291cmNlID0gXCJ1bmtub3duXCI7XG5cbiAgcmV0dXJuIGV2ZW50O1xufVxuXG5mdW5jdGlvbiBnZXRTdHJpbmcodmFsdWU6IHVua25vd24pOiBzdHJpbmcgfCBudWxsIHtcbiAgcmV0dXJuIHR5cGVvZiB2YWx1ZSA9PT0gXCJzdHJpbmdcIiAmJiB2YWx1ZS50cmltKCkgPyB2YWx1ZSA6IG51bGw7XG59XG5cbmZ1bmN0aW9uIHNhbml0aXplU2Vzc2lvbklkKHJhdzogc3RyaW5nIHwgbnVsbCB8IHVuZGVmaW5lZCk6IHN0cmluZyB7XG4gIGNvbnN0IHZhbHVlID0gKHJhdyA/PyBcImRlZmF1bHRcIikudHJpbSgpIHx8IFwiZGVmYXVsdFwiO1xuICBjb25zdCBzYW5pdGl6ZWQgPSB2YWx1ZS5yZXBsYWNlKC9bXmEtekEtWjAtOS5fLV0vZywgXCJfXCIpLnNsaWNlKDAsIDk2KTtcbiAgaWYgKHNhbml0aXplZCkgcmV0dXJuIHNhbml0aXplZDtcblxuICByZXR1cm4gY3J5cHRvLmNyZWF0ZUhhc2goXCJzaGExXCIpLnVwZGF0ZSh2YWx1ZSkuZGlnZXN0KFwiaGV4XCIpLnNsaWNlKDAsIDE2KTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gYXBwZW5kRXZlbnRzKGRlYnVnRGlyOiBzdHJpbmcsIGV2ZW50czogRGVidWdFdmVudFtdLCBsb2dUb0NvbnNvbGU6IGJvb2xlYW4pOiBQcm9taXNlPHZvaWQ+IHtcbiAgYXdhaXQgZnMubWtkaXIoZGVidWdEaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuXG4gIGNvbnN0IGJ5U2Vzc2lvbiA9IG5ldyBNYXA8c3RyaW5nLCBzdHJpbmdbXT4oKTtcbiAgZm9yIChjb25zdCBldmVudCBvZiBldmVudHMpIHtcbiAgICBjb25zdCBzZXNzaW9uSWQgPSBzYW5pdGl6ZVNlc3Npb25JZChnZXRTdHJpbmcoZXZlbnQuc2Vzc2lvbl9pZCkgPz8gXCJkZWZhdWx0XCIpO1xuICAgIGNvbnN0IGxpbmUgPSBKU09OLnN0cmluZ2lmeShldmVudCk7XG4gICAgY29uc3QgbGluZXMgPSBieVNlc3Npb24uZ2V0KHNlc3Npb25JZCkgPz8gW107XG4gICAgbGluZXMucHVzaChsaW5lKTtcbiAgICBieVNlc3Npb24uc2V0KHNlc3Npb25JZCwgbGluZXMpO1xuXG4gICAgaWYgKGxvZ1RvQ29uc29sZSkge1xuICAgICAgY29uc29sZS5kZWJ1ZyhgW2thYmVnYW1lLWRlYnVnOiR7c2Vzc2lvbklkfV0gJHtsaW5lfWApO1xuICAgIH1cbiAgfVxuXG4gIGF3YWl0IFByb21pc2UuYWxsKFxuICAgIFsuLi5ieVNlc3Npb24uZW50cmllcygpXS5tYXAoKFtzZXNzaW9uSWQsIGxpbmVzXSkgPT5cbiAgICAgIGZzLmFwcGVuZEZpbGUoc2Vzc2lvbkZpbGUoZGVidWdEaXIsIHNlc3Npb25JZCksIGAke2xpbmVzLmpvaW4oXCJcXG5cIil9XFxuYCwgXCJ1dGY4XCIpLFxuICAgICksXG4gICk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGxpc3RTZXNzaW9ucyhkZWJ1Z0Rpcjogc3RyaW5nKTogUHJvbWlzZTxBcnJheTx7IHNlc3Npb25faWQ6IHN0cmluZzsgZmlsZTogc3RyaW5nOyBzaXplOiBudW1iZXI7IHVwZGF0ZWRfYXQ6IHN0cmluZyB9Pj4ge1xuICBsZXQgZW50cmllczogc3RyaW5nW107XG4gIHRyeSB7XG4gICAgZW50cmllcyA9IGF3YWl0IGZzLnJlYWRkaXIoZGVidWdEaXIpO1xuICB9IGNhdGNoIChlcnJvcikge1xuICAgIGlmICgoZXJyb3IgYXMgTm9kZUpTLkVycm5vRXhjZXB0aW9uKS5jb2RlID09PSBcIkVOT0VOVFwiKSByZXR1cm4gW107XG4gICAgdGhyb3cgZXJyb3I7XG4gIH1cblxuICBjb25zdCBzZXNzaW9ucyA9IGF3YWl0IFByb21pc2UuYWxsKFxuICAgIGVudHJpZXNcbiAgICAgIC5maWx0ZXIoKGVudHJ5KSA9PiBlbnRyeS5zdGFydHNXaXRoKFwiZGVidWctXCIpICYmIGVudHJ5LmVuZHNXaXRoKFwiLm5kanNvblwiKSlcbiAgICAgIC5tYXAoYXN5bmMgKGVudHJ5KSA9PiB7XG4gICAgICAgIGNvbnN0IGZ1bGxQYXRoID0gcGF0aC5qb2luKGRlYnVnRGlyLCBlbnRyeSk7XG4gICAgICAgIGNvbnN0IHN0YXQgPSBhd2FpdCBmcy5zdGF0KGZ1bGxQYXRoKTtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICBzZXNzaW9uX2lkOiBlbnRyeS5zbGljZShcImRlYnVnLVwiLmxlbmd0aCwgLVwiLm5kanNvblwiLmxlbmd0aCksXG4gICAgICAgICAgZmlsZTogZnVsbFBhdGgsXG4gICAgICAgICAgc2l6ZTogc3RhdC5zaXplLFxuICAgICAgICAgIHVwZGF0ZWRfYXQ6IHN0YXQubXRpbWUudG9JU09TdHJpbmcoKSxcbiAgICAgICAgfTtcbiAgICAgIH0pLFxuICApO1xuXG4gIHJldHVybiBzZXNzaW9ucy5zb3J0KChhLCBiKSA9PiBiLnVwZGF0ZWRfYXQubG9jYWxlQ29tcGFyZShhLnVwZGF0ZWRfYXQpKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gcmVhZFNlc3Npb25UYWlsKGRlYnVnRGlyOiBzdHJpbmcsIHNlc3Npb25JZDogc3RyaW5nLCBsaW5lQ291bnQ6IG51bWJlcik6IFByb21pc2U8c3RyaW5nPiB7XG4gIGNvbnN0IGZpbGUgPSBzZXNzaW9uRmlsZShkZWJ1Z0Rpciwgc2Vzc2lvbklkKTtcbiAgbGV0IGNvbnRlbnQ6IHN0cmluZztcbiAgdHJ5IHtcbiAgICBjb250ZW50ID0gYXdhaXQgZnMucmVhZEZpbGUoZmlsZSwgXCJ1dGY4XCIpO1xuICB9IGNhdGNoIChlcnJvcikge1xuICAgIGlmICgoZXJyb3IgYXMgTm9kZUpTLkVycm5vRXhjZXB0aW9uKS5jb2RlID09PSBcIkVOT0VOVFwiKSByZXR1cm4gXCJcIjtcbiAgICB0aHJvdyBlcnJvcjtcbiAgfVxuXG4gIGNvbnN0IGxpbmVzID0gY29udGVudC50cmltRW5kKCkuc3BsaXQoL1xccj9cXG4vKTtcbiAgcmV0dXJuIGAke2xpbmVzLnNsaWNlKC1NYXRoLm1heCgxLCBNYXRoLm1pbihsaW5lQ291bnQsIDUwMDApKSkuam9pbihcIlxcblwiKX1cXG5gO1xufVxuXG5mdW5jdGlvbiBzZXNzaW9uRmlsZShkZWJ1Z0Rpcjogc3RyaW5nLCBzZXNzaW9uSWQ6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBwYXRoLmpvaW4oZGVidWdEaXIsIGBkZWJ1Zy0ke3Nhbml0aXplU2Vzc2lvbklkKHNlc3Npb25JZCl9Lm5kanNvbmApO1xufVxuIiwgImNvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9kaXJuYW1lID0gXCJEOlxcXFxDb2Rlc1xcXFxrYWJlZ2FtZVwiO2NvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9maWxlbmFtZSA9IFwiRDpcXFxcQ29kZXNcXFxca2FiZWdhbWVcXFxcdml0ZS5jb25maWcucHViLnRzXCI7Y29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2ltcG9ydF9tZXRhX3VybCA9IFwiZmlsZTovLy9EOi9Db2Rlcy9rYWJlZ2FtZS92aXRlLmNvbmZpZy5wdWIudHNcIjtpbXBvcnQgeyBVc2VyQ29uZmlnIH0gZnJvbSBcInZpdGVcIjtcbmltcG9ydCB2dWUgZnJvbSBcIkB2aXRlanMvcGx1Z2luLXZ1ZVwiO1xuLyoqIHZlbmRvcmVkIGVsZW1lbnQtcGx1cyBcdTY3MDkgMzEgXHU0RTJBIC50c3hcdUZGMDhmb3JtLWxhYmVsLXdyYXAgLyBkYXRlLXBpY2tlciAvIHRhYmxlLXYyIFx1N0I0OVx1RkYwOVx1RkYwQ1xuICogIFx1NkNBMVx1NjcwOVx1OEZEOVx1NEUyQVx1NjNEMlx1NEVGNiBlc2J1aWxkIFx1NEYxQVx1NjMwOSBSZWFjdCBcdThCRURcdTRFNDlcdTdGMTZcdThCRDEgSlNYXHVGRjBDXHU4RkQwXHU4ODRDXHU2NUY2XHU2MkE1IGBSZWFjdCBpcyBub3QgZGVmaW5lZGAgKi9cbmltcG9ydCB2dWVKc3ggZnJvbSBcIkB2aXRlanMvcGx1Z2luLXZ1ZS1qc3hcIjtcbmltcG9ydCBwYXRoIGZyb20gXCJwYXRoXCI7XG5pbXBvcnQgVW5vQ1NTIGZyb20gXCJ1bm9jc3Mvdml0ZVwiO1xuaW1wb3J0IHsgZ2V0RGV2U2VydmVySG9zdCB9IGZyb20gXCIuL3NjcmlwdHMvdXRpbHNcIjtcbmltcG9ydCB7IGthYmVnYW1lRGVidWdTZXJ2ZXIgfSBmcm9tIFwiLi9zY3JpcHRzL3ZpdGUtZGVidWctc2VydmVyXCI7XG5cbmV4cG9ydCBjb25zdCByb290ID0gX19kaXJuYW1lO1xuXG4vLyBcdTUyMjRcdTY1QURcdTY2MkZcdTU0MjZcdTRFM0EgV2luZG93cyBcdTVFNzNcdTUzRjBcdUZGMDhcdTdBOTdcdTUzRTNcdTZBMjFcdTVGMEZcdTRFQzVcdTU3MjggV2luZG93cyBcdTUzRUZcdTc1MjhcdUZGMDlcbmV4cG9ydCBjb25zdCBpc1dpbmRvd3MgPSBwcm9jZXNzLnBsYXRmb3JtID09PSBcIndpbjMyXCI7XG5leHBvcnQgY29uc3QgaXNMaW51eCA9IHByb2Nlc3MucGxhdGZvcm0gPT09IFwibGludXhcIjtcbmV4cG9ydCBjb25zdCBpc01hY09TID0gcHJvY2Vzcy5wbGF0Zm9ybSA9PT0gXCJkYXJ3aW5cIjtcbi8vIFx1NjYyRlx1NTQyNlx1NEUzQSBBbmRyb2lkIFx1Njc4NFx1NUVGQVx1RkYwOFRhdXJpIFx1Njc4NFx1NUVGQVx1NjVGNlx1OEJCRVx1N0Y2RSBUQVVSSV9QTEFURk9STVx1RkYwQ1x1NjIxNlx1OTAxQVx1OEZDNyBWSVRFX0FORFJPSUQgXHU2NjNFXHU1RjBGXHU2MzA3XHU1QjlBXHVGRjA5XG5leHBvcnQgY29uc3QgaXNBbmRyb2lkID1cbiAgcHJvY2Vzcy5lbnYuVEFVUklfUExBVEZPUk0gPT09IFwiYW5kcm9pZFwiIHx8XG4gIHByb2Nlc3MuZW52LlZJVEVfQU5EUk9JRCA9PT0gXCJ0cnVlXCI7XG5cbmV4cG9ydCBjb25zdCBpc1dlYiA9IHByb2Nlc3MuZW52LktBQkVHQU1FX01PREUgPT09IFwid2ViXCI7XG5leHBvcnQgY29uc3QgaXNEZWJ1Z0luZ2VzdEVuYWJsZWQgPSBwcm9jZXNzLmVudi5LQUJFR0FNRV9ERUJVR19JTkdFU1QgIT09IFwiZmFsc2VcIjtcblxuXG5leHBvcnQgZGVmYXVsdCB7XG4gIHBsdWdpbnM6IFtcbiAgICB2dWUoKSxcbiAgICB2dWVKc3goKSxcbiAgICBVbm9DU1MoKSxcbiAgICBrYWJlZ2FtZURlYnVnU2VydmVyKHtcbiAgICAgIHdvcmtzcGFjZVJvb3Q6IHJvb3QsXG4gICAgICBlbmFibGVkOiBpc0RlYnVnSW5nZXN0RW5hYmxlZCxcbiAgICAgIGFsbG93UmVtb3RlOiBpc0FuZHJvaWQgfHwgaXNXZWIsXG4gICAgfSksXG4gIF0sXG5cbiAgZGVmaW5lOiB7XG4gICAgX19ERVZfXzogcHJvY2Vzcy5lbnYuTk9ERV9FTlYgPT09IFwiZGV2ZWxvcG1lbnRcIixcbiAgICBfX1dJTkRPV1NfXzogIWlzQW5kcm9pZCAmJiAhaXNXZWIgJiYgaXNXaW5kb3dzLFxuICAgIF9fTElOVVhfXzogIWlzQW5kcm9pZCAmJiAhaXNXZWIgJiYgaXNMaW51eCxcbiAgICBfX01BQ09TX186ICFpc0FuZHJvaWQgJiYgIWlzV2ViICYmIGlzTWFjT1MsXG4gICAgX19BTkRST0lEX186IGlzQW5kcm9pZCxcbiAgICBfX1dFQl9fOiBpc1dlYixcbiAgICBfX0xJR0hUX01PREVfXzogaXNBbmRyb2lkLFxuICAgIC8vIFx1NTIwN1x1NjM2Mlx1NkI2NFx1NUYwMFx1NTE3M1x1Njc2NVx1NUYzQVx1NTIzNlx1OTFDRFx1NTQyRnZpdGVcdTY3MERcdTUyQTFcdTU2NjhcbiAgICBfX1JFQk9PVF9fOiB0cnVlLFxuICB9LFxuXG4gIC8vIFx1NEY3Rlx1NzUyOCBhcHBzL2thYmVnYW1lL3B1YmxpYyBcdTRGNUNcdTRFM0EgcHVibGljIFx1NzZFRVx1NUY1NVx1RkYwOG1haW4gYXBwIFx1NEUxM1x1NzUyOFx1RkYwOVxuICAvLyBcdTY4MzlcdTc2RUVcdTVGNTUgc3RhdGljIFx1NzY4NFx1NTE3MVx1NEVBQlx1OEQ0NFx1NkU5MFx1OTAxQVx1OEZDN1x1NjNEMlx1NEVGNlx1NTkwRFx1NTIzNlx1RkYwOFx1ODlDMVx1NEUwQlx1NjVCOVx1NjNEMlx1NEVGNlx1RkYwOVxuICBwdWJsaWNEaXI6IHBhdGgucmVzb2x2ZShyb290LCBcInN0YXRpY1wiKSxcblxuICBjbGVhclNjcmVlbjogZmFsc2UsXG4gIHNlcnZlcjoge1xuICAgIHBvcnQ6IDE0MjAsXG4gICAgc3RyaWN0UG9ydDogdHJ1ZSxcbiAgICAvLyBcdTY4NENcdTk3NjJcdTdBRUZcdTRFQzVcdTc2RDFcdTU0MkMgbG9jYWxob3N0XHVGRjFCQW5kcm9pZCBcdTc3MUZcdTY3M0FcdTYyMTYgd2ViIFx1NkEyMVx1NUYwRlx1OTcwMFx1NzZEMVx1NTQyQ1x1NjI0MFx1NjcwOVx1N0Y1MVx1NTM2MVx1NEVFNVx1NEZCRlx1OEJCRVx1NTkwN1x1OEZERVx1NjNBNVxuICAgIGhvc3Q6IGlzQW5kcm9pZCB8fCBpc1dlYixcbiAgICAvLyB3ZWJcdUZGMUFvcmlnaW4gXHU2MzA3XHU1NDExXHU1RjAwXHU1M0QxXHU2NzNBIElQXHVGRjBDXHU0RjdGXHU2RDRGXHU4OUM4XHU1NjY4XHU4QkJFXHU1OTA3XHU2QjYzXHU3ODZFXHU4OUUzXHU2NzkwIHNjcmlwdC9zb3VyY2UgbWFwIFx1N0I0OVx1OEJGN1x1NkM0Mlx1MzAwMlxuICAgIC8vIEFuZHJvaWQgXHU3NzFGXHU2NzNBL1x1NkEyMVx1NjJERlx1NTY2OFx1RkYxQWRldlVybCA9IGh0dHA6Ly9sb2NhbGhvc3Q6MTQyMFx1RkYwQ2ZvcmsgXHU3Njg0IGNhcmdvLXRhdXJpIFx1NEUwRFx1NTE4RFx1NjI4QVxuICAgIC8vIFx1NzcxRlx1NjczQSBkZXZVcmwgXHU2NTM5XHU1MTk5XHU2MjEwXHU1QzQwXHU1N0RGXHU3RjUxIElQXHVGRjA4cGF0Y2ggNVx1RkYwOVx1RkYwQ3N0b2NrIGFuZHJvaWQtc3R1ZGlvLXNjcmlwdCBcdTc2ODQgbG9jYWxob3N0XG4gICAgLy8gXHU1MjA2XHU2NTJGXHU4MUVBXHU1MkE4IGBhZGIgcmV2ZXJzZSB0Y3A6MTQyMCB0Y3A6MTQyMGBcdTIwMTRcdTIwMTRcdTk4NzVcdTk3NjIgSFRUUCBcdTdFQ0YgVVNCIFx1NTZERVx1NzNBRlx1NzZGNFx1OEZCRVx1NUYwMFx1NTNEMVx1NjczQVx1MzAwMlxuICAgIC8vIFx1NEY0NiB0YXVyaSB2MiBcdTc5RkJcdTUyQThcdTdBRUYgZGV2IFx1Njc4NFx1NUVGQVx1NjcwOSBQUk9YWV9ERVZfU0VSVkVSXHVGRjA4dGhpcmQvdGF1cmlcbiAgICAvLyBjcmF0ZXMvdGF1cmkvc3JjL21hbmFnZXIvd2Vidmlldy5yc1x1RkYwOVx1RkYwQ1x1OTg3NVx1OTc2Mlx1NUI5RVx1OTY0NVx1NzUzMSBodHRwOi8vdGF1cmkubG9jYWxob3N0IFx1ODFFQVx1NUI5QVx1NEU0OVx1NTM0Rlx1OEJBRVxuICAgIC8vIFx1NEVFM1x1NzQwNlx1NTJBMFx1OEY3RFx1RkYwQ1x1OEJFNVx1NEVFM1x1NzQwNlx1NTNFQVx1OEY2Q1x1NTNEMSBIVFRQXHUzMDAxXHU0RTBEXHU4RjZDXHU1M0QxIFdlYlNvY2tldCB1cGdyYWRlXHVGRjBDbG9jYXRpb24gXHU2RDNFXHU3NTFGXHU3Njg0XG4gICAgLy8gd3M6Ly90YXVyaS5sb2NhbGhvc3QgXHU1RkM1XHU3MTM2XHU1OTMxXHU4RDI1XHUzMDAyXHU2NTQ1XHU2MzA5XHU1Qjk4XHU2NUI5XHU2QTIxXHU2NzdGXHU2NjNFXHU1RjBGXHU2MzA3XHU1QjlBIEhNUiBcdTc2RjRcdThGREVcdTU3MzBcdTU3NDBcdUZGMDhcdTRGMThcdTUxNDhcbiAgICAvLyBUQVVSSV9ERVZfSE9TVFx1MjAxNFx1MjAxNENMSSBcdTUxNkNcdTdGNTEgSVAgXHU2QTIxXHU1RjBGXHU0RTBCXHU2Q0U4XHU1MTY1XHVGRjFCXHU1NDI2XHU1MjE5IGxvY2FsaG9zdCBcdThENzAgYWRiIHJldmVyc2VcdUZGMDlcdUZGMUFcbiAgICAvLyBcdTUxNjhcdTUzQ0NcdTVERTVcdUZGMENcdTRFMTRcdTRFMERcdTdFQ0ZcdThCQkVcdTU5MDdcdTRGQTdcdTRFRTNcdTc0MDZcdUZGMDhDbGFzaCBcdTdCNDlcdTRGMUFcdTc4MzRcdTU3NEYgTEFOIFx1NzY4NCBXUyBVcGdyYWRlXHVGRjA5XHUzMDAyXG4gICAgLi4uKGlzV2ViID8geyBvcmlnaW46IGBodHRwOi8vJHtnZXREZXZTZXJ2ZXJIb3N0KCl9OjE0MjBgIH0gOiB7fSksXG4gICAgLi4uKGlzQW5kcm9pZFxuICAgICAgPyB7XG4gICAgICAgICAgaG1yOiB7XG4gICAgICAgICAgICBwcm90b2NvbDogXCJ3c1wiLFxuICAgICAgICAgICAgaG9zdDogcHJvY2Vzcy5lbnYuVEFVUklfREVWX0hPU1QgfHwgXCJsb2NhbGhvc3RcIixcbiAgICAgICAgICAgIHBvcnQ6IDE0MjAsXG4gICAgICAgICAgfSxcbiAgICAgICAgfVxuICAgICAgOiB7fSksXG4gICAgd2F0Y2g6IHtcbiAgICAgIGlnbm9yZWQ6IFtcbiAgICAgICAgXCIqKi9zcmMtdGF1cmkvKipcIiwgXG4gICAgICAgIFwiKiovdGhpcmQvKipcIiwgXG4gICAgICAgIFwiKiovc3JjLWNyYXdsZXItcGx1Z2lucy8qKlwiLCBcbiAgICAgICAgXCIqKi90YXJnZXQvKipcIiwgXG4gICAgICAgIFwiKiovbm9kZV9tb2R1bGVzLyoqXCIsXG4gICAgICAgIFwiKiovYmluLyoqXCIsXG4gICAgICBdLFxuICAgIH0sXG4gIH0sXG5cbiAgcmVzb2x2ZToge1xuICAgIGFsaWFzOiB7XG4gICAgICBcIkBcIjogcGF0aC5yZXNvbHZlKHByb2Nlc3MuY3dkKCksIFwic3JjXCIpLFxuICAgICAgLy8gdmVuZG9yZWQgZWxlbWVudC1wbHVzXHVGRjFBXHU1MzU1XHU1MzA1XHU1RTczXHU5NEZBXHVGRjA4ZGVubyBcdTRFMERcdThCQTRcdTVENENcdTU5NTdcdTVCNTAgd29ya3NwYWNlXHVGRjA5XHVGRjBDXHU2RTkwXHU3ODAxXHU3NkY0XHU2M0E1XHU2RDg4XHU4RDM5XHVGRjBDXG4gICAgICAvLyBhbGlhcyBcdTYzMDdcdTU0MTEgc3JjL1x1RkYwQ1x1NjVFMFx1Njc4NFx1NUVGQVx1NEVBN1x1NzI2OVx1MzAwMlxuICAgICAgXCJAa2FiZWdhbWUvZWxlbWVudC1wbHVzLWljb25zXCI6IHBhdGgucmVzb2x2ZShcbiAgICAgICAgcm9vdCxcbiAgICAgICAgXCJwYWNrYWdlc1wiLFxuICAgICAgICBcImthYmVnYW1lLWVsZW1lbnQtcGx1cy1pY29uc1wiLFxuICAgICAgICBcInNyY1wiXG4gICAgICApLFxuICAgICAgXCJAa2FiZWdhbWUvZWxlbWVudC1wbHVzXCI6IHBhdGgucmVzb2x2ZShcbiAgICAgICAgcm9vdCxcbiAgICAgICAgXCJwYWNrYWdlc1wiLFxuICAgICAgICBcImthYmVnYW1lLWVsZW1lbnQtcGx1c1wiLFxuICAgICAgICBcInNyY1wiXG4gICAgICApLFxuICAgICAgLy8gcGF0aHFsIFx1NzUxRlx1NjIxMFx1NUJBMlx1NjIzN1x1N0FFRjppbmRleC50cyBcdTRFM0FcdTc1MUZcdTYyMTBcdTcyNjlcdTRFMERcdTUxNjVcdTVFOTMoXHU1OTE2XHU1OEYzIHBhY2thZ2UuanNvbiBcdTUxNjVcdTVFOTMsXHU1MzA1XHU0RTNBXG4gICAgICAvLyB3b3Jrc3BhY2UgXHU2MjEwXHU1NDU4KSxcdTc1MzEgYGRlbm8gdGFzayBwYXRocWw6Z2VuZXJhdGVgIFx1NzUxRlx1NjIxMDtcdTdGM0FcdTY1ODdcdTRFRjZcdTY1RjZcdTUyNERcdTdBRUZcdTY3ODRcdTVFRkEvXG4gICAgICAvLyBcdTdDN0JcdTU3OEJcdTY4QzBcdTY3RTVcdTRGMUFcdTY2MEVcdTc4NkVcdTYyQTVcdTk1MTksXHU1MTQ4XHU4REQxIGdlbmVyYXRlXHUzMDAyXG4gICAgICBcIkBrYWJlZ2FtZS9wYXRocWwtY2xpZW50XCI6IHBhdGgucmVzb2x2ZShcbiAgICAgICAgcm9vdCxcbiAgICAgICAgXCJwYWNrYWdlc1wiLFxuICAgICAgICBcImthYmVnYW1lLXBhdGhxbC1jbGllbnRcIixcbiAgICAgICAgXCJpbmRleC50c1wiXG4gICAgICApLFxuICAgIH0sXG4gIH0sXG4gIGNzczoge1xuICAgIHByZXByb2Nlc3Nvck9wdGlvbnM6IHtcbiAgICAgIHNjc3M6IHtcbiAgICAgICAgYXBpOiBcIm1vZGVybi1jb21waWxlclwiLFxuICAgICAgfSxcbiAgICB9LFxuICB9LFxuXG4gIGVudlByZWZpeDogW1wiVklURV9cIiwgXCJUQVVSSV9cIl0sXG4gIG9wdGltaXplRGVwczoge1xuICAgIGVudHJpZXM6IFtwYXRoLnJlc29sdmUocHJvY2Vzcy5jd2QoKSwgXCJpbmRleC5odG1sXCIpXSxcbiAgICAvLyBcdTRFMERcdTk4ODRcdTY3ODRcdTVFRkFcdTY3MkNcdTU3MzAgcGhvdG9zd2lwZS12dWVcdUZGMENcdTU5Q0JcdTdFQzhcdTRFQ0VcdTZFOTBcdTc4MDFcdTdGMTZcdThCRDFcdUZGMENcdTY1MzlcdTUzMDVcdTUxODVcdTRFRTNcdTc4MDFcdTdBQ0JcdTUzNzNcdTc1MUZcdTY1NDhcbiAgICBleGNsdWRlOiBbXCJwaG90b3N3aXBlXCIsIFwicGhvdG9zd2lwZS9saWdodGJveFwiXSxcbiAgfSxcbiAgYnVpbGQ6IHtcbiAgICBvdXREaXI6IHBhdGgucmVzb2x2ZShyb290LCBgZGlzdC0ke3Byb2Nlc3MuZW52LktBQkVHQU1FX0NPTVBPTkVOVH1gKSxcbiAgICBlbXB0eU91dERpcjogdHJ1ZSxcbiAgICByZXBvcnRDb21wcmVzc2VkU2l6ZTogZmFsc2UsXG4gICAgdGFyZ2V0OiBbXCJlczIwMjFcIiwgXCJjaHJvbWUxMDBcIiwgXCJzYWZhcmkxM1wiXSxcbiAgICBtaW5pZnk6ICFwcm9jZXNzLmVudi5UQVVSSV9ERUJVRyA/IFwiZXNidWlsZFwiIDogZmFsc2UsXG4gICAgc291cmNlbWFwOiAhIXByb2Nlc3MuZW52LlRBVVJJX0RFQlVHLFxuICAgIGNodW5rU2l6ZVdhcm5pbmdMaW1pdDogMTAwMDAwMDAsXG4gICAgcm9sbHVwT3B0aW9uczoge1xuICAgICAgaW5wdXQ6IHtcbiAgICAgICAgaW5kZXg6IHBhdGgucmVzb2x2ZShwcm9jZXNzLmN3ZCgpLCBcImluZGV4Lmh0bWxcIiksXG4gICAgICB9LFxuICAgICAgb3V0cHV0OiB7XG4gICAgICAgIGlubGluZUR5bmFtaWNJbXBvcnRzOiB0cnVlLFxuICAgICAgICBtYW51YWxDaHVua3M6IHVuZGVmaW5lZCxcbiAgICAgIH0sXG4gICAgfSxcbiAgfSxcbn0gc2F0aXNmaWVzIFVzZXJDb25maWc7XG4iLCAiY29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2Rpcm5hbWUgPSBcIkQ6XFxcXENvZGVzXFxcXGthYmVnYW1lXFxcXGFwcHNcXFxca2FiZWdhbWVcIjtjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfZmlsZW5hbWUgPSBcIkQ6XFxcXENvZGVzXFxcXGthYmVnYW1lXFxcXGFwcHNcXFxca2FiZWdhbWVcXFxcdml0ZS5jb25maWcudHNcIjtjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfaW1wb3J0X21ldGFfdXJsID0gXCJmaWxlOi8vL0Q6L0NvZGVzL2thYmVnYW1lL2FwcHMva2FiZWdhbWUvdml0ZS5jb25maWcudHNcIjtpbXBvcnQgeyBkZWZpbmVDb25maWcsIFVzZXJDb25maWcgfSBmcm9tIFwidml0ZVwiO1xuaW1wb3J0IHBhdGggZnJvbSBcInBhdGhcIjtcblxuaW1wb3J0IHsgbWVyZ2UgfSBmcm9tIFwibG9kYXNoLWVzXCI7XG5cbmNvbnN0IHdlYkRldkFwaVRhcmdldCA9IFwiaHR0cDovLzEyNy4wLjAuMTo3NDkwXCI7XG5jb25zdCB3ZWJEZXZBcGlQcm94eVBhdGhzID0gW1xuICBcIi9ycGNcIixcbiAgXCIvZXZlbnRzXCIsXG4gIFwiL2FwaVwiLFxuICBcIi9maWxlXCIsXG4gIFwiL3RodW1ibmFpbFwiLFxuICBcIi9wbHVnaW5fZmlsZVwiLFxuICBcIi9wcm94eVwiLFxuICBcIi9tY3BcIixcbiAgXCIvX19waW5nXCIsXG5dO1xuZnVuY3Rpb24gZW5zdXJlV2ViRW52KG1vZGU6IHN0cmluZykge1xuICBpZiAobW9kZSAhPT0gXCJ3ZWJcIikgcmV0dXJuO1xuICBwcm9jZXNzLmVudi5LQUJFR0FNRV9NT0RFID8/PSBcIndlYlwiO1xuICBwcm9jZXNzLmVudi5WSVRFX0tBQkVHQU1FX01PREUgPz89IFwid2ViXCI7XG59XG5cbmV4cG9ydCBkZWZhdWx0IGRlZmluZUNvbmZpZyhhc3luYyAoeyBtb2RlIH0pID0+IHtcbiAgZW5zdXJlV2ViRW52KG1vZGUpO1xuXG4gIGNvbnN0IHsgZGVmYXVsdDogcHViQ29uZmlnLCByb290IH0gPSBhd2FpdCBpbXBvcnQoXCIuLi8uLi92aXRlLmNvbmZpZy5wdWJcIik7XG5cbiAgY29uc3QgaXNXZWIgPSBwcm9jZXNzLmVudi5LQUJFR0FNRV9NT0RFID09PSBcIndlYlwiIHx8IG1vZGUgPT09IFwid2ViXCI7XG4gIC8vIFx1NThDMVx1N0VCOFx1N0E5N1x1NTNFM1x1NEUwRVx1NEUzQlx1N0E5N1x1NTNFM1x1NTE3MVx1NzUyOCBpbmRleC5odG1sXHVGRjA4P3dpbmRvdz13YWxscGFwZXJcdUZGMENcdTc1MzEgbWFpbi50cyBcdTUyMDZcdTUzRDFcdUZGMDlcdUZGMENcdTRFMERcdTUxOERcdTUzNTVcdTVGMDBcdTUxNjVcdTUzRTNcdTMwMDJcbiAgY29uc3QgaGFzU3VyZk5hdmJhciA9ICFpc1dlYjtcbiAgY29uc3Qgcm9sbHVwSW5wdXQgPSB7XG4gICAgLi4uKGhhc1N1cmZOYXZiYXIgJiYgeyBcInN1cmYtbmF2YmFyXCI6IFwiLi9zdXJmLW5hdmJhci5odG1sXCIgfSksXG4gIH07XG4gIGNvbnN0IHdlYkRldkFwaVByb3h5ID0gaXNXZWJcbiAgICA/IE9iamVjdC5mcm9tRW50cmllcyhcbiAgICAgICAgd2ViRGV2QXBpUHJveHlQYXRocy5tYXAoKHApID0+IFtcbiAgICAgICAgICBwLFxuICAgICAgICAgIHtcbiAgICAgICAgICAgIHRhcmdldDogd2ViRGV2QXBpVGFyZ2V0LFxuICAgICAgICAgICAgY2hhbmdlT3JpZ2luOiB0cnVlLFxuICAgICAgICAgICAgd3M6IGZhbHNlLFxuICAgICAgICAgIH0sXG4gICAgICAgIF0pLFxuICAgICAgKVxuICAgIDogdW5kZWZpbmVkO1xuXG4gIHJldHVybiBtZXJnZTxVc2VyQ29uZmlnLCBVc2VyQ29uZmlnPihwdWJDb25maWcsIHtcbiAgICBzZXJ2ZXI6IHtcbiAgICAgIGFsbG93ZWRIb3N0czogdHJ1ZSxcbiAgICAgIHBvcnQ6IDE0MjAsXG4gICAgICAuLi4od2ViRGV2QXBpUHJveHkgJiYgeyBwcm94eTogd2ViRGV2QXBpUHJveHkgfSksXG4gICAgfSxcbiAgICBidWlsZDoge1xuICAgICAgLy8gXHU2ODRDXHU5NzYyL0FuZHJvaWQgXHU0RTBFIHdlYiBcdTc2ODRcdTRFQTdcdTcyNjlcdTc2RUVcdTVGNTVcdTVGQzVcdTk4N0JcdTUyMDZcdTVGMDBcdUZGMUFcdTRFMjRcdTgwMDVcdTc2ODRcdTVFNzNcdTUzRjAgZGVmaW5lXHVGRjA4X19XRUJfXyAvXG4gICAgICAvLyBfX01BQ09TX18gXHU3QjQ5XHVGRjA5XHUzMDAxcm9sbHVwIGlucHV0XHVGRjA4c3VyZi1uYXZiYXJcdUZGMDlcdTMwMDFjaHVua2luZyBcdTdCNTZcdTc1NjVcdTVCOENcdTUxNjhcbiAgICAgIC8vIFx1NEUwRFx1NTQwQ1x1RkYwQ1x1NTE3MVx1NzUyOFx1NEUwMFx1NEUyQVx1NzZFRVx1NUY1NVx1NjVGNlx1NTQwRVx1OEREMVx1NzY4NFx1Njc4NFx1NUVGQVx1NEYxQVx1OTc1OVx1OUVEOFx1ODk4Nlx1NzZENlx1NTI0RFx1ODAwNVx1MzAwMmJ1aWxkLXdlYi50cyBcdTY2MkZcdTMwMENcdTVCQkZcdTRFM0JcdTUxRkFcbiAgICAgIC8vIFx1NTI0RFx1N0FFRiBcdTIxOTIgXHU1QkI5XHU1NjY4XHU3RjE2IFJ1c3QgXHU1RDRDXHU1MTY1XHUzMDBEXHU0RTI0XHU2QkI1XHU1RjBGXHVGRjBDXHU0RTJEXHU5NUY0XHU4MkU1XHU2M0QyXHU1MTY1XHU0RTAwXHU2QjIxXHU2ODRDXHU5NzYyXHU2Nzg0XHU1RUZBXHVGRjBDd2ViIFx1NEU4Q1x1OEZEQlx1NTIzNlx1NUMzMVxuICAgICAgLy8gXHU0RjFBXHU1RDRDXHU1MjMwXHU2ODRDXHU5NzYyIGJ1bmRsZVx1RkYwOGludm9rZSBcdThENzAgX19UQVVSSV9JTlRFUk5BTFNfX1x1RkYwQ1x1NkQ0Rlx1ODlDOFx1NTY2OFx1OTFDQ1x1NTE2OFx1NjMwMlx1RkYwOVx1MzAwMlxuICAgICAgb3V0RGlyOiBwYXRoLnJlc29sdmUocm9vdCwgaXNXZWIgPyBcImRpc3Qta2FiZWdhbWUtd2ViXCIgOiBcImRpc3Qta2FiZWdhbWVcIiksXG4gICAgICBhc3NldHNJbmxpbmVMaW1pdDogKGZpbGVQYXRoKSA9PiB7XG4gICAgICAgIGlmIChmaWxlUGF0aC5pbmNsdWRlcyhcImljb24tc21hbGwucG5nXCIpKSB7XG4gICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgfSxcbiAgICAgIHJvbGx1cE9wdGlvbnM6IHtcbiAgICAgICAgaW5wdXQ6IHJvbGx1cElucHV0LFxuICAgICAgICBvdXRwdXQ6IHtcbiAgICAgICAgICBpbmxpbmVEeW5hbWljSW1wb3J0czogIWhhc1N1cmZOYXZiYXIgJiYgIWlzV2ViLFxuICAgICAgICAgIC4uLihpc1dlYiAmJiB7XG4gICAgICAgICAgICBtYW51YWxDaHVua3MoaWQ6IHN0cmluZykge1xuICAgICAgICAgICAgICAvLyB2ZW5kb3JlZCBcdTc2ODQgZWxlbWVudC1wbHVzIC8gaWNvbnMgXHU2NjJGXHU0RUQzXHU1MTg1XHU2RTkwXHU3ODAxXHVGRjA4cGFja2FnZXMva2FiZWdhbWUtZWxlbWVudC1wbHVzKlx1RkYwOVx1RkYwQ1xuICAgICAgICAgICAgICAvLyBcdTRFMERcdTU3Mjggbm9kZV9tb2R1bGVzIFx1NEUwQlx1RkYwQ1x1NUZDNVx1OTg3Qlx1NTcyOFx1NEUwQlx1OTc2Mlx1NzY4NCBub2RlX21vZHVsZXMgXHU5NUY4XHU5NUU4XHU0RTRCXHU1MjREXHU1MjI0XHU2Mzg5XHVGRjBDXG4gICAgICAgICAgICAgIC8vIFx1NTQyNlx1NTIxOVx1NEYxQVx1NjU3NFx1NTMwNVx1NUU3Nlx1OEZEQlx1NEUzQiBidW5kbGVcdTMwMDJcbiAgICAgICAgICAgICAgaWYgKGlkLmluY2x1ZGVzKFwicGFja2FnZXMva2FiZWdhbWUtZWxlbWVudC1wbHVzLWljb25zXCIpKSByZXR1cm4gXCJ2ZW5kb3ItZXAtaWNvbnNcIjtcbiAgICAgICAgICAgICAgaWYgKGlkLmluY2x1ZGVzKFwicGFja2FnZXMva2FiZWdhbWUtZWxlbWVudC1wbHVzXCIpKSByZXR1cm4gXCJ2ZW5kb3ItZWxlbWVudC1wbHVzXCI7XG4gICAgICAgICAgICAgIGlmICghaWQuaW5jbHVkZXMoXCJub2RlX21vZHVsZXNcIikpIHJldHVybiB1bmRlZmluZWQ7XG4gICAgICAgICAgICAgIGlmIChpZC5pbmNsdWRlcyhcInZhbnRcIikpIHJldHVybiBcInZlbmRvci12YW50XCI7XG4gICAgICAgICAgICAgIGlmIChpZC5pbmNsdWRlcyhcInBpbmlhXCIpIHx8IGlkLmluY2x1ZGVzKFwidnVlLXJvdXRlclwiKSkgcmV0dXJuIFwidmVuZG9yLXZ1ZS1yb3V0ZXJcIjtcbiAgICAgICAgICAgICAgaWYgKGlkLmluY2x1ZGVzKFwiQHZ1ZVwiKSB8fCBpZC5pbmNsdWRlcyhcIi92dWUvXCIpKSByZXR1cm4gXCJ2ZW5kb3ItdnVlXCI7XG4gICAgICAgICAgICAgIGlmIChpZC5pbmNsdWRlcyhcInBob3Rvc3dpcGVcIikpIHJldHVybiBcInZlbmRvci1waG90b3N3aXBlXCI7XG4gICAgICAgICAgICAgIHJldHVybiBcInZlbmRvclwiO1xuICAgICAgICAgICAgfSxcbiAgICAgICAgICB9KSxcbiAgICAgICAgfSxcbiAgICAgIH0sXG4gICAgfSxcbiAgICBwdWJsaWNEaXI6IFwiLi9wdWJsaWNcIixcbiAgfSk7XG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICI7Ozs7Ozs7Ozs7O0FBT0EsT0FBTyxVQUFVO0FBQ2pCLFNBQVMscUJBQXFCO0FBaUN2QixTQUFTLGFBQ2QsTUFDQSxNQUNRO0FBQ1IsUUFBTSxXQUFXLE1B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QUFDLGlCQUFpQixDQUFDQTtBQUFBLFVBQ3pDLEdBQUlBLFVBQVM7QUFBQSxZQUNYLGFBQWEsSUFBWTtBQUl2QixrQkFBSSxHQUFHLFNBQVMsc0NBQXNDLEVBQUcsUUFBTztBQUNoRSxrQkFBSSxHQUFHLFNBQVMsZ0NBQWdDLEVBQUcsUUFBTztBQUMxRCxrQkFBSSxDQUFDLEdBQUcsU0FBUyxjQUFjLEVBQUcsUUFBTztBQUN6QyxrQkFBSSxHQUFHLFNBQVMsTUFBTSxFQUFHLFFBQU87QUFDaEMsa0JBQUksR0FBRyxTQUFTLE9BQU8sS0FBSyxHQUFHLFNBQVMsWUFBWSxFQUFHLFFBQU87QUFDOUQsa0JBQUksR0FBRyxTQUFTLE1BQU0sS0FBSyxHQUFHLFNBQVMsT0FBTyxFQUFHLFFBQU87QUFDeEQsa0JBQUksR0FBRyxTQUFTLFlBQVksRUFBRyxRQUFPO0FBQ3RDLHFCQUFPO0FBQUEsWUFDVDtBQUFBLFVBQ0Y7QUFBQSxRQUNGO0FBQUEsTUFDRjtBQUFBLElBQ0Y7QUFBQSxJQUNBLFdBQVc7QUFBQSxFQUNiLENBQUM7QUFDSCxDQUFDOyIsCiAgIm5hbWVzIjogWyJfX2Rpcm5hbWUiLCAicGF0aCIsICJwYXRoIiwgInBhdGgiLCAicGF0aCIsICJyb290IiwgImlzV2ViIiwgInBhdGgiXQp9Cg==
