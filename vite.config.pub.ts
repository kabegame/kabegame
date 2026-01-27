import { UserConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import path from "path";
import { copyFile, readFile, rename, rm } from "node:fs/promises";
import UnoCSS from 'unocss/vite';

const root = __dirname;

// 判断是否为 Windows 平台（窗口模式仅在 Windows 可用）
const isWindows = process.platform === "win32";
const isLinux = process.platform === 'linux';
const isMacOS = process.platform === 'darwin';

// 判断桌面环境（从 VITE_DESKTOP 环境变量读取）
const desktop = process.env.VITE_DESKTOP || "";

const isLightMode = process.env.VITE_KABEGAME_MODE === "light";

const isLocalMode = process.env.VITE_KABEGAME_MODE === "local";

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
      // output: {
      //   // ⚠️ 这里不能把所有 chunk 都强制塞进同一个名字（比如 "index"），
      //   // 否则多入口（index / wallpaper）在生产构建会被合并，导致主窗口也执行 wallpaper 入口逻辑。
      //   // 只把 node_modules 抽到 vendor，保留多入口各自的 entry chunk。
      //   manualChunks(id) {
      //     if (id.includes("node_modules")) return "vendor";
      //   },
      // },
    },
  },
} satisfies UserConfig;
