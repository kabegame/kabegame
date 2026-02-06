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
 * - dev/start 会先打包插件到 src-tauri/resources/plugins（确保资源存在）
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
  desktop?: string;
  android?: boolean;
  verbose?: boolean;
  trace?: boolean;
  skip?: string;
  args?: string[];
  release?: boolean;
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
    "构建模式：normal（一般版本，带商店源）或 local（无商店版本，仅本地源 + 预打包全部插件）",
    Mode.NORMAL,
  )
  .option(
    "--desktop <desktop>",
    "指定桌面环境：plasma | gnome（用于后端按桌面环境选择实现）",
  )
  .option("--android", "开发 Android 目标（仅 main，使用底部 Tab 布局等）")
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
    "构建模式：normal、local（仅影响插件预打包与内置列表）或 light（轻量模式，不使用 virtual-driver feature）",
    Mode.NORMAL,
  )
  .option(
    "--desktop <desktop>",
    "指定桌面环境：plasma | gnome（用于后端按桌面环境选择实现）",
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
    "要构建的组件：main | cli",
    "",
  )
  .option(
    "--skip <skip>",
    "跳过流程：vue/cargo（只能一个值；main 仅支持跳过 vue）",
    "",
  )
  .option(
    "--mode <mode>",
    "构建模式：normal（一般版本，带商店源）、local（无商店版本，无商店安装包）或 light（轻量模式，不使用 virtual-driver feature）",
    Mode.NORMAL,
  )
  .option(
    "--desktop <desktop>",
    "指定桌面环境：plasma | gnome（用于后端按桌面环境选择实现）",
  )
  .option("--android", "构建 Android 目标（仅 main，产出 APK/AAB）")
  .option(
    "--release",
    "构建完成后复制安装包到 release/ 目录，只有构建main获取全量的情况下才可用",
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
    "要检查的组件：main | cli",
    Component.MAIN,
  )
  .option("--skip <skip>", "跳过检查项：vue/cargo（只能一个值）", "")
  .option(
    "--mode <mode>",
    "构建模式：normal、local 或 light（影响 cfg 与前端环境变量）",
    Mode.NORMAL,
  )
  .option(
    "--desktop <desktop>",
    "指定桌面环境：plasma | gnome（用于后端按桌面环境选择实现）",
  )
  .action(async (options: BuildOptions) => {
    await check(options);
  });

// 解析命令行参数
program.parse();
