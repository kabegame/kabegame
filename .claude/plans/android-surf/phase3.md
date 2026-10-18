# 安卓畅游 Phase 3：工具栏导航状态、真实加载进度、OAuth 弹窗、桌面版网站

> 前置：Phase 2 已落地并完成收尾验证（内容页为 `SurfActivity` 的 Tauri 主 webview、原生工具栏、
> 主框架 IPC、下载补头，见 `cocs/surf/ANDROID_SURF.md`）。
> 范围：后退 / 前进按钮按历史置灰；地址栏下方显示真实加载进度；脚本 `window.open` 打开的弹窗
> （Google Identity Services 等 OAuth）在 Activity 内以覆盖层承载，保留真实 `WindowProxy`；
> 工具栏「更多」菜单里的「桌面版网站」开关，按站点记住，插件与下载补头随之换成同一个桌面 UA；
> 页面自发的 apk 安装包下载直接拦截。
> **不含**：弹窗内的一键下载与页面下载、tao `getCurrentWindowMetrics` JNI 局部引用残留、
> POST 触发的下载、强制桌面视口（见「风险」8）。

### 总体设计思路

导航状态、进度、弹窗三件事只动 Kotlin，Rust 只多下发文案；桌面版网站跨 Kotlin、Rust、core 与存储，
放在后面单独说明。前三件事都依赖同一个前提：拿到内容页的
`WebChromeClient` 回调。wry 在 `setContentView` 之前已经给 `RustWebView` 装好了自己的
`RustWebChromeClient`（全屏视频、权限、文件选择、JS 对话框、标题上报都在里面），它是 Kotlin 默认
`final` 类，不能继承。做法与 Phase 2 包装 `WebViewClient` 相同：在 `SurfActivity.setContentView`
里取出现有 client，装一个逐方法转发的 `SurfChromeClient`，只额外实现 `onProgressChanged` 与
`onCreateWindow`。

导航状态和进度是纯展示：`SurfToolbar` 增加 `setNavigationState(canGoBack, canGoForward)` 和
`setProgress(0..100)`，由 `SurfActivity` 在 `onPageStarted` / `onPageFinished` /
`doUpdateVisitedHistory`（SPA 前进后退只走这里）和 `onProgressChanged` 里推送。原来的
`setLoading(Boolean)` + 不定进度条删掉。系统返回键行为不变。

弹窗是本期的主体。现在 `setSupportMultipleWindows` 走默认 false，`target=_blank` 和
`window.open` 都在当前页打开，依赖 opener 的 OAuth 流程（弹窗登录后 `postMessage` 回 opener 再
`window.close()`）因此失败。开启多窗口后，所有新窗口请求都进 `onCreateWindow`，这里按来源分流：

- **用户点链接**（命中测试是锚点、`isUserGesture`、锚点 href 为 http/https）：这是普通的
  「新标签页打开」，保持单页语义，把目标 URL 交回内容页加载。pixiv 等站点的作品链接大量使用
  `target=_blank`，若一律弹出覆盖层，一键下载和长按菜单都会失效。
- **其余**（脚本 `window.open`，包括 GIS 按钮这种位于跨域 iframe 里的点击）：新建一个**普通**
  `android.webkit.WebView` 作为 transport 目标，放在内容区之上的覆盖层 `SurfPopup` 里显示，
  带一条显示来源 host 的标题栏和关闭按钮。页面 `window.close()` 经 `onCloseWindow` 关掉它。

链接分流需要拿到目标 URL，而 `onCreateWindow` 本身不给 URL。做法是同样先建 transport 目标，但
先不显示；它的第一次 `onPageStarted` 拿到 URL 后，`stopLoading`、销毁弹窗，把 URL 交给内容页。
这样无论锚点里包的是文字还是图片（`SRC_IMAGE_ANCHOR_TYPE` 的 `extra` 是图片地址而非 href）都能拿到
真实目标。

桌面版网站解决的是「移动 UA 下站点不给登录」：不少站点对移动 UA 直接跳应用商店、`intent:` 唤起
或下发 apk，网页登录入口被藏起来；Google 还会按 UA 里的 `; wv` 标记拒绝 WebView 内的 OAuth
（`disallowed_useragent`），所以弹窗登录 Google 在移动模式下大概率也走不通。切到桌面版就是把
内容页的 UA 换成与当前 WebView 同 Chrome 大版本的桌面 Linux UA（与 Chrome Android「桌面版网站」
同一套写法），同时把 UA Client Hints 的 `mobile` / `platform` 改成桌面值，并开启宽视口与缩放。

难点不在切换本身，而在 Cookie 与 UA 的配对。`cf_clearance` 这类 Cookie 绑定签发时的 UA，Phase 1
因此规定内容页不改 UA、`cefUserAgent()` 恒为系统默认 UA。打破这条之后，配对关系必须落到每个站点上：
`surf_records` 新增 `desktop_mode`，切换时写库；桌面 UA 只由 core 从已登记的系统默认 UA 派生
（`android_desktop_user_agent()`，唯一实现），Rust 建内容页时经 `WebviewWindowBuilder::user_agent`
直接给出，首个请求就是桌面 UA（强制跳转往往发生在首个请求），切换时再经 `attach` 下发给 Kotlin。
消费端有三处，全部按记录取 UA：

- **畅游下载补头**（`android_identity_headers`）：当前会话是桌面模式就补桌面 UA。
- **插件 `requireCookie(host)`**：记录是桌面模式时，顺带把任务的 `User-Agent` 换成桌面 UA，但只替换
  「缺失或等于系统默认 UA」的值。现有插件都是先 `setHeader("User-Agent", cefUserAgent())` 再
  `requireCookie`，因此无需改插件就能配对；插件写死的 UA（xhs、kemono、bilibili）和网页收集里用户
  显式填写的 UA 不被覆盖。
- **弹窗**：UA 与 Client Hints 跟随内容页当前模式，弹窗里签发的 Cookie 也配对。

apk 拦截是同一问题的另一半：页面自发下载里，安装包既不是媒体也不在压缩包名单，现状会被入队、下载完
才在后处理报「格式不受支持」。Phase 3 在 `on_page_download` 里按扩展名 / MIME 提前拒绝，toast 提示
可以在「更多」菜单切到桌面版网站。

关键决策：

1. **弹窗是普通 WebView，不是 Tauri webview。** 弹窗里是第三方登录页，不需要也不应该有 IPC、注入
   脚本或下载命令。它与内容页同进程，共享 `CookieManager`，UA 与 Client Hints 跟随内容页当前模式，
   登录后写下的 Cookie 和签发 UA 仍然配对；弹窗关闭时补发一次 `pageFinished`，让 Rust 立即保存
   Cookie，不必等用户再导航。
