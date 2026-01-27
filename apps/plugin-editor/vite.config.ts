import { defineConfig, type UserConfig } from "vite";

import pubConfig from "../../vite.config.pub";
import { merge } from "lodash-es";

export default defineConfig(merge<UserConfig, UserConfig>(
  pubConfig,
  {
    server: {
      port: 1421
    }
  }
));
