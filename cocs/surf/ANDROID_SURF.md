# Android 畅游（Phase 1 + Phase 2）

Android 畅游用于打开外部站点、完成登录，并把 Cookie 与签发 Cookie 时的 User-Agent 保存到
`surf_records`。V8 插件调用 `Kabegame.requireCookie()` 后会同时注入两者，避免
`cf_clearance` 等与 UA 绑定的 Cookie 因请求指纹不一致而失效。

Phase 2 之后内容页就是 Tauri webview，因此一键下载、页面自发下载、`blob:` / `data:` / MSE
捕获都与桌面共用同一套注入脚本与命令；导航栏改为 Kotlin 原生控件。

## Activity 与 WebView 边界

`SurfActivity` 位于 `MainActivity` 上方，关闭后直接回到原 Vue 页面。主次已对调：

- 内容页是 `WebviewWindowBuilder::new(..., WebviewUrl::External(url))` +
  `.activity_name("SurfActivity")` 创建的 **Tauri 主 webview**（label `surf-<host>:<n>`）。
  它拿到与桌面同一份 `initialization_script`、`on_page_load`，并用真实 Tauri `invoke` 与
  `Channel` 和后端通信，权限由 capability `surf-capability` 管。
- 顶部 48dp 是 `SurfToolbar`：后退、前进、刷新、地址栏、一键下载（运行中同一格换成转圈，
  点转圈即取消）、在浏览器打开、关闭。全部直接操作 `RustWebView`，不经 Rust 往返。

`created_by_activity_name` 必须传主窗口 `activity_name()` 的返回值，不能写死 `"MainActivity"`：
tao 用 `getLocalClassName()` 登记 Activity 名，类名不以 applicationId 开头时返回全限定名。dev 包
applicationId 为 `app.kabegame.dev`、类为 `app.kabegame.MainActivity`，登记的是全名，写死短名会匹配
失败，`build()` 报 `failed to create window`（prod 包恰好能匹配，所以只在 dev 出现）。

wry 的创建顺序是先把 `RustWebView` 交给 `onWebViewCreate`，配置 client 与 IPC，最后才调用
`setContentView(webview)`；首个 `loadUrl` 是 post 出去的，晚于 `setContentView`。因此组合布局与
IPC 替换都在 `SurfActivity.setContentView` 中完成。根布局统一消费 system bar、display cutout 与
IME inset，键盘弹出时底部 padding 取 system bar 和 IME 的较大值。

## IPC 主框架化

wry 安卓用 `addJavascriptInterface("ipc")`，**所有 frame** 都能调用，而上报给 Tauri 做 ACL 的
URL 取自主框架最近一次 `onPageStarted` 的地址。外部页面成为 Tauri webview 后，页面里的第三方
iframe 会冒用主页面身份。

`SurfActivity` 在 `setContentView` 里 `removeJavascriptInterface("ipc")`，改用
`WebViewCompat.addWebMessageListener(webView, "ipc", setOf("*"))`：JS 侧仍是
`window.ipc.postMessage(string)`，Tauri 的 `ipc-protocol.js` 无感；Kotlin 丢弃非主框架消息，并以
当前主框架 URL 调用 `Rust.ipc`。回调在 UI 线程，`Rust.ipc` 移进单线程 executor——同步命令若再经
MainPipe 等主线程会死锁。设备不支持 `WEB_MESSAGE_LISTENER` 时**关闭 IPC**（只能浏览、不能一键
下载），不回退到所有框架可见的通道；`attach` 把 `ipcAvailable` 回传给 Rust，一键下载按钮据此
提示 `surf.collect.ipcUnavailable`。

## 注入脚本顶层守卫

桌面 Tauri 的 `initialization_script` 只进主框架；wry 安卓用
`addDocumentStartJavaScript(…, setOf("*"))`，脚本会进 iframe。`surf_common::surf_initialization_scripts()`
在安卓上给每段脚本包一层 `if (window.top !== window) return;`，与桌面行为一致；安卓没有导航栏，
`surf_url_report.js` 不注入（地址由原生工具栏直接读 `doUpdateVisitedHistory` / `onPageStarted`）。

## 会合与单会话

Rust 创建 Activity 和调用移动插件 `attach` 的先后不能作为约定。`SurfRegistry` 分别保存已就绪
Activity 与待绑定 `SurfBinding`：

