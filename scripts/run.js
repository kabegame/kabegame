#!/usr/bin/env node
/**
 * Unified dev/build entry with flags:
 *   --mode <normal|local>  Build mode (default: normal)
 *                          - normal: 一般版本（带商店源）
 *                          - local:  无商店版本（仅本地源 + 预打包全部插件）
 *   --watch                enable plugin source watching + auto-rebuild
 *   --verbose              show verbose output
 *
 * Examples:
 *   pnpm dev                       # 开发（normal 模式）
 *   pnpm dev --mode local          # 开发（local 模式，预览无商店 UI）
 *   pnpm dev --watch               # 开发 + 插件热重载
 *   pnpm dev --mode local --watch  # local 模式 + 插件热重载
 *   pnpm build                     # 构建（normal 模式）
 *   pnpm build --mode local        # 构建（local 模式，无商店安装包）
 *
 * Watch mode uses:
 *   - Tauri dev watcher + --additional-watch-folders to watch plugin sources
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
const TAURI_SIDECAR_DIR = path.join(SRC_TAURI_DIR, "sidecar");
const TAURI_SIDECAR_CONFIG = path.join(
  SRC_TAURI_DIR,
  "tauri.sidecar.conf.json"
);
const TAURI_SIDECAR_CONFIG_RAW = fs.readFileSync(TAURI_SIDECAR_CONFIG, "utf8");

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

// 构建一个 sidecar 工具
// - dev：建议 profile=debug（更快）
// - build：使用 profile=release（随包发布）
function buildSidecar(env, binName, profile = "release") {
  const triple = rustHostTriple();
  const ext = process.platform === "win32" ? ".exe" : "";
  const src = path.join(SRC_TAURI_DIR, "target", profile, `${binName}${ext}`);
  const dst = path.join(TAURI_SIDECAR_DIR, `${binName}-${triple}${ext}`);

  console.log(
    chalk.blue(`[sidecar] Building: ${binName} (${triple}, profile=${profile})`)
  );
  fs.mkdirSync(TAURI_SIDECAR_DIR, { recursive: true });
  const cargoArgs =
    profile === "release"
      ? ["build", "--release", "--bin", binName]
      : ["build", "--bin", binName];
  run("cargo", cargoArgs, {
    cwd: SRC_TAURI_DIR,
    // sidecar 构建不应依赖主应用的 externalBin（会导致循环依赖/校验失败）
    env: { ...env, TAURI_CONFIG: TAURI_SIDECAR_CONFIG_RAW },
  });
  if (!fs.existsSync(src)) {
    console.error(chalk.red(`❌ sidecar 编译后未找到产物: ${src}`));
    process.exit(1);
  }
  fs.copyFileSync(src, dst);
  console.log(chalk.green(`[sidecar] Copied: ${path.relative(root, dst)}`));
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

function dev(options) {
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

  // Step 2.5: Ensure sidecar binaries exist for `bundle.externalBin` (dev uses debug for speed)
  buildSidecar(env, "kabegame-cli", "debug");
  buildSidecar(env, "kabegame-plugin-editor", "debug");

  const tauriTarget = "tauri:dev";

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

  console.log(
    chalk.blue(`[dev] Starting tauri dev: nx run kabegame:${tauriTarget}`)
  );
  children.push(spawnProc("tauri", ["dev"], { env }));

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

function build(options) {
  // Package plugins first (to src-tauri/resources/plugins), then tauri build
  // - mode=normal: prepackage local-only plugins
  // - mode=local:  prepackage all plugins

  // Step 1: Package plugins to resources
  const packageTarget =
    options.mode === "local"
      ? "crawler-plugins:package-to-resources"
      : "crawler-plugins:package-local-to-resources";
  console.log(
    chalk.blue(`[build] Packaging plugins to resources: ${packageTarget}`)
  );
  // 打包阶段不需要 KABEGAME_BUILTIN_PLUGINS，用基础 env
  run("nx", ["run", packageTarget], { env: buildEnv(options) });

  // Step 1.5: Verify plugins were packaged correctly
  if (!fs.existsSync(RESOURCES_PLUGINS_DIR)) {
    console.error(
      chalk.red(`❌ 错误：插件资源目录不存在: ${RESOURCES_PLUGINS_DIR}`)
    );
    console.error(chalk.red(`   请确保 ${packageTarget} 任务已正确执行`));
    process.exit(1);
  }
  const pluginFiles = fs
    .readdirSync(RESOURCES_PLUGINS_DIR)
    .filter((f) => f.endsWith(".kgpg"));
  if (pluginFiles.length === 0) {
    console.error(
      chalk.red(
        `❌ 错误：插件资源目录中没有找到 .kgpg 文件: ${RESOURCES_PLUGINS_DIR}`
      )
    );
    console.error(chalk.red(`   请确保 ${packageTarget} 任务已正确执行`));
    process.exit(1);
  }
  console.log(
    chalk.green(
      `[build] 已找到 ${pluginFiles.length} 个插件文件: ${pluginFiles.join(
        ", "
      )}`
    )
  );

  // Step 2: Scan generated plugins and build final env with builtin list
  const builtinPlugins = options.mode === "local" ? scanBuiltinPlugins() : [];
  if (options.mode === "local" && builtinPlugins.length === 0) {
    console.warn(
      chalk.yellow(
        `⚠️  警告：local 模式下未找到内置插件，这可能导致插件功能不可用`
      )
    );
  }
  const env = buildEnv(options, builtinPlugins);

  // Step 2.5: Build sidecar binaries that must ship with the app
  buildSidecar(env, "kabegame-cli");
  buildSidecar(env, "kabegame-plugin-editor");

  // Step 3: Build Tauri app
  console.log(chalk.blue(`[build] Building Tauri app (mode=${options.mode})`));
  run("tauri", ["build"], { env });
}

// 创建 Commander 程序
const program = new Command();

program.name("run.js").description("统一开发/构建入口").version("1.0.0");

// dev 命令
program
  .command("dev")
  .description("启动开发模式")
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

// build 命令
program
  .command("build")
  .description("构建生产版本")
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
