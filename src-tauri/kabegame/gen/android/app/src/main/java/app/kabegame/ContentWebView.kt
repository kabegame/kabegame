package app.kabegame

import android.view.ViewGroup
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import java.util.concurrent.Executor
import java.util.concurrent.RejectedExecutionException

/**
 * 外部页面作 Tauri 主 webview 时的公共处理（畅游、爬虫宿主共用）。
 *
 * 1. wry 的 `addJavascriptInterface("ipc")` 对所有 frame 可见、上报来源却是主框架 URL。
 *    这里换成 `addWebMessageListener("ipc")`，只收主框架消息；设备不支持该特性时关闭 IPC，
 *    不回退到不安全的通道。
 * 2. `addWebMessageListener` 的监听被 Chromium 以 JNI 全局引用持有，监听闭包又捕获了 webview
 *    （进而是 Activity）：不移除监听、不 destroy，关闭后整个 Activity 连同页面渲染、定时器与网络
 *    都会留在进程里，每开关一次就漏一份。
 */
object ContentWebView {
  /**
   * 把 wry 的 `addJavascriptInterface("ipc")` 换成只接收主框架消息的 WebMessageListener。
   *
   * JS 侧仍是 `window.ipc.postMessage(string)`，Tauri 的 `ipc-protocol.js` 无需改动。
   * 回调在 UI 线程，`Rust.ipc` 移出 UI 线程执行：同步命令若再经 MainPipe 等主线程会死锁，
   * 单线程 executor 同时保证消息顺序。
   */
  fun installMainFrameIpc(webView: RustWebView, executor: Executor): Boolean {
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
          executor.execute { Rust.ipc(webView.id, url, data) }
        } catch (_: RejectedExecutionException) {
          // Activity 已销毁（executor 已 shutdown），迟到的消息直接丢弃。
        }
      }
      true
    } catch (error: Exception) {
      // 旧接口已移除，监听装不上就只能浏览；不回退到所有 frame 可见的通道。
      android.util.Log.w("Kabegame", "IPC listener unavailable, disabling IPC", error)
      false
    }
  }

  /** 摘链、停载并销毁内容 WebView；[ipcAvailable] 与 `installMainFrameIpc` 的返回值一致。 */
  fun release(webView: RustWebView, ipcAvailable: Boolean) {
    if (ipcAvailable) {
      runCatching { WebViewCompat.removeWebMessageListener(webView, "ipc") }
    }
    webView.stopLoading()
    (webView.parent as? ViewGroup)?.removeView(webView)
    webView.destroy()
  }
}
