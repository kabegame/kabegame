/**
 * 基于 Tapable 的构建系统
 *
 * 使用钩子系统组织构建流程，支持插件化扩展
 */

import { AsyncSeriesHook, SyncHook } from "tapable";
import path from "path";
import { existsSync } from "fs";
import { fileURLToPath } from "url";
import { Component, ComponentPlugin } from "./plugins/component-plugin.js";
import { Mode, ModePlugin } from "./plugins/mode-plugin.js";
import { TracePlugin } from "./plugins/trace-plugin.js";
import { Cmd, CmdPlugin } from "./plugins/cmd-plugin.ts";
import { OSPlugin } from "./plugins/os-plugin.js";
import { SyncWaterfallHook } from "tapable";
import { run } from "./utils.js";
import { BasePlugin } from "./plugins/base-plugin.ts";
import { Skip, SkipPlugin } from "./plugins/skip-plugin.js";
import { ReleasePlugin } from "./plugins/release-plugin.js";
import { DataPlugin } from "./plugins/data-plugin.js";

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
  data?: string;
  verbose?: boolean;
  trace?: boolean;
  skip?: string;
  release?: boolean;
  args?: string[];
  /** false 表示 --no-nx：不经 nx 构建 main 前端 */
  nx?: boolean;
}

interface BuildContext {
  cmd: Cmd;
  component?: Component;
  mode?: Mode;
  data?: string;
  skip?: Skip;
}

interface BuildHooks {
  parseParams: SyncHook<[]>;
  prepareEnv: SyncHook<[]>;
  beforeBuild: SyncHook<[string?]>;
  prepareCompileArgs: SyncWaterfallHook<
    [string?],
    { comp: Component; features: string[]; args?: string[] }
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
      //@ts-ignore
      cmd: null, // "build" / "dev" / "start" / "check"
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

  commonUse(cmd: string): void {
    this.use(new CmdPlugin(cmd));
    this.use(new OSPlugin());
    // --component
    this.use(new ComponentPlugin());

    // --mode (standard | light | android)
    this.use(new ModePlugin());

    // --release
    this.use(new ReleasePlugin());

    // --trace
    this.use(new TracePlugin());

    // --skip
    this.use(new SkipPlugin());

    // --data (dev | prod)
    this.use(new DataPlugin());
  }

  commonBefore(): void {
    this.hooks.parseParams.call();
    this.hooks.prepareEnv.call();
  }

  /**
   * dev 命令
   */
  async dev(options: BuildOptions): Promise<void> {
    //@ts-ignore
    this.options = Object.freeze(options);

    this.commonUse(Cmd.DEV);
    this.commonBefore();
    this.hooks.beforeBuild.call();
    const { features, args: compileArgs } = this.hooks.prepareCompileArgs.call();
    const cwd = this.context.component!.appDir;
    if (this.context.mode!.isAndroid) {
      const args = ["android", "dev"]
        .concat(features.length ? ["-f", features.join(",")] : [])
        .concat(this.options.args?.length ? ["--", ...(this.options.args ?? [])] : []);
      run("tauri", args, { cwd, bin: "cargo" });
    } else if (this.context.mode!.isWeb) {
      const mergedArgs = [...(compileArgs || []), ...(this.options.args || [])];
      const args = this.buildCargoArgs(
        ["run", "-p", "kabegame"],
        features,
        mergedArgs.length > 0 ? mergedArgs : undefined,
      );
      run("cargo", args, { cwd: SRC_TAURI_DIR });
    } else {
      const baseArgs = ["dev"];
      const args = this.buildCargoArgs(baseArgs, features);
      if (this.options.args && this.options.args.length > 0) {
        args.push("--");
        args.push(...this.options.args);
      }
      run("tauri", args, { cwd, bin: "cargo" });
    }
  }

