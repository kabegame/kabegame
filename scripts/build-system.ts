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
import { Cmd } from "./run.ts";
import { OSPlugin } from "./plugins/os-plugin.js";
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

interface BuildOptions {
  component?: string;
  mode?: string;
  desktop?: string;
  verbose?: boolean;
  trace?: boolean;
  args?: string[];
}

interface BuildContext {
  cmd: Cmd | null;
  component?: Component;
  mode?: any;
  desktop?: any;
}

interface BuildHooks {
  parseParams: SyncHook<[]>;
  prepareEnv: SyncHook<[]>;
  beforeBuild: SyncHook<[string?]>;
  prepareFeatures: SyncWaterfallHook<[any?], any>;
  afterBuild: AsyncSeriesHook<[string]>;
}

/**
 * 构建系统核心类
 */
export class BuildSystem {
  public readonly options: Readonly<BuildOptions>;
  public readonly hooks: BuildHooks;
  public readonly context: BuildContext;

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
  use(plugin: any): void {
    if (!plugin || typeof plugin.apply !== "function") {
      throw new Error(`插件必须实现 apply 方法`);
    }
    plugin.apply(this);
  }

  getFeatureList(obj: any): string[] {
    return obj.features.keys().filter((f: string) => obj.features.get(f));
  }

  commonUse(): void {
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

  commonBefore(): void {
    this.hooks.parseParams.call();
    this.hooks.prepareEnv.call();
  }

  /**
   * dev 命令
   */
  async dev(options: BuildOptions): Promise<void> {
    this.context.cmd = new Cmd(Cmd.DEV);
    (this as any).options = Object.freeze(options);

    this.commonUse();
    this.commonBefore();
    this.hooks.beforeBuild.call();
    const { features } = this.hooks.prepareFeatures.call();
    run(
      "tauri",
      ["dev", "--features", features.join(","), ...(this.options.args || [])],
      {
        cwd: (this.context.component as any).appDir,
        bin: "cargo",
      },
    );
  }

  async start(options: BuildOptions): Promise<void> {
    this.context.cmd = new Cmd(Cmd.START);
    (this as any).options = Object.freeze(options);

    this.commonUse();
    this.commonBefore();
    const { features } = this.hooks.prepareFeatures.call();
    const args = [
      "run",
      "-p",
      (this.context.component as any).cargoComp,
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

  async build(options: BuildOptions): Promise<void> {
    this.context.cmd = new Cmd(Cmd.BUILD);
    (this as any).options = Object.freeze(options);

    this.commonUse();
    this.commonBefore();
    if ((this.context.component as any).isPluginEditor) {
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
          ...(this.options.args || []),
        ],
        {
          cwd: SRC_TAURI_DIR,
        },
      );
      // this.hooks.afterBuild.callAsync(Component.PLUGIN_EDITOR)
    }
    if ((this.context.component as any).isCli) {
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
          ...(this.options.args || []),
        ],
        {
          cwd: SRC_TAURI_DIR,
        },
      );
      // this.hooks.afterBuild.callAsync(Component.CLI)
    }
    if ((this.context.component as any).isMain) {
      this.hooks.beforeBuild.call(Component.MAIN);
      const { features } = this.hooks.prepareFeatures.call(Component.MAIN);
      run(
        "tauri",
        ["build", "--features", features.join(","), ...(this.options.args || [])],
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
