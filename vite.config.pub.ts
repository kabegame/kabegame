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
    // 分支自动 `adb reverse tcp:1420 tcp:1420`——页面 HTTP 经 USB 回环直达开发机。
    // 但 tauri v2 移动端 dev 构建有 PROXY_DEV_SERVER（third/tauri
    // crates/tauri/src/manager/webview.rs），页面实际由 http://tauri.localhost 自定义协议
    // 代理加载，该代理只转发 HTTP、不转发 WebSocket upgrade，location 派生的
    // ws://tauri.localhost 必然失败。故按官方模板显式指定 HMR 直连地址（优先
    // TAURI_DEV_HOST——CLI 公网 IP 模式下注入；否则 localhost 走 adb reverse）：
    // 全双工，且不经设备侧代理（Clash 等会破坏 LAN 的 WS Upgrade）。
    ...(isWeb ? { origin: `http://${getDevServerHost()}:1420` } : {}),
    ...(isAndroid
      ? {
          hmr: {
            protocol: "ws",
            host: process.env.TAURI_DEV_HOST || "localhost",
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
      "@kabegame/core": path.resolve(root, "packages", "kabegame-core", "src"),
      // element-plus 在其 package.json 里把 "@popperjs/core" 别名到
      // "npm:@sxzz/popperjs-es"（ESM fork）。bun 会在 node_modules 物化该别名目录，
      // 但 deno 的 hoisted linker 不物化「依赖的 npm 别名」，rollup 从 element-plus
      // 解析裸 "@popperjs/core" 会失败。此处直接把裸 specifier 指到实包。
      "@popperjs/core": "@sxzz/popperjs-es",
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
