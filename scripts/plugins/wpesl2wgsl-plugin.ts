import chalk from "chalk";
import path from "path";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import { BasePlugin } from "./base-plugin.ts";
import { BuildSystem } from "../build-system.ts";
import { ROOT, WPESL2WGSL_FE_WASM, WPESL2WGSL_WASM } from "../paths.ts";

/**
 * kabegame 桌面 standard 模式的命令（dev / start / build / check / test）不带 `--skip vue` 时，先把
 * `deno task build:wpesl2wgsl` 的产物拷进场景宿主；找不到产物只告警，宿主照常构建，场景壁纸退回预览图。
 * Android / Web 没有 WPE，不需要这份 wasm。
 */
export class Wpesl2wgslPlugin extends BasePlugin {
  static readonly NAME = "Wpesl2wgslPlugin";

  constructor() {
    super(Wpesl2wgslPlugin.NAME);
  }

  apply(bs: BuildSystem): void {
    bs.hooks.prepareEnv.tap(this.name, () => {
      const { component, mode, skip } = bs.context;
      if (!component?.isMain || skip?.isVue || !mode?.isStandard) return;
      this.syncWasm();
    });
  }

  private syncWasm(): void {
    const rel = (p: string) => path.relative(ROOT, p);
    if (!existsSync(WPESL2WGSL_WASM)) {
      this.log(
        chalk.yellow(
          `未找到 ${rel(WPESL2WGSL_WASM)}：场景壁纸会退回预览图。先运行 deno task build:wpesl2wgsl`,
        ),
      );
      return;
    }
    const bytes = readFileSync(WPESL2WGSL_WASM);
    // 内容相同就不重写，免得 dev 下 Vite 每次启动都收到一次文件变更
    if (existsSync(WPESL2WGSL_FE_WASM) && readFileSync(WPESL2WGSL_FE_WASM).equals(bytes)) {
      return;
    }
    mkdirSync(path.dirname(WPESL2WGSL_FE_WASM), { recursive: true });
    copyFileSync(WPESL2WGSL_WASM, WPESL2WGSL_FE_WASM);
    this.log(`复制 ${rel(WPESL2WGSL_WASM)} → ${rel(WPESL2WGSL_FE_WASM)}`);
  }
}
