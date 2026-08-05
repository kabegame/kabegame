/**
 * 编译带专利编码（H.264/AAC/MP4）的 CEF（Chromium Embedded Framework）。
 * 官方 Spotify 预编译版用 ffmpeg_branding=Chromium，不含 H.264/AAC；这里用
 * proprietary_codecs=true + ffmpeg_branding=Chrome 自己编一份，供 tauri-runtime-cef 使用。
 *
 * 用法：
 *   deno task build:chromium dev
 *   deno task build:chromium prod
 *   deno task build:chromium dev --clean
 *   deno task build:chromium prod --clean
 *   deno task build:chromium prod --target x86_64   # 仅 macOS，跨编 Intel 版 CEF
 *
 * --target x86_64|arm64（仅 macOS）：在一台 Mac 上为另一架构编 CEF。默认宿主架构，
 * 即 Apple Silicon 上不传时行为与以往完全一致。两种架构共用 Chromium checkout，
 * 只用 out/Release_GN_{arm64,x64} 隔离 GN 输出；runtime 则分别导出到：
 *   bin/macos/arm64/cef-build-{dev,prod}
 *   bin/macos/x86_64/cef-build-{dev,prod}
 * 想彻底分开 checkout 可用 CEFBUILD 环境变量各指一处，代价是多一份数十 G 的源码树。
 *
 * 默认路径（路径公式全部来自 scripts/paths.ts）：
 *   构建根：third/chromium（CHROMIUM_DIR，不带 platform/arch 维度）
 *   runtime：bin/{platform}/{arch}/cef-build-{dev,prod}（cefExportDir）
 * CEFBUILD 可覆盖构建根；CEF_EXPORT_ROOT 可覆盖 runtime 的父目录，覆盖后导出到
 * <root>/cef-build-{variant}。CEF_SOURCE 默认仍为 third/cef。
 *
 * Linux 关键前提：Chromium/CEF 的源码树重度依赖符号链接、POSIX 权限和大小写敏感，
 * exFAT/NTFS 都不行，构建根必须位于 POSIX 文件系统。
 *
 * Windows 关键前提：在 MSYS2 环境中运行，建议从 VS x64 Native Tools 环境启动
 * msys2_shell.cmd -mingw64/-msys -use-full-path，并确保构建根位于 NTFS 盘。
 *
 * macOS 关键前提：完整 Xcode/macOS SDK；构建空间必须是 APFS/HFS+ 等支持符号链接的
 * 文件系统，不能是 exFAT。Apple Silicon 上可经 --target x86_64 跨编 Intel 版。
 */

import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import {
  BUILD_PLATFORM,
  cefExportDir,
  CHROMIUM_DIR,
  HOST_ARCH,
  normalizeTargetArch,
  ROOT,
  TARGET_ARCH,
  THIRD_DIR,
  type TargetArch,
} from "./paths.ts";

type Variant = "dev" | "prod";

interface ParsedArgs {
  variant: Variant;
  clean: boolean;
  targetArch?: TargetArch;
}

interface WindowsPathBridge {
  cygpath: string;
  toMsys(pathname: string): string;
  toMixed(pathname: string): string;
  toWindows(pathname: string): string;
}

interface BuildContext {
  variant: Variant;
  clean: boolean;
  targetArch?: TargetArch;
  archivePlatform: string;
  archFlag: "--x64-build" | "--arm64-build";
  gnOut: string;
  runtimeLib: string;
  pythonBin: string;
  cefBuild: string;
  cefSource: string;
  exportDir: string;
  env: NodeJS.ProcessEnv;
  noHistory: string;
  gclientJobs: string;
  ninjaJobs: string;
  cefBranch: string;
  cefRsArchiveVersion: string;
  windows?: WindowsPathBridge;
  cefSourceCommit?: string;
  cefSourceUrl?: string;
  pgoFlags: string[];
  distribFlags: string[];
  updateFlags: string[];
}

