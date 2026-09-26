import vue from "@vitejs/plugin-vue";
import vueJsx from "@vitejs/plugin-vue-jsx";
import { defineConfig } from "vite";
import pubConfig from "../../vite.config.pub";

// 与应用共用平台常量、源码 alias 和样式环境；DOM 测试按文件开启 happy-dom。
const config = {
  plugins: [vue(), vueJsx()],
  define: pubConfig.define,
  resolve: pubConfig.resolve,
  css: pubConfig.css,
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
};

// 使用应用所安装 Vite 的配置类型，避免 Vitest 内嵌 Vite 的插件类型版本差异。
export default defineConfig(config);
