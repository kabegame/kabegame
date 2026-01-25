import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { BasePlugin } from "./base-plugin";
import { BuildSystem } from "../build-system";
import { Component } from "./component-plugin";
import { OSPlugin } from "./os-plugin";
import { ensureDir, readCargoTomlVersion, run } from "../utils";
import { ROOT } from "../utils";

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  const stack: string[] = [dir];
  while (stack.length) {
    const cur = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const p = path.join(cur, ent.name);
      if (ent.isDirectory()) stack.push(p);
      else if (ent.isFile()) out.push(p);
    }
  }
  return out;
}

function readVersion(root: string): string {
  const packageJson = path.join(root, "package.json");
  const conf = JSON.parse(fs.readFileSync(packageJson, "utf-8")) as {
    version?: string;
  };
  const v = String(conf?.version ?? "").trim();
  if (!v) {
    throw new Error(`无法读取版本号: ${path.relative(root, packageJson)}`);
  }
  return v;
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

function releaseAssetFileName(params: {
  mode: string;
  desktop?: string;
  version: string;
  srcPath: string;
}): string {
  const { mode, desktop, version, srcPath } = params;
  const ext = path.extname(srcPath);
  if (process.platform === "win32") {
    return `Kabegame-${mode}_${version}_${archForWindows()}-setup${ext}`;
  }
  if (process.platform === "linux") {
    const desk = (desktop || "plasma").trim();
    return `Kabegame-${mode}_${desk}_${version}_${archForDeb()}${ext}`;
  }
  return path.basename(srcPath);
}

function findBundleDir(root: string): string | null {
  const candidates = [
    path.join(root, "src-tauri", "app-main", "target", "release", "bundle"),
    path.join(root, "src-tauri", "target", "release", "bundle"),
    path.join(root, "target", "release", "bundle"),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p) && fs.statSync(p).isDirectory()) return p;
    } catch {
      // ignore
    }
  }
  return null;
}

function pickBundleAssets(bundleDir: string, version: string): string[] {
  const files = walkFiles(bundleDir);
  if (process.platform === "win32") {
    const arch = archForWindows().toLowerCase();
    const preferred = files.filter(
      (p) =>
        p.toLowerCase().endsWith("-setup.exe") &&
        p.includes(`_${version}_`) &&
        p.toLowerCase().includes(`_${arch}-setup.exe`),
    );
    if (preferred.length) return preferred;
    return files.filter((p) => p.toLowerCase().endsWith("-setup.exe"));
  }
  if (process.platform === "linux") {
    const preferred = files.filter(
      (p) => p.toLowerCase().endsWith(".deb") && p.includes(`_${version}_`),
    );
    if (preferred.length) return preferred;
    return files.filter((p) => p.toLowerCase().endsWith(".deb"));
  }
  if (process.platform === "darwin") {
    return files.filter((p) => p.toLowerCase().endsWith(".dmg"));
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
      const desktop = OSPlugin.isLinux
        ? bs.context.desktop!.desktop
        : undefined;
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
          desktop,
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