2. **同时最多一个弹窗，弹窗里不再开窗。** 弹窗 `setSupportMultipleWindows(false)`，弹窗内再
   `window.open` 就在弹窗自身打开；内容页再开新弹窗时先关掉旧的。OAuth 场景用不到更深的层级，
   单层让返回键和生命周期都简单。
3. **工具栏始终作用于内容页。** 弹窗有自己的标题栏（host + 关闭），工具栏的地址、后退、一键下载
   不跟随弹窗切换，避免两套页面状态在一个地址栏里来回跳。系统返回键优先作用于弹窗：弹窗能后退就后退，
   否则关闭弹窗；没有弹窗时与现在一致。
4. **转发而不是替换 `RustWebChromeClient`。** 它承担的全屏、权限、文件选择等行为要原样保留；代价是
   升级 wry 时要核对它新增的 override 是否已转发（列入风险）。
5. **桌面模式按站点持久化，存模式不存 UA 串。** 存 UA 串会在 WebView 升级后留下旧 Chrome 版本；存
   布尔、每次由当前默认 UA 派生，内容页、插件、下载补头始终是同一个串。WebView 升级后 Cookie 需要
   重新签发，与移动模式、与桌面升级 CEF 时相同。
6. **配对在宿主侧完成，不改插件 API。** `cefUserAgent()` 没有 host 参数，无法按站点返回；把替换放进
   `requireCookie(host)`，所有已发布插件立即生效。替换规则只碰宿主给出的默认 UA，不碰插件或用户的
   显式选择。
7. **开关进「更多」菜单，不再加图标。** 工具栏已有 6 个按钮，「在浏览器打开」与「桌面版网站」一起
   收进 ⋮ 弹出菜单（Chrome Android 同样把「桌面版网站」放在菜单里），地址栏宽度反而变大。切换由
   Kotlin 立即生效并刷新，再发 `desktopModeChanged` 给 Rust 落库；Rust 不回推，Kotlin 是这个开关的
   显示状态权威，记录是持久化权威。

```
                         SurfActivity
┌──────────────────────────────────────────────────────────┐
│ 原生工具栏  ← → ⟳ [地址]  ⤓  ⋮  ✕   ⋮ = 在浏览器打开 / ☐ 桌面版网站 │
│ ▓▓▓▓▓▓▓░░░░░░  确定进度（onProgressChanged，100 隐藏）          │
├──────────────────────────────────────────────────────────┤
│ FrameLayout（内容区）                                        │
│  ├ RustWebView（Tauri，label surf-<host>:<n>）               │
│  │   chromeClient = SurfChromeClient(delegate = RustWebChromeClient)
│  └ SurfPopup（覆盖层，可选，最多一个）                          │
│      [accounts.google.com            ✕]                    │
│      普通 WebView（无 IPC / 无注入脚本，共享 CookieManager）     │
└──────────────────────────────────────────────────────────┘

 onCreateWindow ─┬ 锚点 + 用户手势 ─► 隐藏的 transport 目标，首个 onPageStarted 取 URL
                 │                     ─► stopLoading + 销毁 ─► content.loadUrl(url)
                 └ 其它（window.open）─► SurfPopup 显示 ─► onCloseWindow / ✕ / 返回键 关闭
                                                         └► emit("pageFinished") 保存 Cookie

 ⋮ 桌面版网站 ─► Kotlin：UA / Client Hints / 宽视口 → reload ─► emit("desktopModeChanged")
                 ─► Rust：SESSION.desktop_mode + surf_records.desktop_mode
 下次打开该站 ─► surf_start_session：builder.user_agent(android_desktop_user_agent())
 插件 requireCookie(host) ─► 记录为桌面模式 ─► User-Agent 缺失或为默认 UA 时换成桌面 UA
 畅游下载补头 ─► 会话为桌面模式 ─► User-Agent = 桌面 UA
```

### 现状锚点

**a. 工具栏只有不定进度条，后退 / 前进没有禁用态**（`SurfToolbar.kt`）
```kotlin
private val loadingBar = ProgressBar(context, null, android.R.attr.progressBarStyleHorizontal).apply {
  isIndeterminate = true          // 现状：不定进度，只表示「在加载」
  visibility = View.GONE
  progressTintList = ColorStateList.valueOf(accent)
  minimumHeight = dp(2)
}

fun setLoading(loading: Boolean) {  // 现状：唯一的加载状态入口
  loadingBar.visibility = if (loading) View.VISIBLE else View.GONE
}
```

**b. 后退 / 前进只在点击时判断**（`SurfActivity.kt`，`setContentView`）
```kotlin
toolbar = SurfToolbar(this).apply {
  onBack = { if (content.canGoBack()) content.goBack() }        // 现状：不能后退时按了没反应
  onForward = { if (content.canGoForward()) content.goForward() }
  ...
}
```

**c. 加载状态来自包装后的 `WebViewClient`**（`SurfActivity.wrapWebViewClient`）
```kotlin
override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
  delegate.onPageStarted(view, url, favicon)
  url?.let { toolbar.setUrl(it) }
  toolbar.setLoading(true)            // 现状：只开不定进度条
}

override fun onPageFinished(view: WebView, url: String?) {
  delegate.onPageFinished(view, url)
  toolbar.setLoading(false)
  ...
}

override fun doUpdateVisitedHistory(view: WebView, url: String?, isReload: Boolean) {
  delegate.doUpdateVisitedHistory(view, url, isReload)
  url?.let { toolbar.setUrl(it); rememberVisited(it) }   // 现状：不刷新后退 / 前进状态
}
```
`shouldOverrideUrlLoading` 里对非 http(s) 的 `intent:` 处理写在匿名 client 内部，弹窗无法复用。

**d. 内容 WebView 直接是根 `LinearLayout` 的子项**（`SurfActivity.setContentView`）
```kotlin
val root = LinearLayout(this).apply {
  orientation = LinearLayout.VERTICAL
  addView(toolbar, ...)
  addView(webview, LinearLayout.LayoutParams(MATCH_PARENT, 0, 1f))  // 现状：没有可叠加覆盖层的容器
}
```

