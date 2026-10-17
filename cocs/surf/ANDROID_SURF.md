# Android 畅游（Phase 1）

Android 畅游用于打开外部站点、完成登录，并把 Cookie 与签发 Cookie 时的 User-Agent 保存到
`surf_records`。V8 插件调用 `Kabegame.requireCookie()` 后会同时注入两者，避免
`cf_clearance` 等与 UA 绑定的 Cookie 因请求指纹不一致而失效。

本阶段只覆盖浏览、登录与会话保存，不包含一键下载、页面自发下载、媒体捕获、真实
`window.open` 弹窗或内容页脚本注入。

## Activity 与 WebView 边界

`SurfActivity` 位于 `MainActivity` 上方，关闭后直接回到原 Vue 页面。Activity 内是上下两段：

- 顶部 48dp 是 `WebviewWindowBuilder::activity_name("SurfActivity")` 创建的 Tauri
  `RustWebView`，加载与桌面相同的 `surf-navbar.html`，拥有 Tauri IPC。
- 下方是 `SurfActivity` 自建的普通 `android.webkit.WebView`，加载外部站点。它不调用
  `addJavascriptInterface`，不接收 Tauri 初始化脚本，外部页面没有应用 IPC 能力。

`created_by_activity_name` 必须传主窗口 `activity_name()` 的返回值，不能写死 `"MainActivity"`：
tao 用 `getLocalClassName()` 登记 Activity 名，类名不以 applicationId 开头时返回全限定名。dev 包
applicationId 为 `app.kabegame.dev`、类为 `app.kabegame.MainActivity`，登记的是全名，写死短名会匹配
失败，`build()` 报 `failed to create window`（prod 包恰好能匹配，所以只在 dev 出现）。新 Activity
的类查找走 Java 包路径 `app/kabegame/SurfActivity`，不受 applicationId 影响。

wry 的创建顺序是先把 `RustWebView` 交给 `onWebViewCreate`，配置 client 与 IPC，最后才调用
`setContentView(webview)`。因此组合布局必须在 `SurfActivity.setContentView` 中完成；若在
`onWebViewCreate` 改布局，随后会被 wry 覆盖。根布局统一消费 system bar、display cutout 与 IME
inset，键盘弹出时底部 padding 取 system bar 和 IME 的较大值。

## 会合与单会话

Rust 创建 Activity 和调用移动插件 `attach` 的先后不能作为约定。`SurfRegistry` 分别保存已就绪
Activity 与待绑定 `SurfBinding`：

1. Activity 先到时，按 navbar label 登记并等待 binding。
2. `attach` 先到时，保存 binding 并等待 Activity。
3. 两边齐备后，`bind` 才让内容 WebView 加载目标 URL。

Android 同时只维护一个畅游会话。Rust 的 `SESSION` 是会话状态权威，记录 `host`、record id 与
navbar label；导航命令必须匹配当前 host。新会话会先通过 Kotlin 插件关闭旧 Activity。事件闭包
还会核对 label。Android 每次启动都会给 navbar label 追加进程内唯一序号，防止同站点重开时旧
Activity 的迟到 `closed` 事件清掉新会话，也不依赖 Tauri 立即从窗口表移除旧 label。

## 命令与事件流

Vue 和 navbar 继续使用桌面命令名：`surf_start_session`、`surf_close_session`、
`surf_get_session_status`、`surf_go_back`、`surf_go_forward`、`surf_reload`、`surf_navigate`。
Android 实现位于 `commands/surf_android.rs`，通过内联 `SurfPlugin` 在 UI 线程操作内容 WebView。

Kotlin 通过 Rust 创建的 `tauri::ipc::Channel` 上报三类消息：

- `urlChanged { url }`：来自 `onPageStarted` / `doUpdateVisitedHistory`，Rust 定向发
  `surf-url-changed` 给对应 navbar。
- `pageFinished { url, cookie }`：刷新记录的 Cookie；只有值实际变化时才写库
  （`update_surf_record_cookie_if_changed`）并广播 `surf-records-change`。
- `closed { cookie }`：Activity 销毁前最后保存一次，随后清除 `SESSION` 并发
  `surf-session-changed { active: false }`。

移动端 Tauri 的全局 Channel 表目前不会回收 Rust 主动创建的 Channel，每个畅游会话会留下一个
闭包。这是已知的上游生命周期限制；单次体量很小，但后续升级 Tauri 时应复查。

## Cookie 与 UA 口径

内容页每次完成加载时记录同站 host 的已访问 URL。保存时依次读取初始根 URL和这些访问路径的
`CookieManager.getCookie(url)`，按 Cookie 名覆盖合并并排序。这样既能拿到 HttpOnly Cookie，也能
覆盖已经访问过的 `Path=/xxx` Cookie；从未访问过的其它 path-only Cookie 无法枚举，这是 Android
`CookieManager` API 的固有限制。第三方 Cookie 已开启，以兼容常见 SSO。

UA 不入库。内容 WebView 不修改 `userAgentString`，因此 Cookie（如 Cloudflare `cf_clearance`）的签发 UA
就是系统 WebView 默认 UA，同进程内所有 WebView 一致。`SurfPlugin` 注册时 Rust 异步调用 Kotlin
`getDefaultUserAgent`（`WebSettings.getDefaultUserAgent`），经
`kabegame_core::plugin::v8::set_android_webview_user_agent` 登记进 `OnceLock`，安卓上的
`Kabegame.cefUserAgent()` 返回它。插件沿用桌面写法：先 `setHeader("User-Agent", cefUserAgent())` 再
`requireCookie()`，UA 由插件显式决定，`requireCookie` 只注入 Cookie。

WebView 自动更新会改变 UA 里的 Chrome 版本（并重启进程），此前签发的 UA 绑定 Cookie 可能失效，需要
重新进畅游过一次验证；这与桌面升级 CEF 后的情况相同。若将来要为单个站点改 UA（如「桌面版网站」），
才需要按记录持久化 UA。

## 导航与限制

http/https 始终留在内容 WebView。`intent:` 仅接受 http/https 的 `browser_fallback_url`，其它 scheme
会被拦截。`setSupportMultipleWindows(false)` 保持单页语义，但依赖真实 WindowProxy 的 OAuth 弹窗
可能失败。Android navbar 不显示开发者工具和一键下载按钮；内容 WebView 只在 debug 构建启用
WebView debugging，可用 `chrome://inspect` 查看。

相关实现：

- `src-tauri/kabegame/src/commands/surf_android.rs`
- `src-tauri/kabegame/gen/android/app/src/main/java/app/kabegame/SurfActivity.kt`
- `src-tauri/kabegame/gen/android/app/src/main/java/app/kabegame/SurfPlugin.kt`
- `apps/kabegame/src/surf-navbar.ts`
