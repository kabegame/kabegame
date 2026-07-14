import { UserConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import path from "path";
import UnoCSS from "unocss/vite";
import { getDevServerHost } from "./scripts/utils";
import { kabegameDebugServer } from "./scripts/vite-debug-server";

export const root = __dirname;

// 判断是否为 Windows 平台（窗口模式仅在 Windows 可用）
export const isWindows = process.platform === "win32";
export const isLinux = process.platform === "linux";
export const isMacOS = process.platform === "darwin";
// 是否为 Android 构建（Tauri 构建时设置 TAURI_PLATFORM，或通过 VITE_ANDROID 显式指定）
export const isAndroid =
  process.env.TAURI_PLATFORM === "android" ||
  process.env.VITE_ANDROID === "true";

export const isWeb = process.env.KABEGAME_MODE === "web";
export const isDebugIngestEnabled = process.env.KABEGAME_DEBUG_INGEST !== "false";


export default {
  plugins: [
    vue(),
    UnoCSS(),
    kabegameDebugServer({
      workspaceRoot: root,
      enabled: isDebugIngestEnabled,
      allowRemote: isAndroid || isWeb,
    }),
  ],

  define: {
    __DEV__: process.env.NODE_ENV === "development",
    __WINDOWS__: !isAndroid && !isWeb && isWindows,
    __LINUX__: !isAndroid && !isWeb && isLinux,
    __MACOS__: !isAndroid && !isWeb && isMacOS,
    __ANDROID__: isAndroid,
    __WEB__: isWeb,
    __LIGHT_MODE__: isAndroid,
    // 切换此开关来强制重启vite服务器
    __REBOOT__: true,
  },

  // 使用 apps/kabegame/public 作为 public 目录（main app 专用）
  // 根目录 static 的共享资源通过插件复制（见下方插件）
  publicDir: path.resolve(root, "static"),

  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    // 桌面端仅监听 localhost；Android 真机或 web 模式需监听所有网卡以便设备连接
    host: isAndroid || isWeb,
    // web：origin 指向开发机 IP，使浏览器设备正确解析 script/source map 等请求。
    // Android 真机/模拟器：devUrl = http://localhost:1420，fork 的 cargo-tauri 不再把
    // 真机 devUrl 改写成局域网 IP（patch 5），stock android-studio-script 的 localhost
    // 分支自动 `adb reverse tcp:1420 tcp:1420`——页面 HTTP 与 HMR WebSocket 均经 USB
    // 回环直达开发机：全双工，且不经设备侧代理（Clash 等会破坏 LAN 的 WS Upgrade）。
    // 故 Android 不覆盖 origin/hmr，走 location 派生的默认值（localhost:1420）即可。
    ...(isWeb ? { origin: `http://${getDevServerHost()}:1420` } : {}),
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },

  resolve: {
    alias: {
      "@": path.resolve(process.cwd(), "src"),
      "@kabegame/core": path.resolve(root, "packages", "kabegame-core", "src"),
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
    entries: [path.resolve(process.cwd(), "index.html")],
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
      },
    },
  },
} satisfies UserConfig;