**e. wry 的 WebView 设置与 ChromeClient**（`generated/RustWebView.kt`、`wry-0.57.0/src/android/main_pipe.rs`）
```kotlin
// RustWebView.init
settings.javaScriptCanOpenWindowsAutomatically = true   // 现状：允许脚本开窗
// setSupportMultipleWindows 未设置 → 默认 false：target=_blank / window.open 都在当前页打开
```
```rust
// main_pipe.rs CreateWebView：顺序是 setWebView → loadUrl(post) → setWebViewClient
//   → setWebChromeClient(RustWebChromeClient) → addJavascriptInterface → setContentView
// 现状：到 SurfActivity.setContentView 时 RustWebChromeClient 已装好，可在这里包装。
```
`RustWebChromeClient` 覆写了 `onShowCustomView`、`onHideCustomView`、`onPermissionRequest`、
`getDefaultVideoPoster`、`onJsAlert`、`onJsConfirm`、`onJsPrompt`、
`onGeolocationPermissionsShowPrompt`、`onShowFileChooser`、`onConsoleMessage`、`onReceivedTitle`；
没有 `onProgressChanged`、`onCreateWindow`、`onCloseWindow`。

**f. 返回键**（`SurfActivity.onCreate`）
```kotlin
override fun handleOnBackPressed() {
  if (::content.isInitialized && content.canGoBack()) {
    content.goBack()                  // 现状：只认内容页
  } else {
    finish()
  }
}
```

**g. 工具栏文案由 Rust 下发**（`surf_android.rs`）
```rust
struct SurfToolbarTexts {
    back: String, forward: String, reload: String, address: String,
    collect: String, cancel: String, open_in_browser: String,
    close: String,                    // 现状：没有弹窗关闭按钮的文案
}
```

**h. UA 只有一份：系统默认 UA**（`kabegame-core/src/plugin/v8/ops.rs`、`surf_receive.rs`）
```rust
fn cef_user_agent() -> Option<String> {
    #[cfg(target_os = "android")]
    {
        return ANDROID_WEBVIEW_USER_AGENT.get().cloned();   // 现状：安卓恒为系统 WebView 默认 UA
    }
    ...
}

pub fn op_kabegame_require_cookie(state: &mut OpState, #[string] host: String) -> bool {
    ...
    match Storage::global().get_surf_record_by_host(&host) {
        Ok(Some(rec)) if !rec.cookie.trim().is_empty() => {
            match run.set_header("Cookie".to_string(), rec.cookie) {   // 现状：只注入 Cookie
            ...
```
```rust
// surf_receive.rs android_identity_headers
if let Some(user_agent) = kabegame_core::plugin::v8::android_webview_user_agent() {
    headers.insert("User-Agent".to_string(), user_agent);   // 现状：下载补头恒为默认 UA
}
```
插件侧（weibo、konachan、danbooru、网页收集）都是先 `setHeader("User-Agent", cefUserAgent())`
再 `requireCookie(host)`；xhs、kemono、bilibili 写死自己的 UA 后再 `requireCookie`。

**i. `surf_records` 没有模式字段**（`storage/migrations/init.rs`，最新 schema；最新迁移为 v041）
```sql
CREATE TABLE surf_records (
    id             TEXT    PRIMARY KEY,
    host           TEXT    NOT NULL UNIQUE,
    root_url       TEXT    NOT NULL,
    icon           BLOB,
    last_visit_at  INTEGER NOT NULL,
    created_at     INTEGER NOT NULL,
    name           TEXT    NOT NULL DEFAULT '',
    cookie         TEXT    NOT NULL DEFAULT ''          -- 现状：没有 desktop_mode
);
```

**j. 页面自发下载只提前拒绝压缩包**（`surf_android.rs` `on_page_download`）
```rust
// 只提前拒绝明确的压缩包……认不出类型的照样入队，由后处理按字节判定。
if !(by_name || by_mime) && super::surf_common::is_archive_download(name, mime_type) {
    toast("surf.download.unsupportedType");
    return;
}
// 现状：.apk / application/vnd.android.package-archive 会被入队，下载完才报格式不受支持
```

**k. 工具栏「在浏览器打开」是独立图标**（`SurfToolbar.kt`）
```kotlin
private val openInBrowser = iconButton(R.drawable.ic_surf_open_in_browser)
...
addView(openInBrowser, LayoutParams(dp(32), dp(44)))   // 现状：6 个图标按钮挤占地址栏宽度
```

### 点 1 — 工具栏状态 API（`SurfToolbar.kt`）
- **修改**
  - `loadingBar` 改为确定进度条（`max = 100`），背景轨道透明。
  - `setLoading(Boolean)` 改为 `setProgress(Int)`：0–99 显示并更新，≥100 隐藏并归零；进度回退
    （新导航打断旧导航）时不做动画。
- **新增**
  - `setNavigationState(canGoBack, canGoForward)`：不可用的按钮 `isEnabled = false`、`alpha = 0.38`。
    禁用的 View 不进入 pressed 态，ripple 与点击都不触发。
  - 把颜色字段抽成 `SurfTheme`（`SurfTheme.kt`），工具栏与弹窗标题栏共用同一套深浅色。
  - 「更多」按钮 `ic_surf_more.xml`（Feather `more-vertical`：三个 r=1 的圆点，同 18dp / 描边 2）。
    点击弹 `PopupMenu`：「在浏览器打开」、可勾选的「桌面版网站」。回调 `onToggleDesktop(Boolean)`。
  - `setDesktopMode(Boolean)`：只更新菜单勾选态。
  - `setDesktopAvailable(Boolean)`：派生不出桌面 UA 时隐藏「桌面版网站」菜单项。
- **删除**
  - 独立的 `openInBrowser` 图标按钮（并入菜单；`ic_surf_open_in_browser.xml` 不再使用，一并删除）。
