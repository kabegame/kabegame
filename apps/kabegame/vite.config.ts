import { defineConfig, UserConfig } from "vite";
import path from "path";

import pubConfig, { root, isMacOS, isWindows } from "../../vite.config.pub";
import { merge } from "lodash-es";

const isWeb = process.env.KABEGAME_MODE === "web";
// web mode: no wallpaper window, chunking always on
const hasWallpaper = !isWeb && (isWindows || isMacOS);

const webProxyTarget = "http://localhost:7490";
const webProxyPaths = ["/rpc", "/events", "/api", "/file", "/thumbnail", "/proxy", "/mcp"];
const webProxy = isWeb
  ? Object.fromEntries(
      webProxyPaths.map((p) => [p, { target: webProxyTarget, changeOrigin: true, ws: false }]),
    )
  : undefined;

const config = merge<UserConfig, UserConfig>(pubConfig, {
  server: {
    allowedHosts: true,
    port: 1420,
    ...(webProxy && { proxy: webProxy }),
  },
  build: {
    outDir: path.resolve(root, "dist-kabegame"),
    assetsInlineLimit: (filePath) => {
      if (filePath.includes('icon-small.png')) {
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

export default defineConfig(config);
