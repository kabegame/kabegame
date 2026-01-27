import { defineConfig, type UserConfig } from "vite";

import pubConfig, { root } from "../../vite.config.pub";
import * as path from 'path';
import { merge } from "lodash-es";

export default defineConfig(merge<UserConfig, UserConfig>(
  pubConfig,
  {
    server: {
      port: 1422
    },
    build: {
      outDir: path.resolve(root, 'dist-cli'),
    }
  }
));
