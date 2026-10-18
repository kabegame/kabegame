package app.kabegame

import android.webkit.WebSettings
import android.webkit.WebView
import androidx.webkit.UserAgentMetadata
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewFeature

/**
 * 「桌面版网站 / 移动版」落到某个 WebView 上的唯一实现。
 *
 * 桌面模式把 UA 串换成与系统 WebView 同 Chrome 大版本的 Linux 桌面 UA（由 Rust 的
 * `android_desktop_user_agent()` 派生，内容页建窗时就已写进 WebSettings），同时把
 * UA Client Hints 的 `mobile` / `platform` / `model` 改成桌面值，并开启宽视口与缩放。
 *
 * 移动模式全部还原为默认：`userAgentString = null` 即系统默认 UA，Client Hints 回到
 * 进程级的默认元数据。默认元数据必须由**尚未被改过**的 WebSettings 捕获，因此
 * `SurfActivity.setContentView` 在首次 apply 前显式调用 [captureDefaultMetadata]；
 * 不能按 `SurfUaMode` 实例缓存——`bind` 会换一个实例，而重建后的内容页可能已经是桌面值。
 */
class SurfUaMode(private val desktopUserAgent: String?) {
  var desktop = false
    private set

  val available get() = desktopUserAgent != null

  fun set(enabled: Boolean) {
    desktop = enabled && desktopUserAgent != null
  }

  fun applyTo(webView: WebView) {
    val settings = webView.settings
    // null = 系统默认 UA；桌面 UA 由 Rust 派生，内容页建窗时 wry 已按 builder.user_agent 设好。
    settings.userAgentString = if (desktop) desktopUserAgent else null
    settings.useWideViewPort = desktop
    settings.loadWithOverviewMode = desktop
    settings.setSupportZoom(desktop)
    settings.builtInZoomControls = desktop
    settings.displayZoomControls = false
    applyUserAgentMetadata(settings)
  }

  private fun applyUserAgentMetadata(settings: WebSettings) {
    if (!WebViewFeature.isFeatureSupported(WebViewFeature.USER_AGENT_METADATA)) return
    captureDefaultMetadata(settings)
    val metadata = if (desktop) {
      val base = defaultMetadata
      val builder = if (base != null) UserAgentMetadata.Builder(base) else UserAgentMetadata.Builder()
      builder
        .setMobile(false)
        .setPlatform("Linux")
        .setModel("")
        .build()
    } else {
      defaultMetadata ?: return
    }
    WebSettingsCompat.setUserAgentMetadata(settings, metadata)
  }

  companion object {
    /** 默认 Client Hints：同一进程、同一 WebView 实现下所有 WebView 一致，故只捕获一次。 */
    private var defaultMetadata: UserAgentMetadata? = null
    private var defaultMetadataCaptured = false

    /** 在 WebSettings 尚未被改过时捕获默认元数据；命令行外的会话重建也复用这一份。 */
    internal fun captureDefaultMetadata(settings: WebSettings) {
      if (defaultMetadataCaptured) return
      if (!WebViewFeature.isFeatureSupported(WebViewFeature.USER_AGENT_METADATA)) return
      defaultMetadata = runCatching {
        WebSettingsCompat.getUserAgentMetadata(settings)
      }.getOrNull()
      defaultMetadataCaptured = true
    }
  }
}
