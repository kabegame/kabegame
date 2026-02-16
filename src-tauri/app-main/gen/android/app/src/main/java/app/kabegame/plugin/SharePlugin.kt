package app.kabegame.plugin

import android.app.Activity
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
