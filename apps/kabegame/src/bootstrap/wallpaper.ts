// 壁纸窗口 bootstrap：只装 pinia、i18n、UnoCSS 与主题变量，根组件为 WallpaperWindow。
// 刻意不装 router / ElementPlus / vant / header features / crawler guard，
// 也不调用 settingsStore.loadAll()——壁纸窗口只经 IPC 读它需要的几个设置。
import { createApp } from "vue";
import { createPinia } from "pinia";
import { i18n } from "@kabegame/i18n";
import "virtual:uno.css";
import "@/styles/anime-theme.css";
import WallpaperWindow from "@/views/WallpaperWindow.vue";

const app = createApp(WallpaperWindow);
app.use(createPinia());
app.use(i18n);
app.mount("#app");