1. Activity 先到：按 label 登记并等待 binding。
2. `attach` 先到：保存 binding 与 invoke，等 `setContentView` 完成 IPC 替换后再一起 resolve
   （这样 Rust 才拿得到 `ipcAvailable`）。Rust 侧对 `attach` 设 10s 超时，超时销毁窗口并报错。
3. 两边齐备后，`bind` 让工具栏拿到文案与初始地址。

Android 同时只维护一个畅游会话。Rust 的 `SESSION` 是会话状态权威，记录 `host`、record id、
label 与 `ipc_available`。新会话会先通过 Kotlin 插件关闭旧 Activity；事件闭包还会核对 label。
每次会话的 label 追加进程内序号（`surf-<host>:<n>`），防止同站点重开时旧 Activity 的迟到
`closed` 事件清掉新会话，也不依赖 Tauri 立即从窗口表移除旧 label。

## 命令与事件流

Vue 继续使用桌面命令名：`surf_start_session`、`surf_close_session`、`surf_get_session_status`。
导航（后退 / 前进 / 刷新 / 地址跳转）不再有 Rust 命令，由原生工具栏直接操作 WebView。

Kotlin 通过 Rust 创建的 `tauri::ipc::Channel` 上报四类消息：

- `pageFinished { url, cookie }`：刷新记录的 Cookie；只有值实际变化时才写库
  （`update_surf_record_cookie_if_changed`）并广播 `surf-records-change`。
- `closed { cookie }`：Activity 销毁前最后保存一次，随后清除 `SESSION`、会话 VFS 目录
  （`surf_session::drop_session`）与一键下载槽位（`surf_collect::drop_slot`），并发
  `surf-session-changed { active: false }`。
- `collectToggle`：原生工具栏的一键下载按钮，Rust 调 `surf_collect::toggle(label)`。
- `pageDownload { url, suggestedName, mimeType }`：`setDownloadListener` 拦到的页面自发下载。

Rust → Kotlin 侧：`attach`、`close`、`setCollectRunning`、`getDefaultUserAgent`。

## 下载：脚本下载与页面下载

桌面的畅游下载交给 CEF 原生下载，浏览器自己带 Cookie；安卓没有这条路。两类下载收敛到
`surf_receive::enqueue_surf_download`：

- **脚本发起**（一键下载、长按菜单、`surf_bootstrap.js` 的 `triggerDownload`）照旧
  `invoke("surf_download_image")`。
- **页面自发**（WebView 判定为附件的导航）由 `setDownloadListener` 拦截，交给 Rust。
  Rust 先按文件名（`is_media_by_path`）和 MIME（`is_supported_media_mime`）判断是否为支持的
  图片或视频，不是（含 zip / 7z / tar 等压缩包）就直接 toast 拒绝、不发起下载；是就走同一个
  入队函数。压缩包不解压：解压属于各爬虫插件自己的事（`Kabegame.archive`），畅游只收媒体。

入队前安卓会补三个头，平台补的头覆盖页面给的：

- `Cookie`：SurfPlugin `getCookie` 读 `CookieManager.getCookie(媒体 URL)`（含 HttpOnly，空则不加头），
  Rust 入口 `surf_android::cookie_header_for_url`。**不要用 wry 的 `cookies_for_url`**：wry 生成的
  `RustWebView.getCookies` 把返回值声明为非空 `String`，没有 Cookie 的 URL（媒体 CDN 如 `i.pximg.net`
  很常见）返回 null 时会在主线程抛 NPE，应用直接崩溃。
- `User-Agent`：Phase 1 登记的系统 WebView UA（`android_webview_user_agent()`）。
- `Referer`：`webview.url()`。

`data:` / `blob:` 的页面下载，Rust 在页面外取不到字节，转回页面里 `media_download.js` 已有的
`__kb_media_download__`，与 `surf_bootstrap.js` 的 `triggerDownload` 同口径。其它 scheme 提示
`surf.download.unsupportedScheme`。

`is_native_job` 在安卓上不再把 `surf_record_id` 当作 native（没有 CEF 下载 handler），改由
reqwest 下载并直接入图库；终态 toast 由 `DownloadState` 的统一分支经 `surf_toast_for_host`
返回页内。

## raw body 的 JSON 兼容

