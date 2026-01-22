import { OSPlugin } from "./os-plugn";
import { BasePlugin } from "./base-plugin"


export class Desktop {
    static PLASMA = 'plasma';
    static GNOME = 'gnome';

    static desktops =  [this.PLASMA, this.GNOME]

    constructor(desktop) {
        this.desktop = desktop;
    }

    get isPlasma() {
        return this.desktop === Desktop.PLASMA
    }

    get isGnome() {
        return this.desktop === Desktop.GNOME
    } 
}

/**
 * 解析组件 component，在上下文中添加
 * isMain、isPluginEditor 等布尔变量直接使用。
 */
export class DesktopPlugin extends BasePlugin {
    static NAME = 'DesktopPlugin'
    constructor() {
        super(DesktopPlugin.NAME)
    }

    apply(bs) {
        if (!OSPlugin.isLinux) {
            return;
        }
        bs.hooks.parseParams.tap(this.name, () => {
            const desktop = bs.options.desktop;
            if (!desktop) {
                throw new Error(`请指定一个桌面！${Desktop.desktops}`)
            }
            if (desktop in Desktop.desktops) {
                throw new Error(`不存在的组件名称，允许的列表：${components}`)
            }
            this.log('Desktop: ', desktop);
            bs.context.desktop = new Desktop(desktop)
        })

        bs.hooks.prepareEnv.tap(this.name, () => {
            this.setEnv('VITE_DESKTOP', bs.context.desktop.desktop);
            this.addRustFlags(`--cfg desktop=${bs.context.desktop.desktop}`)
        })
    }
}