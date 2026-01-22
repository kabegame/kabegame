#!/usr/bin/env node
/**
 * 参数解析插件
 * 负责解析和验证命令行参数，并更新构建上下文
 */

import { BasePlugin } from "./base-plugin.js";
import chalk from "chalk";
import { parseComponent } from "../build-utils.js";

/**
 * 组件解析插件
 * 解析并验证组件参数，更新上下文中的 component
 */
export class ComponentParsePlugin extends BasePlugin {
  constructor() {
    super("ComponentParsePlugin");
  }

  apply(buildSystem) {
    buildSystem.hooks.parseParams.tap(this.name, (context, rawOptions) => {
      const rawComponent = rawOptions.component || "all";
      const component = parseComponent(rawComponent);
      
      if (component === "unknown") {
        console.error(
          chalk.red(
            `❌ 参数错误：无效的组件: ${String(rawComponent)}\n` +
              `支持的组件: main, plugin-editor, cli, daemon, all`
          )
        );
        process.exit(1);
      }

      context.component = component;
      console.log(chalk.cyan(`[parse] 组件: ${component}`));
    });
  }
}

/**
 * Desktop 解析插件
 * 解析并验证桌面环境参数
 */
export class DesktopParsePlugin extends BasePlugin {
  constructor() {
    super("DesktopParsePlugin");
  }

  apply(buildSystem) {
    buildSystem.hooks.parseParams.tap(this.name, (context, rawOptions) => {
      const desktop = rawOptions.desktop ? String(rawOptions.desktop).toLowerCase() : null;
      
      if (desktop) {
        const validDesktops = ["plasma", "gnome"];
        if (!validDesktops.includes(desktop)) {
          console.error(
            chalk.red(
              `❌ 无效的桌面环境选项: ${desktop}\n` +
                `支持的选项: ${validDesktops.join(", ")}`
            )
          );
          process.exit(1);
        }
        context.desktop = desktop;
        console.log(chalk.cyan(`[parse] 桌面环境: ${desktop}`));
      } else {
        context.desktop = null;
      }
    });
  }
}

/**
 * Mode 解析插件
 * 解析并验证构建模式参数
 */
export class ModeParsePlugin extends BasePlugin {
  constructor() {
    super("ModeParsePlugin");
  }

  apply(buildSystem) {
    buildSystem.hooks.parseParams.tap(this.name, (context, rawOptions) => {
      const mode = rawOptions.mode || "normal";
      
      if (mode !== "normal" && mode !== "local" && mode !== "light") {
        console.error(
          chalk.red(
            `❌ 参数错误：--mode 必须是 "normal"、"local" 或 "light"，当前值: ${mode}`
          )
        );
        process.exit(1);
      }

      context.mode = mode;
      console.log(chalk.cyan(`[parse] 构建模式: ${mode}`));
    });
  }
}

/**
 * OS 检测插件
 * 自动检测操作系统并设置到上下文
 */
export class OSParsePlugin extends BasePlugin {
  constructor() {
    super("OSParsePlugin");
  }

  apply(buildSystem) {
    buildSystem.hooks.parseParams.tap(this.name, (context) => {
      const platform = process.platform;
      context.os = {
        platform,
        isWindows: platform === "win32",
        isLinux: platform === "linux",
        isMacOS: platform === "darwin",
        isAndroid: platform === "android",
      };
      console.log(chalk.cyan(`[parse] 操作系统: ${platform}`));
    });
  }
}

/**
 * Trace 解析插件
 * 解析 trace 选项，用于设置 RUST_BACKTRACE
 */
export class TraceParsePlugin extends BasePlugin {
  constructor() {
    super("TraceParsePlugin");
  }

  apply(buildSystem) {
    buildSystem.hooks.parseParams.tap(this.name, (context, rawOptions) => {
      context.trace = rawOptions.trace === true || rawOptions.trace === "true";
      if (context.trace) {
        console.log(chalk.cyan(`[parse] 启用 Rust backtrace`));
      }
    });
  }
}

/**
 * 其他选项解析插件
 * 解析其他命令行选项
 */
export class OptionsParsePlugin extends BasePlugin {
  constructor() {
    super("OptionsParsePlugin");
  }

  apply(buildSystem) {
    buildSystem.hooks.parseParams.tap(this.name, (context, rawOptions) => {
      // 复制其他选项到上下文
      context.options = {
        ...rawOptions,
        skipPluginsPackaging: (process.env.KABEGAME_SKIP_PLUGINS_PACKAGING ?? "").trim() === "1",
      };
    });
  }
}
