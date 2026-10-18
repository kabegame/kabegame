package app.kabegame

import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.os.Bundle
import android.view.View
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.URLUtil
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.LinearLayout
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import app.tauri.plugin.JSObject
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException

/**
 * 畅游页面：内容页就是本 Activity 的 Tauri 主 webview（label = `surf-<host>:<n>`），
 * 顶部一排原生工具栏。注入脚本、Tauri `invoke`、按 label 认会话的命令与桌面完全一致。
 *
 * 两处安卓特有的兜底都在这里：
 * 1. wry 的 `addJavascriptInterface("ipc")` 对所有 frame 可见、上报来源却是主框架 URL。
 *    这里换成 `addWebMessageListener("ipc")`，只收主框架消息；设备不支持该特性时关闭 IPC
 *    （只能浏览、不能一键下载），不回退到不安全的通道。
 * 2. wry 安卓没有下载回调。`setDownloadListener` 只把 URL / 文件名 / MIME 交给 Rust，
 *    由 Rust 补 Cookie / UA / Referer 后重新下载。
 */
class SurfActivity : TauriActivity() {
  private lateinit var content: RustWebView
  private lateinit var toolbar: SurfToolbar
  private val visited = LinkedHashSet<String>()
  private val ipcExecutor = Executors.newSingleThreadExecutor { runnable ->
    Thread(runnable, "surf-ipc").apply { isDaemon = true }
  }

  private var binding: SurfBinding? = null

  /** 主框架 IPC 是否可用；`attach` 把它回传给 Rust。 */
  var ipcAvailable: Boolean = false
    private set

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    // TauriActivity 的 handleBackNavigation = false（wry 不注册返回回调），畅游自己处理：
    // 能页内后退就先后退，退到头再关闭 Activity。
    onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() {
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
    toolbar = SurfToolbar(this).apply {
      onBack = { if (content.canGoBack()) content.goBack() }
      onForward = { if (content.canGoForward()) content.goForward() }
      onReload = { content.reload() }
      onNavigate = { url -> content.loadUrl(url) }
      onCollect = { emit("collectToggle") }
      onOpenInBrowser = { url -> openInBrowser(url) }
      onClose = { finish() }
    }

    // 顺序：先换 IPC，再包 client / 装下载拦截；首个 loadUrl 是 post 出去的，晚于这里执行。
    ipcAvailable = installMainFrameIpc(webview)
    wrapWebViewClient(webview)
    installDownloadInterceptor(webview)

    WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
    CookieManager.getInstance().apply {
      setAcceptCookie(true)
      // 第三方 Cookie 已开启，以兼容常见 SSO。
      setAcceptThirdPartyCookies(webview, true)
    }

    val root = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      addView(toolbar, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
      addView(webview, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
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

    SurfRegistry.onActivityReady(webview.id, this)
  }

  fun bind(binding: SurfBinding) {
    this.binding = binding
    visited.clear()
    toolbar.applyTexts(binding.texts)
    toolbar.setInitialUrl(binding.url)
  }

  fun setCollectRunning(running: Boolean) {
    if (::toolbar.isInitialized) toolbar.setCollectRunning(running)
  }

  /**
   * 把 wry 的 `addJavascriptInterface("ipc")` 换成只接收主框架消息的 WebMessageListener。
   *
   * JS 侧仍是 `window.ipc.postMessage(string)`，Tauri 的 `ipc-protocol.js` 无需改动。
   * 回调在 UI 线程，`Rust.ipc` 移出 UI 线程执行：同步命令若再经 MainPipe 等主线程会死锁，
   * 单线程 executor 同时保证消息顺序。
   */
  private fun installMainFrameIpc(webView: RustWebView): Boolean {
    webView.removeJavascriptInterface("ipc")
    if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
      return false
    }
    return try {
      WebViewCompat.addWebMessageListener(webView, "ipc", setOf("*")) { view, message, _, isMainFrame, _ ->
        if (!isMainFrame) return@addWebMessageListener
        val data = message.data ?: return@addWebMessageListener
        val url = view.url ?: "about:blank"
        try {
          ipcExecutor.execute { Rust.ipc(webView.id, url, data) }
        } catch (_: RejectedExecutionException) {
          // Activity 已销毁（executor 已 shutdown），迟到的消息直接丢弃。
        }
      }
      true
    } catch (error: Exception) {
      // 旧接口已移除，监听装不上就只能浏览；不回退到所有 frame 可见的通道。
      android.util.Log.w("Kabegame", "Surf IPC listener unavailable, disabling IPC", error)
      false
    }
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
        val scheme = uri.scheme
        if (scheme == "http" || scheme == "https") {
          return delegate.shouldOverrideUrlLoading(view, request)
        }
        // 与 Phase 1 同口径：intent: 只接受 http/https 的 browser_fallback_url；其它 scheme 一律拦截。
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

      override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
        delegate.onPageStarted(view, url, favicon)
        url?.let { toolbar.setUrl(it) }
        toolbar.setLoading(true)
      }

      override fun onPageFinished(view: WebView, url: String?) {
        delegate.onPageFinished(view, url)
        toolbar.setLoading(false)
        url?.let {
          toolbar.setUrl(it)
          rememberVisited(it)
        }
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

      override fun doUpdateVisitedHistory(view: WebView, url: String?, isReload: Boolean) {
        delegate.doUpdateVisitedHistory(view, url, isReload)
        // SPA 的 pushState / 前进后退只走这里，地址栏与 Cookie 收集都要跟上。
        url?.let {
          toolbar.setUrl(it)
          rememberVisited(it)
        }
      }
    }
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
    label?.let { SurfRegistry.onActivityGone(it, this) }
    ipcExecutor.shutdown()
    // 内容 webview 由 wry 在 onDestroy 里销毁（Rust.onWebviewDestroy），这里不要再 destroy。
    super.onDestroy()
  }
}
