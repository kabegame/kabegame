#!/usr/bin/env node
/**
 * Unified entry for Kabegame workspace:
 * - 2 个前端应用（main / plugin-editor）分别跑在 1420 / 1421
 * - 4 个 Rust crate：daemon /app-main / app-plugin-editor / cli，共用 kabegame-core
 *
 * 用法（PowerShell）：
 * - pnpm dev -c main
 * - pnpm dev -c plugin-editor
 * - pnpm start -c daemon
 * - pnpm build                             （默认构建全部：main + plugin-editor + cli）
 * - pnpm build -c main|plugin-editor|cli
 *
 * 说明：
 * - dev/start 会先打包插件到 src-tauri/resources/plugins（确保资源存在）
 * - main/plugin-editor 的前端由各自 tauri.conf.json 的 beforeDev/BuildCommand 触发
 */

import { fileURLToPath } from "url";
import path from "path";
import { Command } from "commander";

// 保留对 run.js 中仍使用的函数的引用（dev/start 命令）
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function build(options) {
  const { BuildSystem } = await import("./build-system.js");
  const buildSystem = new BuildSystem();
  await buildSystem.run("build", options);
}

async function dev(options) {
  const { BuildSystem } = await import("./build-system.js");
  const buildSystem = new BuildSystem();
  await buildSystem.run("dev", options);
}

async function start(options) {
  const { BuildSystem } = await import("./build-system.js");
  const buildSystem = new BuildSystem();
  await buildSystem.run("start", options);
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
  .option(
    "--desktop <desktop>",
    "指定桌面环境：plasma | gnome（用于后端按桌面环境选择实现）"
  )
  .option("--verbose", "显示详细输出", false)
  .option("--trace", "启用 Rust backtrace（设置 RUST_BACKTRACE=full）", false)
  .action(async (options) => {
    await dev(options);
  });

// start 命令
program
  .command("start")
  .description("启动")
  .option(
    "-c, --component <component>",
    "要启动的组件：main | plugin-editor | cli | daemon",
    "main"
  )
  .option(
    "--mode <mode>",
    "构建模式：normal 或 local（仅影响插件预打包与内置列表）",
    "normal"
  )
  .option(
    "--desktop <desktop>",
    "指定桌面环境：plasma | gnome（用于后端按桌面环境选择实现）"
  )
  .option("--trace", "启用 Rust backtrace（设置 RUST_BACKTRACE=full）", false)
  .action(async (options) => {
    await start(options);
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
  .option(
    "--desktop <desktop>",
    "指定桌面环境：plasma | gnome（用于后端按桌面环境选择实现）"
  )
  .action(async (options) => {
    await build(options);
  });

// 解析命令行参数
program.parse();
