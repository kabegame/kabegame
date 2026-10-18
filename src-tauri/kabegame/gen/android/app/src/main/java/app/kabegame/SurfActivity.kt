package app.kabegame

import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.os.Bundle
import android.os.Message
import android.view.View
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.RenderProcessGoneDetail
import android.webkit.URLUtil
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.LinearLayout
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.WebViewCompat
import app.tauri.plugin.JSObject
import java.util.concurrent.Executors

/**
 * 畅游页面：内容页就是本 Activity 的 Tauri 主 webview（label = `surf-<host>:<n>`），
 * 顶部一排原生工具栏。注入脚本、Tauri `invoke`、按 label 认会话的命令与桌面完全一致。
 *
 * 安卓特有的兜底都在这里：
 * 1. wry 的 `addJavascriptInterface("ipc")` 对所有 frame 可见、上报来源却是主框架 URL。
 *    这里换成 `addWebMessageListener("ipc")`，只收主框架消息；设备不支持该特性时关闭 IPC
 *    （只能浏览、不能一键下载），不回退到不安全的通道。
 * 2. wry 安卓没有下载回调。`setDownloadListener` 只把 URL / 文件名 / MIME 交给 Rust，
 *    由 Rust 补 Cookie / UA / Referer 后重新下载。
 * 3. wry 安卓没有 `on_new_window`。开启多窗口并包装 `WebChromeClient` 后，链接型新窗口
 *    交回内容页，脚本 `window.open`（OAuth 等）进 [SurfPopup] 覆盖层，保留真实 WindowProxy。
 */
class SurfActivity : TauriActivity() {
  private lateinit var content: RustWebView
  private lateinit var toolbar: SurfToolbar
  private lateinit var contentArea: FrameLayout
  private lateinit var theme: SurfTheme
  private val visited = LinkedHashSet<String>()
  private val ipcExecutor = Executors.newSingleThreadExecutor { runnable ->
    Thread(runnable, "surf-ipc").apply { isDaemon = true }
  }

  private var binding: SurfBinding? = null
  /** 内容页与弹窗的 UA / Client Hints 模式；桌面模式按站点持久化在 `surf_records`。 */
  private var uaMode = SurfUaMode(null)
  /** 同时最多一个弹窗（含链接探针）。 */
  private var popup: SurfPopup? = null

