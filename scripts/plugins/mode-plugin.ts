import { BasePlugin } from "./base-plugin.ts";
import {
  run,
  ROOT,
  FFMPEG_BUILD_DIR,
  FFMPEG_INSTALL_DIR,
  CEF_DIR_SUFFIX,
  TARGET_ARCH,
  IS_CROSS_COMPILE,
  CRAWLER_PLUGINS_DIR,
} from "../utils.ts";
import { Component } from "./component-plugin.ts";
import chalk from "chalk";
import { BuildSystem } from "../build-system.ts";
import { OSPlugin } from "./os-plugin.ts";
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
        !(
          bs.context.cmd!.isDev ||
          bs.context.cmd!.isBuild ||
          bs.context.cmd!.isCheck
        )
      ) {
        throw new Error("android mode 仅支持 dev、build 与 check 命令");
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
      // Android build 默认只出 aarch64:gen/android 的 RustPlugin.kt(ABI 收敛补丁)只创建
      // universal/arm64 两个 flavor,不带 --target 时 tauri CLI 按 Target::all() 全 4 ABI
      // 传 -ParchList=arm64,arm,...,gradle 配置期查 mergeArmDebugJniLibFolders 直接失败;
      // 其它 ABI 也没有自建 rusty_v8/FFmpeg 产物。显式传过 --target/-t 时不注入。
      // 仅 build 需要:dev 按连接设备选 target,check 固定 aarch64-linux-android。
      // (options 是浅冻结,args 数组本身可变;run.ts 保证 args 已初始化为数组。)
      if (modeObj.isAndroid && bs.context.cmd!.isBuild) {
        const tauriArgs = bs.options.args;
        const hasTarget = tauriArgs?.some(
          (a) =>
            a === "--target" ||
            a.startsWith("--target=") ||
            a === "-t" ||
            a.startsWith("-t="),
        );
        if (tauriArgs && !hasTarget) {
          tauriArgs.push("--target", "aarch64");
        }
      }
    });

    bs.hooks.prepareEnv.tap(this.name, () => {
      // 仅供前端 vite 注入展示与 build.rs 旧期间兼容；不再驱动 Rust 编译期分支。
      // 编译期 mode 现在通过 cargo --features 传递（见 prepareCompileArgs hook）。
      this.setEnv("KABEGAME_MODE", this.mode!.mode);
      this.setEnv("VITE_KABEGAME_MODE", this.mode!.mode);
      if (this.mode!.isAndroid) {
        this.setEnv("VITE_ANDROID", "true");
        this.setEnv("TAURI_PLATFORM", "android");
        // Android Java 包(源码目录/生成 Kotlin 包/JNI)固定为 app.kabegame,
        // 与按 mode 变化的 identifier(applicationId:dev=app.kabegame.dev / prod=app.kabegame)
        // 解耦。由 fork 的 cargo-tauri(third/tauri/crates/tauri-cli)消费,stock CLI 会忽略此变量。
        // 见 cocs/tauri/TAURI_CLI_FORK.md。
        this.setEnv("TAURI_ANDROID_PACKAGE", "app.kabegame");
        // rusty_v8 官方自 v0.102.0 起不再发布 aarch64-linux-android 预编译产物,
        // Android 交叉编译依赖自建产物(librusty_v8 静态库 + src_binding.rs),
        // 存放在仓库根 bin/android/(gitignore、不入库,由 `deno task build:v8` 复现;不放 bin/linux/
        // ——那里是 os-plugin 构建期生成并整目录进 deb 的。见 cocs/crawler/V8_RUNTIME.md)。
        // 直接是 .a(bin/android 已 gitignore,无需 gzip);v8 build.rs 的 copy_archive 原样拷贝。
        const rustyV8Dir = path.join(ROOT, "bin", "android");
        const rustyV8Archive = path.join(
          rustyV8Dir,
          "librusty_v8_simdutf_release_aarch64-linux-android.a",
        );
        const rustyV8Binding = path.join(
          rustyV8Dir,
          "src_binding_simdutf_release_aarch64-linux-android.rs",
        );
        if (!fs.existsSync(rustyV8Archive) || !fs.existsSync(rustyV8Binding)) {
          throw new Error(
            [
              `rusty_v8 Android 自建产物缺失: ${path.relative(ROOT, rustyV8Dir)}/`,
              "在 x86_64 Linux 上一次性复现(产物 gitignore、不入库):",
              "  deno task build:v8",
              "见 third-patches/rusty_v8/README.md 与 cocs/crawler/V8_RUNTIME.md。",
            ].join("\n"),
          );
        }
        this.setEnv("RUSTY_V8_ARCHIVE", rustyV8Archive);
        this.setEnv("RUSTY_V8_SRC_BINDING_PATH", rustyV8Binding);

        // 进程内 FFmpeg(rsmpeg):Android 视频预览/维度/兼容副本改走交叉编译的 aarch64
        // FFmpeg,取代此前慢速的 Kotlin 编码 provider(见 cocs/downloader-tasks/VIDEO_INGEST.md)。
        // 产物由 `deno task build:ffmpeg --target android` 生成到
        // third/FFmpeg-build/android/aarch64/install/(gitignore,不入库,命令复现)。
        const androidArch = "aarch64";
        const androidApi = process.env.ANDROID_API || "24";
        const ffmpegAndroidInstall = path.join(
          FFMPEG_BUILD_DIR,
          "android",
          androidArch,
          "install",
        );
        const ffmpegAndroidPkgConfig = path.join(
          ffmpegAndroidInstall,
          "lib",
          "pkgconfig",
        );
        if (
          !fs.existsSync(path.join(ffmpegAndroidPkgConfig, "libavcodec.pc"))
        ) {
          throw new Error(
            [
              `Android FFmpeg 产物缺失: ${path.relative(ROOT, ffmpegAndroidInstall)}/`,
              "需要(装好 NDK 的 Linux/macOS 宿主上)先交叉编译一次:",
              "  git submodule update --init third/FFmpeg third/x264",
              "  deno task build:ffmpeg --target android",
            ].join("\n"),
          );
        }
        this.setEnv("FFMPEG_PKG_CONFIG_PATH", ffmpegAndroidPkgConfig);
        this.setEnv("FFMPEG_LINK_MODE", "static");

        // bindgen(rusty_ffmpeg)解析 FFmpeg 头文件时必须按 android target + NDK sysroot,
        // 否则 clang 用宿主 sysroot/宿主 target 解析,类型宽度与宏定义错乱(仿桌面 macOS
        // 的 BINDGEN_EXTRA_CLANG_ARGS sysroot 注入)。NDK 定位顺序与 build-ffmpeg.sh 一致。
        let ndkDir =
          process.env.NDK_HOME ||
          process.env.ANDROID_NDK_HOME ||
          process.env.ANDROID_NDK_ROOT ||
          "";
        if (!ndkDir && process.env.ANDROID_HOME) {
          const ndkRoot = path.join(process.env.ANDROID_HOME, "ndk");
          if (fs.existsSync(ndkRoot)) {
            const versions = fs
              .readdirSync(ndkRoot)
              .filter((v) =>
                fs.statSync(path.join(ndkRoot, v)).isDirectory(),
              )
              .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
            if (versions.length) {
              ndkDir = path.join(ndkRoot, versions[versions.length - 1]);
            }
          }
        }
        if (!ndkDir || !fs.existsSync(ndkDir)) {
          throw new Error(
            "未找到 Android NDK。请设置 NDK_HOME(或 ANDROID_NDK_HOME/ANDROID_NDK_ROOT)。",
          );
        }
        const ndkHostTag = OSPlugin.isMacOS ? "darwin-x86_64" : "linux-x86_64";
        const ndkSysroot = path.join(
          ndkDir,
          "toolchains",
          "llvm",
          "prebuilt",
          ndkHostTag,
          "sysroot",
        );
        this.setEnv(
          "BINDGEN_EXTRA_CLANG_ARGS",
          `--sysroot=${ndkSysroot} -target ${androidArch}-linux-android${androidApi}`,
        );
        // rusty_ffmpeg 用 pkg-config crate 探测,默认拒绝交叉编译。我们自编的 .pc 用的是
        // android install 的绝对路径(无需 sysroot 前缀改写),放行即可直接使用。
        // 注意:放行交叉后,任何其它 -sys crate 的 pkg-config 探针也会命中宿主 .pc
        // (如 /usr/lib/pkgconfig/bzip2.pc),把 x86_64 的 `-L/usr/lib -lXXX` 注入 aarch64
        // 链接而失败。此类依赖须避开宿主 .pc:去掉用不到的 feature(如根 Cargo.toml 给 zip
        // 关掉默认的 bzip2/zstd,消除 bzip2-sys)、或走 vendored(如 openssl vendored)。
        this.setEnv("PKG_CONFIG_ALLOW_CROSS", "1");

        // 注:target 的 linker 与 TARGET_CC/CXX/AR 不在此手写。dev/build/check 都经 fork 的
        // `cargo tauri android {dev,build,check}`,由 cargo-mobile2 的 NDK Env 从 NDK 推导
        // 并注入(三者同源、随 minSdk/NDK 版本自动正确)。见 cocs/tauri/TAURI_CLI_FORK.md。
      } else {
        // 桌面 FFmpeg 安装前缀按目标架构取(macOS --target x86_64 时是独立的
        // third/FFmpeg-build/darwin/x86_64/install,与 arm64 产物隔离)。见 utils.FFMPEG_INSTALL_DIR。
        this.setEnv(
          "FFMPEG_PKG_CONFIG_PATH",
          path.join(FFMPEG_INSTALL_DIR, "lib", "pkgconfig"),
        );
        // Linux 将 FFmpeg 与 x264 显式静态链接；该模式还会让
        // rusty_ffmpeg 完整解析 .pc 的传递依赖，避免复用旧的链接元数据。
        if (OSPlugin.isLinux) {
          this.setEnv("FFMPEG_LINK_MODE", "static");
        }
        // Linux/Windows/macOS 用 CEF runtime。必须在任何 cargo 命令前设好
        // CEF_PATH,否则 cef-dll-sys 会下载官方无 H.264 的 CEF 覆盖 target 目录
        // (见 .cursor/rules/cef-path-set.mdc)。
        // 回退约定:Linux ~/i/cef-{dev,prod};Windows H:\cef-{dev,prod}；
        // macOS /Volumes/KIOXIA/cef-{dev,prod}(见 scripts/build-chromium.sh)。
        if (
          (OSPlugin.isLinux || OSPlugin.isWindows || OSPlugin.isMacOS) &&
          !this.mode!.isWeb
        ) {
          // dev/check 用 cef-dev(check 只需要任意有效 CEF 目录做编译,不打包);
          // dev/check 用 cef-dev，build 用 cef-prod。
          // macOS 跨编时 CEF runtime 也必须换成对应架构那一份:framework 的架构不匹配
          // 链接期才炸(且报错在 ld 层面,不可读),这里的默认路径直接按架构分叉,
          // 与 build-chromium.sh 的 export_dir(cef-<variant>[-x64])完全对齐。
          const cefVariant =
            (bs.context.cmd.isDev || bs.context.cmd.isCheck
              ? "cef-dev"
              : "cef-prod") + (OSPlugin.isMacOS ? CEF_DIR_SUFFIX : "");
          const cefPath =
            process.env.CEF_PATH ||
            (OSPlugin.isWindows
              ? path.join("H:", cefVariant)
              : OSPlugin.isMacOS
                ? path.join("/Volumes/KIOXIA", cefVariant)
                : path.join(os.homedir(), "i", cefVariant));
          // macOS 的 CEF runtime 是 framework(见 build-chromium.sh 导出结构),
          // Linux/Windows 是单个 libcef.so/dll。
          const cefRuntimeExists = OSPlugin.isMacOS
            ? fs.existsSync(
                path.join(cefPath, "Chromium Embedded Framework.framework"),
              )
            : fs.existsSync(
                path.join(cefPath, OSPlugin.isWindows ? "libcef.dll" : "libcef.so"),
              );
          if (!cefRuntimeExists) {
            throw new Error(
              [
                `CEF runtime not found in: ${cefPath}`,
                "Set CEF_PATH to an exported cef-rs runtime directory" +
                  (OSPlugin.isLinux || OSPlugin.isMacOS ? ", or run:" : "."),
                ...(OSPlugin.isLinux || OSPlugin.isMacOS
                  ? TARGET_ARCH
                    ? [
                        `scripts/build-chromium.sh dev --target ${TARGET_ARCH}`,
                        `scripts/build-chromium.sh prod --target ${TARGET_ARCH}`,
                      ]
                    : ["scripts/build-chromium.sh dev", "scripts/build-chromium.sh prod"]
                  : []),
              ].join("\n"),
            );
          }
          this.setEnv("CEF_PATH", cefPath);
          // Windows/macOS 不需要注入库搜索路径:Windows 由 cef-dll-sys build.rs
          // 把整个 CEF runtime 拷进 target/{debug,release}/(exe 同目录);macOS
          // 在运行时用 cef::library_loader 按绝对路径 dlopen 框架,无需 DYLD 路径。
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
            // 跨编时还必须显式给 target,否则 bindgen 用宿主 arch 解析 FFmpeg 头文件,
            // 与实际链接的另一架构静态库对不上(仿 android 分支的 --sysroot + -target 注入)。
            const crossTarget =
              IS_CROSS_COMPILE && TARGET_ARCH
                ? ` -target ${TARGET_ARCH === "x86_64" ? "x86_64" : "arm64"}-apple-darwin`
                : "";
            this.setEnv("BINDGEN_EXTRA_CLANG_ARGS", `-isysroot ${sdkPath}${crossTarget}`);
          } catch {
            this.log(chalk.yellow("Warning: xcrun failed — BINDGEN_EXTRA_CLANG_ARGS not set. bindgen may fail to find system headers."));
          }
          // 跨编时 rusty_ffmpeg 的 build.rs 用 pkg-config crate 静态探测,而它默认
          // 拒绝交叉编译(host≠target)直接 panic。我们自编的 x64 .pc 用的是 x64 install
          // 的绝对路径(无需 sysroot 前缀改写),放行即可直接消费(仿 android 分支)。
          // 非跨编(--target 同宿主架构或不传)时 host==target,pkg-config crate 根本
          // 不检查该 env,设了也无副作用——但仅在跨编时设,语义更清晰。
          if (IS_CROSS_COMPILE) {
            this.setEnv("PKG_CONFIG_ALLOW_CROSS", "1");
          }
        }
        // windows: libs dir
        else if (OSPlugin.isWindows) {
          const ffmpegBinDir = path.join(FFMPEG_INSTALL_DIR, "bin");
          this.setEnv("FFMPEG_LIBS_DIR", ffmpegBinDir);
          this.setEnv(
            "FFMPEG_INCLUDE_DIR",
            path.join(FFMPEG_INSTALL_DIR, "include"),
          );
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
          "打包插件到开发 data 目录: deno task package --out-dir ../.kabegame/debug/data/plugins-directory",
        ),
      );
      run("package", ["--out-dir", "../.kabegame/debug/data/plugins-directory"], {
        bin: "deno-task",
        cwd: CRAWLER_PLUGINS_DIR,
      });
    } else if (comp.isMain && cmd.isBuild && !this.mode!.isAndroid) {
      // 注意：本步骤在 tauri/cargo 编译 kabegame 主程序之前执行（build-system.ts
      // 的 beforeBuild hook 早于实际编译调用），因此依赖 kabegame-cli release
      // sidecar（target/release/kabegame-cli[.exe]）已提前构建好（package-plugin.ts
      // 的 cliPackPlugin 通过它打包 .kgpg）。CI 中 .github/workflows/release.yml
      // 已保证先 `deno task b -c kabegame-cli` 再 `deno task b -c kabegame --release`；
      // 本地构建需遵循同样的顺序。
      this.log(
        chalk.blue(
          "打包插件到安装包资源目录: deno task package --out-dir ../src-tauri/kabegame/resources/plugins",
        ),
      );
      run("package", ["--out-dir", "../src-tauri/kabegame/resources/plugins"], {
        bin: "deno-task",
        cwd: CRAWLER_PLUGINS_DIR,
      });
    }
  }
}
