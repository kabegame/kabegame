import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import path from "path";
import { copyFile, readFile, rename, rm } from "node:fs/promises";

const repoRoot = path.resolve(__dirname, "../..");
const appRoot = __dirname;

// 判断是否为 Windows 平台（窗口模式仅在 Windows 可用）
const isWindows = process.env.TAURI_ENV_PLATFORM === "windows";

// 判断桌面环境（从 VITE_DESKTOP 环境变量读取）
const desktop = process.env.VITE_DESKTOP || "";

// console.log(process.env);

export default defineConfig({
  plugins: [
    vue(),
    {
      name: "kabegame-html-entry-rewrite-main",
      configureServer(server) {
        const routeToFile: Record<string, string> = {
          "/": "html/index.html",
          "/index.html": "html/index.html",
          ...(isWindows ? { "/wallpaper.html": "html/wallpaper.html" } : {}),
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
    {
      // build 时把 dist-main/html/*.html 扁平化到 dist-main/*.html，满足 Tauri 期望的入口路径：
      // - index.html
      // - wallpaper.html
      name: "kabegame-flatten-html-output-main",
      apply: "build",
      async writeBundle(outputOptions) {
        const outDir = outputOptions.dir;
        if (!outDir) return;

        const moveFile = async (from: string, to: string) => {
          try {
            await rename(from, to);
          } catch (e: any) {
            // Windows/跨盘等场景：rename 可能失败，fallback 为 copy + delete
            if (e?.code === "EXDEV" || e?.code === "EPERM") {
              await copyFile(from, to);
              await rm(from, { force: true });
              return;
            }
            // 源不存在：忽略
            if (e?.code === "ENOENT") return;
            throw e;
          }
        };

        await moveFile(
          path.join(outDir, "html", "index.html"),
          path.join(outDir, "index.html")
        );
        // 仅在 Windows 平台时移动 wallpaper.html
        if (isWindows) {
          await moveFile(
            path.join(outDir, "html", "wallpaper.html"),
            path.join(outDir, "wallpaper.html")
          );
        }

        // 清理空目录（best-effort）
        await rm(path.join(outDir, "html"), { recursive: true, force: true });
      },
    },
  ],

  define: {
    __DEV__: process.env.NODE_ENV === "development",
    __WINDOWS__: isWindows,
    __DESKTOP__: JSON.stringify(desktop),
  },

  // 使用 apps/main/public 作为 public 目录（main app 专用）
  // 根目录 static 的共享资源通过插件复制（见下方插件）
  publicDir: path.resolve(appRoot, "public"),

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
      ...(isWindows ? [path.resolve(appRoot, "html/wallpaper.html")] : []),
    ],
  },
  build: {
    outDir: path.resolve(repoRoot, "dist-main"),
    emptyOutDir: true,
    reportCompressedSize: false,
    target: ["es2021", "chrome100", "safari13"],
    minify: !process.env.TAURI_DEBUG ? "esbuild" : false,
    sourcemap: !!process.env.TAURI_DEBUG,
    chunkSizeWarningLimit: 10000000,
    rollupOptions: {
      input: {
        index: path.resolve(appRoot, "html/index.html"),
        ...(isWindows
          ? { wallpaper: path.resolve(appRoot, "html/wallpaper.html") }
          : {}),
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
        // ⚠️ 这里不能把所有 chunk 都强制塞进同一个名字（比如 "index"），
        // 否则多入口（index / wallpaper）在生产构建会被合并，导致主窗口也执行 wallpaper 入口逻辑。
        // 只把 node_modules 抽到 vendor，保留多入口各自的 entry chunk。
        manualChunks(id) {
          if (id.includes("node_modules")) return "vendor";
        },
      },
    },
  },
});
