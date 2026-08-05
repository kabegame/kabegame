/**
 * 构建路径与目标平台/架构解析。
 *
 * 本文件只依赖 Node 内建模块，确保没有 node_modules 的构建阶段也能直接引用。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const ROOT = path.resolve(__dirname, "..");
export const THIRD_DIR = path.join(ROOT, "third");

/**
 * 目标架构（**仅 macOS**）。由 `--target x86_64|arm64` 指定，用于在 Apple Silicon 上
 * 交叉编译 Intel 版（或反之）。不传 `--target` 或目标为 native/android 时为 undefined。
 *
 * 第三方依赖按目标架构统一落到 `bin/macos/{arch}/{repo}-build`，不同架构完全隔离；
 * cargo/tauri 侧则一律落在 `TARGET_DIR/<triple>/`（见 ARTIFACT_DIR）。
 */
export type TargetArch = "x86_64" | "arm64";

export const TARGET_ARCH_ALIASES: Record<string, TargetArch> = {
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
 * 只解析 argv 中第一个裸 `--` **之前**的 macOS 架构 `--target`；native/android
 * 由各自入口处理。`--` 之后的参数是原样透传给 tauri/cargo 的，由调用方自己负责，
 * 这里不消费也不重复注入。
 */
export function parseTargetArchFromArgv(): TargetArch | undefined {
  const argv = process.argv.slice(2);
  const sep = argv.indexOf("--");
  const scope = sep === -1 ? argv : argv.slice(0, sep);
  for (let i = 0; i < scope.length; i++) {
    const a = scope[i];
    if (a === "--target") {
      const target = scope[i + 1];
      return target && target !== "native" && target !== "android"
        ? normalizeTargetArch(target)
        : undefined;
    }
    if (a.startsWith("--target=")) {
      const target = a.slice("--target=".length);
      return target !== "native" && target !== "android"
        ? normalizeTargetArch(target)
        : undefined;
    }
  }
  return undefined;
}

/** 宿主架构（macOS 之外仅用于第三方构建产物目录命名）。 */
export const HOST_ARCH: TargetArch = process.arch === "arm64"
  ? "arm64"
  : "x86_64";

/** 显式指定的 macOS 目标架构；未传或目标为 native/android 时为 undefined。 */
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
export const IS_CROSS_COMPILE = TARGET_ARCH !== undefined &&
  TARGET_ARCH !== HOST_ARCH;

/** process.platform → 目录命名 token。 */
export const BUILD_PLATFORM: string = (() => {
  switch (process.platform) {
    case "darwin":
      return "macos";
    case "linux":
      return "linux";
    case "win32":
      return "windows";
    default:
      throw new Error(`不支持的构建平台: ${process.platform}`);
  }
})();

/**
 * 第三方仓库编译产物目录（唯一命名公式）：bin/{platform}/{arch}/{repo}-build
 * 不传 platform/arch 时取当前构建目标（TARGET_ARCH ?? HOST_ARCH）。
 */
export function repoBuildDir(
  repo: string,
  opts?: { platform?: string; arch?: TargetArch },
): string {
  const platform = opts?.platform ?? BUILD_PLATFORM;
  const arch = opts?.arch ?? TARGET_ARCH ?? HOST_ARCH;
  return path.join(ROOT, "bin", platform, arch, `${repo}-build`);
}

/**
 * `bin/{platform}/` 下的架构子目录名。
 *
 * 这一层装的是第三方仓库的编译产物（`{repo}-build`），**不是**运行时暂存内容：
 * os-plugin 清空平台暂存目录时要跳过它们，component-plugin 递归收集 deb files
 * 时也必须排除——否则数 GB 的构建树会被打进安装包。
 */
export const ARCH_DIR_NAMES: readonly string[] = ["arm64", "x86_64"];

/** 是否为 `bin/{platform}/` 下的架构子目录（第三方编译产物所在层）。 */
export function isArchDirName(name: string): boolean {
  return ARCH_DIR_NAMES.includes(name);
}

/** CEF runtime distrib 导出目录：bin/{p}/{a}/cef-build-{dev,prod}。 */
export function cefExportDir(
  variant: "dev" | "prod",
  arch?: TargetArch,
): string {
  return `${repoBuildDir("cef", { arch })}-${variant}`;
}

/** chromium checkout 工作区（build-chromium 的构建根，原仓库外 cefbuild）。 */
export const CHROMIUM_DIR: string = path.join(THIRD_DIR, "chromium");

/**
 * 构建属地守卫：某些构建只允许在 Ubuntu 22.04 guest 内执行（glibc 2.35 地板）。
 * 非 Linux 直接放行；Linux 上读 /etc/os-release 判定，不满足则抛错。
 * 逃生阀：环境变量 KB_ALLOW_HOST_BUILD=1。
 */
export function requireUbuntu2204(what: string): void {
  if (process.platform !== "linux" || process.env.KB_ALLOW_HOST_BUILD === "1") {
    return;
  }

  let release = "";
  try {
    release = fs.readFileSync("/etc/os-release", "utf8");
  } catch {
    // 统一走下方的构建属地错误，避免宿主环境细节掩盖 glibc 风险。
  }
  const fields = new Map<string, string>();
  for (const line of release.split("\n")) {
    const match = /^([A-Z_]+)=(.*)$/.exec(line);
    if (!match) continue;
    fields.set(match[1], match[2].replace(/^(["'])(.*)\1$/, "$2"));
  }
  if (fields.get("ID") === "ubuntu" && fields.get("VERSION_ID") === "22.04") {
    return;
  }

  throw new Error(
    `${what} 只允许在 Ubuntu 22.04 guest 内执行（完整挂载同路径仓库），` +
      "否则产物会带上宿主的高版本 glibc 符号；确需在宿主跑请设 KB_ALLOW_HOST_BUILD=1。",
  );
}

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
    ? path.isAbsolute(env) ? env : path.join(ROOT, env)
    : path.join(ROOT, "target");
  if (env) process.env.CARGO_TARGET_DIR = dir; // 归一化回写,统一所有 cargo 派生进程
  return dir;
})();

/**
 * 本次构建**实际产物**所在目录。传了 `--target` 时 cargo/tauri 会多套一层 triple
 * (`target/<triple>/{debug,release}/`),所有"找产物/搬产物"的路径都必须用它而不是
 * TARGET_DIR——否则跨编时会静默打包上一次 native 构建的残留(架构混合的 .app)。
 * 未传 `--target` 时等同 TARGET_DIR。
 */
export const ARTIFACT_DIR = TARGET_TRIPLE
  ? path.join(TARGET_DIR, TARGET_TRIPLE)
  : TARGET_DIR;

// 供子进程(如 src-crawler-plugins/package-plugin.ts)定位产物,无需重复解析 --target。
process.env.KB_ARTIFACT_DIR = ARTIFACT_DIR;