// CEF_BRANCH 对应 CEF 149.0.x / Chromium 149.0.7827.x，与 cef-rs "149" 对齐；
// CEF_RS_ARCHIVE_VERSION 对应 Cargo.lock 中 cef-dll-sys 使用的 archive 版本。
//
// NO_HISTORY=1 只拉当前分支 tip。完整 chromium/src 历史体积巨大，代理下单次 fetch
// 容易中断且不可续传；已有全量残包切换为浅 checkout 时需带 --clean。
//
// GCLIENT_JOBS 限制 DEPS 同步并发。automate-git.py 不透传 --jobs，只能用 PATH shim
// 包住 gclient；NINJA_JOBS 则通过 autoninja 的 NINJA_CORE_LIMIT 限制编译并发，避免 OOM。

function log(message: string): void {
  console.log(`\x1b[1;36m[build-chromium]\x1b[0m ${message}`);
}

function die(message: string, code = 1): never {
  console.error(`\x1b[1;31m[build-chromium] 错误:\x1b[0m ${message}`);
  process.exit(code);
}

function usageError(message?: string): never {
  if (message) console.error(message);
  console.error(
    "用法: deno task build:chromium [dev|prod] [--clean] [--target x86_64|arm64]",
  );
  process.exit(2);
}

function parseArgs(argv: string[]): ParsedArgs {
  const rawVariant = argv[0] ?? "dev";
  if (rawVariant !== "dev" && rawVariant !== "prod") {
    usageError();
  }

  let clean = false;
  let rawTarget: string | undefined;
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--clean") {
      clean = true;
    } else if (arg === "--target") {
      rawTarget = argv[++i];
      if (!rawTarget) usageError("--target 缺少参数");
    } else if (arg.startsWith("--target=")) {
      rawTarget = arg.slice("--target=".length);
      if (!rawTarget) usageError("--target 缺少参数");
    } else {
      usageError(`未知参数: ${arg}`);
    }
  }

  let targetArch = TARGET_ARCH;
  if (rawTarget) {
    try {
      targetArch = normalizeTargetArch(rawTarget);
    } catch (error) {
      die(error instanceof Error ? error.message : String(error));
    }
    if (BUILD_PLATFORM !== "macos") {
      die(
        `--target 仅在 macOS 上支持（跨编 x86_64 / arm64）；当前宿主: ${process.platform}`,
      );
    }
  }

  return { variant: rawVariant, clean, targetArch };
}

function capture(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; quiet?: boolean } = {},
): string {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? ROOT,
    env: options.env ?? process.env,
    shell: false,
    encoding: "utf8",
    stdio: options.quiet
      ? ["ignore", "pipe", "ignore"]
      : ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0) {
    const detail = result.error?.message ?? result.stderr?.trim();
    die(`执行 ${command} 失败${detail ? `: ${detail}` : ""}`);
  }
  return result.stdout.trim();
}

function commandSucceeds(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): boolean {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? ROOT,
    env: options.env ?? process.env,
    shell: false,
    stdio: "ignore",
  });
  return !result.error && result.status === 0;
}

function run(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    failureMessage?: string;
  } = {},
): void {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? ROOT,
    env: options.env ?? process.env,
    shell: false,
    stdio: "inherit",
  });
  if (result.error) die(`无法执行 ${command}: ${result.error.message}`);
  if (result.status !== 0) {
    die(
      options.failureMessage ??
        `${command} 执行失败（退出码 ${result.status ?? "unknown"}）`,
    );
  }
}

