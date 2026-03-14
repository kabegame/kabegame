export const IS_WINDOWS = __WINDOWS__;
export const IS_LINUX = __LINUX__;
export const IS_MACOS = __MACOS__;
export const IS_ANDROID = __ANDROID__;
export const IS_DEV = __DEV__;
// 从 __DESKTOP__ 常量计算 IS_PLASMA
export const IS_PLASMA = __DESKTOP__ === "plasma";
export const IS_GNOME = __DESKTOP__ === "gnome";
export const IS_LIGHT_MODE = __LIGHT_MODE__;

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
