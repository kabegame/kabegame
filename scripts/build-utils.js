#!/usr/bin/env node
/**
 * 构建工具函数
 * 从原 run.js 提取的工具函数
 */

import { spawnSync, spawn } from "child_process";
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";
import chalk from "chalk";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");

export const RESOURCES_PLUGINS_DIR = path.join(
  root,
  "src-tauri",
  "app-main",
  "resources",
  "plugins"
);
export const RESOURCES_BIN_DIR = path.join(
  root,
  "src-tauri",
  "app-main",
  "resources",
  "bin"
);
export const SRC_TAURI_DIR = path.join(root, "src-tauri");
export const TAURI_APP_MAIN_DIR = path.join(SRC_TAURI_DIR, "app-main");

export function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, {
    stdio: "inherit",
    cwd: root,
    shell: process.platform === "win32",
    ...opts,
  });
  if (res.status !== 0) {
    process.exit(res.status ?? 1);
  }
}

export function platformExeExt() {
  return process.platform === "win32" ? ".exe" : "";
}

export function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

export function existsFile(p) {
  try {
    return fs.existsSync(p) && fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

export function findFirstExisting(paths) {
  for (const p of paths) {
    if (p && existsFile(p)) return p;
  }
  return null;
}

export function stageResourceFile(src, dstFileName) {
  if (!fs.existsSync(src)) {
    console.error(chalk.red(`❌ 找不到资源文件: ${src}`));
    process.exit(1);
  }
  ensureDir(RESOURCES_BIN_DIR);
  const dst = path.join(RESOURCES_BIN_DIR, dstFileName);
  fs.copyFileSync(src, dst);
  console.log(
    chalk.cyan(`[build] Staged resource file: ${path.relative(root, dst)}`)
  );
}

export function findDokan2DllOnWindows() {
  if (process.platform !== "win32") return null;

  const bundled = path.join(root, "bin", "dokan2.dll");
  if (existsFile(bundled)) return bundled;

  const fromEnv = (process.env.DOKAN2_DLL ?? "").trim();
  if (fromEnv) {
    if (existsFile(fromEnv)) return fromEnv;
    console.error(
      chalk.red(
        `❌ 环境变量 DOKAN2_DLL 指向的文件不存在: ${fromEnv}\n` +
          `请改为 dokan2.dll 的绝对路径。`
      )
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
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .filter((name) => name.toLowerCase().includes("dokan"));

      const candidates = [];
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

export function ensureDokan2DllResource() {
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
          `   $env:DOKAN2_DLL="C:\\\\Program Files\\\\Dokan\\\\Dokan Library-2.3.1\\\\dokan2.dll"\n`
      )
    );
    return;
  }

  ensureDir(RESOURCES_BIN_DIR);
  fs.copyFileSync(src, dst);
  console.log(
    chalk.cyan(
      `[build] Staged dokan2.dll resource: ${path.relative(
        root,
        dst
      )} (from: ${src})`
    )
  );
}

export function ensureDokanInstallerResourceIfPresent() {
  if (process.platform !== "win32") return;

  const fromEnv = (process.env.DOKAN_INSTALLER ?? "").trim();
  const fixed = path.join(root, "bin", "dokan-installer.exe");

  let src = findFirstExisting([fromEnv, fixed].filter(Boolean));
  if (!src) {
    try {
      const binDir = path.join(root, "bin");
      if (fs.existsSync(binDir)) {
        const files = fs.readdirSync(binDir);
        const hit = files.find((f) => {
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
        `[build] Dokan installer not staged (optional). To bundle it, set env DOKAN_INSTALLER or put bin/dokan-installer.exe`
      )
    );
    return;
  }
  stageResourceFile(src, "dokan-installer.exe");
}

export function copyDokan2DllToTauriReleaseDirBestEffort() {
  if (process.platform !== "win32") return;
  const src = path.join(RESOURCES_BIN_DIR, "dokan2.dll");
  if (!existsFile(src)) return;
  const dst = path.join(SRC_TAURI_DIR, "target", "release", "dokan2.dll");
  try {
    fs.copyFileSync(src, dst);
    console.log(
      chalk.cyan(
        `[build] Copied dokan2.dll next to target/release exe: ${path.relative(
          root,
          dst
        )}`
      )
    );
  } catch {
    // ignore (some environments may lock the file)
  }
}

export function stageResourceBinary(binName) {
  const ext = platformExeExt();
  const src = path.join(SRC_TAURI_DIR, "target", "release", `${binName}${ext}`);
  const dst = path.join(RESOURCES_BIN_DIR, `${binName}${ext}`);
  if (!fs.existsSync(src)) {
    console.error(
      chalk.red(
        `❌ 找不到 sidecar 源二进制: ${src}\n` +
          `请确认已成功构建: cargo build --release -p <crate>`
      )
    );
    process.exit(1);
  }
  ensureDir(RESOURCES_BIN_DIR);
  fs.copyFileSync(src, dst);
  console.log(
    chalk.cyan(`[build] Staged exe resource: ${path.relative(root, dst)}`)
  );
}

export function resourceBinaryExists(binName) {
  const ext = platformExeExt();
  const p = path.join(RESOURCES_BIN_DIR, `${binName}${ext}`);
  return fs.existsSync(p);
}

export function spawnProc(command, args, opts = {}) {
  return spawn(command, args, {
    stdio: "inherit",
    cwd: root,
    shell: process.platform === "win32",
    ...opts,
  });
}

export function scanBuiltinPlugins() {
  if (!fs.existsSync(RESOURCES_PLUGINS_DIR)) {
    return [];
  }
  const files = fs.readdirSync(RESOURCES_PLUGINS_DIR);
  return files
    .filter((f) => f.endsWith(".kgpg"))
    .map((f) => path.basename(f, ".kgpg"))
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}

export function buildEnv(options, builtinPlugins = [], trace = false) {
  const mode = options.mode === "local" ? "local" : "normal";
  const desktop = options.desktop ? String(options.desktop).toLowerCase() : null;
  
  const env = {
    ...process.env,
    KABEGAME_MODE: mode,
    VITE_KABEGAME_MODE: mode,
    VITE_DESKTOP: desktop || "",
  };

  // 设置 RUST_BACKTRACE
  if (trace) {
    env.RUST_BACKTRACE = "full";
    console.log(chalk.cyan(`[env] RUST_BACKTRACE=full`));
  }

  if (process.platform === "linux") {
    if (!env.WEBKIT_DISABLE_DMABUF_RENDERER) {
      env.WEBKIT_DISABLE_DMABUF_RENDERER = "1";
      console.log(
        chalk.yellow(
          `[env] WEBKIT_DISABLE_DMABUF_RENDERER=1 (Linux: 强制软件渲染以避免 DRM/KMS 权限问题)`
        )
      );
    }
  }

  if (mode === "local" && builtinPlugins.length > 0) {
    env.KABEGAME_BUILTIN_PLUGINS = builtinPlugins.join(",");
    console.log(
      chalk.cyan(
        `[env] KABEGAME_BUILTIN_PLUGINS=${env.KABEGAME_BUILTIN_PLUGINS}`
      )
    );
  }

  if (desktop) {
    const validDesktops = ["plasma", "gnome"];
    if (!validDesktops.includes(desktop)) {
      console.error(
        chalk.red(
          `❌ 无效的桌面环境选项: ${desktop}\n` +
            `支持的选项: ${validDesktops.join(", ")}`
        )
      );
      process.exit(1);
    }
    
    console.log(chalk.cyan(`[env] 桌面环境: ${desktop}`));
    console.log(chalk.cyan(`[env] VITE_DESKTOP=${desktop}`));
    const prev = env.RUSTFLAGS ? String(env.RUSTFLAGS) : "";
    const flag = `--cfg desktop="${desktop}"`;
    env.RUSTFLAGS = prev ? `${prev} ${flag}` : flag;
    console.log(chalk.cyan(`[env] RUSTFLAGS+=${flag}`));
  }

  return env;
}

export function parseComponent(raw) {
  const v = (raw ?? "").trim().toLowerCase();
  if (!v) return null;
  if (v === "main" || v === "app-main") return "main";
  if (v === "plugin-editor" || v === "plugineditor" || v === "editor")
    return "plugin-editor";
  if (v === "cli") return "cli";
  if (v === "daemon" || v === "app-daemon") return "daemon";
  if (v === "all") return "all";
  return "unknown";
}

export function getAppDir(component) {
  if (component === "main") return TAURI_APP_MAIN_DIR;
  if (component === "plugin-editor") return path.join(SRC_TAURI_DIR, "app-plugin-editor");
  if (component === "cli") return path.join(SRC_TAURI_DIR, "app-cli");
  return null;
}
