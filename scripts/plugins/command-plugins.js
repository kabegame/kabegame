#!/usr/bin/env node
/**
 * 命令插件
 * 根据选项调整环境变量和参数，不包含具体的执行逻辑
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
 * 插件打包插件
 * 处理插件打包逻辑
 */
export class PluginPackagePlugin extends BasePlugin {
  constructor() {
    super("PluginPackagePlugin");
  }

  apply(buildSystem) {
    // 在预处理阶段打包插件
    buildSystem.hooks.beforeBuild.tapPromise(this.name, async (context) => {
      await this.packagePlugins(context);
    });
  }

  async packagePlugins(context) {
    const command = context.command;
    const component = context.component;

    // dev 命令总是需要打包插件
    if (command === "dev") {
      const packageTarget =
        context.mode === "local"
          ? "crawler-plugins:package-local-to-data"
          : "crawler-plugins:package-to-data";
      console.log(chalk.blue(`[${command}] 打包插件到资源: ${packageTarget}`));
      run("nx", ["run", packageTarget], { env: context.env });
      return;
    }

    // start 命令只在非 cli/daemon 时打包插件
    if (command === "start" && component !== "cli" && component !== "daemon") {
      const packageTarget =
        context.mode === "local"
          ? "crawler-plugins:package-local-to-resources"
          : "crawler-plugins:package-to-resources";
      console.log(chalk.blue(`[${command}] 打包插件到资源: ${packageTarget}`));
      run("nx", ["run", packageTarget], { env: context.env });
      return;
    }

    // build 命令由 PackagePluginsPlugin 处理
  }
}

/**
 * Build 命令插件
 * 根据选项调整构建参数
 */
export class BuildCommandPlugin extends BasePlugin {
  constructor() {
    super("BuildCommandPlugin");
  }

  apply(buildSystem) {
    // 准备命令参数
    buildSystem.hooks.prepareCommandArgs.tap(this.name, (context) => {
      if (context.command !== "build") return;

      // 根据选项设置构建参数
      this.configureBuildArgs(context);
    });
  }

  configureBuildArgs(context) {
    // 构建主应用时的 features
    if (context.wants("main")) {
      const features = [];

      // 当不是 Windows、Linux、macOS 时添加 self-hosted feature
      const isStandardPlatform = context.os.isWindows || context.os.isLinux || context.os.isMacOS;
      if (!isStandardPlatform) {
        features.push("self-hosted");
        console.log(chalk.cyan(`[build] 检测到非标准平台，添加 self-hosted feature`));
      }

      // light 模式下添加 self-hosted feature
      if (context.mode === "light") {
        features.push("self-hosted");
        console.log(chalk.cyan(`[build] light 模式，添加 self-hosted feature`));
      }

      // 当 mode 不是 light 且目标不是 android 时添加 virtual-driver feature
      const shouldAddVirtualDriver = context.mode !== "light" && !context.os.isAndroid;
      if (shouldAddVirtualDriver) {
        features.push("virtual-driver");
        console.log(chalk.cyan(`[build] 添加 virtual-driver feature`));
      } else if (context.mode === "light") {
        console.log(chalk.cyan(`[build] light 模式，跳过 virtual-driver feature`));
      } else if (context.os.isAndroid) {
        console.log(chalk.cyan(`[build] Android 平台，跳过 virtual-driver feature`));
      }

      if (features.length > 0) {
        context.commandArgs.tauri.push("--features", features.join(","));
      }
    }
  }
}

/**
 * Dev 命令插件
 * 根据选项调整 dev 命令参数
 */
export class DevCommandPlugin extends BasePlugin {
  constructor() {
    super("DevCommandPlugin");
  }

  apply(buildSystem) {
    // 准备命令参数
    buildSystem.hooks.prepareCommandArgs.tap(this.name, (context) => {
      if (context.command !== "dev") return;

      this.configureDevArgs(context);
    });

    // 执行 dev 命令
    buildSystem.hooks.executeDev.tapPromise(this.name, async (context) => {
      if (context.command !== "dev") return;

      await this.executeDev(context);
    });
  }

  configureDevArgs(context) {
    // 基础 tauri dev 参数
    context.commandArgs.tauri = ["dev"];

    // 主应用特有的 features
    if (context.component === "main") {
      const features = [];

      // 当不是 Windows、Linux、macOS 时添加 self-hosted feature
      const isStandardPlatform = context.os.isWindows || context.os.isLinux || context.os.isMacOS;
      if (!isStandardPlatform) {
        features.push("self-hosted");
        console.log(chalk.cyan(`[dev] 检测到非标准平台，为 main 添加 self-hosted feature`));
      }

      // light 模式下添加 self-hosted feature
      if (context.mode === "light") {
        features.push("self-hosted");
        console.log(chalk.cyan(`[dev] light 模式，为 main 添加 self-hosted feature`));
      }

      // 当 mode 不是 light 且目标不是 android 时添加 virtual-driver feature
      const shouldAddVirtualDriver = context.mode !== "light" && !context.os.isAndroid;
      if (shouldAddVirtualDriver) {
        features.push("virtual-driver");
        console.log(chalk.cyan(`[dev] 为 main 添加 virtual-driver feature`));
      } else if (context.mode === "light") {
        console.log(chalk.cyan(`[dev] light 模式，跳过 virtual-driver feature`));
      } else if (context.os.isAndroid) {
        console.log(chalk.cyan(`[dev] Android 平台，跳过 virtual-driver feature`));
      }

      if (features.length > 0) {
        context.commandArgs.tauri.push("--features", features.join(","));
      }
    }
  }

