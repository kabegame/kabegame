#!/usr/bin/env node
/**
 * Unified entry for Kabegame workspace:
 * - 2 个前端应用（main / plugin-editor）分别跑在 1420 / 1421
 * - 3 个 Rust crate：app-main / app-plugin-editor / cli，共用 kabegame-core
 *
 * 用法（PowerShell）：
 * - pnpm dev -c main
 * - pnpm dev -c plugin-editor
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
import { BuildSystem } from "./build-system.js";

export class Cmd {
  static readonly DEV = "dev";
  static readonly START = "start";
  static readonly BUILD = "build";

  constructor(private cmd: string) {}

  get isDev(): boolean {
    return this.cmd === Cmd.DEV;
  }

  get isStart(): boolean {
    return this.cmd === Cmd.START;
  }

  get isBuild(): boolean {
    return this.cmd === Cmd.BUILD;
  }
}

// 保留对 run.js 中仍使用的函数的引用（dev/start 命令）
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const buildSystem = new BuildSystem();

interface BuildOptions {
  component?: string;
  mode?: string;
  desktop?: string;
  verbose?: boolean;
  trace?: boolean;
  args?: string[];
}

/**
 * 构建命令的固定执行流程
 */
async function build(options: BuildOptions): Promise<void> {
  buildSystem.build(options);
}

/**
 * dev 命令的固定执行流程
 */
async function dev(options: BuildOptions): Promise<void> {
  buildSystem.dev(options);
}

/**
 * start 命令的固定执行流程
 */
async function start(options: BuildOptions): Promise<void> {
  buildSystem.start(options);
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
    "要启动的组件：main | plugin-editor",
  )
  .option(
    "--mode <mode>",
    "构建模式：normal（一般版本，带商店源）或 local（无商店版本，仅本地源 + 预打包全部插件）",
    "normal",
  )
  .option(
    "--desktop <desktop>",
    "指定桌面环境：plasma | gnome（用于后端按桌面环境选择实现）",
  )
  .option("--verbose", "显示详细输出", false)
  .option("--trace", "启用 Rust backtrace（设置 RUST_BACKTRACE=full）", false)
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
    "要启动的组件：main | plugin-editor | cli",
    "main",
  )
  .option(
    "--mode <mode>",
    "构建模式：normal、local（仅影响插件预打包与内置列表）或 light（轻量模式，不使用 virtual-driver feature）",
    "normal",
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
    "要构建的组件：main | plugin-editor | cli",
    "",
  )
  .option(
    "--mode <mode>",
    "构建模式：normal（一般版本，带商店源）、local（无商店版本，无商店安装包）或 light（轻量模式，不使用 virtual-driver feature）",
    "normal",
  )
  .option(
    "--desktop <desktop>",
    "指定桌面环境：plasma | gnome（用于后端按桌面环境选择实现）",
  )
  .argument("[args...]", "剩余参数（放在 -- 之后）")
  .action(async (args: string[], options: BuildOptions) => {
    options.args = args || [];
    await build(options);
  });

// 解析命令行参数
program.parse();
