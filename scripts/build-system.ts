/**
 * 基于 Tapable 的构建系统
 *
 * 使用钩子系统组织构建流程，支持插件化扩展
 */

import { AsyncSeriesHook, SyncHook } from "tapable";
import { spawn } from "child_process";
import chalk from "chalk";
import path from "path";
import { existsSync } from "fs";
import { fileURLToPath } from "url";
import { Component, ComponentPlugin } from "./plugins/component-plugin.js";
import { Mode, ModePlugin } from "./plugins/mode-plugin.js";
import { TracePlugin } from "./plugins/trace-plugin.js";
import { Cmd, CmdPlugin } from "./plugins/cmd-plugin.ts";
import { OSPlugin } from "./plugins/os-plugin.js";
import { SyncWaterfallHook } from "tapable";
import { run, TARGET_DIR } from "./utils.js";
import { BasePlugin } from "./plugins/base-plugin.ts";
import { Skip, SkipPlugin } from "./plugins/skip-plugin.js";
import { ReleasePlugin } from "./plugins/release-plugin.js";
import { DataPlugin } from "./plugins/data-plugin.js";
import { TauriCliPlugin } from "./plugins/tauri-cli-plugin.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");

// 路径常量
export const RESOURCES_PLUGINS_DIR = path.join(
  root,
  "src-tauri",
  "kabegame",
  "resources",
  "plugins",
);
export const RESOURCES_BIN_DIR = path.join(
  root,
  "src-tauri",
  "kabegame",
  "resources",
  "bin",
);
export const SRC_TAURI_DIR = path.join(root, "src-tauri");
export const SRC_FE_DIR = path.join(root, "apps");
export const TAURI_KABEGAME_DIR = path.join(SRC_TAURI_DIR, "kabegame");

interface BuildOptions {
  component?: string;
  mode?: string;
  data?: string;
  verbose?: boolean;
  trace?: boolean;
  skip?: string;
  release?: boolean;
  args?: string[];
  package?: string;
  test?: string;
  /** false 表示 --no-nx：不经 nx 构建 kabegame 前端 */
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
  beforeRun: SyncHook<[string?]>;
  afterRun: SyncHook<[string?]>;
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

      // 可执行文件已生成、运行进程启动前
      beforeRun: new SyncHook(["comp"]),

      // 运行进程退出后
      afterRun: new SyncHook(["comp"]),
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

  private buildTauriArgs(
    baseArgs: string[],
    features: string[],
    runnerArgs?: string[],
    additionalTauriArgs?: string[],
  ): string[] {
    const args = [...baseArgs];
    if (features.length > 0) {
      args.push("--features", features.join(","));
    }
    if (additionalTauriArgs && additionalTauriArgs.length > 0) {
      args.push(...additionalTauriArgs);
    }
    if (runnerArgs && runnerArgs.length > 0) {
      args.push("--", ...runnerArgs);
    }
    return args;
  }

