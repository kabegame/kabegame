import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { glob } from "glob";
import os from "os";
import { spawnSync } from "child_process";
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
    return `Kabegame_${version}_android-preview${ext}`;
  }
}

function findBundleDir(root: string): string | null {
  const p = OSPlugin.isAndroid ? path.join(root, "src-tauri", "kabegame", "gen", "android", "app", "build", "outputs", "apk", "universal", "release") 
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

function commandOutput(cmd: string, args: string[], cwd?: string): string {
  const res = spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
  });
  if (res.status !== 0) {
    const output = `${res.stdout ?? ""}${res.stderr ?? ""}`.trim();
    throw new Error(
      `${cmd} ${args.join(" ")} failed${output ? `:\n${output}` : ""}`,
    );
  }
  return `${res.stdout ?? ""}${res.stderr ?? ""}`;
}

// Linux 策略:fuser 关闭 `libfuse` feature 走纯 Rust 挂载,二进制**根本不链接** libfuse
// (挂载时懒执行 fusermount3,语义同 Windows delay-load dokan2.dll)。因此正常产物没有
// DT_NEEDED libfuse 条目;若误开 libfuse feature 导致动态依赖回归,此校验会拦下。
function assertNoLinuxLibfuseLink(debPath: string): void {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kabegame-deb-check-"));
  try {
    commandOutput("dpkg-deb", ["-x", debPath, tmpDir]);
    const binDir = path.join(tmpDir, "usr", "bin");
    const binaries = ["kabegame"]
      .map((name) => path.join(binDir, name))
      .filter((p) => fs.existsSync(p) && fs.statSync(p).isFile());

    for (const binary of binaries) {
      const dynamicSection = commandOutput("readelf", ["-d", binary]);
      const fuseNeeded = dynamicSection
        .split(/\r?\n/)
        .filter((line) => /NEEDED.*libfuse/i.test(line));
      if (fuseNeeded.length > 0) {
        throw new Error(
          [
            `Linux release binary must not link libfuse at all: ${path.relative(ROOT, debPath)}`,
            `binary: ${path.relative(tmpDir, binary)}`,
            ...fuseNeeded,
            "On Linux fuser must be built WITHOUT the `libfuse` feature (pure-rust mount); libfuse is never linked. Runtime mounting lazily execs fusermount3 (apt fuse3), like Windows delay-loads dokan2.dll.",
          ].join("\n"),
        );
      }
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
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

    // `bun b` 不再对直接 cargo build 的组件(kabegame-cli/cef-example/cef-helper)
    // 硬编 --release —— 默认 debug,只有传了 --release 时才在这里补上 cargo 的
    // --release 标志。main 组件桌面/android 走 `tauri build`,本身即恒定 release,
    // 不需要(也不认识)这个 cargo 标志。
    bs.hooks.prepareCompileArgs.tap(
      this.name,
      // @ts-ignore:waterfall 入参在这里已被前面的 tap(OSPlugin 等)归一化为对象
      (result: { comp: Component; features: string[]; args?: string[] }) => {
        const viaTauri = result.comp.isMain && !bs.context.mode?.isWeb;
        if (viaTauri) return result;
        return {
          ...result,
          args: [...(result.args || []), "--release"],
        };
      },
    );

    bs.hooks.afterBuild.tapPromise(this.name, async (comp: string) => {
      if (comp !== Component.MAIN) return;
      if (bs.context.skip?.isCargo) return;

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
        if (OSPlugin.isLinux && srcPath.endsWith(".deb")) {
          assertNoLinuxLibfuseLink(srcPath);
        }
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
