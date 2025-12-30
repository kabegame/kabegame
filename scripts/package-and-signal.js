#!/usr/bin/env node
/**
 * Package plugins and signal Tauri to rebuild.
 * 
 * This script:
 * 1. Runs the plugin packaging command
 * 2. Updates src-tauri/.plugin-rebuild-trigger with current timestamp
 * 3. Tauri's build.rs watches this file and triggers a rebuild
 * 
 * Usage:
 *   node scripts/package-and-signal.js [--local]
 */

import { execSync } from "child_process";
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');

const isLocal = process.argv.includes('--local');
const packageCmd = isLocal ? 'package-plugin:local' : 'package-plugin';

const runner = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
console.log(`[package-and-signal] Running ${runner} run ${packageCmd}...`);

try {
  execSync(`${runner} run ${packageCmd}`, {
    cwd: root,
    stdio: 'inherit',
  });
} catch (e) {
  console.error('[package-and-signal] Packaging failed');
  process.exit(1);
}

// Update trigger file to signal Tauri to rebuild
const triggerFile = path.join(root, 'src-tauri', '.plugin-rebuild-trigger');
const timestamp = Date.now().toString();

console.log('[package-and-signal] Signaling Tauri to rebuild...');
fs.writeFileSync(triggerFile, timestamp);

console.log('[package-and-signal] Done!');

