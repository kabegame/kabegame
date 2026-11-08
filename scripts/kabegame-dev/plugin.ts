/**
 * vite 插件 `kabegame-dev`：持有到 app 的唯一 CDP 连接和状态（宿主句柄、控制台流、长任务），对外是
 * `/__kabegame_dev/*` 的 REST。不依赖任何 MCP 的东西：脚本用 fetch / curl 就能直接调。
 */
import type { Plugin } from "vite";
import { currentCdpRegistration } from "../vite-debug-server.ts";
import { createDevRuntime } from "./backend.ts";
import { devPaths } from "./paths.ts";

export interface KabegameDevOptions {
  workspaceRoot: string;
  android: boolean;
}

/**
 * dev 专用（apply: "serve"）。挂 /__kabegame_dev/* 的 REST；只接受回环地址，带 Origin 时只认 localhost / 127.0.0.1。
 * CDP 连接懒建立，断开后下次请求经 resolveEndpoint 重连。vite 关闭（含改配置自动重启）时关掉全部宿主句柄（移除屏外
 * iframe）、取消任务、断开 CDP。改本目录下任何文件都会让 vite 自己重启一次（它们是配置文件的依赖），app 页面随之
 * 整页刷新；句柄、任务、控制台流随旧插件实例一起没了，之后用旧 id 回 404。
 */
export function kabegameDev(options: KabegameDevOptions): Plugin {
  let shutdown: (() => Promise<void>) | null = null;
  return {
    name: "kabegame-dev",
    apply: "serve",
    configureServer(server) {
      const paths = devPaths(options.workspaceRoot);
      const runtime = createDevRuntime({
        paths,
        android: options.android,
        vitePort: server.config.server.port ?? 1420,
        readRegistration: () => currentCdpRegistration(paths.debugDir),
      });
      server.middlewares.use(runtime.handler);
      shutdown = runtime.shutdown;
      server.httpServer?.once("close", () => void runtime.shutdown());
    },
    async closeBundle() {
      await shutdown?.();
    },
  };
}
