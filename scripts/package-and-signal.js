#!/usr/bin/env node
/**
 * Package plugins and signal Tauri to rebuild.
 *
 * This script:
 * 1. Runs the plugin packaging command
 *
 * Usage:
 *   node scripts/package-and-signal.js [--local] [--to-data]
 */

import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");

const isLocal = process.argv.includes("--local");
const toData = process.argv.includes("--to-data");

// 根据参数选择打包命令
const runner = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
let command;
if (toData) {
  // 输出到 data/plugins_directory，通过 pnpm 调用 nx
  const target = isLocal
    ? "crawler-plugins:package-local-to-data"
    : "crawler-plugins:package-to-data";
  command = `${runner} -s nx run ${target}`;
} else {
  // 默认输出到 crawler-plugins/packed，通过 pnpm 调用脚本
  const script = isLocal ? "package-plugin:local" : "package-plugin";
  command = `${runner} run ${script}`;
}

console.log(`[package-and-signal] Running ${command}...`);

try {
  execSync(command, {
    cwd: root,
    stdio: "inherit",
  });
} catch (e) {
  console.error("[package-and-signal] Packaging failed");
  process.exit(1);
}

// Update trigger file to signal Tauri to rebuild
const timestamp = Date.now().toString();

console.log("[package-and-signal] Done!");