  commonUse(cmd: string): void {
    this.use(new CmdPlugin(cmd));
    this.use(new OSPlugin());
    // --component
    this.use(new ComponentPlugin());

    // --mode (standard | android)
    this.use(new ModePlugin());

    // --release
    this.use(new ReleasePlugin());

    // --trace
    this.use(new TracePlugin());

    // --skip
    this.use(new SkipPlugin());

    // --data (dev | prod)
    this.use(new DataPlugin());

    // fork 的 cargo-tauri(third/tauri/crates/tauri-cli):PATH 前置 + dev/build 前确保构建
    this.use(new TauriCliPlugin());
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
      const args = this.buildTauriArgs(
        ["android", "dev"],
        features,
        this.options.args,
        compileArgs,
      );
      run("tauri", args, { cwd, bin: "cargo" });
    } else if (this.context.mode!.isWeb) {
      // 同时启动 Vite dev server (1420) 和 web Rust 二进制 (7490)
      // Vite 后台运行，cargo 前台运行；cargo 退出时杀掉 Vite
      const feDir = this.context.component!.appFeDir;
      console.log(chalk.cyan("[web dev] Starting Vite dev server on 1420..."));
      const viteProc = spawn("bun", ["run", "dev"], {
        cwd: feDir,
        stdio: "inherit",
        env: process.env,
        shell: OSPlugin.isWindows,
      });
      const killVite = () => {
        if (!viteProc.killed) {
          try { viteProc.kill("SIGTERM"); } catch {}
        }
      };
      process.on("exit", killVite);
      process.on("SIGINT", killVite);
      process.on("SIGTERM", killVite);

      console.log(chalk.cyan("[web dev] Starting Rust web binary on 7490..."));
      const mergedArgs = [...(compileArgs || []), ...(this.options.args || [])];
      const args = this.buildCargoArgs(
        ["run", "-p", "kabegame"],
        features,
        mergedArgs.length > 0 ? mergedArgs : undefined,
      );
      run("cargo", args, { cwd: SRC_TAURI_DIR });
      killVite();
    } else {
      const args = this.buildTauriArgs(
        ["dev"],
        features,
        this.options.args,
        compileArgs,
      );
      run("tauri", args, { cwd, bin: "cargo" });
    }
  }

  async start(options: BuildOptions): Promise<void> {
    // @ts-ignore
    this.options = Object.freeze(options);

    this.commonUse(Cmd.START);
    this.commonBefore();

    const component = this.context.component!;
    const { features, args: compileArgs } = this.hooks.prepareCompileArgs.call();
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
    const buildArgs = this.buildCargoArgs(
      [
        "build",
        "-p",
        component.cargoComp,
        ...(component.isMain ? ["--bin", "kabegame"] : []),
      ],
      features,
      compileArgs,
    );
    run("cargo", buildArgs, { cwd: SRC_TAURI_DIR });
    this.hooks.beforeRun.call(component.comp);
    try {
      if (OSPlugin.isMacOS && component.isMain) {
        const exe = path.join(
          TARGET_DIR,
          this.options.release ? "release" : "debug",
          "kabegame",
        );
        run(exe, this.options.args || [], { cwd: root });
      } else {
        const runArgs = this.buildCargoArgs(
          [
            "run",
            "-p",
            component.cargoComp,
            ...(component.isMain ? ["--bin", "kabegame"] : []),
          ],
          features,
          compileArgs,
        );
        if (this.options.args?.length) runArgs.push("--", ...this.options.args);
        run("cargo", runArgs, { cwd: SRC_TAURI_DIR });
      }
    } finally {
      this.hooks.afterRun.call(component.comp);
    }
  }

  async build(options: BuildOptions): Promise<void> {
    //@ts-ignore
    this.options = Object.freeze(options);

    this.commonUse(Cmd.BUILD);
    this.commonBefore();
    if (this.context.component!.isCli) {
      this.hooks.beforeBuild.call(Component.CLI);
      const { features, args: compileArgs } = this.hooks.prepareCompileArgs.call(Component.CLI);
      const mergedArgs = [...(compileArgs || []), ...(this.options.args || [])];
      const args = this.buildCargoArgs(
        ["build", "-p", Component.cargoComp(Component.CLI)],
        features,
        mergedArgs.length > 0 ? mergedArgs : undefined,
      );
      if (!this.context.skip?.isCargo) {
        run("cargo", args, {
          cwd: SRC_TAURI_DIR,
        });
      }
    }
    if (this.context.component!.isMain) {
      this.hooks.beforeBuild.call(Component.MAIN);
      const { features, args: compileArgs } = this.hooks.prepareCompileArgs.call(Component.MAIN);
      const cwd = Component.appDir(Component.MAIN);
      if (!this.context.skip?.isVue) {
        if (this.options.nx === false) {
          run("bun", ["-b", "--cwd", "apps/kabegame", "build"], {});
        } else {
          run("nx", ["run", ".:build-kabegame"], {
            bin: "bun",
          });
        }
      }
      if (!this.context.skip?.isCargo) {
        if (this.context.mode!.isAndroid) {
          const args = this.buildTauriArgs(
            ["android", "build"],
            features,
            compileArgs,
            this.options.args,
          );
          run("tauri", args, { cwd, bin: "cargo" });
        } else if (this.context.mode!.isWeb) {
          const distMain = path.join(root, "dist-kabegame");
          if (!existsSync(distMain)) {
            throw new Error(
              `[web build] dist-kabegame/ not found at ${distMain}.\n` +
              `Run Vue build first: bun b -c kabegame --mode web --skip cargo`,
            );
          }
          const mergedArgs = [...(compileArgs || []), ...(this.options.args || [])];
          const args = this.buildCargoArgs(
            ["build", "-p", "kabegame"],
            features,
            mergedArgs.length > 0 ? mergedArgs : undefined,
          );
          run("cargo", args, { cwd: SRC_TAURI_DIR });
        } else {
          const args = this.buildTauriArgs(
            ["build"],
            features,
            compileArgs,
            this.options.args,
          );
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

      if (this.context.mode!.isAndroid) {
        // android check 走 fork 的 `cargo tauri android check`：复用 tauri/cargo-mobile2
        // 的 NDK 交叉工具链（linker + TARGET_CC/CXX/AR，与 `tauri android build` 完全一致，
        // 无需在 ModePlugin 手写 linker/CC）。FFMPEG / rusty_v8 / bindgen /
        // PKG_CONFIG_ALLOW_CROSS 等 kabegame 特有 env 仍由 ModePlugin.prepareEnv 注入并透传。
        // 见 cocs/tauri/TAURI_CLI_FORK.md。check.rs 不产 APK/AAB、不跑前端。
        // beforeBuild：渲染 tauri.conf.json（ComponentPlugin）+ 确保 fork 已构建（TauriCliPlugin）；
        // os-plugin/mode-plugin 的 beforeBuild 对 check 均为 no-op。
        this.hooks.beforeBuild.call();
        const cwd = this.context.component!.appDir;
        const runnerArgs = [...(compileArgs || []), ...(this.options.args || [])];
        const args = this.buildTauriArgs(
          ["android", "check"],
          features,
          runnerArgs.length > 0 ? runnerArgs : undefined,
        );
        run("tauri", args, { cwd, bin: "cargo" });
        return;
      }

      const mergedArgs = [...(compileArgs || []), ...(this.options.args || [])];
      const checkArgs = this.buildCargoArgs(
        ["check", "-p", this.context.component!.cargoComp],
        features,
        mergedArgs.length > 0 ? mergedArgs : undefined,
      );
      run("cargo", checkArgs);
    }
  }

  async test(options: BuildOptions): Promise<void> {
    //@ts-ignore
    this.options = Object.freeze(options);

    this.commonUse(Cmd.TEST);
    this.commonBefore();

    const packageName = this.options.package || "kabegame-core";
    const testArgs = ["test", "-p", packageName];
    if (this.options.test) {
      testArgs.push("--test", this.options.test);
    }

    let features: string[] = [];
    let compileArgs: string[] | undefined;
    if (packageName === this.context.component!.cargoComp) {
      const prepared = this.hooks.prepareCompileArgs.call(
        this.context.component!.comp,
      );
      features = prepared.features;
      compileArgs = prepared.args;
    }

    const mergedArgs = [...(compileArgs || [])];
    const args = this.buildCargoArgs(
      testArgs,
      features,
      mergedArgs.length > 0 ? mergedArgs : undefined,
    );
    if (this.options.args && this.options.args.length > 0) {
      args.push("--", ...this.options.args);
    }
    run("cargo", args);
  }
}
