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
      name: "kabegame-html-entry-rewrite-plugin-editor",
      configureServer(server) {
        const routeToFile: Record<string, string> = {
          "/": "html/index.html",
          "/index.html": "html/index.html",
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
              `[kabegame-html-entry-rewrite-plugin-editor] failed: ${String(e)}`
            );
            res.statusCode = 500;
            res.end("Internal Server Error");
          }
        });
      },
    },
  ],

  publicDir: path.resolve(repoRoot, "static"),

  clearScreen: false,
  server: {
    port: 1421,
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
    entries: [path.resolve(appRoot, "html/index.html")],
  },
  build: {
    outDir: path.resolve(repoRoot, "dist-plugin-editor"),
    emptyOutDir: true,
    target: ["es2021", "chrome100", "safari13"],
    minify: !process.env.TAURI_DEBUG ? "esbuild" : false,
    sourcemap: !!process.env.TAURI_DEBUG,
    chunkSizeWarningLimit: 10000000,
    rollupOptions: {
      input: {
        index: path.resolve(appRoot, "html/index.html"),
      },
      output: {
        manualChunks: () => "index",
      },
    },
  },
});
