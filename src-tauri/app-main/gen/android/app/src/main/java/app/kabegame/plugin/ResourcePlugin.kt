package app.kabegame.plugin

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.util.Log
import androidx.activity.result.ActivityResult
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import org.json.JSONArray
import java.io.File
import java.io.FileOutputStream
import java.io.IOException

import app.kabegame.MainActivity

@TauriPlugin
class ResourcePlugin(private val activity: Activity) : Plugin(activity) {

    private var pendingPickKgpgInvoke: Invoke? = null

    /** 打开文件选择器选择 .kgpg 文件，将 content:// URI 复制到应用私有目录后返回可读路径 */
    @Command
    fun pickKgpgFile(invoke: Invoke) {
        pendingPickKgpgInvoke = invoke
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = "*/*"
            putExtra(Intent.EXTRA_MIME_TYPES, arrayOf("application/octet-stream", "application/x-kabegame-kgpg"))
        }
        try {
            if (activity is MainActivity) {
                activity.startFilePicker(intent) { result ->
                    handleFilePickerResult(result)
                }
            } else {
                invoke.reject("Activity 类型不支持，需要 MainActivity")
                pendingPickKgpgInvoke = null
            }
        } catch (e: Exception) {
            invoke.reject("无法打开文件选择器: ${e.message}", e)
            pendingPickKgpgInvoke = null
        }
    }

    private fun handleFilePickerResult(result: ActivityResult) {
        val invoke = pendingPickKgpgInvoke ?: return
        pendingPickKgpgInvoke = null
        if (result.resultCode != Activity.RESULT_OK || result.data?.data == null) {
            invoke.reject("用户取消了选择")
            return
        }
        val uri: Uri = result.data!!.data!!
        val path = when (uri.scheme) {
            "file" -> uri.path
            "content" -> if (activity is MainActivity) activity.copyContentUriToFile(uri) else null
            else -> null
        }
        if (path != null && path.endsWith(".kgpg", ignoreCase = true)) {
            val obj = JSObject()
            obj.put("path", path)
            invoke.resolve(obj)
        } else {
            invoke.reject("未选择有效的 .kgpg 文件")
        }
    }

    @InvokeArg
    class ExtractBundledPluginsArgs {
        lateinit var target_dir: String
    }

    @Command
    fun extractBundledPlugins(invoke: Invoke) {
        val args = invoke.parseArgs(ExtractBundledPluginsArgs::class.java)
        Log.i("ResourcePlugin", "extractBundledPlugins: ${args.target_dir}")
        try {
            val targetDirectory = File(args.target_dir)
            if (!targetDirectory.exists()) {
                targetDirectory.mkdirs()
            }
            if (!targetDirectory.isDirectory) {
                invoke.reject("目标路径不是目录: ${args.target_dir}")
                return
            }

            val assetManager = activity.assets
            val assetPath = "resources/plugins"
            val extractedFiles = mutableListOf<String>()

            try {
                // List all files in assets/resources/plugins/
                val files = assetManager.list(assetPath)
                if (files == null || files.isEmpty()) {
                    // No plugins bundled, return empty list (not an error)
                    // Use JSONArray so Rust receives a sequence; put(String[]) becomes toString() and breaks deserialization
                    invoke.resolve(JSObject().apply {
                        put("files", JSONArray())
                        put("count", 0)
                    })
                    return
                }

                // Extract each .kgpg file
                for (fileName in files) {
                    if (!fileName.endsWith(".kgpg")) {
                        continue
                    }

                    val assetFilePath = "$assetPath/$fileName"
                    val targetFile = File(targetDirectory, fileName)

                    try {
                        // Open asset stream
                        val inputStream = assetManager.open(assetFilePath)
                        val outputStream = FileOutputStream(targetFile)

                        // Copy file
                        val buffer = ByteArray(8192)
                        var bytesRead: Int
                        while (inputStream.read(buffer).also { bytesRead = it } != -1) {
                            outputStream.write(buffer, 0, bytesRead)
                        }

                        inputStream.close()
                        outputStream.close()

                        extractedFiles.add(fileName)
                    } catch (e: IOException) {
                        // Log error but continue with other files
                        android.util.Log.e("ResourcePlugin", "Failed to extract $fileName: ${e.message}")
                    }
                }

                // Use JSONArray so Rust receives a sequence; put(String[]) becomes toString() and breaks deserialization
                val filesArray = JSONArray()
                extractedFiles.forEach { filesArray.put(it) }
                invoke.resolve(JSObject().apply {
                    put("files", filesArray)
                    put("count", extractedFiles.size)
                })
            } catch (e: IOException) {
                // Asset path doesn't exist or can't be listed
                invoke.reject("无法访问资源目录 $assetPath: ${e.message}")
            }
        } catch (e: Exception) {
            invoke.reject("提取插件失败: ${e.message}", e)
        }
    }
}
