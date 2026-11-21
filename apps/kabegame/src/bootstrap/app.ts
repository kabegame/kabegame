// 主窗口 bootstrap：原 main.ts 的全部内容原样搬入（main.ts 现在只按 ?window= 分发）。
import { createApp } from "vue";
import { createPinia } from "pinia";
import { LUCIDE_CONTEXT } from "@lucide/vue";
import App from "../App.vue";
import router from "../router";
import "virtual:uno.css";
import "@/styles/anime-theme.css";
import "@/styles/tokens.css";
import "../styles/hscroll-fade.css";
import { vPullToRefresh } from "@/directives/pullToRefresh";
import { vHscrollFade } from "@/directives/hscrollFade";
import { IS_ANDROID, IS_LINUX, IS_MACOS, IS_WEB } from "@/env";
import { invoke } from "@/api/rpc";
import { startWindowPointerFeed } from "@/components/wallpaper/framePointer";
import { registerHeaderFeatures } from "@/header/headerFeatures";
import { createMinAppVersionBeforeAddTaskGuard } from "@/composables/pluginMinAppVersionGate";
import { usePluginStore } from "@/stores/plugins";
import { setCrawlerBeforeAddTaskGuard } from "@/stores/crawler";
import { i18n } from "@kabegame/i18n";
import { logger } from "@/utils/logger";
import { runInitScreen } from "./initScreen";
import { applyStoredColorTheme } from "@/theme/colorTheme";
import { localSettingStorageKey } from "@/stores/settingsDescriptors";

if (IS_ANDROID) {
  document.documentElement.classList.add("platform-android");
}

// 颜色主题先于启动页应用，之后由 App.vue 跟随设置
applyStoredColorTheme(localSettingStorageKey("colorTheme"));

const describeError = (error: unknown) =>
  error instanceof Error ? `${error.message}\n${error.stack ?? ""}`.trim() : String(error);

// 未捕获的前端异常写进应用日志（web 的 logger 回落 console，浏览器本来就会打印，不重复挂）。
if (!IS_WEB) {
  window.addEventListener("error", (event) => {
    logger.error(`[window] ${describeError(event.error ?? event.message)}`);
  });
  window.addEventListener("unhandledrejection", (event) => {
    logger.error(`[unhandledrejection] ${describeError(event.reason)}`);
  });
}

// Linux 读不到全局光标：主窗口把自己收到的鼠标交给应用，应用照壁纸鼠标回传的协议发进那个 socket，图库预览里的网页 / 场景
// 壁纸经它注入（Windows / macOS 由 Rust 轮询全局光标）。同步命令，按调用顺序执行；失败（应用退出中）不管。
if (IS_LINUX) {
  startWindowPointerFeed((pointer) => {
    void invoke("push_window_pointer", { ...pointer }).catch(() => {});
  });
}

// 强制重新加载 WebView（拦截默认行为，确保在 Tauri 内可用）。
// macOS 用 Cmd+Shift+R，其余平台用 Ctrl+Shift+R。

window.addEventListener(
  "keydown",
  (e) => {
    const modifier = IS_MACOS ? e.metaKey : e.ctrlKey;
    if (modifier && e.shiftKey && (e.key === "R" || e.key === "r")) {
      e.preventDefault();
      window.location.reload();
    }
  },
  { capture: true },
);

/**
 * 主界面在后端全局单例就绪之后才创建：先挂启动页（Init app）等 `ready`，卸载后再挂主界面。
 * web 的服务端在监听前已初始化完，直接跳过启动页。
 * 不用顶层 await：构建 target（es2021 / safari13）不支持。
 */
function mountMainApp() {
  const app = createApp(App);

  // 设置 errorHandler 会关掉 Vue 默认的控制台输出，这里补回 console.error。
  app.config.errorHandler = (error, _instance, info) => {
    console.error(error);
    if (!IS_WEB) logger.error(`[vue] ${info}: ${describeError(error)}`);
  };

  app.directive("pull-to-refresh", vPullToRefresh);
  app.directive("hscroll-fade", vHscrollFade);

  // 新界面的线性图标（@lucide/vue）统一细一档：默认 2 在 16px 下偏粗。
  app.provide(LUCIDE_CONTEXT, { strokeWidth: 1.75 });

  const pinia = createPinia();
  app.use(pinia);
  app.use(i18n);

  setCrawlerBeforeAddTaskGuard(createMinAppVersionBeforeAddTaskGuard(usePluginStore()));
  registerHeaderFeatures();
  app.use(router);

  app.mount("#app");
}

if (IS_WEB) {
  mountMainApp();
} else {
  void runInitScreen().then(mountMainApp, (error) => {
    // 启动页自身出错（IPC 不可用等）时退回直接挂主界面，不留白屏。
    console.error("[init] init screen failed:", error);
    mountMainApp();
  });
}
