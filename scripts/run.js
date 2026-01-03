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

function spawnProc(command, args, opts = {}) {
  return spawn(command, args, {
    stdio: "inherit",
    cwd: root,
    shell: process.platform === "win32",
    ...opts,
  });
}

function parseFlags(argv) {
  const flags = {
    watch: false,
    verbose: false,
    mode: "normal", // normal | local
  };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--watch") flags.watch = true;
    else if (arg === "--verbose") flags.verbose = true;
    else if (arg === "--mode") {
      const v = argv[i + 1];
      if (!v) {
        console.error("❌ 参数错误：--mode 后必须提供值（normal|local）");
        process.exit(1);
      }
      flags.mode = v === "local" ? "local" : "normal";
      i++;
    } else if (arg.startsWith("--mode=")) {
      const v = arg.slice("--mode=".length);
      flags.mode = v === "local" ? "local" : "normal";
    } else {
      rest.push(arg);
    }
  }
  return { flags, rest };
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
 * @param {object} flags 命令行标志
 * @param {string[]} [builtinPlugins] 内置插件列表（local 模式使用）
 */
function buildEnv(flags, builtinPlugins = []) {
  const mode = flags.mode === "local" ? "local" : "normal";
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
      `[env] KABEGAME_BUILTIN_PLUGINS=${env.KABEGAME_BUILTIN_PLUGINS}`
    );
  }

  return env;
}

function dev(flags) {
  // Step 1: Package plugins first (to src-tauri/resources/plugins) to ensure resources exist
  // This prevents Tauri from failing on empty resources glob pattern
  const packageTarget =
    flags.mode === "local"
      ? "crawler-plugins:package-to-resources"
      : "crawler-plugins:package-local-to-resources";
  console.log(`[dev] Packaging plugins to resources: ${packageTarget}`);
  // 打包阶段不需要 KABEGAME_BUILTIN_PLUGINS，用基础 env
  run("nx", ["run", packageTarget], { env: buildEnv(flags) });

  // Step 2: Scan generated plugins and build final env with builtin list
  const builtinPlugins = flags.mode === "local" ? scanBuiltinPlugins() : [];
  const env = buildEnv(flags, builtinPlugins);

  const tauriTarget = "tauri:dev";

  const children = [];

  if (flags.watch) {
    const watchArgs = ["scripts/nx-nodemon-plugin-watch.mjs"];
    if (flags.verbose) watchArgs.push("--verbose");
    console.log(
      `[dev] Starting plugin watcher (nodemon, nx-config-derived) mode=all-plugins`
    );
    children.push(spawnProc("node", watchArgs, { env }));
  }

  console.log(`[dev] Starting tauri dev: nx run kabegame:${tauriTarget}`);
  children.push(spawnProc("nx", ["run", `kabegame:${tauriTarget}`], { env }));

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

function build(flags) {
  // Package plugins first (to src-tauri/resources/plugins), then tauri build
  // - mode=normal: prepackage local-only plugins
  // - mode=local:  prepackage all plugins

  // Step 1: Package plugins
  const packageTarget =
    flags.mode === "local"
      ? "crawler-plugins:package-to-resources"
      : "crawler-plugins:package-local-to-resources";
  console.log(`[build] Packaging plugins to resources: ${packageTarget}`);
  // 打包阶段不需要 KABEGAME_BUILTIN_PLUGINS，用基础 env
  run("nx", ["run", packageTarget], { env: buildEnv(flags) });

  // Step 1.5: Verify plugins were packaged correctly
  if (!fs.existsSync(RESOURCES_PLUGINS_DIR)) {
    console.error(`❌ 错误：插件资源目录不存在: ${RESOURCES_PLUGINS_DIR}`);
    console.error(`   请确保 ${packageTarget} 任务已正确执行`);
    process.exit(1);
  }
  const pluginFiles = fs.readdirSync(RESOURCES_PLUGINS_DIR).filter((f) => f.endsWith(".kgpg"));
  if (pluginFiles.length === 0) {
    console.error(`❌ 错误：插件资源目录中没有找到 .kgpg 文件: ${RESOURCES_PLUGINS_DIR}`);
    console.error(`   请确保 ${packageTarget} 任务已正确执行`);
    process.exit(1);
  }
  console.log(`[build] 已找到 ${pluginFiles.length} 个插件文件: ${pluginFiles.join(", ")}`);

  // Step 2: Scan generated plugins and build final env with builtin list
  const builtinPlugins = flags.mode === "local" ? scanBuiltinPlugins() : [];
  if (flags.mode === "local" && builtinPlugins.length === 0) {
    console.warn(`⚠️  警告：local 模式下未找到内置插件，这可能导致插件功能不可用`);
  }
  const env = buildEnv(flags, builtinPlugins);

  // Step 3: Build Tauri app
  console.log(`[build] Building Tauri app (mode=${flags.mode})`);
  run("tauri", ["build"], { env });
}

function main() {
  const [command, ...argv] = process.argv.slice(2);
  if (!command || !["dev", "build"].includes(command)) {
    console.error(
      "Usage: node scripts/run.js <dev|build> [--mode normal|local] [--watch] [--verbose]"
    );
    process.exit(1);
  }
  const { flags } = parseFlags(argv);

  if (command === "dev") {
    dev(flags);
  } else if (command === "build") {
    build(flags);
  }
}

main();
