import { defineConfig, UserConfig } from "vite";
import path from "path";

import pubConfig from "../../vite.config.pub";
import { merge } from "lodash-es";

export default defineConfig(merge<UserConfig, UserConfig>(
  pubConfig,
  {
    server: {
      port: 1420
    },
    optimizeDeps: {
      entries: [
        './index.html',
        ...(pubConfig.define.__WINDOWS__ ? ['./wallpaper.html'] : [])
      ]
    },
    build: {
      rollupOptions: {
        input: pubConfig.define.__WINDOWS__ ? { wallpaper: './wallpaper.html' } : {}
      }
    },
    publicDir: './public'
  }
));

// defineConfig({
//   plugins: [
//     vue(),
//     UnoCSS(),
//   ],

//   define: {
//     __DEV__: process.env.NODE_ENV === "development",
//     __WINDOWS__: isWindows,
//     __DESKTOP__: JSON.stringify(desktop),
//     __LIGHT_MODE__: isLightMode,
//     __LOCAL_MODE__: isLocalMode,
//   },

//   // 使用 apps/main/public 作为 public 目录（main app 专用）
//   // 根目录 static 的共享资源通过插件复制（见下方插件）
//   publicDir: path.resolve(appRoot, "public"),

//   clearScreen: false,
//   server: {
//     port: 1420,
//     strictPort: true,
//     watch: {
//       ignored: ["**/src-tauri/**"],
//     },
//   },

//   resolve: {
//     alias: {
//       "@": path.resolve(appRoot, "src"),
//       "@kabegame/core": path.resolve(repoRoot, "packages", "core", "src"),
//     },
//   },

//   css: {
//     preprocessorOptions: {
//       scss: {
//         api: "modern-compiler",
//       },
//     },
//   },

//   envPrefix: ["VITE_", "TAURI_"],
//   optimizeDeps: {
//     entries: [
//       path.resolve(appRoot, "html/index.html"),
//       ...(isWindows ? [path.resolve(appRoot, "html/wallpaper.html")] : []),
//     ],
//   },
//   build: {
//     outDir: path.resolve(repoRoot, "dist-main"),
//     emptyOutDir: true,
//     reportCompressedSize: false,
//     target: ["es2021", "chrome100", "safari13"],
//     minify: !process.env.TAURI_DEBUG ? "esbuild" : false,
//     sourcemap: !!process.env.TAURI_DEBUG,
//     chunkSizeWarningLimit: 10000000,
//     rollupOptions: {
//       input: {
//         index: path.resolve(appRoot, "html/index.html"),
//         ...(isWindows
//           ? { wallpaper: path.resolve(appRoot, "html/wallpaper.html") }
//           : {}),
//       },
//       onwarn(warning, warn) {
//         if (
//           warning.message &&
//           warning.message.includes(
//             "dynamic import will not move module into another chunk",
//           )
//         ) {
//           return;
//         }
//         warn(warning);
//       },
//       output: {
//         // ⚠️ 这里不能把所有 chunk 都强制塞进同一个名字（比如 "index"），
//         // 否则多入口（index / wallpaper）在生产构建会被合并，导致主窗口也执行 wallpaper 入口逻辑。
//         // 只把 node_modules 抽到 vendor，保留多入口各自的 entry chunk。
//         manualChunks(id) {
//           if (id.includes("node_modules")) return "vendor";
//         },
//       },
//     },
//   },
// });
