// 壁纸窗口 bootstrap：只装 pinia、i18n、UnoCSS 与主题变量，根组件为 WallpaperWindow。
// 刻意不装 router / header features / crawler guard，
// 也不调用 settingsStore.loadAll()——壁纸窗口只经 IPC 读它需要的几个设置。
// tokens.css（`--kb-*` 与 `kb-*` 关键帧）要带上：桌面的 ImageContent 画加载进度、骨架与丢失图都用它，缺了文字退回黑色、
// 进度条与骨架看不见。它只有 :root 变量与关键帧，不碰窗口背景。颜色主题不在壁纸窗口应用（用默认主题的值）。
import { createApp } from "vue";
import { createPinia } from "pinia";
import { i18n } from "@kabegame/i18n";
import "virtual:uno.css";
import "@/styles/anime-theme.css";
import "@/styles/tokens.css";
import WallpaperWindow from "@/views/WallpaperWindow.vue";
import { invoke } from "@/api/rpc";
import { IS_LINUX } from "@/env";
import { startWindowPointerFeed } from "@/components/wallpaper/framePointer";

const app = createApp(WallpaperWindow);
app.use(createPinia());
app.use(i18n);
app.mount("#app");

// Linux 读不到全局光标。GNOME 下壁纸窗口是普通窗口、鼠标直接进来：页面把收到的鼠标交给应用，桌面上的网页 / 场景壁纸经它注入
// （同主窗口）。Plasma 下壁纸窗口是离屏的，收不到真实鼠标，这里不会发出任何东西。
if (IS_LINUX) {
  startWindowPointerFeed((pointer) => {
    void invoke("push_window_pointer", { ...pointer }).catch(() => {});
  });
}
