/**
 * kabegame-dev 的 stdio MCP。由 Claude Code 按 `.mcp.json` 拉起，和会话同生共死，不依赖 vite 活着：
 * 工具表是静态的，vite 不在时照常列出，调用时报是哪一层不在；vite 重启后 REST 没有会话要恢复，下一次调用自然就通。
 *
 * ```text
 * deno run --allow-net=127.0.0.1,localhost --allow-read --allow-write --allow-env apps/kabegame-dev-mcp/src/main.ts
 * ```
 *
 * - `--allow-net` 只给本机：REST 在 vite（`KABEGAME_DEV_SERVER_PORT`，缺省 1420）上；
 * - `--allow-write` 给落盘截图、画面哈希基线、测试工程清单；
 * - 不给 `--allow-run`：adb 只在 vite 里调。
 *
 * stdout 只给协议，日志一律写 stderr。
 */
import path from "node:path";
import process from "node:process";
import { McpServer, StdioServerTransport } from "./sdk.ts";
import { devPaths } from "../../../scripts/kabegame-dev/paths.ts";
import { createClient } from "./client.ts";
import { registerResources } from "./resources.ts";
import { registerTools } from "./tools.ts";
import type { DevMcpDeps } from "./tools.ts";

export const SERVER_NAME = "kabegame-dev";
export const SERVER_VERSION = "0.1.0";

const INSTRUCTIONS =
  "驱动跑着的 kabegame dev 应用（桌面 CEF，或经 adb 的安卓 WebView）：截图、求值、点击、调应用命令、场景宿主与渲染、画面哈希、测试工程导入 / 移除、读应用日志。" +
  "先调 status 看两层探活（vite 在不在；CDP 在不在）。dev 由用户在自己的终端启动（deno task dev -c kabegame，安卓加 --mode android），不要代起。" +
  "调用失败时结果以 [层] 开头说明是哪一层。测试工程只用 projects_remove 移除，绝不调 batch_delete_images。详见 .claude/skills/kabegame-chromium/SKILL.md。";

export const log = (message: string): void => {
  process.stderr.write(`[${SERVER_NAME}] ${message}\n`);
};

export function defaultDeps(): DevMcpDeps {
  const paths = devPaths();
  return { client: createClient(), root: paths.root, logDir: path.join(paths.devData, "logs"), log };
}

export function createDevMcpServer(deps: DevMcpDeps = defaultDeps()): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: INSTRUCTIONS });
  registerTools(server, deps);
  registerResources(server, deps);
  return server;
}

async function main(): Promise<void> {
  // 任何误写 stdout 的日志都会弄坏协议：console.log / info / debug 一律改到 stderr
  console.log = console.error;
  console.info = console.error;
  console.debug = console.error;
  const deps = defaultDeps();
  const server = createDevMcpServer(deps);
  const transport = new StdioServerTransport();
  transport.onclose = () => log("stdio 已关闭");
  await server.connect(transport);
  log(`已启动：REST ${deps.client.baseUrl}，日志目录 ${deps.logDir}`);
  process.stdin.on("end", () => {
    log("stdin 结束，退出");
    process.exit(0);
  });
}

// `import.meta.main`：Deno 与 Node 24+ 都有；根 tsconfig 的 lib 里没有 Deno 类型，这里收窄一下
if ((import.meta as ImportMeta & { main?: boolean }).main) {
  main().catch((error) => {
    log(`启动失败：${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    process.exit(1);
  });
}
