#!/usr/bin/env node
/**
 * 构建相关插件
 * 负责实际的构建工作
 */

import { BasePlugin } from "./base-plugin.js";
import chalk from "chalk";
import {
  run,
  scanBuiltinPlugins,
  buildEnv,
  ensureDokan2DllResource,
  ensureDokanInstallerResourceIfPresent,
  stageResourceBinary,
  resourceBinaryExists,
  copyDokan2DllToTauriReleaseDirBestEffort,
  SRC_TAURI_DIR,
  TAURI_APP_MAIN_DIR,
} from "../build-utils.js";
import path from "path";
import fs from "fs";

/**
 * 环境准备插件
 */
export class PrepareEnvPlugin extends BasePlugin {
  constructor() {
    super("PrepareEnvPlugin");
  }

  apply(buildSystem) {
    buildSystem.hooks.beforeBuild.tapPromise(this.name, async (context) => {
      context.env = buildEnv(context.options, context.builtinPlugins, context.trace);
    });
  }
}

/**
 * 插件打包插件
 */
export class PackagePluginsPlugin extends BasePlugin {
  constructor() {
    super("PackagePluginsPlugin");
  }

  apply(buildSystem) {
    buildSystem.hooks.beforeBuild.tapPromise(this.name, async (context) => {
      // 只在需要 main 或 plugin-editor 时打包插件
      if (!context.wants("main") && !context.wants("plugin-editor")) {
        return;
      }

      if (context.options.skipPluginsPackaging) {
        console.log(
          chalk.yellow(
            `[build] 跳过插件打包 (KABEGAME_SKIP_PLUGINS_PACKAGING=1)`
          )
        );
        return;
      }

      const packageTarget =
        context.mode === "local"
          ? "crawler-plugins:package-to-resources"
          : "crawler-plugins:package-local-to-resources";
      console.log(chalk.blue(`[build] 打包插件: ${packageTarget}`));
      run("nx", ["run", packageTarget], { env: context.env });
    });
  }
}

/**
 * 扫描内置插件插件
 */
export class ScanBuiltinPluginsPlugin extends BasePlugin {
  constructor() {
    super("ScanBuiltinPluginsPlugin");
  }

  apply(buildSystem) {
    buildSystem.hooks.beforeBuild.tapPromise(this.name, async (context) => {
      context.builtinPlugins = context.mode === "local" ? scanBuiltinPlugins() : [];
      
      // 重新准备环境（使用扫描到的内置插件）
      context.env = buildEnv(context.options, context.builtinPlugins);
    });
  }
}

/**
 * 准备资源插件
 */
export class PrepareResourcesPlugin extends BasePlugin {
  constructor() {
    super("PrepareResourcesPlugin");
  }

  apply(buildSystem) {
    buildSystem.hooks.beforeBuild.tapPromise(this.name, async (context) => {
      if (context.os.isWindows && context.wants("main")) {
        ensureDokan2DllResource();
        ensureDokanInstallerResourceIfPresent();
      }
    });
  }
}

/**
 * 构建前端插件
 */
export class BuildFrontendPlugin extends BasePlugin {
  constructor() {
    super("BuildFrontendPlugin");
  }

  apply(buildSystem) {
    buildSystem.hooks.build.tapPromise(this.name, async (context, component) => {
      if (component === "plugin-editor") {
        console.log(chalk.blue(`[build] 构建 plugin-editor 前端`));
        run("pnpm", ["-C", "apps/plugin-editor", "build"], { env: context.env });
      } else if (component === "cli") {
        console.log(chalk.blue(`[build] 构建 cli 前端`));
        run("pnpm", ["-C", "apps/cli", "build"], { env: context.env });
      }
    });
  }
}

/**
 * 构建 Rust 插件
 */
export class BuildRustPlugin extends BasePlugin {
  constructor() {
    super("BuildRustPlugin");
  }

  apply(buildSystem) {
    buildSystem.hooks.build.tapPromise(this.name, async (context, component) => {
      if (component === "plugin-editor") {
        console.log(chalk.blue(`[build] 构建 plugin-editor Rust 二进制`));
        run("cargo", ["build", "--release", "-p", "kabegame-plugin-editor"], {
          cwd: SRC_TAURI_DIR,
          env: context.env,
        });
      } else if (component === "cli") {
        console.log(chalk.blue(`[build] 构建 cli Rust 二进制`));
        run("cargo", ["build", "--release", "-p", "kabegame-cli"], {
          cwd: SRC_TAURI_DIR,
          env: context.env,
        });
      } else if (component === "daemon") {
        console.log(chalk.blue(`[build] 构建 daemon Rust 二进制`));
        run("cargo", ["build", "--release", "-p", "kabegame-daemon"], {
          cwd: SRC_TAURI_DIR,
          env: context.env,
        });
      }
    });
  }
}