```kotlin
private val loadingBar = ProgressBar(context, null, android.R.attr.progressBarStyleHorizontal).apply {
  isIndeterminate = false                                   // 修改
  max = 100                                                 // 新增
  visibility = View.GONE
  progressTintList = ColorStateList.valueOf(theme.accent)   // 修改：颜色来自 SurfTheme
  progressBackgroundTintList = ColorStateList.valueOf(Color.TRANSPARENT)  // 新增
  minimumHeight = dp(2)
}

/** 新增：按内容页历史置灰后退 / 前进。 */
fun setNavigationState(canGoBack: Boolean, canGoForward: Boolean) {
  setButtonEnabled(back, canGoBack)
  setButtonEnabled(forward, canGoForward)
}

/** 修改：取代 setLoading。0–99 显示确定进度，100 表示加载完成并隐藏。 */
fun setProgress(progress: Int) {
  if (progress >= 100) {
    loadingBar.visibility = View.GONE
    loadingBar.setProgress(0, false)
    return
  }
  loadingBar.visibility = View.VISIBLE
  loadingBar.setProgress(progress, progress > loadingBar.progress)
}

private fun setButtonEnabled(button: ImageView, enabled: Boolean) {   // 新增
  button.isEnabled = enabled
  button.alpha = if (enabled) 1f else 0.38f
}

// 删除：fun setLoading(loading: Boolean)

// 新增：「更多」菜单，取代独立的 openInBrowser 按钮
var onToggleDesktop: ((Boolean) -> Unit)? = null
private var desktopMode = false
private val more = surfIconButton(context, theme, R.drawable.ic_surf_more).apply {
  setOnClickListener { showMoreMenu(this) }
}

fun setDesktopMode(enabled: Boolean) { desktopMode = enabled }

private fun showMoreMenu(anchor: View) {
  PopupMenu(context, anchor).apply {
    menu.add(0, MENU_OPEN_IN_BROWSER, 0, texts.openInBrowser)
    menu.add(0, MENU_DESKTOP, 1, texts.desktopSite).apply {
      isCheckable = true
      isChecked = desktopMode
    }
    setOnMenuItemClickListener { item ->
      when (item.itemId) {
        MENU_OPEN_IN_BROWSER -> onOpenInBrowser?.invoke(currentUrl)
        MENU_DESKTOP -> onToggleDesktop?.invoke(!desktopMode)
      }
      true
    }
  }.show()
}
```
```kotlin
/** 新增（SurfTheme.kt）：从 SurfToolbar 抽出的配色，与桌面 surf-navbar.ts 的 CSS 变量一致。 */
class SurfTheme(context: Context) {
  val night = (context.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) ==
    Configuration.UI_MODE_NIGHT_YES
  val fg = if (night) 0xFFF5F5F7.toInt() else 0xFF1D1D1F.toInt()
  val bg = if (night) 0xFF1D1D1F.toInt() else 0xFFF5F5F7.toInt()
  val border = if (night) 0xFF3A3A3C.toInt() else 0xFFD2D2D7.toInt()
  val input = if (night) 0x14FFFFFF else 0x0F000000
  val pressed = if (night) 0xFF3A3A3C.toInt() else 0xFFE5E5EA.toInt()
  val invalid = if (night) 0xFFFF6B5F.toInt() else 0xFFD92D20.toInt()
  val accent = 0xFF3B82F6.toInt()
}
```
`iconButton` 同步挪成 `SurfTheme` 旁的顶层函数 `surfIconButton(context, theme, icon)`，供弹窗关闭按钮复用。

### 点 2 — 转发型 ChromeClient（新增 `SurfChromeClient.kt`）
- **新增**
  - `SurfChromeClient(delegate, onProgress, onCreateWindow)`：逐个转发 `RustWebChromeClient` 的 11 个
    override（见锚点 e），额外实现 `onProgressChanged` 和 `onCreateWindow`。
    > 说明：`RustWebChromeClient` 是 final 类，不能继承；只转发它实际覆写的方法，其余走
    > `WebChromeClient` 默认实现，与包装前一致。
```kotlin
class SurfChromeClient(
  private val delegate: WebChromeClient,
  private val onProgress: (Int) -> Unit,
  private val onNewWindow: (view: WebView, isUserGesture: Boolean, resultMsg: Message) -> Boolean,
) : WebChromeClient() {
  override fun onProgressChanged(view: WebView, newProgress: Int) {
    delegate.onProgressChanged(view, newProgress)
    onProgress(newProgress)
  }

  override fun onCreateWindow(view: WebView, isDialog: Boolean, isUserGesture: Boolean, resultMsg: Message): Boolean =
    onNewWindow(view, isUserGesture, resultMsg)

  // —— 以下原样转发 RustWebChromeClient 的覆写；升级 wry 时核对清单 ——
  override fun onShowCustomView(view: View, callback: CustomViewCallback) = delegate.onShowCustomView(view, callback)
  override fun onHideCustomView() = delegate.onHideCustomView()
  override fun onPermissionRequest(request: PermissionRequest) = delegate.onPermissionRequest(request)
  override fun getDefaultVideoPoster(): Bitmap? = delegate.defaultVideoPoster
  override fun onJsAlert(view: WebView, url: String, message: String, result: JsResult) =
    delegate.onJsAlert(view, url, message, result)
  override fun onJsConfirm(view: WebView, url: String, message: String, result: JsResult) =
    delegate.onJsConfirm(view, url, message, result)
  override fun onJsPrompt(view: WebView, url: String, message: String, defaultValue: String?, result: JsPromptResult) =
    delegate.onJsPrompt(view, url, message, defaultValue, result)
  override fun onGeolocationPermissionsShowPrompt(origin: String, callback: GeolocationPermissions.Callback) =
    delegate.onGeolocationPermissionsShowPrompt(origin, callback)
  override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams) =
    delegate.onShowFileChooser(view, callback, params)
  override fun onConsoleMessage(message: ConsoleMessage) = delegate.onConsoleMessage(message)
  override fun onReceivedTitle(view: WebView, title: String) = delegate.onReceivedTitle(view, title)
}
```

### 点 3 — 弹窗覆盖层（新增 `SurfPopup.kt`）
- **新增**
  - `SurfPopup`：竖排 `LinearLayout` = 标题栏（host 文本 + 关闭按钮）+ 2dp 进度条 + 普通 `WebView`。
  - 两种模式：`Popup`（立即可见）与 `LinkProbe`（`GONE`，第一次 `onPageStarted` 把 URL 交给
    `onLinkResolved` 后自毁）。
  - 弹窗 WebView：`javaScriptEnabled`、`domStorageEnabled`、`setSupportMultipleWindows(false)`、
    第三方 Cookie 开启；构造时传入内容页的 `SurfUaMode`（点 9），UA / Client Hints / 视口与
    内容页一致；不装下载监听（弹窗内的附件下载不处理，列入限制）。
  - `dismiss()`：`stopLoading` → 从父布局摘下 → `destroy()` → 回调 `onDismissed`；幂等。
