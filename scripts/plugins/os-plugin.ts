import { BuildSystem } from "../build-system.ts";
import { BasePlugin } from "./base-plugin.ts";
import { Component } from "./component-plugin.ts";
import {
  ROOT,
  TARGET_DIR,
  FFMPEG_BUILD_DIR,
  RESOURCES_BIN_DIR,
  RESOURCES_DIR,
  ensureDir,
  existsFile,
  findFirstExisting,
  stageResourceFile,
} from "../utils.ts";
import chalk from "chalk";
import { execSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

// CEF 运行时白名单:除下列单文件外,locales 只保留 kabegame 支持的 UI 语言 + en-US 回退
// (CEF locales 是 Chromium 自身 UI 文案,与 app 的 Vue i18n 无关;全量 220 个 ~50MB)。
const CEF_RUNTIME_FILES = [
  "libcef.so",
  "libEGL.so",
  "libGLESv2.so",
  "libvulkan.so.1",
  "libvk_swiftshader.so",
  "vk_swiftshader_icd.json",
  "icudtl.dat",
  "v8_context_snapshot.bin",
  "chrome_100_percent.pak",
  "chrome_200_percent.pak",
  "resources.pak",
];
// Windows CEF 运行时白名单(对照 windows64 minimal distrib 实有文件;无 snapshot_blob.bin,
// 该 build 用 v8_context_snapshot;no-sandbox 传统 exe 模式,不需要 bootstrap.exe/cef_sandbox)。
// 收集到 resources/cef/,安装期由 NSIS hook 搬到 $INSTDIR(libcef.dll 是 load-time 链接,
// CEF 要求 dll/pak/dat/locales 与 exe 同目录)。
const WINDOWS_CEF_RUNTIME_FILES = [
  "libcef.dll",
  "chrome_elf.dll",
  "icudtl.dat",
  "v8_context_snapshot.bin",
  "resources.pak",
  "chrome_100_percent.pak",
  "chrome_200_percent.pak",
  "libEGL.dll",
  "libGLESv2.dll",
  "vk_swiftshader.dll",
  "vk_swiftshader_icd.json",
  "vulkan-1.dll",
  "d3dcompiler_47.dll",
  "dxcompiler.dll",
  "dxil.dll",
];
// en-US.pak 必留(CEF 找不到系统语言时回退它,缺失会启动报错)。
const CEF_LOCALES = ["en-US.pak", "zh-CN.pak", "zh-TW.pak", "ja.pak", "ko.pak"];

// Windows 运行时 DLL 清单（位于仓库根 bin/windows/，构建时复制到 resources/bin）。
// 仅 libav*（由 scripts/build-ffmpeg.sh 产出，FFmpeg 8.x 主版本后缀）；
// libx264 静态嵌入 avcodec-*.dll，libwinpthread 静态嵌入 avutil-*.dll，均无需单独打包。
// 实际复制以 bin/windows/ 下发现的所有 *.dll 为准（见 OSPlugin.copyFFmpegDllsToResources），本清单为预期 manifest。
const WINDOWS_FFMPEG_DLLS_EXPECTED = [
  // libwinpthread 已静态链接进 avutil-*.dll（见 scripts/build-ffmpeg.sh），无需再单独打包。
  // libav*（FFmpeg 8.2：avcodec/avformat 62、avutil 60、avfilter 11、swscale 9、swresample 6）
  "avcodec-62.dll",
  "avformat-62.dll",
  "avutil-60.dll",
  "avfilter-11.dll",
  "swscale-9.dll",
  "swresample-6.dll",
];

// 经 ROOT 拼出,避免与 build-system.ts 形成循环导入(后者反过来 import OSPlugin)
const FFMPEG_INSTALL_DIR = path.join(FFMPEG_BUILD_DIR, "install");

export class OSPlugin extends BasePlugin {
  constructor() {
    super("OSPlugin");
  }

  static get isLinux(): boolean {
    return process.platform === "linux" && !OSPlugin.isAndroid;
  }

  static get isWindows(): boolean {
    return process.platform === "win32" && !OSPlugin.isAndroid;
  }

  static get isMacOS(): boolean {
    return process.platform === "darwin" && !OSPlugin.isAndroid;
  }

  static get isUnix(): boolean {
    return (OSPlugin.isLinux || OSPlugin.isMacOS) && !OSPlugin.isAndroid;
  }

  static isAndroid: boolean = false;

  /** 平台对应的暂存目录,build 期产物在此（Linux/macOS 完全生成,Windows 部分预置 + 部分生成） */
  static get binDir(): string {
    if (OSPlugin.isWindows) return path.join(ROOT, "bin", "windows");
    if (OSPlugin.isLinux) return path.join(ROOT, "bin", "linux");
    if (OSPlugin.isMacOS) return path.join(ROOT, "bin", "macos");
    return path.join(ROOT, "bin");
  }

  /** Linux/macOS 子目录是否完全由本插件生成（用于在收集前清空） */
  private static isGeneratedPlatformDir(): boolean {
    return OSPlugin.isLinux || OSPlugin.isMacOS;
  }

  apply(bs: BuildSystem): void {
    bs.hooks.prepareCompileArgs.tap(
      this.name,
      // @ts-ignore
      (
        nullOrCompOrResult:
          | null
          | string
          | { comp: Component; features: string[]; args?: string[] },
      ) => {
        const args: string[] = [];

        // 处理 waterfall hook 的输入
        if (typeof nullOrCompOrResult === "object" && nullOrCompOrResult !== null && "comp" in nullOrCompOrResult) {
          return {
            comp: nullOrCompOrResult.comp,
            features: nullOrCompOrResult.features || [],
            args: [...(nullOrCompOrResult.args || []), ...args],
          };
        }

        const comp =
          typeof nullOrCompOrResult === "string"
            ? new Component(nullOrCompOrResult)
            : bs.context.component!;

        return {
          comp,
          features: [],
          args,
        };
      },
    );

    // 仅 build 期、main 组件、桌面平台才走 bundleLibs;android/web 跳过
    bs.hooks.beforeBuild.tap(this.name, (comp?: string) => {
      if (!bs.context.cmd?.isBuild) return;
      const component = comp ? new Component(comp) : bs.context.component!;
      if (!component.isMain) return;
      if (bs.context.mode?.isWeb || bs.context.mode?.isAndroid) return;
      this.bundleLibs(bs);
    });

    bs.hooks.beforeRun.tap(this.name, (comp?: string) => {
      const component = comp ? new Component(comp) : bs.context.component!;
      if (component.isMain && OSPlugin.isMacOS) {
        if (bs.context.mode?.isWeb || bs.context.mode?.isAndroid) return;
        this.ensureMacOSCefHelper(bs.options.release ? "release" : "debug");
        return;
      }
    });

    // Linux deb 的 WebKit 依赖不再需要后处理剥除:fork 的 cargo-tauri
    // (third/tauri/crates/tauri-cli)按 TAURI_NO_WEBKIT_DEPS 直接不注入,并对 Depends 去重。
  }

  // ===== 主入口:按平台分发 =====
  private bundleLibs(bs: BuildSystem): void {
    this.verifyFFmpegBuildArtifacts();
    if (OSPlugin.isWindows) {
      // standard 需要 Dokan + 安装器
      if (bs.context.mode?.isStandard) {
        this.copyDokan2DllToResources();
        this.copyDokanInstallerToResources();
      }
      this.collectWindowsFFmpegDlls();
      this.copyFFmpegDllsToResources();
      this.copyDokan2DllToTauriReleaseDirBestEffort();
      // Windows standard 用 CEF runtime;打包其运行时文件(libcef.dll + 资源 + locales)。
      if (bs.context.mode?.isStandard) {
        this.verifyCefArtifacts();
        this.collectWindowsCefRuntime();
      }
    } else if (OSPlugin.isLinux) {
      // 注意:collectLinuxSharedLibs() 会先清空 bin/linux/,CEF 收集必须排在其后。
      this.collectLinuxSharedLibs();
      // Linux standard 用 CEF runtime;打包其运行时文件(libcef.so + 资源 + locales)。
      if (bs.context.mode?.isStandard) {
        this.verifyCefArtifacts();
        this.collectLinuxCefLibs();
      }
    } else if (OSPlugin.isMacOS) {
      this.collectMacOSDylibs();
    }
  }

  // ===== FFmpeg 构建产物校验(三平台共用前置检查) =====
  private verifyFFmpegBuildArtifacts(): void {
    if (OSPlugin.isUnix) {
      const archive = path.join(FFMPEG_INSTALL_DIR, "lib", "libavcodec.a");
      if (!existsFile(archive)) {
        throw new Error(
          [
            `❌ 未找到 FFmpeg 构建产物: ${path.relative(ROOT, archive)}`,
            `请先运行: deno task build:ffmpeg`,
            `(脚本 scripts/build-ffmpeg.sh 会编出 libav*.a 到 third/FFmpeg-build/install/lib/)`,
          ].join("\n"),
        );
      }
    } else if (OSPlugin.isWindows) {
      const installBin = path.join(FFMPEG_INSTALL_DIR, "bin");
      const exists =
        fs.existsSync(installBin) &&
        fs
          .readdirSync(installBin)
          .some((f) => /^avcodec-\d+\.dll$/i.test(f));
      if (!exists) {
        throw new Error(
          [
            `❌ 未找到 FFmpeg 构建产物: ${path.relative(ROOT, installBin)}/avcodec-*.dll`,
            `请在 MSYS2 MinGW 64-bit 终端中运行: deno task build:ffmpeg`,
          ].join("\n"),
        );
      }
    }
  }

  // ===== Windows:从 third/FFmpeg-build/install/bin + MSYS2 mingw64 收集到 bin/windows/ =====
  private collectWindowsFFmpegDlls(): void {
    const dst = OSPlugin.binDir;
    ensureDir(dst);
    // 1) libav* + swscale-* + swresample-*(跳过 avdevice-*)
    const installBin = path.join(FFMPEG_INSTALL_DIR, "bin");
    const ffmpegDlls = fs
      .readdirSync(installBin)
      .filter(
        (f) =>
          /^(av(codec|format|util|filter)|swscale|swresample)-\d+\.dll$/i.test(
            f,
          ) && !f.startsWith("avdevice-"),
      );
    if (ffmpegDlls.length === 0) {
      throw new Error(
        `❌ ${path.relative(ROOT, installBin)} 中未发现 libav* DLL;请重新运行 deno task build:ffmpeg`,
      );
    }
    for (const f of ffmpegDlls) {
      fs.copyFileSync(path.join(installBin, f), path.join(dst, f));
      this.log(chalk.cyan(`已收集 FFmpeg DLL → bin/windows/${f}`));
    }
  }

  // ===== Linux:pkg-config 收集到 bin/linux/ =====
  private collectLinuxSharedLibs(): void {
    const dst = OSPlugin.binDir;
    if (OSPlugin.isGeneratedPlatformDir()) {
      fs.rmSync(dst, { recursive: true, force: true });
    }
    ensureDir(dst);

    // Linux 不捆 libfuse.so:fuser 关闭 libfuse feature 走纯 Rust 挂载,二进制根本不链接
    // libfuse(启动无 DT_NEEDED,挂载时懒执行 fusermount3),运行时只需 SUID fusermount3(apt fuse3)。
    // FFmpeg、x264 均已静态链接；这里只处理显式附加的动态库。
    const packages: string[] = [];
    for (const pkg of packages) {
      let libdir = "";
      try {
        libdir = execSync(`pkg-config --variable=libdir ${pkg}`, {
          encoding: "utf8",
        }).trim();
      } catch (e) {
        throw new Error(
          [
            `❌ pkg-config 找不到 ${pkg}(运行: pkg-config --variable=libdir ${pkg})`,
            `请安装开发包,例如:apt install lib${pkg}-dev`,
          ].join("\n"),
        );
      }
      if (!libdir || !fs.existsSync(libdir)) {
        throw new Error(`pkg-config 返回的 libdir 不存在: ${libdir}`);
      }
      // 复制带版本号的 SONAME 实文件(如 libx264.so.163),跳过 dev 包的无版本符号链接
      const pattern = new RegExp(`^lib${pkg}\\.so\\.\\d+`);
      const files = fs.readdirSync(libdir).filter((f) => pattern.test(f));
      if (files.length === 0) {
        throw new Error(
          `❌ 未在 ${libdir} 找到 lib${pkg}.so.*;请确认 lib${pkg}-dev 已安装`,
        );
      }
      for (const f of files) {
        const src = path.join(libdir, f);
        let realpath = src;
        try {
          realpath = fs.realpathSync(src);
        } catch {
          // ignore — fall back to src
        }
        fs.copyFileSync(realpath, path.join(dst, f));
        this.log(
          chalk.cyan(`已收集 Linux 库 → bin/linux/${f}(来源: ${realpath})`),
        );
      }
    }

    this.appendExtraLibs(dst);
  }

  // ===== CEF runtime(Linux/Windows/MacOS !isWeb)=====
  // 这里的收集和验证只在 Linux和Windows运行，因为MacOS通过tauri framworks 来打包
  // CEF 目录解析与 mode-plugin 一致:优先 CEF_PATH(prepareEnv 已设),
  // 回退 Linux ~/i/cef-prod、Windows H:\cef-prod。
  private cefDir(): string {
    return (
      process.env.CEF_PATH ||
      (OSPlugin.isWindows
        ? path.join("H:", "cef-prod")
        : path.join(os.homedir(), "i", "cef-prod"))
    );
  }

  // 前置校验:缺少 CEF 运行时则报错并提示导出命令(类比 verifyFFmpegBuildArtifacts)。
  private verifyCefArtifacts(): void {
    const dir = this.cefDir();
    const libcef = OSPlugin.isWindows ? "libcef.dll" : "libcef.so";
    const missing = [libcef, "icudtl.dat"].filter(
      (f) => !existsFile(path.join(dir, f)),
    );
    if (missing.length > 0) {
      throw new Error(
        [
          `❌ 未找到 CEF 运行时产物: ${missing.join(", ")}(目录: ${dir})`,
          `请先导出 CEF(release/minimal)或设置 CEF_PATH:`,
          ...(OSPlugin.isWindows
            ? [`  在 Windows 上设置 CEF_PATH 指向已构建的 CEF 发行版目录`]
            : [
                `  scripts/build-chromium.sh prod`,
                `  # 开发运行时: scripts/build-chromium.sh dev`,
              ]),
        ].join("\n"),
      );
    }
  }

  // 收集 CEF runtime 文件 + locales 白名单到 bin/linux/(供 deb 注入到 /usr/lib/kabegame/)。
  private collectLinuxCefLibs(): void {
    const dst = OSPlugin.binDir;
    ensureDir(dst);
    const src = this.cefDir();

    for (const f of CEF_RUNTIME_FILES) {
      const s = path.join(src, f);
      if (!fs.existsSync(s)) {
        throw new Error(`❌ CEF 运行时缺少文件: ${f}(目录: ${src})`);
      }
      let realpath = s;
      try {
        realpath = fs.realpathSync(s);
      } catch {
        // ignore — fall back to s
      }
      fs.copyFileSync(realpath, path.join(dst, f));
      this.log(chalk.cyan(`已收集 CEF 文件 → bin/linux/${f}`));
    }

    // locales 白名单(全量 ~50MB,白名单 ~1.5MB)
    const localesDst = path.join(dst, "locales");
    ensureDir(localesDst);
    let copied = 0;
    for (const f of CEF_LOCALES) {
      const s = path.join(src, "locales", f);
      if (!fs.existsSync(s)) {
        if (f === "en-US.pak") {
          throw new Error(
            `❌ CEF locales 缺少 en-US.pak(CEF 必需的回退语言): ${path.join(src, "locales")}`,
          );
        }
        this.log(chalk.yellow(`CEF locale 缺失(跳过): ${f}`));
        continue;
      }
      fs.copyFileSync(s, path.join(localesDst, f));
      copied++;
    }
    this.log(
      chalk.cyan(`已收集 CEF locales(白名单 ${copied}/${CEF_LOCALES.length})→ bin/linux/locales/`),
    );
  }

  // 收集 Windows CEF runtime 文件 + locales 白名单到 resources/cef/。
  // 经 tauri.conf 的 `resources/**/*` 进 NSIS 安装包,POSTINSTALL hook 再把
  // resources\cef\ 下的文件搬到 $INSTDIR(exe 同目录),locales 搬到 $INSTDIR\locales\。
  private collectWindowsCefRuntime(): void {
    const dst = path.join(RESOURCES_DIR, "cef");
    // 全量生成目录:先清空,避免残留旧版本文件
    fs.rmSync(dst, { recursive: true, force: true });
    ensureDir(dst);
    const src = this.cefDir();

    for (const f of WINDOWS_CEF_RUNTIME_FILES) {
      const s = path.join(src, f);
      if (!fs.existsSync(s)) {
        throw new Error(`❌ CEF 运行时缺少文件: ${f}(目录: ${src})`);
      }
      fs.copyFileSync(s, path.join(dst, f));
      this.log(chalk.cyan(`已收集 CEF 文件 → resources/cef/${f}`));
    }

    // locales 白名单(全量 220+ 个,白名单 ~5 个)
    const localesDst = path.join(dst, "locales");
    ensureDir(localesDst);
    let copied = 0;
    for (const f of CEF_LOCALES) {
      const s = path.join(src, "locales", f);
      if (!fs.existsSync(s)) {
        if (f === "en-US.pak") {
          throw new Error(
            `❌ CEF locales 缺少 en-US.pak(CEF 必需的回退语言): ${path.join(src, "locales")}`,
          );
        }
        this.log(chalk.yellow(`CEF locale 缺失(跳过): ${f}`));
        continue;
      }
      fs.copyFileSync(s, path.join(localesDst, f));
      copied++;
    }
    this.log(
      chalk.cyan(
        `已收集 CEF locales(白名单 ${copied}/${CEF_LOCALES.length})→ resources/cef/locales/`,
      ),
    );
  }

  // ===== macOS:仅保留 KABEGAME_BUNDLE_LIBS_EXTRA 逃生口(x264 已静态嵌入 FFmpeg,libfuse 弱链接懒加载) =====
  private collectMacOSDylibs(): void {
    const dst = OSPlugin.binDir;
    if (OSPlugin.isGeneratedPlatformDir()) {
      fs.rmSync(dst, { recursive: true, force: true });
    }
    ensureDir(dst);
    this.appendExtraLibs(dst);
  }

  // ===== 通用:KABEGAME_BUNDLE_LIBS_EXTRA env 覆盖 =====
  private appendExtraLibs(dst: string): void {
    const extra = (process.env.KABEGAME_BUNDLE_LIBS_EXTRA ?? "").trim();
    if (!extra) return;
    for (const raw of extra
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)) {
      if (!fs.existsSync(raw)) {
        throw new Error(
          `KABEGAME_BUNDLE_LIBS_EXTRA 指向的文件不存在: ${raw}`,
        );
      }
      const realpath = fs.realpathSync(raw);
      fs.copyFileSync(realpath, path.join(dst, path.basename(raw)));
      this.log(chalk.cyan(`已收集额外库 → ${path.basename(raw)}(来源: ${realpath})`));
    }
  }

  private ensureMacOSCefHelper(profile: "debug" | "release"): string {
    const helper = path.join(TARGET_DIR, profile, "kabegame-cef-helper");
    if (!fs.existsSync(helper)) {
      throw new Error(
        [
          `❌ 缺少 kabegame-cef-helper 可执行文件: ${path.relative(ROOT, helper)}`,
          `请先构建 kabegame 主组件${profile === "release" ? " release" : " dev"} 产物`,
        ].join("\n"),
      );
    }
    this.log(
      chalk.cyan(
        `macOS 使用扁平 CEF helper (${profile}): ${path.relative(ROOT, helper)}`,
      ),
    );
    return helper;
  }

  // ===== Windows DLL → resources/bin(给 Tauri 安装包打入) =====
  copyFFmpegDllsToResources(): void {
    if (!OSPlugin.isWindows) return;
    const src = OSPlugin.binDir;
    if (!fs.existsSync(src) || !fs.statSync(src).isDirectory()) return;
    const entries = fs.readdirSync(src, { withFileTypes: true });
    const dlls = entries.filter(
      (e) => e.isFile() && e.name.toLowerCase().endsWith(".dll"),
    );
    if (dlls.length === 0) return;
    ensureDir(RESOURCES_BIN_DIR);
    for (const e of dlls) {
      stageResourceFile(path.join(src, e.name), e.name);
    }
    // 预期 manifest 缺失告警
    const present = new Set(dlls.map((e) => e.name.toLowerCase()));
    for (const expected of WINDOWS_FFMPEG_DLLS_EXPECTED) {
      if (!present.has(expected.toLowerCase())) {
        this.log(
          chalk.yellow(
            `[build] 预期 DLL 缺失(未在 bin/windows/ 找到): ${expected}`,
          ),
        );
      }
    }
  }

  // ===== Dokan2.dll → resources/bin =====
  copyDokan2DllToResources(): void {
    if (!OSPlugin.isWindows) return;
    const dst = path.join(RESOURCES_BIN_DIR, "dokan2.dll");
    if (existsFile(dst)) return;
    const src = OSPlugin.findDokan2DllOnWindows();
    if (!src) {
      this.log(
        chalk.yellow(
          `⚠ 未在系统中找到 dokan2.dll,将继续构建/启动,但"虚拟磁盘"功能将不可用。\n\n` +
            `如果你需要虚拟磁盘:\n` +
            `1) 安装 Dokan 2.x;或\n` +
            `2) 设置环境变量 DOKAN2_DLL 指向 dokan2.dll,例如:\n` +
            `   $env:DOKAN2_DLL="C:\\\\Program Files\\\\Dokan\\\\Dokan Library-2.3.1\\\\dokan2.dll"\n`,
        ),
      );
      return;
    }
    ensureDir(RESOURCES_BIN_DIR);
    fs.copyFileSync(src, dst);
    this.log(
      chalk.cyan(
        `[build] Staged dokan2.dll resource: ${path.relative(
          ROOT,
          dst,
        )} (from: ${src})`,
      ),
    );
  }

  copyDokanInstallerToResources(): void {
    if (!OSPlugin.isWindows) return;
    const fromEnv = (process.env.DOKAN_INSTALLER ?? "").trim();
    const fixed = path.join(OSPlugin.binDir, "dokan-installer.exe");
    let src = findFirstExisting([fromEnv, fixed].filter(Boolean));
    if (!src) {
      try {
        if (fs.existsSync(OSPlugin.binDir)) {
          const files = fs.readdirSync(OSPlugin.binDir);
          const hit = files.find((f: string) => {
            const lower = f.toLowerCase();
            return (
              lower.includes("dokan") &&
              (lower.endsWith(".exe") || lower.endsWith(".msi"))
            );
          });
          if (hit) {
            const p = path.join(OSPlugin.binDir, hit);
            if (existsFile(p)) src = p;
          }
        }
      } catch {
        // ignore
      }
    }
    if (!src) {
      this.log(
        chalk.yellow(
          `[build] Dokan installer not staged (optional). To bundle it, set env DOKAN_INSTALLER or put bin/windows/dokan-installer.exe`,
        ),
      );
      return;
    }
    stageResourceFile(src, "dokan-installer.exe");
  }

  copyDokan2DllToTauriReleaseDirBestEffort(): void {
    if (!OSPlugin.isWindows) return;
    const src = path.join(RESOURCES_BIN_DIR, "dokan2.dll");
    if (!existsFile(src)) return;
    const dst = path.join(TARGET_DIR, "release", "dokan2.dll");
    try {
      fs.copyFileSync(src, dst);
      this.log(
        chalk.cyan(
          `[build] Copied dokan2.dll next to target/release exe: ${path.relative(
            ROOT,
            dst,
          )}`,
        ),
      );
    } catch {
      // ignore (some environments may lock the file)
    }
  }

  // ===== Dokan2.dll 发现:env / 仓库 bin / 系统 / Program Files =====
  static findDokan2DllOnWindows(): string | null {
    if (!OSPlugin.isWindows) return null;

    const bundled = path.join(OSPlugin.binDir, "dokan2.dll");
    if (existsFile(bundled)) return bundled;

    const fromEnv = (process.env.DOKAN2_DLL ?? "").trim();
    if (fromEnv) {
      if (existsFile(fromEnv)) return fromEnv;
      throw new Error(
        `环境变量 DOKAN2_DLL 指向的文件不存在: ${fromEnv}\n` +
          `请改为 dokan2.dll 的绝对路径。`,
      );
    }

    const sysCandidates = [
      path.join(process.env.WINDIR ?? "C:\\Windows", "System32", "dokan2.dll"),
      path.join(process.env.WINDIR ?? "C:\\Windows", "SysWOW64", "dokan2.dll"),
    ];
    const sys = findFirstExisting(sysCandidates);
    if (sys) return sys;

    const programFiles = process.env["ProgramFiles"] ?? "C:\\Program Files";
    const dokanRoot = path.join(programFiles, "Dokan");
    try {
      if (fs.existsSync(dokanRoot) && fs.statSync(dokanRoot).isDirectory()) {
        const entries = fs.readdirSync(dokanRoot, { withFileTypes: true });
        const dirs = entries
          .filter((e: any) => e.isDirectory())
          .map((e: any) => e.name)
          .filter((name: string) => name.toLowerCase().includes("dokan"));

        const candidates: string[] = [];
        for (const d of dirs) {
          candidates.push(path.join(dokanRoot, d, "dokan2.dll"));
          candidates.push(path.join(dokanRoot, d, "x64", "dokan2.dll"));
          candidates.push(path.join(dokanRoot, d, "bin", "dokan2.dll"));
          candidates.push(path.join(dokanRoot, d, "bin", "x64", "dokan2.dll"));
        }
        const found = findFirstExisting(candidates);
        if (found) return found;
      }
    } catch {
      // ignore
    }

    return null;
  }
}
