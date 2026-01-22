import { BasePlugin } from "./base-plugin";
import { SRC_TAURI_DIR } from "../build-system";
import * as path from "path";
import {
  copyDokan2DllToTauriReleaseDirBestEffort,
  stageResourceBinary,
} from "../build-utils";
import { OSPlugin } from "./os-plugn";

// 组件对象
export class Component {
  static MAIN = "main";
  static PLUGIN_EDITOR = "plugin-editor";
  static CLI = "cli";

  static components = [this.MAIN, this.PLUGIN_EDITOR, this.CLI];

  constructor(comp) {
    this.comp = comp;
  }

  get isMain() {
    return this.comp === Component.MAIN || this.isAll;
  }

  get isPluginEditor() {
    return this.comp === Component.PLUGIN_EDITOR || this.isAll;
  }

  get isCli() {
    return this.comp === Component.CLI || this.isAll;
  }

  get isAll() {
    return !this.comp;
  }

  static cargoComp(comp) {
    return "kabegame-" + comp;
  }

  get cargoComp() {
    return Component.cargoComp(this.comp);
  }

  static appDir(cmp) {
    switch (cmp) {
      case this.MAIN: {
        return path.join(SRC_TAURI_DIR, "app-main");
      }
      case this.PLUGIN_EDITOR: {
        return path.join(SRC_TAURI_DIR, "app-plugin-editor");
      }
      case this.CLI: {
        return path.join(SRC_TAURI_DIR, "app-cli");
      }
      default: {
        throw new Error(`未知的app: ${cmp}`);
      }
    }
  }

  get appDir() {
    return Component.appDir(this.comp);
  }
}

/**
 * 解析组件 component，在上下文中添加
 * isMain、isPluginEditor 等布尔变量直接使用。
 */
export class ComponentPlugin extends BasePlugin {
  static NAME = "ComponentPlugin";

  constructor() {
    super(ComponentPlugin.NAME);
  }

  apply(bs) {
    bs.hooks.parseParams.tap(this.name, () => {
      let component = bs.options.component || "";
      if (component && (!component) in Component.components) {
        throw new Error(
          `不存在的组件名称，允许的列表：${Component.components}`,
        );
      }
      if (!component && !bs.cmd.isBuild) {
        throw new Error(
          `非构建模式必须用 -c 指定一个组件：${Component.components}`,
        );
      }
      component = new Component(component);
      if (bs.context.cmd.isDev && component.isCli) {
        throw new Error(`当前 dev 不支持 cli ！cli请构建后测试运行`);
      }
      if (bs.context.cmd.isStart && !component.isCli) {
        throw new Error(`当前 start 只支持 cli！`);
      }
      this.component = component;
      bs.context.component = component;
    });

    if (bs.context.cmd.isBuild) {
      // 无论平台，把这些二进制通通打包到resources里
      bs.hooks.beforeBuild.tap(this.name, (comp) => {
        comp = comp ? new Component(comp) : this.component;
        if (comp.isMain) {
          stageResourceBinary(Component.cargoComp(Component.CLI));
          stageResourceBinary(Component.cargoComp(`${Component.CLI}w`));
          stageResourceBinary(Component.cargoComp(Component.PLUGIN_EDITOR));
        }
      });
    }
  }
}