```kotlin
class SurfPopup(
  context: Context,
  private val theme: SurfTheme,
  closeLabel: String,
  private val linkProbe: Boolean,
  uaMode: SurfUaMode,                                // 新增：跟随内容页的桌面 / 移动模式
  private val onLinkResolved: (String) -> Unit,
  private val onDismissed: (SurfPopup) -> Unit,
) : LinearLayout(context) {
  val webView: WebView = WebView(context).apply {
    settings.javaScriptEnabled = true
    settings.domStorageEnabled = true
    settings.setSupportMultipleWindows(false)       // 弹窗内再开窗就在弹窗自身打开
    CookieManager.getInstance().setAcceptThirdPartyCookies(this, true)
    uaMode.applyTo(this)                             // 新增
  }
  private val title = TextView(context)            // 显示当前 host
  private val progress = ProgressBar(context, null, android.R.attr.progressBarStyleHorizontal)
  private var dismissed = false

  init {
    orientation = VERTICAL
    setBackgroundColor(theme.bg)
    visibility = if (linkProbe) View.GONE else View.VISIBLE
    // 标题栏：title（weight 1）+ surfIconButton(R.drawable.ic_surf_close)，44dp 高，底边 1dp border
    webView.webViewClient = object : WebViewClient() {
      override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
        overrideNonHttp(view, request.url)          // 与内容页同口径（点 4 抽出的顶层函数）

      override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
        if (linkProbe) {
          // 链接型新窗口：拿到真实目标后交回内容页，自身不显示。
          view.stopLoading()
          url?.takeIf { it.startsWith("http://") || it.startsWith("https://") }?.let(onLinkResolved)
          dismiss()
          return
        }
        title.text = url?.let { Uri.parse(it).host }.orEmpty()
      }
    }
    webView.webChromeClient = object : WebChromeClient() {
      override fun onProgressChanged(view: WebView, newProgress: Int) { /* 同工具栏：<100 显示，100 隐藏 */ }
      override fun onCloseWindow(window: WebView) = dismiss()   // 页面 window.close()
    }
  }

  fun dismiss() {
    if (dismissed) return
    dismissed = true
    webView.stopLoading()
    (parent as? ViewGroup)?.removeView(this)
    webView.destroy()
    onDismissed(this)
  }
}
```

### 点 4 — `SurfActivity` 接线（`SurfActivity.kt`）
- **修改**
  - 内容区改成 `FrameLayout`，内容 WebView 与弹窗覆盖层同在其中。
  - `setContentView` 里开启 `setSupportMultipleWindows(true)`，并用 `SurfChromeClient` 包装
    `webview.webChromeClient`（minSdk 26，getter 可用）。
  - `wrapWebViewClient`：`setLoading` 调用删除；`onPageStarted` / `onPageFinished` /
    `doUpdateVisitedHistory` 末尾调用 `refreshNavigation()`。
  - `shouldOverrideUrlLoading` 的非 http(s) 分支抽成顶层函数 `overrideNonHttp(view, uri): Boolean`，
    内容页与弹窗共用。
  - 返回键：先问弹窗，再问内容页。
  - `onDestroy`：`ContentWebView.release` 之前先 `popup?.dismiss()`（配置变化重建时同样关闭，弹窗不跨实例保留）。
- **新增**
  - `openNewWindow(view, isUserGesture, resultMsg)`：按锚点命中分流，建 transport 目标。
  - `onPopupDismissed`：清引用；可见弹窗关闭时补发 `pageFinished` 保存 Cookie。
```kotlin
private var popup: SurfPopup? = null                                       // 新增
private lateinit var contentArea: FrameLayout                              // 新增

// setContentView 内
webview.settings.setSupportMultipleWindows(true)                           // 新增
webview.webChromeClient = SurfChromeClient(                                // 新增
  delegate = webview.webChromeClient ?: WebChromeClient(),
  onProgress = { toolbar.setProgress(it) },
  onNewWindow = ::openNewWindow,
)
contentArea = FrameLayout(this).apply {                                    // 修改：原来 webview 直接进 root
  addView(webview, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
}
val root = LinearLayout(this).apply {
  orientation = LinearLayout.VERTICAL
  addView(toolbar, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT))
  addView(contentArea, LinearLayout.LayoutParams(MATCH_PARENT, 0, 1f))      // 修改
}

/** 新增：新窗口分流。链接 → 交回内容页；脚本 window.open → 覆盖层弹窗（保留 opener）。 */
private fun openNewWindow(view: WebView, isUserGesture: Boolean, resultMsg: Message): Boolean {
  val hit = view.hitTestResult
  val linkProbe = isUserGesture && when (hit.type) {
    WebView.HitTestResult.SRC_ANCHOR_TYPE ->
      hit.extra?.let { it.startsWith("http://") || it.startsWith("https://") } == true
    WebView.HitTestResult.SRC_IMAGE_ANCHOR_TYPE -> true   // extra 是图片地址，目标由探针取
    else -> false
  }
  popup?.dismiss()                                        // 同时最多一个
  val next = SurfPopup(
    this, theme, binding?.texts?.closePopup.orEmpty(), linkProbe, uaMode,
    onLinkResolved = { url -> content.loadUrl(url) },
    onDismissed = ::onPopupDismissed,
  )
  popup = next
  contentArea.addView(next, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
  (resultMsg.obj as WebView.WebViewTransport).webView = next.webView
  resultMsg.sendToTarget()
  return true
}

private fun onPopupDismissed(closed: SurfPopup) {                           // 新增
  if (popup === closed) popup = null
  // OAuth 弹窗关闭时登录 Cookie 已写好：立即保存一次，不等内容页下次加载。
  if (closed.wasVisible) {
    emit("pageFinished") {
      put("url", content.url.orEmpty())
      put("cookie", collectCookie())
    }
  }
}

private fun refreshNavigation() {                                          // 新增
  toolbar.setNavigationState(content.canGoBack(), content.canGoForward())
}

// onCreate 的返回键回调
override fun handleOnBackPressed() {
  popup?.let { open ->                                                     // 新增：弹窗优先
    if (open.webView.canGoBack()) open.webView.goBack() else open.dismiss()
    return
  }
  if (::content.isInitialized && content.canGoBack()) content.goBack() else finish()
}

// onDestroy，super.onDestroy() 之后
popup?.dismiss()                                                           // 新增
if (::content.isInitialized) {
  ContentWebView.release(content, ipcAvailable)
}
```
> `wasVisible` 是 `SurfPopup` 上 `!linkProbe` 的只读属性；链接探针销毁不触发 Cookie 保存。

### 点 5 — 工具栏与提示文案（`surf_android.rs`、`SurfPlugin.kt`、`kabegame-i18n/locales/*.yml`）
- **新增**
  - `SurfToolbarTexts` 增加 `close_popup`、`more`、`desktop_site`，Kotlin 同名 camelCase 字段。
  - 五个 locale 的新 key：

    | key | zh | zhtw | en | ja | ko |
    |---|---|---|---|---|---|
    | `surf.toolbar.closePopup` | 关闭弹窗 | 關閉彈出視窗 | Close popup | ポップアップを閉じる | 팝업 닫기 |
    | `surf.toolbar.more` | 更多 | 更多 | More | その他 | 더보기 |
    | `surf.toolbar.desktopSite` | 桌面版网站 | 電腦版網站 | Desktop site | PC 版サイト | 데스크톱 사이트 |
    | `surf.download.appPackage` | 已拦截应用安装包下载。站点不给网页登录时，可在右上角菜单切换为桌面版网站 | 已攔截應用程式安裝包下載。網站不提供網頁登入時，可在右上角選單切換為電腦版網站 | Blocked an app installer download. If the site hides web sign-in, switch to Desktop site from the menu | アプリのインストールパッケージのダウンロードをブロックしました。Web ログインが表示されない場合は、メニューから PC 版サイトに切り替えてください | 앱 설치 파일 다운로드를 차단했습니다. 웹 로그인이 보이지 않으면 메뉴에서 데스크톱 사이트로 전환하세요 |

  - `surf.toolbar.openInBrowser` 保留，改作菜单项文案。
