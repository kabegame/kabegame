import { createApp } from "vue";
import { createPinia } from "pinia";
import ElementPlus from "element-plus";
import "element-plus/dist/index.css";
import * as ElementPlusIconsVue from "@element-plus/icons-vue";
import App from "./App.vue";
import router from "./router";
import "virtual:uno.css";
import "@kabegame/core/styles/anime-theme.css";
import { vPullToRefresh } from "@kabegame/core/directives/pullToRefresh";
import { IS_ANDROID } from "@kabegame/core/env";
import { getImageSupport, getSupportedFormats } from "@kabegame/image-type";
import { invoke } from "@tauri-apps/api/core";

if (IS_ANDROID) {
  document.documentElement.classList.add("platform-android");
}

const app = createApp(App);

app.directive("pull-to-refresh", vPullToRefresh);

// 注册所有图标
for (const [key, component] of Object.entries(ElementPlusIconsVue)) {
  app.component(key, component);
}

app.use(createPinia());
app.use(router);
app.use(ElementPlus);

app.mount("#app");

// 启动时检测 WebView 图片格式能力并通知后端，扩展后端支持列表（如 avif、heic）
getImageSupport()
  .then((support) => {
    const formats = getSupportedFormats(support);
    return invoke("set_supported_image_formats", { formats });
  })
  .catch(() => {
    // 非 Tauri 或 invoke 不可用时忽略
  });
