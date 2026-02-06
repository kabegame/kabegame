import {
  scanBuiltinPlugins,
  ensureDokan2DllResource,
  ensureDokanInstallerResourceIfPresent,
} from "../utils";
import { BasePlugin } from "./base-plugin";
import { run } from "../utils";
import { Component, ComponentPlugin } from "./component-plugin";
import chalk from "chalk";
import { BuildSystem } from "../build-system";

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
      this.addRustFlags(`--cfg kabegame_mode="${this.mode!.mode}"`);
    });

    bs.hooks.beforeBuild.tap(this.name, () => {
      this.packagePlugins(bs);
      this.prepareResources(bs);
      // 这一步一定要到 packagePlugin 之后，否则会扫描不到插件
      this.setBuiltinPluginsEnvIfNeeded(!bs.context.cmd.isBuild);
    });

    bs.hooks.prepareCompileArgs.tap(
      this.name,
      // @ts-ignore
      (
        nullOrCompOrFeatures:
          | null
          | string
          | { comp: Component; features: string[]; args?: string[] },
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

        // 保留前一个 hook 传递的 args
        const args =
          typeof nullOrCompOrFeatures === "object" &&
          nullOrCompOrFeatures !== null &&
          "args" in nullOrCompOrFeatures
            ? nullOrCompOrFeatures.args
            : undefined;

        // 只保留 self-hosted feature 的逻辑
        return {
          comp,
          features,
          ...(args && { args }),
        };
      },
    );

    // TODO: 对不同的mode执行不同的tap
  }

  // 准备资源文件（仅在需要时包含 dokan 相关文件）
  prepareResources(bs: BuildSystem): void {
    if (!bs.context.cmd.isBuild) {
      return;
    }
    // Light mode 不需要虚拟驱动功能，跳过 dokan 资源处理
    if (this.mode!.isLight) {
      this.log(chalk.yellow("Light mode: skipping Dokan resource preparation"));
      return;
    }

    // 仅在 main 组件构建时才需要处理 dokan 资源
    if (bs.context.component!.isMain) {
      this.log("Ensuring Dokan resources...");
      ensureDokan2DllResource();
      ensureDokanInstallerResourceIfPresent();
    }
  }

  // 打包rhai插件
  packagePlugins(bs: BuildSystem): void {
    const cmd = bs.context.cmd;
    const mode = bs.context.mode!;
    const comp = bs.context.component!;
    if (cmd.isDev || cmd.isBuild) {
      if (cmd.isBuild && !comp.isMain) {
        return;
      }
      // 开发和生产都打包到 resources 目录
      const packageTarget = !mode.isNormal
        ? "crawler-plugins:package-to-resources"
        : "crawler-plugins:package-local-to-resources";
      this.log(chalk.blue(`打包插件到资源: ${packageTarget}`));
      run("nx", ["run", packageTarget], {
        bin: "bun",
      });
    }
    // start 命令不打包插件
  }

  setBuiltinPluginsEnvIfNeeded(isDev: boolean = false): void {
    if (!this.mode) {
      return;
    }

    let builtinPlugins: string[];
    if (this.mode.isNormal) {
      // Normal 模式只包含 local-import 插件
      builtinPlugins = ["local-import"];
    } else {
      // Local 和 Light 模式包含所有预打包插件（始终从 resources 目录扫描）
      builtinPlugins = scanBuiltinPlugins();
    }

    const csv = builtinPlugins.join(",");
    if (csv) {
      this.setEnv("KABEGAME_BUILTIN_PLUGINS", csv);
    }
  }
}