```rust
struct SurfToolbarTexts {
    back: String,
    forward: String,
    reload: String,
    address: String,
    collect: String,
    cancel: String,
    open_in_browser: String,
    close: String,
    close_popup: String,   // 新增
    more: String,          // 新增
    desktop_site: String,  // 新增
}
```
```kotlin
@InvokeArg
class SurfToolbarTexts {
  ...
  lateinit var close: String
  lateinit var closePopup: String   // 新增
  lateinit var more: String         // 新增
  lateinit var desktopSite: String  // 新增
}
```

### 点 6 — 桌面 UA 的唯一派生（`kabegame-core/src/plugin/v8/ops.rs`、`v8.rs`）
- **新增**
  - `android_desktop_user_agent() -> Option<String>`：从已登记的系统默认 UA 取 `Chrome/<major>`，
    拼成与 Chrome Android「桌面版网站」同形的 Linux 桌面 UA；默认 UA 未登记或解析不出版本时返回 `None`
    （调用方据此不切换）。
  - 单测：典型 WebView UA → 期望串；缺 `Chrome/` → `None`。
```rust
/// 安卓畅游「桌面版网站」用的 UA：与当前系统 WebView 同 Chrome 大版本的 Linux 桌面 UA。
/// 内容页、弹窗、插件 requireCookie、下载补头都只认这一个实现。
#[cfg(target_os = "android")]
pub fn android_desktop_user_agent() -> Option<String> {
    let default = ANDROID_WEBVIEW_USER_AGENT.get()?;
    let major = desktop_chrome_major(default)?;
    Some(format!(
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) \
         Chrome/{major}.0.0.0 Safari/537.36"
    ))
}

/// `…Version/4.0 Chrome/155.0.8059.43 Mobile Safari/537.36` → `155`。纯函数，桌面也编译以便单测。
fn desktop_chrome_major(user_agent: &str) -> Option<u32> {
    let rest = user_agent.split("Chrome/").nth(1)?;
    rest.split('.').next()?.parse().ok()
}
```

### 点 7 — 站点模式持久化（`storage/migrations/v042_surf_record_desktop_mode.rs`、`init.rs`、`surf_records.rs`）
- **新增**
  - 迁移 v042：`ALTER TABLE surf_records ADD COLUMN desktop_mode INTEGER NOT NULL DEFAULT 0;`，在
    `migrations/mod.rs` 登记；`init.rs` 建表语句同步加列。
  - `Storage::set_surf_record_desktop_mode(id, enabled)`：值变化才写库并发
    `SurfRecordChanged { desktopMode }`。
- **修改**
  - `SurfRecord` 增加 `#[serde(default)] pub desktop_mode: bool`；各 `SELECT sr.…` 补列、行映射补字段。
    > 说明：前端 `SurfRecord` 类型同步加可选字段，本期不在 Vue 展示。
```rust
pub struct SurfRecord {
    pub id: String,
    pub host: String,
    pub name: String,
    pub root_url: String,
    pub cookie: String,
    pub icon: Option<Vec<u8>>,
    pub last_visit_at: u64,
    pub created_at: u64,
    #[serde(default)]
    pub desktop_mode: bool,            // 新增：安卓畅游是否以桌面版打开该站
    #[serde(default)]
    pub last_image: Option<ImageInfo>,
}
```

### 点 8 — 消费端按记录取 UA（`ops.rs` `op_kabegame_require_cookie`、`surf_receive.rs`、`surf_android.rs`）
- **修改**
  - `requireCookie`：注入 Cookie 后，安卓上若记录 `desktop_mode` 且能派生桌面 UA，且任务当前
    `User-Agent` 缺失或等于系统默认 UA，就换成桌面 UA，并记任务日志 `taskLogDesktopUaInjected`。
  - `android_identity_headers`：按当前会话模式补 UA。
  - `surf_start_session`：记录为桌面模式时 `builder.user_agent(desktop_ua)`；`AndroidSurfSession`
    增加 `desktop_mode`；`AttachArgs` 增加 `desktopUserAgent: Option<String>`（派生失败为 `None`，Kotlin
    据此隐藏菜单项）。
  - `SurfContentEvent` 增加 `DesktopModeChanged { desktop }`：核对当前会话后更新 `SESSION` 与记录。
  - `on_page_download`：压缩包判断之前先判 apk（见下），toast `surf.download.appPackage`。
- **新增**
  - `surf_common::is_app_package_download(name, mime)`：扩展名 `apk` / `apks` / `xapk` / `aab`，或 MIME
    `application/vnd.android.package-archive`。
```rust
// ops.rs op_kabegame_require_cookie，Cookie 注入成功之后
#[cfg(target_os = "android")]
if rec.desktop_mode {
    if let Some(desktop) = android_desktop_user_agent() {
        let current = run.headers_snapshot().into_iter()
            .find(|(name, _)| name.eq_ignore_ascii_case("user-agent"))
            .map(|(_, value)| value);
        // 只替换宿主给的默认 UA：插件写死的 UA、用户在任务 Header 里显式填的 UA 都不碰。
        let replaceable = current.as_deref().map_or(true, |ua| Some(ua) == android_webview_user_agent().as_deref());
        if replaceable && run.set_header("User-Agent".to_string(), desktop).is_ok() {
            emit_http_info(&task_id, task_log_i18n("taskLogDesktopUaInjected", json!({ "host": host })));
        }
    }
}
```
```rust
// surf_receive.rs android_identity_headers
let user_agent = if super::surf_android::is_desktop_session(webview.label()) {   // 修改
    kabegame_core::plugin::v8::android_desktop_user_agent()
} else {
    kabegame_core::plugin::v8::android_webview_user_agent()
};
if let Some(user_agent) = user_agent {
    headers.insert("User-Agent".to_string(), user_agent);
}
```
```rust
// surf_android.rs surf_start_session
let desktop_ua = kabegame_core::plugin::v8::android_desktop_user_agent();   // 新增
if record.desktop_mode {
    if let Some(ua) = desktop_ua.as_deref() {
        builder = builder.user_agent(ua);   // 新增：首个请求即桌面 UA，强制跳转多发生在这里
    }
}

// on_content_event
SurfContentEvent::DesktopModeChanged { desktop } => {                        // 新增
    if !is_current_session(&session.label) {
        return;
    }
    if let Ok(mut current) = SESSION.lock() {
        if let Some(active) = current.as_mut().filter(|active| active.label == session.label) {
            active.desktop_mode = desktop;
        }
    }
    let _ = Storage::global().set_surf_record_desktop_mode(&session.record_id, desktop);
}

// on_page_download，"http" | "https" 分支开头
if super::surf_common::is_app_package_download(name, mime_type) {          // 新增
    toast("surf.download.appPackage");
    return;
}
```
任务日志 `taskLogDesktopUaInjected` 按现有 `taskLog*` 的位置补五种语言（「已为 {host} 使用畅游桌面版 UA」）。

