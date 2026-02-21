package app.kabegame.plugin.picker

import android.app.Activity
import android.content.ContentValues
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.DocumentsContract
import android.provider.MediaStore
import android.provider.OpenableColumns
import android.util.Base64
import android.util.Log
import android.webkit.MimeTypeMap
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
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.util.zip.ZipInputStream

@TauriPlugin
class PickerPlugin(private val activity: Activity) : Plugin(activity) {

    private var pendingInvoke: Invoke? = null
    private var pendingImagesInvoke: Invoke? = null
    private var pendingKgpgInvoke: Invoke? = null

    /** Launcher 由 Activity 在 onCreate 前注册并通过 PickerLauncherHost 提供，避免 RESUMED 后 register 崩溃 */
    private val launcherHost: PickerLauncherHost? = activity as? PickerLauncherHost

    /** 打开文件选择器选择 .kgpg 文件，将 content:// URI 复制到应用私有目录后返回可读路径 */
    @Command
    fun pickKgpgFile(invoke: Invoke) {
        pendingKgpgInvoke = invoke
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = "*/*"
            putExtra(Intent.EXTRA_MIME_TYPES, arrayOf("application/octet-stream", "application/x-kabegame-kgpg"))
        }
        val host = launcherHost
        if (host != null) {
            host.launchPickKgpgFile(intent) { result -> handleKgpgFileResult(result) }
        } else {
            invoke.reject("Activity 未实现 PickerLauncherHost")
            pendingKgpgInvoke = null
        }
    }

    private fun handleKgpgFileResult(result: ActivityResult) {
        val invoke = pendingKgpgInvoke ?: return
        pendingKgpgInvoke = null
        if (result.resultCode != Activity.RESULT_OK || result.data?.data == null) {
            invoke.reject("用户取消了选择")
            return
        }
        val uri: Uri = result.data!!.data!!
        val path = when (uri.scheme) {
            "file" -> uri.path
            "content" -> copyContentUriToPrivateStorage(uri)
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
        var target_dir: String = ""
    }

    @Command
    fun extractBundledPlugins(invoke: Invoke) {
        val args = invoke.parseArgs(ExtractBundledPluginsArgs::class.java)
        Log.i("PickerPlugin", "extractBundledPlugins: ${args.target_dir}")
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
                val files = assetManager.list(assetPath)
                if (files == null || files.isEmpty()) {
                    invoke.resolve(JSObject().apply {
                        put("files", JSONArray())
                        put("count", 0)
                    })
                    return
                }
                for (fileName in files) {
                    if (!fileName.endsWith(".kgpg")) continue
                    val assetFilePath = "$assetPath/$fileName"
                    val targetFile = File(targetDirectory, fileName)
                    try {
                        assetManager.open(assetFilePath).use { inputStream ->
                            FileOutputStream(targetFile).use { outputStream ->
                                inputStream.copyTo(outputStream)
                            }
                        }
                        extractedFiles.add(fileName)
                    } catch (e: IOException) {
                        Log.e("PickerPlugin", "Failed to extract $fileName: ${e.message}")
                    }
                }
                val filesArray = JSONArray()
                extractedFiles.forEach { filesArray.put(it) }
                invoke.resolve(JSObject().apply {
                    put("files", filesArray)
                    put("count", extractedFiles.size)
                })
            } catch (e: IOException) {
                invoke.reject("无法访问资源目录 $assetPath: ${e.message}")
            }
        } catch (e: Exception) {
            invoke.reject("提取插件失败: ${e.message}", e)
        }
    }

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
            Log.e("PickerPlugin", "listContentChildren failed", e)
            invoke.reject("列出 content URI 子项失败: ${e.message}", e)
        }
    }

    @InvokeArg
    class ReadContentUriArgs {
        var uri: String = ""
    }

    /**
     * 将 content:// 文件复制到应用私有目录并返回可读路径。
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
            val path = copyContentUriToPrivateStorage(uri)
                ?: run {
                    invoke.reject("复制 content URI 到本地失败")
                    return
                }
            val result = JSObject()
            result.put("path", path)
            invoke.resolve(result)
        } catch (e: Exception) {
            Log.e("PickerPlugin", "readContentUri failed", e)
            invoke.reject("读取 content URI 失败: ${e.message}", e)
        }
    }

    @InvokeArg
    class IsDirectoryArgs {
        var uri: String = ""
    }

    @Command
    fun isDirectory(invoke: Invoke) {
        val args = invoke.parseArgs(IsDirectoryArgs::class.java)
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
            val isTreeUri = uriStr.contains("/tree/")
            val doc = if (isTreeUri) {
                DocumentFile.fromTreeUri(activity, uri)
            } else {
                DocumentFile.fromSingleUri(activity, uri)
            } ?: run {
                invoke.reject("无法解析 content URI")
                return
            }
            val result = JSObject()
            result.put("isDirectory", doc.isDirectory)
            invoke.resolve(result)
        } catch (e: Exception) {
            Log.e("PickerPlugin", "isDirectory failed", e)
            invoke.reject("判断目录失败: ${e.message}", e)
        }
    }

    @InvokeArg
    class GetMimeTypeArgs {
        var uri: String = ""
    }

    @Command
    fun getMimeType(invoke: Invoke) {
        val args = invoke.parseArgs(GetMimeTypeArgs::class.java)
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
            val mimeType = activity.contentResolver.getType(uri)
            val result = JSObject()
            result.put("mimeType", mimeType)
            invoke.resolve(result)
        } catch (e: Exception) {
            Log.e("PickerPlugin", "getMimeType failed", e)
            invoke.reject("获取 MIME 类型失败: ${e.message}", e)
        }
    }

    @InvokeArg
    class ReadFileBytesArgs {
        var uri: String = ""
    }

    @Command
    fun readFileBytes(invoke: Invoke) {
        val args = invoke.parseArgs(ReadFileBytesArgs::class.java)
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
            val bytes = activity.contentResolver.openInputStream(uri)?.use { it.readBytes() }
                ?: run {
                    invoke.reject("无法读取 content URI")
                    return
                }
            val base64 = Base64.encodeToString(bytes, Base64.NO_WRAP)
            val result = JSObject()
            result.put("data", base64)
            result.put("size", bytes.size.toLong())
            invoke.resolve(result)
        } catch (e: Exception) {
            Log.e("PickerPlugin", "readFileBytes failed", e)
            invoke.reject("读取 content URI 失败: ${e.message}", e)
        }
    }

    @InvokeArg
    class TakePersistablePermissionArgs {
        var uri: String = ""
    }

    @Command
    fun takePersistablePermission(invoke: Invoke) {
        val args = invoke.parseArgs(TakePersistablePermissionArgs::class.java)
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
            try {
                activity.contentResolver.takePersistableUriPermission(
                    uri,
                    Intent.FLAG_GRANT_READ_URI_PERMISSION
                )
            } catch (e: SecurityException) {
                // 不支持持久授权（如单文档 URI），静默忽略
            }
            invoke.resolve(JSObject())
        } catch (e: Exception) {
            Log.e("PickerPlugin", "takePersistablePermission failed", e)
            invoke.reject("请求持久权限失败: ${e.message}", e)
        }
    }

    @InvokeArg
    class ExtractArchiveArgs {
        var archiveUri: String = ""
        var folderName: String = ""
    }

    private val IMAGE_EXTENSIONS = setOf(
        "jpg", "jpeg", "png", "gif", "webp", "bmp", "svg"
    )

    @Command
    fun extractArchiveToMediaStore(invoke: Invoke) {
        val args = invoke.parseArgs(ExtractArchiveArgs::class.java)
        val archiveUriStr = args.archiveUri
        val folderName = args.folderName
        if (archiveUriStr.isBlank() || folderName.isBlank()) {
            invoke.reject("archiveUri 和 folderName 不能为空")
            return
        }
        try {
            val uri = Uri.parse(archiveUriStr)
            if (uri.scheme != "content") {
                invoke.reject("仅支持 content:// URI")
                return
            }
            val result = extractZipToMediaStore(uri, folderName)
            val resultObj = JSObject()
            resultObj.put("uris", JSONArray(result.uris))
            resultObj.put("count", result.count)
            invoke.resolve(resultObj)
        } catch (e: Exception) {
            Log.e("PickerPlugin", "extractArchiveToMediaStore failed", e)
            invoke.reject("解压到 MediaStore 失败: ${e.message}", e)
        }
    }

    private data class ExtractResult(val uris: List<String>, val count: Int)

    private fun extractZipToMediaStore(archiveUri: Uri, folderName: String): ExtractResult {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            throw IllegalStateException("MediaStore RELATIVE_PATH 需要 Android 10+")
        }
        val contentResolver = activity.contentResolver
        val relativePath = "Pictures/Kabegame/$folderName/"
        val usedNames = mutableSetOf<String>()
        val uris = mutableListOf<String>()

        contentResolver.openInputStream(archiveUri)?.use { inputStream ->
            ZipInputStream(inputStream).use { zipStream ->
                var entry = zipStream.nextEntry
                while (entry != null) {
                    if (!entry.isDirectory) {
                        val name = entry.name
                        val ext = name.substringAfterLast('.', "").lowercase()
                        if (ext in IMAGE_EXTENSIONS) {
                            val baseName = name.substringAfterLast('/').substringBeforeLast('.')
                            val safeName = baseName.take(100).replace(Regex("[^a-zA-Z0-9._-]"), "_")
                            var displayName = "$safeName.$ext"
                            var idx = 1
                            while (displayName in usedNames) {
                                displayName = "${safeName} ($idx).$ext"
                                idx++
                            }
                            usedNames.add(displayName)

                            val mimeType = when (ext) {
                                "jpg", "jpeg" -> "image/jpeg"
                                "png" -> "image/png"
                                "gif" -> "image/gif"
                                "webp" -> "image/webp"
                                "bmp" -> "image/bmp"
                                "svg" -> "image/svg+xml"
                                "ico" -> "image/x-icon"
                                else -> "image/$ext"
                            }

                            val values = ContentValues().apply {
                                put(MediaStore.Images.Media.DISPLAY_NAME, displayName)
                                put(MediaStore.Images.Media.MIME_TYPE, mimeType)
                                put(MediaStore.Images.Media.RELATIVE_PATH, relativePath)
                            }
                            val insertUri = contentResolver.insert(
                                MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
                                values
                            )
                            insertUri?.let {
                                contentResolver.openOutputStream(it)?.use { outputStream ->
                                    zipStream.copyTo(outputStream)
                                }
                                uris.add(it.toString())
                            }
                        }
                    }
                    zipStream.closeEntry()
                    entry = zipStream.nextEntry
                }
            }
        } ?: throw IllegalStateException("无法打开压缩包 URI")
        return ExtractResult(uris, uris.size)
    }

    @Command
    fun pickImages(invoke: Invoke) {
        pendingImagesInvoke = invoke
        val host = launcherHost
        if (host != null) {
            host.launchPickImages { uris -> handleImagesSelection(uris) }
        } else {
            invoke.reject("Activity 未实现 PickerLauncherHost")
            pendingImagesInvoke = null
        }
    }

    private fun handleImagesSelection(uris: List<Uri>) {
        val invoke = pendingImagesInvoke ?: return
        pendingImagesInvoke = null
        try {
            val arr = JSONArray()
            for (u in uris) {
                arr.put(u.toString())
            }
            val result = JSObject()
            result.put("uris", arr)
            invoke.resolve(result)
        } catch (e: Exception) {
            invoke.reject("处理图片选择失败: ${e.message}", e)
        }
    }

    @Command
    fun pickFolder(invoke: Invoke) {
        pendingInvoke = invoke
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).apply {
            addCategory(Intent.CATEGORY_DEFAULT)
            flags = Intent.FLAG_GRANT_READ_URI_PERMISSION or
                Intent.FLAG_GRANT_WRITE_URI_PERMISSION or
                Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION
        }
        val host = launcherHost
        if (host != null) {
            host.launchFolderPicker(intent) { result -> handleFolderSelection(result) }
        } else {
            invoke.reject("Activity 未实现 PickerLauncherHost")
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
            val contentResolver = activity.contentResolver
            val takeFlags = Intent.FLAG_GRANT_READ_URI_PERMISSION or
                Intent.FLAG_GRANT_WRITE_URI_PERMISSION
            contentResolver.takePersistableUriPermission(treeUri, takeFlags)

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
                val docId = DocumentsContract.getTreeDocumentId(uri)
                if (docId.startsWith("primary:")) {
                    val path = docId.substringAfter("primary:")
                    "/storage/emulated/0/$path"
                } else if (docId.contains(":")) {
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

    private fun copyContentUriToPrivateStorage(uri: Uri): String? {
        try {
            val contentResolver = activity.applicationContext.contentResolver
            var fileName: String? = null

            contentResolver.query(uri, null, null, null, null)?.use { cursor ->
                if (cursor.moveToFirst()) {
                    val displayNameIndex = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                    if (displayNameIndex != -1) {
                        fileName = cursor.getString(displayNameIndex)
                    }
                }
            }

            if (fileName == null) {
                fileName = uri.lastPathSegment
            }

            if (fileName == null) {
                val mimeType = contentResolver.getType(uri)
                val extension = MimeTypeMap.getSingleton().getExtensionFromMimeType(mimeType) ?: "bin"
                fileName = "content_${System.currentTimeMillis()}.$extension"
            }

            fileName = File(fileName!!).name

            val destFile = File(activity.applicationContext.cacheDir, fileName)

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
            Log.e("PickerPlugin", "copyContentUriToPrivateStorage failed", e)
            return null
        }
    }
}
