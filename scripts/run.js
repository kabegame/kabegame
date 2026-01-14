#!/usr/bin/env node
/**
 * Unified entry for Kabegame workspace:
 * - 2 个前端应用（main / plugin-editor）分别跑在 1420 / 1421
 * - 3 个 Rust crate：app-main / app-plugin-editor / cli，共用 kabegame-core
 *
 * 用法（PowerShell）：
 * - pnpm dev -c main
 * - pnpm dev -c plugin-editor
 * - pnpm start -c main|plugin-editor|cli   （无 watch）
 * - pnpm build                             （默认构建全部：main + plugin-editor + cli）
 * - pnpm build -c main|plugin-editor|cli
 *
 * 说明：
 * - dev/start 会先打包插件到 src-tauri/resources/plugins（确保资源存在）
 * - main/plugin-editor 的前端由各自 tauri.conf.json 的 beforeDev/BuildCommand 触发
 */

import { spawnSync, spawn } from "child_process";
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";
import chalk from "chalk";
import { Command } from "commander";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");

// 插件资源目录（Nx 打包输出目录）
const RESOURCES_PLUGINS_DIR = path.join(
  root,
  "src-tauri",
  "app-main",
  "resources",
  "plugins"
);
const RESOURCES_BIN_DIR = path.join(
  root,
  "src-tauri",
  "app-main",
  "resources",
  "bin"
);

const SRC_TAURI_DIR = path.join(root, "src-tauri");
const TAURI_APP_MAIN_DIR = path.join(SRC_TAURI_DIR, "app-main");
const TAURI_APP_PLUGIN_EDITOR_DIR = path.join(
  SRC_TAURI_DIR,
  "app-plugin-editor"
);

const TAURI_APP_CLI_DIR = path.join(SRC_TAURI_DIR, "app-cli");

