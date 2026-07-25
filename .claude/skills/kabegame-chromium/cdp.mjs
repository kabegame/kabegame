#!/usr/bin/env node
// Kabegame CEF 的 CDP 客户端 —— 连上正在跑的 app，截图 / 执行 JS / 点击。
//
// 依赖仓库自带的 playwright-core。注意用的是 connectOverCDP（连接已有 browser），
// 不是 launch，所以**不需要** `npx playwright install` 下载任何浏览器二进制。
//
// 用法见 driver.sh；本文件一般不直接调用。

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const SKILL_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SKILL_DIR, "../../..");
// playwright-core 装在仓库根的 node_modules 里；脚本自身路径不参与解析，
// 所以显式以仓库根的 package.json 为解析基准。
const require = createRequire(path.join(ROOT, "package.json"));

let chromium;
try {
  ({ chromium } = require("playwright-core"));
} catch (e) {
  console.error(
    "[cdp] 无法加载 playwright-core。请在仓库根跑 `bun install` / `deno install` 恢复依赖。",
  );
  console.error(`[cdp] 原始错误: ${e.message}`);
  process.exit(3);
}

const argv = process.argv.slice(2);
const cmd = argv[0];

function flag(name, fallback = undefined) {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const next = argv[i + 1];
  if (next === undefined || next.startsWith("--")) return true;
  return next;
}
function positional(n) {
  const out = argv.slice(1).filter((a, i, arr) => {
    if (a.startsWith("--")) return false;
    const prev = arr[i - 1];
    // 跳过被 --flag 消费掉的值
    if (prev && prev.startsWith("--")) return false;
    return true;
  });
  return out[n];
}

// 不传 --url 时走 isMainWindow() 启发式，而不是简单子串匹配。
const urlFilter = flag("url", null);

const VITE_PORT = process.env.KABEGAME_DEV_SERVER_PORT || "1420";

/**
 * 解析 CDP 端口。dev 下端口是**随机**的，app 起来后会把号 POST 给 vite
 * （/__kabegame_cdp/register），所以这里只认死端口 1420 去要号。
 * 优先级：--port > $KABEGAME_CEF_DEBUG_PORT（driver.sh 会预解析好塞进来）> 问 vite。
 */
async function resolvePort() {
  const explicit = flag("port", process.env.KABEGAME_CEF_DEBUG_PORT || null);
  if (explicit && explicit !== true) return Number(explicit);

  try {
    const res = await fetch(`http://127.0.0.1:${VITE_PORT}/__kabegame_cdp`, {
      signal: AbortSignal.timeout(3_000),
    });
    if (res.ok) {
      const { port } = await res.json();
      if (Number.isInteger(port)) return port;
    }
  } catch {
    /* 落到下面的统一报错 */
  }

  console.error(
    `[cdp] 拿不到 CDP 端口：dev server（127.0.0.1:${VITE_PORT}）没应答，或还没有 app 上报端口。`,
  );
  console.error(`[cdp] 先确认 dev 在跑（deno task dev -c kabegame），或用 --port 显式指定。`);
  process.exit(4);
}

/**
 * 判定"主窗口"。实测 dev 下同时存在：
 *   http://localhost:1420/            ← 主窗口（SPA，路径随路由变）
 *   http://localhost:1420/wallpaper.html ← 壁纸窗口
 * 另外用户开了 crawler 任务 / surf 时还会有指向外部站点的窗口。
 * 注意 host 是 `localhost` 不是 `127.0.0.1`——按 host 硬匹配会全落空。
 */
function isMainWindow(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    return false;
  }
  // 只认应用自身的页面：dev 是 :1420，打包后是 tauri:// 自定义协议。
  const isAppOrigin = u.port === "1420" || u.protocol === "tauri:";
  if (!isAppOrigin) return false;
  // 排除 wallpaper.html 这类独立入口页；主窗口是 SPA，路径不带 .html。
  return !u.pathname.endsWith(".html");
}

async function connect() {
  const port = await resolvePort();
  // 不要把 http://host:port 直接交给 connectOverCDP：playwright 会拼成
  // `/json/version/`（尾斜杠），Chromium 的 DevTools HTTP 端点对此返回 400。
  // 自己取 webSocketDebuggerUrl 再连，顺带能给出更准确的诊断。
  let wsUrl;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    wsUrl = (await res.json()).webSocketDebuggerUrl;
    if (!wsUrl) throw new Error("响应里没有 webSocketDebuggerUrl");
  } catch (e) {
    console.error(`[cdp] 连不上 127.0.0.1:${port}（app 已退出？正在热重启？）`);
    console.error(`[cdp] 原始错误: ${e.message}`);
    process.exit(4);
  }

  try {
    return await chromium.connectOverCDP(wsUrl, { timeout: 15_000 });
  } catch (e) {
    console.error(`[cdp] CDP 握手失败（ws=${wsUrl}）: ${e.message}`);
    process.exit(4);
  }
}

