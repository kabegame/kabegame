import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import path from "path";
import { readFile } from "node:fs/promises";

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    vue(),
    {
      name: "kabegame-html-entry-rewrite",
      configureServer(server) {
        const routeToFile: Record<string, string> = {
          "/": "html/index.html",
          "/index.html": "html/index.html",
          "/wallpaper.html": "html/wallpaper.html",
          "/plugin-editor.html": "html/plugin-editor.html",
        };

        server.middlewares.use(async (req, res, next) => {
          const method = req.method?.toUpperCase();
          if (method !== "GET" && method !== "HEAD") return next();

          const url = (req.url ?? "").split("?")[0];
          const relFile = routeToFile[url];
          if (!relFile) return next();

          try {
            const absFile = path.resolve(__dirname, relFile);
            let html = await readFile(absFile, "utf-8");
            const transformUrl = url === "/" ? "/index.html" : url;
            html = await server.transformIndexHtml(transformUrl, html);

            res.statusCode = 200;
            res.setHeader("Content-Type", "text/html; charset=utf-8");
            res.end(html);
          } catch (e) {
            server.config.logger.error(
              `[kabegame-html-entry-rewrite] failed to serve ${relFile}: ${String(
                e
              )}`
            );
            res.statusCode = 500;
            res.end("Internal Server Error");
          }
        });
      },
    },
  ],

  // 让 html/ 专门存放“需要 Vite 处理”的多页 html 入口；
  // 静态资源从 static/ 提供（URL 仍是 /xxx）。
  publicDir: "static",

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
  // 关键：限制依赖预构建/扫描入口，避免 Vite 在 Windows 上误扫 src-tauri/target/doc/**/*.html 导致启动失败
  // （尤其是 repo 里存在 rustdoc 输出时，会触发“Failed to scan for dependencies from entries”）
  optimizeDeps: {
    entries: [
      "html/index.html",
      "html/wallpaper.html",
      "html/plugin-editor.html",
    ],
  },
  build: {
    target: ["es2021", "chrome100", "safari13"],
    minify: !process.env.TAURI_DEBUG ? "esbuild" : false,
    sourcemap: !!process.env.TAURI_DEBUG,
    chunkSizeWarningLimit: 10000000, // 抑制单文件过大警告
    rollupOptions: {
      // 多页面入口：主窗口 + 壁纸窗口 + 插件编辑器窗口
      // 这些 html 会被输出到 dist/，供 Tauri 的 WebviewUrl::App(...) 使用
      input: {
        main: path.resolve(__dirname, "html/index.html"),
        wallpaper: path.resolve(__dirname, "html/wallpaper.html"),
        plugin_editor: path.resolve(__dirname, "html/plugin-editor.html"),
      },
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