### 点 9 — 内容页切换（新增 `SurfUaMode.kt`，修改 `SurfActivity.kt`、`SurfPlugin.kt`）
- **新增**
  - `SurfUaMode(desktopUserAgent: String?)`：把「桌面 / 移动」落到某个 WebView 上的唯一实现。桌面：
    `userAgentString`、`useWideViewPort` / `loadWithOverviewMode`、缩放（不显示缩放按钮）、
    `WebSettingsCompat.setUserAgentMetadata`（`mobile=false`、`platform="Linux"`、`model=""`，特性不支持时跳过）。
    移动：全部还原为默认（`userAgentString = null`、元数据取默认）。
  - `SurfActivity.setDesktopMode(enabled)`：应用到内容页（与已打开的弹窗）→ `reload()` → 工具栏勾选
    → `emit("desktopModeChanged")`。
- **修改**
  - `setContentView`：wry 已按 `builder.user_agent` 设好 UA。比较 `settings.userAgentString` 与
    `WebSettings.getDefaultUserAgent` 得到初始模式，在首个（post 出去的）`loadUrl` 之前补齐视口与 Client Hints。
  - `bind`：拿到 `desktopUserAgent` 后构造 `SurfUaMode`，同步工具栏勾选态；为 `null` 时隐藏菜单项。
  - `SurfAttachArgs` 增加 `desktopUserAgent: String?` 与 `desktopMode: Boolean`（记录当前值）；
    `SurfBinding` 增加同名字段，其中 `desktopMode` 为 `var`，切换时就地更新。
    > 说明：配置变化重建时 `SurfRegistry` 把 binding 交给新实例，而 wry 用**创建时**的属性重建 webview
    > （UA 是 `builder.user_agent` 当时的值）。`bind` 以 `binding.desktopMode` 为准，与新 webview 的
    > 实际 UA 不一致就重新应用并 `reload`，切换状态因此跨重建保留。
```kotlin
class SurfUaMode(private val desktopUserAgent: String?) {
  var desktop = false
    private set

  val available get() = desktopUserAgent != null

  fun set(enabled: Boolean) { desktop = enabled && desktopUserAgent != null }

  fun applyTo(webView: WebView) {
    val settings = webView.settings
    settings.userAgentString = if (desktop) desktopUserAgent else null   // null = 系统默认
    settings.useWideViewPort = desktop
    settings.loadWithOverviewMode = desktop
    settings.setSupportZoom(desktop)
    settings.builtInZoomControls = desktop
    settings.displayZoomControls = false
    if (WebViewFeature.isFeatureSupported(WebViewFeature.USER_AGENT_METADATA)) {
      val base = WebSettingsCompat.getUserAgentMetadata(settings)
      WebSettingsCompat.setUserAgentMetadata(
        settings,
        UserAgentMetadata.Builder(base)
          .setMobile(!desktop)
          .setPlatform(if (desktop) "Linux" else "Android")
          .setModel(if (desktop) "" else base.model)
          .build(),
      )
    }
  }
}
```
```kotlin
// SurfActivity
private var uaMode = SurfUaMode(null)                                       // 新增

fun bind(binding: SurfBinding) {
  ...
  uaMode = SurfUaMode(binding.desktopUserAgent).apply { set(binding.desktopMode) }   // 新增
  toolbar.setDesktopAvailable(uaMode.available)
  toolbar.setDesktopMode(uaMode.desktop)
  val expected = if (uaMode.desktop) binding.desktopUserAgent else WebSettings.getDefaultUserAgent(this)
  if (content.settings.userAgentString != expected) {
    // 重建后的 webview 带着创建时的 UA（或 Rust 建页时还没登记默认 UA）：按 binding 纠正一次。
    uaMode.applyTo(content)
    content.reload()
  }
}

private fun setDesktopMode(enabled: Boolean) {                               // 新增
  uaMode.set(enabled)
  uaMode.applyTo(content)
  popup?.let { uaMode.applyTo(it.webView) }
  toolbar.setDesktopMode(uaMode.desktop)
  binding?.desktopMode = uaMode.desktop                                     // 跨配置变化重建保留
  content.reload()
  emit("desktopModeChanged") { put("desktop", uaMode.desktop) }
}
```
> 说明：`setContentView` 时还没有 binding，初始模式靠「UA 是否已被 wry 改过」判断，只补视口与 Client
> Hints；`bind` 之后以 Rust 下发的桌面 UA 为准。

### 点 10 — 文档、回归、changelog
- **修改**
  - `cocs/surf/ANDROID_SURF.md`：「导航与限制」改写多窗口语义（链接回内容页、脚本开窗走覆盖层、
    弹窗是普通 WebView、最多一个、返回键顺序）；「已知限制」删掉 OAuth 弹窗一条，补「弹窗内不处理下载」
    与「`SurfChromeClient` 转发清单随 wry 升级核对」；Activity 边界一节补工具栏置灰、进度与「更多」菜单。
  - `ANDROID_SURF.md`「Cookie 与 UA 口径」重写：UA 不再恒为默认，改为按记录 `desktop_mode`；
    `android_desktop_user_agent` 是唯一派生；`requireCookie` 的替换规则；下载补头随会话模式；
    页面下载的 apk 拦截写进「下载」一节。
  - `cocs/crawler/V8_RUNTIME.md`：`requireCookie` 在安卓桌面模式记录上会替换默认 UA。
  - `docs/PLUGIN_FORMAT.md`（若描述了 `requireCookie` / `cefUserAgent`）同步说明。
  - `cocs/README.md` 畅游条目：主题补「OAuth 弹窗覆盖层、工具栏导航状态与进度、按站点的桌面版网站与
    UA 配对、apk 拦截」，适用场景补「`target=_blank` 打开方式、第三方登录弹窗无反应、站点强制跳应用 /
    下 apk、桌面模式下插件 403」。
  - `versions/latest/regression.md`、`versions/latest/changelog.md`：见下节验证项各一行。