/** 收集所有 context 下的 page，按 url 过滤 */
function collectPages(browser) {
  const pages = [];
  for (const ctx of browser.contexts()) {
    for (const p of ctx.pages()) pages.push(p);
  }
  return pages;
}

function pickPage(browser) {
  const pages = collectPages(browser);
  if (pages.length === 0) {
    console.error("[cdp] 该 browser 下没有任何 page。app 窗口是否已经渲染？");
    process.exit(5);
  }
  const listAll = () => pages.map((p) => `  - ${p.url()}`).join("\n");

  // 显式 --url：按子串匹配，用户说了算。
  if (urlFilter && urlFilter !== true) {
    const matched = pages.filter((p) => p.url().includes(urlFilter));
    if (matched.length === 0) {
      console.error(`[cdp] 没有 URL 含 "${urlFilter}" 的 page。现有 page:\n${listAll()}`);
      process.exit(5);
    }
    return matched[0];
  }

  // 默认：挑主窗口，避免截到壁纸窗口。
  const main = pages.filter((p) => isMainWindow(p.url()));
  if (main.length === 0) {
    console.error(
      `[cdp] 没找到主窗口（应用自身页面且非 *.html 入口）。现有 page:\n${listAll()}\n` +
        `[cdp] 可用 --url <子串> 显式指定。`,
    );
    process.exit(5);
  }
  return main[0];
}

async function main() {
  if (!cmd || cmd === "help" || cmd === "--help") {
    console.log(`用法: cdp.mjs <targets|shot|eval|click|text> [args] [--port N] [--url <substr>]

  targets                 列出所有 page 及其 URL
  shot <out.png> [--full] 截图（--full 整页；默认视口）
  eval '<js>'             在页面里求值，打印 JSON 结果
  click '<selector>'      点击元素（自动等待可见）
  text '<selector>'       打印元素文本

  --port N        CDP 端口；不传则向 vite dev server（127.0.0.1:${VITE_PORT}）
                  要 app 上报的随机端口
  --url <substr>  选择 URL 含该子串的 page
                  （不传则自动挑主窗口，排除 wallpaper.html 等辅助窗口）`);
    return 0;
  }

  const browser = await connect();

  try {
    if (cmd === "targets") {
      const pages = collectPages(browser);
      if (pages.length === 0) {
        console.log("(无 page)");
      }
      for (const p of pages) {
        let title = "";
        try {
          title = await p.title();
        } catch {
          /* 页面可能正在导航 */
        }
        console.log(`${p.url()}\t${title}`);
      }
      return 0;
    }

    const page = pickPage(browser);

    if (cmd === "shot") {
      const out = positional(0);
      if (!out) {
        console.error("[cdp] shot 需要输出路径，例如: shot /tmp/a.png");
        return 2;
      }
      const abs = path.resolve(out);
      await page.screenshot({ path: abs, fullPage: flag("full", false) === true });
      console.log(abs);
      return 0;
    }

    if (cmd === "eval") {
      const js = positional(0);
      if (!js) {
        console.error("[cdp] eval 需要一段 JS，例如: eval 'document.title'");
        return 2;
      }
      const result = await page.evaluate(`(() => (${js}))()`).catch(async (e) => {
        // 允许语句式输入（多行 / 带 return）
        if (String(e.message).includes("SyntaxError")) {
          return page.evaluate(`(() => { ${js} })()`);
        }
        throw e;
      });
      console.log(typeof result === "string" ? result : JSON.stringify(result, null, 2));
      return 0;
    }

    if (cmd === "click") {
      const sel = positional(0);
      if (!sel) {
        console.error("[cdp] click 需要选择器");
        return 2;
      }
      // 吉祥物 / 浮层等经常盖住目标，force 跳过 actionability 的遮挡检查。
      await page.locator(sel).first().click({ timeout: 10_000, force: true });
      console.log(`clicked: ${sel}`);
      return 0;
    }

    if (cmd === "text") {
      const sel = positional(0);
      if (!sel) {
        console.error("[cdp] text 需要选择器");
        return 2;
      }
      console.log(await page.locator(sel).first().innerText({ timeout: 10_000 }));
      return 0;
    }

    console.error(`[cdp] 未知子命令: ${cmd}（用 help 看用法）`);
    return 2;
  } finally {
    // connectOverCDP 的 close 只断开连接，不会关掉 app 本身。
    await browser.close().catch(() => {});
  }
}

main()
  .then((code) => process.exit(code ?? 0))
  .catch((e) => {
    console.error(`[cdp] 失败: ${e.message}`);
    process.exit(1);
  });
