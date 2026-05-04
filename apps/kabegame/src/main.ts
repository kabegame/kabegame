import { createApp } from "vue";
import { createPinia } from "pinia";
import ElementPlus from "element-plus";
import "element-plus/dist/index.css";
import * as ElementPlusIconsVue from "@element-plus/icons-vue";
import App from "./App.vue";
import router from "./router";
import "virtual:uno.css";
import "@kabegame/core/styles/anime-theme.css";
/** Vant：Toast 组件样式（按需引入时显式使用 showToast 必须带样式，见 Vant 文档） */
import "vant/lib/toast/style";
/** Vant 使用项目配色。若使用 Vant，请在其样式之后引入，顺序：anime-theme → vant 样式 → vant-theme */
import "@kabegame/core/styles/vant-theme.css";
import { vPullToRefresh } from "@kabegame/core/directives/pullToRefresh";
import { IS_ANDROID, IS_WEB } from "@kabegame/core/env";
import { Toast, Picker, Popup } from "vant";
import "vant/lib/picker/style";
import "vant/lib/popup/style";
import { registerHeaderFeatures } from "@/header/headerFeatures";
import { createMinAppVersionBeforeAddTaskGuard } from "@/composables/pluginMinAppVersionGate";
import { usePluginStore } from "@/stores/plugins";
import { setCrawlerBeforeAddTaskGuard } from "@kabegame/core/stores/crawler";
import { i18n } from "@kabegame/i18n";

if (IS_ANDROID) {
  document.documentElement.classList.add("platform-android");
}

const app = createApp(App);

app.directive("pull-to-refresh", vPullToRefresh);

// 注册所有图标
for (const [key, component] of Object.entries(ElementPlusIconsVue)) {
  app.component(key, component);
}

const pinia = createPinia();
app.use(pinia);
app.use(i18n);

setCrawlerBeforeAddTaskGuard(createMinAppVersionBeforeAddTaskGuard(usePluginStore()));
registerHeaderFeatures();
app.use(router);
app.use(ElementPlus);
app.use(Toast);
app.use(Picker);
app.use(Popup);

app.mount("#app");

// Native WebView 启动时检测图片格式能力并通知后端；web 模式由服务器固定支持 webp/avif。
if (!IS_WEB) {
  void import("@kabegame/core/stores/imageSupport").then(({ useImageSupportStore }) =>
    useImageSupportStore().detect(),
  );
}
