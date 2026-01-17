#!/usr/bin/env node
/**
 * 命令插件
 * build、dev、start 命令的实现
 */

import { BasePlugin } from "./base-plugin.js";
import chalk from "chalk";
import {
  run,
  spawnProc,
  scanBuiltinPlugins,
  buildEnv,
  getAppDir,
  ensureDokan2DllResource,
  ensureDokanInstallerResourceIfPresent,
  SRC_TAURI_DIR,
} from "../build-utils.js";
import { spawnSync } from "child_process";

/**
 * Build 命令插件
 * 执行生产构建
 */
export class BuildCommandPlugin extends BasePlugin {
  constructor() {
    super("BuildCommandPlugin");
  }

  apply(buildSystem) {
    buildSystem.hooks.executeCommand.tapPromise(this.name, async (context) => {
      if (context.command !== "build") return;

      // build 命令使用构建系统的完整流程
      await buildSystem.executeBuild(context);
    });
  }
}

/**
 * Dev 命令插件
 * 启动开发模式
 */
export class DevCommandPlugin extends BasePlugin {
  constructor() {
    super("DevCommandPlugin");
  }

  apply(buildSystem) {
    buildSystem.hooks.executeCommand.tapPromise(this.name, async (context) => {
      if (context.command !== "dev") return;

      const component = context.component;

      // 验证组件
      if (component === "unknown" || !component) {
        console.error(
          chalk.red(
            `❌ 参数错误：dev 必须指定 -c main 或 -c plugin-editor（当前: ${String(
              context.component
            )}）`
          )
        );
        process.exit(1);
      }
      
      if (component === "cli") {
        console.error(chalk.red(`❌ CLI 不需要 dev，请使用: pnpm start -c cli`));
        process.exit(1);
      }

      // 准备资源
      if (component === "main") {
        ensureDokan2DllResource();
        ensureDokanInstallerResourceIfPresent();
      }

      // 打包插件
      const packageTarget =
        context.mode === "local"
          ? "crawler-plugins:package-local-to-data"
          : "crawler-plugins:package-to-data";
      console.log(chalk.blue(`[dev] 打包插件到资源: ${packageTarget}`));
      run("nx", ["run", packageTarget], { env: buildEnv(context.options, [], context.trace) });

      // 扫描内置插件并构建最终环境
      const builtinPlugins = context.mode === "local" ? scanBuiltinPlugins() : [];
      const env = buildEnv(context.options, builtinPlugins, context.trace);

      // 启动 Tauri dev
      const children = [];
      const appDir = getAppDir(component);
      console.log(chalk.blue(`[dev] 启动 tauri dev: ${component}`));
      
      children.push(
        spawnProc("tauri", ["dev"], {
          env,
          cwd: appDir,
        })
      );

      // 设置进程管理
      const shutdown = () => {
        for (const c of children) {
          try {
            if (!c.killed && c.pid) {
              if (process.platform === "win32") {
                c.kill();
                setTimeout(() => {
                  try {
                    if (!c.killed && c.pid) {
                      spawnSync(
                        "taskkill",
                        ["/F", "/T", "/PID", c.pid.toString()],
                        {
                          stdio: "ignore",
                          shell: false,
                        }
                      );
                    }
                  } catch {}
                }, 2000);
              } else {
                c.kill("SIGTERM");
                setTimeout(() => {
                  try {
                    if (!c.killed) {
                      c.kill("SIGKILL");
                    }
                  } catch {}
                }, 2000);
              }
            }
          } catch {}
        }
      };

      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
      if (process.platform === "win32") {
        process.on("SIGBREAK", shutdown);
      }

      for (const c of children) {
        c.on("exit", (code) => {
          shutdown();
          process.exit(code ?? 0);
        });
      }
    });
  }
}

/**
 * Start 命令插件
 * 启动模式
 */
export class StartCommandPlugin extends BasePlugin {
  constructor() {
    super("StartCommandPlugin");
  }

  apply(buildSystem) {
    buildSystem.hooks.executeCommand.tapPromise(this.name, async (context) => {
      if (context.command !== "start") return;

      const component = context.component ?? "main";

      // cli/daemon 不需要打包前端资源
      if (component !== "cli" && component !== "daemon") {
        const packageTarget =
          context.mode === "local"
            ? "crawler-plugins:package-local-to-resources"
            : "crawler-plugins:package-to-resources";
        console.log(chalk.blue(`[start] 打包插件到资源: ${packageTarget}`));
        run("nx", ["run", packageTarget], { env: buildEnv(context.options, [], context.trace) });
      }

      const builtinPlugins = context.mode === "local" ? scanBuiltinPlugins() : [];
      const env = buildEnv(context.options, builtinPlugins, context.trace);

      if (component === "main") {
        ensureDokan2DllResource();
        ensureDokanInstallerResourceIfPresent();
      }

      if (component === "cli") {
        console.log(chalk.blue(`[start] 运行 cli`));
        run("cargo", ["run", "-p", "kabegame-cli"], { cwd: SRC_TAURI_DIR, env });
        return;
      }

      if (component === "daemon") {
        console.log(chalk.blue(`[start] 运行 daemon`));
        run("cargo", ["run", "-p", "kabegame-daemon"], { cwd: SRC_TAURI_DIR, env });
        return;
      }

      const appDir = getAppDir(component);
      console.log(chalk.blue(`[start] 启动 tauri dev: ${component}`));
      run("tauri", ["dev", "--no-watch"], { cwd: appDir, env });
    });
  }
}