function envOr(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

function createWindowsPathBridge(): WindowsPathBridge {
  const candidates: string[] = [];
  if (process.env.MSYS2_ROOT) {
    candidates.push(
      path.join(process.env.MSYS2_ROOT, "usr", "bin", "cygpath.exe"),
    );
  }
  candidates.push("C:\\msys64\\usr\\bin\\cygpath.exe", "cygpath.exe");
  const cygpath = candidates.find((candidate) =>
    commandSucceeds(candidate, ["-u", "."])
  );
  if (!cygpath) {
    die(
      "未找到 MSYS2 cygpath。请设置 MSYS2_ROOT，或安装到 C:\\msys64；" +
        "本脚本的 Windows 分支必须在 MSYS2 环境中运行。",
    );
  }
  return {
    cygpath,
    toMsys: (pathname) => capture(cygpath, ["-u", pathname]),
    toMixed: (pathname) => capture(cygpath, ["-m", pathname]),
    toWindows: (pathname) => capture(cygpath, ["-w", pathname]),
  };
}

function resolveConfiguredPath(
  pathname: string,
  windows?: WindowsPathBridge,
): string {
  const nativePath = windows ? windows.toWindows(pathname) : pathname;
  return path.resolve(nativePath);
}

function createContext(parsed: ParsedArgs): BuildContext {
  const windows = BUILD_PLATFORM === "windows"
    ? createWindowsPathBridge()
    : undefined;
  const targetArch = BUILD_PLATFORM === "macos"
    ? parsed.targetArch ?? HOST_ARCH
    : undefined;

  let archivePlatform: string;
  let archFlag: "--x64-build" | "--arm64-build";
  let gnOut: string;
  let runtimeLib: string;
  let pythonBin: string;
  if (BUILD_PLATFORM === "linux") {
    archivePlatform = "linux64";
    archFlag = "--x64-build";
    gnOut = "Release_GN_x64";
    runtimeLib = "libcef.so";
    pythonBin = envOr("PYTHON_BIN", "python3");
  } else if (BUILD_PLATFORM === "windows") {
    archivePlatform = "windows64";
    archFlag = "--x64-build";
    gnOut = "Release_GN_x64";
    runtimeLib = "libcef.dll";
    pythonBin = envOr("PYTHON_BIN", "python");
  } else {
    archivePlatform = targetArch === "arm64" ? "macosarm64" : "macosx64";
    archFlag = targetArch === "arm64" ? "--arm64-build" : "--x64-build";
    gnOut = targetArch === "arm64"
      ? "Release_GN_arm64"
      : "Release_GN_x64";
    runtimeLib = "Chromium Embedded Framework.framework";
    pythonBin = envOr("PYTHON_BIN", "python3");
  }

  const cefBuild = resolveConfiguredPath(
    envOr("CEFBUILD", CHROMIUM_DIR),
    windows,
  );
  const cefSource = resolveConfiguredPath(
    envOr("CEF_SOURCE", path.join(THIRD_DIR, "cef")),
    windows,
  );
  const exportDir = process.env.CEF_EXPORT_ROOT
    ? path.join(
      resolveConfiguredPath(process.env.CEF_EXPORT_ROOT, windows),
      `cef-build-${parsed.variant}`,
    )
    : cefExportDir(parsed.variant, targetArch);
  const env: NodeJS.ProcessEnv = { ...process.env };

  if (BUILD_PLATFORM === "macos") {
    // automate 的 arch flag 只决定它读取哪个 out 目录，不会告诉 gn_args.py 生成哪个
    // 架构。gn_args.py 默认只看宿主 machine，所以必须按目标注入 CEF_ENABLE_*，并用
    // GN_OUT_CONFIGS 收敛到目标 Release 配置，否则跨编时 args.gn 根本不会生成。
    const enableName = targetArch === "x86_64" ? "AMD64" : "ARM64";
    env[`CEF_ENABLE_${enableName}`] = "1";
    env.GN_OUT_CONFIGS = gnOut;
    log(`目标架构: ${targetArch}（宿主 ${HOST_ARCH}）`);
    log(`GN 输出目录: out/${gnOut}   distrib 平台名: ${archivePlatform}`);
    log(
      `gn_args 放行: CEF_ENABLE_${enableName}=1   GN_OUT_CONFIGS=${gnOut}`,
    );
  }

  return {
    variant: parsed.variant,
    clean: parsed.clean,
    targetArch,
    archivePlatform,
    archFlag,
    gnOut,
    runtimeLib,
    pythonBin,
    cefBuild,
    cefSource,
    exportDir,
    env,
    noHistory: envOr("NO_HISTORY", "1"),
    gclientJobs: envOr("GCLIENT_JOBS", "4"),
    ninjaJobs: envOr("NINJA_JOBS", "16"),
    cefBranch: envOr("CEF_BRANCH", "7827"),
    cefRsArchiveVersion: envOr("CEF_RS_ARCHIVE_VERSION", "149.0.2"),
    windows,
    pgoFlags: [],
    distribFlags: [],
    updateFlags: [],
  };
}

function hostPath(ctx: BuildContext, pathname: string): string {
  return ctx.windows ? ctx.windows.toWindows(pathname) : pathname;
}

function ensureBuildDir(ctx: BuildContext): void {
  fs.mkdirSync(ctx.cefBuild, { recursive: true });
  log(`构建空间: ${ctx.cefBuild}`);
  log(`runtime 导出目录: ${ctx.exportDir}`);
}

function checkBuildDir(ctx: BuildContext): void {
  if (BUILD_PLATFORM === "windows") {
    log(
      "Windows/MSYS 分支：跳过 POSIX 符号链接检查，请确认构建根（默认 third\\chromium；" +
        "可由 CEFBUILD 覆盖）位于 NTFS 盘。",
    );
    return;
  }

  const testFile = path.join(ctx.cefBuild, ".symlink_test");
  const testLink = `${testFile}.lnk`;
  fs.rmSync(testFile, { force: true });
  fs.rmSync(testLink, { force: true });
  fs.writeFileSync(testFile, "");
  try {
    fs.symlinkSync(testFile, testLink);
    fs.rmSync(testFile, { force: true });
    fs.rmSync(testLink, { force: true });
    log("符号链接可用 ✓");
  } catch {
    fs.rmSync(testFile, { force: true });
    fs.rmSync(testLink, { force: true });
    die(
      `构建空间不支持符号链接（${ctx.cefBuild}）。` +
        "它必须是 ext4/APFS/HFS+ 等 POSIX 文件系统，不能是 exFAT/NTFS。",
    );
  }
}

function prepareCefReference(ctx: BuildContext): void {
  if (!fs.existsSync(ctx.cefSource) || !fs.statSync(ctx.cefSource).isDirectory()) {
    die(
      `CEF 源码不存在: ${ctx.cefSource}（请先 git submodule update --init third/cef）`,
    );
  }
  if (
    !commandSucceeds("git", [
      "-C",
      ctx.cefSource,
      "rev-parse",
      "--is-inside-work-tree",
    ], { env: ctx.env })
  ) {
    die(`third/cef 不是有效的 Git checkout: ${ctx.cefSource}`);
  }

  ctx.cefSourceCommit = capture(
    "git",
    ["-C", ctx.cefSource, "rev-parse", "HEAD"],
    { env: ctx.env },
  );
  ctx.cefSourceUrl = ctx.windows
    ? ctx.windows.toMixed(ctx.cefSource)
    : ctx.cefSource;

  // 增量构建可能已有官方 CEF checkout；把 origin 校正到仓库内 fork，automate 随后
  // 会 fetch 当前提交并在需要时重拷贝 chromium/src/cef，避免漏掉 Kabegame patch。
  const checkout = path.join(ctx.cefBuild, "chromium_git", "cef");
  if (
    commandSucceeds(
      "git",
      ["-C", checkout, "rev-parse", "--is-inside-work-tree"],
      { env: ctx.env },
    )
  ) {
    run(
      "git",
      ["-C", checkout, "remote", "set-url", "origin", ctx.cefSourceUrl],
      { env: ctx.env },
    );
  }

  log(`CEF 源码引用: ${ctx.cefSource}`);
  log(`CEF 源码提交: ${ctx.cefSourceCommit}`);
}

function writeGclientShims(ctx: BuildContext): void {
  const shimDir = path.join(ctx.cefBuild, "shim");
  const depotToolsDir = path.join(ctx.cefBuild, "depot_tools");
  const gclientForShell = ctx.windows
    ? ctx.windows.toMsys(path.join(depotToolsDir, "gclient"))
    : path.join(depotToolsDir, "gclient");
  const shellShim = `#!/usr/bin/env bash
args=("$@")
case "\${1:-}" in sync|revert) args+=(--jobs ${ctx.gclientJobs}) ;; esac
exec "${gclientForShell}" "\${args[@]}"
`;
  const shellShimPath = path.join(shimDir, "gclient");
  fs.writeFileSync(shellShimPath, shellShim);
  fs.chmodSync(shellShimPath, 0o755);

  if (ctx.windows) {
    const gclientBat = hostPath(
      ctx,
      path.join(depotToolsDir, "gclient.bat"),
    );
    fs.writeFileSync(
      path.join(shimDir, "gclient.bat"),
      `@echo off\r
setlocal\r
if /I "%~1"=="sync" goto with_jobs\r
if /I "%~1"=="revert" goto with_jobs\r
call "${gclientBat}" %*\r
exit /b %ERRORLEVEL%\r
:with_jobs\r
call "${gclientBat}" %* --jobs ${ctx.gclientJobs}\r
exit /b %ERRORLEVEL%\r
`,
    );
  }
}

function setupEnv(ctx: BuildContext): void {
  const tmpDir = path.join(ctx.cefBuild, "tmp");
  const cacheDir = path.join(ctx.cefBuild, "cache");
  const depotToolsDir = path.join(ctx.cefBuild, "depot_tools");
  const shimDir = path.join(ctx.cefBuild, "shim");
  for (const dirname of [
    tmpDir,
    cacheDir,
    depotToolsDir,
    path.join(ctx.cefBuild, "automate"),
    shimDir,
  ]) {
    fs.mkdirSync(dirname, { recursive: true });
  }

  // 避免 Chromium 临时文件和 vpython/gsutil 缓存写满系统 tmpfs 或用户缓存盘。
  ctx.env.TMPDIR = ctx.windows ? ctx.windows.toMsys(tmpDir) : tmpDir;
  ctx.env.XDG_CACHE_HOME = ctx.windows
    ? ctx.windows.toMsys(cacheDir)
    : cacheDir;
  if (ctx.windows) {
    const tmpWin = hostPath(ctx, tmpDir);
    ctx.env.TMP = tmpWin;
    ctx.env.TEMP = tmpWin;
    ctx.env.DEPOT_TOOLS_WIN_TOOLCHAIN ||= "0";
    ctx.env.GYP_MSVS_VERSION ||= "2026";
    if (ctx.env.GYP_MSVS_VERSION === "2026") {
      ctx.env.vs2026_install ||=
        "D:\\Applications\\Microsoft Visual Studio\\18\\Community";
    }
    delete ctx.env.GYP_MSVS_OVERRIDE_PATH;
    log(`VS toolchain: GYP_MSVS_VERSION=${ctx.env.GYP_MSVS_VERSION}`);
    if (ctx.env.vs2026_install) {
      log(`VS 2026 install: ${ctx.env.vs2026_install}`);
    }
  }

  writeGclientShims(ctx);
  ctx.env.PATH = [shimDir, depotToolsDir, ctx.env.PATH ?? ""]
    .filter(Boolean)
    .join(path.delimiter);
  ctx.env.CEF_USE_GN = "1";
  ctx.env.DEPOT_TOOLS_UPDATE = "1";
  ctx.env.NINJA_CORE_LIMIT = ctx.ninjaJobs;
}

function isExecutable(pathname: string): boolean {
  try {
    fs.accessSync(pathname, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function bootstrap(ctx: BuildContext): void {
  const depotToolsDir = path.join(ctx.cefBuild, "depot_tools");
  const hasGclient = isExecutable(path.join(depotToolsDir, "gclient")) ||
    fs.existsSync(path.join(depotToolsDir, "gclient.bat"));
  if (!hasGclient) {
    log("拉取 depot_tools...");
    run(
      "git",
      [
        "clone",
        "--depth",
        "1",
        "https://chromium.googlesource.com/chromium/tools/depot_tools.git",
        depotToolsDir,
      ],
      { env: ctx.env },
    );
  }

  const automatePy = path.join(ctx.cefBuild, "automate", "automate-git.py");
  if (!fs.existsSync(automatePy)) {
    log("下载 automate-git.py...");
    run(
      "curl",
      [
        "-fSL",
        "https://raw.githubusercontent.com/chromiumembedded/cef/master/tools/automate/automate-git.py",
        "-o",
        automatePy,
      ],
      { env: ctx.env },
    );
  }
}

function configureVariant(ctx: BuildContext): void {
  // CEF 7827 的 gn_args.py 硬性要求 optimize_webui=true、enable_widevine=true，
  // //cef/BUILD.gn 还有 assert 兜底，不能在这里覆盖。NaCl 已从 Chromium 149 移除，
  // 也不能再写 enable_nacl。prod 的 official build 默认启用 PGO，全量 checkout 通过
  // --with-pgo-profiles 下载；dev 非 official build，不需要 profile。
  let common = "proprietary_codecs=true ffmpeg_branding=Chrome";
  if (BUILD_PLATFORM === "linux") common += " use_sysroot=true";

  if (ctx.variant === "dev") {
    ctx.env.GN_DEFINES =
      `${common} is_official_build=false symbol_level=0 ` +
      "blink_symbol_level=0 dcheck_always_on=false";
    ctx.distribFlags = [
      "--minimal-distrib-only",
      "--no-distrib-docs",
      "--no-distrib-symbols",
      "--distrib-subdir-suffix=dev",
    ];
  } else {
    let prodExtra = "optimize_for_size=true symbol_level=0";
    if (BUILD_PLATFORM === "linux") prodExtra += " use_cups=false";
    ctx.env.GN_DEFINES = `${common} is_official_build=true ${prodExtra}`;
    ctx.distribFlags = [
      "--minimal-distrib-only",
      "--no-distrib-docs",
      "--distrib-subdir-suffix=prod",
    ];
    ctx.pgoFlags = ["--with-pgo-profiles"];
  }
  log(`variant=${ctx.variant}`);
  log(`GN_DEFINES=${ctx.env.GN_DEFINES}`);
}

function chromiumSourceDir(ctx: BuildContext): string {
  return path.join(
    ctx.cefBuild,
    "chromium_git",
    "chromium",
    "src",
  );
}

function configureUpdate(ctx: BuildContext): void {
  const sourceDir = chromiumSourceDir(ctx);
  if (ctx.clean || !fs.existsSync(sourceDir)) {
    log(
      ctx.clean
        ? "强制全量 checkout (--clean)"
        : "首次：全量 checkout（会拉取数十 G，耗时较长）",
    );
    ctx.updateFlags = ["--force-clean"];
  } else {
    log("增量：复用 Chromium checkout，同步 third/cef 后重编 + 重新打包");
    ctx.updateFlags = [
      "--no-chromium-update",
      "--force-cef-update",
      "--force-build",
      "--force-distrib",
    ];
  }
}

function ensurePgoProfile(ctx: BuildContext): void {
  // prod 增量构建不会重跑负责 PGO profile 的 gclient hook；切到另一目标架构时，所需
  // profile 往往从未下载。这里按 chrome/build/<target>.pgo.txt 幂等补齐；全量构建
  // 在源码目录尚不存在时直接返回，仍交给 --with-pgo-profiles。
  if (ctx.variant !== "prod") return;
  const sourceDir = chromiumSourceDir(ctx);
  if (!fs.existsSync(sourceDir)) return;

  let pgoTarget: string;
  if (BUILD_PLATFORM === "macos") {
    pgoTarget = ctx.targetArch === "x86_64" ? "mac" : "mac-arm";
  } else if (BUILD_PLATFORM === "linux") {
    pgoTarget = "linux";
  } else {
    pgoTarget = "win64";
  }

  const stateFile = path.join(
    sourceDir,
    "chrome",
    "build",
    `${pgoTarget}.pgo.txt`,
  );
  if (!fs.existsSync(stateFile)) {
    log(
      `跳过 PGO 预取：未找到状态文件 ${stateFile}（profile 名未知，交给 automate 处理）`,
    );
    return;
  }
  const profileName = fs.readFileSync(stateFile, "utf8").replace(/\s/g, "");
  const profilePath = path.join(
    sourceDir,
    "chrome",
    "build",
    "pgo_profiles",
    profileName,
  );
  if (fs.existsSync(profilePath)) {
    log(`PGO profile 已就位（${pgoTarget}）: ${profileName}`);
    return;
  }

  log(`下载 PGO profile（${pgoTarget}）: ${profileName}`);
  run(
    ctx.pythonBin,
    [
      hostPath(ctx, path.join(sourceDir, "tools", "update_pgo_profiles.py")),
      `--target=${pgoTarget}`,
      "update",
      "--gs-url-base=chromium-optimization-profiles/pgo_profiles",
    ],
    {
      env: ctx.env,
      failureMessage:
        `PGO profile 下载失败（${pgoTarget}）。` +
        "可手动重试或改用 dev variant（无 PGO）。",
    },
  );
  if (!fs.existsSync(profilePath)) {
    die(
      `PGO profile 下载后仍缺失: ${profilePath}\n` +
        "可手动重试或改用 dev variant（无 PGO）。",
    );
  }
  log("PGO profile 下载完成 ✓");
}

function copyPath(source: string, destination: string): void {
  fs.cpSync(source, destination, {
    recursive: true,
    dereference: false,
    preserveTimestamps: true,
    verbatimSymlinks: true,
  });
}

function copyDirectoryContents(source: string, destination: string): void {
  for (const entry of fs.readdirSync(source)) {
    copyPath(path.join(source, entry), path.join(destination, entry));
  }
}

function exportCefRuntime(ctx: BuildContext, distrib: string): void {
  const tmpDir = `${ctx.exportDir}.tmp`;
  let frameworkDir: string | undefined;
  if (BUILD_PLATFORM === "macos") {
    frameworkDir = path.join(
      chromiumSourceDir(ctx),
      "out",
      ctx.gnOut,
      ctx.runtimeLib,
    );
    if (!fs.existsSync(frameworkDir) || !fs.statSync(frameworkDir).isDirectory()) {
      die(`CEF build 缺少 framework: ${frameworkDir}`);
    }
  } else {
    for (const dirname of ["Release", "Resources"]) {
      const required = path.join(distrib, dirname);
      if (!fs.existsSync(required) || !fs.statSync(required).isDirectory()) {
        die(`CEF distrib 缺少 ${dirname}/: ${distrib}`);
      }
    }
  }

  log(`导出 cef-rs runtime: ${ctx.exportDir}`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });

  // cef-dll-sys 需要扁平 runtime：Linux/Windows 把 distrib 的 Release/Resources
  // 内容拷到根层；macOS framework 必须取 GN build output（不是 distrib），其余
  // headers/cmake/libcef_dll 仍取 distrib。framework 内的相对符号链接必须原样保留。
  if (frameworkDir) {
    copyPath(frameworkDir, path.join(tmpDir, ctx.runtimeLib));
  } else {
    copyDirectoryContents(path.join(distrib, "Release"), tmpDir);
    copyDirectoryContents(path.join(distrib, "Resources"), tmpDir);
  }

  for (
    const item of [
      "CMakeLists.txt",
      "cmake",
      "include",
      "libcef_dll",
      "CREDITS.html",
    ]
  ) {
    const source = path.join(distrib, item);
    if (!fs.existsSync(source)) die(`CEF distrib 缺少 ${item}: ${distrib}`);
    copyPath(source, path.join(tmpDir, item));
  }

  fs.writeFileSync(
    path.join(tmpDir, "archive.json"),
    `{
  "type": "minimal",
  "name": "cef_binary_${ctx.cefRsArchiveVersion}+${ctx.archivePlatform}_${ctx.variant}_minimal",
  "sha1": "0000000000000000000000000000000000000000"
}
`,
  );

  const runtimePath = path.join(tmpDir, ctx.runtimeLib);
  if (BUILD_PLATFORM === "macos") {
    if (!fs.existsSync(runtimePath) || !fs.statSync(runtimePath).isDirectory()) {
      die(`导出失败: ${runtimePath} 不存在`);
    }
  } else {
    if (!fs.existsSync(runtimePath) || !fs.statSync(runtimePath).isFile()) {
      die(`导出失败: ${runtimePath} 不存在`);
    }
    const localesDir = path.join(tmpDir, "locales");
    if (!fs.existsSync(localesDir) || !fs.statSync(localesDir).isDirectory()) {
      die(`导出失败: ${localesDir} 不存在`);
    }
  }

  fs.rmSync(ctx.exportDir, { recursive: true, force: true });
  fs.renameSync(tmpDir, ctx.exportDir);

  log("runtime 导出完成 ✓");
  log(
    `接入: export CEF_PATH="${ctx.exportDir}"   然后正常 deno task dev -c kabegame`,
  );
  if (ctx.windows) {
    log(
      `Windows PowerShell 接入: $env:CEF_PATH="${hostPath(ctx, ctx.exportDir)}"`,
    );
  }
}

function findDistrib(ctx: BuildContext): string | undefined {
  const distribRoot = path.join(
    chromiumSourceDir(ctx),
    "cef",
    "binary_distrib",
  );
  if (!fs.existsSync(distribRoot)) return undefined;
  const suffix = `_${ctx.archivePlatform}_${ctx.variant}_minimal`;
  const matches = fs.readdirSync(distribRoot, { withFileTypes: true })
    .filter((entry) =>
      entry.isDirectory() && entry.name.startsWith("cef_binary_") &&
      entry.name.endsWith(suffix)
    )
    .map((entry) => entry.name)
    .sort();
  const selected = matches[matches.length - 1];
  return selected ? path.join(distribRoot, selected) : undefined;
}

function runWithTee(
  command: string,
  args: string[],
  logfile: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const logStream = fs.createWriteStream(logfile);
    const child = spawn(command, args, {
      cwd: ROOT,
      env,
      shell: false,
      stdio: ["inherit", "pipe", "pipe"],
    });
    let settled = false;
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      logStream.end(() => reject(error));
    };
    const tee = (chunk: Uint8Array): void => {
      process.stdout.write(chunk);
      logStream.write(chunk);
    };
    child.stdout?.on("data", tee);
    child.stderr?.on("data", tee);
    child.on("error", (error) => fail(error));
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      logStream.end(() => {
        if (code === 0) resolve();
        else reject(new Error(`${command} 执行失败（退出码 ${code ?? "unknown"}）`));
      });
    });
  });
}

