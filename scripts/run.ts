#!/usr/bin/env -S deno run -A
/**
 * Unified entry for Kabegame workspace:
 * - 1 个前端应用（kabegame）跑在 1420
 * - 2 个 Rust crate：kabegame / kabegame-cli，共用 kabegame-core
 *
 * 用法：
 * - deno task dev -c kabegame
 * - deno task b                       （默认构建全部：kabegame + kabegame-cli）
 * - deno task b -c kabegame|kabegame-cli
 *
 * 说明：
 * - deno task dev -c kabegame 时由构建链打包爬虫插件到 .kabegame/debug/data/plugins-directory，不写入 app resources
 * - kabegame 的前端由各自 tauri.conf.json 的 beforeDev/BuildCommand 触发
 */

import { Command } from "commander";
import { BuildSystem } from "./build-system.ts";
import { Component } from "./plugins/component-plugin.ts";
import { Mode } from "./plugins/mode-plugin.ts";

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
  package?: string;
  test?: string;
  target?: string;
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

async function test(options: BuildOptions): Promise<void> {
  await buildSystem.test(options);
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
    "要启动的组件：kabegame",
    Component.MAIN,
  )
  .option(
    "--mode <mode>",
    "构建模式：standard | android",
    Mode.STANDARD,
  )
  .option("--data <data>", "数据目录模式：dev | prod（默认 dev）")
  // dev 不支持跨编。这里仍然声明该选项，是为了让 TargetPlugin 给出"为什么不行"的
  // 解释，而不是让 commander 抛 `unknown option '--target' (Did you mean --trace?)`。
  .option("--target <arch>", "（dev 不支持跨编，见 build 命令的同名选项）")
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
    "要启动的组件：kabegame | kabegame-cli",
    Component.MAIN,
  )
  .option(
    "--mode <mode>",
    "构建模式：standard | android",
    Mode.STANDARD,
  )
  .option("--data <data>", "数据目录模式：dev | prod（默认 prod）")
  .option(
    "--target <arch>",
    "目标架构（仅 macOS）：x86_64 | arm64。见 build 命令的同名选项",
  )
  .option("--trace", "启用 Rust backtrace（设置 RUST_BACKTRACE=full）", false)
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
    "要构建的组件：kabegame | kabegame-cli",
    "",
  )
  .option(
    "--skip <skip>",
    "跳过流程：vue | cargo（只能一个值）。kabegame：--skip vue 不跑前端构建；--skip cargo 不跑 tauri/cargo（流水线可只验前端）",
    "",
  )
  .option(
    "--mode <mode>",
    "构建模式：standard | android",
    Mode.STANDARD,
  )
  .option("--data <data>", "数据目录模式：dev | prod（默认 prod）")
  .option(
    "--target <arch>",
    "目标架构（仅 macOS）：x86_64 | arm64。用于在一台 Mac 上跨编另一架构；" +
      "产物落 target/<triple>/，FFmpeg/CEF 依赖按架构隔离取用。不传则按宿主原生构建",
  )
  .option(
    "--release",
    "构建完成后复制安装包到 release/ 目录，只有构建 kabegame 获取全量的情况下才可用",
    false,
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
    "要检查的组件：kabegame | kabegame-cli",
    Component.MAIN,
  )
  .option("--skip <skip>", "跳过检查项：vue/cargo（只能一个值）", "")
  .option(
    "--mode <mode>",
    "构建模式：standard | android",
    Mode.STANDARD,
  )
  .option("--data <data>", "数据目录模式：dev | prod（默认 prod）")
  .option(
    "--target <arch>",
    "目标架构（仅 macOS）：x86_64 | arm64。见 build 命令的同名选项",
  )
  .action(async (options: BuildOptions) => {
    await check(options);
  });

program
  .command("test")
  .description("运行 Rust 测试（自动准备 Kabegame/FFmpeg 环境变量）")
  .requiredOption(
    "-c, --component <component>",
    "用于准备环境的组件：kabegame | kabegame-cli",
    Component.MAIN,
  )
  .option("--package <package>", "Cargo package", "kabegame-core")
  .option("--test <testName>", "Cargo integration test target")
  .option(
    "--mode <mode>",
    "构建模式：standard",
    Mode.STANDARD,
  )
  .option("--data <data>", "数据目录模式：dev | prod（默认 prod）")
  .argument("[args...]", "剩余测试参数（传给 cargo test 的 -- 之后）")
  .action(async (args: string[], options: BuildOptions) => {
    options.args = args || [];
    await test(options);
  });

// 解析命令行参数
program.parse();
