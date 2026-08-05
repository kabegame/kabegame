/**
 * 交叉编译 aarch64-linux-android 的 librusty_v8.a，产出 Android V8 后端所需的自建产物：
 *   bin/android/arm64/rusty_v8-build/librusty_v8_simdutf_release_aarch64-linux-android.a
 *   bin/android/arm64/rusty_v8-build/src_binding_simdutf_release_aarch64-linux-android.rs
 * 二者经 mode-plugin 的 RUSTY_V8_ARCHIVE / RUSTY_V8_SRC_BINDING_PATH 注入 android 构建。
 * 产物 gitignore、不入库，由本命令复现（对标 build-ffmpeg.ts 的 --target android）。
 *
 * 构建树 = `third/rusty_v8` 子模块本身（denoland/rusty_v8，pin v149.4.0 = Cargo.lock 的 v8）。它是
 * 一棵「就地复用」的完整树：nested submodules（v8 / build / third_party/*）与已编译的 target/ 都在其中，
 * 所以复用构建（增量、不重新拉取、不从零重编）。补丁全部是 third-patches/rusty_v8/ 顶层 *.patch，均由
 * `git -C third/rusty_v8 apply` 应用（0002 路径带 `build/` 前缀，git apply 会跨进嵌套 build 子模块）：
 *   third-patches/rusty_v8/0001-ninja-jobserver-fd.patch    → build.rs（ninja jobserver 修复）
 *   third-patches/rusty_v8/0002-android-ndk-build-gn.patch  → build/config/android/BUILD.gn（NDK 字面量）
 * 本脚本幂等应用它们。`deno task patch rusty_v8` 因胖树常驻脏态会被 patch-manager 跳过。
 * 另有 3 处非 diff 的 fixup（simdutf checkout / host sysroot / android_toolchain ndk symlink）只在「首次
 * 拉取 nested submodules」时做；复用树里已就绪。见 third-patches/rusty_v8/README.md 与
 * cocs/crawler/V8_RUNTIME.md。
 *
 * 仅 Linux 宿主（NDK 工具链按 linux-x86_64）。首次拉取 nested submodules + NDK 需 ≥15 GB 磁盘、可联网。
 * 另需 clang 19+ 的 libclang（build.rs 在 V8_FROM_SOURCE 下总跑 bindgen）——脚本自动探测 llvm-19。
 *
 * 环境变量：
 *   GN / NINJA   指向「真 chromium 树」的 gn / ninja（非 depot_tools 包装脚本）。默认复用
 *                CHROMIUM_DIR 下 chromium 自带的 gn/ninja；按需覆盖。
 *   LIBCLANG_PATH   clang 19+ 的 libclang 目录（bindgen 用）。未设则自动探测 llvm-19
 *                （llvm-config-19 --libdir 或 /usr/lib/llvm-19/lib）。
 *   BINDGEN_EXTRA_CLANG_ARGS   透传给 bindgen 的 clang 参数。脚本自动前置 NDK Bionic aarch64
 *                `--sysroot=...`（与 bindgen 的 --target=aarch64-linux-android 相符），已设则保留并前置。
 *   RUSTY_V8_BINDING_SRC   显式指定 src_binding 源文件；默认用 build.rs 刚生成的 gn_out/src_binding.rs，
 *                缺失才回退 cargo registry 里 v8 包预置的 aarch64 binding（64 位目标逐字节一致）。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  CHROMIUM_DIR,
  repoBuildDir,
  ROOT,
  THIRD_DIR,
} from "./paths.ts";

const TARGET = "aarch64-linux-android";
const SUB = path.join(THIRD_DIR, "rusty_v8");
const PATCH_DIR = path.join(ROOT, "third-patches", "rusty_v8");
const OUT_DIR = repoBuildDir("rusty_v8", {
  platform: "android",
  arch: "arm64",
});
const ARCHIVE_OUT = path.join(
  OUT_DIR,
  `librusty_v8_simdutf_release_${TARGET}.a`,
);
const BINDING_OUT = path.join(
  OUT_DIR,
  `src_binding_simdutf_release_${TARGET}.rs`,
);

function log(message: string): void {
  console.log(`\x1b[1;36m[build-v8]\x1b[0m ${message}`);
}

function warn(message: string): void {
  console.warn(`\x1b[1;33m[build-v8] 警告:\x1b[0m ${message}`);
}

function die(message: string): never {
  console.error(`\x1b[1;31m[build-v8] 错误:\x1b[0m ${message}`);
  process.exit(1);
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

function isExecutable(filename: string): boolean {
  try {
    fs.accessSync(filename, fs.constants.X_OK);
    return fs.statSync(filename).isFile();
  } catch {
    return false;
  }
}

function requireCommand(command: string, hint?: string): void {
  const pathEntries = (process.env.PATH ?? "").split(path.delimiter);
  const found = pathEntries.some((entry) =>
    entry ? isExecutable(path.join(entry, command)) : false
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

function applyPatch(repo: string, patchFile: string): void {
  const name = path.basename(patchFile);
  if (
    commandSucceeds("git", [
      "-C",
      repo,
      "apply",
      "--reverse",
      "--check",
      patchFile,
    ])
  ) {
    log(`  already applied: ${name} → ${displayPath(repo)}`);
    return;
  }
  if (
    commandSucceeds("git", ["-C", repo, "apply", "--check", patchFile])
  ) {
    run("git", ["-C", repo, "apply", patchFile]);
    log(`  applied:         ${name} → ${displayPath(repo)}`);
    return;
  }
  die(
    `patch 既不能应用也未应用：${patchFile}（→ ${repo}）。` +
      "上游漂移？请核对并重生成。",
  );
}

function ensureAndroidNdkSymlink(): void {
  const link = path.join(
    SUB,
    "third_party",
    "android_toolchain",
    "ndk",
  );
  fs.mkdirSync(path.dirname(link), { recursive: true });
  try {
    const stat = fs.lstatSync(link);
    if (!stat.isSymbolicLink()) {
      die(`无法创建 NDK symlink，目标已存在且不是符号链接: ${link}`);
    }
    if (fs.readlinkSync(link) === "../android_ndk") return;
    fs.unlinkSync(link);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
      throw error;
    }
  }
  fs.symlinkSync("../android_ndk", link, "dir");
}

function ensureNestedBuildTree(): void {
  const androidBuild = path.join(SUB, "build", "config", "android", "BUILD.gn");
  const v8Build = path.join(SUB, "v8", "BUILD.gn");
  if (fs.existsSync(androidBuild) && fs.existsSync(v8Build)) {
    log("nested build tree present — reusing (skip fetch + one-time fixups)");
    return;
  }

  log("fetching nested submodules (v8 / build / third_party — heavy, needs network) …");
  run("git", ["-C", SUB, "submodule", "update", "--init", "--recursive"]);
  // simdutf 子模块工作区可能只剩 gitlink，恢复文件。
  run("git", [
    "-C",
    path.join(SUB, "third_party", "simdutf"),
    "checkout",
    "-f",
    "HEAD",
  ]);
  // host sysroot（gn 生成时需要 amd64 sysroot；install-sysroot 已装则跳过）。
  run("python3", [
    path.join(SUB, "build", "linux", "sysroot_scripts", "install-sysroot.py"),
    "--arch=amd64",
  ]);
  // gn 期望 third_party/android_toolchain/ndk，build.rs 却把 NDK 下到 third_party/android_ndk。
  ensureAndroidNdkSymlink();
}

function findLibclangDir(): string | undefined {
  const candidates: string[] = [];
  const llvmDir = captureOptional("llvm-config-19", ["--libdir"]);
  if (llvmDir) candidates.push(llvmDir);
  candidates.push("/usr/lib/llvm-19/lib");

  for (const candidate of candidates) {
    try {
      if (
        fs.readdirSync(candidate).some((name) => /^libclang.*\.so.*$/.test(name))
      ) {
        return candidate;
      }
    } catch {
      // 继续探测下一个候选目录。
    }
  }
  return undefined;
}

function findNdkSysroot(): string | undefined {
  const prebuilt = path.join(
    SUB,
    "third_party",
    "android_ndk",
    "toolchains",
    "llvm",
    "prebuilt",
  );
  try {
    for (const name of fs.readdirSync(prebuilt).sort()) {
      const candidate = path.join(prebuilt, name, "sysroot");
      if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
        return candidate;
      }
    }
  } catch {
    // 全新 re-vendor 时，NDK 可能要等 build.rs 首跑后才出现。
  }
  return undefined;
}

function findRegistryBinding(version: string): string | undefined {
  const registry = path.join(os.homedir(), ".cargo", "registry", "src");
  try {
    for (const source of fs.readdirSync(registry).sort()) {
      const candidate = path.join(
        registry,
        source,
        `v8-${version}`,
        "gen",
        "src_binding_simdutf_release_aarch64-unknown-linux-gnu.rs",
      );
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return candidate;
      }
    }
  } catch {
    // 没有 cargo registry 时，由调用方给出统一的 binding 缺失错误。
  }
  return undefined;
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GiB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function main(): void {
  if (process.platform !== "linux") {
    die(`build-v8.ts only runs on Linux (host: ${process.platform}).`);
  }
  requireCommand("git");
  requireCommand("cargo", "rustup");
  requireCommand("python3");

  if (!fs.existsSync(SUB) || !fs.statSync(SUB).isDirectory()) {
    die("缺少子模块 third/rusty_v8：先 git submodule update --init third/rusty_v8");
  }

  const gn = process.env.GN || path.join(
    CHROMIUM_DIR,
    "chromium_git",
    "chromium",
    "src",
    "buildtools",
    "linux64",
    "gn",
  );
  const ninja = process.env.NINJA || path.join(
    CHROMIUM_DIR,
    "chromium_git",
    "chromium",
    "src",
    "third_party",
    "ninja",
    "ninja",
  );
  if (!isExecutable(gn)) {
    die(`gn 不可执行：${gn} — 设 GN=/path/to/gn（chromium 树的真 gn，非 depot_tools 包装脚本）`);
  }
  if (!isExecutable(ninja)) {
    die(`ninja 不可执行：${ninja} — 设 NINJA=/path/to/ninja`);
  }

  const cargoToml = fs.readFileSync(path.join(SUB, "Cargo.toml"), "utf8");
  const versionMatch = /^version\s*=\s*"([^"]+)"/m.exec(cargoToml);
  if (!versionMatch) die(`无法从 ${path.join(SUB, "Cargo.toml")} 读取 v8 版本`);
  const version = versionMatch[1];
  const tag = captureOptional("git", ["-C", SUB, "describe", "--tags"]) ??
    "detached";
  log(`rusty_v8 (v8 crate) ${version} @ ${tag}`);

  ensureNestedBuildTree();

  // 全部顶层 *.patch 都打到 third/rusty_v8；0002 的路径带 build/ 前缀，
  // git apply 会跨进嵌套 build 子模块。
  log("ensuring kabegame patches …");
  if (!fs.existsSync(PATCH_DIR) || !fs.statSync(PATCH_DIR).isDirectory()) {
    die(`缺少补丁目录: ${PATCH_DIR}`);
  }
  const patchFiles = fs.readdirSync(PATCH_DIR)
    .filter((name) => name.endsWith(".patch"))
    .sort()
    .map((name) => path.join(PATCH_DIR, name));
  for (const patchFile of patchFiles) applyPatch(SUB, patchFile);

  const env: NodeJS.ProcessEnv = { ...process.env };
  // bindgen 需要 clang 19+ 的 libclang——build.rs 在 V8_FROM_SOURCE 下总会跑 bindgen
  // 生成 binding（无法跳过）。未显式设 LIBCLANG_PATH 则自动探测 llvm-19。
  if (!env.LIBCLANG_PATH) env.LIBCLANG_PATH = findLibclangDir();
  if (env.LIBCLANG_PATH) {
    log(`LIBCLANG_PATH=${env.LIBCLANG_PATH}`);
  } else {
    warn("未探测到 clang 19+ libclang(设 LIBCLANG_PATH 或 apt install llvm-19)；bindgen 会失败。");
  }

  // bindgen 继承 cargo TARGET，以 --target=aarch64-linux-android 解析头文件；但 build.rs
  // 的 android 分支不补 sysroot。必须给它 NDK 的 Bionic aarch64 sysroot，避免误用宿主
  // glibc/x86_64 头；binding 对 64 位目标架构无关。
  const ndkSysroot = findNdkSysroot();
  if (ndkSysroot) {
    env.BINDGEN_EXTRA_CLANG_ARGS = `--sysroot=${ndkSysroot}${
      env.BINDGEN_EXTRA_CLANG_ARGS ? ` ${env.BINDGEN_EXTRA_CLANG_ARGS}` : ""
    }`;
    log(`BINDGEN_EXTRA_CLANG_ARGS += --sysroot=${ndkSysroot}`);
  } else {
    warn(
      "未找到 NDK Bionic sysroot(third_party/android_ndk/.../sysroot)；" +
        "若 bindgen 因宿主头错位失败，待 NDK 下载后再跑一次 build:v8。",
    );
  }

  // 构建复用 third/rusty_v8/target，--features simdutf 必须与 deno_core 0.405 一致；
  // jobserver fd 修复由 crate 补丁提供。
  log(`building librusty_v8.a for ${TARGET} (incremental; from-source first run ~15GB) …`);
  env.GN = gn;
  env.NINJA = ninja;
  env.V8_FROM_SOURCE = "1";
  run(
    "cargo",
    [
      "build",
      "--release",
      "--manifest-path",
      path.join(SUB, "Cargo.toml"),
      "--target",
      TARGET,
      "--features",
      "simdutf",
      ...process.argv.slice(2),
    ],
    { env },
  );

  const archiveIn = path.join(
    SUB,
    "target",
    TARGET,
    "release",
    "gn_out",
    "obj",
    "librusty_v8.a",
  );
  if (!fs.existsSync(archiveIn) || !fs.statSync(archiveIn).isFile()) {
    die(`构建未产出 ${archiveIn}`);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.copyFileSync(archiveIn, ARCHIVE_OUT);
  log(`wrote ${formatSize(fs.statSync(ARCHIVE_OUT).size)}  ${displayPath(ARCHIVE_OUT)}`);

  // V8_FROM_SOURCE 下 build.rs 优先用 clang19 生成的 binding；缺失则回退 v8 crate
  // registry 预置版或 RUSTY_V8_BINDING_SRC。
  let bindingSource = process.env.RUSTY_V8_BINDING_SRC
    ? path.resolve(process.cwd(), process.env.RUSTY_V8_BINDING_SRC)
    : undefined;
  if (!bindingSource) {
    const generated = path.join(
      SUB,
      "target",
      TARGET,
      "release",
      "gn_out",
      "src_binding.rs",
    );
    bindingSource = fs.existsSync(generated) && fs.statSync(generated).isFile()
      ? generated
      : findRegistryBinding(version);
  }
  if (
    !bindingSource || !fs.existsSync(bindingSource) ||
    !fs.statSync(bindingSource).isFile()
  ) {
    die(
      "找不到 src_binding 源。设 RUSTY_V8_BINDING_SRC=<file>，或确认 bindgen 已生成 " +
        "gn_out/src_binding.rs（需 LIBCLANG_PATH 指向 clang19）。",
    );
  }
  fs.copyFileSync(bindingSource, BINDING_OUT);
  log(`wrote ${displayPath(BINDING_OUT)}  (from ${displayPath(bindingSource)})`);

  log(
    "done. Android build picks these up via mode-plugin " +
      "(RUSTY_V8_ARCHIVE / RUSTY_V8_SRC_BINDING_PATH).",
  );
}

main();
