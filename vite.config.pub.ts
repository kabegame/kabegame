import { UserConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import path from "path";
import UnoCSS from 'unocss/vite';

export const root = __dirname;

// 判断是否为 Windows 平台（窗口模式仅在 Windows 可用）
export const isWindows = process.platform === "win32";
export const isLinux = process.platform === 'linux';
export const isMacOS = process.platform === 'darwin';

// 判断桌面环境（从 VITE_DESKTOP 环境变量读取）
export const desktop = process.env.VITE_DESKTOP || "";

export const isLightMode = process.env.VITE_KABEGAME_MODE === "light";

export const isLocalMode = process.env.VITE_KABEGAME_MODE === "local";

export default {
  plugins: [
    vue(),
    UnoCSS(),
  ],

  define: {
    __DEV__: process.env.NODE_ENV === "development",
    __WINDOWS__: isWindows,
    __LINUX__: isLinux,
    __MACOS__: isMacOS,
    __DESKTOP__: JSON.stringify(desktop),
    __LIGHT_MODE__: isLightMode,
    __LOCAL_MODE__: isLocalMode,
  },

  // 使用 apps/main/public 作为 public 目录（main app 专用）
  // 根目录 static 的共享资源通过插件复制（见下方插件）
  publicDir: path.resolve(root, "public"),

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
      "@": path.resolve(process.cwd(), "src"),
      "@kabegame/core": path.resolve(root, "packages", "core", "src"),
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
  optimizeDeps: {
    entries: [
      path.resolve(process.cwd(), "index.html"),
    ],
  },
  build: {
    outDir: path.resolve(root, `dist-${process.env.KABEGAME_COMPONENT}`),
    emptyOutDir: true,
    reportCompressedSize: false,
    target: ["es2021", "chrome100", "safari13"],
    minify: !process.env.TAURI_DEBUG ? "esbuild" : false,
    sourcemap: !!process.env.TAURI_DEBUG,
    chunkSizeWarningLimit: 10000000,
    rollupOptions: {
      input: {
        index: path.resolve(process.cwd(), "index.html"),
      },
      output: {
        inlineDynamicImports: true,
        manualChunks: undefined,
      }
    },
  },
} satisfies UserConfig;
