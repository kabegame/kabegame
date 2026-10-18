package app.kabegame

import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Bitmap
import android.graphics.Color
import android.net.Uri
import android.view.View
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView

/**
 * 畅游内容区之上的弹窗覆盖层：标题栏（来源 host + 关闭）+ 确定进度条 + 普通 `WebView`。
 *
 * 弹窗里是第三方登录页（Google Identity Services 等），不需要也不应该有 Tauri IPC、
 * 注入脚本或下载命令。它与内容页同进程、共享 `CookieManager`，UA 与 Client Hints 跟随
 * 内容页当前模式，弹窗里签发的 Cookie 因此与内容页登录态配对。
 *
 * 两种模式：
 * - `Popup`：立即可见；页面 `window.close()` 经 `onCloseWindow` 关掉它。
 * - `LinkProbe`：`GONE` 的 transport 目标，只用来取 `target=_blank` 的真实目标地址
 *   （`onCreateWindow` 本身不给 URL），第一次拿到 http(s) 地址后交回内容页并自毁。
 *
 * 同时最多一个弹窗；弹窗内不再开新窗口（`setSupportMultipleWindows(false)`）。
 */
class SurfPopup(
  context: Context,
  theme: SurfTheme,
  closeLabel: String,
  private val linkProbe: Boolean,
  uaMode: SurfUaMode,
  private val onLinkResolved: (String) -> Unit,
  private val onDismissed: (SurfPopup) -> Unit,
) : LinearLayout(context) {
  /** 链接探针销毁不触发 Cookie 保存；只有真正显示过的弹窗关闭时才补发一次 `pageFinished`。 */
  val wasVisible: Boolean
    get() = !linkProbe

  val webView: WebView = WebView(context).apply {
    settings.javaScriptEnabled = true
    settings.domStorageEnabled = true
    settings.setSupportMultipleWindows(false) // 弹窗内再开窗就在弹窗自身打开
    CookieManager.getInstance().setAcceptThirdPartyCookies(this, true)
    setBackgroundColor(theme.bg)
    uaMode.applyTo(this)
  }

  private val title = TextView(context).apply {
    setTextColor(theme.fg)
    setTextSize(android.util.TypedValue.COMPLEX_UNIT_SP, 13f)
    setSingleLine(true)
    ellipsize = android.text.TextUtils.TruncateAt.END
  }

  private val progress = ProgressBar(
    context,
    null,
    android.R.attr.progressBarStyleHorizontal,
  ).apply {
    isIndeterminate = false
    max = 100
    visibility = View.GONE
    progressTintList = ColorStateList.valueOf(theme.accent)
    progressBackgroundTintList = ColorStateList.valueOf(Color.TRANSPARENT)
    minimumHeight = surfDp(context, 2)
  }

  private var dismissed = false
  private val probeTimeout = Runnable { dismiss() }

  init {
    orientation = VERTICAL
    setBackgroundColor(theme.bg)
    visibility = if (linkProbe) View.GONE else View.VISIBLE

    val titleBar = LinearLayout(context).apply {
      orientation = HORIZONTAL
      gravity = android.view.Gravity.CENTER_VERTICAL
      setPadding(surfDp(context, 12), 0, surfDp(context, 4), 0)
      addView(title, LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT, 1f))
      addView(
        surfIconButton(context, theme, R.drawable.ic_surf_close).apply {
          contentDescription = closeLabel
          setOnClickListener { dismiss() }
        },
        LayoutParams(surfDp(context, 32), surfDp(context, 44)),
      )
    }
    addView(titleBar, LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, surfDp(context, 44)))
    addView(
      View(context).apply { setBackgroundColor(theme.border) },
      LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, surfDp(context, 1)),
    )
    addView(progress, LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, surfDp(context, 2)))
    addView(webView, LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))

    webView.webViewClient = object : WebViewClient() {
      override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
        if (linkProbe) {
          // 部分 WebView 版本对新窗口的首个导航只走这里、不走 onPageStarted。
          val uri = request.url
          if (uri.scheme == "http" || uri.scheme == "https") resolveProbe(uri.toString())
          return true
        }
        return overrideNonHttp(view, request.url)
      }

      override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
        if (linkProbe) {
          resolveProbe(url)
          return
        }
        title.text = url?.let { Uri.parse(it).host }.orEmpty()
      }

      // 应用内 WebView 共用一个渲染进程：只要有一个 WebView 没在这里返回 true，
      // Chromium 就会杀掉整个应用进程。内容页会关闭畅游，弹窗自己先销毁。
      override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
        android.util.Log.w(
          "Kabegame",
          "Surf popup render process gone (crash=${detail.didCrash()}), closing",
        )
        dismiss()
        return true
      }
    }
    webView.webChromeClient = object : WebChromeClient() {
      override fun onProgressChanged(view: WebView, newProgress: Int) {
        if (newProgress >= 100) {
          progress.visibility = View.GONE
          progress.setProgress(0, false)
          return
        }
        progress.visibility = View.VISIBLE
        progress.setProgress(newProgress, newProgress > progress.progress)
      }

      // 页面 window.close()：OAuth 登录完成后由弹窗自己关闭。
      override fun onCloseWindow(window: WebView) = dismiss()
    }

    if (linkProbe) {
      // 探针没拿到 http(s) 目标（例如命中测试给的是图片地址、实际 href 是 intent:）时不能留下
      // 一个永远隐藏的 WebView；超时静默销毁，不影响内容页。
      postDelayed(probeTimeout, LINK_PROBE_TIMEOUT_MS)
    }
  }

  /** 幂等：先停载、摘链，再 destroy，最后通知 Activity 清引用。 */
  fun dismiss() {
    if (dismissed) return
    dismissed = true
    removeCallbacks(probeTimeout)
    webView.stopLoading()
    (parent as? ViewGroup)?.removeView(this)
    webView.destroy()
    onDismissed(this)
  }

  private fun resolveProbe(url: String?) {
    if (!linkProbe || dismissed) return
    val target = url?.takeIf { it.startsWith("http://") || it.startsWith("https://") } ?: return
    webView.stopLoading()
    onLinkResolved(target)
    dismiss()
  }

  private companion object {
    /** 链接探针等待首个 http(s) 地址的上限。 */
    const val LINK_PROBE_TIMEOUT_MS = 2000L
  }
}