/**
 * 准备二进制资源插件
 */
export class StageBinariesPlugin extends BasePlugin {
  constructor() {
    super("StageBinariesPlugin");
  }

  apply(buildSystem) {
    // 在构建后阶段执行（所有组件构建完成后）
    buildSystem.hooks.afterBuild.tapPromise(this.name, async (context) => {
      if (context.wants("plugin-editor")) {
        if (!resourceBinaryExists("kabegame-plugin-editor")) {
          stageResourceBinary("kabegame-plugin-editor");
        }
      }

      if (context.wants("cli")) {
        if (!resourceBinaryExists("kabegame-cli")) {
          stageResourceBinary("kabegame-cli");
        }
        if (!resourceBinaryExists("kabegame-cliw")) {
          stageResourceBinary("kabegame-cliw");
        }
      }

      // main 构建时确保依赖的二进制存在
      if (context.wants("main")) {
        const needCli =
          !resourceBinaryExists("kabegame-cli") ||
          !resourceBinaryExists("kabegame-cliw");
        if (needCli) {
          console.log(chalk.blue(`[build] 确保 cli 资源存在`));
          run("cargo", ["build", "--release", "-p", "kabegame-cli"], {
            cwd: SRC_TAURI_DIR,
            env: context.env,
          });
          stageResourceBinary("kabegame-cli");
          stageResourceBinary("kabegame-cliw");
        }

        const needEditor = !resourceBinaryExists("kabegame-plugin-editor");
        if (needEditor) {
          console.log(chalk.blue(`[build] 确保 plugin-editor 资源存在`));
          run("cargo", ["build", "--release", "-p", "kabegame-plugin-editor"], {
            cwd: SRC_TAURI_DIR,
            env: context.env,
          });
          stageResourceBinary("kabegame-plugin-editor");
        }
      }
    });
  }
}

/**
 * 构建主应用插件
 */
export class BuildMainAppPlugin extends BasePlugin {
  constructor() {
    super("BuildMainAppPlugin");
  }

  apply(buildSystem) {
    // 主应用构建在构建阶段执行，但在所有其他组件之后（component === null）
    buildSystem.hooks.build.tapPromise(this.name, async (context, component) => {
      // 只在构建主应用时执行（component === null 表示主应用）
      if (component !== null || !context.wants("main")) return;

      // Linux 上需要先构建所有二进制
      if (context.os.isLinux) {
        console.log(chalk.blue(`[build] 为 deb 包构建二进制 (daemon, cli, plugin-editor)`));
        run("cargo", ["build", "--release", "-p", "kabegame-daemon"], {
          cwd: SRC_TAURI_DIR,
          env: context.env,
        });
        
        if (!resourceBinaryExists("kabegame-cli")) {
          run("cargo", ["build", "--release", "-p", "kabegame-cli"], {
            cwd: SRC_TAURI_DIR,
            env: context.env,
          });
        }
        
        if (!resourceBinaryExists("kabegame-plugin-editor")) {
          run("pnpm", ["-C", "apps/plugin-editor", "build"], { env: context.env });
          run("cargo", ["build", "--release", "-p", "kabegame-plugin-editor"], {
            cwd: SRC_TAURI_DIR,
            env: context.env,
          });
        }
      }

      console.log(chalk.blue(`[build] 构建主应用 (bundle installer)`));
      run("tauri", ["build"], { cwd: TAURI_APP_MAIN_DIR, env: context.env });
      copyDokan2DllToTauriReleaseDirBestEffort();
    });
  }
}

/**
 * 后处理插件
 */
export class PostProcessPlugin extends BasePlugin {
  constructor() {
    super("PostProcessPlugin");
  }

  apply(buildSystem) {
    buildSystem.hooks.afterBuild.tapPromise(this.name, async (context) => {
      if (context.os.isLinux && context.wants("main")) {
        const postinstScript = path.join(TAURI_APP_MAIN_DIR, "scripts", "inject-deb-postinst.sh");
        if (fs.existsSync(postinstScript)) {
          console.log(chalk.blue(`[build] 注入 deb postinst 脚本`));
          try {
            run("bash", [postinstScript], { cwd: TAURI_APP_MAIN_DIR });
          } catch (error) {
            console.warn(
              chalk.yellow(`[build] 注入 deb 文件失败 (非致命): ${error.message}`)
            );
          }
        }
      }
    });
  }
}
