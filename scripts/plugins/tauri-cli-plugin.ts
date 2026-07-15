import { BasePlugin } from "./base-plugin.ts";
import { BuildSystem } from "../build-system.ts";
import * as path from "path";
import { existsSync } from "fs";
import { ROOT, TARGET_DIR, run, platformExeExt } from "../utils.ts";
import { Component } from "./component-plugin.ts";

/**
 * TauriCliPlugin — 让所有 `cargo tauri` 调用命中 fork 的 CLI(tauri 上游 monorepo 的
 * crates/tauri-cli,挂载于 third/tauri submodule + third-patches/tauri),而非全局安装版。
 *
 * fork 相对上游 2.11.2 的差异(third-patches/tauri 的 tauri-cli 系列):Android 侧 Java 包
 *(源码目录 / 生成 Kotlin 包 / JNI)按 `TAURI_ANDROID_PACKAGE` env 解耦于 identifier
 *(applicationId),使 dev/prod 双 identifier 并存安装时源码树保持固定 `app.kabegame`;另含
 * `TAURI_NO_WEBKIT_DEPS`、`.icns` 留白、`android check` 子命令、真机 localhost devUrl。
 * 见 cocs/tauri/TAURI_CLI_FORK.md。先 `deno task patch tauri` 应用 series 再构建。
 */
export class TauriCliPlugin extends BasePlugin {
  static readonly NAME = "TauriCliPlugin";

  // crates/tauri-cli 的 manifest 位于 monorepo 内;构建产物落在 monorepo workspace 的
  // target/(third/tauri/target),而非子 crate 目录下。
  static readonly CLI_DIR = path.join(ROOT, "third", "tauri", "crates", "tauri-cli");
  // fork CLI 与主构建共用统一 target(TARGET_DIR,默认 ROOT/target,或 CARGO_TARGET_DIR)。
  // 注意:cargo 对 third/tauri 工作区的默认 target 是它自己的 third/tauri/target,
  // 所以 beforeBuild 必须**显式** `--target-dir TARGET_DIR` 才能落到根 target;BIN_DIR 随之。
  static readonly BIN_DIR = path.join(TARGET_DIR, "release");

  constructor() {
    super(TauriCliPlugin.NAME);
  }

  /**
   * 需要 fork CLI 的主组件流程：dev/build，或 android check
   *（后者走 `cargo tauri android check`，见 build-system check()）。
   * 桌面 check/test/cli 走裸 cargo，不需要 fork。
   */
  private needsTauriCli(bs: BuildSystem, comp?: string): boolean {
    const cmd = bs.context.cmd;
    const isAndroidCheck = !!cmd?.isCheck && !!bs.context.mode?.isAndroid;
    if (!cmd?.isDev && !cmd?.isBuild && !isAndroidCheck) return false;
    if (bs.context.mode?.isWeb) return false;
    if (bs.context.skip?.isCargo) return false;
    const component = comp ? new Component(comp) : bs.context.component!;
    return component.isMain;
  }

  apply(bs: BuildSystem): void {
    // fork bin 目录前置 PATH:cargo 解析 `cargo tauri` 子命令时优先命中 fork 的 cargo-tauri。
    bs.hooks.prepareEnv.tap(this.name, () => {
      this.setEnv(
        "PATH",
        TauriCliPlugin.BIN_DIR + path.delimiter + (process.env.PATH || ""),
      );
      // kabegame 全平台用 CEF 而非 WebKit:fork CLI 据此不向 Linux deb/rpm 注入
      // libwebkit2gtk 依赖(替代原 os-plugin 的 deb 后处理 strip)。仅 Linux 打包路径读取。
      this.setEnv("TAURI_NO_WEBKIT_DEPS", "1");
    });

    // 在主程序流程派生 tauri 之前确保 fork 已构建(cargo 增量,已最新时近似 no-op)。
    bs.hooks.beforeBuild.tap(this.name, (comp?: string) => {
      if (!this.needsTauriCli(bs, comp)) return;
      run(
        "cargo",
        [
          "build",
          "--release",
          "--manifest-path",
          path.join(TauriCliPlugin.CLI_DIR, "Cargo.toml"),
          // 显式统一到根 target(默认 ROOT/target,或 CARGO_TARGET_DIR),与主构建同处
          "--target-dir",
          TARGET_DIR,
        ],
        { cwd: ROOT },
      );
      const bin = path.join(
        TauriCliPlugin.BIN_DIR,
        `cargo-tauri${platformExeExt()}`,
      );
      if (!existsSync(bin)) {
        throw new Error(
          `fork 的 cargo-tauri 未产出: ${bin}\n请检查 third/tauri 子模块是否已初始化(git submodule update --init third/tauri)并已应用 patch(deno task patch tauri)`,
        );
      }
    });
  }
}
