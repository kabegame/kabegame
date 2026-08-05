import { defineConfig, UserConfig } from "vite";
import path from "path";

import { merge } from "lodash-es";

const webDevApiTarget = "http://127.0.0.1:7490";
const webDevApiProxyPaths = [
  "/rpc",
  "/events",
  "/api",
  "/file",
  "/thumbnail",
  "/proxy",
  "/mcp",
  "/__ping",
];
function ensureWebEnv(mode: string) {
  if (mode !== "web") return;
  process.env.KABEGAME_MODE ??= "web";
  process.env.VITE_KABEGAME_MODE ??= "web";
}

export default defineConfig(async ({ mode }) => {
  ensureWebEnv(mode);

  const { default: pubConfig, root, isMacOS, isWindows } = await import("../../vite.config.pub");

  const isWeb = process.env.KABEGAME_MODE === "web" || mode === "web";
  // web mode: no wallpaper window, chunking always on
  const hasWallpaper = !isWeb && (isWindows || isMacOS);
  const hasSurfNavbar = !isWeb;
  const rollupInput = {
    ...(hasWallpaper && { wallpaper: "./wallpaper.html" }),
    ...(hasSurfNavbar && { "surf-navbar": "./surf-navbar.html" }),
  };
  const webDevApiProxy = isWeb
    ? Object.fromEntries(
        webDevApiProxyPaths.map((p) => [
          p,
          {
            target: webDevApiTarget,
            changeOrigin: true,
            ws: false,
          },
        ]),
      )
    : undefined;

  return merge<UserConfig, UserConfig>(pubConfig, {
    server: {
      allowedHosts: true,
      port: 1420,
      ...(webDevApiProxy && { proxy: webDevApiProxy }),
    },
    build: {
      // 桌面/Android 与 web 的产物目录必须分开：两者的平台 define（__WEB__ /
      // __MACOS__ 等）、rollup input（wallpaper/surf-navbar）、chunking 策略完全
      // 不同，共用一个目录时后跑的构建会静默覆盖前者。build-web.ts 是「宿主出
      // 前端 → 容器编 Rust 嵌入」两段式，中间若插入一次桌面构建，web 二进制就
      // 会嵌到桌面 bundle（invoke 走 __TAURI_INTERNALS__，浏览器里全挂）。
      outDir: path.resolve(root, isWeb ? "dist-kabegame-web" : "dist-kabegame"),
      assetsInlineLimit: (filePath) => {
        if (filePath.includes("icon-small.png")) {
          return true;
        }
        return false;
      },
      rollupOptions: {
        input: rollupInput,
        output: {
          inlineDynamicImports: !hasWallpaper && !hasSurfNavbar && !isWeb,
          ...(isWeb && {
            manualChunks(id: string) {
              // vendored 的 element-plus / icons 是仓内源码（packages/kabegame-element-plus*），
              // 不在 node_modules 下，必须在下面的 node_modules 闸门之前判掉，
              // 否则会整包并进主 bundle。
              if (id.includes("packages/kabegame-element-plus-icons")) return "vendor-ep-icons";
              if (id.includes("packages/kabegame-element-plus")) return "vendor-element-plus";
              if (!id.includes("node_modules")) return undefined;
              if (id.includes("vant")) return "vendor-vant";
              if (id.includes("pinia") || id.includes("vue-router")) return "vendor-vue-router";
              if (id.includes("@vue") || id.includes("/vue/")) return "vendor-vue";
              if (id.includes("photoswipe")) return "vendor-photoswipe";
              return "vendor";
            },
          }),
        },
      },
    },
    publicDir: "./public",
  });
});
