import chalk from "chalk";
import path from "path";
import { cpSync, existsSync, readFileSync, rmSync } from "fs";
import { BasePlugin } from "./base-plugin.ts";
import { OSPlugin } from "./os-plugin.ts";
import { BuildSystem } from "../build-system.ts";
import { PLASMA_WALLPAPER_PACKAGE, ROOT, TARGET_DIR } from "../paths.ts";
import { RESOURCES_DIR } from "../utils.ts";

/** 插件包在 resources 下的目录名，与 `src-tauri/kabegame/src/wallpaper/manager/plasma/install.rs` 的 `BUNDLED_DIR_NAME` 一致。 */
const BUNDLED_DIR_NAME = "plasma-wallpaper";

/**
 * Linux 桌面 standard 模式的 kabegame dev / build：把 `deno task build:plasma-plugin` 拼好的 KPackage 拷进应用的
 * `resources/plasma-wallpaper/org.kabegame.wallpaper`，应用切到插件模式时从这里装进用户目录。找不到产物只告警（插件模式
 * 只能用已经装好的插件）。写法同 WpeSceneHostPlugin：
 * - dev：直接写进 `<target>/debug/resources/plasma-wallpaper`（不经 tauri-build 复制、不让主 crate 重编），并删掉
 *   `src-tauri/kabegame/resources/plasma-wallpaper` 里上次 prod 构建留下的，免得 build.rs 重跑时把它复制过来盖掉；
 * - build：写进 `src-tauri/kabegame/resources/plasma-wallpaper`（已 gitignore），随 `resources/**\/*` 打进 deb。
 * 其它平台与 Android 删掉 prod 残留（Android 会把 resources 整个注入 APK）。
 */
export class PlasmaWallpaperPlugin extends BasePlugin {
  static readonly NAME = "PlasmaWallpaperPlugin";

  constructor() {
    super(PlasmaWallpaperPlugin.NAME);
  }

  apply(bs: BuildSystem): void {
    bs.hooks.prepareEnv.tap(this.name, () => {
      const { component, cmd, mode } = bs.context;
      if (!component?.isMain) return;
      if (!OSPlugin.isLinux || !mode?.isStandard) {
        this.removeStaleResources();
        return;
      }
      if (cmd.isDev) {
        this.removeStaleResources();
        this.copyInto(path.join(TARGET_DIR, "debug", "resources", BUNDLED_DIR_NAME));
      } else if (cmd.isBuild) {
        this.copyInto(path.join(RESOURCES_DIR, BUNDLED_DIR_NAME));
      }
    });
  }

  private removeStaleResources(): void {
    const stale = path.join(RESOURCES_DIR, BUNDLED_DIR_NAME);
    if (existsSync(stale)) {
      rmSync(stale, { recursive: true, force: true });
      this.log(`删除上次 prod 构建留下的 ${path.relative(ROOT, stale)}`);
    }
  }

  private copyInto(outDir: string): void {
    const rel = (p: string) => path.relative(ROOT, p);
    const metadata = path.join(PLASMA_WALLPAPER_PACKAGE, "metadata.json");
    if (!existsSync(metadata)) {
      this.log(
        chalk.yellow(
          `未找到 ${rel(PLASMA_WALLPAPER_PACKAGE)}：插件模式只能用已经装好的 Plasma 壁纸插件，先运行 deno task build:plasma-plugin`,
        ),
      );
      return;
    }
    const target = path.join(outDir, path.basename(PLASMA_WALLPAPER_PACKAGE));
    // 同一个修订号就不重拷（dev 每次启动都会走到这里）
    const targetMetadata = path.join(target, "metadata.json");
    if (existsSync(targetMetadata) && readFileSync(targetMetadata).equals(readFileSync(metadata))) return;
    rmSync(outDir, { recursive: true, force: true });
    cpSync(PLASMA_WALLPAPER_PACKAGE, target, { recursive: true });
    this.log(`复制 ${rel(PLASMA_WALLPAPER_PACKAGE)} → ${rel(target)}`);
  }
}
