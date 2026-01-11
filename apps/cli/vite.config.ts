import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import path from "path";
import { copyFile, readFile, rename, rm } from "node:fs/promises";

const repoRoot = path.resolve(__dirname, "../..");
const appRoot = __dirname;

export default defineConfig({
  plugins: [
    vue(),
    {
      name: "kabegame-html-entry-rewrite-cli",
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
              `[kabegame-html-entry-rewrite-cli] failed: ${String(e)}`
            );
            res.statusCode = 500;
            res.end("Internal Server Error");
          }
        });
      },
    },
    {
      // build 时把 dist-cli/html/index.html 扁平化到 dist-cli/index.html
      name: "kabegame-flatten-html-output-cli",
      apply: "build",
      async writeBundle(outputOptions) {
        const outDir = outputOptions.dir;
        if (!outDir) return;

        const moveFile = async (from: string, to: string) => {
          try {
            await rename(from, to);
          } catch (e: any) {
            if (e?.code === "EXDEV" || e?.code === "EPERM") {
              await copyFile(from, to);
              await rm(from, { force: true });
              return;
            }
            if (e?.code === "ENOENT") return;
            throw e;
          }
        };

        await moveFile(
          path.join(outDir, "html", "index.html"),
          path.join(outDir, "index.html")
        );
        await rm(path.join(outDir, "html"), { recursive: true, force: true });
      },
    },
  ],

  clearScreen: false,
  server: {
    port: 1422,
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
    outDir: path.resolve(repoRoot, "dist-cli"),
    emptyOutDir: true,
    reportCompressedSize: false,
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

