import { defineConfig, UserConfig } from "vite";
import path from "path";

import pubConfig, { root } from "../../vite.config.pub";
import { merge } from "lodash-es";

const config = merge<UserConfig, UserConfig>(
  pubConfig,
  {
    server: {
      port: 1420
    },
    build: {
      outDir: path.resolve(root, 'dist-main'),
      rollupOptions: {
        input: pubConfig.define.__WINDOWS__ ? { wallpaper: './wallpaper.html' } : {}
      }
    },
    publicDir: './public'
  }
);

export default defineConfig(config);
