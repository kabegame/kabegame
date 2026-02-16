package app.kabegame

import android.content.Intent
import android.database.Cursor
import android.net.Uri
import android.os.Bundle
import android.provider.OpenableColumns
import android.webkit.MimeTypeMap
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.ActivityResult
import androidx.activity.result.ActivityResultCallback
import androidx.activity.result.contract.ActivityResultContracts
import java.io.File
import java.io.FileOutputStream

class MainActivity : TauriActivity() {
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

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    handleIntent(intent)
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
  }

  fun startFolderPicker(intent: Intent, callback: ActivityResultCallback<ActivityResult>) {
    folderPickerCallback = callback
    folderPickerLauncher.launch(intent)
  }

  fun startFilePicker(intent: Intent, callback: ActivityResultCallback<ActivityResult>) {
    filePickerCallback = callback
    filePickerLauncher.launch(intent)
  }

  /** 供 ResourcePlugin 等调用：将 content:// URI 转为可读文件路径 */
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
