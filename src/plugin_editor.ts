import { createApp } from "vue";
import ElementPlus from "element-plus";
import "element-plus/dist/index.css";
import * as ElementPlusIconsVue from "@element-plus/icons-vue";

import PluginEditorApp from "./plugin-editor/PluginEditorApp.vue";
import "./styles/anime-theme.css";

const app = createApp(PluginEditorApp);

for (const [key, component] of Object.entries(ElementPlusIconsVue)) {
  app.component(key, component);
}

app.use(ElementPlus);

app.mount("#app");