  /** 主框架 IPC 是否可用；`attach` 把它回传给 Rust。 */
  var ipcAvailable: Boolean = false
    private set

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    // TauriActivity 的 handleBackNavigation = false（wry 不注册返回回调），畅游自己处理：
    // 弹窗优先（能后退就后退，否则关闭），再让内容页页内后退，退到头关闭 Activity。
    onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() {
        popup?.let { open ->
          if (open.webView.canGoBack()) open.webView.goBack() else open.dismiss()
          return
        }
        if (::content.isInitialized && content.canGoBack()) {
          content.goBack()
        } else {
          finish()
        }
      }
    })
  }

  // wry 会在 onWebViewCreate 之后再次 setContentView；只有在这里换布局才不会被覆盖。
  override fun setContentView(view: View?) {
    val webview = view as? RustWebView
    if (webview == null) {
      super.setContentView(view)
      return
    }

    content = webview
    theme = SurfTheme(this)
    toolbar = SurfToolbar(this).apply {
      onBack = { if (content.canGoBack()) content.goBack() }
      onForward = { if (content.canGoForward()) content.goForward() }
      onReload = { content.reload() }
      onNavigate = { url -> content.loadUrl(url) }
      onCollect = { emit("collectToggle") }
      onOpenInBrowser = { url -> openInBrowser(url) }
      onToggleDesktop = { enabled -> applyDesktopSite(enabled) }
      onClose = { finish() }
    }

    // 顺序：先换 IPC，再包 client / chrome client / 装下载拦截；首个 loadUrl 是 post 出去的，晚于这里执行。
    ipcAvailable = ContentWebView.installMainFrameIpc(webview, ipcExecutor)
    wrapWebViewClient(webview)
    wrapWebChromeClient(webview)
    installDownloadInterceptor(webview)

    WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
    CookieManager.getInstance().apply {
      setAcceptCookie(true)
      // 第三方 Cookie 已开启，以兼容常见 SSO。
      setAcceptThirdPartyCookies(webview, true)
    }

    // Rust 建窗时若记录是桌面模式，wry 已按 builder.user_agent 设好桌面 UA；这里据此判断初始模式，
    // 并在首个（post 出去的）loadUrl 之前补齐视口与 Client Hints。bind 之后以 Rust 下发的值为准。
    val defaultUserAgent = WebSettings.getDefaultUserAgent(this)
    val currentUserAgent = webview.settings.userAgentString
    // Client Hints 默认值必须在 WebSettings 尚未被改过时捕获；bind 会换新的 SurfUaMode 实例。
    SurfUaMode.captureDefaultMetadata(webview.settings)
    uaMode = SurfUaMode(
      currentUserAgent?.takeIf { it.isNotBlank() && it != defaultUserAgent },
    ).apply { set(available) }
    uaMode.applyTo(webview)

    contentArea = FrameLayout(this).apply {
      addView(
        webview,
        FrameLayout.LayoutParams(
          ViewGroup.LayoutParams.MATCH_PARENT,
          ViewGroup.LayoutParams.MATCH_PARENT,
        ),
      )
    }
    val root = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      addView(
        toolbar,
        LinearLayout.LayoutParams(
          ViewGroup.LayoutParams.MATCH_PARENT,
          ViewGroup.LayoutParams.WRAP_CONTENT,
        ),
      )
      addView(
        contentArea,
        LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f),
      )
    }
    ViewCompat.setOnApplyWindowInsetsListener(root) { target, insets ->
      val bars = insets.getInsets(
        WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout(),
      )
      val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
      target.setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, ime.bottom))
      WindowInsetsCompat.CONSUMED
    }
    super.setContentView(root)
    ViewCompat.requestApplyInsets(root)
    refreshNavigation()
    toolbar.setDesktopAvailable(uaMode.available)
    toolbar.setDesktopMode(uaMode.desktop)

    SurfRegistry.onActivityReady(webview.id, this)
  }

  fun bind(binding: SurfBinding) {
    this.binding = binding
    visited.clear()
    toolbar.applyTexts(binding.texts)
    toolbar.setInitialUrl(binding.url)

    // Rust 下发的桌面 UA / 记录当前模式。
    uaMode = SurfUaMode(binding.desktopUserAgent).apply { set(binding.desktopMode) }
    toolbar.setDesktopAvailable(uaMode.available)
    toolbar.setDesktopMode(uaMode.desktop)
    val expected =
      if (uaMode.desktop) binding.desktopUserAgent else WebSettings.getDefaultUserAgent(this)
    if (::content.isInitialized && content.settings.userAgentString != expected) {
      // 重建后的 webview 带着创建时的 UA（或 Rust 建页时还没登记默认 UA）：按 binding 纠正一次。
      // 配置变化重建时 wry 用创建时的 builder 属性重建 webview，桌面模式因此靠 binding 跨重建保留。
      uaMode.applyTo(content)
      content.reload()
    }
  }

  fun setCollectRunning(running: Boolean) {
    if (::toolbar.isInitialized) toolbar.setCollectRunning(running)
  }

  private fun wrapWebViewClient(webView: RustWebView) {
    val delegate = WebViewCompat.getWebViewClient(webView) ?: return
    webView.webViewClient = object : WebViewClient() {
      override fun shouldInterceptRequest(
        view: WebView,
        request: WebResourceRequest,
      ): WebResourceResponse? = delegate.shouldInterceptRequest(view, request)

      override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
        val uri = request.url
        if (uri.scheme == "http" || uri.scheme == "https") {
          return delegate.shouldOverrideUrlLoading(view, request)
        }
        return overrideNonHttp(view, uri)
      }

      override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
        delegate.onPageStarted(view, url, favicon)
        url?.let { toolbar.setUrl(it) }
        refreshNavigation()
      }

      override fun onPageFinished(view: WebView, url: String?) {
        delegate.onPageFinished(view, url)
        url?.let {
          toolbar.setUrl(it)
          rememberVisited(it)
        }
        refreshNavigation()
        emit("pageFinished") {
          put("url", url ?: view.url.orEmpty())
          put("cookie", collectCookie())
        }
      }

      override fun onReceivedError(
        view: WebView,
        request: WebResourceRequest,
        error: WebResourceError,
      ) {
        delegate.onReceivedError(view, request, error)
      }

      // 应用内 WebView 共用一个渲染进程，不处理就会连带杀掉整个应用；内容页已不可用，直接关闭畅游。
      override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
        android.util.Log.w("Kabegame", "Surf render process gone (crash=${detail.didCrash()}), closing")
        finish()
        return true
      }

      override fun doUpdateVisitedHistory(view: WebView, url: String?, isReload: Boolean) {
        delegate.doUpdateVisitedHistory(view, url, isReload)
        // SPA 的 pushState / 前进后退只走这里，地址栏、Cookie 收集与后退 / 前进状态都要跟上。
        url?.let {
          toolbar.setUrl(it)
          rememberVisited(it)
        }
        refreshNavigation()
      }
    }
  }

  /**
   * 包装 wry 的 `RustWebChromeClient`：逐方法转发，只额外接进度与新窗口。
   *
   * `setSupportMultipleWindows(true)` 之后所有新窗口请求都进 `onCreateWindow`；必须对所有
   * 路径都返回 true 并 `sendToTarget`，否则链接点击会毫无反应。
   */
  private fun wrapWebChromeClient(webView: RustWebView) {
    webView.settings.setSupportMultipleWindows(true)
    webView.webChromeClient = SurfChromeClient(
      delegate = webView.webChromeClient ?: WebChromeClient(),
      onProgress = { toolbar.setProgress(it) },
      onNewWindow = ::openNewWindow,
    )
  }

  /**
   * 新窗口分流：链接 → 交回内容页；脚本 `window.open` → 覆盖层弹窗（保留 opener）。
   *
   * `onCreateWindow` 本身不给目标 URL：链接型先建一个不显示的 transport 目标，拿到首个
   * http(s) 地址后再销毁并让内容页加载。图片链接的命中测试 `extra` 是图片地址，同样靠探针取。
   */
  private fun openNewWindow(
    view: WebView,
    isUserGesture: Boolean,
    resultMsg: Message,
  ): Boolean {
    if (isFinishing || isDestroyed) return false
    val hit = view.hitTestResult
    val linkProbe = isUserGesture && when (hit.type) {
      WebView.HitTestResult.SRC_ANCHOR_TYPE ->
        hit.extra?.let { it.startsWith("http://") || it.startsWith("https://") } == true
      // 图片链接的 extra 是图片地址而非 href，真实目标由探针取。
      WebView.HitTestResult.SRC_IMAGE_ANCHOR_TYPE -> true
      else -> false
    }
    popup?.dismiss() // 同时最多一个
    val next = SurfPopup(
      this,
      theme,
      binding?.texts?.closePopup.orEmpty(),
      linkProbe,
      uaMode,
      onLinkResolved = { url -> content.loadUrl(url) },
      onDismissed = ::onPopupDismissed,
    )
    popup = next
    contentArea.addView(
      next,
      FrameLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        ViewGroup.LayoutParams.MATCH_PARENT,
      ),
    )
    val transport = resultMsg.obj as? WebView.WebViewTransport
    if (transport == null) {
      next.dismiss()
      return false
    }
    transport.webView = next.webView
    resultMsg.sendToTarget()
    return true
  }

  private fun onPopupDismissed(closed: SurfPopup) {
    if (popup === closed) popup = null
    // OAuth 弹窗关闭时登录 Cookie 已写好：立即保存一次，不等内容页下次加载。
    // 链接探针从未显示，不触发保存。
    if (closed.wasVisible) {
      emit("pageFinished") {
        put("url", content.url.orEmpty())
        put("cookie", collectCookie())
      }
    }
  }

  /** 「更多」菜单里的「桌面版网站」：立即应用并刷新，再把新状态交给 Rust 落库。 */
  private fun applyDesktopSite(enabled: Boolean) {
    uaMode.set(enabled)
    uaMode.applyTo(content)
    popup?.let { uaMode.applyTo(it.webView) }
    toolbar.setDesktopMode(uaMode.desktop)
    binding?.desktopMode = uaMode.desktop // 跨配置变化重建保留
    reloadOriginalRequest()
    emit("desktopModeChanged") { put("desktop", uaMode.desktop) }
  }

  /**
   * 换 UA 后重新请求跳转前的原始地址（同 Chrome「桌面版网站」的 ORIGINAL_REQUEST_URL 重载）。
   * 站点按 UA 做服务端跳转时（weibo.com → 302 → m.weibo.cn），`reload()` 只会重载跳转后的
   * 手机版地址，桌面 UA 到了那里也不会被送回桌面版。页面靠 JS 跳转时原始地址等于当前地址，退回 reload。
   */
  private fun reloadOriginalRequest() {
    val original = content.copyBackForwardList().currentItem?.originalUrl
    val scheme = original?.let { Uri.parse(it).scheme }
    if (original != null && original != content.url && (scheme == "http" || scheme == "https")) {
      content.loadUrl(original)
    } else {
      content.reload()
    }
  }

  private fun refreshNavigation() {
    if (!::toolbar.isInitialized || !::content.isInitialized) return
    toolbar.setNavigationState(content.canGoBack(), content.canGoForward())
  }

  private fun installDownloadInterceptor(webView: RustWebView) {
    webView.setDownloadListener { url, _, contentDisposition, mimeType, _ ->
      emit("pageDownload") {
        put("url", url)
        put("suggestedName", URLUtil.guessFileName(url, contentDisposition, mimeType))
        put("mimeType", mimeType)
      }
    }
  }

  private fun openInBrowser(url: String) {
    if (url.isBlank()) return
    runCatching { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) }
  }

  private fun rememberVisited(url: String) {
    val siteHost = binding?.host ?: return
    val uri = runCatching { Uri.parse(url) }.getOrNull() ?: return
    if ((uri.scheme == "http" || uri.scheme == "https") &&
      uri.host.equals(siteHost, ignoreCase = true)
    ) {
      visited.add(url)
    }
  }

  /** 根 URL 与本站已访问路径合并 Cookie，按名称去重并排序。 */
  private fun collectCookie(): String {
    val current = binding ?: return ""
    val cookieManager = CookieManager.getInstance().also { it.flush() }
    val merged = sortedMapOf<String, String>()
    (listOf(current.url) + visited).forEach { url ->
      cookieManager.getCookie(url)?.split(';')?.forEach { pair ->
        val separator = pair.indexOf('=')
        if (separator > 0) {
          merged[pair.substring(0, separator).trim()] = pair.substring(separator + 1).trim()
        }
      }
    }
    return merged.entries.joinToString("; ") { "${it.key}=${it.value}" }
  }

  private fun emit(type: String, extra: JSObject.() -> Unit = {}) {
    binding?.events?.send(JSObject().apply {
      put("type", type)
      extra()
    })
  }

  override fun onDestroy() {
    if (isFinishing && binding != null && ::content.isInitialized) {
      emit("closed") {
        put("cookie", collectCookie())
      }
    }
    // 用 binding 的 label：attach 先到、Activity 尚未 ready 时 content 还没赋值，也要清掉待定项。
    val label = binding?.label ?: if (::content.isInitialized) content.id else null
    // 配置变化重建：attach 只发生一次，把 binding 交给重建后的实例。
    label?.let { SurfRegistry.onActivityGone(it, this, binding?.takeIf { isChangingConfigurations }) }
    ipcExecutor.shutdown()
    // wry 的 Rust.onWebviewDestroy 只清 Rust 侧回调表，从不调 WebView.destroy()；放在 super 之后，
    // 保证 wry 先拿到 webview id。配置变化时 wry 会在新 Activity 里新建 webview，旧的同样要释放，
    // 否则旧页面继续运行，并以同一 id 向 Rust 发 IPC。
    super.onDestroy()
    // 弹窗不跨实例保留；配置变化重建时同样关闭。
    popup?.dismiss()
    if (::content.isInitialized) {
      ContentWebView.release(content, ipcAvailable)
    }
  }
}

/**
 * 非 http(s) 导航的统一处理（内容页与弹窗共用）：
 * `intent:` 只接受 http/https 的 `browser_fallback_url`，其它 scheme 一律拦截。
 *
 * @return true 表示已拦截、不要让 WebView 自己导航。
 */
internal fun overrideNonHttp(view: WebView, uri: Uri): Boolean {
  val scheme = uri.scheme
  if (scheme == "http" || scheme == "https") return false
  if (scheme == "intent") {
    val fallback = runCatching {
      Intent.parseUri(uri.toString(), Intent.URI_INTENT_SCHEME)
        .getStringExtra("browser_fallback_url")
    }.getOrNull()
    if (fallback != null) {
      val fallbackUri = Uri.parse(fallback)
      if (fallbackUri.scheme == "http" || fallbackUri.scheme == "https") {
        view.loadUrl(fallback)
      }
    }
  }
  return true
}
