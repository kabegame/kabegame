import { defineConfig, type UserConfig } from "vite";

import pubConfig, {root} from "../../vite.config.pub";
import { merge } from "lodash-es";
import * as path from 'path';

export default defineConfig(merge<UserConfig, UserConfig>(
  pubConfig,
  {
    server: {
      port: 1421
    },
    build: {
      outDir: path.resolve(root, 'dist-plugin-editor'),
    }
  }
));