  async start(options: BuildOptions): Promise<void> {
    // @ts-ignore
    this.options = Object.freeze(options);

    this.commonUse(Cmd.START);
    this.commonBefore();
    const { features } = this.hooks.prepareCompileArgs.call();
    const baseArgs = ["run", "-p", this.context.component!.cargoComp];
    const args = this.buildCargoArgs(baseArgs, features);

    if (this.options.args && this.options.args.length > 0) {
      args.push("--");
      args.push(...this.options.args);
    }
    // 先构建前端资源
    if (this.context.component?.isMain) {
      if (this.options.nx === false) {
        run("bun", ["-b", "--cwd", this.context.component!.appFeDir, "build"], {});
      } else {
        run("nx", ["run", `.:build-${this.context.component!.comp}`], {
          bin: "bun",
        });
      }
    }
    run("cargo", args);
  }

  async build(options: BuildOptions): Promise<void> {
    //@ts-ignore
    this.options = Object.freeze(options);

    this.commonUse(Cmd.BUILD);
    this.commonBefore();
    if (this.context.component!.isCli && this.context.mode!.isStandard) {
      this.hooks.beforeBuild.call(Component.CLI);
      const { features, args: compileArgs } = this.hooks.prepareCompileArgs.call(Component.CLI);
      const mergedArgs = [...(compileArgs || []), ...(this.options.args || [])];
      const args = this.buildCargoArgs(
        ["build", "--release", "-p", Component.cargoComp(Component.CLI)],
        features,
        mergedArgs.length > 0 ? mergedArgs : undefined,
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
      const { features, args: compileArgs } = this.hooks.prepareCompileArgs.call(Component.MAIN);
      const cwd = Component.appDir(Component.MAIN);
      if (!this.context.skip?.isVue) {
        if (this.options.nx === false) {
          run("bun", ["-b", "--cwd", "apps/main", "build"], {});
        } else {
          run("nx", ["run", ".:build-main"], {
            bin: "bun",
          });
        }
      }
      if (!this.context.skip?.isCargo) {
        if (this.context.mode!.isAndroid) {
          const mergedArgs = [...(compileArgs || []), ...(this.options.args || [])];
          const args = ["android", "build"]
            .concat(features.length ? ["-f", features.join(",")] : [])
            .concat(mergedArgs);
          run("tauri", args, { cwd, bin: "cargo" });
        } else if (this.context.mode!.isWeb) {
          const distMain = path.join(root, "dist-main");
          if (!existsSync(distMain)) {
            throw new Error(
              `[web build] dist-main/ not found at ${distMain}.\n` +
              `Run Vue build first: bun b -c main --mode web --skip cargo`,
            );
          }
          const mergedArgs = [...(compileArgs || []), ...(this.options.args || [])];
          const args = this.buildCargoArgs(
            ["build", "--release", "-p", "kabegame"],
            features,
            mergedArgs.length > 0 ? mergedArgs : undefined,
          );
          run("cargo", args, { cwd: SRC_TAURI_DIR });
        } else {
          const mergedArgs = [...(compileArgs || []), ...(this.options.args || [])];
          const args = this.buildCargoArgs(["build"], features, mergedArgs.length > 0 ? mergedArgs : undefined);
          run("tauri", args, { cwd, bin: "cargo" });
        }
      }
      await this.hooks.afterBuild.promise(Component.MAIN);
    }
  }

  async check(options: BuildOptions): Promise<void> {
    //@ts-ignore
    this.options = Object.freeze(options);

    this.commonUse(Cmd.CHECK);
    this.commonBefore();

    if (!this.context.skip?.isVue) {
      run("vue-tsc", [], {
        bin: "bun",
        cwd: this.context.component!.appFeDir,
      });
    }

    if (!this.context.skip?.isCargo) {
      const { features, args: compileArgs } = this.hooks.prepareCompileArgs.call(
        this.context.component!.comp,
      );
      const mergedArgs = [...(compileArgs || []), ...(this.options.args || [])];
      const checkArgs = this.buildCargoArgs(
        ["check", "-p", this.context.component!.cargoComp],
        features,
        mergedArgs.length > 0 ? mergedArgs : undefined,
      );
      run("cargo", checkArgs);
    }
  }
}
