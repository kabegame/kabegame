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
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.activity.result.ActivityResultCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.webkit.WebViewCompat
import app.kabegame.plugin.PickerLauncherHost
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.InputStream
import java.net.URLDecoder
import android.content.res.AssetFileDescriptor

class MainActivity : TauriActivity(), PickerLauncherHost {
  private var folderPickerCallback: ActivityResultCallback<ActivityResult>? = null
  private var filePickerCallback: ActivityResultCallback<ActivityResult>? = null
  private var webView: WebView? = null
  private var pendingImportPath: String? = null

  /** 用于在 onPageFinished 时再次注入安全区（主文档加载完成后 document 才稳定） */
  private var lastSystemInsets: Insets? = null
  internal fun injectSafeAreaInsetsForPageFinished(w: WebView) = injectSafeAreaInsets(w, w)
  private fun injectSafeAreaInsets(w: WebView, v: android.view.View, insets: Insets? = null) {
      val root = ViewCompat.getRootWindowInsets(v)
      val i = insets ?: lastSystemInsets ?: root?.getInsets(WindowInsetsCompat.Type.systemBars())
      if (i == null) {
          android.util.Log.w("Kabegame", "[SafeArea] injectSafeAreaInsets early return: insets=null, last=$lastSystemInsets, rootInsets=${root != null}")
          return
      }
      lastSystemInsets = i
      val density = v.resources.displayMetrics.density
      val top = i.top / density
      val bottom = i.bottom / density
      val left = i.left / density
      val right = i.right / density
      android.util.Log.i("Kabegame", "[SafeArea] inject dp: top=$top bottom=$bottom left=$left right=$right (px: top=${i.top} bottom=${i.bottom})")
      val js = """
          (function(){var d=document.documentElement;if(d){d.style.setProperty('--sat','${top}px');d.style.setProperty('--sab','${bottom}px');d.style.setProperty('--sal','${left}px');d.style.setProperty('--sar','${right}px');}})();
      """.trimIndent()
      w.evaluateJavascript(js, null)
  }

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

