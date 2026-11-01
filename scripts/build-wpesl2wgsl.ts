/**
 * 构建 wpesl2wgsl（Wallpaper Engine 着色器语言 → WGSL 翻译器，src-tauri/wpesl2wgsl）的 wasm：
 *
 *   deno task build:wpesl2wgsl
 *
 * 产物 bin/wasm/wpesl2wgsl/wpesl2wgsl.wasm（git 忽略，与平台无关）。kabegame 的 dev / start / build / check / test
 * 不带 `--skip vue` 时，由 Wpesl2wgslPlugin 拷进 apps/kabegame/src/wpe-scene/wpesl2wgsl/；缺产物只告警，
 * 场景壁纸退回预览图。
 *
 * 需要 rustup 的 wasm32-unknown-unknown 目标（`rustup target add wasm32-unknown-unknown`），缺失时直接报错并给出命令。
 * 用工作区根 Cargo.toml 的 `[profile.wpesl2wgsl]`（按体积优化、panic = abort），不影响其它 crate 的 release 构建。
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ROOT, TARGET_DIR, WPESL2WGSL_WASM } from "./paths.ts";

const TARGET = "wasm32-unknown-unknown";
const PROFILE = "wpesl2wgsl";
const CRATE = "wpesl2wgsl";

function log(message: string): void {
  console.log(`[build:wpesl2wgsl] ${message}`);
}

function installedTargets(): string[] {
  const res = spawnSync("rustup", ["target", "list", "--installed"], {
    encoding: "utf8",
  });
  if (res.status !== 0) {
    throw new Error(`rustup target list 失败：${res.stderr || res.error}`);
  }
  return res.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

function main(): void {
  if (!installedTargets().includes(TARGET)) {
    throw new Error(
      `缺少 Rust 目标 ${TARGET}，先运行：rustup target add ${TARGET}`,
    );
  }

  const args = [
    "build",
    "-p",
    CRATE,
    "--lib",
    "--target",
    TARGET,
    "--profile",
    PROFILE,
  ];
  log(`cargo ${args.join(" ")}`);
  const res = spawnSync("cargo", args, {
    cwd: ROOT,
    stdio: "inherit",
    env: process.env,
  });
  if (res.status !== 0) {
    process.exit(res.status ?? 1);
  }

  // 自定义 profile 的产物目录就是 profile 名
  const built = path.join(TARGET_DIR, TARGET, PROFILE, `${CRATE}.wasm`);
  if (!fs.existsSync(built)) {
    throw new Error(`没有找到构建产物 ${built}`);
  }
  fs.mkdirSync(path.dirname(WPESL2WGSL_WASM), { recursive: true });
  fs.copyFileSync(built, WPESL2WGSL_WASM);
  const kib = (fs.statSync(WPESL2WGSL_WASM).size / 1024).toFixed(0);
  log(`产物 ${path.relative(ROOT, WPESL2WGSL_WASM)}（${kib} KiB）`);
}

main();
