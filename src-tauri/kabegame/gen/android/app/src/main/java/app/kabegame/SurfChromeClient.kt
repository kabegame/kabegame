package app.kabegame

import android.graphics.Bitmap
import android.net.Uri
import android.os.Message
import android.view.View
import android.webkit.ConsoleMessage
import android.webkit.GeolocationPermissions
import android.webkit.JsPromptResult
import android.webkit.JsResult
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebView

/**
 * 转发型 `WebChromeClient`：wry 已经给 `RustWebView` 装好了自己的 `RustWebChromeClient`
 * （全屏视频、权限、文件选择、JS 对话框、标题上报），它是 Kotlin `final` 类，不能继承。
 * 这里包一层，逐方法转发，只额外实现畅游需要的两个回调。
 *
 * **升级 wry / Tauri 时必须核对**：diff `generated/RustWebChromeClient.kt` 的 `override fun`
 * 列表，新增的 override 若不在这里转发，会静默丢掉对应功能。
 */
class SurfChromeClient(
  private val delegate: WebChromeClient,
  private val onProgress: (Int) -> Unit,
  private val onNewWindow: (view: WebView, isUserGesture: Boolean, resultMsg: Message) -> Boolean,
) : WebChromeClient() {
  override fun onProgressChanged(view: WebView, newProgress: Int) {
    delegate.onProgressChanged(view, newProgress)
    onProgress(newProgress)
  }

  override fun onCreateWindow(
    view: WebView,
    isDialog: Boolean,
    isUserGesture: Boolean,
    resultMsg: Message,
  ): Boolean = onNewWindow(view, isUserGesture, resultMsg)

  // —— 以下原样转发 RustWebChromeClient 的覆写；升级 wry 时核对清单 ——
  override fun onShowCustomView(view: View, callback: CustomViewCallback) =
    delegate.onShowCustomView(view, callback)

  override fun onHideCustomView() = delegate.onHideCustomView()

  override fun onPermissionRequest(request: PermissionRequest) =
    delegate.onPermissionRequest(request)

  override fun getDefaultVideoPoster(): Bitmap? = delegate.defaultVideoPoster

  override fun onJsAlert(view: WebView, url: String, message: String, result: JsResult) =
    delegate.onJsAlert(view, url, message, result)

  override fun onJsConfirm(view: WebView, url: String, message: String, result: JsResult) =
    delegate.onJsConfirm(view, url, message, result)

  override fun onJsPrompt(
    view: WebView,
    url: String,
    message: String,
    defaultValue: String?,
    result: JsPromptResult,
  ) = delegate.onJsPrompt(view, url, message, defaultValue, result)

  override fun onGeolocationPermissionsShowPrompt(
    origin: String,
    callback: GeolocationPermissions.Callback,
  ) = delegate.onGeolocationPermissionsShowPrompt(origin, callback)

  override fun onShowFileChooser(
    view: WebView,
    callback: ValueCallback<Array<Uri?>?>,
    params: FileChooserParams,
  ) = delegate.onShowFileChooser(view, callback, params)

  override fun onConsoleMessage(message: ConsoleMessage): Boolean =
    delegate.onConsoleMessage(message)

  override fun onReceivedTitle(view: WebView, title: String) =
    delegate.onReceivedTitle(view, title)
}
