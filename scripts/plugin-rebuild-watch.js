#!/usr/bin/env node
/**
 * Watches crawler plugin sources and rebuilds packaged plugins via Nx.
 * After a successful rebuild, touches `src-tauri/.plugin-rebuild-trigger`
 * to make Tauri dev watcher restart the app.
 *
 * Usage:
 *   node scripts/plugin-rebuild-watch.js [--local-plugins] [--verbose]
 */

import fs from "fs";
import path from "path";
import { spawn } from "child_process";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

function toPosix(p) {
  return p.split(path.sep).join("/");
}

function listFilesRecursive(dir) {
  const out = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFilesRecursive(full));
    else if (e.isFile()) out.push(full);
  }
  return out;
}

function parseFlags(argv) {
  return {
    localPlugins: argv.includes("--local-plugins"),
    verbose: argv.includes("--verbose"),
  };
}

function touch(filePath) {
  const now = new Date();
  try {
    fs.utimesSync(filePath, now, now);
  } catch {
    fs.writeFileSync(filePath, now.toISOString() + "\n", "utf-8");
  }
}

function spawnShell(command, cwd) {
  // shell:true works cross-platform for simple commands
  return spawn(command, [], { cwd, stdio: "inherit", shell: true });
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));

  const pluginsRoot = path.join(root, "crawler-plugins", "plugins");
  const packagingScript = path.join(root, "crawler-plugins", "package-plugin.js");
  const triggerFile = path.join(root, "src-tauri", ".plugin-rebuild-trigger");

  const allowPluginDirs = flags.localPlugins
    ? ["single-file-import", "local-folder-import"]
    : fs
        .readdirSync(pluginsRoot, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);

  const allowFiles = new Set();
  allowFiles.add(packagingScript);
  for (const pluginDirName of allowPluginDirs) {
    const dir = path.join(pluginsRoot, pluginDirName);
    if (!fs.existsSync(dir)) continue;
    for (const f of listFilesRecursive(dir)) allowFiles.add(f);
  }

  const allowed = [...allowFiles].map((abs) => path.resolve(abs));

  console.log(
    `[plugin-watch] mode=${flags.localPlugins ? "local-plugins" : "all-plugins"} files=${allowed.length}`
  );

  let timer = null;
  let running = false;
  let pending = false;

  const schedule = (changed) => {
    if (flags.verbose) {
      console.log("[plugin-watch] change:", toPosix(path.relative(root, changed)));
    }
    if (timer) clearTimeout(timer);
    timer = setTimeout(async () => {
      if (running) {
        pending = true;
        return;
      }
      running = true;
      pending = false;
      const nxTarget = flags.localPlugins ? "crawler-plugins:package-local" : "crawler-plugins:package";
      console.log(`[plugin-watch] nx run ${nxTarget}`);

      const child = spawnShell(`nx run ${nxTarget}`, root);
      const code = await new Promise((resolve) => child.on("exit", resolve));

      if (code === 0) {
        console.log("[plugin-watch] rebuild ok, triggering tauri restart");
        touch(triggerFile);
      } else {
        console.error("[plugin-watch] rebuild failed, skip restart");
      }

      running = false;
      if (pending) {
        // re-run once if changes happened during build
        schedule(changed);
      }
    }, 250);
  };

  // Use fs.watch per-file (small file set). More reliable than directory glob filters with ignore.
  for (const abs of allowed) {
    try {
      fs.watch(abs, { persistent: true }, () => schedule(abs));
    } catch (e) {
      if (flags.verbose) console.warn("[plugin-watch] cannot watch:", abs, e?.message || e);
    }
  }

  // Keep process alive
  process.stdin.resume();
}

main().catch((err) => {
  console.error("[plugin-watch] error:", err?.message || err);
  process.exit(1);
});


