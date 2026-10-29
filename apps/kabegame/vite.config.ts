import { defineConfig, UserConfig, type Plugin } from "vite";
import path from "path";

import { merge } from "lodash-es";

// 生产 web（demo.kabegame.com）的静态资源从 OSS 读：index.html 仍由二进制内嵌返回，
// 其余文件由 scripts/deploy-web.sh 上传到 OSS 挂载目录 /mnt/oss/web/。
// 服务器出口带宽只有几 Mbps 且所有访客共享，CDN 并发速度约为源站的 5 倍并自带 gzip。
const webCdnBase = "https://cdn.kabegame.com/web/";
const webDevApiTarget = "http://127.0.0.1:7490";
const webDevApiProxyPaths = [
  "/rpc",
  "/events",
  "/api",
  "/file",
  "/thumbnail",
  "/compatible",
  "/plugin_file",
  "/mcp",
  "/__ping",
];
// src/assets/illustrations.ts 按 IS_WEB 二选一，代码里另一份会被折叠掉，但 Vite 加载
// import 时就已发射资源文件；这里删掉没有任何产物引用的 src/assets 资源，
// 免得 web 产物带上原图、本地产物带上 WebP。
function dropUnreferencedSrcAssets(): Plugin {
  return {
    name: "kabegame:drop-unreferenced-src-assets",
    apply: "build",
    enforce: "post",
    generateBundle(_options, bundle) {
      const texts = Object.values(bundle).map((file) =>
        file.type === "chunk" ? file.code : typeof file.source === "string" ? file.source : "",
      );
      for (const [fileName, file] of Object.entries(bundle)) {
        if (file.type !== "asset" || !file.originalFileNames.some((name) => name.includes("src/assets/"))) continue;
        const baseName = path.posix.basename(fileName);
        if (!texts.some((text) => text.includes(baseName))) delete bundle[fileName];
      }
    },
  };
}

function ensureWebEnv(mode: string) {
  if (mode !== "web") return;
  process.env.KABEGAME_MODE ??= "web";
  process.env.VITE_KABEGAME_MODE ??= "web";
}

export default defineConfig(async ({ mode, command }) => {
  ensureWebEnv(mode);

  const { default: pubConfig, root } = await import("../../vite.config.pub");

  const isWeb = process.env.KABEGAME_MODE === "web" || mode === "web";
  const isProd = command === "build";
  // 壁纸窗口与主窗口共用 index.html（?window=wallpaper，由 main.ts 分发），不再单开入口。
  const hasSurfNavbar = !isWeb;
  const rollupInput = {
    ...(hasSurfNavbar && { "surf-navbar": "./surf-navbar.html" }),
  };
  const webDevApiProxy = isWeb
    ? Object.fromEntries(
        webDevApiProxyPaths.map((p) => [
          p,
          {
            target: webDevApiTarget,
            changeOrigin: true,
            ws: false,
          },
        ]),
      )
    : undefined;

  const config = merge<UserConfig, UserConfig>(pubConfig, {
    base: isWeb && isProd ? webCdnBase : "/",
    server: {
      allowedHosts: true,
      port: 1420,
      ...(webDevApiProxy && { proxy: webDevApiProxy }),
    },
    build: {
      // 桌面/Android 与 web 的产物目录必须分开：两者的平台 define（__WEB__ /
      // __MACOS__ 等）、rollup input（surf-navbar）、chunking 策略完全
      // 不同，共用一个目录时后跑的构建会静默覆盖前者。build-web.ts 是「宿主出
      // 前端 → 容器编 Rust 嵌入」两段式，中间若插入一次桌面构建，web 二进制就
      // 会嵌到桌面 bundle（invoke 走 __TAURI_INTERNALS__，浏览器里全挂）。
      outDir: path.resolve(root, isWeb ? "dist-kabegame-web" : "dist-kabegame"),
      assetsInlineLimit: (filePath) => {
        if (filePath.includes("icon-small.png")) {
          return true;
        }
        return false;
      },
      rollupOptions: {
        input: rollupInput,
        output: {
          inlineDynamicImports: !hasSurfNavbar && !isWeb,
          ...(isWeb && {
            manualChunks(id: string) {
              // vendored 的 element-plus / icons 是仓内源码（packages/kabegame-element-plus*），
              // 不在 node_modules 下，必须在下面的 node_modules 闸门之前判掉，
              // 否则会整包并进主 bundle。
              if (id.includes("packages/kabegame-element-plus-icons")) return "vendor-ep-icons";
              if (id.includes("packages/kabegame-element-plus")) return "vendor-element-plus";
              if (!id.includes("node_modules")) return undefined;
              if (id.includes("vant")) return "vendor-vant";
              if (id.includes("pinia") || id.includes("vue-router")) return "vendor-vue-router";
              if (id.includes("@vue") || id.includes("/vue/")) return "vendor-vue";
              if (id.includes("photoswipe")) return "vendor-photoswipe";
              return "vendor";
            },
          }),
        },
      },
    },
    publicDir: "./public",
  });
  // 不经 merge：lodash 按下标合并数组，会把插件揉进 pubConfig 的第 0 个插件
  config.plugins = [...(config.plugins ?? []), dropUnreferencedSrcAssets()];
  return config;
});
