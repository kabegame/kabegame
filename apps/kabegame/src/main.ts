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
import { IS_ANDROID } from "@kabegame/core/env";
import { Toast, Picker, Popup } from "vant";
import "vant/lib/picker/style";
import "vant/lib/popup/style";
import { registerHeaderFeatures } from "@/header/headerFeatures";
import { createMinAppVersionBeforeAddTaskGuard } from "@/composables/pluginMinAppVersionGate";
import { useApp } from "@/stores/app";
import { usePluginStore } from "@/stores/plugins";
import { setCrawlerBeforeAddTaskGuard } from "@kabegame/core/stores/crawler";
import { useImageSupportStore } from "@kabegame/core/stores/imageSupport";
import { setSuperGetter } from "@kabegame/core/state/superState";
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
// useApp 依赖 useSuper -> useRoute/useRouter，必须在 app.use(router) 之后首次实例化
const appStore = useApp();
setSuperGetter(() => appStore.isSuper);
app.use(ElementPlus);
app.use(Toast);
app.use(Picker);
app.use(Popup);

app.mount("#app");

// 启动时检测 WebView 图片格式能力并通知后端，扩展后端支持列表（如 avif、heic）
void useImageSupportStore().detect();
