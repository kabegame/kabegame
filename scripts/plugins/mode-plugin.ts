import {
  copyDokan2DllToResources,
  copyDokanInstallerToResources,
  copyFFmpegDllsToResources,
  BIN_DIR,
} from "../utils";
import { BasePlugin } from "./base-plugin";
import { run } from "../utils";
import { Component } from "./component-plugin";
import chalk from "chalk";
import { BuildSystem } from "../build-system";
import { OSPlugin } from "./os-plugin";
import path from "path";
import fs from "fs";

export class Mode {
  static readonly STANDARD = "standard";
  static readonly LIGHT = "light";
  static readonly ANDROID = "android";
  static readonly WEB = "web";

  static readonly modes = [this.STANDARD, this.LIGHT, this.ANDROID, this.WEB];

  constructor(private readonly _mode: string) {}

  get mode() {
    return this._mode;
  }

  get isStandard(): boolean {
    return this.mode === Mode.STANDARD;
  }

  get isLight(): boolean {
    return this.mode === Mode.LIGHT;
  }

  get isAndroid(): boolean {
    return this.mode === Mode.ANDROID;
  }

  get isWeb(): boolean {
    return this.mode === Mode.WEB;
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
      let mode = bs.options.mode || Mode.STANDARD;
      if (!Mode.modes.includes(mode)) {
        throw new Error(`未知的模式，允许的列表：${Mode.modes}`);
      }
      const modeObj = new Mode(mode);
      if ((modeObj.isLight || modeObj.isAndroid || modeObj.isWeb) && !bs.context.component!.isMain) {
        throw new Error(`${mode} mode 只支持main组件！`);
      }
      if (modeObj.isAndroid && !(bs.context.cmd!.isDev || bs.context.cmd!.isBuild)) {
        throw new Error("android mode 仅支持 dev 与 build 命令");
      }
      if (modeObj.isWeb && !(bs.context.cmd!.isDev || bs.context.cmd!.isBuild || bs.context.cmd!.isCheck)) {
        throw new Error("web mode 仅支持 dev、build 与 check 命令");
      }
      bs.context.mode = modeObj;
      this.mode = modeObj;
      OSPlugin.isAndroid = modeObj.isAndroid;
    });

    bs.hooks.prepareEnv.tap(this.name, () => {
      this.setEnv("KABEGAME_MODE", this.mode!.mode);
      this.setEnv("VITE_KABEGAME_MODE", this.mode!.mode);
      // kabegame_mode cfg is only for local-internal subdivisions (standard/light/android).
      // web/local split is done via Cargo features, not kabegame_mode.
      if (!this.mode!.isWeb) {
        this.addRustFlags(`--cfg kabegame_mode="${this.mode!.mode}"`);
      }

      if (this.mode!.isAndroid) {
        this.setEnv("VITE_ANDROID", "true");
        this.setEnv("TAURI_PLATFORM", "android");
      }

      // 开发/start 时通过 PATH 让主进程及 sidecar（如 ffmpeg）找到 kabegame/bin 下的 DLL，无需复制
      if (
        OSPlugin.isWindows &&
        (bs.context.cmd?.isDev || bs.context.cmd?.isStart) &&
        fs.existsSync(BIN_DIR) &&
        fs.statSync(BIN_DIR).isDirectory()
      ) {
        const binAbs = path.resolve(BIN_DIR);
        const prev = process.env.PATH || "";
        process.env.PATH = binAbs + path.delimiter + prev;
        this.log(chalk.cyan(`PATH prepended with KABEGAME bin: ${binAbs}`));
      }
    });

    bs.hooks.beforeBuild.tap(this.name, (comp) => {
      const component = comp ? new Component(comp) : bs.context.component!;
      if (!component.isMain) {
        return;
      }
      this.packagePlugins(bs);
      this.copyBin(bs);
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

        // Inject Cargo feature flags based on mode.
        // web mode: --no-default-features --features web (cuts out all tauri deps)
        // local mode: default features already activate "local"; no extra flags needed
        const finalArgs = args ? [...args] : [];
        if (this.mode!.isWeb) {
          finalArgs.push("--no-default-features", "--features", "web");
        }

        return {
          comp,
          features,
          ...(finalArgs.length > 0 && { args: finalArgs }),
        };
      },
    );
  }

  // 准备资源文件（仅在需要时包含 dokan 相关文件）
  copyBin(bs: BuildSystem): void {
    if (!bs.context.cmd.isBuild) {
      return;
    }
    // web mode outputs a plain binary — no Tauri bundle, no DLL resources needed
    if (bs.context.mode!.isWeb) {
      return;
    }

    // 仅在 main 组件构建时才需要处理 dokan 与 bin 下 DLL 资源
    if (bs.context.component!.isMain && OSPlugin.isWindows) {
      this.log("Copy Dokan and FFmpeg DLLs resources...");
      if (this.mode!.isStandard) {
        copyDokan2DllToResources();
        copyDokanInstallerToResources();
      }
      copyFFmpegDllsToResources();
    }
  }

  // 打包爬虫插件：仅本地开发写入 data/plugins-directory（不将 .kgpg 打入安装包 resources）
  packagePlugins(bs: BuildSystem): void {
    const cmd = bs.context.cmd;
    const comp = bs.context.component!;
    if (comp.isMain && cmd.isDev) {
      this.log(chalk.blue("打包插件到开发 data 目录: crawler-plugins:package-to-dev-data"));
      run("nx", ["run", "crawler-plugins:package-to-dev-data"], {
        bin: "bun",
      });
    }
    // build / start 不打包插件；正式环境插件从 GitHub Releases 下载
  }
}
