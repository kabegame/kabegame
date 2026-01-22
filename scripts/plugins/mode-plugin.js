import { scanBuiltinPlugins } from "../build-utils";
import { BasePlugin } from "./base-plugin"
import { run } from "../build-utils";
import { Component, ComponentPlugin } from "./component-plugin";
import chalk from "chalk";

export class Mode {
    static NORMAL = 'normal';
    static LOCAL = 'local';
    static LIGHT = 'light';

    static modes = [this.NORMAL, this.LOCAL, this.LIGHT];
    constructor(mode) {
        this.mode = mode;
    }

    get isNormal() {
        return this.mode === Mode.NORMAL
    }

    get isLocal() {
        return this.mode === Mode.LOCAL
    }

    get isLight() {
        return this.mode === Mode.LIGHT
    }
}

/**
 * 解析组件 component，在上下文中添加
 * isMain、isPluginEditor 等布尔变量直接使用。
 */
export class ModePlugin extends BasePlugin {
    static NAME = 'ModePlugin'

    constructor() {
        super(ModePlugin.NAME)
        this.mode = null;
    }

    apply(bs) {
        bs.hooks.parseParams.tap({
            name: this.name,
            after: ComponentPlugin.NAME
        }, () => {
            let mode = bs.options.mode || Mode.NORMAL;
            if (!mode in Mode.modes) {
                throw new Error(`未知的模式，允许的列表：${Mode.modes}`);
            }
            mode = new Mode(mode)
            if (mode.isLight && !bs.context.component.isMain) {
                throw new Error('light mode 只支持main组件！')
            }
            bs.context.mode = mode;
            this.mode = mode;
        })

        bs.hooks.prepareEnv.tap(this.name, () => {
            const builtinPlugins = !this.mode.isNormal ? scanBuiltinPlugins() : [];
            this.setEnv('WEBKIT_DISABLE_DMABUF_RENDERER', builtinPlugins.join(','));
            this.setEnv('KABEGAME_MODE', this.mode.mode);
            this.setEnv('VITE_KABEGAME_MODE', this.mode.mode);
        })

        bs.hooks.beforeBuild.tap(this.name, () => {
            this.packagePlugins(bs)
        })

        //TODO: 虚拟盘仅在非安卓并且为非light情况下才注入
        // 可能传入一个参数数组，或者一个component枚举值，或者什么都没有
        bs.hooks.prepareFeatures.tap(this.name, (nullOrCompOrFeatures) => {
            // self-hosted && vd (local) | self-hosted && !vd (light) | !self-hosted && vd (normal)  
            const mode = this.mode;
            const features = Array.isArray(nullOrCompOrFeatures) ? nullOrCompOrFeatures : []; 
            const comp = nullOrCompOrFeatures 
                ? typeof nullOrCompOrFeatures === 'string' 
                    ? new Component(nullOrCompOrFeatures) 
                    : nullOrCompOrFeatures['comp'] 
                : bs.context.component 
            if (mode.isNormal) {
                features.push('virtual-driver')
            } else if (mode.isLocal) {
                features.push('virtual-dirver', 'self-hosted')
            } else if (mode.isLight) {
                features.push('self-hosted')
            }
            return {
                comp,
                features,
            };
        })

        // TODO: 对不同的mode执行不同的tap
    }

    // 打包rhai插件，虽然这不是异步函数
    packagePlugins(bs) {
        this.log("package plugins")
        const cmd = bs.context.cmd;
        const mode = bs.context.mode;
        const comp = bs.context.component;
        this.log(cmd, cmd.isDev, cmd.isBuild)
        if (cmd.isDev) {
            const packageTarget =
            mode.isLocal
              ? "crawler-plugins:package-local-to-data"
              : "crawler-plugins:package-to-data";
            this.log(chalk.blue(`打包插件到开发目录: ${packageTarget}`));
            run("nx", ["run", packageTarget], {
                bin: 'bun'
            });
        } else if (cmd.isBuild) {
            if (!comp.isMain) {
                return;
            }
            const packageTarget =
            mode.isLocal
                ? "crawler-plugins:package-local-to-resources"
                : "crawler-plugins:package-to-resources";
            this.log(chalk.blue(`打包插件到资源: ${packageTarget}`));
            run("nx", ["run", packageTarget], {
                bin: 'bun'
            });
        }
        // start 命令不打包插件
    }
}