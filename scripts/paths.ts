/**
 * 构建路径、平台与宿主架构解析。
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

/** 宿主架构，用于第三方构建产物的目录命名。 */
export type BuildArch = "x86_64" | "arm64";

export const HOST_ARCH: BuildArch = process.arch === "arm64"
  ? "arm64"
  : "x86_64";

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
 * 不传 platform/arch 时取当前宿主架构。
 */
export function repoBuildDir(
  repo: string,
  opts?: { platform?: string; arch?: BuildArch },
): string {
  const platform = opts?.platform ?? BUILD_PLATFORM;
  const arch = opts?.arch ?? HOST_ARCH;
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

/** 本次原生构建的产物目录。 */
export const ARTIFACT_DIR = TARGET_DIR;