  private var pickVideosCallback: ((List<Uri>) -> Unit)? = null
  private val pickVideosLauncher = registerForActivityResult(
    ActivityResultContracts.PickMultipleVisualMedia()
  ) { uris ->
    pickVideosCallback?.invoke(uris)
    pickVideosCallback = null
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

      // 注入系统安全区到 WebView CSS 变量，供 env(safe-area-inset-*) 在 Android 上使用
      // #region agent log
      ViewCompat.setOnApplyWindowInsetsListener(webView) { v, windowInsets ->
          val insets = windowInsets.getInsets(WindowInsetsCompat.Type.systemBars())
          android.util.Log.i("Kabegame", "[SafeArea] OnApplyWindowInsetsListener called: top=${insets.top} bottom=${insets.bottom} left=${insets.left} right=${insets.right}")
          injectSafeAreaInsets(webView, v, insets)
          windowInsets
      }
      ViewCompat.requestApplyInsets(webView)
      android.util.Log.i("Kabegame", "[SafeArea] requestApplyInsets done, scheduling delayed inject 500ms")
      webView.postDelayed({
          android.util.Log.i("Kabegame", "[SafeArea] delayed inject running, lastSystemInsets=$lastSystemInsets")
          injectSafeAreaInsets(webView, webView)
      }, 500)
      // #endregion agent log
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
              val wrappedClient = ContentUriStreamClient(applicationContext, originalClient) { v, _ ->
                  v?.let {
                      this@MainActivity.injectSafeAreaInsetsForPageFinished(it)
                      android.util.Log.i("Kabegame", "[SafeArea] onPageFinished inject")
                  }
              }
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

  override fun launchPickVideos(onResult: (List<Uri>) -> Unit) {
    pickVideosCallback = onResult
    val request = androidx.activity.result.PickVisualMediaRequest.Builder()
      .setMediaType(ActivityResultContracts.PickVisualMedia.VideoOnly)
      .build()
    pickVideosLauncher.launch(request)
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
 * WebViewClient 包装类：拦截 content:// 与本地文件请求并返回流式 WebResourceResponse
 * 
 * 对于 content:// 请求（kbg-content.localhost）：
 * - 使用 ContentResolver.openInputStream() 打开流
 * - 返回 WebResourceResponse，WebView 会流式读取并解码渲染
 * 
 * 对于本地文件请求（kbg-local.localhost）：
 * - 将 URL path 解码为本地文件路径，仅允许应用私有目录（filesDir/cacheDir/externalFilesDir）
 * - 使用 FileInputStream 返回
 * 
 * 对于其他请求：
 * - 委托给原始 WebViewClient（通常是 wry 的 RustWebViewClient）
 */
private class ContentUriStreamClient(
    private val context: android.content.Context,
    private val delegate: WebViewClient,
    private val onPageFinishedCallback: ((WebView?, String?) -> Unit)? = null
) : WebViewClient() {

    private val contentResolver: ContentResolver get() = context.contentResolver

    companion object {
        private const val PROXY_HOST_CONTENT = "kbg-content.localhost"
        private const val PROXY_HOST_LOCAL = "kbg-local.localhost"
    }

    override fun shouldInterceptRequest(
        view: WebView?,
        request: WebResourceRequest?
    ): WebResourceResponse? {
        val uri = request?.url ?: return delegate.shouldInterceptRequest(view, request)

        // 拦截本地文件代理 URL：http://kbg-local.localhost/<path> → 应用私有目录文件
        if (uri.host == PROXY_HOST_LOCAL) {
            try {
                val pathRaw = uri.path ?: return delegate.shouldInterceptRequest(view, request)
                val pathDecoded = URLDecoder.decode(pathRaw, "UTF-8")
                if (pathDecoded.isBlank()) return delegate.shouldInterceptRequest(view, request)
                val file = File(pathDecoded.trim())
                if (!file.exists() || !file.isFile) {
                    android.util.Log.w("Kabegame", "Local file not found: $pathDecoded")
                    return delegate.shouldInterceptRequest(view, request)
                }
                val canonicalPath = file.canonicalPath
                val allowedDirs = listOfNotNull(
                    context.filesDir?.canonicalPath,
                    context.cacheDir?.canonicalPath,
                    context.getExternalFilesDir(null)?.canonicalPath
                )
                val allowed = allowedDirs.any { dir -> canonicalPath.startsWith(dir) }
                if (!allowed) {
                    android.util.Log.w("Kabegame", "Local file path not in allowed dirs: $canonicalPath")
                    return delegate.shouldInterceptRequest(view, request)
                }
                val mimeType = MimeTypeMap.getSingleton().getMimeTypeFromExtension(
                    file.extension.lowercase()
                ) ?: "application/octet-stream"
                val inputStream = FileInputStream(file)
                return WebResourceResponse(mimeType, null, inputStream)
            } catch (e: Exception) {
                android.util.Log.e("Kabegame", "Error serving local file: $uri", e)
                return delegate.shouldInterceptRequest(view, request)
            }
        }

        // 拦截代理 URL：http://kbg-content.localhost/... → content://...
        if (uri.host == PROXY_HOST_CONTENT) {
            try {
                val contentUriStr = uri.toString().replace("http://$PROXY_HOST_CONTENT/", "content://")
                val contentUri = Uri.parse(contentUriStr)

                val mimeType = contentResolver.getType(contentUri) ?: guessMimeTypeFromUri(contentUri)

                // 视频等媒体需要 Range 支持，否则 WebView 会一直加载不播放
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                    val rangeHeader = request.requestHeaders?.get("Range")
                    if (!rangeHeader.isNullOrBlank()) {
                        val rangeResponse = tryOpenRangeResponse(contentUri, mimeType, rangeHeader)
                        if (rangeResponse != null) return rangeResponse
                        // Range 解析或打开失败则回退到整段流
                    }
                }

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
     * 解析 Range 头并返回 206 响应；失败返回 null，调用方回退到整段流。
     * 格式：bytes=start-end 或 bytes=start-
     */
    private fun tryOpenRangeResponse(contentUri: Uri, mimeType: String, rangeHeader: String): WebResourceResponse? {
        val range = parseRangeHeader(rangeHeader) ?: return null
        val afd = try {
            contentResolver.openAssetFileDescriptor(contentUri, "r") ?: return null
        } catch (e: Exception) {
            return null
        }
        return try {
            val total = afd.length
            if (total < 0) {
                afd.close()
                return null // 长度未知时不支持 range
            }
            val totalSize = total.toLong()
            var start = range.first
            var end = range.second
            if (end < 0) end = totalSize - 1
            end = minOf(end, totalSize - 1)
            if (start > end) {
                afd.close()
                return null
            }
            start = maxOf(0, start)

            val inputStream = afd.createInputStream() ?: run {
                afd.close()
                return null
            }
            val skipped = inputStream.skip(start)
            if (skipped != start) {
                inputStream.close()
                afd.close()
                return null
            }
            val contentLength = (end - start + 1).toInt()
            val boundedStream = BoundedInputStream(inputStream, contentLength)
            val streamWithAfd = StreamWithAfd(boundedStream, afd)

            val responseHeaders = mutableMapOf<String, String>(
                "Content-Range" to "bytes $start-$end/$totalSize",
                "Content-Length" to contentLength.toString(),
                "Accept-Ranges" to "bytes",
            )
            WebResourceResponse(mimeType, null, 206, "Partial Content", responseHeaders, streamWithAfd)
        } catch (e: Exception) {
            android.util.Log.w("Kabegame", "Range response failed for $contentUri", e)
            afd.close()
            null
        }
    }

    /** 关闭流时同时关闭 AssetFileDescriptor，避免泄漏 */
    private class StreamWithAfd(
        private val inner: InputStream,
        private val afd: AssetFileDescriptor
    ) : InputStream() {
        override fun read(): Int = inner.read()
        override fun read(b: ByteArray, off: Int, len: Int): Int = inner.read(b, off, len)
        override fun close() {
            try {
                inner.close()
            } finally {
                afd.close()
            }
        }
    }

    /** 解析 "bytes=start-end" 或 "bytes=start-"；返回 Pair(start, end)，end 为 -1 表示到末尾 */
    private fun parseRangeHeader(rangeHeader: String): Pair<Long, Long>? {
        val value = rangeHeader.trim().lowercase()
        if (!value.startsWith("bytes=")) return null
        val part = value.removePrefix("bytes=").trim()
        val dash = part.indexOf('-')
        if (dash < 0) return null
        val startStr = part.substring(0, dash).trim()
        val endStr = part.substring(dash + 1).trim()
        val start = startStr.toLongOrNull() ?: return null
        if (start < 0) return null
        val end = if (endStr.isEmpty()) -1L else endStr.toLongOrNull() ?: return null
        if (end >= 0 && end < start) return null
        return Pair(start, end)
    }

    /**
     * 只读取最多 maxBytes 的输入流，之后返回 -1
     */
    private class BoundedInputStream(
        private val inner: InputStream,
        private var remaining: Int
    ) : InputStream() {
        override fun read(): Int {
            if (remaining <= 0) return -1
            val b = inner.read()
            if (b >= 0) remaining--
            return b
        }

        override fun read(b: ByteArray, off: Int, len: Int): Int {
            if (remaining <= 0) return -1
            val toRead = minOf(len, remaining)
            val n = inner.read(b, off, toRead)
            if (n > 0) remaining -= n
            return n
        }

        override fun close() {
            inner.close()
        }
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
        onPageFinishedCallback?.invoke(view, url)
    }

    override fun onReceivedError(
        view: WebView?,
        request: WebResourceRequest?,
        error: WebResourceError?
    ) {
        delegate.onReceivedError(view, request, error)
    }
}
