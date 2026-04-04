import { BuildSystem } from "../build-system.js";
import { BasePlugin } from "./base-plugin.js";
import { Component } from "./component-plugin.js";
import chalk from "chalk";

export class OSPlugin extends BasePlugin {
  constructor() {
    super("OSPlugin");
  }

  static get isLinux(): boolean {
    return process.platform === "linux" && !OSPlugin.isAndroid;
  }

  static get isWindows(): boolean {
    return process.platform === "win32" && !OSPlugin.isAndroid;
  }

  static get isMacOS(): boolean {
    return process.platform === "darwin" && !OSPlugin.isAndroid;
  }

  static get isUnix(): boolean {
    return (OSPlugin.isLinux || OSPlugin.isMacOS) && !OSPlugin.isAndroid;
  }

  static isAndroid: boolean = false;

  apply(bs: BuildSystem): void {
    bs.hooks.prepareCompileArgs.tap(
      this.name,
      // @ts-ignore
      (
        nullOrCompOrResult:
          | null
          | string
          | { comp: Component; features: string[]; args?: string[] },
      ) => {
        const args: string[] = [];
        
        // 处理 waterfall hook 的输入
        if (typeof nullOrCompOrResult === "object" && nullOrCompOrResult !== null && "comp" in nullOrCompOrResult) {
          // 前一个 hook 的返回值
          return {
            comp: nullOrCompOrResult.comp,
            features: nullOrCompOrResult.features || [],
            args: [...(nullOrCompOrResult.args || []), ...args],
          };
        }
        
        // 初始调用或字符串输入
        const comp =
          typeof nullOrCompOrResult === "string"
            ? new Component(nullOrCompOrResult)
            : bs.context.component!;
        
        return {
          comp,
          features: [],
          args,
        };
      },
    );
  }
}
