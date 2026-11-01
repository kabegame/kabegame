import { defineConfig } from "vite";
import path from "path";
import { fileURLToPath } from "url";

// 场景宿主（P3-0）：主窗口 / 壁纸窗口的应用页以 `file:` iframe 加载它（见
// src-tauri/kabegame/src/wallpaper/wpe_scene_host.rs），所以：
// - base 用相对路径，产物里的引用都是 `./assets/…`，不依赖任何服务器；
// - 产物直接写进应用的 resource_dir。默认（dev）是 `<CARGO_TARGET_DIR 或 target>/debug/resources/wpe-scene`，
//   改宿主后重跑 build 即生效，不用重编 Rust；prod 由 scripts/plugins/wpe-scene-host-plugin.ts 经
//   KABEGAME_WPE_SCENE_OUT_DIR 指到 src-tauri/kabegame/resources/wpe-scene，随 `resources/**/*` 打进安装包。
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");

function outDir(): string {
  const explicit = process.env.KABEGAME_WPE_SCENE_OUT_DIR;
  if (explicit) return path.resolve(repoRoot, explicit);
  const target = process.env.CARGO_TARGET_DIR
    ? path.resolve(repoRoot, process.env.CARGO_TARGET_DIR)
    : path.join(repoRoot, "target");
  return path.join(target, "debug", "resources", "wpe-scene");
}

export default defineConfig({
  base: "./",
  build: {
    outDir: outDir(),
    // outDir 在项目根之外，Vite 默认不清空，这里显式清掉旧的哈希文件
    emptyOutDir: true,
    target: "esnext",
    // Chromium 原生支持 modulepreload，不要 polyfill（它会额外 fetch 每个 chunk）
    modulePreload: { polyfill: false },
  },
});
