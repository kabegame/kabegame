import { BuildSystem } from "scripts/build-system.js";
import { BasePlugin } from "./base-plugin.js";
import chalk from "chalk";
import { resolve } from "path";

export class Cmd {
  static readonly DEV = "dev";
  static readonly START = "start";
  static readonly BUILD = "build";
  static readonly CHECK = "check";

  static readonly ALL = [Cmd.DEV, Cmd.START, Cmd.BUILD, Cmd.CHECK];

  constructor(private cmd: string) {}

  get isDev(): boolean {
    return this.cmd === Cmd.DEV;
  }

  get isStart(): boolean {
    return this.cmd === Cmd.START;
  }

  get isBuild(): boolean {
    return this.cmd === Cmd.BUILD;
  }

  get isCheck(): boolean {
    return this.cmd === Cmd.CHECK;
  }
}

export class CmdPlugin extends BasePlugin {
  private readonly _cmd: Cmd;

  constructor(_cmd: string) {
    super("CmdPlugin");
    if (!Cmd.ALL.includes(_cmd)) {
      throw new Error(`未知的命令: ${_cmd}，允许的命令 ${Cmd.ALL.join(" | ")}`);
    }
    this._cmd = new Cmd(_cmd);
  }

  get cmd(): Cmd {
    return this._cmd;
  }

  apply(bs: BuildSystem): void {
    bs.hooks.prepareEnv.tap(this.name, () => {
      switch (true) {
        case this.cmd.isBuild: {
          this.addRustFlags("-Awarnings");
          break;
        }
        case this.cmd.isDev: {
          this.setEnv(
            "TAURI_DEV_WATCHER_IGNORE_FILE",
            resolve(bs.context.component!.appDir, ".taurignore"),
          );
          break;
        }
      }
    });
    bs.context.cmd = this.cmd;
  }
}
