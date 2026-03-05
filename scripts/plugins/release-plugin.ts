import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { glob } from "glob";
import { BasePlugin } from "./base-plugin";
import { BuildSystem } from "../build-system";
import { Component } from "./component-plugin";
import { OSPlugin } from "./os-plugin";
import { ensureDir, readCargoTomlVersion, run } from "../utils";
import { ROOT } from "../utils";

function walkFiles(dir: string): string[] {
  return glob.sync("**/*", {
    cwd: dir,
    absolute: true,
    nodir: true,
  });
}

function archForWindows(): string {
  if (process.arch === "x64") return "x64";
  if (process.arch === "arm64") return "arm64";
  return process.arch;
}

function archForDeb(): string {
  if (process.arch === "x64") return "amd64";
  if (process.arch === "arm64") return "arm64";
  return process.arch;
}

function archForMacOS(): string {
  if (process.arch === "x64") return "x64";
  if (process.arch === "arm64") return "aarch64";
  return process.arch;
}

function releaseAssetFileName(params: {
  mode: string;
  version: string;
  srcPath: string;
}): string {
  const { mode, version, srcPath } = params;
  const ext = path.extname(srcPath);
  if (OSPlugin.isWindows) {
    return `Kabegame-${mode}_${version}_${archForWindows()}-setup${ext}`;
  }
  if (OSPlugin.isLinux) {
    return `Kabegame-${mode}_${version}_${archForDeb()}${ext}`;
  }
  if (OSPlugin.isMacOS) {
    return `Kabegame-${mode}_${version}_${archForMacOS()}${ext}`;
  } else {
    return `Kabegame_${version}_android-${ext}`;
  }
}

function findBundleDir(root: string): string | null {
  const candidates = [
    path.join(root, "target", "release", "bundle"),
    ...(OSPlugin.isAndroid ? [path.join(root, "src-tauri", "app-main", "gen", "android", "app", "build", "outputs", "apk")] : []),
  ];
  const p = OSPlugin.isAndroid ? path.join(root, "src-tauri", "app-main", "gen", "android", "app", "build", "outputs", "apk") 
    : OSPlugin.isMacOS ? path.join(root, "target", "release", "bundle", "dmg")
    : OSPlugin.isWindows ? path.join(root, "target", "release", "bundle", "nsis")
    : OSPlugin.isLinux ? path.join(root, "target", "release", "bundle", "deb")
    : path.join(root, "target", "release", "bundle");
  try {
    if (fs.existsSync(p) && fs.statSync(p).isDirectory()) return p;
  } catch {
    // ignore
  }
  return null;
}

function pickBundleAssets(bundleDir: string, version: string): string[] {
  const files = walkFiles(bundleDir);
  if (OSPlugin.isWindows) {
    const arch = archForWindows().toLowerCase();
    const preferred = files.filter(
      (p) =>
        p.endsWith("-setup.exe") &&
        p.includes(`_${version}_`) &&
        p.includes(`_${arch}-setup.exe`),
    );
    if (preferred.length) return preferred;
    return files.filter((p) => p.endsWith("-setup.exe"));
  }
  if (OSPlugin.isLinux) {
    const preferred = files.filter(
      (p) => p.endsWith(".deb") && p.includes(`_${version}_`),
    );
    if (preferred.length) return preferred;
    return files.filter((p) => p.endsWith(".deb"));
  }
  if (OSPlugin.isMacOS) {
    return files.filter((p) => p.endsWith(".dmg"));
  }
  if (OSPlugin.isAndroid) {
    return files.filter((p) => p.endsWith(".apk"));
  }
  return [];
}

function isReleaseBuild(bs: BuildSystem): boolean {
  return Boolean(bs.context.cmd?.isBuild && bs.options.release);
}

export class ReleasePlugin extends BasePlugin {
  static readonly NAME = "ReleasePlugin";

  constructor() {
    super(ReleasePlugin.NAME);
  }

  apply(bs: BuildSystem): void {
    if (!isReleaseBuild(bs)) return;
    bs.hooks.prepareEnv.tap(this.name, () => {
      this.addRustFlags("-C codegen-units=1");
    });

    bs.hooks.afterBuild.tapPromise(this.name, async (comp: string) => {
      if (comp !== Component.MAIN) return;

      const mode = bs.context.mode!.mode;
      const version = readCargoTomlVersion();

      const bundleDir = findBundleDir(ROOT);
      if (!bundleDir) {
        throw new Error("找不到构建产物目录：target/release/bundle");
      }
      const assets = pickBundleAssets(bundleDir, version);
      if (!assets.length) {
        throw new Error(
          `未找到可复制的构建产物（bundleDir=${path.relative(ROOT, bundleDir)}）`,
        );
      }

      const releaseDir = path.join(ROOT, "release");
      ensureDir(releaseDir);
      for (const srcPath of assets) {
        const dstName = releaseAssetFileName({
          mode,
          version,
          srcPath,
        });
        const dstPath = path.join(releaseDir, dstName);
        fs.copyFileSync(srcPath, dstPath);
        this.log(
          `copied ${path.relative(ROOT, srcPath)} -> ${path.relative(
            ROOT,
            dstPath,
          )}`,
        );
      }
    });
  }
}
