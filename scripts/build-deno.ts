/**
 * 从源码自编 deno CLI（third/deno，denoland/deno pin v2.9.0）。
 *
 * 产物与 tauri-cli fork 同款管理：编到 paths.ts 的统一 TARGET_DIR（默认 <root>/target，
 * 尊重 CARGO_TARGET_DIR，如 VM 的 target-22），二进制为 <target>/release/deno。
 * 日常增量刷新由 DenoCliPlugin 在 dev/build 前自动完成；本脚本可用于手动重建。
 *
 * 注意：
 *   - rust 工具链由 third/deno/rust-toolchain.toml 固定（1.95.0），rustup 自动安装。
 *   - deno 官方 release profile 为 lto=true + codegen-units=1 + opt-level='z'，
 *     链接期需 8-16GB 内存。默认用 thin-LTO 降级档（与 DenoCliPlugin 默认一致，
 *     避免 profile 不一致触发全量重编）；KB_DENO_OFFICIAL=1 切回官方档。
 *   - v8（149.4.0）走预编译静态库下载；网络受限时可设 RUSTY_V8_ARCHIVE=/path/to/
 *     librusty_v8_*.a 或 RUSTY_V8_MIRROR=<url>（本脚本原样透传给 cargo）。
 *   - 树内 deno_core 的 kabegame patch series（third-patches/deno）若已应用，编出的
 *     CLI 会带上这些补丁——这正是自编通道的目的。`embed_ext_sources` feature 不会被
 *     CLI 构建启用（仅 kabegame-core 依赖声明开启），CLI 行为与上游一致。
 *   - 默认关闭 upgrade feature：自编二进制不该被 `deno upgrade` 就地覆盖（会跟本脚本
 *     的产物管理打架），后台版本检查也是纯噪音。upgrade 是空 feature（不 gate 任何
 *     依赖），关掉只改行为、不省编译时间/体积。KB_DENO_UPGRADE=1 可切回官方默认。
 *   - Windows 下不能覆盖正在运行的 deno.exe：改动 third/deno 后请用官方 deno 或
 *     另一份拷贝运行本脚本。
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ROOT, TARGET_DIR, THIRD_DIR } from "./paths.ts";

function log(message: string): void {
  console.log(`\x1b[1;36m[build-deno]\x1b[0m ${message}`);
}

function die(message: string): never {
  console.error(`\x1b[1;31m[build-deno] 错误:\x1b[0m ${message}`);
  process.exit(1);
}

function run(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): void {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? ROOT,
    env: options.env ?? process.env,
    shell: false,
    stdio: "inherit",
  });
  if (result.error) die(`无法执行 ${command}: ${result.error.message}`);
  if (result.status !== 0) {
    die(`${command} 执行失败（退出码 ${result.status ?? "unknown"}）`);
  }
}

function captureOptional(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): string | undefined {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? ROOT,
    env: options.env ?? process.env,
    shell: false,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.error || result.status !== 0) return undefined;
  return result.stdout.trim() || undefined;
}

function isExecutable(filename: string): boolean {
  try {
    fs.accessSync(filename, fs.constants.X_OK);
    return fs.statSync(filename).isFile();
  } catch {
    return false;
  }
}

function requireCommand(command: string, hint?: string): void {
  const suffixes = process.platform === "win32"
    ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";")
    : [""];
  const names = path.extname(command)
    ? [command]
    : suffixes.map((suffix) => `${command}${suffix.toLowerCase()}`);
  const found = (process.env.PATH ?? "").split(path.delimiter).some((entry) =>
    entry
      ? names.some((name) => isExecutable(path.join(entry, name)))
      : false
  );
  if (!found) {
    die(`required command not found: ${command}${hint ? ` — ${hint}` : ""}`);
  }
}

function displayPath(filename: string): string {
  const relative = path.relative(ROOT, filename);
  return relative && !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative)
    ? relative
    : filename;
}

function main(): void {
  requireCommand("git");
  requireCommand("rustup", "https://rustup.rs");
  requireCommand("cargo", "https://rustup.rs");

  const sub = path.join(THIRD_DIR, "deno");
  const manifest = path.join(sub, "cli", "Cargo.toml");
  if (!fs.existsSync(manifest) || !fs.statSync(manifest).isFile()) {
    die("缺少子模块 third/deno：先 git submodule update --init third/deno");
  }

  // 与 DenoCliPlugin 保持完全一致的编译环境（cargo 指纹一致才能增量复用）。
  const env: NodeJS.ProcessEnv = { ...process.env, RUSTFLAGS: "-Awarnings" };
  if (process.env.KB_DENO_OFFICIAL === "1") {
    log("KB_DENO_OFFICIAL=1：使用 deno 官方 release profile（fat LTO，链接需 8-16GB 内存）");
  } else {
    env.CARGO_PROFILE_RELEASE_LTO =
      process.env.CARGO_PROFILE_RELEASE_LTO || "thin";
    env.CARGO_PROFILE_RELEASE_CODEGEN_UNITS =
      process.env.CARGO_PROFILE_RELEASE_CODEGEN_UNITS || "16";
    env.CARGO_PROFILE_RELEASE_OPT_LEVEL =
      process.env.CARGO_PROFILE_RELEASE_OPT_LEVEL || "2";
    log(
      `release profile 降级档: lto=${env.CARGO_PROFILE_RELEASE_LTO} ` +
        `codegen-units=${env.CARGO_PROFILE_RELEASE_CODEGEN_UNITS} ` +
        `opt-level=${env.CARGO_PROFILE_RELEASE_OPT_LEVEL}`,
    );
  }

  // 默认剔除 upgrade，但必须手动带回 __vendored_zlib_ng（同在 default 里，
  // 是性能项不是可选项）。KB_DENO_UPGRADE=1 则完全走上游 default。
  let featureArgs = [
    "--no-default-features",
    "--features",
    "__vendored_zlib_ng",
  ];
  if (process.env.KB_DENO_UPGRADE === "1") {
    featureArgs = [];
    log("KB_DENO_UPGRADE=1：保留 upgrade feature（上游 default 特性集）");
  } else {
    log("features: 上游 default 去掉 upgrade（deno upgrade 子命令与后台版本检查禁用）");
  }

  const commit = captureOptional("git", ["-C", sub, "log", "-1", "--format=%h"]) ??
    "?";
  const binBase = path.join(TARGET_DIR, "release", "deno");
  const bin = process.platform === "win32" ? `${binBase}.exe` : binBase;
  log(`building deno (${commit}) → ${bin}`);

  // 必须在 third/deno 内执行 cargo，让 rustup 认到 deno 自带的 rust-toolchain.toml
  // （channel 1.95.0，支持 deno_crypto 的 if_let_guard）。从仓库根跑会退回默认工具链。
  run(
    "cargo",
    [
      "build",
      "--release",
      "--locked",
      "--manifest-path",
      manifest,
      "--target-dir",
      TARGET_DIR,
      ...featureArgs,
      ...process.argv.slice(2),
    ],
    { cwd: sub, env },
  );

  if (!isExecutable(bin)) die(`构建完成但未找到产物: ${bin}`);
  const version = captureOptional(bin, ["--version"], { env })?.split(/\r?\n/, 1)[0];
  if (!version) die(`无法读取构建产物版本: ${bin}`);
  log(`done: ${version} → ${displayPath(bin)}`);
}

main();
