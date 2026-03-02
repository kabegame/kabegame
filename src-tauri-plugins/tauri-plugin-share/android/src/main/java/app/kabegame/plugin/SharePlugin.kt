package app.kabegame.plugin

import android.app.Activity
import android.content.ClipData
import android.content.Intent
import android.net.Uri
import androidx.core.content.FileProvider
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File

@TauriPlugin
class SharePlugin(private val activity: Activity) : Plugin(activity) {

    @InvokeArg
    class ShareFileArgs {
        lateinit var file_path: String
        lateinit var mime_type: String
    }

    @InvokeArg
    class CopyImageToClipboardArgs {
        lateinit var file_path: String
        var mime_type: String = "image/png"
    }

    @Command
    fun copyImageToClipboard(invoke: Invoke) {
        val args = invoke.parseArgs(CopyImageToClipboardArgs::class.java)
        val filePath = args.file_path
        val mimeType = args.mime_type.ifBlank { "image/png" }

        try {
            val ext = mimeType.substringAfterLast("/").substringBefore(";").ifBlank { "png" }.replace("jpeg", "jpg")
            val cacheFile = File(activity.cacheDir, "clipboard_image_${System.currentTimeMillis()}.$ext")
            val inputStream = when {
                filePath.startsWith("content://") -> activity.contentResolver.openInputStream(Uri.parse(filePath))
                else -> File(filePath).takeIf { it.exists() }?.inputStream()
            }
            val ins = inputStream ?: run {
                invoke.reject("文件不存在或无法读取: $filePath")
                return
            }
            ins.use { input ->
                cacheFile.outputStream().use { output ->
                    input.copyTo(output)
                }
            }
            val authority = "${activity.packageName}.fileprovider"
            val uri = FileProvider.getUriForFile(activity, authority, cacheFile)
            val clipboard = activity.getSystemService(android.content.Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager
            val clip = ClipData.newUri(activity.contentResolver, "image", uri)
            clipboard.setPrimaryClip(clip)
            invoke.resolve(JSObject().apply { put("success", true) })
        } catch (e: Exception) {
            invoke.reject("复制到剪贴板失败: ${e.message}", e)
        }
    }

    @Command
    fun shareFile(invoke: Invoke) {
        val args = invoke.parseArgs(ShareFileArgs::class.java)
        val filePath = args.file_path
        val mimeType = args.mime_type

        try {
            val file = File(filePath)
            if (!file.exists()) {
                invoke.reject("文件不存在: $filePath")
                return
            }

            val authority = "${activity.packageName}.fileprovider"
            val uri: Uri = try {
                FileProvider.getUriForFile(activity, authority, file)
            } catch (e: Exception) {
                invoke.reject("无法获取文件 URI: ${e.message}", e)
                return
            }

            val intent = Intent(Intent.ACTION_SEND).apply {
                type = mimeType
                putExtra(Intent.EXTRA_STREAM, uri)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }

            activity.startActivity(Intent.createChooser(intent, null))

            invoke.resolve(JSObject().apply {
                put("success", true)
            })
        } catch (e: Exception) {
            invoke.reject("分享失败: ${e.message}", e)
        }
    }
}