  async executeDev(context) {
    const component = context.component;
    const appDir = getAppDir(component);

    console.log(chalk.blue(`[dev] 启动 tauri dev: ${component}`));

    const children = [];
    children.push(
      spawnProc("tauri", context.commandArgs.tauri, {
        env: context.env,
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
  }
}

/**
 * Start 命令插件
 * 根据选项调整 start 命令参数
 */
export class StartCommandPlugin extends BasePlugin {
  constructor() {
    super("StartCommandPlugin");
  }

  apply(buildSystem) {
    // 准备命令参数
    buildSystem.hooks.prepareCommandArgs.tap(this.name, (context) => {
      if (context.command !== "start") return;

      this.configureStartArgs(context);
    });

    // 执行 start 命令
    buildSystem.hooks.executeStart.tapPromise(this.name, async (context) => {
      if (context.command !== "start") return;

      await this.executeStart(context);
    });
  }

  configureStartArgs(context) {
    const component = context.component ?? "main";

    if (component === "cli") {
      context.commandArgs.cargo = ["run", "-p", "kabegame-cli"];
    } else if (component === "daemon") {
      context.commandArgs.cargo = ["run", "-p", "kabegame-daemon"];
    } else {
      // 主应用和插件编辑器
      context.commandArgs.tauri = ["dev", "--no-watch"];

      if (component === "main") {
        const features = [];

        // 当不是 Windows、Linux、macOS 时添加 self-hosted feature
        const isStandardPlatform = context.os.isWindows || context.os.isLinux || context.os.isMacOS;
        if (!isStandardPlatform) {
          features.push("self-hosted");
          console.log(chalk.cyan(`[start] 检测到非标准平台，为 main 添加 self-hosted feature`));
        }

        // light 模式下添加 self-hosted feature
        if (context.mode === "light") {
          features.push("self-hosted");
          console.log(chalk.cyan(`[start] light 模式，为 main 添加 self-hosted feature`));
        }

        // 当 mode 不是 light 且目标不是 android 时添加 virtual-driver feature
        const shouldAddVirtualDriver = context.mode !== "light" && !context.os.isAndroid;
        if (shouldAddVirtualDriver) {
          features.push("virtual-driver");
          console.log(chalk.cyan(`[start] 为 main 添加 virtual-driver feature`));
        } else if (context.mode === "light") {
          console.log(chalk.cyan(`[start] light 模式，跳过 virtual-driver feature`));
        } else if (context.os.isAndroid) {
          console.log(chalk.cyan(`[start] Android 平台，跳过 virtual-driver feature`));
        }

        if (features.length > 0) {
          context.commandArgs.tauri.push("--features", features.join(","));
        }
      }
    }
  }

  async executeStart(context) {
    const component = context.component ?? "main";

    if (component === "cli") {
      console.log(chalk.blue(`[start] 运行 cli`));
      run("cargo", context.commandArgs.cargo, { cwd: SRC_TAURI_DIR, env: context.env });
      return;
    }

    if (component === "daemon") {
      console.log(chalk.blue(`[start] 运行 daemon`));
      run("cargo", context.commandArgs.cargo, { cwd: SRC_TAURI_DIR, env: context.env });
      return;
    }

    const appDir = getAppDir(component);
    console.log(chalk.blue(`[start] 启动 tauri dev: ${component}`));
    run("tauri", context.commandArgs.tauri, { cwd: appDir, env: context.env });
  }
}

/**
 * 后处理插件
 * 处理复制等后处理操作
 */
export class CopyPostProcessPlugin extends BasePlugin {
  constructor() {
    super("CopyPostProcessPlugin");
  }

  apply(buildSystem) {
    // 在后处理阶段执行复制操作
    buildSystem.hooks.afterBuild.tapPromise(this.name, async (context) => {
      await this.performPostProcess(context);
    });
  }

  async performPostProcess(context) {
    // 这里可以添加各种复制操作，比如：
    // - 复制 DLL 文件到发布目录
    // - 复制其他资源文件
    // - 执行平台特定的后处理

    // 示例：Windows 平台复制 dokan2.dll
    if (context.os.isWindows && context.command === "build" && context.wants("main")) {
      // 这里可以调用 build-utils 中的复制函数
      console.log(chalk.blue(`[post-process] 执行平台特定的后处理操作`));
    }
  }
}
