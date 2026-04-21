/**
 * 工具函数
 */

import { spawnSync, spawn } from "child_process";
import { fileURLToPath } from "url";
import path from "path";
import os from "os";
import fs from "fs";
import chalk from "chalk";
import { OSPlugin } from "./plugins/os-plugin";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const ROOT = path.resolve(__dirname, "..");

export const DATA_PLUGINS_DIR = path.join(ROOT, "data", "plugins-directory");

export const RESOURCES_DIR = path.join(
  ROOT,
  "src-tauri",
  "app-main",
  "resources",
);

export const ffmpegDlls = [
  "libbz2-1.dll",
  "libgcc_s_seh-1.dll",
  "libva_win32.dll",
  "libva.dll",
  "libwinpthread-1.dll",
  "libx264-165.dll",
];

export const RESOURCES_PLUGINS_DIR = path.join(RESOURCES_DIR, "plugins");
export const RESOURCES_BIN_DIR = path.join(RESOURCES_DIR, "bin");
export const SRC_TAURI_DIR = path.join(ROOT, "src-tauri");
export const TAURI_APP_MAIN_DIR = path.join(SRC_TAURI_DIR, "app-main");

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

// 传入 opt.bin 为运行工具，可以为 bun、cargo。如果不传则为二进制
export function run(cmd: string, args: string[], opts: RunOptions = {}): void {
  // console.log('runopts: ', cmd, args, opts)
  switch (opts.bin) {
    case "bun": {
      args = ["run", cmd, ...args];
      cmd = "bun";
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
    chalk.bold.italic(cmd, args.join(" ")),
  );
  const res = spawnSync(cmd, args, {
    stdio: "inherit",
    cwd: ROOT,
    shell: OSPlugin.isWindows,
    env: process.env,
    ...opts,
  });
  if (res.status !== 0) {
    process.exit(res.status ?? 1);
  }
}

export function platformExeExt(): string {
  return OSPlugin.isWindows ? ".exe" : "";
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

export function findDokan2DllOnWindows(): string | null {
  if (process.platform !== "win32") return null;

  const bundled = path.join(ROOT, "bin", "dokan2.dll");
  if (existsFile(bundled)) return bundled;

  const fromEnv = (process.env.DOKAN2_DLL ?? "").trim();
  if (fromEnv) {
    if (existsFile(fromEnv)) return fromEnv;
    console.error(
      chalk.red(
        `❌ 环境变量 DOKAN2_DLL 指向的文件不存在: ${fromEnv}\n` +
          `请改为 dokan2.dll 的绝对路径。`,
      ),
    );
    process.exit(1);
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

export function copyDokan2DllToResources(): void {
  if (process.platform !== "win32") return;

  const dst = path.join(RESOURCES_BIN_DIR, "dokan2.dll");
  if (existsFile(dst)) return;

  const src = findDokan2DllOnWindows();
  if (!src) {
    console.warn(
      chalk.yellow(
        `⚠ 未在系统中找到 dokan2.dll，将继续构建/启动，但"虚拟磁盘"功能将不可用。\n\n` +
          `如果你需要虚拟磁盘：\n` +
          `1) 安装 Dokan 2.x；或\n` +
          `2) 设置环境变量 DOKAN2_DLL 指向 dokan2.dll，例如：\n` +
          `   $env:DOKAN2_DLL="C:\\\\Program Files\\\\Dokan\\\\Dokan Library-2.3.1\\\\dokan2.dll"\n`,
      ),
    );
    return;
  }

  ensureDir(RESOURCES_BIN_DIR);
  fs.copyFileSync(src, dst);
  console.log(
    chalk.cyan(
      `[build] Staged dokan2.dll resource: ${path.relative(
        ROOT,
        dst,
      )} (from: ${src})`,
    ),
  );
}

export function copyDokanInstallerToResources(): void {
  if (process.platform !== "win32") return;

  const fromEnv = (process.env.DOKAN_INSTALLER ?? "").trim();
  const fixed = path.join(ROOT, "bin", "dokan-installer.exe");

  let src = findFirstExisting([fromEnv, fixed].filter(Boolean));
  if (!src) {
    try {
      const binDir = path.join(ROOT, "bin");
      if (fs.existsSync(binDir)) {
        const files = fs.readdirSync(binDir);
        const hit = files.find((f: string) => {
          const lower = f.toLowerCase();
          return (
            lower.includes("dokan") &&
            (lower.endsWith(".exe") || lower.endsWith(".msi"))
          );
        });
        if (hit) {
          const p = path.join(binDir, hit);
          if (existsFile(p)) src = p;
        }
      }
    } catch {
      // ignore
    }
  }
  if (!src) {
    console.log(
      chalk.yellow(
        `[build] Dokan installer not staged (optional). To bundle it, set env DOKAN_INSTALLER or put bin/dokan-installer.exe`,
      ),
    );
    return;
  }
  stageResourceFile(src, "dokan-installer.exe");
}

/** 项目根目录下的 bin 目录（Windows 下放置 DLL 等，供开发时 PATH 或构建时复制到 resources） */
export const BIN_DIR = path.join(ROOT, "bin");

/**
 * 将 kabegame/bin 下所有 *.dll 复制到 resources/bin（仅 Windows）。
 * 与 ensureDokan2DllResource 等一起使用，先执行 Dokan 逻辑再执行本函数即可。
 */
export function copyFFmpegDllsToResources(): void {
  if (process.platform !== "win32") return;
  if (!fs.existsSync(BIN_DIR) || !fs.statSync(BIN_DIR).isDirectory()) return;
  const entries = fs.readdirSync(BIN_DIR, { withFileTypes: true });
  const dlls = entries.filter(
    (e) => e.isFile() && e.name.toLowerCase().endsWith(".dll"),
  );
  if (dlls.length === 0) return;
  ensureDir(RESOURCES_BIN_DIR);
  for (const e of ffmpegDlls) {
    const src = path.join(BIN_DIR, e);
    stageResourceFile(src, e);
  }
}

export function copyDokan2DllToTauriReleaseDirBestEffort(): void {
  if (process.platform !== "win32") return;
  const src = path.join(RESOURCES_BIN_DIR, "dokan2.dll");
  if (!existsFile(src)) return;
  const dst = path.join(SRC_TAURI_DIR, "target", "release", "dokan2.dll");
  try {
    fs.copyFileSync(src, dst);
    console.log(
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

export function stageResourceBinary(binName: string): void {
  const ext = platformExeExt();
  const src = path.join(ROOT, "target", "release", `${binName}${ext}`);
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
