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
      outDir: path.resolve(root, "dist-kabegame"),
      assetsInlineLimit: (filePath) => {
        if (filePath.includes("icon-small.png")) {
          return true;
        }
        return false;
      },
      rollupOptions: {
        input: hasWallpaper ? { wallpaper: "./wallpaper.html" } : {},
        output: {
          inlineDynamicImports: !hasWallpaper && !isWeb,
          ...(isWeb && {
            manualChunks(id: string) {
              if (!id.includes("node_modules")) return undefined;
              if (id.includes("@element-plus/icons-vue")) return "vendor-ep-icons";
              if (id.includes("element-plus")) return "vendor-element-plus";
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
