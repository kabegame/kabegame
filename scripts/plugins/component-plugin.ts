import { BasePlugin } from "./base-plugin";
import { BuildSystem, SRC_FE_DIR, SRC_TAURI_DIR } from "../build-system";
import * as path from "path";
import {
  copyDokan2DllToTauriReleaseDirBestEffort,
  stageResourceBinary,
} from "../build-utils";
import { OSPlugin } from "./os-plugin";

// 组件对象
export class Component {
  static readonly MAIN = "main";
  static readonly PLUGIN_EDITOR = "plugin-editor";
  static readonly CLI = "cli";

  static readonly components = [this.MAIN, this.PLUGIN_EDITOR, this.CLI];

  constructor(private readonly _comp: string) {}

  get comp() {
    return this._comp;
  }

  get isMain(): boolean {
    return this.comp === Component.MAIN || this.isAll;
  }

  get isPluginEditor(): boolean {
    return this.comp === Component.PLUGIN_EDITOR || this.isAll;
  }

  get isCli(): boolean {
    return this.comp === Component.CLI || this.isAll;
  }

  get isAll(): boolean {
    return !this.comp;
  }

  static cargoComp(comp: string): string {
    return "kabegame-" + comp;
  }

  get cargoComp(): string {
    return Component.cargoComp(this.comp);
  }

  static appDir(cmp: string): string {
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

  static appFeDir(comp: string): string {
    return path.join(SRC_FE_DIR, comp);
  }

  get appDir(): string {
    return Component.appDir(this.comp);
  }

  get appFeDir(): string {
    return Component.appFeDir(this.comp);
  }
}

/**
 * 解析组件 component，在上下文中添加
 * isMain、isPluginEditor 等布尔变量直接使用。
 */
export class ComponentPlugin extends BasePlugin {
  static readonly NAME = "ComponentPlugin";

  private component?: Component;

  constructor() {
    super(ComponentPlugin.NAME);
  }

  apply(bs: BuildSystem): void {
    bs.hooks.parseParams.tap(this.name, () => {
      let component = bs.options.component || "";
      if (component && !Component.components.includes(component)) {
        throw new Error(
          `不存在的组件名称 ${component}，允许的列表：${Component.components}`,
        );
      }
      if (!component && !bs.context.cmd!.isBuild) {
        throw new Error(
          `非构建模式必须用 -c 指定一个组件：${Component.components}`,
        );
      }
      const comp = new Component(component);
      if (bs.context.cmd!.isDev && comp.isCli) {
        throw new Error(`当前 dev 不支持 cli ！cli请构建后测试运行`);
      }
      if (bs.context.cmd!.isStart && !comp.isCli) {
        throw new Error(`当前 start 只支持 cli！`);
      }
      this.component = comp;
      bs.context.component = comp;
    });

    bs.hooks.prepareEnv.tap(this.name, () => {
      this.setEnv("KABEGAME_COMPONENT", this.component?.comp || "");
    });

    if (bs.context.cmd!.isBuild) {
      // 无论平台，把这些二进制通通打包到resources里
      bs.hooks.beforeBuild.tap(this.name, (comp?: string) => {
        const component = comp ? new Component(comp) : this.component!;
        if (component.isMain) {
          stageResourceBinary(Component.cargoComp(Component.CLI));
          stageResourceBinary(Component.cargoComp(`${Component.CLI}w`));
          stageResourceBinary(Component.cargoComp(Component.PLUGIN_EDITOR));
        }
      });
    }
  }
}