Tauri 在安卓上没有自定义协议 IPC（`ipc-protocol.js`：`canUseCustomProtocol = osName !== 'android'`），
`Uint8Array` 作为 invoke 参数时经 `JSON.stringify` 变成 JSON 数字数组，到 Rust 是
`InvokeBody::Json`。`page_fs::raw_body_bytes` 同时接受 `Raw` 与数组（值必须 0–255），
`media_download.js` 的 `blob:` / MSE 分块写因此原样复用。代价是体积约膨胀 3–4 倍，所以安卓上的
写块从 8 MiB 降到 1 MiB（避免把 ~30 MB 的 JSON 字符串经 JNI 送一次）。

## Cookie 与 UA 口径

内容页每次完成加载时记录同站 host 的已访问 URL。保存时依次读取初始根 URL 和这些访问路径的
`CookieManager.getCookie(url)`，按 Cookie 名覆盖合并并排序。这样既能拿到 HttpOnly Cookie，也能
覆盖已经访问过的 `Path=/xxx` Cookie；从未访问过的其它 path-only Cookie 无法枚举，这是 Android
`CookieManager` API 的固有限制。第三方 Cookie 已开启，以兼容常见 SSO。

UA 不入库。内容 WebView 不修改 `userAgentString`，因此 Cookie（如 Cloudflare `cf_clearance`）的签发 UA
就是系统 WebView 默认 UA，同进程内所有 WebView 一致。`SurfPlugin` 注册时 Rust 异步调用 Kotlin
`getDefaultUserAgent`（`WebSettings.getDefaultUserAgent`），经
`kabegame_core::plugin::v8::set_android_webview_user_agent` 登记进 `OnceLock`，安卓上的
`Kabegame.cefUserAgent()` 与畅游下载补的 `User-Agent` 都返回它。

WebView 自动更新会改变 UA 里的 Chrome 版本（并重启进程），此前签发的 UA 绑定 Cookie 可能失效，需要
重新进畅游过一次验证；这与桌面升级 CEF 后的情况相同。

## 导航与限制

http/https 始终留在内容 WebView。`intent:` 仅接受 http/https 的 `browser_fallback_url`，其它 scheme
会被拦截；`on_navigation` 与 Kotlin 包装 client 同口径。`setSupportMultipleWindows` 走系统默认
（false），保持单页语义，但依赖真实 WindowProxy 的 OAuth 弹窗可能失败。内容 WebView 只在 debug
构建启用 WebView debugging，可用 `chrome://inspect` 查看。

已知限制 / 待复查：

- wry 安卓没有 `on_download`、`on_new_window`；下载与弹窗分别由 `setDownloadListener` 与单页
  语义兜底。
- 移动端 `Channel::new_with_id` 会对 Rust 主动创建的 Channel 调 `register_channel`，`CHANNELS`
  表只增不减。当前上游已按 webview 回收 `ChannelDataIpcQueue`，但 Channel 闭包本身仍需在升级
  Tauri 时复查。
- `reqwest` 与浏览器指纹不同，个别 CDN 在 Cookie / UA / Referer 都正确时仍可能拒绝。
- 长按菜单依赖页面的 `contextmenu` 事件；安卓 WebView 长按图片是否派发该事件未在真实站点系统验证。
  未派发时不影响一键下载与 `setDownloadListener`，只是长按菜单不出现。
- 大响应经 `fetch` 取数据：已用 `use_https_scheme(true)` 避开 https 页面的混合内容限制，
  `ipc` 自定义协议响应带 `Access-Control-Allow-Origin: *`。

相关实现：

- `src-tauri/kabegame/src/commands/surf_android.rs`
- `src-tauri/kabegame/src/commands/surf_common.rs`（label 解析、注入脚本、页内 toast）
- `src-tauri/kabegame/src/commands/page_fs.rs`（`crawl_fs_*` / `crawl_ffmpeg_*`，全平台）
- `src-tauri/kabegame/src/commands/surf_receive.rs`（下载入队与安卓补头）
- `src-tauri/kabegame/gen/android/app/src/main/java/app/kabegame/SurfActivity.kt`
- `src-tauri/kabegame/gen/android/app/src/main/java/app/kabegame/SurfToolbar.kt`
- `src-tauri/kabegame/gen/android/app/src/main/java/app/kabegame/SurfPlugin.kt`
- `apps/kabegame/src/surf-navbar.ts`（仅桌面）
