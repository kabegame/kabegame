package app.kabegame

import android.content.ContentResolver
import android.content.Intent
import android.database.Cursor
import android.graphics.Bitmap
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.OpenableColumns
import android.webkit.MimeTypeMap
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.ActivityResult
import androidx.activity.result.ActivityResultCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.webkit.WebViewCompat
import app.kabegame.plugin.PickerLauncherHost
import java.io.File
import java.io.FileOutputStream

class MainActivity : TauriActivity(), PickerLauncherHost {
  private var folderPickerCallback: ActivityResultCallback<ActivityResult>? = null
  private var filePickerCallback: ActivityResultCallback<ActivityResult>? = null
  private var webView: WebView? = null
  private var pendingImportPath: String? = null

  private val folderPickerLauncher = registerForActivityResult(
    ActivityResultContracts.StartActivityForResult()
  ) { result ->
    folderPickerCallback?.onActivityResult(result)
    folderPickerCallback = null
  }

  private val filePickerLauncher = registerForActivityResult(
    ActivityResultContracts.StartActivityForResult()
  ) { result ->
    filePickerCallback?.onActivityResult(result)
    filePickerCallback = null
  }

  private var pickImagesCallback: ((List<Uri>) -> Unit)? = null
  private val pickImagesLauncher = registerForActivityResult(
    ActivityResultContracts.PickMultipleVisualMedia()
  ) { uris ->
    pickImagesCallback?.invoke(uris)
    pickImagesCallback = null
  }

  private var pickKgpgCallback: ((ActivityResult) -> Unit)? = null
  private val pickKgpgFileLauncher = registerForActivityResult(
    ActivityResultContracts.StartActivityForResult()
  ) { result ->
    pickKgpgCallback?.invoke(result)
    pickKgpgCallback = null
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    android.util.Log.i("Kabegame", "MainActivity.onCreate start")
    try {
      enableEdgeToEdge()
      super.onCreate(savedInstanceState)
      handleIntent(intent)
      android.util.Log.i("Kabegame", "MainActivity.onCreate done")
    } catch (e: Throwable) {
      android.util.Log.e("Kabegame", "MainActivity.onCreate crash", e)
      throw e
    }
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    handleIntent(intent)
  }

  // 重写 onWebViewCreate 以捕获 WebView 实例
  override fun onWebViewCreate(webView: WebView) {
      this.webView = webView
      super.onWebViewCreate(webView)

      // 禁用双指缩放，防止整页被缩放
      webView.settings.apply {
        setSupportZoom(false)
        builtInZoomControls = false
        displayZoomControls = false
      }

      // 消费 hover 事件，使页面内所有 :hover 样式不触发（触摸设备上更一致）
      webView.setOnHoverListener { _, _ -> true }

      // 如果有待处理的导入路径，立即处理
      pendingImportPath?.let {
          triggerImportPlugin(it)
          pendingImportPath = null
      }

      // 包装 WebViewClient 以拦截 content:// 请求并流式返回
      // 使用 post {} 延迟执行，确保 wry 已完成 setWebViewClient(RustWebViewClient)
      webView.post {
          wrapWebViewClientForContentUriStreaming(webView)
      }
  }

