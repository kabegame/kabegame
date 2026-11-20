import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { glob } from "glob";
import { BasePlugin } from "./base-plugin.ts";
import { BuildSystem } from "../build-system.ts";
import { Component } from "./component-plugin.ts";
import { OSPlugin } from "./os-plugin.ts";
import { ensureDir, platformExeExt, readCargoTomlVersion, run } from "../utils.ts";
import { ARTIFACT_DIR, RELEASE_DIR, ROOT } from "../utils.ts";

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

function osLabel(): string {
  if (OSPlugin.isWindows) return "windows";
  if (OSPlugin.isLinux) return "linux";
  if (OSPlugin.isMacOS) return "macos";
  return "unknown";
}

// kabegame-cli 是桌面原生 headless 二进制,直接取各平台惯用的 arch 记法,
// 与 GUI 安装包命名(archForWindows/Deb/MacOS)保持一致。
function cliArch(): string {
  if (OSPlugin.isWindows) return archForWindows();
  if (OSPlugin.isLinux) return archForDeb();
  if (OSPlugin.isMacOS) return archForMacOS();
  return process.arch;
}

// 形如 kabegame-cli-standard_1.2.3_windows_x64.exe / ..._linux_amd64 / ..._macos_aarch64
function cliReleaseAssetFileName(params: {
  mode: string;
  version: string;
  ext: string;
}): string {
  const { mode, version, ext } = params;
  return `kabegame-cli-${mode}_${version}_${osLabel()}_${cliArch()}${ext}`;
}

function findBundleDir(root: string): string | null {
  const p = OSPlugin.isAndroid ? path.join(root, "src-tauri", "kabegame", "gen", "android", "app", "build", "outputs", "apk", "universal", "release") 
    : OSPlugin.isMacOS ? path.join(ARTIFACT_DIR, "release", "bundle", "dmg")
    : OSPlugin.isWindows ? path.join(ARTIFACT_DIR, "release", "bundle", "nsis")
    : OSPlugin.isLinux ? path.join(ARTIFACT_DIR, "release", "bundle", "deb")
    : path.join(ARTIFACT_DIR, "release", "bundle");
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
      // 只有发版才付链接时间的代价。用 CARGO_PROFILE_RELEASE_* 覆盖 profile 而不是 RUSTFLAGS：
      // cargo 在非 LTO 构建里给依赖传 `-C embed-bitcode=no`，与 RUSTFLAGS 里的 `-C lto` 互斥
      // （直接编译失败），走 profile 才能让 cargo 把 bitcode 选项配对好。其余 release 配置
      // （opt-level / strip 等）在根 Cargo.toml 的 [profile.release]。
      this.setEnv("CARGO_PROFILE_RELEASE_CODEGEN_UNITS", "1");
      this.setEnv("CARGO_PROFILE_RELEASE_LTO", "thin");
    });

    // `deno task b` 不再对直接 cargo build 的组件(kabegame-cli)
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
      if (bs.context.skip?.isCargo) return;

      const mode = bs.context.mode!.mode;
      const version = readCargoTomlVersion();
      const releaseDir = RELEASE_DIR;

      // kabegame-cli:裸 cargo 产物,按系统/平台改名复制到 release/。
      // 只有桌面构建才有原生 CLI(android/web 不产出)。
      if (comp === Component.CLI) {
        if (bs.context.mode?.isAndroid || bs.context.mode?.isWeb) return;
        const ext = platformExeExt();
        const cliSrc = path.join(ARTIFACT_DIR, "release", `kabegame-cli${ext}`);
        if (!fs.existsSync(cliSrc)) {
          throw new Error(
            `找不到 kabegame-cli 构建产物：${path.relative(ROOT, cliSrc)}`,
          );
        }
        ensureDir(releaseDir);
        const dstName = cliReleaseAssetFileName({ mode, version, ext });
        const dstPath = path.join(releaseDir, dstName);
        fs.copyFileSync(cliSrc, dstPath);
        this.log(
          `copied ${path.relative(ROOT, cliSrc)} -> ${path.relative(
            ROOT,
            dstPath,
          )}`,
        );
        return;
      }

      if (comp !== Component.MAIN) return;

      // web 模式的主组件是裸 cargo 产物(单个 headless 二进制,无 tauri bundle),
      // --release 只用于给 cargo 补 --release 标志;产物由 docker compose 的
      // /dist 挂载直接落到 RELEASE_DIR,无需本 hook 再搬运。
      if (bs.context.mode?.isWeb) return;

      const bundleDir = findBundleDir(ROOT);
      if (!bundleDir) {
        throw new Error(
          `找不到构建产物目录：${path.relative(ROOT, path.join(ARTIFACT_DIR, "release", "bundle"))}`,
        );
      }
      const assets = pickBundleAssets(bundleDir, version);
      if (!assets.length) {
        throw new Error(
          `未找到可复制的构建产物（bundleDir=${path.relative(ROOT, bundleDir)}）`,
        );
      }

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