function run(cmd, args, opts = {}) {
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

function platformExeExt() {
  return process.platform === "win32" ? ".exe" : "";
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function existsFile(p) {
  try {
    return fs.existsSync(p) && fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function findFirstExisting(paths) {
  for (const p of paths) {
    if (p && existsFile(p)) return p;
  }
  return null;
}

/**
 * Find dokan2.dll from common install locations (best-effort).
 * Users can also override via env var: DOKAN2_DLL
 */
function findDokan2DllOnWindows() {
  if (process.platform !== "win32") return null;

  // 0) repo bundled dll (preferred for CI/offline reproducibility)
  const bundled = path.join(root, "bin", "dokan2.dll");
  if (existsFile(bundled)) return bundled;

  // 1) explicit override
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

  // 2) system dirs
  const sysCandidates = [
    path.join(process.env.WINDIR ?? "C:\\Windows", "System32", "dokan2.dll"),
    path.join(process.env.WINDIR ?? "C:\\Windows", "SysWOW64", "dokan2.dll"),
  ];
  const sys = findFirstExisting(sysCandidates);
  if (sys) return sys;

  // 3) Dokan default install dir (versioned). We scan shallowly to avoid slow recursion.
  const programFiles = process.env["ProgramFiles"] ?? "C:\\Program Files";
  const dokanRoot = path.join(programFiles, "Dokan");
  try {
    if (fs.existsSync(dokanRoot) && fs.statSync(dokanRoot).isDirectory()) {
      const entries = fs.readdirSync(dokanRoot, { withFileTypes: true });
      // Common pattern: "Dokan Library-2.x.x"
      const dirs = entries
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .filter((name) => name.toLowerCase().includes("dokan"));

      // Try a few typical locations:
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

/**
 * Ensure dokan2.dll is staged into src-tauri/app-main/resources/bin.
 * This is required by the app-main Windows virtual-drive feature.
 */
function ensureDokan2DllResource() {
  if (process.platform !== "win32") return;

  const dst = path.join(RESOURCES_BIN_DIR, "dokan2.dll");
  if (existsFile(dst)) return;

  const src = findDokan2DllOnWindows();
  if (!src) {
    console.warn(
      chalk.yellow(
        `⚠ 未在系统中找到 dokan2.dll，将继续构建/启动，但“虚拟磁盘”功能将不可用。\n\n` +
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

function copyDokan2DllToTauriReleaseDirBestEffort() {
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

/**
 * Copy a release-built binary from src-tauri/target/release into src-tauri/resources/bin
 * using fixed file names (no triple suffix). These will be shipped as normal resources
 * inside the main installer, then moved to $INSTDIR root by NSIS installer hooks.
 */
function stageResourceBinary(binName) {
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

function resourceBinaryExists(binName) {
  const ext = platformExeExt();
  const p = path.join(RESOURCES_BIN_DIR, `${binName}${ext}`);
  return fs.existsSync(p);
}

function spawnProc(command, args, opts = {}) {
  return spawn(command, args, {
    stdio: "inherit",
    cwd: root,
    shell: process.platform === "win32",
    ...opts,
  });
}

/**
 * 扫描 src-tauri/resources/plugins 目录，获取所有 .kgpg 文件的 id 列表
 * @returns {string[]} 插件 id 列表（文件名去掉 .kgpg 后缀）
 */
function scanBuiltinPlugins() {
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

/**
 * 构建环境变量
 * @param {object} options 命令行选项
 * @param {string[]} [builtinPlugins] 内置插件列表（local 模式使用）
 */
function buildEnv(options, builtinPlugins = []) {
  const mode = options.mode === "local" ? "local" : "normal";
  const env = {
    ...process.env,
    // For Rust build.rs (compile-time injected)
    KABEGAME_MODE: mode,
    // For Vite (compile-time constant for potential tree-shaking)
    VITE_KABEGAME_MODE: mode,
  };

  // local 模式：注入内置插件列表（Rust 编译期使用）
  if (mode === "local" && builtinPlugins.length > 0) {
    env.KABEGAME_BUILTIN_PLUGINS = builtinPlugins.join(",");
    console.log(
      chalk.cyan(
        `[env] KABEGAME_BUILTIN_PLUGINS=${env.KABEGAME_BUILTIN_PLUGINS}`
      )
    );
  }

  return env;
}

function parseComponent(raw) {
  const v = (raw ?? "").trim().toLowerCase();
  if (!v) return null;
  if (v === "main" || v === "app-main") return "main";
  if (v === "plugin-editor" || v === "plugineditor" || v === "editor")
    return "plugin-editor";
  if (v === "cli") return "cli";
  if (v === "all") return "all";
  return "unknown";
}

function getAppDir(component) {
  if (component === "main") return TAURI_APP_MAIN_DIR;
  if (component === "plugin-editor") return TAURI_APP_PLUGIN_EDITOR_DIR;
  if (component === "cli") return TAURI_APP_CLI_DIR;
  return null;
}

function dev(options) {
  const component = parseComponent(options.component);
  if (component === "unknown" || !component) {
    console.error(
      chalk.red(
        `❌ 参数错误：dev 必须指定 -c main 或 -c plugin-editor（当前: ${String(
          options.component
        )}）`
      )
    );
    process.exit(1);
  }
  if (component === "cli") {
    console.error(chalk.red(`❌ CLI 不需要 dev，请使用: pnpm start -c cli`));
    process.exit(1);
  }

  if (component === "main") {
    ensureDokan2DllResource();
  }

  // Step 1: Package plugins first (to src-tauri/resources/plugins) to ensure resources exist
  // This prevents Tauri from failing on empty resources glob pattern
  const packageTarget =
    options.mode === "local"
      ? "crawler-plugins:package-local-to-data"
      : "crawler-plugins:package-to-data";
  console.log(
    chalk.blue(`[dev] Packaging plugins to resources: ${packageTarget}`)
  );
  // 打包阶段不需要 KABEGAME_BUILTIN_PLUGINS，用基础 env
  run("nx", ["run", packageTarget], { env: buildEnv(options) });

  // Step 2: Scan generated plugins and build final env with builtin list
  const builtinPlugins = options.mode === "local" ? scanBuiltinPlugins() : [];
  const env = buildEnv(options, builtinPlugins);

  const children = [];

  if (options.watch) {
    const watchArgs = ["scripts/nx-nodemon-plugin-watch.mjs"];
    if (options.verbose) watchArgs.push("--verbose");
    console.log(
      chalk.blue(
        `[dev] Starting plugin watcher (nodemon, nx-config-derived) mode=all-plugins`
      )
    );
    children.push(spawnProc("node", watchArgs, { env }));
  }

  const appDir = getAppDir(component);
  console.log(chalk.blue(`[dev] Starting tauri dev: ${component}`));
  children.push(
    spawnProc("tauri", ["dev", options.watch ? "" : "--no-watch"], {
      env,
      cwd: appDir,
    })
  );

  const shutdown = () => {
    for (const c of children) {
      try {
        if (!c.killed && c.pid) {
          if (process.platform === "win32") {
            // On Windows, kill() without signal sends termination signal
            c.kill();
            // Force kill after delay if still running
            setTimeout(() => {
              try {
                if (!c.killed && c.pid) {
                  // Use taskkill for force termination on Windows
                  spawnSync(
                    "taskkill",
                    ["/F", "/T", "/PID", c.pid.toString()],
                    {
                      stdio: "ignore",
                      shell: false,
                    }
                  );
                }
              } catch {}
            }, 2000);
          } else {
            c.kill("SIGTERM");
            setTimeout(() => {
              try {
                if (!c.killed) {
                  c.kill("SIGKILL");
                }
              } catch {}
            }, 2000);
          }
        }
      } catch {}
    }
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  // Windows-specific: handle console close (Ctrl+Break)
  if (process.platform === "win32") {
    process.on("SIGBREAK", shutdown);
  }

  // If any child exits, stop the whole dev session (and kill the other).
  for (const c of children) {
    c.on("exit", (code) => {
      shutdown();
      process.exit(code ?? 0);
    });
  }
}

function start(options) {
  const component = parseComponent(options.component) ?? "main";
  if (component === "unknown") {
    console.error(
      chalk.red(
        `❌ 参数错误：start 的 -c 只能是 main/plugin-editor/cli（当前: ${String(
          options.component
        )}）`
      )
    );
    process.exit(1);
  }

  // start：无 watch
  if (component !== "cli") {
    const packageTarget =
      options.mode === "local"
        ? "crawler-plugins:package-local-to-resources"
        : "crawler-plugins:package-to-resources";
    console.log(
      chalk.blue(`[start] Packaging plugins to resources: ${packageTarget}`)
    );
    run("nx", ["run", packageTarget], { env: buildEnv(options) });
  }

  const builtinPlugins = options.mode === "local" ? scanBuiltinPlugins() : [];
  const env = buildEnv(options, builtinPlugins);

  if (component === "main") {
    ensureDokan2DllResource();
  }

  if (component === "cli") {
    console.log(chalk.blue(`[start] Running cli (no watch)`));
    run("cargo", ["run", "-p", "kabegame-cli"], { cwd: SRC_TAURI_DIR, env });
    return;
  }

  const appDir = getAppDir(component);
  console.log(
    chalk.blue(`[start] Starting tauri dev (no watch): ${component}`)
  );
  run("tauri", ["dev", "--no-watch"], { cwd: appDir, env });
}

function build(options) {
  const component = parseComponent(options.component) ?? "all";
  if (component === "unknown") {
    console.error(
      chalk.red(
        `❌ 参数错误：build 的 -c 只能是 main/plugin-editor/cli/all（当前: ${String(
          options.component
        )}）`
      )
    );
    process.exit(1);
  }

  // build：默认全构建
  const wantMain = component === "all" || component === "main";
  const wantEditor = component === "all" || component === "plugin-editor";
  const wantCli = component === "all" || component === "cli";

  if (wantMain || wantEditor) {
    const skipPluginsPackaging =
      (process.env.KABEGAME_SKIP_PLUGINS_PACKAGING ?? "").trim() === "1";
    if (skipPluginsPackaging) {
      console.log(
        chalk.yellow(
          `[build] Skipping plugin packaging (KABEGAME_SKIP_PLUGINS_PACKAGING=1); assuming resources/plugins already prepared`
        )
      );
    } else {
      const packageTarget =
        options.mode === "local"
          ? "crawler-plugins:package-to-resources"
          : "crawler-plugins:package-local-to-resources";
      console.log(
        chalk.blue(`[build] Packaging plugins to resources: ${packageTarget}`)
      );
      run("nx", ["run", packageTarget], { env: buildEnv(options) });
    }
  }

  const builtinPlugins = options.mode === "local" ? scanBuiltinPlugins() : [];
  const env = buildEnv(options, builtinPlugins);

  // 为了“一个安装包包含三个 app”：默认(all)只打包 app-main 的安装包；
  // plugin-editor/cli 的 exe 作为 resources/bin 资源随主程序一起被打包，
  // 安装时通过 NSIS hooks 移动到安装根目录。

  if (wantMain) {
    ensureDokan2DllResource();
  }

  if (wantEditor) {
    console.log(chalk.blue(`[build] Building plugin-editor frontend + binary`));
    run("pnpm", ["-C", "apps/plugin-editor", "build"], { env });
    run("cargo", ["build", "--release", "-p", "kabegame-plugin-editor"], {
      cwd: SRC_TAURI_DIR,
      env,
    });
    stageResourceBinary("kabegame-plugin-editor");
  }

  if (wantCli) {
    console.log(chalk.blue(`[build] Building cli frontend + binary`));
    run("pnpm", ["-C", "apps/cli", "build"], { env });
    run("cargo", ["build", "--release", "-p", "kabegame-cli"], {
      cwd: SRC_TAURI_DIR,
      env,
    });
    stageResourceBinary("kabegame-cli");
    stageResourceBinary("kabegame-cliw");
  }

  // main 打包时，确保 sidecar exe 已就位（避免只 build -c main 时缺少资源）
  if (wantMain) {
    const needCli =
      !resourceBinaryExists("kabegame-cli") ||
      !resourceBinaryExists("kabegame-cliw");
    if (needCli) {
      console.log(
        chalk.blue(
          `[build] Ensuring cli resources exist (kabegame-cli + kabegame-cliw)`
        )
      );
      run("cargo", ["build", "--release", "-p", "kabegame-cli"], {
        cwd: SRC_TAURI_DIR,
        env,
      });
      stageResourceBinary("kabegame-cli");
      stageResourceBinary("kabegame-cliw");
    }

    const needEditor = !resourceBinaryExists("kabegame-plugin-editor");
    if (needEditor) {
      console.log(chalk.blue(`[build] Ensuring plugin-editor resource exists`));
      run("cargo", ["build", "--release", "-p", "kabegame-plugin-editor"], {
        cwd: SRC_TAURI_DIR,
        env,
      });
      stageResourceBinary("kabegame-plugin-editor");
    }
  }

  if (wantMain) {
    console.log(chalk.blue(`[build] Building app-main (bundle installer)`));
    run("tauri", ["build"], { cwd: TAURI_APP_MAIN_DIR, env });
    // Make it runnable directly from src-tauri/target/release (common dev habit)
    copyDokan2DllToTauriReleaseDirBestEffort();
  }
}

// 创建 Commander 程序
const program = new Command();

program.name("run.js").description("统一开发/构建入口").version("1.0.0");

// dev 命令
program
  .command("dev")
  .description("启动开发模式")
  .requiredOption(
    "-c, --component <component>",
    "要启动的组件：main | plugin-editor"
  )
  .option(
    "--mode <mode>",
    "构建模式：normal（一般版本，带商店源）或 local（无商店版本，仅本地源 + 预打包全部插件）",
    "normal"
  )
  .option("--watch", "启用插件源监听 + 自动重建", false)
  .option("--verbose", "显示详细输出", false)
  .action((options) => {
    // 验证 mode 参数
    if (options.mode !== "normal" && options.mode !== "local") {
      console.error(
        chalk.red(
          `❌ 参数错误：--mode 必须是 "normal" 或 "local"，当前值: ${options.mode}`
        )
      );
      process.exit(1);
    }
    dev(options);
  });

// start 命令（无 watch）
program
  .command("start")
  .description("启动（无 watch）")
  .option(
    "-c, --component <component>",
    "要启动的组件：main | plugin-editor | cli",
    "main"
  )
  .option(
    "--mode <mode>",
    "构建模式：normal 或 local（仅影响插件预打包与内置列表）",
    "normal"
  )
  .action((options) => {
    if (options.mode !== "normal" && options.mode !== "local") {
      console.error(
        chalk.red(
          `❌ 参数错误：--mode 必须是 \"normal\" 或 \"local\"，当前值: ${options.mode}`
        )
      );
      process.exit(1);
    }
    start(options);
  });

// build 命令
program
  .command("build")
  .description("构建生产版本")
  .option(
    "-c, --component <component>",
    "要构建的组件：main | plugin-editor | cli | all",
    "all"
  )
  .option(
    "--mode <mode>",
    "构建模式：normal（一般版本，带商店源）或 local（无商店版本，无商店安装包）",
    "normal"
  )
  .action((options) => {
    // 验证 mode 参数
    if (options.mode !== "normal" && options.mode !== "local") {
      console.error(
        chalk.red(
          `❌ 参数错误：--mode 必须是 "normal" 或 "local"，当前值: ${options.mode}`
        )
      );
      process.exit(1);
    }
    build(options);
  });

// 解析命令行参数
program.parse();
