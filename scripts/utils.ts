/**
 * 工具函数
 */

import { spawnSync, spawn } from "child_process";
import { fileURLToPath } from "url";
import path from "path";
import os from "os";
import fs from "fs";
import chalk from "chalk";
// 注意:本文件不可 import OSPlugin,否则与 os-plugin.ts 形成循环依赖
// (os-plugin.ts 在 top-level 读取 ROOT 等本文件导出)。
// 用 process.platform 直接判断即可。

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const ROOT = path.resolve(__dirname, "..");
export const THIRD_DIR = path.join(ROOT, "third");
export const BUILD_SUFFIX = process.env.KB_BUILD_SUFFIX ?? "";
export const CRAWLER_PLUGINS_DIR = path.join(ROOT, "src-crawler-plugins");

/**
 * 目标架构（**仅 macOS**）。由 `--target x86_64|arm64` 指定，用于在 Apple Silicon 上
 * 交叉编译 Intel 版（或反之）。不传 `--target` 时全部为 undefined，行为与改动前完全一致。
 *
 * 约定（按 arch 决定，不随宿主变化，保证同一命令在任何 Mac 上落点一致）：
 *  - `arm64`  → 沿用既有的无后缀目录（third/FFmpeg-build/install、CEF_PATH=.../cef-{dev,prod}）
 *  - `x86_64` → 独立目录（third/FFmpeg-build/darwin/x86_64/install、.../cef-{dev,prod}-x64），
 *               与 arm64 产物完全隔离，互不覆盖。
 * cargo/tauri 侧则一律落在 `TARGET_DIR/<triple>/`（见 ARTIFACT_DIR）。
 */
export type TargetArch = "x86_64" | "arm64";

const TARGET_ARCH_ALIASES: Record<string, TargetArch> = {
  x86_64: "x86_64",
  x64: "x86_64",
  amd64: "x86_64",
  "x86_64-apple-darwin": "x86_64",
  arm64: "arm64",
  aarch64: "arm64",
  "aarch64-apple-darwin": "arm64",
};

export function normalizeTargetArch(raw: string): TargetArch {
  const arch = TARGET_ARCH_ALIASES[raw.trim().toLowerCase()];
  if (!arch) {
    throw new Error(
      `未知的 --target: '${raw}'（允许 x86_64 | arm64，也接受 x64/aarch64 与完整 triple）`,
    );
  }
  return arch;
}

/**
 * 只解析 argv 中第一个裸 `--` **之前**的 `--target`。`--` 之后的参数是原样透传给
 * tauri/cargo 的，由调用方自己负责，这里不消费也不重复注入。
 */
function parseTargetArchFromArgv(): TargetArch | undefined {
  const argv = process.argv.slice(2);
  const sep = argv.indexOf("--");
  const scope = sep === -1 ? argv : argv.slice(0, sep);
  for (let i = 0; i < scope.length; i++) {
    const a = scope[i];
    if (a === "--target") {
      return scope[i + 1] ? normalizeTargetArch(scope[i + 1]) : undefined;
    }
    if (a.startsWith("--target=")) {
      return normalizeTargetArch(a.slice("--target=".length));
    }
  }
  return undefined;
}

/** 宿主架构（macOS 之外的取值无意义，仅用于判断是否真正交叉）。 */
export const HOST_ARCH: TargetArch =
  process.arch === "arm64" ? "arm64" : "x86_64";

/** 显式指定的目标架构；未传 `--target` 时为 undefined。 */
export const TARGET_ARCH: TargetArch | undefined = (() => {
  const env = process.env.KB_TARGET_ARCH;
  const arch = env ? normalizeTargetArch(env) : parseTargetArchFromArgv();
  if (!arch) return undefined;
  if (process.platform !== "darwin") {
    throw new Error(
      `--target 仅在 macOS 上支持（跨编 x86_64 / arm64）；当前平台: ${process.platform}`,
    );
  }
  process.env.KB_TARGET_ARCH = arch; // 回写，供 package-plugin 等子进程继承
  return arch;
})();

/** rustc target triple；未指定 `--target` 时为 undefined（cargo 不加 --target）。 */
export const TARGET_TRIPLE: string | undefined = TARGET_ARCH
  ? `${TARGET_ARCH === "x86_64" ? "x86_64" : "aarch64"}-apple-darwin`
  : undefined;

/** 是否为真正的交叉编译（目标架构 ≠ 宿主架构）。 */
export const IS_CROSS_COMPILE =
  TARGET_ARCH !== undefined && TARGET_ARCH !== HOST_ARCH;

export const FFMPEG_BUILD_DIR = path.join(THIRD_DIR, `FFmpeg-build${BUILD_SUFFIX}`);
export const X264_BUILD_DIR = path.join(THIRD_DIR, `x264-build${BUILD_SUFFIX}`);

