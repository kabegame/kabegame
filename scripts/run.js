#!/usr/bin/env node
/**
 * Unified dev/build entry with two flags:
 *   --watch           enable plugin source watching + auto-rebuild
 *   --local-plugins   use local plugins packaging targets
 *
 * Examples:
 *   pnpm dev
 *   pnpm dev --watch
 *   pnpm dev --local-plugins --watch
 *   pnpm build
 *   pnpm build --local-plugins
 *
 * Watch mode uses:
 *   - Tauri dev watcher + --additional-watch-folders to watch plugin sources
 */

import { spawnSync, spawn } from "child_process";
import { fileURLToPath } from "url";
import path from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");

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
  const flags = { watch: false, localPlugins: false, verbose: false };
  const rest = [];
  for (const arg of argv) {
    if (arg === "--watch") flags.watch = true;
    else if (arg === "--local-plugins") flags.localPlugins = true;
    else if (arg === "--verbose") flags.verbose = true;
    else rest.push(arg);
  }
  return { flags, rest };
}

function dev(flags) {
  const tauriTarget = flags.localPlugins
    ? "tauri:dev-local-plugins"
    : "tauri:dev";

  const children = [];

  if (flags.watch) {
    const watchArgs = ["scripts/nx-nodemon-plugin-watch.mjs"];
    if (flags.localPlugins) watchArgs.push("--local-plugins");
    if (flags.verbose) watchArgs.push("--verbose");
    console.log(
      `[dev] Starting plugin watcher (nodemon, nx-config-derived) mode=${
        flags.localPlugins ? "local-plugins" : "all-plugins"
      }`
    );
    children.push(spawnProc("node", watchArgs));
  }

  console.log(`[dev] Starting tauri dev: nx run kabegame:${tauriTarget}`);
  children.push(spawnProc("nx", ["run", `kabegame:${tauriTarget}`]));

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
  // Package plugins first (local vs remote), then tauri build
  if (flags.localPlugins) {
    run("nx", ["run", "crawler-plugins:package-local"]);
  } else {
    run("nx", ["run", "crawler-plugins:package"]);
  }
  run("tauri", ["build"]);
}

function main() {
  const [command, ...argv] = process.argv.slice(2);
  if (!command || !["dev", "build"].includes(command)) {
    console.error(
      "Usage: node scripts/run.js <dev|build> [--watch] [--local-plugins] [--verbose]"
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
