import { WINDOW_KIND } from "./windowKind";

// 入口分发：主窗口与壁纸窗口共用 index.html，按 ?window= 选择 bootstrap。
// 两套 bootstrap 用动态导入，保证壁纸窗口不会把主界面的组件库 / vant / 路由打进自己的 chunk。
if (WINDOW_KIND === "wallpaper") {
  void import("./bootstrap/wallpaper");
} else {
  void import("./bootstrap/app");
}
