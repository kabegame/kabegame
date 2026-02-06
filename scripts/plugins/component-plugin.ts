import { BasePlugin } from "./base-plugin";
import { BuildSystem, SRC_FE_DIR, SRC_TAURI_DIR } from "../build-system";
import * as path from "path";
import {
  RESOURCES_DIR,
  stageResourceBinary,
} from "../utils";
import { OSPlugin } from "./os-plugin";
import { readdirSync, statSync, unlinkSync, existsSync, readFileSync, writeFileSync } from "fs";
import Handlebars from "handlebars";

// 组件对象
export class Component {
  static readonly MAIN = "main";
  static readonly CLI = "cli";

  static readonly components = [this.MAIN, this.CLI];

  constructor(private readonly _comp: string) {}

  get comp() {
    return this._comp;
  }

  get isMain(): boolean {
    return this.comp === Component.MAIN || this.isAll;
  }

  get isCli(): boolean {
    return this.comp === Component.CLI || this.isAll;
  }

  get isAll(): boolean {
    return !this.comp;
  }

  static cargoComp(comp: string): string {
    return comp === Component.MAIN ? "kabegame" : "kabegame-" + comp;
  }

  get cargoComp(): string {
    return Component.cargoComp(this.comp);
  }

  static appDir(cmp: string): string {
    switch (cmp) {
      case this.MAIN: {
        return path.join(SRC_TAURI_DIR, "app-main");
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
      // if (bs.context.cmd!.isStart && comp.isPluginEditor) {
      //   throw new Error(`当前 start 不支持 p`);
      // }
      this.component = comp;
      bs.context.component = comp;
    });

    bs.hooks.prepareEnv.tap(this.name, () => {
      this.setEnv("KABEGAME_COMPONENT", this.component?.comp || "");
      if (bs.context.cmd!.isDev && this.component && !this.component.isCli) {
        this.setEnv(
          "TAURI_CLI_WATCHER_IGNORE_FILENAME",
          `${this.component.comp}.taurignore`,
        );
      }
    });

    bs.hooks.beforeBuild.tap(this.name, (comp?: string) => {
      const component = comp ? new Component(comp) : this.component!;
        // 编译可能存在的handlebars覆盖 tauri.config.json
        const tauriConfigHandlebars = path.resolve(component.appDir, 'tauri.conf.json.handlebars');
        this.log(`tauriConfigHandlebars: ${tauriConfigHandlebars}`);
        if (existsSync(tauriConfigHandlebars)) {
          const tauriConfig = path.resolve(component.appDir, "tauri.conf.json");
          const template = Handlebars.compile(
            readFileSync(tauriConfigHandlebars, {
              encoding: "utf-8",
            }).toString(),
          );
          writeFileSync(
            tauriConfig,
            template({
              // TODO: 当需要更多环境的时候维护这个上下文
              isWindows: OSPlugin.isWindows,
              isMacOS: OSPlugin.isMacOS,
              isLinux: OSPlugin.isLinux,
              isLight: bs.context.mode!.isLight,
              isDev: bs.context.cmd!.isDev,
              isAndroid: !!bs.context.isAndroid,
            }),
          );
        }
    });

    if (bs.context.cmd!.isBuild) {
      bs.hooks.beforeBuild.tap(this.name, (comp?: string) => {
        this.setEnv("KABEGAME_COMPONENT", this.component?.comp || comp || "");
        const component = comp ? new Component(comp) : this.component!;
        if (component.isMain) {
          // 先清空 resources 下所有非.gitkeep（保留文件夹）
          // TODO: 直接清除所有文件
          const resourcesDir = path.join(RESOURCES_DIR);
          const files = readdirSync(resourcesDir, {
            recursive: true,
          }) as string[];
          for (const file of files) {
            const stat = statSync(path.join(resourcesDir, file));
            if (!file.endsWith(".gitkeep") && stat.isFile()) {
              unlinkSync(path.join(resourcesDir, file));
              this.log(`删除文件 ${file}`);
            }
          }
        }
        // linux 不需要（MacOS暂时未定）
        if (
          component.isMain &&
          !bs.context.mode!.isLight &&
          !OSPlugin.isLinux
        ) {
          stageResourceBinary(Component.cargoComp(Component.CLI));
        }
      });
    }
  }
}
