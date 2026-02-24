package app.kabegame.plugin

import android.app.Activity
import android.net.Uri
import android.util.Log
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.io.FileOutputStream
import java.util.UUID
import java.util.zip.ZipInputStream

@TauriPlugin
class ArchiverPlugin(private val activity: Activity) : Plugin(activity) {

    @InvokeArg
    class ExtractZipArgs {
        var archiveUri: String = ""
        var outputDir: String = ""
    }

    @InvokeArg
    class ExtractRarArgs {
        var archiveUri: String = ""
        var outputDir: String = ""
    }

    @Command
    fun extractZip(invoke: Invoke) {
        val args = invoke.parseArgs(ExtractZipArgs::class.java)
        val archiveUriStr = args.archiveUri
        val outputDirStr = args.outputDir

        if (archiveUriStr.isBlank() || outputDirStr.isBlank()) {
            invoke.reject("archiveUri 和 outputDir 不能为空")
            return
        }

        // 在 Dispatchers.IO 协程中执行解压
        CoroutineScope(Dispatchers.IO).launch {
            try {
                val result = extractZipToDirectory(archiveUriStr, outputDirStr)
                withContext(Dispatchers.Main) {
                    val resultObj = JSObject()
                    resultObj.put("dir", result)
                    invoke.resolve(resultObj)
                }
            } catch (e: Exception) {
                Log.e("ArchiverPlugin", "extractZip failed", e)
                withContext(Dispatchers.Main) {
                    invoke.reject("解压 ZIP 失败: ${e.message}", e)
                }
            }
        }
    }

    @Command
    fun extractRar(invoke: Invoke) {
        val args = invoke.parseArgs(ExtractRarArgs::class.java)
        val archiveUriStr = args.archiveUri
        val outputDirStr = args.outputDir

        if (archiveUriStr.isBlank() || outputDirStr.isBlank()) {
            invoke.reject("archiveUri 和 outputDir 不能为空")
            return
        }

        // 在 Dispatchers.IO 协程中执行解压
        CoroutineScope(Dispatchers.IO).launch {
            try {
                val result = extractRarToDirectory(archiveUriStr, outputDirStr)
                withContext(Dispatchers.Main) {
                    val resultObj = JSObject()
                    resultObj.put("dir", result)
                    invoke.resolve(resultObj)
                }
            } catch (e: Exception) {
                Log.e("ArchiverPlugin", "extractRar failed", e)
                withContext(Dispatchers.Main) {
                    invoke.reject("解压 RAR 失败: ${e.message}", e)
                }
            }
        }
    }

    private suspend fun extractZipToDirectory(archiveUriStr: String, outputDirStr: String): String {
        return withContext(Dispatchers.IO) {
            val uri = Uri.parse(archiveUriStr)
            val outputDir = File(outputDirStr)
            if (!outputDir.exists()) {
                outputDir.mkdirs()
            }
            if (!outputDir.isDirectory) {
                throw IllegalStateException("outputDir 不是目录: $outputDirStr")
            }

            // 创建唯一子目录
            val extractDirName = UUID.randomUUID().toString()
            val extractDir = File(outputDir, extractDirName)
            extractDir.mkdirs()

            val contentResolver = activity.contentResolver
            val inputStream = when (uri.scheme) {
                "content" -> contentResolver.openInputStream(uri)
                    ?: throw IllegalStateException("无法打开 content URI: $archiveUriStr")
                "file" -> java.io.FileInputStream(uri.path ?: throw IllegalStateException("无效的 file URI"))
                else -> throw IllegalStateException("不支持的 URI scheme: ${uri.scheme}")
            }

            inputStream.use { stream ->
                ZipInputStream(stream).use { zipStream ->
                    var entry = zipStream.nextEntry
                    while (entry != null) {
                        if (!entry.isDirectory) {
                            val entryName = entry.name
                            // 安全检查：防止路径穿越
                            if (entryName.contains("..") || entryName.startsWith("/")) {
                                zipStream.closeEntry()
                                entry = zipStream.nextEntry
                                continue
                            }

                            val outputFile = File(extractDir, entryName)
                            // 确保父目录存在
                            outputFile.parentFile?.mkdirs()

                            FileOutputStream(outputFile).use { outputStream ->
                                zipStream.copyTo(outputStream)
                            }
                        } else {
                            // 创建目录
                            val dirPath = File(extractDir, entry.name)
                            dirPath.mkdirs()
                        }
                        zipStream.closeEntry()
                        entry = zipStream.nextEntry
                    }
                }
            }

            extractDir.absolutePath
        }
    }

    private suspend fun extractRarToDirectory(archiveUriStr: String, outputDirStr: String): String {
        return withContext(Dispatchers.IO) {
            // TODO: 实现 RAR 解压
            // 可以使用 Junrar 或 Apache Commons Compress
            throw UnsupportedOperationException("RAR 解压尚未实现")
        }
    }
}
