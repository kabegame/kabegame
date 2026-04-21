export const IS_WINDOWS = __WINDOWS__;
export const IS_LINUX = __LINUX__;
export const IS_MACOS = __MACOS__;
export const IS_ANDROID = __ANDROID__;
export const IS_WEB = __WEB__;
export const IS_DEV = __DEV__;
export const IS_LIGHT_MODE = __LIGHT_MODE__;

/**
 * 应用版本号。由 `apps/main/.env` 的 `VITE_APP_VERSION` 编译期注入，
 * 通过 `bun run set-version` 与 Cargo.toml 同步；所有平台（含 web）一致。
 */
export const APP_VERSION: string | null =
  (import.meta.env.VITE_APP_VERSION as string | undefined)?.trim() || null;

/**
 * 紧凑布局阈值（px）。viewport 宽度小于该值时触发移动式紧凑布局。
 * Android 原生应用恒为紧凑；Tauri 桌面永不紧凑；web mode 跟随视口。
 */
export const COMPACT_BREAKPOINT = 768;

/**
 * Android content:// URI 代理前缀。
 * 前端将 content:// 替换为此前缀，WebView shouldInterceptRequest 拦截后还原为 content:// 并流式返回。
 * Chromium 不允许网页直接加载 content:// 子资源，必须通过 HTTP scheme 代理。
 */
export const CONTENT_URI_PROXY_PREFIX = "http://kbg-content.localhost/";

/**
 * Android 本地文件代理前缀。
 * 用于 WebView 加载应用私有目录下的文件（如 GIF 缩略图）。
 * URL 格式：http://kbg-local.localhost/ + 绝对路径（需 encodeURIComponent 编码）。
 */
export const LOCAL_FILE_PROXY_PREFIX = "http://kbg-local.localhost/";
