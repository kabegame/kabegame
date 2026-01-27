import { createApp } from "vue";
import { createPinia } from "pinia";
import ElementPlus from "element-plus";
import "element-plus/dist/index.css";
import "vue-advanced-cropper/dist/style.css";
import * as ElementPlusIconsVue from "@element-plus/icons-vue";

import PluginEditorApp from "./plugin-editor/PluginEditorApp.vue";
import "@kabegame/core/styles/anime-theme.css";
import "virtual:uno.css";

const app = createApp(PluginEditorApp);

for (const [key, component] of Object.entries(ElementPlusIconsVue)) {
  app.component(key, component);
}

app.use(ElementPlus);
app.use(createPinia());

app.mount("#app");
