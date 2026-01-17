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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");

// 路径常量
export const RESOURCES_PLUGINS_DIR = path.join(
  root,
  "src-tauri",
  "app-main",
  "resources",
  "plugins"
);
export const RESOURCES_BIN_DIR = path.join(
  root,
  "src-tauri",
  "app-main",
  "resources",
  "bin"
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
    // 生命周期钩子
    this.hooks = {
      // 解析参数阶段
      parseParams: new SyncHook(["context", "rawOptions"]),
      
      // 执行命令阶段
      executeCommand: new AsyncSeriesHook(["context"]),
      
      // 构建前阶段
      beforeBuild: new AsyncSeriesHook(["context"]),
      
      // 构建阶段（并行）
      build: new AsyncParallelHook(["context", "component"]),
      
      // 构建后阶段
      afterBuild: new AsyncSeriesHook(["context"]),
      
      // 清理阶段
      cleanup: new SyncHook(["context"]),
    };

    // 插件列表
    this.plugins = [];
    
    // 插件注册状态
    this._pluginsRegistered = false;
  }

  /**
   * 注册插件
   */
  use(plugin) {
    if (!plugin || typeof plugin.apply !== "function") {
      throw new Error(`插件必须实现 apply 方法`);
    }
    this.plugins.push(plugin);
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
    this.use(new commands.BuildCommandPlugin());
    this.use(new commands.DevCommandPlugin());
    this.use(new commands.StartCommandPlugin());

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
      const components = ["plugin-editor", "cli", "daemon"].filter(c => 
        context.wants(c) || (c === "daemon" && context.wants("main") && context.os.isLinux)
      );
      await Promise.all(
        components.map(component =>
          this.hooks.build.promise(context, component)
        )
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
}
