import { BuildSystem } from "../build-system.js";
import { BasePlugin } from "./base-plugin.js";

export class Cmd {
  static readonly DEV = "dev";
  static readonly START = "start";
  static readonly BUILD = "build";
  static readonly CHECK = "check";
  static readonly TEST = "test";

  static readonly ALL = [Cmd.DEV, Cmd.START, Cmd.BUILD, Cmd.CHECK, Cmd.TEST];

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

  get isTest(): boolean {
    return this.cmd === Cmd.TEST;
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
      if (this.cmd.isBuild) {
        this.addRustFlags("-Awarnings");
      }
    });
    bs.context.cmd = this.cmd;
  }
}
