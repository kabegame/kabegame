import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import path from "path";

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [vue()],

  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },

  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },

  css: {
    preprocessorOptions: {
      scss: {
        api: "modern-compiler",
      },
    },
  },

  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target: ["es2021", "chrome100", "safari13"],
    minify: !process.env.TAURI_DEBUG ? "esbuild" : false,
    sourcemap: !!process.env.TAURI_DEBUG,
    chunkSizeWarningLimit: 10000000, // 抑制单文件过大警告（默认 500KB）
    rollupOptions: {
      onwarn(warning, warn) {
        // 抑制动态导入和静态导入混合使用的警告
        if (
          warning.message &&
          warning.message.includes(
            "dynamic import will not move module into another chunk"
          )
        ) {
          return;
        }
        warn(warning);
      },
      output: {
        // 关闭 chunk 分包，将所有代码打包到单个文件中
        manualChunks: () => "index",
      },
    },
  },
});
