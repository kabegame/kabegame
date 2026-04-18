#!/usr/bin/env node
/**
 * Unified entry for Kabegame workspace:
 * - 1 个前端应用（main）跑在 1420
 * - 2 个 Rust crate：app-main / app-cli，共用 kabegame-core
 *
 * 用法（PowerShell）：
 * - bun dev -c main
 * - bun b                             （默认构建全部：main + cli）
 * - bun b -c main|cli
 *
 * 说明：
 * - bun dev -c main 时由构建链打包爬虫插件到 data/plugins-directory（package-to-dev-data），不写入 app resources
 * - main 的前端由各自 tauri.conf.json 的 beforeDev/BuildCommand 触发
 */

import { Command } from "commander";
import { BuildSystem } from "./build-system";
import { Component } from "./plugins/component-plugin";
import { Mode } from "./plugins/mode-plugin";

const buildSystem = new BuildSystem();

interface BuildOptions {
  component?: string;
  mode?: string;
  data?: string;
  verbose?: boolean;
  trace?: boolean;
  skip?: string;
  args?: string[];
  release?: boolean;
  /** false 表示传入 --no-nx，不经 nx 构建 main 前端 */
  nx?: boolean;
}

/**
 * 构建命令的固定执行流程
 */
async function build(options: BuildOptions): Promise<void> {
  await buildSystem.build(options);
}

/**
 * dev 命令的固定执行流程
 */
async function dev(options: BuildOptions): Promise<void> {
  await buildSystem.dev(options);
}

/**
 * start 命令的固定执行流程
 */
async function start(options: BuildOptions): Promise<void> {
  await buildSystem.start(options);
}

async function check(options: BuildOptions): Promise<void> {
  await buildSystem.check(options);
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
    "要启动的组件：main",
    Component.MAIN,
  )
  .option(
    "--mode <mode>",
    "构建模式：standard | light | android",
    Mode.STANDARD,
  )
  .option("--data <data>", "数据目录模式：dev | prod（默认 dev）")
  .option("--trace", "启用 Rust backtrace（设置 RUST_BACKTRACE=full）", true)
  .argument("[args...]", "剩余参数（放在 -- 之后）")
  .action(async (args: string[], options: BuildOptions) => {
    options.args = args || [];
    await dev(options);
  });

// start 命令
program
  .command("start")
  .description("启动")
  .option(
    "-c, --component <component>",
    "要启动的组件：main | cli",
    Component.MAIN,
  )
  .option(
    "--mode <mode>",
    "构建模式：standard | light | android",
    Mode.STANDARD,
  )
  .option("--data <data>", "数据目录模式：dev | prod（默认 prod）")
  .option("--trace", "启用 Rust backtrace（设置 RUST_BACKTRACE=full）", false)
  .option(
    "--no-nx",
    "构建 main 前端时不经 nx（不读写 .nx 缓存，适合 Docker）",
  )
  .argument("[args...]", "剩余参数（放在 -- 之后）")
  .action(async (args: string[], options: BuildOptions) => {
    options.args = args || [];
    await start(options);
  });

// build 命令
program
  .command("build")
  .description("构建生产版本")
  .option(
    "-c, --component <component>",
    "要构建的组件：main | cli",
    "",
  )
  .option(
    "--skip <skip>",
    "跳过流程：vue | cargo（只能一个值）。main：--skip vue 不跑前端构建；--skip cargo 不跑 tauri/cargo（流水线可只验前端）",
    "",
  )
  .option(
    "--mode <mode>",
    "构建模式：standard | light | android",
    Mode.STANDARD,
  )
  .option("--data <data>", "数据目录模式：dev | prod（默认 prod）")
  .option(
    "--release",
    "构建完成后复制安装包到 release/ 目录，只有构建main获取全量的情况下才可用",
    false,
  )
  .option(
    "--no-nx",
    "构建 main 前端时不经 nx（不读写 .nx 缓存，适合 Docker）",
  )
  .argument("[args...]", "剩余参数（放在 -- 之后）")
  .action(async (args: string[], options: BuildOptions) => {
    options.args = args || [];
    await build(options);
  });

program
  .command("check")
  .description("检查类型与 Rust Cargo")
  .requiredOption(
    "-c, --component <component>",
    "要检查的组件：main | cli",
    Component.MAIN,
  )
  .option("--skip <skip>", "跳过检查项：vue/cargo（只能一个值）", "")
  .option(
    "--mode <mode>",
    "构建模式：standard | light | android",
    Mode.STANDARD,
  )
  .option("--data <data>", "数据目录模式：dev | prod（默认 prod）")
  .action(async (options: BuildOptions) => {
    await check(options);
  });

// 解析命令行参数
program.parse();
