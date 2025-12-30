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
  import("@vue/devtools")
    .then((devtools) => {
      try {
        // 新版 @vue/devtools 的类型定义可能不再暴露 connect；这里做运行时兼容
        const anyDevtools = devtools as any;
        if (typeof anyDevtools?.connect === "function") {
          anyDevtools.connect();
          console.log("Vue DevTools: 已连接");
        } else {
          // 浏览器扩展通常会自动连接；独立应用也可自行连接
          console.log("Vue DevTools: 已加载（connect API 不可用/无需手动连接）");
        }
      } catch {
        console.log("Vue DevTools: 未检测到连接，请安装浏览器扩展或运行 'npx @vue/devtools'");
      }
    })
    .catch(() => {
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
