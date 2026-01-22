#!/usr/bin/env node
/**
 * 基于 Tapable 的构建系统
 *
 * 使用钩子系统组织构建流程，支持插件化扩展
 */

import { AsyncSeriesHook, AsyncParallelHook, SyncHook } from "tapable";
import path from "path";
import fs from "fs";
import chalk from "chalk";
import { fileURLToPath } from "url";
import { Component, ComponentPlugin } from "./plugins/component-plugin.js";
import { ModePlugin } from "./plugins/mode-plugin.js";
import { DesktopPlugin } from "./plugins/desktop-plugin.js";
import { TracePlugin } from "./plugins/trace-plugin.js";
import { Cmd } from "./run.js";
import { OSPlugin } from "./plugins/os-plugn.js";
import { SyncWaterfallHook } from "tapable";
import { run } from "./build-utils.js";
import { features } from "process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");

// 路径常量
export const RESOURCES_PLUGINS_DIR = path.join(
  root,
  "src-tauri",
  "app-main",
  "resources",
  "plugins",
);
export const RESOURCES_BIN_DIR = path.join(
  root,
  "src-tauri",
  "app-main",
  "resources",
  "bin",
);
export const SRC_TAURI_DIR = path.join(root, "src-tauri");
export const TAURI_APP_MAIN_DIR = path.join(SRC_TAURI_DIR, "app-main");

/**
 * 构建上下文
 */
export class BuildContext {
  constructor() {
    // 命令
    this.command = null; // "build" | "dev" | "start"

    // 解析后的参数
    this.component = "all";
    this.mode = "normal";
    this.desktop = null;
    this.trace = false;
    this.os = null;

    // 原始选项（传递给工具函数）
    this.options = {};

    // 构建环境
    this.env = {};
    this.builtinPlugins = [];

    // 资源
    this.resources = {
      dokan2Dll: null,
      dokanInstaller: null,
      binaries: new Set(),
    };

    // 命令参数（由插件设置）
    this.commandArgs = {
      tauri: [],
      cargo: [],
      pnpm: [],
    };
  }

  /**
   * 检查是否需要构建某个组件
   */
  wants(component) {
    return this.component === "all" || this.component === component;
  }
}

/**
 * 构建系统核心类
 */
export class BuildSystem {
  constructor() {
    this.options = Object.freeze({});
    // 生命周期钩子
    this.hooks = {
      // 解析参数阶段
      parseParams: new SyncHook(),

      // 准备环境变量阶段
      prepareEnv: new SyncHook(),

      // 预处理阶段（主要是打包rhai插件）
      beforeBuild: new SyncHook(["comp"]),

      // 准备命令参数阶段（参数为 comp，如 Component.MAIN，没传则默认为当前上下文组件）
      prepareFeatures: new SyncWaterfallHook(["comp"]),

      // 构建后阶段
      afterBuild: new AsyncSeriesHook(["comp"]),
    };

    this.context = {
      cmd: null, // "build" / "dev" / "start"
    };
  }

  /**
   * 注册插件
   */
  use(plugin) {
    if (!plugin || typeof plugin.apply !== "function") {
      throw new Error(`插件必须实现 apply 方法`);
    }
    plugin.apply(this);
  }

  /**
   * 注册内置插件
   */
  async registerBuiltinPlugins() {
    // 导入所有插件
    const [parse, commands, build] = await Promise.all([
      import("./plugins/parse-plugins.js"),
      import("./plugins/command-plugins.js"),
      import("./plugins/build-plugins.js"),
    ]);

    // 注册解析插件
    this.use(new parse.ComponentParsePlugin());
    this.use(new parse.DesktopParsePlugin());
    this.use(new parse.ModeParsePlugin());
    this.use(new parse.OSParsePlugin());
    this.use(new parse.TraceParsePlugin());
    this.use(new parse.OptionsParsePlugin());

    // 注册命令插件
    this.use(new commands.PluginPackagePlugin());
    this.use(new commands.BuildCommandPlugin());
    this.use(new commands.DevCommandPlugin());
    this.use(new commands.StartCommandPlugin());
    this.use(new commands.CopyPostProcessPlugin());

    // 注册构建插件
    this.use(new build.PrepareEnvPlugin());
    this.use(new build.PackagePluginsPlugin());
    this.use(new build.ScanBuiltinPluginsPlugin());
    this.use(new build.PrepareResourcesPlugin());
    this.use(new build.BuildFrontendPlugin());
    this.use(new build.BuildRustPlugin());
    this.use(new build.StageBinariesPlugin());
    this.use(new build.BuildMainAppPlugin());
    this.use(new build.PostProcessPlugin());
  }

  /**
   * 解析参数
   */
  parseParams(context, rawOptions) {
    this.hooks.parseParams.call(context, rawOptions);
  }

  /**
   * 执行命令
   */
  async executeCommand(context) {
    await this.hooks.executeCommand.promise(context);
  }

  /**
   * 执行构建流程（用于 build 命令）
   */
  async executeBuild(context) {
    try {
      // 构建前
      await this.hooks.beforeBuild.promise(context);

      // 构建（并行）
      const components = ["plugin-editor", "cli", "daemon"].filter(
        (c) =>
          context.wants(c) ||
          (c === "daemon" && context.wants("main") && context.os.isLinux),
      );
      await Promise.all(
        components.map((component) =>
          this.hooks.build.promise(context, component),
        ),
      );

      // 构建主应用（在所有其他组件构建完成后）
      if (context.wants("main")) {
        await this.hooks.build.promise(context, null);
      }

      // 构建后
      await this.hooks.afterBuild.promise(context);

      // 清理
      this.hooks.cleanup.call(context);

      console.log(chalk.green(`[build-system] 构建完成`));
    } catch (error) {
      console.error(chalk.red(`[build-system] 构建失败: ${error.message}`));
      throw error;
    }
  }