### 验证

1. `deno task check -c kabegame --mode android --skip vue`、`deno task check -c kabegame --skip vue`
   （core 与存储改动也影响桌面）与 `./gradlew :app:compileArm64DebugKotlin -x rustBuildArm64Debug`。
2. `test-kabegame`：`desktop_chrome_major` 单测；v042 迁移后 `get_surf_record*` 读出 `desktop_mode`
   默认 false，`set_surf_record_desktop_mode` 只在变化时发事件。
3. 安卓实机（`kabegame-chromium --android` 看内容页状态；测页面下载相关项时不连 CDP）：
   - 刚打开站点：后退、前进均置灰且按压无 ripple；点一个链接后后退可用；后退后前进可用；SPA 路由
     切换（`doUpdateVisitedHistory`）同样刷新。
   - 慢网页加载：进度条从左到右增长，到 100 消失；加载中点新链接，进度条回退不做动画。
   - pixiv 作品列表点 `target=_blank` 链接：在内容页打开，不出现覆盖层；一键下载、长按菜单照常。
   - x.com 登录页「使用 Google 登录」（GIS，按钮在跨域 iframe 内）：出现覆盖层，标题为
     `accounts.google.com`；完成登录后弹窗自行关闭，内容页进入登录态；畅游记录的 Cookie 立即更新
     （`surf-records-change`）。
   - 弹窗打开时按返回键：弹窗内能后退先后退，否则关闭弹窗；再按返回作用于内容页。
   - 弹窗打开时关闭畅游：Activity 销毁，`chrome://inspect` 不残留弹窗页面。
   - 全屏视频、文件选择（任意上传框）、`alert` / `confirm`：与包装前一致（转发生效）。
   - 「更多」菜单：「在浏览器打开」行为不变；勾选「桌面版网站」后页面刷新，内容页
     `navigator.userAgent` 等于桌面 UA、`navigator.userAgentData.mobile === false`；关闭畅游再打开同站，
     首屏即桌面版且菜单仍勾选；另一个站点不受影响。
   - 一个移动 UA 下强制跳应用 / 下 apk 的站点：切桌面版后出现网页登录入口并可登录。
   - Google 登录：移动模式下弹窗若报 `disallowed_useragent`，切桌面版后重试可通过。
   - 桌面模式记录跑 weibo（`cefUserAgent()` + `requireCookie`）：任务日志出现 `taskLogDesktopUaInjected`，
     请求不 403；跑 xhs（写死 UA）：UA 保持插件自己的值、不出现该日志。
   - 桌面模式下一键下载一个需要登录的媒体：请求 UA 为桌面 UA（debug ingest 记录补头）。
   - 页面里点一个 apk 链接：toast `surf.download.appPackage`，下载列表不出现该项。

### 风险与待验证

1. **探针首个 `onPageStarted` 的时机。** transport 目标的第一次导航在部分 WebView 版本上可能先报
   `about:blank`。探针要跳过 `about:blank`，只认第一个 http(s) URL；若某版本对新窗口的首个导航只走
   `shouldOverrideUrlLoading` 不走 `onPageStarted`，两处都要接。
2. **锚点误判。** `<a>` 里包着脚本按钮（`href` 为 http(s) 但 `onclick` 里 `window.open`）会被当成
   链接交回内容页，丢掉 opener。实测遇到再按 host 白名单（如 `accounts.google.com`、
   `appleid.apple.com`）强制走覆盖层。
3. **`hitTestResult` 的陈旧值。** 它反映最近一次触摸，不是本次开窗的来源；无手势的定时器开窗已由
   `isUserGesture` 排除，但手势后延迟开窗仍会读到上次触摸。影响只是分流方向，可接受。
4. **转发清单漂移。** 升级 wry / Tauri 后 `RustWebChromeClient` 若新增 override，`SurfChromeClient`
   不转发就会静默丢功能。升级时 diff `generated/RustWebChromeClient.kt` 的 `override fun` 列表。
5. **开启多窗口对内容页的副作用。** `setSupportMultipleWindows(true)` 后，未处理的新窗口请求会直接
   丢失；`onCreateWindow` 必须对所有路径都返回 true 并 `sendToTarget`，否则链接点击无反应。
6. **COOP。** 部分 OAuth 提供方对弹窗设置 `Cross-Origin-Opener-Policy`，会切断 opener，此时站点
   通常自带重定向回退；与桌面浏览器行为一致，不另做处理。
7. **指纹仍是移动端。** 桌面 UA 只改了 UA 串与 Client Hints，屏幕尺寸、触摸事件、`navigator.platform`
   仍是手机；严格的风控（Cloudflare Turnstile 等）可能判为不一致。`USER_AGENT_METADATA` 不受支持的
   老 WebView 上，`Sec-CH-UA-Mobile` 仍是 `?1`。实测遇到再考虑注入脚本覆盖 `navigator.platform`。
8. **响应式站点仍是窄布局。** 声明了 `width=device-width` 的站点，宽视口不会改变布局宽度；本期目标是
   绕过服务端按 UA 的跳转，布局问题不处理。Chrome 的「强制桌面视口」WebView 没有公开 API。
9. **默认 UA 未登记时。** `getDefaultUserAgent` 是启动时异步登记的；畅游早于登记完成打开时
   `desktopUserAgent` 为 `null`，菜单项隐藏，下次打开恢复。
10. **切换后旧 Cookie。** 切到桌面版后，移动 UA 下签发的 `cf_clearance` 失效，站点会重新校验一次；
    记录的模式与 Cookie 在下一次 `pageFinished` 同时更新，中间若跑插件，可能拿到「桌面模式 + 旧 Cookie」
    而 403，重进一次畅游即可。

### 不在本期

- **新建记录默认桌面版**：本期默认移动版、按站点手动切换；若实测大多数站点都需要桌面版，再加全局默认项。
- **Vue 侧展示站点模式**（畅游记录卡片上的标记）：本期只在原生菜单里可见。
- **tao JNI 局部引用残留**（`MonitorHandle::size()` 钉住已销毁 Activity，实测 5 次开关残留 2 个、约 1 MB）：需要
  `third-patches` 新增 tao 子模块与补丁，单独评估。
- **弹窗内的下载与一键下载**、**POST 触发的下载**：维持现状。
