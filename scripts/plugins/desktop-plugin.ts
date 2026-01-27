import { OSPlugin } from "./os-plugin";
import { BasePlugin } from "./base-plugin";
import { BuildSystem } from "../build-system";

export class Desktop {
  static readonly PLASMA = "plasma";
  static readonly GNOME = "gnome";

  static readonly desktops = [this.PLASMA, this.GNOME];

  constructor(private _desktop: string) {}

  get desktop(): string {
    return this._desktop;
  }

  get isPlasma(): boolean {
    return this.desktop === Desktop.PLASMA;
  }

  get isGnome(): boolean {
    return this.desktop === Desktop.GNOME;
  }
}

/**
 * 解析组件 component，在上下文中添加
 * isMain、isPluginEditor 等布尔变量直接使用。
 */
export class DesktopPlugin extends BasePlugin {
  static readonly NAME = "DesktopPlugin";

  constructor() {
    super(DesktopPlugin.NAME);
  }

  apply(bs: BuildSystem): void {
    if (!OSPlugin.isLinux) {
      return;
    }
    bs.hooks.parseParams.tap(this.name, () => {
      if (!bs.context.component!.isMain) {
        return;
      }
      const desktop = bs.options.desktop;
      if (!desktop) {
        throw new Error(`请指定一个桌面！${Desktop.desktops}`);
      }
      if (!(Desktop.desktops as readonly string[]).includes(desktop)) {
        throw new Error(`不存在的组件名称，允许的列表：${Desktop.desktops}`);
      }
      this.log("Desktop: ", desktop);
      bs.context.desktop = new Desktop(desktop);
    });

    bs.hooks.prepareEnv.tap(this.name, () => {
      if (!bs.context.component!.isMain) {
        return;
      }
      this.setEnv("VITE_DESKTOP", bs.context.desktop!.desktop);
      this.addRustFlags(`--cfg desktop="${bs.context.desktop!.desktop}"`);
    });
  }
}