/**
 * 桌面 FFmpeg 安装前缀（与 scripts/build-ffmpeg.sh 的落点约定一致）。
 * Android 走 `FFMPEG_BUILD_DIR/android/<arch>/install`，由 mode-plugin 单独拼。
 */
export const FFMPEG_INSTALL_DIR =
  TARGET_ARCH === "x86_64"
    ? path.join(FFMPEG_BUILD_DIR, "darwin", "x86_64", "install")
    : path.join(FFMPEG_BUILD_DIR, "install");

/** CEF runtime 导出目录后缀（与 scripts/build-chromium.sh 的 export_dir 约定一致）。 */
export const CEF_DIR_SUFFIX = TARGET_ARCH === "x86_64" ? "-x64" : "";

/**
 * Cargo 产物目录(单一来源)。默认 `<workspace>/target`,工作区根即 ROOT。
 * 若设了 `CARGO_TARGET_DIR`(如 `CARGO_TARGET_DIR=target-22`,用于在 Ubuntu 22.04
 * 隔离环境做低 glibc 地板的 clean build),则以它为准:
 *  - 相对值按 ROOT 解析(而非各自 cwd),避免相对 `CARGO_TARGET_DIR` 在不同 cwd 下歧义
 *    (主构建 spawn cargo 时 cwd=src-tauri,tauri-cli/其它 cwd=ROOT);
 *  - 归一化成绝对路径后**回写** `process.env.CARGO_TARGET_DIR`,保证所有以 `env: process.env`
 *    派生的 cargo/tauri 落点与本变量一致。
 * 构建系统一切「找/搬产物」的路径都应从这里取,不要再硬编码 `path.join(ROOT, "target")`。
 */
export const TARGET_DIR = (() => {
  const env = process.env.CARGO_TARGET_DIR;
  const dir = env
    ? path.isAbsolute(env)
      ? env
      : path.join(ROOT, env)
    : path.join(ROOT, "target");
  if (env) process.env.CARGO_TARGET_DIR = dir; // 归一化回写,统一所有 cargo 派生进程
  return dir;
})();

/**
 * 本次构建**实际产物**所在目录。传了 `--target` 时 cargo/tauri 会多套一层 triple
 * (`target/<triple>/{debug,release}/`),所有"找产物/搬产物"的路径都必须用它而不是
 * TARGET_DIR——否则跨编时会静默打包上一次 native 构建的残留(架构混合的 .app)。
 * 未传 `--target` 时等同 TARGET_DIR,行为不变。
 */
export const ARTIFACT_DIR = TARGET_TRIPLE
  ? path.join(TARGET_DIR, TARGET_TRIPLE)
  : TARGET_DIR;
// 供子进程(如 src-crawler-plugins/package-plugin.ts)定位产物,无需重复解析 --target。
process.env.KB_ARTIFACT_DIR = ARTIFACT_DIR;

export const DATA_PLUGINS_DIR = path.join(
  ROOT,
  ".kabegame",
  "debug",
  "data",
  "plugins-directory",
);

export const RESOURCES_DIR = path.join(
  ROOT,
  "src-tauri",
  "kabegame",
  "resources",
);

// Windows/Linux/macOS 运行时库的收集与复制集中在 scripts/plugins/os-plugin.ts(OSPlugin)。
// 仓库根 bin/{windows,linux,macos}/ 为各平台暂存目录,详见 cocs/build/PLATFORM_SHARED_LIBS.md。

export const RESOURCES_PLUGINS_DIR = path.join(RESOURCES_DIR, "plugins");
export const RESOURCES_BIN_DIR = path.join(RESOURCES_DIR, "bin");
export const SRC_TAURI_DIR = path.join(ROOT, "src-tauri");
export const TAURI_KABEGAME_DIR = path.join(SRC_TAURI_DIR, "kabegame");

/** 开发服务器 host：供 tauri.conf 的 devUrl / CSP 等使用；可被 TAURI_DEV_HOST / VITE_DEV_SERVER_HOST 覆盖 */
export function getDevServerHost(): string {
  const override = process.env.TAURI_DEV_HOST ?? process.env.VITE_DEV_SERVER_HOST;
  if (override) return override;

  const ifaces = os.networkInterfaces();
  const all: string[] = [];
  for (const name of Object.keys(ifaces || {})) {
    for (const iface of ifaces![name]!) {
      if (iface.family !== "IPv4" || iface.internal) continue;
      all.push(iface.address);
    }
  }
  // 优先返回 RFC 1918 私有地址，过滤 VPN/TUN 虚拟网卡（如 Clash 198.18.x.x）
  const rfc1918 = all.find((ip) => {
    const [a, b] = ip.split(".").map(Number);
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  });
  return rfc1918 ?? all[0] ?? "localhost";
}

