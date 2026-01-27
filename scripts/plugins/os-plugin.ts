import { BuildSystem } from "../build-system.js";
import { BasePlugin } from "./base-plugin.js";
import { Component } from "./component-plugin.js";
import chalk from "chalk";

export class OSPlugin extends BasePlugin {
  constructor() {
    super("OSPlugin");
  }

  static get isLinux(): boolean {
    return process.platform === "linux";
  }

  static get isWindows(): boolean {
    return process.platform === "win32";
  }

  static get isMacOS(): boolean {
    return process.platform === "darwin";
  }

  static get isUnix(): boolean {
    return OSPlugin.isLinux || OSPlugin.isMacOS;
  }

  apply(_bs: BuildSystem): void {
  }
}
