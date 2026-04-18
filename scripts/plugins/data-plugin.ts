import { BasePlugin } from "./base-plugin";
import { BuildSystem } from "../build-system";

export class DataMode {
  static readonly DEV = "dev";
  static readonly PROD = "prod";
  static readonly values = [DataMode.DEV, DataMode.PROD];
}

/**
 * 解析 --data dev|prod，控制数据目录模式。
 * dev：使用仓库本地 data/ 和 cache/ 目录（默认用于 bun dev）。
 * prod：使用系统用户数据目录（默认用于 bun build / bun start / bun check）。
 * 对应 Rust cfg: kabegame_data="dev"|"prod"，由 build.rs 注入。
 */
export class DataPlugin extends BasePlugin {
  static readonly NAME = "DataPlugin";

  constructor() {
    super(DataPlugin.NAME);
  }

  apply(bs: BuildSystem): void {
    bs.hooks.parseParams.tap(this.name, () => {
      const explicit = bs.options.data;
      if (explicit && !DataMode.values.includes(explicit)) {
        throw new Error(`未知的 --data 值，允许的列表：${DataMode.values}`);
      }
      const data = explicit ?? (bs.context.cmd?.isDev ? DataMode.DEV : DataMode.PROD);
      bs.context.data = data;
    });

    bs.hooks.prepareEnv.tap(this.name, () => {
      this.setEnv("KABEGAME_DATA", bs.context.data!);
    });
  }
}
