import { UserConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import path from "path";
import UnoCSS from 'unocss/vite';
import { getDevServerHost } from "./scripts/utils";

export const root = __dirname;

// 判断是否为 Windows 平台（窗口模式仅在 Windows 可用）
export const isWindows = process.platform === "win32";
export const isLinux = process.platform === 'linux';
export const isMacOS = process.platform === 'darwin';
// 是否为 Android 构建（Tauri 构建时设置 TAURI_PLATFORM，或通过 VITE_ANDROID 显式指定）
export const isAndroid = process.env.TAURI_PLATFORM === 'android' || process.env.VITE_ANDROID === 'true';

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
    __WINDOWS__: !isAndroid && isWindows,
    __LINUX__: !isAndroid && isLinux,
    __MACOS__: !isAndroid && isMacOS,
    __ANDROID__: isAndroid,
    __DESKTOP__: JSON.stringify(desktop),
    __LIGHT_MODE__: isAndroid || isLightMode,
    __LOCAL_MODE__: !isAndroid &&isLocalMode,
    // 切换此开关来强制重启vite服务器
    __REBOOT__: false,
  },

  // 使用 apps/main/public 作为 public 目录（main app 专用）
  // 根目录 static 的共享资源通过插件复制（见下方插件）
  publicDir: path.resolve(root, "static"),

  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    // 桌面端仅监听 localhost；Android 真机需监听所有网卡以便设备连接
    host: isAndroid,
    // Android 真机：HMR 与 origin 指向开发机 IP，使设备能连上 WebSocket 并正确解析 script/source map 等请求
    ...(isAndroid
      ? {
          origin: `http://${getDevServerHost()}:1420`,
          hmr: {
            protocol: "ws",
            host: getDevServerHost(),
            port: 1420,
          },
        }
      : {}),
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
    // 不预构建本地 photoswipe-reactive，始终从源码编译，改包内代码立即生效
    exclude: ["photoswipe", "photoswipe/lightbox"],
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
