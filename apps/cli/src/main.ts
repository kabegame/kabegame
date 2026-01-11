import { createApp } from "vue";
import ElementPlus from "element-plus";
import "element-plus/dist/index.css";
import * as ElementPlusIconsVue from "@element-plus/icons-vue";
import "@kabegame/core/styles/anime-theme.css";

import App from "./ui/App.vue";

const app = createApp(App);

// 注册所有图标（与 main 对齐）
for (const [key, component] of Object.entries(ElementPlusIconsVue)) {
  app.component(key, component);
}

app.use(ElementPlus).mount("#app");
