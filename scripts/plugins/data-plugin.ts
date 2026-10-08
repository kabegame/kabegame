import { BasePlugin } from "./base-plugin.ts";
import { BuildSystem } from "../build-system.ts";

export class DataMode {
  static readonly DEV = "dev";
  static readonly PROD = "prod";
  static readonly values = [DataMode.DEV, DataMode.PROD];
}

/**
 * 解析 --data dev|prod，控制数据目录模式。
 * dev：使用仓库本地 .kabegame/debug/{data,cache,tmp} 目录（默认用于 deno task dev，以及不带 --release 的 deno task b）。
 * prod：使用系统用户数据目录（默认用于带 --release 的 deno task b，以及 deno task start / check / test）。
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
      const cmd = bs.context.cmd;
      // 未显式指定时：--release 一律 prod；否则 dev / build 默认 dev，其余命令默认 prod
      const data = explicit ?? (!bs.options.release && (cmd?.isDev || cmd?.isBuild) ? DataMode.DEV : DataMode.PROD);
      bs.context.data = data;
    });

    bs.hooks.prepareEnv.tap(this.name, () => {
      this.setEnv("KABEGAME_DATA", bs.context.data!);
    });
  }
}
