# 评估：给 Tauri 安卓补 child webview（多 webview）

> 结论（2026-10-18）：**不打补丁。** 安卓畅游改为「内容页是 `SurfActivity` 的 Tauri 主 webview，
> 导航栏是原生控件」。页面自发下载由 `setDownloadListener` 拦截后交给 Rust 带头下载；脚本到 Rust 的
> 其余通信一律走真实 Tauri `invoke`。实施见 [phase2.md](phase2.md)。原 Phase 2 的
> `__TAURI_INTERNALS__` 垫片方案作废。

## 背景

Phase 1 的 `SurfActivity` 上方是 Tauri webview（复用桌面 `surf-navbar.html`），下方是普通
`android.webkit.WebView`。内容页不是 Tauri webview，所以桌面那套按 webview label 工作的注入脚本和命令
都用不上，原 Phase 2 只好自建垫片和消息桥。评估的问题是：能否像桌面一样，在同一个 Activity 里用
`Window::add_child` 放两个 Tauri webview。

## Tauri 2.12 在安卓上的现状

| 能力 | 安卓 | 依据 |
|---|---|---|
| 多窗口 = 多 Activity | ✅ `WebviewWindowBuilder::activity_name` / `created_by_activity_name` | `tauri/src/webview/webview_window.rs:1525`；tao 经创建者 Activity 的 `startActivity(Class)` 拉起，最多等 5s |
| 多 webview（`Window::add_child`） | ❌ | `#[cfg(any(test, all(desktop, feature = "unstable")))]`（`tauri/src/window/mod.rs:1224`） |
| `Webview::set_bounds` / `set_size` / `set_position` / `hide` / `show` | ❌ | 在 `#[cfg(desktop)] impl` 块（`tauri/src/webview/mod.rs:1621`） |
| wry `build_as_child` | ❌ 文档标 Unsupported | 安卓 `new_as_child` 直接调 `new`，最后照样 `setContentView` 换掉整个 Activity 内容（`wry-0.57.0/src/android/mod.rs:157`） |

runtime 层其实已经准备好了：`tauri-runtime-wry` 在安卓上对 `WindowChild` 已经调用 `build_as_child`
（`lib.rs:5182`）；插件加载钩子 `PluginManager.onWebViewCreated` 对已加载的插件不会重复加载。

## 要补哪几层

### 1. Tauri（小）
- 放开 `add_child` 的 `desktop` 门控（kabegame 安卓构建已启用 `unstable`）。
- 把 `Webview` 的布局 setter 从 `#[cfg(desktop)]` 块里挪出来给安卓用。
- 已有 `third/tauri` + `third-patches/tauri`，估计几十行。

### 2. wry Rust（主要工作量）
wry 安卓现在的模型是**一个 Activity 一个 webview**：
- `ActivityProxy.webview: Option<GlobalRef>` 只有一个槽（`main_pipe.rs`）。
- Rust→Kotlin 的十几种消息（`Eval`、`LoadUrl`、`GoBack`、`GetCookies`……）都是
  `MainPipe::send(activity_id, msg)`，处理时 `get_webview(activity_id)`，要全部改为按
  `(activity_id, webview_id)` 路由。
- `WEBVIEW_ATTRIBUTES` 以 `ActivityId` 为键（配置变更时重建 webview 用），子 webview 会覆盖主 webview
  的属性，要改成按创建顺序的列表。
- 安卓 `InnerWebView` 没有 `Drop`，单个 webview 没有销毁路径；`OnDestroy` 会连 `ActivityProxy`
  一起删。要新增 `DestroyWebView`，否则 `Webview::close()` 会泄漏子 view。
- `set_bounds` / `set_visible` / `focus` 是空实现，需要真实现。
- Kotlin→Rust 方向（`ipc`、`shouldOverride`、`onPageLoading`、`handleRequest`……）已经按
  webview id 分发，不用动。

### 3. wry Kotlin 模板（影响面最大）
- `WryActivity` 只有一个 `mWebView`，返回键和 `onDestroy` 只认它。要改成 `FrameLayout` 容器 +
  `addChildWebView` / `setChildBounds` / `removeChildWebView`。
- 模板由 wry `build.rs` 生成到 `gen/android/.../generated/`，改动会落到**所有** Activity，包括
  `MainActivity`；我们在 `MainActivity` 里对 WebView client 的包装、安全区注入都要回归。

### 4. tao（不补则布局难用）
- 安卓 `inner_size()` = `outer_size()` = `MonitorHandle.size()`，整块屏幕，不扣系统栏、刘海、IME
  （`tao-0.37.1/src/platform_impl/android/mod.rs:723`）。
- `on_window_resized` 是注释掉的（`ndk_glue.rs:760` 起），旋转、弹键盘时没有 `Resized`。
- Tauri 的子 webview 是「Rust 按坐标摆放」模型，拿不到可用尺寸就只能在 Kotlin 侧另做停靠布局。

