import { BasePlugin } from "./base-plugin";
import { run } from "../utils";
import { Component } from "./component-plugin";
import chalk from "chalk";
import { BuildSystem, THIRD_DIR } from "../build-system";
import { OSPlugin } from "./os-plugin";
import path from "path";
import fs from "fs";
import os from "os";
import { execSync } from "child_process";

export class Mode {
  static readonly STANDARD = "standard";
  static readonly ANDROID = "android";
  static readonly WEB = "web";

  static readonly modes = [this.STANDARD, this.ANDROID, this.WEB];

  constructor(private readonly _mode: string) {}

  get mode() {
    return this._mode;
  }

  get isStandard(): boolean {
    return this.mode === Mode.STANDARD;
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
      if (
        (modeObj.isAndroid || modeObj.isWeb) &&
        !bs.context.component!.isMain
      ) {
        throw new Error(`${mode} mode 只支持main组件！`);
      }
      if (
        modeObj.isAndroid &&
        !(bs.context.cmd!.isDev || bs.context.cmd!.isBuild)
      ) {
        throw new Error("android mode 仅支持 dev 与 build 命令");
      }
      if (
        modeObj.isWeb &&
        !(
          bs.context.cmd!.isDev ||
          bs.context.cmd!.isBuild ||
          bs.context.cmd!.isCheck
        )
      ) {
        throw new Error("web mode 仅支持 dev、build 与 check 命令");
      }
      bs.context.mode = modeObj;
      this.mode = modeObj;
      OSPlugin.isAndroid = modeObj.isAndroid;
    });

    bs.hooks.prepareEnv.tap(this.name, () => {
      // 仅供前端 vite 注入展示与 build.rs 旧期间兼容；不再驱动 Rust 编译期分支。
      // 编译期 mode 现在通过 cargo --features 传递（见 prepareCompileArgs hook）。
      this.setEnv("KABEGAME_MODE", this.mode!.mode);
      this.setEnv("VITE_KABEGAME_MODE", this.mode!.mode);
      if (this.mode!.isAndroid) {
        this.setEnv("VITE_ANDROID", "true");
        this.setEnv("TAURI_PLATFORM", "android");
      } else {
        this.setEnv("FFMPEG_PKG_CONFIG_PATH", path.join(
            THIRD_DIR,
            "FFmpeg-build",
            "install",
            "lib",
            "pkgconfig",
          )
        );
        // Linux 将 FFmpeg 与 x264 显式静态链接；该模式还会让
        // rusty_ffmpeg 完整解析 .pc 的传递依赖，避免复用旧的链接元数据。
        if (OSPlugin.isLinux) {
          this.setEnv("FFMPEG_LINK_MODE", "static");
        }
        // Linux/Windows 用 CEF runtime。必须在任何 cargo 命令前设好
        // CEF_PATH,否则 cef-dll-sys 会下载官方无 H.264 的 CEF 覆盖 target 目录
        // (见 .cursor/rules/cef-path-set.mdc)。
        // 回退约定:Linux ~/i/cef-{dev,prod};Windows H:\cef-{dev,prod}。
        if ((OSPlugin.isLinux || OSPlugin.isWindows) && !this.mode!.isWeb) {
          // dev/check 用 cef-dev(check 只需要任意有效 CEF 目录做编译,不打包);
          // 仅 build 要求 cef-prod。
          const cefVariant =
            bs.context.cmd.isDev || bs.context.cmd.isCheck ? "cef-dev" : "cef-prod";
          const cefPath =
            process.env.CEF_PATH ||
            (OSPlugin.isWindows
              ? path.join("H:", cefVariant)
              : path.join(os.homedir(), "i", cefVariant));
          const libcefName = OSPlugin.isWindows ? "libcef.dll" : "libcef.so";
          const libcef = path.join(cefPath, libcefName);
          if (!fs.existsSync(libcef)) {
            throw new Error(
              [
                `CEF runtime not found: ${libcef}`,
                "Set CEF_PATH to an exported cef-rs runtime directory" +
                  (OSPlugin.isLinux ? ", or run:" : "."),
                ...(OSPlugin.isLinux
                  ? ["scripts/build-chromium.sh dev", "scripts/build-chromium.sh prod"]
                  : []),
              ].join("\n"),
            );
          }
          this.setEnv("CEF_PATH", cefPath);
          // Windows 不需要注入库搜索路径:cef-dll-sys build.rs 会把整个 CEF runtime
          // 拷进 target/{debug,release}/(exe 同目录),加载器直接命中。
          if (OSPlugin.isLinux) {
            const libraryPath = (process.env.LD_LIBRARY_PATH || "")
              .split(path.delimiter)
              .filter(Boolean);
            if (!libraryPath.includes(cefPath)) {
              libraryPath.unshift(cefPath);
            }
            this.setEnv("LD_LIBRARY_PATH", libraryPath.join(path.delimiter));
          }
        }
        // Linux 虚拟盘:不再链接 libfuse。fuser 关闭 `libfuse` feature 走纯 Rust 挂载
        // (见 kabegame-core/Cargo.toml),二进制不含 libfuse DT_NEEDED,挂载时懒执行
        // fusermount3。因此无需 FUSE3_STATIC / libfuse3.a,构建期不设任何 fuse 相关 env。
        // macOS: clang (used by bindgen/rusty_ffmpeg) cannot find system headers like
        // errno.h without an explicit sysroot. BINDGEN_EXTRA_CLANG_ARGS is read by
        // bindgen and passed straight to clang before binding generation.
        if (OSPlugin.isMacOS) {
          try {
            const sdkPath = execSync("xcrun --sdk macosx --show-sdk-path", { encoding: "utf8" }).trim();
            this.setEnv("BINDGEN_EXTRA_CLANG_ARGS", `-isysroot ${sdkPath}`);
          } catch {
            this.log(chalk.yellow("Warning: xcrun failed — BINDGEN_EXTRA_CLANG_ARGS not set. bindgen may fail to find system headers."));
          }
        }
        // windows: libs dir
        else if (OSPlugin.isWindows) {
          const ffmpegBinDir = path.join(
            THIRD_DIR,
            "FFmpeg-build",
            "install",
            "bin",
          );
          this.setEnv("FFMPEG_LIBS_DIR", ffmpegBinDir);
          this.setEnv("FFMPEG_INCLUDE_DIR", path.join(
            THIRD_DIR,
            "FFmpeg-build",
            "install",
            "include",
          ));
          this.setEnv("FFMPEG_LINK_MODE", "dynamic");
          const pathPrefixes = [OSPlugin.binDir, ffmpegBinDir].filter((dir) => {
            return fs.existsSync(dir) && fs.statSync(dir).isDirectory();
          });
          if (pathPrefixes.length > 0) {
            this.setEnv(
              "PATH",
              pathPrefixes.join(path.delimiter) + path.delimiter + (process.env.PATH || ""),
            );
          }
        }
      }
      // 注:Windows 下 OSPlugin.binDir 已在上面的 isWindows 分支里随 ffmpegBinDir
      // 一起 unshift 进 PATH,这里不再重复注入,否则 PATH 里会出现两份 bin/windows。
    });

    bs.hooks.beforeBuild.tap(this.name, (comp) => {
      const component = comp ? new Component(comp) : bs.context.component!;
      if (!component.isMain) {
        return;
      }
      this.packagePlugins(bs);
      // bin/{platform}/ 收集与 resources/bin 复制由 OSPlugin.bundleLibs 接管
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
        const features: string[] = Array.isArray(nullOrCompOrFeatures)
          ? [...nullOrCompOrFeatures]
          : typeof nullOrCompOrFeatures === "object" &&
              nullOrCompOrFeatures !== null
            ? [...(nullOrCompOrFeatures.features || [])]
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

        // Mode → cargo feature 翻译。仅作用于 main 组件；cli 始终以 standard 等价
        // 编译，不感知 mode（mode-plugin.ts 顶部 parseParams 已强制 android/web
        // 只允许 main 组件）。
        //   - standard：--features standard（默认特性也是 standard，显式传递便于 dev/check/build 行为一致）
        //   - android：--no-default-features --features android（不带 VD，含 android-only 插件）
        //   - web：--no-default-features --features web（不带 Tauri 栈）
        const finalArgs = args ? [...args] : [];
        if (comp.isMain) {
          if (this.mode!.isWeb) {
            features.push("web");
          } else if (this.mode!.isAndroid) {
            features.push("android");
          } else if (this.mode!.isStandard) {
            features.push("standard");
          }
        }

        return {
          comp,
          features,
          ...(finalArgs.length > 0 && { args: finalArgs }),
        };
      },
    );
  }

  // 打包爬虫插件：
  // - dev：写入 data/plugins-directory（不打进安装包 resources，即时对开发中的
  //   应用可见）
  // - build（非 Android）：写入 resources/plugins/，随 tauri.conf.json 的
  //   bundle.resources 打进安装包；init_kgpg_plugin() 在应用启动时把这里的 .kgpg
  //   "移动"进用户插件目录（见 kabegame-core/src/plugin/mod.rs 的
  //   PluginManager::seed_bundled_plugins）。Android 不走桌面 bundle.resources
  //   机制，跳过。
  // - start：不打包插件；正式环境插件从 GitHub Releases 下载
  packagePlugins(bs: BuildSystem): void {
    const cmd = bs.context.cmd;
    const comp = bs.context.component!;
    if (comp.isMain && cmd.isDev) {
      this.log(
        chalk.blue(
          "打包插件到开发 data 目录: crawler-plugins:package-to-dev-data",
        ),
      );
      run("nx", ["run", "crawler-plugins:package-to-dev-data"], {
        bin: "bun",
      });
    } else if (comp.isMain && cmd.isBuild && !this.mode!.isAndroid) {
      // 注意：本步骤在 tauri/cargo 编译 kabegame 主程序之前执行（build-system.ts
      // 的 beforeBuild hook 早于实际编译调用），因此依赖 kabegame-cli release
      // sidecar（target/release/kabegame-cli[.exe]）已提前构建好（package-plugin.ts
      // 的 cliPackPlugin 通过它打包 .kgpg）。这是 package-to-dev-data 同样存在的
      // 既有约束：CI 中 .github/workflows/release.yml 已保证先 `bun b -c kabegame-cli`
      // 再 `bun b -c kabegame --release`；本地构建需遵循同样的顺序。
      this.log(
        chalk.blue(
          "打包插件到安装包资源目录: crawler-plugins:package-to-resources",
        ),
      );
      run("nx", ["run", "crawler-plugins:package-to-resources"], {
        bin: "bun",
      });
    }
  }
}
