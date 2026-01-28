import { defineConfig, UserConfig } from "vite";
import path from "path";

import pubConfig, { root, isWindows } from "../../vite.config.pub";
import { merge } from "lodash-es";

const config = merge<UserConfig, UserConfig>(pubConfig, {
  server: {
    port: 1420,
  },
  build: {
    outDir: path.resolve(root, "dist-main"),
    rollupOptions: {
      input: isWindows ? { wallpaper: "./wallpaper.html" } : {},
      output: {
        inlineDynamicImports: !isWindows,
      },
    },
  },
  publicDir: "./public",
});

export default defineConfig(config);
