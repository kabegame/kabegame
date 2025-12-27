import { createApp } from "vue";
import { createPinia } from "pinia";
import ElementPlus from "element-plus";
import "element-plus/dist/index.css";
import * as ElementPlusIconsVue from "@element-plus/icons-vue";
import App from "./App.vue";
import router from "./router";
import "./styles/anime-theme.css";

const app = createApp(App);

// 在开发环境中启用 Vue DevTools
if (import.meta.env.DEV) {
  // 连接 Vue DevTools
  // 方式1: 如果已安装浏览器扩展，会自动连接
  // 方式2: 如果需要使用独立应用，请先运行: npx @vue/devtools
  //        然后取消下面的注释来连接独立应用
  import("@vue/devtools").then((devtools) => {
    try {
      // 尝试连接到 DevTools（浏览器扩展或独立应用）
      devtools.connect();
      console.log("Vue DevTools: 已连接");
    } catch (error) {
      console.log("Vue DevTools: 未检测到连接，请安装浏览器扩展或运行 'npx @vue/devtools'");
    }
  }).catch(() => {
    console.log("Vue DevTools: 未安装，请运行 'npm install -D @vue/devtools'");
  });
}

// 注册所有图标
for (const [key, component] of Object.entries(ElementPlusIconsVue)) {
  app.component(key, component);
}

app.use(createPinia());
app.use(router);
app.use(ElementPlus);

app.mount("#app");
