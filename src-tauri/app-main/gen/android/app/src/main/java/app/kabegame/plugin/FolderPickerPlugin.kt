package app.kabegame.plugin

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.DocumentsContract
import android.util.Log
import androidx.activity.result.ActivityResult
import androidx.documentfile.provider.DocumentFile
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import org.json.JSONArray
import org.json.JSONObject

import app.kabegame.MainActivity

@TauriPlugin
class FolderPickerPlugin(private val activity: Activity) : Plugin(activity) {

    private var pendingInvoke: Invoke? = null

    @InvokeArg
    class ListContentChildrenArgs {
        var uri: String = ""
    }

    /**
     * 列出 content:// URI 下一层的直接子项（不递归、不过滤）。
     * 返回 [{ uri, name, isDirectory }, ...]，由 Rust 端做递归与过滤。
     */
    @Command
    fun listContentChildren(invoke: Invoke) {
        val args = invoke.parseArgs(ListContentChildrenArgs::class.java)
        val uriStr = args.uri
        if (uriStr.isBlank()) {
            invoke.reject("uri 不能为空")
            return
        }
        try {
            val treeUri = Uri.parse(uriStr)
            if (treeUri.scheme != "content") {
                invoke.reject("仅支持 content:// URI")
                return
            }
            val isTreeUri = uriStr.contains("/tree/")
            val doc = if (isTreeUri) {
                DocumentFile.fromTreeUri(activity, treeUri)
            } else {
                DocumentFile.fromSingleUri(activity, treeUri)
            } ?: run {
                invoke.reject("无法解析 content URI")
                return
            }
            val arr = JSONArray()
            if (!isTreeUri && !doc.isDirectory) {
                // 单文件 URI：返回仅包含该文件的一项
                val name = doc.name ?: ""
                val obj = JSONObject()
                obj.put("uri", treeUri.toString())
                obj.put("name", name)
                obj.put("isDirectory", false)
                arr.put(obj)
            } else {
                val files = doc.listFiles() ?: emptyArray()
                for (file in files) {
                    val obj = JSONObject()
                    obj.put("uri", file.uri.toString())
                    obj.put("name", file.name ?: "")
                    obj.put("isDirectory", file.isDirectory)
                    arr.put(obj)
                }
            }
            val result = JSObject()
            result.put("entries", arr)
            invoke.resolve(result)
        } catch (e: Exception) {
            Log.e("FolderPickerPlugin", "listContentChildren failed", e)
            invoke.reject("列出 content URI 子项失败: ${e.message}", e)
        }
    }

    @InvokeArg
    class ReadContentUriArgs {
        var uri: String = ""
    }

    /**
     * 将 content:// 文件复制到应用私有目录并返回可读路径。
     * 仅做“读文件”原语，由 Rust 端决定对哪些 URI 调用。
     */
    @Command
    fun readContentUri(invoke: Invoke) {
        val args = invoke.parseArgs(ReadContentUriArgs::class.java)
        val uriStr = args.uri
        if (uriStr.isBlank()) {
            invoke.reject("uri 不能为空")
            return
        }
        try {
            val uri = Uri.parse(uriStr)
            if (uri.scheme != "content") {
                invoke.reject("仅支持 content:// URI")
                return
            }
            if (activity !is MainActivity) {
                invoke.reject("需要 MainActivity 以复制 content URI")
                return
            }
            val path = activity.copyContentUriToFile(uri)
                ?: run {
                    invoke.reject("复制 content URI 到本地失败")
                    return
                }
            val result = JSObject()
            result.put("path", path)
            invoke.resolve(result)
        } catch (e: Exception) {
            Log.e("FolderPickerPlugin", "readContentUri failed", e)
            invoke.reject("读取 content URI 失败: ${e.message}", e)
        }
    }

    @Command
    fun pickFolder(invoke: Invoke) {
        pendingInvoke = invoke

        // 使用 Storage Access Framework (SAF) 选择文件夹
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).apply {
            addCategory(Intent.CATEGORY_DEFAULT)
            flags = Intent.FLAG_GRANT_READ_URI_PERMISSION or
                    Intent.FLAG_GRANT_WRITE_URI_PERMISSION or
                    Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION
        }

        try {
            // 使用 MainActivity 的文件夹选择器
            if (activity is MainActivity) {
                activity.startFolderPicker(intent) { result ->
                    handleFolderSelection(result)
                }
            } else {
                invoke.reject("Activity 类型不支持，需要 MainActivity")
            }
        } catch (e: Exception) {
            invoke.reject("无法打开文件夹选择器: ${e.message}", e)
            pendingInvoke = null
        }
    }

    private fun handleFolderSelection(result: ActivityResult) {
        val invoke = pendingInvoke ?: return
        pendingInvoke = null

        if (result.resultCode != Activity.RESULT_OK || result.data == null) {
            invoke.reject("用户取消了文件夹选择")
            return
        }

        val treeUri: Uri? = result.data?.data
        if (treeUri == null) {
            invoke.reject("未选择文件夹")
            return
        }

        try {
            // 获取持久化权限
            val contentResolver = activity.contentResolver
            val takeFlags = Intent.FLAG_GRANT_READ_URI_PERMISSION or
                    Intent.FLAG_GRANT_WRITE_URI_PERMISSION
            contentResolver.takePersistableUriPermission(treeUri, takeFlags)

            // 尝试获取实际路径（可能为 null，取决于 Android 版本和存储位置）
            val path = getPathFromUri(treeUri)

            val resultObj = JSObject()
            resultObj.put("uri", treeUri.toString())
            if (path != null) {
                resultObj.put("path", path)
            }

            invoke.resolve(resultObj)
        } catch (e: Exception) {
            invoke.reject("处理文件夹选择失败: ${e.message}", e)
        }
    }

    private fun getPathFromUri(uri: Uri): String? {
        return try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.KITKAT) {
                // 尝试从 DocumentsContract 获取路径
                val docId = DocumentsContract.getTreeDocumentId(uri)
                if (docId.startsWith("primary:")) {
                    // 主存储
                    val path = docId.substringAfter("primary:")
                    "/storage/emulated/0/$path"
                } else if (docId.contains(":")) {
                    // 其他存储
                    val parts = docId.split(":")
                    if (parts.size >= 2) {
                        val storageId = parts[0]
                        val path = parts[1]
                        "/storage/$storageId/$path"
                    } else {
                        null
                    }
                } else {
                    null
                }
            } else {
                null
            }
        } catch (e: Exception) {
            null
        }
    }
}
