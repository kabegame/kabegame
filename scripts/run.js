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
  "resources",
  "plugins"
);

const SRC_TAURI_DIR = path.join(root, "src-tauri");
const TAURI_APP_MAIN_DIR = path.join(SRC_TAURI_DIR, "app-main");
const TAURI_APP_PLUGIN_EDITOR_DIR = path.join(
  SRC_TAURI_DIR,
  "app-plugin-editor"
);

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

// 检测是否存在 rustc 工具链
function rustHostTriple() {
  const res = spawnSync("rustc", ["-vV"], {
    encoding: "utf8",
    cwd: root,
    shell: process.platform === "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (res.status !== 0) {
    console.error(
      chalk.red("❌ 读取 rustc host triple 失败，请确认已安装 Rust 工具链")
    );
    process.exit(res.status ?? 1);
  }
  const out = (res.stdout || "").toString();
  const m = out.match(/^host:\s*(.+)$/m);
  if (!m) {
    console.error(chalk.red("❌ 无法从 `rustc -vV` 输出解析 host triple"));
    process.exit(1);
  }
  return m[1].trim();
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

  // Step 1: Package plugins first (to src-tauri/resources/plugins) to ensure resources exist
  // This prevents Tauri from failing on empty resources glob pattern
  const packageTarget =
    options.mode === "local"
      ? "crawler-plugins:package-local-to-resources"
      : "crawler-plugins:package-to-resources";
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

  const appDir =
    component === "main" ? TAURI_APP_MAIN_DIR : TAURI_APP_PLUGIN_EDITOR_DIR;
  console.log(chalk.blue(`[dev] Starting tauri dev: ${component}`));
  children.push(
    spawnProc("tauri", ["dev"], {
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

  if (component === "cli") {
    console.log(chalk.blue(`[start] Running cli (no watch)`));
    run("cargo", ["run", "-p", "kabegame-cli"], { cwd: SRC_TAURI_DIR, env });
    return;
  }

  const appDir =
    component === "main" ? TAURI_APP_MAIN_DIR : TAURI_APP_PLUGIN_EDITOR_DIR;
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
    const packageTarget =
      options.mode === "local"
        ? "crawler-plugins:package-to-resources"
        : "crawler-plugins:package-local-to-resources";
    console.log(
      chalk.blue(`[build] Packaging plugins to resources: ${packageTarget}`)
    );
    run("nx", ["run", packageTarget], { env: buildEnv(options) });
  }

  const builtinPlugins = options.mode === "local" ? scanBuiltinPlugins() : [];
  const env = buildEnv(options, builtinPlugins);

  if (wantMain) {
    console.log(chalk.blue(`[build] Building app-main`));
    run("tauri", ["build"], { cwd: TAURI_APP_MAIN_DIR, env });
  }
  if (wantEditor) {
    console.log(chalk.blue(`[build] Building app-plugin-editor`));
    run("tauri", ["build"], { cwd: TAURI_APP_PLUGIN_EDITOR_DIR, env });
  }
  if (wantCli) {
    console.log(chalk.blue(`[build] Building cli`));
    run("cargo", ["build", "-p", "kabegame-cli", "--release"], {
      cwd: SRC_TAURI_DIR,
      env,
    });
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
