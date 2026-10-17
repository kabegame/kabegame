package app.kabegame

import android.annotation.SuppressLint
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.view.View
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.LinearLayout
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import app.tauri.plugin.JSObject

class SurfActivity : TauriActivity() {
  lateinit var content: WebView
    private set

  private var binding: SurfBinding? = null
  private var label: String? = null
  private val visited = LinkedHashSet<String>()

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
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
    val navbar = view as? RustWebView
    if (navbar == null) {
      super.setContentView(view)
      return
    }

    content = createContentWebView()
    val root = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      addView(
        navbar,
        LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(48)),
      )
      addView(
        content,
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

    label = navbar.id
    SurfRegistry.onActivityReady(navbar.id, this)
  }

  fun bind(binding: SurfBinding) {
    this.binding = binding
    visited.clear()
    content.loadUrl(binding.url)
  }

  @SuppressLint("SetJavaScriptEnabled")
  private fun createContentWebView(): WebView {
    val webView = WebView(this)
    // 不要改 userAgentString：Rust 把系统默认 UA 登记为 Kabegame.cefUserAgent()，须与 Cookie 签发 UA 一致。
    webView.settings.apply {
      javaScriptEnabled = true
      domStorageEnabled = true
      javaScriptCanOpenWindowsAutomatically = true
      setSupportMultipleWindows(false)
      allowFileAccess = false
      allowContentAccess = false
    }
    WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
    CookieManager.getInstance().apply {
      setAcceptCookie(true)
      setAcceptThirdPartyCookies(webView, true)
    }
    webView.webChromeClient = WebChromeClient()
    webView.webViewClient = object : WebViewClient() {
      override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
        val uri = request.url
        if (uri.scheme == "http" || uri.scheme == "https") return false
        if (uri.scheme == "intent") {
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

      override fun onPageStarted(view: WebView, url: String?, favicon: android.graphics.Bitmap?) {
        super.onPageStarted(view, url, favicon)
        url?.let { emit("urlChanged") { put("url", it) } }
      }

      override fun doUpdateVisitedHistory(view: WebView, url: String?, isReload: Boolean) {
        super.doUpdateVisitedHistory(view, url, isReload)
        url?.let { emit("urlChanged") { put("url", it) } }
      }

      override fun onPageFinished(view: WebView, url: String?) {
        super.onPageFinished(view, url)
        url?.let(::rememberVisited)
        emit("pageFinished") {
          put("url", url ?: view.url.orEmpty())
          put("cookie", collectCookie())
        }
      }
    }
    return webView
  }

  private fun rememberVisited(url: String) {
    val siteHost = binding?.host ?: return
    val uri = runCatching { Uri.parse(url) }.getOrNull() ?: return
    if ((uri.scheme == "http" || uri.scheme == "https") && uri.host.equals(siteHost, ignoreCase = true)) {
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

  private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

  override fun onDestroy() {
    if (isFinishing && binding != null && ::content.isInitialized) {
      emit("closed") {
        put("cookie", collectCookie())
      }
    }
    label?.let { SurfRegistry.onActivityGone(it, this) }
    if (::content.isInitialized) content.destroy()
    super.onDestroy()
  }
}
