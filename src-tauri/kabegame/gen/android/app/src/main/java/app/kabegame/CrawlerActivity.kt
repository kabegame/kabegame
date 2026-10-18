package app.kabegame

import android.app.ActivityManager
import android.graphics.Bitmap
import android.os.Bundle
import android.view.View
import android.webkit.CookieManager
import android.webkit.RenderProcessGoneDetail
import android.webkit.URLUtil
import android.webkit.WebSettings
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.OnBackPressedCallback
import androidx.webkit.WebViewCompat
import app.tauri.plugin.JSObject
import java.util.concurrent.Executors

/**
 * WebView 爬虫任务的宿主 Activity（label = `crawler-<task_id>`）。
 *
 * 它**不显示页面**：wry 把 `RustWebView` 交给 `setContentView` 时，这里只做 IPC / client /
 * 下载拦截，然后交给 `CrawlerHost` 停靠到主界面窗口、垫在主 webview 下面。Activity 自己在
 * 第一帧之前 `moveTaskToBack`，用户看不到它；它继续承担 wry 的创建 / 销毁回调与最近任务卡片。
 *
 * 不能 `excludeFromRecents`：实测不进最近任务的栈一离开前台就被 RecentTasks 回收；代价是最近
 * 任务里可能多一张卡（同应用的栈通常被启动器合并）。用户划掉它等同取消任务。
 */
class CrawlerActivity : TauriActivity() {
  private var content: RustWebView? = null
  private var binding: CrawlerBinding? = null
  private var label: String? = null
  private val ipcExecutor = Executors.newSingleThreadExecutor { runnable ->
    Thread(runnable, "crawler-ipc").apply { isDaemon = true }
  }

