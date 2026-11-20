import { BasePlugin } from "./base-plugin.ts";
import { BuildSystem } from "../build-system.ts";

export class DataMode {
  static readonly DEV = "dev";
  static readonly PROD = "prod";
  static readonly values = [DataMode.DEV, DataMode.PROD];
}

/**
 * 解析 --data dev|prod，控制数据目录模式。
 * dev：使用仓库本地 .kabegame/debug/{data,cache,tmp} 目录（所有不带 --release 的命令的默认值）。
 * prod：使用系统用户数据目录（只在带 --release 时成为默认值）。
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
      // 未显式指定时：--release 一律 prod，其余一律 dev。
      //
      // 这个默认值必须在同一个 cargo profile 下对所有命令一致：它经 build.rs 变成
      // `--cfg kabegame_data="dev|prod"`，值一变 kabegame / kabegame-core 的 build script 就
      // EnvVarChanged，两个 crate 连同 kabegame.exe / kabegame-cef-helper 全量重编重链。
      // 旧规则下 check / test / start 默认 prod 而 dev / build 默认 dev，它们共用 target/debug，
      // 于是「改代码 → check → dev」每一轮都要全量重编一次。
      const data = explicit ?? (bs.options.release ? DataMode.PROD : DataMode.DEV);
      bs.context.data = data;
    });

    bs.hooks.prepareEnv.tap(this.name, () => {
      this.setEnv("KABEGAME_DATA", bs.context.data!);
    });
  }
}
