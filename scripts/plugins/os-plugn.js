import { BasePlugin } from "./base-plugin"
import { Component } from "./component-plugin"

export class OSPlugin extends BasePlugin {

    static get isLinux() {
      return process.platform === 'linux'
    }
  
    static get isWindows() {
      return process.platform === 'win32'
    }
  
    static get isMacOS() {
      return process.platform === 'darwin'
    }
  
    static get isUnix() {
      return OSPlugin.isLinux || OSPlugin.isMacOS
    }

    apply(bs) {
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