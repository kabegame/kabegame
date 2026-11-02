import path from "path";
import { existsSync, rmSync } from "fs";
import { BasePlugin } from "./base-plugin.ts";
import { BuildSystem } from "../build-system.ts";
import { ROOT, TARGET_DIR } from "../paths.ts";
import { RESOURCES_DIR, run } from "../utils.ts";

/** 宿主在 resources 下的目录名，与 `src-tauri/kabegame/src/wallpaper/wpe_scene_host.rs` 的 `SCENE_HOST_DIR_NAME` 一致。 */
const SCENE_HOST_DIR_NAME = "wpe-scene";
const SCENE_HOST_APP_DIR = path.join(ROOT, "apps", "wpe-scene");

/**
 * 场景宿主（`apps/wpe-scene`，P3-0）：kabegame 桌面 standard 模式的 dev / build（不带 `--skip vue`）先构建宿主。
 *
 * 应用从 `<exe 目录>/resources/wpe-scene/index.html` 加载它（`AppPaths.resource_dir`）。tauri-build 只在 build.rs
 * 重跑时把 `src-tauri/kabegame/resources/**` 复制进 `target/<profile>/resources`，且 resources 目录有变化就会让
 * build.rs 重跑、主 crate 重编、dev 重启应用，所以两种命令分开放：
 * - dev：直接写进 `<target>/debug/resources/wpe-scene`（vite.config.ts 的默认值），改宿主后
 *   `deno task --cwd apps/wpe-scene build` 即生效，不碰 Rust；同时删掉 `src-tauri/kabegame/resources/wpe-scene`
 *   里上次 prod 构建留下的产物，免得 build.rs 重跑时把它复制过来盖掉 dev 产物。
 * - build：写进 `src-tauri/kabegame/resources/wpe-scene`（已 gitignore），随 tauri.conf.json 的 `resources/**\/*`
 *   打进安装包，安装后同样位于 exe 旁的 `resources/wpe-scene`。
 */
export class WpeSceneHostPlugin extends BasePlugin {
  static readonly NAME = "WpeSceneHostPlugin";

  constructor() {
    super(WpeSceneHostPlugin.NAME);
  }

  apply(bs: BuildSystem): void {
    bs.hooks.prepareEnv.tap(this.name, () => {
      const { component, cmd, mode, skip } = bs.context;
      if (!component?.isMain || skip?.isVue) return;
      if (mode?.isAndroid || mode?.isWeb) return;
      if (cmd.isDev) this.buildForDev();
      else if (cmd.isBuild) this.buildInto(path.join(RESOURCES_DIR, SCENE_HOST_DIR_NAME));
    });
  }

  private buildForDev(): void {
    const stale = path.join(RESOURCES_DIR, SCENE_HOST_DIR_NAME);
    if (existsSync(stale)) {
      rmSync(stale, { recursive: true, force: true });
      this.log(`删除上次 prod 构建留下的 ${path.relative(ROOT, stale)}`);
    }
    this.buildInto(path.join(TARGET_DIR, "debug", "resources", SCENE_HOST_DIR_NAME), true);
  }

  private buildInto(outDir: string, dev = false): void {
    process.env.KABEGAME_WPE_SCENE_OUT_DIR = outDir;
    this.log(`构建场景宿主 → ${path.relative(ROOT, outDir)}`);
    run("build", dev ? ["--mode", "development"] : [], { bin: "deno-task", cwd: SCENE_HOST_APP_DIR });
  }
}
