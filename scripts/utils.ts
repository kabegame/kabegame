/**
 * 工具函数
 */

import { spawn, spawnSync } from "child_process";
import path from "path";
import os from "os";
import fs from "fs";
import chalk from "chalk";
import { ARTIFACT_DIR, repoBuildDir, ROOT } from "./paths.ts";
export * from "./paths.ts";
// 注意:本文件不可 import OSPlugin,否则与 os-plugin.ts 形成循环依赖
// (os-plugin.ts 在 top-level 读取 ROOT 等本文件导出)。
// 用 process.platform 直接判断即可。

export const CRAWLER_PLUGINS_DIR = path.join(ROOT, "src-crawler-plugins");

/**
 * 发布产物汇集目录（gitignored，`.kabegame/` 下与 debug/ 等运行期目录同级）。
 *
 * 单一来源：`deno task b --release` 的桌面安装包/CLI（ReleasePlugin）、web 二进制
 * （docker-compose.web-release.yml 的 /dist 挂载）、以及 web 模式的爬虫插件
 * （RELEASE_PLUGINS_DIR）统一落在这里，供 scripts/deploy-web.sh 与 CI 上传。
 * 前端产物不在此列——仍是仓库根的 dist-kabegame-web/（编译期由 include_dir! 嵌入；
 * 桌面/Android 的前端则出到 dist-kabegame/，两者严格分开互不覆盖）。
 */
export const RELEASE_DIR = path.join(ROOT, ".kabegame", "release");

/**
 * web 发布用的爬虫插件目录：`.kabegame/release/plugins`。
 *
 * 桌面构建的插件仍写 `src-tauri/kabegame/resources/plugins`（要随 tauri
 * bundle.resources 打进安装包）；web 二进制不嵌入插件，服务器改由用户数据目录
 * `~/.local/share/Kabegame/plugins-directory/` 加载，故单独产出到这里再上传。
 */
export const RELEASE_PLUGINS_DIR = path.join(RELEASE_DIR, "plugins");

export const FFMPEG_BUILD_DIR = repoBuildDir("FFmpeg");
export const X264_BUILD_DIR = repoBuildDir("x264");

/**
 * 桌面 FFmpeg 安装前缀：bin/{platform}/{arch}/FFmpeg-build/install。
 * Android 由 mode-plugin 使用同一 repoBuildDir 公式定位。
 */
export const FFMPEG_INSTALL_DIR = path.join(FFMPEG_BUILD_DIR, "install");

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
  const override = process.env.TAURI_DEV_HOST ??
    process.env.VITE_DEV_SERVER_HOST;
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
    return a === 10 || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168);
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
      a.localeCompare(b, undefined, { sensitivity: "base" })
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