interface RunOptions {
  bin?: string;
  cwd?: string;
  [key: string]: any;
}

// 传入 opt.bin 为运行工具，可以为 deno-task、cargo。如果不传则为二进制
export function run(cmd: string, args: string[], opts: RunOptions = {}): void {
  // console.log('runopts: ', cmd, args, opts)
  switch (opts.bin) {
    case "deno-task": {
      // `deno task <script> <args...>`：args 由 deno_task_shell 原样追加进脚本命令，
      // 脚本在 opts.cwd（或 ROOT）的 package.json 中解析。
      args = ["task", cmd, ...args];
      cmd = "deno";
      break;
    }
    case "cargo": {
      args = [cmd, ...args];
      cmd = "cargo";
      break;
    }
  }
  delete opts.bin;
  console.log(
    chalk.yellow("RUN"),
    JSON.stringify(opts),
    "=>\n\t",
    chalk.bold.italic.redBright(cmd, args.join(" ")),
  );
  const res = spawnSync(cmd, args, {
    stdio: "inherit",
    cwd: ROOT,
    shell: process.platform === "win32",
    env: process.env,
    ...opts,
  });
  if (res.status !== 0) {
    process.exit(res.status ?? 1);
  }
}

export function platformExeExt(): string {
  return process.platform === "win32" ? ".exe" : "";
}

export function ensureDir(p: string): void {
  fs.mkdirSync(p, { recursive: true });
}

export function existsFile(p: string): boolean {
  try {
    return fs.existsSync(p) && fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

export function findFirstExisting(
  paths: (string | null | undefined)[],
): string | null {
  for (const p of paths) {
    if (p && existsFile(p)) return p;
  }
  return null;
}

export function stageResourceFile(src: string, dstFileName: string): void {
  if (!fs.existsSync(src)) {
    console.error(chalk.red(`❌ 找不到资源文件: ${src}`));
    process.exit(1);
  }
  ensureDir(RESOURCES_BIN_DIR);
  const dst = path.join(RESOURCES_BIN_DIR, dstFileName);
  fs.copyFileSync(src, dst);
  console.log(
    chalk.cyan(`[build] Staged resource file: ${path.relative(ROOT, dst)}`),
  );
}

export function stageResourceBinary(binName: string): void {
  const ext = platformExeExt();
  const src = path.join(ARTIFACT_DIR, "release", `${binName}${ext}`);
  const dst = path.join(RESOURCES_BIN_DIR, `${binName}${ext}`);
  if (!fs.existsSync(src)) {
    console.error(
      chalk.red(
        `❌ 找不到 sidecar 源二进制: ${src}\n` +
          `请确认已成功构建: cargo build --release -p <crate>`,
      ),
    );
    process.exit(1);
  }
  ensureDir(RESOURCES_BIN_DIR);
  fs.copyFileSync(src, dst);
  console.log(
    chalk.cyan(`[build] Staged exe resource: ${path.relative(ROOT, dst)}`),
  );
}

export function resourceBinaryExists(binName: string): boolean {
  const ext = platformExeExt();
  const p = path.join(RESOURCES_BIN_DIR, `${binName}${ext}`);
  return fs.existsSync(p);
}

export function scanResourcePlugins(): string[] {
  // 始终扫描 RESOURCES_PLUGINS_DIR（预置插件始终在 resources 目录）
  const pluginDir = RESOURCES_PLUGINS_DIR;
  if (!fs.existsSync(pluginDir)) {
    return [];
  }
  const files = fs.readdirSync(pluginDir);
  return files
    .filter((f: string) => f.endsWith(".kgpg"))
    .map((f: string) => path.basename(f, ".kgpg"))
    .filter(Boolean)
    .sort((a: string, b: string) =>
      a.localeCompare(b, undefined, { sensitivity: "base" }),
    );
}

// 读取/更新 Cargo.toml (Workspace Root)
export function readCargoTomlVersion(): string {
  const cargoTomlPath = path.join(ROOT, "Cargo.toml");
  if (!fs.existsSync(cargoTomlPath)) {
    throw new Error("Cargo.toml not found");
  }

  const cargoToml = fs.readFileSync(cargoTomlPath, "utf8");
  const workspacePackageRegex =
    /(\[workspace\.package\][^\[]*?version\s*=\s*")([^"]+)(")/s;
  const match = cargoToml.match(workspacePackageRegex);

  if (!match) {
    throw new Error("Could not find [workspace.package] version in Cargo.toml");
  }

  return match[2];
}
