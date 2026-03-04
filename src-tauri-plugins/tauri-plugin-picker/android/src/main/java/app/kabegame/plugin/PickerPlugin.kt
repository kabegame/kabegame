package app.kabegame.plugin

import android.app.Activity
import android.content.pm.PackageManager
import android.content.ContentValues
import android.content.Intent
import android.Manifest
import android.media.MediaScannerConnection
import android.net.Uri
import android.os.Build
import android.os.Environment
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
import androidx.core.content.ContextCompat
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.IOException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.zip.ZipInputStream

/**
 * Activity 在 onCreate 之前注册的 launcher 提供给 PickerPlugin 使用，
 * 避免插件在 Activity 已 RESUMED 后才被创建时调用 registerForActivityResult 导致崩溃。
 */
interface PickerLauncherHost {
    fun launchFolderPicker(intent: Intent, onResult: (ActivityResult) -> Unit)
    fun launchPickImages(onResult: (List<Uri>) -> Unit)
    fun launchPickKgpgFile(intent: Intent, onResult: (ActivityResult) -> Unit)
}


@TauriPlugin
class PickerPlugin(private val activity: Activity) : Plugin(activity) {
    companion object {
        private const val TAG = "PickerPlugin"
        private const val PICTURES_RELATIVE_PATH = "Pictures/Kabegame/"
    }

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
        var targetDir: String = ""
    }

    @Command
    fun extractBundledPlugins(invoke: Invoke) {
        val args = invoke.parseArgs(ExtractBundledPluginsArgs::class.java)
        Log.i("PickerPlugin", "extractBundledPlugins: ${args.targetDir}")
        try {
            val targetDirectory = File(args.targetDir)
            if (!targetDirectory.exists()) {
                targetDirectory.mkdirs()
            }
            if (!targetDirectory.isDirectory) {
                invoke.reject("目标路径不是目录: ${args.targetDir}")
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
    class CopyImageToPicturesArgs {
        var sourcePath: String = ""
        var mimeType: String = ""
        var displayName: String = ""
    }

    @Command
    fun copyImageToPictures(invoke: Invoke) {
        val args = invoke.parseArgs(CopyImageToPicturesArgs::class.java)
        val sourcePath = args.sourcePath
        val mimeType = args.mimeType
        val displayName = args.displayName
        if (sourcePath.isBlank()) {
            invoke.reject("sourcePath 不能为空")
            return
        }
        if (displayName.isBlank()) {
            invoke.reject("displayName 不能为空")
            return
        }
        try {
            val sourceFile = File(sourcePath)
            if (!sourceFile.exists() || !sourceFile.isFile) {
                invoke.reject("源文件不存在: $sourcePath")
                return
            }
            val contentUri = copyFileToPictures(sourceFile, mimeType, displayName)
            val result = JSObject()
            result.put("contentUri", contentUri)
            invoke.resolve(result)
        } catch (e: Exception) {
            Log.e(TAG, "copyImageToPictures failed", e)
            invoke.reject("复制到 Pictures 失败: ${e.message}", e)
        }
    }

    @InvokeArg
    class CopyExtractedImagesToPicturesArgs {
        var sourceDir: String = ""
    }

    @Command
    fun copyExtractedImagesToPictures(invoke: Invoke) {
        val args = invoke.parseArgs(CopyExtractedImagesToPicturesArgs::class.java)
        val sourceDir = args.sourceDir
        if (sourceDir.isBlank()) {
            invoke.reject("sourceDir 不能为空")
            return
        }
        try {
            val dir = File(sourceDir)
            if (!dir.exists() || !dir.isDirectory) {
                invoke.reject("sourceDir 不是有效目录: $sourceDir")
                return
            }
            val entries = JSONArray()
            dir.walkTopDown()
                .filter { it.isFile }
                .forEach { file ->
                    val mime = guessMimeTypeFromFile(file)
                    val uri = copyFileToPictures(file, mime, file.name)
                    val obj = JSONObject()
                    obj.put("contentUri", uri)
                    obj.put("displayName", file.name)
                    entries.put(obj)
                }
            val result = JSObject()
            result.put("entries", entries)
            invoke.resolve(result)
        } catch (e: Exception) {
            Log.e(TAG, "copyExtractedImagesToPictures failed", e)
            invoke.reject("批量复制到 Pictures 失败: ${e.message}", e)
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
    class GetImageDimensionsArgs {
        var uri: String = ""
    }

    @Command
    fun getImageDimensions(invoke: Invoke) {
        val args = invoke.parseArgs(GetImageDimensionsArgs::class.java)
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
            
            var width: Int? = null
            var height: Int? = null

            // Photo Picker 的 content URI 不支持查询 WIDTH/HEIGHT 列，会抛 Unexpected picker URI projection，直接走 BitmapFactory
            val isPhotoPickerUri = uri.authority?.contains("photopicker") == true

            // 优先尝试从 MediaStore 获取（仅非 Photo Picker URI）
            if (!isPhotoPickerUri && Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                val projection = arrayOf(
                    MediaStore.Images.Media.WIDTH,
                    MediaStore.Images.Media.HEIGHT
                )
                try {
                    activity.contentResolver.query(uri, projection, null, null, null)?.use { cursor ->
                        if (cursor.moveToFirst()) {
                            val widthIndex = cursor.getColumnIndex(MediaStore.Images.Media.WIDTH)
                            val heightIndex = cursor.getColumnIndex(MediaStore.Images.Media.HEIGHT)
                            if (widthIndex >= 0 && heightIndex >= 0) {
                                width = cursor.getInt(widthIndex)
                                height = cursor.getInt(heightIndex)
                                // MediaStore 可能返回 0，需要回退到 BitmapFactory
                                if (width == 0 || height == 0) {
                                    width = null
                                    height = null
                                }
                            }
                        }
                    }
                } catch (_: Exception) {
                    // 部分 content provider 不支持该 projection，忽略后走 BitmapFactory
                }
            }

            // 如果 MediaStore 没有结果，使用 BitmapFactory
            if (width == null || height == null) {
                try {
                    activity.contentResolver.openInputStream(uri)?.use { inputStream ->
                        val options = android.graphics.BitmapFactory.Options().apply {
                            inJustDecodeBounds = true
                        }
                        android.graphics.BitmapFactory.decodeStream(inputStream, null, options)
                        width = options.outWidth
                        height = options.outHeight
                    }
                } catch (e: Exception) {
                    Log.e("PickerPlugin", "BitmapFactory decode failed", e)
                }
            }
            
            if (width == null || height == null || width == 0 || height == 0) {
                invoke.reject("无法获取图片尺寸")
                return
            }
            
            val result = JSObject()
            result.put("width", width!!)
            result.put("height", height!!)
            invoke.resolve(result)
        } catch (e: Exception) {
            Log.e("PickerPlugin", "getImageDimensions failed", e)
            invoke.reject("获取图片尺寸失败: ${e.message}", e)
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
    class OpenImageArgs {
        var uri: String = ""
    }

    /**
     * 使用系统默认图片查看器打开指定 content:// 或 file URI 的图片。
     */
    @Command
    fun openImage(invoke: Invoke) {
        val args = invoke.parseArgs(OpenImageArgs::class.java)
        val uriStr = args.uri
        if (uriStr.isBlank()) {
            invoke.reject("uri 不能为空")
            return
        }
        try {
            val uri = Uri.parse(uriStr)
            val intent = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, "image/*")
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            activity.startActivity(intent)
            invoke.resolve(JSObject())
        } catch (e: android.content.ActivityNotFoundException) {
            invoke.reject("没有可打开图片的应用")
        } catch (e: Exception) {
            Log.e("PickerPlugin", "openImage failed", e)
            invoke.reject("打开图片失败: ${e.message}", e)
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
    class GetDisplayNameArgs {
        var uri: String = ""
    }

    @Command
    fun getDisplayName(invoke: Invoke) {
        val args = invoke.parseArgs(GetDisplayNameArgs::class.java)
        val uriStr = args.uri
        if (uriStr.isBlank()) {
            invoke.reject("uri 不能为空")
            return
        }
        try {
            val uri = Uri.parse(uriStr)
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

            val result = JSObject()
            result.put("name", fileName)
            invoke.resolve(result)
        } catch (e: Exception) {
            Log.e("PickerPlugin", "getDisplayName failed", e)
            invoke.reject("获取文件名失败: ${e.message}", e)
        }
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
            Log.e(TAG, "copyContentUriToPrivateStorage failed", e)
            return null
        }
    }

    private fun copyFileToPictures(sourceFile: File, mimeTypeHint: String, displayNameHint: String): String {
        val safeName = sanitizeDisplayName(displayNameHint)
        val resolvedMime = normalizeMimeType(mimeTypeHint, safeName)
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            copyFileToPicturesMediaStore(sourceFile, safeName, resolvedMime)
        } else {
            copyFileToPicturesLegacy(sourceFile, safeName, resolvedMime)
        }
    }

    private fun copyFileToPicturesMediaStore(sourceFile: File, displayName: String, mimeType: String): String {
        val resolver = activity.contentResolver
        var candidate = displayName
        var index = 1
        while (mediaStoreNameExists(candidate)) {
            candidate = appendIndex(displayName, index)
            index += 1
        }

        val values = ContentValues().apply {
            put(MediaStore.Images.Media.DISPLAY_NAME, candidate)
            put(MediaStore.Images.Media.MIME_TYPE, mimeType)
            put(MediaStore.Images.Media.RELATIVE_PATH, PICTURES_RELATIVE_PATH)
            put(MediaStore.Images.Media.IS_PENDING, 1)
        }

        val uri = resolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values)
            ?: throw IOException("MediaStore insert 返回空")
        try {
            resolver.openOutputStream(uri)?.use { output ->
                FileInputStream(sourceFile).use { input ->
                    input.copyTo(output)
                }
            } ?: throw IOException("无法打开 MediaStore 输出流")

            val completeValues = ContentValues().apply {
                put(MediaStore.Images.Media.IS_PENDING, 0)
            }
            resolver.update(uri, completeValues, null, null)
            return uri.toString()
        } catch (e: Exception) {
            resolver.delete(uri, null, null)
            throw e
        }
    }

    private fun copyFileToPicturesLegacy(sourceFile: File, displayName: String, mimeType: String): String {
        if (
            ContextCompat.checkSelfPermission(activity, Manifest.permission.WRITE_EXTERNAL_STORAGE) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            throw SecurityException("缺少 WRITE_EXTERNAL_STORAGE 权限（Android < 10）")
        }
        val picturesDir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_PICTURES)
        val targetDir = File(picturesDir, "Kabegame")
        if (!targetDir.exists()) {
            targetDir.mkdirs()
        }
        if (!targetDir.isDirectory) {
            throw IOException("无法创建目标目录: ${targetDir.absolutePath}")
        }
        var candidate = File(targetDir, displayName)
        var index = 1
        while (candidate.exists()) {
            candidate = File(targetDir, appendIndex(displayName, index))
            index += 1
        }
        FileInputStream(sourceFile).use { input ->
            FileOutputStream(candidate).use { output ->
                input.copyTo(output)
            }
        }

        var scannedUri: Uri? = null
        val latch = CountDownLatch(1)
        MediaScannerConnection.scanFile(
            activity,
            arrayOf(candidate.absolutePath),
            arrayOf(mimeType),
        ) { _, uri ->
            scannedUri = uri
            latch.countDown()
        }
        latch.await(3, TimeUnit.SECONDS)
        return scannedUri?.toString() ?: Uri.fromFile(candidate).toString()
    }

    private fun mediaStoreNameExists(displayName: String): Boolean {
        val projection = arrayOf(MediaStore.Images.Media._ID)
        val selection = "${MediaStore.Images.Media.RELATIVE_PATH}=? AND ${MediaStore.Images.Media.DISPLAY_NAME}=?"
        activity.contentResolver.query(
            MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
            projection,
            selection,
            arrayOf(PICTURES_RELATIVE_PATH, displayName),
            null,
        )?.use { cursor ->
            return cursor.moveToFirst()
        }
        return false
    }

    private fun appendIndex(fileName: String, index: Int): String {
        val dot = fileName.lastIndexOf('.')
        if (dot <= 0 || dot == fileName.length - 1) {
            return "$fileName($index)"
        }
        val name = fileName.substring(0, dot)
        val ext = fileName.substring(dot)
        return "$name($index)$ext"
    }

    private fun sanitizeDisplayName(name: String): String {
        val fileName = File(name).name.trim()
        return if (fileName.isBlank()) "image.jpg" else fileName
    }

    private fun normalizeMimeType(mimeType: String, fileName: String): String {
        if (mimeType.isNotBlank()) return mimeType
        return guessMimeTypeFromName(fileName) ?: "image/jpeg"
    }

    private fun guessMimeTypeFromFile(file: File): String {
        return guessMimeTypeFromName(file.name) ?: "application/octet-stream"
    }

    private fun guessMimeTypeFromName(fileName: String): String? {
        val ext = fileName.substringAfterLast('.', "").lowercase()
        if (ext.isBlank()) return null
        return MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext)
    }
}