  /**
   * 包装 WebViewClient 以支持 content:// URI 流式加载
   * 仅在 API 26+ 上可用（WebView.getWebViewClient() 需要 API 26）
   */
  private fun wrapWebViewClientForContentUriStreaming(webView: WebView) {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
          try {
              val originalClient = WebViewCompat.getWebViewClient(webView)
                  ?: run {
                      android.util.Log.w("Kabegame", "Failed to get original WebViewClient, skipping content:// streaming wrapper")
                      return
                  }
              val wrappedClient = ContentUriStreamClient(applicationContext.contentResolver, originalClient)
              webView.webViewClient = wrappedClient
              android.util.Log.d("Kabegame", "ContentUriStreamClient wrapper installed")
          } catch (e: Exception) {
              android.util.Log.e("Kabegame", "Failed to wrap WebViewClient for content:// streaming", e)
          }
      } else {
          android.util.Log.w("Kabegame", "Content:// streaming requires API 26+, current: ${Build.VERSION.SDK_INT}")
      }
  }

  fun startFolderPicker(intent: Intent, callback: ActivityResultCallback<ActivityResult>) {
    folderPickerCallback = callback
    folderPickerLauncher.launch(intent)
  }

  fun startFilePicker(intent: Intent, callback: ActivityResultCallback<ActivityResult>) {
    filePickerCallback = callback
    filePickerLauncher.launch(intent)
  }

  override fun launchFolderPicker(intent: Intent, onResult: (ActivityResult) -> Unit) {
    startFolderPicker(intent, ActivityResultCallback { onResult(it) })
  }

  override fun launchPickImages(onResult: (List<Uri>) -> Unit) {
    pickImagesCallback = onResult
    val request = androidx.activity.result.PickVisualMediaRequest.Builder()
      .setMediaType(ActivityResultContracts.PickVisualMedia.ImageOnly)
      .build()
    pickImagesLauncher.launch(request)
  }

  override fun launchPickKgpgFile(intent: Intent, onResult: (ActivityResult) -> Unit) {
    pickKgpgCallback = onResult
    pickKgpgFileLauncher.launch(intent)
  }

  /** 将 content:// URI 转为可读文件路径（供需要时使用） */
  fun copyContentUriToFile(uri: Uri): String? = copyContentUriToPrivateStorage(uri)

  private fun handleIntent(intent: Intent?) {
      if (intent == null) return
      
      val action = intent.action
      val data = intent.data
      
      // 处理 ACTION_VIEW（从文件管理器或其他应用打开）
      if (Intent.ACTION_VIEW == action && data != null) {
          val filePath = getFilePathFromUri(data)
          if (filePath != null && filePath.endsWith(".kgpg", ignoreCase = true)) {
              triggerImportPlugin(filePath)
          }
      }
  }

  private fun getFilePathFromUri(uri: Uri): String? {
      return when (uri.scheme) {
          "file" -> uri.path
          "content" -> copyContentUriToPrivateStorage(uri)
          else -> null
      }
  }

  private fun copyContentUriToPrivateStorage(uri: Uri): String? {
      try {
          val contentResolver = applicationContext.contentResolver
          var fileName: String? = null

          // 尝试从 ContentProvider 查询文件名
          contentResolver.query(uri, null, null, null, null)?.use { cursor ->
              if (cursor.moveToFirst()) {
                  val displayNameIndex = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                  if (displayNameIndex != -1) {
                      fileName = cursor.getString(displayNameIndex)
                  }
              }
          }

          // 如果查询失败，尝试从 URI 路径解析
          if (fileName == null) {
              fileName = uri.lastPathSegment
          }

          // 如果还是失败，回退到时间戳生成
          if (fileName == null) {
              val mimeType = contentResolver.getType(uri)
              val extension = MimeTypeMap.getSingleton().getExtensionFromMimeType(mimeType) ?: "kgpg"
              fileName = "imported_plugin_${System.currentTimeMillis()}.$extension"
          }

          // 简单的清理文件名（防止路径遍历等）
          fileName = File(fileName!!).name

          val destFile = File(applicationContext.cacheDir, fileName)
          
          // 如果文件已存在，先删除，确保覆盖
          if (destFile.exists()) {
              destFile.delete()
          }

          contentResolver.openInputStream(uri)?.use { inputStream ->
              FileOutputStream(destFile).use { outputStream ->
                  inputStream.copyTo(outputStream)
              }
          }
          return destFile.absolutePath
      } catch (e: Exception) {
          e.printStackTrace()
          return null
      }
  }

  private fun triggerImportPlugin(filePath: String) {
      if (webView == null) {
          pendingImportPath = filePath
          android.util.Log.d("Kabegame", "WebView not ready, caching import path: $filePath")
          return
      }
      
      // 构建 JS 代码调用前端全局函数
      val json = "\"${filePath.replace("\\", "\\\\").replace("\"", "\\\"")}\""
      val js = """
          if (window.onKabegameImportPlugin) {
              window.onKabegameImportPlugin($json);
          } else {
              console.warn('onKabegameImportPlugin not found');
          }
      """.trimIndent()
      
      android.util.Log.d("Kabegame", "Triggering import for: $filePath")
      runOnUiThread {
          webView?.evaluateJavascript(js, null)
      }
  }
}

/**
 * WebViewClient 包装类：拦截 content:// URI 请求并返回流式 WebResourceResponse
 * 
 * 对于 content:// 请求：
 * - 使用 ContentResolver.openInputStream() 打开流
 * - 返回 WebResourceResponse，WebView 会流式读取并解码渲染
 * 
 * 对于其他请求：
 * - 委托给原始 WebViewClient（通常是 wry 的 RustWebViewClient）
 */
private class ContentUriStreamClient(
    private val contentResolver: ContentResolver,
    private val delegate: WebViewClient
) : WebViewClient() {

    companion object {
        private const val PROXY_HOST = "kbg-content.localhost"
    }

    override fun shouldInterceptRequest(
        view: WebView?,
        request: WebResourceRequest?
    ): WebResourceResponse? {
        val uri = request?.url ?: return delegate.shouldInterceptRequest(view, request)

        // 拦截代理 URL：http://kbg-content.localhost/... → content://...
        if (uri.host == PROXY_HOST) {
            try {
                val contentUriStr = uri.toString().replace("http://$PROXY_HOST/", "content://")
                val contentUri = Uri.parse(contentUriStr)

                val mimeType = contentResolver.getType(contentUri) ?: guessMimeTypeFromUri(contentUri)

                val inputStream = contentResolver.openInputStream(contentUri)
                    ?: run {
                        android.util.Log.w("Kabegame", "Failed to open InputStream for: $contentUri")
                        return delegate.shouldInterceptRequest(view, request)
                    }

                return WebResourceResponse(mimeType, null, inputStream)
            } catch (e: Exception) {
                android.util.Log.e("Kabegame", "Error intercepting proxy URI: $uri", e)
                return delegate.shouldInterceptRequest(view, request)
            }
        }

        return delegate.shouldInterceptRequest(view, request)
    }

    /**
     * 从 URI 路径猜测 MIME 类型（当 ContentResolver.getType() 返回 null 时使用）
     */
    private fun guessMimeTypeFromUri(uri: Uri): String {
        val path = uri.path ?: return "application/octet-stream"
        val ext = path.substringAfterLast('.', "").lowercase()
        return when (ext) {
            "jpg", "jpeg" -> "image/jpeg"
            "png" -> "image/png"
            "gif" -> "image/gif"
            "webp" -> "image/webp"
            "bmp" -> "image/bmp"
            "avif" -> "image/avif"
            else -> "application/octet-stream"
        }
    }

    // 委托其他方法给原始 client
    override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
        return delegate.shouldOverrideUrlLoading(view, request)
    }

    override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
        delegate.onPageStarted(view, url, favicon)
    }

    override fun onPageFinished(view: WebView?, url: String?) {
        delegate.onPageFinished(view, url)
    }

    override fun onReceivedError(
        view: WebView?,
        request: WebResourceRequest?,
        error: WebResourceError?
    ) {
        delegate.onReceivedError(view, request, error)
    }
}