  /** 主框架 IPC 是否可用；`attach` 把它回传给 Rust。 */
  var ipcAvailable: Boolean = false
    private set

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    // 第一帧之前退到后台：宿主的窗口不参与显示，页面马上会被停靠到主界面下。
    moveTaskToBack(true)
    // 返回键不 finish：把页面放回主界面下面（收起），任务继续跑。
    onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() {
        val current = label
        if (current != null) CrawlerHost.hide(current) else moveTaskToBack(true)
      }
    })
  }

  // wry 在 onWebViewCreate 之后调用 setContentView；只有在这里才能拿到底层 webview。
  override fun setContentView(view: View?) {
    val webview = view as? RustWebView
    if (webview == null) {
      super.setContentView(view)
      return
    }
    content = webview
    label = webview.id

    // 顺序与畅游一致：先换 IPC，再包 client / 装下载拦截；首个 loadUrl 是 post 出去的。
    ipcAvailable = ContentWebView.installMainFrameIpc(webview, ipcExecutor)
    wrapWebViewClient(webview)
    installDownloadInterceptor(webview)
    applyDesktopSiteIfNeeded(webview)

    WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
    CookieManager.getInstance().apply {
      setAcceptCookie(true)
      // 第三方 Cookie 已开启，以兼容常见 SSO。
      setAcceptThirdPartyCookies(webview, true)
    }

    // 不放进自己的窗口：交给 CrawlerHost 停靠到主界面内容根节点、z = -1。
    CrawlerHost.dock(webview.id, webview)
    CrawlerRegistry.onActivityReady(webview.id, this)
  }

  /**
   * 目标站点的畅游记录是「桌面版网站」时，Rust 建窗已用 `builder.user_agent` 换成桌面 UA；
   * 这里在首个（post 出去的）`loadUrl` 之前补齐 Client Hints 与视口，与畅游内容页同一份实现。
   * UA 未被改过（移动模式）时什么都不做。
   */
  private fun applyDesktopSiteIfNeeded(webView: RustWebView) {
    val userAgent = webView.settings.userAgentString
    if (userAgent == WebSettings.getDefaultUserAgent(this)) return
    SurfUaMode.captureDefaultMetadata(webView.settings)
    SurfUaMode(userAgent).apply { set(true) }.applyTo(webView)
  }

  /** Rust `attach` 到达：写入任务名与工具栏文案（文案由 Rust 按应用语言下发）。 */
  fun bind(binding: CrawlerBinding) {
    this.binding = binding
    setTaskDescription(ActivityManager.TaskDescription(binding.taskName))
    CrawlerHost.applyTexts(binding.label, binding.texts)
    if (label == null) label = binding.label
  }

  /** 工具栏「取消任务」：Rust 收 `cancel` 后以取消结束会话并销毁窗口。 */
  fun emitCancel() {
    emit("cancel")
  }

  override fun onResume() {
    super.onResume()
    // 宿主的窗口永远是空的（页面停靠在主界面窗口里）。从最近任务点开这张卡时立即退回主界面，
    // 不把一个空白页面留给用户；首次创建时这次调用与 onCreate 里的那次重复，无害。
    moveTaskToBack(true)
  }

  override fun onPause() {
    super.onPause()
    // wry 在 onPause 里调 WebView.onPause()。页面已经停靠到主界面窗口，暂停态会让它判成
    // hidden（计时器节流、长任务停摆）；这里立即撤销。真到后台时窗口本身不可见，Chromium
    // 仍会冻结，不需要额外处理。
    content?.onResume()
  }

  override fun onDestroy() {
    val current = label
    // 只有真正结束（不是配置变化重建）才看「预期关闭」：重建时把 binding 交给新实例。
    val expected = isFinishing && current != null &&
      CrawlerRegistry.consumeExpectedClose(current)
    // 用户从最近任务划掉宿主（不是 Rust 主动 close）：回发 closed，由 Rust 取消任务。
    if (isFinishing && !expected && binding != null) {
      emit("closed")
    }
    current?.let {
      CrawlerHost.undock(it)
      CrawlerRegistry.onActivityGone(
        it,
        this,
        binding?.takeIf { isChangingConfigurations },
      )
    }
    ipcExecutor.shutdown()
    // wry 的 Rust.onWebviewDestroy 只清 Rust 侧回调表，从不调 WebView.destroy()；放在 super 之后，
    // 保证 wry 先拿到 webview id。
    super.onDestroy()
    content?.let { ContentWebView.release(it, ipcAvailable) }
    content = null
  }

  private fun wrapWebViewClient(webView: RustWebView) {
    val delegate = WebViewCompat.getWebViewClient(webView) ?: return
    webView.webViewClient = object : WebViewClient() {
      override fun shouldInterceptRequest(
        view: WebView,
        request: WebResourceRequest,
      ): WebResourceResponse? = delegate.shouldInterceptRequest(view, request)

      override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
        // 与畅游同口径：只放行 http(s)，intent: / 其它 scheme 一律拦截。
        val scheme = request.url.scheme
        if (scheme == "http" || scheme == "https") {
          return delegate.shouldOverrideUrlLoading(view, request)
        }
        return true
      }

      override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
        delegate.onPageStarted(view, url, favicon)
      }

      override fun onPageFinished(view: WebView, url: String?) {
        delegate.onPageFinished(view, url)
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
      }

      // 应用内 WebView 共用一个渲染进程，不返回 true 就会被 Chromium 连带杀掉整个 app。
      // 页面已不可用：以 renderGone 结束任务，宿主窗口交给 Rust 的 destroy 关闭。
      override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
        android.util.Log.w(
          "Kabegame",
          "Crawler render process gone (crash=${detail.didCrash()}), ending task",
        )
        label?.let { CrawlerRegistry.markExpectedClose(it) }
        emit("renderGone") {
          put("crashed", detail.didCrash())
        }
        return true
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

  private fun emit(type: String, extra: JSObject.() -> Unit = {}) {
    binding?.events?.send(JSObject().apply {
      put("type", type)
      extra()
    })
  }
}
