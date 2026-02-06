import { BasePlugin } from "./base-plugin";
import { BuildSystem } from "../build-system";
import { Component } from "./component-plugin";

/**
 * 解析 --android，在 dev/build -c main 时使用 Tauri Android 目标。
 * 设置 VITE_ANDROID / TAURI_PLATFORM，供前端与构建使用。
 */
export class AndroidPlugin extends BasePlugin {
  static readonly NAME = "AndroidPlugin";

  constructor() {
    super(AndroidPlugin.NAME);
  }

  apply(bs: BuildSystem): void {
    bs.hooks.parseParams.tap(this.name, () => {
      const isAndroid =
        bs.context.component!.isMain &&
        !!bs.options.android &&
        (bs.context.cmd!.isDev || bs.context.cmd!.isBuild);
      if (!!bs.options.android && !bs.context.component!.isMain) {
        throw new Error("--android 仅支持 main 组件");
      }
      if (!!bs.options.android && !(bs.context.cmd!.isDev || bs.context.cmd!.isBuild)) {
        throw new Error("--android 仅支持 dev 与 build 命令");
      }
      bs.context.isAndroid = isAndroid;
    });

    bs.hooks.prepareEnv.tap(this.name, () => {
      if (!bs.context.component!.isMain || !bs.context.isAndroid) {
        return;
      }
      this.setEnv("VITE_ANDROID", "true");
      this.setEnv("TAURI_PLATFORM", "android");
    });
  }
}
