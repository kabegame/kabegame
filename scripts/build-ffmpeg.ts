/**
 * 从源码编译 x264 + FFmpeg，生成“视频缩放 + 兼容视频压缩 + 维度/兼容性探测”所需的
 * libav* 库。它读取 mov/mp4/mkv/webm/wmv 等视频，桌面输出 libx264/AAC MP4；图片推断、
 * 图片维度与缩略图仍由 infer/image crate 处理。kabegame-core 通过
 * rsmpeg/rusty_ffmpeg 进程内链接这些库，不再调用 ffmpeg sidecar。
 *
 * 构建顺序与落点（路径公式全部来自 scripts/paths.ts）：
 *   1. third/x264 → bin/{platform}/{arch}/x264-build/install/
 *   2. 以前者为 PKG_CONFIG_PATH 前缀编译 third/FFmpeg
 *      → bin/{platform}/{arch}/FFmpeg-build/install/
 *   3. Android 固定用 platform=android、arch=arm64；macOS 显式目标按 arch 隔离。
 * Unix 安装静态库；Windows 在 MSYS2/MinGW 中安装 libav* DLL，再用 gendef + MSVC
 * lib.exe 生成导入库。x264 静态嵌入 libavcodec，不依赖系统 libx264。
 *
 * 调用：
 *   deno task build:ffmpeg
 *   deno task build:ffmpeg --target x86_64
 *   deno task build:ffmpeg --target android
 *   deno task build:ffmpeg --skip-x264 [...透传给两个 configure 的参数]
 *
 * 参数：
 *   --skip-x264  复用对应落点已有的 x264.pc，只重编 FFmpeg。
 *   --target      native | android | x86_64 | arm64（含 paths.ts 支持的别名/完整 triple）。
 *   其余裸参数   同时追加给 x264 与 FFmpeg configure。
 *
 * 依赖：两个源码 submodule；macOS x86_64 目标需要 nasm；Windows 需要 MSYS2 MinGW
 * toolchain、gendef、make（nasm 可选），以及 x64 Native Tools 环境里的 lib.exe。Windows 可在
 * MSYS2 shell 中直接执行 `deno task build:ffmpeg`，TS 入口会再次桥接到 bash -lc。
 * Android 需要 host pkg-config 和 NDK；定位顺序为 NDK_HOME → ANDROID_NDK_HOME →
 * ANDROID_NDK_ROOT → ANDROID_HOME/ndk 下最新版本，ANDROID_API 默认 24。
 *
 * 关键坑：Linux native 发布产物只允许在 Ubuntu 22.04 构建，以守住 glibc 2.35 地板；
 * 同时关闭 asm，将 NATIVE_ALIGN 限为 16，并把生成的 HAVE_THP 从 1 改为 0，避免 CEF
 * PartitionAlloc 无法满足大对齐请求。macOS 目标必须使用 Xcode 的 `cc` shim，避免 PATH 中
 * Android NDK 的 clang/ld 劫持后报 `ld: library 'System' not found`。Windows autotools
 * 必须留在 MSYS2 bash 内运行，原生 lib.exe 则只接收 Windows 路径。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  BUILD_PLATFORM,
  HOST_ARCH,
  normalizeTargetArch,
  repoBuildDir,
  requireUbuntu2204,
  ROOT,
  TARGET_ARCH,
  THIRD_DIR,
  type TargetArch,
} from "./paths.ts";

type BuildTarget =
  | { kind: "native" }
  | { kind: "android" }
  | { kind: "macos"; arch: TargetArch };

interface ParsedArgs {
  skipX264: boolean;
  target: BuildTarget;
  configureArgs: string[];
}

interface BuildContext {
  target: BuildTarget;
  skipX264: boolean;
  configureArgs: string[];
  ffmpegSrc: string;
  x264Src: string;
  buildDir: string;
  installDir: string;
  x264BuildDir: string;
  x264InstallDir: string;
  tmpDir: string;
  env: NodeJS.ProcessEnv;
  jobs: number;
  makeCommand: string;
  macCross: boolean;
  macHostTriple?: string;
  android?: AndroidToolchain;
  msys?: MsysBridge;
}

interface AndroidToolchain {
  api: string;
  abi: "arm64-v8a";
  arch: "aarch64";
  triple: "aarch64-linux-android";
  ndkDir: string;
  toolchainDir: string;
}

function die(message: string): never {
  console.error(`错误: ${message}`);
  process.exit(1);
}

function parseArgs(argv: string[]): ParsedArgs {
  let skipX264 = false;
  let rawTarget = "native";
  const configureArgs: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--skip-x264") {
      skipX264 = true;
    } else if (arg === "--target") {
      const value = argv[++i];
      if (!value) die("--target 缺少参数");
      rawTarget = value;
    } else if (arg.startsWith("--target=")) {
      rawTarget = arg.slice("--target=".length);
      if (!rawTarget) die("--target 缺少参数");
    } else {
      configureArgs.push(arg);
    }
  }

  if (rawTarget === "native") {
    return { skipX264, target: { kind: "native" }, configureArgs };
  }
  if (rawTarget === "android") {
    return { skipX264, target: { kind: "android" }, configureArgs };
  }

  let arch: TargetArch;
  try {
    arch = TARGET_ARCH ?? normalizeTargetArch(rawTarget);
  } catch (error) {
    die(error instanceof Error ? error.message : String(error));
  }
  if (BUILD_PLATFORM !== "macos") {
    die(`--target ${arch} 仅在 macOS 宿主上支持（跨编 x86_64 / arm64）`);
  }
  return { skipX264, target: { kind: "macos", arch }, configureArgs };
}

function run(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; quiet?: boolean } = {},
): void {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? ROOT,
    env: options.env ?? process.env,
    shell: false,
    stdio: options.quiet ? "ignore" : "inherit",
  });
  if (result.error) {
    die(`无法执行 ${command}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    die(`${command} 执行失败（退出码 ${result.status ?? "unknown"}）`);
  }
}

function capture(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): string {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? ROOT,
    env: options.env ?? process.env,
    shell: false,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0) {
    const detail = result.error?.message ?? result.stderr.trim();
    die(`执行 ${command} 失败${detail ? `: ${detail}` : ""}`);
  }
  return result.stdout.trim();
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

class MsysBridge {
  readonly bash: string;
  readonly cygpath: string;

  constructor() {
    const candidates: string[] = [];
    if (process.env.MSYS2_ROOT) {
      candidates.push(
        path.join(process.env.MSYS2_ROOT, "usr", "bin", "bash.exe"),
      );
    }
    candidates.push("C:\\msys64\\usr\\bin\\bash.exe");

    const fromKnownRoot = candidates.find((candidate) => fs.existsSync(candidate));
    this.bash = fromKnownRoot ?? "bash.exe";
    this.cygpath = fromKnownRoot
      ? path.join(path.dirname(fromKnownRoot), "cygpath.exe")
      : "cygpath.exe";

    const probe = spawnSync(this.bash, ["-lc", "exit 0"], {
      shell: false,
      stdio: "ignore",
    });
    if (probe.error || probe.status !== 0) {
      die(
        "未找到 MSYS2 bash。请设置 MSYS2_ROOT，或安装到 C:\\msys64；" +
          "在 MSYS2 shell 中运行时也需确保 bash.exe 在 PATH。",
      );
    }
  }

  toMsys(windowsPath: string): string {
    return capture(this.cygpath, ["-u", windowsPath]);
  }

  toWindows(msysPath: string): string {
    return capture(this.cygpath, ["-w", msysPath]);
  }

  commandExists(command: string, env: NodeJS.ProcessEnv): boolean {
    const result = spawnSync(
      this.bash,
      ["-lc", `command -v ${shellQuote(command)} >/dev/null 2>&1`],
      { env, shell: false, stdio: "ignore" },
    );
    return !result.error && result.status === 0;
  }

  findCommand(command: string, env: NodeJS.ProcessEnv): string | undefined {
    const result = spawnSync(
      this.bash,
      ["-lc", `command -v ${shellQuote(command)}`],
      {
        env,
        shell: false,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    return !result.error && result.status === 0
      ? result.stdout.trim() || undefined
      : undefined;
  }

  run(
    command: string,
    args: string[],
    options: { cwd: string; env: NodeJS.ProcessEnv },
  ): void {
    const cwd = this.toMsys(options.cwd);
    const executable = path.isAbsolute(command) ? this.toMsys(command) : command;
    const script = [
      `cd ${shellQuote(cwd)}`,
      `exec ${[executable, ...args].map(shellQuote).join(" ")}`,
    ].join(" && ");
    run(this.bash, ["-lc", script], { env: options.env });
  }
}

function ensureSource(pathname: string, submodule: string): void {
  if (!fs.existsSync(pathname)) {
    die(`源码未找到: ${pathname}\n请执行: git submodule update --init ${submodule}`);
  }
}

function findAndroidNdk(): string {
  const explicit = [
    process.env.NDK_HOME,
    process.env.ANDROID_NDK_HOME,
    process.env.ANDROID_NDK_ROOT,
  ].find((candidate) => candidate !== undefined && candidate !== "");
  if (explicit) {
    if (fs.existsSync(explicit) && fs.statSync(explicit).isDirectory()) {
      return path.resolve(explicit);
    }
    die(`Android NDK 目录不存在: ${explicit}`);
  }

  const ndkRoot = process.env.ANDROID_HOME
    ? path.join(process.env.ANDROID_HOME, "ndk")
    : undefined;
  if (ndkRoot && fs.existsSync(ndkRoot)) {
    const versions = fs.readdirSync(ndkRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    if (versions[0]) return path.join(ndkRoot, versions[0]);
  }

  die("未找到 Android NDK。请设置 NDK_HOME（或 ANDROID_NDK_HOME/ANDROID_NDK_ROOT）。");
}

function configureAndroid(env: NodeJS.ProcessEnv): AndroidToolchain {
  if (BUILD_PLATFORM !== "linux" && BUILD_PLATFORM !== "macos") {
    die("Android 交叉编译仅支持 Linux/macOS 宿主。");
  }

  const ndkDir = findAndroidNdk();
  const api = process.env.ANDROID_API ?? "24";
  const hostTag = BUILD_PLATFORM === "linux" ? "linux-x86_64" : "darwin-x86_64";
  const toolchainDir = path.join(
    ndkDir,
    "toolchains",
    "llvm",
    "prebuilt",
    hostTag,
  );
  const triple = "aarch64-linux-android" as const;
  const cc = path.join(toolchainDir, "bin", `${triple}${api}-clang`);
  try {
    fs.accessSync(cc, fs.constants.X_OK);
  } catch {
    die(
      `NDK clang 不存在: ${cc}\n` +
        `确认 NDK（${ndkDir}）含 API ${api} 的 aarch64 工具链，或用 ANDROID_API 指定其它 level。`,
    );
  }

  env.CC = cc;
  env.CXX = `${cc}++`;
  env.AS = cc;
  env.LD = path.join(toolchainDir, "bin", "ld");
  env.AR = path.join(toolchainDir, "bin", "llvm-ar");
  env.NM = path.join(toolchainDir, "bin", "llvm-nm");
  env.RANLIB = path.join(toolchainDir, "bin", "llvm-ranlib");
  env.STRIP = path.join(toolchainDir, "bin", "llvm-strip");

  console.log(
    `=== Android 交叉编译: NDK=${ndkDir}  API=${api}  ABI=arm64-v8a ===`,
  );
  return {
    api,
    abi: "arm64-v8a",
    arch: "aarch64",
    triple,
    ndkDir,
    toolchainDir,
  };
}

function replaceThp(
  configPath: string,
  label: string,
  requireDefinition = false,
): void {
  if (!fs.existsSync(configPath)) return;
  const original = fs.readFileSync(configPath, "utf8");
  const updated = original.replace(
    /^#define HAVE_THP 1$/m,
    "#define HAVE_THP 0",
  );
  if (updated !== original) fs.writeFileSync(configPath, updated);
  if (/^#define HAVE_THP 1$/m.test(updated)) {
    die(`未能在 ${label} config.h 中关闭 HAVE_THP`);
  }
  if (requireDefinition && !/^#define HAVE_THP 0$/m.test(updated)) {
    die(`未能在 ${label} config.h 中确认 HAVE_THP 已关闭`);
  }
}

function createContext(parsed: ParsedArgs): BuildContext {
  if (parsed.target.kind === "native" && BUILD_PLATFORM === "linux") {
    requireUbuntu2204("FFmpeg/x264 构建");
  }

  const ffmpegSrc = path.join(THIRD_DIR, "FFmpeg");
  const x264Src = path.join(THIRD_DIR, "x264");
  const tmpDir = path.join(THIRD_DIR, ".tmp");
  let buildDir: string;
  let x264BuildDir: string;

  if (parsed.target.kind === "android") {
    buildDir = repoBuildDir("FFmpeg", { platform: "android", arch: "arm64" });
    x264BuildDir = repoBuildDir("x264", { platform: "android", arch: "arm64" });
  } else if (parsed.target.kind === "macos") {
    buildDir = repoBuildDir("FFmpeg", { arch: parsed.target.arch });
    x264BuildDir = repoBuildDir("x264", { arch: parsed.target.arch });
  } else {
    buildDir = repoBuildDir("FFmpeg");
    x264BuildDir = repoBuildDir("x264");
  }

  const env: NodeJS.ProcessEnv = { ...process.env };
  const msys = BUILD_PLATFORM === "windows" ? new MsysBridge() : undefined;
  const android = parsed.target.kind === "android"
    ? configureAndroid(env)
    : undefined;
  const macArch = parsed.target.kind === "macos"
    ? parsed.target.arch
    : BUILD_PLATFORM === "macos" ? HOST_ARCH : undefined;
  const macCross = parsed.target.kind === "macos" && macArch !== HOST_ARCH;

  if (BUILD_PLATFORM === "macos" && parsed.target.kind !== "android") {
    // 必须使用 Xcode 的 cc shim；裸 clang 可能被 PATH 中的 Android NDK 劫持。
    env.CC = "cc";
    if (macCross) {
      console.log(`=== macOS 跨编: 目标 ${macArch} / 宿主 ${HOST_ARCH} ===`);
    } else {
      console.log(`=== macOS 原生构建: ${macArch} ===`);
    }
  }

  fs.mkdirSync(tmpDir, { recursive: true });
  env.TMPDIR = msys ? msys.toMsys(tmpDir) : tmpDir;
  if (msys) {
    env.TMP = tmpDir;
    env.TEMP = tmpDir;
  }

  let makeCommand = "make";
  let jobs = Math.max(1, os.cpus().length);
  if (msys) {
    makeCommand = msys.commandExists("make", env) ? "make" : "mingw32-make";
    jobs = 1;
  }

  return {
    target: parsed.target,
    skipX264: parsed.skipX264,
    configureArgs: parsed.configureArgs,
    ffmpegSrc,
    x264Src,
    buildDir,
    installDir: path.join(buildDir, "install"),
    x264BuildDir,
    x264InstallDir: path.join(x264BuildDir, "install"),
    tmpDir,
    env,
    jobs,
    makeCommand,
    macCross,
    macHostTriple: macArch
      ? `${macArch === "arm64" ? "aarch64" : "x86_64"}-apple-darwin`
      : undefined,
    android,
    msys,
  };
}

function configurePath(ctx: BuildContext, pathname: string): string {
  return ctx.msys ? ctx.msys.toMsys(pathname) : pathname;
}

function runAutotools(
  ctx: BuildContext,
  command: string,
  args: string[],
  cwd: string,
): void {
  if (ctx.msys) {
    ctx.msys.run(command, args, { cwd, env: ctx.env });
  } else {
    run(command, args, { cwd, env: ctx.env });
  }
}

function buildX264(ctx: BuildContext): void {
  const pcFile = path.join(ctx.x264InstallDir, "lib", "pkgconfig", "x264.pc");
  if (ctx.skipX264) {
    if (!fs.existsSync(pcFile)) {
      die(
        `--skip-x264 但未找到已安装的 x264: ${pcFile}\n` +
          "请先不带 --skip-x264 完整运行一次本脚本。",
      );
    }
    console.log(`=== 跳过构建 x264（--skip-x264），复用 ${ctx.x264InstallDir} ===`);
    return;
  }

  if (
    ctx.target.kind === "macos" && ctx.target.arch === "x86_64"
  ) {
    const nasm = spawnSync("nasm", ["-v"], {
      env: ctx.env,
      shell: false,
      stdio: "inherit",
    });
    if (nasm.error || nasm.status !== 0) {
      die("x86_64 目标需要 nasm 汇编器（x264 缺它会直接失败）。请先安装: brew install nasm");
    }
  }

  console.log("=== 构建 x264 ===");
  fs.mkdirSync(ctx.x264BuildDir, { recursive: true });
  const flags = [
    `--prefix=${configurePath(ctx, ctx.x264InstallDir)}`,
    "--enable-static",
    "--disable-cli",
  ];

  if (ctx.target.kind === "android") {
    flags.push(
      "--enable-pic",
      `--host=${ctx.android!.triple}`,
      `--sysroot=${ctx.android!.toolchainDir}/sysroot`,
    );
  } else if (ctx.target.kind === "macos") {
    flags.push(
      "--enable-pic",
      `--extra-cflags=-arch ${ctx.target.arch}`,
      `--extra-ldflags=-arch ${ctx.target.arch}`,
    );
    if (ctx.macCross) flags.push(`--host=${ctx.macHostTriple}`);
  } else if (BUILD_PLATFORM === "linux") {
    flags.push(
      "--enable-pic",
      "--disable-asm",
      "--extra-cflags=-DNATIVE_ALIGN=16",
    );
  } else if (BUILD_PLATFORM === "macos") {
    flags.push("--enable-pic");
  }

  runAutotools(
    ctx,
    configurePath(ctx, path.join(ctx.x264Src, "configure")),
    [...flags, ...ctx.configureArgs],
    ctx.x264BuildDir,
  );

  if (ctx.target.kind === "native" && BUILD_PLATFORM === "linux") {
    replaceThp(path.join(ctx.x264BuildDir, "config.h"), "x264", true);
  }
  runAutotools(ctx, ctx.makeCommand, [`-j${ctx.jobs}`], ctx.x264BuildDir);
  runAutotools(ctx, ctx.makeCommand, ["install"], ctx.x264BuildDir);
  console.log(`x264 已安装到: ${ctx.x264InstallDir}`);
}

function configurePkgConfig(ctx: BuildContext): string[] {
  const paths: string[] = [];
  if (ctx.msys) {
    const mingwPkgConfig = ctx.msys.toWindows("/mingw64/lib/pkgconfig");
    if (fs.existsSync(mingwPkgConfig)) paths.push("/mingw64/lib/pkgconfig");
    paths.unshift(ctx.msys.toMsys(path.join(ctx.x264InstallDir, "lib", "pkgconfig")));
  } else {
    paths.push(path.join(ctx.x264InstallDir, "lib", "pkgconfig"));
  }
  if (ctx.env.PKG_CONFIG_PATH) paths.push(ctx.env.PKG_CONFIG_PATH);
  ctx.env.PKG_CONFIG_PATH = paths.join(ctx.msys ? ":" : path.delimiter);

  if (!ctx.msys) return [];
  const executable = ctx.msys.findCommand("pkg-config", ctx.env);
  return executable ? [`--pkg-config=${executable}`] : [];
}

const FFMPEG_FLAGS = [
  "--disable-everything",
  "--disable-programs",
  "--disable-hwaccels",
  "--disable-libdrm",
  "--disable-vaapi",
  "--disable-vdpau",
  "--disable-opencl",
  "--disable-vulkan",
  "--disable-libxcb",
  "--disable-xlib",
  "--enable-gpl",
  "--enable-protocol=file",
  "--enable-protocol=fd",
  "--enable-demuxer=mov",
  "--enable-demuxer=matroska",
  "--enable-demuxer=asf",
  "--enable-decoder=h264",
  "--enable-decoder=hevc",
  "--enable-decoder=mpeg4",
  "--enable-decoder=vp8",
  "--enable-decoder=vp9",
  "--enable-decoder=av1",
  "--enable-decoder=wmv1",
  "--enable-decoder=wmv2",
  "--enable-decoder=wmv3",
  "--enable-decoder=vc1",
  "--enable-decoder=msmpeg4v1",
  "--enable-decoder=msmpeg4v2",
  "--enable-decoder=msmpeg4v3",
  "--enable-parser=h264",
  "--enable-parser=hevc",
  "--enable-parser=mpeg4video",
  "--enable-parser=vp8",
  "--enable-parser=vp9",
  "--enable-parser=av1",
  "--enable-parser=vc1",
  "--enable-muxer=mov",
  "--enable-muxer=mp4",
  "--enable-muxer=webm",
  "--enable-encoder=gif",
  "--enable-muxer=gif",
  "--enable-decoder=aac",
  "--enable-decoder=mp3float",
  "--enable-decoder=ac3",
  "--enable-decoder=vorbis",
  "--enable-decoder=opus",
  "--enable-decoder=flac",
  "--enable-decoder=wmav1",
  "--enable-decoder=wmav2",
  "--enable-decoder=wmapro",
  "--enable-encoder=aac",
  "--enable-parser=aac",
  "--enable-muxer=ipod",
  "--enable-swresample",
  "--enable-filter=scale",
  "--enable-filter=buffer",
  "--enable-filter=buffersink",
  "--enable-filter=format",
  "--enable-filter=fps",
  "--enable-filter=split",
  "--enable-filter=palettegen",
  "--enable-filter=paletteuse",
  "--enable-filter=aresample",
  "--enable-filter=aformat",
  "--enable-filter=anull",
  "--enable-filter=abuffer",
  "--enable-filter=abuffersink",
  "--enable-filter=asetnsamples",
  "--enable-swscale",
  "--disable-avdevice",
  "--disable-doc",
  "--disable-iconv",
  "--disable-zlib",
  "--disable-bzlib",
  "--disable-lzma",
  "--enable-small",
  "--disable-runtime-cpudetect",
  "--enable-libx264",
  "--enable-encoder=libx264",
];

function patchWindowsMakefiles(ctx: BuildContext): void {
  const relativeSource = path
    .relative(ctx.buildDir, ctx.ffmpegSrc)
    .replace(/\\/g, "/");
  const makefile = path.join(ctx.buildDir, "Makefile");
  if (fs.existsSync(makefile)) {
    const original = fs.readFileSync(makefile, "utf8");
    fs.writeFileSync(
      makefile,
      original.replace(/^include .*Makefile/, `include ${relativeSource}/Makefile`),
    );
  }
  const configMak = path.join(ctx.buildDir, "ffbuild", "config.mak");
  if (fs.existsSync(configMak)) {
    const original = fs.readFileSync(configMak, "utf8");
    fs.writeFileSync(
      configMak,
      original.replace(/^SRC_PATH=.*$/m, `SRC_PATH=${relativeSource}`),
    );
  }
}

function buildFfmpeg(ctx: BuildContext): void {
  console.log("=== 构建 FFmpeg ===");
  fs.mkdirSync(ctx.buildDir, { recursive: true });
  const configureExtra = configurePkgConfig(ctx);
  const linkFlags = ctx.msys
    ? ["--enable-shared", "--disable-static"]
    : ["--enable-static", "--disable-shared", "--enable-pic"];
  const extraLibs = ctx.msys
    ? ["--extra-libs=-Wl,-Bstatic -lwinpthread -Wl,-Bdynamic"]
    : [];
  const crossFlags: string[] = [];

  if (ctx.target.kind === "android") {
    crossFlags.push(
      "--enable-cross-compile",
      "--target-os=android",
      `--arch=${ctx.android!.arch}`,
      "--cpu=armv8-a",
      `--sysroot=${ctx.android!.toolchainDir}/sysroot`,
      `--cc=${ctx.env.CC}`,
      `--cxx=${ctx.env.CXX}`,
      `--ar=${ctx.env.AR}`,
      `--nm=${ctx.env.NM}`,
      `--ranlib=${ctx.env.RANLIB}`,
      `--strip=${ctx.env.STRIP}`,
      "--pkg-config=pkg-config",
      "--pkg-config-flags=--static",
    );
  } else if (ctx.target.kind === "macos") {
    crossFlags.push(
      `--arch=${ctx.target.arch}`,
      "--target-os=darwin",
      `--cc=cc -arch ${ctx.target.arch}`,
      `--extra-cflags=-arch ${ctx.target.arch}`,
      `--extra-ldflags=-arch ${ctx.target.arch}`,
      "--host-cc=cc",
      "--pkg-config-flags=--static",
    );
    if (ctx.macCross) crossFlags.push("--enable-cross-compile");
  }

  const linuxNative = ctx.target.kind === "native" && BUILD_PLATFORM === "linux";
  const configFlags = linuxNative
    ? [...FFMPEG_FLAGS, "--disable-asm"]
    : FFMPEG_FLAGS;
  const extraCflags = linuxNative ? "-O2 -DNATIVE_ALIGN=16" : "-O2";
  runAutotools(
    ctx,
    configurePath(ctx, path.join(ctx.ffmpegSrc, "configure")),
    [
      `--prefix=${configurePath(ctx, ctx.installDir)}`,
      ...configFlags,
      `--extra-cflags=${extraCflags}`,
      ...linkFlags,
      ...extraLibs,
      ...crossFlags,
      ...configureExtra,
      ...ctx.configureArgs,
    ],
    ctx.buildDir,
  );

  if (linuxNative) {
    replaceThp(path.join(ctx.buildDir, "config.h"), "FFmpeg");
  }
  if (ctx.msys) patchWindowsMakefiles(ctx);
  runAutotools(ctx, ctx.makeCommand, [`-j${ctx.jobs}`], ctx.buildDir);
  runAutotools(ctx, ctx.makeCommand, ["install"], ctx.buildDir);
}

function validateLinuxStaticLink(ctx: BuildContext): void {
  if (BUILD_PLATFORM !== "linux") return;
  const pkgConfigPath = [
    path.join(ctx.installDir, "lib", "pkgconfig"),
    path.join(ctx.x264InstallDir, "lib", "pkgconfig"),
  ].join(path.delimiter);
  const result = spawnSync("pkg-config", ["--libs", "--static", "libavcodec"], {
    env: { ...ctx.env, PKG_CONFIG_PATH: pkgConfigPath },
    shell: false,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  if (result.error || result.status !== 0) {
    die(`pkg-config --libs --static libavcodec 执行失败: ${result.error?.message ?? ""}`);
  }
  if (!result.stdout.split(/\s+/).includes("-lx264")) {
    die("FFmpeg 静态链接信息缺少 -lx264。请确认 configure 已启用 libx264，然后重新运行 deno task build:ffmpeg");
  }
}

function removeAvdeviceStaticFiles(ctx: BuildContext): void {
  const libDir = path.join(ctx.installDir, "lib");
  if (fs.existsSync(libDir)) {
    for (const entry of fs.readdirSync(libDir)) {
      if (/^libavdevice.*\.a$/.test(entry)) {
        fs.unlinkSync(path.join(libDir, entry));
      }
    }
  }
  const pc = path.join(libDir, "pkgconfig", "libavdevice.pc");
  if (fs.existsSync(pc)) fs.unlinkSync(pc);
}

function findWindowsProgram(names: string[]): string | undefined {
  const directories = (process.env.PATH ?? "").split(path.delimiter);
  for (const name of names) {
    for (const directory of directories) {
      const candidate = path.join(directory, name);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

function generateWindowsImportLibraries(ctx: BuildContext): void {
  const binDir = path.join(ctx.installDir, "bin");
  const dlls = fs.existsSync(binDir)
    ? fs.readdirSync(binDir)
      .filter((name) =>
        (/^av.*\.dll$/i.test(name) || /^sw(?:scale|resample)-.*\.dll$/i.test(name)) &&
        !/^avdevice-/i.test(name)
      )
      .sort()
      .map((name) => path.join(binDir, name))
    : [];
  if (dlls.length === 0) die(`未找到 libav* DLL: ${binDir}/*.dll`);
  if (!ctx.msys!.commandExists("gendef", ctx.env)) {
    die("未找到 gendef。请在 MSYS2 执行: pacman -S mingw-w64-x86_64-tools-git");
  }
  const libExe = findWindowsProgram(["lib.exe", "lib"]);
  if (!libExe) {
    die("未找到 lib.exe。请在 'x64 Native Tools / VS Developer' 环境运行本脚本。");
  }

  const defDir = path.join(ctx.buildDir, "msvc-implib");
  fs.mkdirSync(defDir, { recursive: true });
  for (const dll of dlls) {
    ctx.msys!.run("gendef", [ctx.msys!.toMsys(dll)], {
      cwd: defDir,
      env: ctx.env,
    });
    const base = path.basename(dll, ".dll");
    const def = path.join(defDir, `${base}.def`);
    if (!fs.existsSync(def)) die(`未能为 ${path.basename(dll)} 生成 .def`);
    const libName = base.split("-", 1)[0];
    const output = path.join(ctx.installDir, "lib", `${libName}.lib`);
    run(libExe, [`-def:${def}`, "-machine:x64", `-out:${output}`], {
      env: ctx.env,
    });
    console.log(`已生成 MSVC 导入库: ${libName}.lib`);
  }
  console.log(
    `Windows libav* DLL 留在 ${binDir}（由 os-plugin 在 build 期复制到 bin/windows）；` +
      `MSVC 导入库已生成到 ${path.join(ctx.installDir, "lib")}。`,
  );
}

function validateAndFinish(ctx: BuildContext): void {
  const codecPc = path.join(ctx.installDir, "lib", "pkgconfig", "libavcodec.pc");
  if (!fs.existsSync(codecPc)) die(`未找到 libav* 安装产物: ${codecPc}`);
  validateLinuxStaticLink(ctx);
  removeAvdeviceStaticFiles(ctx);

  if (ctx.msys) {
    generateWindowsImportLibraries(ctx);
    return;
  }
  console.log(`已输出静态库: ${path.join(ctx.installDir, "lib")}/*.a  头文件: ${path.join(ctx.installDir, "include")}`);
  console.log(
    `rust build.rs 将经 FFMPEG_PKG_CONFIG_PATH=${path.join(ctx.installDir, "lib", "pkgconfig")} 静态链接。`,
  );
}

function main(): void {
  const parsed = parseArgs(process.argv.slice(2));
  const ctx = createContext(parsed);
  ensureSource(path.join(ctx.ffmpegSrc, "configure"), "third/FFmpeg");
  if (!ctx.skipX264) {
    ensureSource(path.join(ctx.x264Src, "configure"), "third/x264");
  }
  buildX264(ctx);
  buildFfmpeg(ctx);
  validateAndFinish(ctx);
}

main();
