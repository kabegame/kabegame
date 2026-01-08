import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import path from "path";
import { readFile } from "node:fs/promises";

const repoRoot = path.resolve(__dirname, "../..");
const appRoot = __dirname;

export default defineConfig({
  plugins: [
    vue(),
    {
      name: "kabegame-html-entry-rewrite-main",
      configureServer(server) {
        const routeToFile: Record<string, string> = {
          "/": "html/index.html",
          "/index.html": "html/index.html",
          "/wallpaper.html": "html/wallpaper.html",
        };

        server.middlewares.use(async (req, res, next) => {
          const method = req.method?.toUpperCase();
          if (method !== "GET" && method !== "HEAD") return next();

          const url = (req.url ?? "").split("?")[0];
          const relFile = routeToFile[url];
          if (!relFile) return next();

          try {
            const absFile = path.resolve(appRoot, relFile);
            let html = await readFile(absFile, "utf-8");
            const transformUrl = url === "/" ? "/index.html" : url;
            html = await server.transformIndexHtml(transformUrl, html);

            res.statusCode = 200;
            res.setHeader("Content-Type", "text/html; charset=utf-8");
            res.end(html);
          } catch (e) {
            server.config.logger.error(
              `[kabegame-html-entry-rewrite-main] failed: ${String(e)}`
            );
            res.statusCode = 500;
            res.end("Internal Server Error");
          }
        });
      },
    },
  ],

  // 仍沿用仓库根的静态目录（避免大搬家）
  publicDir: path.resolve(repoRoot, "static"),

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
      "@": path.resolve(appRoot, "src"),
      "@kabegame/core": path.resolve(repoRoot, "packages", "core", "src"),
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
      path.resolve(appRoot, "html/index.html"),
      path.resolve(appRoot, "html/wallpaper.html"),
    ],
  },
  build: {
    outDir: path.resolve(repoRoot, "dist-main"),
    emptyOutDir: true,
    target: ["es2021", "chrome100", "safari13"],
    minify: !process.env.TAURI_DEBUG ? "esbuild" : false,
    sourcemap: !!process.env.TAURI_DEBUG,
    chunkSizeWarningLimit: 10000000,
    rollupOptions: {
      input: {
        main: path.resolve(appRoot, "html/index.html"),
        wallpaper: path.resolve(appRoot, "html/wallpaper.html"),
      },
      onwarn(warning, warn) {
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
        manualChunks: () => "index",
      },
    },
  },
});
