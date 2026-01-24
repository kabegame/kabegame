#!/usr/bin/env bun
/**
 * 基于 Tapable 的构建系统
 *
 * 使用钩子系统组织构建流程，支持插件化扩展
 */

import { AsyncSeriesHook, SyncHook } from "tapable";
import path from "path";
import { fileURLToPath } from "url";
import { Component, ComponentPlugin } from "./plugins/component-plugin.js";
import { ModePlugin } from "./plugins/mode-plugin.js";
import { DesktopPlugin } from "./plugins/desktop-plugin.js";
import { TracePlugin } from "./plugins/trace-plugin.js";
import { Cmd } from "./run.ts";
import { OSPlugin } from "./plugins/os-plugin.js";
import { SyncWaterfallHook } from "tapable";
import { run } from "./build-utils.js";
import { BasePlugin } from "./plugins/base-plugin.ts";
import { Skip, SkipPlugin } from "./plugins/skip-plugin.js";

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
export const SRC_FE_DIR = path.join(root, "apps");
export const TAURI_APP_MAIN_DIR = path.join(SRC_TAURI_DIR, "app-main");

interface BuildOptions {
  component?: string;
  mode?: string;
  desktop?: string;
  verbose?: boolean;
  trace?: boolean;
  skip?: string;
  args?: string[];
}

interface BuildContext {
  cmd: Cmd | null;
  component?: Component;
  mode?: any;
  desktop?: any;
  skip?: Skip;
}

interface BuildHooks {
  parseParams: SyncHook<[]>;
  prepareEnv: SyncHook<[]>;
  beforeBuild: SyncHook<[string?]>;
  prepareCompileArgs: SyncWaterfallHook<
    [string?],
    { comp: Component; features: string[] }
  >;
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

      // 准备编译参数阶段（features 和 cfg 参数）
      prepareCompileArgs: new SyncWaterfallHook(["comp"]),

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
  use<T extends BasePlugin>(plugin: T): void {
    if (!plugin || typeof plugin.apply !== "function") {
      throw new Error(`插件必须实现 apply 方法`);
    }
    plugin.apply(this);
  }

  getFeatureList(obj: any): string[] {
    return obj.features.keys().filter((f: string) => obj.features.get(f));
  }

  /**
   * 将 features 和 cfgs 转换为 cargo 命令行参数
   */
  private buildCargoArgs(
    baseArgs: string[],
    features: string[],
    additionalArgs?: string[],
  ): string[] {
    const args = [...baseArgs];
    if (features.length > 0) {
      args.push("--features", features.join(","));
    }
    if (additionalArgs && additionalArgs.length > 0) {
      args.push(...additionalArgs);
    }
    return args;
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

    // --skip
    this.use(new SkipPlugin());
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
    const { features } = this.hooks.prepareCompileArgs.call();
    const args = this.buildCargoArgs(["dev"], features, this.options.args);
    run("tauri", args, {
      cwd: this.context.component!.appDir,
      bin: "cargo",
    });
  }

  async start(options: BuildOptions): Promise<void> {
    this.context.cmd = new Cmd(Cmd.START);
    // @ts-ignore
    this.options = Object.freeze(options);

    this.commonUse();
    this.commonBefore();
    const { features } = this.hooks.prepareCompileArgs.call();
    const baseArgs = ["run", "-p", this.context.component!.cargoComp];
    const args = this.buildCargoArgs(baseArgs, features);

    if (this.options.args && this.options.args.length > 0) {
      args.push("--");
      args.push(...this.options.args);
    }
    // 先构建前端资源
    run("nx", ["run", `.:build-${this.context.component!.comp}`], {
      bin: "bun",
    });
    run("cargo", args);
  }

  async build(options: BuildOptions): Promise<void> {
    this.context.cmd = new Cmd(Cmd.BUILD);
    (this as any).options = Object.freeze(options);

    this.commonUse();
    this.commonBefore();
    if (this.context.component!.isPluginEditor) {
      this.hooks.beforeBuild.call(Component.PLUGIN_EDITOR);
      const { features } = this.hooks.prepareCompileArgs.call(
        Component.PLUGIN_EDITOR,
      );
      if (!this.context.skip?.isVue) {
        run("nx", ["run", ".:build-plugin-editor"], {
          bin: "bun",
        });
      }
      const args = this.buildCargoArgs(
        [
          "build",
          "--release",
          "-p",
          Component.cargoComp(Component.PLUGIN_EDITOR),
        ],
        features,
        this.options.args,
      );
      if (!this.context.skip?.isCargo) {
        run("cargo", args, {
          cwd: SRC_TAURI_DIR,
        });
      }
      // this.hooks.afterBuild.callAsync(Component.PLUGIN_EDITOR)
    }
    if (this.context.component!.isCli) {
      this.hooks.beforeBuild.call(Component.CLI);
      const { features } = this.hooks.prepareCompileArgs.call(Component.CLI);
      if (!this.context.skip?.isVue) {
        run("nx", ["run", ".:build-cli"], {
          bin: "bun",
        });
      }
      const args = this.buildCargoArgs(
        ["build", "--release", "-p", Component.cargoComp(Component.CLI)],
        features,
        this.options.args,
      );
      if (!this.context.skip?.isCargo) {
        run("cargo", args, {
          cwd: SRC_TAURI_DIR,
        });
      }
      // this.hooks.afterBuild.callAsync(Component.CLI)
    }
    if (this.context.component!.isMain) {
      this.hooks.beforeBuild.call(Component.MAIN);
      const { features } = this.hooks.prepareCompileArgs.call(Component.MAIN);
      const args = this.buildCargoArgs(["build"], features, this.options.args);
      if (!this.context.skip?.isVue) {
        run("nx", ["run", ".:build-main"], {
          bin: "bun",
        });
      }
      run("tauri", args, {
        cwd: Component.appDir(Component.MAIN),
        bin: "cargo",
      });
      // TODO: 添加linux脚本到deb包中
      // this.hooks.afterBuild.callAsync(Component.MAIN)
    }
  }

  async check(options: BuildOptions): Promise<void> {
    this.context.cmd = new Cmd(Cmd.CHECK);
    (this as any).options = Object.freeze(options);

    this.commonUse();
    this.commonBefore();

    if (!this.context.skip?.isVue) {
      run("typecheck", [], {
        bin: "bun",
        cwd: this.context.component!.appFeDir,
      });
    }

    if (!this.context.skip?.isCargo) {
      this.hooks.prepareCompileArgs.call(this.context.component!.comp);
      run("cargo", ["check", "-p", this.context.component!.cargoComp]);
    }
  }
}
