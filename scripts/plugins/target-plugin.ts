import chalk from "chalk";
import { BasePlugin } from "./base-plugin.ts";
import { BuildSystem } from "../build-system.ts";
import {
  ARTIFACT_DIR,
  HOST_ARCH,
  IS_CROSS_COMPILE,
  ROOT,
  TARGET_ARCH,
  TARGET_TRIPLE,
} from "../utils.ts";
import path from "path";

/**
 * `--target x86_64|arm64`（仅 macOS）的校验与说明性日志。
 *
 * 解析本身在 utils.ts 完成（模块加载期就要定下 ARTIFACT_DIR / FFMPEG_INSTALL_DIR /
 * CEF_DIR_SUFFIX，早于任何插件运行），这里只负责"哪些命令/模式允许跨编"的门控，
 * 以及把实际落点打出来——跨编最危险的失败模式是静默用了另一架构的依赖或残留产物。
 */
export class TargetPlugin extends BasePlugin {
  static readonly NAME = "TargetPlugin";

  constructor() {
    super(TargetPlugin.NAME);
  }

  apply(bs: BuildSystem): void {
    bs.hooks.parseParams.tap(this.name, () => {
      if (!TARGET_ARCH) return;

      // utils.ts 已拦下非 macOS；这里只管 macOS 内部的模式/命令组合。
      if (bs.context.mode?.isAndroid || bs.context.mode?.isWeb) {
        throw new Error(
          "--target 只用于 macOS 桌面跨编；android 的 ABI 用 `-- --target aarch64` 传给 tauri，web 无原生产物",
        );
      }
      if (bs.context.cmd!.isDev) {
        throw new Error(
          "--target 不支持 dev：跨编产物无法在本机正常热重载调试。请用 build/check/start",
        );
      }

      this.log(
        chalk.cyan(
          `目标架构 ${TARGET_ARCH}（宿主 ${HOST_ARCH}${IS_CROSS_COMPILE ? "，跨编" : "，原生"}）` +
            `\n  triple:   ${TARGET_TRIPLE}` +
            `\n  产物目录: ${path.relative(ROOT, ARTIFACT_DIR)}`,
        ),
      );
    });
  }
}
