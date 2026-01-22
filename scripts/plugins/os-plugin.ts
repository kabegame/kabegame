import { BasePlugin } from "./base-plugin.js"
import { Component } from "./component-plugin.js"
import chalk from "chalk";

export class OSPlugin extends BasePlugin {
    constructor() {
      super("OSPlugin")
    }

    static get isLinux(): boolean {
      return process.platform === 'linux'
    }

    static get isWindows(): boolean {
      return process.platform === 'win32'
    }

    static get isMacOS(): boolean {
      return process.platform === 'darwin'
    }

    static get isUnix(): boolean {
      return OSPlugin.isLinux || OSPlugin.isMacOS
    }

    apply(bs: any): void {
        if (OSPlugin.isLinux) {
            this.setEnv('WEBKIT_DISABLE_DMABUF_RENDERER', "1");
            this.log(
                chalk.yellow(
                `[env] WEBKIT_DISABLE_DMABUF_RENDERER=1 (Linux: 强制软件渲染以避免 DRM/KMS 权限问题)`
                )
            );
        }
    }
}  