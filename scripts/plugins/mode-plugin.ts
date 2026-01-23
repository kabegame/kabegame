import {
  scanBuiltinPlugins,
  ensureDokan2DllResource,
  ensureDokanInstallerResourceIfPresent,
} from "../build-utils";
import { BasePlugin } from "./base-plugin";
import { run } from "../build-utils";
import { Component, ComponentPlugin } from "./component-plugin";
import chalk from "chalk";
import { BuildSystem } from "scripts/build-system";

export class Mode {
  static readonly NORMAL = "normal";
  static readonly LOCAL = "local";
  static readonly LIGHT = "light";

  static readonly modes = [this.NORMAL, this.LOCAL, this.LIGHT];

  constructor(private readonly _mode: string) {}

  get mode() {
    return this._mode;
  }

  get isNormal(): boolean {
    return this.mode === Mode.NORMAL;
  }

  get isLocal(): boolean {
    return this.mode === Mode.LOCAL;
  }

  get isLight(): boolean {
    return this.mode === Mode.LIGHT;
  }
}

/**
 * 解析组件 component，在上下文中添加
 * isMain、isPluginEditor 等布尔变量直接使用。
 */
export class ModePlugin extends BasePlugin {
  static readonly NAME = "ModePlugin";

  private mode?: Mode;

  constructor() {
    super(ModePlugin.NAME);
  }

  apply(bs: BuildSystem): void {
    bs.hooks.parseParams.tap(this.name, () => {
      let mode = bs.options.mode || Mode.NORMAL;
      if (!Mode.modes.includes(mode)) {
        throw new Error(`未知的模式，允许的列表：${Mode.modes}`);
      }
      const modeObj = new Mode(mode);
      if (modeObj.isLight && !bs.context.component!.isMain) {
        throw new Error("light mode 只支持main组件！");
      }
      bs.context.mode = modeObj;
      this.mode = modeObj;
    });

    bs.hooks.prepareEnv.tap(this.name, () => {
      this.setEnv("KABEGAME_MODE", this.mode!.mode);
      this.setEnv("VITE_KABEGAME_MODE", this.mode!.mode);
    });

    bs.hooks.beforeBuild.tap(this.name, () => {
      this.packagePlugins(bs);
      this.setBuiltinPluginsEnvIfNeeded();
      this.prepareResources(bs);
    });

    bs.hooks.prepareCompileArgs.tap(
      this.name,
      // @ts-ignore
      (
        nullOrCompOrFeatures:
          | null
          | string
          | { comp: Component; features: string[] },
      ) => {
        // virtual-driver 功能现在通过 cfg(kabegame_mode) 控制，不再使用 features
        // self-hosted 功能仍通过 feature 控制
        const mode = this.mode!;
        const features: string[] = Array.isArray(nullOrCompOrFeatures)
          ? nullOrCompOrFeatures
          : [];
        const comp = nullOrCompOrFeatures
          ? typeof nullOrCompOrFeatures === "string"
            ? new Component(nullOrCompOrFeatures)
            : nullOrCompOrFeatures["comp"]
          : bs.context.component!;

        // cfg 参数：注入 kabegame_mode
        const cfgs = [`kabegame_mode="${mode.mode}"`];

        this.addRustFlags(`--cfg kabegame_mode="${mode.mode}"`);

        // 只保留 self-hosted feature 的逻辑
        return {
          comp,
          features,
        };
      },
    );

    // TODO: 对不同的mode执行不同的tap
  }

  // 准备资源文件（仅在需要时包含 dokan 相关文件）
  prepareResources(bs: any): void {
    // Light mode 不需要虚拟驱动功能，跳过 dokan 资源处理
    if (this.mode!.isLight) {
      this.log(chalk.yellow("Light mode: skipping Dokan resource preparation"));
      return;
    }

    // 仅在 main 组件构建时才需要处理 dokan 资源
    if (bs.context.component.isMain) {
      this.log("Ensuring Dokan resources...");
      ensureDokan2DllResource();
      ensureDokanInstallerResourceIfPresent();
    }
  }

  // 打包rhai插件
  packagePlugins(bs: any): void {
    this.log("package plugins");
    const cmd = bs.context.cmd;
    const mode = bs.context.mode;
    const comp = bs.context.component;
    if (cmd.isDev) {
      const packageTarget = mode.isLocal
        ? "crawler-plugins:package-local-to-data"
        : "crawler-plugins:package-to-data";
      this.log(chalk.blue(`打包插件到开发目录: ${packageTarget}`));
      run("nx", ["run", packageTarget], {
        bin: "bun",
      });
    } else if (cmd.isBuild) {
      if (!comp.isMain) {
        return;
      }
      const builtinPlugins = scanBuiltinPlugins();
      if (builtinPlugins.length > 0) {
        this.log(
          chalk.blue(
            `检测到 resources/plugins 已有 ${builtinPlugins.length} 个插件，跳过 CI 内打包`,
          ),
        );
        return;
      }
      const packageTarget = mode.isLocal
        ? "crawler-plugins:package-local-to-resources"
        : "crawler-plugins:package-to-resources";
      this.log(chalk.blue(`打包插件到资源: ${packageTarget}`));
      run("nx", ["run", packageTarget], {
        bin: "bun",
      });
    }
    // start 命令不打包插件
  }

  setBuiltinPluginsEnvIfNeeded(): void {
    if (!this.mode) {
      return;
    }

    let builtinPlugins: string[];
    if (this.mode.isNormal) {
      // Normal 模式只包含 local-import 插件
      builtinPlugins = ["local-import"];
    } else {
      // Local 和 Light 模式包含所有预打包插件
      builtinPlugins = scanBuiltinPlugins();
    }

    const csv = builtinPlugins.join(",");
    if (csv) {
      this.setEnv("KABEGAME_BUILTIN_PLUGINS", csv);
    }
  }
}