### 5. 依赖接线
wry、tao 现在都来自 crates.io（`tauri-runtime-wry`：`wry = "0.57.0"`、`tao = "0.37.0"`）。
要新增 `third/wry`（可能还有 `third/tao`）子模块、`third-patches/<dir>/` 序列和
`[patch.crates-io]`；每次升级 Tauri 都要一起 re-vendor。wry 安卓代码迭代快，补丁漂移概率高。

规模估计：wry Rust + Kotlin 400–600 行，Tauri 几十行，tao 视方案几十到上百行。

## 补完能换来什么、换不来什么

**能换来：** 内容页成为 Tauri webview，桌面 `surf.rs` 的 `initialization_script`、`on_page_load`、
`eval`、`navigate`、按 label 认会话的 `surf_collect_*` 基本原样可用，权限回到 capability 体系。

**换不来**（wry 安卓本来就没有，与是否 child webview 无关）：
- `on_download`：wry 安卓没有任何下载处理，`with_download_started_handler` 被忽略（见下节）。
- `on_new_window`：没有 new-window 处理。
- `cookies()` 返回空 `Vec`；`set_cookie` / `delete_cookie` 是空实现。`cookies_for_url` 可用。
- CEF 原生下载 transport 不存在，下载仍要走 reqwest 并自己补头。

**还会多一个安全问题：** wry 安卓 IPC 是 `addJavascriptInterface("ipc")`，**所有框架**可见；上报给
Tauri 做 ACL 的 URL 是 `RustWebViewClient.currentUrl`，即主框架最近一次 `onPageStarted` 的地址。
外部页面成为 Tauri webview 后，页面里的第三方 iframe 调用 `ipc.postMessage` 会被当成主页面来源。
选定方案同样受影响，缓解办法见 phase2.md 点 3（不改 wry，在 `SurfActivity` 里替换 IPC 通道）。

## 安卓 WebView 能做 `on_download` 吗

能做「下载通知」，做不了 Tauri 要求的「引擎代下载」。

安卓只有 `WebView.setDownloadListener(DownloadListener)`：

```kotlin
webView.setDownloadListener { url, userAgent, contentDisposition, mimeType, contentLength ->
    // WebView 判定这次导航是下载（Content-Disposition: attachment 或渲染不了的 MIME），
    // 取消导航后只交出这几个参数；没有响应体，之后它什么都不管。
}
```

| | 桌面（CEF / WebView2 / WKWebView） | 安卓 WebView |
|---|---|---|
| 谁收字节 | 浏览器引擎，复用页面同一网络会话 | 应用**重新请求一次** |
| `Requested { url, destination }` | 应用改写 destination，引擎写到那里 | 没有目的地的概念 |
| `Finished { path, success }` | 引擎写完后通知 | 不存在，由应用自己的下载决定 |
| POST 表单触发的下载 | 正常 | 只给 URL，请求体丢失，重发 GET 可能失败 |
| `blob:` URL | 引擎可直接落盘 | 只在页面渲染进程内有效，应用在外面取不到 |
| 一次性 / 签名 URL | 只请求一次 | 页面那次已取消，重发是第二次，可能失效 |
| 请求指纹 | 浏览器本身 | 应用的 HTTP 栈，TLS / HTTP2 指纹不同 |

wry 的 `DownloadEvent::Requested` 承诺「引擎把文件写到 destination」，安卓兑现不了，所以 wry 安卓没接
（`wry-0.57.0/src/android/` 下没有任何 download 代码）。因此即使内容页是 Tauri webview，`surf.rs`
里挂的 `on_download` 闭包在安卓上也永远不会被调用。

可行做法是绕过 wry 自己接：`setDownloadListener` 拿到 URL 和文件名，Rust 用 reqwest 补上 Cookie /
UA / Referer 重新下载，再走桌面页面下载的收尾。覆盖不到的：`blob:` 要靠页面内脚本取字节；POST 触发的
下载和一次性 URL 列为已知限制。

## 方案对比与决定

| 方案 | 第三方补丁 | 导航栏 | 桌面内容页代码复用 | 主要风险 |
|---|---|---|---|---|
| A. 原 Phase 2：普通 WebView + 垫片 | 无 | 复用 HTML | 脚本复用；Rust 要大改造，垫片协议自维护 | 垫片与 Tauri Channel 协议同步 |
| B. 补 child webview | Tauri + wry（+ tao） | 复用 HTML | 大部分 | 补丁维护、波及整个安卓应用、iframe 来源 |
| **C. 内容页做 Tauri 主 webview，导航栏原生（选定）** | 无 | Kotlin 原生 | 大部分 | iframe 来源（可在 Kotlin 侧缓解） |

选 C 的理由：拿到 B 的主要收益（内容页是 Tauri webview，桌面脚本和命令按 label 原样工作），而所有
改动都在自己的代码里，不碰第三方仓库，也不影响 `MainActivity`。代价是导航栏用 Kotlin 重写几个按钮，
不再复用 `surf-navbar.html`。B 只有在安卓出现第二个「一屏多 Tauri webview」需求、且准备同时补齐
download / new-window / IPC 来源并推给上游时才值得重新评估。
