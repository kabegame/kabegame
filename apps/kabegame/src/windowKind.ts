import { IS_ANDROID, IS_WEB } from "@/env";

/**
 * 当前页面属于哪个窗口：壁纸窗口与主窗口加载同一个 `index.html`，壁纸窗口的 URL 带
 * `?window=wallpaper`（见 `src-tauri/kabegame/src/wallpaper/manager/window.rs`）。
 * Web 发布版与 Android 不存在壁纸窗口，硬门控为主窗口。
 */
export type WindowKind = "main" | "wallpaper";

export const WINDOW_KIND: WindowKind =
  !IS_WEB && !IS_ANDROID && new URLSearchParams(location.search).get("window") === "wallpaper" ? "wallpaper" : "main";
