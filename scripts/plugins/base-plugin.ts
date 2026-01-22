#!/usr/bin/env node

import chalk from "chalk";

/**
 * 插件基类
 * 所有插件都应该继承此类或实现相同的接口
 */

export class BasePlugin {
  constructor(protected name: string) {}

  log(...args: any[]): void {
    console.log(`[${chalk.blue(this.name)}]`, ...args);
  }

  /**
   * 插件应用（同步）
   */
  apply(buildSystem: any): void {
    throw new Error(`Plugin ${this.name} must implement apply method`);
  }

  /**
   * 获取插件名称
   */
  getName(): string {
    return this.name;
  }

  setEnv(env: string, value: string): void {
    process.env[env] = value;
    this.log(chalk.cyan(`set ${env}=${value}`));
  }

  addRustFlags(flag: string): void {
    const prev = process.env.RUSTFLAGS ? String(process.env.RUSTFLAGS) : "";
    process.env.RUSTFLAGS = prev ? `${prev} ${flag}` : flag;
    this.log(chalk.cyan(`RUSTFLAGS+=${flag}`));
  }
}