  /**
   * 预处理阶段
   */
  async prepare(context) {
    await this.hooks.beforeBuild.promise(context);
  }

  /**
   * 执行 dev 命令
   */
  async executeDev(context) {
    // 验证组件
    if (context.component === "unknown" || !context.component) {
      console.error(
        chalk.red(
          `❌ 参数错误：dev 必须指定 -c main 或 -c plugin-editor（当前: ${String(
            context.component,
          )}）`,
        ),
      );
      process.exit(1);
    }

    if (context.component === "cli") {
      console.error(chalk.red(`❌ CLI 不需要 dev，请使用: pnpm start -c cli`));
      process.exit(1);
    }

    // 设置命令参数
    this.hooks.prepareFeatures.call(context);

    // 启动 Tauri dev
    await this.hooks.executeDev.promise(context);
  }

  /**
   * 执行 start 命令
   */
  async executeStart(context) {
    // 设置命令参数
    this.hooks.prepareFeatures.call(context);

    // 启动应用
    await this.hooks.executeStart.promise(context);
  }

  /**
   * 后处理阶段
   */
  async postProcess(context) {
    await this.hooks.afterBuild.promise(context);
    this.hooks.cleanup.call(context);
  }

  /**
   * 运行（主入口）
   */
  async run(command, rawOptions) {
    // 确保插件已注册（只注册一次）
    if (!this._pluginsRegistered) {
      await this.registerBuiltinPlugins();
      this._pluginsRegistered = true;
    }

    const context = new BuildContext();
    context.command = command;

    // 解析参数
    this.parseParams(context, rawOptions);

    // 执行命令
    await this.executeCommand(context);
  }

  commonUse() {
    this.use(new OSPlugin());
    // --component
    this.use(new ComponentPlugin());

    // --mode
    this.use(new ModePlugin());

    // --desktop
    this.use(new DesktopPlugin());

    // --trace
    this.use(new TracePlugin());
  }

  commonBefore() {
    this.hooks.parseParams.call();
    this.hooks.prepareEnv.call();
  }

  /**
   * 构建命令
   */
  async dev(options) {
    this.context.cmd = new Cmd(Cmd.DEV);
    this.options = Object.freeze(options);

    this.commonUse();
    this.commonBefore();
    this.hooks.beforeBuild.call();
    const { features } = this.hooks.prepareFeatures.call();
    run(
      "tauri",
      ["dev", "--features", features.join(","), ...this.options.args],
      {
        cwd: this.context.component.appDir,
        bin: "cargo",
      },
    );
  }

  async start(options) {
    this.context.cmd = new Cmd(Cmd.START);
    this.options = Object.freeze(options);

    this.commonUse();
    this.commonBefore();
    const { features } = this.hooks.prepareFeatures.call();
    const args = [
      "run",
      "-p",
      this.context.component.cargoComp,
      "--features",
      features.join(","),
      "--bin",
      Component.cargoComp(Component.CLI),
    ];

    if (this.options.args && this.options.args.length > 0) {
      args.push("--");
      args.push(...this.options.args);
    }

    run("cargo", args, {
      cwd: SRC_TAURI_DIR,
    });
  }

  async build(options) {
    this.context.cmd = new Cmd(Cmd.BUILD);
    this.options = Object.freeze(options);

    this.commonUse();
    this.commonBefore();
    if (this.context.component.isDaemon) {
      this.hooks.beforeBuild.call(Component.DAEMON);
      const { features } = this.hooks.prepareFeatures.call(Component.DAEMON);
      run("cargo", [
        "build",
        "--release",
        "-p",
        Component.cargoComp(Component.DAEMON),
        "--features",
        features.join(","),
        ...this.options.args,
      ]);
      // this.hooks.afterBuild.callAsync(Component.DAEMON)
    }
    if (this.context.component.isPluginEditor) {
      this.hooks.beforeBuild.call(Component.PLUGIN_EDITOR);
      const { features } = this.hooks.prepareFeatures.call(
        Component.PLUGIN_EDITOR,
      );
      run("bun", ["--cwd", Component.appDir(Component.PLUGIN_EDITOR), "build"]);
      run(
        "cargo",
        [
          "build",
          "--release",
          "-p",
          Component.cargoComp(Component.PLUGIN_EDITOR),
          "--features",
          features.join(","),
          ...this.options.args,
        ],
        {
          cwd: SRC_TAURI_DIR,
        },
      );
      // this.hooks.afterBuild.callAsync(Component.PLUGIN_EDITOR)
    }
    if (this.context.component.isCli) {
      this.hooks.beforeBuild.call(Component.CLI);
      const { features } = this.hooks.prepareFeatures.call(Component.CLI);
      run("bun", ["--cwd", Component.appDir(Component.CLI), "build"]);
      run(
        "cargo",
        [
          "build",
          "--release",
          "-p",
          Component.cargoComp(Component.CLI),
          "--features",
          features.join(","),
          ...this.options.args,
        ],
        {
          cwd: SRC_TAURI_DIR,
        },
      );
      // this.hooks.afterBuild.callAsync(Component.CLI)
    }
    if (this.context.component.isMain) {
      this.hooks.beforeBuild.call(Component.MAIN);
      const { features } = this.hooks.prepareFeatures.call(Component.MAIN);
      run(
        "tauri",
        ["build", "--features", features.join(","), ...this.options.args],
        {
          cwd: Component.appDir(Component.MAIN),
          bin: "cargo",
        },
      );
      // TODO: 添加linux脚本到deb包中
      // this.hooks.afterBuild.callAsync(Component.MAIN)
    }
  }
}