async function runBuild(ctx: BuildContext): Promise<void> {
  const logfile = path.join(ctx.cefBuild, `build-${ctx.variant}.log`);
  log(`开始编译，日志: ${logfile}`);
  log("建议在 tmux/screen 里跑；prod 的 LTO 链接很吃内存，OOM 就在 ~/e 挂 swap。");

  const historyFlags: string[] = [];
  if (ctx.noHistory === "1") {
    historyFlags.push("--no-chromium-history");
    log("浅 checkout：仅拉当前分支 tip，不下完整 git 历史");
    if (!ctx.clean && fs.existsSync(chromiumSourceDir(ctx))) {
      log(
        "提示：若已有全量残包，切浅 checkout 可能报 'checkout is incorrect'，需带 --clean 重来",
      );
    }
  }

  const automatePy = path.join(ctx.cefBuild, "automate", "automate-git.py");
  const downloadDir = path.join(ctx.cefBuild, "chromium_git");
  const depotToolsDir = path.join(ctx.cefBuild, "depot_tools");
  if (!ctx.cefSourceUrl || !ctx.cefSourceCommit) {
    die("CEF 源码引用尚未准备完成");
  }
  // 默认 cefclient 在 Linux 会无条件包含 GTK 头，而 Chromium sysroot 没有 GTK；
  // cefsimple 没有该依赖，仍会把 libcef 全量拉着编，Windows 也能少构建额外 UI 目标。
  const args = [
    hostPath(ctx, automatePy),
    `--download-dir=${hostPath(ctx, downloadDir)}`,
    `--depot-tools-dir=${hostPath(ctx, depotToolsDir)}`,
    `--branch=${ctx.cefBranch}`,
    `--url=${ctx.cefSourceUrl}`,
    `--checkout=${ctx.cefSourceCommit}`,
    ctx.archFlag,
    "--no-debug-build",
    "--build-target=cefsimple",
    ...historyFlags,
    ...ctx.pgoFlags,
    ...ctx.distribFlags,
    ...ctx.updateFlags,
  ];

  try {
    await runWithTee(ctx.pythonBin, args, logfile, ctx.env);
  } catch (error) {
    die(error instanceof Error ? error.message : String(error));
  }

  const output = findDistrib(ctx);
  if (!output) die(`未找到产物目录，检查日志: ${logfile}`);
  log("完成 ✓ 产物目录:");
  log(`  ${output}`);
  exportCefRuntime(ctx, output);
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  const ctx = createContext(parsed);
  ensureBuildDir(ctx);
  checkBuildDir(ctx);
  prepareCefReference(ctx);
  setupEnv(ctx);
  bootstrap(ctx);
  configureVariant(ctx);
  configureUpdate(ctx);
  ensurePgoProfile(ctx);
  await runBuild(ctx);
}

await main();
